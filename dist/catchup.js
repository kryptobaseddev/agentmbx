// Consumer checkpoints for session catch-up (T145, spec docs/spec/session-catchup.md, T156-T158).
// One kv record per identity name holds a replay position; fetch pages like replay, commit advances
// monotonically. Catch-up never acks, marks read, or grants authority.
import { createHash } from "node:crypto";
import { parseReplayFrame, replayMaximum } from "./replay.js";
export const catchupKey = (name) => `catchup:${name}`;
/** The catch-up scope is the unfiltered replay scope; commits from filtered replay pages are refused. */
export const CATCHUP_FILTER = createHash("sha256").update(JSON.stringify([null, null, null, null])).digest("hex");
/** Above this gap (or this age since the last captured page) the guided hint points at mbx_inbox first. */
export const CATCHUP_HINT_MAX_MESSAGES = 500;
export const CATCHUP_HINT_MAX_AGE_MS = 7 * 86_400_000;
const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };
export function readCatchup(store, name) {
    const raw = store.get(catchupKey(name));
    if (!raw)
        return null;
    try {
        const r = JSON.parse(raw);
        return r && r.v === 1 && typeof r.epoch === "string" && Number.isSafeInteger(r.position) && r.position >= 0
            && r.filter === CATCHUP_FILTER && Number.isSafeInteger(r.updated_at) && typeof r.by === "string" ? r : null;
    }
    catch {
        return null;
    }
}
const anchorOf = (lease) => lease ? lease.released_at ?? lease.heartbeat_at : null;
/**
 * First-use origin (spec R3): the highest visibility seq whose message first appeared at or before the
 * identity was last held (its prior lease's release, or last heartbeat on a crash). Nothing missed by a
 * crashed holder is thrown away. An identity with no anchor (never held) starts at the current max.
 */
export function initCatchup(store, name, prior, by, now = Date.now()) {
    const epoch = store.get("replay:epoch") ?? fail("CURSOR_EXPIRED", "Replay generation is unavailable; initialize this store before catch-up");
    const maximum = replayMaximum(store, name);
    const anchor = anchorOf(prior);
    let position = maximum, origin = "never-held: start at the current end";
    if (anchor !== null) {
        const iso = new Date(anchor).toISOString();
        // received_at (when the message became visible on this host), not the sender's ts: queued
        // cross-host mail can carry an old sender timestamp while arriving after later local mail.
        const row = store.db.prepare(`SELECT MAX(v.seq) seq FROM mailbox_visibility v JOIN messages m ON m.id=v.message_id
      WHERE v.mailbox=? AND m.received_at<=?`).get(name, iso);
        position = Number(row?.seq ?? 0);
        origin = `last-held ${iso}`;
    }
    const record = { v: 1, epoch, position, filter: CATCHUP_FILTER, updated_at: now, by };
    store.set(catchupKey(name), JSON.stringify(record));
    store.audit("catchup.init", { name, position, origin, by });
    return record;
}
/** Lazily initialize at fetch time when claim time did not (identities claimed outside the MCP path). */
export function ensureCatchup(store, name, lease, by) {
    return readCatchup(store, name) ?? initCatchup(store, name, lease, by);
}
/** Messages first-visible after the committed position; O(rows-after-position), safe on any state. */
export function missedCount(store, name) {
    const record = readCatchup(store, name);
    if (!record)
        return { missed: 0, ageMs: null };
    // Seq is a global autoincrement: count this mailbox's own rows after the position, plus pruned tombstones.
    const visible = Number(store.db.prepare("SELECT COUNT(*) n FROM mailbox_visibility WHERE mailbox=? AND seq>?").get(name, record.position).n);
    const pruned = Number(store.db.prepare("SELECT COUNT(*) n FROM mailbox_pruned WHERE mailbox=? AND seq>?").get(name, record.position).n);
    return { missed: visible + pruned, ageMs: Date.now() - record.updated_at };
}
/** Bounded guided-start hint for dedicated sessions (spec R11/R12); null when nothing is missed. */
export function catchupHint(store, name) {
    const { missed, ageMs } = missedCount(store, name);
    if (!missed)
        return null;
    const record = readCatchup(store, name);
    const since = record ? new Date(record.updated_at).toISOString().slice(0, 10) : "the last captured page";
    if (missed > CATCHUP_HINT_MAX_MESSAGES || (ageMs !== null && ageMs > CATCHUP_HINT_MAX_AGE_MS))
        return `[mbx] ${name} has ${missed} message(s) since ${record ? new Date(record.updated_at).toISOString().slice(0, 19) + "Z" : since} not caught up on — over the guided limit. Check mbx_inbox first; mbx_catchup (bounded history replay) is optional.`;
    return `[mbx] ${name} has ${missed} message(s) since ${new Date(record.updated_at).toISOString().slice(0, 19)}Z not caught up on; call mbx_catchup to page through them, and commit each page (commit: <next_cursor>) after capturing it. mbx_inbox still shows what needs handling.`;
}
/**
 * Advance the checkpoint to a page the agent durably captured (spec R8). Monotonic only: rewinds fail,
 * identical re-commits are no-ops, and a rotated epoch refuses the commit until an explicit restart.
 */
/**
 * A fetch that does not pass `commit` leaves the checkpoint where it was, so the next fetch
 * repeats this page. Say that, and say the exact argument that advances it.
 */
export function catchupUnchanged(nextCursor) {
    return {
        unchanged: true,
        hint: `This page is unchanged because the checkpoint was not committed. After you capture it, call mbx_catchup with commit set to this next_cursor: ${nextCursor}. Fetching again without commit returns this same page.`,
    };
}
/** A cursor that does not decode is a format error, not a different mailbox. */
function parseCatchupCursor(cursor) {
    try {
        return parseReplayFrame(cursor);
    }
    catch (err) {
        const code = err.code;
        if (code === "CURSOR_INVALID") {
            fail("CURSOR_MALFORMED", "Catch-up cursor is malformed or corrupt. Restart from the checkpoint: call mbx_catchup with no cursor.");
        }
        throw err;
    }
}
export function commitCatchup(store, name, cursor, by) {
    const record = readCatchup(store, name) ?? fail("CURSOR_INVALID", "no catch-up checkpoint for this identity; call mbx_catchup without commit first");
    const epoch = store.get("replay:epoch") ?? fail("CURSOR_EXPIRED", "Replay generation is unavailable; initialize this store before catch-up");
    const frame = parseCatchupCursor(cursor);
    if (frame.mailbox !== name || frame.filter !== CATCHUP_FILTER)
        fail("CURSOR_SCOPE_MISMATCH", "catch-up commits must come from this identity's unfiltered catch-up pages");
    if (frame.epoch !== epoch)
        fail("CURSOR_EXPIRED", "the store was restored or reset; restart catch-up explicitly (restart: all | now)");
    if (frame.end > replayMaximum(store, name))
        fail("CURSOR_INVALID", "catch-up commit exceeds available history");
    if (frame.position < record.position)
        fail("CURSOR_INVALID", "catch-up commits never rewind; the stored checkpoint is ahead of this cursor");
    if (frame.position === record.position)
        return { from: record.position, to: frame.position, noop: true };
    const next = { v: 1, epoch, position: frame.position, filter: CATCHUP_FILTER, updated_at: Date.now(), by };
    store.set(catchupKey(name), JSON.stringify(next));
    store.audit("catchup.advance", { name, from: record.position, to: frame.position, by });
    return { from: record.position, to: frame.position, noop: false };
}
/** Explicit restart after epoch rotation or operator decision; audited, never silent. */
export function restartCatchup(store, name, mode, by) {
    const epoch = store.get("replay:epoch") ?? fail("CURSOR_EXPIRED", "Replay generation is unavailable; initialize this store before catch-up");
    const position = mode === "now" ? replayMaximum(store, name) : 0;
    const record = { v: 1, epoch, position, filter: CATCHUP_FILTER, updated_at: Date.now(), by };
    store.set(catchupKey(name), JSON.stringify(record));
    store.audit("catchup.restart", { name, mode, position, by });
    return record;
}
/** Rename carries the checkpoint with the identity (spec R4); release, retire and forward never touch it. */
export function moveCatchup(store, from, to) {
    const raw = store.get(catchupKey(from));
    if (raw === undefined)
        return;
    store.set(catchupKey(to), raw);
    store.db.prepare("DELETE FROM kv WHERE k=?").run(catchupKey(from));
    store.audit("catchup.move", { from, to });
}
