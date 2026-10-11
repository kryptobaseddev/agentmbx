// Session start fills task and lane from CLEO when it is present (T497). A session without CLEO is left unchanged,
// and a failure here never fails the hook.
import { execFileSync, spawnSync } from "node:child_process";
import type { MbxNode } from "./node.ts";
import { setSessionPresence, TASK_RE } from "./presence.ts";
import { ROLE_RE } from "./registry.ts";

const CLEO_BUDGET_MS = 1500;

export interface CleoCurrentData {
  currentTask?: unknown;
  currentPhase?: unknown;
}

/** The task id inside `cleo current`'s `data.currentTask`, a string or `{id}`. */
export function taskIdOf(value: unknown): string | undefined {
  if (typeof value === "string" && TASK_RE.test(value)) return value;
  if (value && typeof value === "object" && "id" in value) {
    const id = (value as { id: unknown }).id;
    if (typeof id === "string" && TASK_RE.test(id)) return id;
  }
  return undefined;
}

function defaultWhich(bin: string): string | null {
  try {
    const found = execFileSync("/usr/bin/which", [bin], { encoding: "utf8" }).trim();
    return found || null;
  } catch {
    return null;
  }
}

function readCleo(bin: string, cwd: string | undefined, env: NodeJS.ProcessEnv): CleoCurrentData | null {
  try {
    const r = spawnSync(bin, ["current"], { cwd, env, encoding: "utf8", timeout: CLEO_BUDGET_MS });
    if (r.status !== 0 || !r.stdout) return null;
    const parsed = JSON.parse(r.stdout) as { data?: CleoCurrentData };
    return parsed.data ?? null;
  } catch {
    return null;
  }
}

/** Write this session's task and lane. `CLEO_TASK_ID` wins and does not spawn cleo. Otherwise `cleo current`. */
export function fillCleoPresence(node: MbxNode, s: {
  cli: string;
  sessionId: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  which?: (bin: string) => string | null;
  current?: (cwd: string | undefined, env: NodeJS.ProcessEnv) => CleoCurrentData | null;
}): void {
  try {
    const env = s.env ?? process.env;
    const fromEnv = env.CLEO_TASK_ID;
    if (typeof fromEnv === "string" && TASK_RE.test(fromEnv)) {
      setSessionPresence(node, { cli: s.cli, sessionId: s.sessionId, task: fromEnv });
      return;
    }
    const which = s.which ?? defaultWhich;
    if (!which("cleo")) return;
    const data = (s.current ?? ((cwd, e) => { const bin = which("cleo"); return bin ? readCleo(bin, cwd, e) : null; }))(s.cwd, env);
    if (!data) return;
    const task = taskIdOf(data.currentTask);
    const phase = typeof data.currentPhase === "string" ? data.currentPhase : "";
    const lane = phase && ROLE_RE.test(phase) ? phase : undefined;
    if (!task && !lane) return;
    setSessionPresence(node, { cli: s.cli, sessionId: s.sessionId, ...(task ? { task } : {}), ...(lane ? { lane } : {}) });
  } catch { /* CLEO is optional */ }
}
