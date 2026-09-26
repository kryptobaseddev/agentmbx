// Signed self-update: manifest signature, fail-closed placeholder key, semver, and the checksum-verified download.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import { existsSync, mkdtempSync, readdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { generateKeyPair, signData } from "../src/crypto.ts";
import { RELEASE_KEY_PLACEHOLDER, RELEASE_PUBLIC_KEY } from "../src/release-key.ts";
import { checkForUpdate, compareSemver, downloadAsset, fetchManifest, periodicUpdateCheck, platformKey, updateAvailable, UpdateError, verifyManifest, type Manifest } from "../src/update.ts";
import { version } from "../src/version.ts";

const key = generateKeyPair();
const other = generateKeyPair();
const asset = Buffer.from("#!/bin/sh\necho fake agentmbx 9.9.9\n");
const sha = createHash("sha256").update(asset).digest("hex");
const manifest: Manifest = { name: "agentmbx", version: "9.9.9", released_at: "2026-09-26T00:00:00Z",
  assets: { [platformKey()]: { file: `agentmbx-${platformKey()}`, sha256: sha, size: asset.length } } };
const files = new Map<string, Buffer>();
let server: Server; let base = "";
const publish = (m: string, sig: string) => { files.set("/manifest.json", Buffer.from(m)); files.set("/manifest.json.sig", Buffer.from(sig)); };

before(async () => {
  server = createServer((req, res) => { const f = files.get(req.url ?? ""); if (!f) { res.statusCode = 404; return res.end(); } res.end(f); });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  files.set(`/${manifest.assets[platformKey()].file}`, asset);
});
after(() => server.close());

test("a correctly signed manifest is accepted and a newer version is reported", async () => {
  const m = JSON.stringify(manifest, null, 2) + "\n";
  publish(m, signData(key.privateKey, m) + "\n");
  const got = await fetchManifest({ base, publicKey: key.publicKey });
  assert.equal(got.version, "9.9.9");
  const c = await checkForUpdate({ base, publicKey: key.publicKey, current: "0.1.0" });
  assert.equal(c.newer, true); assert.equal(c.latest, "9.9.9"); assert.equal(c.asset?.sha256, sha);
  assert.equal((await checkForUpdate({ base, publicKey: key.publicKey, current: "9.9.9" })).newer, false);
});

test("a tampered manifest or a signature from another key is rejected", async () => {
  const m = JSON.stringify(manifest);
  const sig = signData(key.privateKey, m);
  publish(m.replace(sha, "0".repeat(64)), sig);
  await assert.rejects(fetchManifest({ base, publicKey: key.publicKey }), /signature is INVALID/);
  publish(m, signData(other.privateKey, m));
  await assert.rejects(fetchManifest({ base, publicKey: key.publicKey }), /signature is INVALID/);
  publish(m, "not a signature");
  await assert.rejects(fetchManifest({ base, publicKey: key.publicKey }), UpdateError);
  const wrongName = JSON.stringify({ ...manifest, name: "evil" });
  assert.throws(() => verifyManifest(Buffer.from(wrongName), signData(key.privateKey, wrongName), key.publicKey), /not for agentmbx/);
  const traversal = JSON.stringify({ ...manifest, assets: { x: { file: "../../etc/passwd", sha256: sha, size: 1 } } });
  assert.throws(() => verifyManifest(Buffer.from(traversal), signData(key.privateKey, traversal), key.publicKey), /malformed/);
});

test("the placeholder release key fails closed, before any network request", async () => {
  assert.equal(RELEASE_PUBLIC_KEY, RELEASE_KEY_PLACEHOLDER, "source tree ships the placeholder until a release key is pinned");
  const m = JSON.stringify(manifest);
  assert.throws(() => verifyManifest(Buffer.from(m), signData(key.privateKey, m)), /no release signing key pinned/);
  await assert.rejects(fetchManifest({ base: "http://127.0.0.1:9" }), /no release signing key pinned/);
  await assert.rejects(fetchManifest({ base, publicKey: RELEASE_KEY_PLACEHOLDER }), /no release signing key pinned/);
});

test("semver comparison", () => {
  assert.equal(compareSemver("1.2.3", "1.2.3"), 0);
  assert.equal(compareSemver("v1.2.4", "1.2.3"), 1);
  assert.equal(compareSemver("1.10.0", "1.9.9"), 1);
  assert.equal(compareSemver("2.0.0", "10.0.0"), -1);
  assert.equal(compareSemver("1.0.0-rc.1", "1.0.0"), -1);
  assert.equal(compareSemver("1.0.0-rc.2", "1.0.0-rc.10"), -1);
  assert.equal(compareSemver("1.0.0-alpha", "1.0.0-alpha.1"), -1);
  assert.equal(compareSemver("1.0.0-beta", "1.0.0-alpha"), 1);
  assert.equal(compareSemver("1.0.0+build.5", "1.0.0"), 0);
  assert.throws(() => compareSemver("latest", "1.0.0"), UpdateError);
});

test("download verifies sha256 and size, and leaves nothing behind on mismatch", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mbx-upd-"));
  const a = manifest.assets[platformKey()];
  const tmp = await downloadAsset(a, dir, base);
  assert.deepEqual(readFileSync(tmp), asset);
  assert.equal(statSync(tmp).mode & 0o777, 0o755);
  const bad = mkdtempSync(join(tmpdir(), "mbx-upd-"));
  await assert.rejects(downloadAsset({ ...a, sha256: "a".repeat(64) }, bad, base), /checksum mismatch/);
  await assert.rejects(downloadAsset({ ...a, size: a.size + 1 }, bad, base), /size mismatch/);
  await assert.rejects(downloadAsset({ ...a, file: "../x" }, bad, base), /refusing asset name/);
  assert.deepEqual(readdirSync(bad), []);
  assert.ok(existsSync(tmp));
});

test("daemon check runs once per 24 h, notifies once per version, and feeds the status line", async () => {
  const m = JSON.stringify(manifest);
  publish(m, signData(key.privateKey, m));
  const kv = new Map<string, string>();
  const store = { get: (k: string) => kv.get(k), set: (k: string, v: string) => void kv.set(k, v) };
  const notes: string[] = [];
  const notify = async (_t: string, text: string) => { notes.push(text); };
  const t0 = Date.parse("2026-09-26T00:00:00Z");
  await periodicUpdateCheck(store, notify, { base, publicKey: key.publicKey, now: t0 });
  assert.equal(kv.get("update.latest"), "9.9.9"); assert.equal(notes.length, 1); assert.match(notes[0], /9\.9\.9/);
  kv.delete("update.latest");
  await periodicUpdateCheck(store, notify, { base, publicKey: key.publicKey, now: t0 + 3600_000 });
  assert.equal(kv.get("update.latest"), undefined, "skipped within 24 h");
  await periodicUpdateCheck(store, notify, { base, publicKey: key.publicKey, now: t0 + 25 * 3600_000 });
  assert.equal(kv.get("update.latest"), "9.9.9"); assert.equal(notes.length, 1, "same version is not announced twice");
  assert.equal(updateAvailable(store), "9.9.9");
  kv.set("update.latest", version());
  assert.equal(updateAvailable(store), null);
});
