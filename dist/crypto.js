// Canonical JSON, Ed25519 keys and signatures, fingerprints, pairing codes and ULIDs. node:crypto only.
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, sign, verify } from "node:crypto";
/** RFC 8785-style canonical JSON: sorted keys, no whitespace, `undefined` fields dropped. */
export function canonical(value) {
    if (value === null || typeof value !== "object") {
        if (typeof value === "number" && !Number.isFinite(value))
            throw new Error("canonical: non-finite number");
        return JSON.stringify(value);
    }
    if (Array.isArray(value))
        return `[${value.map((v) => canonical(v === undefined ? null : v)).join(",")}]`;
    const obj = value;
    const keys = Object.keys(obj).filter((k) => obj[k] !== undefined).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical(obj[k])}`).join(",")}}`;
}
const SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
const PKCS8_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");
export function generateKeyPair() {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const pub = publicKey.export({ format: "der", type: "spki" }).subarray(SPKI_PREFIX.length);
    const priv = privateKey.export({ format: "der", type: "pkcs8" }).subarray(PKCS8_PREFIX.length);
    return { publicKey: pub.toString("base64"), privateKey: priv.toString("base64") };
}
const pubObj = (b64) => createPublicKey({ key: Buffer.concat([SPKI_PREFIX, Buffer.from(b64, "base64")]), format: "der", type: "spki" });
const privObj = (b64) => createPrivateKey({ key: Buffer.concat([PKCS8_PREFIX, Buffer.from(b64, "base64")]), format: "der", type: "pkcs8" });
const bytes = (data) => (typeof data === "string" ? Buffer.from(data) : data);
export function signData(privateKey, data) {
    return sign(null, bytes(data), privObj(privateKey)).toString("base64");
}
export function verifyData(publicKey, data, signature) {
    try {
        return verify(null, bytes(data), pubObj(publicKey), Buffer.from(signature, "base64"));
    }
    catch {
        return false;
    }
}
/** Short, human-comparable key id: first 16 hex chars of sha256(raw public key), grouped. */
export function fingerprint(publicKey) {
    const h = createHash("sha256").update(Buffer.from(publicKey, "base64")).digest("hex").slice(0, 16);
    return h.match(/.{4}/g).join("-");
}
/** 6-digit short authentication string over the whole pairing transcript (host names, host keys, owner keys, nonces).
 *  Order-independent, so both sides compute the same digits. */
export function pairingCode(a, b) {
    const parts = [a, b].map((p) => [p.host, p.host_pubkey, p.owner_pubkey ?? "-", p.nonce].join("|")).sort();
    const h = createHash("sha256").update(`mbx-pair-v2\n${parts.join("\n")}`).digest();
    return String(h.readUInt32BE(0) % 1_000_000).padStart(6, "0");
}
export const sha256 = (s) => createHash("sha256").update(s).digest("hex");
export const nonce = () => randomBytes(16).toString("base64url");
// ULID: 48-bit ms timestamp + 80 random bits, Crockford base32, monotonic within a millisecond.
const B32 = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
let lastTs = -1;
let lastRand = [];
export function ulid(now = Date.now()) {
    let rand;
    if (now === lastTs) {
        rand = lastRand.slice();
        for (let i = rand.length - 1; i >= 0; i--) {
            if (rand[i] < 31) {
                rand[i]++;
                break;
            }
            rand[i] = 0;
        }
    }
    else
        rand = Array.from(randomBytes(16)).map((b) => b % 32);
    lastTs = now;
    lastRand = rand;
    let t = now, ts = "";
    for (let i = 0; i < 10; i++) {
        ts = B32[t % 32] + ts;
        t = Math.floor(t / 32);
    }
    return ts + rand.map((r) => B32[r]).join("");
}
