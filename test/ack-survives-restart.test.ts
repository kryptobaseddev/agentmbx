// T647: an acknowledged delivery never comes back after the daemon reopens the store or the session rebinds;
// mail that was only read stays counted until it is acknowledged.
import { sendLeased } from "./helpers/leased-send.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { bindWakeLease } from "./helpers/wake-lease.ts";
import { MbxNode } from "../src/node.ts";

test("T647: acks survive a store reopen and a rebind; read-only mail stays unacked", t => {
  const home = mkdtempSync(join(tmpdir(), "mbx-t647-"));
  let n = new MbxNode(home, { host: "alpha" });
  t.after(() => { n.close(); rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
  bindWakeLease(n, { agent: "worker", cli: "opencode", session_id: "ses_a", pid: process.ppid });
  const ids = [1, 2].map(i => sendLeased(n, { from: "sender", to: ["worker"], subject: `m${i}`, body: "x", kind: "request" }).envelope.id);
  n.markRead(n.inbox("worker"), "worker");
  n.ack(ids[0], "worker");
  assert.equal(n.unreadCount("worker"), 1);
  n.close();
  n = new MbxNode(home, { host: "alpha" });
  assert.deepEqual(n.inbox("worker").map(m => [m.id, m.state]), [[ids[1], "read"]]);
  n.bindSession({ agent: "worker", cli: "opencode", session_id: "ses_a", pid: process.ppid });
  // A rebind re-arms desktop-only mail for a wake; it never touches read or acked copies.
  n.store.addDelivery(ids[0], "worker"); // a relay or retention replay re-delivering the same id
  assert.equal(n.unreadCount("worker"), 1);
  assert.deepEqual(n.inbox("worker").map(m => [m.id, m.state]), [[ids[1], "read"]]);
});
