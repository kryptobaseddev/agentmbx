import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { MbxNode } from "../src/node.ts";
import { Store, withStoreBusyTimeout } from "../src/store.ts";
import { writeSessionTaint } from "../src/session-taint.ts";
import { mcpStarting } from "../src/mcp-startup.ts";
import { procTable } from "../src/proc.ts";

const BIN = join(import.meta.dirname, "../bin/agentmbx.js");
const pause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "mbx-startup-")), home = join(root, "mail");
  const node = new MbxNode(home, { host: "alpha" });
  for (let i = 0; i < 20; i++) node.send({ from: "sender", to: ["reader"], subject: `mail ${i}`, body: "populated startup fixture" });
  node.close();
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: join(root, "home"), XDG_CONFIG_HOME: join(root, "config"),
    XDG_DATA_HOME: join(root, "data"), XDG_CACHE_HOME: join(root, "cache"), XDG_STATE_HOME: join(root, "state"),
    MBX_HOME: home, MBX_AGENT: "reader", MBX_CLI: "claude", MBX_NO_DESKTOP: "1", MBX_SESSION_SOCKET: "0",
    AGENTMBX_DEV: process.env.MBX_STARTUP_BENCH_DIST === "1" ? "" : "1" };
  for (const key of Object.keys(env)) if (/^(?:CLAUDE_|CODEX_|CLEO_|ORCA_|MBX_MCP_|MBX_CHANNEL)/.test(key)) delete env[key];
  mkdirSync(env.HOME!, { recursive: true });
  const children: ChildProcessWithoutNullStreams[] = [];
  t.after(async () => {
    await Promise.all(children.map(async child => {
      child.stdin.end();
      const exited = new Promise<void>(resolve => { if (child.exitCode !== null || child.signalCode !== null) resolve(); else child.once("exit", () => resolve()); });
      await Promise.race([exited, pause(500)]);
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
      await Promise.race([exited, pause(1000)]);
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await exited;
    }));
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  const start = (preload?: string) => {
    const started = performance.now();
    const child = spawn(process.execPath, [...(preload ? ["--import", preload] : []), BIN, "mcp"], { env });
    children.push(child);
    let stderr = "", buffer = "";
    child.stderr.on("data", data => { stderr += data; });
    type RpcResult = { result?: { tools?: { name: string }[]; structuredContent?: { agent?: string; id?: string } }; error?: unknown };
    const pending = new Map<number, { resolve: (result: RpcResult) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
    child.stdout.on("data", data => {
      buffer += data;
      for (;;) {
        const end = buffer.indexOf("\n"); if (end < 0) break;
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
        const reply = JSON.parse(line) as RpcResult & { id?: number };
        const call = reply.id === undefined ? undefined : pending.get(reply.id);
        if (call) { clearTimeout(call.timer); pending.delete(reply.id!); call.resolve(reply); }
      }
    });
    child.on("exit", (code, signal) => {
      for (const call of pending.values()) { clearTimeout(call.timer); call.reject(new Error(`MCP exited ${code}/${signal}: ${stderr}`)); }
      pending.clear();
    });
    const rpc = (id: number, method: string, params?: unknown, timeoutMs = 20_000) => new Promise<RpcResult>((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${method} timeout: ${stderr}`)); }, timeoutMs);
      pending.set(id, { resolve, reject, timer });
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, ...(params ? { params } : {}) }) + "\n");
    });
    const initialized = rpc(1, "initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "startup-test", version: "1" } })
      .then(reply => {
        assert.equal(reply.error, undefined, stderr);
        const latencyMs = performance.now() - started;
        child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
        return latencyMs;
      });
    return { child, initialized, rpc, stderr: () => stderr };
  };
  const holdLock = async (ms: number) => {
    const script = `import {DatabaseSync} from 'node:sqlite';
      const db=new DatabaseSync(process.argv[1]); db.exec('BEGIN IMMEDIATE'); process.stdout.write('locked\\n');
      const timer=setTimeout(()=>{db.exec('COMMIT');db.close();process.exit(0)},Number(process.argv[2]));
      process.stdin.resume(); process.stdin.on('end',()=>{clearTimeout(timer);db.exec('ROLLBACK');db.close();process.exit(0)});`;
    const child = spawn(process.execPath, ["--input-type=module", "-e", script, join(home, "mbx.db"), String(ms)], { env });
    children.push(child);
    await new Promise<void>((resolve, reject) => { child.stdout.once("data", () => resolve()); child.once("exit", code => reject(new Error(`lock holder exited ${code}`))); });
    return child;
  };
  const session = (id: string) => {
    const dir = join(env.HOME!, ".claude", "sessions"); mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${process.pid}.json`), JSON.stringify({ sessionId: id }));
  };
  const hook = (id: string) => {
    const child = spawn(process.execPath, [BIN, "hook", "session-start", "--cli", "claude"], { env }); children.push(child);
    let stdout = "", stderr = "";
    child.stdout.on("data", data => { stdout += data; }); child.stderr.on("data", data => { stderr += data; });
    child.stdin.end(JSON.stringify({ session_id: id, cwd: process.cwd() }));
    return new Promise<{ code: number | null; stdout: string; stderr: string }>(resolve => child.once("exit", code => resolve({ code, stdout, stderr })));
  };
  return { root, home, start, holdLock, session, hook };
}

for (const recover of [true, false]) test(`a separate session-start hook ${recover ? "waits for the resumed identity" : "bounds its wait and reports resuming"}`, { timeout: 10_000 }, async t => {
  const f = fixture(t), id = `startup-hook-${recover}`, release = join(f.root, "resume-release"), preload = join(f.root, "hold-resume.mjs");
  f.session(id);
  writeFileSync(preload, `import {DatabaseSync} from 'node:sqlite'; import {existsSync} from 'node:fs';
    const prepare=DatabaseSync.prototype.prepare;
    DatabaseSync.prototype.prepare=function(sql){const statement=prepare.call(this,sql);
      if(sql.includes('INSERT INTO identity_leases')){const run=statement.run;
        statement.run=function(...args){if(!existsSync(${JSON.stringify(release)}))throw Object.assign(new Error('database is locked'),{code:'SQLITE_BUSY'});
          return run.apply(this,args)};}return statement;};`);
  const server = f.start(preload); await server.initialized;
  procTable(0);
  assert.equal(mcpStarting(f.home, "claude", process.pid), true, "the marker must be visible before identity setup finishes");
  assert.equal(mcpStarting(f.home, "codex", process.pid), false, "another provider cannot delay this hook");
  assert.equal(mcpStarting(f.home, "claude", 2_000_000_000), false, "another process tree cannot delay this hook");
  const started = performance.now(), hook = f.hook(id);
  if (recover) { await pause(600); writeFileSync(release, "ready"); }
  const result = await hook;
  assert.equal(result.code, 0, result.stderr);
  assert.ok(performance.now() - started < 3000, "the hook must not wait indefinitely for MCP readiness");
  assert.doesNotMatch(result.stdout, /no mailbox identity|action.*claim|action.*register/);
  if (recover) assert.match(result.stdout, /You are reader@alpha/);
  else { assert.match(result.stdout, /identity is still resuming/); writeFileSync(release, "ready"); }
  const who = await server.rpc(2, "tools/call", { name: "mbx_whoami", arguments: {} });
  assert.equal(who.result?.structuredContent?.agent, "reader");
  assert.equal(mcpStarting(f.home, "claude", process.pid), false, "ready removes the advisory marker");
});

test("initialize answers within 500ms during another process's 10s write lock, then startup recovers", { timeout: 25_000 }, async t => {
  const f = fixture(t), lock = await f.holdLock(10_000), server = f.start();
  const latency = await server.initialized;
  t.diagnostic(`initialize while writer locked: ${latency.toFixed(1)}ms`);
  assert.ok(latency < 500, `initialize took ${latency}ms`);
  const catalog = server.rpc(2, "tools/list");
  const identity = server.rpc(4, "tools/call", { name: "mbx_whoami", arguments: {} });
  let catalogReady = false, identityReady = false;
  void catalog.then(() => { catalogReady = true; }, () => {});
  void identity.then(() => { identityReady = true; }, () => {});
  await pause(300);
  assert.equal(catalogReady, false, "catalog must wait for mailbox setup instead of exposing placeholders");
  assert.equal(identityReady, false, "whoami must not claim an identity or policy level before readiness");
  assert.equal(server.child.exitCode, null, server.stderr());
  assert.equal((await server.rpc(3, "ping", undefined, 500)).error, undefined, "ping must remain usable during startup contention");
  await new Promise<void>(resolve => lock.once("exit", () => resolve()));
  const result = await catalog;
  assert.equal(result.error, undefined, server.stderr());
  assert.ok(result.result?.tools?.some(tool => tool.name === "mbx_whoami"));
  assert.ok(result.result?.tools?.some(tool => tool.name === "mbx_catchup"));
  const who = await identity;
  assert.equal(who.result?.structuredContent?.agent, "reader");
  assert.equal(server.child.exitCode, null, server.stderr());
});

test("store setup and identity resume perform no work before the initialize reply", async t => {
  const f = fixture(t), trace = join(f.root, "trace.jsonl"), preload = join(f.root, "trace.mjs");
  writeFileSync(preload, `import {DatabaseSync} from 'node:sqlite'; import {appendFileSync} from 'node:fs';
    const record=event=>appendFileSync(${JSON.stringify(trace)},JSON.stringify(event)+'\\n');
    const exec=DatabaseSync.prototype.exec;DatabaseSync.prototype.exec=function(sql){record({event:'sql',sql});return exec.call(this,sql)};
    const prepare=DatabaseSync.prototype.prepare;DatabaseSync.prototype.prepare=function(sql){
      record({event:'prepare',sql});const statement=prepare.call(this,sql);const run=statement.run;
      statement.run=function(...args){record({event:'run',sql});return run.apply(this,args)};return statement;
    };
    const write=process.stdout.write;process.stdout.write=function(chunk,...args){
      if(String(chunk).includes('"id":1')&&String(chunk).includes('"result"'))record({event:'initialize'});
      return write.call(this,chunk,...args);
    };`);
  const server = f.start(preload); await server.initialized;
  const who = await server.rpc(2, "tools/call", { name: "mbx_whoami", arguments: {} });
  assert.equal(who.result?.structuredContent?.agent, "reader");
  const events = readFileSync(trace, "utf8").trim().split("\n").map(line => JSON.parse(line)) as { event: string; sql?: string }[];
  const initialized = events.findIndex(e => e.event === "initialize");
  assert.equal(initialized, 0, JSON.stringify(events.slice(0, initialized + 1)));
  assert.ok(events.some(e => e.event === "run" && e.sql?.includes("identity_leases")), "resume must actually run after initialize");
});

test("a busy identity resume retries before serving whoami, without a false unbound result", async t => {
  const f = fixture(t), trace = join(f.root, "resume.txt"), preload = join(f.root, "busy-resume.mjs");
  writeFileSync(preload, `import {DatabaseSync} from 'node:sqlite'; import {appendFileSync} from 'node:fs';
    const prepare=DatabaseSync.prototype.prepare;let injected=false;
    DatabaseSync.prototype.prepare=function(sql){const statement=prepare.call(this,sql);
      if(sql.includes('INSERT INTO identity_leases')){const run=statement.run;
        statement.run=function(...args){appendFileSync(${JSON.stringify(trace)},'attempt\\n');
          if(!injected){injected=true;throw Object.assign(new Error('database is locked'),{code:'SQLITE_BUSY'})}
          return run.apply(this,args)};
      }return statement;
    };`);
  const server = f.start(preload); await server.initialized;
  const who = await server.rpc(2, "tools/call", { name: "mbx_whoami", arguments: {} });
  assert.equal(who.error, undefined, server.stderr());
  assert.equal(who.result?.structuredContent?.agent, "reader", "an early call must wait through resume contention");
  assert.ok(readFileSync(trace, "utf8").trim().split("\n").length >= 2, "identity resume must have retried");
});

test("an immediate send waits for persisted external taint to be restored during startup", async t => {
  const f = fixture(t), sessionId = "startup-tainted", root = Date.now(); f.session(sessionId);
  const store = new Store(f.home);
  writeSessionTaint(store, { v: 1, cli: "claude", session_id: sessionId, root, from: "scout@alpha", id: "outside-source",
    how: "declared", relay_depth: [] });
  store.close();
  const lock = await f.holdLock(2000), server = f.start(); await server.initialized;
  const send = server.rpc(2, "tools/call", { name: "mbx_send", arguments: { to: ["reader"], subject: "startup taint",
    body: "inherited outside content", origin: "agent" } });
  let answered = false; void send.then(() => { answered = true; }, () => {});
  await pause(100); assert.equal(answered, false, "send must wait for resume and taint restore");
  await new Promise<void>(resolve => lock.once("exit", () => resolve()));
  const result = await send; assert.equal(result.error, undefined, server.stderr());
  const id = result.result?.structuredContent?.id; assert.ok(id, JSON.stringify(result));
  const read = new Store(f.home);
  try {
    const row = read.db.prepare("SELECT envelope FROM messages WHERE id=?").get(id)!;
    const envelope = JSON.parse(String(row.envelope));
    assert.equal(envelope.meta.origin, "external");
    assert.equal(envelope.meta.external_source, "inherited");
    assert.equal(envelope.meta.external_since, new Date(root).toISOString());
  } finally { read.close(); }
});

test("a current Store opens without a schema write transaction while a writer holds the lock", t => {
  const f = fixture(t), writer = new DatabaseSync(join(f.home, "mbx.db"));
  t.after(() => writer.close()); writer.exec("BEGIN IMMEDIATE");
  const store = withStoreBusyTimeout(0, () => new Store(f.home));
  assert.equal(store.schemaVersion(), 3); assert.ok(store.get("schema-definition"));
  store.close(); writer.exec("ROLLBACK");
});

test("a legacy schema definition is upgraded once and then uses the read fast path", t => {
  const f = fixture(t), store = new Store(f.home);
  store.set("schema-definition", "older-definition"); store.close();
  const upgraded = new Store(f.home);
  assert.notEqual(upgraded.get("schema-definition"), "older-definition"); upgraded.close();
  const writer = new DatabaseSync(join(f.home, "mbx.db")); t.after(() => writer.close());
  writer.exec("BEGIN IMMEDIATE");
  const current = withStoreBusyTimeout(0, () => new Store(f.home)); current.close(); writer.exec("ROLLBACK");
});

test("closing the transport during startup contention exits without waiting for the writer", { timeout: 10_000 }, async t => {
  const f = fixture(t); await f.holdLock(10_000); const server = f.start(); await server.initialized;
  server.child.stdin.end();
  await Promise.race([new Promise<void>(resolve => server.child.once("exit", () => resolve())), pause(2000)]);
  assert.notEqual(server.child.exitCode, null, server.stderr());
});

// Opt in to the host-load benchmark with MBX_STARTUP_BENCH=1. Add MBX_STARTUP_BENCH_DIST=1
// after npm run build to measure the shipped dist launcher rather than Node's source type stripping.
test("60 concurrent cold starts on a populated store have p99 initialize under 2s", { skip: process.env.MBX_STARTUP_BENCH !== "1", timeout: 30_000 }, async t => {
  const f = fixture(t), servers = Array.from({ length: 60 }, () => f.start());
  const latencies = (await Promise.all(servers.map(server => server.initialized))).sort((a, b) => a - b);
  const p99 = latencies[Math.ceil(latencies.length * 0.99) - 1];
  t.diagnostic(JSON.stringify({ starts: latencies.length, p50_ms: latencies[29], p99_ms: p99, max_ms: latencies[59] }));
  assert.ok(p99 < 2000, `p99 initialize ${p99}ms exceeds 2s`);
});
