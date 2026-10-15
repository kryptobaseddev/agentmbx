// T665: an exec handover must retain the held Codex thread without another hook bind.
import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, cpSync, mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { MbxNode } from "../src/node.ts";
import { fingerprint, generateKeyPair } from "../src/crypto.ts";
import { IdentityLeases, inspectLeaseProcess, type IdentityLease } from "../src/identity-leases.ts";
import { captureWakeIdentity } from "../src/wake-identity.ts";

const THREAD = "55555555-5555-4555-8555-555555555555";
const OTHER = "66666666-6666-4666-8666-666666666666";
const AGENT = "t665-reader";

for (const bindings of ["several threads", "no hook row"]) test(`Codex exec retains the held thread with ${bindings}`, {
  skip: typeof process.execve !== "function",
}, async t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "mbx-t665-"))), install = join(root, "install"), home = join(root, "mail");
  mkdirSync(install);
  for (const path of ["bin", "dist", "src", "package.json"]) cpSync(resolve(path), join(install, path), { recursive: true });
  symlinkSync(resolve("node_modules"), join(install, "node_modules"), "dir");
  const node = new MbxNode(home, { host: "alpha" }), client = new Client({ name: "codex-handover", version: "test" });
  t.after(async () => {
    await client.close().catch(() => {});
    node.close();
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  const provider = inspectLeaseProcess(process.pid);
  assert.equal(provider.alive, true); assert.ok(provider.start);
  node.registerAgent(AGENT, { role: "reader" });
  node.bindSession({ agent: AGENT, cli: "codex", session_id: THREAD, cwd: install, pid: process.pid });
  const leases = new IdentityLeases(node.store);
  // A released lease from another pid must not override this provider's exact hook binding.
  const prior = leases.claim(AGENT, { pid: process.pid, start: provider.start, cli: "codex", sessionId: OTHER,
    keyFp: fingerprint(generateKeyPair().publicKey) });
  leases.release(AGENT, prior.token);
  const env: Record<string, string> = { ...process.env, AGENTMBX_DEV: "1", MBX_HOME: home, MBX_CLI: "codex", MBX_NO_DESKTOP: "1",
    MBX_SESSION_SOCKET: "0", MBX_MCP_REEXEC: "1", MBX_MCP_PARENT_AGENT: AGENT,
    MBX_MCP_PROVIDER_PID: String(process.pid), MBX_MCP_PROVIDER_START: provider.start };
  for (const key of ["MBX_AGENT", "MBX_MCP_DETACHED", "MBX_MCP_REEXEC_BUILD", "MBX_MCP_ORIGINAL_PID"]) delete env[key];
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [join(install, "bin/agentmbx.js"), "mcp"], cwd: install, env }));
  const call = (name: string, args: Record<string, unknown> = {}, threadId = THREAD) =>
    client.callTool({ name, arguments: args, _meta: { threadId } });
  const lease = () => node.store.db.prepare("SELECT * FROM identity_leases WHERE name=?").get(AGENT) as unknown as IdentityLease;
  const before = await call("mbx_whoami");
  assert.notEqual(before.isError, true, JSON.stringify(before));
  assert.equal((before.structuredContent as { agent: string }).agent, AGENT);
  const held = lease();
  assert.equal(held.session_id, THREAD);
  assert.equal(held.released_at, null);
  const original = node.sessionsFor(AGENT).find(s => s.session_id === THREAD);
  assert.ok(original); assert.ok(captureWakeIdentity(node, original), "wake authority exists before reload");

  // The already-held thread is known even when a parent-wide hook lookup cannot select it.
  if (bindings === "several threads") node.bindSession({ agent: "t665-other", cli: "codex", session_id: OTHER, cwd: install, pid: process.pid });
  else node.store.db.prepare("DELETE FROM sessions WHERE cli='codex' AND session_id=?").run(THREAD);
  appendFileSync(join(install, "src/cli.ts"), "\n// T665 deployed build\n");
  assert.notEqual((await call("mbx_whoami")).isError, true, "the triggering reply finishes before exec");
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline && (lease().token === held.token || lease().released_at !== null))
    await new Promise(resolve => setTimeout(resolve, 25));
  await client.listTools(); // Reclaim precedes complete replacement startup.
  const current = lease();
  assert.notEqual(current.token, held.token, "handover releases and claims a fresh generation");
  assert.equal(current.holder_pid, held.holder_pid, "actual exec keeps the MCP pid");
  assert.equal(current.holder_start, held.holder_start);
  assert.equal(current.released_at, null);
  assert.equal(current.session_id, THREAD, "reclaim must retain the real thread, never mcp-<pid>");
  const claim = node.store.db.prepare("SELECT detail FROM audit WHERE event='identity.claim' AND json_extract(detail,'$.name')=? ORDER BY rowid DESC LIMIT 1").get(AGENT) as { detail: string };
  assert.equal(JSON.parse(claim.detail).holder.sessionId, THREAD);

  const after = await call("mbx_whoami");
  assert.notEqual(after.isError, true, JSON.stringify(after));
  assert.equal((after.structuredContent as { agent: string; harness_session: string }).agent, AGENT);
  assert.equal((after.structuredContent as { harness_session: string }).harness_session, THREAD);
  const restored = node.sessionsFor(AGENT).find(s => s.session_id === THREAD);
  assert.ok(restored);
  assert.notEqual(restored.session_key, original.session_key, "replacement publishes its new key without a hook");
  const wake = captureWakeIdentity(node, restored);
  assert.ok(wake, "real-thread wake routing works immediately without another hook bind");
  assert.equal(wake.run(() => "routed"), "routed");
  const id = node.send({ from: "sender", to: [AGENT], subject: "after reload", body: "for this thread" }).envelope.id;
  const inbox = await call("mbx_inbox");
  assert.notEqual(inbox.isError, true, JSON.stringify(inbox));
  assert.match(JSON.stringify(inbox), new RegExp(id));
  const sibling = await call("mbx_whoami", {}, OTHER);
  assert.notEqual(sibling.isError, true);
  assert.equal((sibling.structuredContent as { agent: string | null }).agent, null, "another thread does not inherit the identity");
  assert.equal(lease().token, current.token);
  if (bindings === "several threads") {
    assert.notEqual((await call("mbx_identity", { action: "release" })).isError, true);
    const released = lease();
    assert.notEqual(released.released_at, null);
    appendFileSync(join(install, "src/cli.ts"), "\n// T665 another deployed build\n");
    assert.notEqual((await call("mbx_whoami")).isError, true);
    const detached = await call("mbx_whoami");
    assert.notEqual(detached.isError, true, JSON.stringify(detached));
    assert.equal((detached.structuredContent as { agent: string | null }).agent, null, "an explicit release survives exec");
    assert.equal(lease().token, released.token, "the released real-thread lease is never reclaimed");
    assert.equal(lease().released_at, released.released_at);
  }
});
