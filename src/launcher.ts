// T728: one agentmbx-owned launcher that every harness config and the background service run.
// Configs used to name the node and the entry script of whichever install ran setup (for example
// ~/.local/share/mise/installs/node/24.21.0/...), so a Node upgrade, a version-manager switch or a
// reinstall under another Node broke every harness at once. The launcher records the install it runs
// and finds another Node and package when the recorded ones are gone, so only this file ever changes.
// macOS and Linux only; Windows keeps the direct command until its own launcher exists.
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const LAUNCHER_MARKER = "# agentmbx launcher (T728)";

/** The stable path every config and the service invoke. */
export const launcherPath = (home = homedir()): string => join(home, ".local/share/agentmbx/bin/agentmbx");

export const launcherSupported = (platform: NodeJS.Platform = process.platform): boolean => platform !== "win32";

/** What the launcher runs: a standalone (SEA) binary, or a node plus the agentmbx entry script. */
export type LauncherTarget = { sea: string } | { node: string; entry: string };

const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/** A Homebrew node is recorded by its unversioned symlink, never the Cellar path a `brew upgrade` deletes. */
export function stableNodePath(execPath = process.execPath, candidates = ["/opt/homebrew/bin/node", "/usr/local/bin/node", "/home/linuxbrew/.linuxbrew/bin/node"]): string {
  if (!/\/Cellar\/node(@\d+)?\//.test(execPath)) return execPath;
  let real: string;
  try { real = realpathSync(execPath); } catch { return execPath; }
  for (const c of candidates) { try { if (realpathSync(c) === real) return c; } catch { /* absent */ } }
  return execPath;
}

/** The install this process runs. */
export function currentLauncherTarget(sea: boolean): LauncherTarget {
  if (sea) return { sea: realpathSync(process.execPath) };
  return { node: stableNodePath(), entry: realpathSync(fileURLToPath(new URL("../bin/agentmbx.js", import.meta.url))) };
}

export function launcherScript(t: LauncherTarget): string {
  const sea = "sea" in t ? t.sea : "", node = "node" in t ? t.node : "", entry = "entry" in t ? t.entry : "";
  return `#!/bin/sh
${LAUNCHER_MARKER}. Written by \`agentmbx setup\`; do not edit.
# Every harness config and the background service run this file, so upgrading Node, switching
# version managers or reinstalling agentmbx never rewrites them: only the three lines below change.
AGENTMBX_SEA=${q(sea)}
AGENTMBX_NODE=${q(node)}
AGENTMBX_ENTRY=${q(entry)}
if [ -n "$AGENTMBX_SEA" ] && [ -x "$AGENTMBX_SEA" ]; then exec "$AGENTMBX_SEA" "$@"; fi
node="$AGENTMBX_NODE"
if [ ! -x "$node" ]; then
  # The recorded node is gone (upgraded or uninstalled): use the first node on PATH, then the usual places.
  node=""
  _ifs="$IFS"; IFS=:
  for d in $PATH /opt/homebrew/bin /usr/local/bin /home/linuxbrew/.linuxbrew/bin /usr/bin; do
    if [ -n "$d" ] && [ -x "$d/node" ]; then node="$d/node"; break; fi
  done
  IFS="$_ifs"
fi
entry="$AGENTMBX_ENTRY"
if [ -n "$node" ] && [ ! -f "$entry" ]; then
  # The recorded package is gone: a global npm install sits beside its node (<prefix>/bin/node, <prefix>/lib/node_modules).
  entry="$(dirname "$node")/../lib/node_modules/agentmbx/bin/agentmbx.js"
fi
if [ -z "$node" ] || [ ! -f "$entry" ]; then
  echo "agentmbx: cannot find node and the agentmbx package (this launcher, $0, last ran $AGENTMBX_ENTRY). Reinstall agentmbx, then run: agentmbx setup" >&2
  exit 127
fi
exec "$node" "$entry" "$@"
`;
}

/** The target recorded in an existing launcher, or null when there is none or it is not ours. */
export function readLauncherTarget(path: string): LauncherTarget | null {
  let text: string;
  try { text = readFileSync(path, "utf8"); } catch { return null; }
  if (!text.includes(LAUNCHER_MARKER)) return null;
  const v = (k: string) => {
    const m = new RegExp(`^${k}='((?:[^']|'\\\\'')*)'$`, "m").exec(text);
    return m ? m[1].replace(/'\\''/g, "'") : "";
  };
  const sea = v("AGENTMBX_SEA");
  return sea ? { sea } : { node: v("AGENTMBX_NODE"), entry: v("AGENTMBX_ENTRY") };
}

/** Write the launcher atomically when its content differs. Returns whether it changed. */
export function installLauncher(target: LauncherTarget, home = homedir()): boolean {
  const path = launcherPath(home), text = launcherScript(target);
  try { if (readFileSync(path, "utf8") === text) return false; } catch { /* absent */ }
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.new.${process.pid}`;
  writeFileSync(tmp, text, { mode: 0o755 });
  chmodSync(tmp, 0o755);
  renameSync(tmp, path);
  return true;
}

/** The launcher, when it exists and is ours. */
export function activeLauncher(home = homedir(), platform: NodeJS.Platform = process.platform): string | null {
  if (!launcherSupported(platform)) return null;
  const path = launcherPath(home);
  return existsSync(path) && readLauncherTarget(path) ? path : null;
}

/** Self-heal: repoint a launcher whose recorded install is gone at this running install. */
export function healLauncher(sea: boolean, home = homedir()): boolean {
  const path = activeLauncher(home);
  if (!path) return false;
  const t = readLauncherTarget(path)!;
  const live = "sea" in t ? existsSync(t.sea) : existsSync(t.node) && existsSync(t.entry);
  return live ? false : installLauncher(currentLauncherTarget(sea), home);
}
