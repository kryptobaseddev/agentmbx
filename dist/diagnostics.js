// Same-OS-user diagnostic data, not a mailbox capability or agent authorization API.
// Deliberately does not construct Store: inspection cannot migrate or finalize writes.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { NAME_RE } from "./envelope.js";
import { SCHEMA_VERSION } from "./store.js";
import { version } from "./version.js";
import { procStart } from "./proc.js";
import { identityLeaseStatus, inspectLeaseProcess } from "./identity-leases.js";
const fail = (code, message) => Object.assign(new Error(message), { code });
const label = (x) => typeof x === "string" && x.length > 0 && x.length <= 300 && !/[\x00-\x1f\x7f]/.test(x);
const iso = (x) => typeof x === "number" && Number.isSafeInteger(x) && x >= 0 && x <= 8.64e15 ? new Date(x).toISOString() : null;
const runtimeVersion = (x) => typeof x === "string" && /^\d+\.\d+\.\d+(?:[-+][a-zA-Z0-9.-]+)?$/.test(x);
/** Remote error strings may contain credentials/URLs/body text: emit only a fixed class. */
export function retryErrorClass(value) {
    if (typeof value !== "string" || !value)
        return null;
    if (/timeout|ETIMEDOUT|abort/i.test(value))
        return "TIMEOUT";
    if (/ECONNREFUSED|fetch failed|network|ENOTFOUND|EHOSTUNREACH/i.test(value))
        return "PEER_UNREACHABLE";
    if (/401|403|unauthorized|signature/i.test(value))
        return "PEER_REFUSED";
    return "DELIVERY_FAILED";
}
export function diagnosticSnapshot(home, scope, options = {}) {
    if (!scope || !NAME_RE.test(scope.mailbox) || !label(scope.mailbox)
        || (scope.cli !== undefined && !label(scope.cli)) || (scope.session_id !== undefined && !label(scope.session_id))
        || (!!scope.cli !== !!scope.session_id))
        throw fail("INVALID_SCOPE", "choose a mailbox and, optionally, both provider CLI and session ID");
    const limit = scope.limit ?? 20, now = options.now ?? Date.now();
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
        throw fail("INVALID_SCOPE", "diagnostic limit must be an integer from 1 to 100");
    if (!Number.isSafeInteger(now) || now < 0 || now > 8.64e15)
        throw fail("INVALID_SCOPE", "invalid observation time");
    const path = join(home, "mbx.db");
    if (!existsSync(path))
        throw fail("NOT_FOUND", "mailbox store is not initialized");
    let host;
    try {
        const config = JSON.parse(readFileSync(join(home, "config.json"), "utf8"));
        if (!config || !label(config.host))
            throw 0;
        host = config.host;
    }
    catch {
        throw fail("INVALID_SCOPE", "mailbox host configuration is invalid");
    }
    const db = new DatabaseSync(path, { readOnly: true });
    const sessionArgs = scope.cli ? [scope.cli, scope.session_id] : [];
    const sessionWhere = scope.cli ? " AND cli=? AND session_id=?" : "";
    let schema, lease;
    let sessions;
    let queues;
    let receipts;
    let outgoing, totals, conflict, connectorRaw = null;
    try {
        db.exec("PRAGMA busy_timeout=1000; PRAGMA query_only=ON; BEGIN");
        schema = Number(db.prepare("PRAGMA user_version").get().user_version);
        if (schema < 1 || schema > SCHEMA_VERSION)
            throw fail("STALE_SERVER", "diagnostic runtime cannot inspect this mailbox schema");
        lease = schema >= 2 ? db.prepare("SELECT * FROM identity_leases WHERE name=?").get(scope.mailbox) : undefined;
        const known = lease || db.prepare("SELECT 1 FROM agents WHERE name=? AND host=?").get(scope.mailbox, host)
            || db.prepare("SELECT 1 FROM deliveries WHERE agent=? LIMIT 1").get(scope.mailbox)
            || db.prepare("SELECT 1 FROM sessions WHERE agent=? LIMIT 1").get(scope.mailbox);
        if (!known)
            throw fail("SCOPE_NOT_FOUND", "mailbox was not found");
        sessions = db.prepare(`SELECT cli,session_id,pid,${schema >= 2 ? "pid_start" : "NULL AS pid_start"},updated_at FROM sessions WHERE agent=?${sessionWhere} ORDER BY updated_at DESC,cli,session_id LIMIT ?`)
            .all(scope.mailbox, ...sessionArgs, limit + 1);
        if (scope.cli && !sessions.length && !(lease?.cli === scope.cli && lease.session_id === scope.session_id))
            throw fail("SCOPE_NOT_FOUND", "provider session does not belong to this mailbox");
        totals = db.prepare("SELECT COUNT(*) messages,COALESCE(SUM(state<>'acked'),0) unread FROM deliveries WHERE agent=?").get(scope.mailbox);
        outgoing = Number(db.prepare("SELECT COUNT(DISTINCT o.msg_id) n FROM outbox o JOIN messages m ON m.id=o.msg_id WHERE m.from_addr=?").get(`${scope.mailbox}@${host}`).n);
        queues = db.prepare("SELECT o.msg_id message_id,o.host peer,o.attempts,o.next_at next_retry_at,o.last_error FROM outbox o JOIN messages m ON m.id=o.msg_id WHERE m.from_addr=? ORDER BY o.created_at,o.msg_id,o.host LIMIT ?")
            .all(`${scope.mailbox}@${host}`, limit + 1);
        const predicate = `k GLOB 'identity-request:*' AND CASE WHEN json_valid(v) THEN json_extract(v,'$.target.agent')=? ${scope.cli ? "AND json_extract(v,'$.target.cli')=? AND json_extract(v,'$.target.session_id')=?" : ""} ELSE 0 END`;
        receipts = db.prepare(`SELECT v FROM kv WHERE ${predicate} ORDER BY k LIMIT ?`).all(scope.mailbox, ...sessionArgs, limit + 1);
        conflict = !!db.prepare("SELECT 1 FROM kv WHERE k=?").get(`identity-conflict:${scope.mailbox}`);
        connectorRaw = lease ? db.prepare("SELECT v FROM kv WHERE k=?").get(connectorKey(lease.holder_pid))?.v ?? null : null;
        db.exec("COMMIT");
    }
    finally {
        db.close();
    }
    const inspect = options.inspect ?? inspectLeaseProcess;
    // Session rows record birth in the process-table format (bindSession), not the lease format: compare like with like.
    const inspectSession = options.inspectSession ?? options.inspect ?? ((pid) => {
        let alive = true;
        try {
            process.kill(pid, 0);
        }
        catch (e) {
            if (e.code === "ESRCH")
                return { alive: false, start: null };
            alive = null;
        }
        return { alive, start: procStart(pid) };
    });
    const sessionEvidence = (pid) => { if (!pid)
        return { alive: null, start: null }; try {
        return inspectSession(pid);
    }
    catch {
        return { alive: null, start: null };
    } };
    const evidence = (pid) => { if (!pid)
        return { alive: null, start: null }; try {
        return inspect(pid);
    }
    catch {
        return { alive: null, start: null };
    } };
    const p = lease ? evidence(lease.holder_pid) : { alive: null, start: null };
    const assessment = lease ? identityLeaseStatus(lease, now, p) : null;
    const processState = (p, birth) => p.alive === false ? "dead" : p.start && birth && p.start !== birth ? "pid-reused" : p.alive === true && birth && p.start === birth ? "verified" : "unknown";
    const daemon = options.daemon;
    const daemonTime = daemon && typeof daemon.observed_at === "string" ? Date.parse(daemon.observed_at) : NaN;
    const daemonValid = !!daemon && daemon.host === host && runtimeVersion(daemon.version) && Number.isFinite(daemonTime) && daemonTime <= now && now - daemonTime <= 60_000;
    const recovery = receipts.slice(0, limit).flatMap(({ v }) => {
        let r;
        try {
            r = JSON.parse(v);
        }
        catch {
            return [];
        }
        if (!r || typeof r !== "object" || Array.isArray(r) || typeof r.id !== "string" || !/^[a-f0-9-]{36}$/i.test(r.id)
            || !["claim", "release", "takeover"].includes(r.action) || !["pending", "completed", "failed"].includes(r.status))
            return [];
        return [{ receipt_id: r.id, action: r.action, status: r.status, created_at: iso(r.created_at), completed_at: iso(r.completed_at), error_code: r.status === "failed" ? "IDENTITY_CONTROL_FAILED" : null }];
    });
    return { v: 1, advisory: true, observed_at: new Date(now).toISOString(), host, schema_version: schema,
        scope: { mailbox: scope.mailbox, cli: scope.cli ?? null, session_id: scope.session_id ?? null },
        builds: { installed: { version: version() }, daemon: { version: daemonValid ? daemon.version : null, observed_at: daemonValid ? new Date(daemonTime).toISOString() : null, reason: daemonValid ? null : "no fresh host-matched daemon observation" }, connector: connectorBuild(connectorRaw, lease, processState(p, lease?.holder_start ?? null), now, sessions.length > 0) },
        ownership: { state: conflict ? "conflict" : assessment?.state === "live" ? "held" : assessment?.state === "expired" ? "available" : lease ? "unknown" : "legacy", reason: conflict ? "historical ownership requires explicit recovery" : assessment?.reason ?? (lease?.released_at != null ? "released" : assessment?.state === "live" ? "current holder observed" : "holder process could not be verified"), holder: lease ? { cli: lease.cli, session_id: lease.session_id, pid: lease.holder_pid } : null, process: processState(p, lease?.holder_start ?? null) },
        sessions: sessions.slice(0, limit).map(s => ({ cli: s.cli, session_id: s.session_id, pid: s.pid, updated_at: s.updated_at, process: processState(sessionEvidence(s.pid), s.pid_start), connector_version: null })),
        messages: { received: totals.messages, unread: totals.unread, queued_outgoing: outgoing, task_status: "not-reported" },
        outbox: queues.slice(0, limit).map(q => ({ message_id: q.message_id, peer: q.peer, attempts: q.attempts, next_retry_at: q.next_retry_at, last_error_code: retryErrorClass(q.last_error) })), recovery,
        page: { limit, truncated: { sessions: sessions.length > limit, outbox: queues.length > limit, recovery: receipts.length > limit } }, };
}
/** kv key of a running MCP connector's self-report (published by that process, keyed by its PID). */
export const connectorKey = (pid) => `connector:${pid}`;
const CONNECTOR_FRESH_MS = 5 * 60_000;
/** The lease holder's own report counts only when the holder process is verified and the report is from that same birth. */
function connectorBuild(raw, lease, holder, now, bindingExists) {
    const none = (reason) => ({ version: null, build: null, tools: null, observed_at: null, binding_exists: bindingExists, reason });
    if (!lease || raw === null)
        return none("connector build has no verified runtime observation");
    let r;
    try {
        r = JSON.parse(raw);
    }
    catch {
        return none("connector report is malformed");
    }
    if (holder !== "verified")
        return none("connector holder process is not verified");
    if (r?.v !== 1 || r.pid !== lease.holder_pid || r.start !== lease.holder_start)
        return none("connector report is not from the current holder process");
    const at = typeof r.at === "string" ? Date.parse(r.at) : NaN;
    if (!Number.isFinite(at) || at > now + 60_000 || now - at > CONNECTOR_FRESH_MS)
        return none("connector report is stale");
    if (!runtimeVersion(r.version) || typeof r.build !== "string" || !Array.isArray(r.tools) || r.tools.some((t) => typeof t !== "string"))
        return none("connector report is malformed");
    return { version: r.version, build: r.build.slice(0, 120), tools: r.tools.slice(0, 50), observed_at: new Date(at).toISOString(), binding_exists: bindingExists, reason: null };
}
