// Mailbox cleanup (T209, v0.5.2 R6). Older versions minted names on their own (`-mcp-<hash>`, `-<10 hex>`, `-<pid>`), so a
// busy host collected hundreds of mailboxes nobody will hold again. `prune` retires the ones that are provably dead weight;
// `forward` moves one mailbox's unread mail to another with the owner's signature. Neither ever deletes a message.
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { canonical, fingerprint, verifyData } from "./crypto.ts";
import { NAME_RE } from "./envelope.ts";
import { inLedger } from "./project-ledger.ts";
import { leadingReaders, projectKeysOf, projectLabel, projectMailboxByKey } from "./project-mailbox.ts";
import { isSlotName, notSlot } from "./project-slot.ts";
import { identityAvailability, activityKey, parseActivity } from "./identity-availability.ts";
import { hasHeldIdentity, inspectLeaseProcess, type IdentityLease, type ProcessEvidence } from "./identity-leases.ts";
import { bumpPostToolMarkersForAgent } from "./posttool.ts";
import { AUTO_NAME_RE, registeredIdentity } from "./registry.ts";
import type { MbxNode } from "./node.ts";
import { DatabaseSync } from "node:sqlite";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { resolveProject } from "./project-key.ts";
import { SCHEMA_VERSION, type Store } from "./store.ts";

type CleanupReadContext = { store: Pick<Store, "db">; host: string };
export interface BasenameMigrationPlan {
  project: string; key: string; source: string | null; target: string | null;
  ids: string[]; preserved: number; aliasCorrect: boolean; reason: string | null;
}

/** Pure candidate assessment shared by the read-only preview and guarded apply. No authority is granted by a preview. */
export function basenameMigrationPlan(node: CleanupReadContext, project: string, now = Date.now()): BasenameMigrationPlan {
  const key = resolveProject(project).key, box = projectMailboxByKey(node.store, key);
  const plan: BasenameMigrationPlan = { project, key, source: box?.alias ?? null, target: box?.slot ?? null,
    ids: [], preserved: 0, aliasCorrect: false, reason: null };
  const no = (reason: string) => ({ ...plan, reason });
  if (!box || !box.alias) return no("no allocated project mailbox with a canonical basename alias; designate/setup the project first");
  if (box.home_host !== node.host) return no("project mailbox is homed on another host");
  const keys = projectKeysOf(node.store, box.alias);
  if (keys.length !== 1 || keys[0] !== key) return no("legacy basename has missing, ambiguous or other-project membership");
  if (node.store.db.prepare("SELECT 1 FROM kv WHERE k=?").get(`identity-conflict:${box.alias}`)) return no("legacy ownership requires owner recovery");
  const held = heldReason(node, box.alias, now);
  if (held) return no(`legacy basename is ${held}`);
  const alias = node.store.db.prepare("SELECT v FROM kv WHERE k=?").get(`alias:${box.alias}`)?.v;
  if (typeof alias === "string" && isSlotName(alias) && alias !== box.slot) return no("legacy alias points to another project's mailbox");
  plan.aliasCorrect = alias === box.slot;
  const rows = node.store.db.prepare("SELECT msg_id,state FROM deliveries WHERE agent=? ORDER BY msg_id").all(box.alias) as { msg_id: string; state: string }[];
  for (const row of rows) {
    if (row.state === "read" || row.state === "acked") { plan.preserved++; continue; }
    if (!["queued", "delivered", "notified"].includes(row.state)) return no("legacy mailbox has an unsupported delivery state");
    if (!inLedger(node, box.key, row.msg_id)) return no("legacy pending mail is outside the project's ledger");
    plan.ids.push(row.msg_id);
  }
  return plan;
}

/** Existing-store read snapshot: never construct MbxNode, initialize keys, repair schema or allocate a slot. */
export function readBasenameMigrationPlan(home: string, project: string): BasenameMigrationPlan {
  const path = join(home, "mbx.db");
  if (!existsSync(path)) throw new Error("mailbox is not initialized; run setup before previewing migration");
  const config = JSON.parse(readFileSync(join(home, "config.json"), "utf8")) as { host?: unknown };
  if (typeof config.host !== "string" || !NAME_RE.test(config.host)) throw new Error("mailbox host configuration is invalid");
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    db.exec("PRAGMA busy_timeout=5000; PRAGMA query_only=ON; BEGIN");
    if (Number(db.prepare("PRAGMA user_version").get()!.user_version) !== SCHEMA_VERSION) throw new Error("mailbox schema is not compatible with this preview; update/setup first");
    return basenameMigrationPlan({ store: { db }, host: config.host }, project);
  } finally { db.close(); }
}

/** Lead-only migration under its existing write lease; use the shared mover, never bootstrap a second route. */
export function migrateBasename(node: MbxNode, caller: string, project: string, now = new Date()): { source: string; target: string; project: string; moved: number; ids: string[]; preserved: number } {
  const result = node.store.tx(() => {
    const plan = basenameMigrationPlan(node, project, now.getTime());
    if (plan.reason || !plan.source || !plan.target) throw new Error(plan.reason ?? "legacy basename is not eligible");
    const auth = authorizeLeadForward(node, caller, plan.source, plan.target, now);
    if (!auth.ok || auth.project !== plan.key) throw new Error(auth.ok ? "lead authority is for another project" : auth.reason);
    const moved = plan.aliasCorrect && !plan.ids.length ? { moved: 0, ids: [] as string[] }
      : moveUnread(node, plan.source, plan.target, { authority: "lead", project: auth.project,
        lead: { agent: caller, record: auth.record }, basenameMigration: true });
    return { source: plan.source, target: plan.target, project: plan.key, ...moved, preserved: plan.preserved };
  });
  if (result.moved) bumpPostToolMarkersForAgent(node.store.db, node.home, caller);
  return result;
}

export const retiredKey = (name: string) => `retired:${name}`;
export const isRetired = (node: MbxNode, name: string) => node.store.get(retiredKey(name)) !== undefined;

/** Where a pruned mailbox's unread mail goes: its project's mailbox (T495). */
export interface PruneForward { slot: string; label: string; unread: number }
export interface PruneRow { name: string; reason: string; messages: number; last_activity: string | null; forward?: PruneForward }

/**
 * The project mailbox that takes over a dead generated mailbox's unread mail, or the reason it cannot. It needs exactly ONE project
 * binding whose key has an allocated project mailbox homed on this host. Every unread message must also be in that project's ledger:
 * the ledger already includes whatever was delivered to a bound member, so this is implied by the binding and is why nothing newly
 * reaches the lead (it reads the ledger anyway); it stays as an assertion so a later change to the ledger cannot widen what moves.
 */
function projectForwardFor(node: MbxNode, name: string, unread: number): PruneForward | string {
  const hint = `forward it first (agentmbx identity forward ${name} <to>)`;
  const keys = projectKeysOf(node.store, name);
  if (!keys.length) return hint;
  if (keys.length > 1) return `bound to ${keys.length} projects: ${hint}`;
  const box = projectMailboxByKey(node.store, keys[0]);
  if (!box || box.home_host !== node.host) return `its project has no project mailbox on ${node.host} yet (agentmbx lead set), or ${hint}`;
  const ids = (node.store.db.prepare("SELECT msg_id FROM deliveries WHERE agent=? AND state<>'acked'").all(name) as { msg_id: string }[]).map((r) => r.msg_id);
  const outside = ids.filter((id) => !inLedger(node, box.key, id)).length;
  if (outside) return `${outside} of ${ids.length} unread message(s) are outside the project's ledger: ${hint} with your owner signature`;
  return { slot: box.slot, label: projectLabel(box), unread };
}

/**
 * Mailboxes `prune` would retire: names an older version generated (never a chosen or registered one) that no session
 * holds, with no unread mail and no traffic for `days`. Everything else is listed with the reason it is kept.
 */
export function pruneCandidates(node: MbxNode, o: { days?: number; now?: number; inspect?: (pid: number) => ProcessEvidence } = {}) {
  const now = o.now ?? Date.now(), cutoff = now - (o.days ?? 7) * 86_400_000, inspect = o.inspect ?? inspectLeaseProcess;
  const db = node.store.db;
  const names = new Set<string>([
    ...(db.prepare("SELECT name FROM agents WHERE host=?").all(node.host) as { name: string }[]).map(r => r.name),
    // T493: a project mailbox slot is never a prune candidate; forwarding into or out of one is T495's, not this path's.
    ...(db.prepare(`SELECT DISTINCT agent name FROM deliveries WHERE ${notSlot("agent")}`).all() as { name: string }[]).map(r => r.name),
    ...(db.prepare("SELECT name FROM identity_leases").all() as { name: string }[]).map(r => r.name),
  ]);
  const retire: PruneRow[] = [], kept: PruneRow[] = [];
  for (const name of [...names].sort()) {
    if (isRetired(node, name)) continue;
    const stats = db.prepare("SELECT COUNT(*) total, COALESCE(SUM(state<>'acked'),0) unread, MAX(updated_at) at FROM deliveries WHERE agent=?").get(name) as { total: number; unread: number; at: string | null };
    const sent = (db.prepare("SELECT MAX(ts) at FROM messages WHERE from_addr=?").get(`${name}@${node.host}`) as { at: string | null }).at;
    const seen = (db.prepare("SELECT last_seen FROM agents WHERE name=? AND host=?").get(name, node.host) as { last_seen: string | null } | undefined)?.last_seen ?? null;
    const lease = db.prepare("SELECT * FROM identity_leases WHERE name=?").get(name) as unknown as IdentityLease | undefined;
    const times = [stats.at, sent, seen, lease ? new Date(lease.released_at ?? lease.heartbeat_at).toISOString() : null].filter((t): t is string => !!t).map(t => Date.parse(t)).filter(Number.isFinite);
    const last = times.length ? Math.max(...times) : null;
    const row = { name, messages: Number(stats.total), last_activity: last === null ? null : new Date(last).toISOString() };
    const keep = (reason: string) => kept.push({ ...row, reason });
    if (!AUTO_NAME_RE.test(name)) { keep("chosen name"); continue; }
    if (registeredIdentity(node.store, name)) { keep("registered"); continue; }
    // T495: unread mail no longer keeps a dead mailbox alive when its project has a mailbox to take it; the rest of the gates still apply.
    let forward: PruneForward | undefined;
    if (Number(stats.unread)) {
      const f = projectForwardFor(node, name, Number(stats.unread));
      if (typeof f === "string") { keep(`${stats.unread} unread: ${f}`); continue; }
      forward = f;
    }
    if (last !== null && last > cutoff) { keep(`active within ${o.days ?? 7} days`); continue; }
    const evidence = lease && lease.released_at === null ? inspect(lease.holder_pid) : { alive: null, start: null };
    const a = identityAvailability({ lease, evidence, activity: parseActivity(node.store.get(activityKey(name))), now });
    if (!a.claimable) { keep(a.reason); continue; }
    retire.push({ ...row, reason: forward ? `generated name, unheld, inactive; its ${forward.unread} unread message(s) go to the project mailbox ${forward.label}` : "generated name, unheld, no unread mail, inactive", ...(forward ? { forward } : {}) });
  }
  return { retire, kept };
}

/**
 * Retire a mailbox: it leaves listings, routing and suggestions, and its stale bindings and name memories go. Its messages
 * and delivery history stay (replay and audit still see them); claiming the name later brings it back.
 */
export function retireMailbox(node: MbxNode, name: string, by: string) {
  const db = node.store.db;
  node.store.tx(() => {
    db.prepare("DELETE FROM agents WHERE name=? AND host=?").run(name, node.host);
    db.prepare("DELETE FROM sessions WHERE agent=?").run(name);
    db.prepare("DELETE FROM identity_projects WHERE name=?").run(name);
    db.prepare("DELETE FROM identity_leases WHERE name=? AND released_at IS NOT NULL").run(name);
    db.prepare("DELETE FROM kv WHERE (k GLOB 'name:*' AND v=?) OR k=?").run(name, activityKey(name));
    node.store.set(retiredKey(name), JSON.stringify({ at: new Date().toISOString(), by }));
    node.store.audit("identity.retired", { name, by });
  });
}

/**
 * Apply a prune: each row's unread mail moves to its project mailbox and the mailbox is retired, in one transaction per mailbox.
 * Authority is the user running `--apply`, exactly like retiring today; only a generated, unheld, inactive name's mail moves, and only
 * into its own project's mailbox.
 */
export function applyPrune(node: MbxNode, rows: PruneRow[], by: string): { retired: number; forwarded: number } {
  let forwarded = 0;
  for (const r of rows) node.store.tx(() => {
    if (r.forward) forwarded += moveUnread(node, r.name, r.forward.slot, { authority: "prune", project: projectKeysOf(node.store, r.name)[0] }).moved;
    retireMailbox(node, r.name, by);
  });
  return { retired: rows.length, forwarded };
}

/** Un-retire a name that a session explicitly claims or registers again. */
export function reviveMailbox(node: MbxNode, name: string) {
  if (isRetired(node, name)) node.store.db.prepare("DELETE FROM kv WHERE k=?").run(retiredKey(name));
}

// ---- owner-signed forward --------------------------------------------------------------------------------------------
const forwardSchema = z.object({ v: z.literal(1), type: z.literal("identity-forward"), id: z.string().uuid(), owner_fp: z.string(), host: z.string(),
  host_fp: z.string(), from: z.string().regex(NAME_RE), to: z.string().regex(NAME_RE), unread: z.number().int().nonnegative(),
  issued_at: z.number().int(), expires_at: z.number().int() }).strict();
export type ForwardPayload = z.infer<typeof forwardSchema>;

/** Why a live session holds `name` (so its mail is not ours to move), or null when it is free to forward from. */
function heldReason(node: CleanupReadContext, name: string, now = Date.now()): string | null {
  const lease = node.store.db.prepare("SELECT * FROM identity_leases WHERE name=?").get(name) as unknown as IdentityLease | undefined;
  if (!lease || lease.released_at !== null) return null;
  const a = identityAvailability({ lease, evidence: inspectLeaseProcess(lease.holder_pid), activity: null, now });
  return a.claimable ? null : a.reason;
}

/** What the owner signs to move `from`'s unread mail to `to` (and route `from` to `to` from then on). */
export function buildForward(node: MbxNode, from: string, to: string, now = Date.now()): ForwardPayload {
  const owner = node.ownerPub;
  if (!owner) throw new Error("identity forward requires a local owner key (agentmbx owner init)");
  if (from === to) throw new Error("forward needs two different mailboxes");
  if (isSlotName(from) || isSlotName(to)) throw new Error("a project mailbox cannot be a forward source or target here: project mail is handled by the project lead (T495)");
  const heldBy = heldReason(node, from, now);
  if (heldBy) throw new Error(`${from} is ${heldBy}: its session should rename itself (mbx_whoami) instead`);
  if (!node.knownLocalName(to)) throw new Error(`${to} is not a mailbox on ${node.host}`);
  const unread = Number((node.store.db.prepare("SELECT COUNT(*) n FROM deliveries WHERE agent=? AND state<>'acked'").get(from) as { n: number }).n);
  return forwardSchema.parse({ v: 1, type: "identity-forward", id: randomUUID(), owner_fp: fingerprint(owner), host: node.host, host_fp: fingerprint(node.key.publicKey),
    from, to, unread, issued_at: now, expires_at: now + 5 * 60_000 });
}

/** Who allowed an unread-mail move (T495). The audit row names it, so every path is attributable. */
export type ForwardAuthority = "owner" | "lead" | "prune";
export interface MoveOptions {
  authority: ForwardAuthority;
  /** The project key a lead or prune move is scoped to. */
  project?: string;
  /** The lead record that authorised a lead move. */
  lead?: { agent: string; record: string };
  /** Audit fields that belong to one path only (the owner's signature). */
  extra?: Record<string, unknown>;
  /** T494 alone leaves read/acked source copies in place and records every migrated copy. */
  basenameMigration?: boolean;
}

/**
 * Move `from`'s unread deliveries to `to` (acked history stays, the SAME message ids are re-delivered, nothing is re-signed) and
 * route `from` to `to` from then on. A project mailbox is never aliased to a persona: later project mail must keep going to the
 * project mailbox. The one place that moves unread mail, whoever authorised it; the caller proves the authority and runs this inside
 * its own transaction. Returns the moved ids so the caller can say what moved.
 */
export function moveUnread(node: MbxNode, from: string, to: string, o: MoveOptions): { moved: number; ids: string[] } {
  const pending = node.store.db.prepare("SELECT msg_id,state,updated_at,note FROM deliveries WHERE agent=? AND "
    + (o.basenameMigration ? "state IN ('queued','delivered','notified') ORDER BY msg_id" : "state<>'acked'")).all(from) as { msg_id: string; state: string; updated_at: string; note: string | null }[];
  for (const row of pending) {
    const existing = o.basenameMigration ? node.store.db.prepare("SELECT state FROM deliveries WHERE msg_id=? AND agent=?").get(row.msg_id, to) : undefined;
    node.store.db.prepare("INSERT OR IGNORE INTO deliveries (msg_id,agent,state,updated_at,note) VALUES (?,?,?,?,?)").run(row.msg_id, to, row.state, row.updated_at, row.note);
    node.store.db.prepare("DELETE FROM deliveries WHERE msg_id=? AND agent=?").run(row.msg_id, from);
    if (o.basenameMigration) node.store.audit("identity.basename_migrated", { msg: row.msg_id, from, to, project: o.project,
      authority: o.authority, lead_record: o.lead?.record, by: o.lead?.agent,
      outcome: existing ? "deduplicated" : "moved", source_state: row.state, target_state: existing?.state ?? row.state });
  }
  if (!isSlotName(from)) node.store.set(`alias:${from}`, to);
  const ids = pending.map((r) => r.msg_id);
  node.store.audit("identity.forward", { from, to, moved: pending.length, authority: o.authority, ...(o.project ? { project: o.project } : {}),
    ...(o.lead ? { lead: `${o.lead.agent}@${node.host}`, lead_record: o.lead.record } : {}), ...o.extra, ids: ids.slice(0, 50) });
  return { moved: pending.length, ids };
}

/** Apply an owner-signed forward: unread mail moves (acked history stays), and `from` routes to `to` from now on. */
export function applyForward(node: MbxNode, approval: { payload: ForwardPayload; sig: string }, now = Date.now()): { moved: number } {
  const payload = forwardSchema.parse(approval.payload), owner = node.ownerPub;
  if (isSlotName(payload.from) || isSlotName(payload.to)) throw new Error("a project mailbox cannot be a forward source or target here: project mail is handled by the project lead (T495)");
  if (!owner || fingerprint(owner) !== payload.owner_fp || !verifyData(owner, canonical(payload), approval.sig)) throw new Error("invalid owner forward signature");
  if (payload.host !== node.host || payload.host_fp !== fingerprint(node.key.publicKey)) throw new Error("owner forward approval names another host");
  if (payload.issued_at > now || payload.expires_at <= now) throw new Error("owner forward approval expired");
  const result = node.store.tx(() => {
    if (node.store.get(`forward-used:${payload.id}`)) throw new Error("owner forward approval was already used");
    node.store.set(`forward-used:${payload.id}`, String(now));
    const { moved } = moveUnread(node, payload.from, payload.to, { authority: "owner", extra: { owner_fp: payload.owner_fp, approval: payload.id } });
    return { moved };
  });
  // T342: unread mail moved to payload.to; its claude sessions' hooks must notice (review medium 2).
  bumpPostToolMarkersForAgent(node.store.db, node.home, payload.to);
  return result;
}

// ---- the project lead's forward (T495) -----------------------------------------------------------------------------------
export type LeadForwardAuth = { ok: true; project: string; label: string; record: string } | { ok: false; reason: string };

/**
 * May `caller` move `from`'s unread mail to `to` WITHOUT the owner's signature? Only when every one of these holds, and a failure
 * means the owner-signed path, never a quieter allowance:
 *  1. the call runs inside `caller`'s own held WRITE lease (a name typed at a shell proves nothing);
 *  2. `caller` is the CURRENT lead of a project on THIS host: the owner-signed, unrevoked, unexpired lead record, through the same
 *     lookup that decides who may read and who is woken (leadingReaders). A role label, a folder or a cwd is never consulted;
 *  3. BOTH mailboxes belong to that one project's key: its project mailbox, or a persona whose project bindings are non-empty and
 *     ALL map to that key (a persona that also works elsewhere stays owner-only);
 *  4. the two differ, are not both project mailboxes, the target is a mailbox on this host, and no live session holds the source.
 * It is a pure read; the move itself is `leadForward`, which runs this again inside the same transaction.
 */
export function authorizeLeadForward(node: MbxNode, caller: string, from: string, to: string, now = new Date()): LeadForwardAuth {
  const no = (reason: string): LeadForwardAuth => ({ ok: false, reason });
  if (!hasHeldIdentity(node.store, caller)) return no("this is not running inside the caller's own session lease");
  if (from === to) return no("forward needs two different mailboxes");
  if (isSlotName(from) && isSlotName(to)) return no("a project mailbox cannot be forwarded to another project mailbox");
  const led = leadingReaders(node, caller, now);
  if (!led.length) return no(`${caller} is not the current lead of any project on ${node.host}`);
  const inProject = (name: string, key: string) => { const keys = projectKeysOf(node.store, name); return keys.length === 1 && keys[0] === key; };
  const project = led.find((r) => inProject(from, r.mailbox.key) && inProject(to, r.mailbox.key));
  if (!project) return no(`${from} and ${to} are not both mailboxes of one project that ${caller} leads`);
  if (!isSlotName(to) && !node.knownLocalName(to)) return no(`${to} is not a mailbox on ${node.host}`);
  const heldBy = heldReason(node, from, now.getTime());
  if (heldBy) return no(`${from} is ${heldBy}`);
  return { ok: true, project: project.mailbox.key, label: projectLabel(project.mailbox), record: project.lead.id };
}

export type LeadForward = { ok: true; moved: number; ids: string[]; project: string; label: string } | { ok: false; reason: string };

/**
 * The project lead moves unread mail between mailboxes of its own project. The authority is re-checked inside the transaction that
 * moves the mail, so a lead replaced, revoked or expired between the check and the move moves nothing. A refusal is audited
 * (`identity.forward_refused`) and returned, never thrown: the caller then asks for the owner's signature instead.
 */
export function leadForward(node: MbxNode, caller: string, from: string, to: string, now = new Date()): LeadForward {
  const result = node.store.tx((): LeadForward => {
    const auth = authorizeLeadForward(node, caller, from, to, now);
    if (!auth.ok) return auth;
    const moved = moveUnread(node, from, to, { authority: "lead", project: auth.project, lead: { agent: caller, record: auth.record } });
    return { ok: true, ...moved, project: auth.project, label: auth.label };
  });
  if (!result.ok) node.store.audit("identity.forward_refused", { by: caller, from, to, reason: result.reason });
  else bumpPostToolMarkersForAgent(node.store.db, node.home, to);
  return result;
}
