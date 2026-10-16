import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { doctor, kimiDesktopPluginChecks } from "../src/doctor.ts";
import { kimiDesktop, readDesktopPlugin, type KimiDesktop } from "../src/kimi-desktop.ts";
import { version } from "../src/version.ts";

const desktop: KimiDesktop = { url: "ws://127.0.0.1:1/control", token: "must-not-be-printed", pid: process.pid, dir: "/unused" };
const installed = () => ({ id: "agentmbx", version: version(), enabled: true, state: "ok", hasErrors: false, enabledMcpServerCount: 1, hookCount: 3 });
const reader = (rows: unknown) => (d: KimiDesktop) => readDesktopPlugin(d, async (actual, calls, opts) => {
  assert.equal(actual, desktop);
  assert.deepEqual(calls, [["kimiPlugin.listPlugins", {}]], "doctor may only list plugins");
  assert.equal(opts?.timeoutMs, 2_000);
  return [rows];
});

test("T685: installed/current, missing and app-not-running are distinct read-only checks", async () => {
  const [current] = await kimiDesktopPluginChecks(desktop, reader([installed()]));
  assert.equal(current.level, "ok");
  assert.match(current.label, /installed and current/);
  assert.match(current.label, /still need confirmation/);
  const [missing] = await kimiDesktopPluginChecks(desktop, reader([{ id: "unrelated" }]));
  assert.equal(missing.level, "warn");
  assert.match(missing.label, /plugin missing/);
  assert.match(missing.fix!, /agentmbx setup --only kimi with Kimi.app open/);
  const [stopped] = await kimiDesktopPluginChecks(null, async () => { assert.fail("stopped app must not receive RPCs"); });
  assert.equal(stopped.level, "info");
  assert.match(stopped.label, /app not running.*unverified/);
});

test("T685: stale, disabled, incomplete or erroneous plugins never report current", async () => {
  for (const change of [{ version: "0.0.0" }, { enabled: false }, { state: "error" }, { hasErrors: true }, { enabledMcpServerCount: 0 }, { hookCount: 2 }]) {
    const [check] = await kimiDesktopPluginChecks(desktop, reader([{ ...installed(), ...change }]));
    assert.equal(check.level, "warn", JSON.stringify(change));
    assert.match(check.fix!, /setup --only kimi/);
  }
});

test("T685: malformed or unavailable inventory is unknown, never missing/current, and leaks no diagnostic text", async () => {
  for (const rows of [null, {}, [null], [{ id: "agentmbx" }], [installed(), installed()], [{ ...installed(), version: "bad\nversion" }]]) {
    const [check] = await kimiDesktopPluginChecks(desktop, reader(rows));
    assert.equal(check.level, "warn");
    assert.match(check.label, /inventory unavailable.*unverified/);
  }
  const checks = await kimiDesktopPluginChecks(desktop, async () => { throw new Error(desktop.token); });
  assert.ok(!JSON.stringify(checks).includes(desktop.token));
});

test("T685: doctor includes the desktop row without a terminal Kimi install and leaves provider files unchanged", async t => {
  const home = mkdtempSync(join(tmpdir(), "mbx-t685-"));
  const dir = join(home, "desktop"), state = join(dir, "agents/main/runner.state.json");
  mkdirSync(join(dir, "agents/main"), { recursive: true });
  writeFileSync(state, JSON.stringify({ control: { endpoint: { url: desktop.url, pid: 2 ** 30, auth: { token: desktop.token } } } }));
  const before = readFileSync(state);
  const old = process.env.MBX_KIMI_DESKTOP_DAIMON;
  process.env.MBX_KIMI_DESKTOP_DAIMON = dir;
  t.after(() => { if (old === undefined) delete process.env.MBX_KIMI_DESKTOP_DAIMON; else process.env.MBX_KIMI_DESKTOP_DAIMON = old; rmSync(home, { recursive: true, force: true }); });
  assert.equal(kimiDesktop(), null, "dead PID does not establish a running app");
  const checks = await doctor({ home, cmd: ["agentmbx"], which: () => null, useClis: false }, join(home, "mbx"));
  assert.equal(checks.filter(c => c.label.startsWith("kimi desktop:")).length, 1);
  assert.ok(checks.some(c => c.label.includes("kimi desktop: app not running")));
  assert.deepEqual(readFileSync(state), before);
});
