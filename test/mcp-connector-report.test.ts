// T183: a running MCP connector reports its own version, loaded build and tool catalog, separate from the installed CLI.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { MbxNode } from "../src/node.ts";
import { connectorKey, diagnosticSnapshot } from "../src/diagnostics.ts";
import { version } from "../src/version.ts";

test("the connector's self-report matches its live tool catalog and is visible in diagnostics", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "mbx-connector-"));
  const n = new MbxNode(home, { host: "alpha" }), c = new Client({ name: "connector-report-test", version: "1" });
  const transport = new StdioClientTransport({ command: process.execPath, args: [join(import.meta.dirname, "../bin/agentmbx.js"), "mcp"],
    env: { ...process.env, AGENTMBX_DEV: "1", MBX_HOME: home, MBX_CLI: "claude", MBX_AGENT: "reporter", MBX_NO_DESKTOP: "1" } as Record<string, string> });
  t.after(async () => { await c.close(); n.close(); rmSync(home, { recursive: true, force: true }); });
  await c.connect(transport);
  await c.callTool({ name: "mbx_whoami", arguments: {} });
  const listed = (await c.listTools()).tools.map((x) => x.name).sort();
  const raw = n.store.get(connectorKey(transport.pid!));
  assert.ok(raw, "the connector published a report under its own PID");
  const report = JSON.parse(raw!);
  assert.equal(report.version, version());
  assert.deepEqual(report.tools, listed, "the reported catalog is the advertised catalog");
  const snap = diagnosticSnapshot(home, { mailbox: "reporter" });
  assert.equal(snap.builds.connector.version, version(), JSON.stringify(snap.builds.connector));
  assert.deepEqual(snap.builds.connector.tools, listed);
});

test("mbx_ack accepts an over-long did for a batch, acks every id and returns the truncation warning", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "mbx-ack-did-"));
  const n = new MbxNode(home, { host: "alpha" }), c = new Client({ name: "ack-did-test", version: "1" });
  t.after(async () => { await c.close(); n.close(); rmSync(home, { recursive: true, force: true }); });
  await c.connect(new StdioClientTransport({ command: process.execPath, args: [join(import.meta.dirname, "../bin/agentmbx.js"), "mcp"],
    env: { ...process.env, AGENTMBX_DEV: "1", MBX_HOME: home, MBX_CLI: "claude", MBX_AGENT: "worker", MBX_NO_DESKTOP: "1" } as Record<string, string> }));
  await c.callTool({ name: "mbx_whoami", arguments: {} });
  const ids = Array.from({ length: 6 }, (_, i) => n.send({ from: "sender", to: ["worker"], subject: `q${i}`, body: "question", kind: "request" }).envelope.id);
  const r = await c.callTool({ name: "mbx_ack", arguments: { ids, did: "D".repeat(289) } });
  assert.notEqual(r.isError, true, JSON.stringify(r.content));
  assert.match((r.content as { text: string }[])[0].text, /warning: did was 289 characters/);
  assert.equal(n.inbox("worker").length, 0);
  assert.equal((n.store.db.prepare("SELECT count(*) n FROM audit WHERE event='peer_action' AND detail LIKE '%did_truncated%'").get() as { n: number }).n, 6);
});
