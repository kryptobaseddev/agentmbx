import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MbxNode } from "../src/node.ts";

const node = () => new MbxNode(mkdtempSync(join(tmpdir(), "mbx-rename-")), { host: "alpha" });
const bind = (n: MbxNode, agent: string, pid = process.pid) => n.bindSession({ agent, cli: "claude", session_id: `session-${pid}`, pid, session_key: `key-${pid}` });
const send = (n: MbxNode, to: string[]) => n.send({ from: "sender", to, subject: "rename", body: "unchanged signed body" }).envelope.id;

test("rename moves unacked mail and session bindings while preserving signed envelopes and completed history", () => {
  const n = node();
  try {
    bind(n, "before");
    n.bindSession({ agent: "before", cli: "claude", session_id: "hook-thread", pid: process.pid });
    n.linkIdentity("shell-name", "before");
    const id = send(n, ["before"]), done = send(n, ["before"]);
    n.ack(done, "before", "completed");
    const original = n.read(id, "before").envelope;
    n.addAlias("before", "after", process.pid);
    assert.deepEqual(n.inbox("after").map((m) => m.id), [id]);
    assert.equal(n.read(id, "after").envelope, original);
    assert.equal(n.agentFor("claude", process.pid), "after");
    assert.equal(n.store.get("name:claude:hook-thread"), "after");
    assert.equal(n.resolveAlias("before"), "after");
    assert.deepEqual(n.linkedNames("after"), ["shell-name"]);
    assert.equal(n.unreadCount("before"), 0);
    assert.equal(n.inbox("before", { all: true })[0].id, done);
    n.ack(id, "after");
    assert.equal(n.unreadCount("after"), 0);
    const future = send(n, ["before"]);
    assert.equal(n.read(future, "after").id, future);
    n.addAlias("after", "before", process.pid);
    assert.equal(n.resolveAlias("after"), "before", "renaming back does not form an alias cycle");
    assert.equal(n.resolveAlias("before"), "before");
    assert.equal(n.read(future, "before").id, future);
  } finally { n.close(); }
});

test("rename never resurrects a duplicate recipient's ack or loses a more advanced pending state", () => {
  const n = node();
  try {
    bind(n, "before");
    const done = send(n, ["before", "after"]), pending = send(n, ["before", "after"]);
    n.ack(done, "after", "already done");
    n.setDelivery(pending, "before", "read", "read before rename");
    n.addAlias("before", "after", process.pid);
    assert.deepEqual(n.inbox("after").map((m) => [m.id, m.state]), [[pending, "read"]]);
    const rows = n.store.db.prepare("SELECT msg_id,state,note FROM deliveries WHERE agent='after'").all();
    assert.equal(rows.find((r) => r.msg_id === done)!.note, "already done");
    assert.equal(rows.find((r) => r.msg_id === pending)!.note, "read before rename");
    assert.equal(n.unreadCount("before"), 0);
  } finally { n.close(); }
});

test("rename refuses an occupied target and never transfers an unowned or shared source mailbox", () => {
  const n = node();
  try {
    bind(n, "before");
    bind(n, "occupied", process.ppid);
    const id = send(n, ["before"]);
    assert.throws(() => n.addAlias("before", "occupied", process.pid), /in use/);
    assert.equal(n.read(id, "before").id, id);
    assert.equal(n.store.get("alias:before"), undefined);
    // The old source is now shared by another live process.
    bind(n, "before", process.ppid);
    n.addAlias("before", "after", process.pid);
    assert.equal(n.unreadCount("after"), 0);
    assert.equal(n.unreadCount("before"), 1);
    // A historical routing alias is insufficient evidence for transferring a mailbox.
    const unowned = send(n, ["unowned"]);
    n.addAlias("unowned", "after", process.pid);
    assert.throws(() => n.read(unowned, "after"), /no message/);
  } finally { n.close(); }
});

test("PID reuse cannot transfer the previous process's pending mailbox", () => {
  const n = node();
  try {
    bind(n, "before");
    const id = send(n, ["before"]);
    n.store.db.prepare("UPDATE sessions SET pid_start='different-process'").run();
    n.addAlias("before", "after", process.pid);
    assert.equal(n.read(id, "before").id, id);
    assert.throws(() => n.read(id, "after"), /no message/);
  } finally { n.close(); }
});

test("two MCP sessions sharing a host PID do not acquire each other's mailbox through rename", () => {
  const n = node();
  try {
    bind(n, "before");
    n.bindSession({ agent: "occupied", cli: "kimi", session_id: "other-session", pid: process.pid, session_key: "other-key" });
    assert.throws(() => n.addAlias("before", "occupied", process.pid), /in use/);
    n.bindSession({ agent: "before", cli: "kimi", session_id: "other-session", pid: process.pid, session_key: "other-key" });
    const id = send(n, ["before"]);
    n.addAlias("before", "after", process.pid);
    assert.equal(n.store.get("alias:before"), undefined);
    assert.equal(n.read(id, "before").id, id);
    assert.throws(() => n.read(id, "after"), /no message/);
  } finally { n.close(); }
});

test("rename rolls back mailbox and binding changes together if recording the rename fails", (t) => {
  const n = node();
  try {
    bind(n, "before");
    const id = send(n, ["before"]);
    t.mock.method(n.store, "audit", () => { throw new Error("audit unavailable"); });
    assert.throws(() => n.addAlias("before", "after", process.pid), /audit unavailable/);
    assert.equal(n.store.get("alias:before"), undefined);
    assert.equal(n.agentFor("claude", process.pid), "before");
    assert.deepEqual(n.inbox("before").map((m) => m.id), [id]);
    assert.equal(n.unreadCount("after"), 0);
  } finally { t.mock.restoreAll(); n.close(); }
});
