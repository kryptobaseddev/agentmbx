// T383: a second MCP connection of the same provider session must not evict that session's live server.
import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, cpSync, mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { MbxNode } from "../src/node.ts";
import { holderProviderPid, identityAvailability } from "../src/identity-availability.ts";
import { detachedReloadState, reexecEnv } from "../src/mcp.ts";
import type { IdentityLease } from "../src/identity-leases.ts";

const THREAD = "33333333-3333-4333-8333-333333333333";
const bin = join(import.meta.dirname, "../bin/agentmbx.js");
type Lease = { token: string; holder_pid: number; released_at: number | null };

/** An isolated mailbox plus MCP connections to it; `restarted` runs a server under a different provider (parent) process. */
function fixture(t: { after: (fn: () => Promise<void>) => void }) {
  const home = mkdtempSync(join(tmpdir(), "mbx-same-session-")), node = new MbxNode(home, { host: "alpha" });
  const clients: Client[] = [];
  // A provider stand-in: it stays alive as the server's parent, so the server's provider pid is not this test process.
  const provider = join(home, "provider.mjs");
  writeFileSync(provider, `import { spawn } from "node:child_process";
const c = spawn(process.execPath, process.argv.slice(2), { stdio: "inherit" });
c.on("exit", code => process.exit(code ?? 1));
process.on("SIGTERM", () => c.kill("SIGTERM"));`);
  t.after(async () => {
    for (const c of clients.reverse()) await c.close().catch(() => {});
    node.close(); rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  const connect = async (o: { restarted?: boolean } = {}) => {
    const env: Record<string, string> = { ...process.env, MBX_HOME: home, MBX_CLI: "codex", AGENTMBX_DEV: "1", MBX_NO_DESKTOP: "1" } as Record<string, string>;
    for (const k of Object.keys(env)) if (k.startsWith("MBX_MCP_") || ["MBX_AGENT", "MBX_ROLE", "MBX_CHANNEL"].includes(k)) delete env[k];
    const c = new Client({ name: "same-session", version: "test" });
    await c.connect(new StdioClientTransport({ command: process.execPath, args: o.restarted ? [provider, bin, "mcp"] : [bin, "mcp"], env }));
    clients.push(c);
    return c;
  };
  const call = (c: Client, name: string, args: Record<string, unknown> = {}) =>
    c.callTool({ name, arguments: args, _meta: { threadId: THREAD } }, undefined, { timeout: 10_000 });
  const lease = (name: string) => node.store.db.prepare("SELECT token,holder_pid,released_at FROM identity_leases WHERE name=?").get(name) as Lease;
  return { node, connect, call, lease };
}
const who = (r: unknown) => (r as { structuredContent?: unknown }).structuredContent as { agent: string | null; pending?: string | null; reason?: string | null };

test("a second live connection of the same session and provider never takes the lease; the first keeps serving after it closes", async t => {
  const { node, connect, call, lease } = fixture(t);
  const original = await connect();
  assert.notEqual((await call(original, "mbx_identity", { action: "register", name: "same-reader", role: "reader" })).isError, true);
  const held = lease("same-reader");
  const mail = node.send({ from: "sender", to: ["same-reader"], subject: "pending", body: "kept" }).envelope.id;

  const transient = await connect();
  // T439: the newcomer co-uses the live server's lease (test/same-session-sibling.test.ts) instead of taking it.
  const second = who(await call(transient, "mbx_whoami")) as ReturnType<typeof who> & { co_use?: string };
  assert.equal(second.agent, "same-reader", "the newcomer co-uses the session's identity");
  assert.match(String(second.co_use), /co-using this session's identity/);
  assert.deepEqual(lease("same-reader"), held, "co-use takes nothing");
  const listed = JSON.parse(((await call(transient, "mbx_identity", { action: "list" })).content as { text: string }[])[0].text) as
    { identities: { name: string; claimable: boolean; reason: string }[] };
  const entry = listed.identities.find(i => i.name === "same-reader");
  assert.equal(entry?.claimable, false, "identity list agrees with the claim: not claimable");
  assert.match(String(entry?.reason), /live MCP server of this same codex session.*co-uses it/);
  assert.notEqual((await call(transient, "mbx_identity", { action: "claim", name: "same-reader" })).isError, true, "an explicit claim co-uses too");
  assert.deepEqual(lease("same-reader"), held);
  assert.equal(node.store.db.prepare("SELECT 1 FROM audit WHERE event='identity.takeover'").get(), undefined);

  await transient.close();
  await new Promise(r => setTimeout(r, 200));
  assert.deepEqual(lease("same-reader"), held, "closing the transient connection released nothing");
  const first = await call(original, "mbx_whoami");
  assert.notEqual(first.isError, true, JSON.stringify(first));
  assert.equal(who(first).agent, "same-reader");
  assert.notEqual((await call(original, "mbx_read", { ids: [mail] })).isError, true, "the original server keeps serving");

  // A co-using newcomer takes the identity over with its own lease once the live holder really ends.
  const later = await connect();
  assert.equal(who(await call(later, "mbx_whoami")).agent, "same-reader");
  assert.deepEqual(lease("same-reader"), held);
  await original.close();
  const deadline = Date.now() + 10_000;
  while (lease("same-reader").token === held.token || lease("same-reader").released_at !== null) {
    assert.ok(Date.now() < deadline, "the newcomer did not resume after the holder ended");
    await call(later, "mbx_whoami");
    await new Promise(r => setTimeout(r, 50));
  }
  assert.notEqual(lease("same-reader").holder_pid, held.holder_pid);
  assert.notEqual((await call(later, "mbx_read", { ids: [mail] })).isError, true);
});

test("a dead holder of the same session is still taken over", async t => {
  const { connect, call, lease } = fixture(t);
  const original = await connect();
  assert.notEqual((await call(original, "mbx_identity", { action: "register", name: "dead-reader", role: "reader" })).isError, true);
  const held = lease("dead-reader");
  process.kill(held.holder_pid, "SIGKILL"); // no retire: the lease stays unreleased with a dead holder
  const deadline = Date.now() + 5_000;
  while ((() => { try { process.kill(held.holder_pid, 0); return true; } catch { return false; } })()) {
    assert.ok(Date.now() < deadline, "holder did not exit");
    await new Promise(r => setTimeout(r, 25));
  }
  assert.equal(lease("dead-reader").released_at, null);
  const replacement = await connect();
  const resumed = await call(replacement, "mbx_whoami");
  assert.equal(who(resumed).agent, "dead-reader", JSON.stringify(resumed));
  assert.notEqual(lease("dead-reader").holder_pid, held.holder_pid);
});

test("a live holder under a different (restarted) provider process is taken over", async t => {
  const { node, connect, call, lease } = fixture(t);
  const original = await connect();
  assert.notEqual((await call(original, "mbx_identity", { action: "register", name: "moved-reader", role: "reader" })).isError, true);
  const held = lease("moved-reader");
  const replacement = await connect({ restarted: true });
  const resumed = await call(replacement, "mbx_whoami");
  assert.equal(who(resumed).agent, "moved-reader", JSON.stringify(resumed));
  assert.notEqual(lease("moved-reader").holder_pid, held.holder_pid);
  assert.ok(node.store.db.prepare("SELECT 1 FROM audit WHERE event='identity.takeover' AND detail LIKE '%same-session%'").get());
  const fenced = await call(original, "mbx_inbox");
  assert.equal(fenced.isError, true, "the older process is fenced");
});

test("same-session availability depends on the holder's provider process", () => {
  const now = 1_000_000;
  const lease = { name: "x", token: "t", holder_pid: 50, holder_start: "s", key_fp: "k", cli: "codex", session_id: THREAD,
    claimed_at: now, heartbeat_at: now, idle_ttl: 60_000, released_at: null, release_reason: null } as IdentityLease;
  const live = { alive: true, start: "s" };
  const caller = (providerPid: number | undefined, holder: number | null | undefined) => ({ cli: "codex", sessionId: THREAD, providerPid, holderProviderPid: holder });
  assert.equal(identityAvailability({ lease, evidence: live, activity: null, now, caller: caller(10, 10) }).claimable, false, "same provider: live server keeps it");
  assert.equal(identityAvailability({ lease, evidence: live, activity: null, now, caller: caller(10, 20) }).takeover, "same-session", "restarted provider");
  assert.equal(identityAvailability({ lease, evidence: live, activity: null, now, caller: caller(10, null) }).claimable, false, "unknown parentage never evicts");
  assert.equal(identityAvailability({ lease, evidence: live, activity: null, now, caller: caller(undefined, undefined) }).claimable, false);
  assert.equal(identityAvailability({ lease, evidence: { alive: false, start: null }, activity: null, now, caller: caller(10, 10) }).claimable, true, "dead holder");
  // A reloaded server is the child of the server it replaced: the caller's provider anywhere in its ancestry counts.
  const table = new Map([[50, { ppid: 40 }], [40, { ppid: 10 }], [10, { ppid: 1 }]]);
  assert.equal(holderProviderPid(table, 50, 10), 10);
  assert.equal(holderProviderPid(table, 50, 99), 40);
  assert.equal(holderProviderPid(table, 77, 10), null);
});

test("reload metadata accepts a base that lost its lease (no agent)", () => {
  const lost = { sessions: [{ sessionId: THREAD, agent: "reviewer" }] };
  assert.deepEqual(detachedReloadState(reexecEnv(undefined, undefined, lost)), lost);
  const nameless = { base: { released: true }, sessions: [] };
  assert.deepEqual(detachedReloadState(reexecEnv(undefined, undefined, nameless)), nameless);
  assert.throws(() => detachedReloadState({ MBX_MCP_REEXEC: "1", MBX_MCP_DETACHED: '{"base":{"agent":"","released":false},"sessions":[]}' }),
    "an empty name is still not a name");
});

test("build handover with an unbound base (agent \"\") does not crash the server", async t => {
  const root = mkdtempSync(join(tmpdir(), "mbx-handover-unbound-")), install = join(root, "install"), home = join(root, "mail");
  mkdirSync(install);
  for (const path of ["bin", "dist", "package.json"]) cpSync(resolve(path), join(install, path), { recursive: true });
  symlinkSync(resolve("node_modules"), join(install, "node_modules"), "dir");
  const node = new MbxNode(home, { host: "alpha" }), client = new Client({ name: "handover-unbound", version: "1" });
  let closed = false;
  t.after(async () => { await client.close(); node.close(); rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
  const env: NodeJS.ProcessEnv = { ...process.env, MBX_HOME: home, MBX_CLI: "codex", MBX_NO_DESKTOP: "1" };
  for (const k of ["AGENTMBX_DEV", "MBX_AGENT", "MBX_MCP_REEXEC", "MBX_MCP_REEXEC_BUILD", "MBX_MCP_DETACHED", "MBX_MCP_PROVIDER_PID"]) delete env[k];
  const transport = new StdioClientTransport({ command: process.execPath, args: [join(install, "bin/agentmbx.js"), "mcp"], env: env as Record<string, string> });
  await client.connect(transport);
  transport.onclose = () => { closed = true; };
  const call = (tool: string, args = {}) => client.callTool({ name: tool, arguments: args, _meta: { threadId: THREAD } }, undefined, { timeout: 10_000 });
  assert.notEqual((await call("mbx_identity", { action: "register", name: "handover-reader", role: "reader" })).isError, true);
  // The transport's base state never claimed an identity: base.agent is "" at handover.
  const old = node.store.db.prepare("SELECT holder_pid,token FROM identity_leases WHERE name='handover-reader'").get() as Lease;
  appendFileSync(join(install, "dist/cli.js"), "\n// deployed build\n");
  assert.notEqual((await call("mbx_whoami")).isError, true, "the final call finishes under the old build");
  const deadline = Date.now() + 10_000;
  for (;;) {
    const lease = node.store.db.prepare("SELECT holder_pid,released_at FROM identity_leases WHERE name='handover-reader'").get() as Lease;
    if (lease.holder_pid !== old.holder_pid && lease.released_at === null) break;
    assert.ok(Date.now() < deadline, "the replacement did not take over the session");
    assert.equal(closed, false, "Transport closed: the handover crashed the server");
    await new Promise(r => setTimeout(r, 50));
    await call("mbx_whoami").catch(() => {});
  }
  const after = await call("mbx_whoami");
  assert.notEqual(after.isError, true, JSON.stringify(after));
  assert.equal(who(after).agent, "handover-reader");
  assert.equal(closed, false, "the session's transport stays open");
});
