// T189: the bounded resume notice (spec t184-provider-resume-adapters, R5-R9). A new or resumed conversation learns who it
// is and what it has not caught up on, once per entry, from store reads only: no claim, no checkpoint advance, no mail state
// change, no message content. Harness adapters (T185-T188, T599) import this; keep the API small and harness-neutral.
import { catchupHint } from "./catchup.ts";
import { readHandoff } from "./handoff.ts";
import type { Store } from "./store.ts";

/** Under every harness's context cap (Codex spills above ~2,500 tokens), so the notice is never moved to a file. */
export const RESUME_NOTICE_MAX_CHARS = 1200;
export const RESUME_NOTICE_MAX_LINES = 8;

const openThreads = (store: Store, agent: string): number => Number(store.db.prepare(
  "SELECT COUNT(DISTINCT m.thread) n FROM deliveries d JOIN messages m ON m.id=d.msg_id WHERE d.agent=? AND d.state<>'acked'").get(agent)!.n);

/** (e) T159: the saved handoff note's task ids only, never its text or any status (spec D2/D3). */
const savedRefs = (store: Store, agent: string): string | null => {
  const { note } = readHandoff(store, agent);
  if (!note) return null;
  return note.task_refs.length ? `[mbx] Saved handoff: task refs ${note.task_refs.join(", ")} (verify each with cleo show); call mbx_handoff.`
    : "[mbx] Saved handoff note: call mbx_handoff.";
};

/**
 * The notice for a bound identity: the caller's identity line, the catch-up hint verbatim (over-limit variant included), the
 * open-thread count when there is one, and the saved handoff's task ids (T159). Counts and ids only, never subjects, bodies,
 * notes or task status (R6). Bounded (R7): the handoff line is cut first, then the open-thread line, then the text is cut
 * at the character limit.
 */
export function resumeNotice(store: Store, agent: string, identityLine: string): string {
  const threads = openThreads(store, agent);
  const parts = [identityLine, catchupHint(store, agent), threads ? `[mbx] ${threads} open thread(s) with unacked mail.` : null,
    savedRefs(store, agent)]
    .filter((p): p is string => !!p);
  const fits = (p: string[]) => p.join("\n").length <= RESUME_NOTICE_MAX_CHARS && p.join("\n").split("\n").length <= RESUME_NOTICE_MAX_LINES;
  while (parts.length > 1 && !fits(parts)) parts.pop();
  const text = parts.join("\n").split("\n").slice(0, RESUME_NOTICE_MAX_LINES).join("\n");
  return text.length <= RESUME_NOTICE_MAX_CHARS ? text : `${text.slice(0, RESUME_NOTICE_MAX_CHARS - 1)}…`;
}

/**
 * True once per entry of one provider process into a conversation (R8): the first call for a session id this process (pid
 * plus its recorded start) has not been in, and every switch after that (/new, /resume, back to an earlier conversation, a
 * compression's new id, a new process resuming the same id). Records the entry; one key per pid, so it stays bounded.
 */
export function takeResumeEntry(store: Store, cli: string, pid: number, pidStart: string | null, session: string): boolean {
  const key = `resume-entry:${cli}:${pid}`, value = `${pidStart ?? "?"} ${session}`;
  if (store.get(key) === value) return false;
  store.set(key, value);
  return true;
}
