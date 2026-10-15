import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test, type TestContext } from "node:test";
import { hookDisconnectedNote, hookResumingNote } from "../src/hook-connection.ts";
import { findIdentityControl, identityControlKey, publishIdentityControl } from "../src/identity-control.ts";
import { _resetEvidenceCacheForTests, inspectLeaseProcess } from "../src/identity-leases.ts";
import { MbxNode } from "../src/node.ts";
import { _resetProcCache, procSeams, procStart } from "../src/proc.ts";
import { sessionHintKey } from "../src/registry.ts";
import { bindWakeLease } from "./helpers/wake-lease.ts";

const MESSAGE = "mbx disconnected: reconnect (e.g. /mcp in Claude Code)";
function fixture(t: TestContext, cli = "codex") {
  const home = mkdtempSync(join(tmpdir(), "mbx-t503-")), node = new MbxNode(home, { host: "alpha" });
  t.after(() => { node.close(); rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
  const sid = "real-session";
  bindWakeLease(node, { agent: "builder", cli, session_id: sid, pid: process.pid });
  const key = node.sessionsFor("builder")[0].session_key!;
  const descriptor = findIdentityControl(node.store, cli, sid);
  const remove = () => {
    node.store.db.prepare("DELETE FROM kv WHERE k IN (?,?)").run(identityControlKey(cli, sid), `mcp-process:${key}`);
  };
  const note = () => hookDisconnectedNote(node, cli, sid, process.pid);
  const run = (event: string, dev = true) => spawnSync(process.execPath, [resolve("bin/agentmbx.js"), "hook", event, "--cli", cli], {
    input: JSON.stringify({ session_id: sid, cwd: process.cwd(), prompt: "continue" }), encoding: "utf8", timeout: 10_000,
    env: { ...process.env, MBX_HOME: home, AGENTMBX_DEV: dev ? "1" : "", MBX_AGENT: "unrelated" },
  });
  return { node, sid, key, descriptor, remove, note, run };
}

test("T503 removing both connector records reports the remembered identity without mutating it", t => {
  const f = fixture(t);
  assert.equal(f.note(), null);
  f.node.store.db.prepare("DELETE FROM kv WHERE k=?").run(identityControlKey("codex", f.sid));
  assert.equal(f.note(), null, "the session's live mcp-process record still counts");
  f.remove();
  const before = f.node.store.db.prepare("SELECT * FROM identity_leases").all();
  const rows = f.node.store.db.prepare("SELECT * FROM sessions").all();
  assert.equal(f.note(), `[mbx] ${MESSAGE}; this session no longer holds builder@alpha.`);
  assert.deepEqual(f.node.store.db.prepare("SELECT * FROM identity_leases").all(), before);
  assert.deepEqual(f.node.store.db.prepare("SELECT * FROM sessions").all(), rows);
});

test("T503 a positively dead or reused MCP process is disconnected; unknown evidence stays quiet", t => {
  const f = fixture(t);
  f.node.store.db.prepare("DELETE FROM kv WHERE k=?").run(`mcp-process:${f.key}`);
  assert.equal(f.note(), null, "the live identity-control record still counts");
  publishIdentityControl(f.node.store, { ...f.descriptor, mcp_pid: 2147483647 });
  assert.match(f.note()!, /builder@alpha/);
  publishIdentityControl(f.node.store, { ...f.descriptor, mcp_start: "ps-utc:Sun Jan 1 00:00:00 1995" });
  assert.match(f.note()!, /mbx disconnected/);
  publishIdentityControl(f.node.store, f.descriptor);
  const saved = { ...procSeams };
  t.after(() => { Object.assign(procSeams, saved); _resetEvidenceCacheForTests(); _resetProcCache(); });
  procSeams.platform = "darwin";
  procSeams.ps = () => { throw new Error("process inventory unavailable"); };
  _resetEvidenceCacheForTests(); _resetProcCache();
  assert.equal(f.note(), null, "unreadable evidence is not a dead connector");
});

test("T503 a sibling conversation in a shared provider cannot hide the missing connector", t => {
  const f = fixture(t);
  bindWakeLease(f.node, { agent: "sibling", cli: "codex", session_id: "other-session", pid: process.pid });
  f.remove();
  assert.match(f.note()!, /builder@alpha/);
  assert.doesNotMatch(f.note()!, /sibling/);
  assert.equal(hookDisconnectedNote(f.node, "codex", "first-prompt", process.pid), null,
    "a new conversation can still initialize through the live shared transport");
  const sibling = findIdentityControl(f.node.store, "codex", "other-session");
  publishIdentityControl(f.node.store, { ...sibling, mcp_pid: 2147483647 });
  assert.equal(hookDisconnectedNote(f.node, "codex", "first-prompt", process.pid), `[mbx] ${MESSAGE}.`,
    "an unknown conversation must not inherit a dead sibling's identity");
  for (const invalid of ["", " bad", "bad\nline", "mcp-provisional", "x".repeat(301)])
    assert.equal(hookDisconnectedNote(f.node, "codex", invalid, process.pid), null);
});

for (const cli of ["claude", "codex", "kimi", "opencode", "hermes", "grok"]) test(`T503 ${cli} hooks report disconnection on each prompt and supported session-start output`, t => {
  const f = fixture(t, cli);
  const live = f.run("prompt");
  assert.equal(live.status, 0, live.stderr);
  assert.doesNotMatch(live.stdout, /mbx disconnected/);
  if (cli === "opencode") assert.equal(live.stdout, "");
  if (cli === "claude" || cli === "codex") { // T185/T186: a session whose SessionStart was never seen enters on its first bound prompt
    assert.match(JSON.parse(live.stdout).hookSpecificOutput.additionalContext, /^\[mbx\] You are builder@alpha\b.*call mbx_identity release/);
    assert.equal(f.run("prompt").stdout, "", "once per entry");
  }
  f.remove();
  const before = f.node.store.db.prepare("SELECT * FROM identity_leases").all();
  for (const event of ["prompt", "prompt", "session-start"]) {
    const result = f.run(event);
    assert.equal(result.status, 0, result.stderr);
    if (cli === "hermes" && event === "session-start") { assert.equal(result.stdout, ""); continue; }
    const context = cli === "kimi" || cli === "opencode" ? result.stdout
      : cli === "hermes" ? JSON.parse(result.stdout).context : JSON.parse(result.stdout).hookSpecificOutput.additionalContext;
    // T655: OpenCode names its own reconnect control; every other harness keeps the Claude example.
    const message = cli === "opencode" ? "mbx disconnected: reconnect it with /mcps in OpenCode (select mbx)" : MESSAGE;
    const lines = context.split("\n").filter((line: string) => line.includes(message));
    assert.deepEqual(lines, [`[mbx] ${message}; this session no longer holds builder@alpha.`]);
    assert.doesNotMatch(context, /unrelated/);
  }
  for (const event of ["post-tool", "stop"]) {
    const output = f.run(event).stdout;
    assert.doesNotMatch(output, /mbx disconnected/);
    if (cli !== "grok" || event !== "post-tool") assert.equal(output, "");
  }
  assert.deepEqual(f.node.store.db.prepare("SELECT * FROM identity_leases").all(), before);
});

test("T503 the compiled hook emits the same reconnect line", t => {
  const f = fixture(t);
  assert.doesNotMatch(f.run("prompt", false).stdout, /mbx disconnected/); // T186: the first bound prompt may carry the entry notice
  f.remove();
  const result = f.run("prompt", false);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).hookSpecificOutput.additionalContext, `[mbx] ${MESSAGE}; this session no longer holds builder@alpha.`);
});

// T573: `claude --resume` starts a new provider process. Its SessionStart hook runs before that process's mbx server has
// connected and reclaimed the identity the old process released (live: hook 05:11:51.031Z, reclaim 05:11:51.444Z).
const RESUMING = "[mbx] Resuming builder@alpha: this session's mailbox server is still connecting. Call mbx_whoami and wait for its result before claiming or registering.";
async function resumed(t: TestContext, cli = "claude") {
  const home = mkdtempSync(join(tmpdir(), "mbx-t573-")), node = new MbxNode(home, { host: "alpha" });
  const old = spawn("sleep", ["600"], { stdio: "ignore" });
  t.after(() => { old.kill("SIGKILL"); node.close(); rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
  const sid = cli === "codex" ? "77777777-7777-4777-8777-777777777777" : "resumed-session";
  // The old provider process held the identity for this session, then exited; its MCP released the lease on the way out.
  const held = bindWakeLease(node, { agent: "builder", cli, session_id: sid, pid: old.pid! });
  const key = node.sessionsFor("builder")[0].session_key!, descriptor = findIdentityControl(node.store, cli, sid);
  node.store.db.prepare("DELETE FROM kv WHERE k IN (?,?)").run(identityControlKey(cli, sid), `mcp-process:${key}`);
  assert.equal(held.release(), true);
  old.kill("SIGKILL");
  await once(old, "exit");
  const run = (event: string) => spawnSync(process.execPath, [resolve("bin/agentmbx.js"), "hook", event, "--cli", cli], {
    input: JSON.stringify({ session_id: sid, cwd: process.cwd(), prompt: "continue" }), encoding: "utf8", timeout: 10_000,
    env: { ...process.env, MBX_HOME: home, AGENTMBX_DEV: "1", MBX_AGENT: "unrelated" },
  });
  return { home, node, sid, run, descriptor, note: () => hookResumingNote(node, cli, sid, process.pid) };
}
const contextOf = (cli: string, stdout: string) =>
  cli === "hermes" ? JSON.parse(stdout).context as string : JSON.parse(stdout).hookSpecificOutput.additionalContext as string;

test("T573 a resumed Claude session's hook, run before its MCP reconnects, does not report the identity lost", async t => {
  const f = await resumed(t);
  const leases = f.node.store.db.prepare("SELECT * FROM identity_leases").all();
  for (const event of ["session-start", "prompt"]) {
    const result = f.run(event);
    assert.equal(result.status, 0, result.stderr);
    const context = contextOf("claude", result.stdout);
    assert.equal(context, RESUMING);
    assert.doesNotMatch(context, /no longer holds|mbx disconnected|no mailbox identity yet|mbx_identity/);
  }
  assert.deepEqual(f.node.store.db.prepare("SELECT * FROM identity_leases").all(), leases, "the hook claims nothing");
  assert.match(f.node.store.get(sessionHintKey("claude", process.pid)) ?? "", /resumed-session/, "the session hint the MCP resumes from is still recorded");
  // The provider's MCP now connects and reclaims the same identity for the same session: the hook is quiet again.
  const mcp = new MbxNode(f.home, { host: "alpha" });
  t.after(() => mcp.close());
  bindWakeLease(mcp, { agent: "builder", cli: "claude", session_id: f.sid, pid: process.pid });
  assert.equal(f.note(), null);
  // T185: the SessionStart ran while resuming, so the first bound prompt carries the deferred resume notice, once.
  const after = f.run("prompt");
  assert.equal(after.status, 0, after.stderr);
  const notice = contextOf("claude", after.stdout);
  assert.match(notice, /^\[mbx\] You are builder@alpha\b.*call mbx_identity release/);
  assert.doesNotMatch(notice, /no longer holds|mbx disconnected|no mailbox identity yet|Resuming/);
  assert.equal(f.run("prompt").stdout, "", "and the next prompt is quiet again");
});

test("T573 Hermes resumes the same way: quiet session start, the resuming line on its first prompt", async t => {
  const f = await resumed(t, "hermes");
  const start = f.run("session-start");
  assert.equal(start.status, 0, start.stderr);
  assert.equal(start.stdout, "");
  const prompt = f.run("prompt");
  assert.equal(prompt.status, 0, prompt.stderr);
  assert.equal(contextOf("hermes", prompt.stdout), RESUMING);
});

for (const cli of ["claude", "codex"]) test(`T573/T614 ${cli}: an identity that will not come back keeps the disconnected and unbound guidance`, async t => {
  const f = await resumed(t, cli);
  assert.equal(f.note(), RESUMING);
  const reset = () => f.node.store.db.prepare("UPDATE identity_leases SET released_at=?,release_reason='released',cli=?,session_id=? WHERE name='builder'").run(Date.now(), cli, f.sid);
  f.node.store.db.prepare("UPDATE identity_leases SET released_at=NULL,release_reason=NULL,session_id='another-session' WHERE name='builder'").run();
  assert.equal(f.note(), null, "another session holds it now");
  f.node.store.db.prepare("UPDATE identity_leases SET released_at=NULL,release_reason=NULL WHERE name='builder'").run();
  f.node.store.db.prepare("UPDATE identity_leases SET session_id=? WHERE name='builder'").run(f.sid);
  assert.equal(f.note(), RESUMING, "still held by this same session (the old server is exiting)");
  f.node.store.db.prepare("UPDATE identity_leases SET cli=? WHERE name='builder'").run(cli === "claude" ? "codex" : "claude");
  assert.equal(f.note(), null, "held by the same session id under another cli");
  reset();
  f.node.store.set("identity-conflict:builder", JSON.stringify({ reason: "test" }));
  assert.equal(f.note(), null, "historical ownership needs owner recovery");
  f.node.store.db.prepare("DELETE FROM kv WHERE k='identity-conflict:builder'").run();
  assert.equal(f.note(), RESUMING);
  // This provider process connected before (T503): a missing connector now is a disconnect, not a resume.
  f.node.store.db.prepare("UPDATE sessions SET pid=?, pid_start=? WHERE session_id=?").run(process.pid, procStart(process.pid), f.sid);
  assert.equal(f.note(), null);
  f.node.store.db.prepare("UPDATE sessions SET pid_start='Sun Jan  1 00:00:00 1995' WHERE session_id=?").run(f.sid);
  assert.equal(f.note(), RESUMING, "a row left by an earlier process with this pid is not this process");
  f.node.store.db.prepare("UPDATE sessions SET pid_start=NULL WHERE session_id=?").run(f.sid);
  assert.equal(f.note(), null, "unknown birth time counts as connected");
  f.node.store.db.prepare("UPDATE sessions SET pid=? WHERE session_id=?").run(2147483647, f.sid);
  assert.equal(f.note(), RESUMING);
  publishIdentityControl(f.node.store, { ...f.descriptor, parent_pid: process.pid });
  assert.equal(f.note(), null, "a connector of this provider process holds an identity: T503 decides whether it is alive");
  // T610: a live connector of this provider that holds nothing yet (a restarted server claims on its first tool call) is resuming.
  const self = inspectLeaseProcess(process.pid).start!;
  publishIdentityControl(f.node.store, { ...f.descriptor, parent_pid: process.pid, parent_start: self, mcp_pid: process.pid, mcp_start: self, agent: "", generation: null });
  assert.equal(f.note(), RESUMING, "connected but not yet claimed");
  publishIdentityControl(f.node.store, { ...f.descriptor, parent_pid: process.pid, parent_start: self, mcp_pid: process.pid, mcp_start: self, agent: "builder" });
  assert.equal(f.note(), null, "a live connector that holds an identity is connected, not resuming");
  publishIdentityControl(f.node.store, { ...f.descriptor, parent_pid: process.pid, parent_start: self, mcp_pid: 2147483647, agent: "", generation: null });
  assert.equal(f.note(), null, "an unbound connector whose server is gone is not resuming");
  publishIdentityControl(f.node.store, { ...f.descriptor, parent_pid: process.pid, parent_start: self, mcp_pid: process.pid, mcp_start: "ps-utc:Sun Jan 1 00:00:00 1995", agent: "", generation: null });
  assert.equal(f.note(), null, "nor one whose MCP pid has been reused");
  publishIdentityControl(f.node.store, { ...f.descriptor, parent_pid: process.pid, parent_start: "ps-utc:Sun Jan 1 00:00:00 1995", mcp_pid: process.pid, mcp_start: self, agent: "", generation: null });
  assert.equal(f.note(), null, "nor one left by an earlier process that had this provider's pid");
  f.node.store.db.prepare("DELETE FROM kv WHERE k=?").run(identityControlKey(cli, f.sid));
  assert.equal(f.note(), RESUMING);
  for (const invalid of ["", " bad", "bad\nline", "mcp-provisional", "x".repeat(301), ...(cli === "codex" ? ["not-a-thread-id"] : [])]) {
    f.node.store.set(`name:${cli}:${invalid}`, "builder");
    assert.equal(hookResumingNote(f.node, cli, invalid, process.pid), null, JSON.stringify(invalid.slice(0, 20)));
  }
  f.node.store.set(`name:${cli}:${f.sid}`, "Not A Name");
  assert.equal(f.note(), null, "a malformed name binding names nothing");
  f.node.store.set(`name:${cli}:${f.sid}`, "builder");
  assert.equal(f.note(), RESUMING);
  // An explicit release (or takeover) deletes the session's name binding: nothing will be reclaimed.
  f.node.store.db.prepare("DELETE FROM kv WHERE k=?").run(`name:${cli}:${f.sid}`);
  assert.equal(f.note(), null);
  const result = f.run("session-start");
  assert.equal(result.status, 0, result.stderr);
  assert.match(contextOf(cli, result.stdout), /no mailbox identity yet/);
});

test("T573 a cli that does not rebind sessions keeps the T503 text", async t => {
  const f = await resumed(t, "grok");
  assert.equal(f.note(), null);
  const result = f.run("prompt");
  assert.equal(result.status, 0, result.stderr);
  assert.match(contextOf("grok", result.stdout), /this session no longer holds builder@alpha/);
});

test("T614 a Codex thread resumes independently of sibling rows and controls on its shared provider", async t => {
  const f = await resumed(t, "codex");
  const sibling = "88888888-8888-4888-8888-888888888888";
  bindWakeLease(f.node, { agent: "sibling", cli: "codex", session_id: sibling, pid: process.pid });
  assert.equal(f.note(), RESUMING, "a sibling's binding does not make this thread previously connected");
  const self = inspectLeaseProcess(process.pid).start!;
  const unclaimed = { ...f.descriptor, parent_pid: process.pid, parent_start: self, mcp_pid: process.pid, mcp_start: self, agent: "", generation: null };
  publishIdentityControl(f.node.store, { ...unclaimed, session_id: "mcp-provisional" });
  assert.equal(f.note(), RESUMING, "an unclaimed shared transport can still initialize this exact remembered thread");
  publishIdentityControl(f.node.store, { ...unclaimed, session_id: "mcp-provisional", mcp_pid: 2147483647 });
  assert.equal(f.note(), null, "a live sibling cannot hide the dead provisional transport");
  publishIdentityControl(f.node.store, { ...unclaimed, session_id: sibling });
  assert.equal(f.note(), null, "an unclaimed real sibling cannot supply this thread's process evidence either");
  publishIdentityControl(f.node.store, unclaimed);
  assert.equal(f.note(), RESUMING, "this exact thread's live unclaimed control does count");
  publishIdentityControl(f.node.store, { ...unclaimed, parent_pid: 2147483647 });
  assert.equal(f.note(), null, "an exact control under another parent does not count");
  assert.equal(hookResumingNote(f.node, "codex", sibling, process.pid), null, "the connected sibling stays connected");
  assert.equal(hookResumingNote(f.node, "codex", "99999999-9999-4999-8999-999999999999", process.pid), null,
    "a new thread cannot borrow the remembered name");
});

// ---- T655: an OpenCode serve runs session-start before its mbx server connects ----

test("T655 a fresh OpenCode session that never connected is not reported disconnected", t => {
  const home = mkdtempSync(join(tmpdir(), "mbx-t655-")), node = new MbxNode(home, { host: "alpha" });
  t.after(() => { node.close(); rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
  assert.equal(hookDisconnectedNote(node, "opencode", "ses_fresh", process.pid), null, "no binding, no remembered name, no connector record yet");
  // the other harnesses keep the T503 guidance for a connector they never saw: their servers start before their hooks
  assert.equal(hookDisconnectedNote(node, "grok", "ses_fresh", process.pid), `[mbx] ${MESSAGE}.`);
  assert.equal(hookDisconnectedNote(node, "hermes", "ses_fresh", process.pid), `[mbx] ${MESSAGE}.`);
  // a remembered identity is not a fresh session: losing it is still reported, with OpenCode's own control
  node.store.set("name:opencode:ses_fresh", "builder");
  assert.equal(hookDisconnectedNote(node, "opencode", "ses_fresh", process.pid),
    "[mbx] mbx disconnected: reconnect it with /mcps in OpenCode (select mbx); this session no longer holds builder@alpha.");
});

test("T655 an OpenCode session that lost its connector is told to reconnect with /mcps, never Claude's /mcp", t => {
  const f = fixture(t, "opencode");
  assert.equal(f.note(), null, "connected");
  f.remove();
  assert.equal(f.note(), "[mbx] mbx disconnected: reconnect it with /mcps in OpenCode (select mbx); this session no longer holds builder@alpha.");
  assert.doesNotMatch(f.note()!, /Claude Code/);
});

test("T655 a new OpenCode session on a serve whose connector died is still disconnected", t => {
  const f = fixture(t, "opencode");
  assert.equal(hookDisconnectedNote(f.node, "opencode", "ses_new", process.pid), null, "the serve's live connector can still initialize it");
  publishIdentityControl(f.node.store, { ...f.descriptor, mcp_pid: 2147483647 });
  assert.equal(hookDisconnectedNote(f.node, "opencode", "ses_new", process.pid), "[mbx] mbx disconnected: reconnect it with /mcps in OpenCode (select mbx).");
});

test("T655 the real session-start hook of a fresh OpenCode session says nothing about a disconnect", t => {
  const home = mkdtempSync(join(tmpdir(), "mbx-t655-hook-")), node = new MbxNode(home, { host: "alpha" });
  t.after(() => { node.close(); rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
  const out = spawnSync(process.execPath, [resolve("bin/agentmbx.js"), "hook", "session-start", "--cli", "opencode"], {
    input: JSON.stringify({ session_id: "ses_fresh_start", cwd: process.cwd() }), encoding: "utf8", timeout: 10_000,
    env: { ...process.env, MBX_HOME: home, AGENTMBX_DEV: "1", MBX_AGENT: "unrelated" },
  });
  assert.equal(out.status, 0, out.stderr);
  assert.match(out.stdout, /no mailbox identity yet/, "the unbound guidance still runs");
  assert.doesNotMatch(out.stdout, /disconnected|\/mcp in Claude Code/);
});
