// The owner key: Ed25519, encrypted at rest with a passphrase (scrypt + AES-256-GCM).
// Unlocking needs the passphrase typed on a real terminal (/dev/tty), which agent tool calls do not have.
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";
import { existsSync, openSync, readFileSync, readSync, closeSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { fingerprint, generateKeyPair, signData } from "./crypto.js";
const SCRYPT = { N: 1 << 17, r: 8, p: 1, maxmem: 256 * 1024 * 1024 };
export const ownerPath = (home) => join(home, "owner.key");
export function ownerPublicKey(home) {
    if (!existsSync(ownerPath(home)))
        return null;
    return JSON.parse(readFileSync(ownerPath(home), "utf8")).public_key;
}
export function createOwnerKey(home, passphrase) {
    if (existsSync(ownerPath(home)))
        throw new Error("owner key already exists");
    if (passphrase.length < 12)
        throw new Error("use a passphrase of at least 12 characters");
    const kp = generateKeyPair();
    const salt = randomBytes(16), iv = randomBytes(12);
    const key = scryptSync(passphrase, salt, 32, SCRYPT);
    const c = createCipheriv("aes-256-gcm", key, iv);
    const ct = Buffer.concat([c.update(kp.privateKey, "utf8"), c.final()]);
    const f = { v: 1, public_key: kp.publicKey, kdf: "scrypt", salt: salt.toString("base64"), iv: iv.toString("base64"),
        tag: c.getAuthTag().toString("base64"), ciphertext: ct.toString("base64") };
    writeFileSync(ownerPath(home), JSON.stringify(f, null, 1) + "\n", { mode: 0o600, flag: "wx" });
    return kp.publicKey;
}
export function unlockOwnerKey(home, passphrase) {
    const f = JSON.parse(readFileSync(ownerPath(home), "utf8"));
    const key = scryptSync(passphrase, Buffer.from(f.salt, "base64"), 32, SCRYPT);
    const d = createDecipheriv("aes-256-gcm", key, Buffer.from(f.iv, "base64"));
    d.setAuthTag(Buffer.from(f.tag, "base64"));
    try {
        const priv = Buffer.concat([d.update(Buffer.from(f.ciphertext, "base64")), d.final()]).toString("utf8");
        return { publicKey: f.public_key, privateKey: priv };
    }
    catch {
        throw new Error("wrong passphrase");
    }
}
/** Read a passphrase from the controlling terminal with echo off. Throws when there is no terminal
 *  (e.g. an agent's Bash tool), which is the point: only a human at a keyboard can unlock the owner key. */
export function readPassphraseFromTTY(prompt) {
    let fd;
    try {
        fd = openSync("/dev/tty", "r+");
    }
    catch {
        throw new Error("owner commands need an interactive terminal (no /dev/tty). Run this yourself in Terminal, not through an agent.");
    }
    try {
        writeFileSync(fd, prompt);
        spawnSync("stty", ["-echo"], { stdio: [fd, "ignore", "ignore"] });
        const buf = Buffer.alloc(1024);
        let s = "";
        for (;;) {
            const n = readSync(fd, buf, 0, buf.length, null);
            if (n <= 0)
                break;
            s += buf.subarray(0, n).toString("utf8");
            if (s.includes("\n"))
                break;
        }
        return s.split("\n")[0].replace(/\r$/, "");
    }
    finally {
        spawnSync("stty", ["echo"], { stdio: [fd, "ignore", "ignore"] });
        writeFileSync(fd, "\n");
        closeSync(fd);
    }
}
export const ownerFingerprint = (home) => { const p = ownerPublicKey(home); return p ? fingerprint(p) : null; };
/**
 * The one way to get an owner signature: sign `canonicalJson` (the exact bytes receivers verify) after the human
 * approves. The file backend asks for the passphrase on /dev/tty; the macOS keychain backend (T052) shows a
 * Touch ID / password prompt whose text is derived from `canonicalJson`. `summary` is shown on the terminal
 * (file backend) so the human knows what they are signing.
 */
export async function ownerSignCanonical(home, canonicalJson, summary) {
    const pub = ownerPublicKey(home);
    if (!pub)
        throw new Error("no owner key on this machine: run 'agentmbx owner init'");
    const kp = unlockOwnerKey(home, readPassphraseFromTTY(`${summary}\nOwner passphrase: `));
    return { sig: signData(kp.privateKey, canonicalJson), pub, fp: fingerprint(pub) };
}
