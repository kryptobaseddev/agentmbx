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
 * T573/T614: a resumed provider process runs its first hook before its own mbx server has
 * connected. When this thread has not connected in the current process and its remembered identity is free for it,
 * the server reclaims it by itself (mcp.ts rememberedName / contextFor), so the hook must not report the identity lost.
 * It reads stored bindings and process birth evidence; it never binds, claims or releases.
 */
export function hookResumingNote(node: MbxNode, cli: string, session: string, providerPid: number): string | null {
  if ((!REBINDING_CLIS.includes(cli) && cli !== "codex") || invalidSession(session)) return null;
  if (cli === "codex" && !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(session)) return null;
  const name = node.store.get(`name:${cli}:${session}`);
  // An explicit release or takeover deletes this binding: nothing will be reclaimed.
  if (!name || !NAME_RE.test(name) || node.store.get(`identity-conflict:${name}`) !== undefined) return null;
  // A provider that already connected and lost its connector is disconnected (T503), not resuming. A row whose recorded
  // birth time differs belongs to an earlier process that had this pid; unknown evidence counts as connected.
  const start = procStart(providerPid);
  const rows = node.store.db.prepare("SELECT pid_start,session_id FROM sessions WHERE cli=? AND pid=?").all(cli, providerPid)
    .filter(r => cli !== "codex" || r.session_id === session);
  if (rows.some(r => typeof r.pid_start !== "string" || !start || r.pid_start === start)) return null;
  // A connector of this provider process that holds an identity is connected: T503 decides whether it is alive. T610: one that
  // is live but holds nothing yet (an MCP restarted with the provider claims the remembered identity on its first tool call)
  // is still resuming; a dead or reborn unbound connector is not, and the disconnected path reports it.
  // Codex shares a transport: only this thread or an unclaimed provisional transport can establish its startup state.
  const controls = listIdentityControls(node.store).filter(d => d.cli === cli && d.parent_pid === providerPid
    && (cli !== "codex" || d.session_id === session || (!d.agent && d.session_id.startsWith("mcp-"))));
  if (controls.some(d => d.agent)) return null;
  if (controls.length) {
    const evidence = inspectLeaseProcesses([providerPid, ...controls.map(d => d.mcp_pid)]);
    const parent = evidence.get(providerPid) ?? UNKNOWN_PROCESS;
    if (!controls.some(d => !processGone(d.parent_start, parent) && !processGone(d.mcp_start, evidence.get(d.mcp_pid) ?? UNKNOWN_PROCESS))) return null;
  }
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
  // T655: an OpenCode serve runs session-start before its mbx server has published anything, and the plugin shows that
  // note at the first tool result. A session this serve never bound, with no remembered identity and no connector record of
  // this provider at all, has not connected yet: that is not a lost connector. (Other harnesses start their server before
  // their hooks, so there a never-seen connector keeps the T503 guidance.)
  if (cli === "opencode" && !row && !name && !records.length) return null;
  const evidence = inspectLeaseProcesses([providerPid, ...records.map(r => r.pid)]);
  const parent = evidence.get(providerPid) ?? UNKNOWN_PROCESS;
  if (records.some(r => (!r.parentStart || !processGone(r.parentStart, parent))
    && !processGone(r.start, evidence.get(r.pid) ?? UNKNOWN_PROCESS))) return null;
  const identity = name ?? exact.find(d => d.agent)?.agent;
  // T655: OpenCode's own control: /mcps opens its MCP servers dialog, where selecting a server connects it again.
  const advice = cli === "opencode" ? "reconnect it with /mcps in OpenCode (select mbx)" : "reconnect (e.g. /mcp in Claude Code)";
  return `[mbx] mbx disconnected: ${advice}${identity ? `; this session no longer holds ${identity}@${node.host}` : ""}.`;
}
