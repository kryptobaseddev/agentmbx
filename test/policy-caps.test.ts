import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { canonical, generateKeyPair, signData } from "../src/crypto.ts";
import { MbxNode } from "../src/node.ts";
import { Store, withStoreBusyTimeout } from "../src/store.ts";
import { signedRecords } from "../src/http.ts";
import { loadSyncSnapshot } from "../src/sync-daemon.ts";
import { acceptSigned, activePolicies, delegationNote, dueReminders, effectivePolicy, hasClass, LEVEL_MAX_HOP,
  makePolicy, makeRevocation, parsePolicyTtl, parseTtl, policyLine, storedPolicies, type PolicyRecord } from "../src/policy.ts";
import { dispatchWakes, hasWakeAuthority } from "../src/wake.ts";
import { bindWakeLease } from "./helpers/wake-lease.ts";
import { sendLeased } from "./helpers/leased-send.ts";

process.env.MBX_NO_DESKTOP = "1";

function fixture(t: TestContext) {
  const home = mkdtempSync(join(tmpdir(), "mbx-caps-")), owner = generateKeyPair();
  writeFileSync(join(home, "owner.json"), JSON.stringify({ backend: "keychain", public_key: owner.publicKey }), { mode: 0o600 });
  const n = new MbxNode(home, { host: "alpha" });
  t.after(() => { n.close(); rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
  const make = (extra: Partial<Parameters<typeof makePolicy>[0]> = {}) => makePolicy({ level: "collaborate", agents: ["worker"], hosts: ["alpha"], ownerPub: owner.publicKey, ...extra });
  const accept = (rec: PolicyRecord) => acceptSigned(n.store.db, { rec, sig: signData(owner.privateKey, canonical(rec)) }, n.host);
  return { n, owner, make, accept };
}

test("never policies keep signed null expiry, per-grant scope and revocation through all readers", t => {
  const { n, owner, make, accept } = fixture(t), db = n.store.db;
  const forever = make({ ttlMs: parsePolicyTtl("never"), classes: ["read"], projects: ["/review"] });
  const finite = make({ classes: ["edit"], projects: ["/build"], ttlMs: 3600000 });
  assert.equal(forever.exp, null); assert.equal(accept(forever), null); assert.equal(accept(finite), null);
  assert.throws(() => parseTtl("never"), /bad ttl/, "non-policy durations still require numbers");
  assert.equal(parsePolicyTtl("30m"), 1800000);
  assert.deepEqual(activePolicies(db, "worker", "alpha", new Date("2099-01-01")).map(p => p.id), [forever.id]);
  const effective = effectivePolicy(db, { agent: "worker", host: "alpha", fromAgent: "builder", fromHost: "alpha" });
  assert.deepEqual(effective.grants.map(g => [g.classes, g.projects, g.exp]), [[["read"], ["/review"], null], [["edit"], ["/build"], finite.exp]]);
  assert.equal(effective.exp, finite.exp, "summary expiry remains the earliest finite expiry; individual grants retain null");
  assert.match(policyLine(effective), /never expires/); assert.match(delegationNote(db, "worker", "alpha")!, /with no expiry/);
  assert.deepEqual(dueReminders(db).map(p => p.id), [finite.id]);
  assert.ok(signedRecords(n).some(p => p.rec.id === forever.id));
  const sync = loadSyncSnapshot(n, { contractAllowsProjectPaths: false });
  assert.equal(sync.policies.find(p => p.policy_id === forever.id)!.expires_at, null);
  assert.equal(sync.policies.find(p => p.policy_id === forever.id)!.state, "active");
  const before = db.prepare("SELECT record,sig FROM policies WHERE id=?").get(forever.id);
  db.prepare("UPDATE policies SET exp=? WHERE id=?").run(finite.exp, forever.id);
  assert.ok(storedPolicies(db).invalid.some(p => p.id === forever.id), "cached finite expiry cannot replace signed null");
  db.prepare("UPDATE policies SET exp=NULL WHERE id=?").run(forever.id);
  assert.deepEqual(db.prepare("SELECT record,sig FROM policies WHERE id=?").get(forever.id), before);
  assert.equal(acceptSigned(db, { rec: makeRevocation(forever.id, owner.publicKey), sig: "invalid" }, "alpha"), "bad owner signature");
  const revoke = makeRevocation(forever.id, owner.publicKey);
  assert.equal(acceptSigned(db, { rec: revoke, sig: signData(owner.privateKey, canonical(revoke)) }, "alpha"), null);
  assert.equal(activePolicies(db, "worker", "alpha", new Date("2099-01-01")).length, 0);
});

test("missing/malformed expiry or issue date never becomes a forever grant", t => {
  const { make, accept } = fixture(t);
  for (const exp of [undefined, false, 0, "never", "", {}]) {
    const bad = { ...make({ ttlMs: null }), exp } as unknown as PolicyRecord;
    assert.equal(accept(bad), "bad lifetime");
  }
  assert.equal(accept({ ...make({ ttlMs: null }), iat: "invalid" }), "bad lifetime");
});

test("long-offline peers receive old signed kill switches and targeted revocations for permanent policies", t => {
  const { n, owner, make, accept } = fixture(t);
  const policy = make({ ttlMs: null, now: new Date(Date.now() - 90 * 86400000), hosts: ["*"] });
  assert.equal(accept(policy), null);
  for (const target of [policy.id, "*"]) {
    const rec = makeRevocation(target, owner.publicKey, new Date(Date.now() - 60 * 86400000));
    assert.equal(acceptSigned(n.store.db, { rec, sig: signData(owner.privateKey, canonical(rec)) }, "alpha"), null);
  }
  const items = signedRecords(n);
  assert.equal(items.filter(p => p.rec.type === "revocation").length, 2);
  const other = new Store(join(n.home, "offline-peer"));
  try {
    other.db.prepare("INSERT INTO principals (fp,pub,role,via,added_at) VALUES (?,?, 'owner','fixture',?)").run(policy.owner_fp, owner.publicKey, policy.iat);
    for (const item of items) assert.equal(acceptSigned(other.db, item, "beta"), null);
    assert.equal(activePolicies(other.db, "worker", "beta").length, 0, "the returned permanent record remains revoked");
  } finally { other.close(); }
});

test("legacy NOT NULL expiry migration preserves all evidence and current reopen does not acquire a writer", t => {
  const { n, make, accept } = fixture(t), db = n.store.db;
  assert.equal(accept(make()), null);
  const invalid = make(); assert.equal(accept(invalid), null);
  db.prepare("UPDATE policies SET record='{',revoked=1 WHERE id=?").run(invalid.id);
  const before = db.prepare("SELECT * FROM policies ORDER BY id").all();
  db.exec(`CREATE TABLE policies_legacy (
    id TEXT PRIMARY KEY,record TEXT NOT NULL,sig TEXT NOT NULL,owner_fp TEXT NOT NULL,iat TEXT NOT NULL,exp TEXT NOT NULL,
    revoked INTEGER NOT NULL DEFAULT 0,received_at TEXT NOT NULL);
    INSERT INTO policies_legacy SELECT * FROM policies; DROP TABLE policies; ALTER TABLE policies_legacy RENAME TO policies;`);
  // Even a surviving current fingerprint cannot disguise the legacy constraint.
  const migrated = new Store(n.home);
  assert.deepEqual(migrated.db.prepare("SELECT * FROM policies ORDER BY id").all(), before);
  assert.equal(migrated.db.prepare("PRAGMA table_info(policies)").all().find(r => r.name === "exp")!.notnull, 0);
  assert.equal(accept(make({ ttlMs: null })), null);
  migrated.db.exec("BEGIN IMMEDIATE");
  try { const current = withStoreBusyTimeout(0, () => new Store(n.home)); current.close(); }
  finally { migrated.db.exec("ROLLBACK"); migrated.close(); }
});

for (const level of ["collaborate", "autonomous"] as const) test(`${level}: 500-hop mail stays actionable and reaches the recipient wake adapter after 500 actions`, async t => {
  const home = mkdtempSync(join(tmpdir(), "mbx-deep-wake-")), n = new MbxNode(home, { host: "alpha" });
  t.after(() => { n.close(); rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
  const wakeLog = join(home, "wake.log"), wakeBin = join(home, "test-codex.mjs"), oldBin = process.env.MBX_CODEX_BIN;
  writeFileSync(wakeBin, `#!${process.execPath}\nimport {writeFileSync} from 'node:fs'; writeFileSync(${JSON.stringify(wakeLog)}, process.argv.join(' '));\n`, { mode: 0o700 });
  process.env.MBX_CODEX_BIN = wakeBin;
  t.after(() => { if (oldBin === undefined) delete process.env.MBX_CODEX_BIN; else process.env.MBX_CODEX_BIN = oldBin; });
  bindWakeLease(n, { agent: "worker", cli: "codex", session_id: "deep-worker", pid: process.pid });
  if (level === "collaborate") {
    n.store.db.prepare("UPDATE policies SET revoked=1").run();
    const { delegateWake } = await import("./helpers/wake-lease.ts"); delegateWake(n, "worker", level);
  }
  const row = n.message(sendLeased(n, { from: "builder", to: ["worker"], subject: "deep work", body: "data", kind: "request", hop: 500 }).envelope.id)!;
  for (let i = 0; i < 500; i++) n.store.audit("peer_action", { thread: row.thread });
  assert.equal(n.policyFor(row, "worker").level, level); assert.deepEqual(n.policyFor(row, "worker").classes, ["read", "edit", "outward-reversible"]);
  assert.equal(hasWakeAuthority(n, "worker", row), true); assert.equal(n.depthSuppressed("worker").length, 0);
  const result = await dispatchWakes(n);
  assert.ok(readFileSync(wakeLog, "utf8").includes(row.id)); assert.equal(result[0].result.ok, true); assert.equal(n.unreadCount("worker"), 1);
});

test("depth diagnostics only report a real effective downgrade; mixed grants and ask bookkeeping cannot create suppression", t => {
  const { n, make, accept } = fixture(t);
  assert.equal(accept(make()), null); assert.equal(accept(make({ level: "autonomous" })), null);
  const row = n.message(sendLeased(n, { from: "builder", to: ["worker"], subject: "mixed", body: "data", hop: 500 }).envelope.id)!;
  // Reproduce the historical finite collaborate allowance without restoring any production cap.
  t.mock.property(LEVEL_MAX_HOP, "collaborate", 20);
  const mixed = n.policyFor(row, "worker");
  assert.ok(mixed.notes.some(n => n.includes("exceeds 20"))); assert.equal(mixed.level, "autonomous");
  assert.equal(n.depthSuppressed("worker").length, 0);
  n.store.db.prepare("UPDATE policies SET revoked=1 WHERE json_extract(record,'$.level')='autonomous'").run();
  assert.equal(n.depthSuppressed("worker").length, 1, "only losing the last acting grant reports suppression");
  n.store.db.prepare("UPDATE policies SET revoked=1").run(); assert.equal(accept(make({ level: "ask" })), null);
  assert.equal(n.depthSuppressed("worker").length, 0, "ask already could not act before depth bookkeeping");
});

test("policy CLI signs --ttl never, lists/status display it and renewal preserves or explicitly replaces it", t => {
  const { n, owner } = fixture(t), helper = join(n.home, "test-auth.mjs");
  writeFileSync(helper, `#!${process.execPath}\nimport {readFileSync} from 'node:fs'; import {signData} from ${JSON.stringify(resolve("src/crypto.ts"))};
    const [cmd,file]=process.argv.slice(2); if(cmd==='pubkey') console.log(${JSON.stringify(owner.publicKey)});
    else if(cmd==='sign') console.log(signData(${JSON.stringify(owner.privateKey)},readFileSync(file))); else if(cmd==='check') console.log('ok'); else process.exit(2);\n`, { mode: 0o700 });
  chmodSync(helper, 0o700);
  const cli = (...args: string[]) => {
    const result = spawnSync(process.execPath, ["bin/agentmbx.js", ...args], { encoding: "utf8", timeout: 20000,
      env: { ...process.env, MBX_HOME: n.home, AGENTMBX_DEV: "1", MBX_AUTH_HELPER: helper, MBX_NO_DESKTOP: "1", MBX_NO_UPDATE_CHECK: "1" } });
    assert.equal(result.status, 0, result.stderr); return result.stdout;
  };
  assert.match(cli("policy", "set", "worker", "yolo", "--ttl", "never"), /never expires/);
  let rows = JSON.parse(cli("policy", "list", "--json")) as PolicyRecord[];
  assert.equal(rows.length, 1); assert.equal(rows[0].exp, null);
  assert.match(cli("policy", "list"), /never expires/); assert.match(cli("status"), /never expires/);
  assert.equal(hasClass(n.store.db, "worker", "alpha", "permissions", {}, new Date("2099-01-01")).exp, null);
  assert.match(cli("policy", "renew", rows[0].id), /never expires/);
  rows = JSON.parse(cli("policy", "list", "--json")); assert.equal(rows.length, 1); assert.equal(rows[0].exp, null);
  cli("policy", "renew", rows[0].id, "--ttl", "1h");
  rows = JSON.parse(cli("policy", "list", "--json")); assert.equal(typeof rows[0].exp, "string");
});
