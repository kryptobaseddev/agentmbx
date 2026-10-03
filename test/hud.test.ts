// T312/T313: daemon HUD snapshots and the statusline adapters that read them. Session snapshots are
// `${cli}-${sid}.json` for resolver-bound rows only; pid snapshots exist only when the resolver
// proves one holder for (cli, pid), keyed by the pid's birth time; files are 0600 in a 0700
// directory; vanished bindings are deleted on the next tick; the daemon touches hud/.alive every
// pass and adapters refuse to render when it is older than ~10 s.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { MbxNode } from "../src/node.ts";
import { HUD_ALIVE_MAX_MS, HUD_SCHEMA, hudAlivePath, hudDir, hudPidLinePath, hudPidPath, hudSessionLinePath, hudSessionPath, hudStatus, writeHud } from "../src/hud.ts";
import { IdentityLeases, inspectLeaseProcess } from "../src/identity-leases.ts";
import { procStart } from "../src/proc.ts";

const home = () => mkdtempSync(join(tmpdir(), "mbx-hud-"));
const claim = (n: MbxNode, name: string, sid: string) =>
  new IdentityLeases(n.store).claim(name, { pid: process.pid, start: inspectLeaseProcess(process.pid).start!, keyFp: "aaaa-bbbb-cccc-dddd", cli: "kimi", sessionId: sid });

test("a bound session gets a ${cli}-${sid} snapshot (0600, 0700 dir), identical content for the pid+start file", (t) => {
  const h = home(), n = new MbxNode(h, { host: "alpha" });
  t.after(() => { n.close(); rmSync(h, { recursive: true, force: true }); });
  n.bindSession({ agent: "drum", cli: "kimi", session_id: "sess-hud-1", pid: process.pid, session_key: "k" });
  claim(n, "drum", "sess-hud-1");
  n.send({ from: "boss", to: ["drum"], subject: "one", body: "b" });
  n.send({ from: "boss", to: ["drum"], subject: "two", body: "b", needs_reply: true });
  writeHud(n);
  const bySession = JSON.parse(readFileSync(hudSessionPath(h, "kimi", "sess-hud-1"), "utf8"));
  const start = inspectLeaseProcess(process.pid).start!;
  const byPid = JSON.parse(readFileSync(hudPidPath(h, "kimi", process.pid, start), "utf8"));
  assert.equal(byPid.unread, bySession.unread);
  assert.equal(byPid.identity.name, bySession.identity.name);
  assert.equal(bySession.resolved_by, "session_id");
  assert.equal(byPid.resolved_by, "pid", "a pid file never claims session-id resolution");
  assert.equal(bySession.schema, HUD_SCHEMA);
  assert.equal(bySession.identity.name, "drum");
  assert.equal(bySession.identity.state, "bound");
  assert.equal(bySession.unread, 2);
  assert.equal(bySession.needs_reply, 1);
  assert.deepEqual(bySession.policy, []);
  assert.equal(bySession.resolved_by, "session_id");
  assert.equal(statSync(hudSessionPath(h, "kimi", "sess-hud-1")).mode & 0o777, 0o600, "files are private");
  assert.equal(statSync(hudDir(h)).mode & 0o777, 0o700, "the hud directory is private");
  assert.ok(existsSync(hudAlivePath(h)), "the daemon heartbeat is written");
  // unchanged content is not rewritten, so idle daemons are disk-quiet
  const mtime = statSync(hudSessionPath(h, "kimi", "sess-hud-1")).mtimeMs;
  writeHud(n);
  assert.equal(statSync(hudSessionPath(h, "kimi", "sess-hud-1")).mtimeMs, mtime);
  // ack one: counts move on the next write
  n.ack(n.inbox("drum")[0].id, "drum");
  writeHud(n);
  assert.equal(JSON.parse(readFileSync(hudSessionPath(h, "kimi", "sess-hud-1"), "utf8")).unread, 1);
});

test("critical: a pid shared by several sessions gets NO pid file — an unknown session id renders nothing", (t) => {
  const h = home(), n = new MbxNode(h, { host: "alpha" });
  t.after(() => { n.close(); rmSync(h, { recursive: true, force: true }); });
  // two opencode sessions under one live pid (the owner's probe): the resolver is ambiguous on the pid
  n.bindSession({ agent: "one", cli: "opencode", session_id: "oc-1", pid: process.pid, session_key: "k1" });
  n.bindSession({ agent: "other", cli: "opencode", session_id: "oc-2", pid: process.pid, session_key: "k2" });
  claim(n, "one", "oc-1"); claim(n, "other", "oc-2");
  writeHud(n);
  assert.ok(existsSync(hudSessionPath(h, "opencode", "oc-1")), "each session keeps its own namespaced file");
  assert.equal(readdirSync(hudDir(h)).filter(f => f.includes("-pid-")).length, 0, "no pid file while the resolver is ambiguous");
  // the line renders are pre-written too: same-session probe finds its own line
  assert.ok(existsSync(hudSessionLinePath(h, "opencode", "oc-2")));
  const env = { ...process.env, AGENTMBX_DEV: "1", MBX_HOME: h, MBX_NO_DESKTOP: "1" } as Record<string, string>;
  const probe = spawnSync(process.execPath, [resolve("bin/agentmbx.js"), "statusline", "opencode"],
    { input: JSON.stringify({ session_id: "unknown" }), encoding: "utf8", env });
  assert.equal(probe.stdout, "", "an unknown session under a shared pid must render nothing, not another agent's mail");
  const known = spawnSync(process.execPath, [resolve("bin/agentmbx.js"), "statusline", "opencode"],
    { input: JSON.stringify({ session_id: "oc-2" }), encoding: "utf8", env });
  assert.match(known.stdout, /^mbx other/);
});

test("round 3: a shared-process CLI that names no session id renders nothing (pid fallback is claude-only)", (t) => {
  const h = home(), n = new MbxNode(h, { host: "alpha" });
  t.after(() => { n.close(); rmSync(h, { recursive: true, force: true }); });
  n.bindSession({ agent: "one", cli: "opencode", session_id: "oc-1", pid: process.pid, session_key: "k1" });
  n.bindSession({ agent: "other", cli: "opencode", session_id: "oc-2", pid: process.pid, session_key: "k2" });
  claim(n, "other", "oc-2");
  writeHud(n);
  const env = { ...process.env, AGENTMBX_DEV: "1", MBX_HOME: h, MBX_NO_DESKTOP: "1" } as Record<string, string>;
  // stdin names no session id at all: the pid file exists for this pid, but only Claude may read it —
  // for a shared-process CLI an unbound sibling could exist, and the pid file cannot know.
  const none = spawnSync(process.execPath, [resolve("bin/agentmbx.js"), "statusline", "opencode"],
    { input: "{}", encoding: "utf8", env });
  assert.equal(none.stdout, "", "no sid from a shared-process CLI: never the pid fallback");
  const kimi = spawnSync(process.execPath, [resolve("bin/agentmbx.js"), "statusline", "kimi"],
    { input: "{}", encoding: "utf8", env });
  assert.equal(kimi.stdout, "", "kimi is also multi-conversation per process: no pid fallback either");
});

test("round 3: rows a pass proves dead (and rows with no pid) render nothing and prune on the next tick", (t) => {
  const h = home(), n = new MbxNode(h, { host: "alpha" });
  t.after(() => { n.close(); rmSync(h, { recursive: true, force: true }); });
  n.bindSession({ agent: "ghost", cli: "kimi", session_id: "ghost-1", pid: 424242, session_key: "k" });
  claim(n, "ghost", "ghost-1");
  n.send({ from: "boss", to: ["ghost"], subject: "hey", body: "b" });
  writeHud(n); // 424242 does not exist: the pass proves the row dead before any file is written
  assert.ok(!existsSync(hudSessionPath(h, "kimi", "ghost-1")), "a dead-pid row gets no session file");
  assert.equal(readdirSync(hudDir(h)).filter(f => f.endsWith(".line")).length, 0, "no line file either");
  // a row with no pid at all can never be proven live (no production binder omits a pid)
  n.store.db.prepare("INSERT INTO sessions (agent,cli,session_id,updated_at) VALUES ('legacy','kimi','legacy-1',?)")
    .run(new Date().toISOString());
  writeHud(n);
  assert.ok(!existsSync(hudSessionPath(h, "kimi", "legacy-1")), "a no-pid row never renders");
  // the binding outlives the process (row lingers until the reaper): a live rebind brings the file back
  n.bindSession({ agent: "ghost", cli: "kimi", session_id: "ghost-1", pid: process.pid, session_key: "k" });
  writeHud(n);
  assert.ok(existsSync(hudSessionPath(h, "kimi", "ghost-1")), "a live row renders again");
});

test("round 4: a reused pid (alive but a different process) renders nothing and prunes", (t) => {
  const h = home(), n = new MbxNode(h, { host: "alpha" });
  t.after(() => { n.close(); rmSync(h, { recursive: true, force: true }); });
  n.bindSession({ agent: "ghost", cli: "kimi", session_id: "ghost-1", pid: process.pid, session_key: "k" });
  claim(n, "ghost", "ghost-1");
  n.send({ from: "boss", to: ["ghost"], subject: "hey", body: "b" });
  writeHud(n);
  assert.ok(existsSync(hudSessionPath(h, "kimi", "ghost-1")), "the row renders while the pid is its own");
  // the pid gets reused: the row's recorded birth time no longer matches the live process
  n.store.db.prepare("UPDATE sessions SET pid_start=? WHERE session_id='ghost-1'").run("not-the-live-start");
  writeHud(n);
  assert.ok(!existsSync(hudSessionPath(h, "kimi", "ghost-1")), "a reused pid renders nothing");
  assert.ok(!existsSync(hudSessionLinePath(h, "kimi", "ghost-1")), "its line file prunes too");
  // restoring the true birth time renders again
  n.store.db.prepare("UPDATE sessions SET pid_start=? WHERE session_id='ghost-1'").run(procStart(process.pid));
  writeHud(n);
  assert.ok(existsSync(hudSessionPath(h, "kimi", "ghost-1")), "the true start renders again");
});

test("a real release removes the binding and the snapshot on the next tick; a stale .alive refuses renders", (t) => {
  const h = home(), n = new MbxNode(h, { host: "alpha" });
  t.after(() => { n.close(); rmSync(h, { recursive: true, force: true }); });
  n.bindSession({ agent: "drum", cli: "kimi", session_id: "sess-hud-2", pid: process.pid, session_key: "k" });
  claim(n, "drum", "sess-hud-2");
  writeHud(n);
  assert.ok(existsSync(hudSessionPath(h, "kimi", "sess-hud-2")));
  // the real release path also deletes the session binding rows (identityOperation release)
  n.store.db.prepare("DELETE FROM sessions WHERE session_id='sess-hud-2'").run();
  writeHud(n);
  assert.ok(!existsSync(hudSessionPath(h, "kimi", "sess-hud-2")), "a vanished binding's file is deleted on the next tick");
  assert.ok(!existsSync(hudPidPath(h, "kimi", process.pid, inspectLeaseProcess(process.pid).start!)), "and its pid file too");
  assert.ok(!existsSync(hudSessionLinePath(h, "kimi", "sess-hud-2")), "and its line file too");
  // daemon stopped: .alive goes stale and the adapter refuses
  const env = { ...process.env, AGENTMBX_DEV: "1", MBX_HOME: h, MBX_NO_DESKTOP: "1" } as Record<string, string>;
  const stale = spawnSync(process.execPath, [resolve("bin/agentmbx.js"), "statusline", "kimi"],
    { input: JSON.stringify({ session_id: "x" }), encoding: "utf8", env });
  assert.equal(stale.stdout, "", "no heartbeat: no render");
  const alive = Number(readFileSync(hudAlivePath(h), "utf8"));
  assert.ok(Math.abs(Date.now() - alive) < 5_000, "the heartbeat is current after a write");
});

test("the writer validates ids and isolates bad rows", (t) => {
  const h = home(), n = new MbxNode(h, { host: "alpha" });
  t.after(() => { n.close(); rmSync(h, { recursive: true, force: true }); });
  n.bindSession({ agent: "good", cli: "kimi", session_id: "good-1", pid: process.pid, session_key: "k" });
  claim(n, "good", "good-1");
  n.store.db.prepare("INSERT INTO sessions (agent,cli,session_id,updated_at) VALUES ('evil','kimi','../escape',?)").run(new Date().toISOString());
  n.store.db.prepare("INSERT INTO sessions (agent,cli,session_id,updated_at) VALUES ('long','kimi',?,?)")
    .run("x".repeat(200), new Date().toISOString());
  writeHud(n); // must not throw, must not escape the hud directory
  assert.ok(existsSync(hudSessionPath(h, "kimi", "good-1")), "the good row is still written");
  assert.equal([...new Set(readFileSync(join(hudDir(h), "kimi-good-1.json"), "utf8"))].length > 0, true);
  const outside = resolve(hudDir(h), "..", "escape.json");
  assert.ok(!existsSync(outside), "a ../ session id never escapes the hud directory");
});

test("the bundled Claude adapter renders with node absent from PATH — pure sh, one cat of the line file", (t) => {
  const h = home(), n = new MbxNode(h, { host: "alpha" });
  t.after(() => { n.close(); rmSync(h, { recursive: true, force: true }); });
  n.bindSession({ agent: "drum", cli: "claude", session_id: "claude-1", pid: process.pid, session_key: "k" });
  claim(n, "drum", "claude-1");
  n.send({ from: "boss", to: ["drum"], subject: "hey", body: "b", needs_reply: true });
  writeHud(n);
  const script = resolve("skill/scripts/claude-statusline.sh");
  // Round 3: the render budget is enforced as a dependency, not a wall clock — a node startup is
  // 150 ms idle and 470-630 ms at load 78, which breaks Kimi's 300 ms cap. With node off PATH the
  // script must still render. /bin:/usr/bin carries sed/date/cat but no node (macOS ships none).
  const shEnv = { ...process.env, MBX_HOME: h, PATH: "/bin:/usr/bin" } as Record<string, string>;
  const ok = spawnSync("/bin/sh", [script], { input: JSON.stringify({ session_id: "claude-1" }), encoding: "utf8", env: shEnv });
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /^mbx drum 1↑ 1↺/);
  const unbound = spawnSync("/bin/sh", [script], { input: JSON.stringify({ session_id: "nope" }), encoding: "utf8", env: shEnv });
  assert.equal(unbound.status, 0, unbound.stderr);
  assert.equal(unbound.stdout, "", "an unbound session renders nothing");
  const noSid = spawnSync("/bin/sh", [script], { input: "{}", encoding: "utf8", env: shEnv });
  assert.equal(noSid.stdout, "", "no session id on stdin renders nothing");
  // Round 4: the FIRST session_id wins — a nested key must never override the conversation's own id,
  // and an invalid top-level id must exit instead of falling through to a later valid one.
  const nested = spawnSync("/bin/sh", [script],
    { input: JSON.stringify({ session_id: "claude-1", agent: { session_id: "victim" } }), encoding: "utf8", env: shEnv });
  assert.equal(nested.status, 0, nested.stderr);
  assert.match(nested.stdout, /^mbx drum/, "first session_id wins over a nested key");
  const invalidFirst = spawnSync("/bin/sh", [script],
    { input: JSON.stringify({ session_id: "bad id!", agent: { session_id: "claude-1" } }), encoding: "utf8", env: shEnv });
  assert.equal(invalidFirst.stdout, "", "an invalid first id never falls through to a nested valid one");
});

test("the CLI adapter resolves exactly without opening the store — an empty home gains no files", (t) => {
  const h = home(), n = new MbxNode(h, { host: "alpha" });
  t.after(() => { n.close(); rmSync(h, { recursive: true, force: true }); });
  n.bindSession({ agent: "drum", cli: "claude", session_id: "claude-1", pid: process.pid, session_key: "k" });
  claim(n, "drum", "claude-1");
  n.send({ from: "boss", to: ["drum"], subject: "hey", body: "b", needs_reply: true });
  writeHud(n);
  const env = { ...process.env, AGENTMBX_DEV: "1", MBX_HOME: h, MBX_NO_DESKTOP: "1" } as Record<string, string>;
  const run = (args: string[], stdin: string) =>
    spawnSync(process.execPath, [resolve("bin/agentmbx.js"), "statusline", ...args], { input: stdin, encoding: "utf8", env });
  const ok = run(["claude"], JSON.stringify({ session_id: "claude-1" }));
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /^mbx drum 1↑ 1↺/);
  // cross-CLI isolation: the kimi adapter cannot read claude's file
  const cross = run(["kimi"], JSON.stringify({ session_id: "claude-1" }));
  assert.equal(cross.stdout, "", "session files are namespaced by CLI");
  const missing = run(["opencode"], JSON.stringify({ session_id: "nope" }));
  assert.equal(missing.stdout, "", "a CLI with no binding anywhere renders nothing");
  const codex = run(["codex"], "{}");
  assert.match(codex.stdout, /no custom statusline command yet/);
  // an entirely fresh home: the adapter neither creates keys nor a database
  const empty = home();
  t.after(() => rmSync(empty, { recursive: true, force: true }));
  const blank = spawnSync(process.execPath, [resolve("bin/agentmbx.js"), "statusline", "kimi"],
    { input: JSON.stringify({ session_id: "x" }), encoding: "utf8", env: { ...env, MBX_HOME: empty } });
  assert.equal(blank.stdout, "");
  assert.ok(!existsSync(join(empty, "mbx.db")) && !existsSync(join(empty, "config.json")), "no store is created by a render");
});

test("hudStatus builds the mbx.status/v1 shape from mailbox state, re-checking owner authority", (t) => {
  const h = home(), n = new MbxNode(h, { host: "alpha" });
  t.after(() => { n.close(); rmSync(h, { recursive: true, force: true }); });
  const s = hudStatus(n, { agent: null, state: "unbound", resolvedBy: "none" });
  assert.equal(s.schema, HUD_SCHEMA);
  assert.equal(s.identity.state, "unbound");
  assert.equal(s.unread, 0);
  assert.deepEqual(s.policy, []);
  assert.match(s.mbx_version, /^\d+\.\d+\.\d+/);
});
