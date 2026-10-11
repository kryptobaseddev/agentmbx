import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { _resetEvidenceCacheForTests, inspectLeaseProcess, type ProcessEvidence } from "../src/identity-leases.ts";
import { mcpOrphanCensus, mcpOrphanCheck } from "../src/mcp-lifecycle.ts";
import { procSeams, procTable, recordedStartMatches } from "../src/proc.ts";
import { doctor } from "../src/doctor.ts";

const moduleUrl = pathToFileURL(fileURLToPath(new URL("../src/mcp-lifecycle.ts", import.meta.url))).href;
const fixture = `import { startMcpLifecycle, recordMcpGeneration } from ${JSON.stringify(moduleUrl)};
import { procSeams } from ${JSON.stringify(new URL("../src/proc.ts", import.meta.url).href)};
import { spawn } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
const life = startMcpLifecycle(process.env.MBX_HOME);
if (process.env.FAIL_PS) { procSeams.platform = 'darwin'; procSeams.ps = () => { throw new Error('inspection unavailable'); }; }
life.watchClient({ pid: Number(process.env.MBX_MCP_PROVIDER_PID), start: process.env.MBX_MCP_PROVIDER_START });
life.onShutdown(() => {
  appendFileSync(process.env.MBX_HOME + '/cleanup', process.pid + '\\n');
  if (process.env.CLEANUP_FAIL) throw new Error('cleanup failed');
});
const input = createInterface({ input: process.stdin });
input.on('line', line => {
  if (line === 'ping') process.stdout.write('pong ' + process.pid + '\\n');
  if (line === 'handover') {
    const child = spawn(process.execPath, [process.argv[1]], { stdio: 'inherit', env: { ...process.env, MBX_MCP_REEXEC: '1', MBX_MCP_ORIGINAL_PID: String(process.pid) } });
    recordMcpGeneration(process.env.MBX_HOME, process.pid, { pid: child.pid, start: null });
    life.retireToProxy(); input.close(); process.stdin.pause();
    process.stdout.write('child ' + child.pid + '\\n');
  }
  if (line === 'handover-pending') {
    life.retireToProxy(); input.close(); process.stdin.pause();
    process.on('SIGTERM', () => {});
    process.stdout.write('pending\\n');
  }
  if (line === 'reused-generation') {
    recordMcpGeneration(process.env.MBX_HOME, process.pid, { pid: Number(process.env.MBX_MCP_PROVIDER_PID), start: 'ps-utc:Mon Oct 12 11:00:00 2026' });
    life.retireToProxy(); input.close(); process.stdin.pause();
    process.stdout.write('reused\\n');
  }
});
process.stdout.write('ready ' + process.pid + '\\n');
`;

async function until(check: () => boolean, label: string, ms = 9000) {
  const end = Date.now() + ms;
  while (!check() && Date.now() < end) await new Promise(r => setTimeout(r, 25));
  assert.ok(check(), label);
}

function world(t: TestContext) {
  const home = mkdtempSync(join(tmpdir(), "mbx-client-life-")), script = join(home, "fixture.mjs");
  writeFileSync(script, fixture);
  const children: ChildProcess[] = [], descendants = new Map<number, string>();
  t.after(async () => {
    for (const p of children) {
      p.stdin?.destroy(); p.stdout?.destroy(); p.stderr?.destroy();
      if (p.exitCode === null && p.signalCode === null) p.kill("SIGKILL");
    }
    for (const [pid, start] of descendants) {
      const current = inspectLeaseProcess(pid);
      if (current.alive === true && current.start && recordedStartMatches(start, current.start)) {
        try { process.kill(pid, "SIGKILL"); } catch { /* Owned fixture already exited. */ }
      }
    }
    await Promise.all(children.map(p => p.exitCode !== null || p.signalCode !== null ? undefined : new Promise<void>(r => p.once("exit", () => r()))));
    rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  const run = async (extra: NodeJS.ProcessEnv = {}) => {
    const birth = inspectLeaseProcess(process.pid).start;
    assert.ok(birth);
    const env: NodeJS.ProcessEnv = { ...process.env, MBX_HOME: home, MBX_MCP_PROVIDER_PID: String(process.pid), MBX_MCP_PROVIDER_START: birth, ...extra };
    delete env.MBX_MCP_REEXEC;
    const p = spawn(process.execPath, [script], { env });
    children.push(p);
    let stdout = "", stderr = "";
    p.stdout.on("data", b => { stdout += b; }); p.stderr.on("data", b => { stderr += b; });
    p.stdin.on("error", () => {});
    await until(() => stdout.includes(`ready ${p.pid}\n`), `fixture ready: ${stderr}`);
    return { p, output: () => stdout, errors: () => stderr };
  };
  const duplicateWriter = (p: ChildProcessWithoutNullStreams) => {
    const raw = (p.stdin as unknown as { _handle: { fd: number } })._handle.fd;
    // Inherit the socket directly: Linux cannot reopen it through /dev/fd.
    const writer = spawn(process.execPath, ["-e", "process.stdin.pipe(require('node:fs').createWriteStream(null, { fd: 3 }));"], { stdio: ["pipe", "pipe", "pipe", raw] });
    children.push(writer);
    assert.ok(writer.stdin);
    writer.stdin.on("error", () => {});
    return writer.stdin;
  };
  const remember = async (pid: number) => {
    let start: string | null = null;
    await until(() => { start = inspectLeaseProcess(pid).start; return !!start; }, "owned generation birth");
    descendants.set(pid, start!);
  };
  return { home, children, run, duplicateWriter, remember };
}

test("client EOF exits within 10s and cleans up once", async t => {
  const w = world(t), { p } = await w.run();
  const started = Date.now(); p.stdin.end();
  await until(() => p.exitCode !== null, "EOF exit");
  assert.equal(p.exitCode, 0); assert.ok(Date.now() - started < 10_000);
  assert.equal(readFileSync(join(w.home, "cleanup"), "utf8"), `${p.pid}\n`);
});

test("output EPIPE exits while the client input stays open", async t => {
  const w = world(t), { p } = await w.run();
  p.stdout.destroy(); p.stdin.write("ping\n");
  await until(() => p.exitCode !== null, "EPIPE exit");
  assert.equal(p.exitCode, 0);
});

test("recorded client death exits within 10s even when another process holds its pipe", async t => {
  const w = world(t);
  const client = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"]);
  w.children.push(client);
  let birth: string | null = null;
  await until(() => { birth = inspectLeaseProcess(client.pid!).start; return !!birth; }, "client birth");
  const { p } = await w.run({ MBX_MCP_PROVIDER_PID: String(client.pid), MBX_MCP_PROVIDER_START: birth! });
  const started = Date.now(); client.kill("SIGTERM");
  // The test process retains p.stdin, so EOF cannot be the reason the server exits.
  await until(() => p.exitCode !== null, "dead client exit");
  assert.equal(p.exitCode, 0); assert.ok(Date.now() - started < 10_000);
});

test("proxy death preserves a reparented generation's live client pipe, and EOF then exits", { skip: process.platform === "win32" }, async t => {
  const w = world(t), { p, output, errors } = await w.run(), writer = w.duplicateWriter(p);
  p.stdin.write("handover\n");
  await until(() => /child (\d+)/.test(output()), `generation spawn: ${errors()}`);
  const child = Number(/child (\d+)/.exec(output())![1]);
  await until(() => output().includes(`ready ${child}\n`), "generation ready");
  await w.remember(child);
  await until(() => existsSync(join(w.home, "mcp-lifecycle", `${p.pid}.json`)), "proxy polls the new generation before reparenting");
  assert.equal(p.exitCode, null);
  p.kill("SIGTERM");
  await until(() => p.exitCode !== null, "proxy SIGTERM exit");
  await until(() => procTable(0).get(child)?.ppid === 1, "generation reparented to PID 1");
  writer.write("ping\n");
  await until(() => output().includes(`pong ${child}\n`), `reparented generation serves: ${errors()}`);
  writer.end();
  await until(() => inspectLeaseProcess(child).alive === false, "reparented generation exits on client EOF");
});

test("a generation exits when proxy death also closes the client pipe", { skip: process.platform === "win32" }, async t => {
  const w = world(t), { p, output } = await w.run();
  p.stdin.write("handover\n");
  await until(() => /child (\d+)/.test(output()), "generation spawned");
  const child = Number(/child (\d+)/.exec(output())![1]);
  await until(() => output().includes(`ready ${child}\n`), "generation ready");
  await w.remember(child);
  p.stdin.end(); p.kill("SIGTERM");
  await until(() => inspectLeaseProcess(child).alive === false, "generation lost proxy and pipe");
});

test("EOF exits a paused proxy after its current generation stops", async t => {
  const w = world(t), { p, output } = await w.run();
  p.stdin.write("handover\n");
  await until(() => /child (\d+)/.test(output()), "generation spawned");
  const child = Number(/child (\d+)/.exec(output())![1]);
  await until(() => output().includes(`ready ${child}\n`), "generation ready");
  await w.remember(child);
  const started = Date.now(); p.stdin.end();
  await until(() => p.exitCode !== null, "paused proxy exits after generation EOF");
  assert.equal(p.exitCode, 0); assert.ok(Date.now() - started < 10_000);
});

test("SIGTERM during pending handover exits despite another signal handler and cleanup failure", async t => {
  const w = world(t), { p, output, errors } = await w.run({ CLEANUP_FAIL: "1" });
  p.stdin.write("handover-pending\n");
  await until(() => output().includes("pending\n"), "handover pending");
  p.kill("SIGTERM");
  await until(() => p.exitCode !== null, "SIGTERM exit");
  assert.equal(p.exitCode, 143); assert.match(errors(), /cleanup failed/);
});

test("SIGTERM before any client request exits", async t => {
  const w = world(t), { p } = await w.run();
  p.kill("SIGTERM");
  await until(() => p.exitCode !== null, "startup SIGTERM exit");
  assert.equal(p.exitCode, 143);
});

test("unavailable process inspection keeps a live client serving until EOF", async t => {
  const w = world(t), { p, output } = await w.run({ FAIL_PS: "1" });
  await until(() => existsSync(join(w.home, "mcp-lifecycle", `${p.pid}.json`)), "unknown evidence was polled");
  p.stdin.write("ping\n");
  await until(() => output().includes(`pong ${p.pid}\n`), "unknown evidence does not disconnect a live client");
  p.stdin.end();
  await until(() => p.exitCode !== null, "EOF still exits with unknown evidence");
  assert.equal(p.exitCode, 0);
});

test("a reused generation PID cannot keep its paused proxy alive", async t => {
  const w = world(t), { p, output } = await w.run();
  p.stdin.write("reused-generation\n");
  await until(() => output().includes("reused\n"), "recorded reused generation");
  await until(() => p.exitCode !== null, "generation birth mismatch exits proxy");
  assert.equal(p.exitCode, 0);
});

function censusWorld(t: TestContext) {
  const home = mkdtempSync(join(tmpdir(), "mbx-orphan-census-"));
  mkdirSync(join(home, "mcp-lifecycle"));
  const previous = { ...procSeams };
  t.after(() => { Object.assign(procSeams, previous); _resetEvidenceCacheForTests(); rmSync(home, { recursive: true, force: true }); });
  procSeams.platform = "darwin"; _resetEvidenceCacheForTests();
  const start = "ps-utc:Mon Oct 12 12:00:00 2026";
  const record = (pid: number, client: number, overrides = {}) => {
    const body = JSON.stringify({ v: 1, pid, start, client: { pid: client, start }, role: "generation", ...overrides });
    writeFileSync(join(home, "mcp-lifecycle", `${pid}.json`), body);
    return body;
  };
  return { home, start, record };
}

test("doctor deduplicates orphans, sums RSS in bytes and retains unknown/legacy records without killing", t => {
  const w = censusWorld(t), body = w.record(900001, 990000);
  w.record(900002, 900101); // A live reparented generation is not an orphan.
  w.record(900004, 990000, { start: "ps-utc:Mon Oct 12 11:00:00 2026" }); // PID reuse.
  w.record(900005, 990000);
  procSeams.ps = args => args.join().includes("rss")
    ? "900001 2048 node /tmp/agentmbx.js mcp\n900001 2048 node /tmp/agentmbx.js mcp\n900002 4096 node --no-warnings /tmp/agentmbx.js mcp\n900003 1000 agentmbx mcp\n900004 1000 agentmbx mcp\n900005 ? agentmbx mcp\n900006 9000 node /tmp/cleo.js docs --content agentmbx mcp\n900007 9000 sh -c echo agentmbx mcp\n"
    : "";
  const inspect = (pids: number[]) => new Map<number, ProcessEvidence>(pids.map(pid => [pid, { alive: pid !== 990000, start: pid === 990000 ? null : w.start }]));
  assert.deepEqual(mcpOrphanCensus(w.home, inspect), { total: 5, orphans: 2, orphanRssBytes: 2 * 1024 ** 2, unknown: 2, unknownMemory: 1, unavailable: false });
  const check = mcpOrphanCheck(w.home, inspect);
  assert.equal(check.level, "warn"); assert.match(check.label, /2 \(2\.0 MiB RSS \+ 1 unknown memory/);
  assert.match(check.label, /nothing killed/);
  assert.equal(readFileSync(join(w.home, "mcp-lifecycle", "900001.json"), "utf8"), body);
});

test("failed process inspection never reports clean orphans or kills a live fixture", t => {
  const w = censusWorld(t); w.record(900001, 990000);
  procSeams.ps = args => {
    if (args.join().includes("rss")) return "900001 2048 agentmbx mcp\n";
    throw new Error("unavailable process evidence");
  };
  const inspect = (pids: number[]) => new Map<number, ProcessEvidence>(pids.map(pid => [pid, { alive: null, start: null }]));
  assert.equal(mcpOrphanCensus(w.home, inspect).unknown, 1);
  assert.equal(mcpOrphanCensus(w.home, inspect).orphans, 0);
  procSeams.ps = () => { throw new Error("inventory unavailable"); };
  assert.equal(mcpOrphanCensus(w.home).unavailable, true);
  assert.match(mcpOrphanCheck(w.home).label, /unavailable/);
});

test("empty or malformed inventory is unavailable; malformed lifecycle records stay unknown", t => {
  const w = censusWorld(t), inspect = (pids: number[]) => new Map<number, ProcessEvidence>(pids.map(pid => [pid, { alive: true, start: w.start }]));
  for (const listing of ["", "not a process inventory"]) {
    procSeams.ps = () => listing;
    assert.equal(mcpOrphanCensus(w.home, inspect).unavailable, true);
  }
  writeFileSync(join(w.home, "mcp-lifecycle", "900001.json"), "{" + " ".repeat(4096));
  procSeams.ps = () => "900001 1024 agentmbx mcp\n";
  assert.equal(mcpOrphanCensus(w.home, inspect).unknown, 1);
  assert.equal(mcpOrphanCensus(w.home, inspect).orphans, 0);
});

test("doctor includes the read-only orphan census without a configured harness or initialized host", async t => {
  const w = censusWorld(t), body = w.record(900001, 990000);
  procSeams.ps = () => { throw new Error("inventory unavailable"); };
  const checks = await doctor({ home: w.home, cmd: ["agentmbx"], which: () => null, useClis: false }, w.home);
  assert.equal(checks.filter(c => /MCP orphan census unavailable/.test(c.label)).length, 1);
  assert.equal(readFileSync(join(w.home, "mcp-lifecycle", "900001.json"), "utf8"), body);
});
