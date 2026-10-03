// T332: lease process evidence reads one full ps table per pass (never `ps -p <list>`, 0.3-0.7 s on macOS), never keeps a
// failed or timed-out read for the retries, and keeps the start strings stored in identity_leases.holder_start and
// sessions.pid_start byte-identical. The ps seam forces the BSD ps path, so these run on Linux CI too.
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MbxNode } from "../src/node.ts";
import { procSeams, procStart, processEvidenceSpawns, sleepSync, withProcSnapshot, _resetProcCache } from "../src/proc.ts";
import { IdentityLeases, inspectLeaseProcess, inspectLeaseProcesses, UNKNOWN_RETRY_DELAYS_MS, _resetEvidenceCacheForTests } from "../src/identity-leases.ts";

const EVIDENCE = "pid=,stat=,lstart=", TABLE = "pid=,ppid=,lstart=";
type Row = { pid: number; ppid?: number; stat?: string; utc: string; local?: string };
/** ps -A output as BSD ps prints it: right-aligned pids, %e-padded days, trailing padding. */
const evidenceOut = (rows: Row[]) => rows.map(r => `${String(r.pid).padStart(5)} ${(r.stat ?? "Ss").padEnd(4)} ${r.utc}    `).join("\n") + "\n";
const tableOut = (rows: Row[]) => rows.map(r => `${String(r.pid).padStart(5)} ${String(r.ppid ?? 1).padStart(5)} ${r.local ?? r.utc}    `).join("\n") + "\n";
const timedOut = () => Object.assign(new Error("spawnSync ps ETIMEDOUT"), { code: "ETIMEDOUT" });

/** Swap in a fake BSD ps; every call is recorded. The handler may throw to model a timeout. */
function fakePs(t: TestContext, handler: (args: string[]) => string) {
  const saved = { platform: procSeams.platform, ps: procSeams.ps }, calls: string[][] = [];
  procSeams.platform = "darwin";
  procSeams.ps = (args) => { calls.push(args); return handler(args); };
  _resetEvidenceCacheForTests(); _resetProcCache();
  t.after(() => { Object.assign(procSeams, saved); _resetEvidenceCacheForTests(); _resetProcCache(); });
  return { calls, evidenceReads: () => calls.filter(a => a.join(" ") === `-A -o ${EVIDENCE}`).length };
}
function child(t: TestContext) {
  const c = spawn("sleep", ["30"], { stdio: "ignore" });
  t.after(() => c.kill("SIGKILL"));
  return c.pid!;
}
function node(t: TestContext) {
  const home = mkdtempSync(join(tmpdir(), "mbx-t332-")), n = new MbxNode(home, { host: "alpha" });
  t.after(() => { n.close(); rmSync(home, { recursive: true, force: true }); });
  return n;
}

test("start strings keep their formats: holder_start is ps-utc with collapsed spaces, pid_start the raw local lstart", t => {
  const holder = child(t);
  const rows: Row[] = [
    { pid: process.pid, utc: "Sat Oct  3 08:54:57 2026", local: "Sat Oct  3 01:54:57 2026" },
    { pid: holder, stat: "S+", utc: "Mon Sep 28 23:01:02 2026", local: "Mon Sep 28 16:01:02 2026" },
    { pid: process.ppid, stat: "Z", utc: "Fri Oct  2 00:00:01 2026" },
  ];
  fakePs(t, args => args[2] === EVIDENCE ? evidenceOut(rows) : tableOut(rows));
  const evidence = inspectLeaseProcesses([process.pid, holder, process.ppid]);
  assert.deepEqual(evidence.get(process.pid), { alive: true, start: "ps-utc:Sat Oct 3 08:54:57 2026" });
  assert.deepEqual(evidence.get(holder), { alive: true, start: "ps-utc:Mon Sep 28 23:01:02 2026" });
  assert.deepEqual(evidence.get(process.ppid), { alive: false, start: null }, "a zombie is dead, as before");
  // sessions.pid_start (procStart, hud.ts sameSession) is untouched: local time, %e padding kept.
  assert.equal(procStart(process.pid), "Sat Oct  3 01:54:57 2026");
  assert.equal(procStart(holder), "Mon Sep 28 16:01:02 2026");
});

test("real ps: the full-table strings equal the former per-pid ps -p reads", { skip: process.platform === "linux" ? "Linux reads /proc (proc-linux.test.ts)" : false }, () => {
  _resetEvidenceCacheForTests(); _resetProcCache();
  const pids = [process.pid, process.ppid], evidence = inspectLeaseProcesses(pids);
  for (const pid of pids) {
    // The pre-T332 lease read, verbatim: ps -p in UTC, parsed by the same expression.
    const old = execFileSync("ps", ["-p", String(pid), "-o", EVIDENCE], { encoding: "utf8", env: { ...process.env, TZ: "UTC", LC_ALL: "C", LANG: "C" } }).trim();
    const m = /^\s*(\d+)\s+(\S+)\s+([A-Z][a-z]{2} [A-Z][a-z]{2}\s+\d{1,2} \d{2}:\d{2}:\d{2} \d{4})\s*$/.exec(old)!;
    assert.equal(evidence.get(pid)?.start, `ps-utc:${m[3].replace(/\s+/g, " ")}`);
    assert.match(evidence.get(pid)!.start!, /^ps-utc:[A-Z][a-z]{2} [A-Z][a-z]{2} \d{1,2} \d{2}:\d{2}:\d{2} \d{4}$/);
    const local = execFileSync("ps", ["-p", String(pid), "-o", TABLE], { encoding: "utf8", env: { ...process.env, LC_ALL: "C" } }).trim();
    assert.equal(procStart(pid), /^\s*(\d+)\s+(\d+)\s+(.+?)\s*$/.exec(local)![3]);
  }
  _resetEvidenceCacheForTests();
});

test("darwin: one full-table read per pass, filtered in process, never ps -p", t => {
  const n = node(t), a = child(t), b = child(t), c = child(t);
  const rows: Row[] = [process.pid, process.ppid, a, b, c].map((pid, i) => ({ pid, utc: `Sat Oct  3 08:5${i}:00 2026` }));
  const ps = fakePs(t, args => args[2] === EVIDENCE ? evidenceOut(rows) : tableOut(rows));
  const start = (pid: number) => `ps-utc:Sat Oct 3 08:5${rows.findIndex(r => r.pid === pid)}:00 2026`;
  const spawns = processEvidenceSpawns.count;
  withProcSnapshot(() => {
    const leases = new IdentityLeases(n.store);
    assert.equal(inspectLeaseProcess(process.pid).start, start(process.pid));
    const claimed = leases.claim("holder", { pid: a, start: start(a), keyFp: "aaaa-bbbb-cccc-dddd", cli: "kimi", sessionId: "s1" });
    leases.prepare(["holder"], [b, c, process.ppid], () => assert.equal(leases.withHeld("holder", claimed.token, () => 7), 7));
    assert.deepEqual([...inspectLeaseProcesses([a, b, c]).values()].map(e => e.start), [start(a), start(b), start(c)]);
  });
  assert.equal(ps.evidenceReads(), 1, "every pid of the pass came from one ps -A");
  assert.ok(ps.calls.every(args => !args.includes("-p")), "never ps -p <list>");
  assert.equal(processEvidenceSpawns.count - spawns, 2, "the pass costs the snapshot's table plus one evidence table");
});

test("a failed or timed-out ps is never cached: the next inspection reads again", t => {
  const holder = child(t), rows: Row[] = [{ pid: process.pid, utc: "Sat Oct  3 08:00:00 2026" }, { pid: holder, utc: "Sat Oct  3 08:01:00 2026" }];
  let failures = 1;
  const ps = fakePs(t, args => {
    if (args[2] !== EVIDENCE) return tableOut(rows);
    if (failures-- > 0) { sleepSync(300); throw timedOut(); }
    return evidenceOut(rows);
  });
  assert.deepEqual(inspectLeaseProcesses([holder]).get(holder), { alive: true, start: null }, "a timeout is unknown, not dead");
  // Well inside the 1 s cache window: the unknown answer was not kept, so this probes ps again.
  assert.deepEqual(inspectLeaseProcesses([holder]).get(holder), { alive: true, start: "ps-utc:Sat Oct 3 08:01:00 2026" });
  assert.equal(ps.evidenceReads(), 2);
  inspectLeaseProcesses([holder]);
  assert.equal(ps.evidenceReads(), 2, "a complete answer is cached as before");
});

test("a slow ps timeout does not poison the 250/500 ms retries of a held operation", t => {
  const n = node(t), holder = child(t);
  const rows: Row[] = [{ pid: process.pid, utc: "Sat Oct  3 08:00:00 2026" }, { pid: holder, utc: "Sat Oct  3 08:01:00 2026" }];
  let failures = 0;
  const ps = fakePs(t, args => {
    if (args[2] !== EVIDENCE) return tableOut(rows);
    if (failures-- > 0) { sleepSync(600); throw timedOut(); }
    return evidenceOut(rows);
  });
  const leases = new IdentityLeases(n.store);
  const claimed = leases.claim("holder", { pid: holder, start: "ps-utc:Sat Oct 3 08:01:00 2026", keyFp: "aaaa-bbbb-cccc-dddd", cli: "kimi", sessionId: "s1" });
  _resetEvidenceCacheForTests();
  failures = 1; // the next ps runs 600 ms, then times out (under load, the old ps -p hit its 1 s timeout)
  const reads = ps.evidenceReads(), began = performance.now();
  assert.equal(withProcSnapshot(() => leases.withHeld("holder", claimed.token, () => 42)), 42);
  const elapsed = performance.now() - began;
  assert.equal(ps.evidenceReads() - reads, 2, "the first retry read ps again");
  // A cached timeout would survive the 250 ms retry and need the 500 ms one: 600 + 250 + 500 ms.
  assert.ok(elapsed < 600 + UNKNOWN_RETRY_DELAYS_MS[0] + UNKNOWN_RETRY_DELAYS_MS[1], `succeeded on the first retry (${Math.round(elapsed)} ms)`);
});

test("a live pid missing from a shared table reads once more; a pid proven gone is an answer", t => {
  const late = child(t), gone = spawn("true");
  let rows: Row[] = [{ pid: process.pid, utc: "Sat Oct  3 08:00:00 2026" }, { pid: process.ppid, utc: "Sat Oct  3 07:00:00 2026" }];
  const ps = fakePs(t, args => args[2] === EVIDENCE ? evidenceOut(rows) : tableOut(rows));
  return new Promise<void>(resolve => gone.on("exit", () => setTimeout(resolve, 50))).then(() => {
    inspectLeaseProcesses([process.ppid]);
    assert.equal(ps.evidenceReads(), 1);
    // The shared table predates `late` (alive, absent): one fresh read finds it.
    rows = [...rows, { pid: late, utc: "Sat Oct  3 08:02:00 2026" }];
    assert.equal(inspectLeaseProcesses([late]).get(late)?.start, "ps-utc:Sat Oct 3 08:02:00 2026");
    assert.equal(ps.evidenceReads(), 2);
    // A reaped pid is absent and answers ESRCH: a genuine "no such pid", served from the table without another read.
    assert.deepEqual(inspectLeaseProcesses([gone.pid!]).get(gone.pid!), { alive: false, start: null });
    assert.deepEqual(inspectLeaseProcesses([gone.pid!]).get(gone.pid!), { alive: false, start: null });
    assert.equal(ps.evidenceReads(), 2);
  });
});
