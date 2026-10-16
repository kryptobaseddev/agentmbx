// T672: slots are per (session, pid), so a receipt belongs to one serve. A receipt that names its pid settles only that
// serve's offer; without a pid it settles only the single outstanding offer, never one of two. The second fixture runs
// the poller-target path (no lease) through a real dispatch, so a mid-turn decline there keeps the mail delivered.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MbxNode } from "../src/node.ts";
import {
  completeOpencodeWake, listOpencodeWakeWaiters, OPENCODE_WAKE_BUSY, pushOpencodeWake, resetOpencodeWakeQueue, waitForOpencodeWake,
} from "../src/opencode-wake-queue.ts";
import { opencodeHostSeams } from "../src/opencode-provider.ts";
import { dispatchWakes } from "../src/wake.ts";
import { sendLeased } from "./helpers/leased-send.ts";
import { delegateWake } from "./helpers/wake-lease.ts";

const SESSION = "ses_two_serves", A = 7001, B = 7002;

test("T672: a receipt settles its own serve's offer and never the other's", async () => {
  resetOpencodeWakeQueue();
  try {
    // Two serves poll the same session; the daemon offers each of them a wake (offers are per (session, pid)).
    const pollA = waitForOpencodeWake(SESSION, A, 2_000), pollB = waitForOpencodeWake(SESSION, B, 2_000);
    assert.deepEqual(listOpencodeWakeWaiters().map((w) => w.pid).sort(), [A, B]);
    const pushA = pushOpencodeWake(SESSION, A, "for A", 2_000);
    const pushB = pushOpencodeWake(SESSION, B, "for B", 2_000);
    assert.equal(await pollA, "for A");
    assert.equal(await pollB, "for B");
    // B's receipt, naming B, must not settle A's offer.
    assert.equal(completeOpencodeWake(SESSION, "msg_from_b", null, B), true);
    assert.deepEqual(await pushB, { ok: true, id: "msg_from_b", turnSince: null });
    assert.equal(completeOpencodeWake(SESSION, "msg_second_b", null, B), false, "B's offer is spent");
    // A's offer is still outstanding, and a pid-less receipt now has one candidate again.
    assert.equal(completeOpencodeWake(SESSION, "msg_from_a", null, A), true);
    assert.deepEqual(await pushA, { ok: true, id: "msg_from_a", turnSince: null });
    assert.equal(completeOpencodeWake(SESSION, "msg_late", null, A), false);
  } finally { resetOpencodeWakeQueue(); }
});

test("T672: a pid-less receipt settles nothing while two serves have offers outstanding", async () => {
  resetOpencodeWakeQueue();
  try {
    const pollA = waitForOpencodeWake(SESSION, A, 2_000), pollB = waitForOpencodeWake(SESSION, B, 2_000);
    const pushA = pushOpencodeWake(SESSION, A, "for A", 200), pushB = pushOpencodeWake(SESSION, B, "for B", 200);
    assert.equal(await pollA, "for A");
    assert.equal(await pollB, "for B");
    assert.equal(completeOpencodeWake(SESSION, "msg_ambiguous"), false, "two outstanding offers: the receipt names no serve");
    assert.equal(completeOpencodeWake(SESSION, "msg_wrong_pid", null, A + 99), false, "an unoffered pid settles nothing");
    assert.equal(completeOpencodeWake(SESSION, OPENCODE_WAKE_BUSY, null, A), true, "a busy decline names its own serve");
    assert.deepEqual(await pushA, { ok: false, handedOff: false, busy: true });
    // B was untouched by A's decline and still settles normally.
    assert.equal(completeOpencodeWake(SESSION, "msg_from_b", null, B), true);
    assert.deepEqual(await pushB, { ok: true, id: "msg_from_b", turnSince: null });
  } finally { resetOpencodeWakeQueue(); }
});

test("T672: the poller-target path (no lease) keeps the mail delivered when the plugin declines mid-turn", async (t) => {
  resetOpencodeWakeQueue();
  const home = mkdtempSync(join(tmpdir(), "mbx-t672-")), n = new MbxNode(home, { host: "alpha" });
  const realArgs = opencodeHostSeams.args, prevDesk = process.env.MBX_NO_DESKTOP;
  opencodeHostSeams.args = (pids) => new Map(pids.map((p) => [p, ["/Users/x/.opencode/bin/opencode", "serve", "--stdio", "--port", "0"]]));
  process.env.MBX_NO_DESKTOP = "1";
  t.after(() => { opencodeHostSeams.args = realArgs; if (prevDesk === undefined) delete process.env.MBX_NO_DESKTOP; else process.env.MBX_NO_DESKTOP = prevDesk;
    n.close(); resetOpencodeWakeQueue(); rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
  n.bindSession({ agent: "worker", cli: "opencode", session_id: SESSION, pid: process.pid }); // no lease: the MCP was evicted
  delegateWake(n, "worker");
  const sent = sendLeased(n, { from: "sender", to: ["worker"], subject: "urgent", body: "x", kind: "request" });
  const state = () => (n.store.db.prepare("SELECT state FROM deliveries WHERE msg_id=? AND agent='worker'").get(sent.envelope.id) as { state: string }).state;
  const poll = waitForOpencodeWake(SESSION, process.pid, 2_000);
  const dispatched = dispatchWakes(n);
  const offered = await poll;
  assert.match(offered ?? "", /^\[mbx\] 1 new message\(s\) for worker from sender@alpha/, "the wake was offered to the serve's poller");
  assert.ok((offered ?? "").includes(sent.envelope.id), "and it names the message");
  assert.equal(completeOpencodeWake(SESSION, OPENCODE_WAKE_BUSY, null, process.pid), true, "the plugin declines mid-turn");
  const out = await dispatched;
  const result = out[0]?.result as { ok: boolean; retry?: boolean; outcome?: { kind?: string } };
  assert.equal(result.ok, false);
  assert.equal(result.outcome?.kind, "busy");
  assert.equal(result.retry, true, "busy is a retry");
  assert.equal(state(), "delivered", "a declined offer leaves the mail delivered for the next pass");
  assert.equal(n.unreadCount("worker"), 1);
});
