// T157/T158: consumer checkpoints per identity (spec docs/spec/session-catchup.md, CU-01..CU-10).
// Fetch pages like replay and never advances; commit is monotonic and lease-fenced; catch-up never
// acks, marks read, or grants authority.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { MbxNode } from "../src/node.ts";
import { IdentityLeases, inspectLeaseProcess } from "../src/identity-leases.ts";
import { catchupHint, commitCatchup, ensureCatchup, initCatchup, missedCount, moveCatchup, readCatchup, restartCatchup } from "../src/catchup.ts";
import { encodeReplayFrame, resetReplayEpoch, replayMaximum } from "../src/replay.ts";
import type { IdentityLease } from "../src/identity-leases.ts";

const env = (home: string, agent = "worker") => ({ ...process.env, AGENTMBX_DEV: "1", MBX_HOME: home, MBX_CLI: "kimi", MBX_AGENT: agent, MBX_NO_DESKTOP: "1" }) as Record<string, string>;
const connect = async (home: string, agent = "worker") => {
  const c = new Client({ name: "catchup-test", version: "1" });
  await c.connect(new StdioClientTransport({ command: process.execPath, args: [resolve("bin/agentmbx.js"), "mcp"], env: env(home, agent) }));
  return c;
};
const selfStart = () => inspectLeaseProcess(process.pid).start!;
const claimDirect = (n: MbxNode, name: string, session = "s") =>
  new IdentityLeases(n.store).claim(name, { pid: process.pid, start: selfStart(), keyFp: "aaaa-bbbb-cccc-dddd", cli: "kimi", sessionId: session });
const leaseRow = (n: MbxNode, name: string) => n.store.db.prepare("SELECT * FROM identity_leases WHERE name=?").get(name) as unknown as IdentityLease;
const beat = (n: MbxNode, name: string, at: number) => n.store.db.prepare("UPDATE identity_leases SET heartbeat_at=? WHERE name=?").run(at, name);

test("CU-01: an identity with history starts at its last-held seq with an audited origin; a never-held one starts at the end", (t) => {
  const home = mkdtempSync(join(tmpdir(), "mbx-cu01-")), n = new MbxNode(home, { host: "alpha" });
  t.after(() => { n.close(); rmSync(home, { recursive: true, force: true }); });
  const a = n.send({ from: "boss", to: ["worker"], subject: "early", body: "b" }).envelope;
  const b = n.send({ from: "boss", to: ["worker"], subject: "late", body: "b" }).envelope;
  const anchor = Date.now() - 1;
  // deterministic arrival times around the anchor: a arrived while held, b after
  n.store.db.prepare("UPDATE messages SET received_at=? WHERE id=?").run(new Date(anchor - 1).toISOString(), a.id);
  n.store.db.prepare("UPDATE messages SET received_at=? WHERE id=?").run(new Date(anchor + 60_000).toISOString(), b.id);
  // crash: the holder's last heartbeat and release sit at the anchor
  claimDirect(n, "worker");
  beat(n, "worker", anchor);
  n.store.db.prepare("UPDATE identity_leases SET released_at=?, release_reason='released' WHERE name='worker'").run(anchor);
  const record = initCatchup(n.store, "worker", leaseRow(n, "worker"), "tester");
  const seqOf = (id: string) => Number(n.store.db.prepare("SELECT seq FROM mailbox_visibility WHERE mailbox='worker' AND message_id=?").get(id)!.seq);
  assert.equal(record.position, seqOf(a.id), "origin is the last seq visible while last held, not the current end");
  const audit = n.store.db.prepare("SELECT detail FROM audit WHERE event='catchup.init'").get() as { detail: string };
  assert.match(audit.detail, /last-held /);
  // never-held identity with no record: starts at the current end
  const fresh = initCatchup(n.store, "fresh", null, "tester");
  assert.equal(fresh.position, replayMaximum(n.store, "fresh"));
});

test("CU-01b: the origin anchors on arrival time, not the sender clock: late-delivered queued mail counts as missed", (t) => {
  const home = mkdtempSync(join(tmpdir(), "mbx-cu01b-")), n = new MbxNode(home, { host: "alpha" });
  t.after(() => { n.close(); rmSync(home, { recursive: true, force: true }); });
  const anchor = Date.now() - 60_000;
  const insert = (id: string, ts: string, receivedAt: string) => {
    n.store.db.prepare(`INSERT INTO messages (id,ts,from_addr,thread,reply_to,kind,subject,body,envelope,origin,trust,authority,received_at)
      VALUES (?,?,?,?,NULL,'message','s','b','{}','fedora','verified',NULL,?)`).run(id, ts, `peer@fedora`, id, receivedAt);
    n.store.addDelivery(id, "worker");
  };
  insert("early-arrival", new Date(anchor - 3_600_000).toISOString(), new Date(anchor - 30_000).toISOString());
  // queued cross-host mail: the sender wrote it before the crash, but it only arrived after
  insert("late-arrival", new Date(anchor - 7_200_000).toISOString(), new Date(anchor + 60_000).toISOString());
  claimDirect(n, "worker");
  beat(n, "worker", anchor);
  n.store.db.prepare("UPDATE identity_leases SET released_at=?, release_reason='released' WHERE name='worker'").run(anchor);
  const record = initCatchup(n.store, "worker", leaseRow(n, "worker"), "tester");
  const seqOf = (id: string) => Number(n.store.db.prepare("SELECT seq FROM mailbox_visibility WHERE mailbox='worker' AND message_id=?").get(id)!.seq);
  assert.equal(record.position, seqOf("early-arrival"), "only mail that had ARRIVED while held is the origin");
  assert.ok(record.position < seqOf("late-arrival"));
  assert.equal(missedCount(n.store, "worker").missed, 1, "the late arrival is exactly what catch-up must surface");
});

test("CU-02 + CU-06: fetching pages does not advance the checkpoint and mutates no delivery state", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "mbx-cu02-")), n = new MbxNode(home, { host: "alpha" });
  const c = await connect(home);
  t.after(async () => { await c.close(); n.close(); rmSync(home, { recursive: true, force: true }); });
  await c.callTool({ name: "mbx_whoami", arguments: {} }); // claim; record starts at the current end
  const m1 = n.send({ from: "boss", to: ["worker"], subject: "one", body: "b" }).envelope;
  const m2 = n.send({ from: "boss", to: ["worker"], subject: "two", body: "b" }).envelope;
  const before = n.store.db.prepare("SELECT * FROM deliveries ORDER BY msg_id").all();
  const page = (await c.callTool({ name: "mbx_catchup", arguments: {} })).structuredContent as { messages: { id: string }[]; catchup: { position: number; missed: number } };
  assert.deepEqual(page.messages.map((m) => m.id), [m1.id, m2.id]);
  assert.equal(page.catchup.missed, 2);
  const record = readCatchup(n.store, "worker")!;
  assert.ok(record.position < Number(n.store.db.prepare("SELECT MAX(seq) seq FROM mailbox_visibility WHERE mailbox='worker'").get()!.seq));
  const again = (await c.callTool({ name: "mbx_catchup", arguments: {} })).structuredContent as { messages: { id: string }[]; next_cursor: string; catchup: { unchanged: boolean; hint: string; position: number } };
  assert.deepEqual(again.messages.map((m) => m.id), [m1.id, m2.id], "re-fetch from the stored position returns the same page");
  assert.equal(again.catchup.unchanged, true, "a re-fetch without commit says the page is unchanged");
  assert.match(again.catchup.hint, /unchanged/);
  assert.match(again.catchup.hint, new RegExp(`commit set to this next_cursor: ${again.next_cursor.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
  assert.equal(again.catchup.position, page.catchup.position, "the re-fetch did not advance the checkpoint");
  assert.deepEqual(n.store.db.prepare("SELECT * FROM deliveries ORDER BY msg_id").all(), before, "fetch mutates no delivery state");
});

test("T465: a corrupt cursor is a format error, and a different mailbox stays a scope mismatch", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "mbx-t465-")), n = new MbxNode(home, { host: "alpha" });
  t.after(() => { n.close(); rmSync(home, { recursive: true, force: true }); });
  claimDirect(n, "worker");
  ensureCatchup(n.store, "worker", leaseRow(n, "worker"), "s");
  n.send({ from: "boss", to: ["worker"], subject: "one", body: "b" });
  const epoch = n.store.get("replay:epoch")!;
  const good = encodeReplayFrame({ v: 1, epoch, mailbox: "worker", filter: readCatchup(n.store, "worker")!.filter, position: replayMaximum(n.store, "worker"), end: replayMaximum(n.store, "worker") });
  const chars = good.split("");
  chars[10] = chars[10] === "A" ? "B" : "A";
  const flipped = chars.join("");
  assert.throws(() => commitCatchup(n.store, "worker", flipped, "typo"), (err: { code?: string; message?: string }) => {
    assert.equal(err.code, "CURSOR_MALFORMED");
    assert.match(err.message ?? "", /malformed/);
    assert.match(err.message ?? "", /no cursor/);
    assert.equal((err.message ?? "").includes("different mailbox"), false);
    return true;
  });
  assert.throws(() => commitCatchup(n.store, "worker", "not-a-cursor", "typo"), (err: { code?: string }) => err.code === "CURSOR_MALFORMED");
  const other = encodeReplayFrame({ v: 1, epoch, mailbox: "someone-else", filter: readCatchup(n.store, "worker")!.filter, position: 1, end: 1 });
  assert.throws(() => commitCatchup(n.store, "worker", other, "other"), (err: { code?: string; message?: string }) => {
    assert.equal(err.code, "CURSOR_SCOPE_MISMATCH");
    return true;
  });
});

test("CU-03: commits are monotonic; rewinds fail; identical re-commit is a no-op", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "mbx-cu03-")), n = new MbxNode(home, { host: "alpha" });
  const c = await connect(home);
  t.after(async () => { await c.close(); n.close(); rmSync(home, { recursive: true, force: true }); });
  await c.callTool({ name: "mbx_whoami", arguments: {} });
  n.send({ from: "boss", to: ["worker"], subject: "one", body: "b" });
  const page = (await c.callTool({ name: "mbx_catchup", arguments: {} })).structuredContent as { next_cursor: string };
  const r1 = (await c.callTool({ name: "mbx_catchup", arguments: { commit: page.next_cursor } })).structuredContent as { to: number; noop: boolean };
  assert.equal(r1.noop, false);
  const r2 = (await c.callTool({ name: "mbx_catchup", arguments: { commit: page.next_cursor } })).structuredContent as { noop: boolean };
  assert.equal(r2.noop, true, "re-committing the same cursor is a no-op");
  const older = encodeReplayFrame({ v: 1, epoch: n.store.get("replay:epoch")!, mailbox: "worker", filter: readCatchup(n.store, "worker")!.filter, position: 0, end: 2 });
  assert.throws(() => commitCatchup(n.store, "worker", older, "late-writer"), /never rewind/, "an older cursor cannot rewind the checkpoint");
  assert.equal(missedCount(n.store, "worker").missed, 0);
});

test("CU-04: a new session of the same identity resumes from the committed position, not from zero", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "mbx-cu04-")), n = new MbxNode(home, { host: "alpha" });
  t.after(() => { n.close(); rmSync(home, { recursive: true, force: true }); });
  // holder A works and commits through m1
  const a = await connect(home);
  await a.callTool({ name: "mbx_whoami", arguments: {} });
  n.send({ from: "boss", to: ["worker"], subject: "m1", body: "b" });
  const p1 = (await a.callTool({ name: "mbx_catchup", arguments: {} })).structuredContent as { next_cursor: string };
  await a.callTool({ name: "mbx_catchup", arguments: { commit: p1.next_cursor } });
  // A crashes: heartbeat frozen before m2 and m3
  beat(n, "worker", Date.now());
  await a.close();
  n.send({ from: "boss", to: ["worker"], subject: "m2", body: "b" });
  n.send({ from: "boss", to: ["worker"], subject: "m3", body: "b" });
  // holder B claims the same identity and catches up only on m2 and m3
  const b = await connect(home);
  const page = (await b.callTool({ name: "mbx_catchup", arguments: {} })).structuredContent as { messages: { subject: string }[]; catchup: { missed: number } };
  assert.deepEqual(page.messages.map((m) => m.subject), ["m2", "m3"], "the checkpoint continues; nothing already captured is replayed");
  assert.equal(page.catchup.missed, 2);
  await b.close();
});

test("CU-05: rename moves the record; release leaves it; a later claim continues it", (t) => {
  const home = mkdtempSync(join(tmpdir(), "mbx-cu05-")), n = new MbxNode(home, { host: "alpha" });
  t.after(() => { n.close(); rmSync(home, { recursive: true, force: true }); });
  n.send({ from: "boss", to: ["worker"], subject: "one", body: "b" });
  const tBetween = Date.now() - 1;
  n.send({ from: "boss", to: ["worker"], subject: "two", body: "b" });
  claimDirect(n, "worker"); // no prior: record at the end; then rewind the scenario by hand
  beat(n, "worker", tBetween);
  ensureCatchup(n.store, "worker", leaseRow(n, "worker"), "setup");
  const position = readCatchup(n.store, "worker")!.position;
  moveCatchup(n.store, "worker", "renamed");
  assert.equal(readCatchup(n.store, "worker"), null, "the old name has no record");
  assert.equal(readCatchup(n.store, "renamed")!.position, position, "the record follows the identity");
  // release/retire-style lifecycle: the record survives a release and a later claim continues it
  new IdentityLeases(n.store).release("worker", leaseRow(n, "worker").token);
  assert.ok(readCatchup(n.store, "renamed"), "release leaves the record alone");
  claimDirect(n, "renamed", "next-session");
  assert.equal(readCatchup(n.store, "renamed")!.position, position, "a later claim continues the same checkpoint");
});

test("CU-07: epoch rotation refuses commits; restart re-anchors explicitly", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "mbx-cu07-")), n = new MbxNode(home, { host: "alpha" });
  t.after(() => { n.close(); rmSync(home, { recursive: true, force: true }); });
  claimDirect(n, "worker");
  ensureCatchup(n.store, "worker", leaseRow(n, "worker"), "t");
  n.send({ from: "boss", to: ["worker"], subject: "m", body: "b" });
  const cursor = encodeReplayFrame({ v: 1, epoch: n.store.get("replay:epoch")!, mailbox: "worker",
    filter: readCatchup(n.store, "worker")!.filter, position: replayMaximum(n.store, "worker"), end: replayMaximum(n.store, "worker") });
  resetReplayEpoch(n.store);
  assert.throws(() => commitCatchup(n.store, "worker", cursor, "t"), /restored or reset/);
  const restarted = restartCatchup(n.store, "worker", "all", "t");
  assert.equal(restarted.position, 0);
  assert.equal(missedCount(n.store, "worker").missed, 1);
  const skipped = restartCatchup(n.store, "worker", "now", "t");
  assert.equal(skipped.position, replayMaximum(n.store, "worker"));
  assert.equal(missedCount(n.store, "worker").missed, 0);
});

test("CU-08: the guided hint is bounded by count and age", (t) => {
  const home = mkdtempSync(join(tmpdir(), "mbx-cu08-")), n = new MbxNode(home, { host: "alpha" });
  t.after(() => { n.close(); rmSync(home, { recursive: true, force: true }); });
  claimDirect(n, "worker");
  ensureCatchup(n.store, "worker", leaseRow(n, "worker"), "t");
  assert.equal(catchupHint(n.store, "worker"), null, "nothing missed: no hint");
  const m = n.send({ from: "boss", to: ["worker"], subject: "m", body: "b" }).envelope;
  const cursor = encodeReplayFrame({ v: 1, epoch: n.store.get("replay:epoch")!, mailbox: "worker", filter: readCatchup(n.store, "worker")!.filter, position: 0, end: 0 });
  void m; void cursor;
  n.send({ from: "boss", to: ["worker"], subject: "m2", body: "b" });
  assert.match(catchupHint(n.store, "worker")!, /call mbx_catchup/);
  // an old checkpoint with a small count still suggests the inbox first
  n.store.set("catchup:worker", JSON.stringify({ ...readCatchup(n.store, "worker")!, updated_at: Date.now() - 8 * 86_400_000 }));
  assert.match(catchupHint(n.store, "worker")!, /over the guided limit.*mbx_inbox first/s);
});

test("CU-09: a filtered replay cursor is refused as a commit", (t) => {
  const home = mkdtempSync(join(tmpdir(), "mbx-cu09-")), n = new MbxNode(home, { host: "alpha" });
  t.after(() => { n.close(); rmSync(home, { recursive: true, force: true }); });
  claimDirect(n, "worker");
  const lease = new IdentityLeases(n.store);
  const claimed = leaseRow(n, "worker");
  const token = claimed.token;
  ensureCatchup(n.store, "worker", claimed, "t");
  n.send({ from: "boss", to: ["worker"], subject: "m", body: "b" });
  const filtered = n.replay("worker", token, { thread: "no-such-thread" });
  assert.throws(() => commitCatchup(n.store, "worker", filtered.next_cursor, "t"), /unfiltered catch-up pages/);
});

test("CU-10: an injected write failure during commit keeps the prior checkpoint", (t) => {
  const home = mkdtempSync(join(tmpdir(), "mbx-cu10-")), n = new MbxNode(home, { host: "alpha" });
  t.after(() => { n.close(); rmSync(home, { recursive: true, force: true }); });
  claimDirect(n, "worker");
  const prior = ensureCatchup(n.store, "worker", leaseRow(n, "worker"), "t");
  n.send({ from: "boss", to: ["worker"], subject: "m", body: "b" });
  const cursor = encodeReplayFrame({ v: 1, epoch: n.store.get("replay:epoch")!, mailbox: "worker", filter: prior.filter,
    position: replayMaximum(n.store, "worker"), end: replayMaximum(n.store, "worker") });
  n.store.db.exec(`CREATE TRIGGER catchup_fail BEFORE UPDATE ON kv WHEN NEW.k='catchup:worker' BEGIN SELECT RAISE(ABORT,'injected write failure'); END`);
  try { assert.throws(() => commitCatchup(n.store, "worker", cursor, "t"), /injected write failure/); }
  finally { n.store.db.exec("DROP TRIGGER catchup_fail"); }
  assert.equal(readCatchup(n.store, "worker")!.position, prior.position, "the checkpoint is unchanged");
});
