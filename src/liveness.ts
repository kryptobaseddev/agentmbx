// T699: one answer to "is this mailbox being served, and how?" for `mbx_agents`, `mbx_identity list`,
// `agentmbx agents` and the send receipt.
//
// Liveness is not claimability. The lease still decides who may claim a name (identityAvailability), but a
// released lease is not the same thing as an absent session: OpenCode evicts an idle MCP about hourly and
// releases the lease while the serve keeps hosting the conversation (T659). That mailbox is idle — claimable,
// no holder right now, but wakeable and seen on the session's next turn — not "live" (nothing is serving it)
// and not "offline" (the session is still there). Both wrong answers came from asking different questions:
// `agentmbx agents` read the session binding, the lease-based surfaces read identity_leases.
//
// The reason text is deliberately built from evidence every process can read (lease row, session row, process
// table, serve kind), never from this process's wake-queue registry, so every surface says the same thing.
import { activityKey, identityAvailability, parseActivity, type LeaseActivity } from "./identity-availability.ts";
import { identityLeaseStatus, inspectLeaseProcesses, type IdentityLease, type ProcessEvidence } from "./identity-leases.ts";
import { sessionRowLive, type MbxNode } from "./node.ts";
import { wakeBindingsByAgent, type WakeBinding } from "./opencode-poller.ts";
import type { OpencodeHost } from "./opencode-provider.ts";

export type LivenessState = "live" | "idle" | "unknown" | "offline" | "conflict";

/** A bound session of this name that is still running (the display rule `sessionRowLive`). */
export interface SessionBinding { cli: string; session_id: string; pid: number }

export interface AgentLiveness {
  state: LivenessState;
  reason: string;
  claimable: boolean;
  /**
   * `idle` has two causes, and the receipt treats them differently: `held` still has a current lease (a quiet
   * shared conversation, T608/T383) so the ordinary capture/wake path applies; `released` has no usable lease
   * and the session is only reachable through its live binding (T659/T688).
   */
  idleKind?: "held" | "released";
  binding?: SessionBinding;
  /** T659/T688: a wake path is proven for that binding (shared service, or a registered standalone poller). */
  wakeable?: boolean;
  takeover?: "idle-conversation" | "same-session";
  coUse?: true;
}

type AvailabilityInput = Parameters<typeof identityAvailability>[0];
export interface LivenessInput extends AvailabilityInput {
  /** A live binding of this name, when one exists. Without it a released lease is plainly offline. */
  binding?: SessionBinding | null;
  /** The proven serve hosting that binding (opencode only). */
  serve?: WakeBinding | null;
}

const iso = (ms: number) => new Date(ms).toISOString();

const sameTarget = (b: SessionBinding, s: WakeBinding | null | undefined): s is WakeBinding =>
  !!s && s.cli === b.cli && s.session_id === b.session_id && s.pid === b.pid;

/**
 * The one mapping from lease availability + a live binding to a liveness answer. Pure: callers pass the evidence
 * they already read, so the same rows always produce the same token and reason.
 */
export function livenessOf(o: LivenessInput): AgentLiveness {
  const a = identityAvailability(o);
  if (a.state === "conflict") return { state: "conflict", reason: a.reason, claimable: false };
  if (a.state === "live" || a.state === "unknown") {
    return { state: a.state, reason: a.reason, claimable: a.claimable, ...(a.takeover ? { takeover: a.takeover } : {}), ...(a.coUse ? { coUse: a.coUse } : {}) };
  }
  if (a.state === "idle") {
    return { state: "idle", idleKind: "held", reason: a.reason, claimable: true, ...(a.takeover ? { takeover: a.takeover } : {}) };
  }
  // `offline` (a released or expired lease) and `free` (no lease) are idle only while the same session still runs.
  if (o.binding) {
    const serve = sameTarget(o.binding, o.serve) ? o.serve : null;
    return {
      state: "idle", idleKind: "released", binding: o.binding, claimable: true,
      wakeable: serve?.wakeable === true,
      reason: releasedIdleReason(o.lease, a.reason, o.binding, serve),
    };
  }
  return { state: "offline", reason: a.reason, claimable: a.claimable, ...(a.takeover ? { takeover: a.takeover } : {}) };
}

function releasedIdleReason(lease: IdentityLease | undefined, expiredReason: string, b: SessionBinding, serve: WakeBinding | null): string {
  const why = !lease ? "no current lease"
    : lease.released_at !== null
      ? `${lease.release_reason && lease.release_reason !== "released" ? `expired (${lease.release_reason})` : "released"} ${iso(lease.released_at)}`
      : expiredReason;
  const host = serve ? (serve.kind === "service" ? ", shared service" : ", standalone serve") : "";
  return `${why}; its ${b.cli} session ${b.session_id} is still running (pid ${b.pid}${host}), so it is idle: mail waits for its next turn`;
}

/** One session row as read for a liveness snapshot (process evidence is checked separately). */
export interface SessionRow {
  agent: string; cli: string; session_id: string; pid: number | null; pid_start: string | null; updated_at: string;
}

/** The live binding of `lease`'s session when there is one, else the newest live binding of this name. */
function pickBinding(lease: IdentityLease | undefined, rows: readonly SessionRow[], now: number): SessionBinding | null {
  const usable = rows.filter((r) => !r.session_id.startsWith("mcp-") && sessionRowLive({ pid: r.pid, pid_start: r.pid_start, updated_at: r.updated_at }, now));
  const exact = lease ? usable.find((r) => r.cli === lease.cli && r.session_id === lease.session_id) : undefined;
  const row = exact ?? usable[0];
  return row && row.pid ? { cli: row.cli, session_id: row.session_id, pid: row.pid } : null;
}

export interface LivenessOptions {
  now?: number;
  /** Injected evidence (tests, and identity inventory's own snapshot). Omitted, one batched process read per call. */
  inspect?: (pid: number) => ProcessEvidence;
  /** Injected serve classification (tests). Omitted, one argv read per batch. */
  host?: (pid: number | null | undefined) => OpencodeHost;
  /** Injected poller registration (tests). Omitted, this process's wake queue. */
  waiting?: (sessionID: string, pid: number) => boolean;
}

/** Everything a liveness answer needs, already read. The identity inventory builds one from its own snapshot. */
export interface LivenessSnapshot {
  /** Names the caller wants answered. */
  names: readonly string[];
  leases: readonly IdentityLease[];
  sessions: readonly SessionRow[];
  now: number;
  activity: (name: string) => LeaseActivity | null;
  conflicts: ReadonlySet<string>;
  evidence: (pid: number) => ProcessEvidence;
  caller?: AvailabilityInput["caller"];
  host?: (pid: number | null | undefined) => OpencodeHost;
  waiting?: (sessionID: string, pid: number) => boolean;
  /** Distinguishes stores in the wake memo (a home path). */
  scope?: string;
}

/** How long a wake verdict may be reused. Receipt pages ask again per message; one binding cannot change that fast. */
const WAKE_MEMO_MS = 1_000;
const WAKE_MEMO_MAX = 512;
const wakeMemo = new Map<string, { key: string; at: number; value: WakeBinding | null }>();
const rowKey = (r: { cli: string; session_id: string; pid: number | null }) => `${r.cli}\0${r.session_id}\0${r.pid ?? ""}`;

/**
 * The one liveness mapping for a whole page of names: bindings and wake verdicts are derived here, so the agent
 * list, the roster and the send receipt cannot drift apart again. The wake verdict is reused for one second so a
 * receipt page costs one process read, not one per line.
 */
export function livenessSnapshot(o: LivenessSnapshot): Map<string, AgentLiveness> {
  const unique = [...new Set(o.names)];
  const leases = new Map(o.leases.map((r) => [r.name, r]));
  const rowsByName = new Map<string, SessionRow[]>();
  for (const r of o.sessions) rowsByName.set(r.agent, [...(rowsByName.get(r.agent) ?? []), r]);
  const bindings = new Map<string, SessionBinding | null>();
  for (const name of unique) bindings.set(name, pickBinding(leases.get(name), rowsByName.get(name) ?? [], o.now));

  // A wake verdict is only meaningful when no current lease serves the name: release, expiry or no lease at all.
  const candidates = new Map<string, SessionRow[]>();
  for (const name of unique) {
    const lease = leases.get(name), binding = bindings.get(name);
    if (!binding) continue;
    if (lease && identityLeaseStatus(lease, o.now, o.evidence(lease.holder_pid)).state !== "expired") continue;
    candidates.set(name, (rowsByName.get(name) ?? []).filter((r) => r.cli === binding.cli && r.session_id === binding.session_id));
  }
  const serves = new Map<string, WakeBinding | null>();
  const fresh = new Map<string, SessionRow[]>();
  for (const [name, rows] of candidates) {
    const lease = leases.get(name), key = `${o.scope ?? ""}\0${lease?.token ?? ""}\0${lease?.released_at ?? ""}\0${rows.map(rowKey).join(",")}`;
    const memo = wakeMemo.get(name);
    if (memo && memo.key === key && o.now - memo.at < WAKE_MEMO_MS) serves.set(name, memo.value);
    else fresh.set(name, rows);
  }
  if (fresh.size) {
    const found = wakeBindingsByAgent(new Map(fresh), o.host, o.waiting);
    for (const name of fresh.keys()) {
      const value = found.get(name) ?? null;
      const lease = leases.get(name);
      const key = `${o.scope ?? ""}\0${lease?.token ?? ""}\0${lease?.released_at ?? ""}\0${(fresh.get(name) ?? []).map(rowKey).join(",")}`;
      wakeMemo.set(name, { key, at: o.now, value });
      serves.set(name, value);
    }
    if (wakeMemo.size > WAKE_MEMO_MAX) for (const k of wakeMemo.keys()) if (wakeMemo.size > WAKE_MEMO_MAX) wakeMemo.delete(k);
  }

  const out = new Map<string, AgentLiveness>();
  for (const name of unique) {
    const lease = leases.get(name);
    out.set(name, livenessOf({
      lease, evidence: lease ? o.evidence(lease.holder_pid) : { alive: null, start: null },
      activity: o.activity(name), conflict: o.conflicts.has(name), now: o.now,
      ...(o.caller ? { caller: o.caller } : {}),
      binding: bindings.get(name), serve: serves.get(name) ?? null,
    }));
  }
  return out;
}

/** The same liveness answer for many names, read from one store (and one process snapshot). */
export function agentLivenessBatch(node: MbxNode, names: readonly string[], o: LivenessOptions = {}): Map<string, AgentLiveness> {
  const now = o.now ?? Date.now();
  const unique = [...new Set(names)];
  if (!unique.length) return new Map();
  const marks = unique.map(() => "?").join(",");
  const leases = node.store.db.prepare(`SELECT * FROM identity_leases WHERE name IN (${marks})`).all(...unique) as unknown as IdentityLease[];
  const sessions = node.store.db.prepare(`SELECT agent,cli,session_id,pid,pid_start,updated_at FROM sessions WHERE agent IN (${marks}) ORDER BY updated_at DESC`).all(...unique) as unknown as SessionRow[];
  const holders = leases.flatMap((l) => l.released_at === null ? [l.holder_pid] : []);
  const evidence = new Map<number, ProcessEvidence>();
  if (o.inspect) for (const pid of holders) evidence.set(pid, o.inspect(pid));
  else if (holders.length) for (const [pid, e] of inspectLeaseProcesses(holders)) evidence.set(pid, e);
  return livenessSnapshot({
    names: unique, leases, sessions, now,
    activity: (name) => parseActivity(node.store.get(activityKey(name))),
    conflicts: new Set(unique.filter((name) => node.store.get(`identity-conflict:${name}`) !== undefined)),
    evidence: (pid) => evidence.get(pid) ?? { alive: null, start: null },
    host: o.host, waiting: o.waiting, scope: node.home,
  });
}

/** The same answer for one name; every surface uses this or the batch, never its own rule. */
export function agentLiveness(node: MbxNode, name: string, o: LivenessOptions = {}): AgentLiveness {
  return agentLivenessBatch(node, [name], o).get(name) ?? { state: "offline", reason: "no session has held it under a lease", claimable: true };
}

/**
 * The `agentmbx agents` display for this host's directory: local names carry the shared liveness token and reason.
 * A shell participant (`agentmbx send --as`) has no session and no lease; it stays visible as live for two hours
 * after its last send, exactly as before (T699 decision).
 */
export function agentDirectoryStates(node: MbxNode, o: LivenessOptions = {}): Map<string, { state: LivenessState; reason: string }> {
  const now = o.now ?? Date.now();
  const records = node.agents();
  const local = records.filter((a) => a.host === node.host);
  const answers = agentLivenessBatch(node, local.map((a) => a.name), o);
  const since = new Date(now - 2 * 3_600_000).toISOString();
  const bound = new Set((node.store.db.prepare("SELECT DISTINCT agent FROM sessions").all() as { agent: string }[]).map((r) => r.agent));
  const out = new Map<string, { state: LivenessState; reason: string }>();
  for (const a of local) {
    const l = answers.get(a.name);
    // A shell participant (--as) never bound a session; it stays visible as live for two hours after its last send.
    if (a.cli === "cli" && a.last_seen !== null && a.last_seen > since && !bound.has(a.name) && l?.state === "offline") {
      const mins = Math.max(0, Math.round((now - Date.parse(a.last_seen)) / 60_000));
      out.set(a.name, { state: "live", reason: `shell sender, last seen ${mins} min ago` });
    } else if (l) out.set(a.name, { state: l.state, reason: l.reason });
  }
  return out;
}
