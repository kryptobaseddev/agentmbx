// T330: every bind records its folder's git repository (worktree top, shared repository root, credential-free origin,
// default branch), worktrees of one repository share their mailboxes in mbx_identity list, and the association reaches the
// Cloud only as the allowlisted project key, even after the worktree is gone. No credential is ever stored or synced.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { listIdentityStatus } from "../src/identity-status.ts";
import { MbxNode } from "../src/node.ts";
import { noteProject, registerIdentity } from "../src/registry.ts";
import { _resetRepoAssociationCache, readRepoAssociation, recordRepoAssociation, repoAssociation, sanitizeRemoteUrl } from "../src/repo-association.ts";
import { loadSyncSnapshot } from "../src/sync-daemon.ts";
import { projectSync } from "../src/sync-projection.ts";

const SECRET = "ghp_T330SECRETtoken";
const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
  env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" } });

/** A repository with a token in its origin, a commit, origin/HEAD -> main, and a second worktree; a foreign repository; a plain folder. */
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "mbx-t330-")));
  const repo = join(root, "widget"), wt = join(root, "widget-wt"), other = join(root, "gadget"), plain = join(root, "plain"), clone = join(root, "widget-clone");
  for (const d of [repo, other, plain, clone]) mkdirSync(d);
  git(repo, "init", "-q", "-b", "main");
  git(repo, "remote", "add", "origin", `https://x-access-token:${SECRET}@github.com/Acme/Widget.git?ref=1#frag`);
  git(repo, "commit", "-q", "--allow-empty", "-m", "init");
  git(repo, "update-ref", "refs/remotes/origin/main", "HEAD");
  git(repo, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main");
  git(repo, "worktree", "add", "-q", "-b", "feature", wt);
  mkdirSync(join(wt, "src"));
  git(other, "init", "-q", "-b", "main");
  git(other, "remote", "add", "origin", "git@github.com:acme/gadget.git");
  // A second clone of the same remote, written the other way: one project with the first (D2a).
  git(clone, "init", "-q", "-b", "main");
  git(clone, "remote", "add", "origin", "git@github.com:acme/widget.git");
  _resetRepoAssociationCache();
  return { root, repo, wt, other, plain, clone };
}

test("the sanitizer removes userinfo from URL and scp forms, and any query or fragment", () => {
  assert.equal(sanitizeRemoteUrl(`https://user:${SECRET}@github.com/org/repo.git?token=${SECRET}#x`), "https://github.com/org/repo.git");
  assert.equal(sanitizeRemoteUrl(`https://${SECRET}@gitlab.example.com:8443/team/repo`), "https://gitlab.example.com:8443/team/repo");
  assert.equal(sanitizeRemoteUrl(`ssh://git:${SECRET}@nas.local:2222/volume1/repo.git`), "ssh://nas.local:2222/volume1/repo.git");
  assert.equal(sanitizeRemoteUrl("git@github.com:org/repo.git"), "github.com:org/repo.git");
  assert.equal(sanitizeRemoteUrl(`${SECRET}@nas.local:git/repo.git`), "nas.local:git/repo.git");
  assert.equal(sanitizeRemoteUrl("/srv/git/repo.git"), "/srv/git/repo.git");
  assert.equal(sanitizeRemoteUrl(""), null);
  assert.equal(sanitizeRemoteUrl("has space@host:x"), null);
});

test("AC1/AC2: a repository folder, a subfolder of a worktree and a plain folder; worktrees share the repository; a remote change shows after the cache minute", (t) => {
  const f = fixture(); t.after(() => rmSync(f.root, { recursive: true, force: true }));
  const main = readRepoAssociation(f.repo);
  assert.deepEqual(main, { dir: f.repo, git_root: f.repo, repo_root: f.repo, remote_url: "https://github.com/Acme/Widget.git",
    remote_key: "github.com/acme/widget", default_branch: "main" });
  const inWt = readRepoAssociation(join(f.wt, "src"));
  assert.equal(inWt.git_root, f.wt, "the worktree's own top folder");
  assert.equal(inWt.repo_root, f.repo, "stable across worktrees: the shared repository root");
  assert.equal(inWt.remote_key, main.remote_key); assert.equal(inWt.default_branch, "main");
  assert.deepEqual(readRepoAssociation(f.plain), { dir: f.plain, git_root: null, repo_root: null, remote_url: null, remote_key: null, default_branch: null });
  assert.equal(readRepoAssociation("relative/dir").git_root, null, "a relative folder is never searched");

  const home = mkdtempSync(join(tmpdir(), "mbx-t330-home-")), node = new MbxNode(home, { host: "alpha" });
  t.after(() => { node.close(); rmSync(home, { recursive: true, force: true }); });
  const row = (dir: string) => ({ ...node.store.db.prepare("SELECT git_root,repo_root,remote_url,remote_key,default_branch,updated_at FROM project_repos WHERE dir=?").get(dir) });
  const t0 = Date.parse("2026-10-14T15:00:00Z");
  recordRepoAssociation(node.store, f.repo, t0);
  const first = row(f.repo);
  assert.equal(first.remote_key, "github.com/acme/widget");
  git(f.repo, "remote", "set-url", "origin", "git@github.com:acme/widget-renamed.git");
  recordRepoAssociation(node.store, f.repo, t0 + 30_000);
  assert.deepEqual(row(f.repo), first, "within the cache minute nothing is re-read or rewritten");
  recordRepoAssociation(node.store, f.repo, t0 + 61_000);
  assert.equal(row(f.repo).remote_key, "github.com/acme/widget-renamed");
  assert.equal(row(f.repo).remote_url, "github.com:acme/widget-renamed.git");
  assert.equal(row(f.repo).updated_at, new Date(t0 + 61_000).toISOString());
  recordRepoAssociation(node.store, f.repo, t0 + 200_000);
  assert.equal(row(f.repo).updated_at, new Date(t0 + 61_000).toISOString(), "an unchanged association is not rewritten");
});

test("AC1: every bind records its folder (a repository or not) without creating a membership", (t) => {
  const f = fixture(); t.after(() => rmSync(f.root, { recursive: true, force: true }));
  const home = mkdtempSync(join(tmpdir(), "mbx-t330-home-")), node = new MbxNode(home, { host: "alpha" });
  t.after(() => { node.close(); rmSync(home, { recursive: true, force: true }); });
  node.bindSession({ agent: "orbit-dev", cli: "claude", session_id: "s-wt", cwd: join(f.wt, "src"), pid: process.pid });
  node.bindSession({ agent: "plain-dev", cli: "claude", session_id: "s-plain", cwd: f.plain, pid: process.pid });
  const rows: Record<string, Record<string, unknown>> = Object.fromEntries((node.store.db.prepare("SELECT * FROM project_repos").all() as Record<string, unknown>[]).map((r) => [r.dir as string, { ...r }]));
  assert.equal(rows[join(f.wt, "src")].repo_root, f.repo);
  assert.equal(rows[join(f.wt, "src")].git_root, f.wt);
  assert.deepEqual([rows[f.plain].git_root, rows[f.plain].remote_url], [null, null]);
  assert.equal(node.store.db.prepare("SELECT COUNT(*) n FROM identity_projects").get()!.n, 0, "a bind is not a membership (T538)");
});

test("AC3: mbx_identity list from one worktree shows the mailboxes registered in another worktree of the same repository", async (t) => {
  const f = fixture(); t.after(() => rmSync(f.root, { recursive: true, force: true }));
  const home = mkdtempSync(join(tmpdir(), "mbx-t330-home-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  { const n = new MbxNode(home, { host: "alpha" }); n.close(); }
  const mcp = async (cwd: string) => {
    const client = new Client({ name: "t330", version: "1" });
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [resolve("bin/agentmbx.js"), "mcp"], cwd,
      env: { ...process.env, AGENTMBX_DEV: "1", MBX_HOME: home, MBX_CLI: "hermes", MBX_AGENT: "", MBX_NO_DESKTOP: "1" } as Record<string, string> }));
    return client;
  };
  const a = await mcp(f.repo);
  const reg = await a.callTool({ name: "mbx_identity", arguments: { action: "register", name: "widget-dev", role: "developer" } });
  assert.notEqual(reg.isError, true, JSON.stringify(reg.content));
  await a.close();
  // A foreign repository's member and a plain folder's member must not join the worktree's listing.
  const n = new MbxNode(home, { host: "alpha" });
  registerIdentity(n.store, { name: "gadget-dev", role: "developer" }); noteProject(n.store, "gadget-dev", f.other, true);
  registerIdentity(n.store, { name: "plain-dev", role: "developer" }); noteProject(n.store, "plain-dev", f.plain, true);
  registerIdentity(n.store, { name: "widget-clone-dev", role: "developer" }); noteProject(n.store, "widget-clone-dev", f.clone, true);
  n.close();

  const b = await mcp(f.wt);
  t.after(() => b.close());
  const list = (await b.callTool({ name: "mbx_identity", arguments: { action: "list" } })).structuredContent as { project: string; identities: { name: string; repo?: { repo_root: string; remote_url: string; default_branch: string } }[] };
  assert.equal(list.project, f.wt);
  assert.deepEqual(list.identities.map((i) => i.name), ["widget-clone-dev", "widget-dev"]);
  assert.deepEqual(list.identities[1].repo, { git_root: f.repo, repo_root: f.repo, remote_url: "https://github.com/Acme/Widget.git", default_branch: "main" });
  // The plain folder still lists only its own member, by folder as before.
  assert.deepEqual(listIdentityStatus(home, { project: f.plain }).identities.map((i) => i.name), ["plain-dev"]);
});

test("AC4: the synced project key comes from the recorded association, survives a removed worktree, and no credential is stored or synced", (t) => {
  const f = fixture(); t.after(() => rmSync(f.root, { recursive: true, force: true }));
  const home = mkdtempSync(join(tmpdir(), "mbx-t330-home-")), node = new MbxNode(home, { host: "alpha" });
  t.after(() => { node.close(); rmSync(home, { recursive: true, force: true }); });
  registerIdentity(node.store, { name: "widget-dev", role: "developer" });
  noteProject(node.store, "widget-dev", f.wt, true); // the explicit membership records the folder's association too
  git(f.repo, "worktree", "remove", "--force", f.wt);
  _resetRepoAssociationCache();
  assert.equal(repoAssociation(f.wt).git_root, null, "the folder is gone");
  // projectKeyOf answers nothing: the key can only come from the stored association.
  const source = loadSyncSnapshot(node, { contractAllowsProjectPaths: false }, () => undefined);
  assert.deepEqual(source.agents.find((a) => a.name === "widget-dev")?.project_keys, ["github.com/acme/widget"]);
  const projected = projectSync({ ...source, now: new Date().toISOString(), seq: 1, full: true, contract: 2, contractAllowsProjectPaths: false, contractAllowsProjectLeads: false, sentReceipts: [] });
  assert.ok(projected.ok);
  assert.deepEqual((projected.batch.agents as { upsert: { name: string; project_keys: string[] }[] }).upsert.find((a) => a.name === "widget-dev")?.project_keys, ["github.com/acme/widget"]);
  for (const text of [projected.body, JSON.stringify(source)]) {
    assert.ok(!text.includes(SECRET) && !text.includes(f.repo) && !text.includes("Widget.git") && !text.includes("refs/"), "no credential, path, raw URL or branch leaves the host");
  }
  const dump = JSON.stringify(["project_repos", "identity_projects", "sessions", "audit", "kv"].map((tb) => node.store.db.prepare(`SELECT * FROM ${tb}`).all()));
  assert.ok(!dump.includes(SECRET) && !dump.includes("x-access-token"), "the token is stored nowhere");
});
