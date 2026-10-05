// T391: OpenCode setup installs the hooks PLUGIN (OpenCode has no settings-file hooks) that maps
// session.created/tool.execute.after/session.idle onto the shared `agentmbx hook --cli opencode`
// contract; install is byte-exact, uninstall removes only ours, a local edit turns the file
// foreign and is never overwritten (T347 bar); doctor's opencode-service check runs only when an
// opencode mailbox is bound and says how to start the service when it is down.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MbxNode } from "../src/node.ts";
import { opencodePluginPath, opencodePluginSource, runSetup, type SetupCtx } from "../src/setup.ts";
import { opencodeServiceCheck } from "../src/doctor.ts";
import { version } from "../src/version.ts";

const CMD = ["/opt/bin/agentmbx"];
const ctxFor = (home: string, cmd = CMD): SetupCtx => ({ home, cmd, which: () => null, useClis: false });
const pluginPath = (home: string) => opencodePluginPath(home);

function homeWithConfig(): string {
  const home = mkdtempSync(join(tmpdir(), "mbx-opencode-hooks-"));
  mkdirSync(join(home, ".config/opencode"), { recursive: true });
  writeFileSync(join(home, ".config/opencode/opencode.jsonc"), `{\n  "$schema": "https://opencode.ai/config.json"\n}\n`);
  return home;
}

const install = (home: string) => runSetup(ctxFor(home), { mode: "install", only: ["opencode"] });

test("T391 install writes the plugin byte-exact and idempotently (AC1)", () => {
  const home = homeWithConfig();
  try {
    const rows = install(home);
    const ours = rows.find((r) => r.kind ?? r.item.includes("plugin"))!;
    const want = opencodePluginSource(CMD, version());
    assert.ok(existsSync(pluginPath(home)), "plugin file written");
    assert.equal(readFileSync(pluginPath(home), "utf8"), want, "byte-exact ours");
    assert.equal(ours.action, "added");
    // Second run changes nothing.
    const again = install(home);
    assert.equal(again.find((r) => r.item.includes("plugin"))!.action, "unchanged");
    assert.equal(readFileSync(pluginPath(home), "utf8"), want);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("T391 generated plugin maps OpenCode events onto the shared hook contract (AC1)", () => {
  const src = opencodePluginSource(CMD, version());
  assert.match(src, /^\/\/ agentmbx-plugin v1 \(T391\)/, "ours marker on line 1");
  assert.ok(src.includes("session.created") && src.includes('"session-start"'), "session.created -> session-start");
  assert.ok(src.includes("session.idle") && src.includes('"stop"'), "session.idle -> stop (Stop continuation)");
  assert.ok(src.includes('"tool.execute.after"') && src.includes('"post-tool"'), "tool.execute.after -> post-tool");
  assert.ok(src.includes("/opt/bin/agentmbx"), "absolute agentmbx path embedded");
  assert.ok(src.includes("--cli opencode"), "targets the opencode CLI");
  assert.ok(src.includes("<"), "payload arrives via stdin redirect");
});

test("T391 uninstall removes ours byte-exact, keeps foreign, upgrades ours-stale (AC1)", () => {
  const home = homeWithConfig();
  try {
    install(home);
    runSetup(ctxFor(home), { mode: "uninstall", only: ["opencode"] });
    assert.ok(!existsSync(pluginPath(home)), "ours removed");
    // Foreign: a user's own plugin file is never touched in either mode.
    const foreign = "// my own plugin\nexport const Mine = async () => ({});\n";
    mkdirSync(join(home, ".config/opencode/plugins"), { recursive: true });
    writeFileSync(pluginPath(home), foreign);
    assert.equal(install(home).find((r) => r.item.includes("plugin"))!.action, "unchanged");
    assert.equal(readFileSync(pluginPath(home), "utf8"), foreign, "foreign not overwritten");
    runSetup(ctxFor(home), { mode: "uninstall", only: ["opencode"] });
    assert.equal(readFileSync(pluginPath(home), "utf8"), foreign, "foreign not deleted");
    // Ours-stale: older marker version is still ours, so install upgrades and uninstall removes.
    const stale = opencodePluginSource(CMD, version()).replace('"stop"', '"session-end"');
    writeFileSync(pluginPath(home), stale);
    assert.equal(install(home).find((r) => r.item.includes("plugin"))!.action, "updated");
    assert.equal(readFileSync(pluginPath(home), "utf8"), opencodePluginSource(CMD, version()));
    runSetup(ctxFor(home), { mode: "uninstall", only: ["opencode"] });
    assert.ok(!existsSync(pluginPath(home)), "stale ours removed on uninstall");
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("T391 doctor service check: silent unbound, ok reachable, warn with fix down (AC3)", async () => {
  const home = mkdtempSync(join(tmpdir(), "mbx-opencode-svc-"));
  try {
    const node = new MbxNode(home, { host: "alpha" });
    const up = async () => ({ url: "http://127.0.0.1:49374", auth: "" });
    const down = async () => null;
    // Unbound: no check at all.
    assert.equal(await opencodeServiceCheck(node, up), null);
    assert.equal(await opencodeServiceCheck(node, down), null);
    // Bound: reachable is ok, down is a warn carrying the start hint.
    node.store.db.prepare("INSERT INTO sessions (agent, cli, session_id, channel, updated_at) VALUES (?, 'opencode', ?, 0, ?)")
      .run("agentmbx-opencode", "ses_test1", new Date().toISOString());
    const ok = await opencodeServiceCheck(node, up);
    assert.equal(ok?.level, "ok");
    assert.match(ok?.label ?? "", /service reachable/);
    const warn = await opencodeServiceCheck(node, down);
    assert.equal(warn?.level, "warn");
    assert.match(warn?.label ?? "", /cannot be woken/);
    assert.match(warn?.fix ?? "", /opencode/);
    node.close();
  } finally { rmSync(home, { recursive: true, force: true }); }
});
