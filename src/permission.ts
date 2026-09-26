// YOLO (docs/POLICY.md §5): a CLI session auto-approves its own permission prompts while an owner policy grants its
// agent the `permissions` class. Anything else (no policy, unknown agent, malformed input, any error) returns no
// decision, so the CLI shows its normal prompt. Per-CLI mechanisms and evidence: docs/RESEARCH.md "Permission hooks per CLI".
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { agentName } from "./mcp.ts";
import type { MbxNode } from "./node.ts";

/** Is the permissions class granted to `agent` for a session working in `ctx.cwd`? (see policy.ts hasClass) */
export type Lookup = (agent: string, ctx?: { cwd?: string | null }) => { ok: boolean; policy_id?: string; exp?: string };
export interface Decision { allow: boolean; agent?: string; tool?: string; policy_id?: string; output: string; cwd?: string | null; kimi?: { session_id: string; approval_id: string } }

/** Tools that collect an answer from the user rather than ask for permission: never auto-approved. */
const INTERACTIVE = new Set(["AskUserQuestion", "ExitPlanMode"]);
const NONE: Decision = { allow: false, output: "" };

/**
 * The agent a hook invocation belongs to: only a binding recorded for this very CLI process (pid + start time) counts.
 * No verified binding means no decision (fail closed): a stale row, a reused PID or a guessed name never gets YOLO.
 */
export function resolveAgent(node: MbxNode, cli: string, sessionId: string | undefined, _cwd: string, pid?: number): string | null {
  if (!pid) return null;
  if (sessionId) {
    const r = node.store.db.prepare("SELECT agent, pid, pid_start, updated_at FROM sessions WHERE cli=? AND session_id=?").get(cli, sessionId) as
      { agent: string; pid: number | null; pid_start: string | null; updated_at: string } | undefined;
    if (r && r.pid === pid && node.sameSession(pid, r, { proof: true })) return r.agent;
  }
  return node.agentFor(cli, pid, { proof: true });
}

/** Hook-side decision for `agentmbx hook permission --cli <cli>`. `output` is what the hook prints on stdout. */
export function decidePermission(input: unknown, cli: string, lookup: Lookup, o: { node: MbxNode; pid?: number }): Decision {
  try {
    if (!input || typeof input !== "object" || Array.isArray(input)) return NONE;
    const i = input as Record<string, unknown>;
    const s = (k: string) => (typeof i[k] === "string" && i[k] ? i[k] as string : undefined);
    const tool = s("tool_name");
    const sessionId = s("session_id");
    if (!tool || INTERACTIVE.has(tool)) return NONE;
    if (cli !== "claude" && cli !== "codex" && cli !== "kimi") return NONE;
    if (s("hook_event_name") && s("hook_event_name") !== "PermissionRequest") return NONE;
    const cwd = s("cwd") ?? null;
    const agent = resolveAgent(o.node, cli, sessionId, cwd ?? "", o.pid);
    if (!agent) return NONE;
    const p = lookup(agent, { cwd });
    if (!p?.ok) return NONE;
    if (cli === "kimi") { // Kimi's hook can't decide; the approval goes through the kimi web API (approveKimi), which audits
      const approval = s("id");
      return sessionId && approval ? { allow: true, agent, tool, policy_id: p.policy_id, output: "", cwd, kimi: { session_id: sessionId, approval_id: approval } } : NONE;
    }
    o.node.store.audit("yolo_allow", { agent, cli, tool, policy_id: p.policy_id ?? null });
    return { allow: true, agent, tool, policy_id: p.policy_id,
      output: JSON.stringify({ hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "allow" } } }) };
  } catch { return NONE; }
}

// ---- Kimi: `kimi web` approvals API ------------------------------------------------------------
type Fetch = typeof fetch;
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A live local Kimi server (kimi web / kimi rc / desktop) from $KIMI_CODE_HOME/server/instances, with its bearer token. */
export function kimiServer(kimiHome = process.env.KIMI_CODE_HOME || join(homedir(), ".kimi-code"), isAlive = alive): { url: string; token: string } | null {
  try {
    const dir = join(kimiHome, "server/instances"), tokenFile = join(kimiHome, "server.token");
    if (!existsSync(dir) || !existsSync(tokenFile)) return null;
    const token = readFileSync(tokenFile, "utf8").trim();
    for (const f of readdirSync(dir).filter((f) => f.endsWith(".json"))) {
      const j = JSON.parse(readFileSync(join(dir, f), "utf8")) as { pid?: number; host?: string; port?: number };
      if (typeof j.pid === "number" && typeof j.port === "number" && isAlive(j.pid)) return { url: `http://${j.host || "127.0.0.1"}:${j.port}`, token };
    }
  } catch { /* none */ }
  return null;
}

/**
 * Approve one Kimi approval through the server that hosts the session. Kimi fires the PermissionRequest hook just before it
 * registers the approval, so poll the pending list briefly. A session the server doesn't host (a plain TUI) answers with an
 * error or never lists it: give up, and the user answers the prompt as usual.
 */
export async function approveKimi(node: MbxNode, d: Decision, o: { server?: { url: string; token: string } | null; fetch?: Fetch; waitMs?: number; recheck?: () => boolean } = {}): Promise<boolean> {
  if (!d.allow || !d.kimi) return false;
  const srv = o.server === undefined ? kimiServer() : o.server;
  if (!srv) return false;
  const f = o.fetch ?? fetch, { session_id, approval_id } = d.kimi;
  const headers = { authorization: `Bearer ${srv.token}`, "content-type": "application/json" };
  const base = `${srv.url}/api/v1/sessions/${encodeURIComponent(session_id)}/approvals`;
  const deadline = Date.now() + (o.waitMs ?? 5000);
  try {
    for (;;) {
      const res = await f(`${base}?status=pending`, { headers, signal: AbortSignal.timeout(3000) });
      const j = await res.json().catch(() => null) as { code?: number; data?: { items?: { approval_id: string }[] } } | null;
      if (!res.ok || j?.code !== 0) return false;
      if (j.data?.items?.some((a) => a.approval_id === approval_id)) break;
      if (Date.now() >= deadline) return false;
      await sleep(250);
    }
    if (o.recheck && !o.recheck()) return false; // revoked or expired while we waited
    const res = await f(`${base}/${encodeURIComponent(approval_id)}`, { method: "POST", headers, body: JSON.stringify({ decision: "approved" }), signal: AbortSignal.timeout(3000) });
    const j = await res.json().catch(() => null) as { code?: number } | null;
    if (!res.ok || j?.code !== 0) return false;
    node.store.audit("yolo_allow", { agent: d.agent, cli: "kimi", tool: d.tool, policy_id: d.policy_id ?? null, via: "kimi web" });
    return true;
  } catch { return false; }
}

// ---- OpenCode: the daemon answers through the service API ---------------------------------------
export interface OpencodeSvc { url: string; auth: string }

/**
 * One daemon pass: for each OpenCode session bound to an agent whose policy is active, reply "once" to its pending
 * permission requests. Agents without a policy cost no request at all. A binding with a real session id (ses_…) is
 * queried directly; an MCP-only binding (mcp-<pid>) falls back to the pending requests of its directory, skipping any
 * request from a session bound to another agent, or from an unbound session whose folder name is another agent's.
 */
export async function opencodePermissionPass(node: MbxNode, lookup: Lookup, svc: () => Promise<OpencodeSvc | null>, f: Fetch = fetch): Promise<number> {
  const db = node.store.db;
  const rows = (db.prepare("SELECT agent, session_id, cwd, pid, pid_start, updated_at FROM sessions WHERE cli='opencode' ORDER BY updated_at DESC LIMIT 50").all() as
    { agent: string; session_id: string; cwd: string | null; pid: number | null; pid_start: string | null; updated_at: string }[])
    .filter((r) => r.pid && node.sameSession(r.pid, r, { proof: true })); // only bindings proven to be a live OpenCode process
  const covered = rows.map((r) => ({ ...r, p: safeLookup(lookup, r.agent, r.cwd) })).filter((r) => r.p.ok && (r.session_id.startsWith("ses") || r.cwd));
  if (!covered.length) return 0;
  const s = await svc();
  if (!s) return 0;
  const headers = { "content-type": "application/json", ...(s.auth ? { authorization: s.auth } : {}) };
  const owner = (sid: string) => (db.prepare("SELECT agent FROM sessions WHERE cli='opencode' AND session_id=?").get(sid) as { agent: string } | undefined)?.agent;
  const done = new Set<string>();
  let n = 0;
  for (const r of covered) {
    try {
      const direct = r.session_id.startsWith("ses");
      const url = direct ? `${s.url}/api/session/${encodeURIComponent(r.session_id)}/permission`
        : `${s.url}/api/permission/request?${new URLSearchParams({ "location[directory]": r.cwd! })}`;
      const res = await f(url, { headers, signal: AbortSignal.timeout(5000) });
      if (!res.ok) continue;
      const j = await res.json() as { data?: { id: string; sessionID: string; action: string }[] };
      for (const q of j.data ?? []) {
        if (!q.id?.startsWith("per") || !q.sessionID?.startsWith("ses") || done.has(q.id)) continue;
        if (direct ? q.sessionID !== r.session_id : (owner(q.sessionID) ?? agentName(r.cwd!, "opencode")) !== r.agent) continue;
        done.add(q.id);
        if (!safeLookup(lookup, r.agent, r.cwd).ok) break; // re-check right before approving: revocation wins
        const rep = await f(`${s.url}/api/session/${encodeURIComponent(q.sessionID)}/permission/${encodeURIComponent(q.id)}/reply`,
          { method: "POST", headers, body: JSON.stringify({ decision: "once" }), signal: AbortSignal.timeout(5000) });
        if (!rep.ok) continue;
        node.store.audit("yolo_allow", { agent: r.agent, cli: "opencode", tool: q.action, policy_id: r.p.policy_id ?? null });
        n++;
      }
    } catch { /* next session */ }
  }
  return n;
}
const safeLookup = (lookup: Lookup, agent: string, cwd?: string | null) => { try { return lookup(agent, { cwd }) ?? { ok: false }; } catch { return { ok: false }; } };
