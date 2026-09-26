// Two hosts over real HTTP on localhost: pairing with the code, signed hops, outbox retry, offline peers.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo, Server } from "node:net";
import { flushOutbox, pairWith, refreshDirectory, signHop, startServer } from "../src/http.ts";
import { MbxNode } from "../src/node.ts";

const tmp = () => mkdtempSync(join(tmpdir(), "mbx-lan-"));
process.env.MBX_NO_DESKTOP = "1";

async function up(host: string) {
  const n = new MbxNode(tmp(), { host, bind: "127.0.0.1", port: 0 });
  const s = await startServer(n, 0, "127.0.0.1");
  const addr = `127.0.0.1:${(s.address() as AddressInfo).port}`;
  return { n, s, addr };
}
const down = (...xs: { n: MbxNode; s: Server }[]) => xs.forEach((x) => { x.s.close(); x.n.close(); });

test("pair over HTTP, both sides show the same code, then exchange messages both ways", async () => {
  const A = await up("alpha"), B = await up("beta");
  process.env.MBX_ADVERTISE = A.addr;
  const r = await pairWith(A.n, B.addr);
  delete process.env.MBX_ADVERTISE;
  assert.equal(r.host, "beta");
  const onB = B.n.peer("alpha")!, onA = A.n.peer("beta")!;
  assert.equal(onA.code, onB.code, "both hosts must display the same code");
  assert.equal(onB.state, "pending");
  // before approval, beta refuses alpha's envelopes
  A.n.approvePeer("beta", r.code);
  A.n.send({ from: "mac-dev", to: ["vida-dev@beta"], subject: "early", body: "x" });
  await flushOutbox(A.n);
  assert.equal(B.n.inbox("vida-dev").length, 0);
  assert.equal((A.n.store.db.prepare("SELECT count(*) n FROM outbox").get() as { n: number }).n, 1, "kept for retry");
  assert.throws(() => B.n.approvePeer("alpha", "000001"), /code mismatch/);
  B.n.approvePeer("alpha", r.code);
  A.n.store.db.prepare("UPDATE outbox SET next_at=?").run(new Date(0).toISOString());
  assert.deepEqual(await flushOutbox(A.n), { sent: 1, failed: 0 });
  assert.equal(B.n.inbox("vida-dev")[0].trust, "verified");
  // reply back, directory sync, bare-name routing
  B.n.registerAgent("vida-dev", { role: "dev" });
  const m = B.n.inbox("vida-dev")[0];
  B.n.send({ from: "vida-dev", to: [m.from_addr], subject: "re: early", body: "got it", kind: "reply", reply_to: m.id, thread: m.thread });
  assert.deepEqual(await flushOutbox(B.n), { sent: 1, failed: 0 });
  assert.equal(A.n.inbox("mac-dev")[0].subject, "re: early");
  await refreshDirectory(A.n);
  assert.ok(A.n.agents().some((a) => a.name === "vida-dev" && a.host === "beta"));
  const routed = A.n.send({ from: "mac-dev", to: ["vida-dev"], subject: "bare", body: "b" });
  assert.deepEqual(routed.remote, ["beta"]);
  down(A, B);
});

test("offline peer: messages wait in the outbox and arrive when it comes back", async () => {
  const A = await up("alpha"), B = await up("beta");
  process.env.MBX_ADVERTISE = A.addr;
  const r = await pairWith(A.n, B.addr);
  delete process.env.MBX_ADVERTISE;
  A.n.approvePeer("beta", r.code); B.n.approvePeer("alpha", r.code);
  const port = (B.s.address() as AddressInfo).port;
  B.s.close();
  A.n.send({ from: "mac-dev", to: ["worker@beta"], subject: "while you slept", body: "z", kind: "task" });
  const first = await flushOutbox(A.n);
  assert.deepEqual(first, { sent: 0, failed: 0 });
  const row = A.n.store.db.prepare("SELECT attempts, last_error FROM outbox").get() as { attempts: number; last_error: string };
  assert.equal(row.attempts, 1);
  const B2 = await startServer(B.n, port, "127.0.0.1");
  assert.deepEqual(await flushOutbox(A.n, Date.now() + 60_000), { sent: 1, failed: 0 });
  assert.equal(B.n.inbox("worker").length, 1);
  B2.close(); down(A); B.n.close();
});

test("hops: stale timestamps and unpaired or forged senders get 401", async () => {
  const A = await up("alpha"), B = await up("beta"), C = await up("gamma");
  process.env.MBX_ADVERTISE = A.addr;
  const r = await pairWith(A.n, B.addr);
  delete process.env.MBX_ADVERTISE;
  A.n.approvePeer("beta", r.code); B.n.approvePeer("alpha", r.code);
  const path = "/v1/agents";
  const ok = await fetch(`http://${B.addr}${path}`, { headers: signHop(A.n, "GET", path, "") });
  assert.equal(ok.status, 200);
  const stale = { ...signHop(A.n, "GET", path, ""), "x-mbx-ts": new Date(Date.now() - 6 * 60_000).toISOString() };
  assert.equal((await fetch(`http://${B.addr}${path}`, { headers: stale })).status, 401);
  assert.equal((await fetch(`http://${B.addr}${path}`, { headers: signHop(C.n, "GET", path, "") })).status, 401);
  const forged = { ...signHop(C.n, "GET", path, ""), "x-mbx-host": "alpha" };
  assert.equal((await fetch(`http://${B.addr}${path}`, { headers: forged })).status, 401);
  down(A, B, C);
});
