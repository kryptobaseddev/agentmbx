import { spawnSync } from "node:child_process";
import { basename, dirname } from "node:path";
import { readlinkSync } from "node:fs";
import { procTable } from "./proc.js";
const RUNTIME = /^(?:node|bun)(?:\.exe)?$/;
/** One argv0 for a pid. Linux uses the procfs exe path. A bare name has no known directory. */
function invokedExecutable(pid) {
    // Linux comm is a mutable, truncated task name, not the executable identity.
    // Fail closed if procfs cannot establish the executable; argv is caller-controlled too.
    if (process.platform === "linux") {
        try {
            return readlinkSync(`/proc/${pid}/exe`);
        }
        catch {
            return "";
        }
    }
    return darwinArgv0([pid]).get(pid) ?? "";
}
/** macOS argv0 for many pids in one ps. The invoked path keeps the symlink directory, not the dyld target. */
function darwinArgv0(pids) {
    const out = new Map();
    if (pids.length === 0)
        return out;
    const result = spawnSync("ps", ["-ww", "-o", "pid=,args=", "-p", pids.join(",")], { encoding: "utf8", timeout: 1000 });
    for (const line of (result.stdout ?? "").split("\n")) {
        const match = /^\s*(\d+)\s*(.*)$/.exec(line);
        if (!match)
            continue;
        out.set(Number(match[1]), (match[2] ?? "").trim().split(/\s+/, 1)[0] ?? "");
    }
    for (const pid of pids)
        if (!out.has(pid))
            out.set(pid, "");
    return out;
}
/** Resolve runtime siblings to their OpenCode server, without crossing an agent's shell or another CLI's runtime. */
export function opencodeProviderPid(pid, table = procTable(), command = invokedExecutable) {
    const cache = new Map();
    if (command === invokedExecutable && process.platform !== "linux") {
        const chain = [];
        for (let current = pid, n = 0; current > 1 && n < 17 && table.has(current); n++) {
            chain.push(current);
            current = table.get(current).ppid;
        }
        for (const [id, executable] of darwinArgv0(chain))
            cache.set(id, executable);
    }
    const once = (p) => {
        const hit = cache.get(p);
        if (hit !== undefined)
            return hit;
        const executable = command(p);
        cache.set(p, executable);
        return executable;
    };
    for (let current = pid, n = 0; current > 1 && n < 16; n++) {
        if (!table.has(current))
            return null;
        const executable = once(current);
        const name = basename(executable);
        if (name === "opencode")
            return current;
        // Code Mode can introduce Node/Bun runtimes. Shells and arbitrary helpers are not harness proof.
        if (!RUNTIME.test(name))
            return null;
        const parent = table.get(current).ppid;
        if (parent > 1 && table.has(parent)) {
            const parentExecutable = once(parent);
            const parentName = basename(parentExecutable);
            // A node or bun in another directory is a different CLI. A name with no slash has no known directory, so it is not a boundary.
            if (RUNTIME.test(parentName) && executable.includes("/") && parentExecutable.includes("/") && dirname(executable) !== dirname(parentExecutable))
                return null;
        }
        current = parent;
    }
    return null;
}
