import { activeLead, isLead } from "./lead-record.js";
import { bumpPostToolMarkersForAgent } from "./posttool.js";
import { deliveryReceipts } from "./receipts.js";
import { projectIdentities, projectKey, registeredIdentity } from "./registry.js";
export { LEAD_DEFAULT_TTL_MS, LEAD_MAX_TTL_MS, leadSummary, makeLead, makeLeadRevocation, storeLead, revokeLead, activeLead, isLead, projectLeadView, projectLeadLine, resolveLeadRecipients, } from "./lead-record.js";
const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };
const roleOf = (node, address) => {
    const [name, host] = address.split("@");
    return host === node.host ? registeredIdentity(node.store, name)?.role ?? null : null;
};
/** SQL condition (and parameters) for "a message of this project": stamped with meta.project, stamped with the same git
 *  origin from a paired host's own folder of this repository (T219), or sent by / delivered to an identity associated
 *  with the project. */
function ledgerWhere(node, project) {
    const members = [...projectIdentities(node.store, project)];
    const addrs = members.map((n) => `${n}@${node.host}`);
    const inList = (xs) => (xs.length ? xs.map(() => "?").join(",") : "NULL");
    const key = projectKey(project);
    return { sql: `(json_extract(envelope,'$.meta.project')=?${key ? " OR json_extract(envelope,'$.meta.project_key')=?" : ""} OR from_addr IN (${inList(addrs)})
      OR id IN (SELECT msg_id FROM deliveries WHERE agent IN (${inList(members)})))`, args: [project, ...(key ? [key] : []), ...addrs, ...members] };
}
function ledgerIds(node, project, after, upTo, limit) {
    const w = ledgerWhere(node, project);
    return node.store.db.prepare(`SELECT id FROM messages WHERE id>? AND id<=? AND ${w.sql} ORDER BY id LIMIT ?`)
        .all(after, upTo, ...w.args, limit).map((r) => r.id);
}
/** Is `id` a message of `project`'s ledger? */
export function inLedger(node, project, id) {
    const w = ledgerWhere(node, project);
    return !!node.store.db.prepare(`SELECT 1 FROM messages WHERE id=? AND ${w.sql}`).get(id, ...w.args);
}
/** The project ledger for `caller` working in `project`. Bodies: the caller's own mail, or everything for the lead. */
export function ledgerPage(node, caller, project, o = {}) {
    const limit = o.limit ?? 20;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
        fail("CURSOR_INVALID", "Ledger bounds are invalid");
    const epoch = node.store.get("replay:epoch") ?? fail("CURSOR_EXPIRED", "Store generation is unavailable");
    const max = node.store.db.prepare("SELECT COALESCE(MAX(id),'') m FROM messages").get().m;
    let frame = { v: 1, epoch: epoch, project, position: "", end: max };
    if (o.cursor !== undefined) {
        let f = null;
        try {
            if (typeof o.cursor === "string" && o.cursor.length <= 4096 && /^[A-Za-z0-9_-]+$/.test(o.cursor)) {
                const data = Buffer.from(o.cursor, "base64url");
                if (data.toString("base64url") === o.cursor)
                    f = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(data));
            }
        }
        catch { /* invalid below */ }
        if (!f || typeof f !== "object" || Object.keys(f).sort().join(",") !== "end,epoch,position,project,v" || f.v !== 1
            || typeof f.position !== "string" || typeof f.end !== "string" || f.position > f.end)
            fail("CURSOR_INVALID", "Ledger cursor is invalid");
        if (f.project !== project)
            fail("CURSOR_SCOPE_MISMATCH", "Ledger cursor belongs to a different project");
        if (f.epoch !== epoch)
            fail("CURSOR_EXPIRED", "Store generation changed; restart from the beginning");
        frame = { ...f };
        if (frame.position === frame.end)
            frame.end = max;
    }
    const lead = activeLead(node, project);
    const callerIsLead = !!lead && lead.agent === caller && lead.host === node.host;
    const ids = ledgerIds(node, project, frame.position, frame.end, limit + 1);
    const page = ids.slice(0, limit);
    const messages = page.map((id) => {
        const m = node.message(id);
        const e = JSON.parse(m.envelope);
        const own = node.canSee(m, caller);
        const forwarded = forwardedBy(node, m.id);
        return {
            id: m.id, ts: m.ts, from: m.from_addr, to: e.to, kind: m.kind, subject: m.subject, thread: m.thread, project: e.meta.project ?? null,
            project_key: typeof e.meta.project_key === "string" ? e.meta.project_key : null,
            body: own || callerIsLead ? m.body : null,
            ...(own || callerIsLead ? {} : { body_withheld: "not your mail; the project lead can read it" }),
            recipients: deliveryReceipts(node, m).map((r) => ({ ...r, role: roleOf(node, r.address) })),
            ...(forwarded.length ? { forwarded_by: forwarded } : {}),
        };
    });
    const done = ids.length <= limit;
    const position = page.length ? page[page.length - 1] : frame.position;
    return { project, lead: lead ? `${lead.agent}@${lead.host}` : null, messages,
        next_cursor: Buffer.from(JSON.stringify({ ...frame, position: done ? frame.end : position })).toString("base64url"), has_more: !done };
}
const forwardKey = (msg, to) => `forwarded:${msg}:${to}`;
/** Leads who forwarded message `msg` (to anyone). */
export function forwardedBy(node, msg) {
    return node.store.db.prepare("SELECT v FROM kv WHERE k LIKE ?").all(`forwarded:${msg}:%`).map((r) => r.v);
}
/** The lead who forwarded `msg` to `agent`, for that recipient's header. */
export const forwardedTo = (node, msg, agent) => node.store.get(forwardKey(msg, agent)) ?? null;
/** Lead-only: re-deliver a project message to another local identity, audited. The recipient's policy for it is still
 *  computed from the original sender: forwarding never adds authority. */
export function forwardMessage(node, lead, project, id, to) {
    if (!project)
        fail("LEAD_REQUIRED", "this session works in no project folder");
    if (!isLead(node, lead, project))
        fail("LEAD_REQUIRED", `only the project lead can forward; ${lead}@${node.host} is not the lead of ${project}`);
    const m = node.message(id) ?? fail("NOT_FOUND", `no message ${id}`);
    if (!inLedger(node, project, m.id))
        fail("NOT_IN_PROJECT", `${m.id} is not a message of project ${project}`);
    const [name, host] = to.split("@");
    if (host && host !== node.host)
        fail("LOCAL_ONLY", "forward re-delivers on this host only; use mbx_send for another host");
    const target = node.resolveAlias(name);
    if (!node.knownLocalName(target))
        fail("UNKNOWN_RECIPIENT", `"${name}" is not an agent on ${node.host}`);
    node.store.tx(() => {
        node.store.addDelivery(m.id, target);
        node.store.set(forwardKey(m.id, target), `${lead}@${node.host}`);
        node.store.audit("message.forwarded", { msg: m.id, by: `${lead}@${node.host}`, to: `${target}@${node.host}`, project });
    });
    bumpPostToolMarkersForAgent(node.store.db, node.home, target);
    return { id: m.id, to: `${target}@${node.host}` };
}
