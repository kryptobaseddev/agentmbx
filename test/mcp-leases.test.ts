import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { MbxNode } from "../src/node.ts";
import { IdentityLeases, inspectLeaseProcess } from "../src/identity-leases.ts";
import { fingerprint, generateKeyPair } from "../src/crypto.ts";

for (const cli of ["claude", "codex", "kimi", "opencode"]) test(`${cli} MCP claims, renames and releases its lease`, async (t) => {
  const home = mkdtempSync(join(tmpdir(), "mbx-mcp-lease-")), node = new MbxNode(home, { host: "alpha" });
  const c = new Client({ name: cli, version: "test" });
  t.after(async () => { await c.close(); node.close(); rmSync(home, { recursive: true, force: true }); });
  const transport = new StdioClientTransport({ command: process.execPath, args: [join(import.meta.dirname, "../bin/agentmbx.js"), "mcp"],
    env: { ...process.env, AGENTMBX_DEV: "1", MBX_HOME: home, MBX_CLI: cli, MBX_AGENT: "reader", MBX_NO_DESKTOP: "1" } as Record<string, string> });
  await c.connect(transport);
  const before = node.store.db.prepare("SELECT * FROM identity_leases WHERE name='reader'").get();
  assert.ok(before, "startup must claim the identity"); assert.equal(before.holder_pid, transport.pid);
  const id = node.send({ from: "sender", to: ["reader"], subject: "pending", body: "preserved" }).envelope.id;
  const renamed = await c.callTool({ name: "mbx_whoami", arguments: { name: "renamed" } }); assert.notEqual(renamed.isError, true);
  const after = node.store.db.prepare("SELECT * FROM identity_leases WHERE name='renamed'").get()!;
  assert.equal(after.released_at, null); assert.notEqual(after.token, before.token);
  assert.notEqual(node.store.db.prepare("SELECT released_at FROM identity_leases WHERE name='reader'").get()!.released_at, null);
  assert.equal(node.inbox("renamed")[0].id, id);
  await c.close(); assert.notEqual(node.store.db.prepare("SELECT released_at FROM identity_leases WHERE name='renamed'").get()!.released_at, null);
});

test("a replaced MCP holder cannot mutate mail or release its successor's lease", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "mbx-mcp-fenced-")), node = new MbxNode(home, { host: "alpha" });
  const c = new Client({ name: "claude", version: "test" });
  t.after(async () => { await c.close(); node.close(); rmSync(home, { recursive: true, force: true }); });
  await c.connect(new StdioClientTransport({ command: process.execPath, args: [join(import.meta.dirname, "../bin/agentmbx.js"), "mcp"],
    env: { ...process.env, AGENTMBX_DEV: "1", MBX_HOME: home, MBX_CLI: "claude", MBX_AGENT: "reader", MBX_NO_DESKTOP: "1" } as Record<string, string> }));
  const id = node.send({ from: "sender", to: ["reader"], subject: "pending", body: "preserved" }).envelope.id;
  node.store.db.prepare("UPDATE identity_leases SET heartbeat_at=0 WHERE name='reader'").run();
  const successor = new IdentityLeases(node.store).claim("reader", { pid: process.pid, start: inspectLeaseProcess(process.pid).start!, keyFp: fingerprint(generateKeyPair().publicKey), cli: "test", sessionId: "replacement" });
  for (const [name, args] of [["mbx_send", { to: ["receiver"], subject: "forbidden", body: "lost lease" }], ["mbx_ack", { ids: [id] }], ["mbx_whoami", { name: "stolen" }]] as const) {
    const result = await c.callTool({ name, arguments: args }); assert.equal(result.isError, true, name);
    assert.match(JSON.stringify(result), /lease.*(usable|lost)/i);
  }
  assert.equal(node.unreadCount("reader"), 1); assert.equal(node.inbox("receiver").length, 0);
  await c.close();
  const current = node.store.db.prepare("SELECT token,released_at FROM identity_leases WHERE name='reader'").get()!;
  assert.equal(current.token, successor.token); assert.equal(current.released_at, null);
});

test("MCP rename conflicts preserve the source generation, binding and pending mail", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "mbx-mcp-rename-conflict-")), node = new MbxNode(home, { host: "alpha" });
  const c = new Client({ name: "claude", version: "test" });
  t.after(async () => { await c.close(); node.close(); rmSync(home, { recursive: true, force: true }); });
  await c.connect(new StdioClientTransport({ command: process.execPath, args: [join(import.meta.dirname, "../bin/agentmbx.js"), "mcp"],
    env: { ...process.env, AGENTMBX_DEV: "1", MBX_HOME: home, MBX_CLI: "claude", MBX_AGENT: "reader", MBX_NO_DESKTOP: "1" } as Record<string, string> }));
  const source = node.store.db.prepare("SELECT token FROM identity_leases WHERE name='reader'").get()!.token;
  const id = node.send({ from: "sender", to: ["reader"], subject: "pending", body: "preserved" }).envelope.id;
  const target = new IdentityLeases(node.store).claim("occupied", { pid: process.pid, start: inspectLeaseProcess(process.pid).start!, keyFp: fingerprint(generateKeyPair().publicKey), cli: "test", sessionId: "target" });
  node.bindSession({ agent: "legacy", cli: "kimi", session_id: "legacy-other", pid: process.pid, session_key: "legacy-key" });
  for (const name of ["occupied", "legacy"]) {
    const response = await c.callTool({ name: "mbx_whoami", arguments: { name } });
    assert.equal(response.isError, true);
    assert.equal(((await c.callTool({ name: "mbx_whoami", arguments: {} })).structuredContent as { agent: string }).agent, "reader");
    assert.equal(node.store.db.prepare("SELECT token FROM identity_leases WHERE name='reader'").get()!.token, source);
    assert.equal(node.inbox("reader")[0].id, id);
  }
  assert.equal(node.store.db.prepare("SELECT token FROM identity_leases WHERE name='occupied'").get()!.token, target.token);
  assert.equal(node.store.db.prepare("SELECT 1 FROM identity_leases WHERE name='legacy'").get(), undefined);
});
