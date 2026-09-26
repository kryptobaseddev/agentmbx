// Process identity: a PID plus its start time, so a reused PID never inherits a dead session's identity.
// One `ps -A` call (macOS and Linux) gives pid, parent and start time for every process; cached briefly.
import { execFileSync } from "node:child_process";
let cache = null;
export function procTable(maxAgeMs = 2_000) {
    if (cache && Date.now() - cache.at < maxAgeMs)
        return cache.table;
    const table = new Map();
    try {
        const out = execFileSync("ps", ["-A", "-o", "pid=,ppid=,lstart="], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024, env: { ...process.env, LC_ALL: "C" } });
        for (const line of out.split("\n")) {
            const m = /^\s*(\d+)\s+(\d+)\s+(.+?)\s*$/.exec(line);
            if (m)
                table.set(Number(m[1]), { ppid: Number(m[2]), start: m[3] });
        }
    }
    catch { /* no ps: callers fall back to kill(pid, 0) */ }
    cache = { at: Date.now(), table };
    return table;
}
export const procStart = (pid) => (pid ? procTable().get(pid)?.start ?? null : null);
/** Is this the same live process that was recorded (pid + start time)? Rows without a start time fall back to pid liveness. */
export function sameProcess(pid, start) {
    if (!pid)
        return false;
    const t = procTable();
    if (t.size) {
        const p = t.get(pid);
        return !!p && (!start || p.start === start);
    }
    try {
        process.kill(pid, 0);
        return true;
    }
    catch (e) {
        return e.code === "EPERM";
    }
}
/** This process's ancestors, nearest first (the shell, the agent CLI, its parents …). */
export function ancestors(pid = process.pid, max = 16) {
    const t = procTable(), out = [];
    for (let p = t.get(pid)?.ppid; p && p > 1 && out.length < max; p = t.get(p)?.ppid)
        out.push(p);
    return out;
}
export const _resetProcCache = () => { cache = null; };
