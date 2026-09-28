import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { MbxNode } from "../src/node.ts";
import { prepareBinding, startBinding, observeBinding, inspectBinding, BOOTSTRAP } from "../scripts/e2e/opencode-binding.ts";

const rev = () => "test-revision";
function prepared(t: { after: (fn: () => void) => void }) {
  const value = prepareBinding("test-model", rev);
  t.after(() => rmSync(dirname(value.path), { recursive: true, force: true }));
  return value;
}

test("native binding bootstrap is once-only and observation preserves permission prompts", async t => {
  const { path, state } = prepared(t), calls: string[] = [];
  const config = JSON.parse(readFileSync(join(state.work, "opencode.json"), "utf8"));
  assert.equal(config.permission, undefined);
  assert.equal(config.mcp.servers.mbx.environment.MBX_HOME, state.home);
  const api = async (method: string, url: string, body?: any) => {
    calls.push(`${method} ${url}`);
    if (method === "POST" && url === "/api/session") return { data: { id: "ses_bindingTest" } };
    if (method === "POST" && url.endsWith("/synthetic")) { assert.equal(body.text, BOOTSTRAP); return {}; }
    if (method === "GET" && url.endsWith("/permission")) return { data: [{ id: "per_prompt", action: "mbx_whoami" }] };
    if (method === "GET" && url.endsWith("/message")) return { data: [] };
    if (method === "GET") return { data: { time: { idle: 1 } } };
    throw new Error("unexpected provider mutation");
  };
  assert.equal((await observeBinding(path, api, inspectBinding, rev)).outcome, "not_started");
  assert.equal(calls.length, 0);
  await startBinding(path, api, rev);
  await assert.rejects(startBinding(path, api, rev), /already attempted/);
  const before = calls.length;
  const result = await observeBinding(path, api, inspectBinding, rev);
  assert.equal(result.outcome, "awaiting_owner_approval");
  assert.equal(result.binding.verified, false);
  assert.equal(result.receiptVerified, false);
  assert.ok(calls.slice(before).every(call => call.startsWith("GET ")));
  assert.equal(calls.filter(call => call.startsWith("POST ")).length, 2);
});

for (const at of ["create", "bootstrap"]) test(`uncertain ${at} cannot start a replacement or resubmit`, async t => {
  const { path } = prepared(t), calls: string[] = [];
  const api = async (method: string, url: string) => {
    calls.push(`${method} ${url}`);
    if (at === "bootstrap" && url === "/api/session") return { data: { id: "ses_uncertain" } };
    if (method === "GET") return { data: url.endsWith("/permission") || url.endsWith("/message") ? [] : {} };
    throw new Error("response lost after submission");
  };
  await assert.rejects(startBinding(path, api, rev), /response lost/);
  const retained = JSON.parse(readFileSync(path, "utf8"));
  assert.equal(retained.phase, "submission_uncertain");
  assert.equal(retained.sessionId, at === "create" ? null : "ses_uncertain");
  const before = calls.length;
  await assert.rejects(startBinding(path, api, rev), /already attempted/);
  await observeBinding(path, api, inspectBinding, rev);
  assert.ok(calls.slice(before).every(call => call.startsWith("GET ")));
  assert.ok(JSON.parse(readFileSync(path, "utf8")).history.some((event: any) => event.phase === "submission_uncertain"));
});

test("changed revision and mailbox path reject before provider actions", async t => {
  const { path, state } = prepared(t);
  const api = async () => { throw new Error("provider must not be contacted"); };
  await assert.rejects(startBinding(path, api, () => "changed"), /revision changed/);
  writeFileSync(path, JSON.stringify({ ...state, home: dirname(state.home) }));
  await assert.rejects(startBinding(path, api, rev), /Invalid or relocated/);
});

test("concurrent starts cannot create two native sessions", async t => {
  const { path } = prepared(t);
  let release!: () => void, submitted!: () => void, creates = 0;
  const pending = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { submitted = resolve; });
  const api = async (_method: string, url: string) => {
    if (url === "/api/session") { creates++; submitted(); await pending; return { data: { id: "ses_concurrent" } }; }
    return {};
  };
  const first = startBinding(path, api, rev);
  await started;
  await assert.rejects(startBinding(path, api, rev), /already in use/);
  await assert.rejects(observeBinding(path, api, inspectBinding, rev), /already in use/);
  release(); await first;
  assert.equal(creates, 1);
});

test("binding inspection requires a real MCP lease and exact session metadata", async t => {
  const { state } = prepared(t);
  state.sessionId = "ses_bindingProof";
  const client = new Client({ name: "native-binding-fixture", version: "test" });
  t.after(async () => { await client.close(); });
  assert.equal(inspectBinding(state).verified, false);
  await client.connect(new StdioClientTransport({ command: process.execPath,
    args: [join(import.meta.dirname, "../bin/agentmbx.js"), "mcp"], cwd: state.work,
    env: { ...process.env, AGENTMBX_DEV: "1", MBX_HOME: state.home, MBX_AGENT: "opencode-native", MBX_CLI: "opencode", MBX_NO_DESKTOP: "1" } as Record<string, string> }));
  await client.callTool({ name: "mbx_whoami", arguments: {} });
  assert.equal(inspectBinding(state).verified, false, "provisional transport is not a native session");
  const who = await client.callTool({ name: "mbx_whoami", arguments: {}, _meta: { "ai.opencode/sessionID": state.sessionId } });
  assert.notEqual(who.isError, true);
  const proof = inspectBinding(state);
  assert.equal(proof.verified, true);
  assert.equal(proof.agent, (who.structuredContent as { agent: string }).agent);
  const node = new MbxNode(state.home);
  const lease = node.store.db.prepare("SELECT token FROM identity_leases WHERE name=?").get(proof.agent!);
  assert.ok(lease);
  assert.equal(JSON.stringify(proof).includes(lease.token as string), false);
  node.close();
  await client.close();
  assert.equal(inspectBinding(state).verified, false, "closed holder cannot remain verified");
});

test("a session claim adopts our own base's name instead of refusing as occupied", async t => {
  const { state } = prepared(t);
  const client = new Client({ name: "base-transfer-fixture", version: "test" });
  t.after(async () => { await client.close(); });
  await client.connect(new StdioClientTransport({ command: process.execPath,
    args: [join(import.meta.dirname, "../bin/agentmbx.js"), "mcp"], cwd: state.work,
    env: { ...process.env, AGENTMBX_DEV: "1", MBX_HOME: state.home, MBX_AGENT: "opencode-native", MBX_CLI: "opencode", MBX_NO_DESKTOP: "1" } as Record<string, string> }));
  // the base adopts a name at startup (a remembered-name window)
  const baseWho = await client.callTool({ name: "mbx_whoami", arguments: {} });
  const base = JSON.parse((baseWho.content as { text: string }[])[0].text) as { agent: string };
  assert.ok(base.agent);
  // history remembers the fleet session id under the same name
  const node = new MbxNode(state.home);
  node.store.db.prepare("INSERT OR REPLACE INTO kv (k, v) VALUES (?, ?)").run("name:opencode:ses_fleettest", base.agent);
  const inbox = await client.callTool({ name: "mbx_inbox", arguments: {}, _meta: { "ai.opencode/sessionID": "ses_fleettest" } });
  assert.notEqual(inbox.isError, true, "session tools adopt the name rather than 'belongs to another live session'");
  const row = node.store.db.prepare("SELECT session_id FROM identity_leases WHERE name=?").get(base.agent) as { session_id: string };
  assert.equal(row.session_id, "ses_fleettest", "the lease transferred from our base to the real session");
  node.close();
});
