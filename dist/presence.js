/** A CLEO task id, the only form `task:<id>` addresses. */
export const TASK_RE = /^T\d+$/;
/** Record task and lane on one session row. An omitted field is left as it is. A rebind does not clear them. */
export function setSessionPresence(node, s) {
    if (s.task !== undefined && !TASK_RE.test(s.task))
        throw new Error(`invalid task "${s.task}"`);
    const sets = [];
    const args = [];
    if (s.task !== undefined) {
        sets.push("task=?");
        args.push(s.task);
    }
    if (s.lane !== undefined) {
        sets.push("lane=?");
        args.push(s.lane);
    }
    if (!sets.length)
        return;
    node.store.db.prepare(`UPDATE sessions SET ${sets.join(", ")} WHERE cli=? AND session_id=?`).run(...args, s.cli, s.sessionId);
}
