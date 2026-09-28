import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { MbxNode } from "../src/node.ts";

for (const implicitReply of [false, true]) test(implicitReply ? "mbx_send reply_to records parent provenance" : "expired relay state cannot be revived by a fresh read", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "mbx-relay-"));
  const n = new MbxNode(home, { host: "alpha" }), c = new Client({ name: "relay-test", version: "1" });
  t.after(async () => { await c.close(); n.close(); rmSync(home, { recursive: true, force: true }); });
  const clock = join(home, "clock"), preload = join(home, "clock.mjs");
  let now = Date.now(); writeFileSync(clock, String(now));
  // Test-only child clock injection: exercise the real MCP handlers without waiting an hour.
  writeFileSync(preload, `import {readFileSync} from 'node:fs'; Date.now = () => Number(readFileSync(${JSON.stringify(clock)}, 'utf8'));`);
  await c.connect(new StdioClientTransport({ command: process.execPath, args: ["--import", preload, join(import.meta.dirname, "../bin/agentmbx.js"), "mcp"],
    env: { ...process.env, AGENTMBX_DEV: "1", MBX_HOME: home, MBX_CLI: "claude", MBX_AGENT: "reader", MBX_NO_DESKTOP: "1" } as Record<string, string> }));
  const parent = n.send({ from: "sender", to: ["reader"], subject: "external", body: "data", hop: 5, origin: "external" }).envelope;
  const fresh = n.send({ from: "sender", to: ["reader"], subject: "fresh", body: "data", hop: 0 }).envelope;
  const send = async (reply_to?: string) => {
    const r = await c.callTool({ name: "mbx_send", arguments: { to: ["receiver"], subject: "relay", body: "data", ...(reply_to ? { reply_to } : {}) } });
    assert.notEqual(r.isError, true);
    return JSON.parse(n.message((r.structuredContent as { id: string }).id)!.envelope);
  };
  if (implicitReply) {
    const e = await send(parent.id); assert.equal(e.thread, parent.thread); assert.equal(e.meta.hop, 6); assert.equal(e.meta.origin, "external"); return;
  }
  const read = (id: string) => c.callTool({ name: "mbx_read", arguments: { ids: [id] } });
  await read(parent.id); await read(fresh.id);
  const active = await send(); assert.equal(active.meta.hop, 6); assert.equal(active.meta.origin, "external");
  now += 3600000; writeFileSync(clock, String(now));
  const expired = await send(); assert.equal(expired.meta.hop ?? 0, 0); assert.equal(expired.meta.origin ?? "agent", "agent");
  await read(fresh.id);
  const renewed = await send(); assert.equal(renewed.meta.hop, 1); assert.equal(renewed.meta.origin ?? "agent", "agent");
});

for (const cli of ["claude", "codex", "kimi", "opencode"]) test(`${cli}: unrelated reads cannot renew expired high-depth or external exposure`, async t => {
  const home = mkdtempSync(join(tmpdir(), "mbx-relay-depth-"));
  const n = new MbxNode(home, { host: "alpha" }), c = new Client({ name: "relay-depth-test", version: "1" });
  t.after(async () => { await c.close(); n.close(); rmSync(home, { recursive: true, force: true }); });
  const clock = join(home, "clock"), preload = join(home, "clock.mjs");
  let now = Date.now(); writeFileSync(clock, String(now));
  writeFileSync(preload, `import {readFileSync} from 'node:fs'; Date.now = () => Number(readFileSync(${JSON.stringify(clock)}, 'utf8'));`);
  await c.connect(new StdioClientTransport({ command: process.execPath, args: ["--import", preload, join(import.meta.dirname, "../bin/agentmbx.js"), "mcp"],
    env: { ...process.env, AGENTMBX_DEV: "1", MBX_HOME: home, MBX_CLI: cli, MBX_AGENT: "reader", MBX_NO_DESKTOP: "1" } as Record<string, string> }));
  const old = n.send({ from: "sender", to: ["reader"], subject: "old context", body: "data", hop: 65, origin: "external" }).envelope;
  const fresh = n.send({ from: "sender", to: ["reader"], subject: "unrelated", body: "data" }).envelope;
  const read = async (id: string) => assert.notEqual((await c.callTool({ name: "mbx_read", arguments: { ids: [id] } })).isError, true);
  const send = async (to: string[]) => {
    const result = await c.callTool({ name: "mbx_send", arguments: { to, subject: "new work", body: "direct message" } });
    assert.notEqual(result.isError, true);
    return JSON.parse(n.message((result.structuredContent as { id: string }).id)!.envelope);
  };
  await read(old.id);
  // Unrelated reads retain their own depth without renewing the older exposure.
  for (let i = 0; i < 4; i++) {
    now += 30 * 60_000; writeFileSync(clock, String(now));
    await read(fresh.id);
    if (i === 0) {
      const middle = n.send({ from: "sender", to: ["reader"], subject: "newer internal exposure", body: "data", hop: 4 }).envelope;
      await read(middle.id);
    }
    for (const to of [["one"], ["one", "two"]]) {
      const sent = await send(to);
      assert.equal(sent.thread, sent.id);
      assert.notEqual(sent.thread, old.thread);
      assert.equal(sent.reply_to, null);
      assert.equal(sent.meta.hop, i === 0 ? 66 : i === 1 ? 5 : 1);
      assert.equal(sent.meta.origin ?? "agent", i === 0 ? "external" : "agent");
    }
  }
  // Explicit replies re-read their parent; expiry must not erase actual reply provenance.
  const reply = await c.callTool({ name: "mbx_reply", arguments: { id: old.id, body: "reply" } });
  assert.notEqual(reply.isError, true);
  const replied = JSON.parse(n.message((reply.structuredContent as { id: string }).id)!.envelope);
  assert.equal(replied.meta.hop, 66);
  assert.equal(replied.meta.origin, "external");

});
