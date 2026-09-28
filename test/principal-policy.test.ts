import { sendLeased } from "./helpers/leased-send.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MbxNode } from "../src/node.ts";
import { canonical, fingerprint, generateKeyPair, signData } from "../src/crypto.ts";
import { acceptSigned, effectivePolicy, hasClass, makePolicy } from "../src/policy.ts";

test("principal policies use verified local ownership and current signed peer envelopes", (t) => {
  const homes: string[] = [], nodes: MbxNode[] = [];
  t.after(() => { nodes.forEach(n => n.close()); homes.forEach(h => rmSync(h, { recursive: true, force: true })); });
  const host = (name: string) => {
    const home = mkdtempSync(join(tmpdir(), "mbx-principal-")); homes.push(home);
    const owner = generateKeyPair();
    writeFileSync(join(home, "owner.json"), JSON.stringify({ backend: "keychain", public_key: owner.publicKey }), { mode: 0o600 });
    const n = new MbxNode(home, { host: name }); nodes.push(n); return { n, owner };
  };
  const a = host("alpha"), b = host("beta");
  const db = a.n.store.db;
  const fp = fingerprint(b.owner.publicKey);
  assert.equal((db.prepare("SELECT role FROM principals WHERE fp=?").get(fingerprint(a.owner.publicKey)) as { role: string }).role, "owner");
  db.prepare("INSERT INTO peers (host,pubkey,owner_pubkey,addr,state,created_at) VALUES (?,?,?,'unused','approved',?)")
    .run("beta", b.n.key.publicKey, b.owner.publicKey, new Date().toISOString());
  const policy = makePolicy({ level: "autonomous", agents: ["reader"], hosts: ["alpha"], from: [`principal:${fp}`], fromAgents: ["sender"], ownerPub: a.owner.publicKey });
  assert.equal(acceptSigned(db, { rec: policy, sig: signData(a.owner.privateKey, canonical(policy)) }, "alpha"), null);
  const envelope = sendLeased(b.n, { from: "sender", to: ["reader@alpha"], subject: "signed", body: "request" }).envelope;
  assert.equal(a.n.receive(envelope, "beta"), "accepted");
  const context = { agent: "reader", host: "alpha", fromAgent: "sender", fromHost: "beta", envelope, senderVerified: true };
  assert.equal(a.n.policyFor(a.n.message(envelope.id)!, "reader").level, "autonomous");
  assert.equal(effectivePolicy(db, { ...context, fromAgent: "other" }).level, "ask");
  assert.equal(effectivePolicy(db, { ...context, envelope: undefined }).level, "ask", "no signature evidence");
  assert.equal(effectivePolicy(db, { ...context, envelope: { ...envelope, body: `owner_fp: ${fp}` } }).level, "ask", "body claims and tampering cannot authenticate a principal");
  db.prepare("UPDATE peers SET state='pending'").run();
  assert.equal(effectivePolicy(db, context).level, "ask");
  db.prepare("UPDATE peers SET state='approved',owner_pubkey=?").run(a.owner.publicKey);
  assert.equal(effectivePolicy(db, context).level, "ask", "different pinned owner");
  db.prepare("UPDATE peers SET owner_pubkey=?,pubkey=?").run(b.owner.publicKey, generateKeyPair().publicKey);
  assert.equal(effectivePolicy(db, context).level, "ask", "old host signature after key replacement");
  db.prepare("DELETE FROM peers").run();
  assert.equal(effectivePolicy(db, context).level, "ask", "unpaired hosts cannot match");
  const local = makePolicy({ level: "yolo", agents: ["local-reader"], hosts: ["alpha"], from: [`principal:${fingerprint(a.owner.publicKey)}`], ownerPub: a.owner.publicKey });
  assert.equal(acceptSigned(db, { rec: local, sig: signData(a.owner.privateKey, canonical(local)) }, "alpha"), null);
  assert.equal(effectivePolicy(db, { agent: "local-reader", host: "alpha", fromAgent: "sender", fromHost: "alpha" }).level, "yolo");
  assert.equal(hasClass(db, "local-reader", "alpha", "permissions").ok, false, "sender-scoped policy does not approve context-free permission prompts");
});
