// The signed message envelope, owner grants, and the body metadata parser.
import { canonical, fingerprint, nonce, sha256, signData, ulid, verifyData } from "./crypto.ts";
import { checkEnc, sealBody, type EncBody } from "./body-encryption.ts";

export const KINDS = ["message", "request", "reply", "status", "decision", "alert", "task"] as const;
export type Kind = (typeof KINDS)[number];
export const MAX_BODY = 256 * 1024;
// Saturating wire counter: this value means at least this many relay steps.
export const MAX_RELAY_DEPTH = 1000;
export const NAME_RE = /^[a-z0-9][a-z0-9-]{1,39}$/;

/** `origin`: where the content came from (external = a web page, issue, PR comment, email relayed by an agent);
 *  `hop`: agent-to-agent relay depth, saturated at MAX_RELAY_DEPTH. Both are signed with the envelope. */
export interface Meta { mentions: string[]; directives: string[]; tags: string[]; task_refs: string[]; origin?: "agent" | "external"; hop?: number; project?: string; sender_verification?: "unverified" | "leased" }

/** Owner-signed delegation to ONE live session: `sub` is that session's in-memory key, so nothing else on the
 *  host (even a process using the same agent name) can use it. */
export interface Grant {
  v: 2; id: string; iss: string /* owner key fingerprint */; sub: string /* "session:" + base64 session pubkey */;
  agent: string; host: string; caps: string[]; iat: string; exp: string; nonce: string; sig: string;
}
/** Either a master session acting under an owner grant, or the owner signing one message directly (passphrase on a TTY). */
export type Authority = { grant: Grant; session_sig: string; owner_sig?: undefined; owner_fp?: undefined } | { owner_sig: string; owner_fp: string; grant?: undefined; session_sig?: undefined };

export interface Envelope {
  v: 3; id: string; ts: string; from: string; to: string[]; thread: string; reply_to: string | null;
  kind: Kind; subject: string; body: string; needs_reply: boolean; refs: string[]; meta: Meta;
  authority: Authority | null; enc: EncBody | null;
  sig?: { alg: "ed25519"; host: string; key: string; value: string };
}

export function parseMeta(body: string): Meta {
  const uniq = (xs: string[]) => [...new Set(xs)];
  const all = (re: RegExp) => uniq([...body.matchAll(re)].map((m) => m[1]));
  return {
    mentions: all(/(?:^|[\s(])@([a-z0-9][a-z0-9-]{1,39}(?:@[a-z0-9-]+)?)/gi).map((s) => s.toLowerCase()),
    directives: all(/(?:^|\s)\/(claim|done|blocked|approve|decision|checkin)\b/g),
    tags: all(/(?:^|\s)#([a-z][\w-]{1,40})/gi).map((s) => s.toLowerCase()),
    task_refs: all(/\b(T\d{2,6})\b/g),
  };
}

export interface Draft {
  from: string; to: string[]; subject: string; body: string; kind?: Kind; thread?: string;
  reply_to?: string | null; needs_reply?: boolean; refs?: string[]; origin?: "agent" | "external"; hop?: number;
  /** the sender's project root (canonical path), so receivers can tell which project a message is about */
  project?: string;
  unverifiedSender?: boolean;
}

export function buildEnvelope(d: Draft, now = new Date()): Envelope {
  if (!d.subject.trim()) throw new Error("subject is required");
  if (Buffer.byteLength(d.body) > MAX_BODY) throw new Error(`body is over ${MAX_BODY / 1024} KB; put large content in refs`);
  if (!d.to.length) throw new Error("at least one recipient is required");
  const id = ulid(now.getTime());
  return {
    v: 3, id, ts: now.toISOString(), from: d.from, to: d.to, thread: d.thread ?? id, reply_to: d.reply_to ?? null,
    kind: d.kind ?? "message", subject: d.subject.slice(0, 200), body: d.body, needs_reply: d.needs_reply ?? false,
    refs: d.refs ?? [], meta: { ...parseMeta(d.body), ...(d.unverifiedSender ? { sender_verification: "unverified" as const } : {}), ...(d.origin === "external" ? { origin: "external" as const } : {}), ...(d.hop ? { hop: d.hop } : {}), ...(d.project ? { project: d.project.slice(0, 300) } : {}) },
    authority: null, enc: null,
  };
}

// The signed payload: everything except `sig`, with `body` REPLACED by the ciphertext when `enc` is
// present. The signature therefore commits to the exact ciphertext (swap attacks between two sealed
// envelopes from one sender fail), while the `body` field itself may carry either the ciphertext on the
// wire or the decrypted plaintext in local storage — both forms verify identically. Plaintext envelopes
// (enc: null) canonicalize exactly as before this substitution existed.
const unsigned = (e: Envelope) => { const { sig: _s, body, ...rest } = e; return canonical({ ...rest, body: rest.enc ? rest.enc.body : body }); };

export function signEnvelope(e: Envelope, host: string, hostPub: string, hostPriv: string): Envelope {
  return { ...e, sig: { alg: "ed25519", host, key: fingerprint(hostPub), value: signData(hostPriv, unsigned(e)) } };
}

/** Seal the body for one recipient host's enc key and host-sign the wire form (T028). Local copies stay plaintext (D001). */
export function sealEnvelope(e: Envelope, recipientEncPub: string, host: string, hostPub: string, hostPriv: string): Envelope {
  const sealed = sealBody(e.body, recipientEncPub, e.id);
  return signEnvelope({ ...e, enc: sealed, body: sealed.body }, host, hostPub, hostPriv);
}

export function verifyEnvelope(e: Envelope, hostPub: string): boolean {
  return !!e.sig && e.sig.alg === "ed25519" && e.sig.key === fingerprint(hostPub) && verifyData(hostPub, unsigned(e), e.sig.value);
}

/** Structural validation of anything that claims to be an envelope (input from the network or the store). */
export function checkShape(x: unknown): string | null {
  const e = x as Envelope;
  if (!e || typeof e !== "object") return "not an object";
  if (e.v !== 3) return "unsupported version";
  if (typeof e.id !== "string" || !/^[0-9A-HJKMNP-TV-Z]{26}$/.test(e.id)) return "bad id";
  if (typeof e.from !== "string" || !e.from.includes("@")) return "bad from";
  if (!Array.isArray(e.to) || !e.to.length || e.to.some((t) => typeof t !== "string")) return "bad to";
  if (!KINDS.includes(e.kind)) return "bad kind";
  if (typeof e.body !== "string" || Buffer.byteLength(e.body) > MAX_BODY) return "bad body";
  if (typeof e.subject !== "string") return "bad subject";
  if (typeof e.ts !== "string" || Number.isNaN(Date.parse(e.ts))) return "bad ts";
  if (typeof e.thread !== "string") return "bad thread";
  if (e.reply_to !== null && typeof e.reply_to !== "string") return "bad reply_to";
  if (typeof e.needs_reply !== "boolean") return "bad needs_reply";
  if (!Array.isArray(e.refs) || e.refs.some(value => typeof value !== "string")) return "bad refs";
  if (e.enc === undefined) return "bad enc";
  if (e.enc !== null) return checkEnc(e.enc);
  const a = e.authority;
  if (a !== null) {
    if (!a || typeof a !== "object" || Array.isArray(a)) return "bad authority";
    if (a.owner_sig !== undefined) {
      if (typeof a.owner_sig !== "string" || typeof a.owner_fp !== "string" || a.grant !== undefined || a.session_sig !== undefined)
        return "bad owner authority";
    } else {
      const g = a.grant;
      if (!g || typeof g !== "object" || Array.isArray(g) || g.v !== 2 || typeof a.session_sig !== "string" || a.owner_fp !== undefined)
        return "bad grant authority";
      for (const field of ["id", "iss", "sub", "agent", "host", "iat", "exp", "nonce", "sig"] as const)
        if (typeof g[field] !== "string") return `bad grant.${field}`;
      if (!Array.isArray(g.caps) || g.caps.some(value => typeof value !== "string")) return "bad grant.caps";
    }
  }
  const m = e.meta;
  if (!m || typeof m !== "object" || Array.isArray(m)) return "bad meta";
  for (const field of ["mentions", "directives", "tags", "task_refs"] as const) {
    if (!Array.isArray(m[field]) || m[field].some(value => typeof value !== "string")) return `bad meta.${field}`;
  }
  if (m?.sender_verification !== undefined && m.sender_verification !== "unverified" && m.sender_verification !== "leased") return "bad sender verification";
  if (m?.hop !== undefined && !(Number.isInteger(m.hop) && m.hop >= 0 && m.hop <= MAX_RELAY_DEPTH)) return "bad hop";
  if (m?.origin !== undefined && m.origin !== "agent" && m.origin !== "external") return "bad origin";
  if (m?.project !== undefined && (typeof m.project !== "string" || m.project.length > 300)) return "bad project";
  return null;
}

// ---- owner grants ----------------------------------------------------------------------------
export const CAPS = ["task.assign", "decision", "broadcast", "alert"] as const;
export const MAX_GRANT_HOURS = 24 * 7;

/** The exact bytes the owner key signs for a grant (what ownerSignCanonical is given). */
export const grantPayload = (g: Omit<Grant, "sig">) => canonical(g);

/** An unsigned grant; sign `grantPayload(g)` with the owner key (ownerSignCanonical) and add it as `sig`. */
export function buildGrant(ownerPub: string, sessionPub: string, agent: string, host: string,
  caps: string[], hours = 12, now = new Date()): Omit<Grant, "sig"> {
  if (hours <= 0 || hours > MAX_GRANT_HOURS) throw new Error(`grant lifetime must be 1..${MAX_GRANT_HOURS} hours`);
  const bad = caps.filter((c) => !(CAPS as readonly string[]).includes(c));
  if (bad.length) throw new Error(`unknown caps: ${bad.join(", ")} (known: ${CAPS.join(", ")})`);
  return { v: 2 as const, id: ulid(now.getTime()), iss: fingerprint(ownerPub), sub: `session:${sessionPub}`, agent, host,
    caps: [...new Set(caps)].sort(), iat: now.toISOString(), exp: new Date(now.getTime() + hours * 3_600_000).toISOString(), nonce: nonce() };
}

export function makeGrant(ownerPub: string, ownerPriv: string, sessionPub: string, agent: string, host: string,
  caps: string[], hours = 12, now = new Date()): Grant {
  const g = buildGrant(ownerPub, sessionPub, agent, host, caps, hours, now);
  return { ...g, sig: signData(ownerPriv, grantPayload(g)) };
}

// Authority signatures commit to the pre-sealing form: transport sealing (T028) fills `enc` and swaps the
// body for ciphertext after signing, so verifiers pass the opened envelope and a filled `enc` reads as the
// `enc: null` it was signed with. Envelopes without the field keep canonicalizing without it.
const presealed = (rest: Omit<Envelope, "sig" | "authority">) => (rest.enc ? { ...rest, enc: null } : rest);
/** What the session key signs: the envelope without its host signature and without the session signature itself. */
const sessionPayload = (e: Envelope) => {
  const { sig: _s, authority, ...rest } = e;
  return canonical({ ...presealed(rest), authority: authority?.grant ? { grant: authority.grant } : null });
};
const ownerPayload = (e: Envelope) => {
  const { sig: _s, authority, ...rest } = e;
  return canonical({ ...presealed(rest), authority: { owner_fp: authority?.owner_fp ?? null } });
};

/** Step 1 of an owner-signed envelope: `payload` is the exact bytes the owner key signs (via ownerSignCanonical). */
export function ownerSignRequest(e: Envelope, ownerPub: string): { envelope: Envelope; payload: string } {
  const withFp: Envelope = { ...e, authority: { owner_sig: "", owner_fp: fingerprint(ownerPub) } };
  return { envelope: withFp, payload: ownerPayload(withFp) };
}
/** Step 2: attach the owner signature over `ownerSignRequest(...).payload`. */
export const withOwnerSig = (e: Envelope, sig: string): Envelope => ({ ...e, authority: { owner_sig: sig, owner_fp: e.authority!.owner_fp! } });

/** The owner signs one envelope directly with an unlocked owner key (tests; the CLI goes through ownerSignCanonical). */
export function ownerSign(e: Envelope, ownerPub: string, ownerPriv: string): Envelope {
  const r = ownerSignRequest(e, ownerPub);
  return withOwnerSig(r.envelope, signData(ownerPriv, r.payload));
}

/** Called by the master session's MCP server, which holds the session private key in memory only. */
export function attachAuthority(e: Envelope, grant: Grant, sessionPriv: string): Envelope {
  const withGrant: Envelope = { ...e, authority: { grant, session_sig: "" } };
  return { ...withGrant, authority: { grant, session_sig: signData(sessionPriv, sessionPayload(withGrant)) } };
}

/** Which caps does this envelope need for its authority to count? */
export function capsNeeded(e: Envelope): string[] {
  const need: string[] = [];
  if (e.kind === "task" || e.kind === "request") need.push("task.assign");
  else if (e.kind === "decision") need.push("decision");
  else if (e.kind === "alert") need.push("alert");
  else need.push(`kind:${e.kind}`); // status/message/reply never carry owner authority
  if (e.to.some((t) => t === "*" || t.startsWith("role:"))) need.push("broadcast");
  return need;
}

export type AuthorityCheck = { ok: true; caps: string[]; grant_id: string; session: string } | { ok: false; reason: string };

/** Verify owner authority on an envelope. `ownerPub` is the owner key pinned for the sending host. */
export function checkAuthority(e: Envelope, ownerPub: string | null, revoked: Set<string>, now = new Date()): AuthorityCheck {
  const a = e.authority;
  if (!a) return { ok: false, reason: "no authority" };
  if (!ownerPub) return { ok: false, reason: "no owner key pinned for the sending host" };
  if (a.owner_sig !== undefined) {
    if (a.owner_fp !== fingerprint(ownerPub)) return { ok: false, reason: "signed by an owner key other than the one pinned for that host" };
    if (!verifyData(ownerPub, ownerPayload(e), a.owner_sig)) return { ok: false, reason: "owner signature invalid" };
    return { ok: true, caps: [...CAPS], grant_id: "direct", session: "signed by the owner" };
  }
  const { sig, ...rest } = a.grant;
  if (a.grant.v !== 2) return { ok: false, reason: "unsupported grant version" };
  if (a.grant.iss !== fingerprint(ownerPub)) return { ok: false, reason: "grant not issued by the pinned owner key" };
  if (!verifyData(ownerPub, grantPayload(rest), sig)) return { ok: false, reason: "grant signature invalid" };
  if (`${a.grant.agent}@${a.grant.host}` !== e.from) return { ok: false, reason: `grant is for ${a.grant.agent}@${a.grant.host}, not ${e.from}` };
  if (!a.grant.sub.startsWith("session:")) return { ok: false, reason: "grant subject is not a session key" };
  const sessionPub = a.grant.sub.slice(8);
  if (!verifyData(sessionPub, sessionPayload(e), a.session_sig)) return { ok: false, reason: "not sent by the granted session (session signature invalid)" };
  const issued = typeof a.grant.iat === "string" ? Date.parse(a.grant.iat) : NaN;
  const expires = typeof a.grant.exp === "string" ? Date.parse(a.grant.exp) : NaN;
  const at = now.getTime();
  if (!Number.isFinite(issued) || !Number.isFinite(expires) || !Number.isFinite(at))
    return { ok: false, reason: "grant validity timestamps are invalid" };
  if (expires <= issued || expires - issued > MAX_GRANT_HOURS * 3_600_000)
    return { ok: false, reason: "grant lifetime is outside the allowed interval" };
  if (expires <= at) return { ok: false, reason: "grant expired" };
  if (revoked.has(a.grant.id)) return { ok: false, reason: "grant revoked" };
  const missing = capsNeeded(e).filter((c) => !a.grant.caps.includes(c));
  if (missing.length) return { ok: false, reason: `outside the grant's caps (needs ${missing.join(", ")})` };
  return { ok: true, caps: a.grant.caps, grant_id: a.grant.id, session: fingerprint(sessionPub) };
}

export const bodyHash = (e: Envelope) => sha256(e.body);
