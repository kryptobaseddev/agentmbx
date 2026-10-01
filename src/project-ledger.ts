// Project ledger and lead (T208, v0.5.2 R3). Agents working in one project folder can see that project's mail traffic
// (who sent what to whom, delivery states, roles), with bodies only for their own mail. An owner-designated lead sees all
// of that project's bodies and can forward a project message to another local identity. A lead is an owner-signed record,
// stored durably and re-verified against the owner keys on every read, so a tampered or revoked row never confers it.
import { z } from "zod";
import { canonical, fingerprint, ulid, verifyData } from "./crypto.ts";
import type { Envelope } from "./envelope.ts";
import type { MbxNode } from "./node.ts";
import { ownerKeys } from "./policy.ts";
import { deliveryReceipts, type DeliveryReceipt } from "./receipts.ts";
import { projectIdentities, registeredIdentity } from "./registry.ts";
import type { MessageRow } from "./store.ts";

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
export const isLead = (node: MbxNode, agent: string, project: string | undefined) =>
  !!project && ((l) => !!l && l.agent === agent && l.host === node.host)(activeLead(node, project));

// ---- the ledger ---------------------------------------------------------------------------------

export interface LedgerRecipient extends DeliveryReceipt { role: string | null }
export interface LedgerItem {
  id: string; ts: string; from: string; to: string[]; kind: string; subject: string; thread: string; project: string | null;
  body: string | null; body_withheld?: string; recipients: LedgerRecipient[]; forwarded_by?: string[];
}
export interface LedgerPage { project: string; lead: string | null; messages: LedgerItem[]; next_cursor: string; has_more: boolean }
interface Frame { v: 1; epoch: string; project: string; position: string; end: string }

const roleOf = (node: MbxNode, address: string) => {
  const [name, host] = address.split("@");
  return host === node.host ? registeredIdentity(node.store, name)?.role ?? null : null;
};

/** SQL condition (and parameters) for "a message of this project": stamped with meta.project, or sent by / delivered to
 *  an identity associated with the project. */
function ledgerWhere(node: MbxNode, project: string): { sql: string; args: string[] } {
  const members = [...projectIdentities(node.store, project)];
  const addrs = members.map((n) => `${n}@${node.host}`);
  const inList = (xs: string[]) => (xs.length ? xs.map(() => "?").join(",") : "NULL");
  return { sql: `(json_extract(envelope,'$.meta.project')=? OR from_addr IN (${inList(addrs)})
      OR id IN (SELECT msg_id FROM deliveries WHERE agent IN (${inList(members)})))`, args: [project, ...addrs, ...members] };
}
function ledgerIds(node: MbxNode, project: string, after: string, upTo: string, limit: number): string[] {
  const w = ledgerWhere(node, project);
  return (node.store.db.prepare(`SELECT id FROM messages WHERE id>? AND id<=? AND ${w.sql} ORDER BY id LIMIT ?`)
    .all(after, upTo, ...w.args, limit) as { id: string }[]).map((r) => r.id);
}
/** Is `id` a message of `project`'s ledger? */
export function inLedger(node: MbxNode, project: string, id: string): boolean {
  const w = ledgerWhere(node, project);
  return !!node.store.db.prepare(`SELECT 1 FROM messages WHERE id=? AND ${w.sql}`).get(id, ...w.args);
}

/** The project ledger for `caller` working in `project`. Bodies: the caller's own mail, or everything for the lead. */
export function ledgerPage(node: MbxNode, caller: string, project: string, o: { cursor?: string; limit?: number } = {}): LedgerPage {
  const limit = o.limit ?? 20;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) fail("CURSOR_INVALID", "Ledger bounds are invalid");
  const epoch = node.store.get("replay:epoch") ?? fail("CURSOR_EXPIRED", "Store generation is unavailable");
  const max = (node.store.db.prepare("SELECT COALESCE(MAX(id),'') m FROM messages").get() as { m: string }).m;
  let frame: Frame = { v: 1, epoch: epoch!, project, position: "", end: max };
  if (o.cursor !== undefined) {
    let f: Frame | null = null;
    try {
      if (typeof o.cursor === "string" && o.cursor.length <= 4096 && /^[A-Za-z0-9_-]+$/.test(o.cursor)) {
        const data = Buffer.from(o.cursor, "base64url");
        if (data.toString("base64url") === o.cursor) f = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(data)) as Frame;
      }
    } catch { /* invalid below */ }
    if (!f || typeof f !== "object" || Object.keys(f).sort().join(",") !== "end,epoch,position,project,v" || f.v !== 1
      || typeof f.position !== "string" || typeof f.end !== "string" || f.position > f.end) fail("CURSOR_INVALID", "Ledger cursor is invalid");
    if (f!.project !== project) fail("CURSOR_SCOPE_MISMATCH", "Ledger cursor belongs to a different project");
    if (f!.epoch !== epoch) fail("CURSOR_EXPIRED", "Store generation changed; restart from the beginning");
    frame = { ...f! };
    if (frame.position === frame.end) frame.end = max;
  }
  const lead = activeLead(node, project);
  const callerIsLead = !!lead && lead.agent === caller && lead.host === node.host;
  const ids = ledgerIds(node, project, frame.position, frame.end, limit + 1);
  const page = ids.slice(0, limit);
  const messages = page.map((id): LedgerItem => {
    const m = node.message(id) as MessageRow;
    const e = JSON.parse(m.envelope) as Envelope;
    const own = node.canSee(m, caller);
    const forwarded = forwardedBy(node, m.id);
    return {
      id: m.id, ts: m.ts, from: m.from_addr, to: e.to, kind: m.kind, subject: m.subject, thread: m.thread, project: e.meta.project ?? null,
      body: own || callerIsLead ? m.body : null,
      ...(own || callerIsLead ? {} : { body_withheld: "not your mail; the project lead can read it" }),
      recipients: deliveryReceipts(node, m).map((r) => ({ ...r, role: roleOf(node, r.address) })),
      ...(forwarded.length ? { forwarded_by: forwarded } : {}),
    };
  });
  const done = ids.length <= limit;
  const position = page.length ? page[page.length - 1] : frame.position;
  return { project, lead: lead ? `${lead.agent}@${lead.host}` : null, messages,
    next_cursor: Buffer.from(JSON.stringify({ ...frame, position: done ? frame.end : position })).toString("base64url"), has_more: !done };
}


const forwardKey = (msg: string, to: string) => `forwarded:${msg}:${to}`;
/** Leads who forwarded message `msg` (to anyone). */
export function forwardedBy(node: MbxNode, msg: string): string[] {
  return (node.store.db.prepare("SELECT v FROM kv WHERE k LIKE ?").all(`forwarded:${msg}:%`) as { v: string }[]).map((r) => r.v);
}
/** The lead who forwarded `msg` to `agent`, for that recipient's header. */
export const forwardedTo = (node: MbxNode, msg: string, agent: string): string | null => node.store.get(forwardKey(msg, agent)) ?? null;

/** Lead-only: re-deliver a project message to another local identity, audited. The recipient's policy for it is still
 *  computed from the original sender: forwarding never adds authority. */
export function forwardMessage(node: MbxNode, lead: string, project: string | undefined, id: string, to: string): { id: string; to: string } {
  if (!project) fail("LEAD_REQUIRED", "this session works in no project folder");
  if (!isLead(node, lead, project)) fail("LEAD_REQUIRED", `only the project lead can forward; ${lead}@${node.host} is not the lead of ${project}`);
  const m = node.message(id) ?? fail("NOT_FOUND", `no message ${id}`);
  if (!inLedger(node, project!, m!.id)) fail("NOT_IN_PROJECT", `${m!.id} is not a message of project ${project}`);
  const [name, host] = to.split("@");
  if (host && host !== node.host) fail("LOCAL_ONLY", "forward re-delivers on this host only; use mbx_send for another host");
  const target = node.resolveAlias(name);
  if (!node.knownLocalName(target)) fail("UNKNOWN_RECIPIENT", `"${name}" is not an agent on ${node.host}`);
  node.store.tx(() => {
    node.store.addDelivery(m!.id, target);
    node.store.set(forwardKey(m!.id, target), `${lead}@${node.host}`);
    node.store.audit("message.forwarded", { msg: m!.id, by: `${lead}@${node.host}`, to: `${target}@${node.host}`, project });
  });
  return { id: m!.id, to: `${target}@${node.host}` };
}
