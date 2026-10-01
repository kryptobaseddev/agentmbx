import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildEnvelope, checkShape, signEnvelope, makeGrant, type Envelope } from "../src/envelope.ts";
import { generateKeyPair } from "../src/crypto.ts";
import { MbxNode, formatFor } from "../src/node.ts";

const owner = generateKeyPair(), session = generateKeyPair();
const grant = makeGrant(owner.publicKey, owner.privateKey, session.publicKey, "sender", "alpha", ["alert"]);
const malformedGrants = [
  { ...grant, v: 1 },
  ...["id", "iss", "sub", "agent", "host", "iat", "exp", "nonce", "sig"].flatMap(field =>
    [undefined, null, 42, {}, []].map(value => ({ ...grant, [field]: value }))),
  ...[undefined, null, "alert", {}, [1]].map(caps => ({ ...grant, caps })),
];
const invalid: Record<string, unknown[]> = {
  refs: [undefined, null, "link", {}, [1], [null]],
  ts: [0, 1, true, ["2026-09-28"]],
  thread: [undefined, null, 1, {}, []],
  reply_to: [undefined, 1, {}, []],
  needs_reply: [undefined, null, 1, "false", [], {}],
  enc: [undefined, {}, "encrypted"],
  authority: [undefined, true, "owner", [], {}, { grant: null }, { grant: {}, session_sig: "x" },
    { owner_sig: 1, owner_fp: "key" }, { owner_sig: "sig" }, { owner_sig: "sig", owner_fp: 1 },
    { owner_sig: "sig", owner_fp: "key", grant }, { owner_sig: "sig", owner_fp: "key", session_sig: "sig" },
    { grant, session_sig: 1 }, { grant, session_sig: "sig", owner_fp: "key" },
    ...malformedGrants.map(grant => ({ grant, session_sig: "sig" }))],
};
for (const [field, values] of Object.entries(invalid)) test(`paired signed envelope rejects malformed ${field}`, t => {
  const home = mkdtempSync(join(tmpdir(), "mbx-fields-"));
  const a = new MbxNode(join(home, "a"), { host: "alpha" }), b = new MbxNode(join(home, "b"), { host: "beta" });
  t.after(() => { a.close(); b.close(); rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
  b.addApprovedPeer({ host: "alpha", pubkey: a.key.publicKey, owner_pubkey: a.key.publicKey, addr: "unused" }, "fixture");
  for (const value of values) {
    const raw = buildEnvelope({ from: "sender@alpha", to: ["worker@beta"], subject: "core fields", body: "retained content" });
    const e = signEnvelope({ ...raw, [field]: value } as Envelope, "alpha", a.key.publicKey, a.key.privateKey);
    assert.notEqual(checkShape(e), null, `${field}=${JSON.stringify(value)}`);
    assert.match(b.receive(e, "alpha"), /^rejected:/);
    assert.equal(b.store.hasMessage(e.id), false);
    if (field === "refs") {
      b.store.insertMessage(e, "alpha", "verified", null);
      b.store.addDelivery(e.id, "worker");
      const row = b.read(e.id, "worker");
      assert.match(formatFor(b, row, "worker"), /retained content/);
      assert.match(formatFor(b, row, "worker"), /invalid refs/);
      assert.equal(b.policyFor(row, "worker").level, "ask");
      assert.equal(b.wantsWake("worker", row), false);
      assert.equal(b.message(e.id)!.envelope, JSON.stringify(e));
    }
  }
  const valid = signEnvelope(buildEnvelope({ from: "sender@alpha", to: ["worker@beta"], subject: "valid", body: "ok", refs: ["https://example.invalid/reference"] }), "alpha", a.key.publicKey, a.key.privateKey);
  assert.equal(checkShape(valid), null);
  assert.equal(b.receive(valid, "alpha"), "accepted");
});
