// T654: a different node that meets the engines floor is a warning, not "hooks not wired".
// A missing or too-old node stays a failure and setup rewrites it. Isolated HOME only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { doctor } from "../src/doctor.ts";
import { MbxNode } from "../src/node.ts";
import { hookCommand, opencodePluginPath, opencodePluginSource, runSetup, shJoin, skillDest, type SetupCtx } from "../src/setup.ts";
import { version } from "../src/version.ts";

function home(): string {
  return mkdtempSync(join(tmpdir(), "mbx-t654-"));
}
function ctxFor(root: string, cmd: string[]): SetupCtx {
  return { home: root, cmd, which: () => null, useClis: false };
}
const entry = realpathSync(join(import.meta.dirname, "../bin/agentmbx.js"));

function claudeHooks(root: string, node: string): string {
  const script = join(skillDest(root), "scripts", "claude-posttool.sh");
  mkdirSync(dirname(script), { recursive: true });
  writeFileSync(script, "#!/bin/sh\nexit 0\n");
  const cmd = [node, entry];
  const direct = (sub: string) => hookCommand(cmd, sub, "claude");
  const post = `sh ${shJoin([script])} ${shJoin(cmd)}`;
  const group = (command: string) => [{ hooks: [{ type: "command", command, timeout: 10 }] }];
  const body = JSON.stringify({
    hooks: {
      SessionStart: group(direct("session-start")),
      UserPromptSubmit: group(direct("prompt")),
      PermissionRequest: group(direct("permission")),
      Stop: group(direct("stop")),
      PostToolUse: group(post),
      SessionEnd: group(direct("session-end")),
    },
  }, null, 2) + "\n";
  mkdirSync(join(root, ".claude"), { recursive: true });
  writeFileSync(join(root, ".claude/settings.json"), body);
  return body;
}

function opencodePlugin(root: string, node: string): string {
  const body = opencodePluginSource([node, entry], version());
  const path = opencodePluginPath(root);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body);
  mkdirSync(join(root, ".config/opencode"), { recursive: true });
  writeFileSync(join(root, ".config/opencode/opencode.jsonc"), "{}\n");
  return body;
}

function mbxHome(root: string): string {
  const d = join(root, ".local/share/agentmbx");
  new MbxNode(d, { host: "alpha", port: 1 }).close();
  return d;
}

test("T654: a different node that meets the engines floor warns and is kept", async () => {
  const root = home();
  try {
    const other = join(root, "node26");
    symlinkSync(process.execPath, other);
    const claude = claudeHooks(root, other);
    const plugin = opencodePlugin(root, other);
    const ctx = ctxFor(root, [process.execPath, entry]);
    const before = { claude: readFileSync(join(root, ".claude/settings.json"), "utf8"), plugin: readFileSync(opencodePluginPath(root), "utf8") };
    assert.equal(before.claude, claude);
    assert.equal(before.plugin, plugin);
    const rows = runSetup(ctx, { mode: "install", only: ["claude", "opencode"], stamp: "T654a" });
    assert.ok(rows.some((r) => r.cli === "claude" && r.item.startsWith("hooks") && r.action === "unchanged"), JSON.stringify(rows));
    assert.ok(rows.some((r) => r.cli === "opencode" && r.item.startsWith("plugin") && r.action === "unchanged"), JSON.stringify(rows));
    // Status line is a separate edit and stays out of T654. Compare the hook groups only.
    const after = JSON.parse(readFileSync(join(root, ".claude/settings.json"), "utf8")) as { hooks: unknown };
    assert.deepEqual(after.hooks, (JSON.parse(claude) as { hooks: unknown }).hooks, "claude hooks keep the other node");
    assert.equal(readFileSync(opencodePluginPath(root), "utf8"), plugin, "opencode plugin keeps the other node");
    const checks = await doctor(ctx, mbxHome(root));
    for (const cli of ["claude", "opencode"]) {
      assert.ok(checks.some((c) => c.level === "ok" && new RegExp(`^${cli}: hooks wired`).test(c.label)), `${cli}: ${JSON.stringify(checks)}`);
      const warn = checks.find((c) => c.level === "warn" && c.label.startsWith(`${cli}: hooks use node `));
      assert.ok(warn, `${cli} warn: ${JSON.stringify(checks)}`);
      assert.match(warn.label, new RegExp(other.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
      assert.match(warn.label, new RegExp(process.execPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
      assert.equal(warn.fix, undefined, "an interpreter-only difference does not suggest setup");
    }
    assert.ok(!checks.some((c) => c.level === "fail" && /hooks not wired/.test(c.label)), JSON.stringify(checks));
    assert.ok(!checks.some((c) => /outdated managed wiring|wiring incomplete/.test(c.label)), JSON.stringify(checks));
    assert.ok(!checks.some((c) => c.level === "warn" && /hooks use node/.test(c.label) && /agentmbx setup/.test(c.fix ?? "")), JSON.stringify(checks));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("T654: a missing node and a too-old node stay unwired and are rewritten", async () => {
  const root = home();
  try {
    const gone = "/nonexistent/node-gone";
    claudeHooks(root, gone);
    opencodePlugin(root, gone);
    const ctx = ctxFor(root, [process.execPath, entry]);
    const checks = await doctor(ctx, mbxHome(root));
    for (const cli of ["claude", "opencode"]) {
      const fail = checks.find((c) => c.level === "fail" && new RegExp(`^${cli}: hooks not wired`).test(c.label));
      assert.ok(fail, `${cli}: ${JSON.stringify(checks)}`);
      assert.match(fail.fix ?? "", /agentmbx setup --only/);
    }
    assert.ok(!checks.some((c) => /hooks use node/.test(c.label)), JSON.stringify(checks));
    const rows = runSetup(ctx, { mode: "install", only: ["claude", "opencode"], stamp: "T654b" });
    assert.ok(rows.some((r) => r.cli === "claude" && r.item.startsWith("hooks") && r.action === "updated"), JSON.stringify(rows));
    assert.ok(rows.some((r) => r.cli === "opencode" && r.item.startsWith("plugin") && r.action === "updated"), JSON.stringify(rows));
    const claude = readFileSync(join(root, ".claude/settings.json"), "utf8");
    const plugin = readFileSync(opencodePluginPath(root), "utf8");
    assert.ok(!claude.includes(gone) && claude.includes(process.execPath), "missing claude node is rewritten");
    assert.ok(!plugin.includes(gone) && plugin.includes(process.execPath), "missing opencode node is rewritten");

    const old = join(root, "node20");
    writeFileSync(old, "#!/bin/sh\nprintf '%s\\n' '20.0.0'\n");
    chmodSync(old, 0o755);
    claudeHooks(root, old);
    opencodePlugin(root, old);
    const stale = await doctor(ctx, mbxHome(root));
    for (const cli of ["claude", "opencode"])
      assert.ok(stale.some((c) => c.level === "fail" && new RegExp(`^${cli}: hooks not wired`).test(c.label)), `${cli}: ${JSON.stringify(stale)}`);
    const again = runSetup(ctx, { mode: "install", only: ["claude", "opencode"], stamp: "T654c" });
    assert.ok(again.some((r) => r.cli === "claude" && r.item.startsWith("hooks") && r.action === "updated"), JSON.stringify(again));
    assert.ok(again.some((r) => r.cli === "opencode" && r.item.startsWith("plugin") && r.action === "updated"), JSON.stringify(again));
    assert.ok(!readFileSync(join(root, ".claude/settings.json"), "utf8").includes(old));
    assert.ok(!readFileSync(opencodePluginPath(root), "utf8").includes(old));
  } finally { rmSync(root, { recursive: true, force: true }); }
});
