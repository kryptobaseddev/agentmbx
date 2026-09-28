import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { Store, SCHEMA_VERSION } from "../src/store.ts";
import { MbxNode } from "../src/node.ts";
import { version } from "../src/version.ts";
import { reloadFromDisk, storeMismatchCode, leaseCollisionAction } from "../src/mcp.ts";

test("source SQL inserts specify columns for additive schema compatibility", () => {
  const root = join(import.meta.dirname, "../src");
  let count = 0;
  for (const file of readdirSync(root, { recursive: true, encoding: "utf8" }).filter(f => f.endsWith(".ts"))) {
    const source = readFileSync(join(root, file), "utf8");
    for (const match of source.matchAll(/\bINSERT\s+(?:OR\s+\w+\s+)?INTO\s+([\w]+)\s*/gi)) {
      count++;
      assert.equal(source[match.index! + match[0].length], "(", `${file}: ${match[1]} must name inserted columns`);
    }
  }
  assert.ok(count >= 26, "coverage includes the current runtime insert sites");
});

for (const incompatible of [false, true]) test(`future schema is rejected before startup writes (incompatible: ${incompatible})`, (t) => {
  const home = mkdtempSync(join(tmpdir(), "mbx-future-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const path = join(home, "mbx.db"), db = new DatabaseSync(path);
  db.exec(`PRAGMA user_version=${SCHEMA_VERSION + 1}; CREATE TABLE future_data (value TEXT); INSERT INTO future_data (value) VALUES ('preserve');`);
  if (incompatible) db.exec("CREATE TABLE messages (future_id TEXT)");
  db.close();
  const before = readFileSync(path);
  assert.throws(() => new Store(home), (e: Error & { code?: string }) => {
    assert.equal(e.code, "STALE_SERVER");
    assert.match(e.message, /Restart your CLI session/);
    assert.doesNotMatch(e.message, /no such column/);
    return true;
  });
  assert.deepEqual(readFileSync(path), before, "schema and journal configuration remain untouched");
  const check = new DatabaseSync(path);
  check.exec("BEGIN EXCLUSIVE; ROLLBACK");
  check.close();
});

test("every MCP tool refuses an upgraded schema before its callback", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "mbx-upgrade-"));
  const n = new MbxNode(home, { host: "alpha" });
  const client = new Client({ name: "upgrade-test", version: "1" });
  t.after(async () => { await client.close(); n.close(); rmSync(home, { recursive: true, force: true }); });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [join(import.meta.dirname, "../bin/agentmbx.js"), "mcp"],
    env: { ...process.env, MBX_HOME: home, MBX_AGENT: "worker", MBX_CLI: "claude", MBX_CHANNEL: "0", AGENTMBX_DEV: "1" } as Record<string, string> }));
  const args: Record<string, Record<string, unknown>> = {
    mbx_identity: { action: "list" }, mbx_whoami: {}, mbx_agents: {}, mbx_inbox: {}, mbx_read: { ids: ["missing"] }, mbx_ack: { ids: ["missing"] },
    mbx_reply: { id: "missing", body: "test" }, mbx_send: { to: ["other"], subject: "test", body: "test" },
    mbx_thread: { id: "missing" }, mbx_search: { query: "test" },
  };
  const tools = (await client.listTools()).tools;
  n.store.db.exec(`PRAGMA user_version=${SCHEMA_VERSION + 1}`);
  for (const tool of tools) {
    assert.ok(args[tool.name], `supply valid input for ${tool.name}`);
    const result = await client.callTool({ name: tool.name, arguments: args[tool.name] });
    assert.equal(result.isError, true, tool.name);
    assert.match(JSON.stringify(result.content), /Restart your CLI session/, tool.name);
  }
  assert.equal((n.store.db.prepare("SELECT count(*) n FROM messages").get() as { n: number }).n, 0);
});

test("v1 lease migration preserves signed message bytes and pending/acked delivery history", (t) => {
  const home = mkdtempSync(join(tmpdir(), "mbx-v1-leases-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const original = new MbxNode(home, { host: "alpha" });
  const pending = original.send({ from: "sender", to: ["worker"], subject: "pending", body: "durable" }).envelope.id;
  const acked = original.send({ from: "sender", to: ["worker"], subject: "acked", body: "durable" }).envelope.id;
  original.ack(acked, "worker");
  const before = original.store.db.prepare("SELECT * FROM messages ORDER BY id").all();
  const deliveries = original.store.db.prepare("SELECT * FROM deliveries ORDER BY msg_id").all();
  original.store.db.exec("DROP TABLE identity_leases; PRAGMA user_version=1"); original.close();
  const saved = readFileSync(join(home, "mbx.db"));
  assert.throws(() => new Store(home), { code: "IDENTITY_MIGRATION_REQUIRED" });
  assert.deepEqual(readFileSync(join(home, "mbx.db")), saved, "normal startup cannot implicitly migrate an existing mailbox");
  const migrated = new Store(home, { allowIdentityMigration: true });
  try {
    assert.equal(migrated.schemaVersion(), SCHEMA_VERSION);
    assert.deepEqual(migrated.db.prepare("SELECT * FROM messages ORDER BY id").all(), before);
    assert.deepEqual(migrated.db.prepare("SELECT * FROM deliveries ORDER BY msg_id").all(), deliveries);
    assert.equal(migrated.db.prepare("SELECT state FROM deliveries WHERE msg_id=?").get(pending)!.state, "delivered");
    assert.equal(migrated.db.prepare("SELECT count(*) n FROM identity_leases").get()!.n, 0);
  } finally { migrated.close(); }
});

test("failed migration rolls back the lease table and version marker together", (t) => {
  const home = mkdtempSync(join(tmpdir(), "mbx-migration-abort-")), path = join(home, "mbx.db");
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const db = new DatabaseSync(path);
  db.exec("PRAGMA user_version=1; CREATE VIEW principals AS SELECT 'sentinel' AS fp"); db.close();
  assert.throws(() => new Store(home, { allowIdentityMigration: true }), /view|table/i);
  const check = new DatabaseSync(path);
  try {
    assert.equal(check.prepare("PRAGMA user_version").get()!.user_version, 1);
    assert.equal(check.prepare("SELECT name FROM sqlite_master WHERE name='identity_leases'").get(), undefined);
    assert.equal(check.prepare("SELECT fp FROM principals").get()!.fp, "sentinel");
  } finally { check.close(); }
});

for (const existed of [false, true]) test(`concurrent legacy initialization cannot bypass migration consent (file existed: ${existed})`, t => {
  const home = mkdtempSync(join(tmpdir(), "mbx-migration-race-")), path = join(home, "mbx.db");
  t.after(() => rmSync(home, { recursive: true, force: true }));
  if (existed) new DatabaseSync(path).close();
  const exec = DatabaseSync.prototype.exec;
  let initialized = false;
  t.mock.method(DatabaseSync.prototype, "exec", function(this: DatabaseSync, sql: string) {
    if (!initialized && sql === "BEGIN IMMEDIATE") {
      initialized = true;
      // An old binary initializes the previously empty database after the first
      // compatibility check, but before this opener acquires its migration lock.
      const other = new DatabaseSync(path);
      try { exec.call(other, "CREATE TABLE legacy_data (value TEXT); INSERT INTO legacy_data (value) VALUES ('preserve'); PRAGMA user_version=1"); }
      finally { other.close(); }
    }
    return exec.call(this, sql);
  });
  assert.throws(() => { const store = new Store(home); store.close(); }, { code: "IDENTITY_MIGRATION_REQUIRED" });
  assert.equal(initialized, true);
  const check = new DatabaseSync(path);
  try {
    assert.equal(check.prepare("PRAGMA user_version").get()!.user_version, 1);
    assert.equal(check.prepare("SELECT value FROM legacy_data").get()!.value, "preserve");
    assert.equal(check.prepare("SELECT name FROM sqlite_master WHERE name='identity_leases'").get(), undefined);
  } finally { check.close(); }
});

test("migration records the upgrading version and stale peers get accurate advice", (t) => {
  const home = mkdtempSync(join(tmpdir(), "mbx-upgrade-by-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const original = new MbxNode(home, { host: "alpha" });
  original.store.db.exec("DROP TABLE identity_leases; DELETE FROM kv WHERE k='schema-upgraded-by'; PRAGMA user_version=1");
  original.close();
  const migrated = new Store(home, { allowIdentityMigration: true });
  try {
    assert.equal(migrated.schemaVersion(), SCHEMA_VERSION);
    assert.equal(migrated.upgradedBy(), version());
    migrated.db.exec(`PRAGMA user_version = ${SCHEMA_VERSION + 1}`);
    assert.throws(() => migrated.assertCurrent("0.3.1"), (e: Error) => {
      assert.match(e.message, new RegExp(`upgraded by agentmbx ${version()}`));
      assert.match(e.message, /Update AgentMBX/);
      assert.match(e.message, /mail is preserved/i);
      return true;
    });
    // a session running the very build that recorded the upgrade is told to restart, not to update
    migrated.db.prepare("UPDATE kv SET v=? WHERE k='schema-upgraded-by'").run("0.3.1");
    assert.throws(() => migrated.assertCurrent("0.3.1"), (e: Error) => {
      assert.match(e.message, /already running/);
      assert.match(e.message, /Restart your CLI session/);
      assert.doesNotMatch(e.message, /Update AgentMBX/);
      return true;
    });
  } finally { migrated.close(); }
});

test("MCP self-reload fires only for store mismatches and only once", () => {
  assert.equal(storeMismatchCode(Object.assign(new Error("x"), { code: "STALE_SERVER" })), "STALE_SERVER");
  assert.equal(storeMismatchCode(Object.assign(new Error("x"), { code: "IDENTITY_MIGRATION_REQUIRED" })), "IDENTITY_MIGRATION_REQUIRED");
  assert.equal(storeMismatchCode(new Error("boom")), null);
  assert.equal(storeMismatchCode({ code: 42 }), null);
  const had = process.env.MBX_MCP_REEXEC;
  process.env.MBX_MCP_REEXEC = "1";
  try {
    reloadFromDisk(Object.assign(new Error("x"), { code: "STALE_SERVER" })); // guard set: returns without spawning
    reloadFromDisk(new Error("unrelated")); // not a mismatch: returns without spawning
  } finally {
    if (had === undefined) delete process.env.MBX_MCP_REEXEC; else process.env.MBX_MCP_REEXEC = had;
  }
});

test("lease collisions inside one MCP process converge instead of erroring", () => {
  const inUse = Object.assign(new Error("identity worker already has a holder"), { code: "IDENTITY_IN_USE" });
  const prior = { token: "t", holder_pid: 4242, holder_start: "s", session_id: "mcp-4242", released_at: null };
  const self = { pid: 4242, start: "s", baseSessionId: "mcp-4242", stateSessionId: "ses_9" };
  assert.equal(leaseCollisionAction(inUse, prior, self), "transfer", "our provisional base yields to the real session");
  assert.equal(leaseCollisionAction(inUse, { ...prior, session_id: "ses_9" }, self), "adopt", "a racing same-session claim is shared");
  assert.equal(leaseCollisionAction(inUse, { ...prior, holder_pid: 9999 }, self), null, "another process is a genuine conflict");
  assert.equal(leaseCollisionAction(inUse, { ...prior, session_id: "ses_other" }, self), null, "another session in this process is a genuine conflict");
  assert.equal(leaseCollisionAction(inUse, { ...prior, released_at: "r" }, self), null);
  assert.equal(leaseCollisionAction(Object.assign(new Error("x"), { code: "OTHER" }), prior, self), null);
  assert.equal(leaseCollisionAction(inUse, undefined, self), null);
});

test("code fingerprints detect a deployed build without a schema change", async () => {
  const { codeFingerprint } = await import("../src/mcp.ts");
  const base = codeFingerprint("/nonexistent-entry", () => { throw new Error("no file"); });
  assert.equal(base, version(), "without a readable entry the fingerprint falls back to the version");
  const a = codeFingerprint("entry", () => ({ mtimeMs: 100, size: 5 }));
  const b = codeFingerprint("entry", () => ({ mtimeMs: 200, size: 5 }));
  const c = codeFingerprint("entry", () => ({ mtimeMs: 100, size: 6 }));
  assert.notEqual(a, b, "mtime change means a new build");
  assert.notEqual(a, c, "size change means a new build");
  assert.equal(a, codeFingerprint("entry", () => ({ mtimeMs: 100, size: 5 })), "same build, same fingerprint");
});
