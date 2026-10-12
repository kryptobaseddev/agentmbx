import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { canonical, generateKeyPair, signData, ulid } from "../src/crypto.ts";
import { MbxNode } from "../src/node.ts";
import { createOwnerKey, unlockOwnerKey } from "../src/owner.ts";
import { activeLead, activeLeads, leadFor, leadHistory, makeLead, makeLeadRevocation, revokeLead, storeLead } from "../src/lead-record.ts";

function world(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "mbx-lead-record-"));
  const node = new MbxNode(join(root, "home"), { host: "alpha", bind: "127.0.0.1", port: 0 });
  createOwnerKey(node.home, "test-only-passphrase"); node.syncOwner();
  const owner = unlockOwnerKey(node.home, "test-only-passphrase");
  mkdirSync(join(root, "project"));
  const project = realpathSync(join(root, "project")), now = new Date();
  t.after(() => { node.close(); rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); });
  const sign = (value: unknown) => signData(owner.privateKey, canonical(value));
  const lead = (agent: string, at: Date, ttlMs = 86_400_000) => {
    const rec = makeLead({ project, agent, host: node.host, ownerPub: owner.publicKey, now: at, ttlMs });
    return storeLead(node, rec, sign(rec));
  };
  return { node, project, owner, now, sign, lead };
}

const show = (w: ReturnType<typeof world>, project = true) => spawnSync(process.execPath, [
  join(process.cwd(), "bin/agentmbx.js"), "lead", "show", ...(project ? ["--project", w.project] : []),
], { encoding: "utf8", timeout: 20_000,
  env: { ...process.env, AGENTMBX_DEV: "1", MBX_HOME: w.node.home, MBX_NO_DESKTOP: "1", MBX_NO_UPDATE_CHECK: "1" },
});

test("T562: revoking a replacement never restores the earlier independently valid lead", t => {
  const w = world(t);
  const earlier = w.lead("former-lead", new Date(w.now.getTime() - 1000));
  const replacement = w.lead("replacement-lead", w.now);
  assert.equal(activeLead(w.node, w.project, w.now)?.id, replacement.id);
  const rev = makeLeadRevocation(replacement.id, w.owner.publicKey, w.now);
  revokeLead(w.node, rev, w.sign(rev));
  assert.equal(activeLead(w.node, w.project, w.now), null, `must not resurrect ${earlier.id}`);
  const restored = w.lead(earlier.agent, new Date(w.now.getTime() + 1000));
  assert.equal(activeLead(w.node, w.project, new Date(w.now.getTime() + 1000))?.id, restored.id, "restoration requires a fresh signed record");
});

test("T562: expiry of a replacement never restores a longer-lived earlier lead", t => {
  const w = world(t);
  const earlier = w.lead("former-lead", new Date(w.now.getTime() - 1000));
  const replacement = w.lead("replacement-lead", w.now, 1000);
  assert.equal(activeLead(w.node, w.project, w.now)?.id, replacement.id);
  assert.equal(activeLead(w.node, w.project, new Date(w.now.getTime() + 1000)), null, `must not resurrect ${earlier.id} at the expiry boundary`);
  const restored = w.lead(earlier.agent, new Date(w.now.getTime() + 2000));
  assert.equal(activeLead(w.node, w.project, new Date(w.now.getTime() + 2000))?.id, restored.id);
});

test("T562: lead show identifies the revoked head and its still-valid shadowed predecessor", t => {
  const w = world(t);
  const earlier = w.lead("former-lead", new Date(w.now.getTime() - 1000));
  const replacement = w.lead("replacement-lead", w.now);
  const rev = makeLeadRevocation(replacement.id, w.owner.publicKey, w.now);
  revokeLead(w.node, rev, w.sign(rev));
  const result = show(w);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, new RegExp(`head ${replacement.id}.*revoked`));
  assert.match(result.stdout, new RegExp(`shadowed ${earlier.id}.*former-lead`));
  assert.doesNotMatch(result.stdout, /former-lead@alpha until/);
  assert.ok(!result.stdout.includes(w.sign(replacement)), "show must not print signatures");
});

test("T562: malformed records and forged revocations never shadow valid authority", t => {
  const w = world(t), rec = w.lead("valid-lead", w.now);
  const fake = makeLeadRevocation(rec.id, w.owner.publicKey, w.now);
  w.node.store.db.prepare("UPDATE project_leads SET revocation=?,revocation_sig=? WHERE id=?").run(JSON.stringify(fake), signData(generateKeyPair().privateKey, canonical(fake)), rec.id);
  const invalidId = ulid(w.now.getTime() + 1000);
  w.node.store.db.prepare("INSERT INTO project_leads(id,project,agent,record,sig,received_at) VALUES (?,?,?,?,?,?)").run(invalidId, w.project, "invalid", "{bad", "bad", w.now.toISOString());
  assert.equal(activeLead(w.node, w.project, w.now)?.id, rec.id);
  assert.equal(leadHistory(w.node, w.project, undefined, w.now).active?.id, rec.id);
  assert.equal(leadHistory(w.node, w.project, undefined, w.now).records[0].state, "invalid");
  w.node.store.db.prepare("UPDATE project_leads SET revocation=? WHERE id=?").run("{bad", rec.id);
  assert.equal(activeLead(w.node, w.project, w.now)?.id, rec.id, "malformed revocation takes nothing away");
});

test("T562: bounded history reports unknown rather than no lead outside its window", t => {
  const w = world(t), rec = w.lead("valid-lead", w.now);
  for (let i = 1; i <= 21; i++) w.node.store.db.prepare("INSERT INTO project_leads(id,project,agent,record,sig,received_at) VALUES (?,?,?,?,?,?)")
    .run(ulid(w.now.getTime() + i), w.project, "invalid", "{bad", "bad", w.now.toISOString());
  const view = leadHistory(w.node, w.project, undefined, w.now);
  assert.equal(view.records.length, 20); assert.equal(view.truncated, true);
  assert.equal(view.state, "unknown"); assert.equal(view.head, null); assert.equal(view.active, null);
  assert.equal(activeLead(w.node, w.project, w.now)?.id, rec.id, "runtime selection streams beyond diagnostic coverage");
  assert.throws(() => leadHistory(w.node, w.project, undefined, w.now, 21), /between 1 and 20/);
  const result = show(w);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /unknown \(head outside diagnostic coverage\)/);
  assert.match(result.stdout, /history truncated \(20 records\)/);
  assert.equal(result.stdout.split("\n").filter(line => line.startsWith("  invalid ")).length, 20);
  assert.doesNotMatch(result.stdout, /none \(|valid-lead@alpha until/);
});

test("T562: oversized history is unverified, not a false invalid or active head", t => {
  const w = world(t); w.lead("valid-lead", w.now);
  const id = ulid(w.now.getTime() + 1000);
  w.node.store.db.prepare("INSERT INTO project_leads(id,project,agent,record,sig,received_at) VALUES (?,?,?,?,?,?)")
    .run(id, w.project, "unverified", " ".repeat(9000) + "{}", "bad", w.now.toISOString());
  const view = leadHistory(w.node, w.project, undefined, w.now);
  assert.equal(view.state, "unknown"); assert.equal(view.active, null);
  assert.equal(view.records[0].reason, "oversized"); assert.equal(view.records[0].record, null);
});

test("T562: the same CLEO project key keeps a revoked head across checkouts", t => {
  const w = world(t), key = "071b70b3-551d-44bb-b993-1e84bfa2fe09";
  for (const folder of [w.project, join(w.node.home, "checkout")]) {
    mkdirSync(join(folder, ".cleo"), { recursive: true }); writeFileSync(join(folder, ".cleo/project-id"), key + "\n");
  }
  w.lead("former-lead", new Date(w.now.getTime() - 1000));
  const head = w.lead("replacement-lead", w.now);
  const rev = makeLeadRevocation(head.id, w.owner.publicKey, w.now); revokeLead(w.node, rev, w.sign(rev));
  assert.equal(leadFor(w.node, join(w.node.home, "checkout"), key, w.now), null);
  assert.equal(leadHistory(w.node, join(w.node.home, "checkout"), key, w.now).head?.id, head.id);
  assert.deepEqual(activeLeads(w.node, w.now), []);
});

test("T562: lead show caps projects and sanitizes malformed metadata without exposing records", t => {
  const w = world(t);
  for (let i = 0; i < 51; i++) w.node.store.db.prepare("INSERT INTO project_leads(id,project,agent,record,sig,received_at) VALUES (?,?,?,?,?,?)")
    .run(`invalid-record-${i}`, `/synthetic/${String(i).padStart(2, "0")}\u001b`, "invalid", '{"private":"DO-NOT-DISPLAY"}', "bad", w.now.toISOString());
  const result = show(w, false);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.split("\n").filter(line => line.startsWith("/synthetic/")).length, 50);
  assert.match(result.stdout, /project list truncated \(50 projects\)/);
  assert.doesNotMatch(result.stdout, /DO-NOT-DISPLAY|\u001b/);
});
