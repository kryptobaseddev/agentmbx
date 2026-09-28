import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fork, type ChildProcess } from "node:child_process";
import { Store } from "../src/store.ts";
import { MbxNode } from "../src/node.ts";
import { IdentityLeases, type ProcessEvidence, type LeaseHolder } from "../src/identity-leases.ts";

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
  assert.throws(() => leases.renew("worker", first.token), { code: "IDENTITY_LEASE_LOST" });
  assert.throws(() => leases.withHeld("worker", first.token, () => 1), { code: "IDENTITY_LEASE_LOST" });
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

test("independent processes racing to claim one identity have exactly one winner", { timeout: 15000 }, async (t) => {
  const home = mkdtempSync(join(tmpdir(), "mbx-lease-race-")); new Store(home).close();
  const children: ChildProcess[] = [];
  t.after(async () => { await Promise.all(children.map(c => new Promise<void>(resolve => { if (c.exitCode !== null || c.signalCode) return resolve(); c.once("exit", () => resolve()); c.kill(); }))); rmSync(home, { recursive: true, force: true }); });
  const participants = Array.from({ length: 2 }, () => {
    const c = fork(join(import.meta.dirname, "fixtures/lease-claimant.ts"), [home], { execArgv: [], stdio: ["ignore", "ignore", "inherit", "ipc"] }); children.push(c);
    let ready!: () => void, result!: (value: { result: string; token?: string }) => void;
    const readiness = new Promise<void>(resolve => { ready = resolve; }), outcome = new Promise<{ result: string; token?: string }>(resolve => { result = resolve; });
    c.on("message", (m: { ready?: boolean; result?: string; token?: string }) => { if (m.ready) ready(); if (m.result) result({ result: m.result, token: m.token }); });
    return { c, readiness, outcome };
  });
  await Promise.all(participants.map(p => p.readiness)); participants.forEach(p => p.c.send("claim"));
  const results = await Promise.all(participants.map(p => p.outcome));
  assert.deepEqual(results.map(r => r.result).sort(), ["IDENTITY_IN_USE", "claimed"]);
  const store = new Store(home); try { assert.equal(store.db.prepare("SELECT count(*) n FROM identity_leases WHERE released_at IS NULL").get()!.n, 1); } finally { store.close(); }
});
