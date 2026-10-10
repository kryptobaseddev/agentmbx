import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { MbxNode } from "../src/node.ts";

const bin = join(import.meta.dirname, "../bin/agentmbx.js");
const textOf = (r: unknown) => ((r as { content: { text: string }[] }).content ?? []).map((c) => c.text).join("\n");

// T516: an OpenCode MCP call that carries no session `_meta` must route by THIS process's bound session state, never
// refuse against its own process. One bound state -> use it; several -> an explicit ambiguity naming the fix.
test("T516: no-_meta calls resolve to the single bound session, or fail explicitly when several are bound", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "mbx-oc-nometa-"));
  const n = new MbxNode(home, { host: "alpha" });
  n.registerAgent("receiver"); // T205: sends need an existing recipient
  const c = new Client({ name: "opencode", version: "test" });
  t.after(async () => { await c.close(); n.close(); rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
  // No MBX_AGENT: the transport's own base identity stays unbound, so only the session states decide the no-_meta answer.
  await c.connect(new StdioClientTransport({ command: process.execPath, args: [bin, "mcp"], env: { ...process.env, HOME: home, XDG_CONFIG_HOME: join(home, ".config"), XDG_DATA_HOME: join(home, ".local/share"), XDG_CACHE_HOME: join(home, ".cache"), AGENTMBX_DEV: "1", MBX_HOME: home, MBX_AGENT: "", MBX_CLI: "opencode", MBX_NO_DESKTOP: "1" } as Record<string,string> }));
  const call = (sid: string, name: string, args = {}) => c.callTool({ name, arguments: args, _meta: { sessionID: sid } });

  // AC4-1: with exactly one bound session state, a no-_meta call acts as that session (same identity and session key).
  assert.notEqual((await call("ses_alpha", "mbx_identity", { action: "register", name: "alpha", role: "builder" })).isError, true);
  const viaMeta = await call("ses_alpha", "mbx_whoami");
  const aa = viaMeta.structuredContent as { agent: string; session: string };
  assert.equal(aa.agent, "alpha");
  const noMetaWho = await c.callTool({ name: "mbx_whoami", arguments: {} });
  assert.notEqual(noMetaWho.isError, true, textOf(noMetaWho));
  const nmWho = noMetaWho.structuredContent as { agent: string; session: string };
  assert.deepEqual([nmWho.agent, nmWho.session], [aa.agent, aa.session], "a no-_meta call in a single-session server acts as that session");
  const id = n.send({ from: "sender", to: [aa.agent], subject: "single", body: "only bound session" }).envelope.id;
  const noMetaRead = await c.callTool({ name: "mbx_read", arguments: { ids: [id] } });
  assert.notEqual(noMetaRead.isError, true, textOf(noMetaRead));

  // AC4-2: with several bound sessions, a no-_meta call is an explicit ambiguity naming the fix, never a lease refusal.
  assert.notEqual((await call("ses_beta", "mbx_identity", { action: "register", name: "beta", role: "builder" })).isError, true);
  assert.equal(((await call("ses_beta", "mbx_whoami")).structuredContent as { agent: string }).agent, "beta");
  const ambiguous = await c.callTool({ name: "mbx_whoami", arguments: {} });
  assert.equal(ambiguous.isError, true, "a no-_meta call with two bound sessions is an explicit ambiguity");
  assert.match(textOf(ambiguous), /ambiguous OpenCode session/i);
  assert.match(textOf(ambiguous), /Pass _meta.*sessionID/, "the ambiguity error names the _meta fix");
  assert.doesNotMatch(textOf(ambiguous), /held by|lease refusal/i, "ambiguity never goes through a lease refusal");

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
  await c.connect(new StdioClientTransport({ command: process.execPath, args: [bin, "mcp"], env: { ...process.env, HOME: home, XDG_CONFIG_HOME: join(home, ".config"), XDG_DATA_HOME: join(home, ".local/share"), XDG_CACHE_HOME: join(home, ".cache"), AGENTMBX_DEV: "1", MBX_HOME: home, MBX_AGENT: "", MBX_CLI: "opencode", MBX_NO_DESKTOP: "1" } as Record<string,string> }));
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
