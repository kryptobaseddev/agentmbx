// One answer to "can this identity be claimed now?", used by both mbx_identity list and the claim itself (T204, R4.3), so
// a name the list calls available is never refused by the claim for a reason the list didn't show.
import { identityLeaseStatus } from "./identity-leases.js";
/**
 * A conversation of a shared provider process (Codex or OpenCode transport, hosted Kimi) that made no mbx call and fired
 * no hook for this long can be taken over by an explicit claim: closing such a conversation does not end its process, so
 * its lease never expires on its own. A dedicated session process (Claude, terminal Kimi) is never taken over this way.
 */
export const SHARED_IDLE_MS = 10 * 60_000;
export const activityKey = (name) => `lease-activity:${name}`;
export function parseActivity(raw) {
    if (!raw)
        return null;
    try {
        const a = JSON.parse(raw);
        return Number.isSafeInteger(a?.at) && typeof a?.shared === "boolean" ? { at: a.at, shared: a.shared } : null;
    }
    catch {
        return null;
    }
}
const minutes = (ms) => `${Math.max(1, Math.round(ms / 60_000))} min`;
/**
 * The provider process a lease holder serves under: its parent, or `callerProvider` when that process is anywhere in the
 * holder's ancestry (a reloaded server is the child of the server it replaced). Null when the holder is not in `table`.
 */
export function holderProviderPid(table, holderPid, callerProvider) {
    const parent = table.get(holderPid)?.ppid;
    if (!parent)
        return null;
    for (let p = parent, n = 0; p && p > 1 && n < 16; p = table.get(p)?.ppid, n++)
        if (p === callerProvider)
            return p;
    return parent;
}
export function identityAvailability(o) {
    if (o.conflict)
        return { claimable: false, state: "conflict", reason: "historical ownership requires explicit owner recovery" };
    const lease = o.lease;
    if (!lease)
        return { claimable: true, state: "free", reason: "no session has held it under a lease" };
    const status = identityLeaseStatus(lease, o.now, o.evidence);
    if (status.state === "expired")
        return { claimable: true, state: "offline", reason: lease.released_at !== null ? lease.release_reason ?? "released" : status.reason ?? "expired" };
    const holder = `${lease.cli} session ${lease.session_id}`;
    if (status.state === "unknown")
        return { claimable: false, state: "unknown", reason: `held by ${holder}, whose process could not be verified right now; retry shortly` };
    if (o.caller && lease.cli === o.caller.cli && lease.session_id === o.caller.sessionId && !o.caller.sessionId.startsWith("mcp-")) {
        // T383: a provider may start a second, short-lived MCP server for a session whose own server is still live and serving
        // (Codex did). Only a holder under a different (restarted) provider process is "older"; a live holder under the caller's
        // own provider keeps the lease. T439: that second server co-uses it (acts as the identity under the holder's lease, never
        // taking, renewing or releasing it). Unknown parentage never evicts a live holder and never co-uses it.
        const { providerPid, holderProviderPid: holderProvider } = o.caller;
        if (providerPid !== undefined && holderProvider != null && holderProvider !== providerPid)
            return { claimable: true, state: "live", reason: `held by an older process of this same ${lease.cli} session`, takeover: "same-session" };
        if (providerPid !== undefined && holderProvider === providerPid)
            return { claimable: false, state: "live", coUse: true, reason: `held by the live MCP server of this same ${lease.cli} session (pid ${lease.holder_pid}, same provider process); `
                    + "a sibling server of this session co-uses it: it acts as that identity under the holder's lease, without taking or releasing it" };
        return { claimable: false, state: "live", reason: `held by a live process of this same ${lease.cli} session (pid ${lease.holder_pid}) whose provider process could not be verified; retry shortly` };
    }
    const quiet = o.activity ? o.now - o.activity.at : null;
    if (o.activity?.shared && quiet !== null && quiet >= SHARED_IDLE_MS)
        return { claimable: true, state: "idle", reason: `held by ${holder} in a shared ${lease.cli} process with no mbx activity for ${minutes(quiet)} (that conversation has probably ended)`, takeover: "idle-conversation" };
    return { claimable: false, state: "live", reason: `held by live ${holder}${quiet !== null ? `, last mbx activity ${minutes(quiet)} ago` : ""}` };
}
