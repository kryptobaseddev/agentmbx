// Replay positions are untrusted pagination input, never mailbox authority.
import { randomUUID, createHash } from "node:crypto";
import type { Store, MessageRow } from "./store.ts";

export interface ReplayOptions {
  cursor?: string; limit?: number; maxBytes?: number; scanLimit?: number;
  project?: string; project_host?: string; topic?: string; thread?: string;
}
export type ReplayItem = MessageRow | { id: string; content_omitted: true; reason: "REPLAY_ITEM_TOO_LARGE" };
/** `history_pruned` (present only when nonzero): retention-pruned positions this page passed over (T031). */
export interface ReplayPage { messages: ReplayItem[]; next_cursor: string; has_more: boolean; history_pruned?: number }
interface Frame { v: 1; epoch: string; mailbox: string; filter: string; position: number; end: number }
const fail = (code: string, message: string): never => { throw Object.assign(new Error(message), { code }); };
const EPOCH_KEY = "replay:epoch";
export function initializeReplay(store: Store): void {
  store.db.prepare("INSERT OR IGNORE INTO kv(k,v) VALUES (?,?)").run(EPOCH_KEY, randomUUID());
}
/** Explicit restore/reset write. Stop all writers before restoring and rotating this generation.
 * From the installed package directory, with MBX_HOME explicitly set to the restored store:
 * node --input-type=module -e 'import { MbxNode } from "./dist/node.js"; import { resetReplayEpoch } from "./dist/replay.js"; const n=new MbxNode(); resetReplayEpoch(n.store); n.close();'
 * Reopen daemon/connectors only after this operation succeeds. This is an operator write, never replay.
 */
export function resetReplayEpoch(store: Store): void { store.set(EPOCH_KEY, randomUUID()); }
const encode = (frame: Frame): string => Buffer.from(JSON.stringify(frame)).toString("base64url");
const bytes = (value: unknown): number => Buffer.byteLength(JSON.stringify(value), "utf8");
function bounded(value: number | undefined, fallback: number, min: number, max: number): number {
  const n = value ?? fallback;
  if (!Number.isSafeInteger(n) || n < min || n > max) fail("CURSOR_INVALID", "Replay bounds are invalid");
  return n;
}

/** Caller MUST wrap this query in its actual held-lease read operation; visibility is checked again here. */
export function replayQuery(store: Store, mailbox: string, options: ReplayOptions,
  visible: (row: MessageRow) => boolean, projectHost: (row: MessageRow) => string,
  project: (row: MessageRow) => MessageRow): ReplayPage {
  const limit = bounded(options.limit, 50, 1, 200), maxBytes = bounded(options.maxBytes, 65536, 2048, 262144);
  const scanLimit = bounded(options.scanLimit, 1000, 1, 2000);
  const filterValues = [options.project, options.project_host, options.topic, options.thread];
  if (filterValues.some(v => v !== undefined && (typeof v !== "string" || !v.length || v.length > 300)))
    fail("CURSOR_INVALID", "Replay filters are invalid");
  if (options.project !== undefined && options.project_host === undefined)
    fail("CURSOR_INVALID", "Project replay requires an exact sender host");
  const filter = createHash("sha256").update(JSON.stringify(filterValues.map(v => v ?? null))).digest("hex");
  return store.readTx(() => {
    const epoch = store.get(EPOCH_KEY);
    if (!epoch) fail("CURSOR_EXPIRED", "Replay generation is unavailable; initialize this store before replay");
    // Pruned positions still count as history: a cursor past them stays valid and AUTOINCREMENT never reuses them.
    const maximum = Math.max(Number(store.db.prepare("SELECT COALESCE(MAX(seq),0) n FROM mailbox_visibility WHERE mailbox=?").get(mailbox)!.n),
      Number(store.db.prepare("SELECT COALESCE(MAX(seq),0) n FROM mailbox_pruned WHERE mailbox=?").get(mailbox)!.n));
    if (!Number.isSafeInteger(maximum) || maximum < 0) fail("CURSOR_INVALID", "Replay history exceeds supported bounds");
    let frame: Frame = { v: 1, epoch: epoch!, mailbox, filter, position: 0, end: maximum };
    if (options.cursor !== undefined) {
      if (typeof options.cursor !== "string" || options.cursor.length > 2048 || !/^[A-Za-z0-9_-]+$/.test(options.cursor))
        fail("CURSOR_INVALID", "Replay cursor is invalid");
      let decoded: unknown;
      try {
        const data = Buffer.from(options.cursor, "base64url");
        if (data.toString("base64url") !== options.cursor) fail("CURSOR_INVALID", "Replay cursor is invalid");
        decoded = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(data));
      } catch { fail("CURSOR_INVALID", "Replay cursor is invalid"); }
      const f = decoded as Frame;
      if (!f || typeof f !== "object" || Array.isArray(f) || Object.keys(f).sort().join(",") !== "end,epoch,filter,mailbox,position,v"
        || f.v !== 1 || typeof f.epoch !== "string" || typeof f.mailbox !== "string" || typeof f.filter !== "string"
        || !Number.isSafeInteger(f.position) || !Number.isSafeInteger(f.end) || f.position < 0 || f.end < f.position)
        fail("CURSOR_INVALID", "Replay cursor is invalid");
      if (f.mailbox !== mailbox || f.filter !== filter) fail("CURSOR_SCOPE_MISMATCH", "Replay cursor belongs to a different mailbox or filter");
      if (f.epoch !== epoch) fail("CURSOR_EXPIRED", "Replay generation changed; restart history explicitly");
      if (f.end > maximum) fail("CURSOR_INVALID", "Replay cursor exceeds available history");
      frame = { ...f };
      // A completed frame is an explicit poll for a fresh finite snapshot.
      if (frame.position === frame.end) frame.end = maximum;
    }
    const rows = store.db.prepare(`SELECT v.seq,v.message_id FROM mailbox_visibility v
      WHERE v.mailbox=? AND v.seq>? AND v.seq<=? ORDER BY v.seq LIMIT ?`)
      .all(mailbox, frame.position, frame.end, scanLimit) as unknown as { seq: number; message_id: string }[];
    const messages: ReplayItem[] = [], start = frame.position;
    // Retention gaps are never silent: count pruned positions in the interval this page covers.
    const prunedIn = (to: number) => Number(store.db.prepare("SELECT count(*) n FROM mailbox_pruned WHERE mailbox=? AND seq>? AND seq<=?").get(mailbox, start, to)!.n);
    const gap = prunedIn(frame.end) > 0;
    const page = (position: number): ReplayPage => {
      const pruned = gap ? prunedIn(position) : 0;
      return { messages, next_cursor: encode({ ...frame, position }), has_more: position < frame.end, ...(pruned ? { history_pruned: pruned } : {}) };
    };
    // Reserve the longest remaining position and boolean representation, including hidden scan progress.
    const budgetBytes = (): number => bytes({ messages, next_cursor: encode({ ...frame, position: frame.end }), has_more: false, ...(gap ? { history_pruned: frame.end } : {}) });
    for (const row of rows) {
      const { seq } = row;
      const message = store.db.prepare("SELECT * FROM messages WHERE id=?").get(row.message_id) as unknown as MessageRow | undefined;
      if (!message || !visible(message)) { frame.position = seq; continue; }
      const e = JSON.parse(message.envelope) as { meta?: { project?: string; tags?: string[] } };
      const matches = (options.thread === undefined || message.thread === options.thread)
        && (options.project_host === undefined || projectHost(message) === options.project_host)
        && (options.project === undefined || e.meta?.project === options.project)
        && (options.topic === undefined || e.meta?.tags?.includes(options.topic) === true);
      if (!matches) { frame.position = seq; continue; }
      const item = project(message);
      messages.push(item);
      if (budgetBytes() > maxBytes) {
        messages.pop();
        if (messages.length) break;
        messages.push({ id: message.id, content_omitted: true, reason: "REPLAY_ITEM_TOO_LARGE" });
        if (budgetBytes() > maxBytes) fail("CURSOR_INVALID", "Replay byte budget cannot contain item metadata");
      }
      frame.position = seq;
      if (messages.length === limit) break;
    }
    // No row exists in the remaining sparse interval: safely finish this snapshot.
    if (rows.length < scanLimit && (rows.length === 0 || frame.position === rows.at(-1)!.seq)) frame.position = frame.end;
    return page(frame.position);
  });
}
