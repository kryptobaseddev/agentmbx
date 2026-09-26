import { test } from "node:test";
import assert from "node:assert/strict";
import { canonical, fingerprint, generateKeyPair, ulid } from "../src/crypto.ts";
import { buildEnvelope, checkShape, parseMeta, signEnvelope, verifyEnvelope } from "../src/envelope.ts";

test("canonical JSON sorts keys and drops undefined", () => {
  assert.equal(canonical({ b: 1, a: [1, { d: 2, c: undefined }], z: null }), '{"a":[1,{"d":2}],"b":1,"z":null}');
});

test("ulid is 26 chars and sortable within a millisecond", () => {
  const ids = Array.from({ length: 50 }, () => ulid(1_700_000_000_000));
  assert.ok(ids.every((i) => i.length === 26));
  assert.deepEqual([...ids].sort(), ids);
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

test("oversized body and missing subject are rejected", () => {
  assert.throws(() => buildEnvelope({ from: "a@h", to: ["b@h"], subject: "", body: "x" }));
  assert.throws(() => buildEnvelope({ from: "a@h", to: ["b@h"], subject: "s", body: "x".repeat(300_000) }));
});
