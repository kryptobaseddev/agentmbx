// Daemon routing authority is an exact captured lease generation, never a remembered hook name.
import { canonical, fingerprint } from "./crypto.js";
import { findIdentityControl, identityGeneration } from "./identity-control.js";
import { IdentityLeases, inspectLeaseProcesses } from "./identity-leases.js";
import { withProcSnapshot } from "./proc.js";
const refused = () => Object.assign(new Error("wake identity lease or binding changed"), { code: "WAKE_IDENTITY_LOST" });
const binding = (s) => canonical([s.agent, s.cli, s.session_id, s.pid, s.pid_start, s.session_key, s.channel]);
/** Capture once, then recheck before adapter submission and after asynchronous work. Never follows a successor. */
export function captureWakeIdentity(node, session) {
    try {
        const descriptor = findIdentityControl(node.store, session.cli, session.session_id);
        const row = node.store.db.prepare("SELECT * FROM identity_leases WHERE name=?").get(session.agent);
        if (!row || !session.pid || !session.session_key || row.released_at !== null
            || descriptor.agent !== session.agent || descriptor.parent_pid !== session.pid
            || descriptor.control_key !== fingerprint(session.session_key) || descriptor.control_key !== row.key_fp
            || descriptor.generation !== identityGeneration(row.token) || descriptor.cli !== row.cli
            || descriptor.lease_session_id !== row.session_id || descriptor.mcp_pid !== row.holder_pid || descriptor.mcp_start !== row.holder_start)
            return null;
        const leases = new IdentityLeases(node.store), token = row.token, expected = canonical(descriptor), expectedBinding = binding(session);
        const run = (operation, readOnly = true) => {
            if (operation.constructor.name === "AsyncFunction")
                throw refused();
            return withProcSnapshot(() => {
                const evidence = inspectLeaseProcesses([descriptor.parent_pid, descriptor.mcp_pid]);
                const parent = evidence.get(descriptor.parent_pid) ?? { alive: null, start: null }, child = evidence.get(descriptor.mcp_pid) ?? { alive: null, start: null };
                // Freshness is measured from after the evidence was taken; slow collection under load must not fence a valid wake.
                const at = performance.now();
                if (parent.alive !== true || parent.start !== descriptor.parent_start || child.alive !== true || child.start !== descriptor.mcp_start)
                    throw refused();
                return leases.prepare([session.agent], [descriptor.mcp_pid], () => {
                    const operationWithBinding = () => {
                        const current = node.store.db.prepare("SELECT * FROM sessions WHERE cli=? AND session_id=?").get(session.cli, session.session_id);
                        if (performance.now() - at > 5000 || canonical(findIdentityControl(node.store, session.cli, session.session_id)) !== expected
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
