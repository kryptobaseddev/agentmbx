// T659: an OpenCode session whose MCP was evicted (about hourly, upstream) has no lease holder, so no wake target.
// The plugin poller inside its standalone serve is the target; the shared service, a wrong pid or a dead serve get none.
import { sendLeased } from "./helpers/leased-send.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MbxNode } from "../src/node.ts";
import { dispatchWakes } from "../src/wake.ts";
import { opencodeHostSeams } from "../src/opencode-provider.ts";
import { pollerTargetLive, pollerWakeTargets } from "../src/opencode-poller.ts";
import { completeOpencodeWake, listOpencodeWakeWaiters, resetOpencodeWakeQueue, waitForOpencodeWake } from "../src/opencode-wake-queue.ts";
import { IdentityLeases, inspectLeaseProcess } from "../src/identity-leases.ts";
import { fingerprint, generateKeyPair } from "../src/crypto.ts";
import { delegateWake } from "./helpers/wake-lease.ts";

const STANDALONE = ["/Users/x/.opencode/bin/opencode", "serve", "--stdio", "--port", "0"];
const SERVICE = ["/Users/x/.opencode/bin/opencode", "serve", "--service"];
const SESSION = "ses_idle";

/** A bound standalone OpenCode row for this process, with no lease at all (the MCP was evicted). */
function evicted(t: { after: (fn: () => void) => unknown }, argv: string[] = STANDALONE) {
  const home = mkdtempSync(join(tmpdir(), "mbx-t659-")), n = new MbxNode(home, { host: "alpha" });
  const real = opencodeHostSeams.args, prevDesk = process.env.MBX_NO_DESKTOP;
  opencodeHostSeams.args = (pids) => new Map(pids.map(p => [p, argv]));
  process.env.MBX_NO_DESKTOP = "1";
  t.after(() => { opencodeHostSeams.args = real; if (prevDesk === undefined) delete process.env.MBX_NO_DESKTOP; else process.env.MBX_NO_DESKTOP = prevDesk;
    n.close(); resetOpencodeWakeQueue(); rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
  // A hook bind of the serve's own pid, exactly as the plugin's bind wrote it before the MCP was evicted.
  n.bindSession({ agent: "worker", cli: "opencode", session_id: SESSION, pid: process.pid });
  delegateWake(n, "worker");
  assert.equal(n.store.db.prepare("SELECT 1 FROM identity_leases WHERE name=?").get("worker"), undefined, "the fixture has no lease");
  return n;
}

const delivery = (n: MbxNode, id: string) => n.store.db.prepare("SELECT state,note FROM deliveries WHERE msg_id=? AND agent='worker'").get(id) as { state: string; note: string | null };
const attempts = (n: MbxNode) => (n.store.db.prepare("SELECT count(*) n FROM audit WHERE event='wake.attempt'").get() as { n: number }).n;
const pollerTargets = (n: MbxNode) => pollerWakeTargets(n, "worker", n.sessionsFor("worker")).length;
const releaseLease = (n: MbxNode, agent: string, token: string) => new IdentityLeases(n.store).release(agent, token);
const stateOf = (n: MbxNode, id: string) => delivery(n, id).state;

test("T659: an evicted MCP with a live standalone poller is woken, with ids only", async t => {
  const n = evicted(t);
  const sent = sendLeased(n, { from: "sender", to: ["worker"], subject: "subject here", body: "private body", kind: "request" });
  const poll = waitForOpencodeWake(SESSION, process.pid, 2_000);
  const dispatched = dispatchWakes(n);
  const text = await poll;
  assert.ok(text, "the poller received the wake");
  assert.match(text, /\[mbx\] 1 new message\(s\) for worker/);
  assert.ok(text.includes(sent.envelope.id), "the wake names the ids");
  assert.equal(text.includes("private body"), false, "a wake never carries message content");
  assert.equal(completeOpencodeWake(SESSION, "msg_plugin"), true); // the real plugin's receipt
  const out = await dispatched;
  assert.equal(out[0]?.result.ok, true);
  assert.equal(out[0]?.result.outcome?.kind === "admitted" && out[0].result.outcome.receipt.nativeId, "msg_plugin");
  assert.equal(delivery(n, sent.envelope.id).state, "notified", "only an admitted wake settles the delivery");
  const attempt = n.store.db.prepare("SELECT detail FROM audit WHERE event='wake.attempt'").get() as { detail: string };
  assert.match(attempt.detail, /"outcome":"admitted"/);
  assert.match(attempt.detail, /ses_idle/);
});

test("T659: the shared service is never a poller target", t => {
  const n = evicted(t, SERVICE);
  assert.deepEqual(pollerWakeTargets(n, "worker", n.sessionsFor("worker")), []);
  assert.equal(pollerTargetLive(n, n.sessionsFor("worker")[0]), false);
});

test("T659: a poller for a different pid than the bound row is not a target", async t => {
  const n = evicted(t);
  const other = waitForOpencodeWake(SESSION, process.pid + 1, 500);
  assert.equal(pollerWakeTargets(n, "worker", n.sessionsFor("worker")).length, 0, "the poller's pid must equal the row's pid");
  assert.deepEqual(listOpencodeWakeWaiters().map(w => w.pid), [process.pid + 1]);
  resetOpencodeWakeQueue();
  await other;
});

test("T659: a live lease held by another session means no poller wake", async t => {
  const n = evicted(t);
  const claim = (sessionId: string) => new IdentityLeases(n.store).claim("worker", { pid: process.pid,
    start: inspectLeaseProcess(process.pid).start!, keyFp: fingerprint(generateKeyPair().publicKey), cli: "opencode", sessionId });
  const lease = claim("ses_elsewhere");
  const poll = waitForOpencodeWake(SESSION, process.pid, 1_000);
  assert.equal(pollerTargets(n), 0, "the current lease names another session");
  const sent = sendLeased(n, { from: "sender", to: ["worker"], subject: "urgent", body: "x", kind: "request" });
  const out = await dispatchWakes(n);
  assert.equal(attempts(n), 0, "a stale row must not be woken while the agent's lease names another session");
  assert.equal(out[0]?.result.ok, false);
  assert.equal(n.unreadCount("worker"), 1, "the mail is untouched");
  releaseLease(n, "worker", lease.token);
  assert.equal(pollerTargets(n), 1, "a released lease leaves the poller as the target again");
  assert.equal(stateOf(n, sent.envelope.id), "notified", "nothing was handed to a serve while the lease named another session");
  resetOpencodeWakeQueue();
  await poll;
});

test("T659: no poller means no wake attempt, and the ordinary notice path applies", async t => {
  const n = evicted(t);
  const sent = sendLeased(n, { from: "sender", to: ["worker"], subject: "urgent", body: "x", kind: "request" });
  // No poller is registered at all: that serve is gone, so no wake may be attempted for it.
  const out = await dispatchWakes(n);
  assert.equal(out[0]?.result.ok, false);
  assert.equal(attempts(n), 0, "no wake may be attempted without a live serve");
  assert.deepEqual({ ...delivery(n, sent.envelope.id) }, { state: "notified", note: "desktop" }, "the agent's mail is not consumed: it stays unread for the next pass or rebind");
  assert.equal(n.unreadCount("worker"), 1);
});
