// Owner-signed project lead records (T208) and the `lead` / `role:lead` address (T393).
// Kept off the receipts graph: node.send resolves the address while node.ts is still initializing,
// and receipts reads DID_MAX from node at module scope.
import { z } from "zod";
import { canonical, fingerprint, ulid, verifyData } from "./crypto.js";
import { ownerKeys } from "./policy.js";
import { resolveProject } from "./project-key.js";
import { identityProjects } from "./registry.js";
export const LEAD_DEFAULT_TTL_MS = 30 * 86_400_000;
export const LEAD_MAX_TTL_MS = 180 * 86_400_000;
const LeadRecord = z.object({
    v: z.literal(1), type: z.literal("lead"), id: z.string().min(10).max(40), project: z.string().min(1).max(1024),
    agent: z.string().regex(/^[a-z0-9][a-z0-9-]{1,39}$/), host: z.string().min(1).max(40), iat: z.string().datetime(), exp: z.string().datetime(),
    owner_fp: z.string().min(4).max(64),
}).strict();
const LeadRevocation = z.object({
    v: z.literal(1), type: z.literal("lead-revoke"), id: z.string().min(10).max(40), target: z.string().min(10).max(40),
    iat: z.string().datetime(), owner_fp: z.string().min(4).max(64),
}).strict();
const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };
export function makeLead(o) {
    const now = o.now ?? new Date(), ttl = o.ttlMs ?? LEAD_DEFAULT_TTL_MS;
    if (!(ttl > 0) || ttl > LEAD_MAX_TTL_MS)
        fail("LEAD_TTL", "lead TTL must be between 1 s and 180 days");
    return LeadRecord.parse({ v: 1, type: "lead", id: ulid(now.getTime()), project: o.project, agent: o.agent, host: o.host,
        iat: now.toISOString(), exp: new Date(now.getTime() + ttl).toISOString(), owner_fp: fingerprint(o.ownerPub) });
}
export function makeLeadRevocation(target, ownerPub, now = new Date()) {
    return LeadRevocation.parse({ v: 1, type: "lead-revoke", id: ulid(now.getTime()), target, iat: now.toISOString(), owner_fp: fingerprint(ownerPub) });
}
export const leadSummary = (r) => `Make ${r.agent}@${r.host} the lead of project ${r.project} until ${r.exp}: it can read every message of that project and forward them.`;
/** Owner keys this host trusts: its own, plus adopted owners (paired-device principals). */
const trustedOwners = (node) => [...new Set([...(node.ownerPub ? [node.ownerPub] : []), ...ownerKeys(node.store.db)])];
function signedBy(node, rec, sig, owner_fp) {
    const pub = trustedOwners(node).find((k) => fingerprint(k) === owner_fp);
    return !!pub && verifyData(pub, canonical(rec), sig);
}
/** Store a signed lead record (verified here and again on every read). Later records for the same project supersede. */
export function storeLead(node, rec, sig) {
    const r = LeadRecord.safeParse(rec);
    if (!r.success)
        fail("LEAD_INVALID", `invalid lead record: ${r.error.issues[0]?.message ?? "shape"}`);
    if (!signedBy(node, r.data, sig, r.data.owner_fp))
        fail("LEAD_SIGNATURE", "lead record is not signed by an owner key this host trusts");
    // project_key is derived here from the signed folder and is never part of what the owner signed (T543); NULL without a CLEO id.
    node.store.db.prepare("INSERT OR IGNORE INTO project_leads (id,project,agent,record,sig,received_at,project_key) VALUES (?,?,?,?,?,?,?)")
        .run(r.data.id, r.data.project, r.data.agent, JSON.stringify(r.data), sig, new Date().toISOString(), resolveProject(r.data.project).cleoId);
    node.store.audit("lead.set", { id: r.data.id, project: r.data.project, agent: `${r.data.agent}@${r.data.host}`, exp: r.data.exp });
    return r.data;
}
/** Revoke a stored lead record with a signed revocation. */
export function revokeLead(node, rev, sig) {
    const r = LeadRevocation.safeParse(rev);
    if (!r.success)
        fail("LEAD_INVALID", "invalid lead revocation");
    if (!signedBy(node, r.data, sig, r.data.owner_fp))
        fail("LEAD_SIGNATURE", "lead revocation is not signed by an owner key this host trusts");
    const n = node.store.db.prepare("UPDATE project_leads SET revocation=?, revocation_sig=? WHERE id=? AND revocation IS NULL").run(JSON.stringify(r.data), sig, r.data.target).changes;
    if (!n)
        fail("LEAD_NOT_FOUND", `no active lead record ${r.data.target}`);
    node.store.audit("lead.revoke", { id: r.data.target, revocation: r.data.id });
    return r.data;
}
/** The current lead of `project`, re-verified now: newest valid, unexpired, unrevoked record wins. A record belongs to the
 *  folder it was signed for, or to any other checkout of the same CLEO project (T543: the stored key matches). The owner's
 *  signature is checked exactly as before; the key only decides which signed records are candidates for this project. */
export function activeLead(node, project, now = new Date()) {
    return leadFor(node, project, resolveProject(project).key, now);
}
function leadFor(node, project, key, now) {
    const rows = node.store.db.prepare("SELECT record,sig,revocation,revocation_sig,project_key FROM project_leads WHERE project=? OR project_key=? ORDER BY id DESC").all(project, key);
    for (const row of rows) {
        let rec;
        try {
            const p = LeadRecord.safeParse(JSON.parse(row.record));
            if (!p.success)
                continue;
            rec = p.data;
        }
        catch {
            continue;
        }
        if ((rec.project !== project && !(row.project_key !== null && row.project_key === key)) || !signedBy(node, rec, row.sig, rec.owner_fp))
            continue;
        if (row.revocation && row.revocation_sig) {
            try {
                const rv = LeadRevocation.safeParse(JSON.parse(row.revocation));
                if (rv.success && rv.data.target === rec.id && signedBy(node, rv.data, row.revocation_sig, rv.data.owner_fp))
                    continue; // revoked
            }
            catch { /* a malformed revocation takes nothing away */ }
        }
        if (Date.parse(rec.exp) <= now.getTime())
            continue;
        return rec;
    }
    return null;
}
/** Every project's current lead, each re-verified now like `activeLead` (T496). A project whose records are all
 *  expired, revoked or not signed by a trusted owner key has no entry. One entry per project, however many checkouts have
 *  records (T543). Ordered by project folder. */
export function activeLeads(node, now = new Date()) {
    const out = [];
    for (const g of node.store.db.prepare("SELECT COALESCE(project_key, project) AS k, MIN(project) AS project FROM project_leads GROUP BY COALESCE(project_key, project) ORDER BY MIN(project)").all()) {
        const lead = leadFor(node, g.project, g.k, now);
        if (lead)
            out.push(lead);
    }
    return out;
}
export const isLead = (node, agent, project) => !!project && ((l) => !!l && l.agent === agent && l.host === node.host)(activeLead(node, project));
/** What `agentmbx status` and `agentmbx whoami` show for the owner-designated lead. */
export function projectLeadView(node, project, now = new Date()) {
    if (!project)
        return { project: null, address: null, exp: null };
    const lead = activeLead(node, project, now);
    if (!lead)
        return { project, address: null, exp: null };
    return { project, address: `${lead.agent}@${lead.host}`, exp: lead.exp };
}
export function projectLeadLine(view) {
    if (!view.project)
        return "lead: no project";
    if (!view.address || !view.exp)
        return "lead: none";
    return `lead: ${view.address} until ${view.exp}`;
}
const leadToken = (to) => to === "lead" || to === "role:lead";
/** Expand `lead` and `role:lead` to the owner-designated lead before the envelope is signed.
 *  Any other role stays a fan-out. Both tokens are one address and are de-duplicated. A prebuilt
 *  envelope is not passed here: its signature already commits to `to`. Holder liveness is NOT
 *  consulted here (that graph belongs to receipts); the returned leadAddress lets the caller mark
 *  the resolved targets for the send-time receipt check. */
export function resolveLeadRecipients(node, fromName, to, project) {
    if (!to.some(leadToken))
        return { to, leadAddress: null };
    const folder = project || identityProjects(node.store, fromName)[0];
    if (!folder)
        fail("NO_PROJECT", "no project for this sender: lead and role:lead need the sender's project");
    const lead = activeLead(node, folder) ?? fail("NO_LEAD", "no owner-designated lead is set for this sender's project");
    // Copy before the peer callback: a closure drops the null narrowing on `lead`.
    const { agent, host } = lead;
    const approved = node.peers().some((p) => p.state === "approved" && p.host === host);
    if (host !== node.host && !approved)
        fail("NO_LEAD", `no owner-designated lead is reachable at ${agent}@${host}`);
    const address = host === node.host ? agent : `${agent}@${host}`;
    const out = [];
    for (const token of to) {
        const next = leadToken(token) ? address : token;
        if (!out.includes(next))
            out.push(next);
    }
    return { to: out, leadAddress: address };
}
