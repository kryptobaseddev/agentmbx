import { mailboxLiveness } from "./receipts.js";
export const DEFAULT_RETURN_DAYS = 7;
const SINCE_KEY = "stranded-return-since";
const NOTICE_FROM = "mbx";
/** Mailboxes created here only by mail from paired hosts that know the name themselves: never held, registered or
 *  aliased here, and every unacked message came from a host where an agent of that name exists. */
export function phantomMailboxes(node) {
    const rows = node.store.db.prepare(`SELECT d.agent name, d.msg_id id, m.origin origin FROM deliveries d JOIN messages m ON m.id=d.msg_id
    WHERE d.state <> 'acked' AND d.agent <> 'owner' ORDER BY d.agent, m.id`).all();
    const by = new Map();
    for (const r of rows)
        by.set(r.name, [...(by.get(r.name) ?? []), r]);
    const out = [];
    for (const [name, msgs] of by) {
        if (node.establishedLocalName(name))
            continue;
        const thereToo = (h) => h !== "local" && !!node.store.db.prepare("SELECT 1 FROM agents WHERE name=? AND host=?").get(name, h);
        if (!msgs.every((m) => thereToo(m.origin)))
            continue;
        out.push({ name, messages: msgs.map((m) => m.id), hosts: [...new Set(msgs.map((m) => m.origin))].sort() });
    }
    return out;
}
/** Retire phantom mailboxes: their copies are marked handled with a note naming where the real recipient got it. */
export function retirePhantoms(node, apply) {
    const found = phantomMailboxes(node);
    if (!apply)
        return found;
    for (const p of found) {
        node.store.tx(() => {
            for (const id of p.messages) {
                const host = node.message(id)?.origin ?? p.hosts[0];
                node.store.setDelivery(id, p.name, "acked", `phantom mailbox retired: addressed to ${p.name}@${host}, which received it there`);
                // no cross-host receipt for a phantom: "drum@fedora acked" would tell the sender an agent here handled it (T218)
                node.store.db.prepare("DELETE FROM receipt_outbox WHERE msg_id=? AND agent=?").run(id, p.name);
            }
            node.store.audit("mailbox.phantom_retired", { name: p.name, messages: p.messages.length, hosts: p.hosts });
        });
    }
    return found;
}
/** Days before never-claimed mail is returned (config `stranded_return_days`; 0 turns it off). */
export function returnDays(node) {
    const v = node.config.stranded_return_days;
    return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : DEFAULT_RETURN_DAYS;
}
/**
 * Return mail that waited `days` in a mailbox that is not established here (no agents row, lease, registration or alias:
 * an explicit name@thishost typo, or a legacy delivery-only name). Real mailboxes that never hold a lease (CLI/shell
 * senders, backfilled identities, aliases) are never returned. The sender gets an alert in the same thread and the copy
 * is marked handled with a "returned to sender" note, which the sender's mbx_sent shows. Exactly once: a kv marker is
 * written before the notice, so a crash between the notice and the ack never returns the same copy twice. Only mail
 * delivered after this feature first ran is returned; older stranded mail stays for its owner to decide (doctor lists it).
 */
export function returnNeverClaimed(node, now = Date.now(), days = returnDays(node)) {
    if (!days)
        return [];
    let since = node.store.get(SINCE_KEY);
    if (!since) {
        since = new Date(now).toISOString();
        node.store.set(SINCE_KEY, since);
    }
    const cutoff = new Date(now - days * 86_400_000).toISOString();
    const rows = node.store.db.prepare(`SELECT d.agent mailbox, m.id id, m.from_addr sender, m.subject subject, m.thread thread, m.envelope envelope
    FROM deliveries d JOIN messages m ON m.id=d.msg_id
    WHERE d.state <> 'acked' AND d.agent <> 'owner' AND m.received_at >= ? AND m.received_at <= ?
      AND NOT EXISTS (SELECT 1 FROM identity_leases l WHERE l.name=d.agent)`).all(since, cutoff);
    const out = [];
    for (const r of rows) {
        if (node.establishedLocalName(r.mailbox))
            continue; // a real mailbox, even without a lease: its owner reads it
        const marker = `returned:${r.id}:${r.mailbox}`;
        if (node.store.get(marker)) {
            node.store.setDelivery(r.id, r.mailbox, "acked", `returned to sender after ${days} days (mailbox never established)`);
            continue;
        }
        const [sname] = r.sender.split("@");
        if (sname === NOTICE_FROM || sname === "owner" || sname === r.mailbox) {
            node.store.setDelivery(r.id, r.mailbox, "acked", "stranded: no sender to return it to");
            continue;
        }
        const e = JSON.parse(r.envelope);
        node.store.set(marker, new Date(now).toISOString()); // before the notice: at most one notice per copy
        try {
            node.send({ from: NOTICE_FROM, to: [r.sender], kind: "alert", subject: `Returned unread: ${r.subject}`.slice(0, 200), reply_to: r.id, thread: r.thread,
                body: `Your message ${r.id} to ${r.mailbox}@${node.host} was returned after ${days} days: there is no agent named ${r.mailbox} on ${node.host}, so nobody will read it there. `
                    + `Check the name with mbx_agents and send it again to the right recipient. Original recipients: ${e.to.join(", ")}.` });
        }
        catch {
            node.store.db.prepare("DELETE FROM kv WHERE k=?").run(marker);
            continue;
        } // not sent (unpaired host): stays stranded; doctor lists it
        node.store.setDelivery(r.id, r.mailbox, "acked", `returned to sender after ${days} days (mailbox never established)`);
        node.store.audit("mailbox.returned", { msg: r.id, mailbox: r.mailbox, sender: r.sender, days });
        out.push({ id: r.id, mailbox: r.mailbox, sender: r.sender });
    }
    return out;
}
const escalatedKey = (id, mailbox) => `escalated:${id}:${mailbox}`;
/** Escalate unacked urgent copies (T491) in established local mailboxes with no live holder: one desktop
 *  notice to the owner per copy, exactly once (a kv marker written before the notice). `notify` is injected
 *  so tests capture the notice and the daemon passes notifyDesktop; without it the marker and audit row
 *  still record the escalation. Returns the copies escalated by this pass. */
export function escalateUnheldMail(node, now = Date.now(), notify) {
    const rows = node.store.db.prepare(`SELECT d.agent mailbox, m.id id, m.from_addr sender, m.subject subject, m.kind kind, m.envelope envelope
    FROM deliveries d JOIN messages m ON m.id=d.msg_id WHERE d.state <> 'acked' AND d.agent <> 'owner' ORDER BY m.id`).all();
    const out = [];
    const live = new Map();
    for (const r of rows) {
        if (!node.establishedLocalName(r.mailbox))
            continue; // phantoms and never-claimed names have their own paths
        if (!live.has(r.mailbox))
            live.set(r.mailbox, mailboxLiveness(node, r.mailbox, now).live);
        if (live.get(r.mailbox))
            continue;
        const urgent = r.kind === "alert" || JSON.parse(r.envelope).needs_reply === true;
        if (!urgent)
            continue;
        if (node.store.get(escalatedKey(r.id, r.mailbox)))
            continue;
        const why = r.kind === "alert" ? "alert" : "needs-reply";
        node.store.set(escalatedKey(r.id, r.mailbox), new Date(now).toISOString()); // before the notice: at most one per copy
        notify?.("AgentMBX: urgent mail with no live holder", `${r.subject} — ${r.mailbox}@${node.host} has no live holder, so an ${why} from ${r.sender} waits unread. `
            + `The owner sees this notice once. Remedies: claim the mailbox (mbx_identity action=claim name=${r.mailbox}) or forward it (agentmbx identity forward ${r.mailbox} <to>).`);
        node.store.audit("mailbox.escalated", { msg: r.id, mailbox: r.mailbox, from: r.sender, urgent: why });
        out.push({ id: r.id, mailbox: r.mailbox, from: r.sender, subject: r.subject, urgent: why });
    }
    return out;
}
/** How many unacked copies of `mailbox` the T491 pass has escalated (doctor's stranded row names it). */
export function escalatedCount(node, mailbox) {
    return node.store.db.prepare("SELECT COUNT(*) c FROM kv WHERE k LIKE ?").get(`escalated:%:${mailbox}`).c;
}
