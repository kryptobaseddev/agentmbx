// T659: OpenCode evicts an idle session's MCP about hourly (upstream; doctor explains the signature under T450),
// which releases the mailbox lease. A wake target usually needs a live lease holder (captureWakeIdentity), so in
// that window mail could only be noticed on the desktop. The serve itself is still there, and the plugin inside it
// long-polls the daemon's loopback wake queue for exactly this session: that poller is the target.
//
// Authority is the bound session row plus the poller, not a lease: the row must still name this agent, this session
// id and this serve pid with the birth the row recorded, and for a standalone serve (`serve --stdio`) the poller must
// be registered for that same (session, pid) right now. Registration is live evidence: the daemon drops the slot when
// the serving process's request closes. T688: a row of the shared service (`serve --service`) needs no poller, since
// the service itself still hosts the session; wakeOpencode posts to it (and keeps T646's dual-host refusal). Nothing here reads or changes
// mail: a wake carries ids only, and the session claims its identity again on the turn the wake starts.
import { provenProcess, withProcSnapshot } from "./proc.ts";
import { opencodeHostClassifier, opencodeHostOf, type OpencodeHost } from "./opencode-provider.ts";
import { opencodeWakeWaiting } from "./opencode-wake-queue.ts";
import type { MbxNode } from "./node.ts";

type WakeSession = ReturnType<MbxNode["sessionsFor"]>[number];
type Hosts = (pid: number | null | undefined) => OpencodeHost;

/** A wakeable target with the same shape captureWakeIdentity returns, so dispatchWakes treats both alike. */
export interface PollerTarget {
  session: WakeSession;
  run: <T>(operation: () => T, readOnly?: boolean) => T;
}

const refused = () => Object.assign(new Error("opencode serve poller or session binding changed"), { code: "WAKE_IDENTITY_LOST" });
const binding = (s: WakeSession) => JSON.stringify([s.agent, s.cli, s.session_id, s.pid, s.pid_start, s.session_key, s.channel]);

/** The current row for this exact (cli, session) when it still names this agent and process. */
function currentRow(node: MbxNode, session: WakeSession): WakeSession | undefined {
  const row = node.store.db.prepare("SELECT * FROM sessions WHERE cli=? AND session_id=?").get(session.cli, session.session_id) as WakeSession | undefined;
  return row && row.agent === session.agent && binding(row) === binding(session) ? row : undefined;
}

/** True while this row still names a live serve of `kind` for this exact session. */
function bindingLive(node: MbxNode, session: WakeSession, kind: OpencodeHost, host: Hosts): boolean {
  if (session.cli !== "opencode" || !session.pid || session.pid <= 1 || session.session_id.startsWith("mcp-")) return false;
  if (host(session.pid) !== kind) return false;
  // The recorded birth must still be that process: a reused pid must not inherit a row it never wrote.
  if (!provenProcess(session.pid, session.pid_start)) return false;
  return !!currentRow(node, session);
}

/** True while this row still names a live standalone serve for this exact session, whatever it is polling. */
export const serveBindingLive = (node: MbxNode, session: WakeSession, host: Hosts = opencodeHostOf): boolean =>
  bindingLive(node, session, "standalone", host);

/** T688: the shared service hosts its sessions for as long as it lives, so its row needs no poller; the wake posts to the service. */
const serviceBindingLive = (node: MbxNode, session: WakeSession, host: Hosts = opencodeHostOf): boolean =>
  bindingLive(node, session, "service", host);

/**
 * True while this row names a live standalone serve that is polling the wake queue for this exact session. Selection
 * needs the registration (it is the live evidence that the serve can take a wake); re-verification of a handoff must
 * not, because a successful handoff consumes the slot before its result is settled.
 */
export function pollerTargetLive(node: MbxNode, session: WakeSession, host: Hosts = opencodeHostOf): boolean {
  return serveBindingLive(node, session, host) && opencodeWakeWaiting(session.session_id, session.pid!);
}

/**
 * T699: one bound session the dispatcher can still wake with no lease held. `kind` is the serve that hosts it;
 * `wakeable` says a wake path is proven (a shared service needs no poller, T688; a standalone serve needs its
 * plugin poll registered in THIS process, T659).
 */
export interface WakeBinding {
  cli: string;
  session_id: string;
  pid: number;
  kind: "service" | "standalone";
  wakeable: boolean;
  via: "service" | "standalone-poller" | null;
}

/** The session fields wake classification needs; a full session row is assignable to this. */
export interface WakeRow {
  agent: string; cli: string; session_id: string; pid: number | null; pid_start: string | null;
}

/**
 * T699: the wake bindings behind many agents from one process snapshot (and one argv read with the batched host
 * classifier), for the liveness surfaces. This is the same evidence `pollerWakeTargets` uses, without its run
 * closures: display never takes mail or leases. A standalone poller registration is per-process, so a caller
 * outside the daemon sees the binding (`kind`, `wakeable: false`) but cannot claim the wake path.
 */
export function wakeBindingsByAgent(
  sessionsByAgent: ReadonlyMap<string, readonly WakeRow[]>,
  host: Hosts = opencodeHostClassifier(),
  waiting: (sessionID: string, pid: number) => boolean = opencodeWakeWaiting,
): Map<string, WakeBinding> {
  return withProcSnapshot(() => {
    const out = new Map<string, WakeBinding>();
    for (const [agent, sessions] of sessionsByAgent) {
      let best: WakeBinding | null = null;
      for (const s of sessions) {
        if (s.agent !== agent || s.cli !== "opencode" || !s.pid || s.pid <= 1 || s.session_id.startsWith("mcp-")) continue;
        // The recorded birth must still be that process: a reused pid must not inherit a row it never wrote.
        if (!provenProcess(s.pid, s.pid_start)) continue;
        const kind = host(s.pid);
        if (kind !== "service" && kind !== "standalone") continue;
        const polling = kind === "standalone" && waiting(s.session_id, s.pid);
        const candidate: WakeBinding = kind === "service"
          ? { cli: s.cli, session_id: s.session_id, pid: s.pid, kind, wakeable: true, via: "service" }
          : { cli: s.cli, session_id: s.session_id, pid: s.pid, kind, wakeable: polling, via: polling ? "standalone-poller" : null };
        // A service binding hosts every session of the service; prefer it over a standalone row of the same agent.
        if (!best || candidate.kind === "service" || (candidate.wakeable && !best.wakeable)) best = candidate;
        if (best.kind === "service") break;
      }
      if (best) out.set(agent, best);
    }
    return out;
  });
}

/**
 * Poller targets for `agent`: bound standalone OpenCode sessions whose MCP is gone but whose plugin still polls, and (T688)
 * bound sessions of the shared service, which still hosts them.
 * Only exact rows of this agent count, and only when no lease-based holder exists for it (the caller decides that).
 * A lease that is still current for a DIFFERENT session (the agent moved, or a sibling holds it) excludes every
 * target: that stale row must not be woken for a mailbox it can no longer claim (T659 review).
 */
export function pollerWakeTargets(node: MbxNode, agent: string, sessions: readonly WakeSession[], host?: Hosts): PollerTarget[] {
  const lease = node.store.db.prepare("SELECT session_id FROM identity_leases WHERE name=? AND released_at IS NULL").get(agent) as { session_id: string } | undefined;
  return withProcSnapshot(() => sessions
    .filter(s => s.agent === agent && (pollerTargetLive(node, s, host) || serviceBindingLive(node, s, host)) && (!lease || lease.session_id === s.session_id))
    .map(session => ({
      session,
      run: <T>(operation: () => T, readOnly = true): T => withProcSnapshot(() => {
        if (!serveBindingLive(node, session, host) && !serviceBindingLive(node, session, host)) throw refused();
        // No lease to hold: a write commits in its own store transaction, and the binding is re-proved inside it.
        return readOnly ? operation() : node.store.tx(operation);
      }),
    })));
}
