// T497: mail to task:<id> reaches every live persona on that task, and only those.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateKeyPair } from "../src/crypto.ts";
import { capsNeeded, type Envelope } from "../src/envelope.ts";
import { MbxNode } from "../src/node.ts";
import { setSessionPresence } from "../src/presence.ts";
import { assertKnownRecipients, recipientReceipts } from "../src/receipts.ts";
import { SCHEMA_VERSION } from "../src/store.ts";

process.env.MBX_NO_DESKTOP = "1";

function world(t: { after: (fn: () => void) => void }) {
  const home = mkdtempSync(join(tmpdir(), "mbx-task-"));
  const n = new MbxNode(home, { host: "alpha" });
  t.after(() => { n.close(); rmSync(home, { recursive: true, force: true }); });
  const bind = (agent: string, sessionId: string) => n.bindSession({ agent, cli: "grok", session_id: sessionId, pid: process.pid });
  return { n, bind };
}

test("task: reaches every live persona on that task and names each in the receipts", (t) => {
  const { n, bind } = world(t);
  bind("on-task", "s-on");
  bind("also", "s-also");
  bind("other", "s-other");
  setSessionPresence(n, { cli: "grok", sessionId: "s-on", task: "T497", lane: "implementation" });
  setSessionPresence(n, { cli: "grok", sessionId: "s-also", task: "T497" });
  setSessionPresence(n, { cli: "grok", sessionId: "s-other", task: "T500" });
  n.store.db.prepare(`INSERT INTO sessions (agent,cli,session_id,pid,channel,updated_at,pid_start,task) VALUES ('stale','grok','s-stale',1,0,?, 'dead','T497')`)
    .run(new Date().toISOString());
  assert.equal(n.store.schemaVersion(), SCHEMA_VERSION);
  assert.equal(n.recipientAddrs(["task:T497"]), null);
  assert.doesNotThrow(() => assertKnownRecipients(n, ["task:T497", "task:nope"]));
  assert.ok(capsNeeded({ kind: "message", to: ["task:T497"] } as Envelope).includes("broadcast"));
  assert.ok(!capsNeeded({ kind: "message", to: ["on-task"] } as Envelope).includes("broadcast"));

  const sent = n.send({ from: "boss", to: ["task:T497"], subject: "s", body: "b" });
  assert.deepEqual(new Set(sent.local), new Set(["on-task", "also"]));
  assert.equal(sent.remote.length, 0);
  assert.equal(n.inbox("other").length, 0);
  assert.equal(n.inbox("stale").length, 0);
  const receipts = recipientReceipts(n, sent.envelope.id, sent.targets);
  assert.deepEqual(receipts.map((r) => r.address).sort(), ["also@alpha", "on-task@alpha"]);
  assert.ok(receipts.every((r) => r.to === "task:T497"));

  const bad = n.send({ from: "boss", to: ["task:nope"], subject: "s", body: "b" });
  assert.deepEqual(bad.local, []);
  assert.match(bad.warnings.join("\n"), /task:nope: not a CLEO task id/);
  assert.equal(n.inbox("on-task").length, 1);

  n.bindSession({ agent: "on-task", cli: "grok", session_id: "s-on", pid: process.pid });
  const kept = n.store.db.prepare("SELECT task, lane FROM sessions WHERE cli='grok' AND session_id='s-on'").get() as { task: string; lane: string };
  assert.equal(kept.task, "T497");
  assert.equal(kept.lane, "implementation");
});

test("task: queues one copy to each paired host and does not fan out again on receive", (t) => {
  const { n, bind } = world(t);
  bind("on-task", "s-on");
  setSessionPresence(n, { cli: "grok", sessionId: "s-on", task: "T497" });
  const beta = generateKeyPair();
  n.upsertPendingPeer({ host: "beta", pubkey: beta.publicKey, owner_pubkey: null, addr: "127.0.0.1:9", code: "000000", nonce_local: "n", nonce_remote: "n" });
  n.approvePeer("beta");
  const sent = n.send({ from: "boss", to: ["task:T497", "on-task"], subject: "s", body: "b" });
  assert.deepEqual(sent.remote, ["beta"]);
  assert.deepEqual(sent.envelope.meta.local_names, ["on-task"]);
  const receipts = recipientReceipts(n, sent.envelope.id, sent.targets);
  assert.ok(receipts.some((r) => r.address === "on-task@alpha" && r.to === "task:T497"));
  assert.ok(receipts.some((r) => r.address === "*@beta" && r.state === "remote"));
  const again = n.route(["task:T497"], true);
  assert.equal(again.remote.size, 0);
  assert.ok(again.local.has("on-task"));
});
