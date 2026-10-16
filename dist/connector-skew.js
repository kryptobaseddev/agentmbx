// T661: version skew between the installed agentmbx and what a live session actually runs. A stdio MCP connector loads its
// code once, so after an update a session keeps the old build until its next mbx tool call hands the transport to a fresh
// process (the in-place handover in mcp.ts). An OpenCode serve loads the plugin file once too, and nothing hands that over:
// only reopening the tab loads a newer file, and only `agentmbx setup --only opencode` writes a newer template.
//
// Doctor reports every live connector that is behind the installed build, for every harness, from the connector's own
// self-report (kv `connector:<pid>`, published by that process with its birth). A live OpenCode session is told once per
// (connector version, installed version) pair, on the next real wake it gets: the note never starts a turn of its own.
import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { connectorKey } from "./diagnostics.js";
import { inspectLeaseProcesses } from "./identity-leases.js";
import { recordedStartEpochMs, recordedStartMatches } from "./proc.js";
import { edits, opencodePluginPath, resolveCommand } from "./setup.js";
import { version } from "./version.js";
const VERSION_RE = /^(\d{1,6})\.(\d{1,6})\.(\d{1,6})(?:-([0-9A-Za-z.-]{1,40}))?$/;
/** -1, 0 or 1 like a comparator; null when either side is not a release version (unknown is never "behind"). A prerelease
 *  sorts before its release. */
export function compareVersions(a, b) {
    if (typeof a !== "string" || typeof b !== "string")
        return null;
    const x = VERSION_RE.exec(a), y = VERSION_RE.exec(b);
    if (!x || !y)
        return null;
    for (let i = 1; i <= 3; i++) {
        const d = Number(x[i]) - Number(y[i]);
        if (d)
            return d < 0 ? -1 : 1;
    }
    if (x[4] === y[4])
        return 0;
    if (!x[4])
        return 1;
    if (!y[4])
        return -1;
    return x[4] < y[4] ? -1 : 1;
}
/** Every connector whose self-report names a process that is alive with that same birth. A report from a dead or reused pid
 *  is not a running build, and neither is a malformed one. */
export function liveConnectors(node, opts = {}) {
    const installed = opts.installed ?? version();
    const rows = node.store.db.prepare("SELECT k, v FROM kv WHERE k GLOB 'connector:*' ORDER BY k LIMIT 500").all();
    const parsed = [];
    for (const { k, v } of rows) {
        let r;
        try {
            r = JSON.parse(v);
        }
        catch {
            continue;
        }
        if (!r || r.v !== 1 || typeof r.pid !== "number" || !Number.isSafeInteger(r.pid) || r.pid <= 1 || k !== connectorKey(r.pid) || typeof r.start !== "string")
            continue;
        parsed.push({ pid: r.pid, start: r.start, version: r.version, cli: r.cli });
    }
    if (!parsed.length)
        return [];
    const evidence = (opts.inspect ?? inspectLeaseProcesses)(parsed.map(p => p.pid));
    const lease = node.store.db.prepare("SELECT name, cli, session_id FROM identity_leases WHERE holder_pid=? AND holder_start=? AND released_at IS NULL LIMIT 1");
    const out = [];
    for (const p of parsed) {
        const e = evidence.get(p.pid);
        if (e?.alive !== true || !e.start || !recordedStartMatches(p.start, e.start))
            continue;
        const held = lease.get(p.pid, p.start);
        const ver = typeof p.version === "string" && VERSION_RE.test(p.version) ? p.version : null;
        const c = compareVersions(ver, installed);
        out.push({ pid: p.pid, cli: held?.cli ?? (typeof p.cli === "string" && /^[a-z0-9-]{1,32}$/.test(p.cli) ? p.cli : null), version: ver, installed,
            relation: c === null ? "unknown" : c < 0 ? "behind" : c > 0 ? "ahead" : "equal", agent: held?.name ?? null, session_id: held?.session_id ?? null });
    }
    return out;
}
const HEADER_RE = /^\/\/ agentmbx-plugin v1 \(T391\) — managed by `agentmbx setup --only opencode` \(agentmbx ([^)\s]{1,60})\)/;
/** The managed file's header and mtime only: cheap enough for the wake path, which must not read config. */
export function opencodePluginFile(home = homedir(), read = readSmall) {
    const path = opencodePluginPath(home);
    const cur = read(path);
    if (cur === null)
        return { headerVersion: null, mtimeMs: null, templateCurrent: null };
    let mtimeMs = null;
    try {
        mtimeMs = statSync(path).mtimeMs;
    }
    catch { /* unknown */ }
    const header = HEADER_RE.exec(cur);
    return { headerVersion: header ? header[1] : null, mtimeMs, templateCurrent: null };
}
/** The OpenCode plugin file setup manages, judged the way doctor's wiring row judges it. */
export function opencodePluginState(ctx, read = readSmall) {
    const home = ctx?.home ?? homedir();
    const state = opencodePluginFile(home, read);
    if (state.mtimeMs === null && state.headerVersion === null)
        return state;
    const path = opencodePluginPath(home);
    let templateCurrent = null;
    try {
        const e = edits(ctx ?? { home, cmd: resolveCommand(home), which: () => null, useClis: false }, "opencode").find(x => x.kind === "hooks");
        const cur = read(path);
        if (e && cur !== null && HEADER_RE.test(cur))
            templateCurrent = !!e.isWired?.(cur) || e.install(cur) === cur;
    }
    catch {
        templateCurrent = null;
    }
    return { ...state, templateCurrent };
}
function readSmall(path) {
    try {
        return statSync(path).size > 262_144 ? null : readFileSync(path, "utf8");
    }
    catch {
        return null;
    }
}
/** True when the serve that hosts this session started before the plugin file it would load now was written. */
export function servedOlderPlugin(serveStart, plugin) {
    if (!serveStart || plugin.mtimeMs === null)
        return false;
    const born = recordedStartEpochMs(serveStart);
    // lstart has one-second resolution: only a file written a full second after the serve started is newer.
    return born !== null && plugin.mtimeMs >= born + 1000;
}
/** The exact step for a session's OpenCode plugin, or null when the plugin it loaded is current. */
export function opencodePluginStep(plugin, serveStart) {
    if (plugin.templateCurrent === false)
        return "run `agentmbx setup --only opencode`, then reopen the tab";
    if (servedOlderPlugin(serveStart, plugin))
        return "reopen the tab to load the plugin file written since it started";
    return null;
}
const DOCTOR_LIMIT = 20;
/** Doctor rows: one warn per live connector behind the installed build, naming its session and both versions. */
export function connectorSkewChecks(node, opts = {}) {
    let live = [];
    try {
        live = liveConnectors(node, opts);
    }
    catch (error) {
        return [{ level: "info", label: `connectors: version skew not assessed (${error.message.slice(0, 120)})` }];
    }
    const installed = opts.installed ?? version();
    const behind = live.filter(c => c.relation === "behind" && c.session_id), unknown = live.filter(c => c.relation === "unknown");
    // An unbound connector names no session; many old idle ones would bury the sessions, so they share one row.
    const unbound = live.filter(c => c.relation === "behind" && !c.session_id);
    const checks = [];
    let plugin = null;
    const pluginOf = () => (plugin ??= opts.plugin ?? opencodePluginState(opts.ctx));
    const serveStart = node.store.db.prepare("SELECT pid_start FROM sessions WHERE cli='opencode' AND session_id=? AND pid IS NOT NULL ORDER BY updated_at DESC LIMIT 1");
    for (const c of behind.slice(0, DOCTOR_LIMIT)) {
        const who = `session ${c.session_id} (${c.agent})`;
        let fix = "its next mbx tool call switches it to the installed build in place; if it stays behind, restart that session";
        if (c.cli === "opencode" && c.session_id) {
            const step = opencodePluginStep(pluginOf(), serveStart.get(c.session_id)?.pid_start);
            if (step)
                fix += `; for its OpenCode plugin, ${step}`;
        }
        checks.push({ level: "warn", label: `${c.cli ?? "unknown cli"}: ${who} runs connector ${c.version}; installed ${installed}`, fix });
    }
    // T669: a current connector says nothing about the plugin module a running serve already loaded. The in-place handover
    // switches the MCP, and nothing hands the plugin over, so a session can run an older plugin with a current connector.
    // A behind row above already carries that session's plugin step, so only the rest get a row here.
    const covered = new Set(behind.filter(c => c.cli === "opencode" && c.session_id).map(c => c.session_id));
    const stalePlugin = opencodeSessions(node).filter(s => !covered.has(s.session_id) && opencodePluginStep(pluginOf(), s.pid_start));
    for (const s of stalePlugin.slice(0, DOCTOR_LIMIT)) {
        const step = opencodePluginStep(pluginOf(), s.pid_start);
        checks.push({ level: "warn", label: `opencode: session ${s.session_id} (${s.agent}) runs an older plugin module than the installed ${installed}`,
            fix: `its mbx connector switches in place and needs no restart; the plugin does not: ${step}` });
    }
    if (stalePlugin.length > DOCTOR_LIMIT)
        checks.push({ level: "info", label: `opencode: ${stalePlugin.length - DOCTOR_LIMIT} more session(s) with a stale plugin module not listed` });
    if (unbound.length)
        checks.push({ level: "warn", label: `connectors: ${unbound.length} unbound connector(s) behind ${installed}: ${unbound.slice(0, 8).map(c => `${c.cli ?? "?"} pid ${c.pid} on ${c.version}`).join(", ")}${unbound.length > 8 ? ", …" : ""}`,
            fix: "an unbound connector holds no mailbox; it switches on its next mbx tool call, or ends with its session" });
    if (behind.length > DOCTOR_LIMIT)
        checks.push({ level: "info", label: `connectors: ${behind.length - DOCTOR_LIMIT} more behind ${installed} not listed` });
    if (unknown.length)
        checks.push({ level: "info", label: `connectors: ${unknown.length} live connector(s) report no comparable version (pid ${unknown.slice(0, 5).map(c => c.pid).join(", ")})` });
    if (!behind.length && !unbound.length && live.length)
        checks.push({ level: "ok", label: `connectors: ${live.length - unknown.length} live connector(s), none behind ${installed}` });
    return checks;
}
/** The note a live OpenCode session gets once per (connector version, installed version) pair. */
export function skewNoteText(connector, installed, pluginStep) {
    return `[mbx] AgentMBX ${installed} is installed; this session's mbx connector still runs ${connector}. Your next mbx tool call switches it to ${installed} in place, with no restart.`
        + (pluginStep ? ` The OpenCode plugin is not switched that way: ${pluginStep}.` : "");
}
export const skewNoteKey = (sessionId, connector, installed) => `connector-skew-note:opencode:${sessionId}:${connector}->${installed}`;
/**
 * T669: a session whose connector is already current can still run an older plugin module, because nothing hands the
 * plugin over in place. Once per stale plugin file (its header version and mtime identify it), the session is told the
 * exact reload step on its next real wake, exactly the way a connector-behind note rides one.
 */
export function pluginSkewNoteText(installed, step) {
    return `[mbx] AgentMBX ${installed} is installed; this session's OpenCode plugin still runs the code its serve loaded at start.`
        + ` The mbx connector switches in place, the plugin does not: ${step}.`;
}
export const pluginSkewNoteKey = (sessionId, plugin) => `connector-skew-note:opencode:${sessionId}:plugin:${plugin.headerVersion ?? "unknown"}@${plugin.mtimeMs ?? 0}`;
/** Live OpenCode sessions doctor judges a running plugin for: one exact row per session, newest first. */
function opencodeSessions(node) {
    return node.store.db.prepare("SELECT agent, session_id, pid_start FROM sessions WHERE cli='opencode' AND session_id NOT LIKE 'mcp-%' AND pid IS NOT NULL ORDER BY updated_at DESC")
        .all();
}
/** Test seam: the plugin state the wake note judges (the cheap file read; doctor uses the full state). */
export const skewSeams = { plugin: () => opencodePluginFile() };
/** This session's own live, behind connector, or null: the report must be from the holder's process birth. */
function behindConnector(node, session, installed, inspect) {
    const lease = node.store.db.prepare("SELECT holder_pid, holder_start FROM identity_leases WHERE name=? AND cli='opencode' AND session_id=? AND released_at IS NULL")
        .get(session.agent, session.session_id);
    if (!lease)
        return null; // an evicted MCP restarts on the installed build: nothing to say about the connector
    const raw = node.store.get(connectorKey(lease.holder_pid));
    if (!raw)
        return null;
    const r = JSON.parse(raw);
    if (r?.v !== 1 || r.pid !== lease.holder_pid || r.start !== lease.holder_start || typeof r.version !== "string")
        return null;
    if (compareVersions(r.version, installed) !== -1)
        return null;
    const e = (inspect ?? inspectLeaseProcesses)([lease.holder_pid]).get(lease.holder_pid);
    if (e?.alive !== true || !e.start || !recordedStartMatches(lease.holder_start, e.start))
        return null;
    return r.version;
}
/**
 * The one-line note for a wake about to go to this OpenCode session, or null. It covers what is actually stale:
 * the connector (once per session, connector version and installed version), the plugin module the serve already
 * loaded (once per stale plugin file), or both in one note — a single wake never carries two notes. The caller marks
 * it with markSkewNoted when the wake was admitted. It rides a real wake and never starts a turn of its own.
 */
export function wakeSkewNote(node, session, opts = {}) {
    try {
        if (session.cli !== "opencode")
            return null;
        const installed = opts.installed ?? version();
        const plugin = opts.plugin ?? skewSeams.plugin();
        const step = opencodePluginStep(plugin, session.pid_start);
        const connector = behindConnector(node, session, installed, opts.inspect);
        if (connector) {
            const key = skewNoteKey(session.session_id, connector, installed);
            if (node.store.get(key))
                return null;
            return { key, text: skewNoteText(connector, installed, step), agent: session.agent, session_id: session.session_id, connector, plugin: null, installed };
        }
        // T669: the connector is current, but this serve loaded an older plugin file than the one on disk.
        if (!step)
            return null;
        const key = pluginSkewNoteKey(session.session_id, plugin);
        if (node.store.get(key))
            return null;
        return { key, text: pluginSkewNoteText(installed, step), agent: session.agent, session_id: session.session_id, connector: null,
            plugin: `${plugin.headerVersion ?? "unknown"}@${plugin.mtimeMs ?? 0}`, installed };
    }
    catch {
        return null;
    } // never let a diagnostic note cost a wake
}
/** Called only after the wake carrying the note was admitted. */
export function markSkewNoted(node, note, receipt) {
    try {
        node.store.set(note.key, JSON.stringify({ noted_at: Date.now(), receipt }));
        node.store.audit("connector.skew_noted", { agent: note.agent, cli: "opencode", session: note.session_id, connector: note.connector,
            plugin: note.plugin, installed: note.installed, receipt });
    }
    catch { /* the wake already happened; a missing mark only means the note can ride one more wake */ }
}
