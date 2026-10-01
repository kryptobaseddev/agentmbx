// T206: process-evidence load resilience. Self pid costs no ps; other pids are batched into one
// spawn per cache-miss set; unknown evidence retries with backoff instead of failing closed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MbxNode } from "../src/node.ts";
import { processEvidenceSpawns } from "../src/proc.ts";
import { IdentityLeases, inspectLeaseProcess, inspectLeaseProcesses, UNKNOWN_RETRY_DELAYS_MS, _resetEvidenceCacheForTests, type ProcessEvidence } from "../src/identity-leases.ts";
import { watcherEvidenceRetryable } from "../src/cli.ts";

const self = (): ProcessEvidence => ({ alive: true, start: inspectLeaseProcess(process.pid).start! });

test("self-pid evidence spawns no ps after the first computation (the every-1.5s heartbeat case)", t => {
  _resetEvidenceCacheForTests();
  inspectLeaseProcess(process.pid); // first call computes and caches the birth time
  processEvidenceSpawns.count = 0;
  for (let i = 0; i < 60; i++) assert.equal(inspectLeaseProcess(process.pid).alive, true);
  assert.equal(processEvidenceSpawns.count, 0, "60 self-evidence checks cost zero ps spawns");
  t.after(() => _resetEvidenceCacheForTests());
});

test("foreign pids are batched into one ps spawn per cache-miss set and cached for ~1s", t => {
  _resetEvidenceCacheForTests();
  processEvidenceSpawns.count = 0;
  if (process.platform === "linux") { t.skip("ps spawn counting is exercised on the BSD ps path"); return; }
  const pids = [process.ppid, 1]; // parent and init are both alive on the test hosts
  const first = inspectLeaseProcesses(pids);
  assert.equal(first.get(process.ppid)?.alive, true);
  assert.ok(first.get(1)?.start, "init has birth evidence");
  assert.equal(processEvidenceSpawns.count, 1, "two pids share one ps spawn");
  inspectLeaseProcesses(pids);
  assert.equal(processEvidenceSpawns.count, 1, "a second read inside the cache window costs nothing");
  t.after(() => _resetEvidenceCacheForTests());
});

test("a self-held prepare/withHeld hot loop costs no ps spawns", t => {
  const home = mkdtempSync(join(tmpdir(), "mbx-t206-prep-")), n = new MbxNode(home, { host: "alpha" });
  t.after(() => { n.close(); rmSync(home, { recursive: true, force: true }); });
  _resetEvidenceCacheForTests();
  const leases = new IdentityLeases(n.store);
  const claimed = leases.claim("holder-a", { pid: process.pid, start: self().start!, keyFp: "aaaa-bbbb-cccc-dddd", cli: "kimi", sessionId: "s1" });
  processEvidenceSpawns.count = 0;
  for (let i = 0; i < 10; i++) assert.equal(leases.withHeld("holder-a", claimed.token, () => 1), 1);
  assert.equal(processEvidenceSpawns.count, 0, "10 held operations over a self holder cost no ps spawns");
  t.after(() => _resetEvidenceCacheForTests());
});

test("unknown evidence retries with backoff and then succeeds when inspection recovers", t => {
  const home = mkdtempSync(join(tmpdir(), "mbx-t206-retry-")), n = new MbxNode(home, { host: "alpha" });
  t.after(() => { n.close(); rmSync(home, { recursive: true, force: true }); });
  const claimed = new IdentityLeases(n.store).claim("holder-b", { pid: process.pid, start: self().start!, keyFp: "aaaa-bbbb-cccc-dddd", cli: "kimi", sessionId: "s2" });
  let unknowns = UNKNOWN_RETRY_DELAYS_MS.length; // exhaust the retries, then recover
  let calls = 0;
  const flaky = new IdentityLeases(n.store, { inspect: () => { calls++; return unknowns-- > 0 ? { alive: null, start: null } : self(); } });
  assert.equal(flaky.withHeld("holder-b", claimed.token, () => 42), 42, "withHeld succeeds after backoff retries");
  assert.equal(calls, UNKNOWN_RETRY_DELAYS_MS.length + 1, "initial inspection plus one per retry");
});

test("unknown evidence that never recovers throws IDENTITY_STATUS_UNKNOWN after the retries", t => {
  const home = mkdtempSync(join(tmpdir(), "mbx-t206-unknown-")), n = new MbxNode(home, { host: "alpha" });
  t.after(() => { n.close(); rmSync(home, { recursive: true, force: true }); });
  const claimed = new IdentityLeases(n.store).claim("holder-c", { pid: process.pid, start: self().start!, keyFp: "aaaa-bbbb-cccc-dddd", cli: "kimi", sessionId: "s3" });
  let calls = 0;
  const dark = new IdentityLeases(n.store, { inspect: () => { calls++; return { alive: null, start: null }; } });
  assert.throws(() => dark.withHeld("holder-c", claimed.token, () => 1), { code: "IDENTITY_STATUS_UNKNOWN" });
  assert.equal(calls, UNKNOWN_RETRY_DELAYS_MS.length + 1, "initial attempt plus one inspection per retry");
  assert.throws(() => dark.renew("holder-c", claimed.token), { code: "IDENTITY_STATUS_UNKNOWN" });
});

test("the watcher treats stale and unknown evidence as retryable, not as lease loss", () => {
  assert.equal(watcherEvidenceRetryable(Object.assign(new Error("caller process evidence became stale; retry after inspection"), { code: "IDENTITY_LEASE_REQUIRED" })), true);
  assert.equal(watcherEvidenceRetryable(Object.assign(new Error("identity drum process status is unknown; retry this lease token after inspection recovers"), { code: "IDENTITY_STATUS_UNKNOWN" })), true);
  assert.equal(watcherEvidenceRetryable(Object.assign(new Error("no current identity lease belongs to this caller"), { code: "IDENTITY_NO_CALLER_LEASE" })), false);
  assert.equal(watcherEvidenceRetryable(Object.assign(new Error("identity drum lease is no longer usable"), { code: "IDENTITY_LEASE_LOST" })), false);
  assert.equal(watcherEvidenceRetryable(new Error("some other failure")), false);
  assert.equal(watcherEvidenceRetryable(null), false);
});
