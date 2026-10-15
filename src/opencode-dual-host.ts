// T646: one OpenCode session loaded by two serves (a standalone tab and the shared service). The serve that holds
// the lease and session row and the serve that published the session's control endpoint differ, so wakes are
// refused or pushed into the wrong process. Doctor reports it; nothing is stopped or rewritten here.
import { listIdentityControls } from "./identity-control.ts";
import { inspectLeaseProcesses } from "./identity-leases.ts";
import { opencodeHostClassifier, type OpencodeHost } from "./opencode-provider.ts";
import type { MbxNode } from "./node.ts";

export interface DualHost { session_id: string; agent: string; bound: { pid: number; host: OpencodeHost }; published: { pid: number; host: OpencodeHost } }

/** Bound sessions whose published control endpoint lives under a different live serve than the session row. */
export function findOpencodeDualHosts(node: MbxNode, host: (pid: number | null) => OpencodeHost = opencodeHostClassifier()): DualHost[] {
  const rows = node.store.db.prepare("SELECT agent, session_id, pid FROM sessions WHERE cli='opencode' AND session_id NOT LIKE 'mcp-%' AND pid IS NOT NULL ORDER BY session_id")
    .all() as { agent: string; session_id: string; pid: number }[];
  if (!rows.length) return [];
  const published = new Map(listIdentityControls(node.store).filter(d => d.cli === "opencode").map(d => [d.session_id, d]));
  const split = rows.flatMap(r => { const d = published.get(r.session_id); return d && d.parent_pid !== r.pid ? [{ r, d }] : []; });
  if (!split.length) return [];
  const evidence = inspectLeaseProcesses(split.flatMap(({ r, d }) => [r.pid, d.parent_pid]));
  return split.flatMap(({ r, d }) => {
    if (evidence.get(r.pid)?.alive !== true || evidence.get(d.parent_pid)?.alive !== true || evidence.get(d.parent_pid)?.start !== d.parent_start) return [];
    return [{ session_id: r.session_id, agent: r.agent, bound: { pid: r.pid, host: host(r.pid) }, published: { pid: d.parent_pid, host: host(d.parent_pid) } }];
  });
}

export function opencodeDualHostChecks(node: MbxNode, host?: (pid: number | null) => OpencodeHost): Array<{ level: "warn"; label: string; fix: string }> {
  return findOpencodeDualHosts(node, host).map(x => ({
    level: "warn" as const,
    label: `opencode: session ${x.session_id} (${x.agent}) is bound to the ${x.bound.host} serve pid ${x.bound.pid} but its control endpoint was published by the ${x.published.host} serve pid ${x.published.pid}; two OpenCode processes have this session loaded`,
    fix: "keep the session open in one OpenCode process only (close it in the other client); do not stop a serve based on this check alone",
  }));
}
