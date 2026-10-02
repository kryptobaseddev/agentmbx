// Chosen identities (T204, v0.5.2 R1). A mailbox name exists because an agent, its user or its launch config chose it,
// with a role: AgentMBX never invents one. A session resumes the identity it held before (same provider session id), or
// stays unbound until it claims one from its project's list or registers a new one. The registry records each chosen
// identity's role and which project folders it has worked in, so a restarted agent can find its own mailbox by role.
import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import type { Store } from "./store.ts";

export interface RegisteredIdentity { name: string; role: string; description: string | null; registered_at: string; registered_by: string | null }

/** Roles are short labels ("lead", "reviewer", "lab-staff"), never sentences. */
export const ROLE_RE = /^[a-z0-9][a-z0-9 _-]{0,39}$/i;
export const UNSPECIFIED_ROLE = "unspecified";

/**
 * Names older versions minted on their own: `<name>-mcp-<16 hex>`, `<name>-<10 hex>` (per-session hash) and
 * `<name>-<pid>`. Used only to suggest registering a real name; mail in such mailboxes is still ordinary mail.
 */
export const AUTO_NAME_RE = /-(?:mcp-[0-9a-f]{16}|[0-9a-f]{10}|\d{4,7})$/;

/** The project a session works in: the realpath of its folder, none for the home folder or /. */
export function projectOf(dir: string): string | undefined {
  if (resolve(dir) === resolve(homedir()) || resolve(dir) === "/") return undefined;
  try { return realpathSync(dir); } catch { return resolve(dir); }
}

/**
 * The same repository has a different folder on every host, so a project's mail is matched across paired hosts by its
 * git origin, normalized to `host/path` without scheme, credentials or `.git` (T219): `git@github.com:org/repo.git` and
 * `https://github.com/org/repo` are both `github.com/org/repo`. None for a folder without an origin or with a
 * local-path origin (which means nothing on another host). Cached per process.
 */
const keys = new Map<string, string | undefined>();
export function normalizeRemote(url: string): string | undefined {
  const u = url.trim();
  const scp = /^(?:[^@/\s]+@)?([A-Za-z0-9.-]+):(?!\/\/)(.+)$/.exec(u); // git@host:org/repo
  let host: string, path: string;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(u)) {
    let parsed: URL; try { parsed = new URL(u); } catch { return undefined; }
    if (parsed.protocol === "file:" || !parsed.hostname) return undefined;
    host = parsed.hostname; path = parsed.pathname;
  } else if (scp && !u.startsWith("/") && !/^[A-Za-z]:[\\/]/.test(u)) { host = scp[1]; path = scp[2]; }
  else return undefined;
  path = path.replace(/^\/+|\/+$/g, "").replace(/\.git$/i, "");
  return path ? `${host}/${path}`.toLowerCase().slice(0, 300) : undefined;
}
export function projectKey(project: string | undefined): string | undefined {
  if (!project) return undefined;
  if (keys.has(project)) return keys.get(project);
  let key: string | undefined;
  try {
    key = normalizeRemote(execFileSync("git", ["-C", project, "config", "--get", "remote.origin.url"], { encoding: "utf8", timeout: 2_000, stdio: ["ignore", "pipe", "ignore"] }));
  } catch { key = undefined; } // not a repository, no origin, or no git
  keys.set(project, key);
  return key;
}

export function registeredIdentity(store: Store, name: string): RegisteredIdentity | null {
  return (store.db.prepare("SELECT name,role,description,registered_at,registered_by FROM identities WHERE name=?").get(name) as RegisteredIdentity | undefined) ?? null;
}

/** Record (or update the role and description of) a chosen identity. */
export function registerIdentity(store: Store, o: { name: string; role: string; description?: string | null; by?: string | null }, now = new Date()): RegisteredIdentity {
  const role = o.role.trim();
  if (!ROLE_RE.test(role)) throw Object.assign(new Error(`invalid role "${o.role}": 1-40 characters, letters, digits, space, - or _`), { code: "IDENTITY_ROLE_INVALID" });
  store.db.prepare(`INSERT INTO identities (name,role,description,registered_at,registered_by) VALUES (?,?,?,?,?)
    ON CONFLICT(name) DO UPDATE SET role=excluded.role, description=COALESCE(excluded.description, identities.description)`)
    .run(o.name, role, o.description ?? null, now.toISOString(), o.by ?? null);
  store.audit("identity.register", { name: o.name, role, by: o.by ?? null });
  return registeredIdentity(store, o.name)!;
}

/** Move a registration with its project history to a new name (rename). */
export function renameRegistration(store: Store, from: string, to: string) {
  store.db.prepare("UPDATE OR REPLACE identities SET name=? WHERE name=?").run(to, from);
  store.db.prepare("UPDATE OR IGNORE identity_projects SET name=? WHERE name=?").run(to, from);
  store.db.prepare("DELETE FROM identity_projects WHERE name=?").run(from);
}

/** Remember that `name` works in `project` (every bind, so a restarted agent finds its mailbox from its folder). */
export function noteProject(store: Store, name: string, project: string | undefined, now = new Date()) {
  if (!project) return;
  const at = now.toISOString();
  store.db.prepare(`INSERT INTO identity_projects (name,project,first_seen,last_seen) VALUES (?,?,?,?)
    ON CONFLICT(name,project) DO UPDATE SET last_seen=excluded.last_seen`).run(name, project, at, at);
}

/** Identities associated with a project: recorded binds, plus legacy session rows in that folder. */
export function projectIdentities(store: Store, project: string): Set<string> {
  const out = new Set<string>();
  for (const r of store.db.prepare("SELECT name FROM identity_projects WHERE project=?").all(project) as { name: string }[]) out.add(r.name);
  for (const r of store.db.prepare("SELECT DISTINCT agent FROM sessions WHERE cwd=?").all(project) as { agent: string }[]) out.add(r.agent);
  return out;
}

export function identityProjects(store: Store, name: string): string[] {
  return (store.db.prepare("SELECT project FROM identity_projects WHERE name=? ORDER BY last_seen DESC").all(name) as { project: string }[]).map(r => r.project);
}

/**
 * Register what older versions already treated as chosen: names with a role, and the targets of a rename. Idempotent;
 * runs at store open. Auto-generated names stay unregistered (still claimable with a role).
 */
export function backfillRegistry(store: Store, host: string) {
  const at = new Date().toISOString();
  store.db.prepare(`INSERT OR IGNORE INTO identities (name,role,description,registered_at,registered_by)
    SELECT name, role, description, ?, 'backfill' FROM agents WHERE host=? AND role IS NOT NULL AND role<>''`).run(at, host);
  for (const r of store.db.prepare("SELECT detail FROM audit WHERE event='agent.renamed'").all() as { detail: string }[]) {
    let to: unknown; try { to = JSON.parse(r.detail)?.to; } catch { continue; }
    if (typeof to !== "string" || AUTO_NAME_RE.test(to)) continue;
    store.db.prepare("INSERT OR IGNORE INTO identities (name,role,description,registered_at,registered_by) VALUES (?,?,NULL,?,'backfill')").run(to, UNSPECIFIED_ROLE, at);
  }
  for (const r of store.db.prepare("SELECT DISTINCT agent, cwd FROM sessions WHERE cwd IS NOT NULL").all() as { agent: string; cwd: string }[])
    store.db.prepare("INSERT OR IGNORE INTO identity_projects (name,project,first_seen,last_seen) VALUES (?,?,?,?)").run(r.agent, r.cwd, at, at);
}

/**
 * A provider's hooks know their session id; an MCP server started with a provisional id (terminal Kimi, a Claude session
 * whose session file wasn't written yet) does not. A hook that finds no binding records its session id under its parent
 * process (the provider), with that process's birth time, so the server can resume the identity that session held. It
 * names a session and grants nothing: the lease claim still decides. Shared and hosted processes never use hints.
 */
export const sessionHintKey = (cli: string, ppid: number) => `session-hint:${cli}:${ppid}`;
const HINT_TTL_MS = 24 * 3_600_000;
export function recordSessionHint(store: Store, cli: string, ppid: number, parentStart: string | null, sessionId: string) {
  if (!parentStart) return;
  store.set(sessionHintKey(cli, ppid), JSON.stringify({ session_id: sessionId, parent_start: parentStart, at: Date.now() }));
}
export function sessionHint(store: Store, cli: string, ppid: number, parentStart: string | null): string | null {
  try {
    const h = JSON.parse(store.get(sessionHintKey(cli, ppid)) ?? "null");
    if (!h || !parentStart || h.parent_start !== parentStart || typeof h.session_id !== "string" || !(Date.now() - h.at < HINT_TTL_MS)) return null;
    return h.session_id.startsWith("mcp-") ? null : h.session_id;
  } catch { return null; }
}

/** A hosted conversation already linked to its own mbx server (bind ticket used): its hooks guide instead of re-ticketing. */
export const linkedKey = (cli: string, sessionId: string) => `linked:${cli}:${sessionId}`;
