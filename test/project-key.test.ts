// T543 AC1: one helper decides which project a folder is. The CLEO id (.cleo/project-id, else .cleo/project.json) is the
// key; the folder is the local fallback; the cross-host key is the id, else the git origin, else nothing (never a path).
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { crossHostKey, parseProjectIdFile, parseProjectJsonId, projectKey, resolveProject } from "../src/project-key.ts";
import * as registry from "../src/registry.ts";

const UUID = "071b70b3-551d-44bb-b993-1e84bfa2fe09";
const HEADER = "# CLEO portable project identity (write-once; ADR-094, T12325).\n# Commit this file.\n";

function tree(t: { after: (fn: () => unknown) => void }) {
  const root = mkdtempSync(join(tmpdir(), "mbx-pk-"));
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  const dir = (...p: string[]) => { const d = join(root, ...p); mkdirSync(d, { recursive: true }); return d; };
  const cleo = (d: string, files: { "project-id"?: string; "project.json"?: string }) => {
    mkdirSync(join(d, ".cleo"), { recursive: true });
    for (const [name, body] of Object.entries(files)) writeFileSync(join(d, ".cleo", name), body);
    return d;
  };
  const git = (d: string, origin?: string) => {
    execFileSync("git", ["init", "-q", d]);
    if (origin) execFileSync("git", ["-C", d, "remote", "add", "origin", origin]);
    return d;
  };
  return { root, dir, cleo, git };
}

test("parseProjectIdFile: the first non-comment line is the id; comments, blank lines, CRLF and a BOM are skipped", () => {
  assert.equal(parseProjectIdFile(`${HEADER}${UUID}\n`), UUID);
  assert.equal(parseProjectIdFile(`\n\n# a comment\r\n   ${UUID}   \r\n`), UUID, "blank lines, CRLF and padding");
  assert.equal(parseProjectIdFile(`\uFEFF${UUID}`), UUID, "a BOM");
  assert.equal(parseProjectIdFile("c78d09c3a8ee\n"), "c78d09c3a8ee", "cleocode's 12-hex id is not a UUID and is still an id");
  assert.equal(parseProjectIdFile(`${UUID}\nsecond-line-is-ignored-xx\n`), UUID, "only the first line counts");
});

test("parseProjectIdFile / parseProjectJsonId refuse anything that could be a path, a sentence or too short or long", () => {
  for (const bad of ["", "# only a comment\n", "short", "has space inside-id", "/etc/passwd", "../../x-y-z-1234", "a/b/c/d/e/f/g", "id.with.dots.1234", "-leading-dash-123456", "x".repeat(81)]) {
    assert.equal(parseProjectIdFile(bad), null, JSON.stringify(bad.slice(0, 24)));
    assert.equal(parseProjectJsonId(JSON.stringify({ id: bad })), null, "project.json: " + JSON.stringify(bad.slice(0, 24)));
  }
  assert.equal(parseProjectJsonId(JSON.stringify({ id: UUID, name: "agentmbx" })), UUID);
  assert.equal(parseProjectJsonId("{not json"), null);
  assert.equal(parseProjectJsonId("null"), null);
  assert.equal(parseProjectJsonId(JSON.stringify({ id: 12345678 })), null, "a number is not an id");
});

test("resolveProject: .cleo/project-id is the key; project.json is the fallback; neither means the folder", (t) => {
  const w = tree(t);
  const a = w.cleo(w.dir("a"), { "project-id": `${HEADER}${UUID}\n` });
  const ra = resolveProject(a);
  assert.deepEqual([ra.key, ra.source, ra.cleoId, ra.cleoRoot, ra.folder], [UUID, "cleo-project-id", UUID, a, a]);

  const b = w.cleo(w.dir("b"), { "project.json": JSON.stringify({ schemaVersion: 1, id: UUID, name: "b" }) });
  assert.deepEqual([resolveProject(b).key, resolveProject(b).source], [UUID, "cleo-project-json"], "project.json when project-id is absent");

  const c = w.cleo(w.dir("c"), { "project-id": "not an id\n", "project.json": JSON.stringify({ id: "c78d09c3a8ee" }) });
  assert.deepEqual([resolveProject(c).key, resolveProject(c).source], ["c78d09c3a8ee", "cleo-project-json"], "a malformed project-id falls through to project.json");

  const d = w.cleo(w.dir("d"), { "project-id": "aaaaaaaaaaaa\n", "project.json": JSON.stringify({ id: "bbbbbbbbbbbb" }) });
  assert.equal(resolveProject(d).key, "aaaaaaaaaaaa", "project-id is read first, as the owner decision says");

  const none = w.dir("none");
  const rn = resolveProject(none);
  assert.deepEqual([rn.key, rn.source, rn.cleoId, rn.cleoRoot], [none, "folder", null, null], "no .cleo: the folder is the key");
});

test("resolveProject walks up from a subfolder, stops at a repository boundary and never reads the home folder's .cleo", (t) => {
  const w = tree(t);
  const proj = w.git(w.cleo(w.dir("proj"), { "project-id": `${UUID}\n` }));
  const deep = w.dir("proj", "src", "deep", "er");
  assert.deepEqual([resolveProject(deep).key, resolveProject(deep).cleoRoot], [UUID, proj], "a session started in a subfolder is the same project");

  const nested = w.git(w.dir("proj", "vendor", "other-repo"));
  assert.equal(resolveProject(nested).key, nested, "a nested repository does not inherit its parent's id");
  assert.equal(resolveProject(join(nested, "sub")).key, join(nested, "sub"));

  // $HOME is never searched: a global ~/.cleo is CLEO's own state, not a project.
  const home = w.dir("fakehome");
  w.cleo(home, { "project-id": "ffffffff-ffff-ffff-ffff-ffffffffffff\n" });
  const inHome = w.dir("fakehome", "scratch", "thing");
  const saved = process.env.HOME;
  process.env.HOME = home;
  t.after(() => { if (saved === undefined) delete process.env.HOME; else process.env.HOME = saved; });
  assert.equal(resolveProject(inHome).key, inHome, "a folder under $HOME does not pick up $HOME/.cleo");
  assert.equal(resolveProject(home).key, home, "and the home folder itself is not a project");
  assert.equal(resolveProject("/").key, "/", "nor is /");
});

test("keys: key is the id or the folder; crossHostKey is the id, else the git origin, else nothing, never a path; gitKey stays the git origin", (t) => {
  const w = tree(t);
  const both = w.git(w.cleo(w.dir("both"), { "project-id": `${UUID}\n` }), "git@github.com:org/both.git");
  const rb = resolveProject(both);
  assert.deepEqual([rb.key, rb.crossHostKey, rb.gitKey], [UUID, UUID, "github.com/org/both"], "the id travels; the cloud's git key is unchanged");
  assert.equal(projectKey(both), "github.com/org/both", "projectKey() keeps its git-origin meaning (sync-daemon, #217)");

  const gitOnly = w.git(w.dir("gitonly"), "https://github.com/org/gitonly");
  const rg = resolveProject(gitOnly);
  assert.deepEqual([rg.key, rg.crossHostKey, rg.source], [gitOnly, "github.com/org/gitonly", "folder"], "no id: local key is the folder, cross-host key is the origin");

  const bare = w.dir("bare"), rbare = resolveProject(bare);
  assert.deepEqual([rbare.key, rbare.crossHostKey, rbare.gitKey], [bare, undefined, undefined], "no id and no origin: nothing travels, and a path is never the cross-host key");
  const localOrigin = w.git(w.dir("localorigin"), "/srv/git/x.git");
  assert.equal(resolveProject(localOrigin).crossHostKey, undefined, "a local-path origin means nothing on another host");

  assert.equal(crossHostKey(both), UUID);
  assert.equal(crossHostKey(undefined), undefined);
  assert.equal(crossHostKey(""), undefined);
});

test("a relative folder or another host's path is never searched relative to this process's cwd", (t) => {
  const w = tree(t);
  const proj = w.cleo(w.dir("cwd-proj"), { "project-id": `${UUID}\n` });
  const before = process.cwd();
  process.chdir(proj);
  try {
    assert.deepEqual([resolveProject(".").key, resolveProject(".").source], [".", "folder"], "'.' is the cwd, and the cwd's id must not leak into a record's folder string");
    assert.equal(resolveProject("rel/dir").source, "folder");
  } finally { process.chdir(before); }
  assert.equal(resolveProject("C:\\Users\\someone\\proj").key, "C:\\Users\\someone\\proj", "a Windows path from a paired host is just a string here");
});

test("two checkouts of one CLEO project share a key; a different id does not", (t) => {
  const w = tree(t);
  const one = w.git(w.cleo(w.dir("clone-one"), { "project-id": `${HEADER}${UUID}\n` }), "git@github.com:org/p.git");
  const two = w.git(w.cleo(w.dir("clone-two"), { "project-id": `${UUID}\n` }), "git@github.com:org/p.git");
  const other = w.git(w.cleo(w.dir("other"), { "project-id": "98069e9b-0e3a-4697-ab38-366a2ff83ec0\n" }), "git@github.com:org/other.git");
  assert.equal(resolveProject(one).key, resolveProject(two).key);
  assert.equal(resolveProject(one).crossHostKey, resolveProject(two).crossHostKey);
  assert.notEqual(resolveProject(one).key, resolveProject(other).key);
});

test("cache: an id is kept for the process, a missing id is retried after a minute", (t) => {
  const w = tree(t);
  const late = w.dir("late"), t0 = Date.now();
  assert.equal(resolveProject(late, t0).key, late);
  w.cleo(late, { "project-id": `${UUID}\n` });
  assert.equal(resolveProject(late, t0 + 1_000).key, late, "'none' is cached for a minute");
  assert.equal(resolveProject(late, t0 + 61_000).key, UUID, "then the new file is found");
  rmSync(join(late, ".cleo"), { recursive: true, force: true });
  assert.equal(resolveProject(late, t0 + 3_600_000).key, UUID, "a found id is write-once: it stays cached");
});

test("registry keeps exporting the git-origin names, and the project-key module is the only place that reads project ids or git origins", () => {
  assert.equal(registry.projectKey, projectKey);
  assert.equal(registry.resolveProject, resolveProject);
  assert.equal(typeof registry.normalizeRemote, "function");
  const src = join(import.meta.dirname, "..", "src");
  const offenders: string[] = [];
  for (const f of readdirSync(src).filter((n) => n.endsWith(".ts") && n !== "project-key.ts")) {
    const text = readFileSync(join(src, f), "utf8").split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
    if (/["'`]remote\.origin\.url["'`]/.test(text) || /["'`]project-id["'`]/.test(text) || /["'`]project\.json["'`]/.test(text)) offenders.push(f);
  }
  assert.deepEqual(offenders, [], "a second implementation of the key would let the stores drift apart");
});
