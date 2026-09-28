// A signed, single-use owner approval for one exact local identity handoff.
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { canonical, fingerprint, sha256, verifyData } from "./crypto.js";
import { NAME_RE } from "./envelope.js";
const label = z.string().min(1).max(300).regex(/^[^\p{Cc}\p{Cf}\u2028\u2029]+$/u), fp = z.string().regex(/^[a-f0-9]{4}(?:-[a-f0-9]{4}){3}$/), hash = z.string().regex(/^[a-f0-9]{64}$/);
const previousSchema = z.object({ generation: hash, cli: label, session_id: label, key_fp: fp,
    pid: z.number().int().positive(), start: label }).strict();
export const identityTakeoverPayloadSchema = z.object({ v: z.literal(1), type: z.literal("identity-takeover"), id: z.string().uuid(),
    owner_fp: fp, host: label, host_fp: fp, name: z.string().regex(NAME_RE), previous: previousSchema,
    claimant_hash: hash, claimant_cli: label, claimant_session: label, claimant_lease_session: label, claimant_key: fp,
    issued_at: z.number().int().nonnegative(), expires_at: z.number().int().nonnegative() }).strict();
export const identityTakeoverApprovalSchema = z.object({ payload: identityTakeoverPayloadSchema, sig: z.string().min(1).max(200) }).strict();
const refused = (message) => Object.assign(new Error(message), { code: "IDENTITY_TAKEOVER_REFUSED" });
const previousHolder = (row) => ({ generation: sha256(row.token), cli: row.cli, session_id: row.session_id,
    key_fp: row.key_fp, pid: row.holder_pid, start: row.holder_start });
const lease = (node, name) => node.store.db.prepare("SELECT * FROM identity_leases WHERE name=?").get(name);
export function buildIdentityTakeover(node, claimant, name) {
    const owner = node.ownerPub;
    if (!owner)
        throw refused("identity takeover requires a local owner key");
    if (claimant.generation !== null)
        throw refused("release the destination session's current identity before takeover");
    const row = lease(node, name);
    if (!row || row.released_at !== null)
        throw refused("identity has no occupied lease; use identity claim");
    if (node.store.get(`identity-conflict:${name}`))
        throw refused("unresolved historical ownership requires separate recovery");
    const now = Date.now();
    return identityTakeoverPayloadSchema.parse({ v: 1, type: "identity-takeover", id: randomUUID(), owner_fp: fingerprint(owner),
        host: node.host, host_fp: fingerprint(node.key.publicKey), name, previous: previousHolder(row),
        claimant_hash: sha256(canonical(claimant)), claimant_cli: claimant.cli, claimant_session: claimant.session_id, claimant_lease_session: claimant.lease_session_id, claimant_key: claimant.control_key,
        issued_at: now, expires_at: now + 5 * 60_000 });
}
/** Caller prepares claimant process evidence first. Release, replacement, audit and nonce commit together. */
export function applyIdentityTakeover(node, leases, approval, claimant, operation) {
    if (operation.constructor.name === "AsyncFunction")
        throw refused("takeover operations must be synchronous");
    const { payload, sig } = identityTakeoverApprovalSchema.parse(approval);
    return node.store.tx(() => {
        const owner = node.ownerPub, now = Date.now();
        if (!owner || fingerprint(owner) !== payload.owner_fp || !verifyData(owner, canonical(payload), sig))
            throw refused("invalid owner takeover signature");
        if (payload.issued_at > now || payload.expires_at <= now || payload.expires_at - payload.issued_at > 5 * 60_000)
            throw refused("owner takeover approval expired or has an invalid deadline");
        if (payload.host !== node.host || payload.host_fp !== fingerprint(node.key.publicKey))
            throw refused("owner takeover approval names another host");
        if (claimant.generation !== null || sha256(canonical(claimant)) !== payload.claimant_hash
            || claimant.cli !== payload.claimant_cli || claimant.session_id !== payload.claimant_session || claimant.lease_session_id !== payload.claimant_lease_session || claimant.control_key !== payload.claimant_key)
            throw refused("owner takeover destination changed");
        const used = `identity-takeover-used:${payload.id}`;
        if (node.store.get(used))
            throw refused("owner takeover approval was already used");
        if (node.store.get(`identity-conflict:${payload.name}`))
            throw refused("unresolved historical ownership requires separate recovery");
        const row = lease(node, payload.name);
        if (!row || row.released_at !== null || canonical(previousHolder(row)) !== canonical(payload.previous))
            throw refused("displaced identity generation changed after approval");
        if (!leases.release(payload.name, row.token))
            throw refused("displaced identity could not be released");
        // Retire only bindings belonging to the displaced key. Aliases may use a hook ID
        // distinct from the lease's canonical MCP session ID, so match by key as well.
        const displaced = node.store.db.prepare("SELECT cli,session_id,session_key FROM sessions WHERE agent=? AND cli=? AND session_key IS NOT NULL")
            .all(payload.name, payload.previous.cli);
        const removed = displaced.filter(s => fingerprint(s.session_key) === payload.previous.key_fp);
        for (const binding of removed) {
            node.store.db.prepare("DELETE FROM sessions WHERE cli=? AND session_id=? AND session_key=?").run(binding.cli, binding.session_id, binding.session_key);
            node.store.db.prepare("DELETE FROM kv WHERE k=? AND v=?").run(`name:${binding.cli}:${binding.session_id}`, payload.name);
            node.store.db.prepare("DELETE FROM kv WHERE k=?").run(`mcp-process:${binding.session_key}`);
        }
        node.store.db.prepare("DELETE FROM kv WHERE k=? AND v=?").run(`name:${payload.previous.cli}:${payload.previous.session_id}`, payload.name);
        const result = operation();
        if (result && typeof result.then === "function") {
            void Promise.resolve(result).catch(() => { });
            throw refused("takeover operations must be synchronous");
        }
        const replacement = lease(node, payload.name);
        if (!replacement || replacement.released_at !== null || replacement.token === row.token || replacement.key_fp !== claimant.control_key
            || replacement.holder_pid !== claimant.mcp_pid || replacement.holder_start !== claimant.mcp_start || replacement.cli !== claimant.cli || replacement.session_id !== claimant.lease_session_id)
            throw refused("takeover did not install the approved destination holder");
        node.store.set(used, JSON.stringify({ approval, completed_at: now }));
        node.store.audit("identity.takeover", { approval, removedBindings: removed.map(s => ({ cli: s.cli, session_id: s.session_id })), at: now });
        return result;
    });
}
