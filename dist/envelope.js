// The signed message envelope, owner grants, and the body metadata parser.
import { canonical, fingerprint, nonce, sha256, signData, ulid, verifyData } from "./crypto.js";
export const KINDS = ["message", "request", "reply", "status", "decision", "alert", "task"];
export const MAX_BODY = 256 * 1024;
export const NAME_RE = /^[a-z0-9][a-z0-9-]{1,39}$/;
export function parseMeta(body) {
    const uniq = (xs) => [...new Set(xs)];
    const all = (re) => uniq([...body.matchAll(re)].map((m) => m[1]));
    return {
        mentions: all(/(?:^|[\s(])@([a-z0-9][a-z0-9-]{1,39}(?:@[a-z0-9-]+)?)/gi).map((s) => s.toLowerCase()),
        directives: all(/(?:^|\s)\/(claim|done|blocked|approve|decision|checkin)\b/g),
        tags: all(/(?:^|\s)#([a-z][\w-]{1,40})/gi).map((s) => s.toLowerCase()),
        task_refs: all(/\b(T\d{2,6})\b/g),
    };
}
export function buildEnvelope(d, now = new Date()) {
    if (!d.subject.trim())
        throw new Error("subject is required");
    if (Buffer.byteLength(d.body) > MAX_BODY)
        throw new Error(`body is over ${MAX_BODY / 1024} KB; put large content in refs`);
    if (!d.to.length)
        throw new Error("at least one recipient is required");
    const id = ulid(now.getTime());
    return {
        v: 3, id, ts: now.toISOString(), from: d.from, to: d.to, thread: d.thread ?? id, reply_to: d.reply_to ?? null,
        kind: d.kind ?? "message", subject: d.subject.slice(0, 200), body: d.body, needs_reply: d.needs_reply ?? false,
        refs: d.refs ?? [], meta: parseMeta(d.body), authority: null, enc: null,
    };
}
const unsigned = (e) => { const { sig: _s, ...rest } = e; return canonical(rest); };
export function signEnvelope(e, host, hostPub, hostPriv) {
    return { ...e, sig: { alg: "ed25519", host, key: fingerprint(hostPub), value: signData(hostPriv, unsigned(e)) } };
}
export function verifyEnvelope(e, hostPub) {
    return !!e.sig && e.sig.alg === "ed25519" && e.sig.key === fingerprint(hostPub) && verifyData(hostPub, unsigned(e), e.sig.value);
}
/** Structural validation of anything that claims to be an envelope (input from the network or the store). */
export function checkShape(x) {
    const e = x;
    if (!e || typeof e !== "object")
        return "not an object";
    if (e.v !== 3)
        return "unsupported version";
    if (typeof e.id !== "string" || !/^[0-9A-HJKMNP-TV-Z]{26}$/.test(e.id))
        return "bad id";
    if (typeof e.from !== "string" || !e.from.includes("@"))
        return "bad from";
    if (!Array.isArray(e.to) || !e.to.length || e.to.some((t) => typeof t !== "string"))
        return "bad to";
    if (!KINDS.includes(e.kind))
        return "bad kind";
    if (typeof e.body !== "string" || Buffer.byteLength(e.body) > MAX_BODY)
        return "bad body";
    if (typeof e.subject !== "string")
        return "bad subject";
    if (Number.isNaN(Date.parse(e.ts)))
        return "bad ts";
    return null;
}
// ---- owner grants ----------------------------------------------------------------------------
export const CAPS = ["task.assign", "decision", "broadcast", "alert"];
export const MAX_GRANT_HOURS = 24 * 7;
/** The exact bytes the owner key signs for a grant (what ownerSignCanonical is given). */
export const grantPayload = (g) => canonical(g);
/** An unsigned grant; sign `grantPayload(g)` with the owner key (ownerSignCanonical) and add it as `sig`. */
export function buildGrant(ownerPub, sessionPub, agent, host, caps, hours = 12, now = new Date()) {
    if (hours <= 0 || hours > MAX_GRANT_HOURS)
        throw new Error(`grant lifetime must be 1..${MAX_GRANT_HOURS} hours`);
    const bad = caps.filter((c) => !CAPS.includes(c));
    if (bad.length)
        throw new Error(`unknown caps: ${bad.join(", ")} (known: ${CAPS.join(", ")})`);
    return { v: 2, id: ulid(now.getTime()), iss: fingerprint(ownerPub), sub: `session:${sessionPub}`, agent, host,
        caps: [...new Set(caps)].sort(), iat: now.toISOString(), exp: new Date(now.getTime() + hours * 3_600_000).toISOString(), nonce: nonce() };
}
export function makeGrant(ownerPub, ownerPriv, sessionPub, agent, host, caps, hours = 12, now = new Date()) {
    const g = buildGrant(ownerPub, sessionPub, agent, host, caps, hours, now);
    return { ...g, sig: signData(ownerPriv, grantPayload(g)) };
}
/** What the session key signs: the envelope without its host signature and without the session signature itself. */
const sessionPayload = (e) => {
    const { sig: _s, authority, ...rest } = e;
    return canonical({ ...rest, authority: authority?.grant ? { grant: authority.grant } : null });
};
const ownerPayload = (e) => {
    const { sig: _s, authority, ...rest } = e;
    return canonical({ ...rest, authority: { owner_fp: authority?.owner_fp ?? null } });
};
/** Step 1 of an owner-signed envelope: `payload` is the exact bytes the owner key signs (via ownerSignCanonical). */
export function ownerSignRequest(e, ownerPub) {
    const withFp = { ...e, authority: { owner_sig: "", owner_fp: fingerprint(ownerPub) } };
    return { envelope: withFp, payload: ownerPayload(withFp) };
}
/** Step 2: attach the owner signature over `ownerSignRequest(...).payload`. */
export const withOwnerSig = (e, sig) => ({ ...e, authority: { owner_sig: sig, owner_fp: e.authority.owner_fp } });
/** The owner signs one envelope directly with an unlocked owner key (tests; the CLI goes through ownerSignCanonical). */
export function ownerSign(e, ownerPub, ownerPriv) {
    const r = ownerSignRequest(e, ownerPub);
    return withOwnerSig(r.envelope, signData(ownerPriv, r.payload));
}
/** Called by the master session's MCP server, which holds the session private key in memory only. */
export function attachAuthority(e, grant, sessionPriv) {
    const withGrant = { ...e, authority: { grant, session_sig: "" } };
    return { ...withGrant, authority: { grant, session_sig: signData(sessionPriv, sessionPayload(withGrant)) } };
}
/** Which caps does this envelope need for its authority to count? */
export function capsNeeded(e) {
    const need = [];
    if (e.kind === "task" || e.kind === "request")
        need.push("task.assign");
    else if (e.kind === "decision")
        need.push("decision");
    else if (e.kind === "alert")
        need.push("alert");
    else
        need.push(`kind:${e.kind}`); // status/message/reply never carry owner authority
    if (e.to.some((t) => t === "*" || t.startsWith("role:")))
        need.push("broadcast");
    return need;
}
/** Verify owner authority on an envelope. `ownerPub` is the owner key pinned for the sending host. */
export function checkAuthority(e, ownerPub, revoked, now = new Date()) {
    const a = e.authority;
    if (!a)
        return { ok: false, reason: "no authority" };
    if (!ownerPub)
        return { ok: false, reason: "no owner key pinned for the sending host" };
    if (a.owner_sig !== undefined) {
        if (a.owner_fp !== fingerprint(ownerPub))
            return { ok: false, reason: "signed by an owner key other than the one pinned for that host" };
        if (!verifyData(ownerPub, ownerPayload(e), a.owner_sig))
            return { ok: false, reason: "owner signature invalid" };
        return { ok: true, caps: [...CAPS], grant_id: "direct", session: "signed by the owner" };
    }
    const { sig, ...rest } = a.grant;
    if (a.grant.v !== 2)
        return { ok: false, reason: "unsupported grant version" };
    if (a.grant.iss !== fingerprint(ownerPub))
        return { ok: false, reason: "grant not issued by the pinned owner key" };
    if (!verifyData(ownerPub, grantPayload(rest), sig))
        return { ok: false, reason: "grant signature invalid" };
    if (`${a.grant.agent}@${a.grant.host}` !== e.from)
        return { ok: false, reason: `grant is for ${a.grant.agent}@${a.grant.host}, not ${e.from}` };
    if (!a.grant.sub.startsWith("session:"))
        return { ok: false, reason: "grant subject is not a session key" };
    const sessionPub = a.grant.sub.slice(8);
    if (!verifyData(sessionPub, sessionPayload(e), a.session_sig))
        return { ok: false, reason: "not sent by the granted session (session signature invalid)" };
    if (Date.parse(a.grant.exp) < now.getTime())
        return { ok: false, reason: "grant expired" };
    if (revoked.has(a.grant.id))
        return { ok: false, reason: "grant revoked" };
    const missing = capsNeeded(e).filter((c) => !a.grant.caps.includes(c));
    if (missing.length)
        return { ok: false, reason: `outside the grant's caps (needs ${missing.join(", ")})` };
    return { ok: true, caps: a.grant.caps, grant_id: a.grant.id, session: fingerprint(sessionPub) };
}
export const bodyHash = (e) => sha256(e.body);
