// Cross-host delivery receipts (T218): a recipient host reports delivered, notified, read and acked (with did) back to the
// sender host, signed by its own key; the sender applies them in order and shows them instead of "handed-over". Tampered,
// misdirected, replayed and out-of-order receipts change nothing, and an older peer degrades quietly.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { flushOutbox, flushReceipts, startServer } from "../src/http.ts";
import { MbxNode } from "../src/node.ts";
import { canonical, signData } from "../src/crypto.ts";
import { acceptReceipt, dueReceipts, remoteReceipts, type ReceiptRecord } from "../src/remote-receipts.ts";
import { sentPage } from "../src/receipts.ts";

process.env.MBX_NO_DESKTOP = "1";

interface Up { n: MbxNode; s: Server; home: string; addr: string }
async function up(host: string): Promise<Up> {
  const home = mkdtempSync(join(tmpdir(), "mbx-rcpt-"));
  const n = new MbxNode(home, { host, bind: "127.0.0.1", port: 0 });
  const s = await startServer(n, 0, "127.0.0.1");
  return { n, s, home, addr: `127.0.0.1:${(s.address() as AddressInfo).port}` };
}
async function pairUp(t: { after: (fn: () => Promise<void>) => void }) {
  const A = await up("alpha"), B = await up("beta");
  t.after(async () => {
    for (const x of [A, B]) { await new Promise<void>((r) => x.s.close(() => r())); x.n.close(); rmSync(x.home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
  });
  A.n.addApprovedPeer({ host: "beta", pubkey: B.n.key.publicKey, owner_pubkey: null, addr: B.addr }, "fixture");
  B.n.addApprovedPeer({ host: "alpha", pubkey: A.n.key.publicKey, owner_pubkey: null, addr: A.addr }, "fixture");
  return { A, B };
}
const owed = (n: MbxNode) => (n.store.db.prepare("SELECT agent,host,state FROM receipt_outbox ORDER BY seq").all() as { agent: string; host: string; state: string }[]).map((r) => ({ ...r }));
const remoteOf = (n: MbxNode, sender: string) => sentPage(n, sender).messages[0].recipients.filter((r) => !r.address.endsWith("@alpha"));

test("a paired host reports delivered, read and acked with did; the sender sees them instead of handed-over", async (t) => {
  const { A, B } = await pairUp(t);
  B.n.registerAgent("worker");
  const id = A.n.send({ from: "boss", to: ["worker@beta"], kind: "task", subject: "fix it", body: "please" }).envelope.id;
  assert.deepEqual(await flushOutbox(A.n), { sent: 1, failed: 0 });
  assert.deepEqual(owed(B.n), [{ agent: "worker", host: "alpha", state: "delivered" }], "the delivery queued a receipt for the sending host");
  assert.equal(remoteOf(A.n, "boss")[0].state, "handed-over");
  assert.deepEqual(await flushReceipts(B.n), { sent: 1, deferred: 0 });
  assert.deepEqual(owed(B.n), []);
  let r = remoteOf(A.n, "boss");
  assert.equal(r.length, 1); assert.equal(r[0].address, "worker@beta"); assert.equal(r[0].state, "delivered"); assert.match(r[0].liveness, /signed receipt/);

  B.n.setDelivery(id, "worker", "read");
  B.n.ack(id, "worker", "merged", "fixed the parser and pushed 1a2b3c");
  assert.deepEqual(owed(B.n).map((x) => x.state), ["read", "acked"]);
  assert.deepEqual(await flushReceipts(B.n), { sent: 2, deferred: 0 });
  r = remoteOf(A.n, "boss");
  assert.equal(r[0].state, "acked"); assert.equal(r[0].did, "fixed the parser and pushed 1a2b3c"); assert.equal(r[0].note, "merged");
  const stored = A.n.store.db.prepare("SELECT record,sig FROM remote_receipts WHERE msg_id=?").get(id) as { record: string; sig: string };
  assert.equal(JSON.parse(stored.record).recipient, "worker@beta", "the signed record is kept for audit");

  // mail that never left this host queues no receipts
  A.n.registerAgent("local-peer"); A.n.send({ from: "boss", to: ["local-peer"], subject: "here", body: "b" });
  assert.deepEqual(owed(A.n), []);
  // a bare name that routed to beta (no host in the address, outbox already drained) is shown once beta reports it
  B.n.registerAgent("solo");
  A.n.store.db.prepare("INSERT INTO agents (name,host,role,cli,description,last_seen) VALUES ('solo','beta',NULL,'kimi',NULL,?)").run(new Date().toISOString());
  const bare = A.n.send({ from: "lead", to: ["solo"], subject: "bare", body: "b" }).envelope.id;
  await flushOutbox(A.n); await flushReceipts(B.n);
  const lead = sentPage(A.n, "lead").messages.find((m) => m.id === bare)!;
  assert.deepEqual(lead.recipients.map((x) => [x.address, x.state]), [["solo@beta", "delivered"]]);
});

test("receipts apply only when signed by the recipient host for this host's own mail, in rank then seq order", async (t) => {
  const { A, B } = await pairUp(t);
  const id = A.n.send({ from: "boss", to: ["worker@beta"], subject: "s", body: "b" }).envelope.id;
  const make = (over: Partial<ReceiptRecord> = {}, key = B.n.key.privateKey) => {
    const rec = { v: 1 as const, type: "receipt" as const, msg: id, recipient: "worker@beta", state: "read" as const, at: new Date().toISOString(), seq: 5, ...over };
    return { rec, sig: signData(key, canonical(rec)) };
  };
  assert.equal(acceptReceipt(A.n, make(), "beta"), "accepted");
  assert.equal(acceptReceipt(A.n, make(), "beta"), "duplicate", "a replayed receipt changes nothing");
  assert.equal(acceptReceipt(A.n, make({ state: "delivered", seq: 9 }), "beta"), "stale", "a lower state never moves a receipt back");
  assert.equal(acceptReceipt(A.n, make({ seq: 4 }), "beta"), "stale");
  const forged = make({ state: "acked", seq: 6 }); forged.rec = { ...forged.rec, did: "something it never did" };
  assert.equal(acceptReceipt(A.n, forged, "beta"), "rejected:bad signature");
  assert.equal(acceptReceipt(A.n, make({ state: "acked", seq: 6 }, A.n.key.privateKey), "beta"), "rejected:bad signature", "only beta's key signs beta's receipts");
  assert.match(acceptReceipt(A.n, make({ state: "acked", seq: 6, recipient: "worker@gamma" }), "beta"), /^rejected:receipt for worker@gamma did not come from gamma/);
  assert.match(acceptReceipt(A.n, make({ msg: "01M3XXXXXXXXXXXXXXXXXXXXXX", seq: 6 }), "beta"), /not a message this host sent/);
  assert.equal(acceptReceipt(A.n, { rec: { ...make().rec, extra: 1 }, sig: "x" }, "beta"), "rejected:invalid receipt");
  assert.equal(acceptReceipt(A.n, make({ state: "acked", seq: 6 }), "beta"), "accepted");
  assert.deepEqual(remoteReceipts(A.n, id).map((r) => [r.recipient, r.state]), [["worker@beta", "acked"]]);
  // only a host the message was routed to reports on it: mail sent only to gamma takes no receipt from beta
  const toGamma = A.n.send({ from: "boss", to: ["someone@gamma"], subject: "s", body: "b" }).envelope.id;
  assert.equal(acceptReceipt(A.n, make({ msg: toGamma, seq: 8 }), "beta"), "rejected:message was not sent to beta");
  const bare = A.n.send({ from: "boss", to: ["worker"], subject: "s", body: "b" }).envelope.id;
  assert.equal(acceptReceipt(A.n, make({ msg: bare, seq: 8 }), "beta"), "accepted", "a bare name could have resolved to beta");
  // a receipt signed before beta rotated its host key still verifies after the rotation (retired keys count)
  const early = make({ msg: bare, state: "acked", seq: 9 }), signedWith = B.n.key.publicKey;
  assert.equal(A.n.acceptRotation(B.n.rotateKeys()), "rotated");
  assert.notEqual(A.n.approvedPeer("beta")!.pubkey, signedWith, "beta's pinned key moved on");
  assert.equal(acceptReceipt(A.n, early, "beta"), "accepted");
  // a received message (not ours) never takes receipts, even signed by its own host
  B.n.registerAgent("boss2");
  const theirs = B.n.send({ from: "boss2", to: ["x@alpha"], subject: "s", body: "b" }).envelope.id;
  await flushOutbox(B.n);
  assert.match(acceptReceipt(A.n, make({ msg: theirs, seq: 7 }), "beta"), /not a message this host sent/);
});

test("an older peer without the endpoint degrades to handed-over: receipts wait hourly, then expire, with no errors", async (t) => {
  const { A, B } = await pairUp(t);
  B.n.registerAgent("worker");
  A.n.send({ from: "boss", to: ["worker@beta"], subject: "s", body: "b" });
  await flushOutbox(A.n);
  const old = createServer((_q, res) => { res.writeHead(404, { "content-type": "application/json" }); res.end('{"error":"not found"}'); });
  await new Promise<void>((r) => old.listen(0, "127.0.0.1", r));
  t.after(() => new Promise<void>((r) => old.close(() => r())));
  B.n.store.db.prepare("UPDATE peers SET addr=? WHERE host='alpha'").run(`127.0.0.1:${(old.address() as AddressInfo).port}`);
  const now = Date.now();
  assert.deepEqual(await flushReceipts(B.n, now), { sent: 0, deferred: 1 });
  const row = B.n.store.db.prepare("SELECT next_at,last_error FROM receipt_outbox").get() as { next_at: string; last_error: string };
  assert.match(row.last_error, /does not accept receipts yet \(older AgentMBX\)/);
  assert.ok(Date.parse(row.next_at) - now >= 3_590_000, "retried hourly, not every tick");
  assert.deepEqual(await flushReceipts(B.n, now + 60_000), { sent: 0, deferred: 0 }, "not due yet");
  assert.equal(dueReceipts(B.n, now + 73 * 3_600_000).size, 0, "expired after 72 h");
  assert.equal((B.n.store.db.prepare("SELECT count(*) n FROM receipt_outbox").get() as { n: number }).n, 0);
  assert.ok(B.n.store.db.prepare("SELECT 1 FROM audit WHERE event='receipt.expired'").get());
  assert.equal(remoteOf(A.n, "boss")[0].state, "handed-over", "the sender keeps the honest handed-over state");
});
