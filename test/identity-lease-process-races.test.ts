import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { fork, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Store } from "../src/store.ts";

interface Result { ok: boolean; code?: string; value?: { token: string; holder_pid: number; heartbeat_at: number } | boolean | number }
async function fixture(t: TestContext) {
  const home = mkdtempSync(join(tmpdir(), "mbx-process-race-")), store = new Store(home), children: ChildProcess[] = [];
  t.after(async () => {
    await Promise.all(children.map(child => new Promise<void>(resolve => {
      if (child.exitCode !== null || child.signalCode) return resolve();
      child.once("exit", () => resolve()); child.kill("SIGKILL");
    })));
    store.close(); rmSync(home, { recursive: true, force: true });
  });
  async function worker() {
    const child = fork(join(import.meta.dirname, "fixtures/lease-worker.ts"), [home], { execArgv: [], stdio: ["ignore", "ignore", "inherit", "ipc"] }); children.push(child);
    let seq = 0, ready!: () => void, readyFailed!: (error: Error) => void;
    const pending = new Map<number, { resolve: (result: Result) => void; reject: (error: Error) => void }>();
    const readiness = new Promise<void>((resolve, reject) => { ready = resolve; readyFailed = reject; });
    const fail = (error: Error) => { readyFailed(error); for (const request of pending.values()) request.reject(error); pending.clear(); };
    child.on("error", fail); child.on("exit", (code, signal) => fail(new Error(`lease worker exited: ${code ?? signal}`)));
    child.on("message", (message: Result & { ready?: boolean; id: number }) => {
      if (message.ready) ready();
      const request = pending.get(message.id); if (request) { pending.delete(message.id); request.resolve(message); }
    });
    await readiness;
    return { child, call: (operation: string, name: string, now: number) => new Promise<Result>((resolve, reject) => {
      const id = ++seq; pending.set(id, { resolve, reject }); child.send({ id, operation, name, now }, error => { if (error) { pending.delete(id); reject(error); } });
    }) };
  }
  const [a, b] = await Promise.all([worker(), worker()]);
  return { store, a, b };
}

test("independent renewal and takeover serialize correctly in either order", { timeout: 15000 }, async t => {
  const { store, a, b } = await fixture(t);
  for (const order of ["renew-first", "claim-first", "racing"]) {
    assert.equal((await a.call("claim", order, 1000)).ok, true);
    let renewal: Result, takeover: Result;
    if (order === "renew-first") { renewal = await a.call("renew", order, 1099); takeover = await b.call("claim", order, 1100); }
    else if (order === "claim-first") { takeover = await b.call("claim", order, 1100); renewal = await a.call("renew", order, 1099); }
    else [renewal, takeover] = await Promise.all([a.call("renew", order, 1099), b.call("claim", order, 1100)]);
    assert.notEqual(renewal.ok, takeover.ok, "exactly one generation wins this schedule");
    if (renewal.ok) assert.equal(takeover.code, "IDENTITY_IN_USE");
    else assert.equal(renewal.code, "IDENTITY_LEASE_LOST");
    const row = store.db.prepare("SELECT holder_pid,heartbeat_at FROM identity_leases WHERE name=?").get(order)!;
    assert.equal(row.holder_pid, renewal.ok ? a.child.pid : b.child.pid);
    assert.equal(row.heartbeat_at, renewal.ok ? 1099 : 1100);
  }
});

test("an exact-deadline renewal cannot revive a lease while another process claims it", { timeout: 15000 }, async t => {
  const { a, b } = await fixture(t);
  assert.equal((await a.call("claim", "boundary", 1000)).ok, true);
  const [renewal, takeover] = await Promise.all([a.call("renew", "boundary", 1100), b.call("claim", "boundary", 1100)]);
  assert.equal(renewal.code, "IDENTITY_LEASE_LOST"); assert.equal(takeover.ok, true);
  assert.equal((await a.call("release", "boundary", 1100)).value, false);
});

test("a stopped holder resumes after takeover without writing or releasing its successor", { timeout: 15000 }, async t => {
  const { store, a, b } = await fixture(t);
  assert.equal((await a.call("claim", "paused", 1000)).ok, true);
  a.child.kill("SIGSTOP");
  assert.equal((await b.call("claim", "paused", 1100)).ok, true);
  assert.equal((await b.call("write", "paused", 1100)).ok, true);
  a.child.kill("SIGCONT");
  assert.equal((await a.call("write", "paused", 1100)).code, "IDENTITY_LEASE_LOST");
  assert.equal((await a.call("renew", "paused", 1100)).code, "IDENTITY_LEASE_LOST");
  assert.equal((await a.call("release", "paused", 1100)).value, false);
  assert.equal(store.get("writer:paused"), String(b.child.pid));
  assert.equal(store.db.prepare("SELECT released_at FROM identity_leases WHERE name='paused'").get()!.released_at, null);
});
