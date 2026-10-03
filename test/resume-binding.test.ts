// T326: a resumed Claude start hands its MCP servers a temporary session id, then rewrites ~/.claude/sessions/<pid>.json
// to the resumed conversation's id. A mailbox registered after that switch must follow the id the file names.
import { sendLeased } from "./helpers/leased-send.ts";
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { MbxNode } from "../src/node.ts";
import { procStart } from "../src/proc.ts";

// The test process plays Claude: the MCP server and the hooks are its children, so their parent pid is process.pid.
async function resumedClaude(t: TestContext) {
  const home = mkdtempSync(join(tmpdir(), "mbx-resume-")), fakeHome = mkdtempSync(join(tmpdir(), "mbx-resume-home-"));
  const n = new MbxNode(home, { host: "alpha" });
  const client = new Client({ name: "resume-test", version: "1" });
  t.after(async () => { await client.close(); n.close(); for (const d of [home, fakeHome]) rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
  const sessions = join(fakeHome, ".claude/sessions"); mkdirSync(sessions, { recursive: true });
  const write = (sid: string) => writeFileSync(join(sessions, `${process.pid}.json`), JSON.stringify({ pid: process.pid, sessionId: sid }));
  const env: Record<string, string> = { ...process.env, HOME: fakeHome, MBX_HOME: home, MBX_CLI: "claude", AGENTMBX_DEV: "1" } as Record<string, string>;
  delete env.MBX_AGENT; delete env.MBX_ROLE;
  const cli = (args: string[], input?: unknown) => spawnSync(process.execPath, [resolve("bin/agentmbx.js"), ...args],
    { input: input === undefined ? "" : JSON.stringify(input), encoding: "utf8", timeout: 10_000, env });
  const hook = (event: string, sid: string) => cli(["hook", event, "--cli", "claude"], { session_id: sid, cwd: process.cwd() });
  const status = (sid: string) => cli(["status", "--cli", "claude", "--session", sid, "--json"]);
  // Claude starts a resumed conversation under a temporary id and starts its MCP servers with that id.
  write("temporary-at-start");
  assert.match(hook("session-start", "temporary-at-start").stdout, /no mailbox identity yet/);
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [resolve("bin/agentmbx.js"), "mcp"], env }));
  assert.equal(((await client.callTool({ name: "mbx_whoami", arguments: {} })).structuredContent as { agent: string | null }).agent, null);
  // Then it switches to the resumed conversation's id; the hooks see that id while the session is still unbound.
  write("resumed");
  assert.match(hook("session-start", "resumed").stdout, /no mailbox identity yet/);
  assert.equal(hook("prompt", "resumed").status, 0);
  return { n, client, hook, status, write };
}

test("a mailbox registered after a resumed start binds the resumed session id (T326)", async t => {
  const { n, client, hook, status } = await resumedClaude(t);
  const reg = await client.callTool({ name: "mbx_identity", arguments: { action: "register", name: "orbit-dev", role: "developer" } });
  assert.notEqual(reg.isError, true, JSON.stringify(reg.content));
  assert.deepEqual(n.sessionsFor("orbit-dev").map(s => s.session_id), ["resumed"]);
  assert.equal(n.store.db.prepare("SELECT session_id FROM identity_leases WHERE name='orbit-dev'").get()?.session_id, "resumed");
  sendLeased(n, { from: "sender", to: ["orbit-dev"], subject: "s", body: "b", kind: "request" });
  assert.match(hook("prompt", "resumed").stdout, /1 unread for orbit-dev@alpha/);
  const s = status("resumed"); assert.equal(s.status, 0, s.stderr);
  assert.equal(JSON.parse(s.stdout).agent, "orbit-dev");
  // The temporary id is not the session any more, and an id the provider's file does not name never rebinds the holder.
  assert.notEqual(status("temporary-at-start").status, 0);
  const forged = hook("prompt", "someone-else"); assert.equal(forged.status, 0, forged.stderr); assert.doesNotMatch(forged.stdout, /unread/);
  assert.deepEqual(n.sessionsFor("orbit-dev").map(s => s.session_id), ["resumed"]);
  assert.notEqual((await client.callTool({ name: "mbx_inbox", arguments: {} })).isError, true);
});

test("a session id another live process has bound is never taken over (T326)", async t => {
  const { n, client, write } = await resumedClaude(t);
  const reg = await client.callTool({ name: "mbx_identity", arguments: { action: "register", name: "orbit-dev", role: "developer" } });
  assert.notEqual(reg.isError, true, JSON.stringify(reg.content));
  const other = spawn("sleep", ["60"]); t.after(() => { other.kill(); });
  n.store.db.prepare("INSERT INTO sessions (agent,cli,session_id,cwd,pid,session_key,channel,updated_at,pid_start) VALUES ('someone','claude','taken',NULL,?,NULL,0,?,?)")
    .run(other.pid!, new Date().toISOString(), procStart(other.pid!));
  write("taken");
  assert.notEqual((await client.callTool({ name: "mbx_inbox", arguments: {} })).isError, true);
  assert.deepEqual(n.sessionsFor("orbit-dev").map(s => s.session_id), ["resumed"]);
  assert.equal(n.store.db.prepare("SELECT session_id FROM identity_leases WHERE name='orbit-dev'").get()?.session_id, "resumed");
});

test("a held mailbox follows a later session-id switch without any hook (T326)", async t => {
  const { n, client, status, write } = await resumedClaude(t);
  const reg = await client.callTool({ name: "mbx_identity", arguments: { action: "register", name: "orbit-dev", role: "developer" } });
  assert.notEqual(reg.isError, true, JSON.stringify(reg.content));
  // /clear or compaction rewrites the file; the next mbx call (as the heartbeat would) moves the binding to that id.
  write("after-clear");
  assert.notEqual((await client.callTool({ name: "mbx_inbox", arguments: {} })).isError, true);
  assert.deepEqual(n.sessionsFor("orbit-dev").map(s => s.session_id), ["after-clear"]);
  const s = status("after-clear"); assert.equal(s.status, 0, s.stderr);
  assert.equal(JSON.parse(s.stdout).agent, "orbit-dev");
});
