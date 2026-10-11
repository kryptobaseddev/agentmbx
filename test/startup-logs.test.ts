import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { doctor } from "../src/doctor.ts";
import { MCP_ERROR_LOG_BYTES, recentMcpStartupErrors, recordMcpStartupError } from "../src/logs.ts";

const ROOT = join(import.meta.dirname, ".."), ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z /;
function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "mbx-startup-log-"));
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  const env = { ...process.env, HOME: root, MBX_HOME: join(root, "mail"), MBX_CLI: "codex", AGENTMBX_DEV: "1" };
  for (const key of Object.keys(env)) if (/^(?:MBX_MCP_|CLAUDE_|CODEX_|CLEO_)/.test(key)) delete (env as NodeJS.ProcessEnv)[key];
  return { root, env, log: join(env.MBX_HOME, "mcp-errors.log") };
}
function entry(line: string) { assert.match(line, ISO); return JSON.parse(line.slice(25)) as { pid: number; cli: string; error: string }; }

test("daemon output timestamps physical lines without corrupting split bytes or callbacks", t => {
  const f = fixture(t), module = pathToFileURL(join(ROOT, "src/logs.ts")).href;
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", `import assert from 'node:assert/strict';
    import {timestampDaemonOutput} from ${JSON.stringify(module)}; timestampDaemonOutput();
    const bytes=Buffer.from('😀');let calls=0;
    assert.equal(typeof process.stdout.write('partial'),'boolean');process.stdout.write(' line\\nnext\\n\\n');
    process.stdout.write(bytes.subarray(0,2));process.stdout.write(bytes.subarray(2));
    process.stdout.write('\\n','utf8',()=>calls++);process.stderr.write('error\\nstack\\n',()=>calls++);
    setImmediate(()=>assert.equal(calls,2));`], { env: f.env, encoding: "utf8", timeout: 10_000 });
  assert.equal(child.status, 0, child.stderr);
  for (const output of [child.stdout, child.stderr]) for (const line of output.trimEnd().split("\n")) assert.match(line, ISO);
  assert.equal(child.stdout.replace(new RegExp(ISO.source, "gm"), ""), "partial line\nnext\n\n😀\n");
});

test("launcher import failure records one error and preserves stderr and a nonzero exit", t => {
  const f = fixture(t), install = join(f.root, "install");
  mkdirSync(join(install, "bin"), { recursive: true }); mkdirSync(join(install, "src"));
  writeFileSync(join(install, "package.json"), '{"type":"module"}');
  copyFileSync(join(ROOT, "bin/agentmbx.js"), join(install, "bin/agentmbx.js"));
  copyFileSync(join(ROOT, "src/logs.ts"), join(install, "src/logs.ts"));
  writeFileSync(join(install, "src/cli.ts"), "throw new Error('forced CLI import failure\\nsecond line');");
  const child = spawnSync(process.execPath, [join(install, "bin/agentmbx.js"), "mcp"], { env: f.env, encoding: "utf8", timeout: 10_000 });
  assert.equal(child.status, 1); assert.match(child.stderr, /forced CLI import failure/); assert.equal(child.stdout, "");
  const lines = readFileSync(f.log, "utf8").trimEnd().split("\n"); assert.equal(lines.length, 1);
  assert.deepEqual(entry(lines[0]), { pid: child.pid, cli: "codex", error: "forced CLI import failure\nsecond line" });
  rmSync(f.env.MBX_HOME, { recursive: true }); writeFileSync(f.env.MBX_HOME, "not a directory");
  const unwritable = spawnSync(process.execPath, [join(install, "bin/agentmbx.js"), "mcp"], { env: f.env, encoding: "utf8", timeout: 10_000 });
  assert.equal(unwritable.status, 1); assert.match(unwritable.stderr, /forced CLI import failure/);
});

for (const source of [true, false]) for (const logger of ["missing", "broken"]) for (const command of ["mcp", "daemon"])
  test(`${command} ${source ? "source" : "dist"} launcher preserves the original error with a ${logger} logger`, t => {
    const f = fixture(t), install = join(f.root, "install"), entry = join(install, source ? "src" : "dist");
    mkdirSync(join(install, "bin"), { recursive: true }); mkdirSync(entry);
    writeFileSync(join(install, "package.json"), '{"type":"module"}');
    copyFileSync(join(ROOT, "bin/agentmbx.js"), join(install, "bin/agentmbx.js"));
    writeFileSync(join(entry, source ? "cli.ts" : "cli.js"), "throw new Error('original entry failure');");
    if (logger === "broken") writeFileSync(join(entry, source ? "logs.ts" : "logs.js"), "throw new Error('bootstrap logger failure');");
    const child = spawnSync(process.execPath, [join(install, "bin/agentmbx.js"), command], { env: f.env, encoding: "utf8", timeout: 10_000 });
    assert.equal(child.status, 1); assert.match(child.stderr, /original entry failure/);
    assert.doesNotMatch(child.stderr, /bootstrap logger failure|ERR_MODULE_NOT_FOUND/);
    assert.equal(child.stdout, ""); assert.equal(existsSync(f.log), false);
  });

test("daemon bootstrap import failure timestamps every stderr line", t => {
  const f = fixture(t), install = join(f.root, "install");
  mkdirSync(join(install, "bin"), { recursive: true }); mkdirSync(join(install, "src"));
  writeFileSync(join(install, "package.json"), '{"type":"module"}');
  copyFileSync(join(ROOT, "bin/agentmbx.js"), join(install, "bin/agentmbx.js"));
  copyFileSync(join(ROOT, "src/logs.ts"), join(install, "src/logs.ts"));
  writeFileSync(join(install, "src/cli.ts"), "throw new Error('daemon import failure\\nsecond line');");
  const child = spawnSync(process.execPath, [join(install, "bin/agentmbx.js"), "daemon"], { env: f.env, encoding: "utf8", timeout: 10_000 });
  assert.equal(child.status, 1); assert.match(child.stderr, /daemon import failure/);
  for (const line of child.stderr.trimEnd().split("\n")) assert.match(line, ISO);
  assert.equal(existsSync(f.log), false);
});

test("runMcp records a connect failure once before initialize", t => {
  const f = fixture(t);
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", `
    import {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
    import {runMcp} from './src/mcp.ts';
    McpServer.prototype.connect=async()=>{await new Promise(resolve=>setTimeout(resolve,50));throw new Error('forced connect failure')};
    try {await runMcp()} catch(error) {console.error(error);process.exit(1)}`], { cwd: ROOT, env: f.env, encoding: "utf8", timeout: 10_000 });
  assert.equal(child.status, 1, child.stderr); assert.match(child.stderr, /forced connect failure/);
  const lines = readFileSync(f.log, "utf8").trimEnd().split("\n"); assert.equal(lines.length, 1);
  assert.deepEqual(entry(lines[0]), { pid: child.pid, cli: "codex", error: "forced connect failure" });
});

test("fatal daemon errors still exit nonzero with timestamped stderr", t => {
  const f = fixture(t), module = pathToFileURL(join(ROOT, "src/logs.ts")).href;
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", `import {timestampDaemonOutput} from ${JSON.stringify(module)};
    timestampDaemonOutput(); setImmediate(()=>{throw new Error('fatal daemon error\\nsecond line')});`], { env: f.env, encoding: "utf8", timeout: 10_000 });
  assert.equal(child.status, 1); assert.match(child.stderr, /fatal daemon error/);
  for (const line of child.stderr.trimEnd().split("\n")) assert.match(line, ISO);
});

test("startup log is private, capped, single-line and refuses symlinks", t => {
  const f = fixture(t); mkdirSync(f.env.MBX_HOME); writeFileSync(f.log, "old\n".repeat(MCP_ERROR_LOG_BYTES / 4), { mode: 0o644 });
  recordMcpStartupError(f.env.MBX_HOME, "codex", new Error("new error\nstack"));
  assert.ok(statSync(f.log).size <= MCP_ERROR_LOG_BYTES); assert.equal(statSync(f.log).mode & 0o777, 0o600);
  assert.equal(readFileSync(f.log, "utf8").trimEnd().split("\n").length, 1); assert.equal(entry(readFileSync(f.log, "utf8").trimEnd()).error, "new error\nstack");
  rmSync(f.log); const target = join(f.root, "target"); writeFileSync(target, "preserved"); symlinkSync(target, f.log);
  assert.doesNotThrow(() => recordMcpStartupError(f.env.MBX_HOME, "codex", new Error("ignored")));
  assert.equal(readFileSync(target, "utf8"), "preserved"); assert.throws(() => recentMcpStartupErrors(f.env.MBX_HOME));
});

test("concurrent startup error appenders leave a capped log of complete records", async t => {
  const f = fixture(t), module = pathToFileURL(join(ROOT, "src/logs.ts")).href;
  const children = Array.from({ length: 8 }, () => spawn(process.execPath, ["--input-type=module", "-e", `
    import {recordMcpStartupError} from ${JSON.stringify(module)};
    for(let i=0;i<100;i++)recordMcpStartupError(process.env.MBX_HOME,'codex',new Error('x'.repeat(2048)));`], { env: f.env, stdio: "ignore" }));
  t.after(() => { for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); });
  await Promise.all(children.map(child => new Promise<void>(resolve => child.once("exit", code => { assert.equal(code, 0); resolve(); }))));
  assert.ok(statSync(f.log).size <= MCP_ERROR_LOG_BYTES);
  const lines = readFileSync(f.log, "utf8").trimEnd().split("\n"); assert.ok(lines.length > 0);
  for (const line of lines) assert.equal(entry(line).error, "x".repeat(2048));
});

test("doctor reads only the latest five valid startup errors in the last 24 hours without initializing", async t => {
  const f = fixture(t), now = Date.now(); mkdirSync(f.env.MBX_HOME);
  const line = (at: number, error: string) => `${new Date(at).toISOString()} ${JSON.stringify({ pid: 123, cli: "codex", error })}\n`;
  writeFileSync(f.log, line(now - 25 * 3600_000, "old") + "malformed\n" + line(now + 60_000, "future")
    + Array.from({ length: 8 }, (_, i) => line(now - (8 - i) * 1000, `error ${i}`)).reverse().join(""));
  const before = readFileSync(f.log, "utf8");
  assert.deepEqual(recentMcpStartupErrors(f.env.MBX_HOME, now).map(line => entry(line).error), ["error 3", "error 4", "error 5", "error 6", "error 7"]);
  const checks = await doctor({ home: f.root, cmd: ["agentmbx"], which: () => null, useClis: false }, f.env.MBX_HOME);
  const check = checks.find(c => c.label.startsWith("MCP startup errors")); assert.equal(check?.level, "warn");
  assert.match(check!.label, /5 shown/); assert.match(check!.label, /error 7/); assert.doesNotMatch(check!.label, /error 2|"old"|future|malformed/);
  assert.equal(readFileSync(f.log, "utf8"), before); assert.equal(existsSync(join(f.env.MBX_HOME, "mbx.db")), false);
});
