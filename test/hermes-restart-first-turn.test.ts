// T610: after a full Hermes restart (`hermes --resume <id>`), the new gateway's mbx server connects but claims the remembered
// identity only on the agent's first mbx tool call. The first turn's pre_llm_call then saw "connected, holding nothing" and
// emitted no [mbx] context at all. It must say the identity is resuming, and the bounded resume notice must still reach the
// first bound turn (the entry is not consumed by the run that delivered no notice).
import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { MbxNode } from "../src/node.ts";
import { identityControlKey, listIdentityControls } from "../src/identity-control.ts";
import { bindWakeLease } from "./helpers/wake-lease.ts";
import { sendLeased } from "./helpers/leased-send.ts";

const RESUMING = "[mbx] Resuming worker@alpha: this session's mailbox server is still connecting. Call mbx_whoami and wait for its result before claiming or registering.";

test("T610: the first turn after a Hermes restart, with the new mbx server connected but not yet claimed, says resuming; the first bound turn carries the notice once", async t => {
  const home = mkdtempSync(join(tmpdir(), "mbx-t610-")), node = new MbxNode(home, { host: "alpha" });
  const old = spawn("sleep", ["600"], { stdio: "ignore" });
  const client = new Client({ name: "t610", version: "1" });
  t.after(async () => { await client.close().catch(() => {}); old.kill("SIGKILL"); node.close(); rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
  const sid = "20261012_104708_6e6574";
  // The gateway before the restart held worker for this conversation; quitting released the lease and the process exited.
  const held = bindWakeLease(node, { agent: "worker", cli: "hermes", session_id: sid, pid: old.pid! });
  node.store.db.prepare("DELETE FROM kv WHERE k=?").run(identityControlKey("hermes", sid));
  assert.equal(held.release(), true);
  old.kill("SIGKILL"); await once(old, "exit");
  sendLeased(node, { from: "boss", to: ["worker"], subject: "PRIVATE SUBJECT", body: "SECRET BODY", kind: "request" });
  // That conversation was guided once already (its first unbound prompt, long ago): the unbound text is never repeated.
  node.store.set(`guided:hermes:${sid}`, "2026-10-12T17:48:09.823Z");

  // The relaunched gateway (this test process) starts its mbx server, which connects and publishes an unbound control.
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [resolve("bin/agentmbx.js"), "mcp"],
    env: { ...process.env, AGENTMBX_DEV: "1", MBX_HOME: home, MBX_CLI: "hermes", MBX_AGENT: "", MBX_NO_DESKTOP: "1" } as Record<string, string> }));
  await client.listTools(); // initialized; no mbx tool has been called, so nothing is claimed yet
  const controls = listIdentityControls(node.store).filter(d => d.cli === "hermes" && d.parent_pid === process.pid);
  assert.ok(controls.length >= 1 && controls.every(d => d.agent === ""), `a live, unbound connector of this provider: ${JSON.stringify(controls)}`);
  const leases = JSON.stringify(node.store.db.prepare("SELECT * FROM identity_leases").all());

  const prompt = (text: string) => {
    const r = spawnSync(process.execPath, [resolve("bin/agentmbx.js"), "hook", "prompt", "--cli", "hermes"], { encoding: "utf8", timeout: 15_000,
      input: JSON.stringify({ hook_event_name: "pre_llm_call", session_id: sid, cwd: process.cwd(), extra: { user_message: text, platform: "tui" } }),
      env: { ...process.env, AGENTMBX_DEV: "1", MBX_HOME: home, MBX_AGENT: "unrelated", MBX_NO_DESKTOP: "1" } });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout ? (JSON.parse(r.stdout) as { context: string }).context : "";
  };
  const entry = () => node.store.db.prepare("SELECT COUNT(*) n FROM kv WHERE k LIKE 'resume-entry:hermes:%'").get()!.n;

  // AC1: the first turn is never silent; it names the resuming identity and the next step, and claims nothing.
  const first = prompt("restarted");
  assert.equal(first, RESUMING);
  assert.doesNotMatch(first, /no mailbox identity yet|mbx disconnected|no longer holds|SECRET BODY|PRIVATE SUBJECT/);
  assert.equal(JSON.stringify(node.store.db.prepare("SELECT * FROM identity_leases").all()), leases, "the hook claims nothing");
  // AC2: the run that delivered no notice did not consume the entry.
  assert.equal(entry(), 0);

  // The agent follows the line: its first mbx call makes the server reclaim worker for this exact conversation.
  const who = (await client.callTool({ name: "mbx_whoami", arguments: {} })).structuredContent as { agent: string; harness_session: string };
  assert.equal(who.agent, "worker"); assert.equal(who.harness_session, sid);

  // The first bound turn carries the bounded resume notice, once.
  const bound = prompt("next");
  assert.match(bound, /\[mbx\] You are worker@alpha/);
  assert.match(bound, /not caught up on; call mbx_catchup|1 open thread\(s\) with unacked mail/);
  assert.doesNotMatch(bound, /Resuming worker|SECRET BODY|PRIVATE SUBJECT/);
  assert.equal(entry(), 1);
  assert.doesNotMatch(prompt("and again"), /\[mbx\] You are worker@alpha/, "once per entry");
});
