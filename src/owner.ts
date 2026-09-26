// The owner key: Ed25519. Two backends:
// - "keychain" (macOS with AgentMBX.app): the private key lives in the login Keychain, readable only by
//   AgentMBX.app/Contents/MacOS/agentmbx-auth, which signs after a Touch ID / password prompt whose text it derives from
//   the bytes it signs. owner.json records the backend and the public key.
// - "file": owner.key, encrypted at rest with a passphrase (scrypt + AES-256-GCM). Unlocking needs the passphrase typed
//   on a real terminal (/dev/tty), which agent tool calls do not have.
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { closeSync, existsSync, mkdtempSync, openSync, readFileSync, readSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fingerprint, generateKeyPair, signData, verifyData, type KeyPair } from "./crypto.ts";
import { installedAppPath } from "./service.ts";

const SCRYPT = { N: 1 << 17, r: 8, p: 1, maxmem: 256 * 1024 * 1024 };

export type OwnerBackend = "keychain" | "file";
interface OwnerFile { v: 1; backend?: "file"; public_key: string; kdf: "scrypt"; salt: string; iv: string; tag: string; ciphertext: string }
interface KeychainOwnerFile { v: 1; backend: "keychain"; public_key: string; created_at: string }

/** File backend: the encrypted key. */
export const ownerPath = (home: string) => join(home, "owner.key");
/** Keychain backend: the backend and the public key only (the private key never leaves the Keychain helper). */
export const ownerJsonPath = (home: string) => join(home, "owner.json");

export function ownerInfo(home: string): { backend: OwnerBackend; public_key: string; path: string } | null {
  if (existsSync(ownerPath(home))) return { backend: "file", public_key: (JSON.parse(readFileSync(ownerPath(home), "utf8")) as OwnerFile).public_key, path: ownerPath(home) };
  if (existsSync(ownerJsonPath(home))) {
    const f = JSON.parse(readFileSync(ownerJsonPath(home), "utf8")) as KeychainOwnerFile;
    if (f.backend !== "keychain") throw new Error(`${ownerJsonPath(home)}: unknown owner backend "${String(f.backend)}"`);
    return { backend: "keychain", public_key: f.public_key, path: ownerJsonPath(home) };
  }
  return null;
}

export function ownerPublicKey(home: string): string | null { return ownerInfo(home)?.public_key ?? null; }

// ---- keychain backend (macOS helper) ----------------------------------------------------------------------------
export const AUTH_HELPER = "agentmbx-auth";

/** The Keychain helper inside the installed AgentMBX.app (MBX_AUTH_HELPER overrides it, e.g. for tests), or null. */
export function authHelperPath(env: NodeJS.ProcessEnv = process.env, home = homedir(), platform: string = process.platform): string | null {
  if (env.MBX_AUTH_HELPER) return existsSync(env.MBX_AUTH_HELPER) ? env.MBX_AUTH_HELPER : null;
  if (platform !== "darwin") return null;
  return [join(installedAppPath(home), "Contents/MacOS", AUTH_HELPER), join("/Applications/AgentMBX.app/Contents/MacOS", AUTH_HELPER)]
    .find((p) => existsSync(p)) ?? null;
}

/** Keychain when the helper is available (macOS with AgentMBX.app, or MBX_AUTH_HELPER), otherwise the passphrase file. */
export const defaultOwnerBackend = (env: NodeJS.ProcessEnv = process.env, home = homedir(), platform: string = process.platform): OwnerBackend =>
  authHelperPath(env, home, platform) ? "keychain" : "file";

// helper exit codes (macos/Auth/main.swift)
const HELPER_EXIT: Record<number, string> = {
  2: "bad arguments", 3: "no owner key in the Keychain", 4: "an owner key already exists in the Keychain", 5: "the helper refused to sign this payload",
  6: "not approved (the Touch ID / password prompt was cancelled or failed, or Keychain access was denied)", 7: "Keychain error",
  8: "the Keychain holds a different owner key than this payload names",
  9: "no Touch ID / password prompt can be shown in this session (SSH or no GUI); run it at the Mac, or use: agentmbx owner init --backend file",
  124: "timed out waiting for the Touch ID / password prompt to be approved",
};
export const HELPER_NO_GUI = 9;

export interface HelperResult { code: number; stdout: string; stderr: string }

/** Run the Keychain helper. It may wait for the human at a Touch ID / password prompt, hence the long timeout.
 *  Never throws for a helper failure: a cancel, a Keychain denial or a timeout comes back as a nonzero `code`. */
export function runAuthHelper(helper: string, args: string[], timeoutMs = 5 * 60_000): Promise<HelperResult> {
  return new Promise((resolve) => {
    let p: ReturnType<typeof spawn>;
    try { p = spawn(helper, args, { stdio: ["ignore", "pipe", "pipe"] }); }
    catch (e) { resolve({ code: 127, stdout: "", stderr: `cannot run ${helper}: ${(e as Error).message}` }); return; }
    let stdout = "", stderr = "", timedOut = false, done = false;
    const finish = (r: HelperResult) => { if (!done) { done = true; clearTimeout(t); resolve(r); } };
    p.stdout!.on("data", (d: Buffer) => { stdout += d.toString("utf8"); });
    p.stderr!.on("data", (d: Buffer) => { stderr += d.toString("utf8"); });
    const t = setTimeout(() => { timedOut = true; p.kill("SIGTERM"); }, timeoutMs);
    p.on("error", (e) => finish({ code: 127, stdout, stderr: `cannot run ${helper}: ${e.message}` }));
    p.on("close", (code, signal) => finish(timedOut ? { code: 124, stdout, stderr: "" } : { code: code ?? (signal ? 128 : 1), stdout, stderr }));
  });
}

/** A helper failure as an Error with `helperExit` set (e.g. HELPER_NO_GUI), so callers can suggest the file backend. */
export const helperError = (what: string, r: HelperResult) =>
  Object.assign(new Error(`${what}: ${r.stderr.trim().replace(/^agentmbx-auth: /, "") || HELPER_EXIT[r.code] || `exit ${r.code}`}`), { helperExit: r.code });

const isRawKey = (b64: string) => /^[A-Za-z0-9+/]{43}=$/.test(b64) && Buffer.from(b64, "base64").length === 32;

/**
 * Create (or adopt) the owner key in the macOS Keychain through the helper, and record it in owner.json. When the Keychain
 * already holds an AgentMBX owner key (e.g. a second MBX_HOME on this Mac), it is adopted without a prompt; otherwise the
 * helper shows a Touch ID / password prompt and creates it.
 */
export async function createKeychainOwner(home: string, helper = authHelperPath(), initTimeoutMs = 5 * 60_000): Promise<{ publicKey: string; adopted: boolean }> {
  if (ownerInfo(home)) throw new Error("an owner key already exists on this host");
  if (!helper) throw new Error("the AgentMBX Keychain helper (AgentMBX.app/Contents/MacOS/agentmbx-auth) was not found");
  let adopted = true;
  let r = await runAuthHelper(helper, ["pubkey"], 30_000);
  if (r.code === 3) { adopted = false; r = await runAuthHelper(helper, ["init"], initTimeoutMs); }
  if (r.code !== 0) throw helperError(adopted ? "reading the Keychain owner key failed" : "creating the owner key failed", r);
  const pub = r.stdout.trim();
  if (!isRawKey(pub)) throw new Error(`the Keychain helper returned a malformed public key: ${JSON.stringify(pub.slice(0, 80))}`);
  const f: KeychainOwnerFile = { v: 1, backend: "keychain", public_key: pub, created_at: new Date().toISOString() };
  writeFileSync(ownerJsonPath(home), JSON.stringify(f, null, 1) + "\n", { mode: 0o600, flag: "wx" });
  return { publicKey: pub, adopted };
}

/** Can the helper show a Touch ID / password prompt in this session? False over SSH or without a GUI login. No prompt. */
export async function canPrompt(helper: string): Promise<{ ok: boolean; reason: string }> {
  const r = await runAuthHelper(helper, ["check"], 10_000);
  return r.code === 0 ? { ok: true, reason: "" } : { ok: false, reason: helperError("no prompt possible", r).message.replace(/^no prompt possible: /, "") };
}

/** Doctor check for the keychain backend: is the helper there, and does its key match owner.json? (No prompt.) */
export async function keychainOwnerStatus(home: string, helper = authHelperPath()): Promise<{ ok: boolean; detail: string }> {
  const info = ownerInfo(home);
  if (info?.backend !== "keychain") return { ok: false, detail: "not a keychain owner" };
  if (!helper) return { ok: false, detail: "the Keychain helper (AgentMBX.app/Contents/MacOS/agentmbx-auth) is missing" };
  const r = await runAuthHelper(helper, ["pubkey"], 10_000);
  if (r.code !== 0) return { ok: false, detail: helperError("the Keychain helper", r).message };
  const got = r.stdout.trim();
  if (got !== info.public_key) return { ok: false, detail: `the Keychain holds owner key ${isRawKey(got) ? fingerprint(got) : "?"}, not ${fingerprint(info.public_key)}` };
  return { ok: true, detail: helper };
}

async function keychainSign(home: string, pub: string, canonicalJson: string, summary: string): Promise<string> {
  const helper = authHelperPath();
  if (!helper) throw new Error("the owner key is in the macOS Keychain, but AgentMBX.app's agentmbx-auth helper was not found (reinstall the app: agentmbx daemon install)");
  const dir = mkdtempSync(join(tmpdir(), "agentmbx-sign-"));
  try {
    const file = join(dir, "payload.json");
    writeFileSync(file, canonicalJson, { mode: 0o600 });
    process.stderr.write(`${summary}\nApprove the Touch ID / password prompt to sign this (the prompt describes the same request).\n`);
    const r = await runAuthHelper(helper, ["sign", file]);
    if (r.code !== 0) throw helperError("owner signature not made", r);
    const sig = r.stdout.trim();
    if (!verifyData(pub, canonicalJson, sig))
      throw new Error(`the Keychain helper's signature does not verify against owner key ${fingerprint(pub)} (${ownerJsonPath(home)}); run: agentmbx doctor`);
    return sig;
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

// ---- file backend -----------------------------------------------------------------------------------------------
export function createOwnerKey(home: string, passphrase: string): string {
  if (ownerInfo(home)) throw new Error("owner key already exists");
  if (passphrase.length < 12) throw new Error("use a passphrase of at least 12 characters");
  const kp = generateKeyPair();
  const salt = randomBytes(16), iv = randomBytes(12);
  const key = scryptSync(passphrase, salt, 32, SCRYPT);
  const c = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([c.update(kp.privateKey, "utf8"), c.final()]);
  const f: OwnerFile = { v: 1, backend: "file", public_key: kp.publicKey, kdf: "scrypt", salt: salt.toString("base64"), iv: iv.toString("base64"),
    tag: c.getAuthTag().toString("base64"), ciphertext: ct.toString("base64") };
  writeFileSync(ownerPath(home), JSON.stringify(f, null, 1) + "\n", { mode: 0o600, flag: "wx" });
  return kp.publicKey;
}

export function unlockOwnerKey(home: string, passphrase: string): KeyPair {
  const f = JSON.parse(readFileSync(ownerPath(home), "utf8")) as OwnerFile;
  const key = scryptSync(passphrase, Buffer.from(f.salt, "base64"), 32, SCRYPT);
  const d = createDecipheriv("aes-256-gcm", key, Buffer.from(f.iv, "base64"));
  d.setAuthTag(Buffer.from(f.tag, "base64"));
  try {
    const priv = Buffer.concat([d.update(Buffer.from(f.ciphertext, "base64")), d.final()]).toString("utf8");
    return { publicKey: f.public_key, privateKey: priv };
  } catch { throw new Error("wrong passphrase"); }
}

/** Read a passphrase from the controlling terminal with echo off. Throws when there is no terminal
 *  (e.g. an agent's Bash tool), which is the point: only a human at a keyboard can unlock the owner key. */
export function readPassphraseFromTTY(prompt: string): string {
  let fd: number;
  try { fd = openSync("/dev/tty", "r+"); } catch {
    throw new Error("owner commands need an interactive terminal (no /dev/tty). Run this yourself in Terminal, not through an agent.");
  }
  try {
    writeFileSync(fd, prompt);
    spawnSync("stty", ["-echo"], { stdio: [fd, "ignore", "ignore"] });
    const buf = Buffer.alloc(1024); let s = "";
    for (;;) {
      const n = readSync(fd, buf, 0, buf.length, null);
      if (n <= 0) break;
      s += buf.subarray(0, n).toString("utf8");
      if (s.includes("\n")) break;
    }
    return s.split("\n")[0].replace(/\r$/, "");
  } finally {
    spawnSync("stty", ["echo"], { stdio: [fd, "ignore", "ignore"] });
    writeFileSync(fd, "\n");
    closeSync(fd);
  }
}

export const ownerFingerprint = (home: string) => { const p = ownerPublicKey(home); return p ? fingerprint(p) : null; };

/**
 * The one way to get an owner signature: sign `canonicalJson` (the exact bytes receivers verify) after the human
 * approves. The file backend asks for the passphrase on /dev/tty; the macOS keychain backend shows a Touch ID / password
 * prompt whose text the helper derives from `canonicalJson` itself. `summary` is shown on the terminal so the human
 * knows what they are signing.
 */
export async function ownerSignCanonical(home: string, canonicalJson: string, summary: string): Promise<{ sig: string; pub: string; fp: string }> {
  const info = ownerInfo(home);
  if (!info) throw new Error("no owner key on this machine: run 'agentmbx owner init'");
  const pub = info.public_key;
  if (info.backend === "keychain") return { sig: await keychainSign(home, pub, canonicalJson, summary), pub, fp: fingerprint(pub) };
  const kp = unlockOwnerKey(home, readPassphraseFromTTY(`${summary}\nOwner passphrase: `));
  return { sig: signData(kp.privateKey, canonicalJson), pub, fp: fingerprint(pub) };
}
