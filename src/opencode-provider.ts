import { execFileSync } from "node:child_process";
import { basename, dirname } from "node:path";
import { readlinkSync } from "node:fs";
import { procTable } from "./proc.ts";

const RUNTIME = /^(?:node|bun)(?:\.exe)?$/;

/** Executable identity for the provider walk. Linux uses the procfs exe path. macOS uses the invoked
 *  argv0, which keeps the symlink path (and therefore its directory) instead of the dyld target. */
function invokedExecutable(pid: number): string {
  // Linux comm is a mutable, truncated task name, not the executable identity.
  // Fail closed if procfs cannot establish the executable; argv is caller-controlled too.
  if (process.platform === "linux") {
    try { return readlinkSync(`/proc/${pid}/exe`); } catch { return ""; }
  }
  try {
    const args = execFileSync("ps", ["-ww", "-o", "args=", "-p", String(pid)], { encoding: "utf8", timeout: 1000 }).trim();
    return args.split(/\s+/, 1)[0] ?? "";
  } catch { return ""; }
}

/** Resolve runtime siblings to their OpenCode server, without crossing an agent's shell or another CLI's runtime. */
export function opencodeProviderPid(pid: number, table: Map<number, { ppid: number }> = procTable(), command = invokedExecutable): number | null {
  for (let current = pid, n = 0; current > 1 && n < 16; n++) {
    if (!table.has(current)) return null;
    const executable = command(current);
    const name = basename(executable);
    if (name === "opencode") return current;
    // Code Mode can introduce Node/Bun runtimes. Shells and arbitrary helpers are not harness proof.
    if (!RUNTIME.test(name)) return null;
    const parent = table.get(current)!.ppid;
    if (parent > 1 && table.has(parent)) {
      const parentExecutable = command(parent);
      const parentName = basename(parentExecutable);
      // A node or bun in another directory is a different CLI. Same-directory runtimes still count.
      if (RUNTIME.test(parentName) && dirname(executable) !== dirname(parentExecutable)) return null;
    }
    current = parent;
  }
  return null;
}
