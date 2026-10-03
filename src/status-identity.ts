// Which mailbox a status display (statusline, HUD, `agentmbx status`) belongs to (T310). Read-only and display-only:
// it never grants anything. Resolution is exact: the provider's current session id, then that provider process's own
// bindings (one live holder under that pid), else unbound. It never guesses from a directory or a shared default name,
// because in a folder used by several agents that name belongs to whoever registered it first (owner report 2026-10-02).
import type { MbxNode } from "./node.ts";
import { claudeSessionId } from "./proc.ts";

export type StatusIdentityState = "bound" | "unbound" | "ambiguous";
export interface StatusIdentity { name: string | null; state: StatusIdentityState; resolved_by: "session_id" | "pid" | null; candidates?: string[] }

export function resolveStatusIdentity(node: MbxNode, cli: string, o: { sessionId?: string | null; pid?: number | null } = {}): StatusIdentity {
  const db = node.store.db;
  const sid = o.sessionId ?? (cli === "claude" && o.pid ? claudeSessionId(o.pid) : null);
  if (sid) {
    const row = db.prepare("SELECT agent FROM sessions WHERE cli=? AND session_id=?").get(cli, sid) as { agent: string } | undefined;
    if (row) return { name: row.agent, state: "bound", resolved_by: "session_id" };
  }
  if (o.pid) {
    // The provider process's own bindings, held by a live lease: after /clear the session row may still carry the
    // previous id until the next hook rebinds it, but it is the same process and the same holder.
    const names = [...new Set((db.prepare(`SELECT s.agent FROM sessions s JOIN identity_leases l ON l.name=s.agent
      WHERE s.cli=? AND s.pid=? AND l.released_at IS NULL`).all(cli, o.pid) as { agent: string }[]).map((r) => r.agent))];
    if (names.length === 1) return { name: names[0], state: "bound", resolved_by: "pid" };
    if (names.length > 1) return { name: null, state: "ambiguous", resolved_by: null, candidates: names.sort() };
  }
  return { name: null, state: "unbound", resolved_by: null };
}
