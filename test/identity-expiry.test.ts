import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { MbxNode } from "../src/node.ts";
import { identityRequestKey, readIdentityControlReceipt, resolveIdentityControlReceipt, type IdentityControlRequest } from "../src/identity-control.ts";

function fixture(t: { after: (fn: () => void) => void }) {
  const home = mkdtempSync(join(tmpdir(), "mbx-expiry-")), node = new MbxNode(home, { host: "alpha" });
  t.after(() => { node.close(); rmSync(home, { recursive: true, force: true }); });
  const request: IdentityControlRequest = { v: 1, id: randomUUID(), action: "release", status: "pending", requester_pid: process.pid,
    requester_start: "fixture", created_at: Date.now() - 2000, expires_at: Date.now() - 1000,
    target: { v: 1, cli: "claude", session_id: "test", control_key: "fixture", mcp_pid: process.pid, mcp_start: "fixture",
      parent_pid: process.ppid, parent_start: "fixture", agent: "reader", generation: null } };
  node.store.set(identityRequestKey(request.id), JSON.stringify(request));
  return { home, node, request };
}

test("result finalizes an expired abandoned request once without executing or touching mail", t => {
  const { home, node, request } = fixture(t);
  node.send({ from: "sender", to: ["reader"], subject: "history", body: "preserved" });
  const messages = node.store.db.prepare("SELECT * FROM messages").all();
  const deliveries = node.store.db.prepare("SELECT * FROM deliveries").all();
  assert.equal(readIdentityControlReceipt(home, request.id)!.status, "pending", "pure read retains the original receipt");
  const result = spawnSync(process.execPath, [resolve("bin/agentmbx.js"), "identity", "result", request.id, "--json"], {
    encoding: "utf8", env: { ...process.env, MBX_HOME: home, AGENTMBX_DEV: "1" }, timeout: 5000,
  });
  assert.equal(result.status, 1, result.stderr);
  assert.equal(JSON.parse(result.stdout).outcome, "failed");
  assert.match(JSON.parse(result.stdout).error, /expired before execution/);
  const receipt = readIdentityControlReceipt(home, request.id)!;
  assert.deepEqual(resolveIdentityControlReceipt(home, request.id), receipt);
  assert.equal(receipt.status, "failed");
  assert.deepEqual(node.store.db.prepare("SELECT * FROM messages").all(), messages);
  assert.deepEqual(node.store.db.prepare("SELECT * FROM deliveries").all(), deliveries);
  assert.deepEqual(node.store.db.prepare("SELECT * FROM identity_leases").all(), []);
});

for (const ending of ["COMMIT", "ROLLBACK"]) test(`expiry waits for an in-flight writer's ${ending}`, async t => {
  const { home, node, request } = fixture(t);
  // The writer has already passed its deadline check. Its pending receipt remains visible
  // to WAL readers until the operation and completed receipt commit together.
  const writer = spawn(process.execPath, ["--input-type=module", "-e", `
    import { DatabaseSync } from 'node:sqlite';
    const db = new DatabaseSync(process.argv[1]);
    db.exec('BEGIN IMMEDIATE');
    const key = process.argv[2], request = JSON.parse(db.prepare('SELECT v FROM kv WHERE k=?').get(key).v);
    db.prepare('UPDATE kv SET v=? WHERE k=?').run(JSON.stringify({...request,status:'completed',completed_at:Date.now(),result:{done:true}}),key);
    process.stdout.write('locked');
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,500);
    db.exec(process.argv[3]); db.close();
  `, join(home, "mbx.db"), identityRequestKey(request.id), ending], { stdio: ["ignore", "pipe", "pipe"] });
  const exited = once(writer, "exit");
  t.after(() => { if (writer.exitCode === null) writer.kill(); });
  await once(writer.stdout, "data");
  assert.equal(readIdentityControlReceipt(home, request.id)!.status, "pending");
  const receipt = resolveIdentityControlReceipt(home, request.id)!;
  assert.equal(receipt.status, ending === "COMMIT" ? "completed" : "failed");
  if (ending === "COMMIT") assert.deepEqual(receipt.result, { done: true });
  else assert.match(receipt.error!, /expired/);
  assert.deepEqual(readIdentityControlReceipt(home, request.id), receipt);
  assert.equal((await exited)[0], 0);
});

test("unexpired and absent receipts remain untouched; missing homes are not initialized", t => {
  const { home, node, request } = fixture(t);
  request.expires_at = Date.now() + 10_000; request.created_at = Date.now();
  node.store.set(identityRequestKey(request.id), JSON.stringify(request));
  assert.deepEqual(resolveIdentityControlReceipt(home, request.id), request);
  assert.equal(resolveIdentityControlReceipt(home, randomUUID()), null);
  const missing = join(home, "missing");
  assert.equal(resolveIdentityControlReceipt(missing, request.id), null);
  assert.equal(existsSync(missing), false);
});

for (const schema of [1, 999]) test(`expiry does not migrate or modify schema ${schema}`, t => {
  const { home, node, request } = fixture(t);
  node.store.db.exec(`PRAGMA user_version=${schema}; PRAGMA wal_checkpoint(TRUNCATE)`);
  const before = readFileSync(join(home, "mbx.db"));
  assert.throws(() => resolveIdentityControlReceipt(home, request.id), /schema/);
  assert.deepEqual(readFileSync(join(home, "mbx.db")), before);
  assert.equal(JSON.parse(node.store.get(identityRequestKey(request.id))!).status, "pending");
});
