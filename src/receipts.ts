// Send-time recipient truth (T205): who a message actually reached, decided when it is sent, so a sender never mistakes
// "stored in a mailbox" for "an agent will see it". Liveness is one answer from liveness.ts (T699): the lease, the
// session binding and the serve kind together. Native push eligibility uses the dispatcher's exact lease/binding guard.
import { identityLeaseStatus, inspectLeaseProcess, type IdentityLease, type ProcessEvidence } from "./identity-leases.ts";
import { agentLiveness } from "./liveness.ts";
import type { Envelope } from "./envelope.ts";
import { GROK_NO_PUSH, type MbxNode, type RouteTarget } from "./node.ts";
import { type MessageRow, type Store } from "./store.ts";
import { hasWakeAuthority, liveWatcher, queuedBehindTurnAt, watcherKey } from "./wake.ts";
import { captureWakeIdentity } from "./wake-identity.ts";
import { activityKey, parseActivity, SHARED_IDLE_MS } from "./identity-availability.ts";
import { connectorKey, retryErrorClass } from "./diagnostics.ts";
import { remoteReceipts } from "./remote-receipts.ts";
import { isSlotName } from "./project-slot.ts";
import { projectLabel, projectMailboxBySlot, projectReader } from "./project-mailbox.ts";
import { peerProjectBySlot } from "./project-directory.ts";

export type RecipientState = "live-wake" | "live-next-prompt" | "offline" | "queued-no-holder" | "forwarded" | "remote";
export interface RecipientReceipt { to: string; address: string; state: RecipientState; detail: string }

const iso = (ms: number) => new Date(ms).toISOString();

export interface MailboxLiveness {
  /** True when a session will eventually see mail for this mailbox (live, idle, or an unverified holder). */
  live: boolean;
  state: "live" | "idle" | "unknown" | "offline" | "conflict";
  /** The shared T699 answer, identical on every surface (roster, agent list, receipt). */
  reason: string;
  /** Receipt prose: the holder it last knew, plus this surface's own context. */
  detail: string;
  /** The idle came from a released or expired lease whose session is still running (T699). */
  released?: boolean;
  /** A proven wake path exists for that binding (T688 shared service, or a registered T659 poller). */
  wakeable?: boolean;
}

/** A holder renews its lease every minute; three missed beats mean its session is suspended or gone. Receipts are
 *  stricter than the 30-minute lease idle TTL: mail nobody is polling should read as undelivered sooner (T204). */
const STALE_HEARTBEAT_MS = 3 * 60_000;

/** Is a session holding `name` right now — or still there with its lease released? One answer from liveness.ts
 *  (T699), so a receipt cannot call a wakeable session "offline" while the agent list calls it "live". */
export function mailboxLiveness(node: MbxNode, name: string, now = Date.now(), o: { inspect?: (pid: number) => ProcessEvidence } = {}): MailboxLiveness {
  if (isSlotName(name)) {
    // T493: a project mailbox has no holder of its own. Its reader is the project's current lead, so it is live exactly when that lead is.
    const reader = projectReader(node, name, new Date(now));
    if (!reader) return { live: false, state: "offline", reason: "this project mailbox is not allocated on this host", detail: "this project mailbox is not allocated on this host" };
    const label = `project mailbox ${projectLabel(reader.mailbox)}`;
    if (!reader.lead) {
      const reason = `${label}: no owner-designated lead on ${node.host} to read it`;
      return { live: false, state: "offline", reason, detail: reason };
    }
    const lead = mailboxLiveness(node, reader.lead.agent, now, o);
    return { ...lead, detail: `${label}, read by its lead ${reader.lead.agent}: ${lead.detail}` };
  }
  const l = agentLiveness(node, name, { now, ...(o.inspect ? { inspect: o.inspect } : {}) });
  const row = node.store.db.prepare("SELECT * FROM identity_leases WHERE name=?").get(name) as unknown as IdentityLease | undefined;
  if (l.state === "conflict") return { live: false, state: "conflict", reason: l.reason, detail: l.reason };
  if (!row) return { live: false, state: "offline", reason: l.reason, detail: "no session has ever held this mailbox; it is read when an agent claims it" };
  const holder = `${row.cli} session ${row.session_id.slice(0, 12)}`;
  const silent = row.released_at === null && now - row.heartbeat_at >= STALE_HEARTBEAT_MS;
  if (l.state === "offline" || silent) {
    const status = row.released_at === null ? identityLeaseStatus(row, now, inspectLeaseProcess(row.holder_pid)) : null;
    const why = row.release_reason ?? (silent ? `no heartbeat for ${Math.round((now - row.heartbeat_at) / 60_000)} min` : status?.reason ?? "released");
    return { live: false, state: "offline", reason: l.reason,
      detail: `no live session since ${iso(row.released_at ?? row.heartbeat_at)} (last holder ${holder}, ${why})` };
  }
  const activity = parseActivity(node.store.get(activityKey(name)));
  const quiet = activity?.shared ? now - activity.at : null;
  const note = quiet !== null && quiet >= SHARED_IDLE_MS && (l.state === "live" || (l.state === "idle" && l.idleKind === "held"))
    ? `; its conversation has made no mbx call for ${Math.round(quiet / 60_000)} min and may have ended (no hook or wake-poll activity either)` : "";
  const detail = l.idleKind === "released" ? l.reason
    : l.state === "unknown" ? `held by ${holder} (process unconfirmed, heartbeat ${Math.round((now - row.heartbeat_at) / 1000)} s ago)${note}`
    : `held by ${holder}${note}`;
  return {
    live: true, state: l.state, reason: l.reason, detail,
    ...(l.idleKind === "released" ? { released: true } : {}),
    ...(l.wakeable !== undefined ? { wakeable: l.wakeable } : {}),
  };
}

/** "addressed to the project mailbox X; " when `name` is a project slot that `host` advertises, else nothing (T493). */
const projectBoxNote = (node: MbxNode, name: string | undefined, host: string): string => {
  const box = name && isSlotName(name) ? peerProjectBySlot(node, host, name) : undefined;
  return box ? `addressed to the project mailbox ${box.alias ?? box.slot} on ${host}, read by its lead there; ` : "";
};

/** One receipt per resolved target of a stored message. */
export function recipientReceipts(node: MbxNode, msgId: string, targets: RouteTarget[], now = Date.now()): RecipientReceipt[] {
  const m = node.message(msgId);
  const out: RecipientReceipt[] = [];
  for (const t of targets) {
    if (t.host) {
      const p = node.peer(t.host);
      out.push({ to: t.to, address: `${t.name ?? "*"}@${t.host}`, state: "remote", detail: `${projectBoxNote(node, t.name, t.host)}queued for paired host ${t.host}${p ? ` at ${p.addr}` : ""}; its daemon decides wake and liveness` });
      continue;
    }
    const name = t.name!;
    const address = `${name}@${node.host}`;
    if (name === "owner") { out.push({ to: t.to, address, state: "live-next-prompt", detail: "the owner sees it in agentmbx inbox and as a desktop notification" }); continue; }
    const live = mailboxLiveness(node, name, now);
    if (isSlotName(name)) {
      // T493: the recipient is the project, not a session. With no live lead it is queued exactly like mail to `lead` with no holder
      // (T491); with one, the lead sees it in its project inbox section on its next prompt (waking it is the wake path's, not claimed here).
      const box = projectMailboxBySlot(node.store, name), label = box ? projectLabel(box) : name;
      const here: { state: RecipientState; detail: string } = live.live
        ? { state: "live-next-prompt", detail: `addressed to the project mailbox ${label}; ${live.detail}; it sees this in its project inbox on its next prompt` }
        : { state: "queued-no-holder", detail: `addressed to the project mailbox ${label}; ${live.detail}; it waits here until the project's lead reconnects or the owner designates one, and urgent mail is reported to the owner` };
      // T495: a retired generated name whose unread mail went to the project mailbox still routes there; the sender is told.
      out.push(t.renamed_from ? { to: t.to, address, state: "forwarded", detail: `${t.renamed_from} was renamed to the project mailbox ${label}; ${here.state}: ${here.detail}` } : { to: t.to, address, ...here });
      continue;
    }
    let state: RecipientState, detail: string;
    if (t.lead && !live.live) {
      // T491: `lead`/`role:lead` names the owner-designated lead. When its mailbox has no live holder the
      // send is queued, not just "offline": the sender must hear that the project's lead will not see this
      // until a session claims the mailbox or the owner acts, and urgent copies escalate to the owner.
      state = "queued-no-holder";
      detail = `addressed to the owner-designated lead; ${live.detail}; it waits here until a session claims ${name} or the owner forwards it, and the owner is notified`;
    }
    else if (!live.live) { state = "offline"; detail = live.detail; }
    else if (live.released) {
      // T699: the lease was released (or expired) but the session still runs. That is idle, not offline: mail waits
      // for its next turn, and a proven wake path (a shared service, or a registered poller) can start that turn.
      const mode = node.deliveryMode(name);
      const why = !m ? "message not found" : !node.wantsWake(name, m) ? "this kind does not wake (status, or no needs_reply/mention)"
        : !live.wakeable ? "the session is running without a wake path proven from this process"
        : !hasWakeAuthority(node, name, m) ? "no owner policy lets this sender wake it" : null;
      state = why ? "live-next-prompt" : "live-wake";
      detail = why ? `${live.detail}; seen on its next prompt: ${why}`
        : `${live.detail}; eligible for wake (${mode}); the turn re-claims the mailbox; dispatcher admission pending`;
    }
    else {
      const sessions = node.sessionsFor(name);
      const verified = sessions.filter(s => captureWakeIdentity(node, s));
      const mode = node.deliveryMode(name, verified);
      const watcher = liveWatcher(node, name, now);
      // T386: a watcher-delivered session whose watcher is not live at this instant still gets the
      // wake — the record outlives a between-fires tick, and a terminal kimi session re-arms its
      // watcher at turn end by design (T348), so the dispatcher admits the wake moments later.
      // Only a verified binding may read as live-wake (T376's guard above); with no watcher
      // evidence at all, "no push path" stays the answer.
      // T435: a lapsed Grok session is not on this set. Its receipt stays live-next-prompt and the
      // detail is GROK_NO_PUSH (which names the watch remedy). A stale key still re-arms every
      // other verified cli, including Claude, and a terminal kimi session with no key still re-arms.
      const terminalKimi = !mode.startsWith("push") && verified.every((s) => s.cli === "kimi");
      const rearming = !watcher && verified.length > 0 && !verified.some((s) => s.cli === "grok")
        && (node.store.get(watcherKey(name)) != null || terminalKimi);
      const why = !m ? "message not found" : !node.wantsWake(name, m) ? "this kind does not wake (status, or no needs_reply/mention)"
        : !watcher && sessions.length && !verified.length ? "the current lease or session binding could not be verified"
        : !mode.startsWith("push") && !rearming ? (mode === GROK_NO_PUSH ? GROK_NO_PUSH : "the session has no push path")
        : !hasWakeAuthority(node, name, m) ? "no owner policy lets this sender wake it" : null;
      state = why ? "live-next-prompt" : "live-wake";
      detail = why ? `${live.detail}; seen on its next prompt: ${why}`
        : rearming && !watcher ? `${live.detail}; eligible for wake (mbx watcher: its exit starts your next turn); watcher re-arm pending, dispatcher admission pending`
        : `${live.detail}; eligible for wake (${mode}); dispatcher admission pending${verified.some((s) => s.cli === "opencode") ? `; ${OPENCODE_MIDTURN_NOTE}` : ""}`;
    }
    if (t.renamed_from) { detail = `${t.renamed_from} was renamed to ${name}; ${state}: ${detail}`; state = "forwarded"; }
    out.push({ to: t.to, address, state, detail });
  }
  return out;
}

/** T642: what an OpenCode recipient in the middle of a turn sees, and when. */
export const OPENCODE_MIDTURN_NOTE = "an OpenCode session in the middle of a turn sees it with its next tool result; the wake follows once that turn ends, if the mail is still unhandled";
export const OPENCODE_BEHIND_TURN_NOTE = "wake queued behind the session's running turn: the model sees a notice with its next tool result, the wake when the turn ends";

/** Warning lines for recipients nobody will read soon. */
export const offlineWarnings = (rs: RecipientReceipt[]): string[] =>
  rs.filter((r) => r.state === "offline" || r.state === "queued-no-holder" || (r.state === "forwarded" && /offline: /.test(r.detail)))
    .map((r) => r.state === "queued-no-holder"
      ? `${r.address} is the owner-designated lead but has no live holder: ${r.detail}. The message is queued here, not delivered; the owner is notified. Tell your user it needs the lead back or an owner forward.`
      : `${r.address} is offline: ${r.detail.replace(/^.*offline: /, "")}. The message waits in its mailbox; tell your user if it is urgent.`);

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
  // `lead` and `role:lead` name the owner-designated lead. They are resolved in node.send, after this
  // check, so a missing agent of that literal name is not a typo.
  const concrete = to.filter((t) => t !== "lead" && t !== "role:lead");
  if (!concrete.length) return;
  const unknown = node.route(concrete).targets.filter((t) => t.unknown).map((t) => t.name!);
  if (!unknown.length) return;
  const lines = unknown.map((n) => { const s = suggestNames(node, n); return `"${n}" is not an agent on ${node.host}${s.length ? `; did you mean ${s.join(", ")}?` : ""}`; });
  throw Object.assign(new Error(`not sent: ${lines.join("; ")}. List agents with mbx_agents; a mailbox exists once an agent has held it.`), { code: "UNKNOWN_RECIPIENT" });
}

// ---- sender receipts (T207) ---------------------------------------------------------------------
// What happened to mail this agent sent: per recipient, the delivery state (delivered → notified → read → acked) with
// its note and the recipient's "did" line, the recipient's liveness now, and for paired hosts the outbox state.

export interface DeliveryReceipt {
  address: string; state: string; updated_at: string | null; note: string | null; did: string | null; liveness: string;
  /** T642: the wake was admitted into a turn already running, so it waits for that turn (or the session's next tool result). */
  wake?: string;
  outbox?: { attempts: number; last_error_code: string | null; next_at: string };
}

export function deliveryReceipts(node: MbxNode, m: MessageRow, now = Date.now()): DeliveryReceipt[] {
  const dids = new Map((node.store.db.prepare("SELECT json_extract(detail,'$.recipient') r, json_extract(detail,'$.did') d FROM audit WHERE event='peer_action' AND json_extract(detail,'$.msg')=? ORDER BY at")
    .all(m.id) as { r: string; d: string }[]).map((x) => [x.r, x.d]));
  const local = (node.store.db.prepare("SELECT agent,state,updated_at,note FROM deliveries WHERE msg_id=? ORDER BY agent").all(m.id) as
    { agent: string; state: string; updated_at: string; note: string | null }[]).map((d) => {
    const live = d.agent === "owner" ? { live: true, state: "live" as const, detail: "the owner" } : mailboxLiveness(node, d.agent, now);
    const behind = d.state === "delivered" || d.state === "notified" ? queuedBehindTurnAt(node.store, d.agent, m.id) : null;
    return { address: `${d.agent}@${node.host}`, state: d.state, updated_at: d.updated_at, note: d.note, did: dids.get(d.agent) ?? null,
      liveness: `${live.state}: ${live.detail}`,
      ...(behind ? { wake: `${OPENCODE_BEHIND_TURN_NOTE} (admitted ${behind.slice(0, 19)}Z)` } : {}) };
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
      ...got.map((r): DeliveryReceipt => ({ address: r.recipient, state: r.state, updated_at: r.at, note: r.note, did: r.did, liveness: `${projectBoxNote(node, r.recipient.split("@")[0], h)}on paired host ${h} (signed receipt)` })),
      ...(got.length && !pending.length ? [] : [{ address: (got.length ? pending : names).join(",") || `*@${h}`, state: o ? "queued" : "handed-over", updated_at: null, note: null, did: null,
        liveness: o ? `paired host ${h}: not accepted yet` : `accepted by paired host ${h}; no receipt from it yet`,
        ...(o ? { outbox: { attempts: o.attempts, last_error_code: retryErrorClass(o.last_error), next_at: o.next_at } } : {}) }]),
    ];
  });
  return [...local, ...remote];
}

/** One line per recipient, for thread views. */
// "notified" with note "desktop" means only the owner saw a desktop notice: no agent session was told.
// Note "stalled" (T756) means nothing reached anyone: no session wake and no desktop notice.
export const receiptLine = (r: DeliveryReceipt) => `  → ${r.address}: ${r.state === "notified" && r.note === "desktop" ? "notified (owner desktop notice only)" : r.state === "notified" && r.note === "stalled" ? "stalled (no session or notice reached it; it is read on the next prompt)" : r.state}${r.updated_at ? ` ${r.updated_at.slice(0, 19)}Z` : ""}`
  + `${r.wake ? ` · ${r.wake}` : ""}`
  + `${r.did ? ` · did: ${r.did}` : ""}${r.note ? ` · note: ${r.note}` : ""}${r.outbox ? ` · attempts ${r.outbox.attempts}${r.outbox.last_error_code ? ` (${r.outbox.last_error_code})` : ""}` : ""} · ${r.liveness}`;

const DELIVERY_RANKS = new Set(["queued", "delivered", "notified", "read", "acked"]);
const OWN_DELIVERY_LIMIT = 100;
/** Same window as the owner diagnostic's connector report. A missing or older report is not a reason to release. */
const CONNECTOR_FRESH_MS = 5 * 60_000;

export const DELIVERY_GUIDANCE = [
  "Call mbx_whoami in the current provider thread to verify its actual connector and identity.",
  "If its connector is disconnected or stale, reconnect the mbx MCP server before changing ownership.",
  "Ownership stays with this session. Reconnecting does not release it, and this view does not take it over.",
];

export interface OwnDeliveryItem {
  id: string;
  peer: string;
  state: "accepted" | "queued" | "delivered" | "notified" | "read" | "acked";
  failure: { code: string | null; attempts: number; next_retry_at: string } | null;
}

export interface OwnDelivery {
  items: OwnDeliveryItem[];
  truncated: boolean;
  drafts: null;
  draft_reason: "no draft store";
  task_completion: "not-reported";
}

/** This identity's outgoing rows only. A paired host that has taken the push, with no delivery rank yet, is accepted. */
export function ownDelivery(node: MbxNode, agent: string, now = Date.now()): OwnDelivery {
  const sender = `${agent}@${node.host}`;
  const rows = node.store.db.prepare("SELECT * FROM messages WHERE from_addr=? AND origin='local' ORDER BY id LIMIT ?")
    .all(sender, OWN_DELIVERY_LIMIT + 1) as unknown as MessageRow[];
  const page = rows.slice(0, OWN_DELIVERY_LIMIT);
  const items: OwnDeliveryItem[] = [];
  for (const m of page) {
    for (const r of deliveryReceipts(node, m, now)) {
      const state = r.state === "handed-over" ? "accepted" : DELIVERY_RANKS.has(r.state) ? r.state as OwnDeliveryItem["state"] : null;
      if (!state) continue;
      items.push({
        id: m.id, peer: r.address, state,
        failure: r.outbox ? { code: r.outbox.last_error_code, attempts: r.outbox.attempts, next_retry_at: r.outbox.next_at } : null,
      });
    }
  }
  return { items, truncated: rows.length > OWN_DELIVERY_LIMIT, drafts: null, draft_reason: "no draft store", task_completion: "not-reported" };
}

/** Reconnect text when this identity's own connector report is missing or stale. Reads the lease; writes nothing. */
export function connectorGuidance(store: Store, agent: string, now = Date.now()): string[] {
  const lease = store.db.prepare("SELECT holder_pid, holder_start, released_at FROM identity_leases WHERE name=?").get(agent) as
    { holder_pid: number; holder_start: string; released_at: number | null } | undefined;
  if (!lease || lease.released_at != null) return DELIVERY_GUIDANCE;
  const raw = store.get(connectorKey(lease.holder_pid));
  if (!raw) return DELIVERY_GUIDANCE;
  let report: { v?: unknown; pid?: unknown; start?: unknown; version?: unknown; tools?: unknown; at?: unknown };
  try { report = JSON.parse(raw) as typeof report; } catch { return DELIVERY_GUIDANCE; }
  const at = typeof report.at === "string" ? Date.parse(report.at) : NaN;
  const current = report.v === 1 && report.pid === lease.holder_pid && report.start === lease.holder_start
    && typeof report.version === "string" && Array.isArray(report.tools)
    && Number.isFinite(at) && at <= now + 60_000 && now - at <= CONNECTOR_FRESH_MS;
  return current ? [] : DELIVERY_GUIDANCE;
}

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
