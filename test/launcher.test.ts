// T728: the agentmbx launcher every harness config and the service run.
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { activeLauncher, healLauncher, installLauncher, launcherPath, launcherScript, readLauncherTarget, stableNodePath } from "../src/launcher.ts";
import { mcpNodeScriptCurrent, resolveCommand, runSetup, type SetupCtx } from "../src/setup.ts";

const tmp = (t: { after: (fn: () => void) => void }, prefix: string) => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
};
/** A fake node that prints the argv it was given, so a run proves what the launcher exec'd. */
const fakeNode = (dir: string) => {
  mkdirSync(dir, { recursive: true });
  const node = join(dir, "node");
  writeFileSync(node, `#!/bin/sh\necho "ran $0 $*"\n`); chmodSync(node, 0o755);
  return node;
};
const run = (launcher: string, args: string[], PATH = "/usr/bin:/bin") => spawnSync("/bin/sh", [launcher, ...args], { encoding: "utf8", env: { PATH } });

test("T728 the launcher records its install and round-trips paths with quotes and spaces", (t) => {
  const home = tmp(t, "mbx-t728-");
  const target = { node: "/opt/it's here/bin/node", entry: "/opt/it's here/lib/node_modules/agentmbx/bin/agentmbx.js" };
  assert.equal(installLauncher(target, home), true);
  assert.equal(installLauncher(target, home), false, "unchanged content is not rewritten");
  assert.deepEqual(readLauncherTarget(launcherPath(home)), target);
  assert.equal(activeLauncher(home, "darwin"), launcherPath(home));
  assert.equal(activeLauncher(home, "win32"), null, "Windows keeps the direct command until its own launcher exists");
  assert.deepEqual(readLauncherTarget(join(home, "nope")), null);
});

test("T728 the launcher runs the recorded node and entry with the caller's arguments", (t) => {
  const dir = tmp(t, "mbx-t728-run-");
  const node = fakeNode(join(dir, "rec/bin")), entry = join(dir, "rec/agentmbx.js");
  writeFileSync(entry, "");
  writeFileSync(join(dir, "l"), launcherScript({ node, entry }));
  assert.equal(run(join(dir, "l"), ["mcp", "--x"]).stdout.trim(), `ran ${node} ${entry} mcp --x`);
});

test("T728 when the recorded node and package are gone, the launcher finds node on PATH and the package beside it", (t) => {
  const dir = tmp(t, "mbx-t728-fallback-");
  const prefix = join(dir, "brew");
  const node = fakeNode(join(prefix, "bin"));
  const entry = join(prefix, "lib/node_modules/agentmbx/bin/agentmbx.js");
  mkdirSync(join(prefix, "lib/node_modules/agentmbx/bin"), { recursive: true }); writeFileSync(entry, "");
  // recorded: a mise install that has since been uninstalled
  writeFileSync(join(dir, "l"), launcherScript({ node: join(dir, "mise/installs/node/24.21.0/bin/node"), entry: join(dir, "mise/installs/node/24.21.0/lib/node_modules/agentmbx/bin/agentmbx.js") }));
  const out = run(join(dir, "l"), ["daemon"], `${join(prefix, "bin")}:/usr/bin:/bin`).stdout.trim();
  assert.equal(out, `ran ${node} ${join(prefix, "bin")}/../lib/node_modules/agentmbx/bin/agentmbx.js daemon`);
});

test("T728 with no node and no package the launcher fails loudly with exit 127", (t) => {
  const dir = tmp(t, "mbx-t728-none-");
  writeFileSync(join(dir, "l"), launcherScript({ node: join(dir, "gone/node"), entry: join(dir, "gone/agentmbx.js") }));
  const r = run(join(dir, "l"), ["mcp"], join(dir, "empty"));
  if (r.status === 0) return; // a host node in /opt/homebrew or /usr/local answered; the failure path needs a bare host
  assert.equal(r.status, 127);
  assert.match(r.stderr, /cannot find node and the agentmbx package .* Reinstall agentmbx, then run: agentmbx setup/);
});

test("T728 a standalone binary is exec'd directly", (t) => {
  const dir = tmp(t, "mbx-t728-sea-");
  const sea = fakeNode(join(dir, "bin"));
  writeFileSync(join(dir, "l"), launcherScript({ sea }));
  assert.equal(run(join(dir, "l"), ["version"]).stdout.trim(), `ran ${sea} version`);
  assert.deepEqual(readLauncherTarget(join(dir, "l")), { sea });
});

test("T728 a Homebrew node is recorded by its unversioned symlink, not the Cellar path an upgrade deletes", (t) => {
  const dir = tmp(t, "mbx-t728-brew-");
  const cellar = fakeNode(join(dir, "Cellar/node/26.12.1/bin"));
  mkdirSync(join(dir, "bin")); symlinkSync(cellar, join(dir, "bin/node"));
  assert.equal(stableNodePath(cellar, [join(dir, "nope"), join(dir, "bin/node")]), join(dir, "bin/node"));
  assert.equal(stableNodePath("/x/mise/installs/node/24.21.0/bin/node", [join(dir, "bin/node")]), "/x/mise/installs/node/24.21.0/bin/node", "non-Homebrew paths are kept");
});

test("T728 heal repoints a launcher whose install is gone, and leaves a live one alone", (t) => {
  const home = tmp(t, "mbx-t728-heal-");
  installLauncher({ node: join(home, "gone/node"), entry: join(home, "gone/agentmbx.js") }, home);
  assert.equal(healLauncher(false, home), true);
  const healed = readLauncherTarget(launcherPath(home)) as { node: string; entry: string };
  assert.equal(healed.entry, resolve("bin/agentmbx.js"));
  assert.equal(healLauncher(false, home), false);
});

test("T728 setup writes the launcher into configs and rewrites a node + script entry of this same install", (t) => {
  const home = tmp(t, "mbx-t728-setup-");
  mkdirSync(join(home, ".kimi-code"), { recursive: true });
  const old = { mcpServers: { mbx: { command: process.execPath, args: [resolve("bin/agentmbx.js"), "mcp"] } } };
  writeFileSync(join(home, ".kimi-code/mcp.json"), JSON.stringify(old, null, 2) + "\n");
  assert.equal(mcpNodeScriptCurrent(old.mcpServers.mbx), true, "without the launcher this install's node + script form is current (T533)");
  installLauncher({ node: process.execPath, entry: resolve("bin/agentmbx.js") }, home);
  const cmd = resolveCommand(home);
  assert.deepEqual(cmd, [launcherPath(home)]);
  assert.equal(mcpNodeScriptCurrent(old.mcpServers.mbx, cmd), false, "with the launcher it is drift");
  const ctx: SetupCtx = { home, cmd, which: () => null, useClis: false };
  runSetup(ctx, { mode: "install", stamp: "T1", only: ["kimi"] });
  assert.deepEqual(JSON.parse(readFileSync(join(home, ".kimi-code/mcp.json"), "utf8")).mcpServers.mbx, { command: launcherPath(home), args: ["mcp"] });
});

test("T728 a grok MCP section another Node's install wrote is rewritten to the launcher", (t) => {
  const home = tmp(t, "mbx-t728-grok-");
  mkdirSync(join(home, ".grok"), { recursive: true });
  writeFileSync(join(home, ".grok/config.toml"), `[mcp_servers.mbx]
command = "/x/mise/installs/node/24.21.0/bin/node"
args = [
    "/x/mise/installs/node/24.21.0/lib/node_modules/agentmbx/bin/agentmbx.js",
    "mcp",
]
enabled = true
startup_timeout_sec = 30
`);
  installLauncher({ node: process.execPath, entry: resolve("bin/agentmbx.js") }, home);
  runSetup({ home, cmd: resolveCommand(home), which: () => null, useClis: false }, { mode: "install", stamp: "T1", only: ["grok"] });
  const text = readFileSync(join(home, ".grok/config.toml"), "utf8");
  assert.match(text, new RegExp(`command = "${launcherPath(home).replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}"`));
  assert.doesNotMatch(text, /mise\/installs/);
  assert.match(text, /enabled = true/, "the user's other keys in the section stay");
});
