import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MbxNode } from "../src/node.ts";
import { signEnvelope, type Envelope } from "../src/envelope.ts";
import { configuredLoopDetector, detectConversationLoops, reportConversationLoops } from "../src/loop-detector.ts";
import { conversationLoopChecks } from "../src/doctor.ts";
import { sendLeased } from "./helpers/leased-send.ts";

process.env.MBX_NO_DESKTOP = "1";
function fixture(t: TestContext, config?: { message_threshold: number; window_minutes: number }) {
  const home = mkdtempSync(join(tmpdir(), "mbx-loops-")), n = new MbxNode(home, { host: "alpha", loop_detector: config });
  t.after(() => { n.close(); rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
  let thread: string | undefined;
  const send = (reverse = false, extra: { origin?: "external"; unverifiedSender?: boolean } = {}) => {
    const from = reverse ? "bob" : "ada", to = reverse ? "ada" : "bob";
    const e = sendLeased(n, { from, to: [to, `${to}@alpha`], subject: "work", body: "private contents", kind: "request", thread, ...extra }).envelope;
    thread ??= e.thread; return e;
  };
  return { n, send };
}
const state = (n: MbxNode) => ({ deliveries: n.store.db.prepare("SELECT * FROM deliveries ORDER BY msg_id,agent").all(),
  wakes: n.store.db.prepare("SELECT * FROM wakes").all(), kv: n.store.db.prepare("SELECT * FROM kv ORDER BY k").all() });

test("default detector needs more than 50 distinct messages in both directions, counts duplicate recipients once and doctor is read-only", t => {
  const { n, send } = fixture(t);
  for (let i = 0; i < 50; i++) send(i % 2 === 0);
  assert.deepEqual(detectConversationLoops(n), []);
  send();
  const before = state(n), loops = detectConversationLoops(n);
  assert.equal(loops.length, 1); assert.equal(loops[0].count, 51); assert.deepEqual(loops[0].directions, [26, 25]);
  assert.deepEqual(loops[0].agents, ["ada@alpha", "bob@alpha"]);
  const checks = conversationLoopChecks(n);
  assert.equal(checks[0].level, "warn"); assert.match(checks[0].label, /51 messages.*delivery and wakes continue/);
  assert.doesNotMatch(checks[0].label, /private contents/); assert.deepEqual(state(n), before);
});

test("configured thresholds/window use local receipt time, exclude forged/unverified mail and do not confuse one-way volume with an exchange", t => {
  const { n, send } = fixture(t, { message_threshold: 2, window_minutes: 1 });
  send(); send(); send(); assert.deepEqual(detectConversationLoops(n), []);
  const old = send(true), now = Date.now() + 5_000;
  n.store.db.prepare("UPDATE messages SET received_at=? WHERE id=?").run(new Date(now - 60_000).toISOString(), old.id);
  assert.deepEqual(detectConversationLoops(n, now), [], "the lower window boundary is excluded");
  const unverified = send(true, { unverifiedSender: true });
  assert.deepEqual(detectConversationLoops(n, now), []);
  const forged = send(true);
  n.store.db.prepare("UPDATE messages SET envelope=json_set(envelope,'$.body','forged') WHERE id=?").run(forged.id);
  assert.deepEqual(detectConversationLoops(n, now), []);
  const verified = send(true, { origin: "external" });
  // An old/future sender clock is irrelevant to local receipt ordering. Re-sign in the isolated fixture.
  const skewed = signEnvelope({ ...verified, ts: "2099-01-01T00:00:00.000Z" }, n.host, n.key.publicKey, n.key.privateKey);
  n.store.db.prepare("UPDATE messages SET envelope=?,ts=? WHERE id=?").run(JSON.stringify(skewed), skewed.ts, verified.id);
  const loop = detectConversationLoops(n, now)[0]; assert.equal(loop.count, 4);
  assert.equal(n.unreadCount("ada"), 4); assert.equal(n.unreadCount("bob"), 3, "all mail stays delivered, including unverified and forged fixtures");
  n.ack(unverified.id, "ada");
  assert.equal(detectConversationLoops(n, now)[0].count, 4, "ACKs do not rewrite the observation");
  assert.throws(() => configuredLoopDetector({ loop_detector: { message_threshold: 0 } }));
  assert.equal(conversationLoopChecks(Object.assign(n, { config: { ...n.config, loop_detector: { window_minutes: -1 } } }))[0].level, "warn");
});

test("owner authority and different threads cannot create an automated pair report", t => {
  const { n, send } = fixture(t, { message_threshold: 1, window_minutes: 10 });
  send();
  const e = send(true);
  const otherThread = signEnvelope({ ...e, thread: "another-thread" }, n.host, n.key.publicKey, n.key.privateKey);
  n.store.db.prepare("UPDATE messages SET thread=?,envelope=? WHERE id=?").run(otherThread.thread, JSON.stringify(otherThread), e.id);
  assert.deepEqual(detectConversationLoops(n), []);
  const owner = send(true);
  const manual = signEnvelope({ ...owner, authority: { owner_sig: "untrusted-claim", owner_fp: "owner" } }, n.host, n.key.publicKey, n.key.privateKey);
  n.store.db.prepare("UPDATE messages SET envelope=? WHERE id=?").run(JSON.stringify(manual), owner.id);
  assert.deepEqual(detectConversationLoops(n), []);
});

test("notification reporting deduplicates concurrent ticks, retries failure and never consumes delivery/wake state", async t => {
  const { n, send } = fixture(t, { message_threshold: 2, window_minutes: 10 });
  send(); send(true); send();
  const before = state(n), now = Date.now() + 10;
  let calls = 0, release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const first = reportConversationLoops(n, { now, notify: async () => { calls++; await held; return { ok: true }; } });
  assert.deepEqual(await reportConversationLoops(n, { now, notify: async () => { calls++; return { ok: true }; } }), []);
  assert.equal(calls, 1); release(); assert.equal((await first).length, 1);
  assert.deepEqual(await reportConversationLoops(n, { now: now + 60_000, notify: async () => { calls++; return { ok: true }; } }), []);
  assert.equal(calls, 1);
  assert.deepEqual(state(n).deliveries, before.deliveries); assert.deepEqual(state(n).wakes, before.wakes);
  assert.equal(n.takeWake("ada", "unrelated", now), null, "an observation does not reserve wake budget");
  for (const key of n.store.db.prepare("SELECT k FROM kv WHERE k LIKE 'conversation-loop:%'").all()) n.store.db.prepare("DELETE FROM kv WHERE k=?").run(key.k);
  assert.deepEqual(await reportConversationLoops(n, { now, notify: async () => { throw new Error("notifier unavailable"); } }), []);
  assert.equal((await reportConversationLoops(n, { now: now + 60_000, notify: async () => { calls++; return { ok: true }; } })).length, 1);
  assert.equal(n.unreadCount("bob"), 2); assert.equal(n.unreadCount("ada"), 1);
});
