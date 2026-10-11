// T525: the real Hermes session id is bound to the lease. Hermes's pre_llm_call payload carries the whole conversation
// (`extra.conversation_history`), which is past 64 KiB from the second turn on; the hook used to read that stdin as "" (EAGAIN)
// and quietly do nothing, so the sessions row kept `mcp-<pid>` and nothing keyed by the real id (status, HUD, doctor, MCP reload
// resume) could find the identity. Hooks here are spawned asynchronously and fed through a pipe, as Hermes's Python does.
// The MCP server and every hook share this test process as their parent, which is the topology of a real Hermes gateway.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { MbxNode } from "../src/node.ts";
import { sessionReadiness } from "../src/doctor.ts";
import { hudSessionPath, hudSessionV2Path, hudStatus, hudStatusV2, writeHud } from "../src/hud.ts";
import { resolveStatusIdentity } from "../src/status-identity.ts";
import { sendLeased } from "./helpers/leased-send.ts";

const SID = "20261010_070000_abc123"; // the shape of a real Hermes session id: YYYYMMDD_HHMMSS_<6 hex>
const AGENT = "t525-builder";
const BIG = 200_000; // bytes of conversation history in one pre_llm_call payload

interface Hook { status: number | null; stdout: string; stderr: string }

async function hermesGateway(t: { after: (fn: () => Promise<void> | void) => void }) {
  const home = mkdtempSync(join(tmpdir(), "mbx-t525-")), node = new MbxNode(home, { host: "alpha" });
  const env = { ...process.env, AGENTMBX_DEV: "1", MBX_HOME: home, MBX_CLI: "hermes", MBX_NO_DESKTOP: "1", MBX_DEBUG: "" } as Record<string, string>;
  delete env.MBX_AGENT; // no launch-config name: the identity must come from a claim and from the hook-bound session, as in Hermes
  const clients: Client[] = [];
  t.after(async () => { for (const c of clients) await c.close().catch(() => {}); node.close(); rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
  /** Hermes (re)starts its mbx MCP server: a new `agentmbx mcp` process under the same parent. */
  const startMcp = async () => {
    const c = new Client({ name: "hermes-gateway", version: "1" });
    await c.connect(new StdioClientTransport({ command: process.execPath, args: [resolve("bin/agentmbx.js"), "mcp"], env }));
    clients.push(c); return c;
  };
  const whoami = async (c: Client) => (await c.callTool({ name: "mbx_whoami", arguments: {} })).structuredContent as { agent: string | null; session: string };
  /** One hook call exactly as Hermes's shell_hooks._spawn makes it: pipe, write the payload, close, collect. */
  const runHook = (event: "session-start" | "prompt", payload: string | null, cli = "hermes") => new Promise<Hook>((done, fail) => {
    const child = spawn(process.execPath, [resolve("bin/agentmbx.js"), "hook", event, "--cli", cli], { env, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.on("data", d => (stdout += d)); child.stderr.on("data", d => (stderr += d));
    child.stdin.on("error", () => {});
    const timer = setTimeout(() => { child.kill(); fail(new Error(`hook did not finish: ${stderr}`)); }, 30_000);
    child.on("close", status => { clearTimeout(timer); done({ status, stdout, stderr }); });
    child.stdin.end(payload ?? "");
  });
  const payload = (event: "session-start" | "prompt", extra: Record<string, unknown>, history = 0, sid: string = SID) => JSON.stringify({
    hook_event_name: event === "prompt" ? "pre_llm_call" : "on_session_start", tool_name: null, tool_input: null, session_id: sid, cwd: process.cwd(), profile: "default",
    extra: { ...extra, ...(history ? { conversation_history: [{ role: "system", content: "x".repeat(history) }] } : {}) } });
  const rows = () => node.store.db.prepare("SELECT cli,session_id FROM sessions WHERE cli='hermes'").all().map(r => `${r.cli}:${r.session_id}`);
  return { home, node, env, startMcp, whoami, runHook, payload, rows };
}

/** Turn 1 of a Hermes conversation, before the agent has an identity: small payloads, unbound path. */
async function firstTurn(g: Awaited<ReturnType<typeof hermesGateway>>) {
  const start = await g.runHook("session-start", g.payload("session-start", { model: "m", platform: "tui" }));
  const prompt = await g.runHook("prompt", g.payload("prompt", { turn_id: "u1", user_message: "hello", is_first_turn: true, model: "m", platform: "tui", sender_id: "" }));
  assert.deepEqual([start.status, prompt.status], [0, 0]);
  assert.deepEqual(g.rows(), [], "nothing to bind yet: the conversation holds no identity");
}

test("T525 AC1/AC4: a conversation-sized pre_llm_call payload binds the real session id on the first bound prompt", async t => {
  const g = await hermesGateway(t), c = await g.startMcp();
  await firstTurn(g);
  assert.equal((await c.callTool({ name: "mbx_identity", arguments: { action: "register", name: AGENT, role: "hermes", description: "t525" } })).isError, undefined);
  assert.match(g.rows().join(), /^hermes:mcp-\d+$/, "bound by the MCP only: the row still carries the provisional session");

  const turn2 = await g.runHook("prompt", g.payload("prompt", { turn_id: "u2", user_message: "next", is_first_turn: false, model: "m", platform: "tui", sender_id: "" }, BIG));
  assert.equal(turn2.status, 0, turn2.stderr); assert.equal(turn2.stderr, "");
  assert.deepEqual(g.rows(), [`hermes:${SID}`], "the hook read its whole payload and rebound the row to the real Hermes session id");
});

test("T525 AC2/AC3: status (CLI v1 + v2, endpoint, HUD) and doctor see the bound identity and its counts under the real id", async t => {
  const g = await hermesGateway(t), c = await g.startMcp();
  await firstTurn(g);
  await c.callTool({ name: "mbx_identity", arguments: { action: "register", name: AGENT, role: "hermes", description: "t525" } });
  sendLeased(g.node, { from: "boss@alpha", to: [AGENT], subject: "do it", body: "now", kind: "request", needs_reply: true });
  await g.runHook("prompt", g.payload("prompt", { turn_id: "u2", user_message: "next", model: "m", platform: "tui", sender_id: "" }, BIG));
  assert.deepEqual(g.rows(), [`hermes:${SID}`]);

  const cli = (schema: string) => JSON.parse(spawnSync(process.execPath, [resolve("bin/agentmbx.js"), "status", "--cli", "hermes", "--session", SID, "--json", "--schema", schema],
    { env: g.env, encoding: "utf8", timeout: 20_000 }).stdout) as Record<string, any>;
  const v1 = cli("mbx.status/v1"), v2 = cli("mbx.status/v2");
  assert.deepEqual([v1.identity.name, v1.identity.state, v1.unread, v1.needs_reply], [AGENT, "bound", 1, 1]);
  assert.deepEqual([v2.identity.name, v2.identity.state, v2.inbox.unread, v2.harness.session_id], [AGENT, "bound", 1, SID]);

  // GET /v1/status?cli=hermes&session=<id> (src/http.ts) is these two calls over resolveStatusIdentity.
  const resolved = resolveStatusIdentity(g.node, "hermes", { sessionId: SID });
  assert.deepEqual([resolved.name, resolved.state], [AGENT, "bound"]);
  const endpoint = hudStatus(g.node, { agent: resolved.name, state: resolved.state, resolvedBy: resolved.resolved_by ?? "none" });
  const endpoint2 = hudStatusV2(g.node, { cli: "hermes", sessionId: SID, agent: resolved.name, state: resolved.state, resolvedBy: resolved.resolved_by ?? "none" });
  assert.deepEqual([endpoint.unread, endpoint.needs_reply, endpoint2.inbox.unread], [1, 1, 1]);

  writeHud(g.node);
  const hud1 = JSON.parse(readFileSync(hudSessionPath(g.home, "hermes", SID), "utf8")), hud2 = JSON.parse(readFileSync(hudSessionV2Path(g.home, "hermes", SID), "utf8"));
  assert.deepEqual([hud1.identity.name, hud1.unread, hud2.inbox.unread], [AGENT, 1, 1], "a hermes HUD snapshot now exists for the real id");
  assert.deepEqual([v1.unread, v1.needs_reply, v1.from_owner], [hud1.unread, hud1.needs_reply, hud1.from_owner], "the numbers agree across surfaces");

  const ready = sessionReadiness(g.node, "hermes");
  assert.match(ready.label, /1 verified live mailbox binding\(s\), 1 real session ID\(s\)/);
  assert.notEqual(ready.level, "warn", "no 'run the provider session-start hook' warning once the real id is bound");
});

test("T525 AC5: when Hermes reloads its mbx MCP server mid-session, the new MCP resumes the same identity with no claim", async t => {
  const g = await hermesGateway(t), first = await g.startMcp();
  await firstTurn(g);
  await first.callTool({ name: "mbx_identity", arguments: { action: "register", name: AGENT, role: "hermes", description: "t525" } });
  await g.runHook("prompt", g.payload("prompt", { turn_id: "u2", user_message: "next", model: "m", platform: "tui", sender_id: "" }, BIG));
  assert.deepEqual(g.rows(), [`hermes:${SID}`]);

  await first.close(); // Hermes closes the server (config change / reload) and spawns a replacement under the same gateway
  const second = await g.startMcp();
  assert.equal((await g.whoami(second)).agent, AGENT, "same identity, no mbx_identity claim");
  assert.equal((await second.callTool({ name: "mbx_inbox", arguments: {} })).isError, undefined, "and its mailbox tools work");
});

test("T525 AC5 control: a reload where the hook never bound the real id comes back unbound (the failure this fixes)", async t => {
  const g = await hermesGateway(t), first = await g.startMcp();
  await firstTurn(g);
  await first.callTool({ name: "mbx_identity", arguments: { action: "register", name: AGENT, role: "hermes", description: "t525" } });
  assert.match(g.rows().join(), /^hermes:mcp-\d+$/, "no bound hook ran: the row is still provisional");
  await first.close();
  assert.equal((await g.whoami(await g.startMcp())).agent, null, "nothing keyed by a real session id to resume from");
});

test("T525: a Hermes hook that cannot read any payload exits 1 with a note, so Hermes logs it; other providers and real payloads are unchanged", async t => {
  const g = await hermesGateway(t); await g.startMcp();
  const empty = await g.runHook("prompt", null);
  assert.deepEqual([empty.status, empty.stdout, empty.stderr], [1, "", "[mbx] hook: empty stdin\n"]);
  const blank = await g.runHook("session-start", "  \n");
  assert.deepEqual([blank.status, blank.stderr], [1, "[mbx] hook: empty stdin\n"]);
  const object = await g.runHook("prompt", "{}");
  assert.deepEqual([object.status, object.stdout, object.stderr], [0, "", ""], "an empty JSON object is a payload with no session: quiet, as before");
  const other = await g.runHook("prompt", null, "claude");
  assert.deepEqual([other.status, other.stderr], [0, ""], "only --cli hermes changed");
});

test("T525: `agentmbx send` keeps a piped body larger than the 64 KiB pipe buffer", async t => {
  const g = await hermesGateway(t);
  const body = "é".repeat(40_000) + "a".repeat(40_000) + "-end"; // 120 KB on the wire, under the 256 KB message limit
  const sent = await new Promise<{ status: number | null; stderr: string; stdout: string }>((done, fail) => {
    const child = spawn(process.execPath, [resolve("bin/agentmbx.js"), "send", "--as", "t525-sender", "--to", "t525-reader", "--subject", "big", "--new-mailbox", "--json"],
      { env: g.env, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.on("data", d => (stdout += d)); child.stderr.on("data", d => (stderr += d));
    child.stdin.on("error", () => {});
    child.on("close", status => done({ status, stdout, stderr })); child.on("error", fail);
    child.stdin.end(body);
  });
  assert.equal(sent.status, 0, sent.stderr);
  const [message] = g.node.inbox("t525-reader");
  assert.ok(message, "the message arrived");
  assert.equal(g.node.read(message.id, "t525-reader").body, body, "the whole body, not an empty one");
});
