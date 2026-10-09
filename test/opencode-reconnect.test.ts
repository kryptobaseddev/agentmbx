import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, copyFileSync, chmodSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { opencodeProviderPid } from "../src/opencode-provider.ts";
import { MbxNode } from "../src/node.ts";
import { identityClaimChurn, CLAIM_CHURN_LIMIT } from "../src/doctor.ts";
import { IdentityLeases, inspectLeaseProcess } from "../src/identity-leases.ts";
import { buildIdentityTakeover } from "../src/identity-takeover.ts";
import { fingerprint, generateKeyPair } from "../src/crypto.ts";
import { INSTRUCTIONS } from "../src/mcp.ts";
import { spawnSync } from "node:child_process";
import { publishIdentityControl, type IdentityControlDescriptor } from "../src/identity-control.ts";
import { holderProviderView } from "../src/identity-availability.ts";

// macOS ps preserves the invoked symlink name while dyld resolves the original Node install.
// Linux procfs resolves symlinks, so its executable-identity fixture must remain a real copy.
const fakeExecutable = (path: string) => {
  if (process.platform === "darwin") symlinkSync(process.execPath, path);
  else { copyFileSync(process.execPath, path); chmodSync(path, 0o755); }
};

test("provider resolution crosses Node/Bun runtimes, stops at shells and unknown ancestry", () => {
  const table = new Map([[10, { ppid: 20 }], [20, { ppid: 30 }], [30, { ppid: 1 }]]);
  const commands = new Map([[10, "/bin/node"], [20, "/bin/bun"], [30, "/bin/opencode"]]);
  assert.equal(opencodeProviderPid(10, table, p => commands.get(p) ?? ""), 30);
  commands.set(20, "/bin/zsh");
  assert.equal(opencodeProviderPid(10, table, p => commands.get(p) ?? ""), null);
  commands.set(20, "");
  assert.equal(opencodeProviderPid(10, table, p => commands.get(p) ?? ""), null);
  assert.equal(opencodeProviderPid(99, table, () => "opencode"), null);
  const recorded = { pid: 20, start: "runtime" }, evidence = { alive: true, start: "runtime" };
  assert.equal(holderProviderView(table, 10, 30, recorded, evidence).holderProviderPid, 20);
  assert.equal(holderProviderView(table, 10, 30, recorded, evidence, true).holderProviderPid, 30);
  assert.equal(holderProviderView(table, 10, 30, recorded, { alive: null, start: null }, true).holderProviderAlive, true);
});

test("Linux provider resolution ignores a forged or truncated process title", { skip: process.platform !== "linux" }, () => {
  const title = process.title;
  try {
    process.title = "opencode";
    assert.equal(opencodeProviderPid(process.pid, new Map([[process.pid, { ppid: 1 }]])), null);
    process.title = "a-runtime-title-longer-than-linux-comm";
    assert.equal(opencodeProviderPid(process.pid, new Map([[process.pid, { ppid: 1 }]])), null);
  } finally { process.title = title; }
});

test("OpenCode runtime reconnects co-use, shell-spawned MCPs refuse, other conversations stay isolated, EOF resumes", async t => {
  if (!process.env.T469_HARNESS_FIXTURE) {
    const fixture = mkdtempSync(join(tmpdir(), "mbx-t469-executable-"));
    t.after(() => rmSync(fixture, { recursive: true, force: true }));
    const executable = join(fixture, "opencode");
    fakeExecutable(executable);
    const env: NodeJS.ProcessEnv = { ...process.env, T469_HARNESS_FIXTURE: "1" };
    // A fresh test runner must not inherit the parent's internal worker context.
    delete env.NODE_TEST_CONTEXT;
    const child = spawnSync(executable, ["--test", "--test-isolation=none", "--test-name-pattern=^OpenCode runtime", "--test-timeout=120000", "--test-force-exit", import.meta.filename], {
      env, encoding: "utf8", timeout: 150000,
    });
    assert.equal(child.status, 0, `${child.error ?? ""}\n${child.stdout}\n${child.stderr}`);
    assert.match(child.stdout, /(?:#|ℹ) pass 1\b/, "the executable fixture must actually run its integration test");
    return;
  }
  const home = mkdtempSync(join(tmpdir(), "mbx-t469-")), node = new MbxNode(home, { host: "scratch" });
  const clients: Client[] = [];
  t.after(async () => { for (const c of clients.reverse()) await c.close().catch(() => {}); node.close(); rmSync(home, { recursive: true, force: true }); });
  // Real executable names work on both Linux procfs and macOS ps. Mutable titles do not.
  const runtime = join(home, "node"), shellRuntime = join(home, "zsh");
  for (const executable of [runtime, shellRuntime]) fakeExecutable(executable);
  const wrapper = join(home, "runtime.mjs");
  writeFileSync(wrapper, `import { spawn } from 'node:child_process';
const c = spawn(process.env.T469_NODE, process.argv.slice(2), { stdio: 'inherit' });
c.on('exit', code => process.exit(code ?? 1));
process.on('SIGTERM', () => c.kill('SIGTERM'));`);
  const connect = async (shell = false) => {
    const c = new Client({ name: "runtime", version: "test" }); clients.push(c);
    const env = { ...process.env, T469_NODE: runtime, MBX_HOME: home, OPENCODE_CONFIG_DIR: home, MBX_CLI: "opencode", MBX_NO_DESKTOP: "1", AGENTMBX_DEV: "1" } as Record<string, string>;
    for (const k of Object.keys(env)) if (k.startsWith("MBX_MCP_") || ["MBX_AGENT", "MBX_ROLE", "MBX_CHANNEL"].includes(k)) delete env[k];
    await c.connect(new StdioClientTransport({ command: shell ? shellRuntime : runtime, args: [wrapper, join(import.meta.dirname, "../bin/agentmbx.js"), "mcp"], env }));
    return c;
  };
  const call = (c: Client, name: string, args = {}, sid = "ses_t469") => c.callTool({ name, arguments: args, _meta: { sessionID: sid } });
  const lease = () => node.store.db.prepare("SELECT token,holder_pid,key_fp,released_at FROM identity_leases WHERE name='reconnect-reader'").get();
  const first = await connect();
  assert.notEqual((await call(first, "mbx_identity", { action: "register", name: "reconnect-reader", role: "test" })).isError, true);
  const held = lease();
  const record = JSON.parse(node.store.get(`mcp-provider:${held!.holder_pid}`)!);
  assert.equal(record.providerPid, process.pid); assert.equal(record.harness, true);
  const mail = node.send({ from: "peer", to: ["reconnect-reader"], subject: "retained", body: "retained" }).envelope.id;
  for (let i = 0; i < 3; i++) {
    const sibling = await connect();
    const who = (await call(sibling, "mbx_whoami")).structuredContent as { agent: string; co_use?: string };
    assert.equal(who.agent, "reconnect-reader"); assert.match(who.co_use!, /co-using/);
    assert.notEqual((await call(sibling, "mbx_read", { ids: [mail] })).isError, true);
    assert.deepEqual(lease(), held);
    await sibling.close(); assert.deepEqual(lease(), held);
  }
  const shell = await connect(true);
  const refused = await call(shell, "mbx_identity", { action: "claim", name: "reconnect-reader" });
  assert.equal(refused.isError, true); assert.match(JSON.stringify(refused.content), /standalone.*CLI|standalone.*agentmbx inbox/);
  assert.deepEqual(lease(), held);
  const next = await connect();
  node.keepName("opencode", "ses_stranger", "reconnect-reader");
  const stranger = (await call(next, "mbx_whoami", {}, "ses_stranger")).structuredContent as { agent: string | null };
  assert.equal(stranger.agent, null); assert.deepEqual(lease(), held);
  assert.equal((await call(next, "mbx_read", { ids: [mail] }, "ses_stranger")).isError, true);
  assert.equal(((await call(next, "mbx_whoami")).structuredContent as { agent: string }).agent, "reconnect-reader");
  const identitySibling = await connect();
  assert.equal(((await call(identitySibling, "mbx_whoami")).structuredContent as { agent: string }).agent, "reconnect-reader");
  // Existing sibling retains the old token; the respawned holder has a fresh MCP key/generation.
  await first.close();
  const replacement = await connect();
  assert.equal(((await call(replacement, "mbx_whoami")).structuredContent as { agent: string }).agent, "reconnect-reader");
  const renewed = lease(); assert.notEqual(renewed!.token, held!.token);
  assert.notEqual(renewed!.key_fp, held!.key_fp, "respawn mints a new MCP key");
  assert.equal(((await call(identitySibling, "mbx_whoami")).structuredContent as { agent: string }).agent, "reconnect-reader");
  // The FIRST mailbox call must refresh co-use, not return unbound until a later identity call.
  assert.notEqual((await call(next, "mbx_read", { ids: [mail] })).isError, true);
  assert.equal(((await call(next, "mbx_whoami")).structuredContent as { agent: string }).agent, "reconnect-reader");
  assert.deepEqual(lease(), renewed, "co-user does not replace the respawned holder");

});

test("force takeover refuses its own live session before owner signing and preserves the lease", t => {
  const home = mkdtempSync(join(tmpdir(), "mbx-t469-self-")), node = new MbxNode(home, { host: "scratch" }), key = generateKeyPair();
  t.after(() => { node.close(); rmSync(home, { recursive: true, force: true }); });
  writeFileSync(join(home, "owner.json"), JSON.stringify({ v: 1, backend: "keychain", public_key: key.publicKey }));
  const start = inspectLeaseProcess(process.pid).start!;
  const held = new IdentityLeases(node.store).claim("self-reader", { pid: process.pid, start, keyFp: fingerprint(key.publicKey), cli: "opencode", sessionId: "ses_self" });
  const target: IdentityControlDescriptor = { v: 1, cli: "opencode", session_id: "ses_self", lease_session_id: "ses_self", control_key: fingerprint(key.publicKey), mcp_pid: process.pid, mcp_start: start, parent_pid: process.ppid, parent_start: inspectLeaseProcess(process.ppid).start!, agent: "", generation: null };
  assert.throws(() => buildIdentityTakeover(node, target, "self-reader"), /own live session MCP/);
  publishIdentityControl(node.store, target);
  const cli = spawnSync(process.execPath, [join(import.meta.dirname, "../bin/agentmbx.js"), "identity", "takeover", "self-reader", "--force", "--cli", "opencode", "--session", "ses_self"], { env: { ...process.env, MBX_HOME: home, AGENTMBX_DEV: "1" }, encoding: "utf8", timeout: 5000 });
  assert.equal(cli.status, 1); assert.match(cli.stderr, /own live session MCP/);
  assert.equal(node.store.db.prepare("SELECT token FROM identity_leases WHERE name='self-reader'").get()!.token, held.token);
});

test("doctor flags more than five claims in ten minutes, with bounded time and per-name counts", t => {
  const home = mkdtempSync(join(tmpdir(), "mbx-t469-churn-")), node = new MbxNode(home, { host: "scratch" });
  t.after(() => { node.close(); rmSync(home, { recursive: true, force: true }); });
  for (let i = 0; i < CLAIM_CHURN_LIMIT; i++) node.store.audit("identity.claim", { name: "storm" });
  assert.deepEqual(identityClaimChurn(node), []);
  node.store.audit("identity.claim", { name: "storm" });
  node.store.audit("identity.claim", { name: "other" });
  const result = identityClaimChurn(node);
  assert.equal(result.length, 1); assert.match(result[0].label, /storm.*6 claims/);
  assert.match(result[0].fix!, /Never kill/);
  assert.deepEqual(identityClaimChurn(node, Date.now() + 11 * 60_000), []);
});

test("skill and running MCP instructions forbid process recovery and point to the leased CLI", () => {
  for (const text of [INSTRUCTIONS, readFileSync(new URL("../skill/SKILL.md", import.meta.url), "utf8")]) {
    assert.match(text, /Never kill MBX MCP processes or hand-spawn/);
    assert.match(text, /inbox\/read\/reply\/ack\/send --as/);
  }
});
