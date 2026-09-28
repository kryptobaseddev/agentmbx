// Local coordination, not isolation from another process with access to this user's database.
// Lease tokens fence stale connections; they are never owner grants or permission approvals.
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { AsyncLocalStorage } from "node:async_hooks";
import { NAME_RE } from "./envelope.ts";
import { readLinuxProcess } from "./proc.ts";
import type { Store } from "./store.ts";

// Only a synchronous, open write operation may attest which sender it currently holds.
const heldOperation = new AsyncLocalStorage<{ store: Store; name: string; token: string; active: boolean; readOnly: boolean }>();
export function hasHeldIdentity(store: Store, name: string): boolean {
  const scope = heldOperation.getStore();
  if (!scope?.active || scope.readOnly || scope.store !== store || scope.name !== name) return false;
  const row = store.db.prepare("SELECT token,released_at FROM identity_leases WHERE name=?").get(name);
  return row?.token === scope.token && row.released_at === null;
}

export const DEFAULT_IDENTITY_IDLE_TTL_MS = 30 * 60_000;
export interface LeaseHolder { pid: number; start: string; keyFp: string; cli: string; sessionId: string }
export interface IdentityLease {
  name: string; token: string; holder_pid: number; holder_start: string; key_fp: string; cli: string; session_id: string;
  claimed_at: number; heartbeat_at: number; idle_ttl: number; released_at: number | null; release_reason: string | null;
}
export type ProcessEvidence = { alive: boolean | null; start: string | null };
type Observation = { row: IdentityLease | undefined; process: ProcessEvidence; at: number };
type EvidenceScope = { active: boolean; observations: Map<string, Observation>; processes: Map<number, { value: ProcessEvidence; at: number }> };
const UNKNOWN_PROCESS: ProcessEvidence = { alive: null, start: null };
const EVIDENCE_MAX_AGE_MS = 5000;
const error = (code: string, message: string) => Object.assign(new Error(message), { code });

/** A point-in-time assessment, not authority to claim or operate as this holder. */
export function identityLeaseStatus(row: IdentityLease, now: number, p: ProcessEvidence): { state: "live" | "unknown" | "expired"; reason: string | null } {
  if (row.released_at !== null) return { state: "expired", reason: null };
  const reason = now - row.heartbeat_at >= row.idle_ttl ? "idle"
    : p.alive === false ? "dead" : p.start && p.start !== row.holder_start ? "pid-reused" : null;
  return { state: reason ? "expired" : p.alive === true && p.start === row.holder_start ? "live" : "unknown", reason };
}

/** Missing ps data is unknown, not evidence that a process died. */
export function inspectLeaseProcess(pid: number): ProcessEvidence {
  let alive: boolean | null = true;
  try { process.kill(pid, 0); }
  catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ESRCH") return { alive: false, start: null };
    alive = null; // EPERM can still provide birth evidence for detecting PID reuse.
  }
  try {
    if (process.platform === "linux") {
      const p = readLinuxProcess(pid);
      return p?.dead ? { alive: false, start: null } : { alive, start: p?.start ?? null };
    }
    // Target only this PID, bypass caches, and normalize locale/TZ across independent providers.
    // BSD ps has one-second birth resolution; this is a coordination fence, not a security boundary.
    const out = execFileSync("ps", ["-p", String(pid), "-o", "stat=,lstart="], {
      encoding: "utf8", timeout: 1000, stdio: ["ignore", "pipe", "ignore"],
      env: { ...process.env, TZ: "UTC", LC_ALL: "C", LANG: "C" },
    }).trim();
    const match = /^(\S+)\s+([A-Z][a-z]{2} [A-Z][a-z]{2}\s+\d{1,2} \d{2}:\d{2}:\d{2} \d{4})$/.exec(out);
    if (match?.[1].includes("Z")) return { alive: false, start: null };
    return { alive, start: match ? `ps-utc:${match[2].replace(/\s+/g, " ")}` : null };
  } catch { return { alive, start: null }; }
}

export class IdentityLeases {
  #prepared = new AsyncLocalStorage<EvidenceScope>();
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
    const scope = this.#prepared.getStore();
    if (scope) {
      const p = scope.processes.get(pid);
      return scope.active && p && performance.now() - p.at <= EVIDENCE_MAX_AGE_MS ? p.value : UNKNOWN_PROCESS;
    }
    if (this.store.db.isTransaction) throw error("IDENTITY_PREPARATION_REQUIRED", "prepare process evidence before opening an outer transaction");
    try { return this.inspect(pid); } catch { return { alive: null, start: null }; }
  }
  /** Prepare immutable observations before an outer transaction; nested operations reuse them. */
  prepare<T>(names: string[], pids: number[], operation: () => T): T {
    if (operation.constructor.name === "AsyncFunction") throw error("IDENTITY_ASYNC_OPERATION", "prepared operations must be synchronous");
    const prior = this.#prepared.getStore();
    if (prior?.active) return operation();
    if (prior || this.store.db.isTransaction) throw error("IDENTITY_PREPARATION_REQUIRED", "process evidence must be prepared outside a transaction");
    const scope: EvidenceScope = { active: true, observations: new Map(), processes: new Map() };
    const inspect = (pid: number) => {
      let observed = scope.processes.get(pid);
      if (!observed) { observed = { value: this.evidence(pid), at: performance.now() }; scope.processes.set(pid, observed); }
      return observed;
    };
    for (const name of new Set(names)) {
      const row = this.row(name), p = row && row.released_at === null ? inspect(row.holder_pid) : { value: UNKNOWN_PROCESS, at: performance.now() };
      scope.observations.set(name, { row, process: p.value, at: p.at });
    }
    for (const pid of new Set(pids)) if (Number.isSafeInteger(pid) && pid > 0) inspect(pid);
    return this.#prepared.run(scope, () => {
      try {
        const result = operation();
        if (result && typeof (result as { then?: unknown }).then === "function") { void Promise.resolve(result).catch(() => {}); throw error("IDENTITY_ASYNC_OPERATION", "prepared operations cannot return a thenable"); }
        return result;
      } finally { scope.active = false; }
    });
  }
  processEvidence(pid: number): ProcessEvidence { return this.evidence(pid); }
  private observe(name: string): Observation {
    const scope = this.#prepared.getStore();
    if (scope) {
      if (!scope.active) throw error("IDENTITY_STATUS_UNKNOWN", "prepared process evidence scope is closed");
      // Missing observations must not pair a newly observed generation with old PID evidence.
      return scope.observations.get(name) ?? { row: undefined, process: UNKNOWN_PROCESS, at: performance.now() };
    }
    const row = this.row(name);
    const process = row && row.released_at === null ? this.evidence(row.holder_pid) : UNKNOWN_PROCESS;
    return { row, process, at: performance.now() };
  }
  private observedProcess(row: IdentityLease, observed: Observation): ProcessEvidence {
    // Evidence gathered before locking cannot expire or authorize a successor generation.
    return observed.row?.token === row.token && observed.row.holder_pid === row.holder_pid
      && observed.row.holder_start === row.holder_start && performance.now() - observed.at <= EVIDENCE_MAX_AGE_MS ? observed.process : UNKNOWN_PROCESS;
  }
  private status(row: IdentityLease, now: number, p: ProcessEvidence): { state: "live" | "unknown" | "expired"; reason: string | null } {
    return identityLeaseStatus(row, now, p);
  }
  private expire(row: IdentityLease, now: number, p: ProcessEvidence): "live" | "unknown" | "expired" {
    const { state, reason } = this.status(row, now, p);
    if (!reason) return state;
    this.store.db.prepare("UPDATE identity_leases SET released_at=?,release_reason=? WHERE name=? AND token=? AND released_at IS NULL")
      .run(now, reason, row.name, row.token);
    this.store.audit("identity.expire", { name: row.name, holder: this.holder(row), reason, at: now });
    return "expired";
  }
  private holder(row: IdentityLease): LeaseHolder {
    return { pid: row.holder_pid, start: row.holder_start, keyFp: row.key_fp, cli: row.cli, sessionId: row.session_id };
  }
  claim(name: string, holder: LeaseHolder): IdentityLease {
    this.validateClaim(name, holder);
    const prior = this.observe(name), process = this.evidence(holder.pid), at = this.#prepared.getStore()?.processes.get(holder.pid)?.at ?? performance.now();
    return this.claimPrepared(name, holder, prior, process, at);
  }
  private validateClaim(name: string, holder: LeaseHolder) {
    if (!NAME_RE.test(name) || !Number.isSafeInteger(holder.pid) || holder.pid <= 0 || !holder.start
      || !/^[a-f0-9]{4}(?:-[a-f0-9]{4}){3}$/.test(holder.keyFp) || !holder.cli || !holder.sessionId)
      throw error("IDENTITY_LEASE_CONFIG", "claim needs a valid identity and complete process/session evidence");
  }
  private claimPrepared(name: string, holder: LeaseHolder, observed: Observation, process: ProcessEvidence, at: number): IdentityLease {
    this.validateClaim(name, holder);
    return this.store.tx(() => {
      const now = this.now(), p = performance.now() - at <= EVIDENCE_MAX_AGE_MS ? process : UNKNOWN_PROCESS;
      if (p.alive !== true || p.start !== holder.start) throw error("IDENTITY_PROCESS_UNVERIFIED", "claimant process identity is not verified");
      const prior = this.row(name);
      if (prior && this.expire(prior, now, this.observedProcess(prior, observed)) !== "expired") {
        // An identical claimant (concurrent or repeated first binds of one state) re-claims idempotently.
        if (prior.key_fp === holder.keyFp && prior.holder_pid === holder.pid && prior.holder_start === holder.start
          && prior.cli === holder.cli && prior.session_id === holder.sessionId) {
          this.#prepared.getStore()?.observations.set(name, { row: prior, process: p, at });
          return prior;
        }
        throw error("IDENTITY_IN_USE", `identity ${name} already has a holder`);
      }
      const token = randomUUID();
      this.store.db.prepare(`INSERT INTO identity_leases (name,token,holder_pid,holder_start,key_fp,cli,session_id,claimed_at,heartbeat_at,idle_ttl,released_at,release_reason)
        VALUES (?,?,?,?,?,?,?,?,?,?,NULL,NULL) ON CONFLICT(name) DO UPDATE SET token=excluded.token,holder_pid=excluded.holder_pid,
        holder_start=excluded.holder_start,key_fp=excluded.key_fp,cli=excluded.cli,session_id=excluded.session_id,
        claimed_at=excluded.claimed_at,heartbeat_at=excluded.heartbeat_at,idle_ttl=excluded.idle_ttl,released_at=NULL,release_reason=NULL`)
        .run(name, token, holder.pid, holder.start, holder.keyFp, holder.cli, holder.sessionId, now, now, this.ttl);
      this.store.audit("identity.claim", { name, holder, previousHolder: prior ? this.holder(prior) : null, at: now });
      const claimed = this.row(name)!;
      this.#prepared.getStore()?.observations.set(name, { row: claimed, process: p, at });
      return claimed;
    });
  }
  /** No automatic reacquisition: callers must explicitly claim after losing a lease. */
  renew(name: string, token: string): IdentityLease {
    const observed = this.observe(name);
    const result = this.store.tx(() => {
      const row = this.row(name), now = this.now();
      if (!row || row.token !== token) return { status: "expired" as const };
      const status = this.expire(row, now, this.observedProcess(row, observed));
      if (status !== "live") return { status };
      // A backwards wall-clock step cannot shorten the recorded heartbeat.
      this.store.db.prepare("UPDATE identity_leases SET heartbeat_at=MAX(heartbeat_at,?) WHERE name=? AND token=?").run(now, name, token);
      return { status: "live" as const, row: this.row(name)! };
    });
    if (result.status === "unknown") throw error("IDENTITY_STATUS_UNKNOWN", `identity ${name} process status is unknown; retry this lease token after inspection recovers`);
    if (!result.row) throw error("IDENTITY_LEASE_LOST", `identity ${name} lease is no longer usable; explicitly reclaim it`);
    return result.row;
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
  /** Move ownership atomically with a fresh generation; a failed destination claim restores the source. */
  rename(name: string, token: string, nextName: string): IdentityLease {
    const source = this.observe(name), destination = name === nextName ? source : this.observe(nextName);
    return this.withObserved(name, token, source, () => {
      const row = this.row(name)!;
      if (name === nextName) return row;
      this.release(name, token);
      const next = this.claimPrepared(nextName, this.holder(row), destination, this.observedProcess(row, source), source.at);
      this.store.audit("identity.rename", { from: name, to: nextName, holder: this.holder(row) });
      return next;
    });
  }
  /** Hold the SQLite write lock through the operation, so a successor cannot claim halfway through it. */
  withHeld<T>(name: string, token: string, operation: () => T): T {
    if (operation.constructor.name === "AsyncFunction") throw error("IDENTITY_ASYNC_OPERATION", "lease operations must be synchronous database mutations");
    return this.withObserved(name, token, this.observe(name), operation);
  }
  /** Authorize a read at one WAL snapshot; concurrent writers need not wait for its result. */
  withHeldRead<T>(name: string, token: string, operation: () => T): T {
    if (operation.constructor.name === "AsyncFunction") throw error("IDENTITY_ASYNC_OPERATION", "lease reads must be synchronous");
    return this.withObserved(name, token, this.observe(name), operation, true);
  }
  private withObserved<T>(name: string, token: string, observed: Observation, operation: () => T, readOnly = false): T {
    const run = () => {
      const row = this.row(name);
      const status = row && row.token === token ? readOnly
        ? this.status(row, this.now(), this.observedProcess(row, observed)).state
        : this.expire(row, this.now(), this.observedProcess(row, observed)) : "expired";
      if (status !== "live") return { ok: false as const, status };
      const scope = { store: this.store, name, token, active: true, readOnly };
      let value: T;
      try { value = heldOperation.run(scope, operation); }
      finally { scope.active = false; }
      if (value && typeof (value as { then?: unknown }).then === "function") {
        // This cannot cancel external side effects. Store transaction contexts block later DB writes.
        void Promise.resolve(value).catch(() => {});
        throw error("IDENTITY_ASYNC_OPERATION", "lease operations cannot return a thenable");
      }
      return { ok: true as const, value };
    };
    const result = readOnly ? this.store.readTx(run) : this.store.tx(run);
    if (!result.ok) {
      if (result.status === "unknown") throw error("IDENTITY_STATUS_UNKNOWN", `identity ${name} process status is unknown; retry this lease token after inspection recovers`);
      throw error("IDENTITY_LEASE_LOST", `identity ${name} lease is no longer usable`);
    }
    return result.value;
  }
}
