import { test } from "node:test";
import assert from "node:assert/strict";
import { canonical, fingerprint, generateKeyPair, pairingCode, ulid } from "../src/crypto.ts";
import { buildEnvelope, checkGrant, checkShape, makeGrant, parseMeta, signEnvelope, verifyEnvelope } from "../src/envelope.ts";

test("canonical JSON sorts keys and drops undefined", () => {
  assert.equal(canonical({ b: 1, a: [1, { d: 2, c: undefined }], z: null }), '{"a":[1,{"d":2}],"b":1,"z":null}');
});

test("ulid is 26 chars and sortable within a millisecond", () => {
  const ids = Array.from({ length: 50 }, () => ulid(1_700_000_000_000));
  assert.ok(ids.every((i) => i.length === 26));
  assert.deepEqual([...ids].sort(), ids);
});

test("pairing code is order-independent and 6 digits", () => {
  const a = generateKeyPair(), b = generateKeyPair();
  const x = pairingCode(a.publicKey, "n1", b.publicKey, "n2");
  assert.match(x, /^\d{6}$/);
  assert.equal(x, pairingCode(b.publicKey, "n2", a.publicKey, "n1"));
  assert.notEqual(x, pairingCode(a.publicKey, "n1", b.publicKey, "n3"));
});

test("signed envelope verifies; tampering or wrong key fails", () => {
  const host = generateKeyPair(), other = generateKeyPair();
  const e = signEnvelope(buildEnvelope({ from: "a@h1", to: ["b@h2"], subject: "hi", body: "hello @b /claim T123 #infra" }), "h1", host.publicKey, host.privateKey);
  assert.equal(checkShape(e), null);
  assert.ok(verifyEnvelope(e, host.publicKey));
  assert.ok(!verifyEnvelope({ ...e, body: "hello (edited)" }, host.publicKey));
  assert.ok(!verifyEnvelope({ ...e, from: "keaton@h1" }, host.publicKey));
  assert.ok(!verifyEnvelope(e, other.publicKey));
  assert.equal(e.sig!.key, fingerprint(host.publicKey));
});

test("metadata parser", () => {
  const m = parseMeta("@vida-dev please /claim T1925 and /done T1902 #VidaPeps (cc @axiom-dev@fedora)");
  assert.deepEqual(m.mentions, ["vida-dev", "axiom-dev@fedora"]);
  assert.deepEqual(m.directives, ["claim", "done"]);
  assert.deepEqual(m.tags, ["vidapeps"]);
  assert.deepEqual(m.task_refs, ["T1925", "T1902"]);
});

test("owner grants: valid, wrong subject, expired, forged, revoked", () => {
  const owner = generateKeyPair(), mallory = generateKeyPair();
  const g = makeGrant(owner.publicKey, owner.privateKey, "master@macbook", ["task.assign"], 30);
  assert.deepEqual(checkGrant(g, owner.publicKey, "master@macbook", new Set()), { ok: true, caps: ["task.assign"] });
  assert.equal(checkGrant(g, owner.publicKey, "other@macbook", new Set()).ok, false);
  assert.equal(checkGrant(g, owner.publicKey, "master@macbook", new Set(), new Date(Date.now() + 31 * 86_400_000)).ok, false);
  assert.equal(checkGrant(g, owner.publicKey, "master@macbook", new Set([g.id])).ok, false);
  const forged = makeGrant(mallory.publicKey, mallory.privateKey, "master@macbook", ["task.assign"], 30);
  assert.equal(checkGrant(forged, owner.publicKey, "master@macbook", new Set()).ok, false);
  assert.equal(checkGrant({ ...g, caps: ["task.assign", "everything"] }, owner.publicKey, "master@macbook", new Set()).ok, false);
});

test("oversized body and missing subject are rejected", () => {
  assert.throws(() => buildEnvelope({ from: "a@h", to: ["b@h"], subject: "", body: "x" }));
  assert.throws(() => buildEnvelope({ from: "a@h", to: ["b@h"], subject: "s", body: "x".repeat(300_000) }));
});
