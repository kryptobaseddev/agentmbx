import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { MbxNode } from "../src/node.ts";

function fixture(t: TestContext) {
  const home = mkdtempSync(join(tmpdir(), "mbx-search-"));
  const n = new MbxNode(home, { host: "alpha" });
  t.after(() => { n.close(); rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
  return n;
}

test("scoped search applies visibility before limiting ranked results", (t) => {
  const n = fixture(t);
  for (let i = 0; i < 30; i++) n.send({ from: "other", to: ["elsewhere"], subject: "needle", body: "needle needle needle" });
  const own = n.send({ from: "sender", to: ["primary"], subject: "my result", body: `needle ${"padding ".repeat(100)}` }).envelope.id;
  assert.ok(!n.search("needle", 20).some(m => m.id === own), "fixture ranks unrelated mail ahead of the visible result");
  assert.deepEqual(n.search("needle", 1, "primary").map(m => m.id), [own]);
});

test("scoped search matches visibility for direct, sent, linked and separately bound mail", (t) => {
  const n = fixture(t);
  n.linkIdentity("shell", "primary");
  const send = (from: string, to: string[]) => n.send({ from, to, subject: "needle", body: "body" }).envelope.id;
  const direct = send("other", ["primary", "shell"]);
  const linked = send("other", ["shell"]);
  const sent = send("primary", ["elsewhere"]);
  const linkedSent = send("shell", ["elsewhere"]);
  send("other", ["elsewhere"]);
  const expected = () => n.search("needle", 100).filter(m => n.canSee(m, "primary")).map(m => m.id);
  assert.deepEqual(n.search("needle", 100, "primary").map(m => m.id), expected());
  assert.deepEqual(new Set(expected()), new Set([direct, sent]));
  assert.equal(n.search("needle", 2, "primary").length, 2);
  assert.deepEqual(n.search("needle", 0, "primary"), []);
  assert.deepEqual(n.search(' " ', 10, "primary"), []);
  n.bindSession({ agent: "shell", cli: "kimi", session_id: "separate", pid: process.pid });
  assert.deepEqual(n.search("needle", 100, "primary").map(m => m.id), expected());
  assert.deepEqual(new Set(expected()), new Set([direct, sent]));
});

test("remote senders with the same name do not gain local sender visibility", (t) => {
  const n = fixture(t);
  const home = mkdtempSync(join(tmpdir(), "mbx-search-peer-"));
  const peer = new MbxNode(home, { host: "beta" });
  t.after(() => { peer.close(); rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
  const foreign = peer.send({ from: "primary", to: ["elsewhere"], subject: "needle", body: "remote private" }).envelope;
  const received = peer.send({ from: "primary", to: ["primary"], subject: "needle", body: "remote delivered" }).envelope;
  n.store.insertMessage(foreign, "beta", "verified", null);
  n.store.insertMessage(received, "beta", "verified", null);
  n.store.addDelivery(received.id, "primary");
  assert.deepEqual(n.search("needle", 10, "primary").map(m => m.id), [received.id]);
  assert.deepEqual(n.search("needle", 10, "primary"), n.search("needle", 10).filter(m => n.canSee(m, "primary")));
});
