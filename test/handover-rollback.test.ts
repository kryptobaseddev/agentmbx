// T441: a build handover that fails before the replacement spawns must leave this server fully serving —
// leases, timers and identity control endpoints intact, never half-retired. A child that dies after
// spawning mirrors its exit instead, which the proxy reports. Failure modes are injected through
// MBX_TEST_SPAWN_FAIL so no real install is harmed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, cpSync, mkdtempSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { MbxNode } from "../src/node.ts";
import { listIdentityControls } from "../src/identity-control.ts";

const fixture = (t: { after: (fn: () => void | Promise<void>) => void }) => {
  const root = mkdtempSync(join(tmpdir(), "mbx-rollback-")), install = join(root, "install"), home = join(root, "mail");
  mkdirSync(install);
  for (const path of ["bin", "dist", "package.json"]) cpSync(resolve(path), join(install, path), { recursive: true });
  symlinkSync(resolve("node_modules"), join(install, "node_modules"), "dir");
  const node = new MbxNode(home, { host: "alpha" });
  t.after(async () => { node.close(); rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
  return { install, home, node };
};

const start = async (t: { after: (fn: () => void | Promise<void>) => void }, install: string, home: string, failMode: string) => {
  const client = new Client({ name: "rollback-test", version: "1" });
  t.after(async () => { await client.close().catch(() => {}); });
  const env: NodeJS.ProcessEnv = { ...process.env, MBX_HOME: home, MBX_AGENT: "rollback-reader", MBX_CLI: "claude", MBX_NO_DESKTOP: "1", MBX_TEST_SPAWN_FAIL: failMode };
  for (const key of ["AGENTMBX_DEV", "MBX_MCP_REEXEC", "MBX_MCP_REEXEC_BUILD", "MBX_MCP_DETACHED", "MBX_MCP_PROVIDER_PID"]) delete env[key];
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [join(install, "bin/agentmbx.js"), "mcp"], env: env as Record<string, string> }));
  return client;
};

const whoami = (client: Client) => client.callTool({ name: "mbx_whoami", arguments: {} });

for (const failMode of ["error", "throw"]) test(`handover spawn failure (${failMode}) keeps the server fully serving`, async t => {
  const { install, home, node } = fixture(t);
  const client = await start(t, install, home, failMode);
  const name = `rollback-${failMode}`;
  assert.notEqual((await client.callTool({ name: "mbx_whoami", arguments: { name, role: "builder" } })).isError, true);
  appendFileSync(join(install, "dist/cli.js"), "\n// deployed build\n");
  const trigger = await whoami(client);
  assert.notEqual(trigger.isError, true, "the triggering call still finishes on the old build");
  // The replacement never started: the parent must still serve, hold its lease and its control endpoint.
  const after = await whoami(client);
  assert.notEqual(after.isError, true, JSON.stringify(after));
  assert.equal((after.structuredContent as { agent: string }).agent, name);
  const lease = node.store.db.prepare("SELECT released_at FROM identity_leases WHERE name=?").get(name)!;
  assert.equal(lease.released_at, null, "a failed handover must not release the lease");
  assert.ok(listIdentityControls(node.store).some(d => d.agent === name), "the identity control endpoint survives");
  assert.notEqual((await client.callTool({ name: "mbx_inbox", arguments: {} })).isError, true, "tools keep working after the failed handover");
});

test("a child that exits right after spawning mirrors its exit (clean exit, not a half-retired server)", async t => {
  const { install, home, node } = fixture(t);
  const client = await start(t, install, home, "exit7");
  const name = "rollback-exit";
  assert.notEqual((await client.callTool({ name: "mbx_whoami", arguments: { name, role: "builder" } })).isError, true);
  appendFileSync(join(install, "dist/cli.js"), "\n// deployed build\n");
  assert.notEqual((await whoami(client)).isError, true, "the triggering call still finishes on the old build");
  const deadline = Date.now() + 10_000;
  let closed = false;
  while (Date.now() < deadline && !closed) {
    try {
      await Promise.race([whoami(client).then(() => false), new Promise(r => setTimeout(() => r(true), 2000))]);
    } catch { closed = true; }
    if (!closed) await new Promise(r => setTimeout(r, 25));
  }
  assert.ok(closed, "the parent exits when the replacement dies after spawning");
  const lease = node.store.db.prepare("SELECT released_at FROM identity_leases WHERE name=?").get(name)!;
  assert.notEqual(lease.released_at, null, "retire ran before the mirrored exit (leases released)");
  assert.ok(!listIdentityControls(node.store).some(d => d.agent === name), "retire removed the identity control endpoint");
});
