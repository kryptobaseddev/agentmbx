// Relay backup, restore and retention (T167, docs/spec/relay-durability.md §5–§7). A restore rotates the epoch, keeps
// every revocation and newer signed allowlist the live store had (it never brings back authority), and recovers mail
// accepted after the backup from its senders; dedup on both ends absorbs the repeats. The retention sweep expires only
// what is past its expiry, tells each sender with a relay-signed notice, keeps a tombstone so a late retry is never a
// re-delivery, and frees quota. No restore, dedup or expiry rule (relay or local) can drop accepted mail silently. Every
// operation leaves a receipt in the relay log, and a restore keeps the store it replaced as a rollback copy.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer, type AddressInfo } from "node:net";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { canonical, generateKeyPair, signData, verifyData, type KeyPair } from "../src/crypto.ts";
import { generateEncKeyPair } from "../src/body-encryption.ts";
import { buildEnvelope, sealEnvelope } from "../src/envelope.ts";
import { MbxNode } from "../src/node.ts";
import { RelayCore, startRelayServer, wireHash, type ExpiryNotice } from "../src/relay.ts";
import { SqliteRelayStore } from "../src/relay-store.ts";
import { backupStore, lockStore, readOps, restoreStore, sha256File } from "../src/relay-ops.ts";
import { relayEpochChanged, relayOpen, relayPushOutbox, relayPushReceipts, relayReceive, relaySettle, RELAY_DEADLINE_GRACE_MS, type RelaySession } from "../src/relay-v2.ts";
import { flushOutbox, startServer } from "../src/http.ts";
import { prune, PRUNED_ID_KEEP_DAYS } from "../src/retention.ts";

const BIN = join(import.meta.dirname, "../bin/agentmbx.js");
const DAY = 86_400_000;
const pair = (a: MbxNode, b: MbxNode) => {
  a.addApprovedPeer({ host: b.host, pubkey: b.key.publicKey, owner_pubkey: null, addr: "127.0.0.1:1" }, "fixture");
  b.addApprovedPeer({ host: a.host, pubkey: a.key.publicKey, owner_pubkey: null, addr: "127.0.0.1:1" }, "fixture");
};
const count = (n: MbxNode, sql: string, ...args: (string | number)[]) => Number((n.store.db.prepare(sql).get(...args) as { c: number }).c);
const lanFailedTwice = (n: MbxNode) => n.store.db.prepare("UPDATE outbox SET attempts=2, next_at=?").run(new Date(Date.now() - 1000).toISOString());
const receiptsDue = (n: MbxNode) => n.store.db.prepare("UPDATE receipt_outbox SET attempts=2, next_at=?").run(new Date(Date.now() - 1000).toISOString());
const freePort = () => new Promise<number>((resolve) => { const s = createServer(); s.listen(0, "127.0.0.1", () => { const { port } = s.address() as AddressInfo; s.close(() => resolve(port)); }); });
const closeServer = (s: Server) => new Promise<void>((r) => s.close(() => r()));
const subjects = (n: MbxNode, agent = "bob") => n.inbox(agent).map((m) => m.subject).sort();
const mode = (path: string) => statSync(path).mode & 0o777;
const state = (n: MbxNode, id: string) => (n.store.db.prepare("SELECT state FROM relay_sent WHERE msg_id=?").get(id) as { state: string } | undefined)?.state;
function enrol(core: RelayCore, host: string, key: KeyPair) {
  const challenge = core.challenge(host, key.publicKey);
  core.enrol(host, key.publicKey, "", signData(key.privateKey, canonical({ v: 1, challenge, host, pubkey: key.publicKey, owner_fp: "" })));
}

/** Two paired hosts and a relay whose store lives in `dir` and which can be stopped and started on the same URL. */
async function world(t: { after: (fn: () => unknown) => void }) {
  const homes = [mkdtempSync(join(tmpdir(), "mbx-rec-a-")), mkdtempSync(join(tmpdir(), "mbx-rec-b-"))], dir = mkdtempSync(join(tmpdir(), "mbx-rec-relay-"));
  const a = new MbxNode(homes[0], { host: "alpha" }), b = new MbxNode(homes[1], { host: "beta" });
  pair(a, b); a.registerAgent("alice"); b.registerAgent("bob");
  const key = generateKeyPair(), port = await freePort(), relay = `http://127.0.0.1:${port}`;
  let core: RelayCore | null = null, server: Server | null = null, lock: ReturnType<typeof lockStore> = null;
  /** Like `relay serve`: hold the store lock, open the store, listen; stop releases all three. */
  const start = async () => {
    lock = lockStore(dir); assert.ok(lock, "the store is free");
    core = new RelayCore({}, { store: new SqliteRelayStore(join(dir, "relay.db")), key, log: () => {} });
    server = await startRelayServer(core, port, "127.0.0.1", { log: () => {} });
    return core;
  };
  const stop = async () => { if (server) await closeServer(server); core?.store.close(); lock?.release(); server = null; core = null; lock = null; };
  t.after(async () => { await stop(); a.close(); b.close(); [...homes, dir].forEach((h) => rmSync(h, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })); });
  const open = async (n: MbxNode): Promise<RelaySession> => { const s = await relayOpen(n, relay); assert.ok(s, "v2 session"); return s!; };
  await start();
  await open(b); await open(a);
  const send = async (subject: string) => { const id = a.send({ from: "alice", to: ["bob@beta"], subject, body: subject }).envelope.id; lanFailedTwice(a); assert.equal((await relayPushOutbox(a, await open(a))).accepted, 1); return id; };
  return { a, b, dir, key, relay, start, stop, open, send, core: () => core! };
}

test("restore drill: backup while running, mail accepted after the backup comes back from senders, nothing twice, no authority recreated", async (t) => {
  const w = await world(t);
  const { a, b, dir } = w;
  const gamma = generateKeyPair();
  enrol(w.core(), "gamma", gamma); // a host the operator revokes after the backup
  const m1 = await w.send("m1"); // delivered and confirmed before the backup
  await relayReceive(b, await w.open(b)); receiptsDue(b); await relayPushReceipts(b, await w.open(b));
  await relayReceive(a, await w.open(a)); assert.equal(relaySettle(a).settled, 1);
  const m2 = await w.send("m2"); // delivered before the backup, its receipt never came back
  await relayReceive(b, await w.open(b));
  b.store.db.prepare("DELETE FROM receipt_outbox").run();
  const m3 = await w.send("m3"); // queued at the relay when the backup runs, delivered after it
  const backupFile = join(dir, "backups", "relay-1.db");
  const backup = await backupStore(dir, backupFile); // the relay is running and serving
  assert.equal(backup.sha256, await sha256File(backupFile));
  assert.deepEqual([mode(backupFile), mode(join(dir, "backups"))], [0o600, 0o700], "a backup is owner-only, in an owner-only directory");
  assert.deepEqual([backup.epoch, backup.counts.items, backup.counts.enrolments], [w.core().store.epoch(), 1, 3]);
  assert.match(backup.restore, /^agentmbx relay restore .*relay-1\.db --store-dir /);
  await assert.rejects(backupStore(dir, backupFile), /never overwrites/);
  const m5 = await w.send("m5"); // accepted after the backup and delivered (with m3), unconfirmed
  await relayReceive(b, await w.open(b));
  b.store.db.prepare("DELETE FROM receipt_outbox").run();
  const m4 = await w.send("m4"); // accepted after the backup, never pulled: once the relay restores, only alpha has it
  // after the backup the operator revokes gamma, beta publishes its enc-key ad again, and pairs a new host (its allowlist grows)
  (w.core().store as SqliteRelayStore).revokeEnrolment(gamma.publicKey, new Date().toISOString());
  await new Promise((r) => setTimeout(r, 5)); // a strictly newer ad
  w.core().publishEncAd("beta", b.key.publicKey, b.encKey.publicKey, signData(b.key.privateKey, canonical({ v: 1, host: "beta", enc_pub: b.encKey.publicKey })));
  const adAt = (w.core().store as SqliteRelayStore).db.prepare("SELECT at FROM enc_ads WHERE host_pubkey=?").get(b.key.publicKey) as { at: string };
  const delta = generateKeyPair();
  b.addApprovedPeer({ host: "delta", pubkey: delta.publicKey, owner_pubkey: null, addr: "127.0.0.1:1" }, "fixture");
  await w.open(b);
  assert.ok(w.core().store.senderList(b.key.publicKey)!.senders.includes(delta.publicKey));
  const oldEpoch = w.core().store.epoch(), floor = w.core().store.lastSeq(b.key.publicKey);
  assert.deepEqual(subjects(b), ["m1", "m2", "m3", "m5"]);

  // the volume dies; the operator restores last night's backup (never under a running relay)
  await assert.rejects(restoreStore(dir, backupFile), (e: Error & { code?: string }) => e.code === "RELAY_RUNNING");
  await w.stop();
  await assert.rejects(restoreStore(dir, join(dir, "nope.db")), /no backup/);
  const r = await restoreStore(dir, backupFile);
  assert.equal(r.epoch.from, backup.epoch, "the backup's epoch");
  assert.notEqual(r.epoch.to, oldEpoch); assert.notEqual(r.epoch.to, r.epoch.from);
  assert.deepEqual(r.carried, { revocations: 1, sender_lists: 1, enc_ads: 1, seq_floors: 1 });
  assert.ok(r.replaced && existsSync(r.replaced.rollback) && r.replaced.sha256 === await sha256File(r.replaced.rollback), "the replaced store is kept");
  assert.deepEqual([mode(r.replaced!.rollback), mode(join(dir, "rollback")), mode(join(dir, "relay.db"))], [0o600, 0o700, 0o600], "rollback copy and restored store are owner-only");
  assert.equal(r.replaced!.epoch, oldEpoch);
  assert.equal(r.rollback, `agentmbx relay restore ${r.replaced!.rollback} --store-dir ${dir}`);
  const core = await w.start();
  assert.equal(core.store.epoch(), r.epoch.to, "serve keeps the restored epoch (no second rotation)");
  assert.throws(() => core.requireEnrolled(gamma.publicKey), /not enrolled/, "a key revoked after the backup stays revoked");
  assert.throws(() => enrol(core, "gamma", gamma), /revoked/);
  assert.ok(core.store.senderList(b.key.publicKey)!.senders.includes(delta.publicKey), "the newer signed allowlist is kept");
  assert.equal((core.store as SqliteRelayStore).db.prepare("SELECT at FROM enc_ads WHERE host_pubkey=?").get(b.key.publicKey)!.at, adAt.at, "the newer signed enc-key ad is kept");
  assert.equal(core.store.targetUsage(b.key.publicKey).items, 1, "quota counts the restored queue only (m3)");

  // clients see the new epoch: alpha re-pushes everything beta has not confirmed, beta re-pulls from 0
  const sa = await w.open(a);
  assert.deepEqual([m2, m3, m4, m5].map((id) => state(a, id)), ["repush", "repush", "repush", "repush"]);
  assert.equal(state(a, m1), "settled", "confirmed mail is not re-pushed");
  assert.deepEqual(await relayPushOutbox(a, sa), { accepted: 4, rejected: 0 });
  assert.deepEqual([m1, m2, m3, m4, m5].map((id) => state(a, id)), ["settled", "relay-accepted", "relay-accepted", "relay-accepted", "relay-accepted"]);
  assert.ok(core.store.lastSeq(b.key.publicKey) > floor, "sequence numbers never go back across a restore");
  await relayReceive(b, await w.open(b));
  assert.deepEqual(subjects(b), ["m1", "m2", "m3", "m4", "m5"], "m4 existed only at alpha and came back; m3 and m5 came again and were duplicates");
  assert.equal(core.store.targetUsage(b.key.publicKey).items, 0, "all acked");
  // receipts the restore lost: a duplicate means its sender is still waiting, so beta owes the receipt again
  receiptsDue(b); await relayPushReceipts(b, await w.open(b));
  await relayReceive(a, await w.open(a)); relaySettle(a);
  assert.deepEqual([m3, m4, m5].map((id) => state(a, id)), ["settled", "settled", "settled"]);
  assert.equal(state(a, m2), "relay-accepted", "m2 was acked before the backup and is not re-delivered: its sender waits for its deadline, never loses it silently");
  // the relay log carries the operator's history across the restore
  const ops = readOps(dir).map((o) => o.op);
  assert.deepEqual(ops.slice(0, 2), ["restore", "backup"]);

  // rollback: restore the replaced store; again a new epoch, again everybody converges
  await w.stop();
  const back = await restoreStore(dir, r.replaced!.rollback);
  assert.equal(back.epoch.from, oldEpoch);
  assert.ok(back.carried.revocations === 0, "gamma was already revoked in the rollback copy");
  await w.start();
  await relayPushOutbox(a, await w.open(a));
  const m6 = await w.send("m6");
  await relayReceive(b, await w.open(b));
  assert.deepEqual(subjects(b), ["m1", "m2", "m3", "m4", "m5", "m6"], "after two restores, every message exactly once");
  assert.equal(state(a, m6), "relay-accepted");
  assert.deepEqual(readOps(dir).slice(0, 3).map((o) => o.op), ["restore", "restore", "backup"]);
});

test("restore refuses a running relay, another relay's backup, a newer schema and non-stores, and leaves the live store untouched", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "mbx-rec-refuse-")), other = mkdtempSync(join(tmpdir(), "mbx-rec-other-"));
  t.after(() => [dir, other].forEach((d) => rmSync(d, { recursive: true, force: true })));
  const key = generateKeyPair();
  let core = new RelayCore({}, { store: new SqliteRelayStore(join(dir, "relay.db")), key, log: () => {} });
  enrol(core, "alpha", generateKeyPair());
  const backup = join(other, "mine.db");
  await backupStore(dir, backup);
  core.store.close();
  const epoch = () => { const s = new SqliteRelayStore(join(dir, "relay.db")); try { return s.epoch(); } finally { s.close(); } };
  const before = epoch();

  const lock = lockStore(dir)!; // a relay holds the store
  assert.ok(lock);
  assert.equal(lockStore(dir), null, "one holder at a time, also within one process");
  await assert.rejects(restoreStore(dir, backup), (e: Error & { code?: string }) => e.code === "RELAY_RUNNING");
  lock.release();

  const foreign = new RelayCore({}, { store: new SqliteRelayStore(join(other, "relay.db")), key: generateKeyPair(), log: () => {} });
  foreign.store.close();
  await assert.rejects(restoreStore(dir, join(other, "relay.db")), /another relay key/);
  const newer = join(other, "newer.db");
  copyFileSync(backup, newer);
  const db = new DatabaseSync(newer); db.prepare("UPDATE meta SET v='99' WHERE k='schema_version'").run(); db.close();
  await assert.rejects(restoreStore(dir, newer), /schema 99, newer than this agentmbx/);
  const plain = join(other, "plain.db");
  const p = new DatabaseSync(plain); p.exec("CREATE TABLE t (x)"); p.close();
  await assert.rejects(restoreStore(dir, plain), /not a relay store/);
  writeFileSync(join(other, "junk.db"), "not sqlite at all, just some bytes that are long enough to be a header".repeat(20));
  await assert.rejects(restoreStore(dir, join(other, "junk.db")));
  assert.equal(epoch(), before, "every refusal left the live store as it was");
  assert.ok(!existsSync(join(dir, "rollback")) || readdirSync(join(dir, "rollback")).length === 0, "no rollback copy for a refused restore");

  // a store from before relay.lock: a fresh heartbeat means an older relay may still run
  rmSync(join(dir, "relay.lock"), { force: true });
  const s = new SqliteRelayStore(join(dir, "relay.db")); s.setMeta("heartbeat", String(Date.now())); s.close();
  await assert.rejects(restoreStore(dir, backup), /heartbeat .* s ago/);
  assert.equal((await restoreStore(dir, backup, { force: true })).backup.sha256, await sha256File(backup));

  // a current store that cannot be read: its revocations cannot be carried, so only --force restores, keeping its bytes
  writeFileSync(join(dir, "relay.db"), Buffer.alloc(8192, 7));
  await assert.rejects(restoreStore(dir, backup), (e: Error & { code?: string }) => e.code === "CURRENT_UNREADABLE");
  const forced = await restoreStore(dir, backup, { force: true });
  assert.equal(forced.replaced?.readable, false);
  assert.ok(forced.rollback?.endsWith("--force"));
  assert.deepEqual(forced.carried, { revocations: 0, sender_lists: 0, enc_ads: 0, seq_floors: 0 });
  core = new RelayCore({}, { store: new SqliteRelayStore(join(dir, "relay.db")), key, log: () => {} });
  t.after(() => core.store.close());
  assert.equal(core.store.epoch(), forced.epoch.to);
});

test("retention sweep: only expired items go, each expired envelope's sender gets a signed notice, tombstones stop re-delivery, quota is freed", (t) => {
  const core = new RelayCore({ maxQueueDepth: 3 }, { store: new SqliteRelayStore(":memory:", { now: () => 0 }), log: () => {} });
  t.after(() => core.store.close());
  const alpha = generateKeyPair(), beta = generateKeyPair(), gone = generateKeyPair();
  enrol(core, "alpha", alpha); enrol(core, "beta", beta); enrol(core, "gone", gone);
  {
    const enc = generateEncKeyPair();
    const sealed = (from: string, key: KeyPair) => sealEnvelope(buildEnvelope({ from: `x@${from}`, to: ["bob@beta"], subject: "s", body: "b" }), enc.publicKey, from, key.publicKey, key.privateKey);
    const push = (host: string, key: KeyPair, e: ReturnType<typeof sealed>) => core.pushItems({ host, pubkey: key.publicKey }, [{ kind: "envelope", item_id: e.id, targets: [{ host_pubkey: beta.publicKey, wire_b64: Buffer.from(JSON.stringify(e)).toString("base64") }] }])[0]!;
    const old = sealed("alpha", alpha), live = sealed("alpha", alpha), orphan = sealed("gone", gone);
    const first = push("alpha", alpha, old); push("alpha", alpha, live); push("gone", gone, orphan);
    const rec = { v: 1, type: "receipt", msg: "01M3XPVHH2E83AW8KYVYVFH8KW", recipient: "bob@beta", state: "acked", at: new Date().toISOString(), seq: 1 };
    const receipt = canonical({ rec, sig: signData(beta.privateKey, canonical(rec)) });
    core.pushItems({ host: "beta", pubkey: beta.publicKey }, [{ kind: "receipt", item_id: `receipt:${rec.msg}:${rec.recipient}:1`, targets: [{ host_pubkey: alpha.publicKey, wire_b64: Buffer.from(receipt).toString("base64") }] }]);
    const db = (core.store as SqliteRelayStore).db, now = Date.now();
    // everything but `live` is past its retention; `gone` was revoked meanwhile
    db.prepare("UPDATE items SET accepted_at=?, expires_at=? WHERE item_id<>?").run(new Date(now - 15 * DAY).toISOString(), new Date(now - DAY).toISOString(), live.id);
    (core.store as SqliteRelayStore).revokeEnrolment(gone.publicKey, new Date().toISOString());
    const usedBefore = core.store.targetUsage(beta.publicKey);
    const r = core.sweep(now);
    assert.deepEqual([r.expired, r.notices, r.notices_skipped], [{ envelope: 2, receipt: 1, expired: 0 }, 1, { not_enrolled: 1, over_cap: 0 }]);
    assert.deepEqual(core.pullItems(beta.publicKey).items.map((i) => i.item_id), [live.id], "the live item is untouched");
    const freed = usedBefore.bytes - core.store.targetUsage(beta.publicKey).bytes;
    assert.ok(freed > 0 && core.store.targetUsage(beta.publicKey).items === 1, "expired items no longer count against the target's quota");
    assert.equal(core.store.senderUsage(alpha.publicKey, beta.publicKey).items, 1);
    // the notice: queued for alpha, signed by the relay key, naming the item, its target and both times
    const [n] = core.pullItems(alpha.publicKey).items;
    assert.equal(n?.kind, "expired");
    assert.equal(n?.item_id, `expired:${old.id}:${beta.publicKey}`);
    assert.equal(n?.sender_pubkey, core.key.publicKey);
    const { notice, sig } = JSON.parse(Buffer.from(n!.wire_b64, "base64").toString("utf8")) as { notice: ExpiryNotice; sig: string };
    assert.deepEqual({ ...notice }, { v: 1, type: "relay-expired", item_id: old.id, target_pubkey: beta.publicKey, accepted_at: new Date(now - 15 * DAY).toISOString(), expired_at: new Date(now).toISOString() });
    assert.ok(verifyData(core.key.publicKey, canonical(notice), sig));
    // a late retry is a duplicate with the original time, never a re-delivery after expiry
    const late = push("alpha", alpha, old);
    assert.equal(late.status, "duplicate");
    assert.equal(late.accept!.at, first.accept!.at, "the original acceptance time: the sender's deadline is not reset");
    assert.deepEqual(core.pullItems(beta.publicKey).items.map((i) => i.item_id), [live.id]);
    // sweeping again tells nobody twice; the tombstone lives until the dedup horizon (retention + 7 days)
    assert.deepEqual([core.sweep(now).notices, core.pullItems(alpha.publicKey).items.length], [0, 1]);
    db.prepare("UPDATE dedup SET accepted_at=? WHERE item_id IN (?, ?)").run(new Date(now - 22 * DAY).toISOString(), old.id, live.id);
    assert.equal(core.sweep(now).dedup_pruned, 1, "the tombstone goes; the live item's dedup row stays however old");
    assert.ok(core.store.dedup(alpha.publicKey, live.id, beta.publicKey));
    // a sender whose own queue is full is not told by the relay (its deadline covers it), and the cap holds
    for (let i = 0; i < 2; i++) core.pushItems({ host: "beta", pubkey: beta.publicKey }, [{ kind: "receipt", item_id: `receipt:${rec.msg}:${rec.recipient}:${i + 2}`,
      targets: [{ host_pubkey: alpha.publicKey, wire_b64: Buffer.from(canonical({ rec: { ...rec, seq: i + 2 }, sig: signData(beta.privateKey, canonical({ ...rec, seq: i + 2 })) })).toString("base64") }] }]);
    assert.equal(core.store.targetUsage(alpha.publicKey).items, 3);
    db.prepare("UPDATE items SET expires_at=? WHERE item_id=?").run(new Date(now - 1).toISOString(), live.id);
    const capped = core.sweep(now);
    assert.deepEqual([capped.expired.envelope, capped.notices, capped.notices_skipped.over_cap], [1, 0, 1]);
    assert.equal(core.store.targetUsage(alpha.publicKey).items, 3, "never above the cap");
    assert.deepEqual(core.store.ops(10).map((o) => o.op), ["sweep", "sweep", "sweep"], "each sweep that changed something left a receipt");
    assert.equal((core.store.ops(1)[0]!.receipt as { notices_skipped: { over_cap: number } }).notices_skipped.over_cap, 1);
  }
});

test("the sender applies an expiry notice: the row ends expired with an alert; a confirmed or a forged one alarms nobody", async (t) => {
  const w = await world(t);
  const { a, b } = w;
  const m1 = await w.send("never collected");
  const core = w.core(), db = (core.store as SqliteRelayStore).db;
  db.prepare("UPDATE items SET expires_at=? WHERE item_id=?").run(new Date(Date.now() - 1).toISOString(), m1);
  assert.equal(core.sweep().notices, 1);
  await relayReceive(a, await w.open(a));
  assert.equal(state(a, m1), "expired");
  const alert = a.inbox("alice").find((m) => m.subject === "Undelivered to beta: never collected");
  assert.ok(alert, "the sender is told, like the LAN outbox after 72 h");
  assert.match(alert!.body, /never collected it, so the relay expired it/);
  assert.equal(count(a, "SELECT COUNT(*) c FROM relay_wire"), 0);
  assert.equal(count(a, "SELECT COUNT(*) c FROM relay_quarantine"), 0);
  await relayReceive(b, await w.open(b));
  assert.deepEqual(subjects(b), [], "and it never arrives late");

  // a notice for mail the target already confirmed (its pull raced the sweep) settles the row instead
  const m2 = await w.send("raced");
  await relayReceive(b, await w.open(b)); receiptsDue(b); await relayPushReceipts(b, await w.open(b));
  const notice = (item: string): ExpiryNotice => ({ v: 1, type: "relay-expired", item_id: item, target_pubkey: b.key.publicKey, accepted_at: new Date(Date.now() - 14 * DAY).toISOString(), expired_at: new Date().toISOString() });
  const queue = (n: ExpiryNotice, signer = core.key) => {
    const wire = Buffer.from(canonical({ notice: n, sig: signData(signer.privateKey, canonical(n)) }));
    core.store.insertItem({ target_pubkey: a.key.publicKey, kind: "expired", item_id: `expired:${n.item_id}:${n.target_pubkey}:${Math.random()}`, sender_pubkey: core.key.publicKey,
      sender_host: "relay", wire, wire_hash: wireHash(wire), bytes: wire.length, accepted_at: new Date().toISOString(), expires_at: null });
  };
  queue(notice(m2));
  await relayReceive(a, await w.open(a));
  assert.equal(state(a, m2), "settled");
  assert.equal(a.inbox("alice").filter((m) => m.subject.startsWith("Undelivered")).length, 1, "no second alert");

  // a notice not signed by the pinned relay key is quarantined, and changes nothing
  const m3 = await w.send("forged");
  queue(notice(m3), generateKeyPair());
  await relayReceive(a, await w.open(a));
  assert.equal(state(a, m3), "relay-accepted");
  assert.match((a.store.db.prepare("SELECT reason r FROM relay_quarantine").get() as { r: string }).r, /bad expiry notice/);

  // a notice for a row waiting to be re-pushed after a restore ends it too: no pointless re-push of expired mail
  relayEpochChanged(a, w.relay, a.store.get(`relay-epoch:${w.relay}`)!, "rewind");
  assert.deepEqual([state(a, m3), count(a, "SELECT COUNT(*) c FROM outbox WHERE msg_id=?", m3)], ["repush", 1]);
  queue(notice(m3));
  await relayReceive(a, await w.open(a));
  assert.deepEqual([state(a, m3), count(a, "SELECT COUNT(*) c FROM outbox WHERE msg_id=?", m3)], ["expired", 0]);
});

test("no local expiry rule loses accepted mail: prune keeps relay-held mail, the LAN's 72 h never drops a re-push, the relay deadline decides", async (t) => {
  const w = await world(t);
  const { a } = w;
  const m1 = await w.send("held by the relay");
  a.store.db.prepare("UPDATE messages SET received_at=? WHERE id=?").run(new Date(Date.now() - 30 * DAY).toISOString(), m1);
  const p = prune(a.store, 7);
  assert.equal(p.messages, 0, "a relay-accepted message is still owed a receipt or an alert: never pruned");
  assert.equal(p.kept.outbox, 1);
  // a restore puts it back for a re-push; the relay is gone and the LAN is down for days
  relayEpochChanged(a, w.relay, "another-epoch", "epoch");
  a.store.db.prepare("UPDATE outbox SET created_at=?, next_at=? WHERE msg_id=?").run(new Date(Date.now() - 4 * DAY).toISOString(), new Date(Date.now() - 1000).toISOString(), m1);
  const flushed = await flushOutbox(a);
  assert.deepEqual(flushed, { sent: 0, failed: 0 }, "the LAN failed, but did not give up after 72 h");
  assert.deepEqual([state(a, m1), count(a, "SELECT COUNT(*) c FROM outbox WHERE msg_id=?", m1)], ["repush", 1]);
  assert.equal(a.inbox("alice").filter((m) => m.subject.startsWith("Undelivered")).length, 0);
  assert.equal(prune(a.store, 7).messages, 0, "a re-push is held too");
  // the relay deadline, set from the original acceptance, ends it with an alert and clears the outbox
  const deadline = Date.parse((a.store.db.prepare("SELECT deadline_at d FROM relay_sent WHERE msg_id=?").get(m1) as { d: string }).d);
  assert.deepEqual(relaySettle(a, deadline - 1), { settled: 0, unconfirmed: 0 });
  assert.deepEqual(relaySettle(a, deadline + 1), { settled: 0, unconfirmed: 1 });
  assert.deepEqual([state(a, m1), count(a, "SELECT COUNT(*) c FROM outbox WHERE msg_id=?", m1)], ["unconfirmed", 0]);
  assert.ok(a.inbox("alice").some((m) => m.subject === "Undelivered/unconfirmed to beta: held by the relay"));
  assert.ok(deadline <= Date.now() + 14 * DAY + RELAY_DEADLINE_GRACE_MS + 60_000);
  // a re-push the target confirms meanwhile settles and leaves the outbox
  const m2 = await w.send("confirmed later");
  relayEpochChanged(a, w.relay, "a-third-epoch", "epoch");
  assert.equal(state(a, m2), "repush");
  await relayReceive(w.b, await w.open(w.b)); receiptsDue(w.b); await relayPushReceipts(w.b, await w.open(w.b));
  await relayReceive(a, await w.open(a));
  assert.equal(relaySettle(a).settled, 1);
  assert.deepEqual([state(a, m2), count(a, "SELECT COUNT(*) c FROM outbox WHERE msg_id=?", m2)], ["settled", 0]);
});

test("CLI: backup while serving, restore refused while serving, restore after stop, MBX_RELAY_RESTORE_FROM once, receipts in the relay log", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "mbx-rec-cli-")), home = mkdtempSync(join(tmpdir(), "mbx-rec-cli-home-"));
  t.after(() => [dir, home].forEach((d) => rmSync(d, { recursive: true, force: true })));
  const env = { ...process.env, AGENTMBX_DEV: "1", MBX_HOME: home, MBX_NO_DESKTOP: "1", MBX_NO_UPDATE_CHECK: "1" };
  const run = (args: string[], extra: Record<string, string> = {}) => new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
    const p = spawn(process.execPath, [BIN, "relay", ...args, "--store-dir", dir], { env: { ...env, ...extra }, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    p.stdout.on("data", (c: Buffer) => { stdout += c; }); p.stderr.on("data", (c: Buffer) => { stderr += c; });
    p.on("exit", (code) => resolve({ code, stdout, stderr }));
  });
  const port = await freePort(), url = `http://127.0.0.1:${port}`;
  const serve = async (extra: Record<string, string> = {}) => {
    const p = spawn(process.execPath, [BIN, "relay", "serve", "--port", String(port), "--bind", "127.0.0.1", "--store-dir", dir], { env: { ...env, ...extra }, stdio: ["ignore", "pipe", "pipe"] });
    let out = "", err = "";
    p.stdout.on("data", (c: Buffer) => { out += c; }); p.stderr.on("data", (c: Buffer) => { err += c; });
    const exited = new Promise<void>((r) => p.on("exit", () => r()));
    for (const end = Date.now() + 60_000; !out.includes("listening on"); await new Promise((r) => setTimeout(r, 25))) {
      if (p.exitCode !== null || Date.now() > end) assert.fail(`relay serve did not start: ${err}`);
    }
    return { stop: async () => { p.kill("SIGTERM"); await exited; }, stderr: () => err };
  };
  const info = async () => (await (await fetch(`${url}/v2/relay/info`)).json()) as { epoch: string; relay_pubkey: string };
  let relay = await serve();
  t.after(() => relay.stop());
  const first = await info();
  const b1 = await run(["backup", join(dir, "b1.db")]);
  assert.equal(b1.code, 0, b1.stderr);
  const receipt = JSON.parse(b1.stdout) as { type: string; sha256: string; epoch: string; file: string };
  assert.deepEqual([receipt.type, receipt.epoch, receipt.sha256], ["relay-backup", first.epoch, await sha256File(join(dir, "b1.db"))]);
  const refused = await run(["restore", join(dir, "b1.db")]);
  assert.notEqual(refused.code, 0);
  assert.match(refused.stderr, /a relay is running on .* stop it first/);
  assert.equal((await info()).epoch, first.epoch, "the refused restore changed nothing");

  await relay.stop();
  const restored = await run(["restore", join(dir, "b1.db")]);
  assert.equal(restored.code, 0, restored.stderr);
  const rr = JSON.parse(restored.stdout) as { type: string; epoch: { from: string; to: string }; rollback: string };
  assert.equal(rr.type, "relay-restore");
  assert.match(restored.stderr, /undo with agentmbx relay restore .*rollback/);
  relay = await serve();
  const after = await info();
  assert.deepEqual([after.epoch, after.relay_pubkey], [rr.epoch.to, first.relay_pubkey], "the new epoch is what clients see; the key is the same");

  // the hosted path: MBX_RELAY_RESTORE_FROM restores at start, under the lock, once
  assert.equal((await run(["backup", join(dir, "b2.db")])).code, 0);
  await relay.stop();
  relay = await serve({ MBX_RELAY_RESTORE_FROM: join(dir, "b2.db") });
  const third = await info();
  assert.notEqual(third.epoch, after.epoch);
  assert.match(relay.stderr(), /restored .*b2\.db at start: epoch .* unset MBX_RELAY_RESTORE_FROM/);
  // the variable is consumed by its path: another file at that path, or other restores since, never restore it again
  assert.equal((await run(["backup", join(dir, "b3.db")])).code, 0);
  await relay.stop();
  copyFileSync(join(dir, "b3.db"), join(dir, "b2.db"));
  relay = await serve({ MBX_RELAY_RESTORE_FROM: join(dir, "b2.db") });
  assert.equal((await info()).epoch, third.epoch, "a restart with the variable still set restores nothing, though the file changed");
  assert.match(relay.stderr(), /MBX_RELAY_RESTORE_FROM ignored: already restored from .*b2\.db at .*; unset MBX_RELAY_RESTORE_FROM/);
  await relay.stop();
  const again = await run(["restore", join(dir, "b3.db")]); // rewrites meta.restored
  assert.equal(again.code, 0, again.stderr);
  const fourth = (JSON.parse(again.stdout) as { epoch: { to: string } }).epoch.to;
  relay = await serve({ MBX_RELAY_RESTORE_FROM: join(dir, "b2.db") });
  assert.equal((await info()).epoch, fourth, "still consumed after another restore");
  assert.match(relay.stderr(), /ignored: already restored from/);

  const rot = await run(["rotate-epoch"]); // works while serving: the relay reads its epoch from the store
  assert.equal(rot.code, 0, rot.stderr);
  assert.equal((await info()).epoch, (JSON.parse(rot.stdout) as { to: string }).to);
  const log = await run(["log", "--json"]);
  assert.equal(log.code, 0, log.stderr);
  assert.deepEqual((JSON.parse(log.stdout) as { op: string }[]).map((o) => o.op), ["epoch-rotated", "restore", "backup", "restore", "backup", "restore", "backup"]);
  const text = await run(["log"]);
  assert.match(text.stdout, /restore .*b3\.db epoch .* -> .*; undo: agentmbx relay restore/);
});

test("a restore never re-delivers mail the receiver acked and pruned: pruned ids are tombstones", async (t) => {
  const w = await world(t);
  const { a, b, dir } = w;
  const id = await w.send("old work");
  const file = join(dir, "backups", "before-pull.db");
  await backupStore(dir, file); // the item is still queued in this backup
  await relayReceive(b, await w.open(b));
  b.ack(id, "bob");
  const pruned = prune(b.store, 1, { now: Date.now() + 3 * DAY });
  assert.equal(pruned.messages, 1);
  assert.deepEqual([b.store.hasMessage(id), b.store.wasPruned(id)], [false, true]);
  await w.stop();
  await restoreStore(dir, file);
  await w.start();
  await relayPushOutbox(a, await w.open(a)); // alpha re-pushes (no receipt reached it)
  await relayReceive(b, await w.open(b)); // beta re-pulls from 0: the restored queue still holds the item
  assert.equal(b.store.hasMessage(id), false, "not stored again");
  assert.deepEqual(b.inbox("bob", { all: true }).map((m) => m.subject), [], "bob is not woken for stale, acked work");
  assert.equal(w.core().store.targetUsage(b.key.publicKey).items, 0, "taken as a duplicate and acked");
  // the tombstone outlives anything a relay can hand back (relay retention + dedup grace), then goes
  prune(b.store, 1, { now: Date.now() + (3 + PRUNED_ID_KEEP_DAYS - 1) * DAY });
  assert.equal(b.store.wasPruned(id), true);
  prune(b.store, 1, { now: Date.now() + (3 + PRUNED_ID_KEEP_DAYS + 1) * DAY });
  assert.equal(b.store.wasPruned(id), false);
});

test("expiry applies to v2 items only: v1 pushes and items queued before the upgrade never expire", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "mbx-rec-v1-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const key = generateKeyPair(), alpha = generateKeyPair(), beta = generateKeyPair(), enc = generateEncKeyPair();
  let core = new RelayCore({}, { store: new SqliteRelayStore(join(dir, "relay.db")), key, log: () => {} });
  enrol(core, "alpha", alpha); enrol(core, "beta", beta);
  const sealed = () => sealEnvelope(buildEnvelope({ from: "x@alpha", to: ["bob@beta"], subject: "s", body: "b" }), enc.publicKey, "alpha", alpha.publicKey, alpha.privateKey);
  const v1 = sealed(), v2 = sealed(), legacy = sealed();
  const pushV2 = (e: ReturnType<typeof sealed>) => core.pushItems({ host: "alpha", pubkey: alpha.publicKey }, [{ kind: "envelope", item_id: e.id, targets: [{ host_pubkey: beta.publicKey, wire_b64: Buffer.from(JSON.stringify(e)).toString("base64") }] }])[0]!;
  assert.equal(pushV2(legacy).status, "accepted");
  // a store from before T167: it never enforced expiry, so it cannot tell its v1 items from its v2 items
  const db = (core.store as SqliteRelayStore).db;
  db.prepare("DELETE FROM meta WHERE k='expiry_from'").run();
  core.store.close();
  core = new RelayCore({}, { store: new SqliteRelayStore(join(dir, "relay.db")), key, log: () => {} });
  t.after(() => core.store.close());
  assert.equal(core.push({ host: "alpha", pubkey: alpha.publicKey }, [v1]).stored, 1, "a v1 push after the upgrade");
  assert.equal(pushV2(v2).status, "accepted");
  const r = core.sweep(Date.now() + 60 * DAY);
  assert.deepEqual(r.expired, { envelope: 1, receipt: 0, expired: 0 }, "only the v2 item pushed after the upgrade");
  assert.deepEqual(core.pullItems(beta.publicKey).items.map((i) => i.item_id).sort(), [v1.id, legacy.id].sort());
  assert.ok(core.store.meta("expiry_from"), "recorded once: the next open changes nothing");
});

test("a re-push the LAN rejects ends rejected (doctor shows it); only a LAN delivery settles it", async (t) => {
  const { doctor } = await import("../src/doctor.ts");
  const w = await world(t);
  const { a, b } = w;
  const lan = await startServer(b, 0, "127.0.0.1");
  t.after(() => closeServer(lan));
  a.store.db.prepare("UPDATE peers SET addr=? WHERE host='beta'").run(`127.0.0.1:${(lan.address() as AddressInfo).port}`);
  const repushed = async (subject: string) => { const id = await w.send(subject); relayEpochChanged(a, w.relay, `epoch-${subject}`, "epoch"); assert.equal(state(a, id), "repush"); return id; };
  const m1 = await repushed("sealed for the wrong key");
  a.store.db.prepare("UPDATE peers SET enc_pub=? WHERE host='beta'").run(generateEncKeyPair().publicKey);
  await flushOutbox(a);
  assert.deepEqual([state(a, m1), count(a, "SELECT COUNT(*) c FROM outbox WHERE msg_id=?", m1)], ["rejected", 0]);
  assert.ok(a.inbox("alice").some((m) => m.subject === "Undelivered to beta: sealed for the wrong key"), "the LAN alert");
  const m2 = await repushed("delivered over the LAN");
  a.store.db.prepare("UPDATE peers SET enc_pub=? WHERE host='beta'").run(b.encKey.publicKey);
  await flushOutbox(a);
  assert.equal(state(a, m2), "settled");
  assert.ok(subjects(b).includes("delivered over the LAN"));
  const old = process.env.MBX_RELAY_URL;
  process.env.MBX_RELAY_URL = w.relay;
  try {
    const checks = (await doctor({ home: a.home, cmd: ["agentmbx"], which: () => null, useClis: false } as never, a.home)).map((c) => `${c.level} ${c.label}`);
    assert.ok(checks.some((l) => /^warn 1 message\(s\) waiting for a re-push after a relay restore were rejected/.test(l)), checks.join("\n"));
  } finally { if (old === undefined) delete process.env.MBX_RELAY_URL; else process.env.MBX_RELAY_URL = old; }
});
