import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { MbxNode } from "./src/node.ts";
import { SCHEMA_VERSION } from "./src/store.ts";

test("debug every MCP tool refuses an upgraded schema", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "mbx-upgrade-"));
  const n = new MbxNode(home, { host: "alpha" });
  const client = new Client({ name: "upgrade-test", version: "1" });
  t.after(async () => { await client.close(); n.close(); rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [join(import.meta.dirname, "bin/agentmbx.js"), "mcp"],
    env: { ...process.env, MBX_HOME: home, MBX_AGENT: "worker", MBX_CLI: "claude", MBX_CHANNEL: "0", AGENTMBX_DEV: "1" } }));
  const tools = (await client.listTools()).tools;
  n.store.db.exec(`PRAGMA user_version=${SCHEMA_VERSION + 1}`);
  console.log("tools:", tools.map(t => t.name).join(","));
  for (const tool of tools) {
    try {
      const result = await client.callTool({ name: tool.name, arguments: {} });
      console.log(tool.name, "->", result.isError ? "ERROR" : "OK");
    } catch (e) {
      console.log(tool.name, "-> EXCEPTION", (e as Error).message);
      break;
    }
  }
});
