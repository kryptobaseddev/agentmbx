// T550: an OpenCode descriptor records the serve pid as parent_pid (mcp.ts resolves the provider through
// opencodeProviderPid), while a tool shell can run the CLI outside the serve's exact ppid ancestry. The caller
// proof accepts the FIRST opencode-executable ancestor of the requester — never a further ancestor, never a
// different serve, never for a non-opencode descriptor — and keeps the pid+birth and unknown semantics.
// Fake BSD ps rows (T332 idiom) + an exe-identity seam answer over real live pids, so this runs on Linux CI too.
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MbxNode } from "../src/node.ts";
import { procSeams, _resetProcCache } from "../src/proc.ts";
import { IdentityLeases, UNKNOWN_RETRY_DELAYS_MS, _resetEvidenceCacheForTests } from "../src/identity-leases.ts";
import { identityGeneration, publishIdentityControl, type IdentityControlDescriptor } from "../src/identity-control.ts";
import { opencodeServeSeams } from "../src/opencode-provider.ts";
import { withCliIdentity } from "../src/cli-identity.ts";

const EVIDENCE = "pid=,stat=,lstart=";
const FIRST_RETRY = UNKNOWN_RETRY_DELAYS_MS[0];
type Row = { pid: number; ppid: number; stat?: string; utc: string };
const evidenceOut = (rows: Row[]) => rows.map(r => `${String(r.pid).padStart(5)} ${(r.stat ?? "Ss").padEnd(4)} ${r.utc}    `).join("\n") + "\n";
const tableOut = (rows: Row[]) => rows.map(r => `${String(r.pid).padStart(5)} ${String(r.ppid).padStart(5)} ${r.utc}    `).join("\n") + "\n";

/**
 * An OpenCode session's world: real sleep processes stand in for the serve, the tool shell and the MCP holder,
 * so kill-0 liveness probes answer truthfully. The fake ps serves both read kinds from `rows`; the exe seam
 * names the serve's executable "opencode". The requester's recorded parent is the shell and the shell's is the
 * serve — the descriptor's parent_pid is the serve, two levels above the requester.
 */
function world(t: TestContext, cli = "opencode") {
  const home = mkdtempSync(join(tmpdir(), "mbx-t550-")), node = new MbxNode(home, { host: "alpha" });
  const children: ChildProcess[] = [];
  const sleep = () => { const c = spawn("sleep", ["30"], { stdio: "ignore" }); children.push(c); return c.pid!; };
  const serve = sleep(), shell = sleep(), mcp = sleep();
  const rows: Row[] = [
    { pid: process.pid, ppid: shell, utc: "Sat Oct  3 08:00:00 2026" },
    { pid: shell, ppid: serve, utc: "Sat Oct  3 08:01:00 2026" },
    { pid: serve, ppid: 1, utc: "Sat Oct  3 08:02:00 2026" },
    { pid: mcp, ppid: process.pid, utc: "Sat Oct  3 08:03:00 2026" },
  ];
  const exes = new Map<number, string>([[serve, "/opt/homebrew/bin/opencode"]]);
  const fail = { evidence: 0, table: 0 }, reads = { evidence: 0, table: 0 };
  const saved = { platform: procSeams.platform, ps: procSeams.ps, exe: opencodeServeSeams.exe };
  const reset = () => { _resetEvidenceCacheForTests(); _resetProcCache(); reads.evidence = 0; reads.table = 0; };
  procSeams.platform = "darwin";
  procSeams.ps = args => {
    const kind = args[2] === EVIDENCE ? "evidence" : "table";
    reads[kind]++;
    if (fail[kind] > 0) { fail[kind]--; throw Object.assign(new Error("spawnSync ps ETIMEDOUT"), { code: "ETIMEDOUT" }); }
    return kind === "evidence" ? evidenceOut(rows) : tableOut(rows);
  };
  opencodeServeSeams.exe = pid => exes.get(pid) ?? "/usr/bin/node";
  t.after(() => {
    Object.assign(procSeams, { platform: saved.platform, ps: saved.ps });
    opencodeServeSeams.exe = saved.exe;
    reset();
    for (const child of children) child.kill("SIGKILL");
    node.close();
    rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  reset();
  const start = (pid: number) => `ps-utc:${rows.find(r => r.pid === pid)!.utc.replace(/\s+/g, " ")}`;
  const sessionId = "ses_t550";
  const lease = new IdentityLeases(node.store).claim("reader", { pid: mcp, start: start(mcp), keyFp: "aaaa-bbbb-cccc-dddd", cli, sessionId });
  const descriptor: IdentityControlDescriptor = { v: 1, cli, session_id: sessionId, lease_session_id: sessionId, control_key: "aaaa-bbbb-cccc-dddd",
    agent: "reader", generation: identityGeneration(lease.token), mcp_pid: mcp, mcp_start: start(mcp), parent_pid: serve, parent_start: start(serve) };
  publishIdentityControl(node.store, descriptor);
  reset();
  return { node, rows, fail, reads, reset, descriptor, serve, shell, mcp, start, exes, row: (pid: number) => rows.find(r => r.pid === pid)! };
}

function timed<T>(fn: () => T): { value?: T; error?: NodeJS.ErrnoException; ms: number } {
  const began = performance.now();
  try { return { value: fn(), ms: performance.now() - began }; }
  catch (error) { return { error: error as NodeJS.ErrnoException, ms: performance.now() - began }; }
}

test("T550: an opencode-named serve ancestor is accepted through withCliIdentity", t => {
  const w = world(t);
  assert.equal(w.exes.get(w.serve), "/opt/homebrew/bin/opencode", "the serve's exe is opencode");
  const r = timed(() => withCliIdentity(w.node, { cli: "opencode", session: "ses_t550" }, (agent, descriptor) => {
    assert.equal(descriptor.parent_pid, w.serve, "the descriptor records the serve as parent_pid");
    return agent;
  }));
  assert.equal(r.error, undefined, r.error?.message);
  assert.equal(r.value, "reader");
});

test("T550: a different opencode serve is refused at once, with no backoff", t => {
  const w = world(t);
  const other = spawn("sleep", ["30"], { stdio: "ignore" });
  t.after(() => other.kill("SIGKILL"));
  const otherPid = other.pid!;
  w.rows.push({ pid: otherPid, ppid: 1, utc: "Sat Oct  3 09:00:00 2026" });
  w.exes.set(otherPid, "/usr/local/bin/opencode");
  publishIdentityControl(w.node.store, { ...w.descriptor, parent_pid: otherPid, parent_start: w.start(otherPid) });
  w.reset();
  const r = timed(() => withCliIdentity(w.node, { cli: "opencode", session: "ses_t550" }, () => { throw new Error("operation must not run"); }));
  assert.equal(r.error?.code, "IDENTITY_NO_CALLER_LEASE", r.error?.message);
  assert.ok(r.ms < FIRST_RETRY, `no backoff (${Math.round(r.ms)} ms)`);
  assert.equal(w.reads.table, 1, "one attempt: a definite refusal is not retried");
});

test("T550: a shell that is not under the serve is refused at once", t => {
  const w = world(t);
  w.row(w.shell).ppid = 1; // detached: the ancestry reaches launchd without the serve
  w.reset();
  const r = timed(() => withCliIdentity(w.node, { cli: "opencode", session: "ses_t550" }, () => { throw new Error("operation must not run"); }));
  assert.equal(r.error?.code, "IDENTITY_NO_CALLER_LEASE", r.error?.message);
  assert.ok(r.ms < FIRST_RETRY, `no backoff (${Math.round(r.ms)} ms)`);
  assert.equal(w.reads.table, 1, "one attempt");
});

test("T550: the serve ancestor does not relax pid+birth, unknown, or non-opencode descriptors", async t => {
  await t.test("a reborn serve is a refusal, not a new holder", st => {
    const w = world(st);
    w.row(w.serve).utc = "Sat Oct  3 09:02:00 2026"; // same pid, different birth
    w.reset();
    const r = timed(() => withCliIdentity(w.node, { cli: "opencode", session: "ses_t550" }, () => { throw new Error("operation must not run"); }));
    assert.equal(r.error?.code, "IDENTITY_NO_CALLER_LEASE", r.error?.message);
    assert.ok(r.ms < FIRST_RETRY, `no backoff (${Math.round(r.ms)} ms)`);
    assert.equal(w.reads.table, 1, "one attempt");
  });
  await t.test("a serve row the evidence cannot read stays unknown and is retried", st => {
    const w = world(st);
    w.rows.splice(w.rows.findIndex(r => r.pid === w.serve), 1); // alive, but no birth time is readable
    w.reset();
    const r = timed(() => withCliIdentity(w.node, { cli: "opencode", session: "ses_t550" }, () => { throw new Error("operation must not run"); }));
    assert.equal(r.error?.code, "IDENTITY_STATUS_UNKNOWN", r.error?.message);
    assert.ok(r.ms >= UNKNOWN_RETRY_DELAYS_MS.reduce((a, b) => a + b, 0), `used the retry schedule (${Math.round(r.ms)} ms)`);
  });
  await t.test("a non-opencode descriptor does not get the serve-ancestor acceptance", st => {
    const w = world(st, "kimi");
    w.row(w.shell).ppid = 1; // even with the serve out of the ancestry, the opencode gate must not apply
    w.reset();
    const r = timed(() => withCliIdentity(w.node, { cli: "kimi", session: "ses_t550" }, () => { throw new Error("operation must not run"); }));
    assert.equal(r.error?.code, "IDENTITY_NO_CALLER_LEASE", r.error?.message);
    assert.ok(r.ms < FIRST_RETRY, `no backoff (${Math.round(r.ms)} ms)`);
    assert.equal(w.reads.table, 1, "one attempt");
  });
});
