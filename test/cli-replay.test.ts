import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { MbxNode } from "../src/node.ts";
const command = (home: string, ...args: string[]) => spawnSync(process.execPath, [resolve("bin/agentmbx.js"), "replay", ...args], {
  encoding: "utf8", timeout: 10000, env: { ...process.env, MBX_HOME: home, AGENTMBX_DEV: "1", MBX_AGENT: "" },
});
for (const provider of ["claude", "codex"]) test(`${provider} CLI replay parity, retries, scope errors and released holder fencing`, async t => {
  const home = mkdtempSync(join(tmpdir(), "mbx-cli-replay-")), node = new MbxNode(home, { host: "alpha" });
  const client = new Client({ name: provider, version: "test" });
  t.after(async () => { await client.close(); node.close(); rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [resolve("bin/agentmbx.js"), "mcp"],
    env: { ...process.env, MBX_HOME: home, MBX_AGENT: "reader", MBX_CLI: provider, AGENTMBX_DEV: "1" } as Record<string,string> }));
  const meta = provider === "codex" ? { threadId: "55555555-5555-4555-8555-555555555555" } : undefined;
  const call = (name: string, args: Record<string,unknown> = {}) => client.callTool({ name, arguments: args, ...(meta ? { _meta: meta } : {}) });
  // A shared transport's session starts unbound and registers its own identity (T204); MBX_AGENT names only the transport.
  if (meta) assert.notEqual((await call("mbx_identity", { action: "register", name: "session-reader", role: "reader" })).isError, true);
  const me = (await call("mbx_whoami")).structuredContent as { agent: string };
  const sid = node.store.db.prepare("SELECT session_id FROM sessions WHERE agent=? AND session_key IS NOT NULL").get(me.agent)!.session_id as string;
  const selected = ["--cli", provider, "--session", sid, "--as", me.agent];
  const ids = [1,2,3].map(i => node.send({ from: "sender", to: [me.agent], subject: `mail ${i}`, body: "data" }).envelope.id);
  const before = node.store.db.prepare("SELECT * FROM deliveries ORDER BY msg_id,agent").all();
  const cli = command(home, ...selected, "--limit", "1", "--max-bytes", "2048");
  assert.equal(cli.status, 0, cli.stderr); assert.ok(Buffer.byteLength(cli.stdout.trim()) <= 2048);
  const first = JSON.parse(cli.stdout);
  const mcp = await call("mbx_replay", { limit: 1, max_bytes: 2048 });
  assert.deepEqual(first, JSON.parse((mcp.content as {text:string}[])[0].text));
  const retry = command(home, ...selected, "--cursor", first.next_cursor, "--limit", "1");
  assert.equal(retry.status, 0, retry.stderr);
  assert.deepEqual(JSON.parse(command(home, ...selected, "--cursor", first.next_cursor, "--limit", "1").stdout), JSON.parse(retry.stdout));
  assert.deepEqual(first.messages.map((m: {id:string})=>m.id), [ids[0]]);
  assert.deepEqual(JSON.parse(command(home, ...selected).stdout).messages.map((m: {id:string})=>m.id), ids, "lost cursor explicitly rewinds");
  for (const options of [["--cursor", "invalid"], ["--limit", "NaN"], ["--cursor", first.next_cursor, "--topic", "different"], ["--project", "unbound"], ["--as", "someone-else"]])
    assert.notEqual(command(home, ...selected, ...options).status, 0);
  assert.deepEqual(node.store.db.prepare("SELECT * FROM deliveries ORDER BY msg_id,agent").all(), before);
  await call("mbx_identity", { action: "release" });
  assert.notEqual(command(home, ...selected, "--cursor", first.next_cursor).status, 0);
  await client.close();
  const nextProvider = provider === "claude" ? "codex" : "claude";
  const replacement = new Client({ name: nextProvider, version: "test" });
  t.after(()=>replacement.close());
  await replacement.connect(new StdioClientTransport({command:process.execPath,args:[resolve("bin/agentmbx.js"),"mcp"],
    env:{...process.env,MBX_HOME:home,MBX_AGENT:me.agent,MBX_CLI:nextProvider,AGENTMBX_DEV:"1"} as Record<string,string>}));
  const nextMeta = nextProvider === "codex" ? {threadId:"66666666-6666-4666-8666-666666666666"} : undefined;
  const nextWho = await replacement.callTool({name:"mbx_whoami",arguments:{},...(nextMeta?{_meta:nextMeta}:{})});
  if ((nextWho.structuredContent as {agent:string}).agent !== me.agent) {
    for (const arguments_ of [{action:"release"},{action:"claim",name:me.agent}]) {
      const result = await replacement.callTool({name:"mbx_identity",arguments:arguments_,...(nextMeta?{_meta:nextMeta}:{})});
      assert.notEqual(result.isError,true,JSON.stringify(result));
    }
  }
  const confirmed = await replacement.callTool({name:"mbx_whoami",arguments:{},...(nextMeta?{_meta:nextMeta}:{})});
  assert.equal((confirmed.structuredContent as {agent:string}).agent,me.agent);
  const nextSid = node.store.db.prepare("SELECT session_id FROM sessions WHERE agent=? AND cli=? AND session_key IS NOT NULL ORDER BY rowid DESC LIMIT 1").get(me.agent,nextProvider)!.session_id as string;
  const resumed = command(home,"--cli",nextProvider,"--session",nextSid,"--cursor",first.next_cursor,"--limit","1");
  assert.equal(resumed.status,0,resumed.stderr);
  assert.deepEqual(JSON.parse(resumed.stdout),JSON.parse(retry.stdout),"same persona continues after explicit cross-provider release/claim");
  assert.deepEqual(node.store.db.prepare("SELECT * FROM deliveries ORDER BY msg_id,agent").all(),before);

});
test("bare shell name cannot authorize replay", t => {
  const home = mkdtempSync(join(tmpdir(), "mbx-cli-replay-denied-")), node = new MbxNode(home, {host:"alpha"});
  t.after(()=>{ node.close(); rmSync(home,{recursive:true,force:true}); });
  const id = node.send({from:"sender",to:["offline"],subject:"private",body:"secret"}).envelope.id;
  const result = command(home,"--as","offline");
  assert.notEqual(result.status,0); assert.doesNotMatch(result.stdout,/secret|private/);
  assert.equal(node.inbox("offline")[0].id,id); assert.equal(node.inbox("offline")[0].state,"delivered");
});
