// T202: a plainly started Claude session is woken through its inbox socket by its own mbx MCP server (no flags, no cron).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { MbxNode } from "../src/node.ts";
import { socketPush } from "../src/mcp.ts";
import { dispatchWakes } from "../src/wake.ts";
import { delegateWake } from "./helpers/wake-lease.ts";
import { sendLeased } from "./helpers/leased-send.ts";

/** A stand-in for Claude Code's session inbox socket that records each NDJSON line it receives. */
async function fakeInbox(t: { after: (fn: () => unknown) => void }, name = "inbox.sock") {
  const dir = mkdtempSync(join(tmpdir(), "mbx-sock-")), path = join(dir, name), lines: Record<string, unknown>[] = [];
  const server: Server = createServer((c) => { let buf = ""; c.on("data", (d) => { buf += d; let i; while ((i = buf.indexOf("\n")) >= 0) { lines.push(JSON.parse(buf.slice(0, i))); buf = buf.slice(i + 1); } }); });
  await new Promise<void>((r) => server.listen(path, r));
  t.after(() => { server.close(); rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
  return { path, lines };
}

test("socketPush sends the auth line, then the hint as a user message", async (t) => {
  const inbox = await fakeInbox(t);
  await socketPush("[mbx] 1 new message(s)", { CLAUDE_CODE_MESSAGING_SOCKET: inbox.path, CLAUDE_CODE_MESSAGING_TOKEN: "tok" });
  await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual(inbox.lines, [{ type: "auth", token: "tok" }, { type: "user", message: { role: "user", content: "[mbx] 1 new message(s)" } }]);
  await assert.rejects(socketPush("x", { CLAUDE_CODE_MESSAGING_SOCKET: join(tmpdir(), "missing-mbx.sock") }), "a missing socket is an error, so the budget is refunded");
});

test("a plain Claude session gets a no-body wake through its socket and the daemon defers to it", async (t) => {
  const inbox = await fakeInbox(t, `${process.pid}.sock`); // owned by this server's parent, as Claude Code names it
  const home = mkdtempSync(join(tmpdir(), "mbx-sock-mcp-"));
  const n = new MbxNode(home, { host: "alpha" }), c = new Client({ name: "socket-wake-test", version: "1" });
  t.after(async () => { await c.close(); n.close(); rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
  await c.connect(new StdioClientTransport({ command: process.execPath, args: [join(import.meta.dirname, "../bin/agentmbx.js"), "mcp"],
    env: { ...process.env, AGENTMBX_DEV: "1", MBX_HOME: home, MBX_CLI: "claude", MBX_AGENT: "worker", MBX_NO_DESKTOP: "1",
      CLAUDE_CODE_MESSAGING_SOCKET: inbox.path, CLAUDE_CODE_MESSAGING_TOKEN: "session-token" } as Record<string, string> }));
  const who = (await c.callTool({ name: "mbx_whoami", arguments: {} })).structuredContent as { delivery: string };
  assert.match(who.delivery, /^push/, "the session reports push delivery, not 'no push'");
  delegateWake(n, "worker");
  const m = sendLeased(n, { from: "boss", to: ["worker"], subject: "please review", body: "secret body", kind: "request" }).envelope;
  assert.deepEqual(await dispatchWakes(n), [], "the daemon leaves this session to its own MCP server");
  for (let i = 0; i < 40 && inbox.lines.length < 2; i++) await new Promise((r) => setTimeout(r, 100));
  assert.deepEqual(inbox.lines[0], { type: "auth", token: "session-token" });
  const hint = (inbox.lines[1] as { message: { content: string } }).message.content;
  assert.match(hint, /^\[mbx\] 1 new message\(s\) for worker/);
  assert.ok(hint.includes(m.id) && !hint.includes("secret body"), "ids, never bodies");
  // the server records the delivery and audit right after the push resolves, a moment after the socket saw the lines
  const state = () => (n.store.db.prepare("SELECT state FROM deliveries WHERE msg_id=?").get(m.id) as { state: string }).state;
  for (let i = 0; i < 40 && state() !== "notified"; i++) await new Promise((r) => setTimeout(r, 100));
  assert.equal(state(), "notified");
  assert.ok(n.store.db.prepare("SELECT 1 FROM audit WHERE event='wake.attempt' AND detail LIKE '%session socket%'").get());
});

test("a server whose parent does not own the inherited socket never pushes into that session", async (t) => {
  const inbox = await fakeInbox(t, "999999.sock"); // some other session's socket, inherited through the environment
  const home = mkdtempSync(join(tmpdir(), "mbx-sock-foreign-"));
  const n = new MbxNode(home, { host: "alpha" }), c = new Client({ name: "socket-foreign-test", version: "1" });
  t.after(async () => { await c.close(); n.close(); rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
  await c.connect(new StdioClientTransport({ command: process.execPath, args: [join(import.meta.dirname, "../bin/agentmbx.js"), "mcp"],
    env: { ...process.env, AGENTMBX_DEV: "1", MBX_HOME: home, MBX_CLI: "claude", MBX_AGENT: "worker", MBX_NO_DESKTOP: "1",
      CLAUDE_CODE_MESSAGING_SOCKET: inbox.path, CLAUDE_CODE_MESSAGING_TOKEN: "other-token" } as Record<string, string> }));
  const who = (await c.callTool({ name: "mbx_whoami", arguments: {} })).structuredContent as { delivery: string };
  assert.match(who.delivery, /^no push/);
  delegateWake(n, "worker");
  sendLeased(n, { from: "boss", to: ["worker"], subject: "s", body: "b", kind: "request" });
  await new Promise((r) => setTimeout(r, 2_000));
  assert.deepEqual(inbox.lines, [], "nothing reaches a socket this server's parent does not own");
});
