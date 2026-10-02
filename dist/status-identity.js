import { claudeSessionId } from "./proc.js";
export function resolveStatusIdentity(node, cli, o = {}) {
    const db = node.store.db;
    const sid = o.sessionId ?? (cli === "claude" && o.pid ? claudeSessionId(o.pid) : null);
    if (sid) {
        const row = db.prepare("SELECT agent FROM sessions WHERE cli=? AND session_id=?").get(cli, sid);
        if (row)
            return { name: row.agent, state: "bound", resolved_by: "session_id" };
    }
    if (o.pid) {
        // The provider process's own bindings, held by a live lease: after /clear the session row may still carry the
        // previous id until the next hook rebinds it, but it is the same process and the same holder.
        const names = [...new Set(db.prepare(`SELECT s.agent FROM sessions s JOIN identity_leases l ON l.name=s.agent
      WHERE s.cli=? AND s.pid=? AND l.released_at IS NULL`).all(cli, o.pid).map((r) => r.agent))];
        if (names.length === 1)
            return { name: names[0], state: "bound", resolved_by: "pid" };
        if (names.length > 1)
            return { name: null, state: "ambiguous", resolved_by: null, candidates: names.sort() };
    }
    return { name: null, state: "unbound", resolved_by: null };
}
