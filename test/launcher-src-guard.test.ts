// T443: the launcher prefers ../src/cli.ts under AGENTMBX_DEV only when ../src actually exists —
// an installed tree with the dev flag set must run dist instead of crashing with ERR_MODULE_NOT_FOUND.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const fixture = (t: { after: (fn: () => void | Promise<void>) => void }, withSrc: boolean) => {
  const root = mkdtempSync(join(tmpdir(), "mbx-launcher-"));
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  mkdirSync(join(root, "bin"));
  mkdirSync(join(root, "dist"));
  cpSync(resolve("bin/agentmbx.js"), join(root, "bin/agentmbx.js"));
  writeFileSync(join(root, "dist/cli.js"), 'export const main = async () => { console.log("DIST_MAIN"); };\n');
  if (withSrc) {
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, "src/cli.ts"), 'export const main = async () => { console.log("SRC_MAIN"); };\n');
  }
  return join(root, "bin/agentmbx.js");
};

const run = (launcher: string): string =>
  execFileSync(process.execPath, [launcher], { env: { ...process.env, AGENTMBX_DEV: "1" }, encoding: "utf8" });

test("AGENTMBX_DEV with no src/ runs dist instead of crashing", t => {
  const out = run(fixture(t, false));
  assert.match(out, /DIST_MAIN/, "the installed tree must run the compiled entry");
});

test("AGENTMBX_DEV with src/ present still prefers the source entry", t => {
  const out = run(fixture(t, true));
  assert.match(out, /SRC_MAIN/, "a checkout keeps running src directly under the dev flag");
});
