import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { MbxNode } from "../src/node.ts";

function fixture(t: TestContext) {
  const home = mkdtempSync(join(tmpdir(), "mbx-ack-"));
  const n = new MbxNode(home, { host: "alpha" });
  t.after(() => { n.close(); rmSync(home, { recursive: true, force: true }); });
  n.linkIdentity("shell-one", "primary"); n.linkIdentity("shell-two", "primary");
  return n;
}
const send = (n: MbxNode, to: string[]) => n.send({ from: "sender", to, subject: "ack", body: "body" }).envelope.id;
const state = (n: MbxNode, id: string, agent: string) => (n.store.db.prepare("SELECT state FROM deliveries WHERE msg_id=? AND agent=?").get(id, agent) as { state: string } | undefined)?.state;

test("primary session acknowledges one linked recipient without creating a primary delivery", (t) => {
  const n = fixture(t), id = send(n, ["shell-one"]);
  assert.equal(n.ack(id, "primary", "done", "handled linked request"), id);
  assert.equal(state(n, id, "shell-one"), "acked");
  assert.equal(state(n, id, "primary"), undefined);
  assert.equal(n.ack(id, "primary"), id, "repeat acknowledgement stays idempotent");
  const audit = n.store.db.prepare("SELECT detail FROM audit WHERE event='peer_action'").get() as { detail: string };
  assert.equal(JSON.parse(audit.detail).agent, "primary");
  assert.equal(JSON.parse(audit.detail).recipient, "shell-one");
});

test("direct delivery wins without acknowledging linked duplicate recipients", (t) => {
  const n = fixture(t), id = send(n, ["primary", "shell-one"]);
  n.ack(id, "primary"); n.ack(id, "primary");
  assert.equal(state(n, id, "primary"), "acked");
  assert.equal(state(n, id, "shell-one"), "delivered");
});

test("multiple linked recipient copies require an explicit mailbox choice", (t) => {
  const n = fixture(t), id = send(n, ["shell-one", "shell-two"]);
  assert.throws(() => n.ack(id, "primary"), { code: "AMBIGUOUS_RECIPIENT" });
  assert.equal(state(n, id, "shell-one"), "delivered");
  n.ack(id, "shell-one");
  assert.equal(state(n, id, "shell-two"), "delivered");
  assert.throws(() => n.ack(id, "primary"), { code: "AMBIGUOUS_RECIPIENT" });
});

test("sender visibility and independently bound names grant no acknowledgement", (t) => {
  const n = fixture(t), id = send(n, ["shell-one"]);
  assert.throws(() => n.ack(id, "sender"), { code: "NOT_RECIPIENT" });
  n.bindSession({ agent: "shell-one", cli: "kimi", session_id: "own", pid: process.pid });
  assert.throws(() => n.ack(id, "primary"), { code: "NOT_FOUND" });
  assert.equal(state(n, id, "shell-one"), "delivered");
});

for (const recipient of ["primary", "shell-one"]) test(`acknowledgement for ${recipient} rolls back if auditing fails`, (t) => {
  const n = fixture(t), id = send(n, [recipient]);
  t.mock.method(n.store, "audit", () => { throw new Error("audit unavailable"); });
  assert.throws(() => n.ack(id, "primary", null, "handled"), /audit unavailable/);
  assert.equal(state(n, id, recipient), "delivered");
});
