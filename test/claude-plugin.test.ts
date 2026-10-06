import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { CLAUDE_PLUGIN_ID, classifyClaudePlugin, claudePluginChecks, claudePluginStep, packageRoot, pluginDir, type CliRunner } from "../src/claude-plugin.ts";
import { parseJsonc } from "../src/jsonc.ts";
import { runSetup, type SetupCtx } from "../src/setup.ts";

function raw(text: string, path: string[], key: string): string {
  let node = parseJsonc(text);
  for (const p of path) {
    assert.equal(node.kind, "object");
    const m = node.members.find((x) => x.key === p);
    assert.ok(m, p);
    node = m.value;
  }
  assert.equal(node.kind, "object");
  const hit = node.members.find((x) => x.key === key);
  assert.ok(hit, key);
  return text.slice(hit.value.start, hit.value.end);
}

function fixture(home: string): { settings: string; markets: string; installed: string } {
  const claude = join(home, ".claude");
  const plugins = join(claude, "plugins");
  mkdirSync(plugins, { recursive: true });
  const settings = `{
  // foreign plugins stay
  "enabledPlugins": {
    "cloudflare@cloudflare": true,
    "obsidian@obsidian-skills": true
  },
  "theme": "dark"
}
`;
  const markets = `{
  "cloudflare": {
    "source": { "source": "github", "repo": "cloudflare/cloudflare" },
    "installLocation": "/tmp/foreign-market",
    "lastUpdated": "2020-01-01T00:00:00.000Z"
  }
}
`;
  const installed = `{
  "version": 2,
  "plugins": {
    "cloudflare@cloudflare": [
      { "scope": "user", "version": "1.0.0", "installPath": "/tmp/foreign-plugin" }
    ]
  }
}
`;
  writeFileSync(join(claude, "settings.json"), settings);
  writeFileSync(join(plugins, "known_marketplaces.json"), markets);
  writeFileSync(join(plugins, "installed_plugins.json"), installed);
  return { settings, markets, installed };
}

function runner(home: string, failAt: string | null = null): { run: CliRunner; calls: string[][] } {
  const calls: string[][] = [];
  const root = packageRoot();
  const run: CliRunner = (_bin, args, opts) => {
    calls.push(args);
    assert.equal(opts.env.HOME, home);
    if (args[1] === "validate") return { status: failAt === "validate" ? 1 : 0, stdout: "", stderr: failAt === "validate" ? "invalid" : "" };
    if (failAt === args[1] || failAt === args[2]) return { status: 1, stdout: "", stderr: "refused" };
    const write = (path: string, mutate: (v: Record<string, unknown>) => void): void => {
      const text = readFileSync(path, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
      const cur = JSON.parse(text) as Record<string, unknown>;
      mutate(cur);
      writeFileSync(path, JSON.stringify(cur));
    };
    if (args[1] === "marketplace" && args[2] === "add") {
      write(join(home, ".claude/plugins/known_marketplaces.json"), (cur) => {
        const foreign = cur.cloudflare as { lastUpdated: string };
        foreign.lastUpdated = "MUTATED";
        cur.agentmbx = { source: { source: "directory", path: root }, installLocation: root, lastUpdated: "2026-10-06T00:00:00.000Z" };
      });
    } else if (args[1] === "install") {
      write(join(home, ".claude/settings.json"), (cur) => {
        const enabled = cur.enabledPlugins as Record<string, boolean>;
        enabled["cloudflare@cloudflare"] = false;
        enabled[CLAUDE_PLUGIN_ID] = true;
      });
      write(join(home, ".claude/plugins/installed_plugins.json"), (cur) => {
        const plugins = cur.plugins as Record<string, { version: string }[]>;
        plugins["cloudflare@cloudflare"][0].version = "MUTATED";
        plugins[CLAUDE_PLUGIN_ID] = [{ scope: "user", version: "0.5.13", installPath: pluginDir(root) } as unknown as { version: string }];
      });
    } else if (args[1] === "uninstall") {
      write(join(home, ".claude/settings.json"), (cur) => {
        const enabled = cur.enabledPlugins as Record<string, boolean>;
        enabled["obsidian@obsidian-skills"] = false;
        delete enabled[CLAUDE_PLUGIN_ID];
      });
      write(join(home, ".claude/plugins/installed_plugins.json"), (cur) => {
        const plugins = cur.plugins as Record<string, unknown>;
        delete plugins[CLAUDE_PLUGIN_ID];
        (plugins["cloudflare@cloudflare"] as { version: string }[])[0].version = "MUTATED";
      });
    } else if (args[2] === "remove") {
      write(join(home, ".claude/plugins/known_marketplaces.json"), (cur) => {
        delete cur.agentmbx;
        (cur.cloudflare as { lastUpdated: string }).lastUpdated = "MUTATED";
      });
    }
    return { status: 0, stdout: "", stderr: "" };
  };
  return { run, calls };
}

test("T416: plugin version tracks package.json and declares hooks", () => {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };
  const plugin = JSON.parse(readFileSync(new URL("../plugins/claude/.claude-plugin/plugin.json", import.meta.url), "utf8")) as { version: string; hooks?: string; homepage?: string };
  assert.equal(plugin.version, pkg.version);
  assert.equal(plugin.hooks, "./hooks/hooks.json");
  assert.equal(plugin.homepage, undefined);
});

test("T416: install and uninstall keep foreign plugin bytes", () => {
  const home = mkdtempSync(join(tmpdir(), "t416-"));
  try {
    const before = fixture(home);
    const { run, calls } = runner(home);
    const installed = claudePluginStep(home, "install", false, run);
    assert.equal(installed.action, "added");
    assert.deepEqual(calls.map((c) => c[1] === "marketplace" ? c.slice(0, 3).concat(["<root>", ...c.slice(4)]) : c), [
      ["plugin", "marketplace", "add", "<root>", "--scope", "user"],
      ["plugin", "install", CLAUDE_PLUGIN_ID, "--scope", "user"],
    ]);
    const settings = readFileSync(join(home, ".claude/settings.json"), "utf8");
    const markets = readFileSync(join(home, ".claude/plugins/known_marketplaces.json"), "utf8");
    const installedText = readFileSync(join(home, ".claude/plugins/installed_plugins.json"), "utf8");
    assert.equal(raw(settings, ["enabledPlugins"], "cloudflare@cloudflare"), raw(before.settings, ["enabledPlugins"], "cloudflare@cloudflare"));
    assert.equal(raw(settings, ["enabledPlugins"], "obsidian@obsidian-skills"), raw(before.settings, ["enabledPlugins"], "obsidian@obsidian-skills"));
    assert.equal(raw(settings, [], "theme"), raw(before.settings, [], "theme"));
    assert.equal(raw(settings, ["enabledPlugins"], CLAUDE_PLUGIN_ID), "true");
    assert.equal(raw(markets, [], "cloudflare"), raw(before.markets, [], "cloudflare"));
    assert.equal(raw(installedText, ["plugins"], "cloudflare@cloudflare"), raw(before.installed, ["plugins"], "cloudflare@cloudflare"));
    assert.equal(settings.includes("// foreign plugins stay"), true);
    assert.equal(classifyClaudePlugin(home).kind, "ours");

    const again = claudePluginStep(home, "install", false, run);
    assert.equal(again.action, "unchanged");
    assert.equal(calls.length, 2);

    const removed = claudePluginStep(home, "uninstall", false, run);
    assert.equal(removed.action, "removed");
    const settingsAfter = readFileSync(join(home, ".claude/settings.json"), "utf8");
    const marketsAfter = readFileSync(join(home, ".claude/plugins/known_marketplaces.json"), "utf8");
    const installedAfter = readFileSync(join(home, ".claude/plugins/installed_plugins.json"), "utf8");
    assert.equal(raw(settingsAfter, ["enabledPlugins"], "cloudflare@cloudflare"), raw(before.settings, ["enabledPlugins"], "cloudflare@cloudflare"));
    assert.equal(raw(settingsAfter, ["enabledPlugins"], "obsidian@obsidian-skills"), raw(before.settings, ["enabledPlugins"], "obsidian@obsidian-skills"));
    assert.equal(settingsAfter.includes(CLAUDE_PLUGIN_ID), false);
    assert.equal(raw(marketsAfter, [], "cloudflare"), raw(before.markets, [], "cloudflare"));
    assert.equal(marketsAfter.includes(`"${"agentmbx"}"`), false);
    assert.equal(raw(installedAfter, ["plugins"], "cloudflare@cloudflare"), raw(before.installed, ["plugins"], "cloudflare@cloudflare"));
    assert.equal(classifyClaudePlugin(home).kind, "absent");
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("T416: a partial install replaces an existing enabled value", () => {
  const home = mkdtempSync(join(tmpdir(), "t416-partial-"));
  try {
    const before = fixture(home);
    const settingsPath = join(home, ".claude/settings.json");
    const seeded = before.settings.replace(
      '"enabledPlugins": {',
      `"enabledPlugins": {\n    "${CLAUDE_PLUGIN_ID}": true,`,
    );
    writeFileSync(settingsPath, seeded);
    const { run } = runner(home);
    const step = claudePluginStep(home, "install", false, run);
    assert.equal(step.action, "added");
    const settings = readFileSync(settingsPath, "utf8");
    assert.equal(raw(settings, ["enabledPlugins"], "cloudflare@cloudflare"), raw(seeded, ["enabledPlugins"], "cloudflare@cloudflare"));
    assert.equal(raw(settings, ["enabledPlugins"], "obsidian@obsidian-skills"), raw(seeded, ["enabledPlugins"], "obsidian@obsidian-skills"));
    assert.equal(raw(settings, ["enabledPlugins"], CLAUDE_PLUGIN_ID), "true");
    assert.equal(settings.includes("// foreign plugins stay"), true);
    assert.equal(classifyClaudePlugin(home).kind, "ours");
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("T416: a foreign agentmbx marketplace is not replaced", () => {
  const home = mkdtempSync(join(tmpdir(), "t416-foreign-"));
  try {
    fixture(home);
    const markets = join(home, ".claude/plugins/known_marketplaces.json");
    const original = readFileSync(markets, "utf8");
    writeFileSync(markets, original.replace(`"cloudflare": {`, `"agentmbx": { "source": { "source": "github", "repo": "other/agentmbx" }, "installLocation": "/tmp/not-ours", "lastUpdated": "x" },\n  "cloudflare": {`));
    const before = readFileSync(markets, "utf8");
    const { run, calls } = runner(home);
    const step = claudePluginStep(home, "install", false, run);
    assert.equal(step.action, "manual");
    assert.equal(calls.length, 0);
    assert.equal(readFileSync(markets, "utf8"), before);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("T416: a failed CLI call restores the pre-image bytes", () => {
  const home = mkdtempSync(join(tmpdir(), "t416-fail-"));
  try {
    fixture(home);
    const settings = join(home, ".claude/settings.json");
    const before = readFileSync(settings, "utf8");
    const { run } = runner(home, "install");
    const step = claudePluginStep(home, "install", false, run);
    assert.equal(step.action, "error");
    assert.equal(readFileSync(settings, "utf8"), before);
    assert.match(step.note ?? "", /refused/);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("T416: doctor validates through the injected runner", () => {
  const home = mkdtempSync(join(tmpdir(), "t416-doctor-"));
  try {
    fixture(home);
    const absent = claudePluginChecks(home, { useClis: true, which: () => "/bin/claude", runCli: runner(home).run });
    assert.equal(absent[0]?.level, "warn");
    claudePluginStep(home, "install", false, runner(home).run);
    const { run, calls } = runner(home);
    const ok = claudePluginChecks(home, { useClis: true, which: () => "/bin/claude", runCli: run });
    assert.equal(ok[0]?.level, "ok");
    assert.match(ok[0]?.label ?? "", /loads/);
    assert.equal(calls.some((c) => c[1] === "validate" && c[2] === pluginDir()), true);
    const bad = claudePluginChecks(home, { useClis: true, which: () => "/bin/claude", runCli: runner(home, "validate").run });
    assert.equal(bad[0]?.level, "warn");
    assert.match(bad[0]?.label ?? "", /does not load/);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("T416: setup reports the plugin row and does not spawn claude", () => {
  const home = mkdtempSync(join(tmpdir(), "t416-setup-"));
  try {
    fixture(home);
    const { run, calls } = runner(home);
    const ctx: SetupCtx = { home, cmd: ["agentmbx"], which: () => null, useClis: false, runCli: run };
    const rows = runSetup(ctx, { mode: "install", only: ["claude"] });
    const row = rows.find((r) => r.item === "plugin agentmbx@agentmbx");
    assert.equal(row?.action, "added");
    assert.equal(calls.length, 2);
    assert.equal(calls.every((c) => c[0] === "plugin"), true);
  } finally { rmSync(home, { recursive: true, force: true }); }
});
