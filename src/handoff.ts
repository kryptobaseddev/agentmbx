// T159: handoff context (spec docs/spec/handoff-context.md). A crash or provider switch recovers two things: context computed
// fresh from the mailbox at read time (nothing stored, so nothing is lost), and one small note an agent saved on purpose.
// The note is the only persisted artifact: kv `handoff:<name>`, one per identity, replace-only, 30 days, bounded. It carries
// references, never status: a task ref is a CLEO id some message this identity can see mentions (signed meta.task_refs), and
// its status comes only from authorized CLEO evidence at resume time. Nothing here grants authority or marks anything handled.
import { missedCount, readCatchup } from "./catchup.ts";
import type { MbxNode } from "./node.ts";
import type { Store } from "./store.ts";

export const handoffKey = (name: string) => `handoff:${name}`;
export const HANDOFF_NOTE_MAX = 4000;
/** T652: the schema bound is wider than the note limit, so an over-long note reaches cleanNote and is told how much to cut. */
export const HANDOFF_NOTE_INPUT_MAX = 64_000;
export const HANDOFF_REFS_MAX = 20;
export const HANDOFF_RETENTION_MS = 30 * 86_400_000;
export const HANDOFF_CONTEXT_THREADS = 20;
const TASK_REF = /^T\d{2,6}$/;
const MSG_REF = /^[A-Za-z0-9_-]{6,64}$/;

export interface HandoffNote { v: 1; note: string; task_refs: string[]; msg_refs: string[]; saved_at: number; by: string }
export type HandoffRead = { note: HandoffNote; reason: null } | { note: null; reason: "none" | "expired" | "malformed" };
export interface HandoffInput { note?: string; task_refs?: string[]; msg_refs?: string[] }
export interface HandoffDraft { note: string; task_refs: string[]; msg_refs: string[]; dropped: { task_refs: string[]; msg_refs: string[] } }

const fail = (code: string, message: string): never => { throw Object.assign(new Error(message), { code }); };
const strings = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === "string");

/** The saved note, or why there is none. A record that is not exactly this shape is dropped whole, never read in part (R10). */
export function readHandoff(store: Store, name: string, now = Date.now()): HandoffRead {
  const raw = store.get(handoffKey(name));
  if (raw === undefined) return { note: null, reason: "none" };
  let r: HandoffNote;
  try { r = JSON.parse(raw) as HandoffNote; } catch { return { note: null, reason: "malformed" }; }
  if (!r || typeof r !== "object" || r.v !== 1 || typeof r.note !== "string" || r.note.length > HANDOFF_NOTE_MAX
    || !strings(r.task_refs) || !strings(r.msg_refs) || r.task_refs.length > HANDOFF_REFS_MAX || r.msg_refs.length > HANDOFF_REFS_MAX
    || !r.task_refs.every((t) => TASK_REF.test(t)) || !r.msg_refs.every((m) => MSG_REF.test(m))
    || !Number.isSafeInteger(r.saved_at) || typeof r.by !== "string") return { note: null, reason: "malformed" };
  if (now - r.saved_at > HANDOFF_RETENTION_MS) return { note: null, reason: "expired" };
  return { note: r, reason: null };
}

/** Redaction is explicit and bounded: NFC, control characters other than tab and newline removed, and a note over the limit
 *  refused rather than truncated (R4). */
export function cleanNote(text: string): string {
  // eslint-disable-next-line no-control-regex
  const s = text.normalize("NFC").replace(/[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/g, "");
  if (s.length > HANDOFF_NOTE_MAX) fail("HANDOFF_TOO_LONG", `the handoff note is ${s.length} characters; the limit is ${HANDOFF_NOTE_MAX}: cut at least ${s.length - HANDOFF_NOTE_MAX} characters and save again. It is never truncated.`);
  return s;
}

/** Keep the last HANDOFF_REFS_MAX distinct refs; the excess is dropped oldest-first (the earliest given), never cut (R5). */
function bounded(refs: string[]): { kept: string[]; dropped: string[] } {
  const distinct = [...new Set(refs)];
  const cut = Math.max(0, distinct.length - HANDOFF_REFS_MAX);
  return { kept: distinct.slice(cut), dropped: distinct.slice(0, cut) };
}

/** A task ref is evidence-linked: some message this identity can see (received or its own) mentions it in its signed meta. */
function taskLinked(node: MbxNode, name: string, ref: string): boolean {
  const rows = node.store.db.prepare(`SELECT m.* FROM messages m WHERE EXISTS (SELECT 1 FROM json_each(m.envelope, '$.meta.task_refs') j WHERE j.value=?)
    ORDER BY m.received_at DESC LIMIT 200`).all(ref) as unknown as Parameters<MbxNode["canSee"]>[0][];
  return rows.some((m) => node.canSee(m, name));
}

/** Validate a note to save. Refs that are malformed or that this identity cannot see are refused, so a ref is never a guess. */
export function validateHandoff(node: MbxNode, name: string, input: HandoffInput): HandoffDraft {
  const note = cleanNote(input.note ?? "");
  for (const t of input.task_refs ?? []) {
    if (!TASK_REF.test(t)) fail("HANDOFF_REF_INVALID", `${JSON.stringify(t)} is not a CLEO task id such as T159`);
    if (!taskLinked(node, name, t)) fail("HANDOFF_REF_UNLINKED", `${t} appears in no message this identity can see; a task ref must be linked by a message`);
  }
  for (const id of input.msg_refs ?? []) {
    if (!MSG_REF.test(id)) fail("HANDOFF_REF_INVALID", `${JSON.stringify(id)} is not a message id`);
    const m = node.message(id, name);
    if (!m || !node.canSee(m, name)) fail("HANDOFF_REF_UNLINKED", `no message ${id} in this identity's mailbox`);
  }
  const tasks = bounded(input.task_refs ?? []), msgs = bounded(input.msg_refs ?? []);
  return { note, task_refs: tasks.kept, msg_refs: msgs.kept, dropped: { task_refs: tasks.dropped, msg_refs: msgs.dropped } };
}

/** Replace the one note (R5). The caller holds the identity's write lease; a failure inside its transaction keeps the old note. */
export function saveHandoff(store: Store, name: string, draft: HandoffDraft, by: string, now = Date.now()): HandoffNote {
  const record: HandoffNote = { v: 1, note: draft.note, task_refs: draft.task_refs, msg_refs: draft.msg_refs, saved_at: now, by };
  store.set(handoffKey(name), JSON.stringify(record));
  return record;
}

/** Rename moves the note with the registration, next to moveCatchup; release, retire and forward leave it (R6). */
export function moveHandoff(store: Store, from: string, to: string): void {
  const raw = store.get(handoffKey(from));
  if (raw === undefined) return;
  store.set(handoffKey(to), raw);
  store.db.prepare("DELETE FROM kv WHERE k=?").run(handoffKey(from));
}

/** One line for whoami and the claim result (R7): a note exists, how many refs, and when it was saved. Never the text. */
export function handoffPointer(store: Store, name: string): { saved_at: string; task_refs: number; msg_refs: number; read: string } | null {
  const { note } = readHandoff(store, name);
  return note ? { saved_at: new Date(note.saved_at).toISOString(), task_refs: note.task_refs.length, msg_refs: note.msg_refs.length, read: "mbx_handoff" } : null;
}

/** The note as mbx_handoff returns it: every ref with how to re-verify it, never a status. */
export function presentHandoff(read: HandoffRead) {
  if (!read.note) return { note: null, reason: read.reason };
  const n = read.note;
  return { note: n.note, saved_at: new Date(n.saved_at).toISOString(), expires_at: new Date(n.saved_at + HANDOFF_RETENTION_MS).toISOString(),
    task_refs: n.task_refs.map((id) => ({ id, verify: `cleo show ${id}` })), msg_refs: n.msg_refs.map((id) => ({ id, verify: "mbx_read or mbx_thread" })) };
}

/**
 * Context computed now from this identity's own mailbox (R1-R3), stored nowhere: open threads newest-first (bounded), each with
 * both ends of its unacked range so a resume session can page it from either side, plus counts and the catch-up position.
 * Subjects are the only free text (bounded at send). No bodies, envelopes, policies, tokens or provider reasoning.
 */
export function handoffContext(node: MbxNode, name: string) {
  const threads = node.store.db.prepare(`SELECT m.thread thread, COUNT(*) unacked, MIN(m.id) oldest, MAX(m.id) newest, MAX(m.received_at) last,
      MAX(COALESCE(json_extract(m.envelope, '$.needs_reply'), 0)) needs_reply
    FROM deliveries d JOIN messages m ON m.id=d.msg_id WHERE d.agent=? AND d.state<>'acked' GROUP BY m.thread ORDER BY last DESC`)
    .all(name) as { thread: string; unacked: number; oldest: string; newest: string; needs_reply: number }[];
  const head = node.store.db.prepare("SELECT subject, from_addr FROM messages WHERE id=?");
  return {
    open_threads: threads.length,
    threads: threads.slice(0, HANDOFF_CONTEXT_THREADS).map((t) => {
      const h = head.get(t.newest) as { subject: string; from_addr: string };
      return { thread: t.thread, subject: h.subject, from: h.from_addr, unacked: Number(t.unacked), oldest_unacked_id: t.oldest,
        newest_unacked_id: t.newest, needs_reply: !!t.needs_reply };
    }),
    unread: node.unreadCount(name),
    missed: missedCount(node.store, name).missed,
    catchup_position: readCatchup(node.store, name)?.position ?? null,
  };
}
