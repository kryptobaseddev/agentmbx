// T582: one mailbox fronts several sub-agents. meta.on_behalf_of is a name, not an address and not a second
// mailbox. from stays the leased mailbox. A reply that names no sub-agent copies the label and still delivers
// to that mailbox. An explicit label wins. An address is refused before anything is stored.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { MbxNode, formatMessage, summaryLine } from "../src/node.ts";
import { checkShape, verifyEnvelope, type Envelope } from "../src/envelope.ts";

type SendOut = { id: string };
type Result = { isError?: boolean; content: { text: string }[]; structuredContent?: unknown };
const BIN = join(import.meta.dirname, "../bin/agentmbx.js");

function world(t: { after: (fn: () => void) => void }) {
  const home = mkdtempSync(join(tmpdir(), "mbx-t582-"));
  const n = new MbxNode(home, { host: "alpha" });
  t.after(() => { n.close(); rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
  return { home, n };
}
const envOf = (n: MbxNode, id: string): Envelope => JSON.parse(n.message(id)!.envelope) as Envelope;
const count = (n: MbxNode) => (n.store.db.prepare("SELECT COUNT(*) AS c FROM messages").get() as { c: number }).c;
const toFront = (to: string[], mailbox: string) => to.some((a) => a === mailbox || a.startsWith(`${mailbox}@`));

test("one mailbox records three sub-agents; a reply copies the label back to that mailbox", (t) => {
  const { n } = world(t);
  n.registerAgent("docs-architect");
  n.registerAgent("reviewer");
  const ids: string[] = [];
  for (const child of ["agent-6", "agent-7", "agent-8"]) {
    const e = n.send({ from: "docs-architect", to: ["reviewer"], subject: child, body: `from ${child}`, onBehalfOf: child }).envelope;
    assert.equal(e.from, "docs-architect@alpha");
    assert.equal(e.meta.on_behalf_of, child);
    assert.equal(verifyEnvelope(e, n.key.publicKey), true);
    assert.equal(checkShape(e), null);
    assert.ok(!e.to.some((a) => a.startsWith(child)), "the child is a label, not a recipient");
    ids.push(e.id);
  }
  const row = n.message(ids[0])!;
  assert.match(formatMessage(row), /from: docs-architect@alpha on behalf of agent-6  to: /);
  assert.match(summaryLine(row), /docs-architect@alpha on behalf of agent-6 → /);
  const reply = n.send({ from: "reviewer", to: ["docs-architect"], subject: "Re: agent-6", body: "ack", reply_to: ids[0] }).envelope;
  assert.equal(reply.from, "reviewer@alpha");
  assert.ok(toFront(reply.to, "docs-architect"));
  assert.equal(reply.meta.on_behalf_of, "agent-6");
  assert.equal(verifyEnvelope(reply, n.key.publicKey), true);
  const over = n.send({ from: "reviewer", to: ["docs-architect"], subject: "Re: agent-6", body: "other", reply_to: ids[0], onBehalfOf: "Agent-9" }).envelope;
  assert.equal(over.meta.on_behalf_of, "agent-9", "an explicit label wins, and it is stored lowercase");
  const plain = n.send({ from: "docs-architect", to: ["reviewer"], subject: "plain", body: "x" }).envelope;
  const quiet = n.send({ from: "reviewer", to: ["docs-architect"], subject: "Re: plain", body: "y", reply_to: plain.id }).envelope;
  assert.equal(quiet.meta.on_behalf_of, undefined);
  const before = count(n);
  assert.throws(() => n.send({ from: "docs-architect", to: ["reviewer"], subject: "bad", body: "x", onBehalfOf: "agent-6@alpha" }), /on_behalf_of must be a name like agent-6, not an address/);
  assert.equal(count(n), before);
});

test("agentmbx send --on-behalf-of records the label and refuses an address", (t) => {
  const { n, home } = world(t);
  n.registerAgent("docs-architect");
  n.registerAgent("reviewer");
  const env: NodeJS.ProcessEnv = { ...process.env, AGENTMBX_DEV: "1", MBX_HOME: home, MBX_NO_DESKTOP: "1" };
  const id = (JSON.parse(execFileSync(process.execPath, [BIN, "send", "--as", "docs-architect", "--to", "reviewer", "--subject", "s", "-m", "b", "--on-behalf-of", "agent-6", "--json"],
    { env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })) as { id: string }).id;
  const e = envOf(n, id);
  assert.equal(e.from, "docs-architect@alpha");
  assert.equal(e.meta.on_behalf_of, "agent-6");
  assert.equal(verifyEnvelope(e, n.key.publicKey), true);
  const before = count(n);
  assert.throws(() => execFileSync(process.execPath, [BIN, "send", "--as", "docs-architect", "--to", "reviewer", "--subject", "s", "-m", "b", "--on-behalf-of", "agent-6@alpha"],
    { env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }), /on_behalf_of must be a name/);
  assert.equal(count(n), before);
});

test("mbx_send on_behalf_of and mbx_reply copies it back to the same mailbox", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "mbx-t582-"));
  const n = new MbxNode(home, { host: "alpha" });
  const clients: Client[] = [];
  t.after(async () => { for (const c of clients) await c.close(); n.close(); rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
  const session = async (name: string) => {
    const c = new Client({ name: `t582-${name}`, version: "1" });
    const env: NodeJS.ProcessEnv = { ...process.env, AGENTMBX_DEV: "1", MBX_HOME: home, MBX_CLI: "claude", MBX_AGENT: name, MBX_NO_DESKTOP: "1", MBX_SESSION_SOCKET: "0" };
    await c.connect(new StdioClientTransport({ command: process.execPath, args: [BIN, "mcp"], env: env as Record<string, string> }));
    clients.push(c);
    await c.callTool({ name: "mbx_whoami", arguments: {} });
    return (tool: string, args: Record<string, unknown>) => c.callTool({ name: tool, arguments: args }) as Promise<Result>;
  };
  const out = (r: Result): SendOut => { assert.notEqual(r.isError, true, r.content.map((c) => c.text).join("\n")); return r.structuredContent as SendOut; };
  const lead = await session("docs-architect");
  const reviewer = await session("reviewer");
  const sent = out(await lead("mbx_send", { to: ["reviewer"], subject: "s", body: "from the child", on_behalf_of: "agent-6" }));
  const e = envOf(n, sent.id);
  assert.equal(e.from, "docs-architect@alpha");
  assert.equal(e.meta.on_behalf_of, "agent-6");
  const replied = out(await reviewer("mbx_reply", { id: sent.id, body: "seen" }));
  const back = envOf(n, replied.id);
  assert.equal(back.from, "reviewer@alpha");
  assert.ok(toFront(back.to, "docs-architect"));
  assert.equal(back.meta.on_behalf_of, "agent-6");
  const before = count(n);
  const bad = await lead("mbx_send", { to: ["reviewer"], subject: "s", body: "no", on_behalf_of: "agent-6@alpha" });
  assert.equal(bad.isError, true);
  assert.match(bad.content[0]!.text, /on_behalf_of must be a name/);
  assert.equal(count(n), before);
});
