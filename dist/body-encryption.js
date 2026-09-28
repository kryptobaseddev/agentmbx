// Body encryption for untrusted hops (T028, Option A foundation). Not wired into send/receive yet:
// this module only seals/opens bodies and defines the envelope `enc` v1 shape. How hosts obtain each
// other's X25519 keys (derived from Ed25519 at pairing, or enrolled alongside it) is a caller concern
// decided when the send path wires in (see docs/research/BODY-ENCRYPTION-DESIGN.md).
import { createHmac, createHash, randomBytes } from "node:crypto";
import { x25519 } from "@noble/curves/ed25519.js";
import { xchacha20poly1305 } from "@noble/ciphers/chacha.js";
export const ENC_ALG = "x25519+xchacha20poly1305";
export const encBody = (epk, nonce, ciphertext) => ({ v: 1, alg: ENC_ALG, epk: Buffer.from(epk).toString("base64"), nonce: Buffer.from(nonce).toString("base64"), body: Buffer.from(ciphertext).toString("base64") });
const b64 = (s, bytes) => typeof s === "string" && Buffer.from(s, "base64").length === bytes;
/** Structural validation for `enc` v1; anything else is refused before any decryption is attempted. */
export function checkEnc(x) {
    if (typeof x !== "object" || x === null)
        return "bad enc";
    const e = x;
    if (e.v !== 1)
        return "unsupported enc version";
    if (e.alg !== ENC_ALG)
        return "unsupported enc algorithm";
    if (!b64(e.epk, 32))
        return "bad enc epk";
    if (!b64(e.nonce, 24))
        return "bad enc nonce";
    if (typeof e.body !== "string" || !e.body)
        return "bad enc body";
    return null;
}
const hkdf = (ikm, salt, info, len) => {
    const prk = createHmac("sha256", salt).update(ikm).digest();
    const out = Buffer.alloc(len);
    let t = Buffer.alloc(0);
    for (let i = 1; t.length < len; i++)
        t = createHmac("sha256", prk).update(Buffer.concat([t, info, Buffer.from([i])])).digest();
    t.copy(out, 0, 0, len);
    return out;
};
const ENCODER = new TextEncoder();
const DECODER = new TextDecoder();
/** One ephemeral X25519 keypair per sealed envelope: forward secrecy for every body independently. */
export const generateEncKeyPair = () => {
    const secretKey = x25519.utils.randomSecretKey();
    return { publicKey: Buffer.from(x25519.getPublicKey(secretKey)).toString("base64"), privateKey: Buffer.from(secretKey).toString("base64") };
};
/**
 * Seal a body for one recipient. The per-envelope key comes from ECDH(ephemeral secret, recipient public)
 * stretched with HKDF over the envelope id as context, so the same pair of keys never reuses key material
 * across envelopes even for identical bodies.
 */
export function sealBody(body, recipientPublicKey, envelopeId) {
    const ephemeral = x25519.utils.randomSecretKey();
    const ephemeralPub = x25519.getPublicKey(ephemeral);
    const shared = x25519.getSharedSecret(ephemeral, Buffer.from(recipientPublicKey, "base64"));
    const key = hkdf(shared, Buffer.from(ephemeralPub), ENCODER.encode(`agentmbx-enc-1:${envelopeId ?? ""}`), 32);
    const nonce = randomBytes(24);
    const ciphertext = xchacha20poly1305(key, nonce).encrypt(ENCODER.encode(body));
    return encBody(ephemeralPub, nonce, ciphertext);
}
/** Open a sealed body; throws on any mismatch. Callers must have validated the envelope first. */
export function openBody(enc, recipientPrivateKey, envelopeId) {
    if (checkEnc(enc))
        throw new Error("invalid enc body");
    const shared = x25519.getSharedSecret(Buffer.from(recipientPrivateKey, "base64"), Buffer.from(enc.epk, "base64"));
    const key = hkdf(shared, Buffer.from(enc.epk, "base64"), ENCODER.encode(`agentmbx-enc-1:${envelopeId ?? ""}`), 32);
    const plain = xchacha20poly1305(key, Buffer.from(enc.nonce, "base64")).decrypt(Buffer.from(enc.body, "base64"));
    return DECODER.decode(plain);
}
