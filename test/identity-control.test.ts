import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { MbxNode } from "../src/node.ts";
import { consumeIdentityControl, identityControlReceipt, identityGeneration, identityRequestKey, publishIdentityControl, submitIdentityControl, type IdentityControlDescriptor } from "../src/identity-control.ts";
import { inspectLeaseProcess } from "../src/identity-leases.ts";

const command = (home: string, ...args: string[]) => spawnSync(process.execPath, [resolve("bin/agentmbx.js"), "identity", ...args, "--json"], {
  encoding: "utf8", timeout: 10_000, env: { ...process.env, MBX_HOME: home, AGENTMBX_DEV: "1" },
});

for (const cli of ["claude", "codex", "kimi", "opencode"]) test(`${cli} CLI commands reach the existing MCP holder and retain exact receipts`, async t => {
  const home = mkdtempSync(join(tmpdir(), "mbx-control-")), node = new MbxNode(home, { host: "alpha" }), client = new Client({ name: cli, version: "test" });
  const transport = new StdioClientTransport({ command: process.execPath, args: [resolve("bin/agentmbx.js"), "mcp"],
    env: { ...process.env, MBX_HOME: home, MBX_AGENT: "reader", MBX_CLI: cli, AGENTMBX_DEV: "1" } as Record<string, string> });
  t.after(async () => { try { if (transport.pid) process.kill(transport.pid, "SIGCONT"); } catch {} await client.close(); node.close(); rmSync(home, { recursive: true, force: true }); });
  await client.connect(transport);
  const meta = cli === "codex" ? { threadId: "33333333-3333-4333-8333-333333333333" } : cli === "opencode" ? { sessionID: "ses_clicontrol" } : undefined;
  const who = (await client.callTool({ name: "mbx_whoami", arguments: {}, ...(meta ? { _meta: meta } : {}) })).structuredContent as { agent: string };
  const sid = node.store.db.prepare("SELECT session_id FROM sessions WHERE agent=? AND session_key IS NOT NULL").get(who.agent)!.session_id as string;
  const token = node.store.db.prepare("SELECT token FROM identity_leases WHERE name=?").get(who.agent)!.token as string;
  const message = node.send({ from: "sender", to: [who.agent], subject: "pending", body: "history" }).envelope.id;
  const released = command(home, "release", "--cli", cli, "--session", sid);
  assert.equal(released.status, 0, released.stderr + released.stdout);
  const releaseReceipt = JSON.parse(released.stdout);
  assert.ok(released.stderr.includes(releaseReceipt.id), "submission prints the durable ID before waiting");
  assert.equal(releaseReceipt.status, "completed"); assert.equal(releaseReceipt.result.detached, true);
  assert.ok(!released.stdout.includes(token), "raw lease tokens never enter receipts");
  assert.equal(command(home, "result", releaseReceipt.id).stdout, released.stdout);
  const claimed = command(home, "claim", "--cli", cli, "--session", sid);
  assert.equal(claimed.status, 0, claimed.stderr + claimed.stdout);
  assert.equal(JSON.parse(claimed.stdout).result.unread, 1);
  assert.equal(node.inbox(who.agent)[0].id, message);
  assert.equal(node.store.db.prepare("SELECT holder_pid FROM identity_leases WHERE name=?").get(who.agent)!.holder_pid, transport.pid, "the short-lived CLI is never the holder");
  // A stopped holder cannot answer. Timeout is an unknown outcome with a durable ID.
  process.kill(transport.pid!, "SIGSTOP");
  const timedOut = command(home, "release", "--cli", cli, "--session", sid, "--wait-ms", "0");
  assert.equal(timedOut.status, 75, timedOut.stderr);
  const pending = JSON.parse(timedOut.stdout); assert.equal(pending.outcome, "unknown");
  process.kill(transport.pid!, "SIGCONT");
  let receipt = identityControlReceipt(node.store, pending.id)!;
  for (let i = 0; i < 30 && receipt.status === "pending"; i++) { await new Promise(resolve => setTimeout(resolve, 100)); receipt = identityControlReceipt(node.store, pending.id)!; }
  assert.equal(receipt.status, "failed", "a dead requesting CLI cannot authorize deferred execution");
  assert.equal(node.store.db.prepare("SELECT released_at FROM identity_leases WHERE name=?").get(who.agent)!.released_at, null);
});

test("control requests reject changed generations and roll back failed operations before recording receipts", t => {
  const home = mkdtempSync(join(tmpdir(), "mbx-control-atomic-")), node = new MbxNode(home, { host: "alpha" });
  t.after(() => { node.close(); rmSync(home, { recursive: true, force: true }); });
  const descriptor: IdentityControlDescriptor = { v: 1, cli: "claude", session_id: "test", control_key: "test-key", agent: "reader", generation: identityGeneration("old"),
    mcp_pid: process.pid, mcp_start: inspectLeaseProcess(process.pid).start!, parent_pid: process.ppid, parent_start: inspectLeaseProcess(process.ppid).start! };
  publishIdentityControl(node.store, descriptor);
  const request = submitIdentityControl(node.store, descriptor, "release");
  const changed = { ...descriptor, generation: identityGeneration("new") }; publishIdentityControl(node.store, changed);
  let invoked = 0;
  const denied = consumeIdentityControl(node.store, request, changed, { at: performance.now(), valid: true }, () => invoked++, () => {});
  assert.equal(denied?.status, "failed"); assert.match(denied!.error!, /generation changed/); assert.equal(invoked, 0);
  const next = submitIdentityControl(node.store, changed, "release"); let inMemory = "before";
  const failed = consumeIdentityControl(node.store, next, changed, { at: performance.now(), valid: true }, () => {
    inMemory = "after"; node.store.set("must-rollback", "value"); throw new Error("forced failure");
  }, () => { inMemory = "before"; });
  assert.equal(failed?.status, "failed"); assert.equal(inMemory, "before"); assert.equal(node.store.get("must-rollback"), undefined);
  assert.equal(consumeIdentityControl(node.store, next, changed, { at: performance.now(), valid: true }, () => invoked++, () => {}), null);
  assert.equal(invoked, 0, "a completed receipt cannot be consumed again");
  const expired = { ...submitIdentityControl(node.store, changed, "release"), expires_at: Date.now() - 1 };
  node.store.set(identityRequestKey(expired.id), JSON.stringify(expired));
  assert.match(consumeIdentityControl(node.store, expired, changed, { at: performance.now(), valid: true }, () => invoked++, () => {})!.error!, /expired/);
  const staleProof = submitIdentityControl(node.store, changed, "release");
  assert.match(consumeIdentityControl(node.store, staleProof, changed, { at: performance.now() - 6000, valid: true }, () => invoked++, () => {})!.error!, /stale/);
  const unrelated = { ...changed, parent_pid: process.pid, parent_start: inspectLeaseProcess(process.pid).start! };
  publishIdentityControl(node.store, unrelated);
  assert.throws(() => submitIdentityControl(node.store, unrelated, "release"), /ancestry/);
  assert.equal(invoked, 0);
});
