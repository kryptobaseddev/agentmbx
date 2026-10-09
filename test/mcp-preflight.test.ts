import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { MbxNode } from "../src/node.ts";

test("MCP startup, rename and heartbeat inspect processes outside SQLite transactions", async t => {
  const home = mkdtempSync(join(tmpdir(), "mbx-preflight-")), trace = join(home, "trace.jsonl"), preload = join(home, "trace.mjs");
  const client = new Client({ name: "claude", version: "test" });
  t.after(async () => { await client.close(); rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
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

for (const cli of ["claude", "codex", "kimi", "opencode"]) for (const changed of ["binding", "child"]) test(`${cli} does not adopt a legacy ${changed} replaced after process preflight`, async t => {
  const home = mkdtempSync(join(tmpdir(), "mbx-preflight-rebind-")), preload = join(home, "rebind.mjs"), marker = join(home, "rebound");
  const node = new MbxNode(home, { host: "alpha" }), client = new Client({ name: cli, version: "test" });
  t.after(async () => { await client.close(); node.close(); rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
  node.bindSession({ agent: "reader", cli, session_id: "legacy", pid: process.pid, session_key: "previous-holder" });
  if (changed === "child") node.store.set("mcp-process:previous-holder", JSON.stringify({ pid: 2_000_000_000, start: "old-generation" }));
  const id = node.send({ from: "sender", to: ["reader"], subject: "old mail", body: "retain ownership" }).envelope.id;
  // A second connection commits a hook-like rebind after the preflight SELECT has captured
  // its rows, but before MCP opens its write transaction. The replacement is otherwise a
  // valid unique hook binding for the same parent process; parent liveness alone is insufficient.
  writeFileSync(preload, `import {DatabaseSync} from 'node:sqlite'; import {writeFileSync} from 'node:fs';
    const prepare=DatabaseSync.prototype.prepare; let changed=false;
    DatabaseSync.prototype.prepare=function(sql,...args){
      const statement=prepare.call(this,sql,...args);
      if(sql.startsWith('SELECT agent,cli,session_id,pid,pid_start,session_key,updated_at')){
        const all=statement.all; statement.all=function(...args){const rows=all.apply(this,args);
          if(!changed){changed=true; const other=new DatabaseSync(${JSON.stringify(join(home, "mbx.db"))});
            if(${JSON.stringify(changed)}==='child') {
              prepare.call(other,'UPDATE kv SET v=? WHERE k=?').run(JSON.stringify({pid:2000000000,start:'new-generation'}),'mcp-process:previous-holder');
            } else {
              prepare.call(other,'UPDATE sessions SET session_key=NULL,updated_at=? WHERE cli=? AND session_id=?').run(new Date().toISOString(),${JSON.stringify(cli)},'legacy');
            }
            other.close(); writeFileSync(${JSON.stringify(marker)},'committed');}
          return rows;};
      } return statement;
    };
  `);
  await client.connect(new StdioClientTransport({ command: process.execPath, args: ["--import", preload, join(import.meta.dirname, "../bin/agentmbx.js"), "mcp"],
    env: { ...process.env, AGENTMBX_DEV: "1", MBX_HOME: home, MBX_AGENT: "reader", MBX_CLI: cli, MBX_NO_DESKTOP: "1" } as Record<string, string> }));
  // The ambiguous legacy holder is never adopted, and no substitute name is invented: the session stays unbound (T204).
  const identity = (await client.callTool({ name: "mbx_whoami", arguments: {} })).structuredContent as { agent: string | null; pending: string | null };
  assert.equal(readFileSync(marker, "utf8"), "committed");
  assert.deepEqual([identity.agent, identity.pending], [null, "reader"]);
  assert.equal(node.store.db.prepare("SELECT COUNT(*) n FROM identity_leases").get()!.n, 0);
  assert.equal((await client.callTool({ name: "mbx_read", arguments: { ids: [id] } })).isError, true);
  assert.equal(node.inbox("reader")[0].id, id);
  assert.equal(node.store.db.prepare("SELECT 1 FROM identity_leases WHERE name='reader'").get(), undefined);
});
