// Chosen identities (T204, v0.5.2 R1). A mailbox name exists because an agent, its user or its launch config chose it,
// with a role: AgentMBX never invents one. A session resumes the identity it held before (same provider session id), or
// stays unbound until it claims one from its project's list or registers a new one. The registry records each chosen
// identity's role and which project folders it has worked in, so a restarted agent can find its own mailbox by role.
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import type { Store } from "./store.ts";
import { resolveProject } from "./project-key.ts";

// The git-origin key and the CLEO project key live in project-key.ts (T543); these names keep working from here.
export { crossHostKey, normalizeRemote, projectKey, resolveProject } from "./project-key.ts";

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

/** Remember that `name` is a member of `project` — but ONLY on an explicit claim or registration in
 *  that project (T538). A session's cwd is not a binding: a persona served by a shared host process,
 *  or an agent that happens to start in another project's folder, must not become a member merely by
 *  where its process ran — that cwd upsert re-added foreign personas to the members surface as fast
 *  as T515's prune removed them. Callers pass explicit=true only from the mbx_identity claim/register
 *  path; every other call is a cwd observation and writes nothing. */
export function noteProject(store: Store, name: string, project: string | undefined, explicit: boolean, now = new Date()) {
  if (!project || !explicit) return;
  const at = now.toISOString();
  store.db.prepare(`INSERT INTO identity_projects (name,project,first_seen,last_seen) VALUES (?,?,?,?)
    ON CONFLICT(name,project) DO UPDATE SET last_seen=excluded.last_seen`).run(name, project, at, at);
}

/** Identities recorded in identity_projects for this folder. A session cwd is not a binding:
 *  a shared host process records its own folder for every persona it serves (T515). */
export function projectIdentities(store: Store, project: string): Set<string> {
  const out = new Set<string>();
  for (const r of store.db.prepare("SELECT name FROM identity_projects WHERE project=?").all(project) as { name: string }[]) out.add(r.name);
  return out;
}

export interface StaleProjectBinding {
  name: string;
  project: string;
  last_seen: string;
  kept_project: string;
  kept_last_seen: string;
}

/** Bindings older than another project for the same identity. One project stays. A tie for the
 *  newest last_seen stays. Read-only: the dry run of `agentmbx identity bindings`. */
export function staleProjectBindings(store: Store): StaleProjectBinding[] {
  const rows = store.db.prepare(
    "SELECT name, project, last_seen FROM identity_projects ORDER BY name, last_seen DESC, project",
  ).all() as { name: string; project: string; last_seen: string }[];
  const out: StaleProjectBinding[] = [];
  let i = 0;
  while (i < rows.length) {
    let j = i + 1;
    while (j < rows.length && rows[j].name === rows[i].name) j++;
    const group = rows.slice(i, j);
    const newest = group[0].last_seen;
    const keeper = group.find((r) => r.last_seen === newest)!;
    for (const r of group) {
      if (r.last_seen < newest) out.push({
        name: r.name, project: r.project, last_seen: r.last_seen,
        kept_project: keeper.project, kept_last_seen: keeper.last_seen,
      });
    }
    i = j;
  }
  return out;
}

/** Delete bindings from a dry-run list. A row whose last_seen changed after the list was built is left. */
export function removeStaleProjectBindings(store: Store, rows: readonly StaleProjectBinding[]): number {
  return store.tx(() => {
    const del = store.db.prepare("DELETE FROM identity_projects WHERE name=? AND project=? AND last_seen=?");
    let n = 0;
    for (const r of rows) n += Number(del.run(r.name, r.project, r.last_seen).changes);
    if (n) store.audit("project.binding.removed", {
      removed: n,
      bindings: rows.slice(0, 50).map((r) => ({ name: r.name, project: r.project, kept: r.kept_project })),
    });
    return n;
  });
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
  // Session cwd is not copied (T515). Doing so made a shared host process's folder a permanent
  // membership for every persona that process had served.
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
