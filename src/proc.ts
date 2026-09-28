// Process identity: a PID plus its start time, so a reused PID never inherits a dead session's identity.
// Linux uses kernel birth ticks and boot identity; other platforms use ps. Tables are cached briefly.
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";

export interface Proc { ppid: number; start: string }
let cache: { at: number; table: Map<number, Proc> } | null = null;

/** Native Linux evidence works in minimal containers without ps and does not depend on locale/TZ. */
export function readLinuxProcess(pid: number, bootId?: string): (Proc & { dead: boolean }) | null {
  try {
    if (!Number.isSafeInteger(pid) || pid <= 0) return null;
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    // The comm field may contain spaces and closing parentheses; later fields cannot.
    const fields = stat.slice(stat.lastIndexOf(")") + 2).trim().split(/\s+/);
    const boot = bootId ?? readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
    if (!/^\d+$/.test(fields[1] ?? "") || !/^\d+$/.test(fields[19] ?? "") || !/^[a-f0-9-]{36}$/.test(boot)) return null;
    return { ppid: Number(fields[1]), start: `linux:${boot}:${fields[19]}`, dead: fields[0] === "Z" || fields[0] === "X" };
  } catch { return null; }
}

export function procTable(maxAgeMs = 2_000): Map<number, Proc> {
  if (cache && Date.now() - cache.at < maxAgeMs) return cache.table;
  const table = new Map<number, Proc>();
  try {
    if (process.platform === "linux") {
      const boot = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
      for (const entry of readdirSync("/proc")) {
        if (!/^\d+$/.test(entry)) continue;
        const p = readLinuxProcess(Number(entry), boot);
        if (p && !p.dead) table.set(Number(entry), { ppid: p.ppid, start: p.start });
      }
    } else {
      const out = execFileSync("ps", ["-A", "-o", "pid=,ppid=,lstart="], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024, env: { ...process.env, LC_ALL: "C" } });
      for (const line of out.split("\n")) {
        const m = /^\s*(\d+)\s+(\d+)\s+(.+?)\s*$/.exec(line);
        if (m) table.set(Number(m[1]), { ppid: Number(m[2]), start: m[3] });
      }
    }
  } catch { /* unavailable process inventory: proof-required callers fail closed */ }
  cache = { at: Date.now(), table };
  return table;
}

export const procStart = (pid: number | null | undefined): string | null => (pid ? procTable().get(pid)?.start ?? null : null);

/** Is this the same live process that was recorded (pid + start time)? Rows without a start time fall back to pid liveness. */
export function sameProcess(pid: number | null | undefined, start: string | null | undefined): boolean {
  if (!pid) return false;
  const t = procTable();
  if (t.size) { const p = t.get(pid); return !!p && (!start || p.start === start); }
  if (start) return false; // can't inspect processes: a recorded start time can't be confirmed, so it isn't
  try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === "EPERM"; }
}

/** For authorization: the row must carry a start time and the live process must match it. Unknown = no. */
export const provenProcess = (pid: number | null | undefined, start: string | null | undefined) => !!pid && !!start && procTable().size > 0 && sameProcess(pid, start);

/** This process's ancestors, nearest first (the shell, the agent CLI, its parents …). */
export function ancestors(pid = process.pid, max = 16): number[] {
  const t = procTable(), out: number[] = [];
  for (let p = t.get(pid)?.ppid; p && p > 1 && out.length < max; p = t.get(p)?.ppid) out.push(p);
  return out;
}

export const _resetProcCache = () => { cache = null; };
