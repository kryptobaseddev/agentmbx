import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { MbxNode } from "../src/node.ts";

for (const cli of ["codex", "opencode"]) test(`${cli}: two readers of one live pipe refuse the duplicate before SDK initialization`, { timeout: 15000 }, async t => {
  const root = mkdtempSync(join(tmpdir(), "mbx-reader-gate-")), home = join(root, "mail");
  const node = new MbxNode(home, { host: "alpha" }), client = new Client({ name: "connection-gate", version: "1" });
  t.after(async () => { await client.close().catch(() => {}); node.close(); rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
  const manager = `import {spawn} from 'node:child_process';
    const children=[];let exited=0;
    for(let i=0;i<2;i++){const c=spawn(process.execPath,[${JSON.stringify(resolve("bin/agentmbx.js"))},'mcp'],{stdio:['inherit','inherit','pipe'],env:process.env});children.push(c);
      c.stderr.pipe(process.stderr,{end:false});c.on('exit',(code,signal)=>{console.error(JSON.stringify({candidate:c.pid,code,signal}));if(++exited===2)process.exit(0)});}
    process.on('SIGTERM',()=>{for(const c of children)c.kill('SIGTERM');setTimeout(()=>process.exit(0),1000).unref()});`;
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: join(root, "home"), XDG_CONFIG_HOME: join(root, "config"),
    XDG_DATA_HOME: join(root, "data"), XDG_CACHE_HOME: join(root, "cache"), XDG_STATE_HOME: join(root, "state"),
    AGENTMBX_DEV: "1", MBX_HOME: home, MBX_AGENT: "pipe-reader", MBX_CLI: cli, MBX_NO_DESKTOP: "1", MBX_SESSION_SOCKET: "0" };
  for (const key of Object.keys(env)) if (/^(?:MBX_MCP_|CLAUDE_|CODEX_|CLEO_|ORCA_)/.test(key)) delete env[key];
  const transport = new StdioClientTransport({ command: process.execPath, args: ["--input-type=module", "-e", manager], env: env as Record<string, string>, stderr: "pipe" });
  await client.connect(transport);
  let stderr = ""; transport.stderr?.on("data", data => { stderr += data; });
  const who = await client.callTool({ name: "mbx_whoami", arguments: {} });
  assert.equal((who.structuredContent as { agent: string }).agent, "pipe-reader");
  const deadline = Date.now() + 5000;
  while (!/"code":1/.test(stderr) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
  assert.match(stderr, /duplicate MCP client connection already served by pid \d+; refusing this reader/);
  assert.match(stderr, /"code":1/);
  assert.equal(node.store.db.prepare("SELECT COUNT(*) AS n FROM identity_leases WHERE released_at IS NULL").get()?.n, 1);
  assert.notEqual((await client.callTool({ name: "mbx_inbox", arguments: {} })).isError, true, "the retained reader still serves the same pipe");
});
