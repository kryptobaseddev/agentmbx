// YOLO (docs/POLICY.md §5): a CLI session auto-approves its own permission prompts while an owner policy grants its
// agent the `permissions` class. Anything else (no policy, unknown agent, malformed input, any error) returns no
// decision, so the CLI shows its normal prompt. Per-CLI mechanisms and evidence: docs/RESEARCH.md "Permission hooks per CLI".
import { agentName } from "./mcp.js";
import { kimiServer } from "./kimi-web.js";
import { LIVE_AGENT_MS } from "./node.js";
import { fingerprint } from "./crypto.js";
import { IdentityLeases } from "./identity-leases.js";
export { kimiServer } from "./kimi-web.js";
/** Tools that collect an answer from the user rather than ask for permission: never auto-approved. */
const INTERACTIVE = new Set(["AskUserQuestion", "ExitPlanMode"]);
const NONE = { allow: false, output: "" };
/**
 * The agent a hook invocation belongs to: only a binding recorded for this very CLI process (pid + start time) counts.
 * No verified binding means no decision (fail closed): a stale row, a reused PID or a guessed name never gets YOLO.
 */
function resolveBinding(node, cli, sessionId, pid) {
    if (!pid)
        return null;
    if (sessionId) {
        const r = node.store.db.prepare("SELECT * FROM sessions WHERE cli=? AND session_id=?").get(cli, sessionId);
        if (r)
            return r.pid === pid && node.sameSession(pid, r, { proof: true }) ? r : null;
    }
    const agent = node.agentFor(cli, pid, { proof: true });
    if (!agent)
        return null;
    return node.store.db.prepare("SELECT * FROM sessions WHERE cli=? AND pid=? AND agent=? ORDER BY (session_key IS NOT NULL) DESC,updated_at DESC").all(cli, pid, agent)
        .find(r => node.sameSession(pid, r, { proof: true })) ?? null;
}
/** Check the exact captured binding and generation together. This authorizes only synchronous local work. */
function withAuthority(node, authority, operation) {
    try {
        const old = authority.binding;
        if (!old.pid || !node.sameSession(old.pid, old, { proof: true }))
            return null;
        const observedAt = performance.now();
        const checked = () => {
            const row = node.store.db.prepare("SELECT * FROM sessions WHERE cli=? AND session_id=?").get(old.cli, old.session_id);
            if (!row || !row.pid || performance.now() - observedAt > 5000
                || !Number.isFinite(Date.parse(row.updated_at)) || Date.now() - Date.parse(row.updated_at) > LIVE_AGENT_MS
                || ["agent", "pid", "pid_start", "session_key", "cwd"].some(k => row[k] !== old[k]))
                return null;
            const lease = node.store.db.prepare("SELECT * FROM identity_leases WHERE name=?").get(row.agent);
            if (authority.leaseToken === null)
                return lease ? null : operation(); // legacy evidence cannot acquire a new lease implicitly
            if (!lease || lease.token !== authority.leaseToken || lease.cli !== row.cli || !row.session_key || fingerprint(row.session_key) !== lease.key_fp)
                return null;
            return operation();
        };
        // Let the lease guard gather process evidence before opening the transaction. Session and
        // policy checks still execute under that same guard, without a nested process inspection.
        return authority.leaseToken === null ? node.store.tx(checked)
            : new IdentityLeases(node.store).withHeld(old.agent, authority.leaseToken, checked);
    }
    catch {
        return null;
    }
}
function captureAuthority(node, binding) {
    const lease = node.store.db.prepare("SELECT token FROM identity_leases WHERE name=?").get(binding.agent);
    const authority = { binding, leaseToken: lease?.token ?? null };
    return withAuthority(node, authority, () => authority);
}
export function resolveAgent(node, cli, sessionId, _cwd, pid) {
    try {
        const binding = resolveBinding(node, cli, sessionId, pid);
        return binding && captureAuthority(node, binding) ? binding.agent : null;
    }
    catch {
        return null;
    }
}
/** Hook-side decision for `agentmbx hook permission --cli <cli>`. `output` is what the hook prints on stdout. */
export function decidePermission(input, cli, lookup, o) {
    try {
        if (!input || typeof input !== "object" || Array.isArray(input))
            return NONE;
        const i = input;
        const s = (k) => (typeof i[k] === "string" && i[k] ? i[k] : undefined);
        const tool = s("tool_name");
        const sessionId = s("session_id");
        if (!tool || INTERACTIVE.has(tool))
            return NONE;
        if (cli !== "claude" && cli !== "codex" && cli !== "kimi")
            return NONE;
        if (s("hook_event_name") && s("hook_event_name") !== "PermissionRequest")
            return NONE;
        const cwd = s("cwd") ?? null;
        const binding = resolveBinding(o.node, cli, sessionId, o.pid);
        const authority = binding && captureAuthority(o.node, binding);
        if (!authority)
            return NONE;
        // A hosted provider process may serve other, not-yet-bound threads. Its sole current
        // mailbox is not evidence that an unknown request belongs to that mailbox.
        if (authority.leaseToken && (cli === "codex" || cli === "kimi") && sessionId !== authority.binding.session_id)
            return NONE;
        const agent = authority.binding.agent;
        return withAuthority(o.node, authority, () => {
            const p = lookup(agent, { cwd });
            if (!p?.ok)
                return NONE;
            if (cli === "kimi") { // Kimi's hook can't decide; the approval goes through the kimi web API (approveKimi), which audits
                const approval = s("id");
                return sessionId && approval ? { allow: true, agent, tool, policy_id: p.policy_id, output: "", cwd, authority, kimi: { session_id: sessionId, approval_id: approval } } : NONE;
            }
            o.node.store.audit("yolo_allow", { agent, cli, tool, policy_id: p.policy_id ?? null });
            return { allow: true, agent, tool, policy_id: p.policy_id,
                output: JSON.stringify({ hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "allow" } } }) };
        }) ?? NONE;
    }
    catch {
        return NONE;
    }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/**
 * Approve one Kimi approval through the server that hosts the session. Kimi fires the PermissionRequest hook just before it
 * registers the approval, so poll the pending list briefly. A session the server doesn't host (a plain TUI) answers with an
 * error or never lists it: give up, and the user answers the prompt as usual.
 */
export async function approveKimi(node, d, o = {}) {
    if (!d.allow || !d.kimi || !d.authority || !withAuthority(node, d.authority, () => true))
        return false;
    const srv = o.server === undefined ? kimiServer() : o.server;
    if (!srv)
        return false;
    const f = o.fetch ?? fetch, { session_id, approval_id } = d.kimi;
    const headers = { authorization: `Bearer ${srv.token}`, "content-type": "application/json" };
    const base = `${srv.url}/api/v1/sessions/${encodeURIComponent(session_id)}/approvals`;
    const deadline = Date.now() + (o.waitMs ?? 5000);
    try {
        for (;;) {
            const res = await f(`${base}?status=pending`, { headers, signal: AbortSignal.timeout(3000) });
            const j = await res.json().catch(() => null);
            if (!res.ok || j?.code !== 0)
                return false;
            if (j.data?.items?.some((a) => a.approval_id === approval_id))
                break;
            if (Date.now() >= deadline)
                return false;
            await sleep(250);
        }
        if (!withAuthority(node, d.authority, () => !o.recheck || o.recheck()))
            return false;
        // Provider APIs cannot consume a lease token: this is a fresh dispatch check, not revocation
        // of a request already in flight. Never hold a SQLite transaction across network I/O.
        const res = await f(`${base}/${encodeURIComponent(approval_id)}`, { method: "POST", headers, body: JSON.stringify({ decision: "approved" }), signal: AbortSignal.timeout(3000) });
        const j = await res.json().catch(() => null);
        if (!res.ok || j?.code !== 0)
            return false;
        node.store.audit("yolo_allow", { agent: d.agent, cli: "kimi", tool: d.tool, policy_id: d.policy_id ?? null, via: "kimi web" });
        return true;
    }
    catch {
        return false;
    }
}
/**
 * One daemon pass: for each OpenCode session bound to an agent whose policy is active, reply "once" to its pending
 * permission requests. Agents without a policy cost no request at all. A binding with a real session id (ses_…) is
 * queried directly; an MCP-only binding (mcp-<pid>) falls back to the pending requests of its directory, skipping any
 * request from a session bound to another agent, or from an unbound session whose folder name is another agent's.
 */
export async function opencodePermissionPass(node, lookup, svc, f = fetch) {
    const db = node.store.db;
    const rows = db.prepare("SELECT * FROM sessions WHERE cli='opencode' ORDER BY updated_at DESC LIMIT 50").all()
        .filter((r) => r.pid && node.sameSession(r.pid, r, { proof: true })); // only bindings proven to be a live OpenCode process
    const covered = rows.flatMap(r => {
        const authority = captureAuthority(node, r);
        if (!authority || (authority.leaseToken && !r.session_id.startsWith("ses")))
            return [];
        const p = safeLookup(lookup, r.agent, r.cwd);
        return p.ok && (r.session_id.startsWith("ses") || r.cwd) ? [{ ...r, p, authority }] : [];
    });
    if (!covered.length)
        return 0;
    const s = await svc();
    if (!s)
        return 0;
    const headers = { "content-type": "application/json", ...(s.auth ? { authorization: s.auth } : {}) };
    const owner = (sid) => db.prepare("SELECT agent FROM sessions WHERE cli='opencode' AND session_id=?").get(sid)?.agent;
    const done = new Set();
    let n = 0;
    for (const r of covered) {
        try {
            const direct = r.session_id.startsWith("ses");
            const url = direct ? `${s.url}/api/session/${encodeURIComponent(r.session_id)}/permission`
                : `${s.url}/api/permission/request?${new URLSearchParams({ "location[directory]": r.cwd })}`;
            const res = await f(url, { headers, signal: AbortSignal.timeout(5000) });
            if (!res.ok)
                continue;
            const j = await res.json();
            for (const q of j.data ?? []) {
                if (!q.id?.startsWith("per") || !q.sessionID?.startsWith("ses") || done.has(q.id))
                    continue;
                if (direct ? q.sessionID !== r.session_id : (owner(q.sessionID) ?? agentName(r.cwd, "opencode")) !== r.agent)
                    continue;
                done.add(q.id);
                if (!withAuthority(node, r.authority, () => safeLookup(lookup, r.agent, r.cwd).ok))
                    break;
                const rep = await f(`${s.url}/api/session/${encodeURIComponent(q.sessionID)}/permission/${encodeURIComponent(q.id)}/reply`, { method: "POST", headers, body: JSON.stringify({ decision: "once" }), signal: AbortSignal.timeout(5000) });
                if (!rep.ok)
                    continue;
                node.store.audit("yolo_allow", { agent: r.agent, cli: "opencode", tool: q.action, policy_id: r.p.policy_id ?? null });
                n++;
            }
        }
        catch { /* next session */ }
    }
    return n;
}
const safeLookup = (lookup, agent, cwd) => { try {
    return lookup(agent, { cwd }) ?? { ok: false };
}
catch {
    return { ok: false };
} };
