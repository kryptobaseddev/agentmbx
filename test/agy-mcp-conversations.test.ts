// T725 review blockers: a subagent never claims its root's mailbox, and the shared MCP process's own
// ANTIGRAVITY_CONVERSATION_ID never names a conversation. A Node fixture named agy, never a real Antigravity.
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, copyFileSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { MbxNode } from "../src/node.ts";

const bin = join(import.meta.dirname, "../bin/agentmbx.js");
const textOf = (r: unknown) => ((r as { content: { text: string }[] }).content ?? []).map((c) => c.text).join("\n");
const ROOT = "11111111-1111-4111-8111-111111111111", SUB = "22222222-2222-4222-8222-222222222222", SUB2 = "33333333-3333-4333-8333-333333333333";

function transportFor(home: string, envConversation?: string): StdioClientTransport {
  const env = { ...process.env, HOME: home, XDG_CONFIG_HOME: join(home, ".config"), XDG_DATA_HOME: join(home, ".local/share"), XDG_CACHE_HOME: join(home, ".cache"),
    AGENTMBX_DEV: "1", MBX_HOME: home, MBX_CLI: "agy", MBX_NO_DESKTOP: "1", ...(envConversation ? { ANTIGRAVITY_CONVERSATION_ID: envConversation } : {}) } as Record<string, string>;
  for (const key of Object.keys(env)) if (key.startsWith("MBX_MCP_") || ["MBX_AGENT", "MBX_ROLE", "MBX_CHANNEL"].includes(key)) delete env[key];
  if (!envConversation) delete env.ANTIGRAVITY_CONVERSATION_ID;
  const executable = join(home, "agy");
  if (process.platform === "darwin") symlinkSync(process.execPath, executable);
  else { copyFileSync(process.execPath, executable); chmodSync(executable, 0o755); }
  const wrapper = join(home, "provider.mjs");
  writeFileSync(wrapper, `import { spawn } from 'node:child_process';
const child = spawn(${JSON.stringify(process.execPath)}, [${JSON.stringify(bin)}, 'mcp'], { stdio: 'inherit' });
child.on('exit', code => process.exit(code ?? 1));
process.on('SIGTERM', () => child.kill('SIGTERM'));
`);
  return new StdioClientTransport({ command: executable, args: [wrapper], env });
}

test("T725: the MCP process's ANTIGRAVITY_CONVERSATION_ID never stands in for missing call metadata", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "mbx-agy-env-"));
  const n = new MbxNode(home, { host: "alpha" });
  const c = new Client({ name: "agy", version: "test" });
  t.after(async () => { await c.close(); n.close(); rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
  await c.connect(transportFor(home, ROOT));
  const r = await c.callTool({ name: "mbx_identity", arguments: { action: "register", name: "lab", role: "builder" } });
  assert.equal(r.isError, true);
  assert.match(textOf(r), /Antigravity conversation metadata is required/);
  assert.equal(n.store.db.prepare("SELECT 1 FROM identity_leases WHERE name='lab'").get(), undefined);
});

test("T725: a subagent co-uses its root's held mailbox and never claims it when the root does not hold it", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "mbx-agy-sub-"));
  const n = new MbxNode(home, { host: "alpha" });
  const c = new Client({ name: "agy", version: "test" });
  t.after(async () => { await c.close(); n.close(); rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
  await c.connect(transportFor(home));
  const call = (sid: string, name: string, args = {}, root = ROOT) => c.callTool({ name, arguments: args,
    _meta: { "antigravity.google/conversation_id": sid, "antigravity.google/root_conversation_id": root } });
  assert.notEqual((await call(ROOT, "mbx_identity", { action: "register", name: "lab", role: "builder" })).isError, true);
  const co = (await call(SUB, "mbx_whoami")).structuredContent as { agent: string | null };
  assert.equal(co.agent, "lab", "the subagent co-uses the root's live lease");
  const lease = () => n.store.db.prepare("SELECT session_id, released_at FROM identity_leases WHERE name='lab'").get() as { session_id: string; released_at: number | null };
  assert.equal(lease().session_id, ROOT);
  // the root's lease goes away (restart or idle expiry) while its remembered name stays
  assert.notEqual((await call(ROOT, "mbx_identity", { action: "release" })).isError, true);
  n.store.set(`name:agy:${ROOT}`, "lab");
  const fresh = (await call(SUB2, "mbx_whoami")).structuredContent as { agent: string | null };
  assert.notEqual(fresh.agent, "lab", "a new subagent does not resume the root's remembered name by itself");
  const claim = await call(SUB, "mbx_identity", { action: "claim", name: "lab" });
  assert.equal(claim.isError, true, "an explicit claim of the root's mailbox by its subagent is refused");
  assert.match(textOf(claim), /belongs to this subagent's root conversation/);
  assert.notEqual(lease().released_at, null, "nobody holds lab: the root can claim it back");
  assert.notEqual((await call(ROOT, "mbx_identity", { action: "claim", name: "lab" })).isError, true);
  assert.equal(lease().session_id, ROOT);
});
