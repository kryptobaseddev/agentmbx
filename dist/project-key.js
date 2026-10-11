// One project key (T543). Everything that decides "which project is this folder" lives here, so the lead record,
// identity_projects, the ledger, the probe and the cross-host envelope key cannot drift apart.
//
//   key          the LOCAL key: the CLEO project id when the folder has one, otherwise the folder itself. Keys
//                identity_projects and project_leads, so two checkouts of one CLEO project are one project.
//   crossHostKey the key that travels: the CLEO id, else the normalized git origin, else none. Never a path: a folder
//                means nothing on another host, and sync deliberately sends no paths.
//   gitKey       the normalized git origin alone (T219). It is what the cloud read model accepts (PROJECT_KEY_RE), so
//                `projectKey()` keeps its name, signature and meaning for sync-daemon and everything else that uses it.
//
// The CLEO id is `.cleo/project-id` (committed, write-once, ADR-094: `#` comment lines, then the id), or the `id` of
// `.cleo/project.json` when that file is absent. It is searched upward from the folder, because a session's folder is
// its cwd and not the repository root, and stops before $HOME, at a repository boundary (a `.git` entry), and at `/`.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
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
// ---- the CLEO project id (T543) --------------------------------------------------------------------------------------
/** A CLEO project id is a UUID or a shorter hex handle (cleocode's is 12 hex characters). Anything that could be a path,
 *  contain whitespace or a separator is refused: the key is stored, signed over and sent on the wire. */
export const PROJECT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{5,79}$/;
/** The id in a `.cleo/project-id` file: the first line that is neither blank nor a `#` comment. Null when it is not an id. */
export function parseProjectIdFile(text) {
    for (const raw of text.replace(/^\uFEFF/, "").split(/\r?\n/)) {
        const line = raw.trim();
        if (!line || line.startsWith("#"))
            continue;
        return PROJECT_ID_RE.test(line) ? line : null;
    }
    return null;
}
/** The `id` of a `.cleo/project.json`. Null when the file is not JSON or the id is not an id. */
export function parseProjectJsonId(text) {
    try {
        const id = JSON.parse(text.replace(/^\uFEFF/, ""))?.id;
        return typeof id === "string" && PROJECT_ID_RE.test(id) ? id : null;
    }
    catch {
        return null;
    }
}
const MAX_WALK = 16, MAX_FILE_BYTES = 8_192;
const readSmall = (path) => {
    try {
        const st = statSync(path);
        return st.isFile() && st.size <= MAX_FILE_BYTES ? readFileSync(path, "utf8") : null;
    }
    catch {
        return null;
    }
};
function findCleoId(folder) {
    if (!isAbsolute(folder))
        return null; // a folder string from another host or a hand-written record is never searched relative to this process's cwd
    const home = resolve(homedir());
    let dir = resolve(folder);
    for (let i = 0; i < MAX_WALK; i++) {
        if (dir === home || dir === dirname(dir))
            return null; // never the home folder (a global ~/.cleo is not a project), never /
        const file = readSmall(join(dir, ".cleo", "project-id")), fromFile = file === null ? null : parseProjectIdFile(file);
        if (fromFile)
            return { id: fromFile, root: dir, source: "cleo-project-id" };
        const json = readSmall(join(dir, ".cleo", "project.json")), fromJson = json === null ? null : parseProjectJsonId(json);
        if (fromJson)
            return { id: fromJson, root: dir, source: "cleo-project-json" };
        if (existsSync(join(dir, ".git")))
            return null; // a repository boundary: a nested repository does not inherit its parent's id
        dir = dirname(dir);
    }
    return null;
}
// An id is write-once, so a hit is cached for the process; "none" is cached for a minute (the file may be created, or the
// disk briefly unavailable), like projectKey's git lookup.
const cleoIds = new Map();
function cleoOf(folder, now) {
    const hit = cleoIds.get(folder);
    if (hit && (hit.found || now - hit.at < NO_KEY_TTL_MS))
        return hit.found;
    const found = findCleoId(folder);
    cleoIds.set(folder, { found, at: now });
    return found;
}
/** The one answer to "which project is this folder": see the header. Never throws. */
export function resolveProject(folder, now = Date.now()) {
    const cleo = cleoOf(folder, now);
    const cleoId = cleo?.id ?? null;
    return {
        folder, key: cleoId ?? folder, source: cleo ? cleo.source : "folder", cleoId, cleoRoot: cleo?.root ?? null,
        get gitKey() { return projectKey(folder, now); },
        get crossHostKey() { return cleoId ?? projectKey(folder, now); },
    };
}
/** The cross-host key of a folder, none for no folder. What `meta.project_key` carries. */
export function crossHostKey(folder, now = Date.now()) {
    return folder ? resolveProject(folder, now).crossHostKey : undefined;
}
