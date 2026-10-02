// Cross-host delivery receipts (T218, epic T214). A message sent to an agent on a paired host used to end, for its sender,
// at "handed-over": the other host's daemon knew whether the agent got it, read it and acted on it, but nobody told the
// sender. Now every delivery state change of a remote-origin message is queued (by a trigger on deliveries, so every path
// that moves a delivery is covered, old runtimes included) and pushed back to the sending host as a receipt signed by
// this host's key. The record is the relay receipt envelope agreed for T164, so the relay carries the same bytes.
import { z } from "zod";
import { canonical, signData, verifyData } from "./crypto.ts";
import { NAME_RE } from "./envelope.ts";
import { DID_MAX, RETRY_HOURS, type MbxNode } from "./node.ts";

export const RECEIPT_STATES = ["delivered", "notified", "read", "acked"] as const;
export type ReceiptState = typeof RECEIPT_STATES[number];
const rank = (s: string) => RECEIPT_STATES.indexOf(s as ReceiptState);
/** One message can't fan out into more receipt rows than this per host (a paired host can't grow our table at will). */
export const MAX_RECIPIENTS_PER_HOST = 200;
export const RECEIPT_BATCH = 200;
const HOST_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/;

export const ReceiptRecord = z.object({
  v: z.literal(1), type: z.literal("receipt"), msg: z.string().min(10).max(40),
  recipient: z.string().max(104).refine((a) => { const [n, h, ...rest] = a.split("@"); return !rest.length && (n === "owner" || NAME_RE.test(n)) && HOST_RE.test(h ?? ""); }, "recipient must be name@host"),
  state: z.enum(RECEIPT_STATES), at: z.string().datetime(), note: z.string().max(500).optional(), did: z.string().max(DID_MAX).optional(),
  seq: z.number().int().positive(),
}).strict();
export type ReceiptRecord = z.infer<typeof ReceiptRecord>;
export interface SignedReceipt { rec: ReceiptRecord; sig: string }

interface OutRow { seq: number; msg_id: string; agent: string; host: string; state: string; note: string | null; at: string; attempts: number }

/** The did line the recipient recorded when it acked (audit peer_action), if any. */
function didFor(node: MbxNode, msg: string, agent: string): string | undefined {
  const r = node.store.db.prepare(`SELECT json_extract(detail,'$.did') d FROM audit WHERE event='peer_action'
    AND json_extract(detail,'$.msg')=? AND json_extract(detail,'$.recipient')=? ORDER BY at DESC LIMIT 1`).get(msg, agent) as { d: string | null } | undefined;
  return r?.d ? r.d.slice(0, DID_MAX) : undefined;
}

/** Build and sign the receipt for one queued row. */
export function signReceipt(node: MbxNode, row: Pick<OutRow, "seq" | "msg_id" | "agent" | "state" | "note" | "at">): SignedReceipt {
  const did = row.state === "acked" ? didFor(node, row.msg_id, row.agent) : undefined;
  const rec = ReceiptRecord.parse({ v: 1, type: "receipt", msg: row.msg_id, recipient: `${row.agent}@${node.host}`, state: row.state, at: row.at,
    ...(row.note ? { note: row.note.slice(0, 500) } : {}), ...(did ? { did } : {}), seq: row.seq });
  return { rec, sig: signData(node.key.privateKey, canonical(rec)) };
}

/** Due receipts, oldest first, grouped by the host they are owed to. Rows past RETRY_HOURS are dropped (receipts are advisory). */
export function dueReceipts(node: MbxNode, now = Date.now()): Map<string, OutRow[]> {
  const expired = node.store.db.prepare("DELETE FROM receipt_outbox WHERE at < ?").run(new Date(now - RETRY_HOURS * 3_600_000).toISOString()).changes;
  if (expired) node.store.audit("receipt.expired", { count: Number(expired), hours: RETRY_HOURS });
  const rows = node.store.db.prepare("SELECT seq,msg_id,agent,host,state,note,at,attempts FROM receipt_outbox WHERE next_at <= ? ORDER BY seq LIMIT ?")
    .all(new Date(now).toISOString(), RECEIPT_BATCH * 5) as unknown as OutRow[];
  const by = new Map<string, OutRow[]>();
  for (const r of rows) { const list = by.get(r.host) ?? []; if (list.length < RECEIPT_BATCH) by.set(r.host, [...list, r]); }
  return by;
}

export const receiptsSent = (node: MbxNode, seqs: number[]) => {
  for (const s of seqs) node.store.db.prepare("DELETE FROM receipt_outbox WHERE seq=?").run(s);
};

/** Back off after a failed push; an older peer without the endpoint is retried hourly until its receipts expire. */
export function receiptsDeferred(node: MbxNode, host: string, error: string, now = Date.now(), unsupported = false) {
  const rows = node.store.db.prepare("SELECT seq,attempts FROM receipt_outbox WHERE host=? AND next_at <= ?").all(host, new Date(now).toISOString()) as { seq: number; attempts: number }[];
  for (const r of rows) {
    const wait = unsupported ? 3_600_000 : Math.min(5_000 * 2 ** r.attempts, 3_600_000);
    node.store.db.prepare("UPDATE receipt_outbox SET attempts=attempts+1, next_at=?, last_error=? WHERE seq=?").run(new Date(now + wait).toISOString(), error.slice(0, 300), r.seq);
  }
}

export type AcceptResult = "accepted" | "duplicate" | "stale" | `rejected:${string}`;

/**
 * Apply one receipt a paired host sent for a message this host sent. `hop` is the host the request came from (LAN): it
 * must be the recipient's host. The signature is checked against that host's pinned key either way, so a relay that
 * forwards the record can't change it. Receipts apply by state rank, then seq; anything else is a duplicate or stale.
 */
export function acceptReceipt(node: MbxNode, item: unknown, hop: string | null): AcceptResult {
  const it = item as { rec?: unknown; sig?: unknown } | null;
  const parsed = ReceiptRecord.safeParse(it?.rec);
  if (!parsed.success || typeof it?.sig !== "string" || it.sig.length > 200) return "rejected:invalid receipt";
  const rec = parsed.data, host = rec.recipient.split("@")[1];
  if (hop !== null && host !== hop) return `rejected:receipt for ${rec.recipient} did not come from ${host}`;
  const peer = node.approvedPeer(host);
  if (!peer) return `rejected:${host} is not a paired host`;
  if (!verifyData(peer.pubkey, canonical(rec), it.sig)) return "rejected:bad signature";
  const m = node.store.db.prepare("SELECT origin FROM messages WHERE id=?").get(rec.msg) as { origin: string } | undefined;
  if (!m || m.origin !== "local") return "rejected:not a message this host sent";
  return node.store.tx((): AcceptResult => {
    const old = node.store.db.prepare("SELECT state,seq FROM remote_receipts WHERE msg_id=? AND recipient=?").get(rec.msg, rec.recipient) as { state: string; seq: number } | undefined;
    if (old) {
      if (old.state === rec.state && old.seq === rec.seq) return "duplicate";
      if (rank(rec.state) < rank(old.state) || (rank(rec.state) === rank(old.state) && rec.seq <= old.seq)) return "stale";
    } else {
      const n = Number((node.store.db.prepare("SELECT COUNT(*) n FROM remote_receipts WHERE msg_id=? AND recipient LIKE ?").get(rec.msg, `%@${host}`) as { n: number }).n);
      if (n >= MAX_RECIPIENTS_PER_HOST) return "rejected:too many recipients for one message";
    }
    node.store.db.prepare(`INSERT INTO remote_receipts (msg_id,recipient,state,at,note,did,seq,record,sig,received_at) VALUES (?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(msg_id,recipient) DO UPDATE SET state=excluded.state, at=excluded.at, note=excluded.note, did=excluded.did, seq=excluded.seq,
        record=excluded.record, sig=excluded.sig, received_at=excluded.received_at`)
      .run(rec.msg, rec.recipient, rec.state, rec.at, rec.note ?? null, rec.did ?? null, rec.seq, JSON.stringify(rec), it.sig as string, new Date().toISOString());
    return "accepted";
  });
}

export interface RemoteReceiptRow { recipient: string; state: ReceiptState; at: string; note: string | null; did: string | null }
/** What paired hosts reported for a message this host sent, one row per remote recipient. */
export const remoteReceipts = (node: MbxNode, msgId: string): RemoteReceiptRow[] =>
  node.store.db.prepare("SELECT recipient,state,at,note,did FROM remote_receipts WHERE msg_id=? ORDER BY recipient").all(msgId) as unknown as RemoteReceiptRow[];
