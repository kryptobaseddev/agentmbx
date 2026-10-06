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
export const providerRecordKey = (mcpPid) => `mcp-provider:${mcpPid}`;
/** A kv value is a provider record only when both fields are present and bounded. Anything else is "no record". */
export function parseProviderRecord(raw) {
    if (!raw)
        return null;
    try {
        const parsed = JSON.parse(raw);
        const pid = parsed.providerPid, start = parsed.providerStart;
        if (typeof pid !== "number" || !Number.isSafeInteger(pid) || pid <= 0)
            return null;
        if (typeof start !== "string" || start.length === 0 || start.length > 300)
            return null;
        return { pid, start, ...(parsed.harness === true ? { harness: true } : {}) };
    }
    catch {
        return null;
    }
}
export function recordedProviderVerdict(table, recorded, evidence) {
    // Death is decided before the table: a dead pid is absent from it, and must not fall through to a live ancestor (T317).
    if (evidence.alive === false)
        return "dead";
    if (evidence.alive !== true || evidence.start === null)
        return "unknown";
    if (evidence.start !== recorded.start)
        return "reused";
    if (!table.has(recorded.pid))
        return "unknown";
    return "valid";
}
/**
 * The provider process a lease holder serves under. A valid or dead recorded provider wins over the ancestry walk: a
 * reparented server must not look like it moved to launchd, and a reused pid must not be trusted. With no usable record,
 * the answer is the holder's parent, or `callerProvider` when that process is anywhere in the holder's ancestry (a
 * reloaded server is the child of the server it replaced). Null when the holder is not in `table`.
 */
export function holderProviderPid(table, holderPid, callerProvider, recorded, evidence) {
    if (recorded && evidence) {
        const verdict = recordedProviderVerdict(table, recorded, evidence);
        if (verdict === "valid" || verdict === "dead")
            return recorded.pid;
    }
    const parent = table.get(holderPid)?.ppid;
    if (!parent)
        return null;
    for (let p = parent, n = 0; p && p > 1 && n < 16; p = table.get(p)?.ppid, n++)
        if (p === callerProvider)
            return p;
    return parent;
}
/**
 * The same provider answer for list and claim. A dead record reports that pid with `holderProviderAlive: false` so the
 * caller does not walk up to a live ancestor. A reused or missing record uses the ancestry walk, and a live ancestor is
 * then alive.
 */
export function holderProviderView(table, holderPid, callerProvider, recorded, evidence, canonicalHarness = false) {
    const verdict = recorded && evidence ? recordedProviderVerdict(table, recorded, evidence) : null;
    // A proven harness caller may normalize an older connector's runtime provider record.
    if (canonicalHarness && verdict === "valid" && recorded && callerProvider !== undefined) {
        for (let p = recorded.pid, n = 0; p > 1 && n < 16; n++) {
            if (p === callerProvider)
                return { holderProviderPid: callerProvider, holderProviderAlive: true };
            const parent = table.get(p)?.ppid;
            if (!parent)
                break;
            p = parent;
        }
    }
    const useRecord = verdict === "valid" || verdict === "dead";
    const holderProvider = holderProviderPid(table, holderPid, callerProvider, useRecord ? recorded : null, useRecord ? evidence : null);
    const holderProviderAlive = verdict === "valid" ? true : verdict === "dead" ? false : holderProvider != null ? true : null;
    return { holderProviderPid: holderProvider, holderProviderAlive };
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
        // (Codex did). T439: a server under the caller's own provider co-uses the lease. T440: a different parent is takeover
        // only when the holder's provider is confirmed dead — a shell-launched server must not evict a live one. Unknown
        // parentage never evicts a live holder and never co-uses it.
        const { providerPid, holderProviderPid: holderProvider, holderProviderAlive } = o.caller;
        if (providerPid !== undefined && holderProvider != null && holderProvider !== providerPid) {
            if (holderProviderAlive === false)
                return { claimable: true, state: "live", reason: `held by an older process of this same ${lease.cli} session`, takeover: "same-session" };
            if (holderProviderAlive === true)
                return { claimable: false, state: "live", reason: `held by the live MCP server of this same ${lease.cli} session (pid ${lease.holder_pid}); its provider process is still running` };
        }
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
