import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildEnvelope, checkShape, signEnvelope, verifyEnvelope } from "../src/envelope.ts";
import { canonical, generateKeyPair, verifyData } from "../src/crypto.ts";
import { MbxNode } from "../src/node.ts";
import { checkEnc, generateEncKeyPair, openBody, sealBody, ENC_ALG } from "../src/body-encryption.ts";

const recipient = generateEncKeyPair();

test("seal/open roundtrips a body for the recipient", () => {
  const enc = sealBody("hello over an untrusted hop", recipient.publicKey, "01TESTENVELOPE");
  assert.equal(openBody(enc, recipient.privateKey, "01TESTENVELOPE"), "hello over an untrusted hop");
  assert.equal(checkEnc(enc), null);
});

test("every seal is independently keyed (ephemeral forward secrecy)", () => {
  const a = sealBody("same body", recipient.publicKey);
  const b = sealBody("same body", recipient.publicKey);
  assert.notEqual(a.epk, b.epk);
  assert.notEqual(a.body, b.body);
  assert.equal(openBody(a, recipient.privateKey), "same body");
  assert.equal(openBody(b, recipient.privateKey), "same body");
});

test("wrong recipient, tampered ciphertext and wrong envelope id all fail closed", () => {
  const enc = sealBody("secret", recipient.publicKey, "01RIGHTID");
  const stranger = generateEncKeyPair();
  assert.throws(() => openBody(enc, stranger.privateKey, "01RIGHTID"));
  const tampered = { ...enc, body: Buffer.concat([Buffer.from(enc.body, "base64").subarray(0, 4), Buffer.from([0xff])]).toString("base64") };
  assert.throws(() => openBody(tampered as never, recipient.privateKey, "01RIGHTID"));
  assert.throws(() => openBody(enc, recipient.privateKey, "01WRONGID"), /invalid|bad|tag|mac/i);
});

test("checkEnc validates the v1 shape and refuses everything else", () => {
  const enc = sealBody("x", recipient.publicKey);
  assert.equal(checkEnc(null), "bad enc");
  assert.equal(checkEnc("nope"), "bad enc");
  assert.equal(checkEnc({ ...enc, v: 2 }), "unsupported enc version");
  assert.equal(checkEnc({ ...enc, alg: "rot13" }), "unsupported enc algorithm");
  assert.equal(checkEnc({ ...enc, epk: "AAAA" }), "bad enc epk");
  assert.equal(checkEnc({ ...enc, nonce: "AAAA" }), "bad enc nonce");
  assert.equal(checkEnc({ ...enc, body: "" }), "bad enc body");
  assert.equal(checkEnc({ v: 1, alg: ENC_ALG, epk: enc.epk, nonce: enc.nonce, body: enc.body }), null);
});

test("checkShape accepts a signed envelope with a valid enc and still refuses malformed enc", () => {
  const host = generateKeyPair();
  const enc = sealBody("cipher body", recipient.publicKey);
  const signed = signEnvelope(buildEnvelope({ from: "a@h1", to: ["b@h2"], subject: "hi", body: "cipher body" }), "h1", host.publicKey, host.privateKey);
  assert.equal(checkShape({ ...signed, enc }), null);
  assert.equal(checkShape({ ...signed, enc: { v: 9 } }), "unsupported enc version");
  assert.equal(checkShape({ ...signed, enc: null }), null, "plaintext envelopes stay valid");
});

test("the signature commits to the ciphertext, and wire and decrypted-storage forms verify identically", () => {
  const sender = generateKeyPair();
  const draft = buildEnvelope({ from: "agent@alpha", to: ["peer@beta"], subject: "sealed", body: "top secret body" });
  // simulate the transport edge (relay or opted-in LAN): seal, then sign the wire form
  const sealed = sealBody(draft.body, recipient.publicKey, draft.id);
  const wire = signEnvelope({ ...draft, enc: sealed, body: sealed.body }, "alpha", sender.publicKey, sender.privateKey);
  assert.equal(verifyEnvelope(wire, sender.publicKey), true);
  const stored = { ...wire, body: draft.body }; // local storage keeps plaintext (D001), enc retained
  assert.equal(verifyEnvelope(stored, sender.publicKey), true, "decrypted storage form verifies with the same signature");
  const other = sealBody("a DIFFERENT body", recipient.publicKey, draft.id);
  const grafted = { ...wire, enc: other, body: other.body };
  assert.equal(verifyEnvelope(grafted, sender.publicKey), false,
    "ciphertext is committed: grafting another envelope's ciphertext without re-signing breaks verification");
  // plaintext envelopes canonicalize exactly as before the enc field existed
  const plain = signEnvelope(draft, "alpha", sender.publicKey, sender.privateKey);
  const legacy = { ...draft, enc: null } as Parameters<typeof canonical>[0];
  assert.equal(verifyData(sender.publicKey, canonical(legacy), plain.sig!.value), true,
    "signatures produced over the pre-enc canonical form still verify");
});

test("receive opens sealed bodies, stores plaintext locally, and rejects tampered ciphertext", () => {
  const homes = [mkdtempSync(join(tmpdir(), "mbx-recv-a-")), mkdtempSync(join(tmpdir(), "mbx-recv-b-"))];
  const a = new MbxNode(homes[0], { host: "alpha" }), b = new MbxNode(homes[1], { host: "beta" });
  try {
    a.addApprovedPeer({ host: "beta", pubkey: b.key.publicKey, owner_pubkey: null, addr: "unused" }, "fixture");
    b.addApprovedPeer({ host: "alpha", pubkey: a.key.publicKey, owner_pubkey: null, addr: "unused" }, "fixture");
    const draft = buildEnvelope({ from: "agent@alpha", to: ["peer@beta"], subject: "sealed", body: "secret over the wire" });
    const sealed = sealBody(draft.body, b.encKey.publicKey, draft.id);
    const wire = signEnvelope({ ...draft, enc: sealed, body: sealed.body }, "alpha", a.key.publicKey, a.key.privateKey);
    assert.equal(b.receive(wire, "alpha"), "accepted");
    const stored = JSON.parse(b.store.db.prepare("SELECT envelope FROM messages WHERE id=?").get(draft.id)!.envelope as string);
    assert.equal(stored.body, "secret over the wire", "local storage holds the plaintext");
    assert.ok(stored.enc, "enc is retained so the signature keeps committing to the ciphertext");
    assert.equal(verifyEnvelope(stored, a.key.publicKey), true, "stored form re-verifies");
    assert.equal(b.inbox("peer").length, 1);

    const draft2 = buildEnvelope({ from: "agent@alpha", to: ["peer@beta"], subject: "tampered", body: "original" });
    const sealed2 = sealBody(draft2.body, b.encKey.publicKey, draft2.id);
    const badBytes = Buffer.from(sealed2.body, "base64"); badBytes[10] ^= 0xff;
    const tampered = signEnvelope({ ...draft2, enc: { ...sealed2, body: badBytes.toString("base64") }, body: badBytes.toString("base64") }, "alpha", a.key.publicKey, a.key.privateKey);
    assert.equal(b.receive(tampered, "alpha"), "rejected:undecryptable body");
  } finally { a.close(); b.close(); homes.forEach((h) => rmSync(h, { recursive: true, force: true })); }
});
