// T030: host key rotation keeps pairings, retired keys keep old mail verifiable, forged rotations fail, unpair propagates.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo, Server } from "node:net";
import { announceRotations, flushOutbox, notifyUnpair, startServer } from "../src/http.ts";
import { MbxNode } from "../src/node.ts";
import { canonical, generateKeyPair, signData } from "../src/crypto.ts";
import { finishRotation, saveRotationLog, type SignedRotation } from "../src/key-rotation.ts";
import { sealEnvelope, buildEnvelope, signEnvelope } from "../src/envelope.ts";
import { exportIdentity, importIdentity } from "../src/identity-backup.ts";

process.env.MBX_NO_DESKTOP = "1";

interface Up { n: MbxNode; s: Server; home: string; addr: string }
async function up(host: string, home = mkdtempSync(join(tmpdir(), "mbx-rot-")), port = 0): Promise<Up> {
  const n = new MbxNode(home, { host, bind: "127.0.0.1", port });
  const s = await startServer(n, port, "127.0.0.1");
  return { n, s, home, addr: `127.0.0.1:${(s.address() as AddressInfo).port}` };
}
const stop = (x: Up) => new Promise<void>((r) => { x.s.close(() => r()); x.n.close(); });
const pair = (A: Up, B: Up, owners: { a?: string } = {}) => {
  A.n.addApprovedPeer({ host: B.n.host, pubkey: B.n.key.publicKey, owner_pubkey: null, addr: B.addr }, "fixture");
  B.n.addApprovedPeer({ host: A.n.host, pubkey: A.n.key.publicKey, owner_pubkey: owners.a ?? null, addr: A.addr }, "fixture");
};
const outboxCount = (n: MbxNode) => (n.store.db.prepare("SELECT count(*) n FROM outbox").get() as { n: number }).n;

test("a rotated host keeps its pairing: peers move the pin, old mail still verifies, new mail flows both ways", async (t) => {
  const A = await up("alpha"), B = await up("beta");
  t.after(async () => { await stop(A); await stop(B); rmSync(A.home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); rmSync(B.home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
  const owner = generateKeyPair();
  pair(A, B, { a: owner.publicKey });
  A.n.send({ from: "mac-dev", to: ["vida-dev@beta"], kind: "task", subject: "before", body: "signed by the old key" }, undefined, { pub: owner.publicKey, priv: owner.privateKey });
  assert.deepEqual(await flushOutbox(A.n), { sent: 1, failed: 0 });
  const oldPub = A.n.key.publicKey, oldEnc = A.n.encKey.publicKey;

  const r = A.n.rotateKeys();
  assert.equal(r.rec.old_pub, oldPub);
  assert.notEqual(A.n.key.publicKey, oldPub, "the node switched to the new key in memory");
  assert.notEqual(A.n.encKey.publicKey, oldEnc, "the enc key rotates too");
  assert.deepEqual(await announceRotations(A.n, fetch, true), [{ host: "beta", ok: true }]);
  assert.deepEqual(await announceRotations(A.n, fetch, true), [], "delivered rotations are not resent");
  const onB = B.n.peer("alpha")!;
  assert.equal(onB.pubkey, A.n.key.publicKey, "beta pinned the new host key without re-pairing");
  assert.equal(onB.enc_pub, A.n.encKey.publicKey);
  assert.deepEqual(JSON.parse(onB.prev_keys!), [oldPub]);

  const [before] = B.n.inbox("vida-dev");
  assert.equal(B.n.authorityFor(before)?.ok, true, "owner authority on pre-rotation mail still verifies through the retired key");
  assert.equal(B.n.policyFor(before, "vida-dev").level !== undefined, true);

  A.n.send({ from: "mac-dev", to: ["vida-dev@beta"], subject: "after", body: "signed by the new key" });
  assert.deepEqual(await flushOutbox(A.n), { sent: 1, failed: 0 });
  B.n.send({ from: "vida-dev", to: ["mac-dev@alpha"], subject: "reply", body: "sealed to the new enc key" });
  assert.deepEqual(await flushOutbox(B.n), { sent: 1, failed: 0 });
  assert.equal(A.n.inbox("mac-dev")[0].body, "sealed to the new enc key");
  assert.equal(B.n.inbox("vida-dev").length, 2);
});

test("a peer offline during rotation catches up later; mail sealed to the retired enc key still opens", async (t) => {
  const A = await up("alpha"), B = await up("beta");
  const bHome = B.home, bPort = Number(B.addr.split(":")[1]);
  let B2: Up | undefined;
  t.after(async () => { await stop(A); if (B2) await stop(B2); rmSync(A.home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); rmSync(bHome, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
  pair(A, B);
  // beta seals a message to alpha's current enc key but has not delivered it yet
  B.n.store.db.prepare("UPDATE peers SET enc_pub=? WHERE host='alpha'").run(A.n.encKey.publicKey);
  const draft = buildEnvelope({ from: "vida-dev@beta", to: ["mac-dev@alpha"], subject: "in flight", body: "sealed before the rotation" });
  const inflight = sealEnvelope(draft, A.n.encKey.publicKey, "beta", B.n.key.publicKey, B.n.key.privateKey);
  await stop(B);

  A.n.rotateKeys();
  const [pending] = await announceRotations(A.n, fetch, true);
  assert.equal(pending.ok, false, "beta is offline: the rotation stays pending");
  A.n.send({ from: "mac-dev", to: ["vida-dev@beta"], subject: "queued", body: "waits for beta" });
  assert.equal(outboxCount(A.n), 1);

  B2 = await up("beta", bHome, bPort);
  assert.equal(B2.n.peer("alpha")!.pubkey !== A.n.key.publicKey, true, "beta still pins the old key");
  assert.equal((await announceRotations(A.n, fetch))[0], undefined, "an offline peer is retried at most once a minute");
  assert.deepEqual(await announceRotations(A.n, fetch, false, Date.now() + 61_000), [{ host: "beta", ok: true }]);
  assert.deepEqual(await flushOutbox(A.n, Date.now() + 120_000), { sent: 1, failed: 0 });
  assert.equal(B2.n.inbox("vida-dev")[0].subject, "queued");
  assert.equal(A.n.receive(inflight, "beta"), "accepted", "the retired enc key opens mail sealed before the rotation");
  assert.equal(A.n.inbox("mac-dev")[0].body, "sealed before the rotation");
});

test("forged, out-of-order and replayed rotations cannot move a pin", async (t) => {
  const A = await up("alpha"), B = await up("beta");
  t.after(async () => { await stop(A); await stop(B); rmSync(A.home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); rmSync(B.home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
  pair(A, B);
  const pinned = B.n.peer("alpha")!.pubkey;
  const mallory = generateKeyPair(), next = generateKeyPair();
  const rec = { v: 1 as const, type: "host-rotation" as const, host: "alpha", old_pub: pinned, new_pub: next.publicKey, new_enc_pub: next.publicKey, iat: new Date().toISOString() };
  const forged: SignedRotation = { rec, old_sig: signData(mallory.privateKey, canonical(rec)), new_sig: signData(next.privateKey, canonical(rec)) };
  assert.equal(B.n.acceptRotation(forged), "rejected:rotation is not signed by the pinned host key");
  const noPossession: SignedRotation = { rec, old_sig: signData(A.n.key.privateKey, canonical(rec)), new_sig: signData(mallory.privateKey, canonical(rec)) };
  assert.equal(B.n.acceptRotation(noPossession), "rejected:rotation is not signed by the new host key");
  const elsewhere = { ...rec, old_pub: mallory.publicKey };
  assert.equal(B.n.acceptRotation({ rec: elsewhere, old_sig: signData(mallory.privateKey, canonical(elsewhere)), new_sig: signData(next.privateKey, canonical(elsewhere)) }),
    "rejected:rotation does not start from the pinned host key");
  assert.equal(B.n.acceptRotation({ ...forged, rec: { ...rec, host: "gamma" } }), "rejected:host not paired");
  assert.equal(B.n.peer("alpha")!.pubkey, pinned, "nothing moved the pin");
  // the rotation endpoint is reachable without a hop signature, but only moves pins through valid records
  const res = await fetch(`http://${B.addr}/v1/rotate`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ records: [forged] }) });
  assert.deepEqual(await res.json(), { results: ["rejected:rotation is not signed by the pinned host key"] });
  const real = A.n.rotateKeys();
  assert.equal(B.n.acceptRotation(real), "rotated");
  assert.equal(B.n.acceptRotation(real), "current", "replaying an applied rotation is a no-op");
  // a stale host signature from the retired key no longer authenticates new mail
  const stale = signEnvelope(buildEnvelope({ from: "mac-dev@alpha", to: ["vida-dev@beta"], subject: "stale", body: "x" }), "alpha", pinned, generateKeyPair().privateKey);
  assert.equal(B.n.receive(stale, "alpha"), "rejected:bad signature");
});

test("an interrupted rotation completes only when its record was logged", () => {
  const home = mkdtempSync(join(tmpdir(), "mbx-rot-crash-"));
  try {
    const n = new MbxNode(home, { host: "alpha" });
    const old = n.key.publicKey;
    // staged keys without a logged record: a crash before logging keeps the old keys
    writeFileSync(join(home, "host.key.next"), JSON.stringify(generateKeyPair()));
    writeFileSync(join(home, "enc.key.next"), JSON.stringify(generateKeyPair()));
    assert.equal(finishRotation(home), false);
    n.close();
    const again = new MbxNode(home, { host: "alpha" });
    assert.equal(again.key.publicKey, old, "an unlogged rotation never replaces the keys");
    // a logged record whose swap was interrupted completes on the next start
    const next = generateKeyPair(), nextEnc = generateKeyPair();
    writeFileSync(join(home, "host.key.next"), JSON.stringify(next));
    writeFileSync(join(home, "enc.key.next"), JSON.stringify(nextEnc));
    const rec = { v: 1 as const, type: "host-rotation" as const, host: "alpha", old_pub: old, new_pub: next.publicKey, new_enc_pub: nextEnc.publicKey, iat: new Date().toISOString() };
    saveRotationLog(home, { records: [{ rec, old_sig: "x", new_sig: "y" }], delivered: {} });
    again.close();
    const resumed = new MbxNode(home, { host: "alpha" });
    assert.equal(resumed.key.publicKey, next.publicKey, "the logged rotation completed on start");
    assert.equal(existsSync(join(home, "host.key.next")), false);
    assert.deepEqual(resumed.hostKeys("alpha"), [next.publicKey, old], "the replaced key is retired, not lost");
    assert.equal(JSON.parse(readFileSync(join(home, "retired-keys.json"), "utf8")).enc.length, 1, "the old enc private key is kept to open in-flight mail");
    resumed.close();
  } finally { rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
});

test("removing a pairing tells the peer, which drops it too", async (t) => {
  const A = await up("alpha"), B = await up("beta");
  t.after(async () => { await stop(A); await stop(B); rmSync(A.home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); rmSync(B.home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
  pair(A, B);
  assert.equal(await notifyUnpair(A.n, "beta"), true);
  A.n.removePeer("beta");
  assert.equal(B.n.peer("alpha"), undefined, "beta removed alpha");
  assert.ok(B.n.store.db.prepare("SELECT 1 FROM audit WHERE event='pair.removed_by_peer'").get());
  assert.equal(await notifyUnpair(A.n, "beta"), false, "nothing to notify once removed");
});

test("an identity bundle carries rotation history, so a restored host still verifies pre-rotation mail", () => {
  const [home, restored] = [mkdtempSync(join(tmpdir(), "mbx-rot-exp-")), mkdtempSync(join(tmpdir(), "mbx-rot-imp-"))];
  try {
    const n = new MbxNode(home, { host: "alpha" });
    const old = n.key.publicKey;
    n.rotateKeys();
    const file = join(home, "bundle.json");
    exportIdentity(n, file, "correct horse battery staple");
    const current = n.key.publicKey;
    n.close();
    importIdentity(restored, readFileSync(file, "utf8"), "correct horse battery staple");
    const r = new MbxNode(restored);
    assert.deepEqual(r.hostKeys("alpha"), [current, old], "retired keys came along");
    assert.equal(JSON.parse(readFileSync(join(restored, "rotations.json"), "utf8")).records.length, 1, "pending announcements can still finish");
    r.close();
  } finally { rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); rmSync(restored, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
});
