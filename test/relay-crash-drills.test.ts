// Relay crash drills (T167, docs/spec/relay-durability.md §5): real child processes killed with SIGKILL at every
// commit, response and checkpoint boundary of acceptance, pull and ack, on the relay, the sending host and the receiving
// host, and the real `agentmbx relay serve` killed mid-burst. After each restart: no accepted mail is lost, nothing is
// delivered twice, sequence numbers only go up, and the epoch never changes (a restart is not a restore).
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { generateKeyPair, type KeyPair } from "../src/crypto.ts";
import { MbxNode } from "../src/node.ts";
import { RelayCore, startRelayServer } from "../src/relay.ts";
import { SqliteRelayStore } from "../src/relay-store.ts";
import { relayOpen, relayPushOutbox, relayPushReceipts, relayReceive, relaySettle, type RelaySession } from "../src/relay-v2.ts";

const FIXTURE = join(import.meta.dirname, "fixtures/relay-drill.ts");
const BIN = join(import.meta.dirname, "../bin/agentmbx.js");
const ENV = { ...process.env, MBX_NO_DESKTOP: "1", MBX_NO_UPDATE_CHECK: "1" };
const CHILD_DEADLINE_MS = 90_000;

const pair = (a: MbxNode, b: MbxNode) => {
  a.addApprovedPeer({ host: b.host, pubkey: b.key.publicKey, owner_pubkey: null, addr: "127.0.0.1:1" }, "fixture");
  b.addApprovedPeer({ host: a.host, pubkey: a.key.publicKey, owner_pubkey: null, addr: "127.0.0.1:1" }, "fixture");
};
const count = (n: MbxNode, sql: string, ...args: (string | number)[]) => Number((n.store.db.prepare(sql).get(...args) as { c: number }).c);
const lanFailedTwice = (n: MbxNode) => n.store.db.prepare("UPDATE outbox SET attempts=2, next_at=?").run(new Date(Date.now() - 1000).toISOString());
const freePort = () => new Promise<number>((resolve) => { const s = createServer(); s.listen(0, "127.0.0.1", () => { const { port } = s.address() as AddressInfo; s.close(() => resolve(port)); }); });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Exit { code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }
/** A child with a hard deadline; resolves on exit with everything it printed. */
function watch(proc: ChildProcess): { exit: Promise<Exit>; stdout: () => string } {
  let stdout = "", stderr = "";
  proc.stdout?.on("data", (c: Buffer) => { stdout += c; });
  proc.stderr?.on("data", (c: Buffer) => { stderr += c; });
  const deadline = setTimeout(() => proc.kill("SIGKILL"), CHILD_DEADLINE_MS);
  const exit = new Promise<Exit>((resolve) => proc.on("exit", (code, signal) => { clearTimeout(deadline); resolve({ code, signal, stdout, stderr }); }));
  return { exit, stdout: () => stdout };
}
async function waitFor(what: () => boolean, exit: Promise<Exit>, label: string) {
  let ended: Exit | null = null;
  void exit.then((e) => { ended = e; });
  for (const end = Date.now() + CHILD_DEADLINE_MS; !what(); await sleep(25)) {
    if (ended) assert.fail(`${label} exited before it was ready: ${JSON.stringify(ended)}`);
    if (Date.now() > end) assert.fail(`${label} never became ready`);
  }
}

/** The drill fixture as a relay, armed to die at `crash`. */
async function relayChild(o: { dir: string; port: number; key: KeyPair; crash?: string }) {
  const proc = spawn(process.execPath, [FIXTURE, JSON.stringify({ role: "relay", dir: o.dir, port: o.port, key: o.key.privateKey, crash: o.crash })], { env: ENV, stdio: ["ignore", "pipe", "pipe"] });
  const w = watch(proc);
  await waitFor(() => w.stdout().includes("ready"), w.exit, `relay child (${o.crash ?? "unarmed"})`);
  return { proc, exit: w.exit };
}
/** The drill fixture as a sending or receiving host: one relay pass, or death at `crash`. */
async function hostChild(o: { role: "sender" | "receiver"; home: string; host: string; relay: string; crash?: string }): Promise<Exit> {
  const proc = spawn(process.execPath, [FIXTURE, JSON.stringify(o)], { env: ENV, stdio: ["ignore", "pipe", "pipe"] });
  return watch(proc).exit;
}
const killed = (e: Exit, label: string) => assert.equal(e.signal, "SIGKILL", `${label} died by SIGKILL at its boundary (${e.stderr.slice(-500)})`);

/** A relay store, read directly between runs (its relay is dead or stopped). */
function relayRows(dir: string, target: string) {
  const db = new DatabaseSync(join(dir, "relay.db"));
  try {
    return {
      items: (db.prepare("SELECT seq, item_id, wire_hash, accepted_at FROM items WHERE target_pubkey=? ORDER BY seq").all(target) as { seq: number; item_id: string; wire_hash: string; accepted_at: string }[]).map((r) => ({ ...r, seq: Number(r.seq) })),
      acked: Number((db.prepare("SELECT acked_through a FROM acked WHERE target_pubkey=?").get(target) as { a: number } | undefined)?.a ?? 0),
      epoch: (db.prepare("SELECT v FROM meta WHERE k='epoch'").get() as { v: string }).v,
    };
  } finally { db.close(); }
}

function hosts(t: { after: (fn: () => unknown) => void }) {
  const homes = [mkdtempSync(join(tmpdir(), "mbx-drill-a-")), mkdtempSync(join(tmpdir(), "mbx-drill-b-"))];
  const dir = mkdtempSync(join(tmpdir(), "mbx-drill-relay-"));
  const a = new MbxNode(homes[0], { host: "alpha" }), b = new MbxNode(homes[1], { host: "beta" });
  pair(a, b); a.registerAgent("alice"); b.registerAgent("bob");
  a.close(); b.close();
  t.after(() => [...homes, dir].forEach((h) => rmSync(h, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })));
  /** Run `fn` with the host's store open in this process (the host is otherwise "down" or in a child). */
  const at = async <T>(home: number, fn: (n: MbxNode) => T | Promise<T>): Promise<T> => {
    const n = new MbxNode(homes[home]!, { host: home ? "beta" : "alpha" });
    try { return await fn(n); } finally { n.close(); }
  };
  return { homes, dir, at };
}
const open = async (n: MbxNode, relay: string): Promise<RelaySession> => { const s = await relayOpen(n, relay); assert.ok(s, "v2 session"); return s!; };
const inbox = (n: MbxNode) => n.inbox("bob").map((m) => m.subject).sort();

test("the relay killed at every accept, pull and ack boundary loses nothing and duplicates nothing", async (t) => {
  const { dir, at } = hosts(t);
  const key = generateKeyPair(), port = await freePort(), relay = `http://127.0.0.1:${port}`;
  let r = await relayChild({ dir, port, key });
  t.after(() => { r.proc.kill("SIGKILL"); });
  /** Kill the running relay (a crash too) and start it again armed for the next boundary. */
  const restart = async (crash?: string) => { r.proc.kill("SIGKILL"); killed(await r.exit, "relay"); r = await relayChild({ dir, port, key, crash }); };
  const epoch = await at(0, async (a) => (await open(a, relay)).info.epoch);
  const bPub = await at(1, async (b) => { await open(b, relay); return b.key.publicKey; });
  const m1 = await at(0, (a) => { const id = a.send({ from: "alice", to: ["bob@beta"], subject: "m1", body: "one" }).envelope.id; lanFailedTwice(a); return id; });

  // accept, crash before commit: nothing stored; the sender keeps its row
  await restart("push:before-commit");
  await at(0, async (a) => assert.deepEqual(await relayPushOutbox(a, await open(a, relay)), { accepted: 0, rejected: 0 }));
  killed(await r.exit, "relay at push:before-commit");
  assert.deepEqual(relayRows(dir, bPub).items, [], "the uncommitted item is gone with the process");
  await at(0, (a) => assert.equal(count(a, "SELECT COUNT(*) c FROM outbox"), 1));

  // accept, crash after commit before the answer: stored once; the sender still keeps its row
  r = await relayChild({ dir, port, key, crash: "push:after-commit" });
  await at(0, async (a) => assert.deepEqual(await relayPushOutbox(a, await open(a, relay)), { accepted: 0, rejected: 0 }));
  killed(await r.exit, "relay at push:after-commit");
  const stored = relayRows(dir, bPub).items;
  assert.deepEqual(stored.map((i) => i.item_id), [m1], "committed exactly once");
  await at(0, (a) => assert.equal(count(a, "SELECT COUNT(*) c FROM outbox"), 1, "no accept reached the sender"));

  // the retry is a duplicate with the same seq and the original acceptance time; then a pull dies before its answer
  r = await relayChild({ dir, port, key, crash: "pull:before-response" });
  await at(0, async (a) => {
    assert.deepEqual(await relayPushOutbox(a, await open(a, relay)), { accepted: 1, rejected: 0 });
    const sent = a.store.db.prepare("SELECT seq, accepted_at, epoch FROM relay_sent WHERE msg_id=?").get(m1) as { seq: number; accepted_at: string; epoch: string };
    assert.deepEqual({ seq: Number(sent.seq), at: sent.accepted_at, epoch: sent.epoch }, { seq: stored[0]!.seq, at: stored[0]!.accepted_at, epoch }, "the same seq, the original time, the same epoch");
    assert.equal(count(a, "SELECT COUNT(*) c FROM outbox"), 0);
  });
  await at(1, async (b) => assert.equal(await relayReceive(b, await open(b, relay)), 0));
  killed(await r.exit, "relay at pull:before-response");
  await at(1, (b) => assert.deepEqual(inbox(b), []));

  // ack, crash before commit: the receiver delivered and checkpointed; the relay still holds the item
  r = await relayChild({ dir, port, key, crash: "ack:before-commit" });
  await at(1, async (b) => assert.equal(await relayReceive(b, await open(b, relay)), 1));
  killed(await r.exit, "relay at ack:before-commit");
  assert.deepEqual([relayRows(dir, bPub).items.length, relayRows(dir, bPub).acked], [1, 0], "the ack rolled back");
  await at(1, (b) => assert.deepEqual(inbox(b), ["m1"]));

  // ack, crash after commit before the answer: the relay dropped the item; the receiver re-acks next time
  r = await relayChild({ dir, port, key, crash: "ack:after-commit" });
  await at(1, async (b) => assert.equal(await relayReceive(b, await open(b, relay)), 0));
  killed(await r.exit, "relay at ack:after-commit");
  assert.deepEqual([relayRows(dir, bPub).items.length, relayRows(dir, bPub).acked], [0, stored[0]!.seq]);

  // unarmed: the lost ack is re-sent harmlessly, nothing arrives twice, sequences go on, the epoch never moved
  r = await relayChild({ dir, port, key });
  await at(1, async (b) => {
    assert.equal(await relayReceive(b, await open(b, relay)), 0);
    assert.equal(b.store.get(`relay-acked:${relay}:${epoch}`), String(stored[0]!.seq), "the re-sent ack was taken");
    assert.deepEqual(inbox(b), ["m1"], "delivered exactly once");
  });
  await at(0, async (a) => { a.send({ from: "alice", to: ["bob@beta"], subject: "m2", body: "two" }); lanFailedTwice(a); assert.equal((await relayPushOutbox(a, await open(a, relay))).accepted, 1); });
  await at(1, async (b) => { assert.equal(await relayReceive(b, await open(b, relay)), 1); assert.deepEqual(inbox(b), ["m1", "m2"]); });
  const seqs = await at(0, (a) => (a.store.db.prepare("SELECT seq FROM relay_sent ORDER BY accepted_at").all() as { seq: number }[]).map((x) => Number(x.seq)));
  assert.ok(seqs[1]! > seqs[0]!, `sequence numbers continue after five crashes (${seqs.join(" < ")})`);
  r.proc.kill("SIGKILL"); await r.exit;
  assert.equal(relayRows(dir, bPub).epoch, epoch, "five crashes and restarts, one epoch: a restart is not a restore");
});

test("a sending and a receiving host killed at every boundary lose nothing and duplicate nothing", async (t) => {
  const { homes, dir, at } = hosts(t);
  const core = new RelayCore({}, { store: new SqliteRelayStore(join(dir, "relay.db")), key: generateKeyPair(), log: () => {} });
  const server = await startRelayServer(core, 0, "127.0.0.1", { log: () => {} });
  t.after(() => new Promise<void>((r) => server.close(() => { core.store.close(); r(); })));
  const relay = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const bPub = await at(1, async (b) => { await open(b, relay); return b.key.publicKey; });
  await at(0, async (a) => { await open(a, relay); a.send({ from: "alice", to: ["bob@beta"], subject: "m1", body: "one" }); lanFailedTwice(a); });
  const host = (role: "sender" | "receiver", crash?: string) => hostChild({ role, home: homes[role === "sender" ? 0 : 1]!, host: role === "sender" ? "alpha" : "beta", relay, crash });

  // sender dies after persisting the sealed bytes, before the push leaves
  killed(await host("sender", "push:before-send"), "sender at push:before-send");
  const hash = await at(0, (a) => {
    assert.equal(count(a, "SELECT COUNT(*) c FROM outbox"), 1);
    return (a.store.db.prepare("SELECT wire_hash h FROM relay_wire").get() as { h: string }).h;
  });
  assert.equal(core.pullItems(bPub).items.length, 0);
  // sender dies after the relay committed and answered, before it recorded the accept
  killed(await host("sender", "push:after-response"), "sender at push:after-response");
  await at(0, (a) => assert.deepEqual([count(a, "SELECT COUNT(*) c FROM outbox"), count(a, "SELECT COUNT(*) c FROM relay_sent")], [1, 0], "the row survives the crash"));
  const [item] = core.store.pull(bPub, 0, 10);
  assert.equal(item?.wire_hash, hash, "the relay holds exactly the bytes persisted before the first attempt");
  // the restarted sender: a duplicate with the same seq, then the row leaves the outbox
  const pushed = await host("sender");
  assert.deepEqual(JSON.parse(pushed.stdout.trim()), { accepted: 1, rejected: 0 }, pushed.stderr);
  await at(0, (a) => {
    assert.equal(count(a, "SELECT COUNT(*) c FROM outbox"), 0);
    assert.equal(Number((a.store.db.prepare("SELECT seq FROM relay_sent").get() as { seq: number }).seq), item!.seq);
  });
  assert.equal(core.pullItems(bPub).items.length, 1, "one item at the relay, never two");

  // receiver dies after the mailbox committed the message, before its checkpoint
  killed(await host("receiver", "receive:after-deliver"), "receiver at receive:after-deliver");
  await at(1, (b) => { assert.deepEqual(inbox(b), ["m1"]); assert.equal(count(b, "SELECT COUNT(*) c FROM relay_position WHERE received_through > 0"), 0); });
  // receiver dies after its checkpoint, before the ack leaves: the re-pull was a duplicate, not a second copy
  killed(await host("receiver", "ack:before-send"), "receiver at ack:before-send");
  await at(1, (b) => {
    assert.deepEqual(inbox(b), ["m1"]);
    assert.equal(Number((b.store.db.prepare("SELECT received_through t FROM relay_position").get() as { t: number }).t), item!.seq);
  });
  assert.equal(core.pullItems(bPub).items.length, 1, "never acked: the relay still holds it");
  // receiver dies after the relay took the ack, before it recorded that
  killed(await host("receiver", "ack:after-response"), "receiver at ack:after-response");
  assert.deepEqual([core.pullItems(bPub).items.length, core.store.ackedThrough(bPub)], [0, item!.seq]);
  // the restarted receiver: nothing new, the ack recorded, still one copy
  const received = await host("receiver");
  assert.deepEqual(JSON.parse(received.stdout.trim()), { accepted: 0 }, received.stderr);
  await at(1, (b) => assert.deepEqual(inbox(b), ["m1"], "delivered exactly once across three receiver crashes"));

  // the delivery receipt goes back and settles the sender's row
  await at(1, async (b) => { b.store.db.prepare("UPDATE receipt_outbox SET attempts=2, next_at=?").run(new Date(Date.now() - 1000).toISOString()); assert.ok(await relayPushReceipts(b, await open(b, relay)) >= 1); });
  await at(0, async (a) => { await relayReceive(a, await open(a, relay)); assert.deepEqual(relaySettle(a), { settled: 1, unconfirmed: 0 }); });
});

test("the real `agentmbx relay serve`, killed mid-push and mid-pull, delivers every message exactly once", async (t) => {
  const { dir, at } = hosts(t);
  const home = mkdtempSync(join(tmpdir(), "mbx-drill-cli-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const port = await freePort(), relay = `http://127.0.0.1:${port}`;
  const serve = async () => {
    const proc = spawn(process.execPath, [BIN, "relay", "serve", "--port", String(port), "--bind", "127.0.0.1", "--store-dir", dir],
      { env: { ...ENV, AGENTMBX_DEV: "1", MBX_HOME: home }, stdio: ["ignore", "pipe", "pipe"] });
    const w = watch(proc);
    await waitFor(() => w.stdout().includes("listening on"), w.exit, "agentmbx relay serve");
    return { proc, exit: w.exit };
  };
  let r = await serve();
  t.after(() => { r.proc.kill("SIGKILL"); });
  let kills = 0;
  /** Fires the request, then SIGKILLs the relay a moment later: wherever that lands (before, inside or after the
   *  transactions of the batch, or before the answer) is the boundary under test. */
  const killer = (path: string, method: string, on: number): typeof fetch => {
    let n = 0;
    return async (input, init) => {
      if (String(input).includes(path) && (init?.method ?? "GET") === method && ++n === on) { kills++; const p = r.proc; setTimeout(() => p.kill("SIGKILL"), 3); }
      return fetch(input, init);
    };
  };
  /** Run passes until `done`, restarting the relay whenever it died. */
  const converge = async (pass: () => Promise<unknown>, done: () => Promise<boolean>) => {
    for (let round = 0; !(await done()); round++) {
      assert.ok(round < 40, "converges");
      if (r.proc.exitCode !== null || r.proc.signalCode !== null) { await r.exit; r = await serve(); }
      await pass();
      await Promise.race([r.exit, sleep(50)]);
    }
  };
  const epoch = await at(0, async (a) => (await open(a, relay)).info.epoch);
  await at(1, async (b) => { await open(b, relay); });
  const N = 24;
  await at(0, (a) => { for (let i = 0; i < N; i++) a.send({ from: "alice", to: ["bob@beta"], subject: `m${String(i).padStart(2, "0")}`, body: `n${i}` }); lanFailedTwice(a); });

  const pushKill = killer("/v2/relay/items", "POST", 3);
  await converge(() => at(0, async (a) => {
    const s = await relayOpen(a, relay, pushKill);
    if (!s) return;
    s.info.limits.max_batch = 4; // several batches, so the kill lands mid-burst
    await relayPushOutbox(a, s);
  }), () => at(0, (a) => count(a, "SELECT COUNT(*) c FROM outbox") === 0));
  const pullKill = killer("/v2/relay/items?", "GET", 3);
  await converge(() => at(1, async (b) => {
    const s = await relayOpen(b, relay, pullKill);
    if (!s) return;
    s.info.limits.max_pull = 5; // several pages, so the kill lands mid-drain
    await relayReceive(b, s);
  }), () => at(1, (b) => b.inbox("bob").length === N && b.store.get(`relay-acked:${relay}:${epoch}`) !== null
    && Number(b.store.get(`relay-acked:${relay}:${epoch}`)) === Number((b.store.db.prepare("SELECT received_through t FROM relay_position").get() as { t: number }).t)));
  assert.equal(kills, 2, "the relay was killed once mid-push and once mid-pull");

  const subjects = await at(1, (b) => inbox(b));
  assert.deepEqual(subjects, Array.from({ length: N }, (_, i) => `m${String(i).padStart(2, "0")}`), "every message exactly once");
  const sent = await at(0, (a) => a.store.db.prepare("SELECT seq, epoch FROM relay_sent").all() as { seq: number; epoch: string }[]);
  assert.equal(new Set(sent.map((x) => Number(x.seq))).size, N, "one seq per message");
  assert.ok(sent.every((x) => x.epoch === epoch), "two crashes, one epoch");
  r.proc.kill("SIGKILL"); await r.exit;
  const bPub = await at(1, (b) => b.key.publicKey);
  assert.deepEqual(relayRows(dir, bPub).items, [], "all acked: the relay holds nothing");
  assert.equal(relayRows(dir, bPub).epoch, epoch);
});
