// T656: a kimi lease claimed under the provisional mcp-<pid> id adopts the hook-bound real session id at the bind
// (src/node.ts bindSession), so identity_leases and sessions carry the same id the way mbx_whoami.harness_session
// already reports it. identity-status keeps the T316 "held by this session" view for a provisional caller against
// the adopted state. Nothing here touches mcp.ts (the adoption is bind-driven) or cli.ts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fingerprint, generateKeyPair } from "../src/crypto.ts";
import { findIdentityControl, identityGeneration, publishIdentityControl } from "../src/identity-control.ts";
import { captureWakeIdentity } from "../src/wake-identity.ts";
import { IdentityLeases, inspectLeaseProcess } from "../src/identity-leases.ts";
import { listIdentityStatus } from "../src/identity-status.ts";
import { MbxNode } from "../src/node.ts";

const AGENT = "t656-agent";
const REAL = "session_t656";
const PROVISIONAL = "mcp-t656";

function fixture(t: { after: (fn: () => void) => void }) {
  const home = mkdtempSync(join(tmpdir(), "mbx-t656-")), cwd = mkdtempSync(join(tmpdir(), "mbx-t656-work-"));
  const n = new MbxNode(home, { host: "alpha" });
  t.after(() => { n.close(); rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); rmSync(cwd, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
  const key = generateKeyPair(), leases = new IdentityLeases(n.store);
  const start = inspectLeaseProcess(process.pid).start!;
  const claim = (sessionId = PROVISIONAL) => leases.claim(AGENT, { pid: process.pid, start, keyFp: fingerprint(key.publicKey), cli: "kimi", sessionId });
  // The MCP server binds its provisional id (this also writes the mcp-process:<key> server record).
  const serverBind = (cli = "kimi") => n.bindSession({ agent: AGENT, cli, session_id: PROVISIONAL, cwd, pid: process.pid, session_key: key.publicKey, mcp_pid: process.pid });
  const hookBind = (cli = "kimi", session = REAL) => n.bindSession({ agent: AGENT, cli, session_id: session, cwd, pid: process.pid });
  const leaseSession = () => (n.store.db.prepare("SELECT session_id FROM identity_leases WHERE name=?").get(AGENT) as { session_id: string }).session_id;
  return { n, cwd, key, leases, claim, serverBind, hookBind, leaseSession };
}

test("T656: the kimi hook bind moves a provisional mcp-<pid> lease to the real session id, inside the bind transaction", async t => {
  const { n, claim, serverBind, hookBind, leaseSession } = fixture(t);
  claim();
  serverBind();
  assert.equal(leaseSession(), PROVISIONAL);
  hookBind();
  assert.equal(leaseSession(), REAL, "the lease row now carries the hook-bound real session id");
  const moved = n.store.db.prepare("SELECT at,event,detail FROM audit WHERE event='identity.session-moved' ORDER BY at").all() as { detail: string }[];
  assert.equal(moved.length, 1);
  assert.match(moved[0]!.detail, new RegExp(`"from":"${PROVISIONAL}"|"from":\\s*"${PROVISIONAL}"`));
  assert.match(moved[0]!.detail, /session_t656/);
  hookBind("kimi", "session_t656-again");
  assert.equal(leaseSession(), REAL, "after the adoption the lease is no longer provisional: a later bind is a no-op");
  assert.equal((n.store.db.prepare("SELECT count(*) n FROM audit WHERE event='identity.session-moved'").get() as { n: number }).n, 1, "exactly one move is recorded");
});

test("T656: a foreign server record, a released lease and a non-kimi bind never rewrite the lease", async t => {
  const { n, cwd, key, claim, serverBind, hookBind, leaseSession } = fixture(t);
  claim();
  serverBind();
  // the binding's server record names another process: the lease holder does not match
  n.store.set(`mcp-process:${key.publicKey}`, JSON.stringify({ pid: 2 ** 22 + 7, start: "not-this-process" }));
  hookBind();
  assert.equal(leaseSession(), PROVISIONAL, "a foreign server record rewrites nothing");

  const f2 = fixture(t);
  f2.claim();
  f2.serverBind();
  f2.leases.release(AGENT, (f2.n.store.db.prepare("SELECT token FROM identity_leases WHERE name=?").get(AGENT) as { token: string }).token);
  f2.hookBind();
  assert.equal(f2.leaseSession(), PROVISIONAL, "a released lease is not revived by a bind");

  const f3 = fixture(t);
  f3.claim();
  f3.serverBind("hermes");
  f3.hookBind("hermes");
  assert.equal(f3.leaseSession(), PROVISIONAL, "the adoption is kimi-scoped; hermes keeps its mcp- lease id by design");
  void cwd;
});

test("T656: identity-status still reports 'held by this session' for a provisional mcp-<pid> caller on the adopted state", async t => {
  const { n, cwd, claim, serverBind, hookBind } = fixture(t);
  claim();
  serverBind();
  hookBind();
  const list = listIdentityStatus(n.home, { caller: { cli: "kimi", sessionId: PROVISIONAL, pid: process.pid, providerPid: process.pid, canonicalHarness: false } });
  const me = list.identities.find((i) => i.name === AGENT)!;
  assert.equal(me.state, "held");
  assert.equal(me.claimable, false);
  assert.equal(me.reason, "held by this session");
  assert.equal(me.holder?.session_id, REAL, "the holder view names the real session");
  // the exact-id caller also still matches
  const exact = listIdentityStatus(n.home, { caller: { cli: "kimi", sessionId: REAL, pid: process.pid, providerPid: process.pid, canonicalHarness: false } });
  assert.equal(exact.identities.find((i) => i.name === AGENT)?.reason, "held by this session");
  // a provisional caller for a DIFFERENT process is not this session
  const other = listIdentityStatus(n.home, { caller: { cli: "kimi", sessionId: "mcp-other", pid: 2 ** 22 + 9, providerPid: 2 ** 22 + 9, canonicalHarness: false } });
  assert.notEqual(other.identities.find((i) => i.name === AGENT)?.reason, "held by this session");
  void cwd;
});

test("T656: after adoption a stale re-publish converges on the lease row and captureWakeIdentity admits the wake", async t => {
  const { n, key, claim, serverBind, hookBind } = fixture(t);
  claim();
  serverBind();
  hookBind(); // lease adopted to REAL
  const lease = n.store.db.prepare("SELECT token,holder_start FROM identity_leases WHERE name=?").get(AGENT) as { token: string; holder_start: string | null };
  // What the hook would mint: the pre-bind descriptor's stale lease_session_id, republished after the adoption.
  const parentStart = inspectLeaseProcess(process.pid).start!;
  publishIdentityControl(n.store, { v: 1, cli: "kimi", session_id: REAL, lease_session_id: PROVISIONAL,
    control_key: fingerprint(key.publicKey), mcp_pid: process.pid, mcp_start: parentStart,
    parent_pid: process.pid, parent_start: parentStart, agent: AGENT, generation: identityGeneration(lease.token) });
  const published = findIdentityControl(n.store, "kimi", REAL);
  assert.equal(published.lease_session_id, REAL, "publish converges on the adopted lease id, not the stale one");
  const session = n.sessionsFor(AGENT).find((s) => s.session_id === REAL)!;
  assert.ok(session.session_key, "fixture session carries the server key");
  assert.ok(captureWakeIdentity(n, session), "captureWakeIdentity admits the wake after adoption");

  // negative: a descriptor whose holder does not match the lease publishes as given and is refused for its session
  const other = { ...published, session_id: "session_t656-other", lease_session_id: PROVISIONAL, mcp_pid: 2 ** 22 + 3, mcp_start: "ps-utc:other" };
  publishIdentityControl(n.store, other);
  assert.equal(findIdentityControl(n.store, "kimi", "session_t656-other").lease_session_id, PROVISIONAL, "a foreign holder publishes as given");
  const otherSession = { agent: AGENT, cli: "kimi", session_id: "session_t656-other", pid: process.pid, pid_start: parentStart, session_key: key.publicKey, channel: 0 };
  assert.equal(captureWakeIdentity(n, otherSession as never), null, "a control naming a different holder is refused");
});
