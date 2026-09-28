import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { MbxNode } from "../src/node.ts";
import { IdentityLeases, inspectLeaseProcess } from "../src/identity-leases.ts";

for (const cli of ["claude", "codex", "kimi", "opencode"]) test(`${cli} explicit release and reclaim preserves history and does not auto-reacquire`, async t => {
  const home = mkdtempSync(join(tmpdir(), "mbx-recover-")), node = new MbxNode(home, { host: "alpha" });
  const client = new Client({ name: cli, version: "test" }), preload = join(home, "heartbeat.mjs");
  t.after(async () => { await client.close(); node.close(); rmSync(home, { recursive: true, force: true }); });
  writeFileSync(preload, "const interval=globalThis.setInterval; globalThis.setInterval=(fn,ms,...args)=>interval(fn,ms===60000?50:ms,...args);");
  await client.connect(new StdioClientTransport({ command: process.execPath, args: ["--import", preload, join(import.meta.dirname, "../bin/agentmbx.js"), "mcp"],
    env: { ...process.env, MBX_HOME: home, MBX_AGENT: "reader", MBX_CLI: cli, AGENTMBX_DEV: "1", MBX_NO_DESKTOP: "1" } as Record<string, string> }));
  const meta = cli === "codex" ? { threadId: "11111111-1111-4111-8111-111111111111" } : cli === "opencode" ? { sessionID: "ses_recovery" } : undefined;
  const call = (name: string, args: Record<string, unknown> = {}) => client.callTool({ name, arguments: args, ...(meta ? { _meta: meta } : {}) });
  const identity = (await call("mbx_whoami")).structuredContent as { agent: string };
  const name = identity.agent;
  const peerMeta = cli === "codex" ? { threadId: "22222222-2222-4222-8222-222222222222" } : cli === "opencode" ? { sessionID: "ses_peer" } : undefined;
  const peer = peerMeta ? (await client.callTool({ name: "mbx_whoami", arguments: {}, _meta: peerMeta })).structuredContent as { agent: string } : undefined;
  const peerToken = peer ? node.store.db.prepare("SELECT token FROM identity_leases WHERE name=?").get(peer.agent)!.token : undefined;
  const pending = node.send({ from: "sender", to: [name], subject: "pending", body: "history" }).envelope.id;
  const acked = node.send({ from: "sender", to: [name], subject: "done", body: "history" }).envelope.id;
  node.ack(acked, name, "handoff note");
  const messages = node.store.db.prepare("SELECT * FROM messages ORDER BY id").all();
  const before = node.store.db.prepare("SELECT token FROM identity_leases WHERE name=?").get(name)!.token;
  assert.equal((await call("mbx_identity", { action: "claim", name: "other" })).isError, true, "held identities require explicit release or rename");
  assert.notEqual((await call("mbx_identity", { action: "release" })).isError, true);
  await new Promise(resolve => setTimeout(resolve, 200));
  assert.notEqual(node.store.db.prepare("SELECT released_at FROM identity_leases WHERE name=?").get(name)!.released_at, null);
  assert.equal((await call("mbx_inbox")).isError, true);
  assert.notEqual((await call("mbx_identity", { action: "list" })).isError, true);
  const recovered = await call("mbx_identity", { action: "claim" });
  assert.notEqual(recovered.isError, true, JSON.stringify(recovered));
  const summary = recovered.structuredContent as { unread: number; open_threads: number; recent_notes: { note: string }[] };
  assert.equal(summary.unread, 1); assert.equal(summary.open_threads, 1); assert.equal(summary.recent_notes[0].note, "handoff note");
  assert.notEqual(node.store.db.prepare("SELECT token FROM identity_leases WHERE name=?").get(name)!.token, before);
  assert.equal(node.inbox(name)[0].id, pending);
  assert.deepEqual(node.store.db.prepare("SELECT * FROM messages ORDER BY id").all(), messages);
  assert.notEqual((await call("mbx_inbox")).isError, true);
  // Explicit recovery also works after an expired generation, without a prior release.
  node.store.db.prepare("UPDATE identity_leases SET heartbeat_at=0 WHERE name=?").run(name);
  assert.notEqual((await call("mbx_identity", { action: "claim" })).isError, true);
  await call("mbx_identity", { action: "release" });
  assert.notEqual((await call("mbx_identity", { action: "claim", name: "new-reader" })).isError, true);
  assert.equal(node.inbox(name)[0].id, pending, "switching identities does not rename or forward old mail");
  assert.equal((await call("mbx_read", { ids: [pending] })).isError, true);
  if (peer) {
    const row = node.store.db.prepare("SELECT token,released_at FROM identity_leases WHERE name=?").get(peer.agent)!;
    assert.equal(row.token, peerToken); assert.equal(row.released_at, null, "another session on the shared transport retains its lease");
  }
});

test("stale recovery cannot take over or release a successor, or erase its session binding", async t => {
  const home = mkdtempSync(join(tmpdir(), "mbx-recover-stale-")), node = new MbxNode(home, { host: "alpha" }), client = new Client({ name: "claude", version: "test" });
  t.after(async () => { await client.close(); node.close(); rmSync(home, { recursive: true, force: true }); });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [join(import.meta.dirname, "../bin/agentmbx.js"), "mcp"],
    env: { ...process.env, MBX_HOME: home, MBX_AGENT: "reader", MBX_CLI: "claude", AGENTMBX_DEV: "1" } as Record<string, string> }));
  node.store.db.prepare("UPDATE identity_leases SET heartbeat_at=0 WHERE name='reader'").run();
  const next = new IdentityLeases(node.store).claim("reader", { pid: process.pid, start: inspectLeaseProcess(process.pid).start!, keyFp: "aaaa-bbbb-cccc-dddd", cli: "claude", sessionId: "successor" });
  node.bindSession({ agent: "reader", cli: "claude", session_id: "successor", pid: process.pid, session_key: "successor-key" });
  const result = await client.callTool({ name: "mbx_identity", arguments: { action: "claim", name: "reader" } });
  assert.equal(result.isError, true);
  await client.callTool({ name: "mbx_identity", arguments: { action: "release" } });
  const current = node.store.db.prepare("SELECT token,released_at FROM identity_leases WHERE name='reader'").get()!;
  assert.equal(current.token, next.token); assert.equal(current.released_at, null);
  assert.equal(node.store.db.prepare("SELECT session_key FROM sessions WHERE session_id='successor'").get()!.session_key, "successor-key");
  assert.equal((await client.callTool({ name: "mbx_identity", arguments: { action: "takeover", name: "reader" } })).isError, true);
});
