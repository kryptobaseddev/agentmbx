// Local coordination, not isolation from another process with access to this user's database.
// Lease tokens fence stale connections; they are never owner grants or permission approvals.
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { NAME_RE } from "./envelope.js";
export const DEFAULT_IDENTITY_IDLE_TTL_MS = 30 * 60_000;
const error = (code, message) => Object.assign(new Error(message), { code });
/** Missing ps data is unknown, not evidence that a process died. */
export function inspectLeaseProcess(pid) {
    let alive = true;
    try {
        process.kill(pid, 0);
    }
    catch (e) {
        if (e.code === "ESRCH")
            return { alive: false, start: null };
        alive = null; // EPERM can still provide birth evidence for detecting PID reuse.
    }
    try {
        if (process.platform === "linux") {
            const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
            const fields = stat.slice(stat.lastIndexOf(")") + 2).trim().split(/\s+/);
            const boot = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
            if (fields[0] === "Z" || fields[0] === "X")
                return { alive: false, start: null };
            if (!/^\d+$/.test(fields[19] ?? "") || !/^[a-f0-9-]{36}$/.test(boot))
                return { alive, start: null };
            return { alive, start: `linux:${boot}:${fields[19]}` };
        }
        // Target only this PID, bypass caches, and normalize locale/TZ across independent providers.
        // BSD ps has one-second birth resolution; this is a coordination fence, not a security boundary.
        const out = execFileSync("ps", ["-p", String(pid), "-o", "stat=,lstart="], {
            encoding: "utf8", timeout: 1000, stdio: ["ignore", "pipe", "ignore"],
            env: { ...process.env, TZ: "UTC", LC_ALL: "C", LANG: "C" },
        }).trim();
        const match = /^(\S+)\s+([A-Z][a-z]{2} [A-Z][a-z]{2}\s+\d{1,2} \d{2}:\d{2}:\d{2} \d{4})$/.exec(out);
        if (match?.[1].includes("Z"))
            return { alive: false, start: null };
        return { alive, start: match ? `ps-utc:${match[2].replace(/\s+/g, " ")}` : null };
    }
    catch {
        return { alive, start: null };
    }
}
export class IdentityLeases {
    store;
    clock;
    inspect;
    ttl;
    constructor(store, options = {}) {
        this.store = store;
        this.clock = options.clock ?? Date.now;
        this.inspect = options.inspect ?? inspectLeaseProcess;
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
        try {
            return this.inspect(pid);
        }
        catch {
            return { alive: null, start: null };
        }
    }
    expire(row, now) {
        if (row.released_at !== null)
            return "expired";
        const p = this.evidence(row.holder_pid);
        const reason = now - row.heartbeat_at >= row.idle_ttl ? "idle"
            : p.alive === false ? "dead" : p.start && p.start !== row.holder_start ? "pid-reused" : null;
        if (!reason)
            return p.alive === true && p.start === row.holder_start ? "live" : "unknown";
        this.store.db.prepare("UPDATE identity_leases SET released_at=?,release_reason=? WHERE name=? AND token=? AND released_at IS NULL")
            .run(now, reason, row.name, row.token);
        this.store.audit("identity.expire", { name: row.name, holder: this.holder(row), reason, at: now });
        return "expired";
    }
    holder(row) {
        return { pid: row.holder_pid, start: row.holder_start, keyFp: row.key_fp, cli: row.cli, sessionId: row.session_id };
    }
    claim(name, holder) {
        if (!NAME_RE.test(name) || !Number.isSafeInteger(holder.pid) || holder.pid <= 0 || !holder.start
            || !/^[a-f0-9]{4}(?:-[a-f0-9]{4}){3}$/.test(holder.keyFp) || !holder.cli || !holder.sessionId)
            throw error("IDENTITY_LEASE_CONFIG", "claim needs a valid identity and complete process/session evidence");
        return this.store.tx(() => {
            const now = this.now(), p = this.evidence(holder.pid);
            if (p.alive !== true || p.start !== holder.start)
                throw error("IDENTITY_PROCESS_UNVERIFIED", "claimant process identity is not verified");
            const prior = this.row(name);
            if (prior && this.expire(prior, now) !== "expired")
                throw error("IDENTITY_IN_USE", `identity ${name} already has a holder`);
            const token = randomUUID();
            this.store.db.prepare(`INSERT INTO identity_leases (name,token,holder_pid,holder_start,key_fp,cli,session_id,claimed_at,heartbeat_at,idle_ttl,released_at,release_reason)
        VALUES (?,?,?,?,?,?,?,?,?,?,NULL,NULL) ON CONFLICT(name) DO UPDATE SET token=excluded.token,holder_pid=excluded.holder_pid,
        holder_start=excluded.holder_start,key_fp=excluded.key_fp,cli=excluded.cli,session_id=excluded.session_id,
        claimed_at=excluded.claimed_at,heartbeat_at=excluded.heartbeat_at,idle_ttl=excluded.idle_ttl,released_at=NULL,release_reason=NULL`)
                .run(name, token, holder.pid, holder.start, holder.keyFp, holder.cli, holder.sessionId, now, now, this.ttl);
            this.store.audit("identity.claim", { name, holder, previousHolder: prior ? this.holder(prior) : null, at: now });
            return this.row(name);
        });
    }
    /** No automatic reacquisition: callers must explicitly claim after losing a lease. */
    renew(name, token) {
        const result = this.store.tx(() => {
            const row = this.row(name), now = this.now();
            if (!row || row.token !== token)
                return { status: "expired" };
            const status = this.expire(row, now);
            if (status !== "live")
                return { status };
            // A backwards wall-clock step cannot shorten the recorded heartbeat.
            this.store.db.prepare("UPDATE identity_leases SET heartbeat_at=MAX(heartbeat_at,?) WHERE name=? AND token=?").run(now, name, token);
            return { status: "live", row: this.row(name) };
        });
        if (result.status === "unknown")
            throw error("IDENTITY_STATUS_UNKNOWN", `identity ${name} process status is unknown; retry this lease token after inspection recovers`);
        if (!result.row)
            throw error("IDENTITY_LEASE_LOST", `identity ${name} lease is no longer usable; explicitly reclaim it`);
        return result.row;
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
    /** Move ownership atomically with a fresh generation; a failed destination claim restores the source. */
    rename(name, token, nextName) {
        return this.store.tx(() => this.withHeld(name, token, () => {
            const row = this.row(name);
            if (name === nextName)
                return row;
            this.release(name, token);
            const next = this.claim(nextName, this.holder(row));
            this.store.audit("identity.rename", { from: name, to: nextName, holder: this.holder(row) });
            return next;
        }));
    }
    /** Hold the SQLite write lock through the operation, so a successor cannot claim halfway through it. */
    withHeld(name, token, operation) {
        if (operation.constructor.name === "AsyncFunction")
            throw error("IDENTITY_ASYNC_OPERATION", "lease operations must be synchronous database mutations");
        const result = this.store.tx(() => {
            const row = this.row(name);
            const status = row && row.token === token ? this.expire(row, this.now()) : "expired";
            if (status !== "live")
                return { ok: false, status };
            const value = operation();
            if (value && typeof value.then === "function")
                throw error("IDENTITY_ASYNC_OPERATION", "lease operations cannot return a thenable");
            return { ok: true, value };
        });
        if (!result.ok) {
            if (result.status === "unknown")
                throw error("IDENTITY_STATUS_UNKNOWN", `identity ${name} process status is unknown; retry this lease token after inspection recovers`);
            throw error("IDENTITY_LEASE_LOST", `identity ${name} lease is no longer usable`);
        }
        return result.value;
    }
}
