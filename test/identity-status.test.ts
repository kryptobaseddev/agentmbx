import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { MbxNode } from "../src/node.ts";
import { IdentityLeases } from "../src/identity-leases.ts";
import { listIdentityStatus } from "../src/identity-status.ts";

const cli = (home: string, ...args: string[]) => spawnSync(process.execPath, [resolve("bin/agentmbx.js"), ...args], {
  encoding: "utf8", env: { ...process.env, MBX_HOME: home, AGENTMBX_DEV: "1" }, timeout: 5000,
});

test("identity inventory distinguishes current, expired, unknown and legacy ownership without mutating leases", t => {
  const home = mkdtempSync(join(tmpdir(), "mbx-identities-")), node = new MbxNode(home, { host: "alpha" });
  t.after(() => { node.close(); rmSync(home, { recursive: true, force: true }); });
  const names = ["held", "released", "idle", "dead", "reused", "unknown", "conflicted"];
  const leases = new IdentityLeases(node.store, { clock: () => 1000, idleTtlMs: 100, inspect: pid => ({ alive: true, start: `birth-${pid}` }) });
  names.forEach((name, i) => {
    const lease = leases.claim(name, { pid: 100 + i, start: `birth-${100 + i}`, cli: ["claude", "codex", "kimi", "opencode"][i % 4], sessionId: name, keyFp: "aaaa-bbbb-cccc-dddd" });
    if (name === "released") leases.release(name, lease.token);
  });
  node.store.db.prepare("UPDATE identity_leases SET heartbeat_at=900 WHERE name='idle'").run();
  node.store.set("identity-conflict:conflicted", "retained");
  node.registerAgent("legacy", { cli: "kimi" });
  node.store.db.prepare("INSERT INTO agents (name,host) VALUES ('remote-only','beta')").run();
  for (let i = 0; i < 2; i++) {
    const id = node.send({ from: "sender", to: ["held"], subject: "history", body: "preserved" }).envelope.id;
    if (i === 1) node.ack(id, "held");
  }
  const before = node.store.db.prepare("SELECT * FROM identity_leases ORDER BY name").all();
  const audit = node.store.db.prepare("SELECT * FROM audit").all();
  const result = listIdentityStatus(home, { now: 1050, inspect: pid => {
    if (pid === 103) return { alive: false, start: null };
    if (pid === 104) return { alive: true, start: "replacement" };
    if (pid === 105) throw new Error("unavailable");
    return { alive: true, start: `birth-${pid}` };
  } });
  assert.equal(result.advisory, true);
  assert.deepEqual(Object.fromEntries(result.identities.map(r => [r.name, r.state])), {
    conflicted: "conflict", dead: "available", held: "held", idle: "available", legacy: "legacy", released: "available", reused: "available", unknown: "unknown",
  });
  const held = result.identities.find(r => r.name === "held")!;
  assert.equal(held.unread, 1); assert.equal(held.messages, 2); assert.ok(held.last_activity);
  for (const lease of before) assert.ok(!JSON.stringify(result).includes(lease.token as string));
  assert.deepEqual(node.store.db.prepare("SELECT * FROM identity_leases ORDER BY name").all(), before);
  assert.deepEqual(node.store.db.prepare("SELECT * FROM audit").all(), audit);
});

test("identity CLI inspects schema v1 without migration or registration", t => {
  const home = mkdtempSync(join(tmpdir(), "mbx-identity-v1-")), node = new MbxNode(home, { host: "alpha" });
  t.after(() => rmSync(home, { recursive: true, force: true }));
  node.send({ from: "sender", to: ["historical"], subject: "unread", body: "kept" });
  node.store.db.exec("DROP TABLE identity_leases; PRAGMA user_version=1"); node.close();
  const path = join(home, "mbx.db"), before = readFileSync(path);
  const response = cli(home, "identity", "list", "--json");
  assert.equal(response.status, 0, response.stderr);
  const result = JSON.parse(response.stdout);
  assert.equal(result.schema_version, 1); assert.equal(result.identities[0].name, "historical");
  assert.equal(result.identities[0].state, "legacy"); assert.equal(result.identities[0].unread, 1);
  assert.deepEqual(readFileSync(path), before);
  const check = new DatabaseSync(path, { readOnly: true });
  try { assert.equal(check.prepare("SELECT name FROM sqlite_master WHERE name='identity_leases'").get(), undefined); }
  finally { check.close(); }
  assert.match(cli(home, "identity", "list").stdout, /historical\tlegacy\t1 unread/);
});

test("identity CLI help and usage do not create a mailbox", t => {
  const root = mkdtempSync(join(tmpdir(), "mbx-identity-missing-")), home = join(root, "missing");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  assert.match(cli(home, "identity", "--help").stdout, /identity list/);
  assert.equal(cli(home, "identity", "claim").status, 2);
  assert.equal(cli(home, "identity", "list").status, 3);
  assert.equal(existsSync(home), false);
});

test("identity inventory refuses future schemas without modifying them", t => {
  const home = mkdtempSync(join(tmpdir(), "mbx-identity-future-")), node = new MbxNode(home, { host: "alpha" });
  t.after(() => rmSync(home, { recursive: true, force: true }));
  node.store.db.exec("PRAGMA user_version=999"); node.close();
  const before = readFileSync(join(home, "mbx.db"));
  assert.throws(() => listIdentityStatus(home), { code: "STALE_SERVER" });
  assert.deepEqual(readFileSync(join(home, "mbx.db")), before);
});
