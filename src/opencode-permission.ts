import type { MbxNode } from "./node.ts";
import { resolveAgent } from "./permission.ts";
import { hasClass } from "./policy.ts";

/** Whether the plugin inside a standalone OpenCode serve may set effect "allow".
 *  Allow only for a live `ses_` binding whose pid matches, whose lease still matches that
 *  process, and whose agent has an active permissions-class policy. Anything else is an
 *  explicit skip. This never calls the shared OpenCode service. */
export function opencodePermissionDecision(node: MbxNode, sessionID: string, pid: number): { decision: "allow" } | { skip: true } {
  const skip = { skip: true as const };
  if (!sessionID.startsWith("ses_") || sessionID.length > 256 || !Number.isInteger(pid) || pid <= 0) return skip;
  const row = node.store.db.prepare(
    "SELECT agent, pid, cwd FROM sessions WHERE cli='opencode' AND session_id=?",
  ).get(sessionID) as { agent: string; pid: number | null; cwd: string | null } | undefined;
  if (!row?.agent || row.pid !== pid) return skip;
  if (resolveAgent(node, "opencode", sessionID, row.cwd ?? "", pid) !== row.agent) return skip;
  const grant = hasClass(node.store.db, row.agent, node.host, "permissions", { cwd: row.cwd });
  if (!grant.ok) return skip;
  node.store.audit("yolo_allow", { agent: row.agent, cli: "opencode", tool: "opencode-permission", policy_id: grant.policy_id ?? null });
  return { decision: "allow" };
}
