// Hosted Kimi (the desktop daimon, `kimi web`) runs one mbx MCP server per conversation, all under one shared parent
// process, and its MCP calls carry no session metadata: neither a hook nor a server can tell which server belongs to which
// conversation, and guessing is never allowed. The conversation's own hook knows its real session id and folder, so it
// issues a one-time ticket into that conversation's context; the conversation hands it to its own mbx server
// (mbx_whoami bind), which links itself only when the ticket was issued under its own parent process. A ticket names the
// session it links and nothing else: it grants no authority. Trust assumption: a nonce appears only in its own conversation's
// context; if it leaked into a sibling conversation of the same app first, that one links instead, the rightful bind fails
// and its next prompt gets a new ticket (self-healing, never cross-app or cross-provider).
import { randomBytes } from "node:crypto";
export const BIND_TICKET_TTL_MS = 15 * 60_000;
export const BIND_TICKET_RE = /^[a-f0-9]{32}$/;
const key = (nonce) => `bind-ticket:${nonce}`;
const tickets = (store) => store.db.prepare("SELECT k, v FROM kv WHERE k LIKE 'bind-ticket:%'").all()
    .flatMap(r => { try {
    return [{ nonce: r.k.slice("bind-ticket:".length), t: JSON.parse(r.v) }];
}
catch {
    return [];
} });
/** A ticket for this session: the unexpired one already issued, else a fresh one. Expired tickets are dropped. */
export function issueBindTicket(store, t, now = Date.now()) {
    return store.tx(() => {
        for (const { nonce, t: old } of tickets(store)) {
            if (!(old.exp > now)) {
                store.db.prepare("DELETE FROM kv WHERE k=?").run(key(nonce));
                continue;
            }
            if (old.cli === t.cli && old.session_id === t.session_id && old.parent_pid === t.parent_pid)
                return nonce;
        }
        const nonce = randomBytes(16).toString("hex");
        store.set(key(nonce), JSON.stringify({ ...t, exp: now + BIND_TICKET_TTL_MS }));
        return nonce;
    });
}
/** Consume a ticket for a server of `cli` whose parent is `parentPid`; null (and nothing consumed) when it doesn't fit. */
export function takeBindTicket(store, nonce, cli, parentPid, now = Date.now()) {
    if (!BIND_TICKET_RE.test(nonce))
        return null;
    return store.tx(() => {
        const raw = store.get(key(nonce));
        if (!raw)
            return null;
        let t;
        try {
            t = JSON.parse(raw);
        }
        catch {
            store.db.prepare("DELETE FROM kv WHERE k=?").run(key(nonce));
            return null;
        }
        if (!(t.exp > now)) {
            store.db.prepare("DELETE FROM kv WHERE k=?").run(key(nonce));
            return null;
        }
        if (t.cli !== cli || t.parent_pid !== parentPid)
            return null; // another provider process's conversation: leave it
        store.db.prepare("DELETE FROM kv WHERE k=?").run(key(nonce));
        return t;
    });
}
export const bindInstruction = (nonce) => `[mbx] This conversation's mbx tools are not linked to it yet (the app hosts several conversations in one process). Call mbx_whoami with bind="${nonce}" now, once, before other mbx tools. Do it without comment.`;
