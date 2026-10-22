// Which mailbox a status display (statusline, HUD, `agentmbx status`) belongs to (T310). Read-only and display-only:
// it never grants anything. Resolution is exact: the provider's current session id, then that provider process's own
// bindings (one live holder under that pid), else unbound. It never guesses from a directory or a shared default name,
// because in a folder used by several agents that name belongs to whoever registered it first (owner report 2026-10-02).
import { fingerprint } from "./crypto.ts";
import { sharedConversationCli } from "./cli-identity.ts";
import type { MbxNode } from "./node.ts";
import { claudeSessionId } from "./proc.ts";

export type StatusIdentityState = "bound" | "unbound" | "ambiguous";
/** T723: this session's binding names a mailbox whose live lease another holder (another key) has: it is not this session's. */
export interface StatusLostTo { name: string; cli: string; session: string }
export interface StatusIdentity { name: string | null; state: StatusIdentityState; resolved_by: "session_id" | "pid" | null; candidates?: string[]; lost_to?: StatusLostTo }

export function resolveStatusIdentity(node: MbxNode, cli: string, o: { sessionId?: string | null; pid?: number | null } = {}): StatusIdentity {
  const db = node.store.db;
  const sid = o.sessionId ?? (cli === "claude" && o.pid ? claudeSessionId(o.pid) : null);
  if (sid) {
    const row = db.prepare("SELECT agent,session_key FROM sessions WHERE cli=? AND session_id=?").get(cli, sid) as { agent: string; session_key: string | null } | undefined;
    if (row) {
      const lease = db.prepare("SELECT cli,session_id,key_fp FROM identity_leases WHERE name=? AND released_at IS NULL").get(row.agent) as
        { cli: string; session_id: string; key_fp: string } | undefined;
      // T723: on a shared provider transport (OpenCode/Antigravity), a conversation whose mailbox another conversation took keeps its binding row.
      if (sharedConversationCli(cli) && lease && (lease.cli !== cli || lease.session_id !== sid) && row.session_key && fingerprint(row.session_key) !== lease.key_fp)
        return { name: null, state: "unbound", resolved_by: null, lost_to: { name: row.agent, cli: lease.cli, session: lease.session_id } };
      return { name: row.agent, state: "bound", resolved_by: "session_id" };
    }
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
