// T550: an OpenCode control descriptor's parent_pid is whatever the MCP-side resolve produced (mcp.ts):
// the raw mcp ppid when opencodeProviderPid found no runtime path, or the first opencode executable on
// the MCP's branch — neither of which has to sit in a tool shell's ancestry (live repro, /tmp/t550-repro
// runs T1/T3: the MCP branch and the tool shell branch diverge below the serve). What both ends of one
// session provably share is the TOPMOST opencode executable, so the caller proof accepts on root
// equality. Fake BSD ps rows (T332 idiom) + real sleep pids for truthful liveness/birth probes + an
// exe-identity seam, so this runs on Linux CI too.
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
// Fake-tree pids (never probed: the root walk reads rows and exe names only, liveness/birth probes
// cover the real pids below).
const TOOL = 90001, SERVE = 90002, SERVE2 = 90003, TOP = 90004;

/**
 * An OpenCode session's world. Real sleep processes stand in for the recorded pids (MCP holder `mcp`,
 * recorded parent `bind` — the T1 resolve-null shape, and `host` — the T3 plugin-host shape) so kill-0
 * liveness and birth probes answer truthfully. The fake ps serves both read kinds from `rows`; the exe
 * seam names the serve's executable "opencode". Topology: the requester's recorded chain runs
 * requester -> tool-shell(fake) -> serve(fake, exe opencode); the MCP branch runs mcp(real) ->
 * bind(real) -> serve — the two branches meet only at the serve, and parent_pid (bind) is NOT in the
 * requester's ancestry, exactly the live-repro refusal shape.
 */
function world(t: TestContext, cli = "opencode") {
  const home = mkdtempSync(join(tmpdir(), "mbx-t550-")), node = new MbxNode(home, { host: "alpha" });
  const children: ChildProcess[] = [];
  const sleep = () => { const c = spawn("sleep", ["30"], { stdio: "ignore" }); children.push(c); return c.pid!; };
  const serve = SERVE, mcp = sleep(), bind = sleep(), host = sleep();
  const rows: Row[] = [
    { pid: process.pid, ppid: TOOL, utc: "Sat Oct  3 08:00:00 2026" },
    { pid: TOOL, ppid: serve, utc: "Sat Oct  3 08:01:00 2026" },
    { pid: serve, ppid: 1, utc: "Sat Oct  3 08:02:00 2026" },
    { pid: mcp, ppid: bind, utc: "Sat Oct  3 08:03:00 2026" },
    { pid: bind, ppid: serve, utc: "Sat Oct  3 08:04:00 2026" },
    { pid: host, ppid: serve, utc: "Sat Oct  3 08:05:00 2026" },
  ];
  const exes = new Map<number, string>([[serve, "/opt/homebrew/bin/opencode"], [host, "/opt/homebrew/bin/opencode"]]);
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
    agent: "reader", generation: identityGeneration(lease.token), mcp_pid: mcp, mcp_start: start(mcp), parent_pid: bind, parent_start: start(bind) };
  publishIdentityControl(node.store, descriptor);
  reset();
  return { node, rows, fail, reads, reset, descriptor, serve, mcp, bind, host, start, exes,
    publish: (d: IdentityControlDescriptor) => { publishIdentityControl(node.store, d); reset(); },
    row: (pid: number) => rows.find(r => r.pid === pid)! };
}

function timed<T>(fn: () => T): { value?: T; error?: NodeJS.ErrnoException; ms: number } {
  const began = performance.now();
  try { return { value: fn(), ms: performance.now() - began }; }
  catch (error) { return { error: error as NodeJS.ErrnoException, ms: performance.now() - began }; }
}

test("T550: resolve-null shape — recorded parent_pid is a sibling-branch intermediate, shared serve root accepts", t => {
  const w = world(t);
  assert.notEqual(w.descriptor.parent_pid, w.serve, "the live repro's T1: parent_pid is the raw mcp ppid, not the serve");
  assert.ok(!w.rows.some(r => r.pid === TOOL && r.ppid === w.descriptor.parent_pid), "parent_pid is not in the requester's recorded ancestry");
  const r = timed(() => withCliIdentity(w.node, { cli: "opencode", session: "ses_t550" }, (agent, descriptor) => {
    assert.equal(descriptor.parent_pid, w.bind);
    return agent;
  }));
  assert.equal(r.error, undefined, r.error?.message);
  assert.equal(r.value, "reader");
});

test("T550: plugin-host shape — recorded parent_pid is a nearer opencode executable, shared serve root accepts", t => {
  const w = world(t);
  w.publish({ ...w.descriptor, parent_pid: w.host, parent_start: w.start(w.host) });
  assert.equal(w.exes.get(w.host), "/opt/homebrew/bin/opencode", "the plugin-host's exe is opencode, nearer than the serve");
  const r = timed(() => withCliIdentity(w.node, { cli: "opencode", session: "ses_t550" }, agent => agent));
  assert.equal(r.error, undefined, r.error?.message);
  assert.equal(r.value, "reader");
});

test("T550: different serve roots are refused at once, with no backoff", t => {
  const w = world(t);
  w.rows.push({ pid: SERVE2, ppid: 1, utc: "Sat Oct  3 09:02:00 2026" });
  w.exes.set(SERVE2, "/usr/local/bin/opencode");
  w.row(w.bind).ppid = SERVE2; // the MCP branch now tops out at a different serve
  w.reset();
  const r = timed(() => withCliIdentity(w.node, { cli: "opencode", session: "ses_t550" }, () => { throw new Error("operation must not run"); }));
  assert.equal(r.error?.code, "IDENTITY_NO_CALLER_LEASE", r.error?.message);
  assert.ok(r.ms < FIRST_RETRY, `no backoff (${Math.round(r.ms)} ms)`);
  assert.equal(w.reads.table, 1, "one attempt: a definite refusal is not retried");
});

test("T550: the shared root does not relax pid+birth checks on the recorded pids", async t => {
  await t.test("a reborn recorded parent is a refusal, not a new holder", st => {
    const w = world(st);
    w.row(w.bind).utc = "Sat Oct  3 09:04:00 2026"; // same pid, different birth
    w.reset();
    const r = timed(() => withCliIdentity(w.node, { cli: "opencode", session: "ses_t550" }, () => { throw new Error("operation must not run"); }));
    assert.equal(r.error?.code, "IDENTITY_NO_CALLER_LEASE", r.error?.message);
    assert.ok(r.ms < FIRST_RETRY, `no backoff (${Math.round(r.ms)} ms)`);
    assert.equal(w.reads.table, 1, "one attempt");
  });
  await t.test("a reborn MCP holder is a refusal even with a shared root", st => {
    const w = world(st);
    w.row(w.mcp).utc = "Sat Oct  3 09:03:00 2026";
    w.reset();
    const r = timed(() => withCliIdentity(w.node, { cli: "opencode", session: "ses_t550" }, () => { throw new Error("operation must not run"); }));
    assert.equal(r.error?.code, "IDENTITY_NO_CALLER_LEASE", r.error?.message);
    assert.ok(r.ms < FIRST_RETRY, `no backoff (${Math.round(r.ms)} ms)`);
    assert.equal(w.reads.table, 1, "one attempt");
  });
});

test("T550: a null serve root on either side is refused at once", async t => {
  await t.test("broken chain on both sides (serve row gone)", st => {
    const w = world(st);
    w.rows.splice(w.rows.findIndex(r => r.pid === SERVE), 1);
    w.reset();
    const r = timed(() => withCliIdentity(w.node, { cli: "opencode", session: "ses_t550" }, () => { throw new Error("operation must not run"); }));
    assert.equal(r.error?.code, "IDENTITY_NO_CALLER_LEASE", r.error?.message);
    assert.ok(r.ms < FIRST_RETRY, `no backoff (${Math.round(r.ms)} ms)`);
  });
  await t.test("broken chain on the requester side only (tool row gone)", st => {
    const w = world(st);
    w.rows.splice(w.rows.findIndex(r => r.pid === TOOL), 1);
    w.reset();
    const r = timed(() => withCliIdentity(w.node, { cli: "opencode", session: "ses_t550" }, () => { throw new Error("operation must not run"); }));
    assert.equal(r.error?.code, "IDENTITY_NO_CALLER_LEASE", r.error?.message);
    assert.ok(r.ms < FIRST_RETRY, `no backoff (${Math.round(r.ms)} ms)`);
  });
});

test("T550: a non-opencode descriptor does not get the root-equality acceptance", t => {
  const w = world(t, "kimi");
  const r = timed(() => withCliIdentity(w.node, { cli: "kimi", session: "ses_t550" }, () => { throw new Error("operation must not run"); }));
  assert.equal(r.error?.code, "IDENTITY_NO_CALLER_LEASE", r.error?.message);
  assert.ok(r.ms < FIRST_RETRY, `no backoff (${Math.round(r.ms)} ms)`);
  assert.equal(w.reads.table, 1, "one attempt");
});

test("T550 PIN: nested opencode serves — both ends top out at the OUTERMOST opencode executable and are accepted", t => {
  // Topmost-root semantics intentionally place a serve under another opencode executable in the same
  // authority domain: the live repro showed a session's recorded parent can sit anywhere in its branch
  // (raw intermediate or a nearer opencode host), so only the topmost opencode executable is stable on
  // both sides. A nearer-ancestor rule would refuse this topology. Security is unchanged: any
  // descendant of the topmost opencode executable may act as the session, the same trust model as the
  // historical "any descendant of parent_pid" walk; the session is still disambiguated by --session.
  const w = world(t);
  w.rows.push({ pid: TOP, ppid: 1, utc: "Sat Oct  3 07:00:00 2026" });
  w.exes.set(TOP, "/opt/homebrew/bin/opencode"); // the serve now runs under another opencode executable
  w.row(w.serve).ppid = TOP;
  w.reset();
  const r = timed(() => withCliIdentity(w.node, { cli: "opencode", session: "ses_t550" }, agent => agent));
  assert.equal(r.error, undefined, r.error?.message);
  assert.equal(r.value, "reader");
});
