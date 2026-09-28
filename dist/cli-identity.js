// CLI ownership comes from the provider's exact current MCP lease, never from --as alone.
import { canonical } from "./crypto.js";
import { findIdentityControl, identityControlKey, identityGeneration, inspectIdentityControlCaller, listIdentityControls } from "./identity-control.js";
import { IdentityLeases, inspectLeaseProcess } from "./identity-leases.js";
import { kimiInstances } from "./kimi-web.js";
const refused = (message) => Object.assign(new Error(message), { code: "IDENTITY_LEASE_REQUIRED" });
const rowFor = (node, name) => node.store.db.prepare("SELECT * FROM identity_leases WHERE name=?").get(name);
const matches = (d, row) => !!row && row.released_at === null
    && identityGeneration(row.token) === d.generation && row.key_fp === d.control_key && row.cli === d.cli
    && row.session_id === d.lease_session_id && row.holder_pid === d.mcp_pid && row.holder_start === d.mcp_start;
/** Proof collection happens outside SQLite; authorization and operation share the lease transaction. */
export function withCliIdentity(node, selection, operation) {
    if (operation.constructor.name === "AsyncFunction")
        throw refused("mailbox operations must be synchronous");
    if (!!selection.cli !== !!selection.session)
        throw refused("select both --cli and --session, or neither");
    const descriptors = selection.cli && selection.session ? [findIdentityControl(node.store, selection.cli, selection.session)] : listIdentityControls(node.store);
    return withIdentity(node, selection, descriptors, operation);
}
/** Hook bootstrap is limited to a unique provisional single-session provider, never hosted thread guesses. */
export function withHookIdentity(node, cli, session, operation, allowBootstrap = false) {
    if (operation.constructor.name === "AsyncFunction")
        throw refused("hook operations must be synchronous");
    if (!session)
        throw refused("hook requires an explicit session id");
    const all = listIdentityControls(node.store).filter(d => d.cli === cli && d.parent_pid === process.ppid);
    let descriptors, bootstrap = false;
    if (node.store.get(identityControlKey(cli, session)) !== undefined)
        descriptors = [findIdentityControl(node.store, cli, session)];
    else {
        // Hosted providers must first publish an exact session binding. Never bootstrap by directory.
        if (!allowBootstrap || !["claude", "kimi"].includes(cli) || (cli === "kimi" && kimiInstances().some(instance => instance.pid === process.ppid)) || new Set(all.map(d => d.control_key)).size !== 1
            || all.some(d => !d.session_id.startsWith("mcp-") || !d.lease_session_id.startsWith("mcp-")))
            throw refused("hook session has no exact current MCP binding");
        descriptors = all;
        bootstrap = true;
    }
    if (descriptors.some(d => d.parent_pid !== process.ppid))
        throw refused("hook does not belong to this provider process");
    return withIdentity(node, {}, descriptors, (agent, descriptor) => {
        if (bootstrap && canonical(listIdentityControls(node.store).filter(d => d.cli === cli && d.parent_pid === process.ppid)) !== canonical(all))
            throw refused("hook bootstrap bindings changed before the operation");
        return operation(agent, descriptor);
    });
}
function withIdentity(node, selection, descriptors, operation) {
    if (operation.constructor.name === "AsyncFunction")
        throw refused("mailbox operations must be synchronous");
    const requester = inspectLeaseProcess(process.pid);
    if (requester.alive !== true || !requester.start)
        throw refused("cannot verify the calling process");
    const candidates = new Map();
    for (const descriptor of descriptors) {
        const row = rowFor(node, descriptor.agent);
        if (!matches(descriptor, row))
            continue;
        const proof = inspectIdentityControlCaller(descriptor, process.pid, requester.start);
        if (proof.valid)
            candidates.set(descriptor.control_key, { descriptor, token: row.token, proof });
    }
    // --as must not pick a different hosted session merely because it shares a provider parent.
    if (candidates.size !== 1)
        throw Object.assign(refused(candidates.size ? "ambiguous provider sessions: specify --cli and --session" : "no current identity lease belongs to this caller; claim through the provider session first"), { code: candidates.size ? "IDENTITY_LEASE_REQUIRED" : "IDENTITY_NO_CALLER_LEASE" });
    const { descriptor, token, proof } = [...candidates.values()][0];
    const [name, host, extra] = selection.as?.split("@") ?? [descriptor.agent];
    if (name !== descriptor.agent || (host !== undefined && host !== node.host) || extra !== undefined)
        throw refused(`this session holds ${descriptor.agent}@${node.host}, not the requested identity`);
    const leases = new IdentityLeases(node.store);
    return leases.prepare([descriptor.agent], [descriptor.mcp_pid], () => {
        const guarded = () => {
            if (!proof.valid || performance.now() - proof.at > 5000)
                throw refused("caller process evidence became stale; retry after inspection");
            if (canonical(findIdentityControl(node.store, descriptor.cli, descriptor.session_id)) !== canonical(descriptor)
                || !matches(descriptor, rowFor(node, descriptor.agent)))
                throw refused("identity binding changed before the operation");
            return operation(descriptor.agent, descriptor);
        };
        return selection.readOnly ? leases.withHeldRead(descriptor.agent, token, guarded) : leases.withHeld(descriptor.agent, token, guarded);
    });
}
