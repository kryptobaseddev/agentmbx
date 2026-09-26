#!/usr/bin/env node
// Write SHA256SUMS and manifest.json for a release directory holding the agentmbx-<platform>-<arch> binaries.
//   node scripts/make-manifest.mjs <dir> <version>
// manifest.json = { name, version, released_at, assets: { "darwin-arm64": { file, sha256, size }, ... } }
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const [dir, rawVersion] = process.argv.slice(2);
if (!dir || !rawVersion) { console.error("usage: make-manifest.mjs <dir> <version>"); process.exit(2); }
const version = rawVersion.replace(/^v/, "");
if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version)) { console.error(`bad version ${rawVersion}`); process.exit(2); }

const files = readdirSync(dir).filter((f) => /^agentmbx-(darwin|linux)-(arm64|x64)$/.test(f)).sort();
if (!files.length) { console.error(`no agentmbx-<platform>-<arch> binaries in ${dir}`); process.exit(1); }
const assets = {}; const sums = [];
for (const file of files) {
  const data = readFileSync(join(dir, file));
  const sha256 = createHash("sha256").update(data).digest("hex");
  assets[file.replace(/^agentmbx-/, "")] = { file, sha256, size: statSync(join(dir, file)).size };
  sums.push(`${sha256}  ${file}`);
}
// optional: the macOS notifier app (universal), installed into ~/Applications by install.sh on macOS
const app = "AgentMBX-macos.zip";
try {
  const data = readFileSync(join(dir, app));
  const sha256 = createHash("sha256").update(data).digest("hex");
  assets["macos-app"] = { file: app, sha256, size: data.length };
  sums.push(`${sha256}  ${app}`);
} catch { /* not built for this release */ }
writeFileSync(join(dir, "SHA256SUMS"), sums.join("\n") + "\n");
const manifest = { name: "agentmbx", version, released_at: new Date().toISOString(), assets };
writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
console.log(`manifest.json for agentmbx ${version}: ${Object.keys(assets).join(", ")}`);
