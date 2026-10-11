// Process identity: a PID plus its start time, so a reused PID never inherits a dead session's identity.
// Linux uses kernel birth ticks and boot identity; other platforms use ps. Tables are cached briefly.
import { execFileSync, type StdioOptions } from "node:child_process";
import { fstatSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { AsyncLocalStorage } from "node:async_hooks";

export interface Proc { ppid: number; start: string }

/** Kernel identity of both client pipe ends; inherited fds and exec keep it, separate connections do not. */
export function stdioEndpoint(): string | null {
  if (process.platform !== "darwin" && process.platform !== "linux") return null;
  try {
    const ends = [0, 1].map(fd => fstatSync(fd, { bigint: true }));
    if (ends.some(s => !(s.isFIFO() || s.isSocket()) || s.ino === 0n)) return null;
    // macOS pipe inode values may be signed and exceed Number precision; retain every bit.
    return `${process.platform}:${ends.map(s => `${s.dev}:${s.ino}:${s.mode & 0o170000n}`).join("|")}`;
  } catch { return null; }
}
let cache: { at: number; table: Map<number, Proc> } | null = null;
const snapshots = new AsyncLocalStorage<{ active: boolean; at: number; table: Map<number, Proc> }>();

/** Count of ps spawns for process evidence (T206 measurement); never reset by production code. */
export const processEvidenceSpawns = { count: 0 };

type PsOptions = { env: NodeJS.ProcessEnv; timeout?: number; stdio?: StdioOptions };
/** Test seam (T332): the platform branch and the ps runner. Production code never reassigns either. */
export const procSeams: { platform: NodeJS.Platform; ps: (args: string[], options: PsOptions) => string } = {
  platform: process.platform,
  ps: (args, options) => execFileSync("ps", args, { encoding: "utf8", maxBuffer: 16 * 1024 * 1024, ...options }),
};

/** Synchronous sleep for retry backoff; evidence paths must stay synchronous. */
export const sleepSync = (ms: number) => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); };

/** Capture process inventory before a database transaction; expired or escaped scopes fail closed. */
export function withProcSnapshot<T>(operation: () => T): T {
  if (operation.constructor.name === "AsyncFunction") throw new Error("process snapshots require synchronous operations");
  const prior = snapshots.getStore();
  if (prior?.active) return operation();
  if (prior) throw new Error("process snapshot scope is closed");
  // Share the short module cache instead of forcing a fresh ps -A per call: the snapshot may be at most
  // 2 s old, and start times do not change within it, so proof decisions (start equality) cannot drift.
  const table = procTable(), scope = { active: true, at: performance.now(), table };
  return snapshots.run(scope, () => {
    try {
      const result = operation();
      if (result && typeof (result as { then?: unknown }).then === "function") { void Promise.resolve(result).catch(() => {}); throw new Error("process snapshots cannot return a thenable"); }
      return result;
    } finally { scope.active = false; }
  });
}

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
  const snapshot = snapshots.getStore();
  if (snapshot) return snapshot.active && performance.now() - snapshot.at <= 5000 ? snapshot.table : new Map();
  if (cache && Date.now() - cache.at < maxAgeMs) return cache.table;
  const table = new Map<number, Proc>();
  try {
    if (procSeams.platform === "linux") {
      const boot = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
      for (const entry of readdirSync("/proc")) {
        if (!/^\d+$/.test(entry)) continue;
        const p = readLinuxProcess(Number(entry), boot);
        if (p && !p.dead) table.set(Number(entry), { ppid: p.ppid, start: p.start });
      }
    } else {
      processEvidenceSpawns.count += 1;
      const out = procSeams.ps(["-A", "-o", "pid=,ppid=,lstart="], { env: { ...process.env, LC_ALL: "C" } });
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

/** Lease-format evidence from one full process table: BSD one-second birth resolution, rendered in UTC. */
export type PsEvidence = { zombie: boolean; start: string };
const PS_EVIDENCE_TIMEOUT_MS = 1000;
/** A successful table answers every pid for this long (the T206 evidence cache window); a failed read is never kept. */
const PS_EVIDENCE_MAX_AGE_MS = 1000;
let psEvidence: { at: number; table: Map<number, PsEvidence> } | null = null;

/**
 * Every process's lease evidence from one `ps -A` (T332). On macOS `ps -p <a,b,…>` costs 0.3-0.7 s (it hit the 1 s
 * timeout under load), while the full table costs about 30 ms; filtering in process keeps one read per pass, never one per
 * pid. Start strings are byte-identical to the former `ps -p` read: `ps-utc:` plus lstart in UTC with whitespace collapsed.
 * Returns null when ps fails or times out; that failure is not cached, so the next call reads again.
 */
export function psEvidenceTable(maxAgeMs = PS_EVIDENCE_MAX_AGE_MS): { at: number; table: Map<number, PsEvidence> } | null {
  if (psEvidence && performance.now() - psEvidence.at <= maxAgeMs) return psEvidence;
  const at = performance.now(); // taken before the spawn: a slow read does not extend its own freshness
  processEvidenceSpawns.count += 1;
  let out: string;
  try {
    out = procSeams.ps(["-A", "-o", "pid=,stat=,lstart="], {
      timeout: PS_EVIDENCE_TIMEOUT_MS, stdio: ["ignore", "pipe", "ignore"],
      env: { ...process.env, TZ: "UTC", LC_ALL: "C", LANG: "C" },
    });
  } catch { return null; }
  const table = new Map<number, PsEvidence>();
  for (const line of out.split("\n")) {
    const m = /^\s*(\d+)\s+(\S+)\s+([A-Z][a-z]{2} [A-Z][a-z]{2}\s+\d{1,2} \d{2}:\d{2}:\d{2} \d{4})\s*$/.exec(line);
    if (m) table.set(Number(m[1]), { zombie: m[2].includes("Z"), start: `ps-utc:${m[3].replace(/\s+/g, " ")}` });
  }
  if (!table.size) return null; // a table with no rows (not even ps itself) is not evidence that anything died
  return psEvidence = { at, table };
}

export const _resetPsEvidenceCache = () => { psEvidence = null; };
export const _resetProcCache = () => { cache = null; psEvidence = null; };

/**
 * The session id Claude Code currently records for its process `pid` (~/.claude/sessions/<pid>.json). /clear, /resume
 * and compaction rewrite it while the same process (and its mbx MCP server) lives on, so it is read fresh each time.
 */
export function claudeSessionId(pid: number): string | null {
  try {
    const id = JSON.parse(readFileSync(claudeSessionFile(pid), "utf8"))?.sessionId;
    return typeof id === "string" && id.trim() ? id : null;
  } catch { return null; }
}
const claudeSessionFile = (pid: number) => join(homedir(), ".claude/sessions", `${pid}.json`);

const PS_LSTART_RE = /^[A-Z][a-z]{2} ([A-Z][a-z]{2})\s+(\d{1,2}) (\d{2}):(\d{2}):(\d{2}) (\d{4})$/;
const PS_MONTHS: Record<string, number> = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 };
/** Epoch ms for any recorded start format: `linux:boot:ticks`, `ps-utc:` (UTC lstart), or procTable's
 *  raw local-zone lstart. Null when the string is none of those — unparseable is never proof of reuse. */
export function recordedStartEpochMs(start: string): number | null {
  if (start.startsWith("linux:")) {
    const ticks = Number(start.split(":")[2]);
    try {
      const btime = Number(/btime (\d+)/.exec(readFileSync("/proc/stat", "utf8"))?.[1]);
      return Number.isFinite(ticks) && Number.isFinite(btime) ? btime * 1000 + ticks * 10 : null; // USER_HZ is 100
    } catch { return null; }
  }
  const utc = start.startsWith("ps-utc:");
  const m = PS_LSTART_RE.exec(utc ? start.slice("ps-utc:".length) : start);
  if (!m) return null;
  return utc ? Date.UTC(Number(m[6]), PS_MONTHS[m[1]], Number(m[2]), Number(m[3]), Number(m[4]), Number(m[5]))
    : new Date(Number(m[6]), PS_MONTHS[m[1]], Number(m[2]), Number(m[3]), Number(m[4]), Number(m[5])).getTime();
}

/** The same recorded process birth across formats: mcp-process rows record procStart's raw lstart (or
 *  linux: ticks) while lease evidence is ps-utc. Returns false only when both starts parse and name
 *  different moments (a reused pid); an unparseable start is not proof of reuse, so the row keeps. */
export function recordedStartMatches(recorded: string, live: string): boolean {
  if (recorded === live) return true;
  const a = recordedStartEpochMs(recorded), b = recordedStartEpochMs(live);
  return a === null || b === null ? true : a === b;
}

/** The process start as epoch ms, comparable with ISO timestamps (T337 review: reject a session row older than its process). */
export function procStartEpochMs(pid: number): number | null {
  const start = procStart(pid);
  return start ? recordedStartEpochMs(start) : null;
}

const grokSessionsFile = () => process.env.MBX_GROK_SESSIONS_FILE || join(process.env.GROK_HOME || join(homedir(), ".grok"), "active_sessions.json");
/** The grok CLI tracks live sessions in active_sessions.json: [{session_id, pid, cwd, opened_at}].
 *  T337: this MCP server is that grok process's child, so a pid match names its session. Review:
 *  one process can host several sessions (forks, "+ New Agent") — never guess unless exactly one
 *  row matches; a row older than the process is a reused pid's leftover, never its session. */
export function grokSessionId(pid: number): string | null {
  try {
    const rows = JSON.parse(readFileSync(grokSessionsFile(), "utf8")) as unknown;
    if (!Array.isArray(rows)) return null;
    const matches = rows.filter((r): r is { session_id: string; opened_at?: unknown } =>
      !!r && typeof r === "object" && (r as { pid?: unknown }).pid === pid
      && typeof (r as { session_id?: unknown }).session_id === "string"
      && /^[A-Za-z0-9_-]{1,128}$/.test((r as { session_id: string }).session_id));
    if (matches.length !== 1) return null;
    const opened = typeof matches[0].opened_at === "string" ? Date.parse(matches[0].opened_at) : NaN;
    const startMs = procStartEpochMs(pid);
    if (Number.isFinite(opened) && startMs !== null && opened < startMs) return null;
    return matches[0].session_id;
  } catch { return null; } // malformed or half-written file: no session id
}

/** grok switches sessions in-process (/new, /clear, /resume): re-read the registry when it changes (review med 7). */
export function grokSessionTracker(pid: number): () => string | null {
  let stamp: string | null = null, id: string | null = null;
  return () => {
    let next: string | null = null;
    try { const s = statSync(grokSessionsFile()); next = `${s.ino}:${s.size}:${s.mtimeMs}`; } catch { /* no file yet */ }
    if (next === null) { stamp = null; return id = null; }
    if (next !== stamp) { stamp = next; id = grokSessionId(pid); }
    return id;
  };
}

/**
 * claudeSessionId for a caller that asks on every tool call and heartbeat (T326): the file is parsed again only when its
 * inode, size or modification time changed.
 */
export function claudeSessionTracker(pid: number): () => string | null {
  let stamp: string | null = null, id: string | null = null;
  return () => {
    let next: string | null = null;
    try { const s = statSync(claudeSessionFile(pid)); next = `${s.ino}:${s.size}:${s.mtimeMs}`; } catch { /* no file yet */ }
    if (next === null) { stamp = null; return id = null; }
    if (next !== stamp) { stamp = next; id = claudeSessionId(pid); }
    return id;
  };
}
