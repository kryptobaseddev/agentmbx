// T209 (v0.5.2 R6): prune retires only generated, unheld, empty, inactive mailboxes; forward moves unread mail with the
// owner's signature; messages are never deleted and a retired name comes back when it is claimed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonical, signData } from "../src/crypto.ts";
import { createOwnerKey, unlockOwnerKey } from "../src/owner.ts";
import { MbxNode } from "../src/node.ts";
import { applyForward, buildForward, isRetired, pruneCandidates, retireMailbox } from "../src/identity-cleanup.ts";
import { listIdentityStatus } from "../src/identity-status.ts";
import { registerIdentity } from "../src/registry.ts";
import { assertKnownRecipients } from "../src/receipts.ts";

const old = (n: MbxNode, name: string, days: number) => {
  const at = new Date(Date.now() - days * 86_400_000).toISOString();
  n.store.db.prepare("UPDATE deliveries SET updated_at=? WHERE agent=?").run(at, name);
  n.store.db.prepare("UPDATE agents SET last_seen=? WHERE name=?").run(at, name);
  n.store.db.prepare("UPDATE messages SET ts=?, received_at=?").run(at, at);
};

test("prune retires only generated, unheld, empty and inactive mailboxes, and never deletes mail", t => {
  const home = mkdtempSync(join(tmpdir(), "mbx-prune-")), n = new MbxNode(home, { host: "alpha" });
  t.after(() => { n.close(); rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
  for (const name of ["orbit-mcp-0123456789abcdef", "orbit-0123456789", "orbit-87078", "orbit-lead", "orbit-mcp-fedcba9876543210", "orbit-mcp-aaaaaaaaaaaaaaaa"]) n.registerAgent(name);
  const acked = n.send({ from: "boss", to: ["orbit-mcp-0123456789abcdef"], subject: "done", body: "kept" }).envelope.id;
  n.ack(acked, "orbit-mcp-0123456789abcdef");
  n.send({ from: "boss", to: ["orbit-mcp-fedcba9876543210"], subject: "unread", body: "waiting" });
  registerIdentity(n.store, { name: "orbit-mcp-aaaaaaaaaaaaaaaa", role: "builder" });
  for (const name of ["orbit-mcp-0123456789abcdef", "orbit-0123456789", "orbit-87078", "orbit-lead", "orbit-mcp-fedcba9876543210", "orbit-mcp-aaaaaaaaaaaaaaaa", "boss"]) old(n, name, 30);
  const { retire, kept } = pruneCandidates(n, { days: 7 });
  assert.deepEqual(retire.map(r => r.name), ["orbit-0123456789", "orbit-87078", "orbit-mcp-0123456789abcdef"]);
  const why = Object.fromEntries(kept.map(k => [k.name, k.reason]));
  assert.equal(why["orbit-lead"], "chosen name");
  assert.match(why["orbit-mcp-fedcba9876543210"], /1 unread: forward it first/);
  assert.equal(why["orbit-mcp-aaaaaaaaaaaaaaaa"], "registered");
  for (const r of retire) retireMailbox(n, r.name, "test");
  assert.ok(isRetired(n, "orbit-87078"));
  assert.ok(n.message(acked), "messages are never deleted");
  assert.ok(!listIdentityStatus(home).identities.some(i => i.name === "orbit-87078"), "retired names leave the list");
  assert.ok(listIdentityStatus(home, { includeRetired: true }).identities.some(i => i.name === "orbit-87078"));
  assert.throws(() => assertKnownRecipients(n, ["orbit-87078"]), /not an agent/, "a retired name is no longer a send target");
  assert.deepEqual(pruneCandidates(n, { days: 7 }).retire, [], "idempotent");
});

test("prune keeps a generated mailbox that is still active or held", t => {
  const home = mkdtempSync(join(tmpdir(), "mbx-prune-live-")), n = new MbxNode(home, { host: "alpha" });
  t.after(() => { n.close(); rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
  n.registerAgent("fresh-mcp-0123456789abcdef");
  n.registerAgent("held-mcp-0123456789abcdef");
  old(n, "held-mcp-0123456789abcdef", 30);
  n.store.db.prepare(`INSERT INTO identity_leases (name,token,holder_pid,holder_start,key_fp,cli,session_id,claimed_at,heartbeat_at,idle_ttl,released_at,release_reason)
    VALUES ('held-mcp-0123456789abcdef','t',?, 'live','k','claude','s',?,?,?,NULL,NULL)`).run(process.pid, Date.now(), Date.now() - 10 * 86_400_000, 40 * 86_400_000);
  const { retire, kept } = pruneCandidates(n, { days: 7, inspect: () => ({ alive: true, start: "live" }) });
  assert.deepEqual(retire, []);
  assert.match(kept.find(k => k.name === "fresh-mcp-0123456789abcdef")!.reason, /active within 7 days/);
  assert.match(kept.find(k => k.name === "held-mcp-0123456789abcdef")!.reason, /held by live claude session/);
});

test("forward moves unread mail with an owner signature, once, and routes the old name to the new one", t => {
  const home = mkdtempSync(join(tmpdir(), "mbx-forward-")), n0 = new MbxNode(home, { host: "alpha" });
  createOwnerKey(home, "test-only-passphrase");
  n0.close();
  const n = new MbxNode(home, { host: "alpha" }), owner = unlockOwnerKey(home, "test-only-passphrase");
  t.after(() => { n.close(); rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
  n.registerAgent("orbit-lead"); n.registerAgent("orbit-mcp-0123456789abcdef");
  const a = n.send({ from: "boss", to: ["orbit-mcp-0123456789abcdef"], subject: "one", body: "1" }).envelope.id;
  const b = n.send({ from: "boss", to: ["orbit-mcp-0123456789abcdef"], subject: "two", body: "2" }).envelope.id;
  n.ack(b, "orbit-mcp-0123456789abcdef");
  const payload = buildForward(n, "orbit-mcp-0123456789abcdef", "orbit-lead");
  assert.equal(payload.unread, 1);
  assert.throws(() => applyForward(n, { payload, sig: signData(owner.privateKey, canonical({ ...payload, to: "boss" })) }), /invalid owner forward signature/);
  const sig = signData(owner.privateKey, canonical(payload));
  assert.deepEqual(applyForward(n, { payload, sig }), { moved: 1 });
  assert.deepEqual(n.inbox("orbit-lead").map(m => m.id), [a]);
  assert.equal(n.unreadCount("orbit-mcp-0123456789abcdef"), 0);
  assert.equal(n.message(b)?.id, b, "acked history stays where it was");
  assert.throws(() => applyForward(n, { payload, sig }), /already used/);
  assert.equal(n.resolveAlias("orbit-mcp-0123456789abcdef"), "orbit-lead");
  assert.throws(() => buildForward(n, "orbit-lead", "nobody-here"), /not a mailbox/);
});

test("a session claiming a retired mailbox brings it back with its history", async t => {
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { StdioClientTransport } = await import("@modelcontextprotocol/sdk/client/stdio.js");
  const home = mkdtempSync(join(tmpdir(), "mbx-revive-")), n = new MbxNode(home, { host: "alpha" });
  const c = new Client({ name: "revive", version: "1" });
  t.after(async () => { await c.close(); n.close(); rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
  n.registerAgent("orbit-87078");
  const id = n.send({ from: "boss", to: ["orbit-87078"], subject: "old", body: "history" }).envelope.id;
  n.ack(id, "orbit-87078");
  retireMailbox(n, "orbit-87078", "test");
  await c.connect(new StdioClientTransport({ command: process.execPath, args: [join(import.meta.dirname, "../bin/agentmbx.js"), "mcp"],
    env: { ...process.env, AGENTMBX_DEV: "1", MBX_HOME: home, MBX_CLI: "claude", MBX_AGENT: "", MBX_NO_DESKTOP: "1" } as Record<string, string> }));
  const r = await c.callTool({ name: "mbx_identity", arguments: { action: "claim", name: "orbit-87078" } });
  assert.notEqual(r.isError, true, JSON.stringify(r));
  assert.equal(isRetired(n, "orbit-87078"), false);
  assert.match(JSON.stringify(await c.callTool({ name: "mbx_inbox", arguments: { all: true } })), new RegExp(id));
});
