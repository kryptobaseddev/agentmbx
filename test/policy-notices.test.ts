import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonical, generateKeyPair, signData } from "../src/crypto.ts";
import { MbxNode } from "../src/node.ts";
import { acceptSigned, delegationNote, makePolicy, makeRevocation, policyBrief } from "../src/policy.ts";

test("startup and wake notices preserve separate sender, project, class and expiry scopes", (t) => {
  const home = mkdtempSync(join(tmpdir(), "mbx-notice-")), owner = generateKeyPair();
  writeFileSync(join(home, "owner.json"), JSON.stringify({ backend: "keychain", public_key: owner.publicKey }), { mode: 0o600 });
  const n = new MbxNode(home, { host: "alpha" });
  t.after(() => { n.close(); rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
  const now = new Date(), common = { agents: ["reader"], hosts: ["alpha"], ownerPub: owner.publicKey, now };
  const read = makePolicy({ ...common, level: "autonomous", classes: ["read"], projects: ["/work/review"], ttlMs: 7200000 });
  const permission = makePolicy({ ...common, level: "yolo", classes: ["permissions"], from: ["beta"], fromAgents: ["builder"], projects: ["/work/build"], ttlMs: 60000 });
  const expired = makePolicy({ ...common, level: "yolo", now: new Date(now.getTime() - 120000), ttlMs: 60000, projects: ["/expired"] });
  for (const rec of [read, permission, expired]) assert.equal(acceptSigned(n.store.db, { rec, sig: signData(owner.privateKey, canonical(rec)) }, "alpha"), null);
  for (const render of [delegationNote, policyBrief]) {
    const text = render(n.store.db, "reader", "alpha")!;
    assert.match(text, /autonomous \[read\] for requests from any agent on this machine within \/work\/review/);
    assert.match(text, /YOLO \[permissions\] for requests from builder on beta within \/work\/build/);
    for (const rec of [read, permission]) { assert.ok(text.includes(rec.exp)); assert.ok(text.includes(rec.id.slice(-6))); }
    assert.doesNotMatch(text, /\[read, permissions\]|\/expired/);
    assert.match(text, /separate/);
    assert.match(text, /mbx_read/);
  }
  const revocation = makeRevocation(permission.id, owner.publicKey);
  assert.equal(acceptSigned(n.store.db, { rec: revocation, sig: signData(owner.privateKey, canonical(revocation)) }, "alpha"), null);
  for (const render of [delegationNote, policyBrief]) assert.doesNotMatch(render(n.store.db, "reader", "alpha")!, /YOLO|\/work\/build/);
  assert.equal(delegationNote(n.store.db, "other", "alpha"), null);
  assert.equal(policyBrief(n.store.db, "other", "alpha"), "");
});
