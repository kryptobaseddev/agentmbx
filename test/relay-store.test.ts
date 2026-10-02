// Durable relay store (T165, docs/spec/relay-durability.md §2, §3, §4, §7): a restart loses nothing, fan-out is
// all-or-nothing per item, dedup tells a retry from a conflicting reuse of an id, every acceptance is signed by the relay
// key, pulls page by last returned seq, and acks never run past what was allocated.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { canonical, generateKeyPair, signData, verifyData, type KeyPair } from "../src/crypto.ts";
import { generateEncKeyPair } from "../src/body-encryption.ts";
import { buildEnvelope, sealEnvelope } from "../src/envelope.ts";
import { DEFAULT_QUOTA, RelayCore, relayHop, startRelayServer, type PushItem } from "../src/relay.ts";
import { SqliteRelayStore } from "../src/relay-store.ts";

function enrol(core: RelayCore, host: string, key: KeyPair, owner = "owner-1") {
  const challenge = core.challenge(host, key.publicKey);
  core.enrol(host, key.publicKey, owner, signData(key.privateKey, canonical({ v: 1, challenge, host, pubkey: key.publicKey, owner_fp: owner })));
}
const keys = () => ({ alpha: generateKeyPair(), beta: generateKeyPair(), gamma: generateKeyPair() });
const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64");
function sealedFor(from: { host: string; key: KeyPair }, to: string[], body = "secret") {
  const enc = generateEncKeyPair();
  return sealEnvelope(buildEnvelope({ from: `alice@${from.host}`, to, subject: "s", body }), enc.publicKey, from.host, from.key.publicKey, from.key.privateKey);
}
const item = (e: ReturnType<typeof sealedFor>, targets: KeyPair[]): PushItem =>
  ({ kind: "envelope", item_id: e.id, targets: targets.map((k) => ({ host_pubkey: k.publicKey, wire_b64: b64(JSON.stringify(e)) })) });

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
  assert.equal(core.getEncAd("beta")?.enc_pub, "ENCPUB");
  const pulled = core.pullItems(k.beta.publicKey, 0);
  assert.deepEqual(pulled.items.map((i) => [i.seq, i.item_id]), [[1, e1.id]]);
  const e2 = sealedFor({ host: "alpha", key: k.alpha }, ["bob@beta"]);
  assert.deepEqual(core.pushItems({ host: "alpha", pubkey: k.alpha.publicKey }, [item(e2, [k.beta])])[0].targets.map((x) => x.seq), [2], "sequence numbers continue, never restart");
  // and the same store refuses another relay key (its accept receipts would no longer verify)
  assert.throws(() => new RelayCore(DEFAULT_QUOTA, { store: core.store, key: generateKeyPair() }), /another relay key/);
});

test("dedup: a retry is a duplicate with the same seq and a valid signed receipt; a different body under the same id is a conflict", (t) => {
  const core = new RelayCore(); t.after(() => core.store.close());
  const k = keys(); enrol(core, "alpha", k.alpha); enrol(core, "beta", k.beta);
  const e = sealedFor({ host: "alpha", key: k.alpha }, ["bob@beta"]);
  const from = { host: "alpha", pubkey: k.alpha.publicKey };
  const first = core.pushItems(from, [item(e, [k.beta])])[0];
  assert.equal(first.status, "accepted");
  assert.ok(verifyData(core.key.publicKey, canonical(first.accept), first.sig!), "the accept receipt is signed by the relay key");
  assert.equal(first.accept!.targets[0].host_pubkey, k.beta.publicKey);
  const retry = core.pushItems(from, [item(e, [k.beta])])[0];
  assert.equal(retry.status, "duplicate"); assert.equal(retry.targets[0].seq, first.targets[0].seq);
  const resealed = sealedFor({ host: "alpha", key: k.alpha }, ["bob@beta"], "different");
  const conflict = core.pushItems(from, [{ ...item(resealed, [k.beta]), item_id: e.id }])[0];
  assert.match(conflict.status, /rejected:(conflict|item id is not the envelope id)/);
  const sameIdNewBody = { ...e, body: resealed.body, enc: resealed.enc };
  assert.equal(core.pushItems(from, [{ kind: "envelope", item_id: e.id, targets: [{ host_pubkey: k.beta.publicKey, wire_b64: b64(JSON.stringify(sameIdNewBody)) }] }])[0].status, "rejected:conflict");
  assert.equal(core.pullItems(k.beta.publicKey).items.length, 1, "one stored item, never two");
});

test("fan-out is all-or-nothing per item, and the relay only stores sealed envelopes and well-formed receipts", (t) => {
  const core = new RelayCore({ ...DEFAULT_QUOTA, maxQueueDepth: 1 }); t.after(() => core.store.close());
  const k = keys(); enrol(core, "alpha", k.alpha); enrol(core, "beta", k.beta); enrol(core, "gamma", k.gamma);
  const from = { host: "alpha", pubkey: k.alpha.publicKey };
  core.pushItems(from, [item(sealedFor({ host: "alpha", key: k.alpha }, ["x@gamma"]), [k.gamma])]); // gamma's queue is now full
  const both = core.pushItems(from, [item(sealedFor({ host: "alpha", key: k.alpha }, ["bob@beta", "carol@gamma"]), [k.beta, k.gamma])])[0];
  assert.match(both.status, /^rejected:quota:queue depth exceeded for gamma/);
  assert.equal(core.pullItems(k.beta.publicKey).items.length, 0, "beta got nothing: the item is rolled back as a whole");
  const plain = buildEnvelope({ from: "alice@alpha", to: ["bob@beta"], subject: "s", body: "PLAINTEXT" });
  assert.equal(core.pushItems(from, [{ kind: "envelope", item_id: plain.id, targets: [{ host_pubkey: k.beta.publicKey, wire_b64: b64(JSON.stringify(plain)) }] }])[0].status,
    "rejected:envelope body is not sealed");
  assert.equal(core.pushItems(from, [{ kind: "envelope", item_id: "nope", targets: [] }])[0].status, "rejected:bad targets");
  assert.equal(core.pushItems(from, [{ kind: "envelope", item_id: "x".repeat(20), targets: [{ host_pubkey: generateKeyPair().publicKey, wire_b64: "e30=" }] }])[0].status, "rejected:target not enrolled");
  const receipt = { rec: { v: 1, type: "receipt", msg: "01M3XPVHH2E83AW8KYVYVFH8KW", recipient: "bob@beta", state: "acked", at: new Date().toISOString(), seq: 1 }, sig: "SIG" };
  assert.equal(core.pushItems({ host: "beta", pubkey: k.beta.publicKey }, [{ kind: "receipt", item_id: "receipt:01M3XPVHH2E83AW8KYVYVFH8KW:bob@beta:1",
    targets: [{ host_pubkey: k.alpha.publicKey, wire_b64: b64(canonical(receipt)) }] }])[0].status, "accepted");
  assert.equal(core.pullItems(k.alpha.publicKey).items[0].kind, "receipt");
});

test("pull pages by last returned seq; ack is per epoch, never past what was allocated, and deletes only what it covers", (t) => {
  const core = new RelayCore({ ...DEFAULT_QUOTA, maxPull: 2 }); t.after(() => core.store.close());
  const k = keys(); enrol(core, "alpha", k.alpha); enrol(core, "beta", k.beta);
  const from = { host: "alpha", pubkey: k.alpha.publicKey };
  for (let i = 0; i < 3; i++) core.pushItems(from, [item(sealedFor({ host: "alpha", key: k.alpha }, ["bob@beta"]), [k.beta])]);
  const p1 = core.pullItems(k.beta.publicKey, 0, 10);
  assert.deepEqual([p1.items.map((i) => i.seq), p1.last_seq, p1.more], [[1, 2], 2, true]);
  const p2 = core.pullItems(k.beta.publicKey, p1.last_seq);
  assert.deepEqual([p2.items.map((i) => i.seq), p2.last_seq, p2.more], [[3], 3, false]);
  assert.throws(() => core.ackItems(k.beta.publicKey, p1.epoch, 4), /beyond the last allocated seq/);
  assert.throws(() => core.ackItems(k.beta.publicKey, "an-old-epoch", 2), /epoch changed/);
  assert.deepEqual(core.ackItems(k.beta.publicKey, p1.epoch, 2), { acked_through: 2, deleted: 2 });
  assert.deepEqual(core.pullItems(k.beta.publicKey, 0).items.map((i) => i.seq), [3], "only the unacked item is left");
  assert.equal(core.pullItems(k.beta.publicKey, 0).last_seq, 3);
});

test("owner quotas count items and bytes; a host name stays bound to its first key (F4)", (t) => {
  const core = new RelayCore({ ...DEFAULT_QUOTA, maxOwnerBytes: 3000 }); t.after(() => core.store.close());
  const k = keys(); enrol(core, "alpha", k.alpha); enrol(core, "beta", k.beta);
  const from = { host: "alpha", pubkey: k.alpha.publicKey };
  const statuses = Array.from({ length: 4 }, () => core.pushItems(from, [item(sealedFor({ host: "alpha", key: k.alpha }, ["bob@beta"], "x".repeat(600)), [k.beta])])[0].status);
  assert.ok(statuses.some((s) => /owner queue bytes exceeded/.test(s)), statuses.join(","));
  const squatter = generateKeyPair();
  assert.throws(() => enrol(core, "beta", squatter), /enrolled with another key/);
  assert.equal(core.enrolmentByName("beta")!.pubkey, k.beta.publicKey);
});

test("v1 mail is durable too, and the HTTP v2 endpoints sign the query string", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "mbx-relayhttp-"));
  const path = join(dir, "relay.db"), relayKey = generateKeyPair(), k = keys();
  let core = new RelayCore(DEFAULT_QUOTA, { store: new SqliteRelayStore(path), key: relayKey });
  enrol(core, "alpha", k.alpha); enrol(core, "beta", k.beta);
  const v1 = sealedFor({ host: "alpha", key: k.alpha }, ["bob@beta"]);
  assert.deepEqual(core.push({ host: "alpha", pubkey: k.alpha.publicKey }, [v1]), { stored: 1 });
  core.store.close();
  core = new RelayCore(DEFAULT_QUOTA, { store: new SqliteRelayStore(path), key: relayKey });
  assert.deepEqual(core.pull(k.beta.publicKey).items.map((i) => i.envelope.id), [v1.id], "v1 mail survives the restart");
  const server = await startRelayServer(core, 0, "127.0.0.1");
  t.after(() => new Promise<void>((r) => server.close(() => { core.store.close(); rmSync(dir, { recursive: true, force: true }); r(); })));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const info = await (await fetch(`${base}/v2/relay/info`)).json() as { relay_pubkey: string; epoch: string; limits: { retention_days: number; max_owner_bytes: number } };
  assert.equal(info.relay_pubkey, relayKey.publicKey); assert.equal(info.limits.retention_days, 14); assert.equal(info.limits.max_owner_bytes, 50 * 1024 * 1024);
  const signedPath = "/v2/relay/items?after=0&limit=10";
  const ok = await fetch(`${base}${signedPath}`, { headers: relayHop("beta", k.beta.privateKey, "GET", signedPath, "") });
  assert.equal(ok.status, 200);
  const tampered = await fetch(`${base}/v2/relay/items?after=5&limit=10`, { headers: relayHop("beta", k.beta.privateKey, "GET", signedPath, "") });
  assert.equal(tampered.status, 401, "the pull cursor is covered by the signature");
});

test("an injected relay key (MBX_RELAY_KEY) yields the same key pair as the generated one", async () => {
  const { generateKeyPair, keyPairFromPrivate } = await import("../src/crypto.ts");
  const k = generateKeyPair();
  assert.deepEqual(keyPairFromPrivate(k.privateKey), k);
  assert.throws(() => keyPairFromPrivate("c2hvcnQ="), /32-byte/);
});
