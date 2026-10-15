// Daemon routing authority is an exact captured lease generation, never a remembered hook name.
import { canonical, fingerprint } from "./crypto.js";
import { findIdentityControl, identityGeneration } from "./identity-control.js";
import { IdentityLeases, inspectLeaseProcesses } from "./identity-leases.js";
import { procTable, residentStartOf, withProcSnapshot } from "./proc.js";
const refused = () => Object.assign(new Error("wake identity lease or binding changed"), { code: "WAKE_IDENTITY_LOST" });
const binding = (s) => canonical([s.agent, s.cli, s.session_id, s.pid, s.pid_start, s.session_key, s.channel]);
const leaseOf = (node, agent) => node.store.db.prepare("SELECT * FROM identity_leases WHERE name=?").get(agent);
const HOLDER_HOPS = 4;
/**
 * T646: the control descriptor a former holder published, still alive under another serve (the shared OpenCode
 * service after a same-session takeover), is never replaced by the new holder (T436), so the wake authority is
 * rebuilt from the current lease and the session row that holder wrote. Only for a descriptor of a different key
 * AND a different lease generation: a defect in the current holder's own descriptor still refuses.
 */
function holderAuthority(node, session, row, published) {
    const generation = identityGeneration(row.token);
    if (published.control_key === row.key_fp || published.generation === generation)
        return null;
    if (!session.pid || !session.pid_start || !session.session_key || row.cli !== session.cli || row.session_id !== session.session_id
        || fingerprint(session.session_key) !== row.key_fp || !row.holder_pid || !row.holder_start)
        return null;
    const table = procTable();
    let ancestor = table.get(row.holder_pid)?.ppid;
    for (let hop = 1; ancestor && ancestor !== session.pid && hop < HOLDER_HOPS; hop++)
        ancestor = table.get(ancestor)?.ppid;
    if (ancestor !== session.pid || !node.sameSession(session.pid, session, { proof: true }))
        return null;
    const parent = inspectLeaseProcesses([session.pid]).get(session.pid);
    if (parent?.alive !== true || !parent.start)
        return null;
    return { v: 1, cli: session.cli, session_id: session.session_id, lease_session_id: row.session_id, control_key: row.key_fp,
        mcp_pid: row.holder_pid, mcp_start: row.holder_start, parent_pid: session.pid, parent_start: parent.start, agent: session.agent, generation };
}
/** The exact holder's control for this session: its own published descriptor, or (T646) one rebuilt from its lease. */
function wakeAuthority(node, session) {
    const published = findIdentityControl(node.store, session.cli, session.session_id);
    const row = leaseOf(node, session.agent);
    if (!row || !session.pid || !session.session_key || row.released_at !== null)
        return null;
    const descriptor = published.agent === session.agent && published.control_key === row.key_fp ? published : holderAuthority(node, session, row, published);
    if (!descriptor || descriptor.agent !== session.agent || descriptor.parent_pid !== session.pid
        || descriptor.control_key !== fingerprint(session.session_key) || descriptor.control_key !== row.key_fp
        || descriptor.generation !== identityGeneration(row.token) || descriptor.cli !== row.cli
        || descriptor.lease_session_id !== row.session_id || descriptor.mcp_pid !== row.holder_pid || descriptor.mcp_start !== row.holder_start)
        return null;
    return descriptor;
}
/** Capture once, then recheck before adapter submission and after asynchronous work. Never follows a successor. */
export function captureWakeIdentity(node, session) {
    try {
        const descriptor = wakeAuthority(node, session);
        const row = leaseOf(node, session.agent);
        if (!descriptor || !row)
            return null;
        const leases = new IdentityLeases(node.store), token = row.token, expected = canonical(descriptor), expectedBinding = binding(session);
        const run = (operation, readOnly = true) => {
            if (operation.constructor.name === "AsyncFunction")
                throw refused();
            return withProcSnapshot(() => {
                // sameSession below runs inside the lease write. Read the table before either lock when this
                // process or its parent is not already remembered (T591). A remembered birth does not spawn.
                if (residentStartOf(descriptor.parent_pid) == null || residentStartOf(descriptor.mcp_pid) == null)
                    procTable();
                const evidence = inspectLeaseProcesses([descriptor.parent_pid, descriptor.mcp_pid]);
                const parent = evidence.get(descriptor.parent_pid) ?? { alive: null, start: null }, child = evidence.get(descriptor.mcp_pid) ?? { alive: null, start: null };
                // Freshness is measured from after the evidence was taken; slow collection under load must not fence a valid wake.
                const at = performance.now();
                if (parent.alive !== true || parent.start !== descriptor.parent_start || child.alive !== true || child.start !== descriptor.mcp_start)
                    throw refused();
                return leases.prepare([session.agent], [descriptor.mcp_pid], () => {
                    const operationWithBinding = () => {
                        const current = node.store.db.prepare("SELECT * FROM sessions WHERE cli=? AND session_id=?").get(session.cli, session.session_id);
                        if (performance.now() - at > 5000 || canonical(wakeAuthority(node, session)) !== expected
                            || !current || binding(current) !== expectedBinding || !current.pid || !node.sameSession(current.pid, current, { proof: true }))
                            throw refused();
                        return operation();
                    };
                    return readOnly ? leases.withHeldRead(session.agent, token, operationWithBinding) : leases.withHeld(session.agent, token, operationWithBinding);
                });
            });
        };
        run(() => undefined);
        return { session, run };
    }
    catch {
        return null;
    }
}
