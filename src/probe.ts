// T392: `agentmbx probe` — the T388 cross-harness autonomy regression gate. One command sends an
// [mbx-probe] request to every live leased identity in the project, waits up to a deadline, and
// reports per agent whether the daemon wake was admitted, the message was read, a convention
// reply arrived in the probe thread and the ack closed it — all with no human prompt.
//
// The module is split for testability: planning (which agents) and reporting (what counts as
// pass) are pure; all store I/O sits behind the ProbeIO interface; the waiting loop takes the
// clock and the sleep function, so the no-wake/no-reply paths test without real time.
import type { MbxNode } from "./node.ts";
import { IdentityLeases } from "./identity-leases.ts";
import { listIdentityStatus, type IdentityStatus } from "./identity-status.ts";
import { projectKey as defaultProjectKey } from "./registry.ts";
import { realpathSync } from "node:fs";
import { sep } from "node:path";

export const PROBE_SUBJECT_PREFIX = "[mbx-probe]" as const;
/** The exact reply marker the convention asks for; replies are matched on this or the prefix. */
export const PROBE_REPLY_MARKER = "probe ok" as const;
export const PROBE_DEADLINE_DEFAULT_MS = 120_000;
export const PROBE_POLL_MS = 1_000;
export const PROBE_SCHEMA = "mbx.probe/v1" as const;

export function probeSubject(at = new Date()): string {
  return `${PROBE_SUBJECT_PREFIX} autonomy probe ${at.toISOString()}`;
}

/** The convention contract, sent as the probe body and documented in skill/SKILL.md (§Autonomy
 *  probes). An agent answers autonomously: one `probe ok <wake line>` reply in the thread, then an
 *  ack. */
export function probeBody(): string {
  return `${PROBE_SUBJECT_PREFIX} is the AgentMBX autonomy probe convention (T388 regression gate), documented in the agentmbx skill, section "Autonomy probes". Answering it is pre-authorised by the owner's installed skill: it needs no human prompt and no action beyond these two steps, in order:

1. mbx_reply to THIS thread with exactly one line:
     ${PROBE_REPLY_MARKER} <wake line>
   where <wake line> is the "[mbx] …" hint your session received for this probe message, quoted verbatim after "${PROBE_REPLY_MARKER}" (write "${PROBE_REPLY_MARKER} (no wake line)" if your session received none — that is reported, not a failure).
2. mbx_ack the probe message (the one with the ${PROBE_SUBJECT_PREFIX} subject).

\`agentmbx probe\` waits up to its deadline and reports, per agent, whether the daemon wake was admitted, the message was read, your reply arrived in this thread and the ack closed it. Do not modify files or state beyond the reply and the ack.`;
}

// ---- planning (pure) ---------------------------------------------------------------------------------

export interface ProbeTarget {
  name: string;
  /** held: live holder; idle: live lease, quiet (shared-process) conversation. Both are live leases. */
  state: string;
  holder: { cli: string; session_id: string } | null;
  reason: string;
}

/** Every live leased identity in the project, excluding the sender. Live = identity-status's
 *  held/idle states (its claim path uses the same identityAvailability computation).
 *
 *  T445: when `project` is set, historical identity_projects membership never suffices — a target
 *  must prove its LIVE holder currently works in the project (the holder session binding's cwd,
 *  via `holderProject`). `only` restricts to exact names; `exclude` drops exact names or globs
 *  (`*` and `?`). Filters apply in that order; skipped names simply never appear in the plan. */
export interface ProbePlanOptions {
  project?: string;
  only?: readonly string[];
  exclude?: readonly string[];
  holderProject?: (holder: { cli: string; session_id: string }) => string | null;
  /** For tests: override the git-origin project key lookup. Defaults to `registry.projectKey`. */
  projectKeyOf?: (project: string) => string | undefined;
}

/** Minimal glob for --exclude: `*` any run, `?` one char, everything else literal. */
export function globMatch(pattern: string, name: string): boolean {
  const re = new RegExp("^" + pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".") + "$");
  return re.test(name);
}

/** True when a holder's session cwd is the project, inside it, or has the same git-origin project key (T445). One rule
 *  for `planProbe` and the roster's `seen_here` (T496), so the two cannot drift. A missing cwd is not in the project. */
export function cwdInProject(rawCwd: string | null | undefined, project: string,
  keyOf: (path: string) => string | undefined = defaultProjectKey): boolean {
  if (!rawCwd) return false;
  const cwd = (() => { try { return realpathSync(rawCwd); } catch { return rawCwd; } })();
  if (cwd === project || cwd.startsWith(project + sep)) return true;
  const targetKey = keyOf(cwd), projectKey = keyOf(project);
  return targetKey !== undefined && projectKey !== undefined && targetKey === projectKey;
}

export function planProbe(identities: readonly IdentityStatus[], sender: string, options: ProbePlanOptions = {}): ProbeTarget[] {
  const only = options.only?.length ? new Set(options.only) : null;
  const keyOf = options.projectKeyOf ?? defaultProjectKey;
  return identities
    .filter((i) => i.name !== sender && (i.state === "held" || i.state === "idle"))
    .filter((i) => {
      if (!options.project || !options.holderProject) return true;
      return cwdInProject(i.holder ? options.holderProject(i.holder) : null, options.project, keyOf);
    })
    .filter((i) => !only || only.has(i.name))
    .filter((i) => !(options.exclude ?? []).some((p) => globMatch(p, i.name)))
    .map((i) => ({ name: i.name, state: i.state, holder: i.holder ? { cli: i.holder.cli, session_id: i.holder.session_id } : null, reason: i.reason }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

// ---- store I/O behind an interface -------------------------------------------------------------------

export interface SentProbe { id: string; thread: string; at: number }
export interface WakeObservation {
  outcome: string | null; via: string | null; receipt: string | null;
  /** Conversation session that can observe a watcher exit. Absent on dispatcher rows. */
  session: string | null; at: number | null;
}
export interface TargetObservation {
  wake: WakeObservation | null;
  readAt: number | null;
  ackedAt: number | null;
  ackNote: string | null;
  reply: { id: string; at: number } | null;
}

export interface ProbeIO {
  host(): string;
  listTargets(): IdentityStatus[];
  /** The cwd of a holder's live session binding row, or null when it has none (T445). */
  holderProject?(holder: { cli: string; session_id: string }): string | null;
  send(target: string): SentProbe;
  observe(target: string, sent: SentProbe): TargetObservation;
}

/** The real store-backed IO: targets via identity-status (the established read-only enumeration,
 *  with the project filter and caller scope), sends as kind=request with needs_reply, and
 *  observations read straight from the audit/deliveries/messages tables. Each send runs inside
 *  the sender's withHeld lease fence — the same fence `agentmbx send` uses — so the envelope is
 *  marked sender_verification "leased" and the probe measures the real wake-authority path; a
 *  sender whose lease is gone when a send lands throws and the target reports a send failure. */
export function storeProbeIO(node: MbxNode, o: { project?: string; sender: string;
  caller?: { cli: string; sessionId: string; pid?: number } }): ProbeIO {
  const db = node.store.db;
  return {
    host: () => node.host,
    listTargets: () => listIdentityStatus(node.home, { project: o.project, ...(o.caller ? { caller: o.caller } : {}) }).identities,
    holderProject: (holder) => {
      // The live holder proves current project work through its session binding row — historical
      // identity_projects membership never suffices (T445).
      const row = db.prepare("SELECT cwd FROM sessions WHERE cli=? AND session_id=? ORDER BY updated_at DESC LIMIT 1")
        .get(holder.cli, holder.session_id) as { cwd: string | null } | undefined;
      return row?.cwd ?? null;
    },
    send: (target) => {
      const at = Date.now();
      const draft = { from: o.sender, to: [target], subject: probeSubject(new Date(at)), body: probeBody(),
        kind: "request" as const, needs_reply: true, ...(o.project ? { project: o.project } : {}) };
      const row = db.prepare("SELECT token FROM identity_leases WHERE name=? AND released_at IS NULL").get(o.sender) as { token: string } | undefined;
      // No unfenced fallback: a sender without a live lease (released between planning and
      // sending, or never held) throws and the target reports a send failure — the token is
      // re-read per send so a lease that moves mid-probe lands in the same place.
      if (!row) throw new Error(`sender ${o.sender} no longer holds its lease`);
      const r = new IdentityLeases(node.store).withHeld(o.sender, row.token, () => node.send(draft));
      return { id: r.envelope.id, thread: r.envelope.thread, at };
    },
    observe: (target, sent) => {
      const since = new Date(sent.at).toISOString();
      // Wake: the latest wake.attempt at/after the send decides. The dispatcher logs
      // outcome/receipt/native on wake.attempt and the transport via on its sibling wake event;
      // watchers and channels log everything on the attempt row itself.
      let wake: WakeObservation | null = null;
      for (const row of db.prepare("SELECT at, detail FROM audit WHERE event='wake.attempt' AND at>=? ORDER BY at ASC").all(since) as { at: string; detail: string }[]) {
        let d: { agent?: string; outcome?: string | null; via?: string | null; receipt?: string | null; session?: string | null };
        try { d = JSON.parse(row.detail); } catch { continue; }
        if (d.agent !== target) continue;
        wake = { outcome: d.outcome ?? null, via: d.via ?? null, receipt: d.receipt ?? null,
          session: typeof d.session === "string" && d.session ? d.session : null, at: Date.parse(row.at) };
      }
      if (wake && !wake.via) {
        for (const row of db.prepare("SELECT at, detail FROM audit WHERE event='wake' AND at>=? ORDER BY at ASC").all(since) as { at: string; detail: string }[]) {
          let d: { agent?: string; via?: string | null };
          try { d = JSON.parse(row.detail); } catch { continue; }
          if (d.agent === target && d.via) wake = { ...wake, via: d.via };
        }
      }
      const dlv = db.prepare("SELECT state, updated_at, note FROM deliveries WHERE msg_id=? AND agent=?").get(sent.id, target) as
        { state: string; updated_at: string; note: string | null } | undefined;
      const readAt = dlv && (dlv.state === "read" || dlv.state === "acked") ? Date.parse(dlv.updated_at) : null;
      const ackedAt = dlv && dlv.state === "acked" ? Date.parse(dlv.updated_at) : null;
      // Reply: same thread, from the target, matched tolerantly on the convention — an agent
      // may answer before or after its wake line is logged, so the thread and the marker are
      // the contract, not event ordering.
      let reply: { id: string; at: number } | null = null;
      for (const row of db.prepare("SELECT id, ts, subject, from_addr, envelope FROM messages WHERE thread=? AND id<>? ORDER BY ts ASC").all(sent.thread, sent.id) as
        { id: string; ts: string; subject: string | null; from_addr: string; envelope: string }[]) {
        if (row.from_addr !== `${target}@${node.host}`) continue;
        let body = "";
        try { body = (JSON.parse(row.envelope) as { body?: string }).body ?? ""; } catch { /* unmatched shape: fall through */ }
        if ((row.subject ?? "").startsWith(PROBE_SUBJECT_PREFIX) || body.includes(PROBE_REPLY_MARKER)) {
          reply = { id: row.id, at: Date.parse(row.ts) };
          break;
        }
      }
      return { wake, readAt, ackedAt, ackNote: ackedAt !== null ? (dlv?.note ?? null) : null, reply };
    },
  };
}

// ---- report (pure) -----------------------------------------------------------------------------------

export interface ProbeAgentReport {
  name: string;
  /** Planning state from identity-status (held/idle). Present even in --plan output. */
  state: string;
  holder: { cli: string; session_id: string } | null;
  message_id: string;
  sent_at: string;
  wake: (WakeObservation & { latency_ms: number | null }) | null;
  read: { at: string; latency_ms: number } | null;
  ack: { at: string; note: string | null; latency_ms: number } | null;
  reply: { id: string; at: string; latency_ms: number } | null;
  /** How the answer arrived: an admitted idle wake, or in-turn (the session was
   *  mid-turn and saw the probe via its in-turn hook — no wake row). Null until
   *  a reply exists. */
  path: "idle-wake" | "in-turn" | null;
  ok: boolean;
  reason: string | null;
}

export interface ProbeReport {
  schema: typeof PROBE_SCHEMA;
  ok: boolean;
  host: string;
  project?: string;
  sender: string;
  deadline_ms: number;
  /** True when run with the strict gate (an admitted idle wake AND the reply). */
  require_idle_wake: boolean;
  started_at: string;
  finished_at: string;
  targets: ProbeAgentReport[];
  summary: { total: number; passed: number; failed: number };
  reason: string | null;
}

const iso = (ms: number) => new Date(ms).toISOString();
const latency = (at: number | null, sentAt: number) => (at === null ? null : Math.max(0, at - sentAt));

/** A `via: watcher` admit counts as an idle wake only when the attempt names the conversation
 *  session that can observe the exit. Printing the hint is not that observation. An `mcp-*`
 *  lease token is not a conversation session. Other admitted vias are unchanged. */
export function watcherObservesExit(wake: WakeObservation | null): boolean {
  if (wake?.outcome !== "admitted") return false;
  if (wake.via !== "watcher") return true;
  return !!wake.session && !wake.session.startsWith("mcp-");
}

/** Default gate: the convention reply arrived in the thread within the deadline — the agent
 *  answered autonomously whether it was woken while idle (`path: "idle-wake"`) or saw the probe
 *  mid-turn through its in-turn hook (`path: "in-turn"`, no wake row). With `requireIdleWake`
 *  (the T388 harness rows) the gate is the strict one: an admitted idle wake AND the reply.
 *  A watcher row without its observing session is not that idle wake. Read and ack are recorded
 *  either way, never gated. */
export function buildProbeReport(o: {
  plan: ProbeTarget[];
  sent: Map<string, SentProbe>;
  sendErrors?: Map<string, string>;
  observations: Map<string, TargetObservation>;
  startedAt: number;
  finishedAt: number;
  deadlineMs: number;
  host: string;
  project?: string;
  sender: string;
  requireIdleWake?: boolean;
  noTargetsReason?: string;
  /** --plan: targets were computed but nothing was sent, so no pass/fail reasons apply. */
  plannedOnly?: boolean;
}): ProbeReport {
  const deadlineS = Math.round(o.deadlineMs / 1000);
  const requireIdleWake = o.requireIdleWake ?? false;
  const targets: ProbeAgentReport[] = o.plan.map((t) => {
    const sent = o.sent.get(t.name);
    const ob = o.observations.get(t.name) ?? { wake: null, readAt: null, ackedAt: null, ackNote: null, reply: null };
    const admitted = ob.wake?.outcome === "admitted";
    const idleWake = watcherObservesExit(ob.wake);
    const path: ProbeAgentReport["path"] = ob.reply ? (idleWake ? "idle-wake" : "in-turn") : null;
    const reason = o.plannedOnly ? null
      : o.sendErrors?.get(t.name) ? `probe message could not be sent: ${o.sendErrors.get(t.name)}`
      : !ob.reply && !ob.wake ? `no wake.attempt for ${t.name} within ${deadlineS}s of the probe`
      : !ob.reply && !admitted ? `wake for ${t.name} never admitted (last outcome: ${ob.wake!.outcome ?? "unknown"}${ob.wake!.via ? ` via ${ob.wake!.via}` : ""})`
      : !ob.reply ? `${t.name} woke but did not reply in the probe thread within ${deadlineS}s`
      : requireIdleWake && !idleWake ? `in-turn answer without an admitted idle wake (last wake outcome: ${ob.wake?.outcome ?? "none"}${ob.wake?.via ? ` via ${ob.wake.via}` : ""}); --require-idle-wake requires one`
      : null;
    return {
      name: t.name, state: t.state, holder: t.holder, message_id: sent?.id ?? "", sent_at: sent ? iso(sent.at) : "",
      path,
      wake: ob.wake && sent ? { ...ob.wake, latency_ms: latency(ob.wake.at, sent.at) } : null,
      read: ob.readAt !== null && sent ? { at: iso(ob.readAt), latency_ms: latency(ob.readAt, sent.at)! } : null,
      ack: ob.ackedAt !== null && sent ? { at: iso(ob.ackedAt), note: ob.ackNote, latency_ms: latency(ob.ackedAt, sent.at)! } : null,
      reply: ob.reply && sent ? { id: ob.reply.id, at: iso(ob.reply.at), latency_ms: latency(ob.reply.at, sent.at)! } : null,
      ok: reason === null,
      reason,
    };
  });
  const failed = targets.filter((t) => !t.ok).length;
  const reason = o.noTargetsReason ?? (failed ? targets.filter((t) => !t.ok).map((t) => t.reason).join("; ") : null);
  return {
    schema: PROBE_SCHEMA, ok: targets.length > 0 && failed === 0, host: o.host,
    ...(o.project ? { project: o.project } : {}),
    sender: o.sender, deadline_ms: o.deadlineMs, require_idle_wake: requireIdleWake,
    started_at: iso(o.startedAt), finished_at: iso(o.finishedAt),
    targets, summary: { total: targets.length, passed: targets.length - failed, failed }, reason,
  };
}

// ---- the waiting loop ---------------------------------------------------------------------------------

export async function runProbe(io: ProbeIO, o: {
  sender: string;
  project?: string;
  deadlineMs?: number;
  /** Restrict targets to these exact names (after the live-project check). */
  only?: readonly string[];
  /** Drop these names (exact or glob) after every other filter. */
  exclude?: readonly string[];
  /** Print the plan only: compute targets, send nothing, wait for nothing. */
  planOnly?: boolean;
  /** Strict gate (the T388 harness rows): an admitted idle wake AND the reply. Default is
   *  reply-only — an agent answering mid-turn through its in-turn hook passes as "in-turn". */
  requireIdleWake?: boolean;
  /** Injectable clock/sleep so tests run the no-wake/no-reply paths without real time. */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  pollMs?: number;
}): Promise<ProbeReport> {
  const deadlineMs = o.deadlineMs ?? PROBE_DEADLINE_DEFAULT_MS;
  const now = o.now ?? Date.now;
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const pollMs = o.pollMs ?? PROBE_POLL_MS;
  const startedAt = now();

  const plan = planProbe(io.listTargets(), o.sender, {
    project: o.project, only: o.only, exclude: o.exclude,
    holderProject: io.holderProject ? (h) => io.holderProject!(h) : undefined,
  });
  if (!plan.length) {
    return buildProbeReport({ plan, sent: new Map(), observations: new Map(), startedAt, finishedAt: now(),
      deadlineMs, host: io.host(), project: o.project, sender: o.sender, requireIdleWake: o.requireIdleWake,
      noTargetsReason: "no live leased identities to probe (excluding the sender)" });
  }
  if (o.planOnly) {
    return buildProbeReport({ plan, sent: new Map(), observations: new Map(), startedAt, finishedAt: now(),
      deadlineMs, host: io.host(), project: o.project, sender: o.sender, requireIdleWake: o.requireIdleWake, plannedOnly: true });
  }

  const sent = new Map<string, SentProbe>();
  const sendErrors = new Map<string, string>();
  for (const t of plan) {
    try { sent.set(t.name, io.send(t.name)); }
    catch (e) { sendErrors.set(t.name, (e as Error).message); }
  }

  const observations = new Map<string, TargetObservation>();
  const complete = (name: string): boolean => {
    const ob = observations.get(name);
    return !!ob && ob.wake?.outcome === "admitted" && ob.reply !== null && (ob.readAt !== null || ob.ackedAt !== null);
  };
  const observeAll = () => {
    for (const t of plan) {
      if (sent.has(t.name) && !complete(t.name)) observations.set(t.name, io.observe(t.name, sent.get(t.name)!));
    }
  };
  for (;;) {
    observeAll();
    if (plan.every((t) => complete(t.name)) || now() - startedAt >= deadlineMs) break;
    await sleep(pollMs);
  }
  observeAll(); // a final pass so targets still waiting show their latest state

  return buildProbeReport({ plan, sent, sendErrors, observations, startedAt, finishedAt: now(),
    deadlineMs, host: io.host(), project: o.project, sender: o.sender, requireIdleWake: o.requireIdleWake });
}
