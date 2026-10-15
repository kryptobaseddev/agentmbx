// T649: a subject over 200 characters used to fail the whole send (zod .max(200)), so an agent lost a turn to a schema error.
// Now the field says the cap up front, and a longer subject is truncated at a grapheme boundary to 199 characters plus "…",
// with a warning and subject_truncated:true; the send happens once and the body is unchanged. A paired host's receive check is
// unchanged (it still rejects 201), and the truncated subject passes it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { buildEnvelope, checkShape, fitSubject, MAX_SUBJECT, MAX_SUBJECT_INPUT } from "../src/envelope.ts";
import { MbxNode } from "../src/node.ts";

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
const points = (s: string) => [...s].length;
// The owner's case: a 213-character subject.
const LONG = "T649 repro: " + "subject words ".repeat(14) + "x".repeat(5);

test("fitSubject: 213 characters become 199 plus …, with the warning; 200 is left alone", () => {
  assert.equal(points(LONG), 213);
  const fit = fitSubject(LONG);
  assert.equal(fit.truncated, true);
  assert.equal(points(fit.subject), 200);
  assert.ok(fit.subject.endsWith("…"));
  assert.equal(fit.subject.slice(0, -1), LONG.slice(0, 199));
  assert.equal(fit.warning, "subject truncated from 213 to 200 characters");
  const exact = "y".repeat(MAX_SUBJECT);
  assert.deepEqual(fitSubject(exact), { subject: exact, truncated: false, from: 200, warning: null });
});

test("fitSubject never splits an emoji or a combined sequence at the cut, and fits the receive check in UTF-16 units", () => {
  for (const glyph of ["😀", "👨‍👩‍👧", "🇺🇸", "é"]) {
    for (let lead = 190; lead <= 199; lead++) {
      const s = "a".repeat(lead) + glyph + "b".repeat(30);
      const { subject } = fitSubject(s);
      assert.doesNotMatch(subject, LONE_SURROGATE, `${glyph} at ${lead}`);
      assert.ok(points(subject) <= MAX_SUBJECT && subject.length <= MAX_SUBJECT, `${glyph} at ${lead}: ${points(subject)}/${subject.length}`);
      assert.ok(subject.endsWith("…"));
      const kept = subject.slice(0, -1);
      assert.ok(kept === "a".repeat(lead) || kept.startsWith("a".repeat(lead) + glyph), `${glyph} at ${lead} is kept whole or dropped whole`);
      const e = buildEnvelope({ from: "me@alpha", to: ["you"], subject: s, body: "b" });
      assert.equal(checkShape({ ...e, sig: "x".repeat(88) } as never)?.startsWith("subject") ?? false, false, "a paired host accepts it");
    }
  }
  // an all-emoji subject: 300 astral characters (600 units) fit as at most 199 units plus …
  const wide = fitSubject("😀".repeat(300));
  assert.ok(wide.subject.length <= MAX_SUBJECT);
  assert.doesNotMatch(wide.subject, LONE_SURROGATE);
});

async function mcp(t: { after: (fn: () => void | Promise<void>) => void }) {
  const home = mkdtempSync(join(tmpdir(), "mbx-t649-"));
  const n = new MbxNode(home, { host: "alpha" });
  n.registerAgent("receiver");
  const client = new Client({ name: "t649", version: "1" });
  t.after(async () => { await client.close(); n.close(); rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [resolve("bin/agentmbx.js"), "mcp"],
    env: { ...process.env, AGENTMBX_DEV: "1", MBX_HOME: home, MBX_CLI: "claude", MBX_AGENT: "worker", MBX_NO_DESKTOP: "1" } as Record<string, string> }));
  return { n, client, home };
}

test("mbx_send: a 213-character subject sends once, truncated with …, body unchanged, warning and subject_truncated set", async (t) => {
  const { n, client } = await mcp(t);
  const body = "the body\nstays exactly as written 😀";
  const sent = await client.callTool({ name: "mbx_send", arguments: { to: ["receiver"], subject: LONG, body } });
  assert.notEqual(sent.isError, true, JSON.stringify(sent.content));
  const out = sent.structuredContent as { id: string; subject_truncated?: boolean; warnings: string[] };
  assert.equal(out.subject_truncated, true);
  assert.equal(out.warnings[0], "subject truncated from 213 to 200 characters");
  const inbox = n.inbox("receiver");
  assert.equal(inbox.length, 1, "sent exactly once");
  assert.equal(inbox[0].id, out.id);
  assert.ok(points(inbox[0].subject) <= 200 && inbox[0].subject.endsWith("…"));
  assert.equal(inbox[0].body, body);
  const short = await client.callTool({ name: "mbx_send", arguments: { to: ["receiver"], subject: "short", body: "b" } });
  const plain = short.structuredContent as { subject_truncated?: boolean; warnings: string[] };
  assert.equal(plain.subject_truncated, undefined);
  assert.ok(!plain.warnings.some((w) => /truncated/.test(w)));
  const abuse = await client.callTool({ name: "mbx_send", arguments: { to: ["receiver"], subject: "z".repeat(MAX_SUBJECT_INPUT + 1), body: "b" } });
  assert.equal(abuse.isError, true, "the abuse guard still refuses a subject over 1000 characters");
  assert.equal(n.inbox("receiver").length, 2);
});

test("the tool and field descriptions state the cap up front", async (t) => {
  const { client } = await mcp(t);
  const tools = (await client.listTools()).tools;
  const send = tools.find((x) => x.name === "mbx_send")!, reply = tools.find((x) => x.name === "mbx_reply")!;
  const phrase = /One line, at most 200 characters; longer subjects are truncated with …/i;
  assert.match(send.description ?? "", phrase);
  assert.match(String((send.inputSchema.properties as Record<string, { description?: string }>).subject.description), phrase);
  assert.match(reply.description ?? "", phrase);
  assert.match(send.description ?? "", /Next: /);
  assert.match(reply.description ?? "", /Next: /);
});

test("mbx_reply: a Re: subject over the cap is truncated the same way, with the warning", async (t) => {
  const { n, client } = await mcp(t);
  const orig = n.send({ from: "boss", to: ["worker"], subject: "z".repeat(199), body: "q", kind: "request", needs_reply: true }).envelope;
  const r = await client.callTool({ name: "mbx_reply", arguments: { id: orig.id, body: "answer" } });
  assert.notEqual(r.isError, true, JSON.stringify(r.content));
  const out = r.structuredContent as { id: string; subject_truncated?: boolean; warnings: string[] };
  assert.equal(out.subject_truncated, true);
  assert.equal(out.warnings[0], "subject truncated from 203 to 200 characters");
  const stored = n.message(out.id)!;
  assert.equal(stored.subject, "Re: " + "z".repeat(195) + "…");
});

test("CLI send truncates the same way and prints the warning; the send happens once", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "mbx-t649-cli-"));
  const n = new MbxNode(home, { host: "alpha" });
  n.registerAgent("receiver");
  t.after(() => { n.close(); rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
  const r = spawnSync(process.execPath, [resolve("bin/agentmbx.js"), "send", "--as", "clisender", "--to", "receiver", "--subject", LONG, "-m", "cli body"],
    { encoding: "utf8", input: "", env: { ...process.env, MBX_HOME: home, MBX_AGENT: "", AGENTMBX_DEV: "1", MBX_NO_DESKTOP: "1" }, timeout: 20_000 });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /warning: subject truncated from 213 to 200 characters/);
  const inbox = n.inbox("receiver");
  assert.equal(inbox.length, 1);
  assert.ok(points(inbox[0].subject) === 200 && inbox[0].subject.endsWith("…"));
  assert.equal(inbox[0].body, "cli body");
  const big = spawnSync(process.execPath, [resolve("bin/agentmbx.js"), "send", "--as", "clisender", "--to", "receiver", "--subject", "z".repeat(MAX_SUBJECT_INPUT + 1), "-m", "b"],
    { encoding: "utf8", input: "", env: { ...process.env, MBX_HOME: home, MBX_AGENT: "", AGENTMBX_DEV: "1", MBX_NO_DESKTOP: "1" }, timeout: 20_000 });
  assert.notEqual(big.status, 0);
  assert.match(big.stderr, /over 1000 characters/);
  assert.equal(n.inbox("receiver").length, 1);
});
