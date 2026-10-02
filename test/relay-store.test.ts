// Durable relay store (T165, docs/spec/relay-durability.md §2–§8): a restart loses nothing, fan-out is all-or-nothing
// per item, dedup tells a retry from a conflicting reuse of an id, every acceptance is signed by the relay key, pulls page
// by last returned seq and expose the queue head, acks never run past what was allocated, hosts are found by key (names
// are labels), quotas charge keys and proven accounts (never an unproven owner claim), a T030 rotation carries the queue,
// and a public relay bounds its enrolment state.
import { test } from "node:test";
import assert from "node:assert/strict";
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import type { AddressInfo } from "node:net";
import { canonical, generateKeyPair, keyPairFromPrivate, signData, verifyData, type KeyPair } from "../src/crypto.ts";
import { generateEncKeyPair } from "../src/body-encryption.ts";
import { buildEnvelope, sealEnvelope } from "../src/envelope.ts";
import { DEFAULT_QUOTA, parseRelayKey, RelayCore, relayHop, startRelayServer, wireHash, type PushItem } from "../src/relay.ts";
import { SCHEMA_VERSION, SqliteRelayStore } from "../src/relay-store.ts";
import type { SignedRotation } from "../src/key-rotation.ts";

function enrol(core: RelayCore, host: string, key: KeyPair, owner = "owner-1") {
  const challenge = core.challenge(host, key.publicKey);
  core.enrol(host, key.publicKey, owner, signData(key.privateKey, canonical({ v: 1, challenge, host, pubkey: key.publicKey, owner_fp: owner })));
}
const keys = () => ({ alpha: generateKeyPair(), beta: generateKeyPair(), gamma: generateKeyPair() });
const b64 = (s: string | Buffer) => Buffer.from(s).toString("base64");
function sealedFor(from: { host: string; key: KeyPair }, to: string[], body = "secret") {
  const enc = generateEncKeyPair();
  return sealEnvelope(buildEnvelope({ from: `alice@${from.host}`, to, subject: "s", body }), enc.publicKey, from.host, from.key.publicKey, from.key.privateKey);
}
const item = (e: ReturnType<typeof sealedFor>, targets: KeyPair[]): PushItem =>
  ({ kind: "envelope", item_id: e.id, targets: targets.map((k) => ({ host_pubkey: k.publicKey, wire_b64: b64(JSON.stringify(e)) })) });
function receiptItem(signer: KeyPair, to: KeyPair, o: { msg?: string; seq?: number; id?: string; sig?: string } = {}): PushItem {
  const rec = { v: 1, type: "receipt", msg: o.msg ?? "01M3XPVHH2E83AW8KYVYVFH8KW", recipient: "bob@beta", state: "acked", at: new Date().toISOString(), seq: o.seq ?? 1 };
  const wire = canonical({ rec, sig: o.sig ?? signData(signer.privateKey, canonical(rec)) });
  return { kind: "receipt", item_id: o.id ?? `receipt:${rec.msg}:${rec.recipient}:${rec.seq}`, targets: [{ host_pubkey: to.publicKey, wire_b64: b64(wire) }] };
}
function rotation(host: string, cur: KeyPair): { next: KeyPair; signed: SignedRotation } {
  const next = generateKeyPair();
  const rec = { v: 1 as const, type: "host-rotation" as const, host, old_pub: cur.publicKey, new_pub: next.publicKey, new_enc_pub: generateEncKeyPair().publicKey, iat: new Date().toISOString() };
  return { next, signed: { rec, old_sig: signData(cur.privateKey, canonical(rec)), new_sig: signData(next.privateKey, canonical(rec)) } };
}

test("a restart loses nothing: enrolments, enc ads, queued items, sequence numbers and the epoch survive", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "mbx-relaystore-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "relay.db"), relayKey = generateKeyPair(), k = keys();
  let core = new RelayCore(DEFAULT_QUOTA, { store: new SqliteRelayStore(path), key: relayKey });
  enrol(core, "alpha", k.alpha); enrol(core, "beta", k.beta);
  core.publishEncAd("beta", k.beta.publicKey, "ENCPUB", signData(k.beta.privateKey, canonical({ v: 1, host: "beta", enc_pub: "ENCPUB" })));
  const e1 = sealedFor({ host: "alpha", key: k.alpha }, ["bob@beta"]);
  assert.equal(core.pushItems({ host: "alpha", pubkey: k.alpha.publicKey }, [item(e1, [k.beta])])[0].status, "accepted");
  const epoch = core.store.epoch();
  core.store.close();
  // the process dies; a new one opens the same store with the same key
  core = new RelayCore(DEFAULT_QUOTA, { store: new SqliteRelayStore(path), key: relayKey });
  t.after(() => core.store.close());
  assert.equal(core.store.epoch(), epoch, "a restart is not a restore: the epoch stays");
  assert.equal(core.requireEnrolled(k.beta.publicKey).host, "beta");
  assert.equal(core.getEncAdByKey(k.beta.publicKey)?.enc_pub, "ENCPUB");
  const pulled = core.pullItems(k.beta.publicKey, 0);
  assert.deepEqual(pulled.items.map((i) => [i.seq, i.item_id]), [[1, e1.id]]);
  const e2 = sealedFor({ host: "alpha", key: k.alpha }, ["bob@beta"]);
  assert.deepEqual(core.pushItems({ host: "alpha", pubkey: k.alpha.publicKey }, [item(e2, [k.beta])])[0].targets.map((x) => x.seq), [2], "sequence numbers continue, never restart");
  // and the same store refuses another relay key (its accept receipts would no longer verify)
  assert.throws(() => new RelayCore(DEFAULT_QUOTA, { store: core.store, key: generateKeyPair() }), /another relay key/);
});

test("a crash after commit and before the answer: the retry is a duplicate with the same seq and a valid accept", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "mbx-relaycrash-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "relay.db"), relayKey = generateKeyPair(), k = keys();
  let core = new RelayCore(DEFAULT_QUOTA, { store: new SqliteRelayStore(path), key: relayKey });
  enrol(core, "alpha", k.alpha); enrol(core, "beta", k.beta);
  const e = sealedFor({ host: "alpha", key: k.alpha }, ["bob@beta"]);
  const from = { host: "alpha", pubkey: k.alpha.publicKey };
  const lost = core.pushItems(from, [item(e, [k.beta])])[0]; // committed; the answer never reaches the sender
  core.store.close();
  core = new RelayCore(DEFAULT_QUOTA, { store: new SqliteRelayStore(path), key: relayKey });
  t.after(() => core.store.close());
  const retry = core.pushItems(from, [item(e, [k.beta])])[0];
  assert.equal(retry.status, "duplicate");
  assert.deepEqual(retry.accept!.targets, lost.accept!.targets, "same seq and wire hash as the lost answer");
  assert.ok(verifyData(relayKey.publicKey, canonical(retry.accept), retry.sig!));
  assert.equal(core.pullItems(k.beta.publicKey).items.length, 1);
});

test("dedup: a retry is a duplicate with the same seq and a signed receipt; other bytes under the same id are a conflict", (t) => {
  const core = new RelayCore(); t.after(() => core.store.close());
  const k = keys(); enrol(core, "alpha", k.alpha); enrol(core, "beta", k.beta);
  const e = sealedFor({ host: "alpha", key: k.alpha }, ["bob@beta"]);
  const from = { host: "alpha", pubkey: k.alpha.publicKey };
  const first = core.pushItems(from, [item(e, [k.beta])])[0];
  assert.equal(first.status, "accepted");
  assert.ok(verifyData(core.key.publicKey, canonical(first.accept), first.sig!), "the accept receipt is signed by the relay key");
  assert.equal(first.accept!.targets[0].wire_hash, wireHash(Buffer.from(JSON.stringify(e))), "wire_hash is SHA-256 of the exact bytes");
  const retry = core.pushItems(from, [item(e, [k.beta])])[0];
  assert.equal(retry.status, "duplicate"); assert.equal(retry.targets[0].seq, first.targets[0].seq);
  // the same envelope re-serialized (other bytes, same id) and a re-sealed body under the same id are both conflicts
  const respaced = Buffer.from(JSON.stringify(e, null, 1));
  assert.equal(core.pushItems(from, [{ kind: "envelope", item_id: e.id, targets: [{ host_pubkey: k.beta.publicKey, wire_b64: b64(respaced) }] }])[0].status, "rejected:conflict");
  const resealed = sealedFor({ host: "alpha", key: k.alpha }, ["bob@beta"], "different");
  assert.equal(core.pushItems(from, [{ kind: "envelope", item_id: e.id, targets: [{ host_pubkey: k.beta.publicKey, wire_b64: b64(JSON.stringify({ ...e, body: resealed.body, enc: resealed.enc })) }] }])[0].status, "rejected:conflict");
  assert.equal(core.pullItems(k.beta.publicKey).items.length, 1, "one stored item, never two");
});

test("fan-out is all-or-nothing per item; one target per host; only sealed envelopes and signed, well-formed receipts", (t) => {
  const core = new RelayCore({ ...DEFAULT_QUOTA, maxQueueDepth: 1 }); t.after(() => core.store.close());
  const k = keys(); enrol(core, "alpha", k.alpha); enrol(core, "beta", k.beta); enrol(core, "gamma", k.gamma);
  const from = { host: "alpha", pubkey: k.alpha.publicKey };
  core.pushItems(from, [item(sealedFor({ host: "alpha", key: k.alpha }, ["x@gamma"]), [k.gamma])]); // gamma's queue is now full
  const both = core.pushItems(from, [item(sealedFor({ host: "alpha", key: k.alpha }, ["bob@beta", "carol@gamma"]), [k.beta, k.gamma])])[0];
  assert.match(both.status, /^rejected:quota:queue depth exceeded for gamma/);
  assert.equal(core.pullItems(k.beta.publicKey).items.length, 0, "beta got nothing: the item is rolled back as a whole");
  // several recipients on one host are one target: the sender merges them, a repeated target is refused
  const two = sealedFor({ host: "alpha", key: k.alpha }, ["bob@beta", "dan@beta"]);
  assert.equal(core.pushItems(from, [item(two, [k.beta, k.beta])])[0].status, "rejected:duplicate target");
  assert.equal(core.pushItems(from, [item(two, [k.beta])])[0].status, "accepted");
  const plain = buildEnvelope({ from: "alice@alpha", to: ["bob@beta"], subject: "s", body: "PLAINTEXT" });
  assert.equal(core.pushItems(from, [{ kind: "envelope", item_id: plain.id, targets: [{ host_pubkey: k.beta.publicKey, wire_b64: b64(JSON.stringify(plain)) }] }])[0].status,
    "rejected:envelope body is not sealed");
  assert.equal(core.pushItems(from, [{ kind: "envelope", item_id: "nope", targets: [] }])[0].status, "rejected:bad targets");
  assert.equal(core.pushItems(from, [{ kind: "envelope", item_id: "x".repeat(20), targets: [{ host_pubkey: generateKeyPair().publicKey, wire_b64: "e30=" }] }])[0].status, "rejected:target not enrolled");
  const fromBeta = { host: "beta", pubkey: k.beta.publicKey };
  assert.equal(core.pushItems(fromBeta, [receiptItem(k.beta, k.alpha)])[0].status, "accepted");
  assert.equal(core.pullItems(k.alpha.publicKey).items[0].kind, "receipt");
  assert.equal(core.pushItems(fromBeta, [receiptItem(k.beta, k.alpha, { seq: 2, id: "receipt:whatever" })])[0].status, "rejected:item id is not the receipt id");
  assert.equal(core.pushItems(fromBeta, [receiptItem(k.gamma, k.alpha, { seq: 3 })])[0].status, "rejected:receipt is not signed by the sending host");
  assert.equal(core.pushItems(fromBeta, [receiptItem(k.beta, k.alpha, { seq: 4, msg: "short" })])[0].status, "rejected:bad receipt");
});

test("pull pages by last returned seq within a byte budget and shows the head; ack is per epoch and never past the head", (t) => {
  const core = new RelayCore({ ...DEFAULT_QUOTA, maxPull: 2 }); t.after(() => core.store.close());
  const k = keys(); enrol(core, "alpha", k.alpha); enrol(core, "beta", k.beta);
  const from = { host: "alpha", pubkey: k.alpha.publicKey };
  for (let i = 0; i < 3; i++) core.pushItems(from, [item(sealedFor({ host: "alpha", key: k.alpha }, ["bob@beta"]), [k.beta])]);
  const p1 = core.pullItems(k.beta.publicKey, 0, 10);
  assert.deepEqual([p1.items.map((i) => i.seq), p1.last_seq, p1.more, p1.head_seq], [[1, 2], 2, true, 3]);
  const p2 = core.pullItems(k.beta.publicKey, p1.last_seq);
  assert.deepEqual([p2.items.map((i) => i.seq), p2.last_seq, p2.more], [[3], 3, false]);
  assert.throws(() => core.pullItems(k.beta.publicKey, 0, 10, "an-old-epoch"), /epoch changed/);
  assert.throws(() => core.ackItems(k.beta.publicKey, p1.epoch, 4), /beyond the last allocated seq/);
  assert.throws(() => core.ackItems(k.beta.publicKey, "an-old-epoch", 2), /epoch changed/);
  assert.deepEqual(core.ackItems(k.beta.publicKey, p1.epoch, 2), { acked_through: 2, deleted: 2, head_seq: 3 });
  assert.deepEqual(core.pullItems(k.beta.publicKey, 0).items.map((i) => i.seq), [3], "only the unacked item is left");
  const tight = new RelayCore({ ...DEFAULT_QUOTA, maxPullBytes: 10 }); t.after(() => tight.store.close());
  enrol(tight, "alpha", k.alpha); enrol(tight, "beta", k.beta);
  for (let i = 0; i < 2; i++) tight.pushItems(from, [item(sealedFor({ host: "alpha", key: k.alpha }, ["bob@beta"]), [k.beta])]);
  const page = tight.pullItems(k.beta.publicKey, 0);
  assert.deepEqual([page.items.length, page.more], [1, true], "an item larger than the budget still comes alone; the rest waits");
});

test("a restore that keeps the epoch is visible: the head drops below the receiver's checkpoint; rotate-epoch voids checkpoints", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "mbx-relayrestore-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "relay.db"), backup = join(dir, "backup.db"), relayKey = generateKeyPair(), k = keys();
  let core = new RelayCore(DEFAULT_QUOTA, { store: new SqliteRelayStore(path), key: relayKey });
  enrol(core, "alpha", k.alpha); enrol(core, "beta", k.beta);
  const from = { host: "alpha", pubkey: k.alpha.publicKey };
  core.pushItems(from, [item(sealedFor({ host: "alpha", key: k.alpha }, ["bob@beta"]), [k.beta])]);
  (core.store as SqliteRelayStore).db.exec(`VACUUM INTO '${backup}'`); // a volume snapshot at head 1
  for (let i = 0; i < 2; i++) core.pushItems(from, [item(sealedFor({ host: "alpha", key: k.alpha }, ["bob@beta"]), [k.beta])]);
  const checkpoint = core.pullItems(k.beta.publicKey, 0).last_seq; // the receiver processed through 3
  core.store.close();
  copyFileSync(backup, path); rmSync(`${path}-wal`, { force: true }); rmSync(`${path}-shm`, { force: true });
  core = new RelayCore(DEFAULT_QUOTA, { store: new SqliteRelayStore(path), key: relayKey });
  t.after(() => core.store.close());
  const after = core.pullItems(k.beta.publicKey, checkpoint);
  assert.equal(after.epoch, core.pullItems(k.beta.publicKey, 0).epoch, "the restore kept the epoch");
  assert.ok(after.head_seq < checkpoint, "head_seq below the checkpoint: the receiver must treat this as an epoch change");
  assert.throws(() => core.ackItems(k.beta.publicKey, after.epoch, checkpoint), /treat as an epoch change/);
  const old = core.store.epoch();
  assert.notEqual(core.store.rotateEpoch(), old, "agentmbx relay rotate-epoch after such a restore");
});

test("names are labels: hosts are found by key, two owners may share a name, a revoked key stays revoked", (t) => {
  const core = new RelayCore(); t.after(() => core.store.close());
  const k = keys(), otherMac = generateKeyPair();
  enrol(core, "macbook", k.alpha, "owner-1");
  enrol(core, "macbook", otherMac, "owner-2"); // a second owner's macbook on a shared relay
  assert.equal(core.requireEnrolled(k.alpha.publicKey).host, "macbook");
  assert.equal(core.requireEnrolled(otherMac.publicKey).host, "macbook");
  enrol(core, "beta", k.beta, "owner-2");
  assert.equal(core.enrolmentByName("macbook", core.requireEnrolled(k.beta.publicKey))!.pubkey, otherMac.publicKey, "v1 name routing prefers the caller's own owner claim");
  // a proven account (set by the JWKS authority, §8) keeps names unique inside it
  const store = core.store as SqliteRelayStore, at = new Date().toISOString();
  store.putEnrolment({ host: "studio", pubkey: k.gamma.publicKey, owner_fp: "", at, account: "acct-1", authorized_by: "jwks" });
  assert.throws(() => store.putEnrolment({ host: "studio", pubkey: generateKeyPair().publicKey, owner_fp: "", at, account: "acct-1", authorized_by: "jwks" }), /already enrolled in this account/);
  store.putEnrolment({ host: "studio", pubkey: generateKeyPair().publicKey, owner_fp: "", at, account: "acct-2", authorized_by: "jwks" });
  store.revokeEnrolment(otherMac.publicKey, at);
  assert.throws(() => enrol(core, "macbook", otherMac, "owner-2"), /revoked/, "re-enrolment never clears a revocation");
  assert.throws(() => core.requireEnrolled(otherMac.publicKey), /not enrolled/);
});

test("a T030 rotation rebinds the name to the new key, carries the queue in order and revokes the old key", (t) => {
  const core = new RelayCore(); t.after(() => core.store.close());
  const k = keys(); enrol(core, "alpha", k.alpha); enrol(core, "beta", k.beta);
  const from = { host: "alpha", pubkey: k.alpha.publicKey };
  const sent = [0, 1].map(() => sealedFor({ host: "alpha", key: k.alpha }, ["bob@beta"]));
  for (const e of sent) core.pushItems(from, [item(e, [k.beta])]);
  const { next, signed } = rotation("beta", k.beta);
  assert.throws(() => core.rotate({ ...signed, new_sig: signed.old_sig }), /not signed by the new host key/);
  assert.throws(() => core.rotate(rotation("beta", generateKeyPair()).signed), /not enrolled/);
  assert.deepEqual(core.rotate(signed), { moved: 2 });
  assert.throws(() => core.requireEnrolled(k.beta.publicKey), /not enrolled/, "the old key is revoked");
  assert.equal(core.requireEnrolled(next.publicKey).host, "beta");
  assert.deepEqual(core.pullItems(next.publicKey).items.map((i) => i.item_id), sent.map((e) => e.id), "the queue followed, in order");
  assert.equal(core.pushItems(from, [item(sent[0], [next])])[0].status, "duplicate", "dedup followed too");
  assert.throws(() => enrol(core, "beta", k.beta), /revoked/, "the old key cannot come back");
});

test("quotas charge target keys, each sender's share and proven accounts; an unproven owner claim is never charged", (t) => {
  const core = new RelayCore({ ...DEFAULT_QUOTA, maxSenderItems: 2, maxOwnerDepth: 3 }); t.after(() => core.store.close());
  const k = keys(), mallory = generateKeyPair();
  enrol(core, "alpha", k.alpha, "victim"); enrol(core, "beta", k.beta, "victim");
  enrol(core, "mallory", mallory, "victim"); // claims the victim's owner fingerprint
  const push = (sender: KeyPair, host: string, target: KeyPair) =>
    core.pushItems({ host, pubkey: sender.publicKey }, [item(sealedFor({ host, key: sender }, ["bob@beta"]), [target])])[0].status;
  assert.deepEqual([push(mallory, "mallory", k.beta), push(mallory, "mallory", k.beta), push(mallory, "mallory", k.beta)],
    ["accepted", "accepted", "rejected:quota:sender share exceeded for beta"], "one sender cannot fill a target's queue");
  assert.equal(push(k.alpha, "alpha", k.beta), "accepted", "mallory's claim of the owner fingerprint cost the real owner nothing");
  // a proven account is charged across its hosts
  const store = core.store as SqliteRelayStore, at = new Date().toISOString(), acctHost = generateKeyPair(), acctHost2 = generateKeyPair();
  store.putEnrolment({ host: "h1", pubkey: acctHost.publicKey, owner_fp: "", at, account: "acct", authorized_by: "jwks" });
  store.putEnrolment({ host: "h2", pubkey: acctHost2.publicKey, owner_fp: "", at, account: "acct", authorized_by: "jwks" });
  assert.deepEqual([push(k.alpha, "alpha", acctHost), push(k.beta, "beta", acctHost), push(k.alpha, "alpha", acctHost2), push(k.beta, "beta", acctHost2)].at(-1),
    "rejected:quota:owner queue depth exceeded for h2");
  assert.equal(core.accountDepth("acct"), 3);
});

test("a public relay bounds enrolment: validated fields, expiring and capped challenges, a key cap, per-address rate", async (t) => {
  const core = new RelayCore({ ...DEFAULT_QUOTA, maxPendingChallenges: 2, maxEnrolments: 2, challengeTtlMs: 50, enrolPerMinutePerIp: 3 });
  t.after(() => core.store.close());
  assert.throws(() => core.challenge("bad host!", generateKeyPair().publicKey), /bad host name/);
  assert.throws(() => core.challenge("ok", "x".repeat(8_000_000)), /bad host key/);
  const k = keys();
  core.challenge("a", k.alpha.publicKey); core.challenge("b", k.beta.publicKey);
  assert.throws(() => core.challenge("c", k.gamma.publicKey), /too many open enrolment challenges/);
  await new Promise((r) => setTimeout(r, 80));
  const n = core.challenge("c", k.gamma.publicKey); // expired ones were swept
  await new Promise((r) => setTimeout(r, 80));
  assert.throws(() => core.enrol("c", k.gamma.publicKey, "o", signData(k.gamma.privateKey, canonical({ v: 1, challenge: n, host: "c", pubkey: k.gamma.publicKey, owner_fp: "o" }))), /no pending/);
  const roomy = new RelayCore({ ...DEFAULT_QUOTA, maxEnrolments: 2 }); t.after(() => roomy.store.close());
  enrol(roomy, "a", k.alpha); enrol(roomy, "b", k.beta);
  assert.throws(() => enrol(roomy, "c", k.gamma), /capacity/);
  enrol(roomy, "a", k.alpha); // a known key re-enrols at capacity
  assert.throws(() => enrol(roomy, "x", k.alpha, "o".repeat(65)), /bad enrolment fields/);
  const server = await startRelayServer(core, 0, "127.0.0.1");
  t.after(() => new Promise<void>((r) => server.close(() => r())));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = () => fetch(`${base}/v1/relay/challenge`, { method: "POST", body: JSON.stringify({ host: "z", pubkey: generateKeyPair().publicKey }) }).then((r) => r.status);
  const statuses = [await call(), await call(), await call(), await call()];
  assert.equal(statuses.at(-1), 429, statuses.join(","));
  const big = await fetch(`${base}/v1/relay/enrol`, { method: "POST", body: "x".repeat(20_000) });
  assert.equal(big.status, 413, "enrolment bodies are small");
});

test("schema: a v1 store is migrated (wire becomes exact bytes), a newer store is refused, wire bytes round-trip", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "mbx-relayschema-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "relay.db");
  const v1 = new DatabaseSync(path);
  v1.exec(`CREATE TABLE meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);
    CREATE TABLE enrolments (host_pubkey TEXT PRIMARY KEY, host_name TEXT NOT NULL, owner_fp TEXT NOT NULL, account TEXT, authorized_by TEXT, enrolled_at TEXT NOT NULL, revoked_at TEXT);
    CREATE UNIQUE INDEX enrolments_live_name ON enrolments(host_name) WHERE revoked_at IS NULL;
    CREATE TABLE items (target_pubkey TEXT NOT NULL, seq INTEGER NOT NULL, kind TEXT NOT NULL, item_id TEXT NOT NULL, sender_pubkey TEXT NOT NULL,
      sender_host TEXT NOT NULL, wire TEXT NOT NULL, wire_hash TEXT NOT NULL, bytes INTEGER NOT NULL, accepted_at TEXT NOT NULL, expires_at TEXT, PRIMARY KEY (target_pubkey, seq));
    INSERT INTO meta VALUES ('schema_version','1'), ('epoch','e-1');
    INSERT INTO enrolments VALUES ('K1','mac','o',NULL,NULL,'2026-10-01T00:00:00Z',NULL);
    INSERT INTO items VALUES ('K1',1,'envelope','id1','S','alpha','{"x":1}','${createHash("sha256").update('{"x":1}').digest("hex")}',7,'2026-10-01T00:00:00Z',NULL);`);
  v1.close();
  const s = new SqliteRelayStore(path);
  assert.equal(s.meta("schema_version"), String(SCHEMA_VERSION));
  assert.equal(s.epoch(), "e-1", "a migration is not a restore");
  const [row] = s.pull("K1", 0, 10);
  assert.ok(Buffer.isBuffer(row!.wire)); assert.equal(wireHash(row!.wire), row!.wire_hash);
  s.putEnrolment({ host: "mac", pubkey: "K2", owner_fp: "o2", at: "2026-10-02T00:00:00Z" }); // the old global name index is gone
  // bytes that are not valid UTF-8 come back exactly
  const raw = Buffer.from([0x7b, 0xff, 0xfe, 0x7d]);
  s.insertItem({ target_pubkey: "K2", kind: "envelope", item_id: "raw", sender_pubkey: "S", sender_host: "a", wire: raw, wire_hash: wireHash(raw), bytes: 4, accepted_at: "x", expires_at: null });
  assert.ok(s.pull("K2", 0, 1)[0]!.wire.equals(raw));
  s.setMeta("schema_version", "99"); s.close();
  assert.throws(() => new SqliteRelayStore(path), /newer than this agentmbx/);
});

test("relay keys: raw (keygen) and JSON (relay.key) both load, a mismatched pair is refused, errors never echo key material", () => {
  const k = generateKeyPair();
  assert.deepEqual(parseRelayKey(k.privateKey), k);
  assert.deepEqual(parseRelayKey(JSON.stringify(k) + "\n"), k);
  assert.deepEqual(keyPairFromPrivate(k.privateKey), k);
  assert.throws(() => parseRelayKey(JSON.stringify({ ...k, publicKey: generateKeyPair().publicKey })), /does not match/);
  for (const bad of [k.privateKey.slice(0, 20), `{"privateKey":"${k.privateKey.slice(0, 30)}`, "SecretKeyMaterial123"])
    assert.throws(() => parseRelayKey(bad), (e: Error) => !e.message.includes(bad.slice(0, 8)) && /not a valid relay key/.test(e.message));
});

test("HTTP: v1 mail is durable, v2 finds callers by key, signs the query, shows the caller's head, rotates and answers epoch 409", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "mbx-relayhttp-"));
  const path = join(dir, "relay.db"), relayKey = generateKeyPair(), k = keys(), twin = generateKeyPair();
  let core = new RelayCore(DEFAULT_QUOTA, { store: new SqliteRelayStore(path), key: relayKey });
  enrol(core, "alpha", k.alpha); enrol(core, "beta", k.beta, "owner-1"); enrol(core, "beta", twin, "owner-3"); // two hosts named beta; v1 routing picks the sender's owner
  const v1 = sealedFor({ host: "alpha", key: k.alpha }, ["bob@beta"]);
  assert.deepEqual(core.push({ host: "alpha", pubkey: k.alpha.publicKey }, [v1]), { stored: 1 });
  core.store.close();
  core = new RelayCore(DEFAULT_QUOTA, { store: new SqliteRelayStore(path), key: relayKey });
  const server = await startRelayServer(core, 0, "127.0.0.1");
  t.after(() => new Promise<void>((r) => server.close(() => { core.store.close(); rmSync(dir, { recursive: true, force: true }); r(); })));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const get = (p: string, key: KeyPair, host = "beta", signed = p) => fetch(`${base}${p}`, { headers: relayHop(host, key.privateKey, "GET", signed, "", Date.now(), key.publicKey) });
  const info = await (await fetch(`${base}/v2/relay/info`)).json() as { relay_pubkey: string; limits: { retention_days: number }; you?: unknown };
  assert.equal(info.relay_pubkey, relayKey.publicKey); assert.equal(info.limits.retention_days, 14); assert.equal(info.you, undefined);
  const mine = await (await get("/v2/relay/info", twin)).json() as { you: { pubkey: string; head_seq: number } };
  assert.equal(mine.you.pubkey, twin.publicKey, "by key, not by the shared name");
  const v1pull = await (await fetch(`${base}/v1/relay/messages?after=0`, { headers: relayHop("beta", twin.privateKey, "GET", "/v1/relay/messages", "") })).json() as { items: unknown[] };
  assert.ok(Array.isArray(v1pull.items), "v1 by name: the signature picks which beta is calling");
  const signedPath = "/v2/relay/items?after=0&limit=10";
  assert.equal((await get(signedPath, k.beta)).status, 200);
  assert.equal((await fetch(`${base}/v2/relay/items?after=5&limit=10`, { headers: relayHop("beta", k.beta.privateKey, "GET", signedPath, "", Date.now(), k.beta.publicKey) })).status, 401, "the pull cursor is covered by the signature");
  assert.equal((await get("/v2/relay/items?after=0&epoch=stale", k.beta)).status, 409);
  const nan = await fetch(`${base}${signedPath}`, { headers: { ...relayHop("beta", k.beta.privateKey, "GET", signedPath, "", Date.now(), k.beta.publicKey), "x-mbx-ts": "NaN" } });
  assert.equal(nan.status, 401);
  const { next, signed } = rotation("beta", k.beta);
  const rotated = await fetch(`${base}/v2/relay/rotate`, { method: "POST", body: JSON.stringify({ rotation: signed }) });
  assert.deepEqual([rotated.status, await rotated.json()], [200, { moved: 1 }]);
  assert.equal((await get(signedPath, next)).status, 200, "the new key is in");
  assert.equal((await get(signedPath, k.beta)).status, 401, "the old key is out");
});
