import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

test("MCP startup, rename and heartbeat inspect processes outside SQLite transactions", async t => {
  const home = mkdtempSync(join(tmpdir(), "mbx-preflight-")), trace = join(home, "trace.jsonl"), preload = join(home, "trace.mjs");
  const client = new Client({ name: "claude", version: "test" });
  t.after(async () => { await client.close(); rmSync(home, { recursive: true, force: true }); });
  writeFileSync(trace, "");
  // Test-only instrumentation checks real process discovery, not an implementation mock.
  writeFileSync(preload, `import {DatabaseSync} from 'node:sqlite'; import cp from 'node:child_process'; import fs from 'node:fs'; import {syncBuiltinESMExports} from 'node:module';
    const databases=new Set(), originalExec=DatabaseSync.prototype.exec;
    DatabaseSync.prototype.exec=function(...args){databases.add(this);return originalExec.apply(this,args)};
    const record=event=>fs.appendFileSync(${JSON.stringify(trace)},JSON.stringify({event,locked:[...databases].some(db=>db.isOpen&&db.isTransaction)})+'\\n');
    const exec=cp.execFileSync; cp.execFileSync=function(file,...args){if(String(file).split('/').pop()==='ps')record('ps');return exec.call(this,file,...args)};
    const read=fs.readFileSync; fs.readFileSync=function(path,...args){if(String(path).startsWith('/proc/'))record('proc');return read.call(this,path,...args)};
    syncBuiltinESMExports();
    const interval=globalThis.setInterval; globalThis.setInterval=(fn,delay,...args)=>interval(delay===60000?()=>{record('heartbeat');fn()}:fn,delay===60000?50:delay,...args);
  `);
  await client.connect(new StdioClientTransport({ command: process.execPath, args: ["--import", preload, join(import.meta.dirname, "../bin/agentmbx.js"), "mcp"],
    env: { ...process.env, AGENTMBX_DEV: "1", MBX_HOME: home, MBX_AGENT: "reader", MBX_CLI: "claude", MBX_NO_DESKTOP: "1" } as Record<string, string> }));
  assert.notEqual((await client.callTool({ name: "mbx_whoami", arguments: { name: "renamed" } })).isError, true);
  await new Promise(resolve => setTimeout(resolve, 200));
  assert.notEqual((await client.callTool({ name: "mbx_inbox", arguments: {} })).isError, true);
  await client.close();
  const events = readFileSync(trace, "utf8").trim().split("\n").map(line => JSON.parse(line)) as { event: string; locked: boolean }[];
  assert.ok(events.some(e => e.event === "heartbeat"));
  const inspections = events.filter(e => e.event !== "heartbeat");
  assert.ok(inspections.length > 0); assert.ok(inspections.every(e => !e.locked), JSON.stringify(inspections.filter(e => e.locked)));
});
