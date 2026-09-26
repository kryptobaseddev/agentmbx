#!/usr/bin/env node
// Build a single-executable AgentMBX (Node SEA) for the current platform: build/agentmbx-<darwin|linux>-<arm64|x64>.
//   1. esbuild bundles src/cli.ts (+ MCP SDK, zod) into one CJS file with the version baked in
//   2. node --experimental-sea-config turns it into a preparation blob
//   3. a copy of this node binary gets the blob injected with postject (and is re-signed on macOS)
// Env: AGENTMBX_NODE_BINARY (node to embed, default process.execPath), AGENTMBX_CODESIGN_IDENTITY (macOS Developer ID;
//      default ad-hoc), AGENTMBX_RELEASE_PUBKEY (override the pinned release key; tests only), AGENTMBX_VERSION (override).
import { execFileSync } from "node:child_process";
import { copyFileSync, chmodSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { inject } from "postject";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "build");
const work = join(out, "sea-work");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const version = process.env.AGENTMBX_VERSION || pkg.version;
const plat = process.platform, arch = process.arch;
if (!["darwin", "linux"].includes(plat) || !["arm64", "x64"].includes(arch)) throw new Error(`unsupported platform ${plat}-${arch}`);
const target = join(out, `agentmbx-${plat}-${arch}`);
const run = (cmd, args) => execFileSync(cmd, args, { stdio: "inherit" });

rmSync(work, { recursive: true, force: true });
mkdirSync(work, { recursive: true });

// 1. bundle. The entry mirrors bin/agentmbx.js: hide ExperimentalWarning (node:sqlite), then run main().
const bundle = join(work, "agentmbx.cjs");
await build({
  stdin: {
    contents: `process.removeAllListeners("warning");
process.on("warning", (w) => { if (w.name !== "ExperimentalWarning") console.warn(w); });
const { main } = require("./src/cli.ts");
main().catch((e) => { process.stderr.write("agentmbx: " + (e && e.stack || e) + "\\n"); process.exit(1); });`,
    resolveDir: root, sourcefile: "sea-entry.cjs", loader: "js",
  },
  bundle: true, platform: "node", target: "node24", format: "cjs", outfile: bundle, minify: false, legalComments: "inline",
  // give import.meta.url a real value inside the CJS bundle (path lookups near the binary then fail softly, never crash)
  banner: { js: 'const __agentmbx_import_meta_url = require("node:url").pathToFileURL(process.execPath).href;' },
  define: {
    "import.meta.url": "__agentmbx_import_meta_url",
    __AGENTMBX_VERSION__: JSON.stringify(version),
    __AGENTMBX_RELEASE_KEY__: JSON.stringify(process.env.AGENTMBX_RELEASE_PUBKEY || ""),
  },
  // import.meta.url is only used on the unbundled fallback paths, which the defines above short-circuit
  logOverride: { "empty-import-meta": "silent" },
  logLevel: "warning",
});

// 2. SEA preparation blob
const blob = join(work, "sea-prep.blob");
const seaConfig = join(work, "sea-config.json");
writeFileSync(seaConfig, JSON.stringify({ main: bundle, output: blob, disableExperimentalSEAWarning: true, useSnapshot: false, useCodeCache: false,
  assets: { "SKILL.md": join(root, "skill", "SKILL.md") } }, null, 2));
run(process.execPath, ["--experimental-sea-config", seaConfig]);

// 3. copy node, inject, sign
const nodeBin = process.env.AGENTMBX_NODE_BINARY || process.execPath;
rmSync(target, { force: true });
copyFileSync(nodeBin, target);
chmodSync(target, 0o755);
if (plat === "darwin") run("codesign", ["--remove-signature", target]);
await inject(target, "NODE_SEA_BLOB", readFileSync(blob), {
  sentinelFuse: "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2",
  ...(plat === "darwin" ? { machoSegmentName: "NODE_SEA" } : {}),
});
if (plat === "darwin") {
  const id = process.env.AGENTMBX_CODESIGN_IDENTITY;
  run("codesign", id ? ["--sign", id, "--options", "runtime", "--timestamp", "--force", target] : ["--sign", "-", "--force", target]);
}
rmSync(work, { recursive: true, force: true });
console.log(`built ${target} (agentmbx ${version}, ${(statSync(target).size / 1048576).toFixed(1)} MB)`);
