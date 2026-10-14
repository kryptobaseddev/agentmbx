// Daemon sync client (T262, T468, T446). One POST writer, one seq per host. No network call
// unless a local link record exists, and no bearer token. A SyncAck never turns project_paths on.
// An in-range SyncAck stores the cloud's contract range, clamped to CONTRACT_VERSION and never
// below the contract just spoken. A stored max of at least 2 sets project_leads. An out-of-range
// ack whose range overlaps contracts 1..CONTRACT_VERSION stores that clamped range and leaves
// project_leads set. A range that does not overlap, such as {3,4}, does not change the link.
import { createHash, randomBytes } from "node:crypto";
import {
  CONTRACT_VERSION, PATH_FLAG_PREFIX, PROJECT_LEADS_SINCE, PROJECT_PATHS_SINCE, REPO_SINCE, projectSync, type Projection, type SyncSnapshot,
} from "./sync-projection.ts";

export const LINK_KEY = "sync.link";
export const STATE_KEY = "sync.state";
export { PATH_FLAG_PREFIX };

export interface SyncLink {
  v: 1;
  sync_url: string;
  contract: { min: number; max: number };
  /** Set by local enrolment when the spoken schema lists HostReport.project_paths. Never by a SyncAck. */
  project_paths?: boolean;
  /** Set when an in-range SyncAck stores a contract max >= 2. A later lower ack leaves it set; it is ignored below contract 2. A SyncAck never sets project_paths. */
  project_leads?: boolean;
}

interface Pending { seq: number; body: string; receiptKeys: string[]; snapshotHash: string }

interface SyncState {
  ack_seq: number;
  next_at: number;
  attempt: number;
  pending?: Pending;
  snapshot_hash?: string;
  force_full?: boolean;
  sent_receipts: string[];
  floor_seconds: number;
  acked_at?: string;
}

export interface Kv { get(k: string): string | undefined; set(k: string, v: string): void }

/** Signs one POST attempt. `timestamp` and `nonce` run at send time, including a retry of a stored body. */
export interface SyncSigner {
  hostId: string;
  /** Scheme, host, and port only. No path and no trailing slash. */
  apiOrigin: string;
  /** Ed25519 signature of the exact UTF-8 string, standard base64. */
  sign(message: string): string;
  /** Unix seconds. */
  timestamp(): number;
  /** 32 random bytes, base64url. */
  nonce(): string;
}

/** The bytes the cloud verifies. No trailing newline. */
export function syncPopString(input: { apiOrigin: string; hostId: string; body: string; timestamp: string; nonce: string }): string {
  const hash = createHash("sha256").update(input.body).digest("hex");
  return [
    "agentmbx-sync-pop-v1",
    input.apiOrigin,
    input.hostId,
    "POST",
    "/v1/host/sync",
    hash,
    input.timestamp,
    input.nonce,
  ].join("\n");
}

/** 32 random bytes as base64url. A new value on every call. */
export function newSyncNonce(): string {
  return randomBytes(32).toString("base64url");
}

export interface SyncDeps {
  kv: Kv;
  fetch: typeof fetch;
  now: number;
  /** Called only when a new batch will be sent. Not called when unlinked, waiting, or resending. */
  source: (ctx: { now: string; seq: number; full: boolean; contract: number; contractAllowsProjectPaths: boolean; contractAllowsProjectLeads: boolean; contractAllowsRepo: boolean; sentReceipts: string[]; lastAck?: string | null }) => Omit<SyncSnapshot, "now" | "seq" | "full" | "contract" | "contractAllowsProjectPaths" | "contractAllowsProjectLeads" | "contractAllowsRepo" | "sentReceipts">;
  signer?: SyncSigner;
  audit?: (event: string, detail: Record<string, string | number | boolean>) => void;
}

export type SyncResult =
  | { outcome: "unlinked" }
  | { outcome: "sync.contract" }
  | { outcome: "wait"; next_at: number }
  | { outcome: "sync.cap" }
  | { outcome: "sync.withheld" }
  | { outcome: "acked"; seq: number }
  | { outcome: "retry"; seq: number }
  | { outcome: "sync.rejected"; seq: number };

export function readLink(get: Kv["get"]): SyncLink | null {
  const raw = get(LINK_KEY);
  if (!raw) return null;
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return null; }
  if (!parsed || typeof parsed !== "object") return null;
  const l = parsed as Partial<SyncLink>;
  if (l.v !== 1 || typeof l.sync_url !== "string" || !l.sync_url) return null;
  if (!l.contract || typeof l.contract.min !== "number" || typeof l.contract.max !== "number") return null;
  return { v: 1, sync_url: l.sync_url, contract: { min: l.contract.min, max: l.contract.max },
    ...(l.project_paths === true ? { project_paths: true } : {}), ...(l.project_leads === true ? { project_leads: true } : {}) };
}

function blank(): SyncState {
  return { ack_seq: 0, next_at: 0, attempt: 0, sent_receipts: [], floor_seconds: 5 };
}

function readState(get: Kv["get"]): SyncState {
  const raw = get(STATE_KEY);
  if (!raw) return blank();
  try {
    const s = JSON.parse(raw) as Partial<SyncState>;
    return {
      ack_seq: typeof s.ack_seq === "number" ? s.ack_seq : 0,
      next_at: typeof s.next_at === "number" ? s.next_at : 0,
      attempt: typeof s.attempt === "number" ? s.attempt : 0,
      ...(s.pending && typeof s.pending.body === "string" && typeof s.pending.seq === "number"
        ? { pending: { seq: s.pending.seq, body: s.pending.body, receiptKeys: Array.isArray(s.pending.receiptKeys) ? s.pending.receiptKeys.filter((x) => typeof x === "string") : [], snapshotHash: typeof s.pending.snapshotHash === "string" ? s.pending.snapshotHash : "" } }
        : {}),
      ...(typeof s.snapshot_hash === "string" ? { snapshot_hash: s.snapshot_hash } : {}),
      ...(s.force_full ? { force_full: true } : {}),
      sent_receipts: Array.isArray(s.sent_receipts) ? s.sent_receipts.filter((x) => typeof x === "string") : [],
      floor_seconds: typeof s.floor_seconds === "number" ? s.floor_seconds : 5,
    };
  } catch { return blank(); }
}

function writeState(kv: Kv, state: SyncState): void {
  kv.set(STATE_KEY, JSON.stringify(state));
}

function spoken(link: SyncLink): number | null {
  const high = Math.min(CONTRACT_VERSION, link.contract.max);
  if (high < link.contract.min || high < 1) return null;
  return high;
}

export function postUrl(syncUrl: string): string {
  if (syncUrl.startsWith("wss://")) return `https://${syncUrl.slice(6)}`;
  if (syncUrl.startsWith("ws://")) return `http://${syncUrl.slice(5)}`;
  return syncUrl;
}

function backoffMs(attempt: number, floorSeconds: number): number {
  const seconds = Math.min(300, Math.max(5, floorSeconds) * 2 ** Math.max(0, attempt - 1));
  return seconds * 1000;
}

function retryAfterMs(header: string | null, now: number): number | null {
  if (!header) return null;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const at = Date.parse(header);
  if (Number.isFinite(at)) return Math.max(0, at - now);
  return null;
}

function clampSeconds(n: unknown, fallback: number): number {
  const v = typeof n === "number" ? n : fallback;
  if (!Number.isFinite(v)) return fallback;
  return Math.min(300, Math.max(5, Math.floor(v)));
}

export async function syncOnce(o: SyncDeps): Promise<SyncResult> {
  const link = readLink(o.kv.get.bind(o.kv));
  if (!link) return { outcome: "unlinked" };
  const contract = spoken(link);
  if (contract === null) {
    o.audit?.("sync.contract", { code: "sync.contract" });
    return { outcome: "sync.contract" };
  }
  const state = readState(o.kv.get.bind(o.kv));
  if (o.now < state.next_at) return { outcome: "wait", next_at: state.next_at };
  let pending = state.pending;
  if (!pending) {
    const seq = state.ack_seq + 1;
    const allowsPaths = contract >= PROJECT_PATHS_SINCE && link.project_paths === true;
    const allowsLeads = contract >= PROJECT_LEADS_SINCE && link.project_leads === true;
    const allowsRepo = contract >= REPO_SINCE;
    const sentAt = new Date(o.now).toISOString();
    const snap = o.source({ now: sentAt, seq, full: true, contract, contractAllowsProjectPaths: allowsPaths, contractAllowsProjectLeads: allowsLeads, contractAllowsRepo: allowsRepo, sentReceipts: state.sent_receipts, lastAck: state.acked_at ?? null });
    const common = { ...snap, now: sentAt, seq, contract, contractAllowsProjectPaths: allowsPaths, contractAllowsProjectLeads: allowsLeads, contractAllowsRepo: allowsRepo, sentReceipts: state.sent_receipts };
    const fullTry: Projection = projectSync({ ...common, full: true });
    if (!fullTry.ok) {
      state.next_at = o.now + 15_000;
      writeState(o.kv, state);
      o.audit?.(fullTry.code, { code: fullTry.code });
      return { outcome: fullTry.code };
    }
    const changed = state.force_full === true || !state.snapshot_hash || fullTry.snapshotHash !== state.snapshot_hash || fullTry.receiptKeys.length > 0;
    const projected = changed ? fullTry : projectSync({ ...common, full: false });
    if (!projected.ok) {
      state.next_at = o.now + 15_000;
      writeState(o.kv, state);
      o.audit?.(projected.code, { code: projected.code });
      return { outcome: projected.code };
    }
    pending = { seq, body: projected.body, receiptKeys: projected.receiptKeys, snapshotHash: fullTry.snapshotHash };
    state.pending = pending;
    state.force_full = false;
    writeState(o.kv, state);
  }
  return send(o, link, state, pending);
}

function withoutStatus(body: string): string | null {
  try {
    const parsed = JSON.parse(body) as { host?: { status?: unknown } };
    if (!parsed.host || !Object.prototype.hasOwnProperty.call(parsed.host, "status")) return null;
    delete parsed.host.status;
    return JSON.stringify(parsed);
  } catch { return null; }
}

async function send(o: SyncDeps, link: SyncLink, state: SyncState, pending: Pending): Promise<SyncResult> {
  const signer = o.signer;
  if (!signer) return { outcome: "unlinked" };
  const timestamp = String(signer.timestamp());
  const nonce = signer.nonce();
  const message = syncPopString({ apiOrigin: signer.apiOrigin, hostId: signer.hostId, body: pending.body, timestamp, nonce });
  let res: Response;
  try {
    res = await o.fetch(postUrl(link.sync_url), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "X-MBX-Host-Id": signer.hostId,
        "X-MBX-Timestamp": timestamp,
        "X-MBX-Nonce": nonce,
        "X-MBX-Signature": signer.sign(message),
      },
      body: pending.body,
    });
  } catch {
    state.attempt += 1;
    state.next_at = o.now + backoffMs(state.attempt, state.floor_seconds);
    writeState(o.kv, state);
    return { outcome: "retry", seq: pending.seq };
  }
  if (res.status === 401 || res.status === 409 || res.status === 429 || res.status >= 500) {
    return recover(o, state, pending, res);
  }
  if (res.status < 200 || res.status >= 300) {
    if (res.status === 400) {
      const stripped = withoutStatus(pending.body);
      if (stripped) {
        pending.body = stripped;
        state.pending = pending;
        writeState(o.kv, state);
        return send(o, link, state, pending);
      }
    }
    state.attempt += 1;
    state.next_at = o.now + backoffMs(state.attempt, state.floor_seconds);
    writeState(o.kv, state);
    o.audit?.("sync.rejected", { code: "sync.rejected", seq: pending.seq });
    return { outcome: "sync.rejected", seq: pending.seq };
  }
  let ack: { ack_seq?: unknown; next_sync_seconds?: unknown; commands?: unknown; contract?: { min?: unknown; max?: unknown } } = {};
  try { ack = await res.json() as typeof ack; } catch { ack = {}; }
  refusePathCommands(o, ack.commands);
  if (ack.ack_seq !== pending.seq) {
    state.attempt += 1;
    state.next_at = o.now + backoffMs(state.attempt, state.floor_seconds);
    writeState(o.kv, state);
    return { outcome: "retry", seq: pending.seq };
  }
  const wait = clampSeconds(ack.next_sync_seconds, 15);
  state.ack_seq = pending.seq;
  state.acked_at = new Date(Number(timestamp) * 1000).toISOString();
  state.pending = undefined;
  state.attempt = 0;
  state.floor_seconds = wait;
  state.next_at = o.now + wait * 1000;
  state.snapshot_hash = pending.snapshotHash;
  state.sent_receipts = [...new Set([...state.sent_receipts, ...pending.receiptKeys])];
  const range = ack.contract;
  const sent = sentContract(pending.body);
  // Compare the contract this batch spoke, not CONTRACT_VERSION. A link capped at 1
  // speaks 1, and an old cloud that acks max 1 still accepts that batch.
  // An out-of-range ack that still overlaps a contract this daemon can speak follows
  // the cloud, so the next batch is inside the range. Anything else stays put.
  if (range && typeof range.min === "number" && typeof range.max === "number" && sent !== null && (sent < range.min || sent > range.max)) {
    state.force_full = true;
    writeState(o.kv, state);
    rememberAck(o.kv, sent, range, true);
    o.audit?.("sync.contract", { code: "sync.contract" });
    return { outcome: "sync.contract" };
  }
  rememberAck(o.kv, sent, range);
  writeState(o.kv, state);
  o.audit?.("sync.batch", { seq: pending.seq, outcome: "acked" });
  return { outcome: "acked", seq: pending.seq };
}

function sentContract(body: string): number | null {
  try {
    const n = (JSON.parse(body) as { contract?: unknown }).contract;
    return typeof n === "number" ? n : null;
  } catch { return null; }
}

/** Store an ack's contract. An in-range ack never excludes the contract just spoken. An overlapping out-of-range ack follows the cloud. Never writes project_paths, and never clears project_leads. */
function rememberAck(kv: Kv, sent: number | null, range: { min?: unknown; max?: unknown } | undefined, followCloud = false): void {
  if (!range || typeof range.min !== "number" || typeof range.max !== "number") return;
  if (!Number.isInteger(range.min) || !Number.isInteger(range.max) || range.min < 1 || range.min > range.max) return;
  const max = Math.min(range.max, CONTRACT_VERSION);
  const min = range.min;
  const overlaps = range.max >= 1 && range.min <= CONTRACT_VERSION;
  if (followCloud) {
    if (!overlaps) return;
  } else if (sent === null || max < sent || min > sent) {
    return;
  }
  const raw = kv.get(LINK_KEY);
  if (!raw) return;
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return; }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return;
  const stored = parsed as Record<string, unknown>;
  stored.contract = { min, max };
  if (max >= PROJECT_LEADS_SINCE) stored.project_leads = true;
  kv.set(LINK_KEY, JSON.stringify(stored));
}

function refusePathCommands(o: SyncDeps, commands: unknown): void {
  const text = JSON.stringify(commands ?? null);
  if (!text.includes(PATH_FLAG_PREFIX) && !text.includes("local_path") && !text.includes("project_paths") && !text.includes("project_leads")) return;
  o.audit?.("sync.command", { code: "OP_NOT_ALLOWED_FROM_CONSOLE" });
}

async function recover(o: SyncDeps, state: SyncState, pending: Pending, res: Response): Promise<SyncResult> {
  if (res.status === 409) {
    let ackSeq = state.ack_seq;
    try {
      const body = await res.json() as { ack_seq?: unknown };
      if (typeof body.ack_seq === "number") ackSeq = body.ack_seq;
    } catch { /* keep the last ack */ }
    state.ack_seq = ackSeq;
    state.pending = undefined;
    state.force_full = true;
    state.snapshot_hash = undefined;
    state.attempt = 0;
    state.next_at = o.now;
    writeState(o.kv, state);
    return { outcome: "retry", seq: pending.seq };
  }
  const headerWait = retryAfterMs(res.headers.get("retry-after"), o.now);
  state.attempt += 1;
  const exp = backoffMs(state.attempt, state.floor_seconds);
  const floorMs = Math.min(300, Math.max(5, state.floor_seconds)) * 1000;
  // Retry-After replaces the exponential, but a wait never runs faster than the last next_sync_seconds, and never longer than 300s.
  state.next_at = o.now + (headerWait == null ? exp : Math.min(300_000, Math.max(headerWait, floorMs)));
  writeState(o.kv, state);
  return { outcome: "retry", seq: pending.seq };
}
