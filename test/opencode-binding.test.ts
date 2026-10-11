import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { MbxNode } from "../src/node.ts";

const bin = join(import.meta.dirname, "../bin/agentmbx.js");
test("OpenCode metadata isolates sessions, binds wake IDs, and scopes cleanup", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "mbx-oc-"));
  const n = new MbxNode(home, { host: "alpha" });
  n.registerAgent("receiver"); // T205: sends need an existing recipient
  const c = new Client({ name: "opencode", version: "test" });
  t.after(async () => { await c.close(); n.close(); rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
  await c.connect(new StdioClientTransport({ command: process.execPath, args: [bin, "mcp"], env: { ...process.env, AGENTMBX_DEV: "1", MBX_HOME: home, MBX_CLI: "opencode", MBX_AGENT: "oc-test", MBX_NO_DESKTOP: "1" } as Record<string,string> }));
  const call = (sid: string, name: string, args = {}) => c.callTool({ name, arguments: args, _meta: { sessionID: sid } });
  // T204: sessions start unbound (never on the transport's launch name or a derived one); each registers its own identity.
  const [ua, ub] = await Promise.all([call("ses_alpha", "mbx_whoami"), call("ses_beta", "mbx_whoami")]);
  assert.deepEqual([(ua.structuredContent as {agent:string|null}).agent, (ub.structuredContent as {agent:string|null}).agent], [null, null]);
  assert.equal(n.store.db.prepare("SELECT COUNT(*) c FROM sessions WHERE session_id LIKE 'ses_%'").get()!.c, 0, "an unbound session binds nothing");
  for (const [sid, name] of [["ses_alpha", "alpha"], ["ses_beta", "beta"]]) assert.notEqual((await call(sid, "mbx_identity", { action: "register", name, role: "builder" })).isError, true);
  const [a,b] = await Promise.all([call("ses_alpha", "mbx_whoami"), call("ses_beta", "mbx_whoami")]);
  const aa = a.structuredContent as {agent:string;session:string}, bb=b.structuredContent as {agent:string;session:string};
  assert.deepEqual([aa.agent, bb.agent], ["alpha", "beta"]);
  const namespaced = await c.callTool({ name: "mbx_whoami", arguments: {}, _meta: { "ai.opencode/sessionID": "ses_alpha" } });
  assert.equal((namespaced.structuredContent as {agent:string}).agent, aa.agent);
  const conflict = await c.callTool({ name: "mbx_whoami", arguments: {}, _meta: { "ai.opencode/sessionID": "ses_alpha", sessionID: "ses_beta" } });
  assert.equal(conflict.isError, true);
  for (const value of [null, 17, "", "../bad"]) {
    const invalid = await c.callTool({ name: "mbx_whoami", arguments: {}, _meta: { "ai.opencode/sessionID": value } });
    assert.equal(invalid.isError, true);
  }
  assert.notEqual(aa.agent, bb.agent);
  assert.notEqual(aa.session, bb.session);
  assert.deepEqual(n.store.db.prepare("SELECT session_id FROM sessions WHERE session_id LIKE 'ses_%' ORDER BY session_id").all().map(r=>r.session_id), ["ses_alpha","ses_beta"]);
  const id = n.send({from:"sender",to:[aa.agent],subject:"private",body:"alpha only",origin:"external",hop:3}).envelope.id;
  assert.equal((await call("ses_beta", "mbx_read", {ids:[id]})).isError, true);
  assert.notEqual((await call("ses_alpha", "mbx_read", {ids:[id]})).isError, true);
  const sent = await call("ses_beta", "mbx_send", {to:["receiver"],subject:"independent",body:"hello"});
  const e = JSON.parse(n.message((sent.structuredContent as {id:string}).id)!.envelope);
  assert.equal(e.meta.hop ?? 0,0); assert.notEqual(e.meta.origin,"external");
  await call("ses_alpha", "mbx_whoami", {name:"alpha-renamed"});
  assert.equal(((await call("ses_beta", "mbx_whoami")).structuredContent as {agent:string}).agent,bb.agent);
  assert.equal(((await call("ses_alpha", "mbx_whoami")).structuredContent as {agent:string}).agent,"alpha-renamed");
  n.keepName("opencode", "ses_conflict", bb.agent);
  const prior = n.store.db.prepare("SELECT token FROM identity_leases WHERE name=?").get(bb.agent)!;
  const privateBeta = n.send({from:"sender",to:[bb.agent],subject:"private beta",body:"beta only"}).envelope.id;
  const recovered = await call("ses_conflict", "mbx_whoami");
  assert.notEqual(recovered.isError, true, "a conflicting saved name keeps recovery controls reachable");
  const pending = recovered.structuredContent as {agent:string|null;pending:string;unbound:boolean};
  assert.deepEqual([pending.agent, pending.unbound, pending.pending], [null, true, bb.agent], "a stale saved name cannot merge two live sessions, and no substitute name is minted");
  assert.notEqual((await call("ses_conflict", "mbx_identity", {action:"list"})).isError, true);
  assert.equal((await call("ses_conflict", "mbx_read", {ids:[privateBeta]})).isError, true);
  assert.deepEqual(n.store.db.prepare("SELECT token FROM identity_leases WHERE name=?").get(bb.agent), prior);
  assert.equal(((await call("ses_beta", "mbx_whoami")).structuredContent as {agent:string;session:string}).session, bb.session);
  const invalid = await call("../bad", "mbx_whoami"); assert.equal(invalid.isError,true);
  const noMeta = await c.callTool({name:"mbx_whoami",arguments:{}});
  assert.equal(noMeta.isError, true, "metadata-free calls cannot use the transport's launch identity either");
  assert.match(JSON.stringify(noMeta.content), /session metadata is required/);
  await c.close();
  const rows = n.store.db.prepare("SELECT session_id,session_key FROM sessions WHERE session_id LIKE 'ses_%'").all();
  assert.deepEqual(rows.map(r => r.session_id).sort(), ["ses_alpha", "ses_beta"], "the unbound conflicting session never bound"); assert.ok(rows.every(r=>r.session_key===null));
});
