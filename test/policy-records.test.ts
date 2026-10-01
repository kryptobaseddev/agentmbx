import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { canonical, generateKeyPair, signData } from "../src/crypto.ts";
import { MbxNode } from "../src/node.ts";
import { acceptSigned, activePolicies, dueReminders, hasClass, makePolicy, type PolicyRecord } from "../src/policy.ts";
import { signedRecords } from "../src/http.ts";

function fixture(t: { after(fn: () => void): void }) {
  const home = mkdtempSync(join(tmpdir(), "mbx-policy-record-")), owner = generateKeyPair();
  writeFileSync(join(home, "owner.json"), JSON.stringify({ backend: "keychain", public_key: owner.publicKey }), { mode: 0o600 });
  const n = new MbxNode(home, { host: "alpha" }), db = n.store.db;
  t.after(() => { n.close(); rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
  const make = () => makePolicy({ level: "yolo", agents: ["trusted-worker"], hosts: ["alpha"], ownerPub: owner.publicKey, ttlMs: 3600000 });
  const accept = (rec: PolicyRecord) => acceptSigned(db, { rec, sig: signData(owner.privateKey, canonical(rec)) }, "alpha");
  return { n, db, make, accept, owner };
}

test("signed policy selectors must be arrays of nonempty strings", t => {
  const { db, make, accept } = fixture(t);
  for (const key of ["agents", "hosts"] as const) for (const side of ["to", "from"] as const) {
    for (const value of ["trusted-worker", [], [null], [1], [""], ["  "]]) {
      const rec = make(); (rec[side] as any)[key] = value;
      assert.notEqual(accept(rec), null, `${side}.${key}: ${JSON.stringify(value)}`);
    }
  }
  for (const value of ["/work", [null], [""], ["  "]]) {
    const rec = make(); (rec as any).projects = value; assert.notEqual(accept(rec), null);
  }
  const rec = make(); (rec as any).iat = 2026; assert.notEqual(accept(rec), null);
  assert.equal((db.prepare("SELECT count(*) n FROM policies").get() as any).n, 0);
});

test("retained invalid policies fail closed without poisoning valid neighbors or rewriting evidence", t => {
  const { n, db, make, accept } = fixture(t);
  const good = make(); assert.equal(accept(good), null);
  const mutations = [
    (id: string) => db.prepare("UPDATE policies SET record='{' WHERE id=?").run(id),
    (id: string) => db.prepare("UPDATE policies SET record=json_set(record,'$.to.agents','trusted-worker') WHERE id=?").run(id),
    (id: string) => db.prepare("UPDATE policies SET record=json_set(record,'$.to.agents',json('[\"worker\"]')) WHERE id=?").run(id),
    (id: string) => db.prepare("UPDATE policies SET sig='invalid' WHERE id=?").run(id),
    (id: string) => db.prepare("UPDATE policies SET exp='2099-01-01T00:00:00.000Z' WHERE id=?").run(id),
  ];
  for (const mutate of mutations) { const bad = make(); assert.equal(accept(bad), null); mutate(bad.id); }
  const before = db.prepare("SELECT * FROM policies ORDER BY id").all();
  assert.deepEqual(activePolicies(db, "trusted-worker", "alpha").map(p => p.id), [good.id]);
  assert.equal(hasClass(db, "worker", "alpha", "permissions").ok, false);
  assert.deepEqual(signedRecords(n).map(p => p.rec.id), [good.id]);
  assert.deepEqual(dueReminders(db).map(p => p.id), [good.id]);
  assert.deepEqual(db.prepare("SELECT * FROM policies ORDER BY id").all(), before);
  db.prepare("UPDATE principals SET role='peer-owner' WHERE role='owner'").run();
  assert.deepEqual(activePolicies(db, "trusted-worker", "alpha"), []);
});


test("expiry, exact selectors, current signatures and revocation retain their boundaries", t => {
  const { db, make, accept, owner } = fixture(t);
  const good = make(); good.projects = []; assert.equal(accept(good), null);
  assert.equal(activePolicies(db, "worker", "alpha").length, 0);
  assert.equal(activePolicies(db, "trusted-worker", "alp").length, 0);
  assert.equal(activePolicies(db, "trusted-worker", "alpha", new Date(good.exp)).length, 0);
  assert.equal(activePolicies(db, "trusted-worker", "alpha", new Date(Date.parse(good.exp) - 1)).length, 1);
  db.prepare("UPDATE policies SET revoked=1 WHERE id=?").run(good.id);
  assert.equal(hasClass(db, "trusted-worker", "alpha", "permissions").ok, false);
  const invalid = make(); (invalid.to as any).agents = "trusted-worker";
  db.prepare("INSERT INTO policies (id,record,sig,owner_fp,iat,exp,received_at) VALUES (?,?,?,?,?,?,?)")
    .run(invalid.id, JSON.stringify(invalid), signData(owner.privateKey, canonical(invalid)), invalid.owner_fp, invalid.iat, invalid.exp, invalid.iat);
  assert.deepEqual(activePolicies(db, "worker", "alpha"), []);
  assert.deepEqual(dueReminders(db), []);
  assert.equal((db.prepare("SELECT count(*) n FROM kv WHERE k LIKE 'reminded:%'").get() as any).n, 0);
});

test("policy CLI reports invalid records and refuses to renew them before signing", t => {
  const { n, db, make, accept } = fixture(t);
  const good = make(), bad = make();
  assert.equal(accept(good), null); assert.equal(accept(bad), null);
  db.prepare("UPDATE policies SET record='{' WHERE id=?").run(bad.id);
  const cli = (...args: string[]) => spawnSync(process.execPath, ["bin/agentmbx.js", ...args], {
    env: { ...process.env, MBX_HOME: n.home, AGENTMBX_DEV: "1" }, encoding: "utf8", timeout: 10000,
  });
  const listed = cli("policy", "list", "--json");
  assert.equal(listed.status, 0, listed.stderr);
  assert.deepEqual(JSON.parse(listed.stdout).map((p: PolicyRecord) => p.id), [good.id]);
  assert.match(listed.stderr, /invalid stored policy/);
  const status = cli("status"); assert.equal(status.status, 0, status.stderr);
  assert.match(status.stderr, /invalid stored policies ignored/);
  const renew = cli("policy", "renew", bad.id);
  assert.equal(renew.status, 2, renew.stderr); assert.match(renew.stderr, /expected one valid owner policy/);
});

test("makePolicy rejects malformed inputs before normalization", t => {
  const { owner } = fixture(t);
  const base = { level: "autonomous" as const, agents: ["worker"], hosts: ["alpha"], ownerPub: owner.publicKey };
  for (const field of ["agents", "hosts", "from", "fromAgents", "projects", "classes"]) {
    assert.throws(() => makePolicy({ ...base, [field]: "worker" } as any));
  }
});
