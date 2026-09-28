import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonical, generateKeyPair, signData } from "../src/crypto.ts";
import { buildEnvelope } from "../src/envelope.ts";
import { MbxNode, formatFor, trustLabel } from "../src/node.ts";
import { acceptSigned, makePolicy } from "../src/policy.ts";
import { sendLeased } from "./helpers/leased-send.ts";

test("message policies require signed positive sender evidence locally and across paired hosts", async t => {
  const homes: string[] = [], nodes: MbxNode[] = [];
  t.after(() => { nodes.forEach(n => n.close()); homes.forEach(h => rmSync(h, { recursive: true, force: true })); });
  const host = (name: string) => {
    const home = mkdtempSync(join(tmpdir(), "mbx-sender-proof-")); homes.push(home);
    const owner = generateKeyPair();
    writeFileSync(join(home, "owner.json"), JSON.stringify({ backend: "keychain", public_key: owner.publicKey }), { mode: 0o600 });
    const n = new MbxNode(home, { host: name }); nodes.push(n);
    const rec = makePolicy({ level: "yolo", agents: ["recipient"], hosts: [name], from: ["*"], ownerPub: owner.publicKey });
    assert.equal(acceptSigned(n.store.db, { rec, sig: signData(owner.privateKey, canonical(rec)) }, name), null);
    return { n, owner };
  };
  const a = host("alpha"), b = host("beta"), draft = { from: "claimed", to: ["recipient", "recipient@beta"], subject: "request", body: "body" };
  b.n.addApprovedPeer({ host: "alpha", pubkey: a.n.key.publicKey, owner_pubkey: a.owner.publicKey, addr: "unused" }, "fixture");
  const plain = a.n.send(draft).envelope;
  assert.equal(plain.meta.sender_verification, "unverified");
  const old = a.n.send(draft, undefined, undefined, buildEnvelope({ ...draft, from: "claimed@alpha" })).envelope;
  assert.equal(old.meta.sender_verification, undefined, "simulate an older signer that omits the marker");
  for (const e of [plain, old]) {
    const local = a.n.message(e.id)!;
    assert.equal(a.n.policyFor(local, "recipient").level, "ask"); assert.match(trustLabel(local), /unverified-sender/);
    assert.equal(b.n.receive(e, "alpha"), "accepted", "unverified mail remains readable");
    assert.equal(b.n.policyFor(b.n.message(e.id)!, "recipient").level, "ask");
  }
  const good = sendLeased(a.n, draft).envelope, row = a.n.message(good.id)!;
  assert.equal(a.n.policyFor(row, "recipient").level, "yolo", "send-time proof remains valid after the fixture lease releases");
  assert.equal(b.n.receive(good, "alpha"), "accepted");
  const remote = b.n.message(good.id)!;
  assert.equal(b.n.policyFor(remote, "recipient").level, "yolo");
  for (const changed of [{ ...good, body: "tampered" }, { ...plain, meta: { ...plain.meta, sender_verification: "leased" } }]) {
    assert.equal(a.n.policyFor({ ...row, envelope: JSON.stringify(changed) }, "recipient").level, "ask");
  }
  b.n.store.db.prepare("UPDATE peers SET pubkey=? WHERE host='alpha'").run(generateKeyPair().publicKey);
  assert.equal(b.n.policyFor(remote, "recipient").level, "ask", "old signatures cannot inherit a new pairing");
  const owned = await a.n.sendAsOwner({ ...draft, from: "owner" }, async payload => ({ sig: signData(a.owner.privateKey, payload) }));
  const ownerRow = a.n.message(owned.envelope.id)!;
  assert.equal(JSON.parse(ownerRow.authority!).ok, true);
  assert.match(formatFor(a.n, ownerRow, "recipient"), /authority: OWNER/);
  assert.doesNotMatch(trustLabel(ownerRow), /unverified-sender/, "owner authority is separate from agent lease attestation");
});
