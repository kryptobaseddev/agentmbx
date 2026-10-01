// T211: doctor surfaces stranded mail, sessions waiting on a remembered identity, and prune weight. Read-only checks.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MbxNode } from "../src/node.ts";
import { strandedMail, pendingIdentities, pruneSummary } from "../src/doctor.ts";
import { publishIdentityControl } from "../src/identity-control.ts";
import { IdentityLeases, inspectLeaseProcess } from "../src/identity-leases.ts";
import { fingerprint, generateKeyPair } from "../src/crypto.ts";

const home = () => mkdtempSync(join(tmpdir(), "mbx-doctor-t211-"));

test("stranded mail reports unread mailboxes with no live holder, with last holder, since and reason", (t) => {
  const h = home(), n = new MbxNode(h, { host: "alpha" });
  t.after(() => { n.close(); rmSync(h, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
  n.send({ from: "boss", to: ["gone"], subject: "s1", body: "b" });
  n.send({ from: "boss", to: ["gone"], subject: "s2", body: "b" });
  n.send({ from: "boss", to: ["owner"], subject: "for the human", body: "b" });
  // a last-holder record: a released lease names who held it and since when
  n.store.db.prepare(`INSERT INTO identity_leases (name,token,holder_pid,holder_start,key_fp,cli,session_id,claimed_at,heartbeat_at,idle_ttl,released_at,release_reason)
    VALUES ('gone','tok',4242,'ps-utc:old','aaaa-bbbb-cccc-dddd','claude','sess-gone-1',?,? ,?,?,'released')`)
    .run(Date.now() - 86_400_000, Date.now() - 3_600_000, 30 * 60_000, Date.now() - 3_600_000);
  const checks = strandedMail(n);
  assert.equal(checks.length, 1, "owner mail is not stranded and live names are not listed");
  assert.equal(checks[0].level, "warn");
  assert.match(checks[0].label, /^gone: 2 unread message\(s\) stranded/);
  assert.match(checks[0].label, /claude session sess-gone-1/);
  assert.match(checks[0].label, /no live session since /);
  assert.match(checks[0].label, /released/);
  assert.match(checks[0].fix!, /mbx_identity \{"action":"claim","name":"gone"\}/);
  assert.match(checks[0].fix!, /agentmbx identity forward gone <to>/);
});

test("stranded mail skips mailboxes a live session holds", (t) => {
  const h = home(), n = new MbxNode(h, { host: "alpha" });
  t.after(() => { n.close(); rmSync(h, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
  n.send({ from: "boss", to: ["held"], subject: "s", body: "b" });
  const leases = new IdentityLeases(n.store);
  const claimed = leases.claim("held", { pid: process.pid, start: inspectLeaseProcess(process.pid).start!, keyFp: "aaaa-bbbb-cccc-dddd", cli: "kimi", sessionId: "live-session" });
  assert.ok(claimed);
  assert.deepEqual(strandedMail(n), []);
});

test("stranded mail caps at 10 lines and summarizes the rest", (t) => {
  const h = home(), n = new MbxNode(h, { host: "alpha" });
  t.after(() => { n.close(); rmSync(h, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
  for (let i = 0; i < 13; i++) n.send({ from: "boss", to: [`mb-${String(i).padStart(2, "0")}`], subject: "s", body: "b" });
  const checks = strandedMail(n);
  assert.equal(checks.length, 11);
  assert.equal(checks[0].level, "warn");
  assert.match(checks[10].label, /3 more mailbox\(es\) with stranded unread mail/);
  assert.equal(checks[10].fix, undefined);
});

test("pending identities reports unbound sessions whose remembered name another session holds", (t) => {
  const h = home(), n = new MbxNode(h, { host: "alpha" });
  t.after(() => { n.close(); rmSync(h, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
  const key = generateKeyPair();
  // a live holder of "wanted" (self pid = provably live)
  new IdentityLeases(n.store).claim("wanted", { pid: process.pid, start: inspectLeaseProcess(process.pid).start!, keyFp: fingerprint(key.publicKey), cli: "claude", sessionId: "other-sess" });
  // the waiting session: published control with agent "" and a remembered name
  publishIdentityControl(n.store, { v: 1, cli: "claude", session_id: "sess-waiting", lease_session_id: "sess-waiting", control_key: fingerprint(key.publicKey),
    mcp_pid: process.pid, mcp_start: "ps-utc:x", parent_pid: process.ppid, parent_start: "ps-utc:y", agent: "", generation: null });
  n.store.set("name:claude:sess-waiting", "wanted");
  const checks = pendingIdentities(n);
  assert.equal(checks.length, 1);
  assert.equal(checks[0].level, "warn");
  assert.match(checks[0].label, /claude session sess-waiting is waiting for its remembered identity wanted, held by claude session other-sess/);
  assert.match(checks[0].fix!, /agentmbx identity takeover wanted --force/);
});

test("pending identities stays quiet when the name is free, self-held or unremembered", (t) => {
  const h = home(), n = new MbxNode(h, { host: "alpha" });
  t.after(() => { n.close(); rmSync(h, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
  const key = generateKeyPair();
  const blank = { v: 1 as const, cli: "claude", session_id: "s", lease_session_id: "s", control_key: fingerprint(key.publicKey),
    mcp_pid: process.pid, mcp_start: "ps-utc:x", parent_pid: process.ppid, parent_start: "ps-utc:y", agent: "", generation: null };
  publishIdentityControl(n.store, { ...blank, session_id: "s-free", lease_session_id: "s-free" }); // remembered name has no lease: claimable now
  n.store.set("name:claude:s-free", "anything");
  publishIdentityControl(n.store, { ...blank, session_id: "s-none", lease_session_id: "s-none" }); // no remembered name
  publishIdentityControl(n.store, { ...blank, session_id: "s-bound", lease_session_id: "s-bound", agent: "someone" }); // already bound
  assert.deepEqual(pendingIdentities(n), []);
});

test("prune summary counts generated mailboxes prune would retire, and stays quiet when there are none", (t) => {
  const h = home(), n = new MbxNode(h, { host: "alpha" });
  t.after(() => { n.close(); rmSync(h, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
  const quiet = pruneSummary(n);
  assert.equal(quiet.level, "info");
  assert.match(quiet.label, /no generated mailboxes eligible for prune/);
  // a generated name, never registered, no lease, no unread, no traffic for 7 days
  n.registerAgent("scratch-mcp-0123456789abcdef", { cli: "kimi" });
  n.store.db.prepare("UPDATE agents SET last_seen=? WHERE name=?").run(new Date(Date.now() - 8 * 86_400_000).toISOString(), "scratch-mcp-0123456789abcdef");
  const hit = pruneSummary(n);
  assert.equal(hit.level, "warn");
  assert.match(hit.label, /1 generated mailbox\(es\).*would be retired/);
  assert.match(hit.fix!, /agentmbx identity prune --dry-run/);
});
