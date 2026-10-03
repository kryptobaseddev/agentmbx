// CLI ownership comes from the provider's exact current MCP lease, never from --as alone.
import { canonical } from "./crypto.js";
import { findIdentityControl, identityControlKey, identityGeneration, inspectIdentityControlCaller, listIdentityControls } from "./identity-control.js";
import { IdentityLeases, inspectLeaseProcess, UNKNOWN_RETRY_DELAYS_MS } from "./identity-leases.js";
import { claudeSessionId, sleepSync } from "./proc.js";
import { kimiInstances } from "./kimi-web.js";
const refused = (message) => Object.assign(new Error(message), { code: "IDENTITY_LEASE_REQUIRED" });
/** Evidence that could not be read: neither a holder nor a refusal, so the caller retries it (T340). */
const unknownEvidence = (message) => Object.assign(new Error(message), { code: "IDENTITY_STATUS_UNKNOWN" });
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
/** Hook bootstrap requires one holder; only Claude may change real session IDs within that holder. */
export function withHookIdentity(node, cli, session, operation, allowBootstrap = false) {
    if (operation.constructor.name === "AsyncFunction")
        throw refused("hook operations must be synchronous");
    if (!session || session.length > 300 || session !== session.trim() || /[\u0000-\u001f\u007f-\u009f]/u.test(session) || session.startsWith("mcp-"))
        throw refused("hook requires a valid non-provisional session id");
    const all = listIdentityControls(node.store).filter(d => d.cli === cli && d.parent_pid === process.ppid);
    let descriptors, bootstrap = false;
    const rebindClaude = allowBootstrap && cli === "claude" && !node.store.db.prepare("SELECT 1 FROM sessions WHERE cli=? AND session_id=?").get(cli, session);
    if (node.store.get(identityControlKey(cli, session)) !== undefined && !rebindClaude)
        descriptors = [findIdentityControl(node.store, cli, session)];
    else {
        // Hosted providers must first publish an exact session binding. Never bootstrap by directory.
        // Claude's /clear, /resume and compaction replace the session id of the same process, whose MCP holder carries the
        // id it started with: the provider's own session file naming exactly this session is the proof of that rotation.
        const rotated = cli === "claude" && claudeSessionId(process.ppid) === session;
        if (!allowBootstrap || !["claude", "kimi"].includes(cli) || (cli === "kimi" && kimiInstances().some(instance => instance.pid === process.ppid)) || new Set(all.map(d => d.control_key)).size !== 1
            || all.some(d => (!d.lease_session_id.startsWith("mcp-") && !rotated) || (cli !== "claude" && !d.session_id.startsWith("mcp-"))
                || !matches(d, rowFor(node, d.agent)) || canonical({ ...d, session_id: "" }) !== canonical({ ...all[0], session_id: "" })))
            throw refused("hook session has no exact current MCP binding");
        descriptors = all;
        bootstrap = true;
    }
    if (descriptors.some(d => d.parent_pid !== process.ppid))
        throw refused("hook does not belong to this provider process");
    return withIdentity(node, {}, descriptors, (agent, descriptor) => {
        if (bootstrap && canonical(listIdentityControls(node.store).filter(d => d.cli === cli && d.parent_pid === process.ppid)) !== canonical(all))
            throw refused("hook bootstrap bindings changed before the operation");
        return operation(agent, descriptor, bootstrap);
    });
}
function withIdentity(node, selection, descriptors, operation) {
    if (operation.constructor.name === "AsyncFunction")
        throw refused("mailbox operations must be synchronous");
    const leases = new IdentityLeases(node.store);
    const authorize = () => {
        // Inspected on every attempt: a ps timeout leaves this process's birth time unknown, and a retry can read it (T340).
        const requester = inspectLeaseProcess(process.pid);
        if (requester.alive === false)
            throw refused("cannot verify the calling process");
        if (requester.alive !== true || !requester.start)
            throw unknownEvidence("cannot verify the calling process: its process evidence is unavailable; retry after inspection recovers");
        const candidates = new Map();
        let unknown = 0;
        for (const descriptor of descriptors) {
            const row = rowFor(node, descriptor.agent);
            if (!matches(descriptor, row))
                continue;
            const proof = inspectIdentityControlCaller(descriptor, process.pid, requester.start);
            if (proof.state === "valid")
                candidates.set(descriptor.control_key, { descriptor, token: row.token });
            else if (proof.state === "unknown")
                unknown++;
        }
        // --as must not pick a different hosted session merely because it shares a provider parent.
        if (candidates.size > 1)
            throw refused("ambiguous provider sessions: specify --cli and --session");
        // Unknown evidence is not "no lease" (T340): it may be this caller's holder, or a second one that makes a lone
        // candidate ambiguous. Retry it; only definite refusals report at once.
        if (unknown)
            throw unknownEvidence("caller process evidence is unknown; retry after inspection recovers");
        if (!candidates.size)
            throw Object.assign(refused("no current identity lease belongs to this caller. Run mailbox commands inside the provider session that holds the lease (your agent session, through its mbx tools); inspect holders with `agentmbx identity list`. The owner can replace a live holder with `agentmbx identity takeover <name> --force --cli <provider> --session <id>`"), { code: "IDENTITY_NO_CALLER_LEASE" });
        const { descriptor, token } = [...candidates.values()][0];
        const [name, host, extra] = selection.as?.split("@") ?? [descriptor.agent];
        if (name !== descriptor.agent || (host !== undefined && host !== node.host) || extra !== undefined)
            throw refused(`this session holds ${descriptor.agent}@${node.host}, not the requested identity`);
        return { descriptor, token, start: requester.start };
    };
    // Unknown or stale caller evidence is retried with backoff; slow evidence collection must not
    // fail an otherwise-valid session (T206). A definite refusal is thrown at once, with no backoff (T340).
    for (let attempt = 0;; attempt++) {
        if (attempt)
            sleepSync(UNKNOWN_RETRY_DELAYS_MS[attempt - 1]);
        try {
            const { descriptor, token, start } = authorize();
            return leases.prepare([descriptor.agent], [descriptor.mcp_pid], () => {
                const guarded = () => {
                    // Re-collect the caller proof immediately before the operation: the freshness window then
                    // measures from evidence-taken to operation-run, excluding collection time.
                    const proof = inspectIdentityControlCaller(descriptor, process.pid, start);
                    if (proof.state === "invalid")
                        throw refused("the calling process no longer matches this session's identity holder");
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
        catch (e) {
            const retryable = e.code === "IDENTITY_STATUS_UNKNOWN"
                || /caller process evidence became stale/.test(e.message);
            if (!retryable || attempt >= UNKNOWN_RETRY_DELAYS_MS.length)
                throw e;
        }
    }
}
