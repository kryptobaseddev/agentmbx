// T341: test-only preload. Loaded into a spawned agentmbx process with NODE_OPTIONS=--import <this file>, it appends one
// JSON line per child_process call to $MBX_SPAWN_TRACE. syncBuiltinESMExports() makes the ESM named imports in src/
// (`import { execFileSync } from "node:child_process"`) see the wrappers, so absolute paths (/bin/ps) are caught too, on
// every platform. Production code never loads it.
import { appendFileSync } from "node:fs";
import { createRequire, syncBuiltinESMExports } from "node:module";

const log = process.env.MBX_SPAWN_TRACE;
if (log) {
  const cp = createRequire(import.meta.url)("node:child_process");
  for (const name of ["spawn", "spawnSync", "execFile", "execFileSync", "exec", "execSync", "fork"]) {
    const real = cp[name];
    cp[name] = function traced(...args) {
      const argv = Array.isArray(args[1]) ? args[1].slice(0, 4).map(String) : [];
      try { appendFileSync(log, `${JSON.stringify({ pid: process.pid, at: Date.now(), fn: name, file: String(args[0]), argv })}\n`); }
      catch { /* tracing never changes the traced process's behaviour */ }
      return real.apply(this, args);
    };
  }
  syncBuiltinESMExports();
}
