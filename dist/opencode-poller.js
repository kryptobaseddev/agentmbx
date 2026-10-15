// T659: OpenCode evicts an idle session's MCP about hourly (upstream; doctor explains the signature under T450),
// which releases the mailbox lease. A wake target usually needs a live lease holder (captureWakeIdentity), so in
// that window mail could only be noticed on the desktop. The serve itself is still there, and the plugin inside it
// long-polls the daemon's loopback wake queue for exactly this session: that poller is the target.
//
// Authority is the bound session row plus the poller, not a lease: the row must still name this agent, this session
// id and this serve pid with the birth the row recorded, the serve must be a standalone one (`serve --stdio`, never
// the shared service), and the poller must be registered for that same (session, pid) right now. Registration is
// live evidence: the daemon drops the slot when the serving process's request closes. Nothing here reads or changes
// mail: a wake carries ids only, and the session claims its identity again on the turn the wake starts.
import { provenProcess, withProcSnapshot } from "./proc.js";
import { opencodeHostOf } from "./opencode-provider.js";
import { opencodeWakeWaiting } from "./opencode-wake-queue.js";
const refused = () => Object.assign(new Error("opencode serve poller or session binding changed"), { code: "WAKE_IDENTITY_LOST" });
const binding = (s) => JSON.stringify([s.agent, s.cli, s.session_id, s.pid, s.pid_start, s.session_key, s.channel]);
/** The current row for this exact (cli, session) when it still names this agent and process. */
function currentRow(node, session) {
    const row = node.store.db.prepare("SELECT * FROM sessions WHERE cli=? AND session_id=?").get(session.cli, session.session_id);
    return row && row.agent === session.agent && binding(row) === binding(session) ? row : undefined;
}
/** True while this row still names a live standalone serve for this exact session, whatever it is polling. */
export function serveBindingLive(node, session, host = opencodeHostOf) {
    if (session.cli !== "opencode" || !session.pid || session.session_id.startsWith("mcp-"))
        return false;
    if (!isStandalone(host(session.pid), session.pid))
        return false;
    // The recorded birth must still be that process: a reused pid must not inherit a row it never wrote.
    if (!provenProcess(session.pid, session.pid_start))
        return false;
    return !!currentRow(node, session);
}
/**
 * True while this row names a live standalone serve that is polling the wake queue for this exact session. Selection
 * needs the registration (it is the live evidence that the serve can take a wake); re-verification of a handoff must
 * not, because a successful handoff consumes the slot before its result is settled.
 */
export function pollerTargetLive(node, session, host = opencodeHostOf) {
    return serveBindingLive(node, session, host) && opencodeWakeWaiting(session.session_id, session.pid);
}
/** T659: `opencode serve --stdio` is standalone; the shared service (`serve --service`) is never a target. */
const isStandalone = (kind, pid) => kind === "standalone" && pid > 1;
/**
 * Poller targets for `agent`: bound standalone OpenCode sessions whose MCP is gone but whose plugin still polls.
 * Only exact rows of this agent count, and only when no lease-based holder exists for it (the caller decides that).
 * A lease that is still current for a DIFFERENT session (the agent moved, or a sibling holds it) excludes every
 * target: that stale row must not be woken for a mailbox it can no longer claim (T659 review).
 */
export function pollerWakeTargets(node, agent, sessions, host) {
    const lease = node.store.db.prepare("SELECT session_id FROM identity_leases WHERE name=? AND released_at IS NULL").get(agent);
    return withProcSnapshot(() => sessions
        .filter(s => s.agent === agent && pollerTargetLive(node, s, host) && (!lease || lease.session_id === s.session_id))
        .map(session => ({
        session,
        run: (operation, readOnly = true) => withProcSnapshot(() => {
            if (!serveBindingLive(node, session, host))
                throw refused();
            // No lease to hold: a write commits in its own store transaction, and the binding is re-proved inside it.
            return readOnly ? operation() : node.store.tx(operation);
        }),
    })));
}
