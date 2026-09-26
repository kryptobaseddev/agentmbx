// The signed message envelope, owner grants, and the body metadata parser.
import { canonical, fingerprint, nonce, sha256, signData, ulid, verifyData } from "./crypto.ts";

export const KINDS = ["message", "request", "reply", "status", "decision", "alert", "task"] as const;
export type Kind = (typeof KINDS)[number];
export const MAX_BODY = 256 * 1024;
export const NAME_RE = /^[a-z0-9][a-z0-9-]{1,39}$/;

export interface Meta { mentions: string[]; directives: string[]; tags: string[]; task_refs: string[] }

/** Owner-signed delegation: the owner lets one agent speak with owner authority for a limited time. */
export interface Grant {
  v: 1; id: string; iss: string /* owner key fingerprint */; sub: string /* agent@host */;
  caps: string[]; iat: string; exp: string; nonce: string; sig: string;
}

export interface Envelope {
  v: 3; id: string; ts: string; from: string; to: string[]; thread: string; reply_to: string | null;
  kind: Kind; subject: string; body: string; needs_reply: boolean; refs: string[]; meta: Meta;
  authority: { grant: Grant } | null; enc: null;
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
  reply_to?: string | null; needs_reply?: boolean; refs?: string[]; grant?: Grant | null;
}

export function buildEnvelope(d: Draft, now = new Date()): Envelope {
  if (!d.subject.trim()) throw new Error("subject is required");
  if (Buffer.byteLength(d.body) > MAX_BODY) throw new Error(`body is over ${MAX_BODY / 1024} KB; put large content in refs`);
  if (!d.to.length) throw new Error("at least one recipient is required");
  const id = ulid(now.getTime());
  return {
    v: 3, id, ts: now.toISOString(), from: d.from, to: d.to, thread: d.thread ?? id, reply_to: d.reply_to ?? null,
    kind: d.kind ?? "message", subject: d.subject.slice(0, 200), body: d.body, needs_reply: d.needs_reply ?? false,
    refs: d.refs ?? [], meta: parseMeta(d.body), authority: d.grant ? { grant: d.grant } : null, enc: null,
  };
}

const unsigned = (e: Envelope) => { const { sig: _s, ...rest } = e; return canonical(rest); };

export function signEnvelope(e: Envelope, host: string, hostPub: string, hostPriv: string): Envelope {
  return { ...e, sig: { alg: "ed25519", host, key: fingerprint(hostPub), value: signData(hostPriv, unsigned(e)) } };
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
  if (Number.isNaN(Date.parse(e.ts))) return "bad ts";
  return null;
}

// ---- owner grants ----------------------------------------------------------------------------
const grantPayload = (g: Omit<Grant, "sig">) => canonical(g);

export function makeGrant(ownerPub: string, ownerPriv: string, sub: string, caps: string[], days: number, now = new Date()): Grant {
  const g = { v: 1 as const, id: ulid(now.getTime()), iss: fingerprint(ownerPub), sub, caps: [...caps].sort(),
    iat: now.toISOString(), exp: new Date(now.getTime() + days * 86_400_000).toISOString(), nonce: nonce() };
  return { ...g, sig: signData(ownerPriv, grantPayload(g)) };
}

export type GrantCheck = { ok: true; caps: string[] } | { ok: false; reason: string };

/** Verify an owner grant attached to an envelope sent by `from`. `revoked` holds revoked grant ids. */
export function checkGrant(g: Grant, ownerPub: string, from: string, revoked: Set<string>, now = new Date()): GrantCheck {
  const { sig, ...rest } = g;
  if (g.iss !== fingerprint(ownerPub)) return { ok: false, reason: "grant not issued by the pinned owner key" };
  if (!verifyData(ownerPub, grantPayload(rest), sig)) return { ok: false, reason: "grant signature invalid" };
  if (g.sub !== from) return { ok: false, reason: `grant is for ${g.sub}, not ${from}` };
  if (Date.parse(g.exp) < now.getTime()) return { ok: false, reason: "grant expired" };
  if (revoked.has(g.id)) return { ok: false, reason: "grant revoked" };
  return { ok: true, caps: g.caps };
}

export const bodyHash = (e: Envelope) => sha256(e.body);
