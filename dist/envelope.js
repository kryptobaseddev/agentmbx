// The signed message envelope, owner grants, and the body metadata parser.
import { canonical, fingerprint, nonce, sha256, signData, ulid, verifyData } from "./crypto.js";
import { checkEnc, sealBody } from "./body-encryption.js";
export const KINDS = ["message", "request", "reply", "status", "decision", "alert", "task"];
export const MAX_BODY = 256 * 1024;
// Saturating wire counter: this value means at least this many relay steps.
export const MAX_RELAY_DEPTH = 1000;
// Per-envelope caps for input from the network (T029). The senders' own limits are tighter (MCP: 20 recipients, 20 refs).
export const MAX_SUBJECT = 200, MAX_RECIPIENTS = 100, MAX_REFS = 100, MAX_FIELD = 300, MAX_REF = 2048;
/** A sealed body on the wire: base64 of the MAX_BODY plaintext plus the 16-byte AEAD tag. */
export const MAX_SEALED_BODY = 4 * Math.ceil((MAX_BODY + 16) / 3);
export const NAME_RE = /^[a-z0-9][a-z0-9-]{1,39}$/;
/** How long outside content a session read keeps that session's own sends external, counted from the root exposure (T104, T344). */
export const EXTERNAL_TAINT_MS = 3_600_000;
/** Instants as `Date.prototype.toISOString` writes them (years 0000-9999). */
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
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
        kind: d.kind ?? "message", subject: oneLine(d.subject).slice(0, 200), body: d.body, needs_reply: d.needs_reply ?? false,
        refs: d.refs ?? [], meta: { ...parseMeta(d.body), ...(d.unverifiedSender ? { sender_verification: "unverified" } : {}), ...(d.origin === "external" ? { origin: "external", external_since: d.external_since ?? now.toISOString(), external_source: d.external_since ? "inherited" : "declared" } : {}), ...(d.hop ? { hop: d.hop } : {}), ...(d.project ? { project: d.project.slice(0, 300) } : {}), ...(d.project_key ? { project_key: d.project_key.slice(0, 300) } : {}) },
        authority: null, enc: null,
    };
}
// The signed payload: everything except `sig`, with `body` REPLACED by the ciphertext when `enc` is
// present. The signature therefore commits to the exact ciphertext (swap attacks between two sealed
// envelopes from one sender fail), while the `body` field itself may carry either the ciphertext on the
// wire or the decrypted plaintext in local storage — both forms verify identically. Plaintext envelopes
// (enc: null) canonicalize exactly as before this substitution existed.
const unsigned = (e) => { const { sig: _s, body, ...rest } = e; return canonical({ ...rest, body: rest.enc ? rest.enc.body : body }); };
export function signEnvelope(e, host, hostPub, hostPriv) {
    return { ...e, sig: { alg: "ed25519", host, key: fingerprint(hostPub), value: signData(hostPriv, unsigned(e)) } };
}
/** Seal the body for one recipient host's enc key and host-sign the wire form (T028). Local copies stay plaintext (D001). */
export function sealEnvelope(e, recipientEncPub, host, hostPub, hostPriv) {
    const sealed = sealBody(e.body, recipientEncPub, e.id);
    return signEnvelope({ ...e, enc: sealed, body: sealed.body }, host, hostPub, hostPriv);
}
export function verifyEnvelope(e, hostPub) {
    return !!e.sig && e.sig.alg === "ed25519" && e.sig.key === fingerprint(hostPub) && verifyData(hostPub, unsigned(e), e.sig.value);
}
/** Structural validation of anything that claims to be an envelope (input from the network or the store). */
/** Line breaks and other control characters, which could make sender text look like AgentMBX header lines (T196, F8). */
const CONTROL = /[\u0000-\u001f\u007f\u0085\u2028\u2029]/;
export const oneLine = (s) => s.replace(new RegExp(CONTROL.source, "g"), " ");
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
    if (e.from.length > MAX_FIELD)
        return `from over ${MAX_FIELD} characters`;
    if (!Array.isArray(e.to) || !e.to.length || e.to.some((t) => typeof t !== "string"))
        return "bad to";
    if (e.to.length > MAX_RECIPIENTS)
        return `more than ${MAX_RECIPIENTS} recipients`;
    if (e.to.some((t) => t.length > MAX_FIELD))
        return `recipient over ${MAX_FIELD} characters`;
    if (!KINDS.includes(e.kind))
        return "bad kind";
    if (e.enc === undefined)
        return "bad enc";
    if (typeof e.body !== "string")
        return "bad body";
    const maxBody = e.enc === null ? MAX_BODY : MAX_SEALED_BODY; // wire form of a sealed body is its base64 ciphertext
    if (Buffer.byteLength(e.body) > maxBody)
        return `body over ${maxBody} bytes`;
    if (typeof e.subject !== "string")
        return "bad subject";
    if (e.subject.length > MAX_SUBJECT)
        return `subject over ${MAX_SUBJECT} characters`;
    if (CONTROL.test(e.subject))
        return "subject contains control characters"; // T196 (F8): no fake header lines
    if (typeof e.ts !== "string" || Number.isNaN(Date.parse(e.ts)))
        return "bad ts";
    if (typeof e.thread !== "string" || e.thread.length > MAX_FIELD)
        return "bad thread";
    if (e.reply_to !== null && (typeof e.reply_to !== "string" || e.reply_to.length > MAX_FIELD))
        return "bad reply_to";
    if (typeof e.needs_reply !== "boolean")
        return "bad needs_reply";
    if (!Array.isArray(e.refs) || e.refs.some(value => typeof value !== "string"))
        return "bad refs";
    if (e.refs.length > MAX_REFS || e.refs.some((r) => r.length > MAX_REF))
        return `more than ${MAX_REFS} refs or a ref over ${MAX_REF} characters`;
    if (e.enc !== null) { // sealed envelopes still get the authority/meta checks below
        const bad = checkEnc(e.enc);
        if (bad)
            return bad;
        if (e.enc.body.length > MAX_SEALED_BODY)
            return `sealed body over ${MAX_SEALED_BODY} bytes`;
    }
    const a = e.authority;
    if (a !== null) {
        if (!a || typeof a !== "object" || Array.isArray(a))
            return "bad authority";
        if (a.owner_sig !== undefined) {
            if (typeof a.owner_sig !== "string" || typeof a.owner_fp !== "string" || a.grant !== undefined || a.session_sig !== undefined)
                return "bad owner authority";
        }
        else {
            const g = a.grant;
            if (!g || typeof g !== "object" || Array.isArray(g) || g.v !== 2 || typeof a.session_sig !== "string" || a.owner_fp !== undefined)
                return "bad grant authority";
            for (const field of ["id", "iss", "sub", "agent", "host", "iat", "exp", "nonce", "sig"])
                if (typeof g[field] !== "string")
                    return `bad grant.${field}`;
            if (!Array.isArray(g.caps) || g.caps.some(value => typeof value !== "string"))
                return "bad grant.caps";
        }
    }
    const m = e.meta;
    if (!m || typeof m !== "object" || Array.isArray(m))
        return "bad meta";
    for (const field of ["mentions", "directives", "tags", "task_refs"]) {
        if (!Array.isArray(m[field]) || m[field].some(value => typeof value !== "string"))
            return `bad meta.${field}`;
    }
    if (m?.sender_verification !== undefined && m.sender_verification !== "unverified" && m.sender_verification !== "leased")
        return "bad sender verification";
    if (m?.hop !== undefined && !(Number.isInteger(m.hop) && m.hop >= 0 && m.hop <= MAX_RELAY_DEPTH))
        return "bad hop";
    if (m?.origin !== undefined && m.origin !== "agent" && m.origin !== "external")
        return "bad origin";
    // T344: the root exposure time of external mail. A future value is well-formed here and counts as the reader's now.
    if (m?.external_since !== undefined && (m.origin !== "external" || typeof m.external_since !== "string" || !ISO_INSTANT.test(m.external_since)
        || !Number.isFinite(Date.parse(m.external_since))))
        return "bad external_since";
    if (m?.external_source !== undefined && (m.external_since === undefined || (m.external_source !== "declared" && m.external_source !== "inherited")))
        return "bad external_source";
    if (m?.project !== undefined && (typeof m.project !== "string" || m.project.length > 300))
        return "bad project";
    if (m?.project_key !== undefined && (typeof m.project_key !== "string" || m.project_key.length > 300))
        return "bad project key";
    // bare `to` entries the sending host delivered to its own agents; receivers skip exactly these (S2 follow-up)
    if (m?.local_names !== undefined && (!Array.isArray(m.local_names) || m.local_names.length > 100 || m.local_names.some((n) => typeof n !== "string" || !NAME_RE.test(n))))
        return "bad local names";
    return null;
}
/**
 * The root exposure a reader takes from one message read at `now`. First-hand outside content exposes the reader now:
 * declared external by its sender, a malformed envelope whose provenance is unknown, or external mail from before T344
 * (no `external_since`), which may be declared content however old it is. Inherited taint keeps the sender's root
 * exposure, so agents answering each other never extend a taint past root + EXTERNAL_TAINT_MS. A root later than `now`
 * (a skewed clock or a bad sender) counts as `now`: never longer than one first-hand read. A reader keeps the latest root
 * of everything it read.
 */
export function externalExposure(e, now) {
    if (checkShape(e))
        return { how: "malformed", root: now };
    const { meta: m } = e;
    if (m.origin !== "external")
        return null;
    if (m.external_since === undefined)
        return { how: "legacy", root: now };
    if (m.external_source !== "inherited")
        return { how: "declared", root: now };
    return { how: "inherited", root: Math.min(Date.parse(m.external_since), now) };
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
// Authority signatures commit to the pre-sealing form: transport sealing (T028) fills `enc` and swaps the
// body for ciphertext after signing, so verifiers pass the opened envelope and a filled `enc` reads as the
// `enc: null` it was signed with. Envelopes without the field keep canonicalizing without it.
const presealed = (rest) => (rest.enc ? { ...rest, enc: null } : rest);
/** What the session key signs: the envelope without its host signature and without the session signature itself. */
const sessionPayload = (e) => {
    const { sig: _s, authority, ...rest } = e;
    return canonical({ ...presealed(rest), authority: authority?.grant ? { grant: authority.grant } : null });
};
const ownerPayload = (e) => {
    const { sig: _s, authority, ...rest } = e;
    return canonical({ ...presealed(rest), authority: { owner_fp: authority?.owner_fp ?? null } });
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
    if (e.to.some((t) => t === "*" || t.startsWith("role:") || t.startsWith("task:")))
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
    const issued = typeof a.grant.iat === "string" ? Date.parse(a.grant.iat) : NaN;
    const expires = typeof a.grant.exp === "string" ? Date.parse(a.grant.exp) : NaN;
    const at = now.getTime();
    if (!Number.isFinite(issued) || !Number.isFinite(expires) || !Number.isFinite(at))
        return { ok: false, reason: "grant validity timestamps are invalid" };
    if (expires <= issued || expires - issued > MAX_GRANT_HOURS * 3_600_000)
        return { ok: false, reason: "grant lifetime is outside the allowed interval" };
    if (expires <= at)
        return { ok: false, reason: "grant expired" };
    if (revoked.has(a.grant.id))
        return { ok: false, reason: "grant revoked" };
    const missing = capsNeeded(e).filter((c) => !a.grant.caps.includes(c));
    if (missing.length)
        return { ok: false, reason: `outside the grant's caps (needs ${missing.join(", ")})` };
    return { ok: true, caps: a.grant.caps, grant_id: a.grant.id, session: fingerprint(sessionPub) };
}
export const bodyHash = (e) => sha256(e.body);
