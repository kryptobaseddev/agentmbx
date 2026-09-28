import { wakeText } from "../src/wake.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildEnvelope, checkShape, signEnvelope, type Envelope } from "../src/envelope.ts";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { MbxNode, formatFor, summaryLine } from "../src/node.ts";

test("paired signed mail rejects malformed metadata before storing or waking", async t => {
  const home = mkdtempSync(join(tmpdir(), "mbx-meta-"));
  const a = new MbxNode(join(home, "a"), { host: "alpha" });
  const b = new MbxNode(join(home, "b"), { host: "beta" });
  t.after(() => { a.close(); b.close(); rmSync(home, { recursive: true, force: true }); });
  b.upsertPendingPeer({ host: "alpha", pubkey: a.key.publicKey, owner_pubkey: null, addr: "127.0.0.1:0", code: "000000", nonce_local: "n", nonce_remote: "n" });
  b.approvePeer("alpha"); b.registerAgent("worker");
  const draft = () => buildEnvelope({ from: "sender@alpha", to: ["worker@beta"], subject: "metadata", body: "hello @worker" });
  const valid = draft().meta;
  const malformed: unknown[] = [undefined, null, [], "bad", 1, true, {}];
  for (const field of ["mentions", "directives", "tags", "task_refs"]) {
    for (const value of [undefined, null, "worker", {}, [1], [null]]) malformed.push({ ...valid, [field]: value });
  }
  let malformedId = "";
  for (const meta of malformed) {
    const e = signEnvelope({ ...draft(), meta } as Envelope, "alpha", a.key.publicKey, a.key.privateKey);
    assert.notEqual(checkShape(e), null, JSON.stringify(meta));
    assert.match(b.receive(e, "alpha"), /^rejected:bad meta/);
    assert.equal(b.store.hasMessage(e.id), false);
    assert.equal(b.inbox("worker").length, 0);
    // Simulate a receipt accepted by an older version, without rewriting its signed bytes.
    b.store.insertMessage(e, "alpha", "verified", { ok: true, session: "signed by the owner" });
    b.store.addDelivery(e.id, "worker");
    const stored = b.inbox("worker")[0];
    assert.equal(b.policyFor(stored, "worker").level, "ask");
    assert.equal(b.wantsWake("worker", stored), false);
    assert.match(b.policyFor(stored, "worker").notes.join(" "), /malformed-envelope/);
    assert.match(formatFor(b, stored, "worker"), /hello @worker/);
    assert.match(formatFor(b, stored, "worker"), /authority: none.*stored message structure is invalid/);
    assert.doesNotMatch(summaryLine(stored), /OWNER/);
    assert.doesNotMatch(wakeText("worker", [stored]), /OWNER-authority/);
    assert.equal(b.message(e.id)!.envelope, JSON.stringify(e));
    b.ack(e.id, "worker");
    malformedId = e.id;
  }
  const client = new Client({ name: "metadata-test", version: "1" });
  try {
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [join(import.meta.dirname, "../bin/agentmbx.js"), "mcp"],
      env: { ...process.env, AGENTMBX_DEV: "1", MBX_HOME: b.home, MBX_CLI: "claude", MBX_AGENT: "worker", MBX_NO_DESKTOP: "1" } as Record<string, string> }));
    const read = await client.callTool({ name: "mbx_read", arguments: { ids: [malformedId] } });
    assert.notEqual(read.isError, true);
    const sent = await client.callTool({ name: "mbx_send", arguments: { to: ["receiver"], subject: "relay", body: "retained content" } });
    assert.notEqual(sent.isError, true);
    const relay = JSON.parse(b.message((sent.structuredContent as { id: string }).id)!.envelope);
    assert.equal(relay.meta.origin, "external");
    assert.ok(relay.meta.hop > 6);
  } finally { await client.close(); }
  // Historical messages with no lease marker remain structurally valid and readable.
  const e = signEnvelope(draft(), "alpha", a.key.publicKey, a.key.privateKey);
  assert.equal(checkShape(e), null);
  assert.equal(b.receive(e, "alpha"), "accepted");
  const m = b.inbox("worker")[0];
  assert.equal(b.policyFor(m, "worker").level, "ask");
  assert.equal(b.wantsWake("worker", m), true);
  assert.match(formatFor(b, m, "worker"), /hello @worker/);
});
