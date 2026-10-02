// Durable relay client (T166, docs/spec/relay-durability.md §3, §4, §5, §9, §10): rows reach the relay only after two
// LAN failures and a due backoff; they leave the outbox only on a valid signed accept and wait for the delivery receipt;
// retries reuse the same bytes; the receiver checkpoints, quarantines and acks; receipts travel the relay too; an epoch
// change or a rewound queue makes senders re-push and receivers re-pull without duplicates; the sender owns its deadline.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { MbxNode } from "../src/node.ts";
import { generateKeyPair } from "../src/crypto.ts";
import { RelayCore, startRelayServer } from "../src/relay.ts";
import { SqliteRelayStore } from "../src/relay-store.ts";
import { relayOpen, relayPushOutbox, relayPushReceipts, relayReceive, relaySettle, RELAY_DEADLINE_GRACE_MS } from "../src/relay-v2.ts";

const pair = (a: MbxNode, b: MbxNode) => {
  a.addApprovedPeer({ host: b.host, pubkey: b.key.publicKey, owner_pubkey: null, addr: "127.0.0.1:1" }, "fixture");
  b.addApprovedPeer({ host: a.host, pubkey: a.key.publicKey, owner_pubkey: null, addr: "127.0.0.1:1" }, "fixture");
};
const count = (n: MbxNode, sql: string, ...args: (string | number)[]) => Number((n.store.db.prepare(sql).get(...args) as { c: number }).c);
/** Make every outbox row look like it failed twice on the LAN and is due now. */
const lanFailedTwice = (n: MbxNode) => n.store.db.prepare("UPDATE outbox SET attempts=2, next_at=?").run(new Date(Date.now() - 1000).toISOString());
const receiptsLanFailedTwice = (n: MbxNode) => n.store.db.prepare("UPDATE receipt_outbox SET attempts=2, next_at=?").run(new Date(Date.now() - 1000).toISOString());

async function world(t: { after: (fn: () => unknown) => void }, o: { core?: RelayCore; f?: typeof fetch } = {}) {
  const homes = [mkdtempSync(join(tmpdir(), "mbx-r2-a-")), mkdtempSync(join(tmpdir(), "mbx-r2-b-"))];
  const a = new MbxNode(homes[0], { host: "alpha" }), b = new MbxNode(homes[1], { host: "beta" });
  pair(a, b);
  b.registerAgent("bob"); a.registerAgent("alice");
  const core = o.core ?? new RelayCore();
  const server = await startRelayServer(core, 0, "127.0.0.1");
  t.after(() => { a.close(); b.close(); homes.forEach((h) => rmSync(h, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })); return new Promise<void>((r) => server.close(() => r())); });
  const relay = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const open = async (n: MbxNode, f = o.f ?? fetch) => { const s = await relayOpen(n, relay, f); assert.ok(s, "v2 session"); return s!; };
  await open(b); // beta enrols and publishes its enc key
  return { a, b, core, relay, open };
}

test("end to end: LAN-failed mail crosses the relay, the receiver checkpoints and acks, the receipt comes back and settles the row", async (t) => {
  const { a, b, core, open } = await world(t);
  a.send({ from: "alice", to: ["bob@beta"], subject: "over the relay", body: "hello" });
  let sa = await open(a);
  assert.deepEqual(await relayPushOutbox(a, sa), { accepted: 0, rejected: 0 }, "a fresh row stays on the LAN");
  lanFailedTwice(a);
  assert.deepEqual(await relayPushOutbox(a, sa), { accepted: 1, rejected: 0 });
  assert.equal(count(a, "SELECT COUNT(*) c FROM outbox"), 0);
  assert.equal((a.store.db.prepare("SELECT state FROM relay_sent").get() as { state: string }).state, "relay-accepted");
  const sb = await open(b);
  assert.equal(await relayReceive(b, sb), 1);
  assert.equal(b.inbox("bob").length, 1);
  assert.equal(core.pullItems(b.key.publicKey).items.length, 0, "acked: the relay dropped it");
  // beta's delivery receipt goes back over the relay
  receiptsLanFailedTwice(b);
  assert.ok(await relayPushReceipts(b, sb) >= 1);
  assert.equal(count(b, "SELECT COUNT(*) c FROM receipt_outbox WHERE state='delivered'"), 0);
  sa = await open(a);
  await relayReceive(a, sa);
  assert.ok(count(a, "SELECT COUNT(*) c FROM remote_receipts WHERE recipient='bob@beta'") === 1);
  assert.deepEqual(relaySettle(a), { settled: 1, unconfirmed: 0 });
  assert.equal(count(a, "SELECT COUNT(*) c FROM relay_wire"), 0, "settled rows drop their bytes");
});

test("a lost push response keeps the row; the retry reuses the same bytes and is a duplicate with the same seq", async (t) => {
  let drop = true;
  const lossy: typeof fetch = async (input, init) => {
    const res = await fetch(input, init);
    if (drop && String(input).includes("/v2/relay/items") && init?.method === "POST") { drop = false; throw new Error("connection reset after commit"); }
    return res;
  };
  const { a, open } = await world(t, { f: lossy });
  a.send({ from: "alice", to: ["bob@beta"], subject: "s", body: "b" }); lanFailedTwice(a);
  const sa = await open(a);
  assert.deepEqual(await relayPushOutbox(a, sa), { accepted: 0, rejected: 0 });
  assert.equal(count(a, "SELECT COUNT(*) c FROM outbox"), 1, "no accept, no removal");
  const hash = (a.store.db.prepare("SELECT wire_hash h FROM relay_wire").get() as { h: string }).h;
  assert.deepEqual(await relayPushOutbox(a, sa), { accepted: 1, rejected: 0 });
  const accept = JSON.parse((a.store.db.prepare("SELECT accept FROM relay_sent").get() as { accept: string }).accept);
  assert.equal(accept.targets[0].wire_hash, hash, "the same persisted bytes");
  assert.equal(accept.targets.length, 1);
});

test("a rejected result or an accept that is not ours keeps the row: 200 alone means nothing", async (t) => {
  const { a, b, core, relay, open } = await world(t);
  a.send({ from: "alice", to: ["bob@beta"], subject: "s", body: "b" }); lanFailedTwice(a);
  const forged: typeof fetch = async (input, init) => {
    const res = await fetch(input, init);
    if (!(String(input).includes("/v2/relay/items") && init?.method === "POST")) return res;
    const j = await res.json() as { results: { accept: { targets: { wire_hash: string }[] } }[] };
    j.results[0]!.accept.targets[0]!.wire_hash = "0".repeat(64); // a relay claiming other bytes; its signature no longer matches
    return new Response(JSON.stringify(j), { status: 200, headers: { "content-type": "application/json" } });
  };
  assert.deepEqual(await relayPushOutbox(a, await open(a, forged)), { accepted: 0, rejected: 0 });
  assert.equal(count(a, "SELECT COUNT(*) c FROM outbox"), 1);
  assert.equal(count(a, "SELECT COUNT(*) c FROM relay_sent"), 0);
  // the relay revokes beta: the push is rejected, audited, and the row stays for the LAN and its 72 h rule
  (core.store as SqliteRelayStore).revokeEnrolment(b.key.publicKey, new Date().toISOString());
  assert.deepEqual(await relayPushOutbox(a, await open(a)), { accepted: 0, rejected: 1 });
  assert.equal(count(a, "SELECT COUNT(*) c FROM outbox"), 1);
  assert.ok(count(a, "SELECT COUNT(*) c FROM audit WHERE event='relay.push_rejected'") >= 1);
  void relay;
});

test("a relay that changes its key is not used; the pinned key decides", async (t) => {
  const { a, core, relay, open } = await world(t);
  await open(a);
  a.store.set(`relay-key:${relay}`, generateKeyPair().publicKey); // pinned some other key
  assert.equal(await relayOpen(a, relay), null);
  assert.ok(count(a, "SELECT COUNT(*) c FROM audit WHERE event='relay.key_changed'") >= 1);
  void core;
});

test("next_at and the LAN-attempt threshold are respected", async (t) => {
  const { a, open } = await world(t);
  a.send({ from: "alice", to: ["bob@beta"], subject: "s", body: "b" });
  const sa = await open(a);
  a.store.db.prepare("UPDATE outbox SET attempts=1, next_at=?").run(new Date(Date.now() - 1000).toISOString());
  assert.equal((await relayPushOutbox(a, sa)).accepted, 0, "one LAN failure is not enough");
  a.store.db.prepare("UPDATE outbox SET attempts=5, next_at=?").run(new Date(Date.now() + 60_000).toISOString());
  assert.equal((await relayPushOutbox(a, sa)).accepted, 0, "backoff not due");
});

test("the receiver quarantines what it cannot accept, still advances and acks; an ack failure is covered by the next ack", async (t) => {
  let failAck = true;
  const flaky: typeof fetch = async (input, init) => {
    if (failAck && String(input).includes("/v2/relay/ack")) { failAck = false; throw new Error("ack lost"); }
    return fetch(input, init);
  };
  const { a, b, core, open } = await world(t, { f: flaky });
  a.send({ from: "alice", to: ["bob@beta"], subject: "good", body: "1" }); lanFailedTwice(a);
  await relayPushOutbox(a, await open(a));
  // a second item from alpha that beta cannot open: sealed for some other key
  const other = (await import("../src/body-encryption.ts")).generateEncKeyPair();
  const { buildEnvelope, sealEnvelope } = await import("../src/envelope.ts");
  const bad = sealEnvelope(buildEnvelope({ from: "alice@alpha", to: ["bob@beta"], subject: "bad", body: "x" }), other.publicKey, "alpha", a.key.publicKey, a.key.privateKey);
  core.pushItems({ host: "alpha", pubkey: a.key.publicKey }, [{ kind: "envelope", item_id: bad.id, targets: [{ host_pubkey: b.key.publicKey, wire_b64: Buffer.from(JSON.stringify(bad)).toString("base64") }] }]);
  const sb = await open(b);
  assert.equal(await relayReceive(b, sb), 1);
  assert.equal(count(b, "SELECT COUNT(*) c FROM relay_quarantine"), 1);
  assert.match((b.store.db.prepare("SELECT reason r FROM relay_quarantine").get() as { r: string }).r, /undecryptable/);
  assert.equal((b.store.db.prepare("SELECT received_through t FROM relay_position").get() as { t: number }).t, core.pullItems(b.key.publicKey).head_seq, "the checkpoint covers both items");
  assert.equal(core.pullItems(b.key.publicKey).items.length, 2, "the ack was lost; the relay still holds both");
  await relayReceive(b, sb);
  assert.equal(core.pullItems(b.key.publicKey).items.length, 0, "the next ack covered them");
  assert.equal(b.inbox("bob").length, 1, "no duplicate delivery");
});

test("an epoch change (restore) makes the sender re-push and the receiver re-pull, with no duplicates", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "mbx-r2-epoch-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const relayKey = generateKeyPair();
  const core = new RelayCore({}, { store: new SqliteRelayStore(join(dir, "relay.db")), key: relayKey });
  const { a, b, open } = await world(t, { core });
  a.send({ from: "alice", to: ["bob@beta"], subject: "first", body: "1" }); lanFailedTwice(a);
  await relayPushOutbox(a, await open(a));
  await relayReceive(b, await open(b)); // beta has it and acked it; no delivery receipt reached alpha yet
  // the operator restores an empty backup and rotates the epoch: the relay lost everything after the snapshot
  const db = (core.store as SqliteRelayStore).db;
  db.exec("DELETE FROM items; DELETE FROM dedup; DELETE FROM seqs; DELETE FROM acked;");
  core.store.rotateEpoch();
  const sa = await open(a);
  assert.equal(count(a, "SELECT COUNT(*) c FROM outbox"), 1, "the unconfirmed row is back for re-push");
  assert.equal((await relayPushOutbox(a, sa)).accepted, 1);
  const sb = await open(b);
  assert.equal(await relayReceive(b, sb), 0, "re-pulled from 0: a duplicate, not a second copy");
  assert.equal(b.inbox("bob").length, 1);
  assert.ok(count(b, "SELECT COUNT(*) c FROM audit WHERE event='relay.epoch_changed'") >= 1);
});

test("a queue head below the checkpoint in the same epoch is treated as a rewind", async (t) => {
  const { a, b, core, open } = await world(t, { core: new RelayCore({}, { store: new SqliteRelayStore(":memory:", { now: () => 0 }) }) });
  for (let i = 0; i < 2; i++) a.send({ from: "alice", to: ["bob@beta"], subject: `m${i}`, body: "x" });
  lanFailedTwice(a);
  await relayPushOutbox(a, await open(a));
  const sb = await open(b);
  await relayReceive(b, sb);
  b.store.db.prepare("UPDATE relay_position SET received_through=50").run(); // the store behind it went back in time
  a.send({ from: "alice", to: ["bob@beta"], subject: "after", body: "x" }); lanFailedTwice(a);
  await relayPushOutbox(a, await open(a));
  assert.equal(await relayReceive(b, sb), 1, "detected the rewind, re-pulled from 0 and got the new item");
  assert.equal(b.inbox("bob").length, 3);
  void core;
});

test("the sender owns its deadline: an unconfirmed relay delivery alerts the sender without any relay notice", async (t) => {
  const { a, open } = await world(t);
  a.send({ from: "alice", to: ["bob@beta"], subject: "into the void", body: "x" }); lanFailedTwice(a);
  await relayPushOutbox(a, await open(a));
  const deadline = Date.parse((a.store.db.prepare("SELECT deadline_at d FROM relay_sent").get() as { d: string }).d);
  assert.ok(deadline >= Date.now() + 14 * 86_400_000 + RELAY_DEADLINE_GRACE_MS - 60_000, "retention + grace");
  assert.deepEqual(relaySettle(a, deadline - 1), { settled: 0, unconfirmed: 0 });
  assert.deepEqual(relaySettle(a, deadline + 1), { settled: 0, unconfirmed: 1 });
  const alert = a.inbox("alice").find((m) => m.subject.startsWith("Undelivered/unconfirmed to beta"));
  assert.ok(alert, "the sender is told");
  assert.match(alert!.body, /older than 0\.5\.3/, "beta never sent any receipt: the peer may be too old");
  assert.deepEqual(relaySettle(a, deadline + 2), { settled: 0, unconfirmed: 0 }, "told once");
});

test("a v1-only relay (no /v2/relay/info) gives no v2 session, so the daemon keeps the v1 path", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "mbx-r2-v1-"));
  const n = new MbxNode(home, { host: "alpha" });
  t.after(() => { n.close(); rmSync(home, { recursive: true, force: true }); });
  const v1only: typeof fetch = async () => new Response(JSON.stringify({ error: "not found" }), { status: 404 });
  assert.equal(await relayOpen(n, "http://old-relay:7374", v1only), null);
});

test("doctor sees v2 enrolment (G13 fixed), waiting relay deliveries and quarantined items", async (t) => {
  const { doctor } = await import("../src/doctor.ts");
  const { a, b, relay, open } = await world(t);
  a.send({ from: "alice", to: ["bob@beta"], subject: "s", body: "b" }); lanFailedTwice(a);
  await relayPushOutbox(a, await open(a));
  b.store.db.prepare(`INSERT INTO relay_quarantine (relay,epoch,seq,kind,item_id,sender_pubkey,reason,wire,at) VALUES (?,?,?,?,?,?,?,?,?)`)
    .run(relay, "e", 9, "envelope", "x", "k", "rejected:undecryptable body", Buffer.from("{}"), new Date().toISOString());
  const old = process.env.MBX_RELAY_URL;
  process.env.MBX_RELAY_URL = relay;
  try {
    const labels = async (n: MbxNode) => (await doctor({ home: n.home, cmd: ["agentmbx"], which: () => null, useClis: false } as never, n.home)).map((c) => `${c.level} ${c.label}`);
    const da = await labels(a), db = await labels(b);
    assert.ok(da.some((l) => l.startsWith("ok relay configured") && l.includes("(enrolled)")), da.join("\n"));
    assert.ok(da.some((l) => /1 message\(s\) accepted by the relay, waiting/.test(l)));
    assert.ok(db.some((l) => /^warn 1 relay item\(s\) .* quarantine/.test(l)), db.join("\n"));
  } finally { if (old === undefined) delete process.env.MBX_RELAY_URL; else process.env.MBX_RELAY_URL = old; }
});

test("a daemon publishes its paired peers as the senders it accepts; a stranger's key is refused by the relay", async (t) => {
  const { a, b, core, open } = await world(t);
  assert.deepEqual(core.store.senderList(b.key.publicKey)?.senders, [a.key.publicKey], "beta accepts alpha only");
  const stranger = generateKeyPair();
  const challenge = core.challenge("stranger", stranger.publicKey);
  const { canonical, signData } = await import("../src/crypto.ts");
  core.enrol("stranger", stranger.publicKey, "", signData(stranger.privateKey, canonical({ v: 1, challenge, host: "stranger", pubkey: stranger.publicKey, owner_fp: "" })));
  const r = core.pushItems({ host: "stranger", pubkey: stranger.publicKey }, [{ kind: "receipt", item_id: "receipt:x:y@z:1", targets: [{ host_pubkey: b.key.publicKey, wire_b64: "e30=" }] }]);
  assert.equal(r[0]!.status, "rejected:sender not accepted by target");
  a.send({ from: "alice", to: ["bob@beta"], subject: "still works", body: "x" }); lanFailedTwice(a);
  assert.equal((await relayPushOutbox(a, await open(a))).accepted, 1);
  await open(b); // unchanged peer set: no republish
  assert.equal(count(b, "SELECT COUNT(*) c FROM audit WHERE event='relay.senders_failed'"), 0);
});
