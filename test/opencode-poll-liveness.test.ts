// T676 (from T583): a shared OpenCode process can't show a conversation's liveness through its MCP heartbeat, and the plugin's
// post-tool fast path skips the hook spawn whenever no new mail arrived. So a conversation working for more than SHARED_IDLE_MS
// without an mbx call looked idle: receipts said it "may have ended", and an explicit claim could take its identity. The tab's
// plugin long-polls the daemon's wake queue for its session every 20 s or less while it lives; the daemon now counts that poll
// as the agent's activity, throttled, and only with the T659 proof (session row, standalone serve pid and birth, current lease
// for this session), so a stray poll can't keep a dead identity "live".
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import type { Server as HttpServer } from "node:http";
import { MbxNode } from "../src/node.ts";
import { POLL_ACTIVITY_MS, recordPollActivity, startServer } from "../src/http.ts";
import { opencodeHostSeams } from "../src/opencode-provider.ts";
import { resetOpencodeWakeQueue } from "../src/opencode-wake-queue.ts";
import { activityKey, identityAvailability, parseActivity, SHARED_IDLE_MS } from "../src/identity-availability.ts";
import { IdentityLeases, type IdentityLease } from "../src/identity-leases.ts";
import { mailboxLiveness, OPENCODE_MIDTURN_NOTE } from "../src/receipts.ts";
import { bindWakeLease } from "./helpers/wake-lease.ts";

const closeServer = (s: HttpServer) => new Promise<void>((r) => { s.closeAllConnections?.(); s.close(() => r()); });
const MIN = 60_000;

async function rig(t: { after: (fn: () => unknown) => void }, sid = "ses_live", argv = ["/usr/local/bin/opencode", "--standalone"]) {
  resetOpencodeWakeQueue();
  const home = mkdtempSync(join(tmpdir(), "mbx-t676-"));
  const node = new MbxNode(home, { host: "alpha" });
  const server = await startServer(node, 0, "127.0.0.1");
  const port = (server.address() as AddressInfo).port, real = opencodeHostSeams.args;
  opencodeHostSeams.args = () => new Map([[process.pid, argv]]);
  t.after(async () => { opencodeHostSeams.args = real; resetOpencodeWakeQueue(); await closeServer(server); node.close();
    rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); });
  bindWakeLease(node, { agent: "worker", cli: "opencode", session_id: sid, pid: process.pid });
  const quiet = (at: number) => node.store.set(activityKey("worker"), JSON.stringify({ at, shared: true }));
  const activity = () => parseActivity(node.store.get(activityKey("worker")));
  const lease = () => node.store.db.prepare("SELECT * FROM identity_leases WHERE name='worker'").get() as unknown as IdentityLease;
  /** What another conversation's explicit claim of `worker` would be told, judged at `now`. */
  const claim = (now: number) => identityAvailability({ lease: lease(), evidence: new IdentityLeases(node.store).processEvidence(lease().holder_pid),
    activity: activity(), now, caller: { cli: "opencode", sessionId: "ses_other" } });
  /** One real long-poll start from this (session, pid); aborted right away (the record is taken when the poll starts). */
  const poll = async (session = sid, pid = process.pid) => {
    const ctl = new AbortController();
    const req = fetch(`http://127.0.0.1:${port}/v1/opencode-wake?session=${encodeURIComponent(session)}&pid=${pid}`, { signal: ctl.signal }).catch(() => null);
    await new Promise((r) => setTimeout(r, 80));
    ctl.abort(); await req;
  };
  return { node, quiet, activity, claim, poll, lease };
}

test("T676: a working tab's wake poll keeps its identity from looking idle: takeover refused while it polls, allowed once it stops", async (t) => {
  const r = await rig(t);
  const start = Date.now();
  r.quiet(start - 15 * MIN); // no mbx call or hook for 15 minutes (the post-tool fast path spawns nothing)
  const before = r.claim(start);
  assert.equal(before.claimable, true, before.reason);
  assert.equal(before.takeover, "idle-conversation", "the gap: a live, working conversation was claimable");
  assert.match(mailboxLiveness(r.node, "worker", start).detail, /may have ended \(no hook or wake-poll activity either\)/);

  await r.poll();
  const a = r.activity()!;
  assert.ok(a.at >= start, "the poll counted as activity");
  assert.equal(a.shared, true, "shared is kept");
  const live = r.claim(Date.now());
  assert.equal(live.claimable, false, live.reason);
  assert.equal(live.state, "live");
  assert.doesNotMatch(mailboxLiveness(r.node, "worker").detail, /may have ended/);

  // the tab closes: no more polls. After SHARED_IDLE_MS the conversation is claimable again.
  const later = a.at + SHARED_IDLE_MS + MIN;
  assert.equal(r.claim(later).claimable, true);
  assert.equal(r.claim(later).takeover, "idle-conversation");
});

test("T676: the poll record is throttled per (session, pid) and never moves activity backwards", async (t) => {
  const r = await rig(t, "ses_throttle");
  const t0 = Date.now() + 10 * MIN; // a fresh key for this module-level throttle
  r.quiet(t0 - 15 * MIN);
  assert.equal(recordPollActivity(r.node, "ses_throttle", process.pid, t0), true);
  r.quiet(t0 - 15 * MIN);
  assert.equal(recordPollActivity(r.node, "ses_throttle", process.pid, t0 + POLL_ACTIVITY_MS - 1), false, "inside the throttle window");
  assert.equal(r.activity()!.at, t0 - 15 * MIN);
  assert.equal(recordPollActivity(r.node, "ses_throttle", process.pid, t0 + POLL_ACTIVITY_MS), true, "the next window records again");
  r.quiet(t0 + 100 * MIN); // newer activity from an mbx call
  assert.equal(recordPollActivity(r.node, "ses_throttle", process.pid, t0 + 2 * POLL_ACTIVITY_MS), false);
  assert.equal(r.activity()!.at, t0 + 100 * MIN, "never backwards");
});

test("T676: a stray or stale poll proves nothing (wrong pid, unknown session, lease for another session or released, shared service)", async (t) => {
  const r = await rig(t, "ses_proof");
  const stale = Date.now() - 15 * MIN;
  let clock = Date.now() + 20 * MIN; // each probe uses its own throttle window
  const tryPoll = (session: string, pid: number) => { r.quiet(stale); clock += POLL_ACTIVITY_MS; recordPollActivity(r.node, session, pid, clock); return r.activity()!.at; };
  assert.equal(tryPoll("ses_proof", 2 ** 22 + 77), stale, "a pid that is not the row's serve");
  assert.equal(tryPoll("ses_nobody", process.pid), stale, "no session row");
  r.node.store.db.prepare("UPDATE identity_leases SET session_id='ses_moved' WHERE name='worker'").run();
  assert.equal(tryPoll("ses_proof", process.pid), stale, "the lease is held for another session");
  r.node.store.db.prepare("UPDATE identity_leases SET session_id='ses_proof', released_at=? WHERE name='worker'").run(Date.now());
  assert.equal(tryPoll("ses_proof", process.pid), stale, "a released lease");
  r.node.store.db.prepare("UPDATE identity_leases SET released_at=NULL WHERE name='worker'").run();
  assert.notEqual(tryPoll("ses_proof", process.pid), stale, "control: the full proof records");
  opencodeHostSeams.args = () => new Map([[process.pid, ["/usr/local/bin/opencode", "serve", "--service"]]]);
  assert.equal(tryPoll("ses_proof", process.pid), stale, "the shared service is never a standalone serve");
});

test("T676: receipts wording: the quiet detail names every activity source; the OpenCode mid-turn note matches the busy-decline wake", () => {
  assert.equal(OPENCODE_MIDTURN_NOTE, "an OpenCode session in the middle of a turn sees it with its next tool result; the wake follows once that turn ends, if the mail is still unhandled");
});
