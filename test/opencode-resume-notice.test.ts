import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { MbxNode } from "../src/node.ts";
import { bindWakeLease } from "./helpers/wake-lease.ts";
import { initCatchup } from "../src/catchup.ts";
import { identityControlKey } from "../src/identity-control.ts";
import { registerIdentity } from "../src/registry.ts";

function fixture(t: TestContext) {
  const n = new MbxNode(mkdtempSync(join(tmpdir(), "mbx-oc-entry-")), { host: "alpha", bind: "127.0.0.1", port: 0 });
  t.after(() => { n.close(); rmSync(n.home, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); });
  const bind = (agent: string, sid: string) => {
    n.registerAgent(agent, { role: "builder" });
    registerIdentity(n.store, { name: agent, role: "builder" });
    bindWakeLease(n, { agent, cli: "opencode", session_id: sid, pid: process.pid });
    initCatchup(n.store, agent, null, "test");
  };
  const hook = (sid: string, event: string, created = false, dev = true) => {
    const r = spawnSync(process.execPath, [resolve("bin/agentmbx.js"), "hook", event, "--cli", "opencode"], {
      input: JSON.stringify({ session_id: sid, cwd: n.home, ...(created ? { mbx_entry: "created" } : {}) }),
      encoding: "utf8", timeout: 20_000,
      env: { ...process.env, AGENTMBX_DEV: dev ? "1" : "", MBX_HOME: n.home, MBX_NO_DESKTOP: "1", MBX_NO_UPDATE_CHECK: "1", HOME: n.home },
    });
    assert.equal(r.status, 0, r.stderr);
    const notices = r.stdout.split("\n").flatMap(line => {
      try { const v = JSON.parse(line); return v.mbx_resume ? [v.mbx_resume] : []; } catch { return []; }
    }) as { session_id: string; text: string }[];
    return { out: r.stdout, notices };
  };
  const protectedState = () => JSON.stringify({ deliveries: n.store.db.prepare("SELECT * FROM deliveries ORDER BY msg_id,agent").all(),
    checkpoint: n.store.db.prepare("SELECT * FROM kv WHERE k LIKE 'catchup:%' ORDER BY k").all(),
    leases: n.store.db.prepare("SELECT * FROM identity_leases ORDER BY name").all() });
  return { n, bind, hook, protectedState };
}

test("T187: bound session.created emits a bounded own-mail notice once, not on later activity", t => {
  const f = fixture(t), sid = "ses_fresh";
  f.bind("worker", sid);
  f.n.send({ from: "sender", to: ["worker"], subject: "PRIVATE SUBJECT", body: "PRIVATE BODY" });
  const before = f.protectedState();
  const notice = f.hook(sid, "session-start", true).notices;
  assert.equal(notice.length, 1);
  assert.equal(notice[0].session_id, sid); assert.match(notice[0].text, /worker@alpha \(role: builder\)/);
  assert.match(notice[0].text, /not caught up on/); assert.match(notice[0].text, /mbx_inbox/);
  assert.ok(notice[0].text.length <= 1200 && notice[0].text.split("\n").length <= 8);
  assert.doesNotMatch(notice[0].text, /PRIVATE SUBJECT|PRIVATE BODY/);
  assert.equal(f.protectedState(), before);
  assert.deepEqual(f.hook(sid, "post-tool").notices, []);
  assert.deepEqual(f.hook(sid, "session-start", true).notices, []);
});

test("T187 D7: zero-count entries stay silent and acknowledged-but-missed mail still gets context", t => {
  const f = fixture(t);
  f.bind("empty-worker", "ses_empty");
  assert.deepEqual(f.hook("ses_empty", "session-start", true).notices, []);
  f.bind("missed-worker", "ses_missed");
  const id = f.n.send({ from: "sender", to: ["missed-worker"], subject: "private", body: "private" }).envelope.id;
  f.n.ack(id, "missed-worker");
  assert.equal(f.n.unreadCount("missed-worker"), 0);
  const before = f.protectedState(), notices = f.hook("ses_missed", "session-start", true).notices;
  assert.equal(notices.length, 1); assert.match(notices[0].text, /1 message\(s\).*not caught up on/);
  assert.equal(f.protectedState(), before);
});

test("T187: created before binding defers only to that session's later existing hook", t => {
  const f = fixture(t);
  const unbound = f.hook("ses_later", "session-start", true);
  assert.deepEqual(unbound.notices, []); assert.match(unbound.out, /not bound|register|claim/);
  f.bind("later-worker", "ses_later");
  f.n.send({ from: "sender", to: ["later-worker"], subject: "private", body: "private" });
  const before = f.protectedState();
  assert.equal(f.hook("ses_later", "post-tool").notices.length, 1);
  assert.equal(f.protectedState(), before);
  assert.deepEqual(f.hook("ses_later", "post-tool").notices, []);
});

test("T187: interleaved shared-PID sessions don't turn ordinary activity into new entries", t => {
  const f = fixture(t);
  for (const suffix of ["a", "b"]) {
    f.bind(`worker-${suffix}`, `ses_${suffix}`);
    f.n.send({ from: "sender", to: [`worker-${suffix}`], subject: "private", body: "private" });
  }
  for (const suffix of ["a", "b"]) assert.equal(f.hook(`ses_${suffix}`, "session-start", true).notices.length, 1);
  for (const suffix of ["a", "b", "a", "b"]) assert.deepEqual(f.hook(`ses_${suffix}`, "post-tool").notices, []);
  f.bind("existing-worker", "ses_existing");
  f.n.send({ from: "sender", to: ["existing-worker"], subject: "private", body: "private" });
  assert.deepEqual(f.hook("ses_existing", "session-start").notices, [], "a generic startup hook without native-created provenance is not resume");
  assert.deepEqual(f.hook("ses_existing", "post-tool").notices, [], "first post-tool is not a resume event");
});

test("T187: missing binding or stale connector emits fallback, never a resume envelope or a claim", t => {
  const f = fixture(t);
  const before = f.protectedState();
  assert.deepEqual(f.hook("", "session-start", true).notices, []);
  assert.equal(f.protectedState(), before);
  f.bind("stale-worker", "ses_stale");
  f.n.send({ from: "sender", to: ["stale-worker"], subject: "private", body: "private" });
  const key = f.n.sessionsFor("stale-worker")[0].session_key!;
  f.n.store.db.prepare("DELETE FROM kv WHERE k IN (?,?)").run(identityControlKey("opencode", "ses_stale"), `mcp-process:${key}`);
  const staleBefore = f.protectedState(), result = f.hook("ses_stale", "session-start", true);
  assert.deepEqual(result.notices, []); assert.match(result.out, /mbx disconnected.*stale-worker/);
  assert.equal(f.protectedState(), staleBefore);
});

test("T187: guided-limit hint is retained verbatim without exporting task or message text", t => {
  const f = fixture(t); f.bind("overlimit-worker", "ses_overlimit");
  f.n.send({ from: "sender", to: ["overlimit-worker"], subject: "PRIVATE SUBJECT", body: "PRIVATE BODY" });
  const record = JSON.parse(f.n.store.get("catchup:overlimit-worker")!);
  f.n.store.set("catchup:overlimit-worker", JSON.stringify({ ...record, updated_at: Date.now() - 8 * 86_400_000 }));
  const notice = f.hook("ses_overlimit", "session-start", true).notices[0].text;
  assert.match(notice, /over the guided limit/); assert.match(notice, /mbx_catchup.*optional/);
  assert.doesNotMatch(notice, /PRIVATE SUBJECT|PRIVATE BODY|\bT\d+\b|recent_notes/);
});

test("T187: the compiled hook emits the same exact-session bounded entry envelope", t => {
  const f = fixture(t); f.bind("compiled-worker", "ses_compiled");
  f.n.send({ from: "sender", to: ["compiled-worker"], subject: "private", body: "private" });
  const before = f.protectedState();
  const notices = f.hook("ses_compiled", "session-start", true, false).notices;
  assert.equal(notices.length, 1); assert.equal(notices[0].session_id, "ses_compiled");
  assert.match(notices[0].text, /compiled-worker@alpha/); assert.match(notices[0].text, /mbx_catchup/);
  assert.equal(f.protectedState(), before);
});

// T187: OpenCode fires session.created only for a new conversation, so a reopened tab or a restarted serve enters
// through its serve generation. post-tool does not rebind, so the row stands for whatever serve wrote it last.
test("T187: a conversation already noticed is entered once more by a new serve generation", t => {
  const f = fixture(t), sid = "ses_revisit", agent = "revisit-worker";
  f.bind(agent, sid);
  f.n.send({ from: "sender", to: [agent], subject: "PRIVATE SUBJECT", body: "PRIVATE BODY" });
  const before = f.protectedState();
  const fresh = f.hook(sid, "session-start", true).notices;
  assert.equal(fresh.length, 1, "the fresh entry notices first");
  assert.deepEqual(f.hook(sid, "post-tool").notices, [], "the same serve generation is never noticed twice");
  // a new serve generation for the same conversation (a reopened tab, or a restarted serve)
  f.n.store.db.prepare("UPDATE sessions SET pid=?, pid_start=? WHERE cli='opencode' AND session_id=?").run(4242, "ps-utc:Thu Oct 16 00:20:00 2026", sid);
  const again = f.hook(sid, "post-tool").notices;
  assert.equal(again.length, 1, "the new generation is entered once");
  assert.equal(again[0].session_id, sid);
  assert.match(again[0].text, /revisit-worker@alpha \(role: builder\)/);
  assert.match(again[0].text, /not caught up on/);
  assert.ok(again[0].text.length <= 1200 && again[0].text.split("\n").length <= 8, "bounded like the fresh entry");
  assert.doesNotMatch(again[0].text, /PRIVATE SUBJECT|PRIVATE BODY/);
  assert.equal(f.protectedState(), before, "no mail, lease or checkpoint change");
  assert.deepEqual(f.hook(sid, "post-tool").notices, [], "and then it is silent too");
});

test("T187: a conversation that was never noticed is not a resume, whatever its serve generation", t => {
  const f = fixture(t), sid = "ses_unnoticed", agent = "unnoticed-worker";
  f.bind(agent, sid);
  f.n.send({ from: "sender", to: [agent], subject: "private", body: "private" });
  const before = f.protectedState();
  assert.deepEqual(f.hook(sid, "post-tool").notices, [], "ordinary activity is not an entry");
  f.n.store.db.prepare("UPDATE sessions SET pid=?, pid_start=? WHERE cli='opencode' AND session_id=?").run(5252, "ps-utc:Thu Oct 16 00:25:00 2026", sid);
  assert.deepEqual(f.hook(sid, "post-tool").notices, [], "and a new generation alone does not make it one");
  assert.equal(f.protectedState(), before);
});

test("T187 D7: a revisit with nothing to catch up on stays silent and records no notice", t => {
  const f = fixture(t);
  f.bind("quiet-worker", "ses_quiet");
  const before = f.protectedState();
  assert.deepEqual(f.hook("ses_quiet", "session-start", true).notices, []);
  assert.deepEqual(f.hook("ses_quiet", "post-tool").notices, []);
  assert.equal(f.protectedState(), before);
});
