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
    mbx_whoami: {}, mbx_agents: {}, mbx_inbox: {}, mbx_read: { ids: ["missing"] }, mbx_ack: { ids: ["missing"] },
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
