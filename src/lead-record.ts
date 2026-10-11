// Owner-signed project lead records (T208) and the `lead` / `role:lead` address (T393).
// Kept off the receipts graph: node.send resolves the address while node.ts is still initializing,
// and receipts reads DID_MAX from node at module scope.
import { z } from "zod";
import { canonical, fingerprint, ulid, verifyData } from "./crypto.ts";
import type { MbxNode } from "./node.ts";
import { ownerKeys } from "./policy.ts";
import { identityProjects } from "./registry.ts";

export const LEAD_DEFAULT_TTL_MS = 30 * 86_400_000;
export const LEAD_MAX_TTL_MS = 180 * 86_400_000;

const LeadRecord = z.object({
  v: z.literal(1), type: z.literal("lead"), id: z.string().min(10).max(40), project: z.string().min(1).max(1024),
  agent: z.string().regex(/^[a-z0-9][a-z0-9-]{1,39}$/), host: z.string().min(1).max(40), iat: z.string().datetime(), exp: z.string().datetime(),
  owner_fp: z.string().min(4).max(64),
}).strict();
export type LeadRecord = z.infer<typeof LeadRecord>;
const LeadRevocation = z.object({
  v: z.literal(1), type: z.literal("lead-revoke"), id: z.string().min(10).max(40), target: z.string().min(10).max(40),
  iat: z.string().datetime(), owner_fp: z.string().min(4).max(64),
}).strict();
export type LeadRevocation = z.infer<typeof LeadRevocation>;

const fail = (code: string, message: string): never => { throw Object.assign(new Error(message), { code }); };

export function makeLead(o: { project: string; agent: string; host: string; ownerPub: string; ttlMs?: number; now?: Date }): LeadRecord {
  const now = o.now ?? new Date(), ttl = o.ttlMs ?? LEAD_DEFAULT_TTL_MS;
  if (!(ttl > 0) || ttl > LEAD_MAX_TTL_MS) fail("LEAD_TTL", "lead TTL must be between 1 s and 180 days");
  return LeadRecord.parse({ v: 1, type: "lead", id: ulid(now.getTime()), project: o.project, agent: o.agent, host: o.host,
    iat: now.toISOString(), exp: new Date(now.getTime() + ttl).toISOString(), owner_fp: fingerprint(o.ownerPub) });
}
export function makeLeadRevocation(target: string, ownerPub: string, now = new Date()): LeadRevocation {
  return LeadRevocation.parse({ v: 1, type: "lead-revoke", id: ulid(now.getTime()), target, iat: now.toISOString(), owner_fp: fingerprint(ownerPub) });
}
export const leadSummary = (r: LeadRecord) => `Make ${r.agent}@${r.host} the lead of project ${r.project} until ${r.exp}: it can read every message of that project and forward them.`;

/** Owner keys this host trusts: its own, plus adopted owners (paired-device principals). */
const trustedOwners = (node: MbxNode) => [...new Set([...(node.ownerPub ? [node.ownerPub] : []), ...ownerKeys(node.store.db)])];
function signedBy(node: MbxNode, rec: unknown, sig: string, owner_fp: string): boolean {
  const pub = trustedOwners(node).find((k) => fingerprint(k) === owner_fp);
  return !!pub && verifyData(pub, canonical(rec), sig);
}

/** Store a signed lead record (verified here and again on every read). Later records for the same project supersede. */
export function storeLead(node: MbxNode, rec: unknown, sig: string): LeadRecord {
  const r = LeadRecord.safeParse(rec);
  if (!r.success) fail("LEAD_INVALID", `invalid lead record: ${r.error.issues[0]?.message ?? "shape"}`);
  if (!signedBy(node, r.data!, sig, r.data!.owner_fp)) fail("LEAD_SIGNATURE", "lead record is not signed by an owner key this host trusts");
  node.store.db.prepare("INSERT OR IGNORE INTO project_leads (id,project,agent,record,sig,received_at) VALUES (?,?,?,?,?,?)")
    .run(r.data!.id, r.data!.project, r.data!.agent, JSON.stringify(r.data), sig, new Date().toISOString());
  node.store.audit("lead.set", { id: r.data!.id, project: r.data!.project, agent: `${r.data!.agent}@${r.data!.host}`, exp: r.data!.exp });
  return r.data!;
}

/** Revoke a stored lead record with a signed revocation. */
export function revokeLead(node: MbxNode, rev: unknown, sig: string): LeadRevocation {
  const r = LeadRevocation.safeParse(rev);
  if (!r.success) fail("LEAD_INVALID", "invalid lead revocation");
  if (!signedBy(node, r.data!, sig, r.data!.owner_fp)) fail("LEAD_SIGNATURE", "lead revocation is not signed by an owner key this host trusts");
  const n = node.store.db.prepare("UPDATE project_leads SET revocation=?, revocation_sig=? WHERE id=? AND revocation IS NULL").run(JSON.stringify(r.data), sig, r.data!.target).changes;
  if (!n) fail("LEAD_NOT_FOUND", `no active lead record ${r.data!.target}`);
  node.store.audit("lead.revoke", { id: r.data!.target, revocation: r.data!.id });
  return r.data!;
}

/** The current lead of `project`, re-verified now: newest valid, unexpired, unrevoked record wins. */
export function activeLead(node: MbxNode, project: string, now = new Date()): LeadRecord | null {
  const rows = node.store.db.prepare("SELECT record,sig,revocation,revocation_sig FROM project_leads WHERE project=? ORDER BY id DESC").all(project) as
    { record: string; sig: string; revocation: string | null; revocation_sig: string | null }[];
  for (const row of rows) {
    let rec: LeadRecord;
    try { const p = LeadRecord.safeParse(JSON.parse(row.record)); if (!p.success) continue; rec = p.data; } catch { continue; }
    if (rec.project !== project || !signedBy(node, rec, row.sig, rec.owner_fp)) continue;
    if (row.revocation && row.revocation_sig) {
      try {
        const rv = LeadRevocation.safeParse(JSON.parse(row.revocation));
        if (rv.success && rv.data.target === rec.id && signedBy(node, rv.data, row.revocation_sig, rv.data.owner_fp)) continue; // revoked
      } catch { /* a malformed revocation takes nothing away */ }
    }
    if (Date.parse(rec.exp) <= now.getTime()) continue;
    return rec;
  }
  return null;
}
/** Every project's current lead, each re-verified now like `activeLead` (T496). A project whose records are all
 *  expired, revoked or not signed by a trusted owner key has no entry. Ordered by project folder. */
export function activeLeads(node: MbxNode, now = new Date()): LeadRecord[] {
  const out: LeadRecord[] = [];
  for (const { project } of node.store.db.prepare("SELECT DISTINCT project FROM project_leads ORDER BY project").all() as { project: string }[]) {
    const lead = activeLead(node, project, now);
    if (lead) out.push(lead);
  }
  return out;
}
export const isLead = (node: MbxNode, agent: string, project: string | undefined) =>
  !!project && ((l) => !!l && l.agent === agent && l.host === node.host)(activeLead(node, project));

export interface ProjectLeadView { project: string | null; address: string | null; exp: string | null }

/** What `agentmbx status` and `agentmbx whoami` show for the owner-designated lead. */
export function projectLeadView(node: MbxNode, project: string | undefined, now = new Date()): ProjectLeadView {
  if (!project) return { project: null, address: null, exp: null };
  const lead = activeLead(node, project, now);
  if (!lead) return { project, address: null, exp: null };
  return { project, address: `${lead.agent}@${lead.host}`, exp: lead.exp };
}

export function projectLeadLine(view: ProjectLeadView): string {
  if (!view.project) return "lead: no project";
  if (!view.address || !view.exp) return "lead: none";
  return `lead: ${view.address} until ${view.exp}`;
}

const leadToken = (to: string): boolean => to === "lead" || to === "role:lead";

/** The expanded `to` plus the address `lead`/`role:lead` resolved to (null when no lead token was
 *  present), so the caller can mark exactly the targets the tokens produced (T491). */
export interface LeadResolution { to: string[]; leadAddress: string | null }

/** Expand `lead` and `role:lead` to the owner-designated lead before the envelope is signed.
 *  Any other role stays a fan-out. Both tokens are one address and are de-duplicated. A prebuilt
 *  envelope is not passed here: its signature already commits to `to`. Holder liveness is NOT
 *  consulted here (that graph belongs to receipts); the returned leadAddress lets the caller mark
 *  the resolved targets for the send-time receipt check. */
export function resolveLeadRecipients(node: MbxNode, fromName: string, to: string[], project?: string): LeadResolution {
  if (!to.some(leadToken)) return { to, leadAddress: null };
  const folder = project || identityProjects(node.store, fromName)[0];
  if (!folder) fail("NO_PROJECT", "no project for this sender: lead and role:lead need the sender's project");
  const lead = activeLead(node, folder) ?? fail("NO_LEAD", "no owner-designated lead is set for this sender's project");
  // Copy before the peer callback: a closure drops the null narrowing on `lead`.
  const { agent, host } = lead;
  const approved = node.peers().some((p) => p.state === "approved" && p.host === host);
  if (host !== node.host && !approved) fail("NO_LEAD", `no owner-designated lead is reachable at ${agent}@${host}`);
  const address = host === node.host ? agent : `${agent}@${host}`;
  const out: string[] = [];
  for (const token of to) {
    const next = leadToken(token) ? address : token;
    if (!out.includes(next)) out.push(next);
  }
  return { to: out, leadAddress: address };
}
