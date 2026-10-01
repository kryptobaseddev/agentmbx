import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { MbxNode } from "../src/node.ts";

for (const cli of ["claude", "codex", "kimi", "opencode"]) test(`${cli} v2 import is atomic, idempotent and limited to the current lease`, async t => {
  const home = mkdtempSync(join(tmpdir(), "mbx-import-")), archive = join(home, "archive");
  mkdirSync(join(archive, "messages"), { recursive: true }); mkdirSync(join(archive, "acks"));
  const n = new MbxNode(home, { host: "alpha" }), clients: Client[] = [];
  t.after(async () => { for (const c of clients) await c.close(); n.close(); rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
  const write = (id: string, to: string[], subject = id) => writeFileSync(join(archive, "messages", `${id}.json`), JSON.stringify({
    id, ts: new Date().toISOString(), from: "old-sender", to, thread: id, type: "request", subject, body: "old body", reply_to: null, needs_reply: true, refs: [],
  }));
  write("a", ["reader", "other"]); write("b", ["reader"]); write("c", ["other"]);
  writeFileSync(join(archive, "acks/a.reader"), ""); writeFileSync(join(archive, "acks/c.other"), "");
  const run = (...args: string[]) => spawnSync(process.execPath, [resolve("bin/agentmbx.js"), "import-v2", archive, ...args], {
    encoding: "utf8", timeout: 15_000, env: { ...process.env, MBX_HOME: home, AGENTMBX_DEV: "1", MBX_AGENT: "" },
  });
  assert.equal(run("--as", "reader").status, 1); assert.equal(n.store.db.prepare("SELECT count(*) n FROM messages").get()?.n, 0);
  const holder = async (name: string) => {
    const client = new Client({ name: "import-test", version: "1" }); clients.push(client);
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [resolve("bin/agentmbx.js"), "mcp"],
      env: { ...process.env, MBX_HOME: home, MBX_AGENT: name, MBX_CLI: cli, AGENTMBX_DEV: "1" } as Record<string,string> }));
    const me = (await client.callTool({ name: "mbx_whoami", arguments: {} })).structuredContent as { agent: string };
    assert.equal(me.agent, name);
    const sid = n.sessionsFor(name)[0].session_id;
    return { client, selected: ["--cli", cli, "--session", sid, "--as", name] };
  };
  const reader = await holder("reader"), other = await holder("other");
  assert.equal(run().status, 1, "shared parent cannot select an importer implicitly");
  const first = run(...reader.selected); assert.equal(first.status, 0, first.stderr); assert.match(first.stdout, /imported 2/);
  const state = (id: string, agent: string) => n.store.db.prepare("SELECT state FROM deliveries WHERE msg_id=? AND agent=?").get(`v2-${id}`, agent)?.state;
  assert.equal(state("a", "reader"), "acked"); assert.equal(state("b", "reader"), "delivered");
  assert.equal(state("a", "other"), undefined); assert.equal(n.message("v2-c"), undefined);
  assert.equal(n.message("v2-a")?.origin, "legacy");
  const second = run(...other.selected); assert.equal(second.status, 0, second.stderr); assert.match(second.stdout, /imported 2/);
  assert.equal(state("a", "other"), "delivered"); assert.equal(state("c", "other"), "acked");
  n.ack("v2-b", "reader");
  const again = run(...reader.selected); assert.equal(again.status, 0, again.stderr); assert.match(again.stdout, /imported 0/);
  assert.equal(state("b", "reader"), "acked");
  write("a-extra", ["reader"]);
  const prefix = run(...reader.selected); assert.equal(prefix.status, 0, prefix.stderr); assert.match(prefix.stdout, /imported 1/);
  assert.match(run(...reader.selected).stdout, /imported 0/, "archive IDs resolve exactly, not as prefixes");
  write("00", ["reader"]); write("b", ["reader"], "conflicting bytes");
  const conflict = run(...reader.selected); assert.equal(conflict.status, 1); assert.match(conflict.stderr, /conflicts with stored content/);
  assert.equal(n.message("v2-00"), undefined, "earlier inserts roll back with a later conflict");
  assert.equal(n.message("v2-b")?.subject, "b");
  assert.notEqual((await reader.client.callTool({ name: "mbx_identity", arguments: { action: "release" } })).isError, true);
  assert.equal(run(...reader.selected).status, 1); assert.equal(n.message("v2-00"), undefined);
});
