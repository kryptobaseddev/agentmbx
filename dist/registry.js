// Chosen identities (T204, v0.5.2 R1). A mailbox name exists because an agent, its user or its launch config chose it,
// with a role: AgentMBX never invents one. A session resumes the identity it held before (same provider session id), or
// stays unbound until it claims one from its project's list or registers a new one. The registry records each chosen
// identity's role and which project folders it has worked in, so a restarted agent can find its own mailbox by role.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
/** Roles are short labels ("lead", "reviewer", "lab-staff"), never sentences. */
export const ROLE_RE = /^[a-z0-9][a-z0-9 _-]{0,39}$/i;
export const UNSPECIFIED_ROLE = "unspecified";
/**
 * Names older versions minted on their own: `<name>-mcp-<16 hex>`, `<name>-<10 hex>` (per-session hash) and
 * `<name>-<pid>`. Used only to suggest registering a real name; mail in such mailboxes is still ordinary mail.
 */
export const AUTO_NAME_RE = /-(?:mcp-[0-9a-f]{16}|[0-9a-f]{10}|\d{4,7})$/;
/** The project a session works in: the realpath of its folder, none for the home folder or /. */
export function projectOf(dir) {
    if (resolve(dir) === resolve(homedir()) || resolve(dir) === "/")
        return undefined;
    try {
        return realpathSync(dir);
    }
    catch {
        return resolve(dir);
    }
}
/**
 * The same repository has a different folder on every host, so a project's mail is matched across paired hosts by its
 * git origin, normalized to `host/path` without scheme, credentials or `.git` (T219): `git@github.com:org/repo.git` and
 * `https://github.com/org/repo` are both `github.com/org/repo`. None for a folder without an origin or with a
 * local-path origin (which means nothing on another host). A key is cached for the process (a later `git remote
 * set-url` shows after a restart); "no key" is cached for a minute only, so a `git` call that timed out on a loaded host
 * heals without a restart.
 */
const keys = new Map();
const NO_KEY_TTL_MS = 60_000;
export function normalizeRemote(url) {
    const u = url.trim();
    const scp = /^(?:[^@/\s]+@)?([A-Za-z0-9.-]+):(?!\/\/)(.+)$/.exec(u); // git@host:org/repo
    let host, path;
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(u)) {
        let parsed;
        try {
            parsed = new URL(u);
        }
        catch {
            return undefined;
        }
        if (parsed.protocol === "file:" || !parsed.hostname)
            return undefined;
        host = parsed.hostname;
        path = parsed.pathname;
    }
    else if (scp && !u.startsWith("/") && !/^[A-Za-z]:[\\/]/.test(u)) {
        host = scp[1];
        path = scp[2];
    }
    else
        return undefined;
    path = path.replace(/^\/+|\/+$/g, "").replace(/\.git$/i, "");
    if (!path)
        return undefined;
    const key = `${host}/${path}`.toLowerCase();
    // A public forge's org/repo is not private. A self-hosted remote's path can name a machine, a user and a folder
    // (nas.local/volume1/homes/keaton/git/foo), and the key travels in envelopes and to the cloud read model: those are
    // reduced to a digest that both hosts still compute identically, so cross-host matching keeps working.
    return FORGES.has(host.toLowerCase()) ? key.slice(0, 300) : `h:${createHash("sha256").update(key).digest("hex").slice(0, 32)}`;
}
const FORGES = new Set(["github.com", "gitlab.com", "bitbucket.org", "codeberg.org", "git.sr.ht", "dev.azure.com", "ssh.dev.azure.com", "gitee.com"]);
export function projectKey(project, now = Date.now()) {
    if (!project)
        return undefined;
    const hit = keys.get(project);
    if (hit && (hit.key !== undefined || now - hit.at < NO_KEY_TTL_MS))
        return hit.key;
    let key;
    try {
        key = normalizeRemote(execFileSync("git", ["-C", project, "config", "--get", "remote.origin.url"], { encoding: "utf8", timeout: 2_000, stdio: ["ignore", "pipe", "ignore"] }));
    }
    catch {
        key = undefined;
    } // not a repository, no origin, no git, or a timeout under load
    keys.set(project, { key, at: now });
    return key;
}
export function registeredIdentity(store, name) {
    return store.db.prepare("SELECT name,role,description,registered_at,registered_by FROM identities WHERE name=?").get(name) ?? null;
}
/** Record (or update the role and description of) a chosen identity. */
export function registerIdentity(store, o, now = new Date()) {
    const role = o.role.trim();
    if (!ROLE_RE.test(role))
        throw Object.assign(new Error(`invalid role "${o.role}": 1-40 characters, letters, digits, space, - or _`), { code: "IDENTITY_ROLE_INVALID" });
    store.db.prepare(`INSERT INTO identities (name,role,description,registered_at,registered_by) VALUES (?,?,?,?,?)
    ON CONFLICT(name) DO UPDATE SET role=excluded.role, description=COALESCE(excluded.description, identities.description)`)
        .run(o.name, role, o.description ?? null, now.toISOString(), o.by ?? null);
    store.audit("identity.register", { name: o.name, role, by: o.by ?? null });
    return registeredIdentity(store, o.name);
}
/** Move a registration with its project history to a new name (rename). */
export function renameRegistration(store, from, to) {
    store.db.prepare("UPDATE OR REPLACE identities SET name=? WHERE name=?").run(to, from);
    store.db.prepare("UPDATE OR IGNORE identity_projects SET name=? WHERE name=?").run(to, from);
    store.db.prepare("DELETE FROM identity_projects WHERE name=?").run(from);
}
/** Remember that `name` works in `project` (every bind, so a restarted agent finds its mailbox from its folder). */
export function noteProject(store, name, project, now = new Date()) {
    if (!project)
        return;
    const at = now.toISOString();
    store.db.prepare(`INSERT INTO identity_projects (name,project,first_seen,last_seen) VALUES (?,?,?,?)
    ON CONFLICT(name,project) DO UPDATE SET last_seen=excluded.last_seen`).run(name, project, at, at);
}
/** Identities recorded in identity_projects for this folder. A session cwd is not a binding:
 *  a shared host process records its own folder for every persona it serves (T515). */
export function projectIdentities(store, project) {
    const out = new Set();
    for (const r of store.db.prepare("SELECT name FROM identity_projects WHERE project=?").all(project))
        out.add(r.name);
    return out;
}
/** Bindings older than another project for the same identity. One project stays. A tie for the
 *  newest last_seen stays. Read-only: the dry run of `agentmbx identity bindings`. */
export function staleProjectBindings(store) {
    const rows = store.db.prepare("SELECT name, project, last_seen FROM identity_projects ORDER BY name, last_seen DESC, project").all();
    const out = [];
    let i = 0;
    while (i < rows.length) {
        let j = i + 1;
        while (j < rows.length && rows[j].name === rows[i].name)
            j++;
        const group = rows.slice(i, j);
        const newest = group[0].last_seen;
        const keeper = group.find((r) => r.last_seen === newest);
        for (const r of group) {
            if (r.last_seen < newest)
                out.push({
                    name: r.name, project: r.project, last_seen: r.last_seen,
                    kept_project: keeper.project, kept_last_seen: keeper.last_seen,
                });
        }
        i = j;
    }
    return out;
}
/** Delete bindings from a dry-run list. A row whose last_seen changed after the list was built is left. */
export function removeStaleProjectBindings(store, rows) {
    return store.tx(() => {
        const del = store.db.prepare("DELETE FROM identity_projects WHERE name=? AND project=? AND last_seen=?");
        let n = 0;
        for (const r of rows)
            n += Number(del.run(r.name, r.project, r.last_seen).changes);
        if (n)
            store.audit("project.binding.removed", {
                removed: n,
                bindings: rows.slice(0, 50).map((r) => ({ name: r.name, project: r.project, kept: r.kept_project })),
            });
        return n;
    });
}
export function identityProjects(store, name) {
    return store.db.prepare("SELECT project FROM identity_projects WHERE name=? ORDER BY last_seen DESC").all(name).map(r => r.project);
}
/**
 * Register what older versions already treated as chosen: names with a role, and the targets of a rename. Idempotent;
 * runs at store open. Auto-generated names stay unregistered (still claimable with a role).
 */
export function backfillRegistry(store, host) {
    const at = new Date().toISOString();
    store.db.prepare(`INSERT OR IGNORE INTO identities (name,role,description,registered_at,registered_by)
    SELECT name, role, description, ?, 'backfill' FROM agents WHERE host=? AND role IS NOT NULL AND role<>''`).run(at, host);
    for (const r of store.db.prepare("SELECT detail FROM audit WHERE event='agent.renamed'").all()) {
        let to;
        try {
            to = JSON.parse(r.detail)?.to;
        }
        catch {
            continue;
        }
        if (typeof to !== "string" || AUTO_NAME_RE.test(to))
            continue;
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
export const sessionHintKey = (cli, ppid) => `session-hint:${cli}:${ppid}`;
const HINT_TTL_MS = 24 * 3_600_000;
export function recordSessionHint(store, cli, ppid, parentStart, sessionId) {
    if (!parentStart)
        return;
    store.set(sessionHintKey(cli, ppid), JSON.stringify({ session_id: sessionId, parent_start: parentStart, at: Date.now() }));
}
export function sessionHint(store, cli, ppid, parentStart) {
    try {
        const h = JSON.parse(store.get(sessionHintKey(cli, ppid)) ?? "null");
        if (!h || !parentStart || h.parent_start !== parentStart || typeof h.session_id !== "string" || !(Date.now() - h.at < HINT_TTL_MS))
            return null;
        return h.session_id.startsWith("mcp-") ? null : h.session_id;
    }
    catch {
        return null;
    }
}
/** A hosted conversation already linked to its own mbx server (bind ticket used): its hooks guide instead of re-ticketing. */
export const linkedKey = (cli, sessionId) => `linked:${cli}:${sessionId}`;
