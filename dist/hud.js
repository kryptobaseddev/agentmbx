// HUD snapshot files (T312): the daemon writes one small JSON file per bound session and, only
// when the T310 resolver proves a single holder, per holder pid+start; `agentmbx statusline <cli>`
// adapters (T313) read a single file with one cat — never SQL against the store, never a directory
// lookup. Writes are atomic (temp file + rename), private (0700/0600), content-compared, and the
// daemon touches hud/.alive every tick so adapters refuse stale renders when the daemon is down.
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { activePolicies } from "./policy.js";
import { registeredIdentity, projectIdentities, projectOf } from "./registry.js";
import { projectLeadView } from "./lead-record.js";
import { identityLeaseStatus, inspectLeaseProcess, inspectLeaseProcesses } from "./identity-leases.js";
import { relayFor } from "./relay-client.js";
import { relayState } from "./relay-v2.js";
import { resolveStatusIdentity } from "./status-identity.js";
import { STATUS_V2_SCHEMA } from "./status-schema.js";
import { sweepPostToolMarkers } from "./posttool.js";
import { procStart } from "./proc.js";
import { updateAvailable } from "./update.js";
import { version } from "./version.js";
export const HUD_SCHEMA = "mbx.status/v1";
export const HUD_ALIVE_MAX_MS = 10_000;
export const hudDir = (home) => join(home, "hud");
/** Session snapshots are namespaced by CLI so an OpenCode id can never satisfy a Kimi statusline. */
export const hudSessionPath = (home, cli, sessionId) => join(hudDir(home), `${cli}-${sessionId}.json`);
/** Pid snapshots carry cli, pid AND birth time: two processes started in the same second never collide. */
export const hudPidPath = (home, cli, pid, start) => join(hudDir(home), `${cli}-pid-${pid}-${start.replaceAll(/[^0-9A-Za-z_-]/g, "")}.json`);
export const hudSessionLinePath = (home, cli, sessionId) => join(hudDir(home), `${cli}-${sessionId}.line`);
export const hudPidLinePath = (home, cli, pid, start) => join(hudDir(home), `${cli}-pid-${pid}-${start.replaceAll(/[^0-9A-Za-z_-]/g, "")}.line`);
export const hudAlivePath = (home) => join(hudDir(home), ".alive");
const CLI_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;
const SID_RE = /^[A-Za-z0-9_-]{1,128}$/;
/** Build one mbx.status/v1 snapshot. `from_owner` re-checks authority now, so a revoked grant drops out. */
export function hudStatus(node, o) {
    const name = o.agent;
    const rows = name
        ? node.store.db.prepare(`SELECT m.* FROM deliveries d JOIN messages m ON m.id = d.msg_id
        WHERE d.agent = ? AND d.state <> 'acked'`).all(name)
        : [];
    let unread = 0, needs_reply = 0, from_owner = 0;
    for (const row of rows) {
        unread += 1;
        const e = JSON.parse(row.envelope);
        if (e.needs_reply)
            needs_reply += 1;
        if (e.authority != null && node.authorityFor(row)?.ok)
            from_owner += 1; // re-checked now, not just on arrival
    }
    const outbox = name
        ? node.store.db.prepare(`SELECT COUNT(DISTINCT o.msg_id) n FROM outbox o JOIN messages m ON m.id = o.msg_id
        WHERE substr(m.from_addr, 1, instr(m.from_addr, '@') - 1) = ?`).get(name)
        : { n: 0 };
    const role = name ? registeredIdentity(node.store, name)?.role
        ?? (node.agents().find((a) => a.name === name && a.host === node.host)?.role ?? null) : null;
    const policies = name ? activePolicies(node.store.db, name, node.host) : [];
    return {
        schema: HUD_SCHEMA, mbx_version: version(), update_available: updateAvailable(node.store),
        identity: { name, role, state: o.state, ...(o.candidates ? { candidates: o.candidates } : {}) },
        unread, needs_reply, from_owner,
        outbox_unsent: Number(outbox.n),
        policy: policies.map((p) => p.level),
        resolved_by: o.resolvedBy,
    };
}
/** The pre-rendered statusline segment: the daemon writes it next to each snapshot so the adapter
 *  is one `cat` with no JSON parsing (review: node startup already dominates the render budget). */
export function hudLine(snap) {
    const tag = snap.identity.name + (snap.identity.role ? `(${snap.identity.role})` : "");
    const seg = [tag];
    if (snap.unread)
        seg.push(`${snap.unread}↑`);
    if (snap.needs_reply)
        seg.push(`${snap.needs_reply}↺`);
    if (snap.from_owner)
        seg.push(`owner:${snap.from_owner}`);
    if (snap.outbox_unsent)
        seg.push(`${snap.outbox_unsent} unsent`);
    if (snap.update_available)
        seg.push(`*v${snap.update_available}`);
    return `mbx ${seg.join(" ")}`;
}
// T366: Kimi's `[status_line].command` REPLACES the built-in footer (the T347 premise that `items`
// and `command` compose was wrong), so every kimi-rendered line is alert-only: with nothing to show
// (unread == 0) the line is EMPTY and Kimi renders its own footer items untouched; with unread mail
// the alert takes footer line 1. Every other CLI's command composes with its built-in items and its
// line is unchanged. Unbound/ambiguous rows never reach this — the writer skips them before render.
const cliLine = (cli, snap) => cli === "kimi" && !snap.unread ? "" : hudLine(snap);
const writeSeg = (path, seg) => writeIfChanged(path, seg ? `${seg}\n` : "");
const writeIfChanged = (path, content) => {
    try {
        if (readFileSync(path, "utf8") === content)
            return;
    }
    catch { /* absent: write */ }
    const tmp = `${path}.tmp-${process.pid}`;
    writeFileSync(tmp, content, { mode: 0o600 });
    renameSync(tmp, path); // atomic on POSIX: statuslines always read a complete file
    chmodSync(path, 0o600);
};
/**
 * Write snapshots for every bound session and (only when the resolver proves one holder) holder
 * pid+start; drop files whose binding vanished; touch .alive. Per-row failures never abort the
 * pass, and the whole step is wrapped by the caller's own try.
 */
export function writeHud(node, now = Date.now()) {
    const dir = hudDir(node.home);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    chmodSync(dir, 0o700);
    const rows = node.store.db.prepare(`SELECT agent, cli, session_id, pid, pid_start, updated_at FROM sessions
    WHERE session_id NOT LIKE 'mcp-%'`).all();
    const wanted = new Set();
    const perAgent = new Map(); // computed once per agent, not per row (review low 8)
    const pidDone = new Set();
    // One ps for every distinct pid, not one per row (review low 4).
    const pids = [...new Set(rows.map((r) => r.pid).filter((p) => !!p))];
    const evidence = new Map();
    try {
        for (const [pid, ev] of inspectLeaseProcesses(pids))
            evidence.set(pid, ev);
    }
    catch { /* evidence unavailable: pid files are skipped this pass */ }
    for (const row of rows) {
        try {
            if (!CLI_RE.test(row.cli) || !SID_RE.test(row.session_id))
                continue; // writer-side id validation
            // Review round 3: a row whose pid this pass proves dead (or a row with no pid at all, which can
            // never be proven live — no production binder omits a pid) renders until the reaper deletes the
            // binding. Skip it so its stale files prune now. Absent evidence is not proof of death.
            if (!row.pid)
                continue;
            if (evidence.get(row.pid)?.alive === false)
                continue;
            // Round 4: a REUSED pid is alive but belongs to a different process. procStart and the row's
            // recorded pid_start come from the same process table (same string format on every platform), so
            // a positive mismatch proves reuse. No start evidence (empty table): do not skip.
            const liveStart = procStart(row.pid);
            if (row.pid_start && liveStart && liveStart !== row.pid_start)
                continue;
            const resolved = resolveStatusIdentity(node, row.cli, { sessionId: row.session_id, pid: row.pid });
            if (resolved.state !== "bound" || !resolved.name)
                continue; // never render unbound or ambiguous (review low 9)
            let snapshot = perAgent.get(resolved.name);
            if (snapshot === undefined) {
                snapshot = JSON.stringify(hudStatus(node, { agent: resolved.name, state: "bound", resolvedBy: resolved.resolved_by === "pid" ? "pid" : "session_id" }));
                perAgent.set(resolved.name, snapshot);
            }
            wanted.add(hudSessionPath(node.home, row.cli, row.session_id));
            writeIfChanged(hudSessionPath(node.home, row.cli, row.session_id), snapshot);
            const line = cliLine(row.cli, JSON.parse(snapshot));
            wanted.add(hudSessionLinePath(node.home, row.cli, row.session_id));
            writeSeg(hudSessionLinePath(node.home, row.cli, row.session_id), line);
            // Critical fix: a pid file is written per (cli, pid) only when a pid-ONLY resolution proves a
            // single holder — keyed by the pid's birth time so a reused pid can never inherit another
            // agent's mail, and never written while the pid is ambiguous (the owner's probe).
            if (row.pid && !pidDone.has(`${row.cli}:${row.pid}`)) {
                pidDone.add(`${row.cli}:${row.pid}`);
                const byPid = resolveStatusIdentity(node, row.cli, { pid: row.pid });
                if (byPid.state === "bound" && byPid.name && byPid.resolved_by === "pid") {
                    const start = evidence.get(row.pid)?.start ?? null;
                    if (start) {
                        const pidKey = `pid:${byPid.name}`; // never reuse a session-keyed snapshot's resolved_by
                        let pidSnap = perAgent.get(pidKey);
                        if (pidSnap === undefined) {
                            pidSnap = JSON.stringify(hudStatus(node, { agent: byPid.name, state: "bound", resolvedBy: "pid" }));
                            perAgent.set(pidKey, pidSnap);
                        }
                        const p = hudPidPath(node.home, row.cli, row.pid, start);
                        wanted.add(p);
                        writeIfChanged(p, pidSnap);
                        const pl = hudPidLinePath(node.home, row.cli, row.pid, start);
                        wanted.add(pl);
                        writeSeg(pl, cliLine(row.cli, JSON.parse(pidSnap)));
                    }
                }
            }
        }
        catch { /* one bad row never aborts the pass */ }
    }
    // Files whose binding vanished go on the next tick — not after a grace period (review high 2).
    for (const file of readdirSync(dir)) {
        const path = join(dir, file);
        if (wanted.has(path) || file === ".alive")
            continue;
        try {
            unlinkSync(path);
        }
        catch { /* gone: fine */ }
    }
    // T342: post-tool markers outlive released/reaped sessions; delete files whose session is not bound.
    sweepPostToolMarkers(node.home, new Set(rows.map((r) => `${r.cli}-${r.session_id}`)));
    // Heartbeat: adapters refuse to render from a snapshot older than HUD_ALIVE_MAX_MS.
    const alive = String(now);
    try {
        if (readFileSync(hudAlivePath(node.home), "utf8") !== alive)
            writeFileSync(hudAlivePath(node.home), alive, { mode: 0o600 });
    }
    catch {
        writeFileSync(hudAlivePath(node.home), alive, { mode: 0o600 });
    }
}
/** How a cli session is woken when mail wants it; informational, from the cli's wiring (src/wake.ts). */
const WAKE_PATH = {
    claude: "channel", // pushed through the session's inbox socket (sessions.channel)
    codex: "queue", // `codex queue`
    opencode: "api", // service API synthetic endpoint
    kimi: "watcher", // terminal Kimi wakes through `agentmbx watch`; the desktop app has its own socket
    hermes: "watcher", // the Hermes bg-process watcher is the wake path (T460)
    grok: "watcher", // Grok wakes through `agentmbx watch` (T435)
    copilot: "none",
    cursor: "none",
    gemini: "none",
};
/**
 * The mbx.status/v2 emitter (T404): one v2 snapshot for a (cli, session) pair, built on top of the v1
 * hudStatus snapshot so the two schemas never disagree on counts. Identity resolution is the caller's
 * (the T310 resolver at every call site): an unbound session yields an explicit unbound result, never an
 * error and never another identity's mailbox. Served by the T407 loopback endpoint and `agentmbx status
 * --schema mbx.status/v2` (T406); `sessionId` may be null for pid-resolved CLI calls, which skip the
 * lease/session-row lookups that need a session id.
 */
export function hudStatusV2(node, o) {
    const v1 = hudStatus(node, { agent: o.agent, state: o.state, resolvedBy: o.resolvedBy, candidates: o.candidates });
    const name = o.agent;
    const sessionRow = o.sessionId
        ? node.store.db.prepare("SELECT cwd, channel FROM sessions WHERE cli=? AND session_id=?").get(o.cli, o.sessionId)
        : undefined;
    const leaseRow = name && o.sessionId
        ? node.store.db.prepare("SELECT * FROM identity_leases WHERE name=? AND cli=? AND session_id=? AND released_at IS NULL")
            .get(name, o.cli, o.sessionId)
        : undefined;
    const projectDir = sessionRow?.cwd ? projectOf(sessionRow.cwd) : undefined;
    const relayUrl = relayFor(node);
    const relay = relayUrl ? relayState(node, relayUrl) : null;
    return {
        schema: STATUS_V2_SCHEMA,
        mbx_version: v1.mbx_version,
        identity: v1.identity,
        registration: {
            registered: name ? registeredIdentity(node.store, name) !== null : false,
            lease: leaseRow
                ? {
                    holder_cli: leaseRow.cli,
                    holder_session: leaseRow.session_id,
                    verified: identityLeaseStatus(leaseRow, Date.now(), inspectLeaseProcess(leaseRow.holder_pid)).state === "live",
                }
                : null,
        },
        inbox: { unread: v1.unread, needs_reply: v1.needs_reply, from_owner: v1.from_owner, outbox_unsent: v1.outbox_unsent },
        harness: {
            cli: o.cli,
            session_id: o.sessionId,
            wake_path: name ? (sessionRow?.channel ? "channel" : (WAKE_PATH[o.cli] ?? "none")) : "none",
            policy: v1.policy,
        },
        cloud: relayUrl
            ? {
                relay: { url: relayUrl, state: relay?.state ?? "unreachable", last_ack: relay?.at ?? null },
                key_ad_expiry: relay?.enc_ad_exp ?? null,
                account: null, // no daemon-side account link until the cloud sync client (T402)
            }
            : { relay: { url: null, state: "unset", last_ack: null }, key_ad_expiry: null, account: null },
        devices: node.peers().filter((p) => p.state === "approved").map((p) => ({
            host: p.host,
            address: p.addr,
            reachability: "unknown", // no presence probe behind this; last LAN contact is not tracked yet
            last_presence: null,
        })),
        project: name && projectDir
            ? { directory: projectDir, lead: projectLeadView(node, projectDir).address, members: [...projectIdentities(node.store, projectDir)].sort() }
            : null,
        resolved_by: v1.resolved_by,
    };
}
