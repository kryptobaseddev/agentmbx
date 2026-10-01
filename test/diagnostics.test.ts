import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { MbxNode } from "../src/node.ts";
import { SCHEMA_VERSION } from "../src/store.ts";
import { connectorKey, diagnosticSnapshot, retryErrorClass } from "../src/diagnostics.ts";

function fixture(t: {after(fn:()=>void):void}) {
  const home=mkdtempSync(join(tmpdir(),"mbx-diagnostic-"));
  const node=new MbxNode(home,{host:"alpha"});
  t.after(()=>{node.close();rmSync(home,{recursive:true,force:true});});
  node.registerAgent("alice"); node.registerAgent("bob");
  const now=10000;
  node.store.db.prepare("INSERT INTO identity_leases VALUES (?,?,?,?,?,?,?,?,?,?,?,?)").run("alice","LEASE_SECRET",123,"birth","CONTROL_SECRET","codex","thread-a",now-100,now-50,1800000,null,null);
  node.store.db.prepare("INSERT INTO sessions(agent,cli,session_id,pid,pid_start,updated_at,session_key) VALUES (?,?,?,?,?,?,?)").run("alice","codex","thread-a",123,"birth",new Date(now).toISOString(),"SESSION_SECRET");
  return {home,node,now};
}
const unknown=()=>({alive:null,start:null});

test("diagnostics scope queues/receipts and preserve database bytes without leaking credentials",t=>{
 const {home,node,now}=fixture(t);
 const msg=node.send({from:"alice",to:["bob"],subject:"PRIVATE_SUBJECT",body:"PRIVATE_BODY"}).envelope.id;
 const other=node.send({from:"bob",to:["alice"],subject:"other",body:"OTHER_BODY"}).envelope.id;
 for(const [id,host] of [[msg,"peer-a"],[msg,"peer-b"],[other,"peer-a"]]) node.store.db.prepare("INSERT INTO outbox(msg_id,host,next_at,created_at,last_error) VALUES (?,?,?,?,?)").run(id,host,"later","before","fetch failed https://secret:password@host PRIVATE_BODY");
 const receipt=randomUUID();
 node.store.set(`identity-request:${receipt}`,JSON.stringify({id:receipt,action:"takeover",status:"pending",created_at:now-5,target:{agent:"alice",cli:"codex",session_id:"thread-a",control_key:"CONTROL_SECRET",generation:"TOKEN_HASH"},approval:{secret:"OWNER_GRANT"},result:{body:"PRIVATE_BODY"}}));
 node.store.set(`identity-request:${randomUUID()}`,JSON.stringify({id:randomUUID(),action:"claim",status:"failed",target:{agent:"bob",cli:"claude",session_id:"thread-b"},error:"SECRET_ERROR"}));
 for(const [i,value] of ["invalid","null","[]","42","{}"].entries()) node.store.set(`identity-request:legacy-${i}`,value);
 const tables=["messages","deliveries","outbox","identity_leases","kv"];
 const rows=()=>tables.map(table=>node.store.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all());
 const before=rows();node.store.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");const bytes=readFileSync(join(home,"mbx.db"));
 const snap=diagnosticSnapshot(home,{mailbox:"alice",cli:"codex",session_id:"thread-a",limit:1},{now,inspect:unknown});
 assert.equal(snap.messages.queued_outgoing,1);assert.equal(snap.outbox.length,1);assert.equal(snap.page.truncated.outbox,true);
 assert.equal(snap.recovery[0].receipt_id,receipt);assert.equal(snap.recovery[0].status,"pending");
 assert.equal(snap.builds.connector.version,null);assert.equal(snap.builds.connector.binding_exists,true);assert.equal(snap.ownership.state,"unknown");
 assert.equal(snap.messages.task_status,"not-reported");assert.equal(snap.outbox[0].last_error_code,"PEER_UNREACHABLE");
 for(const secret of ["LEASE_SECRET","CONTROL_SECRET","SESSION_SECRET","TOKEN_HASH","OWNER_GRANT","PRIVATE_BODY","PRIVATE_SUBJECT","OTHER_BODY","SECRET_ERROR","password"]) assert(!JSON.stringify(snap).includes(secret),secret);
 assert.deepEqual(rows(),before);assert.deepEqual(readFileSync(join(home,"mbx.db")),bytes);
});

test("runtime observations stay distinct and stale/unmatched daemon is unknown",t=>{
 const {home,now}=fixture(t);
 const snap=diagnosticSnapshot(home,{mailbox:"alice"},{now,inspect:()=>({alive:true,start:"birth"}),daemon:{host:"alpha",version:"0.1.0",observed_at:new Date(now-1).toISOString()}});
 assert.equal(snap.builds.daemon.version,"0.1.0");assert.notEqual(snap.builds.installed.version,"0.1.0");assert.equal(snap.builds.connector.version,null);assert.equal(snap.ownership.state,"held");
 for(const daemon of [{host:"other",version:"1.2.3",observed_at:new Date(now).toISOString()},{host:"alpha",version:"1.2.3",observed_at:new Date(now-70000).toISOString()},{host:"alpha",version:"secret",observed_at:"invalid"}]) assert.equal(diagnosticSnapshot(home,{mailbox:"alice"},{now,inspect:unknown,daemon}).builds.daemon.version,null);
});

test("scope validation never falls back globally and arrays remain bounded",t=>{
 const {home,node,now}=fixture(t);
 for(const scope of [{mailbox:"alice",limit:0},{mailbox:"alice",limit:101},{mailbox:"alice",limit:1.5},{mailbox:"alice",cli:"codex"},{mailbox:"alice",session_id:"thread-a"},{mailbox:"alice",cli:"bad\n",session_id:"s"}]) assert.throws(()=>diagnosticSnapshot(home,scope,{now}),{code:"INVALID_SCOPE"});
 assert.throws(()=>diagnosticSnapshot(home,{mailbox:"nobody"},{now}),{code:"SCOPE_NOT_FOUND"});
 assert.throws(()=>diagnosticSnapshot(home,{mailbox:"alice",cli:"claude",session_id:"thread-b"},{now}),{code:"SCOPE_NOT_FOUND"});
 for(let i=0;i<5;i++) node.store.set(`identity-request:${i}`,JSON.stringify({id:randomUUID(),action:"release",status:"failed",created_at:now,target:{agent:"alice",cli:"codex",session_id:"thread-a"},error:"TOKEN_PASSWORD_SECRET"}));
 const snap=diagnosticSnapshot(home,{mailbox:"alice",limit:2},{now,inspect:unknown});assert.equal(snap.recovery.length,2);assert.equal(snap.page.truncated.recovery,true);assert(snap.recovery.every(r=>r.error_code==="IDENTITY_CONTROL_FAILED"));
});

test("unknown versus PID reused stays advisory without releasing holder",t=>{
 const {home,node,now}=fixture(t);
 const a=diagnosticSnapshot(home,{mailbox:"alice"},{now,inspect:unknown});assert.equal(a.ownership.process,"unknown");assert.equal(a.ownership.state,"unknown");
 const b=diagnosticSnapshot(home,{mailbox:"alice"},{now,inspect:()=>({alive:true,start:"newbirth"})});assert.equal(b.ownership.process,"pid-reused");assert.equal(b.ownership.state,"available");
 assert.equal(node.store.db.prepare("SELECT released_at FROM identity_leases WHERE name='alice'").get()!.released_at,null);
});

test("missing/config invalid/future schema inspection does not initialize or migrate",t=>{
 const missing=mkdtempSync(join(tmpdir(),"mbx-diagnostic-missing-"));t.after(()=>rmSync(missing,{recursive:true,force:true}));
 assert.throws(()=>diagnosticSnapshot(missing,{mailbox:"alice"}),{code:"NOT_FOUND"});assert.equal(existsSync(join(missing,"mbx.db")),false);
 const {home,node}=fixture(t);node.store.db.exec(`PRAGMA user_version=${SCHEMA_VERSION+1}`);
 assert.throws(()=>diagnosticSnapshot(home,{mailbox:"alice"}),{code:"STALE_SERVER"});
 assert.equal(node.store.db.prepare("PRAGMA user_version").get()!.user_version,SCHEMA_VERSION+1);
 writeFileSync(join(home,"config.json"),"null");assert.throws(()=>diagnosticSnapshot(home,{mailbox:"alice"}),{code:"INVALID_SCOPE"});
});

test("error classifier emits only fixed classes",()=>{
 assert.equal(retryErrorClass("ETIMEDOUT secret"),"TIMEOUT");assert.equal(retryErrorClass("403 secret"),"PEER_REFUSED");assert.equal(retryErrorClass("arbitrary secret"),"DELIVERY_FAILED");assert.equal(retryErrorClass(null),null);
});

test("session rows compare process birth in their own format, not the lease format (T183)",t=>{
 const {home,now}=fixture(t);
 // the lease records "ps-utc:" birth, a session row the process-table form: each is compared like with like
 const snap=diagnosticSnapshot(home,{mailbox:"alice"},{now,inspect:()=>({alive:true,start:"ps-utc:other-form"}),inspectSession:()=>({alive:true,start:"birth"})});
 assert.equal(snap.sessions[0].process,"verified");
});

test("the running connector's version, build and tools are reported only for the verified current holder (T183)",t=>{
 const {home,node,now}=fixture(t);
 const report=(r:Record<string,unknown>)=>node.store.set(connectorKey(123),JSON.stringify({v:1,pid:123,start:"birth",version:"0.5.1",build:"0.5.1:1:2",tools:["mbx_send","mbx_inbox"],cli:"codex",at:new Date(now-1000).toISOString(),...r}));
 const live={now,inspect:()=>({alive:true,start:"birth"})};
 assert.equal(diagnosticSnapshot(home,{mailbox:"alice"},live).builds.connector.reason,"connector build has no verified runtime observation");
 report({});
 const c=diagnosticSnapshot(home,{mailbox:"alice"},live).builds.connector;
 assert.deepEqual([c.version,c.build,c.tools,c.reason],["0.5.1","0.5.1:1:2",["mbx_send","mbx_inbox"],null]);
 assert.equal(diagnosticSnapshot(home,{mailbox:"alice"},live).builds.installed.version!==undefined,true,"installed stays a separate field");
 assert.equal(diagnosticSnapshot(home,{mailbox:"alice"},{now,inspect:()=>({alive:true,start:"newbirth"})}).builds.connector.version,null,"a reused PID's report does not count");
 report({start:"older"});
 assert.equal(diagnosticSnapshot(home,{mailbox:"alice"},live).builds.connector.reason,"connector report is not from the current holder process");
 report({at:new Date(now-10*60_000).toISOString()});
 assert.equal(diagnosticSnapshot(home,{mailbox:"alice"},live).builds.connector.reason,"connector report is stale");
 report({version:"evil string"});
 assert.equal(diagnosticSnapshot(home,{mailbox:"alice"},live).builds.connector.reason,"connector report is malformed");
});
