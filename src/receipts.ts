// Send-time recipient truth (T205): who a message actually reached, decided when it is sent, so a sender never mistakes
// "stored in a mailbox" for "an agent will see it". Liveness comes from the identity lease and its existing process
// evidence. Native push eligibility uses the dispatcher's exact lease/binding guard.
import { IdentityLeases, identityLeaseStatus, type IdentityLease } from "./identity-leases.ts";
import type { Envelope } from "./envelope.ts";
import type { MbxNode, RouteTarget } from "./node.ts";
import type { MessageRow } from "./store.ts";
import { hasWakeAuthority, liveWatcher } from "./wake.ts";
import { captureWakeIdentity } from "./wake-identity.ts";
import { procTable } from "./proc.ts";
import { activityKey, parseActivity, SHARED_IDLE_MS } from "./identity-availability.ts";
import { remoteReceipts } from "./remote-receipts.ts";

/** A holder renews its lease every minute; three missed beats mean its session is suspended or gone. */
const STALE_HEARTBEAT_MS = 3 * 60_000;

export type RecipientState = "live-wake" | "live-next-prompt" | "offline" | "forwarded" | "remote";
export interface RecipientReceipt { to: string; address: string; state: RecipientState; detail: string }

const iso = (ms: number) => new Date(ms).toISOString();

/** Is a session holding `name` right now? Unknown process evidence with a fresh heartbeat counts as live (it is the
 *  lease's own rule for "unknown"); everything else says since when and who held it last. */
export function mailboxLiveness(node: MbxNode, name: string, now = Date.now()): { live: boolean; detail: string } {
  const row = node.store.db.prepare("SELECT * FROM identity_leases WHERE name=?").get(name) as unknown as IdentityLease | undefined;
  if (!row) return { live: false, detail: "no session has ever held this mailbox; it is read when an agent claims it" };
  let state: "live" | "unknown" | "expired" = "unknown", reason: string | null = null;
  try { ({ state, reason } = identityLeaseStatus(row, now, new IdentityLeases(node.store).processEvidence(row.holder_pid))); }
  catch {
    // Evidence can't be inspected inside a transaction: judge by the lease row, the process table snapshot taken before
    // it (a vanished holder is gone) and the heartbeat, which a live holder renews every minute (T204 review).
    const table = procTable();
    if (row.released_at !== null || now - row.heartbeat_at >= row.idle_ttl) { state = "expired"; reason = row.released_at !== null ? null : "idle"; }
    else if (table.size && !table.has(row.holder_pid)) { state = "expired"; reason = "dead"; }
    else if (now - row.heartbeat_at >= STALE_HEARTBEAT_MS) { state = "expired"; reason = `no heartbeat for ${Math.round((now - row.heartbeat_at) / 60_000)} min`; }
    // Its pid is running and it renewed within three minutes: as live as an advisory receipt can tell.
    else if (table.has(row.holder_pid)) state = "live";
  }
  if ((state === "live" || state === "unknown") && now - row.heartbeat_at >= STALE_HEARTBEAT_MS) {
    state = "expired"; reason = `no heartbeat for ${Math.round((now - row.heartbeat_at) / 60_000)} min`;
  }
  const holder = `${row.cli} session ${row.session_id.slice(0, 12)}`;
  if (state === "live" || state === "unknown") {
    const activity = parseActivity(node.store.get(activityKey(name)));
    const quiet = activity?.shared && now - activity.at >= SHARED_IDLE_MS
      ? `; its conversation has made no mbx call for ${Math.round((now - activity.at) / 60_000)} min and may have ended` : "";
    return { live: true, detail: state === "live" ? `held by ${holder}${quiet}`
      : `held by ${holder} (process unconfirmed, heartbeat ${Math.round((now - row.heartbeat_at) / 1000)} s ago)${quiet}` };
  }
  const since = row.released_at ?? row.heartbeat_at;
  const why = row.release_reason ?? reason ?? "released";
  return { live: false, detail: `no live session since ${iso(since)} (last holder ${holder}, ${why})` };
}

/** One receipt per resolved target of a stored message. */
export function recipientReceipts(node: MbxNode, msgId: string, targets: RouteTarget[], now = Date.now()): RecipientReceipt[] {
  const m = node.message(msgId);
  const out: RecipientReceipt[] = [];
  for (const t of targets) {
    if (t.host) {
      const p = node.peer(t.host);
      out.push({ to: t.to, address: `${t.name ?? "*"}@${t.host}`, state: "remote", detail: `queued for paired host ${t.host}${p ? ` at ${p.addr}` : ""}; its daemon decides wake and liveness` });
      continue;
    }
    const name = t.name!;
    const address = `${name}@${node.host}`;
    if (name === "owner") { out.push({ to: t.to, address, state: "live-next-prompt", detail: "the owner sees it in agentmbx inbox and as a desktop notification" }); continue; }
    const live = mailboxLiveness(node, name, now);
    let state: RecipientState, detail: string;
    if (!live.live) { state = "offline"; detail = live.detail; }
    else {
      const sessions = node.sessionsFor(name);
      const verified = sessions.filter(s => captureWakeIdentity(node, s));
      const mode = node.deliveryMode(name, verified);
      const watcher = liveWatcher(node, name, now);
      const why = !m ? "message not found" : !node.wantsWake(name, m) ? "this kind does not wake (status, or no needs_reply/mention)"
        : !watcher && sessions.length && !verified.length ? "the current lease or session binding could not be verified"
        : !mode.startsWith("push") || (mode.includes("mbx watcher") && !watcher) ? "the session has no push path"
        : !hasWakeAuthority(node, name, m) ? "no owner policy lets this sender wake it" : null;
      state = why ? "live-next-prompt" : "live-wake";
      detail = why ? `${live.detail}; seen on its next prompt: ${why}` : `${live.detail}; eligible for wake (${mode}); dispatcher admission pending`;
    }
    if (t.renamed_from) { detail = `${t.renamed_from} was renamed to ${name}; ${state}: ${detail}`; state = "forwarded"; }
    out.push({ to: t.to, address, state, detail });
  }
  return out;
}

/** Warning lines for recipients nobody will read soon. */
export const offlineWarnings = (rs: RecipientReceipt[]): string[] =>
  rs.filter((r) => r.state === "offline" || (r.state === "forwarded" && /offline: /.test(r.detail)))
    .map((r) => `${r.address} is offline: ${r.detail.replace(/^.*offline: /, "")}. The message waits in its mailbox; tell your user if it is urgent.`);

/** Levenshtein distance, capped (names are at most 40 characters). */
function distance(a: string, b: string): number {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++)
    d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[a.length][b.length];
}

/** Up to 3 existing local names close to `name` (prefix match or edit distance <= 2). */
export function suggestNames(node: MbxNode, name: string): string[] {
  const names = new Set<string>([
    ...node.agents().filter((a) => a.host === node.host).map((a) => a.name),
    ...(node.store.db.prepare("SELECT name FROM identity_leases").all() as { name: string }[]).map((r) => r.name),
  ]);
  return [...names].map((n) => ({ n, d: n.startsWith(name) || name.startsWith(n) ? 0 : distance(n, name) }))
    .filter((x) => x.d <= 2 && x.n !== name).sort((a, b) => a.d - b.d || a.n.localeCompare(b.n)).slice(0, 3).map((x) => x.n);
}

/** Refuse a send to a local name that never existed instead of silently creating a mailbox (T205). Checked before
 *  anything is stored; `name@otherhost` is the other host's business. */
export function assertKnownRecipients(node: MbxNode, to: string[]): void {
  const unknown = node.route(to).targets.filter((t) => t.unknown).map((t) => t.name!);
  if (!unknown.length) return;
  const lines = unknown.map((n) => { const s = suggestNames(node, n); return `"${n}" is not an agent on ${node.host}${s.length ? `; did you mean ${s.join(", ")}?` : ""}`; });
  throw Object.assign(new Error(`not sent: ${lines.join("; ")}. List agents with mbx_agents; a mailbox exists once an agent has held it.`), { code: "UNKNOWN_RECIPIENT" });
}

// ---- sender receipts (T207) ---------------------------------------------------------------------
// What happened to mail this agent sent: per recipient, the delivery state (delivered → notified → read → acked) with
// its note and the recipient's "did" line, the recipient's liveness now, and for paired hosts the outbox state.

export interface DeliveryReceipt {
  address: string; state: string; updated_at: string | null; note: string | null; did: string | null; liveness: string;
  outbox?: { attempts: number; last_error: string | null; next_at: string };
}

export function deliveryReceipts(node: MbxNode, m: MessageRow, now = Date.now()): DeliveryReceipt[] {
  const dids = new Map((node.store.db.prepare("SELECT json_extract(detail,'$.recipient') r, json_extract(detail,'$.did') d FROM audit WHERE event='peer_action' AND json_extract(detail,'$.msg')=? ORDER BY at")
    .all(m.id) as { r: string; d: string }[]).map((x) => [x.r, x.d]));
  const local = (node.store.db.prepare("SELECT agent,state,updated_at,note FROM deliveries WHERE msg_id=? ORDER BY agent").all(m.id) as
    { agent: string; state: string; updated_at: string; note: string | null }[]).map((d) => {
    const live = d.agent === "owner" ? { live: true, detail: "the owner" } : mailboxLiveness(node, d.agent, now);
    return { address: `${d.agent}@${node.host}`, state: d.state, updated_at: d.updated_at, note: d.note, did: dids.get(d.agent) ?? null,
      liveness: live.live ? `live: ${live.detail}` : `offline: ${live.detail}` };
  });
  // Remote recipients: the envelope's addressees on other hosts; a queued outbox row means not yet accepted there.
  const e = JSON.parse(m.envelope) as Envelope;
  const outbox = new Map((node.store.db.prepare("SELECT host,attempts,last_error,next_at FROM outbox WHERE msg_id=?").all(m.id) as
    { host: string; attempts: number; last_error: string | null; next_at: string }[]).map((o) => [o.host, o]));
  // Signed receipts from those hosts (T218) replace "handed-over" with the recipient's own state, did and note.
  const signed = remoteReceipts(node, m.id);
  const hosts = new Set([...e.to.filter((t) => t.includes("@") && !t.endsWith(`@${node.host}`)).map((t) => t.split("@")[1]), ...outbox.keys(),
    ...signed.map((r) => r.recipient.split("@")[1])]);
  const remote = [...hosts].sort().flatMap((h): DeliveryReceipt[] => {
    const o = outbox.get(h);
    const names = e.to.filter((t) => t.endsWith(`@${h}`));
    // A signed receipt proves delivery even while the outbox still retries (the peer's answer to the push was lost).
    const got = signed.filter((r) => r.recipient.endsWith(`@${h}`));
    const pending = names.filter((n) => !got.some((r) => r.recipient === n));
    return [
      ...got.map((r): DeliveryReceipt => ({ address: r.recipient, state: r.state, updated_at: r.at, note: r.note, did: r.did, liveness: `on paired host ${h} (signed receipt)` })),
      ...(got.length && !pending.length ? [] : [{ address: (got.length ? pending : names).join(",") || `*@${h}`, state: o ? "queued" : "handed-over", updated_at: null, note: null, did: null,
        liveness: o ? `paired host ${h}: not accepted yet` : `accepted by paired host ${h}; no receipt from it yet`,
        ...(o ? { outbox: { attempts: o.attempts, last_error: o.last_error, next_at: o.next_at } } : {}) }]),
    ];
  });
  return [...local, ...remote];
}

/** One line per recipient, for thread views. */
// "notified" with note "desktop" means only the owner saw a desktop notice: no agent session was told.
export const receiptLine = (r: DeliveryReceipt) => `  → ${r.address}: ${r.state === "notified" && r.note === "desktop" ? "notified (owner desktop notice only)" : r.state}${r.updated_at ? ` ${r.updated_at.slice(0, 19)}Z` : ""}`
  + `${r.did ? ` · did: ${r.did}` : ""}${r.note ? ` · note: ${r.note}` : ""}${r.outbox ? ` · attempts ${r.outbox.attempts}${r.outbox.last_error ? ` (${r.outbox.last_error.slice(0, 60)})` : ""}` : ""} · ${r.liveness}`;

interface SentFrame { v: 1; epoch: string; sender: string; position: string; end: string }
export interface SentItem { id: string; ts: string; kind: string; subject: string; thread: string; to: string[]; recipients: DeliveryReceipt[] }
export interface SentPage { messages: SentItem[]; next_cursor: string; has_more: boolean }
const fail = (code: string, message: string): never => { throw Object.assign(new Error(message), { code }); };
const encodeFrame = (f: SentFrame) => Buffer.from(JSON.stringify(f)).toString("base64url");

/** Mail `agent` sent from this host, oldest first, paged by an opaque cursor that mirrors replay: a frame over a finite
 *  snapshot (message ids are ULIDs, so id order is send order and survives VACUUM); a completed cursor polls for newer. */
export function sentPage(node: MbxNode, agent: string, o: { cursor?: string; limit?: number } = {}): SentPage {
  const limit = o.limit ?? 20;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) fail("CURSOR_INVALID", "Sent bounds are invalid");
  const sender = `${agent}@${node.host}`;
  const epoch = node.store.get("replay:epoch") ?? fail("CURSOR_EXPIRED", "Store generation is unavailable");
  const max = (node.store.db.prepare("SELECT COALESCE(MAX(id),'') m FROM messages WHERE from_addr=? AND origin='local'").get(sender) as { m: string }).m;
  let frame: SentFrame = { v: 1, epoch: epoch!, sender, position: "", end: max };
  if (o.cursor !== undefined) {
    if (typeof o.cursor !== "string" || o.cursor.length > 1024 || !/^[A-Za-z0-9_-]+$/.test(o.cursor)) fail("CURSOR_INVALID", "Sent cursor is invalid");
    let f: SentFrame | null = null;
    try {
      const data = Buffer.from(o.cursor!, "base64url");
      if (data.toString("base64url") === o.cursor) f = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(data)) as SentFrame;
    } catch { /* invalid below */ }
    if (!f || typeof f !== "object" || Object.keys(f).sort().join(",") !== "end,epoch,position,sender,v" || f.v !== 1
      || typeof f.position !== "string" || typeof f.end !== "string" || typeof f.epoch !== "string" || f.position > f.end)
      fail("CURSOR_INVALID", "Sent cursor is invalid");
    if (f!.sender !== sender) fail("CURSOR_SCOPE_MISMATCH", "Sent cursor belongs to a different sender");
    if (f!.epoch !== epoch) fail("CURSOR_EXPIRED", "Store generation changed; restart from the beginning");
    frame = { ...f! };
    if (frame.position === frame.end) frame.end = max; // a completed frame polls for newer mail
  }
  const rows = node.store.db.prepare("SELECT * FROM messages WHERE from_addr=? AND origin='local' AND id>? AND id<=? ORDER BY id LIMIT ?")
    .all(sender, frame.position, frame.end, limit + 1) as unknown as MessageRow[];
  const page = rows.slice(0, limit);
  const position = page.length ? page[page.length - 1].id : frame.position;
  const messages = page.map((m): SentItem => {
    const e = JSON.parse(m.envelope) as Envelope;
    return { id: m.id, ts: m.ts, kind: m.kind, subject: m.subject, thread: m.thread, to: e.to, recipients: deliveryReceipts(node, m) };
  });
  const done = rows.length <= limit;
  return { messages, next_cursor: encodeFrame({ ...frame, position: done ? frame.end : position }), has_more: !done };
}
