// T522: two OpenCode processes on one bound session overlap assistant turns, and each turn
// carries a git snapshot. The daemon audits a change in that set. Doctor only reports it.
import { DatabaseSync } from "node:sqlite";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { sha256 } from "./crypto.ts";
import type { MbxNode } from "./node.ts";

export interface AssistantTurn {
  id: string;
  created: number;
  completed: number;
  snapshot: boolean;
}

export interface DuplicateLoop {
  session_id: string;
  agent: string;
  pairs: number;
  messages: string[];
  snapshots: boolean;
}

const EVENT = "opencode.duplicate_loop";
const MESSAGE_CAP = 20;

export function opencodeDbPath(env: NodeJS.ProcessEnv = process.env, home = homedir()): string {
  if (typeof env.OPENCODE_DB === "string" && env.OPENCODE_DB !== "") return env.OPENCODE_DB;
  const xdg = typeof env.XDG_DATA_HOME === "string" && env.XDG_DATA_HOME !== "" ? env.XDG_DATA_HOME : join(home, ".local", "share");
  return join(xdg, "opencode", "opencode.db");
}

/** Each turn starts before the other finishes. Endpoints that only touch do not overlap. */
export function overlappingTurns(turns: readonly AssistantTurn[]): Array<[AssistantTurn, AssistantTurn]> {
  const sorted = [...turns].sort((a, b) => a.created - b.created || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const pairs: Array<[AssistantTurn, AssistantTurn]> = [];
  for (let i = 0; i < sorted.length; i++) {
    const a = sorted[i]!;
    for (let j = i + 1; j < sorted.length; j++) {
      const b = sorted[j]!;
      if (b.created >= a.completed) break;
      if (a.created < b.completed && b.created < a.completed) pairs.push([a, b]);
    }
  }
  return pairs;
}

function boundSessions(node: MbxNode): Array<{ agent: string; session_id: string }> {
  return node.store.db.prepare(
    "SELECT agent, session_id FROM sessions WHERE cli='opencode' AND session_id NOT LIKE 'mcp-%' ORDER BY session_id",
  ).all() as Array<{ agent: string; session_id: string }>;
}

function turnsIn(db: DatabaseSync, sessionId: string): AssistantTurn[] {
  const rows = db.prepare(
    "SELECT id, time_updated, data FROM session_message WHERE session_id = ? AND type = 'assistant'",
  ).all(sessionId) as Array<{ id: string; time_updated: number | null; data: string }>;
  const turns: AssistantTurn[] = [];
  for (const row of rows) {
    let data: { time?: { created?: unknown; completed?: unknown }; snapshot?: { start?: unknown } };
    try { data = JSON.parse(row.data) as typeof data; } catch { continue; }
    const created = data.time?.created;
    if (typeof created !== "number" || !Number.isFinite(created)) continue;
    const completedRaw = data.time?.completed;
    const completed = typeof completedRaw === "number" && Number.isFinite(completedRaw) && completedRaw >= created
      ? completedRaw
      : typeof row.time_updated === "number" && Number.isFinite(row.time_updated) && row.time_updated >= created
        ? row.time_updated
        : created;
    const start = data.snapshot?.start;
    turns.push({ id: row.id, created, completed, snapshot: typeof start === "string" && start.length > 0 });
  }
  return turns;
}

function openDb(path: string): DatabaseSync | null {
  if (!existsSync(path)) return null;
  try { return new DatabaseSync(path, { readOnly: true, timeout: 2000 }); } catch { return null; }
}

interface Found extends DuplicateLoop { fingerprint: string }

function scan(node: MbxNode, dbPath: string): Found[] {
  const bound = boundSessions(node);
  if (!bound.length) return [];
  const db = openDb(dbPath);
  if (!db) return [];
  try {
    const out: Found[] = [];
    for (const row of bound) {
      let turns: AssistantTurn[];
      try { turns = turnsIn(db, row.session_id); } catch { continue; }
      const pairs = overlappingTurns(turns);
      if (!pairs.length) continue;
      const ids = [...new Set(pairs.flatMap(([a, b]) => [a.id, b.id]))].sort();
      const loop: DuplicateLoop = {
        session_id: row.session_id,
        agent: row.agent,
        pairs: pairs.length,
        messages: ids.slice(0, MESSAGE_CAP),
        snapshots: pairs.some(([a, b]) => a.snapshot && b.snapshot),
      };
      out.push({ ...loop, fingerprint: sha256(JSON.stringify([row.session_id, ids])) });
    }
    return out;
  } finally { try { db.close(); } catch { /* the read-only handle is already gone */ } }
}

function published(loop: Found): DuplicateLoop {
  return { session_id: loop.session_id, agent: loop.agent, pairs: loop.pairs, messages: loop.messages, snapshots: loop.snapshots };
}

export function findOpencodeDuplicateLoops(node: MbxNode, opts: { dbPath?: string } = {}): DuplicateLoop[] {
  return scan(node, opts.dbPath ?? opencodeDbPath()).map(published);
}

function kvKey(sessionId: string): string {
  return `opencode-duplicate-loop:${sessionId}`;
}

/** The daemon writes one audit row when the overlapping set for a bound session changes. */
export function auditOpencodeDuplicateLoops(node: MbxNode, opts: { dbPath?: string } = {}): DuplicateLoop[] {
  const found = scan(node, opts.dbPath ?? opencodeDbPath());
  const seen = new Set(found.map((loop) => loop.session_id));
  for (const loop of found) {
    const key = kvKey(loop.session_id);
    if (node.store.get(key) === loop.fingerprint) continue;
    node.store.set(key, loop.fingerprint);
    node.store.audit(EVENT, {
      session_id: loop.session_id,
      agent: loop.agent,
      pairs: loop.pairs,
      messages: loop.messages,
      snapshots: loop.snapshots,
    });
  }
  for (const row of boundSessions(node)) {
    if (!seen.has(row.session_id)) node.store.db.prepare("DELETE FROM kv WHERE k=?").run(kvKey(row.session_id));
  }
  return found.map(published);
}

export function opencodeDuplicateLoopChecks(node: MbxNode, opts: { dbPath?: string } = {}): Array<{ level: "warn"; label: string; fix: string }> {
  return findOpencodeDuplicateLoops(node, opts).map((loop) => ({
    level: "warn" as const,
    label: `opencode: overlapping assistant messages on bound session ${loop.session_id} (${loop.pairs} pair${loop.pairs === 1 ? "" : "s"}${loop.snapshots ? ", with snapshots" : ""})`,
    fix: "two OpenCode processes took turns on this session; stop the extra serve so only one loop writes it",
  }));
}

/** Started by the daemon's existing loop-report arm. cli.ts is not edited from this task. */
export function armOpencodeDuplicateLoopAudit(node: MbxNode): void {
  let busy = false;
  const tick = () => {
    if (busy) return;
    busy = true;
    try { auditOpencodeDuplicateLoops(node); }
    catch (error) {
      process.stderr.write(`[agentmbx] opencode duplicate loop: ${String(error).replace(/\s+/g, " ").slice(0, 300)}\n`);
    } finally { busy = false; }
  };
  setInterval(tick, 60_000).unref();
  setTimeout(tick, 5_000).unref();
}
