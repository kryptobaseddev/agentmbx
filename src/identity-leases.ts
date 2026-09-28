// Local coordination, not isolation from another process with access to this user's database.
// Lease tokens fence stale connections; they are never owner grants or permission approvals.
import { randomUUID } from "node:crypto";
import { NAME_RE } from "./envelope.ts";
import { procTable } from "./proc.ts";
import type { Store } from "./store.ts";

export const DEFAULT_IDENTITY_IDLE_TTL_MS = 30 * 60_000;
export interface LeaseHolder { pid: number; start: string; keyFp: string; cli: string; sessionId: string }
export interface IdentityLease {
  name: string; token: string; holder_pid: number; holder_start: string; key_fp: string; cli: string; session_id: string;
  claimed_at: number; heartbeat_at: number; idle_ttl: number; released_at: number | null; release_reason: string | null;
}
export type ProcessEvidence = { alive: boolean | null; start: string | null };
const error = (code: string, message: string) => Object.assign(new Error(message), { code });

/** Missing ps data is unknown, not evidence that a process died. */
export function inspectLeaseProcess(pid: number): ProcessEvidence {
  try { process.kill(pid, 0); }
  catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ESRCH") return { alive: false, start: null };
    return { alive: null, start: null };
  }
  return { alive: true, start: procTable(0).get(pid)?.start ?? null };
}

export class IdentityLeases {
  private store: Store;
  private clock: () => number;
  private inspect: (pid: number) => ProcessEvidence;
  private ttl: number;
  constructor(store: Store, options: { idleTtlMs?: number; clock?: () => number; inspect?: (pid: number) => ProcessEvidence } = {}) {
    this.store = store; this.clock = options.clock ?? Date.now; this.inspect = options.inspect ?? inspectLeaseProcess;
    this.ttl = options.idleTtlMs ?? DEFAULT_IDENTITY_IDLE_TTL_MS;
    if (!Number.isSafeInteger(this.ttl) || this.ttl <= 0) throw error("IDENTITY_LEASE_CONFIG", "identity idle TTL must be a positive integer in milliseconds");
  }
  private now(): number {
    const now = this.clock();
    if (!Number.isSafeInteger(now) || now < 0 || !Number.isSafeInteger(now + this.ttl)) throw error("IDENTITY_LEASE_CONFIG", "invalid lease clock or deadline");
    return now;
  }
  private row(name: string): IdentityLease | undefined {
    return this.store.db.prepare("SELECT * FROM identity_leases WHERE name=?").get(name) as unknown as IdentityLease | undefined;
  }
  private evidence(pid: number): ProcessEvidence {
    try { return this.inspect(pid); } catch { return { alive: null, start: null }; }
  }
  private expire(row: IdentityLease, now: number): "live" | "unknown" | "expired" {
    if (row.released_at !== null) return "expired";
    const p = this.evidence(row.holder_pid);
    const reason = now - row.heartbeat_at >= row.idle_ttl ? "idle"
      : p.alive === false ? "dead" : p.start && p.start !== row.holder_start ? "pid-reused" : null;
    if (!reason) return p.alive === true && p.start === row.holder_start ? "live" : "unknown";
    this.store.db.prepare("UPDATE identity_leases SET released_at=?,release_reason=? WHERE name=? AND token=? AND released_at IS NULL")
      .run(now, reason, row.name, row.token);
    this.store.audit("identity.expire", { name: row.name, holder: this.holder(row), reason, at: now });
    return "expired";
  }
  private holder(row: IdentityLease): LeaseHolder {
    return { pid: row.holder_pid, start: row.holder_start, keyFp: row.key_fp, cli: row.cli, sessionId: row.session_id };
  }
  claim(name: string, holder: LeaseHolder): IdentityLease {
    if (!NAME_RE.test(name) || !Number.isSafeInteger(holder.pid) || holder.pid <= 0 || !holder.start
      || !/^[a-f0-9]{4}(?:-[a-f0-9]{4}){3}$/.test(holder.keyFp) || !holder.cli || !holder.sessionId)
      throw error("IDENTITY_LEASE_CONFIG", "claim needs a valid identity and complete process/session evidence");
    return this.store.tx(() => {
      const now = this.now(), p = this.evidence(holder.pid);
      if (p.alive !== true || p.start !== holder.start) throw error("IDENTITY_PROCESS_UNVERIFIED", "claimant process identity is not verified");
      const prior = this.row(name);
      if (prior && this.expire(prior, now) !== "expired") throw error("IDENTITY_IN_USE", `identity ${name} already has a holder`);
      const token = randomUUID();
      this.store.db.prepare(`INSERT INTO identity_leases (name,token,holder_pid,holder_start,key_fp,cli,session_id,claimed_at,heartbeat_at,idle_ttl,released_at,release_reason)
        VALUES (?,?,?,?,?,?,?,?,?,?,NULL,NULL) ON CONFLICT(name) DO UPDATE SET token=excluded.token,holder_pid=excluded.holder_pid,
        holder_start=excluded.holder_start,key_fp=excluded.key_fp,cli=excluded.cli,session_id=excluded.session_id,
        claimed_at=excluded.claimed_at,heartbeat_at=excluded.heartbeat_at,idle_ttl=excluded.idle_ttl,released_at=NULL,release_reason=NULL`)
        .run(name, token, holder.pid, holder.start, holder.keyFp, holder.cli, holder.sessionId, now, now, this.ttl);
      this.store.audit("identity.claim", { name, holder, previousHolder: prior ? this.holder(prior) : null, at: now });
      return this.row(name)!;
    });
  }
  /** No automatic reacquisition: callers must explicitly claim after losing a lease. */
  renew(name: string, token: string): IdentityLease {
    const row = this.store.tx(() => {
      const row = this.row(name), now = this.now();
      if (!row || row.token !== token || this.expire(row, now) !== "live") return null;
      // A backwards wall-clock step cannot shorten the recorded heartbeat.
      this.store.db.prepare("UPDATE identity_leases SET heartbeat_at=MAX(heartbeat_at,?) WHERE name=? AND token=?").run(now, name, token);
      return this.row(name)!;
    });
    if (!row) throw error("IDENTITY_LEASE_LOST", `identity ${name} lease is no longer usable; explicitly reclaim it`);
    return row;
  }
  release(name: string, token: string): boolean {
    return this.store.tx(() => {
      const row = this.row(name);
      if (!row || row.token !== token || row.released_at !== null) return false;
      const now = this.now();
      this.store.db.prepare("UPDATE identity_leases SET released_at=?,release_reason='released' WHERE name=? AND token=?").run(now, name, token);
      this.store.audit("identity.release", { name, holder: this.holder(row), at: now });
      return true;
    });
  }
  /** Hold the SQLite write lock through the operation, so a successor cannot claim halfway through it. */
  withHeld<T>(name: string, token: string, operation: () => T): T {
    const result = this.store.tx(() => {
      const row = this.row(name);
      if (!row || row.token !== token || this.expire(row, this.now()) !== "live") return { ok: false as const };
      return { ok: true as const, value: operation() };
    });
    if (!result.ok) throw error("IDENTITY_LEASE_LOST", `identity ${name} lease is no longer usable`);
    return result.value;
  }
}
