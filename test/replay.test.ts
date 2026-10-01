import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MbxNode } from "../src/node.ts";
import { IdentityLeases, inspectLeaseProcess } from "../src/identity-leases.ts";
import { Store } from "../src/store.ts";
import { buildEnvelope } from "../src/envelope.ts";
import { resetReplayEpoch, type ReplayPage } from "../src/replay.ts";

function fixture(t: TestContext) {
  const home = mkdtempSync(join(tmpdir(), "mbx-replay-")), node = new MbxNode(home, { host: "alpha" });
  t.after(() => { node.close(); rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
  const leases = new IdentityLeases(node.store);
  const holder = { pid: process.pid, start: inspectLeaseProcess(process.pid).start!, keyFp: "aaaa-aaaa-aaaa-aaaa", cli: "test", sessionId: "test" };
  const lease = leases.claim("reader", holder);
  const send = (body = "mail", to = ["reader"]) => node.send({ from: "sender", to, body, subject: "replay" }).envelope;
  return { home, node, leases, holder, token: lease.token, send };
}
const ids = (page: ReplayPage) => page.messages.map(m => m.id);
const frame = (cursor: string) => JSON.parse(Buffer.from(cursor, "base64url").toString());
const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
const snapshot = (node: MbxNode) => JSON.stringify(["messages", "deliveries", "identity_leases", "kv", "wakes", "grants"].map(t => node.store.db.prepare(`SELECT * FROM ${t}`).all()));

test("finite replay snapshots, identical retries and late visibility do not skip arrivals or ACK", t => {
  const f = fixture(t), a = f.send(), b = f.send(), before = snapshot(f.node);
  const first = f.node.replay("reader", f.token, { limit: 1 });
  assert.deepEqual(ids(first), [a.id]); assert.equal(first.has_more, true);
  const secondInput = first.next_cursor;
  const second = f.node.replay("reader", f.token, { cursor: secondInput, limit: 1 });
  assert.deepEqual(ids(second), [b.id]); assert.equal(second.has_more, false);
  assert.equal(snapshot(f.node), before, "query never updates ACK, heartbeat or checkpoint state");
  const old = buildEnvelope({ from: "sender@remote", to: ["reader"], subject: "backdated", body: "old" });
  old.ts = "2000-01-01T00:00:00.000Z";
  f.node.store.insertMessage(old, "remote", "verified", null);
  const newer = f.send(); f.node.store.addDelivery(old.id, "reader");
  assert.deepEqual(f.node.replay("reader", f.token, { cursor: secondInput, limit: 1 }), second);
  const poll = f.node.replay("reader", f.token, { cursor: second.next_cursor });
  assert.deepEqual(ids(poll), [newer.id, old.id]);
});

test("bounded filtered and no-longer-visible ranges progress without exposing hidden IDs", t => {
  const f = fixture(t), messages = Array.from({ length: 7 }, () => f.send());
  for (const m of messages.slice(0, 6)) f.node.store.db.prepare("DELETE FROM deliveries WHERE msg_id=? AND agent='reader'").run(m.id);
  const a = f.node.replay("reader", f.token, { scanLimit: 2 });
  assert.equal(a.messages.length, 0); assert.equal(a.has_more, true);
  const b = f.node.replay("reader", f.token, { cursor: a.next_cursor, scanLimit: 2 });
  assert.ok(frame(b.next_cursor).position > frame(a.next_cursor).position);
  const c = f.node.replay("reader", f.token, { cursor: b.next_cursor, scanLimit: 2 });
  const d = f.node.replay("reader", f.token, { cursor: c.next_cursor, scanLimit: 2 });
  assert.deepEqual(ids(d), [messages[6].id]); assert.equal(d.has_more, false);
  assert.ok(!JSON.stringify(a).includes(messages[0].id));
});

test("UTF8 whole-page budgets omit a first oversized body and defer later items without skipping", t => {
  const f = fixture(t), large = f.send("🧠".repeat(3000)), small = f.send("tail");
  const first = f.node.replay("reader", f.token, { maxBytes: 2048 });
  assert.deepEqual(first.messages[0], { id: large.id, content_omitted: true, reason: "REPLAY_ITEM_TOO_LARGE" });
  assert.ok(Buffer.byteLength(JSON.stringify(first)) <= 2048);
  const seen = [...ids(first)]; let p = first;
  while (p.has_more) { p = f.node.replay("reader", f.token, { cursor: p.next_cursor, maxBytes: 2048 }); seen.push(...ids(p)); }
  assert.deepEqual(seen, [large.id, small.id]);
  assert.equal(f.node.read(large.id, "reader").body.length, 6000);
});

test("exact limit edges produce all messages once with bounded default/max pages", t => {
  const f = fixture(t), expected = Array.from({ length: 201 }, () => f.send().id);
  let page = f.node.replay("reader", f.token, { limit: 200, maxBytes: 262144 });
  const seen = ids(page);
  while (page.has_more) { page = f.node.replay("reader", f.token, { cursor: page.next_cursor, limit: 200, maxBytes: 262144 }); seen.push(...ids(page)); }
  assert.deepEqual(seen, expected); assert.equal(new Set(seen).size, 201);
  for (const limit of [0, -1, 1.5, 201, NaN, Infinity]) assert.throws(() => f.node.replay("reader", f.token, { limit }), { code: "CURSOR_INVALID" });
});

test("cursor frames fail closed on scope, epoch, unsafe bounds and malformed encoding", t => {
  const f = fixture(t); f.send();
  const cursor = f.node.replay("reader", f.token).next_cursor, base = frame(cursor);
  for (const value of [null, [], { ...base, v: 2 }, { ...base, position: -1 }, { ...base, position: 0.2 },
    { ...base, end: Number.MAX_SAFE_INTEGER + 1 }, { ...base, end: base.end + 1 }, { ...base, extra: 1 }])
    assert.throws(() => f.node.replay("reader", f.token, { cursor: encode(value) }), { code: "CURSOR_INVALID" });
  for (const bad of ["!", "A", "x".repeat(2049), Buffer.from([255]).toString("base64url")])
    assert.throws(() => f.node.replay("reader", f.token, { cursor: bad }), { code: "CURSOR_INVALID" });
  assert.throws(() => f.node.replay("reader", f.token, { cursor: encode({ ...base, mailbox: "other" }) }), { code: "CURSOR_SCOPE_MISMATCH" });
  assert.throws(() => f.node.replay("reader", f.token, { cursor, topic: "changed" }), { code: "CURSOR_SCOPE_MISMATCH" });
  resetReplayEpoch(f.node.store);
  assert.throws(() => f.node.replay("reader", f.token, { cursor }), { code: "CURSOR_EXPIRED" });
});

test("exact sender-host project and signed topic filters never broaden mailbox visibility", t => {
  const f = fixture(t);
  const own = f.node.send({ from: "sender", to: ["reader"], subject: "project", body: "#handoff", project: "/repo" }).envelope;
  f.node.send({ from: "sender", to: ["other"], subject: "hidden", body: "#handoff", project: "/repo" });
  const page = f.node.replay("reader", f.token, { project: "/repo", project_host: "alpha", topic: "handoff" });
  assert.deepEqual(ids(page), [own.id]);
  assert.throws(() => f.node.replay("reader", f.token, { project: "/repo" }), { code: "CURSOR_INVALID" });
  assert.equal(f.node.replay("reader", f.token, { project: "/repo", project_host: "remote" }).messages.length, 0);
  assert.ok(!Buffer.from(page.next_cursor, "base64url").toString().includes("/repo"));
});

test("same persona provider restart resumes while stale lease and foreign mailbox are denied", t => {
  const f = fixture(t), a = f.send(), b = f.send();
  const first = f.node.replay("reader", f.token, { limit: 1 });
  f.leases.release("reader", f.token);
  const replacement = f.leases.claim("reader", { ...f.holder, cli: "codex", sessionId: "replacement" });
  assert.throws(() => f.node.replay("reader", f.token, { cursor: first.next_cursor }), { code: "IDENTITY_LEASE_LOST" });
  const reopened = new MbxNode(f.home); t.after(() => reopened.close());
  assert.deepEqual(ids(reopened.replay("reader", replacement.token, { cursor: first.next_cursor })), [b.id]);
  assert.equal(ids(first)[0], a.id);
  assert.throws(() => reopened.replay("other", replacement.token, { cursor: first.next_cursor }), { code: "IDENTITY_LEASE_LOST" });
});

test("independent writers append visibility after a captured snapshot and completed poll finds it", t => {
  const f = fixture(t); f.send(); f.send();
  const first = f.node.replay("reader", f.token, { limit: 1 });
  const late = f.send("late", ["other"]), other = new Store(f.home);
  try { other.addDelivery(late.id, "reader"); } finally { other.close(); }
  const second = f.node.replay("reader", f.token, { cursor: first.next_cursor });
  assert.ok(!ids(second).includes(late.id));
  assert.deepEqual(ids(f.node.replay("reader", f.token, { cursor: second.next_cursor })), [late.id]);
});

test("first-ever pair dedup means rename away/back needs explicit historical rewind", t => {
  const f = fixture(t), e = f.send(), completed = f.node.replay("reader", f.token);
  f.node.bindSession({ agent: "reader", cli: "claude", session_id: `mcp-${process.pid}`, pid: process.pid, session_key: "key" });
  f.node.addAlias("reader", "renamed", process.pid);
  assert.equal(f.node.replay("reader", f.token).messages.length, 0, "old events do not authorize removed mail");
  f.node.addAlias("renamed", "reader", process.pid);
  assert.equal(f.node.replay("reader", f.token, { cursor: completed.next_cursor }).messages.length, 0);
  assert.deepEqual(ids(f.node.replay("reader", f.token)), [e.id]);
});


test("highwater and row selection share one read snapshot across an interleaved WAL writer", t => {
  const f = fixture(t), first = f.send(), late = f.send("late", ["other"]), writer = new Store(f.home);
  const original = f.node.store.db;
  let inserted = false;
  f.node.store.db = new Proxy(original, { get(target, property) {
    const value = Reflect.get(target, property);
    if (property !== "prepare") return typeof value === "function" ? value.bind(target) : value;
    return (sql: string) => {
      const statement = original.prepare(sql);
      if (!sql.startsWith("SELECT COALESCE(MAX(seq)")) return statement;
      return new Proxy(statement, { get(stmt, key) {
        const method = Reflect.get(stmt, key);
        if (key !== "get") return typeof method === "function" ? method.bind(stmt) : method;
        return (...args: unknown[]) => {
          const result = method.apply(stmt, args);
          if (!inserted) { inserted = true; writer.addDelivery(late.id, "reader"); }
          return result;
        };
      } });
    };
  } });
  try {
    const page = f.node.replay("reader", f.token);
    assert.deepEqual(ids(page), [first.id]);
    assert.deepEqual(ids(f.node.replay("reader", f.token, { cursor: page.next_cursor })), [late.id]);
  } finally { f.node.store.db = original; writer.close(); }
});

test("returned byte-limited continuation defers a visible item instead of advancing past it", t => {
  const f = fixture(t), a = f.send("first"), b = f.send("second");
  const page = f.node.replay("reader", f.token, { maxBytes: 2048 });
  assert.deepEqual(ids(page), [a.id]); assert.equal(page.has_more, true);
  const again = f.node.replay("reader", f.token, { cursor: page.next_cursor, maxBytes: 2048 });
  assert.deepEqual(ids(again), [b.id]); assert.equal(again.has_more, false);
  assert.ok(Buffer.byteLength(JSON.stringify(page), "utf8") <= 2048);
});


test("unsigned positions permit an authorized deliberate rewind/skip without granting foreign mail", t => {
  const f = fixture(t), a = f.send(), b = f.send(), c = f.send();
  const first = f.node.replay("reader", f.token, { limit: 1 }), cursor = frame(first.next_cursor);
  const bPosition = Number(f.node.store.db.prepare("SELECT seq FROM mailbox_visibility WHERE mailbox='reader' AND message_id=?").get(b.id)!.seq);
  const deliberatelySkipped = f.node.replay("reader", f.token, { cursor: encode({ ...cursor, position: bPosition }) });
  assert.deepEqual(ids(deliberatelySkipped), [c.id], "position is not a MAC-authenticated server receipt");
  const rewind = f.node.replay("reader", f.token, { cursor: encode({ ...cursor, position: 0 }) });
  assert.deepEqual(ids(rewind), [a.id, b.id, c.id]);
  assert.throws(() => f.node.replay("reader", f.token, { cursor: encode({ ...cursor, mailbox: "foreign" }) }), { code: "CURSOR_SCOPE_MISMATCH" });
});
