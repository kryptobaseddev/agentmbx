import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MbxNode } from "../src/node.ts";
import { IdentityLeases } from "../src/identity-leases.ts";

for (const cli of ["claude", "codex", "kimi", "opencode"]) test(`${cli} startup offers recovery choices without claiming historical mail`, t => {
  const home = mkdtempSync(join(tmpdir(), "mbx-startup-choice-")), node = new MbxNode(home, { host: "alpha" });
  t.after(() => { node.close(); rmSync(home, { recursive: true, force: true }); });
  const leases = new IdentityLeases(node.store, { inspect: () => ({ alive: true, start: "fixture" }) });
  const lease = leases.claim("historical", { pid: process.pid, start: "fixture", keyFp: "aaaa-bbbb-cccc-dddd", cli, sessionId: "previous" });
  leases.release("historical", lease.token);
  node.send({ from: "sender", to: ["historical"], subject: "PRIVATE SUBJECT", body: "SECRET BODY" });
  const before = node.store.db.prepare("SELECT * FROM identity_leases").all();
  const result = spawnSync(process.execPath, ["bin/agentmbx.js", "hook", "session-start", "--cli", cli], {
    input: JSON.stringify({ session_id: "new-session", cwd: "/work" }), encoding: "utf8",
    env: { ...process.env, MBX_HOME: home, MBX_AGENT: "working", AGENTMBX_DEV: "1" },
  });
  assert.equal(result.status, 0, result.stderr);
  const context = cli === "kimi" ? result.stdout : JSON.parse(result.stdout).hookSpecificOutput.additionalContext;
  if (cli !== "kimi") assert.equal(JSON.parse(result.stdout).hookSpecificOutput.hookEventName, "SessionStart");
  assert.match(context, /mbx_whoami/); assert.match(context, /mbx_identity.*action=list/);
  assert.match(context, /explicitly release.*claim/);
  assert.doesNotMatch(context, /SECRET BODY|PRIVATE SUBJECT/);
  assert.deepEqual(node.store.db.prepare("SELECT * FROM identity_leases").all(), before);
  assert.equal(node.unreadCount("historical"), 1);
  assert.equal(node.unreadCount("working"), 0);
});

test("Claude post-tool hook surfaces arrivals once, including linked names and equal-count replacements", () => {
  const n = new MbxNode(mkdtempSync(join(tmpdir(), "mbx-hooks-")), { host: "alpha" });
  try {
    n.bindSession({ agent: "builder", cli: "claude", session_id: "mcp-builder", pid: process.pid, session_key: "k" });
    const run = (session = "s1", cli = "claude") => {
      const r = spawnSync(process.execPath, ["bin/agentmbx.js", "hook", "post-tool", "--cli", cli], {
        input: JSON.stringify({ session_id: session, tool_name: "Bash" }), encoding: "utf8",
        env: { ...process.env, MBX_HOME: n.home, AGENTMBX_DEV: "1" },
      });
      assert.equal(r.status, 0, r.stderr);
      return r.stdout;
    };
    assert.equal(run(), "", "empty inbox is silent");
    const send = (to = "builder") => n.send({ from: "sender", to: [to], subject: "PRIVATE SUBJECT", body: "SECRET BODY", kind: "request" }).envelope.id;
    const first = send();
    const output = JSON.parse(run()).hookSpecificOutput;
    assert.equal(output.hookEventName, "PostToolUse");
    assert.match(output.additionalContext, /1 unread mbx message.*builder@alpha/);
    assert.doesNotMatch(output.additionalContext, /SECRET BODY|PRIVATE SUBJECT/);
    assert.equal(n.inbox("builder")[0].state, "delivered", "notice neither reads nor acknowledges mail");
    assert.equal(run(), "", "unchanged inbox is silent");
    n.ack(first, "builder");
    const second = send();
    assert.match(run(), /1 unread mbx message/, "new message at the same count still notifies");
    assert.equal(run(), "");
    assert.match(run("s2"), /1 unread mbx message/, "deduplication is session scoped");
    n.linkIdentity("shell-name", "builder");
    const linked = send("shell-name");
    assert.match(run(), /shell-name \(1; agentmbx inbox --as shell-name\)/);
    assert.equal(run(), "");
    n.ack(second, "builder");
    assert.equal(run(), "", "acknowledging a message does not repeat the remaining notice");
    n.ack(linked, "shell-name");
    assert.equal(run(), "");
    send();
    assert.equal(run("s1", "codex"), "", "unsupported providers do not receive Claude hook output");
    assert.match(run(), /1 unread mbx message/);
  } finally { n.close(); }
});

for (const cli of ["claude", "codex", "kimi", "opencode"]) test(`${cli} prompt recovers missed startup and preserves MCP identity`, () => {
  const n = new MbxNode(mkdtempSync(join(tmpdir(), "mbx-prompt-bind-")), { host: "alpha" });
  try {
    n.bindSession({ agent: "chosen", cli, session_id: "mcp-placeholder", pid: process.pid, session_key: "key" });
    const run = (sid: unknown) => spawnSync(process.execPath, ["bin/agentmbx.js", "hook", "prompt", "--cli", cli], {
      input: JSON.stringify({ session_id: sid, cwd: "/work" }), encoding: "utf8",
      env: { ...process.env, MBX_HOME: n.home, AGENTMBX_DEV: "1" },
    });
    const first = run("real-session");
    assert.equal(first.status, 0, first.stderr);
    const rows = n.sessionsFor("chosen");
    assert.equal(rows.length, 1);
    assert.equal(rows[0].session_id, "real-session");
    assert.equal(rows[0].session_key, "key");
    n.store.db.prepare("UPDATE sessions SET updated_at='2000-01-01T00:00:00Z'").run();
    const refresh = run("real-session");
    assert.equal(refresh.status, 0, refresh.stderr);
    assert.notEqual(n.sessionsFor("chosen")[0].updated_at, "2000-01-01T00:00:00Z");
    for (const missing of [undefined]) {
      const before = n.store.db.prepare("SELECT * FROM sessions").all();
      const result = run(missing);
      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(n.store.db.prepare("SELECT * FROM sessions").all(), before, "no guessed session ID");
    }
  } finally { n.close(); }
});


test("prompt hooks ignore nonstring and empty session IDs", () => {
  const n = new MbxNode(mkdtempSync(join(tmpdir(), "mbx-prompt-invalid-")), { host: "alpha" });
  try {
    for (const sid of [null, "", 42, {}]) {
      const r = spawnSync(process.execPath, ["bin/agentmbx.js", "hook", "prompt", "--cli", "kimi"], {
        input: JSON.stringify({ session_id: sid }), encoding: "utf8",
        env: { ...process.env, MBX_HOME: n.home, AGENTMBX_DEV: "1" },
      });
      assert.equal(r.status, 0, r.stderr);
      assert.deepEqual(n.store.db.prepare("SELECT * FROM sessions").all(), []);
    }
  } finally { n.close(); }
});
