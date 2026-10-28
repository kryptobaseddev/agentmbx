// Conversation external taint (T345). The CLI reads it when sending. The MCP server
// persists it on noteRead after #120 merges, and release/claim restore it (T346).
import { EXTERNAL_TAINT_MS, MAX_RELAY_DEPTH, MAX_CONTENT_ROOTS, readContentProvenance, validContentRoot, type ContentRoot, type ProvenanceSources, type ExternalExposure, type Envelope } from "./envelope.ts";
import { canonical, fingerprint, ulid, verifyData } from "./crypto.ts";
import { killSwitchSince, ownerKeys, type Signed } from "./policy.ts";
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

/** Durable source lineage and first local raw/derived disclosure times; persona and transport are not keys. */
export interface SessionExposure {
  v: 2;
  host: string;
  cli: string;
  session_id: string;
  generation: number;
  unknown: boolean;
  roots: { source: ContentRoot; first_raw_at: number | null; raw_at: number | null; derived_at: number | null; last_message_id: string; last_read_at: number }[];
}
/** No record, legacy state and failed reads are unknown; callers must not interpret null as clean. */
export interface SessionExposureRead { record: SessionExposure | null; reason: string | null }
const exposureScope = (host: string, cli: string, sessionId: string) => [host, cli, sessionId].every(part => typeof part === "string" && LABEL.test(part) && !/[\u0000-\u001f\u007f]/.test(part));
const exposureTime = (at: unknown, now: number) => at === null || (typeof at === "number" && Number.isSafeInteger(at) && at >= 0 && at <= now);

/** Read observation-only history without expiring or declassifying any source. */
export function readSessionExposure(store: Store, host: string, cli: string, sessionId: string, now = Date.now()): SessionExposureRead {
  try {
    if (!exposureScope(host, cli, sessionId) || !Number.isSafeInteger(now) || now < 0) throw new Error("invalid scope/time");
    const row = store.db.prepare("SELECT record FROM session_exposures WHERE host=? AND cli=? AND session_id=?").get(host, cli, sessionId) as { record: string } | undefined;
    if (!row) return { record: null, reason: "missing exposure history" };
    const value: unknown = JSON.parse(row.record);
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid record");
    const r = value as SessionExposure;
    if (Object.keys(r).sort().join(",") !== "cli,generation,host,roots,session_id,unknown,v" || r.v !== 2 || r.host !== host || r.cli !== cli || r.session_id !== sessionId
      || !Number.isSafeInteger(r.generation) || r.generation < 1 || typeof r.unknown !== "boolean" || !Array.isArray(r.roots) || r.roots.length > MAX_CONTENT_ROOTS) throw new Error("invalid record");
    const ids = new Set<string>();
    for (const root of r.roots) {
      if (!root || typeof root !== "object" || Object.keys(root).sort().join(",") !== "derived_at,first_raw_at,last_message_id,last_read_at,raw_at,source"
        || !validContentRoot(root.source, now) || ids.has(root.source.message_id) || !exposureTime(root.raw_at, now) || !exposureTime(root.derived_at, now)
        || !exposureTime(root.first_raw_at, now) || (root.first_raw_at === null) !== (root.raw_at === null)
        || (root.first_raw_at !== null && root.raw_at !== null && root.first_raw_at > root.raw_at)
        || typeof root.last_message_id !== "string" || !/^[0-9A-HJKMNP-TV-Z]{26}$/.test(root.last_message_id)
        || root.last_read_at === null || !exposureTime(root.last_read_at, now)
        || (root.raw_at === null && root.derived_at === null)
        || (root.first_raw_at !== null && root.first_raw_at < Date.parse(root.source.since)) || (root.derived_at !== null && root.derived_at < Date.parse(root.source.since))
        || root.last_read_at < Math.max(root.raw_at ?? 0, root.derived_at ?? 0)) throw new Error("invalid root exposure");
      ids.add(root.source.message_id);
    }
    if (!r.unknown && !r.roots.length) throw new Error("empty history is not clean evidence");
    return { record: r, reason: r.unknown ? "incomplete exposure history" : null };
  } catch { return { record: null, reason: "unreadable or invalid exposure history" }; }
}

/**
 * Atomically union validated roots and record local disclosures, never evicting roots or clearing unknown history.
 * Reads store evidence in S2; clearance does not alter approval or the v1 fence before S6 activation.
 */
export function recordSessionExposure(store: Store, host: string, cli: string, sessionId: string, input: unknown, sources: ProvenanceSources, now = Date.now(), disclosure: "payload" | "summary" | "reply" = "payload"): SessionExposureRead {
  if (!exposureScope(host, cli, sessionId) || !Number.isSafeInteger(now) || now < 0) throw new Error("invalid exposure scope/time");
  return store.tx(() => {
    const current = readSessionExposure(store, host, cli, sessionId, now);
    if (!current.record && current.reason !== "missing exposure history") return current; // Preserve corrupt bytes for diagnosis.
    const p = readContentProvenance(input, sources, now);
    if (p.kind === "agent" && disclosure !== "summary") return current; // A signed clean label cannot create or clear exposure history.
    const r: SessionExposure = current.record ?? { v: 2, host, cli, session_id: sessionId, generation: 1,
      unknown: store.get(taintKey(cli, sessionId)) !== undefined, roots: [] };
    const before = canonical(r);
    let unrepresentedExposure = p.kind === "unknown" || (disclosure === "summary" && !p.roots.length);
    if (unrepresentedExposure) r.unknown = true;
    for (const source of p.roots) {
      let root = r.roots.find(old => old.source.message_id === source.message_id);
      if (root && canonical(root.source) !== canonical(source)) { r.unknown = true; unrepresentedExposure = true; continue; }
      if (!root) {
        if (r.roots.length === MAX_CONTENT_ROOTS) { r.unknown = true; unrepresentedExposure = true; continue; }
        root = { source, first_raw_at: null, raw_at: null, derived_at: null, last_message_id: (input as Envelope).id, last_read_at: now }; r.roots.push(root);
      }
      if (root.last_message_id !== (input as Envelope).id) { root.last_message_id = (input as Envelope).id; root.last_read_at = now; }
      if (p.kind === "firsthand-outside" && disclosure !== "summary") {
        root.first_raw_at ??= now;
        if (root.raw_at === null || disclosure === "reply" || now - root.raw_at >= EXTERNAL_TAINT_MS) { root.raw_at = now; root.last_read_at = now; }
      }
      else if (root.derived_at === null) { root.derived_at = now; root.last_read_at = now; }
    }
    if (current.record && !unrepresentedExposure && before === canonical(r)) return current;
    if (current.record) {
      if (r.generation === Number.MAX_SAFE_INTEGER) throw new Error("exposure generation overflow");
      r.generation++;
    }
    store.db.prepare("INSERT INTO session_exposures (host,cli,session_id,record) VALUES (?,?,?,?) ON CONFLICT(host,cli,session_id) DO UPDATE SET record=excluded.record")
      .run(host, cli, sessionId, JSON.stringify(r));
    store.audit("provenance.exposure_observed", { host, cli, session_id: sessionId, generation: r.generation, kind: p.kind, disclosure,
      message_id: p.kind === "unknown" ? null : (input as Envelope).id, roots: p.roots, unknown: r.unknown });
    return { record: r, reason: r.unknown ? "incomplete exposure history" : null };
  });
}

/** Exact daemon-resolved conversation/project; never a persona or a wildcard. */
export interface ExposureScope { host: string; cli: string; session_id: string; project_key: string }
/** Owner acceptance of the complete current snapshot, with no policy class or future-facing selector. */
export interface SessionClearance {
  v: 2; type: "session-clearance"; id: string; owner_fp: string; project_key: string;
  exposure: SessionExposure; effect: "clear" | "attest"; reason: string; iat: string; exp: string;
}
/** Validation is separate from activation: S2 stores evidence, never changes v1 approval or taint. */
export interface ClearanceResult { ok: boolean; reason: string; already_applied?: boolean }
const clearText = (x: unknown, max: number): x is string => typeof x === "string" && x.length > 0 && x.length <= max && x === x.trim()
  && !/[\u0000-\u001f\u007f-\u009f\u200e\u200f\u2028-\u202e\u2066-\u2069]/u.test(x) && !/\s{2}/u.test(x);
const clearScope = (s: ExposureScope) => exposureScope(s.host, s.cli, s.session_id) && [s.host, s.cli, s.session_id, s.project_key].every(x => clearText(x, 300) && x !== "*");
const clearanceKey = (s: ExposureScope) => `session-clearance-current:${canonical([s.host, s.cli, s.session_id, s.project_key])}`;

/** Capture all current exposures in one read snapshot before requesting the owner's signature. */
export function buildSessionClearance(store: Store, scope: ExposureScope, ownerPub: string, effect: "clear" | "attest", reason: string, ttlMs = 15 * 60_000, now = Date.now()): SessionClearance {
  if (!clearScope(scope) || !clearText(reason, 500) || !["clear", "attest"].includes(effect) || !Number.isSafeInteger(now) || now < 0
    || !Number.isSafeInteger(ttlMs) || ttlMs <= 0 || ttlMs > EXTERNAL_TAINT_MS) throw new Error("clearance needs an exact session/project, reason, and lifetime at most one hour");
  return store.readTx(() => {
    const { record, reason: failed } = readSessionExposure(store, scope.host, scope.cli, scope.session_id, now);
    if (!record || record.unknown) throw new Error(`cannot sign incomplete exposure history: ${failed}`);
    return { v: 2, type: "session-clearance", id: ulid(now), owner_fp: fingerprint(ownerPub), project_key: scope.project_key,
      exposure: record, effect, reason, iat: new Date(now).toISOString(), exp: new Date(now + ttlMs).toISOString() };
  });
}

/** Verify owner, scope, finite expiry, revocation and the complete unchanged current exposure generation. */
export function validateSessionClearance(store: Store, value: unknown, scope: ExposureScope, now = Date.now()): ClearanceResult {
  try {
    const signed = value as Signed<SessionClearance>, r = signed?.rec;
    if (!clearScope(scope) || !Number.isSafeInteger(now) || !signed || Object.keys(signed).sort().join(",") !== "rec,sig"
      || typeof signed.sig !== "string" || signed.sig.length > 200 || !r || typeof r !== "object" || Array.isArray(r)
      || Object.keys(r).sort().join(",") !== "effect,exp,exposure,iat,id,owner_fp,project_key,reason,type,v"
      || r.v !== 2 || r.type !== "session-clearance" || !/^[0-9A-HJKMNP-TV-Z]{26}$/.test(r.id)
      || !["clear", "attest"].includes(r.effect) || !clearText(r.reason, 500)) return { ok: false, reason: "invalid clearance record" };
    const key = ownerKeys(store.db).find(pub => fingerprint(pub) === r.owner_fp);
    if (!key || !verifyData(key, canonical(r), signed.sig)) return { ok: false, reason: "untrusted owner signature" };
    const issued = Date.parse(r.iat), expires = Date.parse(r.exp);
    if (!Number.isSafeInteger(issued) || !Number.isSafeInteger(expires) || issued > now || issued < 0 || expires <= now || expires <= issued
      || expires - issued > EXTERNAL_TAINT_MS || new Date(issued).toISOString() !== r.iat || new Date(expires).toISOString() !== r.exp)
      return { ok: false, reason: "invalid or expired clearance lifetime" };
    if (r.project_key !== scope.project_key || r.exposure?.host !== scope.host || r.exposure?.cli !== scope.cli || r.exposure?.session_id !== scope.session_id)
      return { ok: false, reason: "clearance session/project mismatch" };
    if (killSwitchSince(store.db, r.iat, r.owner_fp)) return { ok: false, reason: "clearance revoked" };
    for (const row of store.db.prepare("SELECT record,sig FROM policy_revocations WHERE target=? AND owner_fp=?").all(r.id, r.owner_fp) as { record: string; sig: string }[]) {
      const rev = JSON.parse(row.record);
      if (rev.v === 1 && rev.type === "revocation" && rev.target === r.id && rev.owner_fp === r.owner_fp && verifyData(key, canonical(rev), row.sig))
        return { ok: false, reason: "clearance revoked" };
    }
    const current = readSessionExposure(store, scope.host, scope.cli, scope.session_id, now);
    if (!current.record || current.record.unknown || canonical(current.record) !== canonical(r.exposure)) return { ok: false, reason: "exposure snapshot changed or incomplete" };
    return { ok: true, reason: "current session snapshot covered; no action class granted" };
  } catch { return { ok: false, reason: "unreadable clearance evidence" }; }
}

/** Atomic signature/snapshot recheck after the prompt; applying again never extends expiry or rewrites history. */
export function acceptSessionClearance(store: Store, signed: Signed<SessionClearance>, scope: ExposureScope, now = Date.now()): ClearanceResult {
  return store.tx(() => {
    const result = validateSessionClearance(store, signed, scope, now);
    if (!result.ok) { store.audit("session_clearance.apply_denied", { scope, reason: result.reason }); return result; }
    const key = `session-clearance:${signed.rec.id}`, old = store.get(key);
    if (old !== undefined && old !== canonical(signed)) {
      store.audit("session_clearance.apply_denied", { scope, id: signed.rec.id, reason: "record id collision" });
      return { ok: false, reason: "record id collision" };
    }
    if (old === undefined) { store.set(key, canonical(signed)); store.set(clearanceKey(scope), signed.rec.id); }
    store.audit("session_clearance.applied", { scope, id: signed.rec.id, effect: signed.rec.effect, generation: signed.rec.exposure.generation, already_applied: old !== undefined });
    return { ...result, already_applied: old !== undefined };
  });
}

/** Observation-only lookup; future enforcement must still check an independently authorized action/request. */
export function currentSessionClearance(store: Store, scope: ExposureScope, now = Date.now()): Signed<SessionClearance> | null {
  try {
    return store.tx(() => {
      const id = store.get(clearanceKey(scope)), raw = id && store.get(`session-clearance:${id}`);
      if (!raw) return null;
      const signed: Signed<SessionClearance> = JSON.parse(raw), result = signed.rec?.id === id
        ? validateSessionClearance(store, signed, scope, now) : { ok: false, reason: "clearance index mismatch" };
      store.audit("session_clearance.checked", { scope, id, valid: result.ok, reason: result.reason });
      return result.ok ? signed : null;
    });
  } catch { return null; }
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
  const base = "sent with origin external, as you declared: recipients may only read it under owner policy (no edit or outward); their own sends are not affected. Recipients acting on this message may not use outward-reversible, nor may a session tainted by reading it.";
  if (!taint) return base;
  return `${base} This session's sends stay external until ${iso(taint.root + EXTERNAL_TAINT_MS)}, an hour after its root exposure at ${iso(taint.root)}: you read ${taint.id} from ${taint.from}.`;
}

/** T738: the warning when an origin "external" declaration names no outside payload and is sent as agent mail. */
export const UNEVIDENCED_EXTERNAL = "origin \"external\" was not applied: no outside source was declared, so this went out as agent mail. "
  + "Mail between your owner's agents, in any project, is agent content. If the body carries text from a web page, issue, PR comment or email, "
  + "send it with origin external and payload firsthand-outside (you fetched it) or derived-outside.";
