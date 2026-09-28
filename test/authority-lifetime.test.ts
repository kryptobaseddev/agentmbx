import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateKeyPair } from "../src/crypto.ts";
import { makeGrant } from "../src/envelope.ts";
import { MbxNode, formatFor } from "../src/node.ts";
import { hasWakeAuthority, wakeText } from "../src/wake.ts";

for (const change of ["revoke", "expire", "owner-key", "host-key", "unpair"] as const) test(`owner authority is recomputed after ${change}`, t => {
  const homes = [mkdtempSync(join(tmpdir(), "mbx-authority-a-")), mkdtempSync(join(tmpdir(), "mbx-authority-b-"))];
  const owner = generateKeyPair(), session = generateKeyPair();
  writeFileSync(join(homes[0], "owner.json"), JSON.stringify({ backend: "keychain", public_key: owner.publicKey }), { mode: 0o600 });
  const a = new MbxNode(homes[0], { host: "alpha" }), b = new MbxNode(homes[1], { host: "beta" });
  t.after(() => { a.close(); b.close(); homes.forEach(h => rmSync(h, { recursive: true, force: true })); });
  b.addApprovedPeer({ host: "alpha", pubkey: a.key.publicKey, owner_pubkey: owner.publicKey, addr: "unused" }, "fixture");
  const grant = makeGrant(owner.publicKey, owner.privateKey, session.publicKey, "master", "alpha", ["task.assign"], 1);
  const e = a.send({ from: "master", to: ["worker", "worker@beta"], subject: "authorized task", body: "payload", kind: "task" },
    { pub: session.publicKey, priv: session.privateKey, grant }).envelope;
  assert.equal(b.receive(e, "alpha"), "accepted");
  const cached = b.read(e.id, "worker"), stored = b.store.db.prepare("SELECT authority,envelope FROM messages WHERE id=?").get(e.id);
  assert.equal(JSON.parse(cached.authority!).ok, true); assert.equal(hasWakeAuthority(b, "worker", cached), true);
  if (change === "revoke") {
    for (const n of [a,b]) n.store.db.prepare("INSERT INTO grants VALUES (?,?,?,?,1)").run(grant.id, grant.sub, JSON.stringify(grant), grant.exp);
  } else if (change === "expire") t.mock.timers.enable({ apis: ["Date"], now: Date.parse(grant.exp) });
  else if (change === "owner-key") b.store.db.prepare("UPDATE peers SET owner_pubkey=? WHERE host='alpha'").run(generateKeyPair().publicKey);
  else if (change === "host-key") b.store.db.prepare("UPDATE peers SET pubkey=? WHERE host='alpha'").run(generateKeyPair().publicKey);
  else b.store.db.prepare("UPDATE peers SET state='pending' WHERE host='alpha'").run();
  assert.equal(hasWakeAuthority(b, "worker", cached), false, "a cached receipt cannot authorize current wake work");
  assert.doesNotMatch(formatFor(b, cached, "worker"), /authority: OWNER/);
  assert.doesNotMatch(wakeText("worker", [cached]), /Includes an OWNER-authority message/);
  for (const row of [b.read(e.id, "worker"), ...b.inbox("worker"), ...b.thread(e.thread, "worker"), ...b.search("authorized", 20, "worker")])
    assert.equal(JSON.parse(row.authority!).ok, false);
  assert.deepEqual(b.store.db.prepare("SELECT authority,envelope FROM messages WHERE id=?").get(e.id), stored, "historical receipt and signed bytes remain intact");
  if (change === "revoke" || change === "expire") {
    assert.equal(hasWakeAuthority(a, "worker", a.read(e.id, "worker")), false);
    assert.doesNotMatch(formatFor(a, a.read(e.id, "worker"), "worker"), /authority: OWNER/);
  }
});
