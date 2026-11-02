// T765: informational mail closes on read; work mail read but unanswered is reminded at 30 min and reported to the lead at 2 h.
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonical, signData } from "../src/crypto.ts";
import { makeLead, storeLead } from "../src/lead-record.ts";
import { MbxNode } from "../src/node.ts";
import { createOwnerKey, unlockOwnerKey } from "../src/owner.ts";
import { noteProject } from "../src/registry.ts";
import { ALERT_AFTER_MS, REMIND_AFTER_MS, sweepUnanswered, unansweredReminder } from "../src/unanswered.ts";

type Kind = "message" | "reply" | "status" | "request" | "task";

function world(t: TestContext) {
  const n = new MbxNode(mkdtempSync(join(tmpdir(), "mbx-t765-")), { host: "testhost", bind: "127.0.0.1", port: 0 });
  createOwnerKey(n.home, "test-only-passphrase");
  const owner = unlockOwnerKey(n.home, "test-only-passphrase");
  t.after(() => { n.close(); rmSync(n.home, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); });
  const dir = join(n.home, "alpha");
  mkdirSync(join(dir, ".cleo"), { recursive: true });
  writeFileSync(join(dir, ".cleo", "project-id"), "# CLEO project id: write once, commit it\n071b70b3-551d-44bb-b993-1e84bfa2fe09\n");
  const A = realpathSync(dir);
  for (const name of ["alpha-lead", "alpha-worker"]) { n.registerAgent(name); noteProject(n.store, name, A, true); }
  const rec = makeLead({ project: A, agent: "alpha-lead", host: n.host, ownerPub: owner.publicKey });
  storeLead(n, rec, signData(owner.privateKey, canonical(rec)));
  const send = (kind: Kind, needs_reply = false) =>
    n.send({ from: "boss", to: ["alpha-worker"], subject: "secret-subject", body: "secret-body", kind, needs_reply }).envelope.id;
  const read = (id: string) => n.markRead([n.message(id, "alpha-worker")!], "alpha-worker");
  const state = (id: string) => (n.store.db.prepare("SELECT state, note FROM deliveries WHERE msg_id=? AND agent='alpha-worker'").get(id) as { state: string; note: string | null });
  const alerts = () => (n.store.db.prepare("SELECT m.envelope FROM deliveries d JOIN messages m ON m.id=d.msg_id WHERE d.agent='alpha-lead'").all() as { envelope: string }[])
    .map(r => JSON.parse(r.envelope) as { kind: string; subject: string; body: string });
  return { n, send, read, state, alerts };
}

test("T765: a full read acks message, reply and status mail that asks for nothing; work and needs_reply mail stay read", (t) => {
  const { n, send, read, state } = world(t);
  const info = (["message", "reply", "status"] as const).map((k) => send(k));
  const work = [send("request"), send("task"), send("message", true)];
  for (const id of [...info, ...work]) read(id);
  for (const id of info) assert.deepEqual({ ...state(id) }, { state: "acked", note: "auto: read" });
  for (const id of work) assert.equal(state(id).state, "read");
  assert.ok(n.store.db.prepare("SELECT 1 FROM audit WHERE event='auto_ack'").get(), "audited");
});

test("T765: metadata reads never auto-ack", (t) => {
  const { n, send, state } = world(t);
  const id = send("status");
  n.markRead([{ id }], "alpha-worker", { mode: "metadata" });
  assert.equal(state(id).state, "read");
  sweepUnanswered(n);
  assert.equal(state(id).state, "read", "nor does the sweep close a peeked-at copy");
});

test("T765: the reminder names work read 30+ min ago once per window, and stops once replied to", (t) => {
  const { n, send, read } = world(t);
  const id = send("request");
  read(id);
  const now = Date.now();
  assert.equal(unansweredReminder(n, "alpha-worker", "s1", now), null, "not due yet");
  const line = unansweredReminder(n, "alpha-worker", "s1", now + REMIND_AFTER_MS + 1);
  assert.match(line ?? "", new RegExp(id));
  assert.ok(!line!.includes("secret"), "ids only");
  assert.equal(unansweredReminder(n, "alpha-worker", "s1", now + REMIND_AFTER_MS + 2), null, "throttled per session");
  n.send({ from: "alpha-worker", to: ["boss"], subject: "re", body: "done", kind: "reply", reply_to: id });
  assert.equal(unansweredReminder(n, "alpha-worker", "s2", now + REMIND_AFTER_MS + 3), null, "a reply answers it");
});

test("T765: the sweep closes informational backlog and alerts the lead once per message after 2 h", (t) => {
  const { n, send, state, alerts } = world(t);
  const status = send("status"), req = send("request");
  // A read made by a path that does not auto-ack (an older connector): the sweep closes it.
  for (const id of [status, req]) n.setDelivery(id, "alpha-worker", "read");
  const later = Date.now() + ALERT_AFTER_MS + 1;
  assert.deepEqual(sweepUnanswered(n, later), ["alpha-worker"]);
  assert.equal(state(status).state, "acked");
  assert.deepEqual({ ...state(req) }, { state: "read", note: "unanswered" }, "the sender's receipt shows it");
  const [a] = alerts();
  assert.equal(a.kind, "alert");
  assert.match(a.body, new RegExp(req));
  assert.ok(!a.body.includes("secret-subject") && !a.body.includes("secret-body"));
  assert.deepEqual(sweepUnanswered(n, later + 60_000), [], "each message alerts once");
  assert.equal(alerts().length, 1);
});

test("T765: the lead's own unanswered mail alerts no one", (t) => {
  const { n, alerts } = world(t);
  const id = n.send({ from: "boss", to: ["alpha-lead"], subject: "s", body: "b", kind: "request" }).envelope.id;
  n.setDelivery(id, "alpha-lead", "read");
  assert.deepEqual(sweepUnanswered(n, Date.now() + ALERT_AFTER_MS + 1), []);
  assert.equal(alerts().filter((a) => a.subject.startsWith("Unanswered")).length, 0);
});
