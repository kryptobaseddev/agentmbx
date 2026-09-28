// A signed, single-use owner approval for one exact local identity handoff.
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { canonical, fingerprint, sha256, verifyData } from "./crypto.ts";
import { NAME_RE } from "./envelope.ts";
import type { IdentityControlDescriptor } from "./identity-control.ts";
import type { IdentityLease, IdentityLeases } from "./identity-leases.ts";
import type { MbxNode } from "./node.ts";

const label = z.string().min(1).max(300).regex(/^[^\p{Cc}\p{Cf}\u2028\u2029]+$/u), fp = z.string().regex(/^[a-f0-9]{4}(?:-[a-f0-9]{4}){3}$/), hash = z.string().regex(/^[a-f0-9]{64}$/);
const previousSchema = z.object({ generation: hash, cli: label, session_id: label, key_fp: fp,
  pid: z.number().int().positive(), start: label }).strict();
export const identityTakeoverPayloadSchema = z.object({ v: z.literal(1), type: z.literal("identity-takeover"), id: z.string().uuid(),
  owner_fp: fp, host: label, host_fp: fp, name: z.string().regex(NAME_RE), previous: previousSchema,
  claimant_hash: hash, claimant_cli: label, claimant_session: label, claimant_key: fp,
  issued_at: z.number().int().nonnegative(), expires_at: z.number().int().nonnegative() }).strict();
export const identityTakeoverApprovalSchema = z.object({ payload: identityTakeoverPayloadSchema, sig: z.string().min(1).max(200) }).strict();
export type IdentityTakeoverPayload = z.infer<typeof identityTakeoverPayloadSchema>;
export type IdentityTakeoverApproval = z.infer<typeof identityTakeoverApprovalSchema>;
const refused = (message: string) => Object.assign(new Error(message), { code: "IDENTITY_TAKEOVER_REFUSED" });
const previousHolder = (row: IdentityLease) => ({ generation: sha256(row.token), cli: row.cli, session_id: row.session_id,
  key_fp: row.key_fp, pid: row.holder_pid, start: row.holder_start });
const lease = (node: MbxNode, name: string) => node.store.db.prepare("SELECT * FROM identity_leases WHERE name=?").get(name) as unknown as IdentityLease | undefined;

export function buildIdentityTakeover(node: MbxNode, claimant: IdentityControlDescriptor, name: string): IdentityTakeoverPayload {
  const owner = node.ownerPub;
  if (!owner) throw refused("identity takeover requires a local owner key");
  if (claimant.generation !== null) throw refused("release the destination session's current identity before takeover");
  const row = lease(node, name);
  if (!row || row.released_at !== null) throw refused("identity has no occupied lease; use identity claim");
  if (node.store.get(`identity-conflict:${name}`)) throw refused("unresolved historical ownership requires separate recovery");
  const now = Date.now();
  return identityTakeoverPayloadSchema.parse({ v: 1, type: "identity-takeover", id: randomUUID(), owner_fp: fingerprint(owner),
    host: node.host, host_fp: fingerprint(node.key.publicKey), name, previous: previousHolder(row),
    claimant_hash: sha256(canonical(claimant)), claimant_cli: claimant.cli, claimant_session: claimant.session_id, claimant_key: claimant.control_key,
    issued_at: now, expires_at: now + 5 * 60_000 });
}

/** Caller prepares claimant process evidence first. Release, replacement, audit and nonce commit together. */
export function applyIdentityTakeover<T>(node: MbxNode, leases: IdentityLeases, approval: IdentityTakeoverApproval,
  claimant: IdentityControlDescriptor, operation: () => T): T {
  if (operation.constructor.name === "AsyncFunction") throw refused("takeover operations must be synchronous");
  const { payload, sig } = identityTakeoverApprovalSchema.parse(approval);
  return node.store.tx(() => {
    const owner = node.ownerPub, now = Date.now();
    if (!owner || fingerprint(owner) !== payload.owner_fp || !verifyData(owner, canonical(payload), sig)) throw refused("invalid owner takeover signature");
    if (payload.issued_at > now || payload.expires_at <= now || payload.expires_at - payload.issued_at > 5 * 60_000) throw refused("owner takeover approval expired or has an invalid deadline");
    if (payload.host !== node.host || payload.host_fp !== fingerprint(node.key.publicKey)) throw refused("owner takeover approval names another host");
    if (claimant.generation !== null || sha256(canonical(claimant)) !== payload.claimant_hash
      || claimant.cli !== payload.claimant_cli || claimant.session_id !== payload.claimant_session || claimant.control_key !== payload.claimant_key)
      throw refused("owner takeover destination changed");
    const used = `identity-takeover-used:${payload.id}`;
    if (node.store.get(used)) throw refused("owner takeover approval was already used");
    if (node.store.get(`identity-conflict:${payload.name}`)) throw refused("unresolved historical ownership requires separate recovery");
    const row = lease(node, payload.name);
    if (!row || row.released_at !== null || canonical(previousHolder(row)) !== canonical(payload.previous)) throw refused("displaced identity generation changed after approval");
    if (!leases.release(payload.name, row.token)) throw refused("displaced identity could not be released");
    const result = operation();
    if (result && typeof (result as { then?: unknown }).then === "function") { void Promise.resolve(result).catch(() => {}); throw refused("takeover operations must be synchronous"); }
    const replacement = lease(node, payload.name);
    if (!replacement || replacement.released_at !== null || replacement.token === row.token || replacement.key_fp !== claimant.control_key
      || replacement.holder_pid !== claimant.mcp_pid || replacement.holder_start !== claimant.mcp_start || replacement.cli !== claimant.cli)
      throw refused("takeover did not install the approved destination holder");
    node.store.set(used, JSON.stringify({ approval, completed_at: now }));
    node.store.audit("identity.takeover", { approval, at: now });
    return result;
  });
}
