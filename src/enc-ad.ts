// Signed, expiring encryption-key advertisements (T168, docs/spec/relay-durability.md §8). A host tells senders which
// X25519 key to seal its mail for. Over the relay the advertisement passes through an untrusted party, so it must prove
// itself: signed by the host key the sender pinned at pairing, naming that key and host, inside its validity window.
// A v1 advertisement ({v:1, host, enc_pub}) carries no expiry, so a relay could replay an old one forever; senders on
// this version refuse it from a relay (the LAN exchange is unchanged). Publishers still send v1 for older senders.
import { canonical, signData, verifyData, type KeyPair } from "./crypto.ts";

export interface EncAdRecord { v: 2; type: "enc-ad"; host: string; host_pubkey: string; enc_pub: string; iat: string; exp: string }
/** How long a published advertisement is valid, and the longest validity anyone accepts. */
export const ENC_AD_TTL_MS = 30 * 86_400_000;
export const ENC_AD_MAX_TTL_MS = 90 * 86_400_000;
/** A publisher refreshes its advertisement at the relay once a day (and on any key or relay epoch change). */
export const ENC_AD_REFRESH_MS = 86_400_000;
const SKEW_MS = 5 * 60_000;

const isKey32 = (k: unknown): k is string => typeof k === "string" && k.length === 44 && /^[A-Za-z0-9+/]{43}=$/.test(k) && Buffer.from(k, "base64").length === 32;

export function signEncAd(host: string, hostKey: KeyPair, encPub: string, now = Date.now(), ttl = ENC_AD_TTL_MS): { ad: EncAdRecord; sig: string } {
  const ad: EncAdRecord = { v: 2, type: "enc-ad", host, host_pubkey: hostKey.publicKey, enc_pub: encPub, iat: new Date(now).toISOString(), exp: new Date(now + ttl).toISOString() };
  return { ad, sig: signData(hostKey.privateKey, canonical(ad)) };
}

/**
 * Null when `ad`, signed `sig`, is a current advertisement by `expect.host_pubkey` (and `expect.host`, when given);
 * otherwise why not: unsigned, malformed, wrong peer, bad signature (tampered, or another key signed it), not yet valid,
 * expired, or a lifetime over the maximum. The record is checked exactly as received: an added field breaks the signature.
 */
export function checkEncAd(ad: unknown, sig: unknown, expect: { host?: string; host_pubkey: string }, now = Date.now()): string | null {
  if (typeof sig !== "string" || !sig) return "unsigned";
  const a = ad as Partial<EncAdRecord> | null;
  if (!a || typeof a !== "object" || a.v !== 2 || a.type !== "enc-ad" || typeof a.host !== "string" || typeof a.host_pubkey !== "string"
    || typeof a.iat !== "string" || typeof a.exp !== "string" || !isKey32(a.enc_pub) || a.host.length > 255 || a.iat.length > 40 || a.exp.length > 40) return "malformed";
  if (a.host_pubkey !== expect.host_pubkey || (expect.host !== undefined && a.host !== expect.host)) return "wrong peer";
  if (!verifyData(expect.host_pubkey, canonical(a), sig)) return "bad signature";
  const iat = Date.parse(a.iat), exp = Date.parse(a.exp);
  if (!Number.isFinite(iat) || !Number.isFinite(exp)) return "malformed";
  if (iat > now + SKEW_MS) return "not yet valid";
  if (exp <= now) return "expired";
  if (exp - iat > ENC_AD_MAX_TTL_MS) return "lifetime over the maximum";
  return null;
}

/**
 * A paired peer's enc key from a relay's enc-key answer, or why it is refused. Only the signed v2 record counts; a
 * served `enc_pub` beside it must be the same key (a relay that answers two keys is tampering).
 */
export function encFromRelayAnswer(answer: Record<string, unknown> | null | undefined, peer: { host: string; pubkey: string }, now = Date.now()): { enc_pub: string } | { reason: string } {
  const j = answer ?? {};
  if (j.ad === undefined) {
    return typeof j.enc_pub === "string" && typeof j.sig === "string"
      ? { reason: "unexpiring v1 advertisement (the peer's AgentMBX predates signed expiring ads, or the relay withheld the current one)" }
      : { reason: "unsigned" };
  }
  const bad = checkEncAd(j.ad, j.ad_sig, { host: peer.host, host_pubkey: peer.pubkey }, now);
  if (bad) return { reason: bad };
  const encPub = (j.ad as EncAdRecord).enc_pub;
  if (j.enc_pub !== undefined && j.enc_pub !== encPub) return { reason: "tampered: the served key differs from the signed advertisement" };
  return { enc_pub: encPub };
}
