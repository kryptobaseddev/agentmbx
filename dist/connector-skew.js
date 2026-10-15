// T661: version skew between the installed agentmbx and what a live session actually runs. A stdio MCP connector loads its
// code once, so after an update a session keeps the old build until its next mbx tool call hands the transport to a fresh
// process (the in-place handover in mcp.ts). An OpenCode serve loads the plugin file once too, and nothing hands that over:
// only reopening the tab loads a newer file, and only `agentmbx setup --only opencode` writes a newer template.
//
// Doctor reports every live connector that is behind the installed build, for every harness, from the connector's own
// self-report (kv `connector:<pid>`, published by that process with its birth). The daemon tells a live standalone OpenCode
// session once per (connector version, installed version) pair, through the same poller queue a wake uses.
import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { connectorKey } from "./diagnostics.js";
import { inspectLeaseProcesses } from "./identity-leases.js";
import { pollerTargetLive } from "./opencode-poller.js";
import { pushOpencodeWake } from "./opencode-wake-queue.js";
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
/** The OpenCode plugin file setup manages, judged the way doctor's wiring row judges it. */
export function opencodePluginState(ctx, read = readSmall) {
    const home = ctx?.home ?? homedir();
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
    let templateCurrent = null;
    try {
        const e = edits(ctx ?? { home, cmd: resolveCommand(home), which: () => null, useClis: false }, "opencode").find(x => x.kind === "hooks");
        if (e && header)
            templateCurrent = !!e.isWired?.(cur) || e.install(cur) === cur;
    }
    catch {
        templateCurrent = null;
    }
    return { headerVersion: header ? header[1] : null, mtimeMs, templateCurrent };
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
    let live;
    try {
        live = liveConnectors(node, opts);
    }
    catch (error) {
        return [{ level: "info", label: `connectors: version skew not assessed (${error.message.slice(0, 120)})` }];
    }
    if (!live.length)
        return [];
    const installed = opts.installed ?? version();
    const behind = live.filter(c => c.relation === "behind" && c.session_id), unknown = live.filter(c => c.relation === "unknown");
    // An unbound connector names no session; many old idle ones would bury the sessions, so they share one row.
    const unbound = live.filter(c => c.relation === "behind" && !c.session_id);
    const checks = [];
    let plugin = null;
    const serveStart = node.store.db.prepare("SELECT pid_start FROM sessions WHERE cli='opencode' AND session_id=? AND pid IS NOT NULL ORDER BY updated_at DESC LIMIT 1");
    for (const c of behind.slice(0, DOCTOR_LIMIT)) {
        const who = `session ${c.session_id} (${c.agent})`;
        let fix = "its next mbx tool call switches it to the installed build in place; if it stays behind, restart that session";
        if (c.cli === "opencode" && c.session_id) {
            plugin ??= opts.plugin ?? opencodePluginState(opts.ctx);
            const step = opencodePluginStep(plugin, serveStart.get(c.session_id)?.pid_start);
            if (step)
                fix += `; for its OpenCode plugin, ${step}`;
        }
        checks.push({ level: "warn", label: `${c.cli ?? "unknown cli"}: ${who} runs connector ${c.version}; installed ${installed}`, fix });
    }
    if (unbound.length)
        checks.push({ level: "warn", label: `connectors: ${unbound.length} unbound connector(s) behind ${installed}: ${unbound.slice(0, 8).map(c => `${c.cli ?? "?"} pid ${c.pid} on ${c.version}`).join(", ")}${unbound.length > 8 ? ", …" : ""}`,
            fix: "an unbound connector holds no mailbox; it switches on its next mbx tool call, or ends with its session" });
    if (behind.length > DOCTOR_LIMIT)
        checks.push({ level: "info", label: `connectors: ${behind.length - DOCTOR_LIMIT} more behind ${installed} not listed` });
    if (unknown.length)
        checks.push({ level: "info", label: `connectors: ${unknown.length} live connector(s) report no comparable version (pid ${unknown.slice(0, 5).map(c => c.pid).join(", ")})` });
    if (!behind.length && !unbound.length)
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
 * One pass: every bound standalone OpenCode session whose connector is behind and whose plugin is polling gets the note
 * once. The key is claimed before the push and kept when the text left (a missing receipt still means it was handed off),
 * so a retry never repeats a delivered note; a refused push frees the claim for the next tick.
 *
 * The poller admits with resume:true (admitWake in the plugin), so the note STARTS A TURN like a wake does; there is no
 * non-turn-starting variant in the poll protocol. On a busy session delivery "queue" holds it until that turn ends.
 */
export async function noteConnectorSkew(node, deps = {}) {
    const installed = deps.installed ?? version(), now = deps.now ?? Date.now();
    const behind = liveConnectors(node, deps).filter(c => c.relation === "behind" && c.cli === "opencode" && c.session_id && c.agent);
    if (!behind.length)
        return [];
    const push = deps.push ?? ((sid, pid, text) => pushOpencodeWake(sid, pid, text));
    const live = deps.live ?? ((s) => pollerTargetLive(node, s));
    let plugin = null;
    const sent = [];
    for (const c of behind) {
        const session = node.store.db.prepare("SELECT * FROM sessions WHERE cli='opencode' AND session_id=? AND agent=?").get(c.session_id, c.agent);
        if (!session?.pid || !live(session))
            continue;
        const key = skewNoteKey(c.session_id, c.version, installed);
        const claim = node.store.tx(() => {
            const prev = node.store.get(key);
            if (prev) {
                try {
                    if ((JSON.parse(prev).pending_until ?? Infinity) > now)
                        return null;
                }
                catch {
                    return null;
                }
            }
            const value = JSON.stringify({ pending_until: now + 60_000, at: now });
            node.store.set(key, value);
            return value;
        });
        if (!claim)
            continue;
        plugin ??= deps.plugin ?? opencodePluginState();
        const text = skewNoteText(c.version, installed, opencodePluginStep(plugin, session.pid_start));
        let result = { ok: false, handedOff: false };
        try {
            result = await push(session.session_id, session.pid, text);
        }
        catch { /* retry next tick */ }
        const delivered = result.ok || result.handedOff;
        node.store.tx(() => {
            if (node.store.get(key) !== claim)
                return;
            if (delivered)
                node.store.set(key, JSON.stringify({ noted_at: now, receipt: result.ok ? result.id : null }));
            else
                node.store.db.prepare("DELETE FROM kv WHERE k=? AND v=?").run(key, claim);
        });
        if (delivered) {
            node.store.audit("connector.skew_noted", { agent: c.agent, cli: "opencode", session: c.session_id, connector: c.version, installed, receipt: result.ok ? result.id : null });
            sent.push(c.session_id);
        }
    }
    return sent;
}
/** Daemon-only, armed from the loop reporter's arm. A slow push cannot overlap its own next tick. */
export function armConnectorSkewNotes(node) {
    let busy = false;
    const tick = () => {
        if (busy)
            return;
        busy = true;
        void noteConnectorSkew(node).catch(error => {
            process.stderr.write(`[agentmbx] connector skew notes: ${String(error).replace(/\s+/g, " ").slice(0, 300)}\n`);
        }).finally(() => { busy = false; });
    };
    setInterval(tick, 60_000).unref();
    setTimeout(tick, 5_000).unref();
}
