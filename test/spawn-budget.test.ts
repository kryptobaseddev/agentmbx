// T341 / T591 AC3: process-spawn budget. After warm-up a steady-state tool call starts nothing, including no macOS
// ps. An idle `agentmbx watch` spawns nothing, and the OpenCode plugin's post-tool hook starts no node while nothing changed.
// Claude's post-tool wrapper is guarded with node absent from PATH in hooks.test.ts (T342).
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { MbxNode } from "../src/node.ts";
import { liveWatcher } from "../src/wake.ts";
import { opencodePluginSource } from "../src/setup.ts";
import { posttoolLastPath, posttoolMarkerPath, readPostToolMarker, writePostToolLast } from "../src/posttool.ts";
import { version } from "../src/version.ts";
import { bindWakeLease } from "./helpers/wake-lease.ts";

const TRACER = pathToFileURL(resolve("test/helpers/spawn-tracer.mjs")).href;
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
async function until(pred: () => boolean, ms = 10_000): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (!pred() && Date.now() < deadline) await sleep(25);
  return pred();
}
type Trace = { pid: number; at: number; fn: string; file: string; argv: string[] };
const traces = (path: string): Trace[] => existsSync(path) ? readFileSync(path, "utf8").trim().split("\n").filter(Boolean).map(l => JSON.parse(l)) : [];

function traced(t: TestContext, cli: string) {
  const home = mkdtempSync(join(tmpdir(), "mbx-t341-")), log = join(home, "spawn-trace.jsonl");
  const env = { ...process.env, AGENTMBX_DEV: "1", MBX_HOME: home, MBX_CLI: cli, MBX_AGENT: "worker", MBX_NO_DESKTOP: "1", MBX_DEBUG: "",
    NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --import ${TRACER}`.trim(), MBX_SPAWN_TRACE: log } as Record<string, string>;
  for (const key of Object.keys(env)) if (/^(MBX_MCP_|CLAUDE_CODE_|CODEX_|CLEO_)/.test(key)) delete env[key];
  t.after(() => rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  return { home, log, env };
}

for (const cli of ["claude", "kimi"]) test(`T341 ${cli}: steady-state MCP tool calls start no process`, { timeout: 120_000 }, async t => {
  const { log, env } = traced(t, cli);
  const c = new Client({ name: `t341-${cli}`, version: "1" });
  const transport = new StdioClientTransport({ command: process.execPath, args: [resolve("bin/agentmbx.js"), "mcp"], env });
  t.after(async () => { await c.close().catch(() => {}); });
  await c.connect(transport);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r = await c.callTool({ name, arguments: args });
    assert.notEqual(r.isError, true, `${name}: ${JSON.stringify(r.content)}`);
    return r.structuredContent as Record<string, unknown> | undefined;
  };
  // Warm-up: startup, binding and the first evidence reads may spawn; they are reported, not asserted.
  assert.equal((await call("mbx_whoami"))?.agent, "worker");
  await call("mbx_inbox");
  await sleep(500);
  const warm = traces(log);
  t.diagnostic(`T341 ${cli} warm-up spawns: ${warm.length} ${JSON.stringify(warm.map(s => `${s.fn} ${s.file.split("/").pop()} ${s.argv.join(" ")}`))}`);
  // Steady state: three rounds of the everyday tools, each round past the 2 s process-table cache window.
  for (let round = 0; round < 3; round++) {
    await call("mbx_whoami");
    await call("mbx_inbox");
    const sent = await call("mbx_send", { to: ["worker"], subject: `t341 ${round}`, body: "steady state", kind: "status" });
    await call("mbx_read", { ids: [String(sent?.id)] });
    await call("mbx_ack", { ids: [String(sent?.id)], did: "t341 steady-state probe" });
    await call("mbx_agents");
    await sleep(2_500);
  }
  const steady = traces(log).slice(warm.length);
  t.diagnostic(`T341 ${cli} steady-state spawns over 18 calls: ${steady.length} ${JSON.stringify(steady.map(s => `${s.file} ${s.argv.join(" ")}`))}`);
  // T591 AC3: warm-up may spawn. After it, macOS and Linux both stay at zero. A ps here is a regression.
  assert.deepEqual(steady, [], `steady-state tool calls spawned a process: ${JSON.stringify(steady)}`);
});

test("T341 an idle agentmbx watch starts no process after startup", { timeout: 120_000 }, async t => {
  const { home, log, env } = traced(t, "kimi");
  const n = new MbxNode(home, { host: "alpha" });
  const c = new Client({ name: "t341-watch", version: "1" });
  t.after(async () => { await c.close().catch(() => {}); n.close(); });
  await c.connect(new StdioClientTransport({ command: process.execPath, args: [resolve("bin/agentmbx.js"), "mcp"], env }));
  await c.callTool({ name: "mbx_whoami", arguments: {} });
  const w = spawn(process.execPath, [resolve("bin/agentmbx.js"), "watch"], { env: { ...env, MBX_AGENT: "", MBX_WATCH_INTERVAL_MS: "200" }, stdio: "ignore" });
  t.after(() => { w.kill("SIGKILL"); });
  assert.ok(await until(() => liveWatcher(n, "worker")), "the watcher registers");
  n.store.db.prepare("UPDATE identity_leases SET heartbeat_at=? WHERE name='worker'").run(Date.now()); // anchor the idle window
  const started = traces(log).filter(s => s.pid === w.pid).length;
  await sleep(6_000); // ~30 ticks inside one staleness window
  assert.equal(w.exitCode, null, "the watcher is still watching");
  const idle = traces(log).filter(s => s.pid === w.pid).slice(started);
  assert.deepEqual(idle, [], `~30 idle watch ticks started processes: ${JSON.stringify(idle)}`);
  t.diagnostic(`T341 watch startup spawns: ${started}`);
});

test("T341 OpenCode post-tool starts node only when the decision can change (delivery or bind)", { timeout: 60_000 }, async t => {
  const home = mkdtempSync(join(tmpdir(), "mbx-t341-oc-")), dir = mkdtempSync(join(tmpdir(), "mbx-t341-plugin-"));
  const n = new MbxNode(home, { host: "alpha" });
  const g = globalThis as { __mbxSpawn?: unknown; __mbxWakePort?: string | null };
  const saved = { home: process.env.MBX_HOME, spawn: g.__mbxSpawn, port: g.__mbxWakePort };
  t.after(() => {
    if (saved.home === undefined) delete process.env.MBX_HOME; else process.env.MBX_HOME = saved.home;
    g.__mbxSpawn = saved.spawn; g.__mbxWakePort = saved.port;
    n.close();
    for (const d of [home, dir]) rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  process.env.MBX_HOME = home;
  g.__mbxWakePort = null;
  const sid = "ses_t341budget";
  bindWakeLease(n, { agent: "worker", cli: "opencode", session_id: sid, pid: process.pid });
  assert.ok(readPostToolMarker(home, "opencode", sid), "an opencode bind writes the fast-path marker");
  // The stub stands in for the full `agentmbx hook post-tool --cli opencode`: like the real one (cli.ts posttoolDone) it
  // records the marker it processed in .last. The real hook's .last write is covered below.
  const spawned: string[] = [];
  g.__mbxSpawn = (_bin: string[], args: string[], _input: string, cb: (out: string) => void) => {
    spawned.push(args[1]);
    const marker = readPostToolMarker(home, "opencode", sid);
    if (args[1] === "post-tool" && marker !== null) writePostToolLast(home, "opencode", sid, marker);
    cb("");
  };
  const file = join(dir, "agentmbx.ts");
  writeFileSync(file, opencodePluginSource(["/nonexistent/agentmbx"], version()));
  const mod = await import(pathToFileURL(file).href) as { AgentMBXHooks: (ctx: unknown) => Promise<Record<string, (input: unknown) => Promise<void>>> };
  const hooks = await mod.AgentMBXHooks({ directory: "/work" });
  const tool = async (times: number) => { for (let i = 0; i < times; i++) await hooks["tool.execute.after"]({ sessionID: sid }); };
  const postTool = () => spawned.filter(e => e === "post-tool").length;

  await tool(1);
  assert.equal(postTool(), 1, "the first tool call after a bind runs the full hook once");
  await tool(10);
  assert.equal(postTool(), 1, "10 steady-state tool calls start no node");
  n.send({ from: "peer", to: ["worker"], subject: "s", body: "b", kind: "request" });
  await tool(5);
  assert.equal(postTool(), 2, "a delivery bumps the marker: exactly one full run, then steady again");
  bindWakeLease(n, { agent: "worker", cli: "opencode", session_id: sid, pid: process.pid });
  await tool(5);
  assert.equal(postTool(), 3, "a rebind bumps the marker: exactly one full run");
  writeFileSync(posttoolLastPath(home, "opencode", sid), "");
  writeFileSync(posttoolMarkerPath(home, "opencode", sid), "");
  await tool(2);
  assert.equal(postTool(), 5, "an empty marker is doubt: every call runs the full hook");
  // A path-shaped id must never select another file, even one whose marker and last agree.
  writeFileSync(join(home, "posttool", "sid.marker"), "same"); writeFileSync(join(home, "posttool", "sid.last"), "same");
  await hooks["tool.execute.after"]({ sessionID: "bad/../sid" });
  assert.equal(postTool(), 6, "an unusable session id is doubt too");
});

test("T341 the real opencode post-tool hook records the marker it processed", { timeout: 60_000 }, t => {
  const home = mkdtempSync(join(tmpdir(), "mbx-t341-hook-"));
  const n = new MbxNode(home, { host: "alpha" });
  t.after(() => { n.close(); rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
  const sid = "ses_t341hook";
  bindWakeLease(n, { agent: "worker", cli: "opencode", session_id: sid, pid: process.pid });
  const marker = readPostToolMarker(home, "opencode", sid);
  assert.ok(marker);
  const r = spawnSync(process.execPath, [resolve("bin/agentmbx.js"), "hook", "post-tool", "--cli", "opencode"], {
    input: JSON.stringify({ session_id: sid, cwd: process.cwd() }), encoding: "utf8", timeout: 20_000,
    env: { ...process.env, MBX_HOME: home, AGENTMBX_DEV: "1", MBX_AGENT: "" },
  });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(readFileSync(posttoolLastPath(home, "opencode", sid), "utf8"), marker, "the plugin's next call can take the fast path");
});
