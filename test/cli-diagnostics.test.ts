import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { MbxNode } from "../src/node.ts";
import { SCHEMA_VERSION } from "../src/store.ts";
const cli=(home:string,...args:string[])=>new Promise<{status:number|null;stdout:string;stderr:string}>((resolveResult,reject)=>{
 const child=spawn(process.execPath,[resolve("bin/agentmbx.js"),...args],{env:{...process.env,AGENTMBX_DEV:"1",MBX_HOME:home},stdio:["ignore","pipe","pipe"]});let stdout="",stderr="";
 child.stdout.on("data",x=>stdout+=x);child.stderr.on("data",x=>stderr+=x);child.on("error",reject);child.on("close",status=>resolveResult({status,stdout,stderr}));
});
function fixture(t:{after(fn:()=>void):void}){const home=mkdtempSync(join(tmpdir(),"mbx-cli-diag-")),node=new MbxNode(home,{host:"alpha",port:1});node.registerAgent("alice");node.registerAgent("bob");t.after(()=>{node.close();rmSync(home,{recursive:true,force:true});});return{home,node};}

test("diagnostics CLI reports exact mailbox/session with redaction and no byte-state changes",async t=>{
 const {home,node}=fixture(t),now=Date.now();
 node.store.db.prepare("INSERT INTO identity_leases VALUES (?,?,?,?,?,?,?,?,?,?,?,?)").run("alice","LEASE_SECRET",process.pid,"unknownbirth","CONTROL_SECRET","codex","thread-a",now,now,1800000,null,null);
 node.store.db.prepare("INSERT INTO sessions(agent,cli,session_id,pid,pid_start,session_key,updated_at) VALUES (?,?,?,?,?,?,?)").run("alice","codex","thread-a",process.pid,"unknownbirth","SESSION_SECRET",new Date(now).toISOString());
 const id=node.send({from:"alice",to:["bob"],subject:"PRIVATE_SUBJECT",body:"PRIVATE_BODY"}).envelope.id;
 for(const host of ["peer-a","peer-b"])node.store.db.prepare("INSERT INTO outbox(msg_id,host,next_at,created_at,last_error) VALUES (?,?,?,?,?)").run(id,host,"later","before","fetch failed password=PRIVATE_SECRET");
 const receipt=randomUUID();node.store.set(`identity-request:${receipt}`,JSON.stringify({id:receipt,action:"release",status:"pending",target:{agent:"alice",cli:"codex",session_id:"thread-a",control_key:"CONTROL_SECRET"},created_at:now,expires_at:now-1,approval:{secret:"OWNER_SECRET"}}));
 const tables=["messages","deliveries","identity_leases","kv","outbox"],rows=()=>tables.map(table=>node.store.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all());const before=rows();node.store.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");const bytes=readFileSync(join(home,"mbx.db"));
 const response=await cli(home,"diagnostics","--mailbox","alice","--cli","codex","--session","thread-a","--limit","1","--json");assert.equal(response.status,0,response.stderr);const s=JSON.parse(response.stdout);
 assert.equal(s.scope.mailbox,"alice");assert.equal(s.scope.session_id,"thread-a");assert.equal(s.builds.connector.version,null);assert.equal(s.builds.connector.binding_exists,true);assert.equal(s.daemon_connection.state,"unreachable");assert.equal(s.messages.queued_outgoing,1);assert.equal(s.outbox.length,1);assert.equal(s.recovery[0].status,"pending");assert(s.recovery_guidance.some((g:string)=>g.includes("mbx_whoami")));
 for(const secret of ["LEASE_SECRET","CONTROL_SECRET","SESSION_SECRET","PRIVATE_SUBJECT","PRIVATE_BODY","PRIVATE_SECRET","OWNER_SECRET"])assert(!response.stdout.includes(secret),secret);
 assert.deepEqual(rows(),before);assert.deepEqual(readFileSync(join(home,"mbx.db")),bytes);
});

test("daemon observed version is distinct from absent connector and malformed metadata",async t=>{
 const {home,node}=fixture(t);let payload:unknown={service:"agentmbx",v:1,host:"alpha",version:"0.1.0"},requests=0;
 const server=createServer((req,res)=>{requests++;assert.equal(req.url,"/v1/status");assert.equal(req.method,"GET");res.end(JSON.stringify(payload));});await new Promise<void>(r=>server.listen(0,"127.0.0.1",r));t.after(()=>server.close());const port=(server.address() as {port:number}).port;
 const config=JSON.parse(readFileSync(join(home,"config.json"),"utf8"));config.port=port;writeFileSync(join(home,"config.json"),JSON.stringify(config));
 const response=await cli(home,"diagnostics","--mailbox","alice","--json");assert.equal(response.status,0,response.stderr);const s=JSON.parse(response.stdout);assert.equal(s.builds.daemon.version,"0.1.0");assert.notEqual(s.builds.installed.version,"0.1.0");assert.equal(s.builds.connector.binding_exists,false);assert.equal(s.builds.connector.version,null);assert.equal(s.daemon_connection.state,"observed");
 payload={service:"other",v:1,host:"alpha",version:"9.9.9",secret:"SECRET"};const wrong=JSON.parse((await cli(home,"diagnostics","--mailbox","alice","--json")).stdout);assert.equal(wrong.builds.daemon.version,null);assert.equal(wrong.daemon_connection.state,"unknown");assert(!JSON.stringify(wrong).includes("SECRET"));
 payload="x".repeat(5000);const large=JSON.parse((await cli(home,"diagnostics","--mailbox","alice","--json")).stdout);assert.equal(large.daemon_connection.state,"unknown");assert.equal(requests,3);assert.equal(node.store.schemaVersion(),SCHEMA_VERSION);
});

test("disconnected released identity remains available with no automatic claim",async t=>{
 const {home,node}=fixture(t),now=Date.now();node.store.db.prepare("INSERT INTO identity_leases VALUES (?,?,?,?,?,?,?,?,?,?,?,?)").run("alice","SECRET",1,"oldbirth","KEY","opencode","old-thread",now-20,now-10,1800000,now-5,"explicit");
 const response=await cli(home,"diagnostics","--mailbox","alice","--json");assert.equal(response.status,0,response.stderr);const s=JSON.parse(response.stdout);assert.equal(s.ownership.state,"available");assert.equal(s.builds.connector.binding_exists,false);assert.equal(s.builds.connector.version,null);assert.equal(s.daemon_connection.state,"unreachable");
 assert.equal(node.store.db.prepare("SELECT released_at FROM identity_leases WHERE name='alice'").get()!.released_at,now-5);
 assert.match((await cli(home,"diagnostics","--mailbox","alice")).stdout,/connector unknown \(no binding recorded\)/);
});

test("help/invalid scope does not create stores and session mismatch fails closed",async t=>{
 const root=mkdtempSync(join(tmpdir(),"mbx-cli-diag-missing-")),home=join(root,"missing");t.after(()=>rmSync(root,{recursive:true,force:true}));
 assert.match((await cli(home,"diagnostics","--help")).stdout,/--mailbox/);
 for(const args of [[],["--mailbox","alice","--cli","codex"],["--mailbox","alice","--session","thread-a"],["--mailbox","alice","--limit","101"],["--mailbox","alice","--limit","1.5"],["--mailbox","alice","extra"]])assert.equal((await cli(home,"diagnostics",...args)).status,2);
 assert.equal((await cli(home,"diagnostics","--mailbox","alice","--json")).status,3);assert.equal(existsSync(home),false);
 const f=fixture(t);assert.equal((await cli(f.home,"diagnostics","--mailbox","alice","--cli","codex","--session","foreign","--json")).status,1);
});

test("legacy schema inventory is inspected without migration and future schema refused",async t=>{
 const {home,node}=fixture(t);node.store.db.exec("DROP TABLE identity_leases; PRAGMA user_version=1");node.store.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");const before=readFileSync(join(home,"mbx.db"));
 const old=await cli(home,"diagnostics","--mailbox","alice","--json");assert.equal(old.status,0,old.stderr);assert.equal(JSON.parse(old.stdout).schema_version,1);assert.deepEqual(readFileSync(join(home,"mbx.db")),before);
 node.store.db.exec(`PRAGMA user_version=${SCHEMA_VERSION+1}`);assert.equal((await cli(home,"diagnostics","--mailbox","alice","--json")).status,1);assert.equal(node.store.db.prepare("PRAGMA user_version").get()!.user_version,SCHEMA_VERSION+1);
});
