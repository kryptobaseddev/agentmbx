import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MbxNode } from "../src/node.ts";
import { allocateProjectMailbox } from "../src/project-mailbox.ts";
import { noteProject } from "../src/registry.ts";
import { basenameMigrationPlan, migrateBasename, moveUnread, readBasenameMigrationPlan } from "../src/identity-cleanup.ts";
import { IdentityLeases, inspectLeaseProcess } from "../src/identity-leases.ts";
import { fingerprint, generateKeyPair } from "../src/crypto.ts";

function world(t: TestContext) {
  const n = new MbxNode(mkdtempSync(join(tmpdir(), "mbx-basename-")), { host: "alpha", bind: "127.0.0.1", port: 0 });
  const folder = join(n.home, "legacy-project");
  mkdirSync(join(folder, ".cleo"), { recursive: true });
  writeFileSync(join(folder, ".cleo/project-id"), "071b70b3-551d-44bb-b993-1e84bfa2fe09\n");
  const project = realpathSync(folder), source = "legacy-project";
  n.registerAgent(source); noteProject(n.store, source, project, true);
  const id = n.send({ from: "sender", to: [source], subject: "pending", body: "PRIVATE-BODY" }).envelope.id;
  const read = n.send({ from: "sender", to: [source], subject: "opened", body: "history" }).envelope.id;
  const acked = n.send({ from: "sender", to: [source], subject: "handled", body: "history" }).envelope.id;
  n.store.setDelivery(read, source, "read", "retain read note"); n.ack(acked, source);
  const box = allocateProjectMailbox(n, project).mailbox;
  t.after(() => { n.close(); rmSync(n.home, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); });
  const snapshot = () => JSON.stringify({ deliveries: n.store.db.prepare("SELECT * FROM deliveries ORDER BY msg_id,agent").all(),
    aliases: n.store.db.prepare("SELECT * FROM kv WHERE k LIKE 'alias:%' ORDER BY k").all(), audits: n.store.db.prepare("SELECT * FROM audit ORDER BY rowid").all() });
  return { n, project, source, id, read, acked, box, snapshot };
}

test("T494: CLI defaults to a read-only basename migration preview", t => {
  const w = world(t), before = w.snapshot();
  const result = spawnSync(process.execPath, [join(process.cwd(), "bin/agentmbx.js"), "identity", "migrate-basename", "--project", w.project, "--json"], {
    encoding: "utf8", timeout: 20_000, env: { ...process.env, AGENTMBX_DEV: "1", MBX_HOME: w.n.home, MBX_NO_UPDATE_CHECK: "1", MBX_NO_DESKTOP: "1" },
  });
  assert.equal(result.status, 0, result.stderr);
  const plan = JSON.parse(result.stdout);
  assert.equal(plan.applied, false); assert.equal(plan.source, w.source); assert.equal(plan.target, w.box.slot);
  assert.deepEqual(plan.ids, [w.id]); assert.equal(w.snapshot(), before);
  assert.doesNotMatch(result.stdout, /PRIVATE-BODY/);
});

test("T494: the shared mover preserves read and acked history for basename migration", t => {
  const w = world(t);
  const before = w.n.store.db.prepare("SELECT * FROM deliveries WHERE msg_id IN (?,?) ORDER BY msg_id").all(w.read, w.acked);
  const options = { authority: "lead" as const, project: w.box.key, basenameMigration: true };
  const moved = w.n.store.tx(() => moveUnread(w.n, w.source, w.box.slot, options));
  assert.deepEqual(moved.ids, [w.id]);
  assert.deepEqual(w.n.store.db.prepare("SELECT * FROM deliveries WHERE msg_id IN (?,?) ORDER BY msg_id").all(w.read, w.acked), before);
  const audits = w.n.store.db.prepare("SELECT detail FROM audit WHERE event='identity.basename_migrated'").all();
  assert.equal(audits.length, 1); assert.equal(JSON.parse(audits[0].detail as string).msg, w.id);
});

test("T494: preview never initializes a missing home or repairs an incompatible schema", t => {
  const w = world(t), missing = join(w.n.home, "not-initialized");
  assert.throws(() => readBasenameMigrationPlan(missing, w.project), /not initialized/);
  assert.equal(existsSync(missing), false);
  w.n.store.db.exec("PRAGMA user_version=99");
  const before = w.snapshot();
  assert.throws(() => readBasenameMigrationPlan(w.n.home, w.project), /not compatible/);
  assert.equal(w.n.store.db.prepare("PRAGMA user_version").get()!.user_version, 99);
  assert.equal(w.snapshot(), before);
});

test("T494: missing slot, ambiguous membership, foreign home and a live source are refused", t => {
  const w = world(t);
  const other = join(w.n.home, "other"); mkdirSync(other); noteProject(w.n.store, w.source, other, true);
  assert.match(basenameMigrationPlan(w.n, w.project).reason!, /ambiguous/);
  w.n.store.db.prepare("DELETE FROM identity_projects WHERE name=? AND project=?").run(w.source, other);
  w.n.store.db.prepare("UPDATE project_mailboxes SET home_host='elsewhere' WHERE slot=?").run(w.box.slot);
  assert.match(basenameMigrationPlan(w.n, w.project).reason!, /another host/);
  w.n.store.db.prepare("UPDATE project_mailboxes SET home_host=? WHERE slot=?").run(w.n.host, w.box.slot);
  new IdentityLeases(w.n.store).claim(w.source, { pid: process.pid, start: inspectLeaseProcess(process.pid).start!,
    keyFp: fingerprint(generateKeyPair().publicKey), cli: "claude", sessionId: "legacy-source-session" });
  assert.match(basenameMigrationPlan(w.n, w.project).reason!, /held by live/);
  assert.match(basenameMigrationPlan(w.n, other).reason!, /no allocated/);
});

test("T494: unsupported states and foreign slot aliases are explicit refusals", t => {
  const w = world(t);
  w.n.store.db.prepare("UPDATE deliveries SET state='future-state' WHERE msg_id=? AND agent=?").run(w.id, w.source);
  assert.match(basenameMigrationPlan(w.n, w.project).reason!, /unsupported/);
  w.n.store.db.prepare("UPDATE deliveries SET state='delivered' WHERE msg_id=? AND agent=?").run(w.id, w.source);
  w.n.store.set(`alias:${w.source}`, "pm-00000000000000000000000000000000");
  assert.match(basenameMigrationPlan(w.n, w.project).reason!, /another project's/);
});

test("T494: an unleased caller cannot apply or manufacture a lead alias", t => {
  const w = world(t), before = w.snapshot();
  assert.throws(() => migrateBasename(w.n, "pretend-lead", w.project), /own session lease/);
  assert.equal(w.snapshot(), before);
});

test("T494: existing read/acked target copies are deduplicated without resetting their state", t => {
  const w = world(t);
  w.n.store.db.prepare("INSERT INTO deliveries(msg_id,agent,state,updated_at,note) VALUES (?,?,?,?,'target already handled')")
    .run(w.id, w.box.slot, "acked", new Date().toISOString());
  const before = w.n.store.db.prepare("SELECT * FROM deliveries WHERE msg_id=? AND agent=?").get(w.id, w.box.slot);
  w.n.store.tx(() => moveUnread(w.n, w.source, w.box.slot, { authority: "lead", project: w.box.key, basenameMigration: true }));
  assert.deepEqual(w.n.store.db.prepare("SELECT * FROM deliveries WHERE msg_id=? AND agent=?").get(w.id, w.box.slot), before);
  const audit = JSON.parse(w.n.store.db.prepare("SELECT detail FROM audit WHERE event='identity.basename_migrated'").get()!.detail as string);
  assert.equal(audit.outcome, "deduplicated"); assert.equal(audit.target_state, "acked");
  assert.equal(w.n.store.get(`alias:${w.source}`), w.box.slot);
  const next = w.n.send({ from: "sender", to: [w.source], subject: "future", body: "x" });
  assert.deepEqual(next.local, [w.box.slot]);
});

test("T494: queued and notified copies move and receive one audit each", t => {
  const w = world(t);
  w.n.store.setDelivery(w.id, w.source, "queued");
  // Simulate another legacy pending copy before project alias allocation took over routing.
  w.n.store.db.prepare("UPDATE deliveries SET state='notified' WHERE msg_id=? AND agent=?").run(w.read, w.source);
  const result = w.n.store.tx(() => moveUnread(w.n, w.source, w.box.slot, { authority: "lead", project: w.box.key, basenameMigration: true }));
  assert.equal(result.moved, 2);
  assert.equal(w.n.store.db.prepare("SELECT COUNT(*) n FROM audit WHERE event='identity.basename_migrated'").get()!.n, 2);
  assert.equal(w.n.store.db.prepare("SELECT state FROM deliveries WHERE msg_id=? AND agent=?").get(w.acked, w.source)!.state, "acked");
});
