// T652: agents (OpenCode ones most) burned turns on mbx tool shape errors. mbx_send called with mbx_reply's shape
// ({id, body, kind}) failed at the schema ("to: Missing key, subject: Missing key") and was retried as mbx_reply. Now that
// call is the reply, sent once through mbx_reply's own path, with a note saying so; a send with neither recipients nor a
// message id gets one actionable line. Handoff notes may be up to 4000 characters, and an over-long note is told how much
// to cut (never truncated).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { MbxNode } from "../src/node.ts";
import { HANDOFF_NOTE_MAX } from "../src/handoff.ts";

type Result = { isError?: boolean; content: { type: string; text: string }[]; structuredContent?: Record<string, unknown> };
const errorText = (r: Result) => r.content.map((c) => c.text).join("\n");

async function mcp(t: { after: (fn: () => void | Promise<void>) => void }) {
  const home = mkdtempSync(join(tmpdir(), "mbx-t652-"));
  const n = new MbxNode(home, { host: "alpha" });
  n.registerAgent("boss"); n.registerAgent("receiver");
  const client = new Client({ name: "t652", version: "1" });
  t.after(async () => { await client.close(); n.close(); rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [resolve("bin/agentmbx.js"), "mcp"],
    env: { ...process.env, AGENTMBX_DEV: "1", MBX_HOME: home, MBX_CLI: "claude", MBX_AGENT: "worker", MBX_NO_DESKTOP: "1" } as Record<string, string> }));
  const call = (name: string, args: Record<string, unknown>) => client.callTool({ name, arguments: args }) as Promise<Result>;
  return { n, call, client };
}

test("mbx_send {id, body, kind} is exactly one reply: threaded, sent back to the sender, Re: subject, with the note", async (t) => {
  const { n, call } = await mcp(t);
  const orig = n.send({ from: "boss", to: ["worker"], subject: "can you check X", body: "q", kind: "request", needs_reply: true }).envelope;
  const r = await call("mbx_send", { id: orig.id, body: "checked: X is fine", kind: "reply" });
  assert.notEqual(r.isError, true, errorText(r));
  const out = r.structuredContent as { id: string; to: string; thread: string; reply_to: string; note: string };
  assert.equal(out.note, `treated as a reply to ${orig.id}; mbx_reply is the reply tool`);
  assert.equal(out.reply_to, orig.id);
  assert.equal(out.thread, orig.thread);
  assert.equal(out.to, "boss@alpha");
  const got = n.inbox("boss");
  assert.equal(got.length, 1, "sent exactly once");
  assert.equal(got[0].id, out.id);
  assert.equal(got[0].subject, "Re: can you check X");
  assert.equal(got[0].kind, "reply");
  assert.equal(got[0].thread, orig.thread);
  assert.equal(got[0].reply_to, orig.id);
  assert.equal(got[0].body, "checked: X is fine");
  assert.match(errorText(r), new RegExp(`Next: mbx_ack ${orig.id}`), "the same result text mbx_reply gives");
});

test("mbx_send with the reply shape matches mbx_reply field for field", async (t) => {
  const { n, call } = await mcp(t);
  const a = n.send({ from: "boss", to: ["worker"], subject: "one", body: "q" }).envelope;
  const b = n.send({ from: "boss", to: ["worker"], subject: "two", body: "q" }).envelope;
  const viaSend = (await call("mbx_send", { reply_to: a.id, body: "ans" })).structuredContent as Record<string, unknown>;
  const viaReply = (await call("mbx_reply", { id: b.id, body: "ans" })).structuredContent as Record<string, unknown>;
  const shape = (o: Record<string, unknown>) => Object.keys(o).filter((k) => k !== "note").sort();
  assert.deepEqual(shape(viaSend), shape(viaReply));
  const [sa, sb] = [n.message(viaSend.id as string)!, n.message(viaReply.id as string)!];
  assert.deepEqual([sa.kind, sa.subject, sa.from_addr], ["reply", "Re: one", "worker@alpha"]);
  assert.deepEqual([sb.kind, sb.subject, sb.from_addr], ["reply", "Re: two", "worker@alpha"]);
  assert.equal(viaReply.note, undefined, "mbx_reply itself carries no note");
});

test("mbx_send to + id without subject sends to those recipients in the thread with the Re: subject", async (t) => {
  const { n, call } = await mcp(t);
  const orig = n.send({ from: "boss", to: ["worker"], subject: "plan", body: "q" }).envelope;
  const r = await call("mbx_send", { to: ["receiver"], reply_to: orig.id, body: "fyi" });
  assert.notEqual(r.isError, true, errorText(r));
  const got = n.inbox("receiver");
  assert.equal(got.length, 1);
  assert.equal(got[0].subject, "Re: plan");
  assert.equal(got[0].thread, orig.thread);
  assert.equal(n.inbox("boss").length, 0, "the explicit recipients win over the original sender");
});

test("mbx_send with no recipients and no message id gets one actionable line, and nothing is sent", async (t) => {
  const { n, call } = await mcp(t);
  const missing = await call("mbx_send", { body: "hello" });
  assert.equal(missing.isError, true);
  assert.match(errorText(missing), /mbx_send needs to and subject; to answer a message use mbx_reply \{id, body\}/);
  assert.doesNotMatch(errorText(missing), /Missing key|invalid_type/);
  const noSubject = await call("mbx_send", { to: ["receiver"], body: "hello" });
  assert.equal(noSubject.isError, true);
  assert.match(errorText(noSubject), /mbx_send needs subject .*mbx_reply \{id, body\}/);
  assert.equal(n.inbox("receiver").length, 0);
  const plain = await call("mbx_send", { to: ["receiver"], subject: "hi", body: "hello" });
  assert.notEqual(plain.isError, true, errorText(plain));
  assert.equal(n.message((plain.structuredContent as { id: string }).id)!.kind, "message", "a normal send keeps kind message");
});

test("handoff notes: 4000 characters save, 4001 fail stating the limit and how much to cut, in mbx_handoff and mbx_identity", async (t) => {
  const { call } = await mcp(t);
  assert.equal(HANDOFF_NOTE_MAX, 4000);
  const ok = await call("mbx_handoff", { action: "save", note: "x".repeat(4000) });
  assert.notEqual(ok.isError, true, errorText(ok));
  assert.equal((ok.structuredContent as { saved: { note: string } }).saved.note.length, 4000);
  const over = await call("mbx_handoff", { action: "save", note: "x".repeat(4001) });
  assert.equal(over.isError, true);
  assert.match(errorText(over), /the handoff note is 4001 characters; the limit is 4000: cut at least 1 characters/);
  const way = await call("mbx_identity", { action: "release", note: "y".repeat(5868) });
  assert.equal(way.isError, true);
  assert.match(errorText(way), /5868 characters; the limit is 4000: cut at least 1868 characters/);
});

test("the descriptions state the 4000-character handoff limit and the reply shape", async (t) => {
  const { client } = await mcp(t);
  const tools = (await client.listTools()).tools;
  const props = (name: string) => tools.find((x) => x.name === name)!.inputSchema.properties as Record<string, { description?: string }>;
  const desc = (name: string) => tools.find((x) => x.name === name)!.description ?? "";
  for (const name of ["mbx_handoff", "mbx_identity"]) {
    assert.match(desc(name), /at most 4000 characters/, `${name} tool description`);
    assert.match(String(props(name).note.description), /at most 4000 characters/, `${name} note field`);
    assert.doesNotMatch(desc(name) + String(props(name).note.description), /1000 characters/);
  }
  assert.match(desc("mbx_send"), /Given a message id and no to, it is sent as mbx_reply \{id, body\} would be/);
  assert.match(String(props("mbx_send").id.description), /alias of reply_to/);
  for (const name of ["mbx_send", "mbx_handoff", "mbx_identity"]) assert.match(desc(name), /Next: /);
});
