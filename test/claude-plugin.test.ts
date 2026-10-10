import assert from "node:assert/strict";
import { cpSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { CLAUDE_PLUGIN_ID, classifyClaudePlugin, claudePluginChecks, claudePluginStep, packageRoot, pluginDir, shipsClaudePlugin, type CliRunner } from "../src/claude-plugin.ts";
import { doctor } from "../src/doctor.ts";
import { MbxNode } from "../src/node.ts";
import { parseJsonc } from "../src/jsonc.ts";
import { runSetup, type SetupCtx } from "../src/setup.ts";
import { version } from "../src/version.ts";

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
        plugins[CLAUDE_PLUGIN_ID] = [{ scope: "user", version: version(), installPath: pluginDir(root) } as unknown as { version: string }];
      });
    } else if (args[1] === "update") {
      write(join(home, ".claude/plugins/installed_plugins.json"), (cur) => {
        (cur.plugins as Record<string, { version: string }[]>)[CLAUDE_PLUGIN_ID][0].version = version();
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

/** Full HOME/XDG isolation: every home-derived path in this process points into the temp home. */
function isolate(t: TestContext, home: string): void {
  const keys = ["HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME", "CLAUDE_CONFIG_DIR"] as const;
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  process.env.HOME = home;
  process.env.XDG_CONFIG_HOME = join(home, ".config");
  process.env.XDG_DATA_HOME = join(home, ".local/share");
  process.env.XDG_STATE_HOME = join(home, ".local/state");
  process.env.XDG_CACHE_HOME = join(home, ".cache");
  delete process.env.CLAUDE_CONFIG_DIR;
  t.after(() => {
    for (const k of keys) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
    rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
}

test("T416: the local marketplace lists plugins/claude and the plugin ships the T415 mod", async () => {
  const root = packageRoot();
  assert.equal(shipsClaudePlugin(root), true);
  const market = JSON.parse(readFileSync(join(root, ".claude-plugin/marketplace.json"), "utf8")) as { name: string; plugins: { name: string; source: string }[] };
  assert.equal(market.name, "agentmbx");
  assert.deepEqual(market.plugins.map((p) => [p.name, p.source]), [["agentmbx", "./plugins/claude"]]);
  assert.equal(`${market.plugins[0].name}@${market.name}`, CLAUDE_PLUGIN_ID);
  const hooks = JSON.parse(readFileSync(join(pluginDir(root), "hooks/hooks.json"), "utf8")) as { modules: string[] };
  assert.deepEqual(hooks.modules, ["./register.js"]);
  const mod = await import(new URL("../plugins/claude/hooks/register.js", import.meta.url).href) as Record<string, unknown>;
  for (const name of ["register", "renderSections", "bandText", "statusLineText"]) assert.equal(typeof mod[name], "function", name);
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { files: string[] };
  assert.ok(pkg.files.includes(".claude-plugin") && pkg.files.includes("plugins"), "the npm package ships the marketplace and the plugin");
});

test("T416: setup wires the plugin idempotently, doctor reports it, uninstall removes only ours", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "t416-e2e-"));
  isolate(t, home);
  const before = fixture(home);
  const mbx = join(home, ".local/share/agentmbx");
  new MbxNode(mbx, { host: "alpha", port: 1 }).close();
  const { run, calls } = runner(home);
  const ctx: SetupCtx = { home, cmd: ["/opt/bin/agentmbx"], which: () => null, useClis: false, runCli: run };
  const pluginRow = (rows: { item: string; action: string }[]) => rows.find((r) => r.item === "plugin agentmbx@agentmbx");

  const missing = (await doctor(ctx, mbx)).find((c) => /^claude: plugin/.test(c.label));
  assert.equal(missing?.level, "warn");
  assert.equal(missing?.fix, "agentmbx setup --only claude");

  assert.equal(pluginRow(runSetup(ctx, { mode: "install", only: ["claude"] }))?.action, "added");
  const installCalls = calls.length;
  assert.equal(pluginRow(runSetup(ctx, { mode: "install", only: ["claude"] }))?.action, "unchanged");
  assert.equal(calls.length, installCalls, "a second setup runs no claude command");
  const settingsInstalled = readFileSync(join(home, ".claude/settings.json"), "utf8");

  const ok = (await doctor(ctx, mbx)).find((c) => /^claude: plugin/.test(c.label));
  assert.equal(ok?.level, "ok");
  assert.equal(ok?.label, "claude: plugin installed and loads (agentmbx@agentmbx)");
  assert.ok(calls.some((c) => c[1] === "validate" && c[2] === pluginDir()));
  assert.equal(readFileSync(join(home, ".claude/settings.json"), "utf8"), settingsInstalled, "doctor writes nothing");

  assert.equal(pluginRow(runSetup(ctx, { mode: "uninstall", only: ["claude"] }))?.action, "removed");
  assert.equal(classifyClaudePlugin(home).kind, "absent");
  const markets = readFileSync(join(home, ".claude/plugins/known_marketplaces.json"), "utf8");
  const installed = readFileSync(join(home, ".claude/plugins/installed_plugins.json"), "utf8");
  assert.equal(raw(markets, [], "cloudflare"), raw(before.markets, [], "cloudflare"));
  assert.equal(raw(installed, ["plugins"], "cloudflare@cloudflare"), raw(before.installed, ["plugins"], "cloudflare@cloudflare"));
  assert.equal(pluginRow(runSetup(ctx, { mode: "uninstall", only: ["claude"] }))?.action, "unchanged");
});

test("T416: a foreign agentmbx@agentmbx plugin record is never overwritten or removed", (t) => {
  const home = mkdtempSync(join(tmpdir(), "t416-foreign-plugin-"));
  isolate(t, home);
  fixture(home);
  const path = join(home, ".claude/plugins/installed_plugins.json");
  const text = readFileSync(path, "utf8").replace(`"plugins": {`, `"plugins": {\n    "${CLAUDE_PLUGIN_ID}": [{ "scope": "user", "version": "9.9.9", "installPath": "/opt/someone-else/agentmbx" }],`);
  writeFileSync(path, text);
  const { run, calls } = runner(home);
  for (const mode of ["install", "uninstall"] as const) {
    const step = claudePluginStep(home, mode, false, run);
    assert.equal(step.action, "manual", mode);
    assert.equal(readFileSync(path, "utf8"), text, mode);
  }
  assert.equal(calls.length, 0);
  const check = claudePluginChecks(home, { useClis: true, which: () => "/bin/claude", runCli: run });
  assert.equal(check[0]?.level, "info");
});

test("T416: an install without the plugin files skips instead of failing", (t) => {
  const home = mkdtempSync(join(tmpdir(), "t416-sea-"));
  isolate(t, home);
  fixture(home);
  const bare = join(home, "pkg");
  mkdirSync(bare, { recursive: true });
  assert.equal(shipsClaudePlugin(bare), false);
  const { run, calls } = runner(home);
  const step = claudePluginStep(home, "install", false, run, bare);
  assert.equal(step.action, "skipped");
  assert.match(step.note ?? "", /does not ship the Claude plugin files/);
  assert.equal(calls.length, 0);
  assert.equal(claudePluginChecks(home, { useClis: true, which: () => "/bin/claude", runCli: run }, bare)[0]?.level, "info");
  // a full copy of the shipped files is enough on its own
  cpSync(join(packageRoot(), ".claude-plugin"), join(bare, ".claude-plugin"), { recursive: true });
  cpSync(pluginDir(), pluginDir(bare), { recursive: true });
  assert.equal(shipsClaudePlugin(bare), true);
  assert.ok(existsSync(join(pluginDir(bare), "hooks/register.js")));
});

test("T542: a stale cached plugin is a doctor warning, and setup updates it to this version", () => {
  const home = mkdtempSync(join(tmpdir(), "t542-stale-"));
  try {
    fixture(home);
    claudePluginStep(home, "install", false, runner(home).run);
    const path = join(home, ".claude/plugins/installed_plugins.json");
    const cur = JSON.parse(readFileSync(path, "utf8")) as { plugins: Record<string, { version: string }[]> };
    cur.plugins[CLAUDE_PLUGIN_ID][0].version = "0.5.19";
    writeFileSync(path, JSON.stringify(cur));
    const stale = claudePluginChecks(home, { useClis: true, which: () => "/bin/claude", runCli: runner(home).run });
    assert.equal(stale[0]?.level, "warn");
    assert.match(stale[0]?.label ?? "", new RegExp(`loaded plugin is 0\\.5\\.19, agentmbx is ${version().replace(/\./g, "\\.")}`));
    assert.equal(claudePluginStep(home, "install", true, runner(home).run).action, "updated", "dry run reports the update");
    const { run, calls } = runner(home);
    const step = claudePluginStep(home, "install", false, run);
    assert.equal(step.action, "updated");
    assert.deepEqual(calls, [["plugin", "update", CLAUDE_PLUGIN_ID, "--scope", "user", "-y"]]);
    assert.equal(claudePluginChecks(home, { useClis: true, which: () => "/bin/claude", runCli: runner(home).run })[0]?.level, "ok");
    const again = runner(home);
    assert.equal(claudePluginStep(home, "install", false, again.run).action, "unchanged");
    assert.deepEqual(again.calls, [], "a current install runs nothing");
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("T542: a failed update is an error naming the version still loaded", () => {
  const home = mkdtempSync(join(tmpdir(), "t542-fail-"));
  try {
    fixture(home);
    claudePluginStep(home, "install", false, runner(home).run);
    const path = join(home, ".claude/plugins/installed_plugins.json");
    const cur = JSON.parse(readFileSync(path, "utf8")) as { plugins: Record<string, { version: string }[]> };
    cur.plugins[CLAUDE_PLUGIN_ID][0].version = "0.5.19";
    writeFileSync(path, JSON.stringify(cur));
    const step = claudePluginStep(home, "install", false, runner(home, "update").run);
    assert.equal(step.action, "error");
    assert.match(step.note ?? "", /left 0\.5\.19/);
  } finally { rmSync(home, { recursive: true, force: true }); }
});
