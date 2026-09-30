// Host identity backup (T031) for machine replacement: config, the host Ed25519 key, the X25519 body key, a file-backend
// owner key (already passphrase-encrypted) and every approved peer with its pinned keys. The same host key on the new
// machine keeps existing pairings valid. The bundle is sealed with a passphrase (scrypt + XChaCha20-Poly1305) and written
// 0600. A Keychain owner key is not exportable: only its public key is recorded, for information.
// Mail, policies and devices are not part of the bundle; back up the complete home for those.
import { randomBytes, scryptSync } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { xchacha20poly1305 } from "@noble/ciphers/chacha.js";
import { x25519 } from "@noble/curves/ed25519.js";
import { canonical, fingerprint, signData, verifyData } from "./crypto.js";
import { NAME_RE } from "./envelope.js";
import { MbxNode } from "./node.js";
import { ownerInfo } from "./owner.js";
import { privatePath } from "./private-files.js";
const SCRYPT = { N: 1 << 17, r: 8, p: 1, maxmem: 256 * 1024 * 1024 };
export const IDENTITY_FILES = ["config.json", "host.key", "enc.key", "owner.key", "owner.json"];
const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };
const checkPassphrase = (s) => { if (s.length < 12)
    fail("USAGE_ERROR", "use a passphrase of at least 12 characters"); };
const key = (pass, salt) => scryptSync(pass, salt, 32, SCRYPT);
const aad = ({ ciphertext: _, ...header }) => Buffer.from(canonical(header));
export function sealBundle(bundle, passphrase) {
    checkPassphrase(passphrase);
    const salt = randomBytes(16), nonce = randomBytes(24);
    const header = { format: "agentmbx-identity", v: 1, kdf: "scrypt", N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p, salt: salt.toString("base64"),
        alg: "xchacha20poly1305", nonce: nonce.toString("base64"), ciphertext: "" };
    const ct = xchacha20poly1305(key(passphrase, salt), nonce, aad(header)).encrypt(Buffer.from(JSON.stringify(bundle)));
    return { ...header, ciphertext: Buffer.from(ct).toString("base64") };
}
export function openBundle(raw, passphrase) {
    let s;
    try {
        s = JSON.parse(raw);
    }
    catch {
        return fail("BAD_BUNDLE", "not an AgentMBX identity bundle");
    }
    if (s?.format !== "agentmbx-identity" || s.v !== 1 || s.kdf !== "scrypt" || s.alg !== "xchacha20poly1305"
        || s.N !== SCRYPT.N || s.r !== SCRYPT.r || s.p !== SCRYPT.p || ![s.salt, s.nonce, s.ciphertext].every((x) => typeof x === "string"))
        fail("BAD_BUNDLE", "not a supported AgentMBX identity bundle (v1)");
    let b;
    try {
        const pt = xchacha20poly1305(key(passphrase, Buffer.from(s.salt, "base64")), Buffer.from(s.nonce, "base64"), aad(s))
            .decrypt(Buffer.from(s.ciphertext, "base64"));
        b = JSON.parse(Buffer.from(pt).toString("utf8"));
    }
    catch {
        return fail("BAD_PASSPHRASE", "wrong passphrase or damaged identity bundle");
    }
    // Refuse a bundle whose halves do not belong together before anything on disk changes.
    const ok = b?.v === 1 && typeof b.host === "string" && NAME_RE.test(b.host) && b.config?.host === b.host
        && verifyData(b.host_key?.publicKey, "agentmbx-identity", signData(b.host_key.privateKey, "agentmbx-identity"))
        && Buffer.from(x25519.getPublicKey(Buffer.from(b.enc_key?.privateKey ?? "", "base64"))).toString("base64") === b.enc_key.publicKey
        && Array.isArray(b.peers) && Array.isArray(b.principals);
    if (!ok)
        fail("BAD_BUNDLE", "identity bundle contents are inconsistent");
    return b;
}
/** Everything the bundle holds, read from an open node. */
export function identityBundle(node) {
    const db = node.store.db, info = ownerInfo(node.home);
    return {
        v: 1, created_at: new Date().toISOString(), host: node.host, config: JSON.parse(readFileSync(join(node.home, "config.json"), "utf8")),
        host_key: node.key, enc_key: node.encKey,
        owner: !info ? null : info.backend === "file" ? { backend: "file", file: JSON.parse(readFileSync(info.path, "utf8")) } : { backend: "keychain", public_key: info.public_key },
        peers: db.prepare("SELECT host,pubkey,owner_pubkey,addr,enc_pub,created_at,approved_at FROM peers WHERE state='approved' ORDER BY host").all(),
        principals: db.prepare("SELECT fp,pub,role,label,via,added_at,peer FROM principals WHERE via<>'local' ORDER BY fp").all(),
    };
}
/** Write the sealed bundle (0600, never over an existing file unless `force`). */
export function exportIdentity(node, file, passphrase, o = {}) {
    const b = identityBundle(node);
    writeFileSync(file, JSON.stringify(sealBundle(b, passphrase)) + "\n", { mode: 0o600, flag: o.force ? "w" : "wx" });
    privatePath(file, 0o600, false, false); // an overwritten file keeps its old mode unless enforced
    return { host: b.host, peers: b.peers.length, owner: b.owner?.backend ?? null };
}
export const identityInitialized = (home) => ["config.json", "host.key", "enc.key"].some((f) => existsSync(join(home, f)));
/**
 * Restore a bundle into `home`. A home with an identity is refused unless `force`; then its identity files and a
 * consistent copy of mbx.db go to <home>/identity-backup-<time>/ first. Stop the daemon and agents on `home` before this.
 */
export function importIdentity(home, raw, passphrase, o = {}) {
    const b = openBundle(raw, passphrase);
    mkdirSync(home, { recursive: true, mode: 0o700 });
    privatePath(home, 0o700);
    let backup = null;
    if (identityInitialized(home)) {
        if (!o.force)
            fail("IDENTITY_EXISTS", `${home} already has a host identity; refusing to overwrite it (use --force: the old identity is backed up first)`);
        backup = join(home, `identity-backup-${new Date(o.now ?? Date.now()).toISOString().replace(/[:.]/g, "-")}`);
        mkdirSync(backup, { mode: 0o700 });
        for (const f of IDENTITY_FILES)
            if (existsSync(join(home, f))) {
                copyFileSync(join(home, f), join(backup, f));
                privatePath(join(backup, f), 0o600, false, false);
            }
        if (existsSync(join(home, "mbx.db"))) {
            const db = new DatabaseSync(join(home, "mbx.db"), { readOnly: true });
            try {
                db.prepare("VACUUM INTO ?").run(join(backup, "mbx.db"));
            }
            finally {
                db.close();
            }
            privatePath(join(backup, "mbx.db"), 0o600, false, false);
        }
        for (const f of IDENTITY_FILES)
            rmSync(join(home, f), { force: true });
    }
    const put = (f, v) => writeFileSync(join(home, f), JSON.stringify(v, f === "owner.key" ? null : undefined, f === "owner.key" ? 1 : 2) + "\n", { mode: 0o600, flag: "wx" });
    put("config.json", b.config);
    put("host.key", b.host_key);
    put("enc.key", b.enc_key);
    if (b.owner?.backend === "file")
        put("owner.key", b.owner.file);
    const node = new MbxNode(home);
    try {
        node.store.tx(() => {
            const db = node.store.db, owner = node.ownerPub;
            // A replaced identity's local owner must not keep authority here; only the restored owner key (if any) counts.
            db.prepare("DELETE FROM principals WHERE via='local' AND fp<>?").run(owner ? fingerprint(owner) : "");
            for (const p of b.peers)
                db.prepare(`INSERT INTO peers (host,pubkey,owner_pubkey,addr,state,code,nonce_local,nonce_remote,created_at,approved_at,enc_pub)
        VALUES (?,?,?,?,'approved',NULL,NULL,NULL,?,?,?) ON CONFLICT(host) DO UPDATE SET pubkey=excluded.pubkey, owner_pubkey=excluded.owner_pubkey,
        addr=excluded.addr, state='approved', code=NULL, approved_at=excluded.approved_at, enc_pub=excluded.enc_pub`)
                    .run(p.host, p.pubkey, p.owner_pubkey, p.addr, p.created_at, p.approved_at, p.enc_pub);
            for (const r of b.principals)
                db.prepare(`INSERT INTO principals (fp,pub,role,label,via,added_at,peer) VALUES (?,?,?,?,?,?,?)
        ON CONFLICT(fp) DO UPDATE SET role=excluded.role, label=excluded.label, via=excluded.via, peer=excluded.peer`)
                    .run(r.fp, r.pub, r.role, r.label, r.via, r.added_at, r.peer);
            node.store.audit("identity.imported", { host: b.host, exported_at: b.created_at, peers: b.peers.map((p) => p.host), backup });
        });
        return { host: node.host, peers: b.peers.map((p) => p.host), backup, owner: b.owner };
    }
    finally {
        node.close();
    }
}
