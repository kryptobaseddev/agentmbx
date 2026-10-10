import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test, type TestContext } from "node:test";
import { hookDisconnectedNote } from "../src/hook-connection.ts";
import { findIdentityControl, identityControlKey, publishIdentityControl } from "../src/identity-control.ts";
import { _resetEvidenceCacheForTests } from "../src/identity-leases.ts";
import { MbxNode } from "../src/node.ts";
import { _resetProcCache, procSeams } from "../src/proc.ts";
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
  if (cli === "claude" || cli === "codex" || cli === "opencode") assert.equal(live.stdout, "");
  f.remove();
  const before = f.node.store.db.prepare("SELECT * FROM identity_leases").all();
  for (const event of ["prompt", "prompt", "session-start"]) {
    const result = f.run(event);
    assert.equal(result.status, 0, result.stderr);
    if (cli === "hermes" && event === "session-start") { assert.equal(result.stdout, ""); continue; }
    const context = cli === "kimi" || cli === "opencode" ? result.stdout
      : cli === "hermes" ? JSON.parse(result.stdout).context : JSON.parse(result.stdout).hookSpecificOutput.additionalContext;
    const lines = context.split("\n").filter((line: string) => line.includes(MESSAGE));
    assert.deepEqual(lines, [`[mbx] ${MESSAGE}; this session no longer holds builder@alpha.`]);
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
  assert.equal(f.run("prompt", false).stdout, "");
  f.remove();
  const result = f.run("prompt", false);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).hookSpecificOutput.additionalContext, `[mbx] ${MESSAGE}; this session no longer holds builder@alpha.`);
});
