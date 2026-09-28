import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MbxNode } from "../src/node.ts";
import { resolveAgent } from "../src/permission.ts";

const make = () => new MbxNode(mkdtempSync(join(tmpdir(), "mbx-binding-")), { host: "alpha" });
const rows = (n: MbxNode) => n.store.db.prepare("SELECT agent,cli,session_id,session_key,channel,cwd FROM sessions ORDER BY session_id").all();

for (const cli of ["claude", "codex", "opencode", "kimi"]) for (const mcpFirst of [true, false]) {
  test(`${cli}: ${mcpFirst ? "MCP then hook" : "hook then MCP"} produces one stable wake binding`, () => {
    const n = make();
    try {
      const mcp = { agent: "chosen-name", cli, session_id: "mcp-123", pid: process.pid, session_key: "key", channel: cli === "claude" };
      const hook = { agent: "folder-name", cli, session_id: "real-thread", pid: process.pid, cwd: "/work" };
      if (mcpFirst) { n.bindSession(mcp); n.bindSession(hook); }
      else { n.bindSession(hook); n.bindSession(mcp); }
      const expected = { agent: "chosen-name", cli, session_id: "real-thread", session_key: "key", channel: cli === "claude" ? 1 : 0, cwd: "/work" };
      assert.deepEqual(rows(n).map((r) => ({ ...r })), [expected]);
      n.bindSession(mcp); // an MCP heartbeat must not recreate the provisional row
      n.bindSession(hook); // a hook without channel/key metadata must preserve them
      assert.deepEqual(rows(n).map((r) => ({ ...r })), [expected]);
      assert.equal(n.agentFor(cli, process.pid), "chosen-name");
      assert.deepEqual(n.sessionsFor("chosen-name").map((s) => s.session_id), ["real-thread"]);
    } finally { n.close(); }
  });
}

test("distinct real sessions and ambiguous MCP keys sharing a PID are not combined", () => {
  const n = make();
  try {
    n.bindSession({ agent: "first", cli: "kimi", session_id: "real-first", pid: process.pid, session_key: "key-a" });
    n.bindSession({ agent: "second", cli: "kimi", session_id: "real-second", pid: process.pid, session_key: "key-b" });
    assert.equal(n.bindSession({ agent: "second", cli: "kimi", session_id: "real-second", pid: process.pid }), "second");
    assert.deepEqual(rows(n).map((r) => [r.agent, r.session_key]), [["first", "key-a"], ["second", "key-b"]]);
    assert.equal(n.agentFor("kimi", process.pid, { proof: true }), null, "PID alone cannot choose between these sessions");
    assert.equal(resolveAgent(n, "kimi", "real-first", "/work", process.pid), "first");
    assert.equal(resolveAgent(n, "kimi", "real-second", "/work", process.pid), "second");
    assert.equal(resolveAgent(n, "kimi", "unknown", "/work", process.pid), null);
    n.bindSession({ agent: "third", cli: "kimi", session_id: "mcp-third", pid: process.pid, session_key: "key-c" });
    assert.equal(n.bindSession({ agent: "fourth", cli: "kimi", session_id: "real-fourth", pid: process.pid }), "fourth");
    assert.equal(rows(n).length, 4);
  } finally { n.close(); }
});

test("different project directories do not merge through a shared PID", () => {
  const n = make();
  try {
    n.bindSession({ agent: "first", cli: "opencode", session_id: "real-first", pid: process.pid, cwd: "/first" });
    n.bindSession({ agent: "second", cli: "opencode", session_id: "mcp-second", pid: process.pid, cwd: "/second", session_key: "key" });
    assert.equal(rows(n).length, 2);
    assert.equal(rows(n).find((r) => r.session_id === "real-first")!.agent, "first");
  } finally { n.close(); }
});

test("a failed binding merge rolls back the canonical row and keeps its provisional source", (t) => {
  const n = make();
  try {
    n.bindSession({ agent: "chosen", cli: "codex", session_id: "mcp-123", pid: process.pid, session_key: "key" });
    const before = rows(n);
    t.mock.method(n, "keepName", () => { throw new Error("failed name persistence"); });
    assert.throws(() => n.bindSession({ agent: "folder", cli: "codex", session_id: "real-thread", pid: process.pid }), /failed name persistence/);
    assert.deepEqual(rows(n), before);
  } finally { t.mock.restoreAll(); n.close(); }
});

test("rebinding a reused PID/session id does not retain the old key or channel", () => {
  const n = make();
  try {
    n.bindSession({ agent: "old", cli: "claude", session_id: "thread", pid: process.pid, session_key: "old-key", channel: true });
    n.store.db.prepare("UPDATE sessions SET pid_start='another-process'").run();
    n.bindSession({ agent: "fresh", cli: "claude", session_id: "thread", pid: process.pid });
    // The real session id may retain its remembered display name, but never the old authority key.
    assert.equal(rows(n)[0].session_key, null);
    assert.equal(rows(n)[0].channel, 0);
  } finally { n.close(); }
});

test("legacy duplicate rows converge on the real session id when its MCP heartbeats", () => {
  const n = make();
  try {
    const mcp = { agent: "chosen", cli: "codex", session_id: "mcp-123", pid: process.pid, session_key: "key" };
    n.bindSession(mcp);
    n.store.db.prepare(`INSERT INTO sessions (agent,cli,session_id,cwd,pid,session_key,channel,updated_at,pid_start)
      SELECT agent,cli,'real-thread','/work',pid,NULL,0,updated_at,pid_start FROM sessions WHERE session_id='mcp-123'`).run();
    n.bindSession(mcp);
    assert.deepEqual(rows(n).map((r) => [r.session_id, r.session_key]), [["real-thread", "key"]]);
  } finally { n.close(); }
});

test("an unproven MCP reconnect cannot replace another live session key", () => {
  const n = make();
  try {
    n.bindSession({ agent: "chosen", cli: "codex", session_id: "real-thread", pid: process.pid, session_key: "old-key" });
    n.bindSession({ agent: "chosen", cli: "codex", session_id: "mcp-new", pid: process.pid, session_key: "new-key" });
    assert.deepEqual(rows(n).map((r) => [r.session_id, r.session_key]), [["mcp-new", "new-key"], ["real-thread", "old-key"]]);
    assert.equal(n.agentFor("codex", process.pid, { proof: true }), null);
  } finally { n.close(); }
});

for (const proof of ["live", "missing", "malformed", "invalid-pid", "unknown-birth", "reused-pid"]) test(`MCP child recovery handles ${proof} evidence`, () => {
  const n = make();
  try {
    n.bindSession({ agent: "chosen", cli: "codex", session_id: "real-thread", pid: process.pid, session_key: "old-key", channel: true, mcp_pid: process.pid });
    const name = "mcp-process:old-key";
    if (proof === "missing") n.store.db.prepare("DELETE FROM kv WHERE k=?").run(name);
    if (proof === "malformed") n.store.set(name, "{");
    if (proof === "invalid-pid") n.store.set(name, JSON.stringify({ pid: -1, start: "old" }));
    if (proof === "unknown-birth") n.store.set(name, JSON.stringify({ pid: process.pid, start: null }));
    if (proof === "reused-pid") n.store.set(name, JSON.stringify({ pid: process.pid, start: "previous-process" }));
    n.bindSession({ agent: "chosen", cli: "codex", session_id: "mcp-new", pid: process.pid, session_key: "new-key" });
    if (proof === "reused-pid") {
      assert.equal(rows(n).length, 1);
      assert.equal(rows(n)[0].session_id, "real-thread");
      assert.equal(rows(n)[0].session_key, "new-key");
      assert.equal(rows(n)[0].channel, 0);
      assert.equal(n.store.get(name), undefined);
    } else {
      assert.equal(rows(n).length, 2);
      assert.equal(rows(n).find((r) => r.session_id === "real-thread")!.session_key, "old-key");
      assert.equal(n.agentFor("codex", process.pid, { proof: true }), null);
    }
  } finally { n.close(); }
});

for (const restore of [false, true]) test(`reconnect ${restore ? "restores a saved name without blocking later renames" : "honors an explicit name"}`, () => {
  const n = make();
  try {
    n.bindSession({ agent: "saved", cli: "codex", session_id: "thread", pid: process.pid });
    n.keepName("codex", "thread", "saved");
    const binding = { agent: "explicit", cli: "codex", session_id: "mcp-new", pid: process.pid, session_key: "new-key" };
    assert.equal(n.bindSession({ ...binding, restore_name: restore }), restore ? "saved" : "explicit");
    assert.equal(n.bindSession({ ...binding, agent: "later-name" }), "later-name");
    assert.equal(rows(n)[0].agent, "later-name");
  } finally { n.close(); }
});

test("ambiguous saved names are not chosen by reconnect", () => {
  const n = make();
  try {
    for (const name of ["one", "two"]) {
      n.bindSession({ agent: name, cli: "codex", session_id: name, pid: process.pid });
      n.keepName("codex", name, name);
    }
    assert.equal(n.bindSession({ agent: "fresh", cli: "codex", session_id: "mcp-new", pid: process.pid, session_key: "key", restore_name: true }), "fresh");
    assert.equal(rows(n).length, 3);
  } finally { n.close(); }
});
