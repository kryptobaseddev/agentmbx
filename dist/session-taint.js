// Conversation external taint (T345). The CLI reads it when sending. The MCP server
// persists it on noteRead after #120 merges, and release/claim restore it (T346).
import { EXTERNAL_TAINT_MS, MAX_RELAY_DEPTH } from "./envelope.js";
const LABEL = /^[^\u0000-\u001f\u007f]{1,300}$/;
const CAUSE = /^[^\u0000-\u001f\u007f]{1,300}$/;
const ID = /^[A-Za-z0-9_-]{1,80}$/;
const HOWS = new Set(["declared", "inherited", "legacy", "malformed"]);
const MAX_HOPS = 500;
/**
 * Kv key `taint:<cli>:<session_id>`. Either part may contain a colon; both are encoded
 * so `a:b` + `c` and `a` + `b:c` are different keys.
 */
export function taintKey(cli, sessionId) {
    if (!LABEL.test(cli) || !LABEL.test(sessionId))
        throw Object.assign(new Error("taint key needs a cli and session id"), { code: "TAINT_KEY" });
    return `taint:${encodeURIComponent(cli)}:${encodeURIComponent(sessionId)}`;
}
const liveAt = (at, now) => Number.isSafeInteger(at) && at <= now && now - at < EXTERNAL_TAINT_MS;
function hopsOf(value, now) {
    if (!Array.isArray(value))
        return null;
    const hops = [];
    for (const item of value.slice(-MAX_HOPS)) {
        if (!item || typeof item !== "object")
            return null;
        const hop = item;
        if (typeof hop.hop !== "number" || !Number.isInteger(hop.hop) || hop.hop < 0 || hop.hop > MAX_RELAY_DEPTH)
            return null;
        if (typeof hop.from !== "string" || !CAUSE.test(hop.from) || typeof hop.at !== "number")
            return null;
        if (liveAt(hop.at, now))
            hops.push({ hop: hop.hop, from: hop.from, at: hop.at });
    }
    return hops;
}
function normalize(value, cli, sessionId, now) {
    if (!value || typeof value !== "object")
        return null;
    const row = value;
    if (row.v !== 1 || row.cli !== cli || row.session_id !== sessionId)
        return null;
    if (typeof row.root !== "number" || !liveAt(row.root, now))
        return null;
    if (typeof row.from !== "string" || !CAUSE.test(row.from) || typeof row.id !== "string" || !ID.test(row.id))
        return null;
    if (typeof row.how !== "string" || !HOWS.has(row.how))
        return null;
    const relay_depth = hopsOf(row.relay_depth, now);
    if (!relay_depth)
        return null;
    return { v: 1, cli, session_id: sessionId, root: row.root, from: row.from, id: row.id, how: row.how, relay_depth };
}
/** The conversation's live taint, or null when the key is missing, malformed, or an hour past its root. */
export function readSessionTaint(store, cli, sessionId, now = Date.now()) {
    let key;
    try {
        key = taintKey(cli, sessionId);
    }
    catch {
        return null;
    }
    const raw = store.get(key);
    if (raw === undefined)
        return null;
    try {
        return normalize(JSON.parse(raw), cli, sessionId, now);
    }
    catch {
        return null;
    }
}
/** Write a live record. An expired root deletes the key. Anything else that is not live throws and leaves the old value. */
export function writeSessionTaint(store, record, now = Date.now()) {
    const key = taintKey(record.cli, record.session_id);
    if (record.v === 1 && Number.isSafeInteger(record.root) && record.root <= now && now - record.root >= EXTERNAL_TAINT_MS) {
        store.db.prepare("DELETE FROM kv WHERE k=?").run(key);
        return;
    }
    const normalized = normalize(record, record.cli, record.session_id, now);
    if (!normalized)
        throw Object.assign(new Error("taint record is not a live session exposure"), { code: "TAINT_RECORD" });
    store.set(key, JSON.stringify(normalized));
}
const iso = (t) => new Date(t).toISOString();
/** CLI refusal: `--origin agent` must not send while this conversation is tainted. */
export function refuseAgentOrigin(taint) {
    return `--origin agent refused: this session read ${taint.id} from ${taint.from}; sends stay external until ${iso(taint.root + EXTERNAL_TAINT_MS)}`;
}
/** Same facts the MCP send warning reports, for a CLI send that inherited the stored root. */
export function taintSendWarning(taint) {
    return `sent with origin external because this session read outside content: recipients may only read it under owner policy (no edit or outward). This session's sends stay external until ${iso(taint.root + EXTERNAL_TAINT_MS)}, an hour after its root exposure at ${iso(taint.root)}: you read ${taint.id} from ${taint.from}.`;
}
/** A sender that passed `--origin external` declares the body first-hand, even when a taint is also live. */
export function declaredOriginWarning(taint) {
    const base = "sent with origin external, as you declared: recipients may only read it under owner policy (no edit or outward), and reading it makes their own sends external for 1 h.";
    if (!taint)
        return base;
    return `${base} This session's sends stay external until ${iso(taint.root + EXTERNAL_TAINT_MS)}, an hour after its root exposure at ${iso(taint.root)}: you read ${taint.id} from ${taint.from}.`;
}
