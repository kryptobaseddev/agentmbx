// T756: stalled work mail alerts the stuck agent's project lead (desktop notices stay off by owner decision).
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonical, signData } from "../src/crypto.ts";
import { makeLead, storeLead } from "../src/lead-record.ts";
import { MbxNode } from "../src/node.ts";
import { createOwnerKey, unlockOwnerKey } from "../src/owner.ts";
import { noteProject } from "../src/registry.ts";
import { alertLeadOfStall, STALL_ALERT_MS, type PendingRow } from "../src/wake.ts";

function world(t: TestContext) {
  const n = new MbxNode(mkdtempSync(join(tmpdir(), "mbx-t756-")), { host: "testhost", bind: "127.0.0.1", port: 0 });
  createOwnerKey(n.home, "test-only-passphrase");
  const owner = unlockOwnerKey(n.home, "test-only-passphrase");
  t.after(() => { n.close(); rmSync(n.home, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); });
  const dir = join(n.home, "alpha");
  mkdirSync(join(dir, ".cleo"), { recursive: true });
  writeFileSync(join(dir, ".cleo", "project-id"), "# CLEO project id: write once, commit it\n071b70b3-551d-44bb-b993-1e84bfa2fe09\n");
  const A = realpathSync(dir);
  for (const name of ["alpha-lead", "alpha-worker"]) { n.registerAgent(name); noteProject(n.store, name, A, true); }
  const rec = makeLead({ project: A, agent: "alpha-lead", host: n.host, ownerPub: owner.publicKey });
  storeLead(n, rec, signData(owner.privateKey, canonical(rec)));
  const pending = (kind: "request" | "task" | "status") => {
    const id = n.send({ from: "boss", to: ["alpha-worker"], subject: "secret-subject", body: "secret-body", kind }).envelope.id;
    return { ...n.message(id, "alpha-worker")!, agent: "alpha-worker" } as PendingRow;
  };
  const alerts = () => (n.store.db.prepare("SELECT m.envelope FROM deliveries d JOIN messages m ON m.id=d.msg_id WHERE d.agent='alpha-lead'").all() as { envelope: string }[])
    .map(r => JSON.parse(r.envelope) as { kind: string; subject: string; body: string });
  return { n, pending, alerts };
}

test("T756: stalled request mail alerts the project lead once per window, with ids and no content", (t) => {
  const { n, pending, alerts } = world(t);
  const row = pending("request");
  assert.equal(alertLeadOfStall(n, "alpha-worker", [row]), "alpha-lead");
  const [a] = alerts();
  assert.equal(a.kind, "alert");
  assert.match(a.body, new RegExp(row.id));
  assert.ok(!a.body.includes("secret-subject") && !a.body.includes("secret-body"), "no subject or body of the stuck mail");
  assert.equal(alertLeadOfStall(n, "alpha-worker", [pending("task")]), null, "throttled inside the window");
  assert.equal(alertLeadOfStall(n, "alpha-worker", [pending("task")], Date.now() + STALL_ALERT_MS + 1), "alpha-lead", "alerts again after it");
});

test("T756: status mail and the lead's own mail never alert", (t) => {
  const { n, pending, alerts } = world(t);
  assert.equal(alertLeadOfStall(n, "alpha-worker", [pending("status")]), null);
  assert.equal(alertLeadOfStall(n, "alpha-lead", [{ ...pending("request"), agent: "alpha-lead" }]), null);
  assert.equal(alerts().length, 0);
});
