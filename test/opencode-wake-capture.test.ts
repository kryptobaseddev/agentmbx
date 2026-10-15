// T646: a former holder's control endpoint, still live under another serve, must not fence the current holder's
// wakes; a refused capture with no notice leaves the mail delivered; doctor reports the two hosting serves.
import { sendLeased } from "./helpers/leased-send.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { bindWakeLease } from "./helpers/wake-lease.ts";
import { MbxNode } from "../src/node.ts";
import { dispatchWakes } from "../src/wake.ts";
import { findIdentityControl, publishIdentityControl } from "../src/identity-control.ts";
import { inspectLeaseProcess } from "../src/identity-leases.ts";
import { captureWakeIdentity } from "../src/wake-identity.ts";
import { findOpencodeDualHosts, opencodeDualHostChecks } from "../src/opencode-dual-host.ts";

function fixture(t: { after: (fn: () => void) => unknown }) {
  const home = mkdtempSync(join(tmpdir(), "mbx-t646-")), n = new MbxNode(home, { host: "alpha" });
  const old = process.env.MBX_NO_DESKTOP;
  process.env.MBX_NO_DESKTOP = "1";
  t.after(() => { if (old === undefined) delete process.env.MBX_NO_DESKTOP; else process.env.MBX_NO_DESKTOP = old;
    n.close(); rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
  // The holder (this process) is the MCP child of the session's serve (our parent), as an OpenCode tab's MCP is.
  bindWakeLease(n, { agent: "worker", cli: "opencode", session_id: "ses_tab", pid: process.ppid });
  return n;
}

/** What the shared service left behind: its own key and lease generation, a live process, a different parent. */
function staleServiceControl(n: MbxNode, o: { sameGeneration?: boolean } = {}) {
  const own = findIdentityControl(n.store, "opencode", "ses_tab");
  publishIdentityControl(n.store, { ...own, control_key: "e92e-9e61-c549-29bf", generation: o.sameGeneration ? own.generation : "1".repeat(64),
    mcp_pid: process.pid, mcp_start: inspectLeaseProcess(process.pid).start!, parent_pid: process.pid, parent_start: inspectLeaseProcess(process.pid).start! });
}

test("T646: a former holder's live control endpoint does not fence the current lease holder", t => {
  const n = fixture(t);
  staleServiceControl(n);
  const guard = captureWakeIdentity(n, n.sessionsFor("worker")[0]);
  assert.ok(guard, "the current holder's lease and session row are the wake authority");
  assert.equal(guard.run(() => "ran"), "ran");
  // The published endpoint is left alone: capture rebuilds authority, it never rewrites another process's record.
  assert.equal(findIdentityControl(n.store, "opencode", "ses_tab").control_key, "e92e-9e61-c549-29bf");
});

test("T646: a foreign endpoint of the same lease generation is still refused", t => {
  const n = fixture(t);
  staleServiceControl(n, { sameGeneration: true });
  assert.equal(captureWakeIdentity(n, n.sessionsFor("worker")[0]), null);
});

test("T646: a session row whose key is not the lease holder's gets no rebuilt authority", t => {
  const n = fixture(t);
  staleServiceControl(n);
  n.store.db.prepare("UPDATE sessions SET session_key='someone-else' WHERE session_id='ses_tab'").run();
  assert.equal(captureWakeIdentity(n, n.sessionsFor("worker")[0]), null);
});

test("T646: a refused capture with a skipped notice leaves the mail delivered and audits once", async t => {
  const n = fixture(t);
  const own = findIdentityControl(n.store, "opencode", "ses_tab");
  publishIdentityControl(n.store, { ...own, parent_pid: process.pid, parent_start: inspectLeaseProcess(process.pid).start! }); // own-key defect: refused
  const sent = sendLeased(n, { from: "sender", to: ["worker"], subject: "urgent", body: "x", kind: "request" });
  const saturate = () => n.store.set("desktop-notices", JSON.stringify(Array.from({ length: 6 }, () => Date.now())));
  saturate();
  const out = await dispatchWakes(n);
  assert.equal(out[0]?.result.via, "lease");
  const state = () => (n.store.db.prepare("SELECT state FROM deliveries WHERE msg_id=? AND agent='worker'").get(sent.envelope.id) as { state: string }).state;
  assert.equal(state(), "delivered");
  saturate();
  await dispatchWakes(n);
  assert.equal(state(), "delivered", "the next pass retries instead of stranding it");
  const audits = n.store.db.prepare("SELECT count(*) n FROM audit WHERE event='wake.capture_failed'").get() as { n: number };
  assert.equal(audits.n, 1);
});

test("T646: doctor reports a session bound to one serve whose endpoint another live serve published", t => {
  const n = fixture(t);
  assert.deepEqual(findOpencodeDualHosts(n, () => "standalone"), []);
  staleServiceControl(n);
  const hosts = (pid: number | null) => pid === process.pid ? "service" as const : "standalone" as const;
  const found = findOpencodeDualHosts(n, hosts);
  assert.deepEqual(found.map(x => [x.session_id, x.bound.host, x.published.host]), [["ses_tab", "standalone", "service"]]);
  const checks = opencodeDualHostChecks(n, hosts);
  assert.equal(checks.length, 1);
  assert.equal(checks[0].level, "warn");
  assert.match(checks[0].label, /two OpenCode processes have this session loaded/);
});
