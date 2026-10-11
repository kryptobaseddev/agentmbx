import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, copyFileSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { MbxNode } from "../src/node.ts";
import { opencodeHostOf, processArgsTable } from "../src/opencode-provider.ts";

const bin = join(import.meta.dirname, "../bin/agentmbx.js");
const textOf = (r: unknown) => ((r as { content: { text: string }[] }).content ?? []).map((c) => c.text).join("\n");

// Real executable identity exercises the production host classifier, not an environment override.
// This is a Node fixture named opencode, never a real OpenCode server or the owner's mailbox.
function transportFor(home: string, host: "standalone" | "service" | "unknown"): StdioClientTransport {
  const env = { ...process.env, HOME: home, XDG_CONFIG_HOME: join(home, ".config"), XDG_DATA_HOME: join(home, ".local/share"), XDG_CACHE_HOME: join(home, ".cache"), OPENCODE_CONFIG_DIR: home, AGENTMBX_DEV: "1", MBX_HOME: home, MBX_CLI: "opencode", MBX_NO_DESKTOP: "1" } as Record<string, string>;
  for (const key of Object.keys(env)) if (key.startsWith("MBX_MCP_") || ["MBX_AGENT", "MBX_ROLE", "MBX_CHANNEL"].includes(key)) delete env[key];
  const executable = join(home, host === "unknown" ? "zsh" : "opencode");
  if (process.platform === "darwin") symlinkSync(process.execPath, executable);
  else { copyFileSync(process.execPath, executable); chmodSync(executable, 0o755); }
  const wrapper = join(home, "provider.mjs");
  writeFileSync(wrapper, `import { spawn } from 'node:child_process';
const child = spawn(${JSON.stringify(process.execPath)}, [${JSON.stringify(bin)}, 'mcp'], { stdio: 'inherit' });
child.on('exit', code => process.exit(code ?? 1));
process.on('SIGTERM', () => child.kill('SIGTERM'));
process.on('SIGINT', () => child.kill('SIGINT'));
`);
  return new StdioClientTransport({ command: executable, args: [wrapper, host === "service" ? "--service" : "--stdio"], env });
}

// T516: a standalone host can have an unbound second tab even when only one session has called MBX.
test("T516: standalone no-_meta calls never borrow one or several bound sessions", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "mbx-oc-nometa-"));
  const n = new MbxNode(home, { host: "alpha" });
  n.registerAgent("receiver"); // T205: sends need an existing recipient
  const c = new Client({ name: "opencode", version: "test" });
  t.after(async () => { await c.close(); n.close(); rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
  // No MBX_AGENT: the transport's own base identity stays unbound, so only the session states decide the no-_meta answer.
  await c.connect(transportFor(home, "standalone"));
  const call = (sid: string, name: string, args = {}) => c.callTool({ name, arguments: args, _meta: { sessionID: sid } });

  const refused = async (name: string, args = {}) => {
    const result = await c.callTool({ name, arguments: args });
    assert.equal(result.isError, true, "no-meta calls have no proven session");
    assert.match(textOf(result), /session metadata is required/);
    assert.match(textOf(result), /_meta.*sessionID/);
    assert.match(textOf(result), /codemode=false/);
    assert.equal(result.structuredContent, undefined);
  };
  await refused("mbx_identity", { action: "register", name: "anonymous", role: "builder" });
  assert.equal(n.store.db.prepare("SELECT name FROM agents WHERE name='anonymous'").get(), undefined);
  assert.notEqual((await call("ses_alpha", "mbx_identity", { action: "register", name: "alpha", role: "builder" })).isError, true);
  const viaMeta = await call("ses_alpha", "mbx_whoami");
  const aa = viaMeta.structuredContent as { agent: string; session: string };
  assert.equal(aa.agent, "alpha");
  await refused("mbx_whoami");
  const id = n.send({ from: "sender", to: [aa.agent], subject: "single", body: "only bound session" }).envelope.id;
  const prior = n.store.db.prepare("SELECT token,heartbeat_at FROM identity_leases WHERE name='alpha'").get();
  await refused("mbx_read", { ids: [id] });
  await refused("mbx_ack", { ids: [id] });
  await refused("mbx_inbox");
  assert.deepEqual(n.store.db.prepare("SELECT token,heartbeat_at FROM identity_leases WHERE name='alpha'").get(), prior, "an unattributed call never touches the bound lease");
  assert.equal(n.unreadCount("alpha"), 1, "no-meta read/ack leaves private mail untouched");

  // Binding a second session does not change the metadata requirement.
  assert.notEqual((await call("ses_beta", "mbx_identity", { action: "register", name: "beta", role: "builder" })).isError, true);
  assert.equal(((await call("ses_beta", "mbx_whoami")).structuredContent as { agent: string }).agent, "beta");
  await refused("mbx_whoami");

  // AC4-3: the ambiguity must not corrupt either session — every _meta call still sees only its own identity and mail.
  const a2 = (await call("ses_alpha", "mbx_whoami")).structuredContent as { agent: string };
  const b2 = (await call("ses_beta", "mbx_whoami")).structuredContent as { agent: string };
  assert.deepEqual([a2.agent, b2.agent], ["alpha", "beta"], "sessions stay isolated after the ambiguity");
  const pa = n.send({ from: "sender", to: ["alpha"], subject: "pa", body: "alpha private" }).envelope.id;
  const pb = n.send({ from: "sender", to: ["beta"], subject: "pb", body: "beta private" }).envelope.id;
  assert.notEqual((await call("ses_alpha", "mbx_read", { ids: [pa] })).isError, true);
  assert.equal((await call("ses_alpha", "mbx_read", { ids: [pb] })).isError, true, "alpha cannot read beta's mail");
  assert.notEqual((await call("ses_beta", "mbx_read", { ids: [pb] })).isError, true);
  assert.equal((await call("ses_beta", "mbx_read", { ids: [pa] })).isError, true, "beta cannot read alpha's mail");
  const inboxA = await call("ses_alpha", "mbx_inbox", { all: true });
  const inboxB = await call("ses_beta", "mbx_inbox", { all: true });
  const idsA = (inboxA.structuredContent as { messages: { id: string }[] }).messages.map((m) => m.id);
  const idsB = (inboxB.structuredContent as { messages: { id: string }[] }).messages.map((m) => m.id);
  assert.ok(idsA.includes(pa) && !idsA.includes(pb), "alpha's inbox holds only its own mail");
  assert.ok(idsB.includes(pb) && !idsB.includes(pa), "beta's inbox holds only its own mail");
});

// T516 AC3 (lead's correction): within one serve process, co-use is SAME-SESSION only. A different session claiming a
// sibling session's identity is refused (T308 AC2: never a cross-identity leak) — it is never reported as co-use, it
// adopts nothing, and it sees none of the holder's counts.
test("T516: a different session in one process cannot claim a sibling session's identity", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "mbx-oc-cross-"));
  const n = new MbxNode(home, { host: "alpha" });
  n.registerAgent("receiver");
  const c = new Client({ name: "opencode", version: "test" });
  t.after(async () => { await c.close(); n.close(); rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
  await c.connect(transportFor(home, "standalone"));
  const call = (sid: string, name: string, args = {}) => c.callTool({ name, arguments: args, _meta: { sessionID: sid } });
  assert.notEqual((await call("ses_alpha", "mbx_identity", { action: "register", name: "alpha", role: "builder" })).isError, true);
  const pa = n.send({ from: "sender", to: ["alpha"], subject: "pa", body: "alpha private" }).envelope.id;
  assert.notEqual((await call("ses_alpha", "mbx_read", { ids: [pa] })).isError, true, "alpha reads its own mail");
  // ses_beta shares this process (same pid, birth and cli) but is a DIFFERENT session: the same-process AC3 co-use
  // branch only applies to the SAME session id, so claiming alpha falls through to the ordinary live-holder refusal.
  const claimed = await call("ses_beta", "mbx_identity", { action: "claim", name: "alpha" });
  assert.equal(claimed.isError, true, "an unbound different session is refused when it claims a sibling's identity");
  assert.doesNotMatch(textOf(claimed), /co-?use/i, "a cross-session claim is never a co-use of the holder's lease (T308 AC2)");
  assert.match(textOf(claimed), /not available|held by/i, "the refusal names the live holder");
  const after = (await call("ses_beta", "mbx_whoami")).structuredContent as { agent: string | null; unbound?: boolean };
  assert.equal(after.agent, null, "the refused session adopted nothing and stays unbound");
  // A same-process sibling that was refused its claim then runs its own identity: it sees only its own counts.
  assert.notEqual((await call("ses_beta", "mbx_identity", { action: "register", name: "beta", role: "builder" })).isError, true);
  const pb = n.send({ from: "sender", to: ["beta"], subject: "pb", body: "beta private" }).envelope.id;
  const inbox = await call("ses_beta", "mbx_inbox", { all: true });
  const ids = (inbox.structuredContent as { messages: { id: string }[] }).messages.map((m) => m.id);
  assert.ok(ids.includes(pb) && !ids.includes(pa), "beta sees its own mail and none of alpha's counts");
  assert.notEqual((await call("ses_alpha", "mbx_read", { ids: [pa] })).isError, true, "alpha's mail and lease are untouched");
  const lease = n.store.db.prepare("SELECT session_id FROM identity_leases WHERE name='alpha'").get() as { session_id: string };
  assert.equal(lease.session_id, "ses_alpha", "alpha's lease still names its own session");
});

for (const host of ["service", "unknown"] as const) test(`T516: ${host} host never lends its single bound session to a no-_meta caller`, async (t) => {
  const home = mkdtempSync(join(tmpdir(), `mbx-oc-${host}-`));
  const n = new MbxNode(home, { host: "scratch" });
  const c = new Client({ name: "opencode", version: "test" });
  t.after(async () => { await c.close(); n.close(); rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
  await c.connect(transportFor(home, host));
  const meta = { "ai.opencode/sessionID": "ses_alpha" };
  assert.notEqual((await c.callTool({ name: "mbx_identity", arguments: { action: "register", name: "alpha", role: "builder" }, _meta: meta })).isError, true);
  const lease = n.store.db.prepare("SELECT holder_pid FROM identity_leases WHERE name='alpha'").get() as { holder_pid: number };
  const record = JSON.parse(n.store.get(`mcp-provider:${lease.holder_pid}`)!) as { providerPid: number };
  assert.equal(opencodeHostOf(record.providerPid), host, JSON.stringify([...processArgsTable([record.providerPid])].filter(([pid]) => pid === record.providerPid)));
  const mail = n.send({ from: "sender", to: ["alpha"], subject: "private alpha", body: "alpha only" }).envelope.id;
  const who = await c.callTool({ name: "mbx_whoami", arguments: {} });
  assert.equal(who.isError, true);
  assert.match(textOf(who), /session metadata is required/);
  assert.equal(who.structuredContent, undefined, "no identity or counts leak");
  const read = await c.callTool({ name: "mbx_read", arguments: { ids: [mail] } });
  assert.equal(read.isError, true, "an unidentified caller cannot read the bound session's mail");
  const inbox = await c.callTool({ name: "mbx_inbox", arguments: {} });
  assert.equal(inbox.isError, true);
  assert.equal(inbox.structuredContent, undefined, "no mailbox counts or subjects leak");
  const alpha = await c.callTool({ name: "mbx_read", arguments: { ids: [mail] }, _meta: meta });
  assert.notEqual(alpha.isError, true, textOf(alpha));
  assert.match(textOf(alpha), /alpha only/);
});
