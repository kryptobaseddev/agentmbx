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
    // Keep the lease valid while independently advancing the one-hour relay provenance clock.
    env: { ...process.env, AGENTMBX_DEV: "1", MBX_IDENTITY_IDLE_TTL_MS: "7200000", MBX_HOME: home, MBX_CLI: "claude", MBX_AGENT: "reader", MBX_NO_DESKTOP: "1" } as Record<string, string> }));
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
