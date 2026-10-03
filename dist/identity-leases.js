// Local coordination, not isolation from another process with access to this user's database.
// Lease tokens fence stale connections; they are never owner grants or permission approvals.
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { AsyncLocalStorage } from "node:async_hooks";
import { NAME_RE } from "./envelope.js";
import { processEvidenceSpawns, readLinuxProcess, sleepSync } from "./proc.js";
// Only a synchronous, open write operation may attest which sender it currently holds.
const heldOperation = new AsyncLocalStorage();
export function hasHeldIdentity(store, name) {
    const scope = heldOperation.getStore();
    if (!scope?.active || scope.readOnly || scope.store !== store || scope.name !== name)
        return false;
    const row = store.db.prepare("SELECT token,released_at FROM identity_leases WHERE name=?").get(name);
    return row?.token === scope.token && row.released_at === null;
}
export const DEFAULT_IDENTITY_IDLE_TTL_MS = 30 * 60_000;
const UNKNOWN_PROCESS = { alive: null, start: null };
export { UNKNOWN_PROCESS };
const EVIDENCE_MAX_AGE_MS = 5000;
/** Unknown evidence is retried with this backoff before an operation fails (T206). */
export const UNKNOWN_RETRY_DELAYS_MS = [250, 500, 1_000];
const error = (code, message) => Object.assign(new Error(message), { code });
/** A point-in-time assessment, not authority to claim or operate as this holder. */
export function identityLeaseStatus(row, now, p) {
    if (row.released_at !== null)
        return { state: "expired", reason: null };
    const reason = now - row.heartbeat_at >= row.idle_ttl ? "idle"
        : p.alive === false ? "dead" : p.start && p.start !== row.holder_start ? "pid-reused" : null;
    return { state: reason ? "expired" : p.alive === true && p.start === row.holder_start ? "live" : "unknown", reason };
}
/** Missing ps data is unknown, not evidence that a process died. */
export function inspectLeaseProcess(pid) {
    return inspectLeaseProcesses([pid]).get(pid) ?? UNKNOWN_PROCESS;
}
/** A short shared cache so a hot loop re-checking one holder costs no ps spawns (T206). */
const EVIDENCE_CACHE_MS = 1_000;
const EVIDENCE_CACHE_STALE_MS = 10 * EVIDENCE_CACHE_MS;
const evidenceCache = new Map();
let selfEvidenceCache = null;
/** Own pid is alive by definition; its birth time is computed once per process, never per call. */
function inspectSelf() {
    if (selfEvidenceCache)
        return selfEvidenceCache;
    const value = psInspectBatch([process.pid]).get(process.pid) ?? UNKNOWN_PROCESS;
    // Cache only a complete answer: a ps timeout under load must not pin "unknown" for the life of the process.
    if (value.alive === true && value.start)
        selfEvidenceCache = value;
    return value;
}
/** One ps spawn for every requested pid (BSD one-second birth resolution; coordination fence, not a boundary). */
function psInspectBatch(pids) {
    const found = new Map();
    const probe = (pid) => {
        try {
            process.kill(pid, 0);
            return true;
        }
        catch (e) {
            return e.code === "ESRCH" ? false : null;
        }
    };
    if (process.platform === "linux") {
        for (const pid of pids) {
            const alive = probe(pid);
            if (alive === false) {
                found.set(pid, { alive: false, start: null });
                continue;
            }
            const p = readLinuxProcess(pid);
            found.set(pid, p?.dead ? { alive: false, start: null } : { alive, start: p?.start ?? null });
        }
        return found;
    }
    processEvidenceSpawns.count += 1;
    try {
        const out = execFileSync("ps", ["-p", pids.join(","), "-o", "pid=,stat=,lstart="], {
            encoding: "utf8", timeout: 1000, stdio: ["ignore", "pipe", "ignore"],
            env: { ...process.env, TZ: "UTC", LC_ALL: "C", LANG: "C" },
        }).trim();
        for (const line of out.split("\n")) {
            const m = /^\s*(\d+)\s+(\S+)\s+([A-Z][a-z]{2} [A-Z][a-z]{2}\s+\d{1,2} \d{2}:\d{2}:\d{2} \d{4})\s*$/.exec(line);
            if (!m)
                continue;
            const pid = Number(m[1]);
            found.set(pid, m[2].includes("Z") ? { alive: false, start: null } : { alive: probe(pid), start: `ps-utc:${m[3].replace(/\s+/g, " ")}` });
        }
    }
    catch { /* unavailable inventory: probed liveness below, start stays unknown */ }
    for (const pid of pids)
        if (!found.has(pid))
            found.set(pid, { alive: probe(pid), start: null });
    return found;
}
/** Batched, cached process evidence for other pids: one spawn per cache miss set, never one per pid. */
export function inspectLeaseProcesses(pids) {
    const now = performance.now();
    const out = new Map();
    const missing = [];
    for (const pid of new Set(pids.filter(p => Number.isSafeInteger(p) && p > 0))) {
        if (pid === process.pid) {
            out.set(pid, inspectSelf());
            continue;
        }
        const cached = evidenceCache.get(pid);
        if (cached && now - cached.at <= EVIDENCE_CACHE_MS)
            out.set(pid, cached.value);
        else
            missing.push(pid);
    }
    if (missing.length) {
        const takenAt = performance.now();
        for (const [pid, value] of psInspectBatch(missing)) {
            evidenceCache.set(pid, { value, at: takenAt });
            out.set(pid, value);
        }
    }
    for (const [pid, cached] of evidenceCache)
        if (now - cached.at > EVIDENCE_CACHE_STALE_MS)
            evidenceCache.delete(pid);
    return out;
}
export const _resetEvidenceCacheForTests = () => { evidenceCache.clear(); selfEvidenceCache = null; };
export class IdentityLeases {
    #prepared = new AsyncLocalStorage();
    store;
    clock;
    inspect;
    customInspect;
    ttl;
    constructor(store, options = {}) {
        this.store = store;
        this.clock = options.clock ?? Date.now;
        this.inspect = options.inspect ?? inspectLeaseProcess;
        this.customInspect = options.inspect !== undefined;
        this.ttl = options.idleTtlMs ?? DEFAULT_IDENTITY_IDLE_TTL_MS;
        if (!Number.isSafeInteger(this.ttl) || this.ttl <= 0)
            throw error("IDENTITY_LEASE_CONFIG", "identity idle TTL must be a positive integer in milliseconds");
    }
    now() {
        const now = this.clock();
        if (!Number.isSafeInteger(now) || now < 0 || !Number.isSafeInteger(now + this.ttl))
            throw error("IDENTITY_LEASE_CONFIG", "invalid lease clock or deadline");
        return now;
    }
    row(name) {
        return this.store.db.prepare("SELECT * FROM identity_leases WHERE name=?").get(name);
    }
    evidence(pid) {
        const scope = this.#prepared.getStore();
        if (scope) {
            const p = scope.processes.get(pid);
            return scope.active && p && performance.now() - p.at <= EVIDENCE_MAX_AGE_MS ? p.value : UNKNOWN_PROCESS;
        }
        if (this.store.db.isTransaction)
            throw error("IDENTITY_PREPARATION_REQUIRED", "prepare process evidence before opening an outer transaction");
        try {
            return this.inspect(pid);
        }
        catch {
            return { alive: null, start: null };
        }
    }
    /** Prepare immutable observations before an outer transaction; nested operations reuse them. */
    prepare(names, pids, operation) {
        if (operation.constructor.name === "AsyncFunction")
            throw error("IDENTITY_ASYNC_OPERATION", "prepared operations must be synchronous");
        const prior = this.#prepared.getStore();
        if (prior?.active)
            return operation();
        if (prior || this.store.db.isTransaction)
            throw error("IDENTITY_PREPARATION_REQUIRED", "process evidence must be prepared outside a transaction");
        const scope = { active: true, observations: new Map(), processes: new Map() };
        const wanted = new Set();
        for (const name of new Set(names)) {
            const row = this.row(name);
            if (row && row.released_at === null)
                wanted.add(row.holder_pid);
        }
        for (const pid of new Set(pids))
            if (Number.isSafeInteger(pid) && pid > 0)
                wanted.add(pid);
        // An injected inspect (tests) keeps the per-pid call shape; the default batches one ps for all pids.
        const batch = this.customInspect ? null : inspectLeaseProcesses([...wanted]);
        const takenAt = performance.now();
        const inspect = (pid) => {
            let observed = scope.processes.get(pid);
            if (!observed) {
                let value = UNKNOWN_PROCESS;
                if (batch)
                    value = batch.get(pid) ?? UNKNOWN_PROCESS;
                else
                    try {
                        value = this.inspect(pid);
                    }
                    catch {
                        value = UNKNOWN_PROCESS;
                    }
                observed = { value, at: batch ? takenAt : performance.now() };
                scope.processes.set(pid, observed);
            }
            return observed;
        };
        for (const name of new Set(names)) {
            const row = this.row(name), p = row && row.released_at === null ? inspect(row.holder_pid) : { value: UNKNOWN_PROCESS, at: performance.now() };
            scope.observations.set(name, { row, process: p.value, at: p.at });
        }
        for (const pid of new Set(pids))
            if (Number.isSafeInteger(pid) && pid > 0)
                inspect(pid);
        return this.#prepared.run(scope, () => {
            try {
                const result = operation();
                if (result && typeof result.then === "function") {
                    void Promise.resolve(result).catch(() => { });
                    throw error("IDENTITY_ASYNC_OPERATION", "prepared operations cannot return a thenable");
                }
                return result;
            }
            finally {
                scope.active = false;
            }
        });
    }
    processEvidence(pid) { return this.evidence(pid); }
    observe(name) {
        const scope = this.#prepared.getStore();
        if (scope) {
            if (!scope.active)
                throw error("IDENTITY_STATUS_UNKNOWN", "prepared process evidence scope is closed");
            // Missing observations must not pair a newly observed generation with old PID evidence.
            return scope.observations.get(name) ?? { row: undefined, process: UNKNOWN_PROCESS, at: performance.now() };
        }
        const row = this.row(name);
        const process = row && row.released_at === null ? this.evidence(row.holder_pid) : UNKNOWN_PROCESS;
        return { row, process, at: performance.now() };
    }
    observedProcess(row, observed) {
        // Evidence gathered before locking cannot expire or authorize a successor generation.
        return observed.row?.token === row.token && observed.row.holder_pid === row.holder_pid
            && observed.row.holder_start === row.holder_start && performance.now() - observed.at <= EVIDENCE_MAX_AGE_MS ? observed.process : UNKNOWN_PROCESS;
    }
    status(row, now, p) {
        return identityLeaseStatus(row, now, p);
    }
    expire(row, now, p) {
        const { state, reason } = this.status(row, now, p);
        if (!reason)
            return state;
        this.store.db.prepare("UPDATE identity_leases SET released_at=?,release_reason=? WHERE name=? AND token=? AND released_at IS NULL")
            .run(now, reason, row.name, row.token);
        this.store.audit("identity.expire", { name: row.name, holder: this.holder(row), reason, at: now });
        return "expired";
    }
    holder(row) {
        return { pid: row.holder_pid, start: row.holder_start, keyFp: row.key_fp, cli: row.cli, sessionId: row.session_id };
    }
    claim(name, holder) {
        this.validateClaim(name, holder);
        const prior = this.observe(name), process = this.evidence(holder.pid), at = this.#prepared.getStore()?.processes.get(holder.pid)?.at ?? performance.now();
        return this.claimPrepared(name, holder, prior, process, at);
    }
    validateClaim(name, holder) {
        if (!NAME_RE.test(name) || !Number.isSafeInteger(holder.pid) || holder.pid <= 0 || !holder.start
            || !/^[a-f0-9]{4}(?:-[a-f0-9]{4}){3}$/.test(holder.keyFp) || !holder.cli || !holder.sessionId)
            throw error("IDENTITY_LEASE_CONFIG", "claim needs a valid identity and complete process/session evidence");
    }
    claimPrepared(name, holder, observed, process, at) {
        this.validateClaim(name, holder);
        return this.store.tx(() => {
            const now = this.now(), p = performance.now() - at <= EVIDENCE_MAX_AGE_MS ? process : UNKNOWN_PROCESS;
            if (p.alive !== true || p.start !== holder.start)
                throw error("IDENTITY_PROCESS_UNVERIFIED", "claimant process identity is not verified");
            const prior = this.row(name);
            if (prior && this.expire(prior, now, this.observedProcess(prior, observed)) !== "expired") {
                // An identical claimant (concurrent or repeated first binds of one state) re-claims idempotently.
                if (prior.key_fp === holder.keyFp && prior.holder_pid === holder.pid && prior.holder_start === holder.start
                    && prior.cli === holder.cli && prior.session_id === holder.sessionId) {
                    this.#prepared.getStore()?.observations.set(name, { row: prior, process: p, at });
                    return prior;
                }
                throw error("IDENTITY_IN_USE", `identity ${name} already has a holder (${prior.cli} session ${prior.session_id}). `
                    + "The finishing holder must call mbx_identity release before ending; then release your current identity and claim this name. "
                    + "Closing a hosted conversation may leave its shared MCP process running. If the holder cannot release, the owner can use agentmbx identity takeover.");
            }
            const token = randomUUID();
            this.store.db.prepare(`INSERT INTO identity_leases (name,token,holder_pid,holder_start,key_fp,cli,session_id,claimed_at,heartbeat_at,idle_ttl,released_at,release_reason)
        VALUES (?,?,?,?,?,?,?,?,?,?,NULL,NULL) ON CONFLICT(name) DO UPDATE SET token=excluded.token,holder_pid=excluded.holder_pid,
        holder_start=excluded.holder_start,key_fp=excluded.key_fp,cli=excluded.cli,session_id=excluded.session_id,
        claimed_at=excluded.claimed_at,heartbeat_at=excluded.heartbeat_at,idle_ttl=excluded.idle_ttl,released_at=NULL,release_reason=NULL`)
                .run(name, token, holder.pid, holder.start, holder.keyFp, holder.cli, holder.sessionId, now, now, this.ttl);
            this.store.audit("identity.claim", { name, holder, previousHolder: prior ? this.holder(prior) : null, at: now });
            const claimed = this.row(name);
            this.#prepared.getStore()?.observations.set(name, { row: claimed, process: p, at });
            return claimed;
        });
    }
    /** No automatic reacquisition: callers must explicitly claim after losing a lease. */
    renew(name, token) {
        for (let attempt = 0;; attempt++) {
            const observed = attempt === 0 ? this.observe(name) : this.freshObservation(name);
            const result = this.store.tx(() => {
                const row = this.row(name), now = this.now();
                if (!row || row.token !== token)
                    return { status: "expired" };
                const status = this.expire(row, now, this.observedProcess(row, observed));
                if (status !== "live")
                    return { status };
                // A backwards wall-clock step cannot shorten the recorded heartbeat.
                this.store.db.prepare("UPDATE identity_leases SET heartbeat_at=MAX(heartbeat_at,?) WHERE name=? AND token=?").run(now, name, token);
                return { status: "live", row: this.row(name) };
            });
            if (result.status !== "unknown") {
                if (!result.row)
                    throw error("IDENTITY_LEASE_LOST", `identity ${name} lease is no longer usable; explicitly reclaim it`);
                return result.row;
            }
            // Never inspect or sleep while an outer transaction holds the write lock: fail fast there, as before.
            if (attempt >= UNKNOWN_RETRY_DELAYS_MS.length || this.store.db.isTransaction)
                throw error("IDENTITY_STATUS_UNKNOWN", `identity ${name} process status is unknown; retry this lease token after inspection recovers`);
            sleepSync(UNKNOWN_RETRY_DELAYS_MS[attempt]);
        }
    }
    release(name, token) {
        return this.store.tx(() => {
            const row = this.row(name);
            if (!row || row.token !== token || row.released_at !== null)
                return false;
            const now = this.now();
            this.store.db.prepare("UPDATE identity_leases SET released_at=?,release_reason='released' WHERE name=? AND token=?").run(now, name, token);
            this.store.audit("identity.release", { name, holder: this.holder(row), at: now });
            return true;
        });
    }
    /** The same holder, process and key under the provider's new session id (Claude replaces it within one process, T326). */
    moveSession(name, token, sessionId) {
        return this.store.tx(() => {
            const row = this.row(name);
            if (!row || row.token !== token || row.released_at !== null)
                throw error("IDENTITY_LEASE_LOST", `identity ${name} lease is no longer usable; explicitly reclaim it`);
            if (row.session_id === sessionId)
                return row;
            this.store.db.prepare("UPDATE identity_leases SET session_id=? WHERE name=? AND token=? AND released_at IS NULL").run(sessionId, name, token);
            this.store.audit("identity.session-moved", { name, from: row.session_id, to: sessionId, holder: this.holder(row) });
            return this.row(name);
        });
    }
    /** Move ownership atomically with a fresh generation; a failed destination claim restores the source. */
    rename(name, token, nextName) {
        const source = this.observe(name), destination = name === nextName ? source : this.observe(nextName);
        return this.withObserved(name, token, source, () => {
            const row = this.row(name);
            if (name === nextName)
                return row;
            this.release(name, token);
            const next = this.claimPrepared(nextName, this.holder(row), destination, this.observedProcess(row, source), source.at);
            this.store.audit("identity.rename", { from: name, to: nextName, holder: this.holder(row) });
            return next;
        });
    }
    /** Hold the SQLite write lock through the operation, so a successor cannot claim halfway through it. */
    withHeld(name, token, operation) {
        if (operation.constructor.name === "AsyncFunction")
            throw error("IDENTITY_ASYNC_OPERATION", "lease operations must be synchronous database mutations");
        return this.withObserved(name, token, this.observe(name), operation);
    }
    /** Authorize a read at one WAL snapshot; concurrent writers need not wait for its result. */
    withHeldRead(name, token, operation) {
        if (operation.constructor.name === "AsyncFunction")
            throw error("IDENTITY_ASYNC_OPERATION", "lease reads must be synchronous");
        return this.withObserved(name, token, this.observe(name), operation, true);
    }
    withObserved(name, token, observed, operation, readOnly = false) {
        for (let attempt = 0;; attempt++) {
            try {
                return this.withObservedOnce(name, token, attempt === 0 ? observed : this.freshObservation(name), operation, readOnly);
            }
            catch (e) {
                if (e.code !== "IDENTITY_STATUS_UNKNOWN")
                    throw e;
                if (attempt >= UNKNOWN_RETRY_DELAYS_MS.length || this.store.db.isTransaction)
                    throw e; // no sleeping under an outer write lock
                sleepSync(UNKNOWN_RETRY_DELAYS_MS[attempt]);
            }
        }
    }
    /** One authorize-and-run attempt. Unknown process status is the caller's retry signal. */
    withObservedOnce(name, token, observed, operation, readOnly = false) {
        const run = () => {
            const row = this.row(name);
            const status = row && row.token === token ? readOnly
                ? this.status(row, this.now(), this.observedProcess(row, observed)).state
                : this.expire(row, this.now(), this.observedProcess(row, observed)) : "expired";
            if (status !== "live")
                return { ok: false, status };
            const scope = { store: this.store, name, token, active: true, readOnly };
            let value;
            try {
                value = heldOperation.run(scope, operation);
            }
            finally {
                scope.active = false;
            }
            if (value && typeof value.then === "function") {
                // This cannot cancel external side effects. Store transaction contexts block later DB writes.
                void Promise.resolve(value).catch(() => { });
                throw error("IDENTITY_ASYNC_OPERATION", "lease operations cannot return a thenable");
            }
            return { ok: true, value };
        };
        const result = readOnly ? this.store.readTx(run) : this.store.tx(run);
        if (!result.ok) {
            if (result.status === "unknown")
                throw error("IDENTITY_STATUS_UNKNOWN", `identity ${name} process status is unknown; retry this lease token after inspection recovers`);
            throw error("IDENTITY_LEASE_LOST", `identity ${name} lease is no longer usable`);
        }
        return result.value;
    }
    /** Re-collect evidence for one name outside any prepared snapshot; retries must see fresh data. */
    freshObservation(name) {
        const row = this.row(name);
        if (!row || row.released_at !== null)
            return { row, process: UNKNOWN_PROCESS, at: performance.now() };
        let process = UNKNOWN_PROCESS;
        if (!this.customInspect)
            process = inspectLeaseProcesses([row.holder_pid]).get(row.holder_pid) ?? UNKNOWN_PROCESS;
        else
            try {
                process = this.inspect(row.holder_pid);
            }
            catch {
                process = UNKNOWN_PROCESS;
            }
        return { row, process, at: performance.now() };
    }
}
