// The CLEO task and lane of a live session (T497). They live on the session row, not the identity:
// a persona that moves to another task must stop receiving task: mail for the old one.
import type { MbxNode } from "./node.ts";

/** A CLEO task id, the only form `task:<id>` addresses. */
export const TASK_RE = /^T\d+$/;

/** Record task and lane on one session row. An omitted field is left as it is. A rebind does not clear them. */
export function setSessionPresence(node: MbxNode, s: { cli: string; sessionId: string; task?: string; lane?: string }): void {
  if (s.task !== undefined && !TASK_RE.test(s.task)) throw new Error(`invalid task "${s.task}"`);
  const sets: string[] = [];
  const args: string[] = [];
  if (s.task !== undefined) { sets.push("task=?"); args.push(s.task); }
  if (s.lane !== undefined) { sets.push("lane=?"); args.push(s.lane); }
  if (!sets.length) return;
  node.store.db.prepare(`UPDATE sessions SET ${sets.join(", ")} WHERE cli=? AND session_id=?`).run(...args, s.cli, s.sessionId);
}
