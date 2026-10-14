// T639 (owner decision D045): a non-expiring yolo policy is refused at creation (makePolicy is the
// single choke point for `policy set` and `policy renew`); read, collaborate and autonomous keep
// accepting --ttl never. Records stored before the rule are reported by doctor with the re-sign
// command and never revoked. Possession stays legal: checkRecord still accepts such records from
// paired hosts on older builds.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonical, fingerprint, generateKeyPair, signData } from "../src/crypto.ts";
import { MbxNode } from "../src/node.ts";
import { acceptSigned, makePolicy, makeRevocation, type AnyRecord, type PolicyRecord } from "../src/policy.ts";
import { nonExpiringYoloPolicies } from "../src/doctor.ts";

const H = 3_600_000;
const ownerKey = generateKeyPair();

function fixture(t: { after(fn: () => void): void }) {
  const home = mkdtempSync(join(tmpdir(), "mbx-t639-"));
  writeFileSync(join(home, "owner.json"), JSON.stringify({ backend: "keychain", public_key: ownerKey.publicKey }), { mode: 0o600 });
  const n = new MbxNode(home, { host: "alpha" });
  t.after(() => { n.close(); rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
  const accept = (rec: AnyRecord) => acceptSigned(n.store.db, { rec, sig: signData(ownerKey.privateKey, canonical(rec)) }, "alpha");
  return { n, accept };
}

const base = (level: PolicyRecord["level"], exp: string | null): PolicyRecord =>
  ({ v: 1, type: "policy", id: `ttl-${level}-${exp === null ? "never" : "finite"}-${Math.random().toString(36).slice(2, 8)}`,
    level, classes: level === "yolo" ? ["permissions"] : ["read"],
    to: { agents: ["trusted-worker"], hosts: ["alpha"] }, from: { hosts: ["local"], agents: ["*"] },
    iat: new Date().toISOString(), exp, owner_fp: fingerprint(ownerKey.publicKey) });

test("makePolicy refuses a non-expiring yolo policy (D045) with a clear message", () => {
  let err: Error | null = null;
  try { makePolicy({ level: "yolo", agents: ["w"], hosts: ["alpha"], ownerPub: ownerKey.publicKey, ttlMs: null }); }
  catch (e) { err = e as Error; }
  assert.ok(err, "yolo with ttlMs null must refuse");
  assert.match(err.message, /yolo policies must expire/);
  assert.match(err.message, /168 h/);
  assert.doesNotMatch(err.message, /or use --ttl never/, "the hint must not suggest the refused thing");
});

test("makePolicy: an over-max yolo error does not suggest --ttl never; other levels still accept never", () => {
  const grab = (fn: () => unknown): Error => { try { fn(); } catch (e) { return e as Error; } throw new Error("expected a refusal"); };
  const yoloErr = grab(() => makePolicy({ level: "yolo", agents: ["w"], hosts: ["alpha"], ownerPub: ownerKey.publicKey, ttlMs: 169 * H }));
  assert.match(yoloErr.message, /last at most 168 h/);
  assert.doesNotMatch(yoloErr.message, /never/);
  for (const level of ["ask", "collaborate", "autonomous"] as const) {
    const rec = makePolicy({ level, agents: ["w"], hosts: ["alpha"], ownerPub: ownerKey.publicKey, ttlMs: null });
    assert.equal(rec.exp, null, `${level} may still never expire`);
  }
  // an over-max non-yolo error keeps pointing at never as the escape hatch
  const askErr = grab(() => makePolicy({ level: "ask", agents: ["w"], hosts: ["alpha"], ownerPub: ownerKey.publicKey, ttlMs: 721 * H }));
  assert.match(askErr.message, /or use --ttl never/);
  // yolo without an explicit ttl keeps its finite default
  assert.notEqual(makePolicy({ level: "yolo", agents: ["w"], hosts: ["alpha"], ownerPub: ownerKey.publicKey }).exp, null);
});

test("checkRecord still accepts a stored non-expiring yolo (possession is legal); doctor reports it with the re-sign command", async t => {
  const { n, accept } = fixture(t);
  const rec = base("yolo", null);
  assert.equal(accept(rec), null, "acceptSigned stores it: D045 refuses creation, not possession");
  const [check] = nonExpiringYoloPolicies(n);
  assert.equal(check?.level, "warn");
  assert.match(check.label, new RegExp(`yolo policy ${rec.id.slice(-6)} never expires`));
  assert.match(check.label, /D045/);
  assert.match(check.label, /not revoked$/);
  assert.match(check.fix!, new RegExp(`agentmbx policy renew ${rec.id.slice(-6)} --ttl 168h`));
  assert.match(check.fix!, new RegExp(`agentmbx policy revoke ${rec.id.slice(-6)}`));
});

test("doctor stays silent for a never-expiring non-yolo record, a finite yolo, a revoked one and a non-current-owner one", async t => {
  const { n, accept } = fixture(t);
  const askNever = base("ask", null), yoloFinite = base("yolo", new Date(Date.now() + H).toISOString());
  assert.equal(accept(askNever), null);
  assert.equal(accept(yoloFinite), null);
  const yoloNever = base("yolo", null);
  assert.equal(accept(yoloNever), null);
  assert.equal(accept(makeRevocation(yoloNever.id, ownerKey.publicKey)), null);
  // a record this host keeps only as evidence (its owning principal is no longer the current owner)
  const evidence = base("yolo", null);
  assert.equal(accept(evidence), null);
  n.store.db.prepare("UPDATE principals SET role='peer-owner' WHERE role='owner'").run();
  assert.deepEqual(nonExpiringYoloPolicies(n), []);
});
