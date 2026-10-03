// T340: caller proofs answer valid, invalid or unknown. Only unknown (ps failed or timed out) is retried on the
// UNKNOWN_RETRY_DELAYS_MS schedule; a definite refusal is thrown at once, so it adds no latency. Covers the CLI caller
// check, the requester check that used to run once before the retry loop, and submitIdentityControl. The procSeams fake
// BSD ps (T332) answers over real live pids, so these run on Linux CI too.
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MbxNode } from "../src/node.ts";
import { procSeams, _resetProcCache } from "../src/proc.ts";
import { IdentityLeases, UNKNOWN_RETRY_DELAYS_MS, _resetEvidenceCacheForTests } from "../src/identity-leases.ts";
import { identityGeneration, identityRequestKey, inspectIdentityControlCaller, publishIdentityControl, submitIdentityControl, type IdentityControlDescriptor } from "../src/identity-control.ts";
import { withCliIdentity } from "../src/cli-identity.ts";

const EVIDENCE = "pid=,stat=,lstart=";
const FIRST_RETRY = UNKNOWN_RETRY_DELAYS_MS[0];
type Row = { pid: number; ppid: number; stat?: string; utc: string };
const evidenceOut = (rows: Row[]) => rows.map(r => `${String(r.pid).padStart(5)} ${(r.stat ?? "Ss").padEnd(4)} ${r.utc}    `).join("\n") + "\n";
const tableOut = (rows: Row[]) => rows.map(r => `${String(r.pid).padStart(5)} ${String(r.ppid).padStart(5)} ${r.utc}    `).join("\n") + "\n";
const timedOut = () => Object.assign(new Error("spawnSync ps ETIMEDOUT"), { code: "ETIMEDOUT" });

/**
 * This process asks; its real parent is the provider and a real child is the MCP holder of lease "reader". The fake ps
 * serves both read kinds from `rows`; `fail.evidence` / `fail.table` make that many upcoming reads of a kind time out.
 */
function world(t: TestContext) {
  const home = mkdtempSync(join(tmpdir(), "mbx-t340-")), node = new MbxNode(home, { host: "alpha" });
  const child = spawn("sleep", ["30"], { stdio: "ignore" }), mcp = child.pid!;
  const rows: Row[] = [
    { pid: process.pid, ppid: process.ppid, utc: "Sat Oct  3 08:00:00 2026" },
    { pid: process.ppid, ppid: 1, utc: "Sat Oct  3 07:00:00 2026" },
    { pid: mcp, ppid: process.pid, utc: "Sat Oct  3 08:01:00 2026" },
  ];
  const fail = { evidence: 0, table: 0 }, reads = { evidence: 0, table: 0 };
  const saved = { platform: procSeams.platform, ps: procSeams.ps };
  const reset = () => { _resetEvidenceCacheForTests(); _resetProcCache(); reads.evidence = 0; reads.table = 0; };
  procSeams.platform = "darwin";
  procSeams.ps = args => {
    const kind = args[2] === EVIDENCE ? "evidence" : "table";
    reads[kind]++;
    if (fail[kind] > 0) { fail[kind]--; throw timedOut(); }
    return kind === "evidence" ? evidenceOut(rows) : tableOut(rows);
  };
  t.after(() => { Object.assign(procSeams, saved); reset(); child.kill("SIGKILL"); node.close(); rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
  reset();
  const start = (pid: number) => `ps-utc:${rows.find(r => r.pid === pid)!.utc.replace(/\s+/g, " ")}`;
  const lease = new IdentityLeases(node.store).claim("reader", { pid: mcp, start: start(mcp), keyFp: "aaaa-bbbb-cccc-dddd", cli: "kimi", sessionId: "s1" });
  const descriptor: IdentityControlDescriptor = { v: 1, cli: "kimi", session_id: "s1", lease_session_id: "s1", control_key: "aaaa-bbbb-cccc-dddd",
    agent: "reader", generation: identityGeneration(lease.token), mcp_pid: mcp, mcp_start: start(mcp), parent_pid: process.ppid, parent_start: start(process.ppid) };
  publishIdentityControl(node.store, descriptor);
  reset();
  return { node, rows, fail, reads, reset, descriptor, mcp, start, row: (pid: number) => rows.find(r => r.pid === pid)! };
}

function timed<T>(fn: () => T): { value?: T; error?: NodeJS.ErrnoException; ms: number } {
  const began = performance.now();
  try { return { value: fn(), ms: performance.now() - began }; }
  catch (error) { return { error: error as NodeJS.ErrnoException, ms: performance.now() - began }; }
}

test("inspectIdentityControlCaller answers valid, invalid or unknown; a definite mismatch outranks unknown evidence", t => {
  const w = world(t), ask = () => inspectIdentityControlCaller(w.descriptor, process.pid, w.start(process.pid));
  assert.deepEqual({ ...ask(), at: 0 }, { at: 0, valid: true, state: "valid" });
  w.reset(); w.fail.table = 1;
  assert.deepEqual({ ...ask(), at: 0 }, { at: 0, valid: false, state: "unknown" }, "no process table: the ancestry is unknown, not unrelated");
  w.reset(); w.fail.evidence = 1;
  assert.equal(ask().state, "unknown", "no birth times: unknown, not a mismatch");
  w.reset(); w.row(w.mcp).stat = "Z";
  assert.equal(ask().state, "invalid", "an MCP holder that died is a refusal");
  w.reset(); w.fail.table = 1;
  assert.equal(ask().state, "invalid", "a dead holder stays a refusal while the ancestry is unknown");
  w.reset(); w.row(w.mcp).stat = "Ss"; w.row(process.ppid).utc = "Sat Oct  3 07:30:00 2026";
  assert.equal(ask().state, "invalid", "a reborn provider pid is a refusal");
  w.reset(); w.row(process.ppid).utc = "Sat Oct  3 07:00:00 2026"; w.row(process.pid).ppid = 1;
  assert.equal(ask().state, "invalid", "a complete ancestry without the provider is a refusal");
});

test("CLI caller check: unknown ancestry is retried and succeeds, where it used to report IDENTITY_NO_CALLER_LEASE", t => {
  const w = world(t);
  w.fail.table = 1;
  const r = timed(() => withCliIdentity(w.node, { as: "reader" }, agent => agent));
  assert.equal(r.error, undefined, r.error?.message);
  assert.equal(r.value, "reader");
  assert.ok(r.ms >= FIRST_RETRY, `waited for the first retry (${Math.round(r.ms)} ms)`);
  assert.equal(w.reads.table, 3, "failed read, the retry's read, the pre-operation re-check");
});

test("CLI requester check: unknown evidence for the calling process is retried inside the loop and succeeds", t => {
  const w = world(t);
  w.fail.evidence = 1; // this process's own birth time cannot be read on the first attempt
  const r = timed(() => withCliIdentity(w.node, {}, agent => agent));
  assert.equal(r.error, undefined, r.error?.message);
  assert.equal(r.value, "reader");
  assert.ok(r.ms >= FIRST_RETRY, `waited for the first retry (${Math.round(r.ms)} ms)`);
  assert.equal(w.reads.evidence, 2, "the retry read the evidence again; it was not checked once before the loop");
});

test("CLI caller check: definite refusals fail at once, with no backoff", async t => {
  const cases: [string, (w: ReturnType<typeof world>) => void, string][] = [
    ["provider is not an ancestor", w => { w.row(process.pid).ppid = 1; }, "IDENTITY_NO_CALLER_LEASE"],
    ["MCP holder died", w => { w.row(w.mcp).stat = "Z"; }, "IDENTITY_NO_CALLER_LEASE"],
    ["provider pid reborn", w => { w.row(process.ppid).utc = "Sat Oct  3 07:30:00 2026"; }, "IDENTITY_NO_CALLER_LEASE"],
  ];
  for (const [name, mutate, code] of cases) await t.test(name, st => {
    const w = world(st);
    mutate(w);
    let ran = false;
    const r = timed(() => withCliIdentity(w.node, {}, () => { ran = true; }));
    assert.equal(r.error?.code, code, r.error?.message);
    assert.equal(ran, false);
    assert.ok(r.ms < FIRST_RETRY, `no backoff (${Math.round(r.ms)} ms)`);
    assert.equal(w.reads.table, 1, "one attempt");
  });
});

test("CLI pre-operation re-check: a definite mismatch is refused at once, not retried as stale evidence", t => {
  const w = world(t), inner = procSeams.ps;
  let tables = 0;
  // The authorizing read sees the provider; the re-check just before the operation sees the caller reparented away.
  procSeams.ps = (args, options) => { if (args[2] !== EVIDENCE && ++tables === 2) w.row(process.pid).ppid = 1; return inner(args, options); };
  let ran = false;
  const r = timed(() => withCliIdentity(w.node, {}, () => { ran = true; }));
  assert.equal(r.error?.code, "IDENTITY_LEASE_REQUIRED", r.error?.message);
  assert.match(r.error!.message, /no longer matches/);
  assert.equal(ran, false);
  assert.ok(r.ms < FIRST_RETRY, `no backoff (${Math.round(r.ms)} ms)`);
  assert.equal(tables, 2, "authorize and re-check only");
});

test("CLI caller check: evidence that stays unknown fails as unknown after the schedule, never as no caller lease", t => {
  const w = world(t);
  w.fail.table = UNKNOWN_RETRY_DELAYS_MS.length + 1;
  const r = timed(() => withCliIdentity(w.node, {}, agent => agent));
  assert.equal(r.error?.code, "IDENTITY_STATUS_UNKNOWN", r.error?.message);
  assert.equal(w.reads.table, UNKNOWN_RETRY_DELAYS_MS.length + 1, "initial attempt plus one per retry");
  assert.ok(r.ms >= UNKNOWN_RETRY_DELAYS_MS.reduce((a, b) => a + b, 0), `used the whole schedule (${Math.round(r.ms)} ms)`);
});

test("submitIdentityControl: unknown ancestry or requester evidence is retried and the request is submitted", t => {
  const w = world(t);
  for (const kind of ["table", "evidence"] as const) {
    w.reset(); w.fail[kind] = 1;
    const r = timed(() => submitIdentityControl(w.node.store, w.descriptor, "release"));
    assert.equal(r.error, undefined, `${kind}: ${r.error?.message}`);
    assert.equal(r.value!.status, "pending");
    assert.ok(w.node.store.get(identityRequestKey(r.value!.id)), "the request is stored");
    assert.ok(r.ms >= FIRST_RETRY, `${kind}: waited for the first retry (${Math.round(r.ms)} ms)`);
    assert.equal(w.reads[kind], 2, `${kind}: read again on the retry`);
  }
});

test("submitIdentityControl: a definite refusal fails at once and stores nothing", t => {
  const w = world(t);
  const unrelated: IdentityControlDescriptor = { ...w.descriptor, parent_pid: w.mcp, parent_start: w.descriptor.mcp_start };
  publishIdentityControl(w.node.store, unrelated);
  w.reset();
  const r = timed(() => submitIdentityControl(w.node.store, unrelated, "release"));
  assert.equal(r.error?.code, "IDENTITY_CONTROL_REFUSED");
  assert.match(r.error!.message, /ancestry/);
  assert.ok(r.ms < FIRST_RETRY, `no backoff (${Math.round(r.ms)} ms)`);
  assert.equal(w.reads.table, 1, "one attempt");
  assert.equal(w.node.store.db.prepare("SELECT count(*) AS n FROM kv WHERE k GLOB 'identity-request:*'").get()!.n, 0);
});
