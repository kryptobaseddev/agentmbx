import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync, fork, type ChildProcess } from "node:child_process";
import { Store } from "../src/store.ts";
import { MbxNode } from "../src/node.ts";
import { IdentityLeases, inspectLeaseProcess, type ProcessEvidence, type LeaseHolder } from "../src/identity-leases.ts";

function fixture(t: TestContext) {
  const home = mkdtempSync(join(tmpdir(), "mbx-leases-")), node = new MbxNode(home, { host: "alpha" });
  t.after(() => { node.close(); rmSync(home, { recursive: true, force: true }); });
  let now = 1000;
  const processes = new Map<number, ProcessEvidence>([[10, { alive: true, start: "birth-a" }], [20, { alive: true, start: "birth-b" }]]);
  const leases = new IdentityLeases(node.store, { idleTtlMs: 100, clock: () => now, inspect: pid => processes.get(pid) ?? { alive: null, start: null } });
  const a: LeaseHolder = { pid: 10, start: "birth-a", keyFp: "aaaa-aaaa-aaaa-aaaa", cli: "test", sessionId: "a" };
  const b: LeaseHolder = { pid: 20, start: "birth-b", keyFp: "bbbb-bbbb-bbbb-bbbb", cli: "test", sessionId: "b" };
  return { home, node, leases, processes, a, b, time: (value: number) => { now = value; } };
}

test("lease expiry fences stale renew/release/operations and preserves mailbox history", (t) => {
  const f = fixture(t), { node, leases, a, b } = f;
  const pending = node.send({ from: "sender", to: ["worker"], subject: "pending", body: "history" }).envelope.id;
  const done = node.send({ from: "sender", to: ["worker"], subject: "done", body: "history" }).envelope.id;
  node.ack(done, "worker");
  const original = node.message(pending)!.envelope, first = leases.claim("worker", a);
  assert.throws(() => leases.claim("worker", b), { code: "IDENTITY_IN_USE" });
  f.time(1099); leases.renew("worker", first.token);
  f.time(1198); assert.equal(leases.withHeld("worker", first.token, () => 42), 42);
  f.time(1199); assert.throws(() => leases.renew("worker", first.token), { code: "IDENTITY_LEASE_LOST" });
  const second = leases.claim("worker", b); assert.notEqual(second.token, first.token);
  assert.throws(() => leases.renew("worker", first.token), { code: "IDENTITY_LEASE_LOST" });
  assert.equal(leases.release("worker", first.token), false);
  let ran = false; assert.throws(() => leases.withHeld("worker", first.token, () => { ran = true; }), { code: "IDENTITY_LEASE_LOST" }); assert.equal(ran, false);
  assert.equal(node.message(pending)!.envelope, original);
  assert.deepEqual(node.inbox("worker").map(m => m.id), [pending]);
  assert.equal(node.inbox("worker", { all: true }).find(m => m.id === done)!.state, "acked");
  assert.equal(leases.release("worker", second.token), true); assert.equal(leases.release("worker", second.token), false);
  assert.equal(leases.claim("worker", a).name, "worker");
});

test("unknown process status retains ownership but cannot authorize operations; death and PID reuse expire", (t) => {
  const f = fixture(t), { leases, processes, a, b } = f;
  const first = leases.claim("worker", a);
  processes.set(a.pid, { alive: null, start: null });
  assert.throws(() => leases.claim("worker", b), { code: "IDENTITY_IN_USE" });
  assert.throws(() => leases.renew("worker", first.token), { code: "IDENTITY_STATUS_UNKNOWN" });
  assert.throws(() => leases.withHeld("worker", first.token, () => 1), { code: "IDENTITY_STATUS_UNKNOWN" });
  processes.set(a.pid, { alive: true, start: a.start });
  assert.equal(leases.renew("worker", first.token).token, first.token, "inspection recovery verifies the same generation without reclaiming");
  processes.set(a.pid, { alive: false, start: null });
  const second = leases.claim("worker", b);
  processes.set(b.pid, { alive: true, start: "reused" }); processes.set(a.pid, { alive: true, start: a.start });
  const third = leases.claim("worker", a); assert.notEqual(third.token, second.token);
  const reasons = f.node.store.db.prepare("SELECT detail FROM audit WHERE event='identity.expire'").all().map(r => JSON.parse(String(r.detail)).reason);
  assert.deepEqual(reasons, ["dead", "pid-reused"]);
  f.time(1100); processes.set(a.pid, { alive: null, start: null }); processes.set(b.pid, { alive: true, start: b.start });
  assert.equal(leases.claim("worker", b).holder_pid, b.pid, "idle expiration is independent of process inspection");
});

test("claim and nested guarded mutations roll back with their audit transaction", (t) => {
  const { node, leases, a } = fixture(t);
  node.store.db.exec("CREATE TRIGGER reject_claim BEFORE INSERT ON audit WHEN NEW.event='identity.claim' BEGIN SELECT RAISE(ABORT,'audit unavailable'); END");
  assert.throws(() => leases.claim("worker", a), /audit unavailable/);
  assert.equal(node.store.db.prepare("SELECT count(*) n FROM identity_leases").get()!.n, 0);
  node.store.db.exec("DROP TRIGGER reject_claim");
  const lease = leases.claim("worker", a);
  assert.throws(() => leases.withHeld("worker", lease.token, () => node.store.tx(() => { node.store.set("nested", "value"); throw Error("abort"); })), /abort/);
  assert.equal(node.store.get("nested"), undefined);
  node.store.tx(() => {
    node.store.set("outer", "kept");
    assert.throws(() => node.store.tx(() => { node.store.set("inner", "lost"); throw Error("savepoint"); }), /savepoint/);
    assert.equal(node.store.get("outer"), "kept"); assert.equal(node.store.get("inner"), undefined);
  });
  assert.equal(node.store.get("outer"), "kept");
});

test("lease configuration and claimant process evidence are validated", (t) => {
  const { node, leases, a } = fixture(t);
  for (const idleTtlMs of [0, -1, 0.5, NaN, Infinity]) assert.throws(() => new IdentityLeases(node.store, { idleTtlMs }), { code: "IDENTITY_LEASE_CONFIG" });
  assert.throws(() => leases.claim("worker", { ...a, start: "wrong" }), { code: "IDENTITY_PROCESS_UNVERIFIED" });
  assert.throws(() => leases.claim("worker", { ...a, keyFp: "missing" }), { code: "IDENTITY_LEASE_CONFIG" });
});

test("lease process inspection precedes the write transaction while guarded mutations remain locked", t => {
  const { node, a } = fixture(t), locked: boolean[] = [];
  const leases = new IdentityLeases(node.store, { clock: () => 1000, inspect: () => {
    locked.push(node.store.db.isTransaction); return { alive: true, start: a.start };
  } });
  const lease = leases.claim("worker", a);
  leases.renew("worker", lease.token);
  leases.withHeld("worker", lease.token, () => { assert.equal(node.store.db.isTransaction, true); node.store.set("guarded", "yes"); });
  leases.rename("worker", lease.token, "renamed");
  assert.ok(locked.length >= 3); assert.ok(locked.every(value => !value), "process inspection must not monopolize the SQLite write lock");
});

test("prepared outer transactions reuse evidence across claim, rename and renewal without inspecting under lock", t => {
  const { node, a } = fixture(t), checks: boolean[] = [];
  const leases = new IdentityLeases(node.store, { clock: () => 1000, inspect: () => {
    checks.push(node.store.db.isTransaction); return { alive: true, start: a.start };
  } });
  assert.throws(() => node.store.tx(() => leases.claim("unprepared", a)), { code: "IDENTITY_PREPARATION_REQUIRED" });
  leases.prepare(["worker", "renamed"], [a.pid], () => node.store.tx(() => {
    let invoked = false;
    assert.throws(() => leases.prepare([], [], async () => { invoked = true; }), { code: "IDENTITY_ASYNC_OPERATION" });
    assert.equal(invoked, false);
    const first = leases.claim("worker", a);
    leases.renew("worker", first.token);
    const next = leases.rename("worker", first.token, "renamed");
    leases.renew("renamed", next.token);
    leases.withHeld("renamed", next.token, () => node.store.set("prepared", "committed"));
  }));
  assert.deepEqual(checks, [false]); assert.equal(node.store.get("prepared"), "committed");
});

test("pre-lock evidence about a dead predecessor cannot expire a new generation", t => {
  const { node, leases, processes, a, b } = fixture(t);
  leases.claim("worker", a);
  const c = { ...a, pid: 30, start: "birth-c", keyFp: "cccc-cccc-cccc-cccc", sessionId: "c" };
  processes.set(c.pid, { alive: true, start: c.start });
  let replacement: string | undefined, armed = true;
  const contender = new IdentityLeases(node.store, { clock: () => 1000, idleTtlMs: 100, inspect: pid => {
    if (pid === a.pid && armed) {
      armed = false; processes.set(a.pid, { alive: false, start: null });
      replacement = leases.claim("worker", b).token;
      return { alive: false, start: null };
    }
    return processes.get(pid) ?? { alive: null, start: null };
  } });
  assert.throws(() => contender.claim("worker", c), { code: "IDENTITY_IN_USE" });
  assert.ok(replacement);
  assert.equal(node.store.db.prepare("SELECT token FROM identity_leases WHERE name='worker'").get()!.token, replacement);
});

test("lease read snapshots reject writes without blocking a concurrent connection", t => {
  const { home, node, leases, a } = fixture(t), lease = leases.claim("worker", a), writer = new Store(home);
  try {
    leases.withHeldRead("worker", lease.token, () => {
      assert.throws(() => node.store.set("forbidden", "write"), /readonly/i);
      writer.set("concurrent", "committed");
      assert.equal(node.store.get("concurrent"), undefined, "reader retains its authorized snapshot");
    });
    assert.equal(node.store.get("concurrent"), "committed");
    leases.withHeld("worker", lease.token, () => node.store.set("after-read", "write"));
    assert.equal(node.store.get("after-read"), "write", "query_only is restored after a read snapshot");
  } finally { writer.close(); }
});

test("SQLite whole-transaction abort preserves its error and fences retained statements until unwind", (t) => {
  const { node, leases, a } = fixture(t), store = node.store;
  const lease = leases.claim("worker", a), connection = store.db;
  const retained = connection.prepare("INSERT INTO kv(k,v) VALUES ('escaped','bad')");
  connection.exec("CREATE TRIGGER abort_everything BEFORE INSERT ON kv WHEN NEW.k='abort' BEGIN SELECT RAISE(ROLLBACK,'original rollback'); END");
  assert.throws(() => leases.withHeld("worker", lease.token, () => {
    assert.throws(() => store.tx(() => store.set("abort", "bad")), /original rollback/);
    assert.equal(connection.isTransaction, false);
    assert.throws(() => retained.run(), /original rollback/);
    assert.throws(() => connection.exec("INSERT INTO kv(k,v) VALUES ('escaped2','bad')"), /original rollback/);
    assert.throws(() => store.tx(() => store.set("escaped3", "bad")), /original rollback/);
  }), /original rollback/);
  for (const key of ["abort", "escaped", "escaped2", "escaped3"]) assert.equal(store.get(key), undefined);
  leases.withHeld("worker", lease.token, () => store.set("recovered", "good"));
  assert.equal(store.get("recovered"), "good");
});

test("lease fences reject async callbacks before invocation and roll back returned thenables", (t) => {
  const { node, leases, a } = fixture(t), lease = leases.claim("worker", a);
  let invoked = false;
  assert.throws(() => leases.withHeld("worker", lease.token, async () => { invoked = true; }), { code: "IDENTITY_ASYNC_OPERATION" });
  assert.equal(invoked, false);
  assert.throws(() => leases.withHeld("worker", lease.token, () => { node.store.set("thenable", "bad"); return Promise.resolve(); }), { code: "IDENTITY_ASYNC_OPERATION" });
  assert.equal(node.store.get("thenable"), undefined);
});

test("a rejected promise continuation cannot write after its lease transaction closes", async t => {
  const { node, leases, a, b } = fixture(t), lease = leases.claim("worker", a);
  const prepared = node.store.db.prepare("INSERT INTO kv(k,v) VALUES ('escaped-async','bad')");
  let resume!: () => void, pending!: Promise<void>;
  const wait = new Promise<void>(resolve => { resume = resolve; });
  assert.throws(() => leases.withHeld("worker", lease.token, () => {
    pending = (async () => { await wait; prepared.run(); })();
    return pending;
  }), { code: "IDENTITY_ASYNC_OPERATION" });
  leases.release("worker", lease.token); const successor = leases.claim("worker", b);
  resume();
  await assert.rejects(pending, /transaction context.*closed/i);
  assert.equal(node.store.get("escaped-async"), undefined);
  leases.withHeld("worker", successor.token, () => node.store.set("successor", "good"));
  assert.equal(node.store.get("successor"), "good");
});

test("independent observers in different time zones agree on lease process birth", () => {
  const expected = inspectLeaseProcess(process.pid);
  assert.equal(expected.alive, true); assert.ok(expected.start);
  for (const TZ of ["UTC", "America/Los_Angeles", "Asia/Tokyo"]) {
    const script = `import { inspectLeaseProcess } from ${JSON.stringify(new URL("../src/identity-leases.ts", import.meta.url).href)}; console.log(JSON.stringify(inspectLeaseProcess(${process.pid})));`;
    const observed = JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8", env: { ...process.env, TZ, LC_ALL: "C" } }));
    assert.deepEqual(observed, expected, TZ);
  }
});

test("independent processes racing to claim one identity have exactly one winner", { timeout: 15000 }, async (t) => {
  const home = mkdtempSync(join(tmpdir(), "mbx-lease-race-")); new Store(home).close();
  const children: ChildProcess[] = [];
  t.after(async () => { await Promise.all(children.map(c => new Promise<void>(resolve => { if (c.exitCode !== null || c.signalCode) return resolve(); c.once("exit", () => resolve()); c.kill(); }))); rmSync(home, { recursive: true, force: true }); });
  const participants = Array.from({ length: 2 }, () => {
    const c = fork(join(import.meta.dirname, "fixtures/lease-claimant.ts"), [home], { execArgv: [], stdio: ["ignore", "ignore", "inherit", "ipc"] }); children.push(c);
    let ready!: () => void, result!: (value: { result: string; token?: string }) => void, failed!: (error: Error) => void;
    const failure = new Promise<never>((_, reject) => { failed = reject; });
    c.once("error", failed);
    c.once("exit", (code, signal) => failed(new Error(`lease claimant exited before completion: ${code ?? signal}`)));
    const readiness = new Promise<void>(resolve => { ready = resolve; }), outcome = new Promise<{ result: string; token?: string }>(resolve => { result = resolve; });
    c.on("message", (m: { ready?: boolean; result?: string; token?: string }) => { if (m.ready) ready(); if (m.result) result({ result: m.result, token: m.token }); });
    const readyOrFailed = Promise.race([readiness, failure]), resultOrFailed = Promise.race([outcome, failure]);
    // Outcome may reject during startup before the readiness barrier is awaited.
    void resultOrFailed.catch(() => {});
    return { c, readiness: readyOrFailed, outcome: resultOrFailed };
  });
  await Promise.all(participants.map(p => p.readiness)); participants.forEach(p => p.c.send("claim"));
  const results = await Promise.all(participants.map(p => p.outcome));
  assert.deepEqual(results.map(r => r.result).sort(), ["IDENTITY_IN_USE", "claimed"]);
  const store = new Store(home); try { assert.equal(store.db.prepare("SELECT count(*) n FROM identity_leases WHERE released_at IS NULL").get()!.n, 1); } finally { store.close(); }
});
