import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MbxNode } from "../src/node.ts";
import { IdentityLeases, inspectLeaseProcess } from "../src/identity-leases.ts";
import { hudAlivePath, hudDir, hudSessionPath, hudSessionV2Path, hudPidV2Path, hudSessionLinePath, writeHud, hudStatusV2 } from "../src/hud.ts";

const fixture = () => {
  const home = mkdtempSync(join(tmpdir(), "mbx-hud-v2-"));
  const node = new MbxNode(home, { host: "alpha" });
  const bind = (name: string, sid: string) => {
    node.bindSession({ agent: name, cli: "kimi", session_id: sid, pid: process.pid, session_key: sid });
    new IdentityLeases(node.store).claim(name, { pid: process.pid, start: inspectLeaseProcess(process.pid).start!, keyFp: "aaaa-bbbb-cccc-dddd", cli: "kimi", sessionId: sid });
  };
  return { home, node, bind, close: () => { node.close(); rmSync(home, { recursive: true, force: true }); } };
};
const read = (path: string) => JSON.parse(readFileSync(path, "utf8"));

test("T405: v2 and v1 are emitted together, private, content-compared, refreshed and pruned", t => {
  const f = fixture(); t.after(f.close);
  f.bind("drum", "session-a");
  f.node.send({ from: "boss", to: ["drum"], subject: "mail", body: "b", needs_reply: true });
  const now = Date.now(); writeHud(f.node, now);
  const session = hudSessionV2Path(f.home, "kimi", "session-a");
  const pid = hudPidV2Path(f.home, "kimi", process.pid, inspectLeaseProcess(process.pid).start!);
  const v2 = read(session), v1 = read(hudSessionPath(f.home, "kimi", "session-a"));
  assert.equal(v2.schema, "mbx.status/v2"); assert.equal(v1.schema, "mbx.status/v1");
  assert.equal(v2.inbox.unread, v1.unread); assert.equal(v2.inbox.needs_reply, 1);
  assert.equal(v2.harness.session_id, "session-a"); assert.equal(v2.registration.lease.verified, true);
  assert.equal(read(pid).resolved_by, "pid"); assert.equal(read(pid).harness.session_id, null);
  assert.equal(read(pid).registration.lease, null);
  assert.equal(statSync(session).mode & 0o777, 0o600); assert.equal(statSync(pid).mode & 0o777, 0o600);
  assert.equal(statSync(hudDir(f.home)).mode & 0o777, 0o700);
  assert.equal(readFileSync(hudSessionLinePath(f.home, "kimi", "session-a"), "utf8"), "mbx drum 1↑ 1↺\n");
  const inode = statSync(session).ino, mtime = statSync(session).mtimeMs;
  writeHud(f.node, now + 1);
  assert.equal(statSync(session).ino, inode); assert.equal(statSync(session).mtimeMs, mtime);
  assert.equal(readFileSync(hudAlivePath(f.home), "utf8"), String(now + 1));
  f.node.ack(f.node.inbox("drum")[0].id, "drum"); writeHud(f.node, now + 2);
  assert.equal(read(session).inbox.unread, 0); assert.notEqual(statSync(session).ino, inode, "replacement uses atomic rename");
  assert.equal(readFileSync(hudSessionLinePath(f.home, "kimi", "session-a"), "utf8"), "");
  assert.ok(!readdirSync(hudDir(f.home)).some(p => p.includes(".tmp-")));
  f.node.store.db.prepare("DELETE FROM sessions").run(); writeHud(f.node, now + 3);
  assert.deepEqual(readdirSync(hudDir(f.home)), [".alive"]);
});

test("T405: shared PID sessions keep separate mailboxes and unknown sessions remain unbound", t => {
  const f = fixture(); t.after(f.close); f.bind("one", "a"); f.bind("other", "b");
  f.node.send({ from: "boss", to: ["one"], subject: "mail", body: "b" }); writeHud(f.node);
  const a = read(hudSessionV2Path(f.home, "kimi", "a")), b = read(hudSessionV2Path(f.home, "kimi", "b"));
  assert.equal(a.identity.name, "one"); assert.equal(a.inbox.unread, 1);
  assert.equal(b.identity.name, "other"); assert.equal(b.inbox.unread, 0);
  assert.ok(!readdirSync(hudDir(f.home)).some(p => p.includes("-pid-")));
  const unknown = hudStatusV2(f.node, { cli: "kimi", sessionId: "missing", agent: null, state: "unbound", resolvedBy: "none" });
  assert.equal(unknown.identity.state, "unbound"); assert.equal(unknown.identity.name, null);
  assert.deepEqual(unknown.inbox, { unread: 0, needs_reply: 0, from_owner: 0, outbox_unsent: 0 });
  assert.equal(unknown.registration.registered, false); assert.equal(unknown.project, null);
  f.node.store.db.prepare("UPDATE sessions SET pid_start='reused'").run(); writeHud(f.node);
  assert.deepEqual(readdirSync(hudDir(f.home)), [".alive"], "reused PID cannot keep either schema's stale mailbox");
});


test("T405: v2 metadata failure prunes v2 while preserving legacy output and the heartbeat", t => {
  const f = fixture(); t.after(f.close); f.bind("one", "a");
  f.node.send({ from: "boss", to: ["one"], subject: "mail", body: "b" }); writeHud(f.node);
  t.mock.method(f.node, "peers", () => { throw new Error("metadata unavailable"); });
  const now = Date.now() + 10; writeHud(f.node, now);
  assert.equal(read(hudSessionPath(f.home, "kimi", "a")).unread, 1);
  assert.equal(readFileSync(hudSessionLinePath(f.home, "kimi", "a"), "utf8"), "mbx one 1↑\n");
  assert.ok(!readdirSync(hudDir(f.home)).some(p => p.endsWith(".v2.json")));
  assert.equal(readFileSync(hudAlivePath(f.home), "utf8"), String(now));
});

test("T405: multiple sessions and PID output reuse a single mailbox count pass per identity", t => {
  const f = fixture(); t.after(f.close); f.bind("one", "a");
  f.node.bindSession({ agent: "one", cli: "kimi", session_id: "b", pid: process.pid, session_key: "b" });
  const prepare = f.node.store.db.prepare.bind(f.node.store.db);
  let mailboxReads = 0;
  t.mock.method(f.node.store.db, "prepare", (sql: string) => {
    if (sql.includes("FROM deliveries d JOIN messages m")) mailboxReads++;
    return prepare(sql);
  });
  writeHud(f.node);
  assert.equal(mailboxReads, 1, "session and PID v1/v2 snapshots share one mailbox pass");
  assert.equal(read(hudSessionV2Path(f.home, "kimi", "a")).harness.session_id, "a");
  assert.equal(read(hudSessionV2Path(f.home, "kimi", "b")).harness.session_id, "b");
});
