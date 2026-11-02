import { activeLead } from "./lead-record.js";
import { notSlot } from "./project-slot.js";
export const REMIND_AFTER_MS = 30 * 60_000;
export const ALERT_AFTER_MS = 2 * 3600_000;
/** Older reads are left alone: the alert is for work going stale now, not for archaeology. */
const LOOKBACK_MS = 7 * 24 * 3600_000;
const iso = (ms) => new Date(ms).toISOString();
const INFORMATIONAL = `m.kind IN ('message','reply','status') AND m.authority IS NULL AND coalesce(json_extract(m.envelope,'$.needs_reply'),0)=0`;
const WORK = `(m.kind IN ('request','task','decision','alert') OR m.authority IS NOT NULL OR json_extract(m.envelope,'$.needs_reply')=1)`;
/** Ack read copies of informational mail: `ids` after a full read, or (no ids) every one not merely peeked at with a
 *  metadata read. One audit row per call; returns the count. */
export function autoAckRead(store, ids, agent, now = Date.now()) {
    if (ids && !ids.length)
        return 0;
    const only = ids ? `AND m.id IN (${ids.map(() => "?").join(",")})` : "";
    const r = store.db.prepare(`UPDATE deliveries SET state='acked', note='auto: read', updated_at=?
    WHERE state='read' ${agent ? "AND agent=?" : ""} ${ids ? "" : "AND coalesce(note,'')<>'metadata'"} AND msg_id IN (SELECT m.id FROM messages m WHERE ${INFORMATIONAL} ${only})`)
        .run(iso(now), ...(agent ? [agent] : []), ...(ids ?? []));
    const n = Number(r.changes);
    if (n)
        store.audit("auto_ack", { ...(agent ? { agent } : {}), count: n, why: "auto: read (informational mail)" });
    return n;
}
/** Work mail `agent` read at least `age` ago (within the lookback), still unacked and with no reply from it. Newest first. */
export function unansweredMail(node, agent, age, now = Date.now()) {
    return node.store.db.prepare(`SELECT m.id id, m.kind kind, m.from_addr "from", d.updated_at read_at, d.note note
    FROM deliveries d JOIN messages m ON m.id=d.msg_id
    WHERE d.agent=? AND d.state='read' AND d.updated_at<=? AND d.updated_at>=? AND m.from_addr NOT LIKE 'mbx@%' AND ${WORK}
      AND NOT EXISTS (SELECT 1 FROM messages r WHERE r.reply_to=m.id AND r.from_addr=?)
    ORDER BY d.updated_at DESC LIMIT 20`).all(agent, iso(now - age), iso(now - LOOKBACK_MS), `${agent}@${node.host}`);
}
const idList = (rows, n) => `${rows.slice(0, n).map((u) => u.id).join(", ")}${rows.length > n ? ", …" : ""}`;
/** The 30 min reminder for one session, at most once per REMIND_AFTER_MS per session; null when nothing is due. */
export function unansweredReminder(node, agent, session, now = Date.now()) {
    const due = unansweredMail(node, agent, REMIND_AFTER_MS, now);
    if (!due.length)
        return null;
    const key = `unanswered-nag:${session}:${agent}`, last = Date.parse(node.store.get(key) ?? "");
    if (Number.isFinite(last) && now - last < REMIND_AFTER_MS)
        return null;
    node.store.set(key, iso(now));
    return `[mbx] ${due.length} work message(s) you read have no reply or ack: ${idList(due, 5)}. Answer each with mbx_reply, or mbx_ack with did="<what you did, or why not>".`;
}
/** The project lead to alert about `agent`: the active lead of its latest project, on this host, and not `agent` itself. */
export function leadToAlert(node, agent, now = Date.now()) {
    const project = node.store.db.prepare("SELECT project FROM identity_projects WHERE name=? ORDER BY last_seen DESC LIMIT 1").get(agent)?.project;
    const lead = project ? activeLead(node, project, new Date(now)) : null;
    return lead && lead.host === node.host && lead.agent !== agent ? lead.agent : null;
}
/** Daemon sweep: close informational mail already read, then alert each lead once per message unanswered 2 h after read.
 *  The alerted copies carry note 'unanswered', which the sender's receipts show. Returns the agents reported. */
export function sweepUnanswered(node, now = Date.now()) {
    autoAckRead(node.store, undefined, undefined, now);
    // A project slot is read by its lead, who is the one this alert would go to: slots are never listed (T493).
    const agents = node.store.db.prepare(`SELECT DISTINCT agent FROM deliveries WHERE state='read' AND coalesce(note,'')<>'unanswered'
    AND updated_at<=? AND updated_at>=? AND ${notSlot("agent")}`).all(iso(now - ALERT_AFTER_MS), iso(now - LOOKBACK_MS))
        .map((r) => r.agent);
    const out = [];
    for (const agent of agents) {
        const due = unansweredMail(node, agent, ALERT_AFTER_MS, now).filter((u) => u.note !== "unanswered");
        const lead = due.length ? leadToAlert(node, agent, now) : null;
        if (!lead)
            continue;
        const list = due.slice(0, 10).map((u) => `${u.id} (${u.kind} from ${u.from})`).join(", ");
        try {
            node.send({ from: "mbx", to: [lead], kind: "alert", subject: `Unanswered mail: ${agent} read work and did not reply or ack`.slice(0, 200),
                body: `${agent} read ${due.length} work message(s) over 2 h ago and has neither replied nor acked them: ${list}${due.length > 10 ? ", …" : ""}. `
                    + `Check on ${agent} (it may have moved on mid-task), or reassign the work.` });
        }
        catch {
            continue;
        }
        node.store.tx(() => { for (const u of due)
            node.store.db.prepare("UPDATE deliveries SET note='unanswered' WHERE msg_id=? AND agent=? AND state='read'").run(u.id, agent); });
        node.store.audit("unanswered.alert", { agent, lead, count: due.length });
        out.push(agent);
    }
    return out;
}
