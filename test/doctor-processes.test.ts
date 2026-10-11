import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

test("doctor --processes dispatch is read-only and cannot combine with --fix", t => {
  const root = mkdtempSync(join(tmpdir(), "mbx-process-doctor-")); t.after(() => rmSync(root, { recursive: true, force: true }));
  const env = { ...process.env, AGENTMBX_DEV: "1", MBX_HOME: join(root, "uninitialized") };
  const run = (args: string[]) => spawnSync(process.execPath, [resolve("bin/agentmbx.js"), "doctor", ...args], { env, encoding: "utf8", timeout: 10000 });
  const result = run(["--processes"]); assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /MCP\/watch process|inventory unavailable/);
  assert.deepEqual(readdirSync(root), [], "process diagnosis does not initialize MBX_HOME");
  const rejected = run(["--processes", "--fix"]); assert.equal(rejected.status, 2);
  assert.match(rejected.stderr, /read-only; omit --fix/); assert.deepEqual(readdirSync(root), []);
  const help = run(["--help"]); assert.equal(help.status, 0); assert.match(help.stdout, /--processes/);
});
