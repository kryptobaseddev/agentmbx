// Conversation external taint (T345). The CLI reads it when sending. The MCP server
// persists it on noteRead after #120 merges, and release/claim restore it (T346).
import { EXTERNAL_TAINT_MS, MAX_RELAY_DEPTH, type ExternalExposure } from "./envelope.ts";
import type { Store } from "./store.ts";

const LABEL = /^[^\u0000-\u001f\u007f]{1,300}$/;
const CAUSE = /^[^\u0000-\u001f\u007f]{1,300}$/;
const ID = /^[A-Za-z0-9_-]{1,80}$/;
const HOWS = new Set<ExternalExposure["how"]>(["declared", "inherited", "legacy", "malformed"]);
const MAX_HOPS = 500;

/** One still-live agent-to-agent exposure. Release and claim restore this list (T346). */
export interface SessionTaintHop { hop: number; from: string; at: number }

/**
 * The live outside exposure for one conversation. `relay_depth` is that conversation's
 * hop history, not a single counter: a co-using sibling shares this same record.
 */
export interface SessionTaint {
  v: 1;
  cli: string;
  session_id: string;
  /** Root exposure, epoch milliseconds. The record is live while now - root < EXTERNAL_TAINT_MS. */
  root: number;
  from: string;
  id: string;
  how: ExternalExposure["how"];
  relay_depth: SessionTaintHop[];
}

/**
 * Kv key `taint:<cli>:<session_id>`. Either part may contain a colon; both are encoded
 * so `a:b` + `c` and `a` + `b:c` are different keys.
 */
export function taintKey(cli: string, sessionId: string): string {
  if (!LABEL.test(cli) || !LABEL.test(sessionId)) throw Object.assign(new Error("taint key needs a cli and session id"), { code: "TAINT_KEY" });
  return `taint:${encodeURIComponent(cli)}:${encodeURIComponent(sessionId)}`;
}

const liveAt = (at: number, now: number): boolean => Number.isSafeInteger(at) && at <= now && now - at < EXTERNAL_TAINT_MS;

function hopsOf(value: unknown, now: number): SessionTaintHop[] | null {
  if (!Array.isArray(value)) return null;
  const hops: SessionTaintHop[] = [];
  for (const item of value.slice(-MAX_HOPS)) {
    if (!item || typeof item !== "object") return null;
    const hop = item as Record<string, unknown>;
    if (typeof hop.hop !== "number" || !Number.isInteger(hop.hop) || hop.hop < 0 || hop.hop > MAX_RELAY_DEPTH) return null;
    if (typeof hop.from !== "string" || !CAUSE.test(hop.from) || typeof hop.at !== "number") return null;
    if (liveAt(hop.at, now)) hops.push({ hop: hop.hop, from: hop.from, at: hop.at });
  }
  return hops;
}

function normalize(value: unknown, cli: string, sessionId: string, now: number): SessionTaint | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  if (row.v !== 1 || row.cli !== cli || row.session_id !== sessionId) return null;
  if (typeof row.root !== "number" || !liveAt(row.root, now)) return null;
  if (typeof row.from !== "string" || !CAUSE.test(row.from) || typeof row.id !== "string" || !ID.test(row.id)) return null;
  if (typeof row.how !== "string" || !HOWS.has(row.how as ExternalExposure["how"])) return null;
  const relay_depth = hopsOf(row.relay_depth, now);
  if (!relay_depth) return null;
  return { v: 1, cli, session_id: sessionId, root: row.root, from: row.from, id: row.id, how: row.how as ExternalExposure["how"], relay_depth };
}

/** The conversation's live taint, or null when the key is missing, malformed, or an hour past its root. */
export function readSessionTaint(store: Store, cli: string, sessionId: string, now = Date.now()): SessionTaint | null {
  let key: string;
  try { key = taintKey(cli, sessionId); } catch { return null; }
  const raw = store.get(key);
  if (raw === undefined) return null;
  try { return normalize(JSON.parse(raw), cli, sessionId, now); } catch { return null; }
}

/** Approval must distinguish absent/valid expired state from corrupt or unreadable taint. */
export function sessionUntainted(store: Store, cli: string, sessionId: string, now = Date.now()): boolean {
  try {
    const raw = store.get(taintKey(cli, sessionId));
    if (raw === undefined) return true;
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== "object") return false;
    const root = (value as { root?: unknown }).root;
    if (typeof root !== "number" || !Number.isSafeInteger(root) || root > now) return false;
    // Validate the expired record at its root instead of treating every malformed record as expired.
    return now - root >= EXTERNAL_TAINT_MS && normalize(value, cli, sessionId, root) !== null;
  } catch { return false; }
}

/** Write a live record. An expired root deletes the key. Anything else that is not live throws and leaves the old value. */
export function writeSessionTaint(store: Store, record: SessionTaint, now = Date.now()): void {
  const key = taintKey(record.cli, record.session_id);
  if (record.v === 1 && Number.isSafeInteger(record.root) && record.root <= now && now - record.root >= EXTERNAL_TAINT_MS) {
    store.db.prepare("DELETE FROM kv WHERE k=?").run(key);
    return;
  }
  const normalized = normalize(record, record.cli, record.session_id, now);
  if (!normalized) throw Object.assign(new Error("taint record is not a live session exposure"), { code: "TAINT_RECORD" });
  store.set(key, JSON.stringify(normalized));
}

const iso = (t: number): string => new Date(t).toISOString();

/** CLI refusal: `--origin agent` must not send while this conversation is tainted. */
export function refuseAgentOrigin(taint: SessionTaint): string {
  return `--origin agent refused: this session read ${taint.id} from ${taint.from}; sends stay external until ${iso(taint.root + EXTERNAL_TAINT_MS)}`;
}

/** Same facts the MCP send warning reports, for a CLI send that inherited the stored root. */
export function taintSendWarning(taint: SessionTaint): string {
  return `sent with origin external because this session read outside content: recipients may only read it under owner policy (no edit or outward). This session's sends stay external until ${iso(taint.root + EXTERNAL_TAINT_MS)}, an hour after its root exposure at ${iso(taint.root)}: you read ${taint.id} from ${taint.from}. Neither this tainted session nor recipients acting on this message may use outward-reversible.`;
}

/** A sender that passed `--origin external` declares the body first-hand, even when a taint is also live. */
export function declaredOriginWarning(taint: SessionTaint | null): string {
  const base = "sent with origin external, as you declared: recipients may only read it under owner policy (no edit or outward), and reading it makes their own sends external for 1 h. Recipients acting on this message may not use outward-reversible, nor may a session tainted by reading it.";
  if (!taint) return base;
  return `${base} This session's sends stay external until ${iso(taint.root + EXTERNAL_TAINT_MS)}, an hour after its root exposure at ${iso(taint.root)}: you read ${taint.id} from ${taint.from}.`;
}
