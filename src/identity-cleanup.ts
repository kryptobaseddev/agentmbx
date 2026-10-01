// Mailbox cleanup (T209, v0.5.2 R6). Older versions minted names on their own (`-mcp-<hash>`, `-<10 hex>`, `-<pid>`), so a
// busy host collected hundreds of mailboxes nobody will hold again. `prune` retires the ones that are provably dead weight;
// `forward` moves one mailbox's unread mail to another with the owner's signature. Neither ever deletes a message.
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { canonical, fingerprint, verifyData } from "./crypto.ts";
import { NAME_RE } from "./envelope.ts";
import { identityAvailability, activityKey, parseActivity } from "./identity-availability.ts";
import { inspectLeaseProcess, type IdentityLease, type ProcessEvidence } from "./identity-leases.ts";
import { AUTO_NAME_RE, registeredIdentity } from "./registry.ts";
import type { MbxNode } from "./node.ts";

export const retiredKey = (name: string) => `retired:${name}`;
export const isRetired = (node: MbxNode, name: string) => node.store.get(retiredKey(name)) !== undefined;

export interface PruneRow { name: string; reason: string; messages: number; last_activity: string | null }

/**
 * Mailboxes `prune` would retire: names an older version generated (never a chosen or registered one) that no session
 * holds, with no unread mail and no traffic for `days`. Everything else is listed with the reason it is kept.
 */
export function pruneCandidates(node: MbxNode, o: { days?: number; now?: number; inspect?: (pid: number) => ProcessEvidence } = {}) {
  const now = o.now ?? Date.now(), cutoff = now - (o.days ?? 7) * 86_400_000, inspect = o.inspect ?? inspectLeaseProcess;
  const db = node.store.db;
  const names = new Set<string>([
    ...(db.prepare("SELECT name FROM agents WHERE host=?").all(node.host) as { name: string }[]).map(r => r.name),
    ...(db.prepare("SELECT DISTINCT agent name FROM deliveries").all() as { name: string }[]).map(r => r.name),
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
    if (Number(stats.unread)) { keep(`${stats.unread} unread: forward it first (agentmbx identity forward ${name} <to>)`); continue; }
    if (last !== null && last > cutoff) { keep(`active within ${o.days ?? 7} days`); continue; }
    const evidence = lease && lease.released_at === null ? inspect(lease.holder_pid) : { alive: null, start: null };
    const a = identityAvailability({ lease, evidence, activity: parseActivity(node.store.get(activityKey(name))), now });
    if (!a.claimable) { keep(a.reason); continue; }
    retire.push({ ...row, reason: "generated name, unheld, no unread mail, inactive" });
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

/** Un-retire a name that a session explicitly claims or registers again. */
export function reviveMailbox(node: MbxNode, name: string) {
  if (isRetired(node, name)) node.store.db.prepare("DELETE FROM kv WHERE k=?").run(retiredKey(name));
}

// ---- owner-signed forward --------------------------------------------------------------------------------------------
const forwardSchema = z.object({ v: z.literal(1), type: z.literal("identity-forward"), id: z.string().uuid(), owner_fp: z.string(), host: z.string(),
  host_fp: z.string(), from: z.string().regex(NAME_RE), to: z.string().regex(NAME_RE), unread: z.number().int().nonnegative(),
  issued_at: z.number().int(), expires_at: z.number().int() }).strict();
export type ForwardPayload = z.infer<typeof forwardSchema>;

/** What the owner signs to move `from`'s unread mail to `to` (and route `from` to `to` from then on). */
export function buildForward(node: MbxNode, from: string, to: string, now = Date.now()): ForwardPayload {
  const owner = node.ownerPub;
  if (!owner) throw new Error("identity forward requires a local owner key (agentmbx owner init)");
  if (from === to) throw new Error("forward needs two different mailboxes");
  const held = (name: string) => {
    const lease = node.store.db.prepare("SELECT * FROM identity_leases WHERE name=?").get(name) as unknown as IdentityLease | undefined;
    return lease && lease.released_at === null ? identityAvailability({ lease, evidence: inspectLeaseProcess(lease.holder_pid), activity: null, now }) : null;
  };
  const source = held(from);
  if (source && !source.claimable) throw new Error(`${from} is ${source.reason}: its session should rename itself (mbx_whoami) instead`);
  if (!node.knownLocalName(to)) throw new Error(`${to} is not a mailbox on ${node.host}`);
  const unread = Number((node.store.db.prepare("SELECT COUNT(*) n FROM deliveries WHERE agent=? AND state<>'acked'").get(from) as { n: number }).n);
  return forwardSchema.parse({ v: 1, type: "identity-forward", id: randomUUID(), owner_fp: fingerprint(owner), host: node.host, host_fp: fingerprint(node.key.publicKey),
    from, to, unread, issued_at: now, expires_at: now + 5 * 60_000 });
}

/** Apply an owner-signed forward: unread mail moves (acked history stays), and `from` routes to `to` from now on. */
export function applyForward(node: MbxNode, approval: { payload: ForwardPayload; sig: string }, now = Date.now()): { moved: number } {
  const payload = forwardSchema.parse(approval.payload), owner = node.ownerPub;
  if (!owner || fingerprint(owner) !== payload.owner_fp || !verifyData(owner, canonical(payload), approval.sig)) throw new Error("invalid owner forward signature");
  if (payload.host !== node.host || payload.host_fp !== fingerprint(node.key.publicKey)) throw new Error("owner forward approval names another host");
  if (payload.issued_at > now || payload.expires_at <= now) throw new Error("owner forward approval expired");
  return node.store.tx(() => {
    if (node.store.get(`forward-used:${payload.id}`)) throw new Error("owner forward approval was already used");
    node.store.set(`forward-used:${payload.id}`, String(now));
    const pending = node.store.db.prepare("SELECT msg_id,state,updated_at,note FROM deliveries WHERE agent=? AND state<>'acked'").all(payload.from) as { msg_id: string; state: string; updated_at: string; note: string | null }[];
    for (const row of pending) {
      node.store.db.prepare("INSERT OR IGNORE INTO deliveries (msg_id,agent,state,updated_at,note) VALUES (?,?,?,?,?)").run(row.msg_id, payload.to, row.state, row.updated_at, row.note);
      node.store.db.prepare("DELETE FROM deliveries WHERE msg_id=? AND agent=?").run(row.msg_id, payload.from);
    }
    node.store.set(`alias:${payload.from}`, payload.to);
    node.store.audit("identity.forward", { from: payload.from, to: payload.to, moved: pending.length, owner_fp: payload.owner_fp, approval: payload.id });
    return { moved: pending.length };
  });
}
