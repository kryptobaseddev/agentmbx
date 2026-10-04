// Retention (T031): prune old, fully settled mail. Off by default: nothing is deleted until the owner sets
// `retention_days` in config.json (agentmbx retention set <days>) or runs `agentmbx prune --older-than <days>`.
// A message is prunable only when it was received before the cutoff, every local delivery is acked and was last
// updated before the cutoff, and no outbox row or unsettled relay row still holds it (T167). Unacked mail
// (queued/delivered/notified/read — which covers every pending wake) is never touched. Each pruned visibility position leaves a tombstone so replay reports
// the gap (history_pruned) instead of skipping it silently.
import type { Store } from "./store.ts";

export const MAX_RETENTION_DAYS = 36_500;
export interface PruneResult {
  dry_run: boolean; older_than_days: number; cutoff: string; messages: number; deliveries: number; replay_positions: number;
  kept: { unacked: number; outbox: number; recent_activity: number }; vacuumed: boolean;
}

export function retentionDays(value: unknown): number {
  const n = typeof value === "string" && /^\d+$/.test(value) ? Number(value) : value;
  if (typeof n !== "number" || !Number.isSafeInteger(n) || n < 1 || n > MAX_RETENTION_DAYS)
    throw Object.assign(new Error(`retention must be a whole number of days from 1 to ${MAX_RETENTION_DAYS}`), { code: "USAGE_ERROR" });
  return n;
}
/** The configured window, or null (the default: retention off, nothing is pruned automatically). */
export const configuredRetention = (config: object): number | null => {
  const v = (config as { retention_days?: unknown }).retention_days;
  return v === undefined || v === null ? null : retentionDays(v);
};

const OLD = "m.received_at < :cutoff";
/** Still held for delivery: an outbox row, or a relay row that is not final (accepted, or waiting for a re-push after a
 *  relay restore, T167). The relay keeps such mail for its own retention (14 days by default), longer than a short local
 *  window, and the sender's deadline and expiry alerts need the message: pruning it would lose that mail silently. */
const HELD = `(EXISTS (SELECT 1 FROM outbox o WHERE o.msg_id=m.id) OR EXISTS (SELECT 1 FROM relay_sent s WHERE s.msg_id=m.id AND s.state IN ('relay-accepted','repush')))`;
const ELIGIBLE = `${OLD}
  AND NOT EXISTS (SELECT 1 FROM deliveries d WHERE d.msg_id=m.id AND (d.state<>'acked' OR d.updated_at >= :cutoff))
  AND NOT ${HELD}`;

/** Count (dry run) or delete prunable mail in one write transaction; VACUUM afterwards when asked and anything went. */
export function prune(store: Store, days: number, o: { dryRun?: boolean; vacuum?: boolean; now?: number } = {}): PruneResult {
  const older_than_days = retentionDays(days), now = o.now ?? Date.now();
  const cutoff = new Date(now - older_than_days * 86_400_000).toISOString(), db = store.db, p = { cutoff };
  const n = (sql: string, params: Record<string, string> = p) => Number(db.prepare(sql).get(params)!.n);
  const count = (): Omit<PruneResult, "dry_run" | "older_than_days" | "cutoff" | "vacuumed"> => ({
    messages: n(`SELECT count(*) n FROM messages m WHERE ${ELIGIBLE}`),
    deliveries: n(`SELECT count(*) n FROM deliveries WHERE msg_id IN (SELECT m.id FROM messages m WHERE ${ELIGIBLE})`),
    replay_positions: n(`SELECT count(*) n FROM mailbox_visibility WHERE message_id IN (SELECT m.id FROM messages m WHERE ${ELIGIBLE})`),
    kept: {
      unacked: n(`SELECT count(*) n FROM messages m WHERE ${OLD} AND EXISTS (SELECT 1 FROM deliveries d WHERE d.msg_id=m.id AND d.state<>'acked')`),
      outbox: n(`SELECT count(*) n FROM messages m WHERE ${OLD} AND ${HELD}`),
      recent_activity: n(`SELECT count(*) n FROM messages m WHERE ${OLD} AND NOT EXISTS (SELECT 1 FROM deliveries d WHERE d.msg_id=m.id AND d.state<>'acked')
        AND EXISTS (SELECT 1 FROM deliveries d WHERE d.msg_id=m.id AND d.updated_at >= :cutoff) AND NOT ${HELD}`),
    },
  });
  const base = { older_than_days, cutoff, vacuumed: false };
  if (o.dryRun) return { dry_run: true, ...base, ...store.readTx(count) };
  const r = store.tx(() => {
    const c = count();
    if (!c.messages) return c;
    const at = new Date(now).toISOString();
    db.exec("CREATE TEMP TABLE IF NOT EXISTS prune_ids (id TEXT PRIMARY KEY); DELETE FROM temp.prune_ids");
    db.prepare(`INSERT INTO prune_ids (id) SELECT m.id FROM messages m WHERE ${ELIGIBLE}`).run(p);
    const ids = "(SELECT id FROM temp.prune_ids)";
    db.prepare(`INSERT OR IGNORE INTO mailbox_pruned (mailbox,seq,message_id,pruned_at) SELECT mailbox,seq,message_id,? FROM mailbox_visibility WHERE message_id IN ${ids}`).run(at);
    db.exec(`DELETE FROM mailbox_visibility WHERE message_id IN ${ids}; DELETE FROM deliveries WHERE msg_id IN ${ids};
      INSERT INTO messages_fts(messages_fts,rowid,subject,body) SELECT 'delete',rowid,subject,body FROM messages WHERE id IN ${ids};
      DELETE FROM messages WHERE id IN ${ids}; DROP TABLE temp.prune_ids`);
    store.audit("retention.pruned", { older_than_days, cutoff, messages: c.messages, deliveries: c.deliveries, replay_positions: c.replay_positions });
    return c;
  });
  // VACUUM needs no open transaction; it returns freed pages to the filesystem after a real prune.
  if (o.vacuum && r.messages) { db.exec("VACUUM"); base.vacuumed = true; }
  return { dry_run: false, ...base, ...r };
}
