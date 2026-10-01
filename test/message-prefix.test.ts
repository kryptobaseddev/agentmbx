import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { MbxNode } from "../src/node.ts";

test("hidden prefix collisions neither disclose IDs nor hide a visible message", (t) => {
  const home = mkdtempSync(join(tmpdir(), "mbx-prefix-")), n = new MbxNode(home, { host: "alpha" });
  t.after(() => { n.close(); rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
  const hidden = Array.from({ length: 9 }, () => n.send({ from: "other", to: ["private"], subject: "secret", body: "secret" }).envelope.id);
  const own = n.send({ from: "sender", to: ["reader"], subject: "visible", body: "visible" }).envelope.id;
  const prefix = own.slice(0, 6); assert.ok(hidden.every(id => id.startsWith(prefix)));
  assert.throws(() => n.read(prefix, "stranger"), { code: "NOT_FOUND" });
  assert.throws(() => n.ack(prefix, "stranger"), { code: "NOT_FOUND" });
  assert.equal(n.read(prefix, "reader").id, own);
  assert.equal(n.read(prefix, "sender").id, own);
  assert.equal(n.ack(prefix, "reader"), own);
  n.linkIdentity("shell", "primary");
  const shell = n.send({ from: "sender", to: ["shell"], subject: "linked", body: "linked" }).envelope.id;
  assert.throws(() => n.read(prefix, "primary"), { code: "NOT_FOUND" });
  assert.equal(n.read(prefix, "shell").id, shell);
  const second = n.send({ from: "sender", to: ["reader"], subject: "second", body: "second" }).envelope.id;
  assert.throws(() => n.read(prefix, "reader"), (e: Error & { code?: string }) => e.code === "AMBIGUOUS" && e.message.includes(own) && e.message.includes(second) && hidden.every(id => !e.message.includes(id)));
});

test("MCP and scoped CLI thread/reply paths resolve only visible prefixes", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "mbx-prefix-tools-")), n = new MbxNode(home, { host: "alpha" });
  const c = new Client({ name: "prefix-test", version: "1" }), bin = join(import.meta.dirname, "../bin/agentmbx.js");
  t.after(async () => { await c.close(); n.close(); rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
  const hidden = Array.from({ length: 9 }, () => n.send({ from: "other", to: ["private"], subject: "secret", body: "secret" }).envelope.id);
  const env = { ...process.env, AGENTMBX_DEV: "1", MBX_HOME: home, MBX_CLI: "claude", MBX_AGENT: "reader", MBX_NO_DESKTOP: "1" } as Record<string, string>;
  await c.connect(new StdioClientTransport({ command: process.execPath, args: [bin, "mcp"], env }));
  const prefix = hidden[0].slice(0, 6);
  const call = (name: string, args: Record<string, unknown>) => c.callTool({ name, arguments: args });
  for (const [name, args] of [["mbx_read", { ids: [prefix] }], ["mbx_ack", { ids: [prefix] }], ["mbx_reply", { id: prefix, body: "reply" }], ["mbx_thread", { id: prefix }]] as const) {
    const out = JSON.stringify(await call(name, args));
    assert.ok(hidden.every(id => !out.includes(id)), `${name} exposed hidden IDs`);
    assert.doesNotMatch(out, /ambiguous|matches 6/i);
  }
  const denied = spawnSync(process.execPath, [bin, "send", "--as", "reader", "--to", "receiver", "--reply-to", prefix, "-m", "reply"], { env, encoding: "utf8" });
  assert.equal(denied.status, 3); assert.ok(hidden.every(id => !denied.stderr.includes(id)));
  const own = n.send({ from: "sender", to: ["reader"], subject: "visible", body: "visible-body" }).envelope.id;
  assert.ok(own.startsWith(prefix));
  const thread = await call("mbx_thread", { id: prefix }); assert.notEqual(thread.isError, true); assert.match(JSON.stringify(thread), /visible-body/);
  const cli = spawnSync(process.execPath, [bin, "thread", prefix, "--as", "reader"], { env, encoding: "utf8" });
  assert.equal(cli.status, 0, cli.stderr); assert.match(cli.stdout, /visible-body/); assert.doesNotMatch(cli.stdout, /secret/);
  const ack = spawnSync(process.execPath, [bin, "ack", "--thread", prefix, "--as", "reader"], { env, encoding: "utf8" });
  assert.equal(ack.status, 0, ack.stderr); assert.match(ack.stdout, new RegExp(own));
});
