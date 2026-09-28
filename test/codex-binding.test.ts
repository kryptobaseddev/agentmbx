import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { MbxNode } from "../src/node.ts";

test("Codex thread metadata isolates daemon mailboxes and recovers colliding hook names", async (t) => {
  const home=mkdtempSync(join(tmpdir(),"mbx-codex-")), n=new MbxNode(home,{host:"alpha"});
  const c=new Client({name:"codex",version:"test"});
  t.after(async()=>{await c.close();n.close();rmSync(home,{recursive:true,force:true});});
  const a="01a0e578-d883-7e93-92e3-fbef626be300",b="01a0e4c4-0f62-7ae1-8c1f-618c71fe02ee";
  for(const id of [a,b]){n.bindSession({agent:"shared",cli:"codex",session_id:id,pid:process.pid});n.keepName("codex",id,"shared");}
  const mail=n.send({from:"sender",to:["shared"],subject:"ambiguous history",body:"preserve"}).envelope.id;
  await c.connect(new StdioClientTransport({command:process.execPath,args:[join(import.meta.dirname,"../bin/agentmbx.js"),"mcp"],env:{...process.env,AGENTMBX_DEV:"1",MBX_HOME:home,MBX_CLI:"codex",MBX_AGENT:"shared",MBX_NO_DESKTOP:"1"} as Record<string,string>}));
  const call=(threadId:string,name:string,args={})=>c.callTool({name,arguments:args,_meta:{threadId,sessionId:"execution-not-thread"}});
  const [x,y]=await Promise.all([call(a,"mbx_whoami"),call(b,"mbx_whoami")]);
  const aa=x.structuredContent as {agent:string;session:string},bb=y.structuredContent as {agent:string;session:string};
  assert.notEqual(aa.agent,bb.agent);assert.notEqual(aa.agent,"shared");assert.notEqual(bb.agent,"shared");assert.notEqual(aa.session,bb.session);
  assert.equal(n.inbox("shared")[0].id,mail);
  const id=n.send({from:"sender",to:[aa.agent],subject:"private",body:"for a"}).envelope.id;
  assert.equal((await call(b,"mbx_read",{ids:[id]})).isError,true);
  assert.notEqual((await call(a,"mbx_ack",{ids:[id]})).isError,true);
  const row=n.store.db.prepare("SELECT agent FROM sessions WHERE cli='codex' AND session_id=?").get(a);
  assert.equal(row?.agent,aa.agent);
  assert.equal(n.store.db.prepare("SELECT 1 FROM sessions WHERE session_id='execution-not-thread'").get(),undefined);
  assert.equal((await call("invalid","mbx_whoami")).isError,true);
  const absent=await c.callTool({name:"mbx_whoami",arguments:{},_meta:{sessionId:a}});
  const provisional=(absent.structuredContent as {agent:string}).agent;
  assert.match(provisional,/^shared-mcp-\d+$/,"unscoped calls use an isolated provisional mailbox");
  assert.notEqual(provisional,aa.agent,"execution ID cannot substitute for thread ID");
  assert.equal(n.inbox("shared")[0].id,mail,"ambiguous legacy history remains untouched");
});
