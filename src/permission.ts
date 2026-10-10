// POLICY.md §5: untainted sessions may use explicit YOLO or the bounded outward-reversible path.
// Unknown authority, command or provider state returns no decision, preserving the normal prompt.
import { kimiServer } from "./kimi-web.ts";
import { LIVE_AGENT_MS, type MbxNode } from "./node.ts";
import { fingerprint } from "./crypto.ts";
import { IdentityLeases, type IdentityLease } from "./identity-leases.ts";
import { opencodeHostOf, type OpencodeHost } from "./opencode-provider.ts";
import { sessionUntainted } from "./session-taint.ts";
import { checkOutwardReversible, parseOutwardReversible, type OutwardReversible } from "./outward-reversible.ts";
import { realpathSync } from "node:fs";

export { kimiServer } from "./kimi-web.ts";

/** Check one requested class under the session's project scope (policy.ts hasClass). */
export type PermissionClass = "permissions" | "outward-reversible";
export type Lookup = (agent: string, ctx?: { cwd?: string | null; class?: PermissionClass }) => { ok: boolean; policy_id?: string; exp?: string | null };
interface PermissionBinding { agent: string; cli: string; session_id: string; pid: number | null; pid_start: string | null; session_key: string | null; updated_at: string; cwd: string | null }
interface PermissionAuthority { binding: PermissionBinding; leaseToken: string }
export interface Decision { allow: boolean; agent?: string; tool?: string; policy_id?: string; class?: PermissionClass; intent?: OutwardReversible; output: string; cwd?: string | null; authority?: PermissionAuthority; kimi?: { session_id: string; approval_id: string } }

/** Tools that collect an answer from the user rather than ask for permission: never auto-approved. */
const INTERACTIVE = new Set(["AskUserQuestion", "ExitPlanMode"]);
const NONE: Decision = { allow: false, output: "" };

/**
 * The agent a hook invocation belongs to: only a binding recorded for this very CLI process (pid + start time) counts.
 * No verified binding means no decision (fail closed): a stale row, a reused PID or a guessed name never gets YOLO.
 */
function resolveBinding(node: MbxNode, cli: string, sessionId: string | undefined, pid?: number): PermissionBinding | null {
  if (!pid) return null;
  if (sessionId) {
    const r = node.store.db.prepare("SELECT * FROM sessions WHERE cli=? AND session_id=?").get(cli, sessionId) as PermissionBinding | undefined;
    if (r) return r.pid === pid && node.sameSession(pid, r, { proof: true }) ? r : null;
  }
  const agent = node.agentFor(cli, pid, { proof: true });
  if (!agent) return null;
  return (node.store.db.prepare("SELECT * FROM sessions WHERE cli=? AND pid=? AND agent=? ORDER BY (session_key IS NOT NULL) DESC,updated_at DESC").all(cli, pid, agent) as unknown as PermissionBinding[])
    .find(r => node.sameSession(pid, r, { proof: true })) ?? null;
}

/** Check the exact captured binding and generation together. This authorizes only synchronous local work. */
function withAuthority<T>(node: MbxNode, authority: PermissionAuthority, operation: () => T): T | null {
  try {
    const old = authority.binding;
    if (!old.pid || !node.sameSession(old.pid, old, { proof: true })) return null;
    const observedAt = performance.now();
    const checked = () => {
      const row = node.store.db.prepare("SELECT * FROM sessions WHERE cli=? AND session_id=?").get(old.cli, old.session_id) as PermissionBinding | undefined;
      if (!row || !row.pid || performance.now() - observedAt > 5000
        || !Number.isFinite(Date.parse(row.updated_at)) || Date.now() - Date.parse(row.updated_at) > LIVE_AGENT_MS
        || ["agent", "pid", "pid_start", "session_key", "cwd"].some(k => row[k as keyof PermissionBinding] !== old[k as keyof PermissionBinding])) return null;
      const lease = node.store.db.prepare("SELECT * FROM identity_leases WHERE name=?").get(row.agent) as IdentityLease | undefined;
      if (!lease || lease.token !== authority.leaseToken || lease.cli !== row.cli || !row.session_key || fingerprint(row.session_key) !== lease.key_fp) return null;
      return operation();
    };
    // Let the lease guard gather process evidence before opening the transaction. Session and
    // policy checks still execute under that same guard, without a nested process inspection.
    return new IdentityLeases(node.store).withHeld(old.agent, authority.leaseToken, checked);
  } catch { return null; }
}

function captureAuthority(node: MbxNode, binding: PermissionBinding): PermissionAuthority | null {
  const lease = node.store.db.prepare("SELECT token FROM identity_leases WHERE name=?").get(binding.agent) as { token: string } | undefined;
  if (!lease) return null;
  const authority = { binding, leaseToken: lease.token };
  return withAuthority(node, authority, () => authority);
}

export function resolveAgent(node: MbxNode, cli: string, sessionId: string | undefined, _cwd: string, pid?: number): string | null {
  try {
    const binding = resolveBinding(node, cli, sessionId, pid);
    return binding && captureAuthority(node, binding) ? binding.agent : null;
  } catch { return null; }
}

/** Hook-side decision for `agentmbx hook permission --cli <cli>`. `output` is what the hook prints on stdout. */
export async function decidePermission(input: unknown, cli: string, lookup: Lookup, o: { node: MbxNode; pid?: number; preflight?: typeof checkOutwardReversible }): Promise<Decision> {
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
    const binding = resolveBinding(o.node, cli, sessionId, o.pid);
    const authority = binding && captureAuthority(o.node, binding);
    if (!authority) return NONE;
    // A hosted provider process may serve other, not-yet-bound threads. Its sole current
    // mailbox is not evidence that an unknown request belongs to that mailbox.
    if ((cli === "codex" || cli === "kimi") && sessionId !== authority.binding.session_id) return NONE;
    const agent = authority.binding.agent;
    const clean = () => sessionUntainted(o.node.store, authority.binding.cli, authority.binding.session_id);
    let cls: PermissionClass = "permissions", intent: OutwardReversible | undefined;
    const yolo = withAuthority(o.node, authority, () => clean() && lookup(agent, { cwd, class: cls })?.ok);
    if (!yolo) {
      cls = "outward-reversible";
      if (sessionId !== authority.binding.session_id) return NONE;
      if (!cwd || !authority.binding.cwd || realpathSync(cwd) !== realpathSync(authority.binding.cwd)) return NONE;
      const covered = withAuthority(o.node, authority, () => clean() && lookup(agent, { cwd, class: cls })?.ok);
      if (!covered) return NONE;
      const ti = i.tool_input;
      if (!ti || typeof ti !== "object" || Array.isArray(ti)) return NONE;
      const args = ti as Record<string, unknown>;
      if (!((cli === "claude" || cli === "codex") && tool === "Bash" || cli === "kimi" && tool === "Shell")
        || typeof args.command !== "string" || Object.keys(args).some(k => /^(?:env|cwd|workdir|shell|executable)$/.test(k))) return NONE;
      const parsed = parseOutwardReversible(args.command);
      if (!parsed || !await (o.preflight ?? checkOutwardReversible)(parsed, cwd)) return NONE;
      intent = parsed;
    }
    return withAuthority(o.node, authority, () => {
      const p = lookup(agent, { cwd, class: cls });
      if (!clean() || !p?.ok) return NONE;
      if (cli === "kimi") { // Kimi's hook can't decide; the approval goes through the kimi web API (approveKimi), which audits
        const approval = s("id");
        return sessionId && approval ? { allow: true, agent, tool, policy_id: p.policy_id, class: cls, intent, output: "", cwd, authority, kimi: { session_id: sessionId, approval_id: approval } } : NONE;
      }
      o.node.store.audit("yolo_allow", { agent, cli, tool, policy_id: p.policy_id ?? null, ...(intent ? { class: cls, action: intent.kind } : {}) });
      return { allow: true, agent, tool, policy_id: p.policy_id, class: cls,
        output: JSON.stringify({ hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "allow" } } }) };
    }) ?? NONE;
  } catch { return NONE; }
}

// ---- Kimi: `kimi web` approvals API ------------------------------------------------------------
type Fetch = typeof fetch;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Approve one Kimi approval through the server that hosts the session. Kimi fires the PermissionRequest hook just before it
 * registers the approval, so poll the pending list briefly. A session the server doesn't host (a plain TUI) answers with an
 * error or never lists it: give up, and the user answers the prompt as usual.
 */
export async function approveKimi(node: MbxNode, d: Decision, o: { server?: { url: string; token: string } | null; fetch?: Fetch; waitMs?: number; recheck?: () => boolean } = {}): Promise<boolean> {
  const clean = () => !!d.authority && sessionUntainted(node.store, d.authority.binding.cli, d.authority.binding.session_id);
  if (!d.allow || !d.kimi || !d.authority || !withAuthority(node, d.authority, clean)) return false;
  if (d.intent && !o.recheck) return false;
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
    if (d.intent && (!d.cwd || !await checkOutwardReversible(d.intent, d.cwd))) return false;
    if (!withAuthority(node, d.authority, () => clean() && (!o.recheck || o.recheck()))) return false;
    // Provider APIs cannot consume a lease token: this is a fresh dispatch check, not revocation
    // of a request already in flight. Never hold a SQLite transaction across network I/O.
    const res = await f(`${base}/${encodeURIComponent(approval_id)}`, { method: "POST", headers, body: JSON.stringify({ decision: "approved" }), signal: AbortSignal.timeout(3000) });
    const j = await res.json().catch(() => null) as { code?: number } | null;
    if (!res.ok || j?.code !== 0) return false;
    node.store.audit("yolo_allow", { agent: d.agent, cli: "kimi", tool: d.tool, policy_id: d.policy_id ?? null, via: "kimi web", ...(d.intent ? { class: d.class, action: d.intent.kind } : {}) });
    return true;
  } catch { return false; }
}

// ---- OpenCode: the daemon answers through the service API ---------------------------------------
export interface OpencodeSvc { url: string; auth: string }

/**
 * One daemon pass: for each service-hosted OpenCode session bound to an agent whose policy is active, reply "once"
 * to its pending permission requests. A standalone session is answered by the plugin in that serve (T521). An
 * unknown host is skipped. Neither calls the shared service. Only a current lease and an exact provider session
 * binding may authorize a request. Provisional or legacy bindings never infer ownership from a project directory.
 */
export async function opencodePermissionPass(node: MbxNode, lookup: Lookup, svc: () => Promise<OpencodeSvc | null>, f: Fetch = fetch, host: (pid: number | null | undefined) => OpencodeHost = opencodeHostOf): Promise<number> {
  const db = node.store.db;
  const rows = (db.prepare("SELECT * FROM sessions WHERE cli='opencode' ORDER BY updated_at DESC LIMIT 50").all() as unknown as PermissionBinding[])
    .filter((r) => r.pid && node.sameSession(r.pid, r, { proof: true })); // only bindings proven to be a live OpenCode process
  const covered = rows.flatMap(r => {
    const authority = captureAuthority(node, r);
    if (!authority || !r.session_id.startsWith("ses") || !sessionUntainted(node.store, r.cli, r.session_id)) return [];
    const p = safeLookup(lookup, r.agent, r.cwd);
    return p.ok ? [{ ...r, p, authority }] : [];
  }).filter((r) => host(r.pid) === "service");
  if (!covered.length) return 0;
  const s = await svc();
  if (!s) return 0;
  const headers = { "content-type": "application/json", ...(s.auth ? { authorization: s.auth } : {}) };
  const done = new Set<string>();
  let n = 0;
  for (const r of covered) {
    try {
      const url = `${s.url}/api/session/${encodeURIComponent(r.session_id)}/permission`;
      const res = await f(url, { headers, signal: AbortSignal.timeout(5000) });
      if (!res.ok) continue;
      const j = await res.json() as { data?: { id: string; sessionID: string; action: string }[] };
      for (const q of j.data ?? []) {
        if (!q.id?.startsWith("per") || !q.sessionID?.startsWith("ses") || done.has(q.id)) continue;
        if (q.sessionID !== r.session_id) continue;
        done.add(q.id);
        if (!withAuthority(node, r.authority, () => sessionUntainted(node.store, r.cli, r.session_id) && safeLookup(lookup, r.agent, r.cwd).ok)) break;
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
const safeLookup = (lookup: Lookup, agent: string, cwd?: string | null) => { try { return lookup(agent, { cwd, class: "permissions" }) ?? { ok: false }; } catch { return { ok: false }; } };
