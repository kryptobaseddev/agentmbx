// The council's four trust tests (docs/COUNCIL-VERDICT-2026-09-26.md) plus the basic two-host flow, without HTTP.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateKeyPair, pairingCode } from "../src/crypto.ts";
import { makeGrant } from "../src/envelope.ts";
import { MbxNode, type Session } from "../src/node.ts";
import { createOwnerKey, unlockOwnerKey } from "../src/owner.ts";

const tmp = () => mkdtempSync(join(tmpdir(), "mbx-test-"));
const PASS = "correct horse battery staple";

/** Two hosts, each with an owner key, paired both ways (as `mbx pair` + approve would leave them). */
function twoHosts() {
  const a = new MbxNode(tmp(), { host: "alpha" }), b = new MbxNode(tmp(), { host: "beta" });
  createOwnerKey(a.home, PASS); createOwnerKey(b.home, PASS);
  for (const [x, y] of [[a, b], [b, a]] as const) {
    x.upsertPendingPeer({ host: y.host, pubkey: y.key.publicKey, owner_pubkey: y.ownerPub, addr: "127.0.0.1:0", code: "000000", nonce_local: "n", nonce_remote: "n" });
    x.approvePeer(y.host);
  }
  a.registerAgent("master"); a.registerAgent("helper"); b.registerAgent("worker", { role: "dev" });
  b.bindSession({ agent: "worker", cli: "codex", session_id: "mcp-worker", pid: process.pid, session_key: "k" }); // a live session: role: and * reach it
  return { a, b };
}

function masterSession(a: MbxNode, caps = ["task.assign"], hours = 12): Session {
  const s = generateKeyPair(), owner = unlockOwnerKey(a.home, PASS);
  return { priv: s.privateKey, pub: s.publicKey, grant: makeGrant(owner.publicKey, owner.privateKey, s.publicKey, "master", a.host, caps, hours) };
}

const deliverOutbox = (from: MbxNode, to: MbxNode) =>
  (from.store.db.prepare("SELECT m.envelope FROM outbox o JOIN messages m ON m.id=o.msg_id WHERE o.host=?").all(to.host) as { envelope: string }[])
    .map((r) => to.receive(JSON.parse(r.envelope), from.host));

test("council 1: a grant used by a non-master session carries no authority", () => {
  const { a, b } = twoHosts();
  const real = masterSession(a);
  a.send({ from: "master", to: ["worker@beta"], subject: "real", body: "do X", kind: "task" }, real);
  // an impostor on the same host: same agent name, stolen grant, but its own session key
  const impostor = generateKeyPair();
  a.send({ from: "master", to: ["worker@beta"], subject: "fake", body: "do Y", kind: "task" }, { priv: impostor.privateKey, pub: impostor.publicKey, grant: real.grant });
  // and a plain send with the same name and no session at all
  a.send({ from: "master", to: ["worker@beta"], subject: "plain", body: "do Z", kind: "task" });
  assert.deepEqual(deliverOutbox(a, b), ["accepted", "accepted", "accepted"]);
  const got = Object.fromEntries(b.inbox("worker").map((m) => [m.subject, m.authority ? JSON.parse(m.authority) : null]));
  assert.equal(got.real.ok, true);
  assert.equal(got.fake.ok, false);
  assert.match(got.fake.reason, /session signature invalid/);
  assert.equal(got.plain, null);
});

test("council 2: an envelope retried after 11 minutes and after 3 days is stored exactly once", () => {
  const { a, b } = twoHosts();
  const { envelope } = a.send({ from: "helper", to: ["worker@beta"], subject: "late", body: "hi" });
  // simulate a very old envelope arriving (the envelope's own ts is never checked for freshness)
  const old = { ...envelope };
  assert.equal(b.receive(old, "alpha"), "accepted");
  assert.equal(b.receive(old, "alpha"), "duplicate");
  assert.equal(b.receive(old, "alpha"), "duplicate");
  assert.equal(b.inbox("worker").length, 1);
});

test("council 3: swapping either owner key (or a host key or name) changes the pairing code", () => {
  const h1 = generateKeyPair().publicKey, h2 = generateKeyPair().publicKey, o1 = generateKeyPair().publicKey, o2 = generateKeyPair().publicKey;
  const A = { host: "alpha", host_pubkey: h1, owner_pubkey: o1, nonce: "na" }, B = { host: "beta", host_pubkey: h2, owner_pubkey: o2, nonce: "nb" };
  const base = pairingCode(A, B);
  assert.equal(base, pairingCode(B, A));
  assert.notEqual(base, pairingCode({ ...A, owner_pubkey: generateKeyPair().publicKey }, B));
  assert.notEqual(base, pairingCode(A, { ...B, owner_pubkey: generateKeyPair().publicKey }));
  assert.notEqual(base, pairingCode({ ...A, host_pubkey: generateKeyPair().publicKey }, B));
  assert.notEqual(base, pairingCode(A, { ...B, host: "gamma" }));
});

test("council 4: a message that exceeds its caps arrives with authority none", () => {
  const { a, b } = twoHosts();
  const s = masterSession(a, ["task.assign"]);
  a.send({ from: "master", to: ["worker@beta"], subject: "status", body: "fyi", kind: "status" }, s);          // status never carries authority
  a.send({ from: "master", to: ["role:dev"], subject: "broadcast task", body: "all devs", kind: "task" }, s); // needs broadcast
  a.send({ from: "master", to: ["worker@beta"], subject: "decision", body: "we ship", kind: "decision" }, s); // needs decision
  a.send({ from: "master", to: ["worker@beta"], subject: "ok task", body: "fix it", kind: "task" }, s);
  deliverOutbox(a, b);
  const got = Object.fromEntries(b.inbox("worker").map((m) => [m.subject, JSON.parse(m.authority!)]));
  assert.equal(got.status.ok, false);
  assert.equal(got["broadcast task"].ok, false);
  assert.match(got["broadcast task"].reason, /broadcast/);
  assert.equal(got.decision.ok, false);
  assert.equal(got["ok task"].ok, true);
});

test("forged owner key, expired and revoked grants are rejected", () => {
  const { a, b } = twoHosts();
  const mallory = generateKeyPair(), s = generateKeyPair();
  const forged = makeGrant(mallory.publicKey, mallory.privateKey, s.publicKey, "master", "alpha", ["task.assign"]);
  a.send({ from: "master", to: ["worker@beta"], subject: "forged", body: "x", kind: "task" }, { priv: s.privateKey, pub: s.publicKey, grant: forged });
  const real = masterSession(a);
  a.send({ from: "master", to: ["worker@beta"], subject: "revoked", body: "x", kind: "task" }, real);
  b.store.db.prepare("INSERT INTO grants VALUES (?,?,?,?,1)").run(real.grant!.id, real.grant!.sub, "{}", real.grant!.exp);
  deliverOutbox(a, b);
  const got = Object.fromEntries(b.inbox("worker").map((m) => [m.subject, JSON.parse(m.authority!)]));
  assert.match(got.forged.reason, /pinned owner key/);
  assert.match(got.revoked.reason, /revoked/);
  assert.throws(() => makeGrant(mallory.publicKey, mallory.privateKey, s.publicKey, "m", "h", ["task.assign"], 24 * 8), /lifetime/);
});

test("unpaired host, tampered body and host spoofing are rejected", () => {
  const { a, b } = twoHosts();
  const stranger = new MbxNode(tmp(), { host: "gamma" });
  const { envelope: fromStranger } = stranger.send({ from: "xx", to: ["worker@beta"], subject: "s", body: "b" });
  assert.equal(b.receive(fromStranger, "gamma"), "rejected:host not paired");
  const { envelope } = a.send({ from: "helper", to: ["worker@beta"], subject: "s", body: "original" });
  assert.equal(b.receive({ ...envelope, body: "tampered" }, "alpha"), "rejected:bad signature");
  assert.equal(b.receive({ ...envelope, from: "helper@gamma" }, "alpha"), "rejected:sender host mismatch");
  assert.equal(b.receive(envelope, "alpha"), "accepted");
});

test("local delivery, labels, inbox/read/ack, threads and search", () => {
  const { a } = twoHosts();
  const { envelope } = a.send({ from: "master", to: ["helper"], subject: "Deploy plan", body: "please /claim T1925 #deploy", kind: "request", needs_reply: true });
  a.send({ from: "helper", to: ["master"], subject: "re: Deploy plan", body: "on it", kind: "reply", thread: envelope.thread, reply_to: envelope.id });
  const inbox = a.inbox("helper");
  assert.equal(inbox.length, 1);
  assert.equal(inbox[0].trust, "local");
  assert.equal(a.unreadCount("helper"), 1);
  a.read(envelope.id, "helper");
  assert.equal(a.unreadCount("helper"), 1, "reading is read-only; only ack clears it");
  a.ack(envelope.id, "helper", "done");
  assert.equal(a.unreadCount("helper"), 0);
  assert.equal(a.inbox("helper", { all: true })[0].state, "acked");
  assert.equal(a.thread(envelope.thread).length, 2);
  assert.equal(a.search("deploy")[0].id, envelope.id);
  assert.equal(a.wantsWake("helper", inbox[0]), true);
});

test("wake brake: batching stays, thread/hour and agent/day counts do not block, and status does not wake", () => {
  const { a } = twoHosts();
  let t = Date.now();
  assert.equal(a.takeWake("helper", "th1", t), null);
  assert.match(a.takeWake("helper", "th1", t + 5_000)!, /batched/);
  for (let i = 1; i < 70; i++) assert.equal(a.takeWake("helper", "th1", t + i * 31_000), null, `wake ${i + 1} is admitted`);
  assert.match(a.takeWake("helper", "th2", t + 69 * 31_000 + 5_000)!, /batched/, "batching is per agent across threads");
  assert.equal(a.takeWake("helper", "th2", t + 70 * 31_000), null);
  const { envelope } = a.send({ from: "master", to: ["helper"], subject: "fyi", body: "status only", kind: "status" });
  assert.equal(a.wantsWake("helper", a.message(envelope.id)!), false);
});

test("Stop continuation records every turn without thread/hour or agent/day count limits", () => {
  const { a } = twoHosts(), now = Date.now();
  for (let i = 0; i < 70; i++) assert.equal(a.allowContinue("helper", "th1", now), true, `continuation ${i + 1} is admitted`);
  assert.equal(a.allowContinue("helper", null, now), true, "a continuation without a thread still passes above 60/day");
  const count = a.store.db.prepare("SELECT count(*) n FROM wakes WHERE agent=?").get("helper") as { n: number };
  assert.equal(count.n, 71, "continuations retain wake history for batching and diagnostics");
});

test("owner key: wrong passphrase fails, file is not plaintext", () => {
  const h = tmp();
  const pub = createOwnerKey(h, PASS);
  assert.equal(unlockOwnerKey(h, PASS).publicKey, pub);
  assert.throws(() => unlockOwnerKey(h, "wrong passphrase!!"), /wrong passphrase/);
  assert.throws(() => createOwnerKey(tmp(), "short"), /12 characters/);
});

test("owner-signed direct message: verified on the paired host, forgery and tampering rejected", () => {
  const { a, b } = twoHosts();
  const owner = unlockOwnerKey(a.home, PASS);
  a.send({ from: "owner", to: ["worker@beta"], subject: "do it", body: "owner says go", kind: "task" }, undefined, { pub: owner.publicKey, priv: owner.privateKey });
  const mallory = generateKeyPair();
  a.send({ from: "owner", to: ["worker@beta"], subject: "fake", body: "x", kind: "task" }, undefined, { pub: mallory.publicKey, priv: mallory.privateKey });
  deliverOutbox(a, b);
  const got = Object.fromEntries(b.inbox("worker").map((m) => [m.subject, JSON.parse(m.authority!)]));
  assert.equal(got["do it"].ok, true);
  assert.equal(got["do it"].session, "signed by the owner");
  assert.equal(got.fake.ok, false);
  // local recipients on the owner's own host see it too
  a.registerAgent("helper");
  a.send({ from: "owner", to: ["helper"], subject: "local", body: "y", kind: "task" }, undefined, { pub: owner.publicKey, priv: owner.privateKey });
  assert.equal(JSON.parse(a.inbox("helper")[0].authority!).ok, true);
});

test("hook and MCP bindings from one CLI process share the MCP server's agent name", () => {
  const node = new MbxNode(mkdtempSync(join(tmpdir(), "mbx-bind-")), { host: "h1" });
  // hook binds first under the folder name, then the MCP server (renamed) binds from the same process
  node.bindSession({ agent: "keatonhoskins", cli: "codex", session_id: "thread-1", pid: process.pid });
  node.bindSession({ agent: "codex", cli: "codex", session_id: "mcp-1", pid: process.pid, session_key: "k" });
  assert.deepEqual(node.sessionsFor("codex").map((s) => s.session_id), ["thread-1"]);
  // a later hook run (resume) adopts the MCP name too
  node.bindSession({ agent: "keatonhoskins", cli: "codex", session_id: "thread-1", pid: process.pid });
  assert.equal(node.sessionsFor("keatonhoskins").length, 0);
  node.close();
});
