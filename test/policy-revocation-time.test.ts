import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MbxNode } from "../src/node.ts";
import { canonical, fingerprint, generateKeyPair, signData } from "../src/crypto.ts";
import { acceptSigned, activePolicies, makePolicy, makeRevocation, type AnyRecord } from "../src/policy.ts";
const instant = Date.parse("2030-01-01T09:00:00Z");
const stamp = (ms: number, offset: number) => new Date(ms + offset * 60000).toISOString().slice(0, -1)
  + (offset < 0 ? "-" : "+") + String(Math.floor(Math.abs(offset) / 60)).padStart(2, "0") + ":" + String(Math.abs(offset) % 60).padStart(2, "0");
function fixture(t: TestContext) {
  const home = mkdtempSync(join(tmpdir(), "mbx-revocation-time-")), owner = generateKeyPair();
  writeFileSync(join(home, "owner.json"), JSON.stringify({ backend: "keychain", public_key: owner.publicKey }), { mode: 0o600 });
  const n = new MbxNode(home, { host: "alpha" }), db = n.store.db;
  t.after(() => { n.close(); rmSync(home, { recursive: true, force: true }); });
  const policy = (delta = 0) => makePolicy({ level: "autonomous", agents: ["worker"], hosts: ["alpha"], ownerPub: owner.publicKey, now: new Date(instant + delta) });
  const accept = (rec: AnyRecord, signer = owner) => acceptSigned(db, { rec, sig: signData(signer.privateKey, canonical(rec)) }, "alpha");
  const active = () => activePolicies(db, "worker", "alpha", new Date(instant + 60000));
  return { db, owner, policy, accept, active };
}
for (const order of ["policy-first", "revocation-first"]) for (const delta of [-1, 0, 1])
  for (const pOffset of [-240, 0, 240]) for (const rOffset of [-420, 0, 330])
    test(`${order}: policy ${delta}ms, offsets ${pOffset}/${rOffset}`, t => {
      const { db, owner, policy, accept, active } = fixture(t);
      const p = policy(delta), r = makeRevocation("*", owner.publicKey, new Date(instant));
      p.iat = stamp(instant + delta, pOffset); r.iat = stamp(instant, rOffset);
      for (const rec of order === "policy-first" ? [p, r] : [r, p]) assert.equal(accept(rec), null);
      assert.equal(active().length, delta > 0 ? 1 : 0);
      assert.equal((db.prepare("SELECT record FROM policies WHERE id=?").get(p.id) as { record: string }).record, JSON.stringify(p));
      assert.equal((db.prepare("SELECT record FROM policy_revocations WHERE id=?").get(r.id) as { record: string }).record, JSON.stringify(r));
    });

test("malformed revocations reject before changing authority", t => {
  const { db, owner, policy, accept, active } = fixture(t); assert.equal(accept(policy()), null);
  for (const field of ["iat", "target", "id", "v", "all"]) {
    const r = makeRevocation("*", owner.publicKey, new Date(instant));
    (r as any)[field] = field === "iat" ? "not a date" : field === "v" ? 2 : field === "all" ? false : null;
    assert.notEqual(accept(r), null, field); assert.equal(active().length, 1);
  }
  const r = makeRevocation("*", owner.publicKey, new Date(instant)); (r as any).iat = 2030;
  assert.notEqual(accept(r), null);
  assert.equal((db.prepare("SELECT count(*) n FROM policy_revocations").get() as { n: number }).n, 0);
});

test("failed revocation storage rolls back policy flags and audit", t => {
  const { db, owner, policy, accept, active } = fixture(t); assert.equal(accept(policy()), null);
  const audit = db.prepare("SELECT * FROM audit").all();
  db.exec("CREATE TEMP TRIGGER fail_revoke BEFORE INSERT ON policy_revocations BEGIN SELECT RAISE(ABORT, 'fixture failure'); END");
  assert.throws(() => accept(makeRevocation("*", owner.publicKey, new Date(instant))), /fixture failure/);
  assert.equal(active().length, 1); assert.deepEqual(db.prepare("SELECT * FROM audit").all(), audit);
  assert.equal((db.prepare("SELECT count(*) n FROM policy_revocations").get() as { n: number }).n, 0);
});

test("explicit targets retain semantics and writes respect caller transactions", t => {
  const { db, owner, policy, accept, active } = fixture(t); const p = policy(1);
  const r = makeRevocation(p.id, owner.publicKey, new Date(instant));
  assert.equal(accept(p), null);
  db.exec("BEGIN"); assert.equal(accept(r), null); assert.equal(active().length, 0); db.exec("ROLLBACK");
  assert.equal(active().length, 1); assert.equal(accept(r), null); assert.equal(active().length, 0);
});

test("another known signer cannot revoke this owner's policy", t => {
  const { db, policy, accept, active } = fixture(t); const p = policy(); assert.equal(accept(p), null);
  const other = generateKeyPair();
  db.prepare("INSERT INTO principals (fp,pub,role,via,added_at) VALUES (?,?,'peer-owner','test',?)")
    .run(fingerprint(other.publicKey), other.publicKey, new Date().toISOString());
  for (const target of ["*", p.id]) assert.equal(accept(makeRevocation(target, other.publicKey, new Date(instant)), other), null);
  assert.equal(active().length, 1);
});

test("retained signed revocations override flags missed by older versions without rewriting evidence", t => {
  const { db, owner, policy, accept, active } = fixture(t);
  const p = policy(-1); p.iat = stamp(instant - 1, 240);
  const r = makeRevocation("*", owner.publicKey, new Date(instant));
  assert.equal(accept(p), null); assert.equal(accept(r), null);
  db.prepare("UPDATE policies SET revoked=0 WHERE id=?").run(p.id); // Historical lexical comparison missed this row.
  const before = db.prepare("SELECT * FROM policies").all();
  const ledger = db.prepare("SELECT * FROM policy_revocations").all();
  assert.equal(active().length, 0);
  assert.deepEqual(db.prepare("SELECT * FROM policies").all(), before);
  assert.deepEqual(db.prepare("SELECT * FROM policy_revocations").all(), ledger);
});

test("historical reconciliation uses signed revocation content and isolates corrupt records", t => {
  const { db, owner, policy, accept, active } = fixture(t);
  const p = policy(1), r = makeRevocation("*", owner.publicKey, new Date(instant));
  assert.equal(accept(p), null); assert.equal(accept(r), null);
  db.prepare("UPDATE policy_revocations SET iat=?,target=? WHERE id=?").run(stamp(instant + 2, 0), p.id, r.id);
  assert.equal(active().length, 1, "unsigned cache fields cannot broaden revocation");
  const original = db.prepare("SELECT record,sig FROM policy_revocations WHERE id=?").get(r.id) as { record: string; sig: string };
  for (const record of ["{", "null", JSON.stringify({ ...r, iat: stamp(instant + 2, 0) })]) {
    db.prepare("UPDATE policy_revocations SET record=? WHERE id=?").run(record, r.id);
    assert.equal(active().length, 1);
  }
  db.prepare("UPDATE policy_revocations SET record=?,sig=? WHERE id=?").run(original.record, "invalid", r.id);
  assert.equal(active().length, 1);
  const targeted = makeRevocation(p.id, owner.publicKey, new Date(instant - 1));
  assert.equal(accept(targeted), null);
  db.prepare("UPDATE policies SET revoked=0 WHERE id=?").run(p.id);
  assert.equal(active().length, 0, "explicit signed target overrides chronology even beside corrupt records");
});
