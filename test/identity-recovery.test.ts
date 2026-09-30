import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { MbxNode } from "../src/node.ts";
import { IdentityLeases, inspectLeaseProcess } from "../src/identity-leases.ts";

for (const cli of ["codex", "opencode"]) test(`${cli} remembered holder conflict leaves identity controls usable and preserves the holder`, async t => {
  const home = mkdtempSync(join(tmpdir(), "mbx-resume-conflict-")), node = new MbxNode(home, { host: "alpha" });
  const previous = new Client({ name: "previous", version: "test" }), replacement = new Client({ name: "replacement", version: "test" });
  t.after(async () => { await previous.close(); await replacement.close(); node.close(); rmSync(home, { recursive: true, force: true }); });
  const transport = () => new StdioClientTransport({ command: process.execPath, args: [join(import.meta.dirname, "../bin/agentmbx.js"), "mcp"],
    env: { ...process.env, MBX_HOME: home, MBX_AGENT: "resume-default", MBX_CLI: cli, AGENTMBX_DEV: "1", MBX_NO_DESKTOP: "1" } as Record<string, string> });
  const meta = cli === "codex" ? { threadId: "11111111-1111-4111-8111-111111111111" } : { sessionID: "ses_resumeconflict" };
  const call = (client: Client, name: string, args = {}) => client.callTool({ name, arguments: args, _meta: meta });
  await previous.connect(transport());
  assert.notEqual((await call(previous, "mbx_whoami", { name: "circle" })).isError, true);
  const holder = node.store.db.prepare("SELECT token,holder_pid FROM identity_leases WHERE name='circle'").get()!;
  const mail = node.send({ from: "sender", to: ["circle"], subject: "pending", body: "preserved" }).envelope.id;
  await replacement.connect(transport());
  const identity = await call(replacement, "mbx_whoami");
  assert.notEqual(identity.isError, true, JSON.stringify(identity));
  const me = identity.structuredContent as { agent: string; recovery: { identity: string } };
  assert.notEqual(me.agent, "circle");
  assert.equal(me.recovery.identity, "circle");
  assert.notEqual((await call(replacement, "mbx_identity", { action: "list" })).isError, true);
  assert.equal((await call(replacement, "mbx_read", { ids: [mail] })).isError, true);
  assert.deepEqual(node.store.db.prepare("SELECT token,holder_pid FROM identity_leases WHERE name='circle'").get(), holder);
  assert.equal(node.inbox("circle")[0].id, mail);
  await call(previous, "mbx_identity", { action: "release" });
  await call(replacement, "mbx_identity", { action: "release" });
  assert.notEqual((await call(replacement, "mbx_identity", { action: "claim", name: "circle" })).isError, true);
  assert.equal(((await call(replacement, "mbx_whoami")).structuredContent as { agent: string }).agent, "circle");
  assert.equal(node.inbox("circle")[0].id, mail);
});

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
  if (peer) {
    const blocked = await call("mbx_identity", { action: "claim", name: peer.agent });
    assert.equal(blocked.isError, true, "release does not authorize taking another session's mailbox");
    assert.match(JSON.stringify(blocked.content), /finishing holder must call mbx_identity release/);
    assert.notEqual((await call("mbx_identity", { action: "list" })).isError, true, "failed destination claim leaves recovery controls usable");
  }
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
    const peerCall = (tool: string, args: Record<string, unknown>) => client.callTool({ name: tool, arguments: args, _meta: peerMeta });
    await peerCall("mbx_identity", { action: "release" });
    const inherited = await peerCall("mbx_identity", { action: "claim", name });
    assert.notEqual(inherited.isError, true, JSON.stringify(inherited));
    assert.equal((inherited.structuredContent as { unread: number }).unread, 1);
    assert.equal(node.inbox(name)[0].id, pending, "successor inherits the exact mailbox on a still-live shared transport");
    assert.deepEqual(node.store.db.prepare("SELECT * FROM messages ORDER BY id").all(), messages);
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

test("explicit OpenCode to Claude handoff transfers persona and mail without transferring session authority", async t => {
  const home = mkdtempSync(join(tmpdir(), "mbx-provider-handoff-")), node = new MbxNode(home, { host: "alpha" });
  const old = new Client({ name: "opencode", version: "test" }), next = new Client({ name: "claude", version: "test" });
  t.after(async () => { await old.close(); await next.close(); node.close(); rmSync(home, { recursive: true, force: true }); });
  for (const [client, cli, agent] of [[old, "opencode", "old-default"], [next, "claude", "new-default"]] as const) {
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [join(import.meta.dirname, "../bin/agentmbx.js"), "mcp"],
      env: { ...process.env, MBX_HOME: home, MBX_CLI: cli, MBX_AGENT: agent, AGENTMBX_DEV: "1" } as Record<string, string> }));
  }
  const oldCall = (name: string, args = {}) => old.callTool({ name, arguments: args, _meta: { sessionID: "ses_providerhandoff" } });
  assert.notEqual((await oldCall("mbx_whoami", { name: "lab-dev" })).isError, true);
  const previous = (await oldCall("mbx_whoami")).structuredContent as { session: string };
  const pending = node.send({ from: "sender", to: ["lab-dev"], subject: "pending", body: "history" }).envelope.id;
  const done = node.send({ from: "sender", to: ["lab-dev"], subject: "done", body: "history" }).envelope.id;
  node.ack(done, "lab-dev", "handoff context");
  const messages = node.store.db.prepare("SELECT * FROM messages ORDER BY id").all();
  assert.notEqual((await oldCall("mbx_identity", { action: "release" })).isError, true);
  await next.callTool({ name: "mbx_identity", arguments: { action: "release" } });
  const claim = await next.callTool({ name: "mbx_identity", arguments: { action: "claim", name: "lab-dev" } });
  assert.notEqual(claim.isError, true, JSON.stringify(claim));
  const summary = claim.structuredContent as { unread: number; recent_notes: { note: string }[] };
  assert.equal(summary.unread, 1);
  assert.equal(summary.recent_notes[0].note, "handoff context");
  const identity = (await next.callTool({ name: "mbx_whoami", arguments: {} })).structuredContent as { session: string; owner_grant: unknown };
  assert.notEqual(identity.session, previous.session);
  assert.equal(identity.owner_grant, null);
  assert.equal(node.inbox("lab-dev")[0].id, pending);
  assert.deepEqual(node.store.db.prepare("SELECT * FROM messages ORDER BY id").all(), messages);
  assert.equal((await oldCall("mbx_inbox")).isError, true, "old provider cannot use the successor's lease");
});
