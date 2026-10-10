// Advisory only: missing connector records never release or recreate an identity.
import { fingerprint } from "./crypto.js";
import { NAME_RE } from "./envelope.js";
import { listIdentityControls } from "./identity-control.js";
import { inspectLeaseProcesses, processGone, UNKNOWN_PROCESS } from "./identity-leases.js";
import { kimiMultiHost } from "./kimi-web.js";
export function hookDisconnectedNote(node, cli, session, providerPid) {
    if (session.length > 300 || session !== session.trim() || !session || /[\u0000-\u001f\u007f-\u009f]/u.test(session) || session.startsWith("mcp-"))
        return null;
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
        }
        catch { /* malformed records cannot establish a live connection */ }
    }
    const evidence = inspectLeaseProcesses([providerPid, ...records.map(r => r.pid)]);
    const parent = evidence.get(providerPid) ?? UNKNOWN_PROCESS;
    if (records.some(r => (!r.parentStart || !processGone(r.parentStart, parent))
        && !processGone(r.start, evidence.get(r.pid) ?? UNKNOWN_PROCESS)))
        return null;
    const identity = name ?? exact.find(d => d.agent)?.agent;
    return `[mbx] mbx disconnected: reconnect (e.g. /mcp in Claude Code)${identity ? `; this session no longer holds ${identity}@${node.host}` : ""}.`;
}
