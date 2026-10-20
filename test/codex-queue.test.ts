import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { MbxNode } from "../src/node.ts";
import { dispatchWakes, type WakeResult } from "../src/wake.ts";
import { codexPendingKey, type CodexPending } from "../src/codex-queue.ts";
import { bindWakeLease } from "./helpers/wake-lease.ts";
import { sendLeased } from "./helpers/leased-send.ts";
import { writeCodexQueueStub } from "./helpers/codex-queue.ts";
import { enqueueCodexQueue, reconcileCodexQueue, type CodexQueueContext } from "../src/codex-queue.ts";
import { captureWakeIdentity } from "../src/wake-identity.ts";
import { codexHomeFor, recordCodexHome } from "../src/codex-home.ts";

function fixture(t: TestContext, options: Parameters<typeof writeCodexQueueStub>[1] = {}, thread = "exact-thread") {
  const home = mkdtempSync(join(tmpdir(), "mbx-codex-queue-")), n = new MbxNode(home, { host: "alpha" }), bin = join(home, "codex");
  writeCodexQueueStub(bin, options);
  const saved = { MBX_CODEX_BIN: process.env.MBX_CODEX_BIN, MBX_NO_DESKTOP: process.env.MBX_NO_DESKTOP };
  Object.assign(process.env, { MBX_CODEX_BIN: bin, MBX_NO_DESKTOP: "1" });
  t.after(() => { n.close(); rmSync(home, { recursive: true, force: true });
    for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v; });
  const held = bindWakeLease(n, { agent: "reader", cli: "codex", session_id: thread, pid: process.pid });
  const send = () => sendLeased(n, { from: "sender", to: ["reader"], kind: "request", body: "private body", subject: "work" }).envelope.id;
  const items = () => { try { return JSON.parse(readFileSync(bin + ".queue.json", "utf8")) as { id: string; threadId: string; clientUserMessageId: string }[]; } catch { return []; } };
  const pending = () => (n.store.db.prepare("SELECT v FROM kv WHERE k GLOB 'codex-queue:*'").all() as { v: string }[]).map(r => JSON.parse(r.v) as CodexPending);
  const unbrake = () => n.store.db.prepare("DELETE FROM wakes").run();
  return { n, bin, held, send, items, pending, unbrake };
}

test("only one owned notice per thread; pending receipt precedes the native add", async t => {
  const f = fixture(t);
  writeCodexQueueStub(f.bin, { onAdd: `const db = new DatabaseSync(${JSON.stringify(join(f.n.home, 'mbx.db'))}, {readOnly:true});
    const pending=db.prepare("SELECT v FROM kv WHERE k GLOB 'codex-queue:*'").all();
    if(pending.length!==1 || JSON.parse(pending[0].v).clientId!==p.clientUserMessageId) throw new Error('no durable pending operation'); db.close();` });
  f.send(); assert.equal((await dispatchWakes(f.n))[0].result.ok, true);
  f.send(); f.unbrake(); assert.equal((await dispatchWakes(f.n))[0].result.ok, false);
  assert.equal(f.items().length, 1); assert.equal(f.pending().length, 1);
  assert.equal(f.pending()[0].settled, true);
  assert.equal(JSON.stringify(f.pending()).includes("private body"), false);
});

for (const action of ["read", "ack", "release", "handover", "pid-birth"] as const)
  test(`${action} withdraws exact owned queued input at the daemon pass, preserving legacy input`, async t => {
    const f = fixture(t); const id = f.send();
    assert.equal((await dispatchWakes(f.n))[0].result.ok, true);
    const foreign = { id: "legacy", threadId: "exact-thread", clientUserMessageId: "not-ours", input: [{ type: "text", text: "[mbx] user-owned text" }] };
    writeFileSync(f.bin + ".queue.json", JSON.stringify([...f.items(), foreign]));
    if (action === "read") f.n.setDelivery(id, "reader", "read");
    if (action === "ack") f.n.ack(id, "reader");
    if (action === "release" || action === "handover") f.held.release();
    if (action === "handover") bindWakeLease(f.n, { agent: "reader", cli: "codex", session_id: "new-thread", pid: process.pid });
    if (action === "pid-birth") f.n.store.db.prepare("UPDATE identity_leases SET holder_start='reused' WHERE name='reader'").run();
    await dispatchWakes(f.n);
    assert.deepEqual(f.items(), [foreign]); assert.equal(f.pending().length, 0);
  });

test("lost response after add is reconciled before retry and retained through provider unavailability", async t => {
  const f = fixture(t, { onAdd: "process.exit(1);" }); f.send();
  assert.equal(((await dispatchWakes(f.n))[0].result as WakeResult).outcome?.kind, "unknown");
  assert.equal(f.items().length, 1); assert.equal(f.pending().length, 1);
  f.n.store.db.prepare("UPDATE deliveries SET state='delivered'").run(); f.unbrake();
  await dispatchWakes(f.n); assert.equal(f.items().length, 1);
  f.held.release();
  process.env.MBX_CODEX_BIN = "/nonexistent/codex";
  await dispatchWakes(f.n); assert.equal(f.pending().length, 1); assert.equal(f.items().length, 1);
  process.env.MBX_CODEX_BIN = f.bin;
  await dispatchWakes(f.n); assert.equal(f.pending().length, 0); assert.equal(f.items().length, 0);
});

test("a consumed item is not recalled and does not block the next notice", async t => {
  const f = fixture(t); f.send(); await dispatchWakes(f.n);
  writeFileSync(f.bin + ".queue.json", "[]");
  f.send(); f.unbrake();
  assert.equal((await dispatchWakes(f.n))[0].result.ok, true); assert.equal(f.items().length, 1);
});

test("a corrupt pending receipt is preserved and blocks Codex submission", async t => {
  const f = fixture(t); f.send(); await dispatchWakes(f.n);
  const key = codexPendingKey(f.pending()[0]); f.n.store.set(key, "{");
  f.send(); f.unbrake(); await dispatchWakes(f.n);
  assert.equal(f.n.store.get(key), "{"); assert.equal(f.items().length, 1);
});

test("failure audit retains an exit code and stderr class without copying stderr payloads", async t => {
  const f = fixture(t, { beforeInitialize: "process.stderr.write('authentication unavailable: private diagnostic'); process.exit(7);" });
  f.send(); await dispatchWakes(f.n);
  const row = f.n.store.db.prepare("SELECT detail FROM audit WHERE event='wake.attempt'").get()!;
  const detail = JSON.parse(String(row.detail));
  assert.equal(detail.failure.exitCode, 7); assert.equal(detail.failure.stderrClass, "authentication");
  assert.equal(String(row.detail).includes("private diagnostic"), false); assert.equal(f.pending().length, 0);
});

test("a helper ignoring EOF and SIGTERM cannot hang a completed queue operation", { timeout: 5000 }, async t => {
  const f = fixture(t, { beforeInitialize: "process.on('SIGTERM',()=>{}); process.stdin.on('end',()=>setInterval(()=>{},1000));" });
  f.send(); assert.equal((await dispatchWakes(f.n))[0].result.ok, true);
  assert.equal(f.items().length, 1); assert.equal(f.pending()[0].settled, true);
});

test("withdrawal precedes a new-holder wake and an unavailable provider blocks that wake", async t => {
  const f = fixture(t); f.send(); await dispatchWakes(f.n); f.held.release();
  // A new captured lease generation for the same mailbox, with a new native thread.
  f.n.store.db.prepare("DELETE FROM sessions WHERE agent='reader'").run();
  const replacement = new MbxNode(f.n.home);
  try {
    const second = bindWakeLease(replacement, { agent: "reader", cli: "codex", session_id: "new-thread", pid: process.pid });
    assert.notEqual(second.token, f.held.token); f.send(); f.unbrake();
    process.env.MBX_CODEX_BIN = "/nonexistent/codex";
    await dispatchWakes(f.n); assert.equal(f.items().length, 1); assert.equal(f.items()[0].threadId, "exact-thread");
    process.env.MBX_CODEX_BIN = f.bin; f.n.store.db.prepare("DELETE FROM kv WHERE k='wake-busy:reader'").run();
    f.unbrake(); await dispatchWakes(f.n);
    assert.equal(f.items().length, 1); assert.equal(f.items()[0].threadId, "new-thread");
  } finally { replacement.close(); }
});

test("late admission after release is withdrawn without a second daemon pass", async t => {
  const f = fixture(t);
  writeCodexQueueStub(f.bin, { onAdd: `const db = new DatabaseSync(${JSON.stringify(join(f.n.home, 'mbx.db'))});
    db.prepare("UPDATE identity_leases SET released_at=1 WHERE name='reader'").run(); db.close();` });
  f.send(); await dispatchWakes(f.n);
  assert.equal(f.items().length, 0); assert.equal(f.pending().length, 0);
});

test("an in-flight add is not forgotten by concurrent reconciliation while its helper can still write", async t => {
  const f = fixture(t); f.send(); await dispatchWakes(f.n);
  const pending = f.pending()[0]; pending.settled = false; pending.worker = pending.writer;
  writeFileSync(f.bin + ".queue.json", "[]");
  f.n.store.set(codexPendingKey(pending), JSON.stringify(pending));
  const blocked = await reconcileCodexQueue(f.n.store, f.bin, () => false);
  assert.equal(blocked.has("reader"), true); assert.equal(f.pending().length, 1);
  pending.worker = { ...pending.writer, start: "a previous PID birth" };
  f.n.store.set(codexPendingKey(pending), JSON.stringify(pending));
  assert.equal((await reconcileCodexQueue(f.n.store, f.bin, () => false)).size, 0);
  assert.equal(f.pending().length, 0, "a proven ended/reused helper with no queued item can be retired");
});

test("concurrent daemon submissions share the pending fence and enqueue once", async t => {
  const f = fixture(t), id = f.send(), guard = captureWakeIdentity(f.n, f.n.sessionsFor("reader")[0])!;
  const queue: CodexQueueContext = { store: f.n.store, agent: "reader", deliveries: [{ id, agent: "reader" }], run: guard.run, keep: () => true };
  const results = await Promise.allSettled([1, 2].map(() => enqueueCodexQueue(f.bin, "exact-thread", "[mbx] first", queue, () => true)));
  assert.equal(results.filter(x => x.status === "fulfilled").length, 1); assert.equal(f.items().length, 1);
});

test("paged lookup deletes only the owned id beyond the first page", async t => {
  const f = fixture(t); f.send(); await dispatchWakes(f.n); const own = f.items()[0];
  const foreign = { id: "foreign", threadId: "exact-thread", clientUserMessageId: "unrelated" };
  writeCodexQueueStub(f.bin, { onList: `result = p.cursor ? {data:load(),nextCursor:null} : {data:[${JSON.stringify(foreign)}],nextCursor:'page-2'};` });
  f.held.release(); await dispatchWakes(f.n);
  assert.equal(f.items().some(x => x.id === own.id), false); assert.equal(f.pending().length, 0);
});

test("T722: a withdrawal in another CODEX_HOME backs off as thread-missing, then succeeds once the home is recorded", async t => {
  const thread = "01a156ee-bea3-74c3-959a-0ac2478e9e26", base = mkdtempSync(join(tmpdir(), "mbx-t722-"));
  const codexHome = join(base, "orca-home"), calls = join(base, "list-calls");
  mkdirSync(join(codexHome, "sessions", "2026", "10", "20"), { recursive: true });
  writeFileSync(join(codexHome, "sessions", "2026", "10", "20", `rollout-2026-10-20T01-30-49-${thread}.jsonl`), "");
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const f = fixture(t, {}, thread);
  // Codex answers "thread not found" unless the helper runs in the thread's own home.
  writeCodexQueueStub(f.bin, { onList: `fs.appendFileSync(${JSON.stringify(calls)}, "x");
    if (process.env.CODEX_HOME !== ${JSON.stringify(codexHome)}) {
      process.stdout.write(JSON.stringify({ id: request.id, error: { code: -32603, message: "thread not found: " + p.threadId } }) + "\\n"); return;
    }` });
  const id = f.send();
  const first = (await dispatchWakes(f.n))[0].result;
  assert.equal(first.ok, true, JSON.stringify(first));
  assert.equal(f.items().length, 1);
  f.n.ack(id, "reader");
  const listCalls = () => { try { return readFileSync(calls, "utf8").length; } catch { return 0; } };

  assert.equal((await reconcileCodexQueue(f.n.store, f.bin, () => false)).get("reader"), "thread-missing");
  assert.equal(listCalls(), 1);
  assert.equal((await reconcileCodexQueue(f.n.store, f.bin, () => false)).get("reader"), "thread-missing", "still blocked inside the backoff");
  assert.equal(listCalls(), 1, "no helper is started again inside the backoff");
  assert.equal(f.pending().length, 1);

  recordCodexHome(f.n.store, thread, codexHome);
  assert.equal(codexHomeFor(f.n.store, thread), codexHome);
  assert.equal((await reconcileCodexQueue(f.n.store, f.bin, () => false, Date.now() + 10 * 60_000)).size, 0);
  assert.equal(f.pending().length, 0); assert.equal(f.items().length, 0, "the owned notice was withdrawn in the right home");
});
