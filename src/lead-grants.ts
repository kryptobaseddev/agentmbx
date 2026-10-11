// Owner-signed grants carried by a project lead record (T499). The owner signs, once, that the members of a project may be
// auto-approved for the bounded outward-reversible work (a branch push, a draft PR) while their project lead is live and untainted.
//
// The grants are a SECOND signed record stored on the lead's own row (`project_leads.grants`, `grants_sig`), never a new key inside the
// signed lead record: LeadRecord is a strict v1 schema, so an older runtime that met an extra key would drop the lead altogether. The
// lead record's bytes and signature stay exactly as signed; an older reader keeps the lead and simply never sees the grants.
//
// Use is a check in the permission lookup, not a message: `withLeadGrants` answers for class outward-reversible when the owner's own
// policies do not. Everything it reads is the database, because the lookup runs inside the persona's lease transaction (permission.ts
// withAuthority), which may not inspect processes or do I/O.
import { z } from "zod";
import { fingerprint, ulid } from "./crypto.ts";
import { NAME_RE } from "./envelope.ts";
import { leadFor, signedBy, type LeadRecord } from "./lead-record.ts";
import type { MbxNode } from "./node.ts";
import type { Lookup, PermissionClass } from "./permission.ts";
import { killSwitchSince, within } from "./policy.ts";
import { resolveProject } from "./project-key.ts";
import { sessionUntainted } from "./session-taint.ts";
import type { Store } from "./store.ts";

const H = 3_600_000;
/** What an owner can delegate through a lead record: only what has an enforcement point. read and edit are policy-line text with
 *  none yet (T551), and a signature must not gain effect later by an upgrade; `outward` and `permissions` are never delegated. */
export const DELEGABLE_CLASSES = ["outward-reversible"] as const;
export type DelegableClass = (typeof DELEGABLE_CLASSES)[number];
/** A grant lives at most as long as a collaborate policy (720 h) and never past the lead record it hangs on. */
export const GRANT_MAX_TTL_MS = 720 * H;

const LeadGrantsSchema = z.object({
  v: z.literal(1), type: z.literal("lead-grants"), id: z.string().min(10).max(40), lead: z.string().min(10).max(40),
  classes: z.array(z.string().min(1).max(40)).min(1).max(8),
  agents: z.array(z.string().min(1).max(40)).min(1).max(50),
  iat: z.string().datetime(), exp: z.string().datetime(), owner_fp: z.string().min(4).max(64),
}).strict();
export type LeadGrants = z.infer<typeof LeadGrantsSchema>;

const fail = (code: string, message: string): never => { throw Object.assign(new Error(message), { code }); };

/** The class and persona rules, shared by make (before the owner is asked to sign) and store/use (never trusting a stored blob). */
function checkShape(g: LeadGrants): string | null {
  for (const c of g.classes) {
    if (!(DELEGABLE_CLASSES as readonly string[]).includes(c)) {
      return c === "read" || c === "edit" ? `class "${c}" has no enforcement point yet (T551); only ${DELEGABLE_CLASSES.join(", ")} can be delegated`
        : c === "outward" || c === "permissions" ? `class "${c}" is never delegated through a lead record (only ${DELEGABLE_CLASSES.join(", ")})`
        : `unknown class "${c}" (only ${DELEGABLE_CLASSES.join(", ")} can be delegated)`;
    }
  }
  if (new Set(g.classes).size !== g.classes.length) return "duplicate classes";
  if (g.agents.includes("*") && g.agents.length > 1) return "\"*\" must be the only agent selector";
  const bad = g.agents.find((a) => a !== "*" && !NAME_RE.test(a));
  if (bad) return `"${bad}" is not a mailbox name`;
  if (new Set(g.agents).size !== g.agents.length) return "duplicate agents";
  return null;
}

export function makeLeadGrants(o: { lead: LeadRecord; classes: string[]; agents: string[]; ownerPub: string; ttlMs?: number; now?: Date }): LeadGrants {
  const now = o.now ?? new Date();
  const leadLeft = Date.parse(o.lead.exp) - now.getTime();
  const ttl = o.ttlMs ?? Math.min(GRANT_MAX_TTL_MS, leadLeft);
  if (!(ttl > 0)) fail("LEAD_GRANTS_TTL", "the lead record has expired; there is nothing to attach grants to");
  if (ttl > GRANT_MAX_TTL_MS) fail("LEAD_GRANTS_TTL", `lead grants last at most ${GRANT_MAX_TTL_MS / H} h`);
  if (ttl > leadLeft) fail("LEAD_GRANTS_TTL", `lead grants cannot outlive the lead record (it expires ${o.lead.exp})`);
  const g = LeadGrantsSchema.parse({ v: 1, type: "lead-grants", id: ulid(now.getTime()), lead: o.lead.id, classes: [...o.classes], agents: [...o.agents],
    iat: now.toISOString(), exp: new Date(now.getTime() + ttl).toISOString(), owner_fp: fingerprint(o.ownerPub) });
  const bad = checkShape(g);
  if (bad) fail("LEAD_GRANTS_INVALID", bad);
  return g;
}

const CLASS_TEXT: Record<DelegableClass, string> = { "outward-reversible": "push a non-default branch and open a draft PR" };
/** One plain line: what the owner is signing. Shown before the signature. */
export function leadGrantsSummary(g: LeadGrants, lead: LeadRecord): string {
  const who = g.agents.includes("*")
    ? `ANY persona that is a member of project ${lead.project} (a session becomes a member by registering itself with mbx_identity)`
    : `${g.agents.join(", ")}, as members of project ${lead.project}`;
  return `Let ${who} ${g.classes.map((c) => CLASS_TEXT[c as DelegableClass] ?? c).join(" and ")} with automatic approval, while ${lead.agent}@${lead.host} (the lead) `
    + `is live and not tainted by outside content, until ${g.exp}. Granted through lead record ${lead.id}; it ends with that record or with a policy kill switch.`;
}

/** Store a signed grants blob on the lead's current record. One immutable blob per record: to change grants the owner signs a new lead record. */
export function storeLeadGrants(node: MbxNode, rec: unknown, sig: string, now = new Date()): LeadGrants {
  const p = LeadGrantsSchema.safeParse(rec);
  if (!p.success) fail("LEAD_GRANTS_INVALID", `invalid lead grants: ${p.error.issues[0]?.message ?? "shape"}`);
  const g = p.data!;
  const shape = checkShape(g);
  if (shape) fail("LEAD_GRANTS_INVALID", shape);
  if (!signedBy(node, g, sig, g.owner_fp)) fail("LEAD_GRANTS_SIGNATURE", "lead grants are not signed by an owner key this host trusts");
  const db = node.store.db;
  const row = db.prepare("SELECT project, project_key FROM project_leads WHERE id=?").get(g.lead) as { project: string; project_key: string | null } | undefined;
  if (!row) fail("LEAD_NOT_FOUND", `no lead record ${g.lead} on this host`);
  const lead = leadFor(node, row!.project, row!.project_key ?? resolveProject(row!.project).key, now);
  if (!lead || lead.id !== g.lead) fail("LEAD_NOT_ACTIVE", `lead record ${g.lead} is not the project's current lead record (expired, revoked or superseded)`);
  const bad = lifetimeProblem(g, lead!, now);
  if (bad) fail("LEAD_GRANTS_TTL", bad);
  const n = db.prepare("UPDATE project_leads SET grants=?, grants_sig=? WHERE id=? AND grants IS NULL").run(JSON.stringify(g), sig, g.lead).changes;
  if (!n) fail("LEAD_GRANTS_EXIST", `lead record ${g.lead} already carries grants; sign a new lead record to change them`);
  node.store.audit("lead.grants_set", { id: g.id, lead: g.lead, project: lead!.project, agent: `${lead!.agent}@${lead!.host}`, classes: g.classes, agents: g.agents, exp: g.exp });
  return g;
}

/** Same owner as the lead record, bounded by it and by the 30-day cap. `now` only checks that the grant has not already ended. */
function lifetimeProblem(g: LeadGrants, lead: LeadRecord, now: Date): string | null {
  const iat = Date.parse(g.iat), exp = Date.parse(g.exp);
  if (g.owner_fp !== lead.owner_fp) return "lead grants must be signed by the same owner as the lead record";
  if (!(exp > iat)) return "lead grants end before they start";
  if (exp - iat > GRANT_MAX_TTL_MS) return `lead grants last at most ${GRANT_MAX_TTL_MS / H} h`;
  if (exp > Date.parse(lead.exp)) return `lead grants cannot outlive the lead record (it expires ${lead.exp})`;
  if (exp <= now.getTime()) return "lead grants have already expired";
  return null;
}

/** The grants on `lead`'s row, re-verified now: parse, owner signature, bound to this very record, lifetime. Null otherwise. */
export function verifiedLeadGrants(node: MbxNode, lead: LeadRecord, now = new Date()): LeadGrants | null {
  const row = node.store.db.prepare("SELECT grants, grants_sig FROM project_leads WHERE id=?").get(lead.id) as { grants: string | null; grants_sig: string | null } | undefined;
  if (!row?.grants || !row.grants_sig) return null;
  try {
    const p = LeadGrantsSchema.safeParse(JSON.parse(row.grants));
    if (!p.success) return null;
    const g = p.data;
    if (g.lead !== lead.id || checkShape(g) || lifetimeProblem(g, lead, now) || !signedBy(node, g, row.grants_sig, g.owner_fp)) return null;
    return g;
  } catch { return null; }
}

export type LeadLiveness = "ok" | "lead-not-live" | "lead-tainted";
/**
 * Is the lead there to approve, and clean? Live = an unreleased lease whose heartbeat is inside its own idle TTL (database
 * evidence, no process inspection; a killed lead keeps its grants until the heartbeat ages out). Clean = every conversation the
 * store knows for the lead, the lease's and each `sessions` row's, passes sessionUntainted (corrupt or unreadable taint is not clean).
 */
export function leadLiveness(store: Store, lead: LeadRecord, now = Date.now()): LeadLiveness {
  const lease = store.db.prepare("SELECT cli, session_id, heartbeat_at, idle_ttl, released_at FROM identity_leases WHERE name=?").get(lead.agent) as
    { cli: string; session_id: string; heartbeat_at: number; idle_ttl: number; released_at: number | null } | undefined;
  if (!lease || lease.released_at !== null || !(now - lease.heartbeat_at < lease.idle_ttl)) return "lead-not-live";
  const seen = new Map<string, { cli: string; session_id: string }>([[`${lease.cli}\u0000${lease.session_id}`, { cli: lease.cli, session_id: lease.session_id }]]);
  for (const r of store.db.prepare("SELECT cli, session_id FROM sessions WHERE agent=?").all(lead.agent) as { cli: string; session_id: string }[]) seen.set(`${r.cli}\u0000${r.session_id}`, r);
  for (const s of seen.values()) if (!sessionUntainted(store, s.cli, s.session_id, now)) return "lead-tainted";
  return "ok";
}

export type GrantState = "none" | "expired" | "killed" | "active" | "suspended: lead not live" | "suspended: lead tainted";
/** What `lead show` prints for a lead record's grants. */
export function leadGrantsView(node: MbxNode, lead: LeadRecord, now = new Date()): { grants: LeadGrants | null; state: GrantState } {
  const g = verifiedLeadGrants(node, lead, now);
  if (!g) {
    const raw = node.store.db.prepare("SELECT grants FROM project_leads WHERE id=?").get(lead.id) as { grants: string | null } | undefined;
    return { grants: null, state: raw?.grants ? "expired" : "none" };
  }
  if (killSwitchSince(node.store.db, g.iat, g.owner_fp)) return { grants: g, state: "killed" };
  const live = leadLiveness(node.store, lead, now.getTime());
  return { grants: g, state: live === "ok" ? "active" : live === "lead-tainted" ? "suspended: lead tainted" : "suspended: lead not live" };
}

export interface LeadGrantUse { lead: string; record: string; grants: string; exp: string }

/**
 * Does a lead-carried grant cover `agent`'s outward-reversible request in `cwd`? Every condition is a database read:
 * the persona is an explicit member of a project whose folder (or CLEO key) contains `cwd`; that project has an active lead record
 * on this host; the lead is not the persona; the record carries valid, unexpired grants naming the persona and the class; no owner
 * kill switch has been signed since; and the lead is live and untainted. Anything else is not a grant.
 */
export function leadGrantFor(node: MbxNode, agent: string, o: { cwd?: string | null; class?: PermissionClass; now?: Date }): { ok: boolean; policy_id?: string; exp?: string | null; grant?: LeadGrantUse } {
  const NO = { ok: false } as const;
  if (o.class !== "outward-reversible" || !o.cwd) return NO;
  const now = o.now ?? new Date();
  const db = node.store.db;
  const members = db.prepare("SELECT project, project_key FROM identity_projects WHERE name=?").all(agent) as { project: string; project_key: string | null }[];
  if (!members.length) return NO;
  const here = resolveProject(o.cwd).cleoId;
  for (const m of members) {
    if (!(within(o.cwd, [m.project]) || (m.project_key !== null && here === m.project_key))) continue;
    const lead = leadFor(node, m.project, m.project_key ?? m.project, now);
    if (!lead || lead.host !== node.host || lead.agent === agent) continue;
    const g = verifiedLeadGrants(node, lead, now);
    if (!g || !g.classes.includes(o.class) || !(g.agents.includes("*") || g.agents.includes(agent))) continue;
    if (killSwitchSince(db, g.iat, g.owner_fp)) continue;
    if (leadLiveness(node.store, lead, now.getTime()) !== "ok") continue;
    const exp = Date.parse(g.exp) < Date.parse(lead.exp) ? g.exp : lead.exp;
    return { ok: true, policy_id: `lead-grant:${g.id}`, exp, grant: { lead: `${lead.agent}@${lead.host}`, record: lead.id, grants: g.id, exp } };
  }
  return NO;
}

/** The permission lookup with lead grants behind the owner's own policies. Only class outward-reversible ever falls through. */
export const withLeadGrants = (node: MbxNode, own: Lookup): Lookup => (agent, ctx) => {
  const r = own(agent, ctx);
  return r.ok || ctx?.class !== "outward-reversible" ? r : leadGrantFor(node, agent, { cwd: ctx?.cwd, class: ctx.class });
};

/** One audit row per approved use, written where the hook commits the approval (permission.ts), never per lookup. */
export function auditLeadGrantUse(store: Store, d: { grant?: LeadGrantUse; agent?: string; cli: string; session_id?: string; tool?: string; class?: string; action?: string; cwd?: string | null; via?: string }): void {
  if (!d.grant) return;
  store.audit("lead.grant_used", { persona: d.agent ?? null, cli: d.cli, session_id: d.session_id ?? null, tool: d.tool ?? null, class: d.class ?? null,
    action: d.action ?? null, cwd: d.cwd ?? null, lead: d.grant.lead, record: d.grant.record, grants: d.grant.grants, exp: d.grant.exp, ...(d.via ? { via: d.via } : {}) });
}
