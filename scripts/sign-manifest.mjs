#!/usr/bin/env node
// Sign a release manifest with the release Ed25519 key.
//   RELEASE_SIGNING_KEY=<base64 raw 32-byte private key> node scripts/sign-manifest.mjs <manifest.json>
//     writes <manifest.json>.sig = base64 Ed25519 signature over the exact file bytes, after checking that the key
//     matches the public key pinned in src/release-key.ts (a mismatch would ship a release no install can verify).
//   node scripts/sign-manifest.mjs --keygen
//     prints a new key pair (same raw base64 format as src/crypto.ts generateKeyPair). See docs/RELEASING.md.
import { createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";

const SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
const PKCS8_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");

if (process.argv[2] === "--keygen") {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const pub = publicKey.export({ format: "der", type: "spki" }).subarray(SPKI_PREFIX.length).toString("base64");
  const priv = privateKey.export({ format: "der", type: "pkcs8" }).subarray(PKCS8_PREFIX.length).toString("base64");
  console.log(`public  (src/release-key.ts):          ${pub}\nprivate (secret RELEASE_SIGNING_KEY):   ${priv}`);
  process.exit(0);
}

const file = process.argv[2];
if (!file) { console.error("usage: sign-manifest.mjs <manifest.json> | --keygen"); process.exit(2); }
const raw = Buffer.from((process.env.RELEASE_SIGNING_KEY ?? "").trim(), "base64");
if (raw.length !== 32) { console.error("RELEASE_SIGNING_KEY must be a base64 raw 32-byte Ed25519 private key"); process.exit(1); }
const priv = createPrivateKey({ key: Buffer.concat([PKCS8_PREFIX, raw]), format: "der", type: "pkcs8" });
const pubObj = createPublicKey(priv);
const pub = pubObj.export({ format: "der", type: "spki" }).subarray(SPKI_PREFIX.length).toString("base64");

const { RELEASE_PUBLIC_KEY } = await import(new URL("../src/release-key.ts", import.meta.url).href);
// key rotation: the one release that ships the new pinned key is still signed with the previous key
const rotatingFrom = (process.env.RELEASE_ROTATION_PREVIOUS_KEY ?? "").trim();
if (rotatingFrom && rotatingFrom === pub) console.log(`key rotation: signing with previous key ${pub}; binaries in this release pin ${RELEASE_PUBLIC_KEY}`);
else if (RELEASE_PUBLIC_KEY !== pub) {
  console.error(`signing key does not match the key pinned in src/release-key.ts\n  pinned:  ${RELEASE_PUBLIC_KEY}\n  signing: ${pub}\n`
    + "Installed binaries would reject this release. Pin the right public key (docs/RELEASING.md) and tag again.");
  process.exit(1);
}
const bytes = readFileSync(file);
const sig = sign(null, bytes, priv);
if (!verify(null, bytes, pubObj, sig)) { console.error("self-check failed: signature does not verify"); process.exit(1); }
writeFileSync(`${file}.sig`, sig.toString("base64") + "\n");
console.log(`signed ${file} -> ${file}.sig (key ${pub})`);
