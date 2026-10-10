// T416: install the Claude Code mod through Claude's own plugin CLI. The runner is injected so tests
// never execute the real `claude` binary against a home directory. After the CLI returns, foreign
// plugin records are put back from the pre-image so their bytes survive a CLI rewrite.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { insertMember, parseJsonc, removeMember, replaceValue } from "./jsonc.js";
import { version } from "./version.js";
export const CLAUDE_PLUGIN_ID = "agentmbx@agentmbx";
export const CLAUDE_MARKETPLACE = "agentmbx";
export function packageRoot() {
    return fileURLToPath(new URL("..", import.meta.url));
}
export function pluginDir(root = packageRoot()) {
    return join(root, "plugins", "claude");
}
/** The marketplace and the plugin it lists both ship next to this package (a git or npm install). The single
 *  executable bundles neither, so there is nothing for `claude plugin marketplace add` to read. */
export function shipsClaudePlugin(root = packageRoot()) {
    return existsSync(join(root, ".claude-plugin", "marketplace.json"))
        && existsSync(join(pluginDir(root), ".claude-plugin", "plugin.json"))
        && existsSync(join(pluginDir(root), "hooks", "register.js"));
}
const NOT_SHIPPED = "this agentmbx install does not ship the Claude plugin files (the single binary bundles none); install agentmbx with npm to get the mod";
export function execCli(bin, args, opts) {
    const r = spawnSync(bin, args, { cwd: opts.cwd, env: opts.env, encoding: "utf8", timeout: 30_000 });
    return { status: r.status, stdout: String(r.stdout ?? ""), stderr: String(r.stderr ?? "") };
}
function readText(path) {
    try {
        return readFileSync(path, "utf8");
    }
    catch {
        return null;
    }
}
function samePath(a, b) {
    try {
        return realpathSync(a) === realpathSync(b);
    }
    catch {
        return false;
    }
}
function walk(text, path) {
    let node = parseJsonc(text);
    for (const key of path) {
        if (node.kind !== "object")
            return null;
        const m = node.members.find((x) => x.key === key);
        if (!m)
            return null;
        node = m.value;
    }
    return node;
}
function memberValue(text, path, key) {
    const node = walk(text, path);
    if (!node || node.kind !== "object")
        return null;
    const m = node.members.find((x) => x.key === key);
    return m ? text.slice(m.value.start, m.value.end) : null;
}
function setOnly(text, path, key, jsonValue) {
    const root = parseJsonc(text);
    if (root.kind !== "object")
        return text;
    let obj = root;
    for (const p of path) {
        const m = obj.members.find((x) => x.key === p);
        if (!m)
            return setOnly(insertMember(text, obj, p, "{}"), path, key, jsonValue);
        if (m.value.kind !== "object")
            return text;
        obj = m.value;
    }
    const existing = obj.members.find((m) => m.key === key);
    return existing ? replaceValue(text, existing, jsonValue) : insertMember(text, obj, key, jsonValue);
}
function removeOnly(text, path, key) {
    const node = walk(text, path);
    if (!node || node.kind !== "object")
        return text;
    return node.members.some((x) => x.key === key) ? removeMember(text, node, key) : text;
}
/** Put the CLI's value for our key into the pre-image. Every other value keeps its original bytes. */
function adopt(before, after, path, key, want) {
    if (want === "absent") {
        if (before === null)
            return null;
        return removeOnly(before, path, key);
    }
    const raw = after ? memberValue(after, path, key) : null;
    if (raw === null)
        return before;
    return setOnly(before ?? "{\n}\n", path, key, raw);
}
function writeBack(path, before, next) {
    if (next === null)
        return;
    if (next === before)
        return;
    mkdirSync(dirname(path), { recursive: true });
    const mode = before !== null && existsSync(path) ? statSync(path).mode : 0o600;
    writeFileSync(path, next, { mode });
}
function jsonValue(text, path) {
    if (text === null)
        return undefined;
    try {
        const node = walk(text, path);
        if (!node)
            return undefined;
        return JSON.parse(text.slice(node.start, node.end));
    }
    catch {
        return undefined;
    }
}
function pathField(value) {
    if (!value || typeof value !== "object")
        return null;
    const o = value;
    if (typeof o.path === "string")
        return o.path;
    if (typeof o.installLocation === "string")
        return o.installLocation;
    if (o.source && typeof o.source === "object")
        return pathField(o.source);
    return null;
}
function marketplaceSlot(text, root) {
    const all = jsonValue(text, []);
    if (!all || typeof all !== "object" || Array.isArray(all) || !(CLAUDE_MARKETPLACE in all))
        return "absent";
    const hit = pathField(all[CLAUDE_MARKETPLACE]);
    return hit !== null && samePath(hit, root) ? "ours" : "foreign";
}
function enabledSlot(text) {
    const all = jsonValue(text, ["enabledPlugins"]);
    if (!all || typeof all !== "object" || Array.isArray(all))
        return "absent";
    const keys = Object.keys(all).filter((k) => k === CLAUDE_PLUGIN_ID || k.startsWith("agentmbx@"));
    if (!keys.length)
        return "absent";
    if (keys.length === 1 && keys[0] === CLAUDE_PLUGIN_ID && all[CLAUDE_PLUGIN_ID] === true)
        return "ours";
    return "foreign";
}
function installedSlot(text, root, home) {
    const all = jsonValue(text, ["plugins"]);
    if (!all || typeof all !== "object" || Array.isArray(all) || !(CLAUDE_PLUGIN_ID in all))
        return "absent";
    const rows = all[CLAUDE_PLUGIN_ID];
    const list = Array.isArray(rows) ? rows : [rows];
    const plugin = pluginDir(root);
    const owned = list.some((row) => {
        if (!row || typeof row !== "object")
            return false;
        const r = row;
        if (r.scope !== "user" || typeof r.installPath !== "string")
            return false;
        if (samePath(r.installPath, plugin))
            return true;
        const p = r.installPath;
        return p.includes(`${sep}.claude${sep}plugins${sep}cache${sep}agentmbx${sep}`)
            || p.includes(`${sep}.claude${sep}plugins${sep}marketplaces${sep}agentmbx${sep}`)
            || p.startsWith(join(home, ".claude", "plugins"));
    });
    return owned ? "ours" : "foreign";
}
/** The version Claude Code actually loads: its cached install, not the package's plugin.json (T542). */
export function installedClaudePluginVersion(home) {
    const all = jsonValue(readText(join(home, ".claude", "plugins", "installed_plugins.json")), ["plugins"]);
    const rows = all && typeof all === "object" ? all[CLAUDE_PLUGIN_ID] : undefined;
    const row = (Array.isArray(rows) ? rows : [rows]).find((r) => r && typeof r === "object" && r.scope === "user");
    return typeof row?.version === "string" ? row.version : null;
}
export function classifyClaudePlugin(home, root = packageRoot()) {
    const market = marketplaceSlot(readText(join(home, ".claude", "plugins", "known_marketplaces.json")), root);
    const enabled = enabledSlot(readText(join(home, ".claude", "settings.json")));
    const installed = installedSlot(readText(join(home, ".claude", "plugins", "installed_plugins.json")), root, home);
    const slots = [market, enabled, installed];
    if (slots.includes("foreign"))
        return { kind: "foreign", note: "a Claude plugin or marketplace named agentmbx points somewhere else and was left alone" };
    if (slots.every((s) => s === "ours"))
        return { kind: "ours" };
    if (slots.every((s) => s === "absent"))
        return { kind: "absent" };
    return { kind: "partial" };
}
const FILES = (home) => [
    { path: join(home, ".claude", "settings.json"), container: ["enabledPlugins"], key: CLAUDE_PLUGIN_ID },
    { path: join(home, ".claude", "plugins", "known_marketplaces.json"), container: [], key: CLAUDE_MARKETPLACE },
    { path: join(home, ".claude", "plugins", "installed_plugins.json"), container: ["plugins"], key: CLAUDE_PLUGIN_ID },
];
function reconcile(home, snapshots, want) {
    for (const f of FILES(home)) {
        const before = snapshots.get(f.path) ?? null;
        const after = readText(f.path);
        writeBack(f.path, after, adopt(before, after, f.container, f.key, want));
    }
}
function run(runner, root, home, args) {
    return runner("claude", args, { cwd: root, env: { ...process.env, HOME: home } });
}
export function claudePluginStep(home, mode, dryRun, runner, root = packageRoot()) {
    const path = join(home, ".claude", "settings.json");
    const state = classifyClaudePlugin(home, root);
    if (state.kind === "foreign")
        return { action: "manual", path, note: state.note };
    if (mode === "install" && state.kind === "ours") {
        const have = installedClaudePluginVersion(home);
        if (have === version())
            return { action: "unchanged", path, note: `${CLAUDE_PLUGIN_ID} already installed` };
        // T542: an npm upgrade refreshes the marketplace source, never Claude's cached copy.
        if (dryRun)
            return { action: "updated", path, note: `dry run: ${have ?? "unknown"} -> ${version()}` };
        const result = run(runner, root, home, ["plugin", "update", CLAUDE_PLUGIN_ID, "--scope", "user", "-y"]);
        const now = installedClaudePluginVersion(home);
        if (result.status !== 0 || now !== version()) {
            const detail = (result.stderr || result.stdout).trim().slice(0, 200);
            return { action: "error", path, note: `claude plugin update left ${now ?? "unknown"}, want ${version()}${detail ? `: ${detail}` : ""}` };
        }
        return { action: "updated", path, note: `${CLAUDE_PLUGIN_ID} ${have ?? "unknown"} -> ${version()} (restart Claude Code to load it)` };
    }
    if (mode === "install" && !shipsClaudePlugin(root))
        return { action: "skipped", path, note: NOT_SHIPPED };
    if (mode === "uninstall" && state.kind === "absent")
        return { action: "unchanged", path, note: "Claude plugin not installed" };
    if (dryRun)
        return { action: mode === "install" ? "added" : "removed", path, note: "dry run" };
    const snapshots = new Map(FILES(home).map((f) => [f.path, readText(f.path)]));
    const calls = mode === "install"
        ? [
            ...(state.kind === "partial" && marketplaceSlot(snapshots.get(join(home, ".claude", "plugins", "known_marketplaces.json")) ?? null, root) === "ours"
                ? []
                : [["plugin", "marketplace", "add", root, "--scope", "user"]]),
            ["plugin", "install", CLAUDE_PLUGIN_ID, "--scope", "user"],
        ]
        : [
            ["plugin", "uninstall", CLAUDE_PLUGIN_ID, "--scope", "user"],
            ["plugin", "marketplace", "remove", CLAUDE_MARKETPLACE],
        ];
    for (const args of calls) {
        const result = run(runner, root, home, args);
        if (result.status !== 0) {
            for (const [p, before] of snapshots) {
                if (before !== null)
                    writeBack(p, readText(p), before);
                else if (existsSync(p))
                    rmSync(p);
            }
            const detail = (result.stderr || result.stdout).trim().slice(0, 200);
            return { action: "error", path, note: detail ? `claude ${args.join(" ")} failed: ${detail}` : `claude ${args.join(" ")} failed` };
        }
    }
    reconcile(home, snapshots, mode === "install" ? "present" : "absent");
    const done = classifyClaudePlugin(home, root);
    if (mode === "install" && done.kind !== "ours")
        return { action: "error", path, note: "claude plugin install did not register agentmbx@agentmbx" };
    if (mode === "uninstall" && done.kind !== "absent")
        return { action: "error", path, note: "claude plugin uninstall left agentmbx registered" };
    return { action: mode === "install" ? "added" : "removed", path, note: CLAUDE_PLUGIN_ID };
}
export function claudePluginChecks(home, opts, root = packageRoot()) {
    const state = classifyClaudePlugin(home, root);
    const fix = "agentmbx setup --only claude";
    if (state.kind === "foreign")
        return [{ level: "info", label: "claude: plugin marketplace is not ours and was left alone" }];
    if (state.kind === "absent" && !shipsClaudePlugin(root))
        return [{ level: "info", label: `claude: plugin not installed (${NOT_SHIPPED})` }];
    if (state.kind === "absent" || state.kind === "partial")
        return [{ level: "warn", label: "claude: plugin not installed", fix }];
    const dir = pluginDir(root);
    const hooks = existsSync(join(dir, "hooks", "hooks.json")) && existsSync(join(dir, "hooks", "register.js"));
    let pluginVersion = "";
    try {
        pluginVersion = JSON.parse(readFileSync(join(dir, ".claude-plugin", "plugin.json"), "utf8")).version ?? "";
    }
    catch { /* missing */ }
    const versionOk = pluginVersion === version();
    const mayRun = opts.runCli !== undefined || (opts.useClis && opts.which("claude") !== null && process.env.AGENTMBX_DEV !== "1");
    let validated = false;
    let validateOk = false;
    if (mayRun) {
        const runner = opts.runCli ?? execCli;
        const result = run(runner, root, home, ["plugin", "validate", dir]);
        validated = true;
        validateOk = result.status === 0;
    }
    const installed = installedClaudePluginVersion(home);
    if (installed !== version())
        return [{ level: "warn", label: `claude: loaded plugin is ${installed ?? "unknown"}, agentmbx is ${version()}`, fix }];
    if (!hooks || !versionOk || (validated && !validateOk))
        return [{ level: "warn", label: "claude: plugin installed but it does not load", fix }];
    return [{ level: "ok", label: validated ? "claude: plugin installed and loads (agentmbx@agentmbx)" : "claude: plugin installed (agentmbx@agentmbx)" }];
}
