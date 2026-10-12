// T189: the bounded resume notice (spec t184-provider-resume-adapters, R5-R9). A new or resumed conversation learns who it
// is and what it has not caught up on, once per entry, from store reads only: no claim, no checkpoint advance, no mail state
// change, no message content. Harness adapters (T185-T188, T599) import this; keep the API small and harness-neutral.
import { catchupHint } from "./catchup.js";
/** Under every harness's context cap (Codex spills above ~2,500 tokens), so the notice is never moved to a file. */
export const RESUME_NOTICE_MAX_CHARS = 1200;
export const RESUME_NOTICE_MAX_LINES = 8;
const openThreads = (store, agent) => Number(store.db.prepare("SELECT COUNT(DISTINCT m.thread) n FROM deliveries d JOIN messages m ON m.id=d.msg_id WHERE d.agent=? AND d.state<>'acked'").get(agent).n);
/**
 * The notice for a bound identity: the caller's identity line, the catch-up hint verbatim (over-limit variant included), and
 * the open-thread count when there is one. Counts only, never subjects, bodies, notes or task status (R6). Bounded (R7):
 * the open-thread line is cut first, then the text is cut at the character limit.
 */
export function resumeNotice(store, agent, identityLine) {
    const threads = openThreads(store, agent);
    const parts = [identityLine, catchupHint(store, agent), threads ? `[mbx] ${threads} open thread(s) with unacked mail.` : null]
        .filter((p) => !!p);
    const fits = (p) => p.join("\n").length <= RESUME_NOTICE_MAX_CHARS && p.join("\n").split("\n").length <= RESUME_NOTICE_MAX_LINES;
    while (parts.length > 1 && !fits(parts))
        parts.pop();
    const text = parts.join("\n").split("\n").slice(0, RESUME_NOTICE_MAX_LINES).join("\n");
    return text.length <= RESUME_NOTICE_MAX_CHARS ? text : `${text.slice(0, RESUME_NOTICE_MAX_CHARS - 1)}…`;
}
/**
 * True once per entry of one provider process into a conversation (R8): the first call for a session id this process (pid
 * plus its recorded start) has not been in, and every switch after that (/new, /resume, back to an earlier conversation, a
 * compression's new id, a new process resuming the same id). Records the entry; one key per pid, so it stays bounded.
 */
export function takeResumeEntry(store, cli, pid, pidStart, session) {
    const key = `resume-entry:${cli}:${pid}`, value = `${pidStart ?? "?"} ${session}`;
    if (store.get(key) === value)
        return false;
    store.set(key, value);
    return true;
}
