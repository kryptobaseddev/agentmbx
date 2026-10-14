// Directory → git repository association (T330). Every bind records, for the folder it runs in, the repository that folder
// belongs to: this worktree's top folder, the repository root that every worktree of one clone shares, the origin URL with
// any credential removed, its normalized key, and the default branch. Null fields for a folder that is not in a repository.
//
// It reads the `.git` files directly and never runs git: binds happen in hooks and on every MCP heartbeat, which keep a
// process-spawn budget (T341). A result is cached per folder for a minute, so a changed root or remote shows within that.
//
// What leaves the host is only the normalized remote key (sync `agents[].project_keys`, contract 2): never a path, a raw
// URL or the branch. The table lives here, not in the store schema, so it is additive for every older runtime (T330 D1a).
import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { normalizeRemote } from "./project-key.ts";
import type { Store } from "./store.ts";

export interface RepoAssociation {
  /** The folder asked about. */
  dir: string;
  /** The top folder of the worktree (or checkout) the folder is in. */
  git_root: string | null;
  /** The repository root shared by every worktree of one clone: the folder that holds the common `.git`. */
  repo_root: string | null;
  /** The origin URL without userinfo, query or fragment. Stored on this host only. */
  remote_url: string | null;
  /** normalizeRemote(origin): the credential-free key the cloud accepts (forge `host/org/repo`, else an `h:` digest). */
  remote_key: string | null;
  /** The branch `refs/remotes/origin/HEAD` points to. */
  default_branch: string | null;
}

const MAX_WALK = 64, MAX_FILE_BYTES = 256 * 1024, TTL_MS = 60_000;
const readSmall = (path: string): string | null => {
  try { const st = statSync(path); return st.isFile() && st.size <= MAX_FILE_BYTES ? readFileSync(path, "utf8") : null; } catch { return null; }
};

/** The origin URL with every credential removed: userinfo in both URL (`https://tok@host/…`) and scp (`user@host:path`) forms,
 *  and any query or fragment. A local path stays as it is. Null for an empty or unparseable value. */
export function sanitizeRemoteUrl(raw: string): string | null {
  const u = raw.trim();
  if (!u || /[\s\u0000-\u001f]/.test(u)) return null;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(u)) {
    let url: URL; try { url = new URL(u); } catch { return null; }
    url.username = ""; url.password = ""; url.search = ""; url.hash = "";
    return url.toString();
  }
  const scp = /^(?:[^@/]+@)?([A-Za-z0-9.-]+):(?!\/\/)(.+)$/.exec(u);
  if (scp && !/^[A-Za-z]:[\\/]/.test(u)) return `${scp[1]}:${scp[2]}`;
  return u.includes("@") ? null : u; // a local path; anything else carrying an "@" is not trusted to be credential-free
}

/** The origin URL in a git config file: the last `url` of the `[remote "origin"]` section. */
function originUrl(config: string): string | null {
  let inOrigin = false, url: string | null = null;
  for (const raw of config.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith("[")) { inOrigin = /^\[\s*remote\s+"origin"\s*\]$/.test(line); continue; }
    if (!inOrigin) continue;
    const m = /^url\s*=\s*(.*)$/i.exec(line);
    if (m) url = m[1].replace(/^"(.*)"$/, "$1").trim();
  }
  return url;
}

/** The `.git` entry for a folder: walk up to the first folder that has one. A `.git` file (worktree, submodule) points at
 *  the real git dir; `commondir` in that git dir names the repository's shared one. */
function gitDirs(folder: string): { top: string; gitDir: string; commonDir: string } | null {
  let dir = resolve(folder);
  for (let i = 0; i < MAX_WALK; i++) {
    const entry = join(dir, ".git");
    let st; try { st = statSync(entry); } catch { st = null; }
    if (st?.isDirectory()) return { top: dir, gitDir: entry, commonDir: common(entry) };
    if (st?.isFile()) {
      const m = /^gitdir:\s*(.+)$/m.exec(readSmall(entry) ?? "");
      if (!m) return null;
      const gitDir = resolve(dir, m[1].trim());
      return existsSync(gitDir) ? { top: dir, gitDir, commonDir: common(gitDir) } : null;
    }
    if (dir === dirname(dir)) return null;
    dir = dirname(dir);
  }
  return null;
}
function common(gitDir: string): string {
  const rel = readSmall(join(gitDir, "commondir"))?.trim();
  return rel ? resolve(gitDir, rel) : gitDir;
}

/** The association of one folder, read from disk. Never throws. */
export function readRepoAssociation(folder: string): RepoAssociation {
  const none: RepoAssociation = { dir: folder, git_root: null, repo_root: null, remote_url: null, remote_key: null, default_branch: null };
  if (!isAbsolute(folder)) return none;
  try {
    const found = gitDirs(folder);
    if (!found) return none;
    // A non-bare repository keeps its git dir at <root>/.git; a bare one is its own root.
    const repo_root = basename(found.commonDir) === ".git" ? dirname(found.commonDir) : found.commonDir;
    const raw = originUrl(readSmall(join(found.commonDir, "config")) ?? "");
    const head = /^ref:\s*refs\/remotes\/origin\/(.+)$/m.exec(readSmall(join(found.commonDir, "refs", "remotes", "origin", "HEAD")) ?? "");
    return { dir: folder, git_root: found.top, repo_root, remote_url: raw ? sanitizeRemoteUrl(raw) : null,
      remote_key: raw ? normalizeRemote(raw) ?? null : null, default_branch: head ? head[1].trim() : null };
  } catch { return none; }
}

const cache = new Map<string, { value: RepoAssociation; at: number }>();
/** readRepoAssociation, cached per folder for a minute. */
export function repoAssociation(folder: string, now = Date.now()): RepoAssociation {
  const hit = cache.get(folder);
  if (hit && now - hit.at >= 0 && now - hit.at < TTL_MS) return hit.value;
  const value = readRepoAssociation(folder);
  cache.set(folder, { value, at: now });
  return value;
}

/** The repository a folder groups with (T330 D2a): its remote key when it has an origin, else its repository root. */
export const repoIdentity = (a: Pick<RepoAssociation, "remote_key" | "repo_root"> | null | undefined): string | null =>
  a?.remote_key ?? a?.repo_root ?? null;

const ensured = new WeakSet<object>();
export const REPO_TABLE = `CREATE TABLE IF NOT EXISTS project_repos (
  dir TEXT PRIMARY KEY, git_root TEXT, repo_root TEXT, remote_url TEXT, remote_key TEXT, default_branch TEXT, updated_at TEXT NOT NULL)`;
/** Create the table once per store handle. Additive: older runtimes never read it. */
export function ensureRepoTable(store: Pick<Store, "db">): void {
  if (ensured.has(store.db)) return;
  store.db.exec(REPO_TABLE);
  ensured.add(store.db);
}

const FIELDS = ["git_root", "repo_root", "remote_url", "remote_key", "default_branch"] as const;
/** Record the association of `dir` (an absolute folder). Writes only when a field changed. Returns what was read. */
export function recordRepoAssociation(store: Pick<Store, "db">, dir: string | undefined | null, now = Date.now()): RepoAssociation | null {
  if (!dir || !isAbsolute(dir)) return null;
  const a = repoAssociation(dir, now);
  ensureRepoTable(store);
  const prev = store.db.prepare(`SELECT ${FIELDS.join(",")} FROM project_repos WHERE dir=?`).get(dir) as Record<string, string | null> | undefined;
  if (prev && FIELDS.every((f) => (prev[f] ?? null) === a[f])) return a;
  store.db.prepare(`INSERT INTO project_repos (dir,${FIELDS.join(",")},updated_at) VALUES (?,?,?,?,?,?,?)
    ON CONFLICT(dir) DO UPDATE SET ${FIELDS.map((f) => `${f}=excluded.${f}`).join(",")}, updated_at=excluded.updated_at`)
    .run(dir, a.git_root, a.repo_root, a.remote_url, a.remote_key, a.default_branch, new Date(now).toISOString());
  return a;
}

/** Stored associations by folder, from a store that may predate the table (read-only callers). */
export function storedRepoAssociations(db: Store["db"]): Map<string, RepoAssociation> {
  const out = new Map<string, RepoAssociation>();
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='project_repos'").get()) return out;
  for (const r of db.prepare(`SELECT dir,${FIELDS.join(",")} FROM project_repos`).all() as unknown as RepoAssociation[]) out.set(r.dir, { ...r });
  return out;
}

/** For tests: forget cached reads. */
export function _resetRepoAssociationCache(): void { cache.clear(); }
