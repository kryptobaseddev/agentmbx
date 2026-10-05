// T386: a watcher-delivered session whose watcher is not live at the instant of sending still gets
// the wake (the dispatcher admits it within ~22ms; the record outlives a between-fires tick and a
// terminal kimi re-arms its watcher at turn end, T348) — the send receipt must say ELIGIBLE FOR
// WAKE, not "no push path". Sessions with no watcher evidence at all keep the "no push path"
// reason, and a binding the dispatcher would reject is never reported as live-wake (T376's guard).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateKeyPair } from "../src/crypto.ts";
import { IdentityLeases, inspectLeaseProcess } from "../src/identity-leases.ts";
import { GROK_NO_PUSH, MbxNode } from "../src/node.ts";
import { recipientReceipts } from "../src/receipts.ts";
import { liveWatcher, watcherKey } from "../src/wake.ts";
import { bindWakeLease } from "./helpers/wake-lease.ts";
import { sendLeased } from "./helpers/leased-send.ts";

const ELIGIBLE = /eligible for wake \(mbx watcher: its exit starts your next turn\); watcher re-arm pending, dispatcher admission pending/;

function world(t: { after: (fn: () => void) => void }) {
  const home = mkdtempSync(join(tmpdir(), "mbx-watcher-receipt-"));
  const n = new MbxNode(home, { host: "alpha" });
  t.after(() => { n.close(); rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
  const send = (to: string) =>
    sendLeased(n, { from: "boss", to: [to], subject: "wake", body: "now", needs_reply: true });
  const receipt = (to: string) => {
    const r = send(to);
    return recipientReceipts(n, r.envelope.id, r.targets).find((x) => x.to === to)!;
  };
  return { n, receipt };
}

test("AC1: a stale watcher record (watcher between fires) reports eligible for wake, not no push path", (t) => {
  const { n, receipt } = world(t);
  bindWakeLease(n, { agent: "worker", cli: "kimi", session_id: "term-1", pid: process.pid });
  // the record outlives the watcher's freshness window: armed, but not live at this instant
  n.store.set(watcherKey("worker"), JSON.stringify({ pid: process.pid, at: Date.now() - 60_000 }));
  assert.equal(liveWatcher(n, "worker"), false, "fixture: the watcher is not live at this instant");
  assert.match(n.deliveryMode("worker"), /^no push:/, "a stale record reads as no-push to deliveryMode");
  const r = receipt("worker");
  assert.equal(r.state, "live-wake");
  assert.match(r.detail, ELIGIBLE);
  assert.doesNotMatch(r.detail, /no push path|seen on its next prompt/);
});

test("AC1: a terminal kimi session in the watcher re-arm gap (no record yet) reports eligible for wake", (t) => {
  const { n, receipt } = world(t);
  bindWakeLease(n, { agent: "worker", cli: "kimi", session_id: "term-1", pid: process.pid });
  assert.equal(liveWatcher(n, "worker"), false, "fixture: no watcher is live");
  assert.match(n.deliveryMode("worker"), /^no push:/, "terminal kimi without a watcher has no live push mode");
  const r = receipt("worker");
  assert.equal(r.state, "live-wake");
  assert.match(r.detail, ELIGIBLE);
  assert.doesNotMatch(r.detail, /no push path|seen on its next prompt/);
});

test("a live watcher keeps the standard eligible wording (unchanged path)", (t) => {
  const { n, receipt } = world(t);
  bindWakeLease(n, { agent: "worker", cli: "kimi", session_id: "term-1", pid: process.pid });
  n.store.set(watcherKey("worker"), JSON.stringify({ pid: process.pid, at: Date.now() }));
  assert.ok(liveWatcher(n, "worker"), "fixture: the watcher is live");
  const r = receipt("worker");
  assert.equal(r.state, "live-wake");
  assert.match(r.detail, /eligible for wake \(push \(mbx watcher: its exit starts your next turn\)\); dispatcher admission pending/);
  assert.doesNotMatch(r.detail, /re-arm pending/);
});

test("AC2: a session with no watcher configured at all still reports live-next-prompt with a reason", (t) => {
  const { n, receipt } = world(t);
  bindWakeLease(n, { agent: "worker", cli: "claude", session_id: "thread-1", pid: process.pid });
  assert.equal(liveWatcher(n, "worker"), false);
  assert.match(n.deliveryMode("worker"), /^no push:/);
  const r = receipt("worker");
  assert.equal(r.state, "live-next-prompt");
  assert.match(r.detail, /seen on its next prompt: the session has no push path/);
  assert.doesNotMatch(r.detail, /re-arm pending/);
});

test("T435: a lapsed grok session with a stale watcher key stays live-next-prompt", (t) => {
  const { n, receipt } = world(t);
  bindWakeLease(n, { agent: "worker", cli: "grok", session_id: "grok-1", pid: process.pid });
  n.store.set(watcherKey("worker"), JSON.stringify({ pid: process.pid, at: Date.now() - 60_000 }));
  assert.equal(liveWatcher(n, "worker"), false, "fixture: the watcher is not live at this instant");
  assert.equal(n.deliveryMode("worker"), GROK_NO_PUSH);
  const r = receipt("worker");
  assert.equal(r.state, "live-next-prompt");
  assert.match(r.detail, /post-tool and Stop hooks/);
  assert.equal(r.detail.endsWith(GROK_NO_PUSH), true, r.detail);
  assert.doesNotMatch(r.detail, /re-arm pending/);
});

test("a claude session with a stale watcher key still reports re-arm pending", (t) => {
  const { n, receipt } = world(t);
  bindWakeLease(n, { agent: "worker", cli: "claude", session_id: "thread-1", pid: process.pid });
  n.store.set(watcherKey("worker"), JSON.stringify({ pid: process.pid, at: Date.now() - 60_000 }));
  assert.equal(liveWatcher(n, "worker"), false);
  const r = receipt("worker");
  assert.equal(r.state, "live-wake");
  assert.match(r.detail, ELIGIBLE);
});

test("T376 guard kept: an unverifiable binding with a stale watcher record is never live-wake", (t) => {
  const { n, receipt } = world(t);
  // a real lease and binding, but no published identity control: captureWakeIdentity cannot verify it
  const key = generateKeyPair();
  new IdentityLeases(n.store).claim("worker", { pid: process.pid, start: inspectLeaseProcess(process.pid).start!,
    keyFp: "aaaa-bbbb-cccc-dddd", cli: "kimi", sessionId: "term-1" });
  n.bindSession({ agent: "worker", cli: "kimi", session_id: "term-1", pid: process.pid, session_key: key.publicKey });
  n.store.set(watcherKey("worker"), JSON.stringify({ pid: process.pid, at: Date.now() - 60_000 }));
  const r = receipt("worker");
  assert.equal(r.state, "live-next-prompt");
  assert.match(r.detail, /the current lease or session binding could not be verified/);
  assert.doesNotMatch(r.detail, /live-wake|eligible for wake|re-arm pending/);
});
