// Canonical JSON, Ed25519 keys and signatures, fingerprints, pairing codes and ULIDs. node:crypto only.
import { createHash, createHmac, createPrivateKey, createPublicKey, generateKeyPairSync, hkdfSync, randomBytes, scryptSync, sign, timingSafeEqual, verify } from "node:crypto";

/** RFC 8785-style canonical JSON: sorted keys, no whitespace, `undefined` fields dropped. */
export function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") {
    if (typeof value === "number" && !Number.isFinite(value)) throw new Error("canonical: non-finite number");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map((v) => canonical(v === undefined ? null : v)).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).filter((k) => obj[k] !== undefined).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical(obj[k])}`).join(",")}}`;
}

export interface KeyPair { publicKey: string; privateKey: string } // base64 raw 32-byte keys

const SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
const PKCS8_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");

export function generateKeyPair(): KeyPair {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const pub = publicKey.export({ format: "der", type: "spki" }).subarray(SPKI_PREFIX.length);
  const priv = privateKey.export({ format: "der", type: "pkcs8" }).subarray(PKCS8_PREFIX.length);
  return { publicKey: pub.toString("base64"), privateKey: priv.toString("base64") };
}

const pubObj = (b64: string) => createPublicKey({ key: Buffer.concat([SPKI_PREFIX, Buffer.from(b64, "base64")]), format: "der", type: "spki" });
const privObj = (b64: string) => createPrivateKey({ key: Buffer.concat([PKCS8_PREFIX, Buffer.from(b64, "base64")]), format: "der", type: "pkcs8" });

export function signData(privateKey: string, data: string): string {
  return sign(null, Buffer.from(data), privObj(privateKey)).toString("base64");
}

export function verifyData(publicKey: string, data: string, signature: string): boolean {
  try { return verify(null, Buffer.from(data), pubObj(publicKey), Buffer.from(signature, "base64")); }
  catch { return false; }
}

/** Short, human-comparable key id: first 16 hex chars of sha256(raw public key), grouped. */
export function fingerprint(publicKey: string): string {
  const h = createHash("sha256").update(Buffer.from(publicKey, "base64")).digest("hex").slice(0, 16);
  return h.match(/.{4}/g)!.join("-");
}

export interface PairParty { host: string; host_pubkey: string; owner_pubkey: string | null; nonce: string }

/** 6-digit short authentication string over the whole pairing transcript (host names, host keys, owner keys, nonces).
 *  Order-independent, so both sides compute the same digits. */
export function pairingCode(a: PairParty, b: PairParty): string {
  const parts = [a, b].map((p) => [p.host, p.host_pubkey, p.owner_pubkey ?? "-", p.nonce].join("|")).sort();
  const h = createHash("sha256").update(`mbx-pair-v2\n${parts.join("\n")}`).digest();
  return String(h.readUInt32BE(0) % 1_000_000).padStart(6, "0");
}

// ---- token pairing (agentmbx pair / join) ----------------------------------------------------------
/** A one-time pairing token: 12 Crockford base32 chars = 60 random bits, shown as XXXX-XXXX-XXXX. */
export function newPairToken(): string {
  const bits = randomBytes(8).readBigUInt64BE() >> 4n; // 60 bits
  let s = "";
  for (let i = 11; i >= 0; i--) s += B32[Number((bits >> BigInt(i * 5)) & 31n)];
  return `${s.slice(0, 4)}-${s.slice(4, 8)}-${s.slice(8)}`;
}

/** Accepts lower case, missing dashes/spaces, and Crockford look-alikes (I/L→1, O→0). Throws if malformed. */
export function normalizePairToken(t: string): string {
  const s = t.toUpperCase().replace(/[\s-]/g, "").replace(/[IL]/g, "1").replace(/O/g, "0");
  if (!/^[0-9A-HJKMNP-TV-Z]{12}$/.test(s)) throw new Error("malformed pairing token (expected XXXX-XXXX-XXXX)");
  return s;
}

/** Slow, salted derivation of the pairing key from the token (scrypt N=2^15). The daemon stores only this, never the
 *  token, and the cost makes offline guessing against an observed MAC hopeless within the token's lifetime. */
export function pairTokenKey(token: string): string {
  return scryptSync(normalizePairToken(token), "agentmbx-pair-token-v1", 32, { N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }).toString("hex");
}

/** Both parties' public halves (host names, host keys, owner keys, nonces) plus the address B asks A to use. */
export function joinTranscript(a: PairParty, b: PairParty & { addr: string }): string {
  const pick = (p: PairParty) => ({ host: p.host, host_pubkey: p.host_pubkey, owner_pubkey: p.owner_pubkey ?? null, nonce: p.nonce });
  return canonical({ proto: "agentmbx-pair-token-v1", a: pick(a), b: { ...pick(b), addr: b.addr } });
}

/** HMAC-SHA256 over the transcript, keyed by HKDF(token key, label). "join" is B→A, "accept" is A→B. */
export function pairMac(tokenKey: string, label: "join" | "accept", transcript: string): string {
  const k = Buffer.from(hkdfSync("sha256", Buffer.from(tokenKey, "hex"), "agentmbx-pair-token-v1", `mac:${label}`, 32));
  return createHmac("sha256", k).update(`${label}\n${transcript}`).digest("base64url");
}

export function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export const sha256 = (s: string | Buffer) => createHash("sha256").update(s).digest("hex");
export const nonce = () => randomBytes(16).toString("base64url");

// ULID: 48-bit ms timestamp + 80 random bits, Crockford base32, monotonic within a millisecond.
const B32 = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
let lastTs = -1; let lastRand: number[] = [];
export function ulid(now = Date.now()): string {
  let rand: number[];
  if (now === lastTs) {
    rand = lastRand.slice();
    for (let i = rand.length - 1; i >= 0; i--) { if (rand[i] < 31) { rand[i]++; break; } rand[i] = 0; }
  } else rand = Array.from(randomBytes(16)).map((b) => b % 32);
  lastTs = now; lastRand = rand;
  let t = now, ts = "";
  for (let i = 0; i < 10; i++) { ts = B32[t % 32] + ts; t = Math.floor(t / 32); }
  return ts + rand.map((r) => B32[r]).join("");
}
