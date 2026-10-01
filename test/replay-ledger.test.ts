import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { MbxNode } from "../src/node.ts";
import { Store, SCHEMA_VERSION } from "../src/store.ts";
import { buildEnvelope } from "../src/envelope.ts";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

type Grant = { seq: number; mailbox: string; message_id: string };
const grants = (store: Store) => store.db.prepare("SELECT seq,mailbox,message_id FROM mailbox_visibility ORDER BY seq").all() as unknown as Grant[];
function fixture(t: { after(fn: () => void): void }) {
  const home = mkdtempSync(join(tmpdir(), "mbx-ledger-"));
  const node = new MbxNode(home, { host: "alpha" });
  t.after(() => { node.close(); rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
  return node;
}
const send = (node: MbxNode, to: string[] = ["reader"]) => node.send({ from: "sender", to, subject: "ledger", body: "signed mail" }).envelope;

test("local sender history and recipients get distinct grants; duplicates and ACK never advance visibility", t => {
  const n = fixture(t), e = send(n);
  assert.deepEqual(grants(n.store).map(r => [r.mailbox,r.message_id]), [["sender",e.id],["reader",e.id]]);
  assert.equal(n.read(e.id, "sender").id, e.id, "outbound history exists without a sender delivery");
  const before = grants(n.store);
  assert.equal(n.store.insertMessage(e, "local", "local", null), false);
  assert.equal(n.store.insertMessage({ ...e, from: "impostor@alpha" }, "local", "local", null), false);
  n.store.addDelivery(e.id, "reader");
  n.ack(e.id, "reader", "completed by recipient");
  assert.deepEqual(grants(n.store), before);
  const next = send(n);
  assert.ok(grants(n.store).filter(r => r.message_id === next.id).every(r => r.seq > before.at(-1)!.seq));
});

test("late deliveries and raw delivery writers append current order for already stored/backdated messages", t => {
  const n = fixture(t);
  const older = buildEnvelope({ from: "foreign@remote", to: ["reader"], subject: "old clock", body: "data" });
  older.ts = "2001-01-01T00:00:00.000Z";
  n.store.insertMessage(older, "remote", "verified", null);
  assert.equal(grants(n.store).length, 0, "foreign sender does not receive a local mailbox grant");
  const newer = send(n), boundary = grants(n.store).at(-1)!.seq;
  n.store.addDelivery(older.id, "late");
  assert.ok(grants(n.store).find(r => r.message_id === older.id && r.mailbox === "late")!.seq > boundary);
  n.store.db.prepare("INSERT INTO deliveries (msg_id,agent,state,updated_at,note) VALUES (?,?,'acked',?,'imported ACK')")
    .run(newer.id, "raw-import", new Date().toISOString());
  assert.ok(grants(n.store).find(r => r.mailbox === "raw-import")!.seq > boundary);
  assert.equal(n.store.db.prepare("SELECT state,note FROM deliveries WHERE agent='raw-import'").get()!.state, "acked");
});

test("paired receive grants local fanout only and deduplicates repeated remote envelopes", t => {
  const n = fixture(t);
  // Distinct host configuration and key required; pairing establishes the actual receive verification path.
  const remoteHome = mkdtempSync(join(tmpdir(), "mbx-ledger-peer-"));
  const remote = new MbxNode(remoteHome, { host: "remote" });
  t.after(() => { remote.close(); rmSync(remoteHome, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
  n.store.db.prepare("INSERT INTO peers (host,pubkey,addr,state,created_at) VALUES (?,?,?,'approved',?)")
    .run("remote", remote.key.publicKey, "http://127.0.0.1:1", new Date().toISOString());
  const e = remote.send({ from: "foreign", to: ["one@alpha", "two@alpha"], subject: "received", body: "remote" }).envelope;
  assert.equal(n.receive(e, "remote"), "accepted");
  assert.deepEqual(grants(n.store).map(r => r.mailbox), ["one", "two"]);
  assert.equal(n.receive(e, "remote"), "duplicate");
  assert.equal(grants(n.store).length, 2);
  assert.equal(n.canSee(n.read(e.id), "foreign"), false);
});

test("rename transfers newly visible pairs, keeps overlapping ACK and never treats old ledger as authority", t => {
  const n = fixture(t);
  n.bindSession({ agent: "before", cli: "claude", session_id: `mcp-${process.pid}`, pid: process.pid, session_key: "key" });
  const overlap = send(n, ["before", "after"]), fresh = send(n, ["before"]);
  n.ack(overlap.id, "after", "already ACKed");
  const before = grants(n.store), boundary = before.at(-1)!.seq;
  n.addAlias("before", "after", process.pid);
  assert.equal(grants(n.store).filter(r => r.mailbox === "after" && r.message_id === overlap.id).length, 1);
  assert.ok(grants(n.store).find(r => r.mailbox === "after" && r.message_id === fresh.id)!.seq > boundary);
  assert.equal(n.store.db.prepare("SELECT state,note FROM deliveries WHERE agent='after' AND msg_id=?").get(overlap.id)!.state, "acked");
  assert.ok(grants(n.store).some(r => r.mailbox === "before" && r.message_id === fresh.id), "historical ledger retained");
  assert.equal(n.canSee(n.read(fresh.id), "before"), false, "current delivery proof remains authority");
});

test("ledger insertion failures roll back message/delivery and nested savepoints together", t => {
  const n = fixture(t);
  n.store.db.exec("CREATE TRIGGER deny_sender BEFORE INSERT ON mailbox_visibility WHEN new.mailbox='sender' BEGIN SELECT RAISE(ABORT,'ledger denied'); END");
  assert.throws(() => send(n), /ledger denied/);
  assert.equal(n.store.db.prepare("SELECT count(*) n FROM messages").get()!.n, 0);
  assert.equal(grants(n.store).length, 0);
  n.store.db.exec("DROP TRIGGER deny_sender");
  const e = send(n);
  const before = grants(n.store);
  n.store.db.exec("CREATE TRIGGER deny_late BEFORE INSERT ON mailbox_visibility WHEN new.mailbox='late' BEGIN SELECT RAISE(ABORT,'late denied'); END");
  assert.throws(() => n.store.tx(() => { n.store.addDelivery(e.id, "late"); }), /late denied/);
  assert.equal(n.store.db.prepare("SELECT 1 FROM deliveries WHERE agent='late'").get(), undefined);
  assert.deepEqual(grants(n.store), before);
});

test("failed rename transfer rolls back grants, routing, sessions and delivery history", t => {
  const n = fixture(t);
  n.bindSession({ agent: "before", cli: "claude", session_id: `mcp-${process.pid}`, pid: process.pid, session_key: "key" });
  send(n, ["before"]);
  const before = grants(n.store), delivery = n.store.db.prepare("SELECT * FROM deliveries ORDER BY msg_id,agent").all();
  n.store.db.exec("CREATE TRIGGER deny_alias BEFORE INSERT ON mailbox_visibility WHEN new.mailbox='after' BEGIN SELECT RAISE(ABORT,'transfer denied'); END");
  assert.throws(() => n.addAlias("before", "after", process.pid), /transfer denied/);
  assert.deepEqual(grants(n.store), before);
  assert.deepEqual(n.store.db.prepare("SELECT * FROM deliveries ORDER BY msg_id,agent").all(), delivery);
  assert.equal(n.resolveAlias("before"), "before");
  assert.equal(n.agentFor("claude", process.pid), "before");
});

test("v2 migration deterministically backfills visibility without modifying signed mail or ACK receipts", t => {
  const home = mkdtempSync(join(tmpdir(), "mbx-ledger-migrate-"));
  t.after(() => rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  const n = new MbxNode(home, { host: "alpha" });
  const e = send(n, ["sender", "reader"]);
  n.ack(e.id, "reader", "preserved note");
  const foreign = buildEnvelope({ from: "sender@remote", to: ["reader"], subject: "foreign", body: "mail" });
  n.store.insertMessage(foreign, "remote", "verified", null);
  n.store.addDelivery(foreign.id, "reader");
  const localHost = buildEnvelope({ from: "samehost@alpha", to: ["reader"], subject: "local host history", body: "mail" });
  n.store.insertMessage(localHost, "remote", "verified", null);
  const mail = n.store.db.prepare("SELECT * FROM messages ORDER BY id").all();
  const delivery = n.store.db.prepare("SELECT * FROM deliveries ORDER BY msg_id,agent").all();
  n.store.db.exec("DROP TRIGGER deliveries_visibility; DROP TABLE mailbox_visibility; PRAGMA user_version=2");
  n.close();
  const upgraded = new Store(home);
  assert.equal(upgraded.schemaVersion(), SCHEMA_VERSION);
  assert.deepEqual(upgraded.db.prepare("SELECT * FROM messages ORDER BY id").all(), mail);
  assert.deepEqual(upgraded.db.prepare("SELECT * FROM deliveries ORDER BY msg_id,agent").all(), delivery);
  const first = grants(upgraded);
  assert.equal(first.length, 4);
  assert.ok(!first.some(r => r.mailbox === "sender" && r.message_id === foreign.id), "foreign host sender-name collision is not local sender history");
  assert.ok(first.some(r => r.mailbox === "samehost" && r.message_id === localHost.id), "same local host matches current canSee even for remote origin");
  assert.equal(first.filter(r => r.mailbox === "sender" && r.message_id === e.id).length, 1);
  upgraded.db.exec("DROP TRIGGER deliveries_visibility; DROP TABLE mailbox_visibility; PRAGMA user_version=2");
  upgraded.close();
  const repeated = new Store(home);
  try { assert.deepEqual(grants(repeated), first, "equivalent legacy snapshots backfill in the same order"); }
  finally { repeated.close(); }
});

test("failed ledger backfill leaves previous schema and mail unchanged", t => {
  const home = mkdtempSync(join(tmpdir(), "mbx-ledger-abort-"));
  t.after(() => rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  const n = new MbxNode(home, { host: "alpha" });
  send(n);
  const mail = n.store.db.prepare("SELECT * FROM messages").all();
  n.store.db.exec("DELETE FROM mailbox_visibility; PRAGMA user_version=2; CREATE TRIGGER deny_backfill BEFORE INSERT ON mailbox_visibility BEGIN SELECT RAISE(ABORT,'backfill denied'); END");
  n.close();
  assert.throws(() => new Store(home), /backfill denied/);
  const db = new DatabaseSync(join(home, "mbx.db"));
  try {
    assert.equal(db.prepare("PRAGMA user_version").get()!.user_version, 2);
    assert.deepEqual(db.prepare("SELECT * FROM messages").all(), mail);
    assert.equal(db.prepare("SELECT count(*) n FROM mailbox_visibility").get()!.n, 0);
  } finally { db.close(); }
});

test("retained old writers including preprepared statements fail closed after ledger migration", t => {
  const home = mkdtempSync(join(tmpdir(), "mbx-ledger-old-writer-"));
  t.after(() => rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  const n = new MbxNode(home, { host: "alpha" }), e = send(n);
  n.store.db.exec("DROP TRIGGER messages_writer_version; DROP TRIGGER deliveries_writer_version; DROP TRIGGER deliveries_visibility; DROP TABLE mailbox_visibility; PRAGMA user_version=2");
  n.close();
  const old = new DatabaseSync(join(home, "mbx.db"));
  const messageInsert = old.prepare(`INSERT INTO messages (id,ts,from_addr,thread,reply_to,kind,subject,body,envelope,origin,trust,authority,received_at)
    SELECT ?,ts,from_addr,thread,reply_to,kind,subject,body,envelope,origin,trust,authority,received_at FROM messages WHERE id=?`);
  const deliveryInsert = old.prepare("INSERT INTO deliveries (msg_id,agent,state,updated_at,note) VALUES (?,?,'delivered',?,NULL)");
  const current = new Store(home);
  try {
    const before = grants(current);
    assert.throws(() => messageInsert.run("old-write", e.id), /mbx_writer_schema_version/);
    assert.throws(() => deliveryInsert.run(e.id, "old-reader", new Date().toISOString()), /mbx_writer_schema_version/);
    assert.deepEqual(grants(current), before);
    assert.equal(old.prepare("SELECT count(*) n FROM messages").get()!.n, 1, "old connection can still read");
    assert.equal(old.prepare("SELECT 1 FROM deliveries WHERE agent='old-reader'").get(), undefined);
    old.function("mbx_writer_schema_version", () => 2);
    assert.throws(() => deliveryInsert.run(e.id, "old-reader", new Date().toISOString()), /writer schema is stale/);
    current.addDelivery(e.id, "current-reader");
    assert.ok(grants(current).some(r => r.mailbox === "current-reader"));
  } finally { old.close(); current.close(); }
});

test("independent current Store connections append late visibility after committed boundaries", t => {
  const n = fixture(t), e = send(n);
  const second = new Store(n.home);
  try {
    const boundary = grants(n.store).at(-1)!.seq;
    second.addDelivery(e.id, "second-reader");
    n.store.addDelivery(e.id, "third-reader");
    const late = grants(second).filter(r => r.seq > boundary);
    assert.deepEqual(late.map(r => r.mailbox), ["second-reader", "third-reader"]);
    assert.ok(late[1].seq > late[0].seq);
    second.addDelivery(e.id, "second-reader");
    assert.deepEqual(grants(n.store).filter(r => r.seq > boundary), late);
  } finally { second.close(); }
});

test("MCP whoami rename ledger failure rolls back the outer held lease transaction", async t => {
  const home = mkdtempSync(join(tmpdir(), "mbx-ledger-mcp-"));
  const n = new MbxNode(home, { host: "alpha" }), client = new Client({ name: "ledger-rename", version: "1" });
  t.after(async () => { await client.close(); n.close(); rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
  await client.connect(new StdioClientTransport({ command: process.execPath,
    args: [join(import.meta.dirname, "../bin/agentmbx.js"), "mcp"],
    env: { ...process.env, AGENTMBX_DEV: "1", MBX_HOME: n.home, MBX_CLI: "claude", MBX_AGENT: "before", MBX_NO_DESKTOP: "1" } as Record<string,string> }));
  const e = send(n, ["before"]);
  const lease = n.store.db.prepare("SELECT token,released_at FROM identity_leases WHERE name='before'").get()!;
  const before = grants(n.store);
  n.store.db.exec("CREATE TRIGGER deny_mcp_alias BEFORE INSERT ON mailbox_visibility WHEN new.mailbox='after' BEGIN SELECT RAISE(ABORT,'MCP transfer denied'); END");
  const failed = await client.callTool({ name: "mbx_whoami", arguments: { name: "after" } });
  assert.equal(failed.isError, true);
  assert.match(JSON.stringify(failed.content), /MCP transfer denied/);
  assert.deepEqual(n.store.db.prepare("SELECT token,released_at FROM identity_leases WHERE name='before'").get(), lease);
  assert.equal(n.store.db.prepare("SELECT 1 FROM identity_leases WHERE name='after'").get(), undefined);
  assert.deepEqual(grants(n.store), before);
  assert.equal(n.canSee(n.read(e.id), "before"), true);
  assert.equal(n.canSee(n.read(e.id), "after"), false);
  const stillHeld = await client.callTool({ name: "mbx_whoami", arguments: {} });
  assert.notEqual(stillHeld.isError, true, "original MCP state/lease remain usable");
  n.store.db.exec("DROP TRIGGER deny_mcp_alias");
  const renamed = await client.callTool({ name: "mbx_whoami", arguments: { name: "after" } });
  assert.notEqual(renamed.isError, true);
  assert.ok(grants(n.store).some(r => r.mailbox === "after" && r.message_id === e.id));
});

test("malformed existing host configuration rolls back ledger migration", t => {
  const home = mkdtempSync(join(tmpdir(), "mbx-ledger-config-"));
  t.after(() => rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  const n = new MbxNode(home, { host: "alpha" });
  send(n);
  const mail = n.store.db.prepare("SELECT * FROM messages").all(), deliveries = n.store.db.prepare("SELECT * FROM deliveries").all();
  n.store.db.exec("DROP TRIGGER deliveries_visibility; DROP TABLE mailbox_visibility; PRAGMA user_version=2");
  n.close();
  writeFileSync(join(home, "config.json"), "{bad configuration");
  assert.throws(() => new Store(home), /JSON|property|Unexpected/i);
  const db = new DatabaseSync(join(home, "mbx.db"));
  try {
    assert.equal(db.prepare("PRAGMA user_version").get()!.user_version, 2);
    assert.equal(db.prepare("SELECT 1 FROM sqlite_master WHERE name='mailbox_visibility'").get(), undefined);
    assert.deepEqual(db.prepare("SELECT * FROM messages").all(), mail);
    assert.deepEqual(db.prepare("SELECT * FROM deliveries").all(), deliveries);
  } finally { db.close(); }
});
