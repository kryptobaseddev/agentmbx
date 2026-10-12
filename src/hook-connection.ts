// Advisory only: missing connector records never release or recreate an identity.
import { REBINDING_CLIS } from "./cli-identity.ts";
import { fingerprint } from "./crypto.ts";
import { NAME_RE } from "./envelope.ts";
import { listIdentityControls } from "./identity-control.ts";
import { inspectLeaseProcesses, processGone, UNKNOWN_PROCESS } from "./identity-leases.ts";
import { kimiMultiHost } from "./kimi-web.ts";
import type { MbxNode } from "./node.ts";
import { procStart } from "./proc.ts";

const invalidSession = (session: string) =>
  session.length > 300 || session !== session.trim() || !session || /[\u0000-\u001f\u007f-\u009f]/u.test(session) || session.startsWith("mcp-");

/**
 * T573: a resumed provider process (`claude --resume`, Hermes /resume) runs its first hook before its own mbx server has
 * connected. When that process has never connected and the session's remembered identity is free for this same session,
 * the server reclaims it by itself (mcp.ts rememberedName / sessionHint), so the hook must not report the identity lost.
 * Database reads plus one inspection of the provider's own birth time; it never binds, claims or releases.
 */
export function hookResumingNote(node: MbxNode, cli: string, session: string, providerPid: number): string | null {
  if (!REBINDING_CLIS.includes(cli) || invalidSession(session)) return null;
  const name = node.store.get(`name:${cli}:${session}`);
  // An explicit release or takeover deletes this binding: nothing will be reclaimed.
  if (!name || !NAME_RE.test(name) || node.store.get(`identity-conflict:${name}`) !== undefined) return null;
  // A provider that already connected and lost its connector is disconnected (T503), not resuming. A row whose recorded
  // birth time differs belongs to an earlier process that had this pid; unknown evidence counts as connected.
  const start = procStart(providerPid);
  const rows = node.store.db.prepare("SELECT pid_start FROM sessions WHERE cli=? AND pid=?").all(cli, providerPid);
  if (rows.some(r => typeof r.pid_start !== "string" || !start || r.pid_start === start)) return null;
  if (listIdentityControls(node.store).some(d => d.cli === cli && d.parent_pid === providerPid)) return null;
  const lease = node.store.db.prepare("SELECT cli,session_id,released_at FROM identity_leases WHERE name=?").get(name);
  if (!lease || (lease.released_at === null && (lease.cli !== cli || lease.session_id !== session))) return null;
  return `[mbx] Resuming ${name}@${node.host}: this session's mailbox server is still connecting. Call mbx_whoami and wait for its result before claiming or registering.`;
}

export function hookDisconnectedNote(node: MbxNode, cli: string, session: string, providerPid: number): string | null {
  if (invalidSession(session)) return null;
  const row = node.store.db.prepare("SELECT session_key,pid_start FROM sessions WHERE cli=? AND session_id=? AND pid=?").get(cli, session, providerPid);
  const key = typeof row?.session_key === "string" ? row.session_key : null;
  const remembered = node.store.get(`name:${cli}:${session}`);
  const name = remembered && NAME_RE.test(remembered) ? remembered : null;
  const controls = listIdentityControls(node.store).filter(d => d.cli === cli && d.parent_pid === providerPid);
  // A known shared-host conversation must not borrow another conversation's live connector.
  // Before a first binding, a live provider connector can still initialize this conversation.
  const exact = controls.filter(d => d.session_id === session || (key && d.control_key === fingerprint(key)));
  const selected = exact.length ? exact : controls.filter(d => (!key && !name)
    || ["claude", "hermes"].includes(cli) || (cli === "kimi" && !kimiMultiHost(providerPid))
    || (cli === "opencode" && name && d.agent === name));
  const records = selected.map(d => ({ pid: d.mcp_pid, start: d.mcp_start, parentStart: d.parent_start }));
  if (key) {
    try {
      const record = JSON.parse(node.store.get(`mcp-process:${key}`) ?? "null");
      if (record && Number.isSafeInteger(record.pid) && record.pid > 0 && typeof record.start === "string" && record.start)
        records.push({ pid: record.pid, start: record.start, parentStart: typeof row?.pid_start === "string" ? row.pid_start : "" });
    } catch { /* malformed records cannot establish a live connection */ }
  }
  const evidence = inspectLeaseProcesses([providerPid, ...records.map(r => r.pid)]);
  const parent = evidence.get(providerPid) ?? UNKNOWN_PROCESS;
  if (records.some(r => (!r.parentStart || !processGone(r.parentStart, parent))
    && !processGone(r.start, evidence.get(r.pid) ?? UNKNOWN_PROCESS))) return null;
  const identity = name ?? exact.find(d => d.agent)?.agent;
  return `[mbx] mbx disconnected: reconnect (e.g. /mcp in Claude Code)${identity ? `; this session no longer holds ${identity}@${node.host}` : ""}.`;
}
