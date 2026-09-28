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
  const c = new Client({ name: "opencode", version: "test" });
  t.after(async () => { await c.close(); n.close(); rmSync(home, { recursive: true, force: true }); });
  await c.connect(new StdioClientTransport({ command: process.execPath, args: [bin, "mcp"], env: { ...process.env, AGENTMBX_DEV: "1", MBX_HOME: home, MBX_CLI: "opencode", MBX_AGENT: "oc-test", MBX_NO_DESKTOP: "1" } as Record<string,string> }));
  const call = (sid: string, name: string, args = {}) => c.callTool({ name, arguments: args, _meta: { sessionID: sid } });
  const [a,b] = await Promise.all([call("ses_alpha", "mbx_whoami"), call("ses_beta", "mbx_whoami")]);
  const aa = a.structuredContent as {agent:string;session:string}, bb=b.structuredContent as {agent:string;session:string};
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
  assert.equal((await call("ses_conflict", "mbx_whoami")).isError, true, "a stale saved name cannot merge two live sessions");
  assert.equal(n.store.db.prepare("SELECT 1 FROM sessions WHERE session_id='ses_conflict'").get(), undefined);
  const invalid = await call("../bad", "mbx_whoami"); assert.equal(invalid.isError,true);
  const fallback = (await c.callTool({name:"mbx_whoami",arguments:{}})).structuredContent as {agent:string};
  assert.notEqual(fallback.agent,aa.agent); assert.notEqual(fallback.agent,bb.agent);
  await c.close();
  const rows = n.store.db.prepare("SELECT session_id,session_key FROM sessions WHERE session_id LIKE 'ses_%'").all();
  assert.equal(rows.length,2); assert.ok(rows.every(r=>r.session_key===null));
});
