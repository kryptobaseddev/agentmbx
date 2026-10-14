// T622: an in-place handover child is started with the released name and detectHost's
// provisional mcp-<pid>. When this provider has exactly one hook-bound harness session,
// the reclaimed lease and the identity.claim audit must carry that id.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { MbxNode } from "../src/node.ts";
import { IdentityLeases, inspectLeaseProcess } from "../src/identity-leases.ts";
import { generateKeyPair, fingerprint } from "../src/crypto.ts";
import { procStart } from "../src/proc.ts";

const bin = join(import.meta.dirname, "../bin/agentmbx.js");
const HARNESS = "20261012_104708_6e6574";

const reclaim = async (t: { after: (fn: () => Promise<void>) => void }, home: string, project: string) => {
  const provider = inspectLeaseProcess(process.pid);
  assert.equal(provider.alive, true);
  assert.ok(provider.start);
  const key = generateKeyPair();
  const node = new MbxNode(home, { host: "alpha" });
  const prior = new IdentityLeases(node.store).claim("t622-staff", {
    pid: process.pid, start: provider.start, keyFp: fingerprint(key.publicKey), cli: "hermes", sessionId: "mcp-1",
  });
  new IdentityLeases(node.store).release("t622-staff", prior.token);
  const client = new Client({ name: "hermes", version: "test" });
  t.after(async () => {
    await client.close();
    node.close();
    rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    rmSync(project, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  const env: Record<string, string> = { ...process.env, AGENTMBX_DEV: "1", MBX_HOME: home, MBX_CLI: "hermes", MBX_NO_DESKTOP: "1",
    MBX_MCP_REEXEC: "1", MBX_MCP_PARENT_AGENT: "t622-staff",
    MBX_MCP_PROVIDER_PID: String(process.pid), MBX_MCP_PROVIDER_START: provider.start! };
  delete env.MBX_AGENT;
  delete env.MBX_MCP_DETACHED;
  delete env.MBX_MCP_REEXEC_BUILD;
  delete env.MBX_MCP_ORIGINAL_PID;
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [bin, "mcp"], cwd: project, env }));
  const who = await client.callTool({ name: "mbx_whoami", arguments: {} });
  assert.notEqual(who.isError, true, JSON.stringify(who));
  const harness = (who.structuredContent as { agent: string; harness_session: string }).harness_session;
  const lease = node.store.db.prepare("SELECT session_id, released_at FROM identity_leases WHERE name=?").get("t622-staff") as { session_id: string; released_at: number | null };
  const claim = node.store.db.prepare("SELECT detail FROM audit WHERE event='identity.claim' ORDER BY rowid DESC LIMIT 1").get() as { detail: string };
  return { harness, agent: (who.structuredContent as { agent: string }).agent, lease, claim: JSON.parse(claim.detail) as { holder: { sessionId: string } } };
};

test("handover reclaim stores the one hook-bound harness session on the lease and the claim audit (T622)", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "mbx-t622-")), project = realpathSync(mkdtempSync(join(tmpdir(), "mbx-t622-work-")));
  const node = new MbxNode(home, { host: "alpha" });
  const birth = procStart(process.pid);
  assert.ok(birth);
  node.store.db.prepare("INSERT INTO sessions (agent,cli,session_id,cwd,pid,session_key,channel,updated_at,pid_start) VALUES (?,?,?,?,?,?,?,?,?)")
    .run("t622-staff", "hermes", HARNESS, project, process.pid, null, 0, new Date().toISOString(), birth);
  node.close();
  const got = await reclaim(t, home, project);
  assert.equal(got.agent, "t622-staff");
  assert.equal(got.harness, HARNESS);
  assert.equal(got.lease.session_id, HARNESS);
  assert.equal(got.lease.released_at, null);
  assert.equal(got.claim.holder.sessionId, HARNESS);
});

test("handover reclaim keeps the provisional id when no harness session is bound (T622)", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "mbx-t622-none-")), project = realpathSync(mkdtempSync(join(tmpdir(), "mbx-t622-none-work-")));
  const got = await reclaim(t, home, project);
  assert.equal(got.agent, "t622-staff");
  assert.match(got.harness, /^mcp-\d+$/);
  assert.equal(got.lease.session_id, got.harness);
  assert.equal(got.lease.released_at, null);
  assert.equal(got.claim.holder.sessionId, got.harness);
});
