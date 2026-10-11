// T441: a build handover that fails before the replacement spawns must leave this server fully serving —
// leases, timers and identity control endpoints intact, never half-retired. A child that dies after
// spawning mirrors its exit instead, which the proxy reports. Failure modes are injected through
// MBX_TEST_SPAWN_FAIL so no real install is harmed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, cpSync, mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { MbxNode } from "../src/node.ts";
import { listIdentityControls } from "../src/identity-control.ts";

const fixture = (t: { after: (fn: () => void | Promise<void>) => void }) => {
  const root = mkdtempSync(join(tmpdir(), "mbx-rollback-")), install = join(root, "install"), home = join(root, "mail");
  mkdirSync(install);
  // The failure-injection seam is gated behind AGENTMBX_DEV=1, under which the launcher loads ../src/cli.ts —
  // so the fixture ships src/ as well and the build-change trigger appends to src/cli.ts (codeEntry resolves
  // ./cli.ts next to the running module).
  for (const path of ["bin", "dist", "src", "package.json"]) cpSync(resolve(path), join(install, path), { recursive: true });
  symlinkSync(resolve("node_modules"), join(install, "node_modules"), "dir");
  const node = new MbxNode(home, { host: "alpha" });
  t.after(async () => { node.close(); rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
  return { install, home, node, entry: join(install, "src/cli.ts") };
};

const start = async (t: { after: (fn: () => void | Promise<void>) => void }, install: string, home: string, failMode: string) => {
  const client = new Client({ name: "rollback-test", version: "1" });
  t.after(async () => { await client.close().catch(() => {}); });
  const env: NodeJS.ProcessEnv = { ...process.env, MBX_HOME: home, MBX_AGENT: "rollback-reader", MBX_CLI: "claude", MBX_NO_DESKTOP: "1", MBX_TEST_SPAWN_FAIL: failMode };
  for (const key of ["AGENTMBX_DEV", "MBX_MCP_REEXEC", "MBX_MCP_REEXEC_BUILD", "MBX_MCP_DETACHED", "MBX_MCP_PROVIDER_PID"]) delete env[key];
  env.AGENTMBX_DEV = "1"; // the failure-injection seam is gated behind the dev flag, as in `npm test`
  const preload = join(install, "exec-behavior.mjs");
  writeFileSync(preload, failMode === "exec-throw" ? "process.execve = () => {throw Error('injected exec failure')};"
    : failMode === "exec-return" ? "process.execve = () => {};"
    : failMode === "exec-preflight" ? "Object.defineProperty(process,'execPath',{value:'/nonexistent-t488-owned-fixture/executable'});"
    : "process.execve = undefined;");
  const transport = new StdioClientTransport({ command: process.execPath, args: ["--import", preload, join(install, "bin/agentmbx.js"), "mcp"], env: env as Record<string, string>, stderr: "pipe" });
  await client.connect(transport);
  const stderrLines: string[] = [];
  (transport as unknown as { stderr: { on: (ev: string, cb: (d: unknown) => void) => void } }).stderr.on("data", d => stderrLines.push(String(d)));
  return { client, stderrLines };
};

const whoami = (client: Client) => client.callTool({ name: "mbx_whoami", arguments: {} });

for (const failMode of ["error", "throw"]) test(`handover spawn failure (${failMode}) keeps the server fully serving`, async t => {
  const { install, home, node, entry } = fixture(t);
  const { client } = await start(t, install, home, failMode);
  const name = `rollback-${failMode}`;
  assert.notEqual((await client.callTool({ name: "mbx_whoami", arguments: { name, role: "builder" } })).isError, true);
  appendFileSync(entry, "\n// deployed build\n");
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
  const schema = node.store.schemaVersion();
  node.store.db.exec(`PRAGMA user_version=${schema + 1}`);
  appendFileSync(entry, "\n// deployed schema build\n");
  assert.equal((await whoami(client)).isError, true, "the stale schema is refused while the replacement fails");
  assert.equal((await whoami(client)).isError, true, "a failed schema handover resumes the original reader");
  assert.equal(node.store.db.prepare("SELECT released_at FROM identity_leases WHERE name=?").get(name)!.released_at, null,
    "failed schema handover leaves the lease held");
  node.store.db.exec(`PRAGMA user_version=${schema}`);
  assert.notEqual((await whoami(client)).isError, true, "the original mailbox remains open after schema handover failure");
});

test("a child that exits right after spawning mirrors its exit (clean exit, not a half-retired server)", async t => {
  const { install, home, node, entry } = fixture(t);
  const { client } = await start(t, install, home, "exit7");
  const name = "rollback-exit";
  assert.notEqual((await client.callTool({ name: "mbx_whoami", arguments: { name, role: "builder" } })).isError, true);
  appendFileSync(entry, "\n// deployed build\n");
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

test("an async spawn error resets the pending handover: a later build change retries it", async t => {
  const { install, home, entry } = fixture(t);
  const { client, stderrLines } = await start(t, install, home, "error");
  assert.notEqual((await client.callTool({ name: "mbx_whoami", arguments: { name: "rollback-retry", role: "builder" } })).isError, true);
  const announcements = () => stderrLines.filter(l => l.includes("was updated on disk")).length;
  appendFileSync(entry, "\n// deployed build 1\n");
  assert.notEqual((await whoami(client)).isError, true);
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline && announcements() < 1) await new Promise(r => setTimeout(r, 25));
  assert.equal(announcements(), 1, "the first build change triggers the handover");
  appendFileSync(entry, "\n// deployed build 2\n");
  assert.notEqual((await whoami(client)).isError, true, "the server still serves after the failed handover");
  const retryDeadline = Date.now() + 5_000;
  while (Date.now() < retryDeadline && announcements() < 2) await new Promise(r => setTimeout(r, 25));
  assert.equal(announcements(), 2, "the async spawn failure reset handedOver, so the next build change retries the handover");
});

test("exec preflight failure preserves serving, lease and control endpoint", { skip: typeof process.execve !== "function" }, async t => {
  const { install, home, node, entry } = fixture(t), { client } = await start(t, install, home, "exec-preflight");
  const before = await whoami(client), name = (before.structuredContent as { agent: string }).agent;
  const lease = node.store.db.prepare("SELECT token FROM identity_leases WHERE name=?").get(name)!;
  appendFileSync(entry, "\n// deployed build\n");
  assert.notEqual((await whoami(client)).isError, true);
  assert.notEqual((await client.callTool({ name: "mbx_inbox", arguments: {} })).isError, true);
  assert.equal(node.store.db.prepare("SELECT token FROM identity_leases WHERE name=? AND released_at IS NULL").get(name)?.token, lease.token);
  assert.ok(listIdentityControls(node.store).some(d => d.agent === name));
});

for (const mode of ["exec-throw", "exec-return"]) test(`${mode} closes the transport after retirement instead of serving half-retired`, { skip: typeof process.execve !== "function" }, async t => {
  const { install, home, node, entry } = fixture(t), { client } = await start(t, install, home, mode);
  const before = await whoami(client), name = (before.structuredContent as { agent: string }).agent;
  appendFileSync(entry, "\n// deployed build\n");
  assert.notEqual((await whoami(client)).isError, true, "the triggering result must flush before replacement");
  await assert.rejects(() => whoami(client));
  assert.notEqual(node.store.db.prepare("SELECT released_at FROM identity_leases WHERE name=?").get(name)?.released_at, null);
  assert.ok(!listIdentityControls(node.store).some(d => d.agent === name));
});
