import { execFileSync } from "node:child_process";
import { basename } from "node:path";
import { readFileSync, readlinkSync } from "node:fs";
import { procSeams, procTable } from "./proc.js";
/** Resolve runtime siblings to their OpenCode server, without crossing an agent's shell. */
export function opencodeProviderPid(pid, table = procTable(), command = (p) => {
    // Linux comm is a mutable, truncated task name, not the executable identity.
    // Fail closed if procfs cannot establish the executable; argv is caller-controlled too.
    if (process.platform === "linux") {
        try {
            return readlinkSync(`/proc/${p}/exe`);
        }
        catch {
            return "";
        }
    }
    try {
        return execFileSync("ps", ["-o", "comm=", "-p", String(p)], { encoding: "utf8", timeout: 1000 }).trim();
    }
    catch {
        return "";
    }
}) {
    for (let current = pid, n = 0; current > 1 && n < 16; n++) {
        if (!table.has(current))
            return null;
        const executable = basename(command(current));
        if (executable === "opencode")
            return current;
        // Code Mode can introduce Node/Bun runtimes. Shells and arbitrary helpers are not harness proof.
        if (!/^(?:node|bun)(?:\.exe)?$/.test(executable))
            return null;
        current = table.get(current).ppid;
    }
    return null;
}
/** True when this argv is the shared OpenCode service: a `--service` flag and no private `--stdio` transport. */
export const isOpencodeServiceArgv = (argv) => argv.some((a) => a === "--service" || a.startsWith("--service=")) && !argv.includes("--stdio");
/** Every process's argv from one read: procfs cmdline on Linux, otherwise one `ps -A -o pid=,args=`
 *  (macOS ps cannot keep argument boundaries, so argv here is whitespace-split; a path with spaces
 *  in argv[0] fails closed as `unknown`). An empty map means the read failed. */
export function processArgsTable(pids) {
    const out = new Map();
    try {
        if (procSeams.platform === "linux") {
            for (const p of pids ?? []) {
                try {
                    out.set(p, readFileSync(`/proc/${p}/cmdline`, "utf8").split("\0").filter(Boolean));
                }
                catch { /* gone */ }
            }
            return out;
        }
        const ps = procSeams.ps(["-A", "-o", "pid=,args="], { env: { ...process.env, LC_ALL: "C" }, timeout: 2_000, stdio: ["ignore", "pipe", "ignore"] });
        for (const line of ps.split("\n")) {
            const m = /^\s*(\d+)\s+(.*?)\s*$/.exec(line);
            if (m)
                out.set(Number(m[1]), m[2].split(/\s+/).filter(Boolean));
        }
    }
    catch { /* unavailable: callers fail closed */ }
    return out;
}
/** Test seam: production never reassigns it. */
export const opencodeHostSeams = { args: processArgsTable };
/** Which kind of OpenCode server hosts a binding whose recorded pid is `pid` (the hook's parent: the
 *  serve process the plugin runs in). Walks at most a few node/bun runtime hops up the process tree to
 *  the first `opencode` executable; anything else, or an unreadable process table, is `unknown`. */
export function opencodeHostOf(pid, args, table = procTable()) {
    if (!pid || !Number.isSafeInteger(pid) || pid <= 1)
        return "unknown";
    const chain = [];
    for (let p = pid, n = 0; p > 1 && n < 4; n++) {
        chain.push(p);
        const next = table.get(p)?.ppid;
        if (!next)
            break;
        p = next;
    }
    const argv = args ?? opencodeHostSeams.args(chain);
    for (const p of chain) {
        const a = argv.get(p);
        if (!a?.length)
            return "unknown";
        const exe = basename(a[0]);
        if (exe === "opencode" || exe === "opencode.exe")
            return isOpencodeServiceArgv(a.slice(1)) ? "service" : "standalone";
        if (!/^(?:node|bun)(?:\.exe)?$/.test(exe))
            return "unknown";
    }
    return "unknown";
}
/** A classifier for many bindings from one process read (doctor): macOS/BSD read `ps -A` once and
 *  reuse it; Linux reads only the procfs cmdline files each binding needs (no spawn). */
export function opencodeHostClassifier() {
    let args;
    return (pid) => opencodeHostOf(pid, procSeams.platform === "linux" ? undefined : (args ??= opencodeHostSeams.args([])));
}
