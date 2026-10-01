import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { MbxNode } from "../src/node.ts";

test("Codex thread metadata isolates daemon mailboxes; a remembered name two threads collide on is never adopted", async (t) => {
  const home=mkdtempSync(join(tmpdir(),"mbx-codex-")), n=new MbxNode(home,{host:"alpha"});
  const c=new Client({name:"codex",version:"test"});
  t.after(async()=>{await c.close();n.close();rmSync(home,{recursive:true,force:true});});
  const a="01a0e578-d883-7e93-92e3-fbef626be300",b="01a0e4c4-0f62-7ae1-8c1f-618c71fe02ee";
  for(const id of [a,b]){n.bindSession({agent:"shared",cli:"codex",session_id:id,pid:process.pid});n.keepName("codex",id,"shared");}
  const mail=n.send({from:"sender",to:["shared"],subject:"ambiguous history",body:"preserve"}).envelope.id;
  await c.connect(new StdioClientTransport({command:process.execPath,args:[join(import.meta.dirname,"../bin/agentmbx.js"),"mcp"],env:{...process.env,AGENTMBX_DEV:"1",MBX_HOME:home,MBX_CLI:"codex",MBX_AGENT:"shared",MBX_NO_DESKTOP:"1"} as Record<string,string>}));
  const call=(threadId:string,name:string,args={})=>c.callTool({name,arguments:args,_meta:{threadId,sessionId:"execution-not-thread"}});
  // T204: both threads remember "shared", whose legacy holders are ambiguous. Neither adopts it and neither gets a substitute.
  const [x,y]=await Promise.all([call(a,"mbx_whoami"),call(b,"mbx_whoami")]);
  assert.equal((x.structuredContent as {agent:string|null}).agent,null);assert.equal((y.structuredContent as {agent:string|null}).agent,null);
  assert.equal(n.store.db.prepare("SELECT COUNT(*) c FROM identity_leases").get()!.c,0,"no name was invented for either thread");
  assert.equal((await call(a,"mbx_read",{ids:[mail]})).isError,true);
  assert.equal(n.inbox("shared")[0].id,mail);
  // Each thread chooses its own identity; the mailboxes stay isolated by thread.
  for(const [thread,name] of [[a,"thread-a"],[b,"thread-b"]] as const)
    assert.notEqual((await call(thread,"mbx_identity",{action:"register",name,role:"builder"})).isError,true);
  const aa=(await call(a,"mbx_whoami")).structuredContent as {agent:string;session:string},bb=(await call(b,"mbx_whoami")).structuredContent as {agent:string;session:string};
  assert.deepEqual([aa.agent,bb.agent],["thread-a","thread-b"]);assert.notEqual(aa.session,bb.session);
  const id=n.send({from:"sender",to:[aa.agent],subject:"private",body:"for a"}).envelope.id;
  assert.equal((await call(b,"mbx_read",{ids:[id]})).isError,true);
  assert.notEqual((await call(a,"mbx_ack",{ids:[id]})).isError,true);
  const row=n.store.db.prepare("SELECT agent FROM sessions WHERE cli='codex' AND session_id=?").get(a);
  assert.equal(row?.agent,aa.agent);
  assert.equal(n.store.db.prepare("SELECT 1 FROM sessions WHERE session_id='execution-not-thread'").get(),undefined);
  assert.equal((await call("invalid","mbx_whoami")).isError,true);
  const absent=(await c.callTool({name:"mbx_whoami",arguments:{},_meta:{sessionId:a}})).structuredContent as {agent:string|null;pending:string|null};
  assert.deepEqual([absent.agent,absent.pending],[null,"shared"],"unscoped calls use the transport's own launch identity, here pending and unadopted");
  assert.equal(n.inbox("shared")[0].id,mail,"ambiguous legacy history remains untouched");
  await c.close();
  assert.ok(n.store.get("identity-conflict:shared"));
  const next=new Client({name:"codex",version:"test"});t.after(()=>next.close());
  await next.connect(new StdioClientTransport({command:process.execPath,args:[join(import.meta.dirname,"../bin/agentmbx.js"),"mcp"],env:{...process.env,AGENTMBX_DEV:"1",MBX_HOME:home,MBX_CLI:"codex",MBX_AGENT:"shared",MBX_NO_DESKTOP:"1"} as Record<string,string>}));
  const nextWho=(await next.callTool({name:"mbx_whoami",arguments:{}})).structuredContent as {agent:string|null;pending:string|null};
  assert.deepEqual([nextWho.agent,nextWho.pending],[null,"shared"]);
  assert.equal(n.store.db.prepare("SELECT 1 FROM identity_leases WHERE name='shared'").get(),undefined);
  assert.equal(n.inbox("shared")[0].id,mail,"reconnect does not adopt history after legacy rows migrate away");
  await next.close();
});
