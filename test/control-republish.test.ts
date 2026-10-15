import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fingerprint, generateKeyPair } from "../src/crypto.ts";
import { MbxNode } from "../src/node.ts";
import { findIdentityControl, identityGeneration, publishIdentityControl } from "../src/identity-control.ts";
import { IdentityLeases, inspectLeaseProcess, type IdentityLease } from "../src/identity-leases.ts";
import { captureWakeIdentity } from "../src/wake-identity.ts";
import { procStart } from "../src/proc.ts";

function fixture(t: TestContext, cli: "codex" | "opencode") {
  const home = mkdtempSync(join(tmpdir(), "mbx-control-republish-")), node = new MbxNode(home, { host: "alpha" });
  const clients: Client[] = [];
  t.after(async () => { for (const client of clients.reverse()) await client.close(); node.close(); rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
  const sid = cli === "codex" ? "33333333-3333-4333-8333-333333333333" : "ses_republish";
  const meta = cli === "codex" ? { threadId: sid } : { sessionID: sid };
  const start = async () => {
    const client = new Client({ name: "control-republish", version: "test" }); clients.push(client);
    const env = { ...process.env, MBX_HOME: home, MBX_CLI: cli, AGENTMBX_DEV: "1", MBX_NO_DESKTOP: "1" } as Record<string, string>;
    for (const key of Object.keys(env)) if (key.startsWith("MBX_MCP_") || ["MBX_AGENT", "MBX_ROLE", "MBX_CHANNEL"].includes(key)) delete env[key];
    const transport = new StdioClientTransport({ command: process.execPath, args: [resolve("bin/agentmbx.js"), "mcp"], env });
    await client.connect(transport);
    return { client, transport, call: (name: string, args = {}) => client.callTool({ name, arguments: args, _meta: meta }) };
  };
  const lease = () => node.store.db.prepare("SELECT * FROM identity_leases WHERE name='reader'").get() as unknown as IdentityLease;
  const check = () => {
    const row = lease(), descriptor = findIdentityControl(node.store, cli, sid);
    const session = node.sessionsFor("reader").find(s => s.cli === cli && s.session_id === sid)!;
    assert.equal(descriptor.control_key, row.key_fp, "descriptor uses the lease holder's key");
    assert.equal(fingerprint(session.session_key!), row.key_fp, "binding uses the lease holder's key");
    assert.equal(descriptor.generation, identityGeneration(row.token));
    assert.equal(descriptor.mcp_pid, row.holder_pid);
    assert.equal(descriptor.lease_session_id, row.session_id);
    assert.ok(captureWakeIdentity(node, session), "the daemon can capture the exact wake identity");
    return descriptor;
  };
  return { home, node, sid, start, lease, check };
}

test("T648 current lease holder replaces a former holder's live control endpoint", async t => {
  const f = fixture(t, "opencode"), owner = generateKeyPair();
  writeFileSync(join(f.home, "owner.json"), JSON.stringify({ v: 1, backend: "keychain", public_key: owner.publicKey }), { mode: 0o600 });
  const helper = join(f.home, "fixture-owner.mjs");
  writeFileSync(join(f.home, "fixture-key.json"), JSON.stringify(owner), { mode: 0o600 });
  writeFileSync(helper, `#!/usr/bin/env node
import {readFileSync} from 'node:fs'; import {signData} from ${JSON.stringify(new URL("../src/crypto.ts", import.meta.url).href)};
const [cmd,file]=process.argv.slice(2); if(cmd!=='sign') process.exit(5);
const key=JSON.parse(readFileSync(new URL('./fixture-key.json',import.meta.url),'utf8'));
console.log(signData(key.privateKey,readFileSync(file,'utf8')));`, { mode: 0o700 });
  const first = await f.start();
  assert.notEqual((await first.call("mbx_identity", { action: "register", name: "reader", role: "reader" })).isError, true);
  const old = f.check(), prior = f.lease();
  // Leave the old endpoint and its process alive, exactly as a displaced shared-service transport does.
  assert.equal(new IdentityLeases(f.node.store).release("reader", prior.token), true);
  const next = await f.start();
  assert.notEqual((await next.call("mbx_identity", { action: "claim", name: "reader" })).isError, true);
  const current = f.check();
  assert.equal(current.mcp_pid, next.transport.pid);
  assert.notEqual(current.generation, old.generation);
  assert.equal(inspectLeaseProcess(first.transport.pid!).alive, true);
  assert.equal((await first.call("mbx_inbox")).isError, true, "the former holder remains fenced");
  assert.deepEqual(f.check(), current);
  const command = (...args: string[]) => {
    const result = spawnSync(process.execPath, [resolve("bin/agentmbx.js"), "identity", ...args, "--cli", "opencode", "--session", f.sid, "--json"], {
      encoding: "utf8", timeout: 10_000, env: { ...process.env, MBX_HOME: f.home, MBX_AUTH_HELPER: helper, AGENTMBX_DEV: "1" },
    });
    assert.equal(result.status, 0, result.stderr + result.stdout);
    assert.equal(JSON.parse(result.stdout).status, "completed");
  };
  command("release");
  command("claim", "reader");
  f.check();
  const key = generateKeyPair();
  f.node.registerAgent("occupied");
  new IdentityLeases(f.node.store).claim("occupied", { pid: process.pid, start: inspectLeaseProcess(process.pid).start!, keyFp: fingerprint(key.publicKey), cli: "claude", sessionId: "owner-fixture" });
  command("release");
  command("takeover", "occupied", "--force");
  const taken = findIdentityControl(f.node.store, "opencode", f.sid);
  assert.equal(taken.agent, "occupied");
  assert.equal(taken.mcp_pid, next.transport.pid);
  assert.ok(captureWakeIdentity(f.node, f.node.sessionsFor("occupied").find(s => s.session_id === f.sid)!));
});

test("T648 Codex hook resume and metadata share one key across release and re-claim", async t => {
  const f = fixture(t, "codex"), birth = procStart(process.pid)!;
  f.node.registerAgent("reader");
  f.node.keepName("codex", f.sid, "reader");
  f.node.store.db.prepare("INSERT INTO sessions (agent,cli,session_id,cwd,pid,session_key,channel,updated_at,pid_start) VALUES (?,?,?,?,?,?,?,?,?)")
    .run("reader", "codex", f.sid, process.cwd(), process.pid, null, 0, new Date().toISOString(), birth);
  const current = await f.start();
  const who = await current.call("mbx_whoami");
  assert.equal((who.structuredContent as { agent: string }).agent, "reader", JSON.stringify(who));
  f.check();
  assert.notEqual((await current.call("mbx_identity", { action: "release" })).isError, true);
  assert.notEqual((await current.call("mbx_identity", { action: "claim", name: "reader" })).isError, true);
  f.check();
  const base = await current.client.callTool({ name: "mbx_whoami", arguments: {} });
  assert.equal((base.structuredContent as { agent: string }).agent, "reader");
  f.check();
});

test("T648 a released holder's live null-generation endpoint does not block re-claim", async t => {
  const f = fixture(t, "opencode"), first = await f.start();
  assert.notEqual((await first.call("mbx_identity", { action: "register", name: "reader", role: "reader" })).isError, true);
  assert.notEqual((await first.call("mbx_identity", { action: "release" })).isError, true);
  assert.equal(findIdentityControl(f.node.store, "opencode", f.sid).generation, null);
  const next = await f.start();
  assert.notEqual((await next.call("mbx_identity", { action: "claim", name: "reader" })).isError, true);
  assert.equal(f.check().mcp_pid, next.transport.pid);
});

test("T648 held claim repairs a same-pid stale key but preserves live foreign controls", async t => {
  const f = fixture(t, "codex"), current = await f.start();
  const foreignProcess = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: "ignore" });
  t.after(() => foreignProcess.kill());
  assert.notEqual((await current.call("mbx_identity", { action: "register", name: "reader", role: "reader" })).isError, true);
  const correct = f.check();
  publishIdentityControl(f.node.store, { ...correct, control_key: "1111-1111-1111-1111" });
  assert.notEqual((await current.call("mbx_identity", { action: "claim", name: "reader" })).isError, true);
  assert.deepEqual(f.check(), correct);
  for (const changes of [{ generation: correct.generation }, { agent: "another", generation: identityGeneration("other") }, { agent: "", generation: null }]) {
    const foreign = { ...correct, ...changes, control_key: "2222-2222-2222-2222", mcp_pid: foreignProcess.pid!, mcp_start: inspectLeaseProcess(foreignProcess.pid!).start! };
    publishIdentityControl(f.node.store, foreign);
    assert.notEqual((await current.call("mbx_identity", { action: "claim", name: "reader" })).isError, true);
    assert.deepEqual(findIdentityControl(f.node.store, "codex", f.sid), foreign, "a live foreign endpoint stays protected");
  }
});
