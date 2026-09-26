// Signed self-update. A release publishes manifest.json (version + sha256 of every platform binary) and
// manifest.json.sig (Ed25519 over the exact manifest bytes, key pinned in release-key.ts). Nothing is trusted until
// the signature verifies; a downloaded binary is installed only if its sha256 matches the signed manifest.
import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, existsSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { verifyData } from "./crypto.ts";
import { RELEASE_KEY_PLACEHOLDER, RELEASE_PUBLIC_KEY } from "./release-key.ts";
import { installKind, version, type InstallKind } from "./version.ts";

export const DEFAULT_UPDATE_BASE = "https://github.com/kryptobaseddev/agentmbx/releases/latest/download";
export const SERVICE_LABEL = "com.agentmbx.daemon";
export const updateBase = () => (process.env.MBX_UPDATE_URL || DEFAULT_UPDATE_BASE).replace(/\/+$/, "");

export interface Asset { file: string; sha256: string; size: number }
export interface Manifest { name: "agentmbx"; version: string; released_at: string; assets: Record<string, Asset> }
export class UpdateError extends Error { override name = "UpdateError"; }

// ---- semver -----------------------------------------------------------------------------------
const SEMVER = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;
export function parseSemver(v: string) {
  const m = SEMVER.exec(v.trim());
  if (!m) throw new UpdateError(`not a semantic version: ${JSON.stringify(v)}`);
  return { core: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] ? m[4].split(".") : [] };
}
/** -1 / 0 / 1. Pre-releases sort below their release (1.0.0-rc.1 < 1.0.0); build metadata is ignored. */
export function compareSemver(a: string, b: string): number {
  const x = parseSemver(a), y = parseSemver(b);
  for (let i = 0; i < 3; i++) if (x.core[i] !== y.core[i]) return x.core[i] < y.core[i] ? -1 : 1;
  if (!x.pre.length || !y.pre.length) return x.pre.length === y.pre.length ? 0 : x.pre.length ? -1 : 1;
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    const p = x.pre[i], q = y.pre[i];
    if (p === undefined) return -1;
    if (q === undefined) return 1;
    if (p === q) continue;
    const pn = /^\d+$/.test(p), qn = /^\d+$/.test(q);
    if (pn && qn) return Number(p) < Number(q) ? -1 : 1;
    if (pn !== qn) return pn ? -1 : 1;
    return p < q ? -1 : 1;
  }
  return 0;
}

// ---- manifest ---------------------------------------------------------------------------------
async function get(url: string, timeoutMs = 20_000): Promise<Buffer> {
  let res: Response;
  try { res = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(timeoutMs), headers: { "user-agent": `agentmbx/${version()}` } }); }
  catch (e) { throw new UpdateError(`cannot fetch ${url}: ${(e as Error).message}`); }
  if (!res.ok) throw new UpdateError(`cannot fetch ${url}: HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

export const isPlaceholderKey = (k: string | undefined) => !k || k === RELEASE_KEY_PLACEHOLDER || k.startsWith("PLACEHOLDER");

/** Verify the signature over the exact manifest bytes, then parse and validate. Throws UpdateError on anything off. */
export function verifyManifest(bytes: Uint8Array, signature: string, publicKey: string = RELEASE_PUBLIC_KEY): Manifest {
  if (isPlaceholderKey(publicKey)) throw new UpdateError("this build has no release signing key pinned (src/release-key.ts still holds the placeholder), "
    + "so release manifests cannot be verified; refusing to update. Reinstall from https://agentmbx.com/install.sh or update manually.");
  if (Buffer.from(publicKey, "base64").length !== 32) throw new UpdateError("pinned release key is not a 32-byte Ed25519 key; refusing to update");
  if (!verifyData(publicKey, bytes, signature.trim())) throw new UpdateError("release manifest signature is INVALID (tampered manifest or wrong signing key); refusing to update");
  let m: Manifest;
  try { m = JSON.parse(Buffer.from(bytes).toString("utf8")) as Manifest; } catch { throw new UpdateError("release manifest is not valid JSON"); }
  if (m?.name !== "agentmbx") throw new UpdateError("release manifest is not for agentmbx");
  parseSemver(String(m.version));
  if (!m.assets || typeof m.assets !== "object") throw new UpdateError("release manifest has no assets");
  for (const [k, a] of Object.entries(m.assets)) {
    if (!a || typeof a.file !== "string" || !/^[A-Za-z0-9._-]+$/.test(a.file) || !/^[0-9a-f]{64}$/i.test(a.sha256) || !Number.isInteger(a.size))
      throw new UpdateError(`release manifest asset ${k} is malformed`);
  }
  return m;
}

export async function fetchManifest(opts: { base?: string; publicKey?: string } = {}): Promise<Manifest> {
  const base = (opts.base ?? updateBase()).replace(/\/+$/, "");
  if (isPlaceholderKey(opts.publicKey ?? RELEASE_PUBLIC_KEY)) verifyManifest(Buffer.alloc(0), "", opts.publicKey); // fail closed before any network I/O
  const [bytes, sig] = await Promise.all([get(`${base}/manifest.json`), get(`${base}/manifest.json.sig`)]);
  return verifyManifest(bytes, sig.toString("utf8"), opts.publicKey);
}

export const platformKey = (platform: string = process.platform, arch: string = process.arch) => `${platform}-${arch}`;

export interface UpdateCheck { current: string; latest: string; newer: boolean; manifest: Manifest; asset: Asset | null }
export async function checkForUpdate(opts: { base?: string; publicKey?: string; current?: string } = {}): Promise<UpdateCheck> {
  const manifest = await fetchManifest(opts);
  const current = opts.current ?? version();
  return { current, latest: manifest.version, newer: compareSemver(manifest.version, current) > 0, manifest, asset: manifest.assets[platformKey()] ?? null };
}

// ---- download + install -----------------------------------------------------------------------
/** Download an asset into destDir (same filesystem as the target, so the final rename is atomic) and verify it
 *  against the signed manifest. Returns the temp path; nothing is left behind on failure. */
export async function downloadAsset(asset: Asset, destDir: string, base: string = updateBase()): Promise<string> {
  if (!/^[A-Za-z0-9._-]+$/.test(asset.file)) throw new UpdateError(`refusing asset name ${JSON.stringify(asset.file)}`);
  const data = await get(`${base.replace(/\/+$/, "")}/${asset.file}`, 600_000);
  const sum = createHash("sha256").update(data).digest("hex");
  if (sum !== asset.sha256.toLowerCase())
    throw new UpdateError(`checksum mismatch for ${asset.file}: expected ${asset.sha256}, got ${sum}; refusing to install`);
  if (data.length !== asset.size) throw new UpdateError(`size mismatch for ${asset.file}: expected ${asset.size}, got ${data.length}; refusing to install`);
  const tmp = join(destDir, `.agentmbx-update-${randomBytes(6).toString("hex")}`);
  try { writeFileSync(tmp, data, { mode: 0o755 }); chmodSync(tmp, 0o755); }
  catch (e) { try { unlinkSync(tmp); } catch { /* */ } throw new UpdateError(`cannot write ${tmp}: ${(e as Error).message}`); }
  return tmp;
}

/** Atomically replace the running executable (the running process keeps its old inode). */
export function replaceExecutable(tmp: string, target: string) {
  try { renameSync(tmp, target); }
  catch (e) { try { unlinkSync(tmp); } catch { /* */ } throw new UpdateError(`cannot replace ${target}: ${(e as Error).message}`); }
}

/** Restart the installed daemon service so it runs the new binary. Only touches a service whose definition runs
 *  `target` (a daemon installed from another copy or from npm is left alone). Returns what was done, or null. */
export function restartDaemon(target: string): string | null {
  const def = process.platform === "darwin" ? join(homedir(), "Library/LaunchAgents", `${SERVICE_LABEL}.plist`) : join(homedir(), ".config/systemd/user/agentmbx.service");
  try {
    if (!existsSync(def) || !readFileSync(def, "utf8").includes(target)) return null;
    if (process.platform === "darwin") {
      execFileSync("launchctl", ["kickstart", "-k", `gui/${process.getuid!()}/${SERVICE_LABEL}`], { stdio: "ignore" });
      return "restarted the launchd daemon";
    }
    execFileSync("systemctl", ["--user", "restart", "agentmbx"], { stdio: "ignore" });
    return "restarted the systemd user daemon";
  } catch (e) { return `could not restart the daemon (${(e as Error).message.split("\n")[0]}); restart it yourself`; }
}

export function manualUpdateCommand(kind: InstallKind = installKind()): string {
  if (kind === "npm") return "npm i -g agentmbx@latest";
  if (kind === "dev") return `git -C ${fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/, "")} pull`;
  return "agentmbx update";
}

// ---- kv-backed state (daemon check, status line) ------------------------------------------------
interface KV { get(k: string): string | undefined; set(k: string, v: string): void }
const DAY = 24 * 3600_000;

/** Daemon helper: at most one check per 24 h, one notification per new version. Never throws. */
export async function periodicUpdateCheck(kv: KV, notify: (title: string, text: string) => Promise<unknown>, opts: { base?: string; publicKey?: string; now?: number } = {}) {
  if (process.env.MBX_NO_UPDATE_CHECK) return;
  const now = opts.now ?? Date.now();
  const last = Date.parse(kv.get("update.checked_at") ?? "");
  if (Number.isFinite(last) && now - last < DAY) return;
  kv.set("update.checked_at", new Date(now).toISOString());
  try {
    const c = await checkForUpdate(opts);
    kv.set("update.latest", c.latest);
    if (c.newer && kv.get("update.notified") !== c.latest) {
      kv.set("update.notified", c.latest);
      await notify("AgentMBX update available", `agentmbx ${c.latest} is available (you have ${c.current}). Run: ${manualUpdateCommand()}`);
    }
  } catch (e) { process.stderr.write(`[agentmbx] update check: ${(e as Error).message}\n`); }
}

/** "x.y.z" when the last daemon check saw a newer release than this build, else null. */
export function updateAvailable(kv: KV): string | null {
  const latest = kv.get("update.latest");
  try { return latest && compareSemver(latest, version()) > 0 ? latest : null; } catch { return null; }
}

// ---- CLI --------------------------------------------------------------------------------------
async function confirm(q: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try { return /^y(es)?$/i.test((await rl.question(q)).trim()); } finally { rl.close(); }
}

/** `agentmbx update [--check] [--yes]` and `agentmbx version --check`. Returns the process exit code. */
export async function updateCommand(opts: { check?: boolean; yes?: boolean }): Promise<number> {
  const kind = installKind();
  let c: UpdateCheck;
  try { c = await checkForUpdate(); }
  catch (e) {
    process.stderr.write(`agentmbx: update check failed: ${(e as Error).message}\n`);
    if (kind !== "sea") process.stderr.write(`This ${kind} install updates with: ${manualUpdateCommand(kind)}\n`);
    return 1;
  }
  if (!c.newer) { console.log(`agentmbx ${c.current} is up to date (latest release ${c.latest})`); return 0; }
  console.log(`update available: ${c.latest} (installed ${c.current}, ${kind})`);
  if (opts.check) { console.log(`run: ${manualUpdateCommand(kind)}`); return 0; }
  if (kind !== "sea") { console.log(`This ${kind === "npm" ? "npm" : "source checkout"} install updates with:\n  ${manualUpdateCommand(kind)}`); return 0; }
  if (!c.asset) { process.stderr.write(`agentmbx: release ${c.latest} has no binary for ${platformKey()}\n`); return 1; }
  const target = realpathSync(process.execPath);
  if (!opts.yes) {
    if (!process.stdin.isTTY) { process.stderr.write("agentmbx: not a terminal; pass --yes to install the update\n"); return 1; }
    if (!(await confirm(`Replace ${target} with agentmbx ${c.latest}? [y/N] `))) { console.log("cancelled"); return 1; }
  }
  try {
    const tmp = await downloadAsset(c.asset, dirname(target));
    replaceExecutable(tmp, target);
  } catch (e) { process.stderr.write(`agentmbx: ${(e as Error).message}\n`); return 1; }
  console.log(`installed agentmbx ${c.latest} at ${target} (sha256 verified against the signed manifest)`);
  const r = restartDaemon(target);
  if (r) console.log(r);
  return 0;
}
