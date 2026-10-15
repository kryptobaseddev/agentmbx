// T646: one OpenCode session loaded by two serves (a standalone tab and the shared service). The serve that holds
// the lease and session row and the serve that published the session's control endpoint differ, so wakes are
// refused or pushed into the wrong process. Doctor reports it; nothing is stopped or rewritten here.
import { listIdentityControls } from "./identity-control.js";
import { inspectLeaseProcesses } from "./identity-leases.js";
import { opencodeHostClassifier } from "./opencode-provider.js";
/** Bound sessions whose published control endpoint lives under a different live serve than the session row. */
export function findOpencodeDualHosts(node, host = opencodeHostClassifier()) {
    const rows = node.store.db.prepare("SELECT agent, session_id, pid FROM sessions WHERE cli='opencode' AND session_id NOT LIKE 'mcp-%' AND pid IS NOT NULL ORDER BY session_id")
        .all();
    if (!rows.length)
        return [];
    const published = new Map(listIdentityControls(node.store).filter(d => d.cli === "opencode").map(d => [d.session_id, d]));
    const split = rows.flatMap(r => { const d = published.get(r.session_id); return d && d.parent_pid !== r.pid ? [{ r, d }] : []; });
    if (!split.length)
        return [];
    const evidence = inspectLeaseProcesses(split.flatMap(({ r, d }) => [r.pid, d.parent_pid]));
    return split.flatMap(({ r, d }) => {
        if (evidence.get(r.pid)?.alive !== true || evidence.get(d.parent_pid)?.alive !== true || evidence.get(d.parent_pid)?.start !== d.parent_start)
            return [];
        return [{ session_id: r.session_id, agent: r.agent, bound: { pid: r.pid, host: host(r.pid) }, published: { pid: d.parent_pid, host: host(d.parent_pid) } }];
    });
}
export function opencodeDualHostChecks(node, host) {
    return findOpencodeDualHosts(node, host).map(x => ({
        level: "warn",
        label: `opencode: session ${x.session_id} (${x.agent}) is bound to the ${x.bound.host} serve pid ${x.bound.pid} but its control endpoint was published by the ${x.published.host} serve pid ${x.published.pid}; two OpenCode processes have this session loaded`,
        fix: "keep the session open in one OpenCode process only (close it in the other client); do not stop a serve based on this check alone",
    }));
}
