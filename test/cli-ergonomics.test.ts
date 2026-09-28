import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { MbxNode } from "../src/node.ts";

async function fixture(t: { after: (fn: () => void | Promise<void>) => void }, leased = true) {
  const home = mkdtempSync(join(tmpdir(), "mbx-cli-"));
  const n = new MbxNode(home, { host: "test-host" });
  const client = new Client({ name: "cli-test", version: "1" });
  t.after(async () => { if (leased) await client.close(); n.close(); rmSync(home, { recursive: true, force: true }); });
  if (leased) await client.connect(new StdioClientTransport({ command: process.execPath, args: [resolve("bin/agentmbx.js"), "mcp"],
    env: { ...process.env, MBX_HOME: home, MBX_AGENT: "reader", MBX_CLI: "claude", AGENTMBX_DEV: "1" } as Record<string, string> }));
  const cli = (...args: string[]) => spawnSync(process.execPath, [resolve("bin/agentmbx.js"), ...args], {
    encoding: "utf8", input: "", env: { ...process.env, MBX_HOME: home, MBX_AGENT: "", MBX_DEBUG: "", AGENTMBX_DEV: "1" }, timeout: 5000,
  });
  const send = (subject: string, from = "sender", thread?: string) => n.send({ from, to: ["reader"], subject, body: "body", thread, needs_reply: true, refs: ["src/cli.ts"] }).envelope;
  return { n, cli, send };
}

test("CLI usage errors are one line, with help hints and exit 2", async (t) => {
  const { cli } = await fixture(t);
  for (const args of [["read"], ["thread"], ["ack"], ["send", "--as", "sender", "-m", "body"], ["inbox", "--unknown"], ["bad\ncommand"]]) {
    const r = cli(...args);
    assert.equal(r.status, 2, r.stderr);
    assert.equal(r.stderr.trim().split("\n").length, 1);
    assert.match(r.stderr, /see: agentmbx/);
    assert.doesNotMatch(r.stderr, /at run|at main/);
  }
});

test("CLI command help retains send options and respects option terminators", async (t) => {
  const { cli } = await fixture(t);
  const help = cli("send", "--help");
  assert.equal(help.status, 0);
  assert.match(help.stdout, /--needs-reply/);
  assert.match(help.stdout, /--reply-to/);
  assert.doesNotMatch(help.stdout, /agentmbx daemon/);
  const literal = cli("read", "--as", "reader", "--", "--help");
  assert.equal(literal.status, 3);
  assert.match(literal.stderr, /no message --help/);
});

test("CLI read and ack preserve missing and ambiguous exit codes", async (t) => {
  const { cli, send } = await fixture(t);
  const a = send("a"), b = send("b");
  const prefix = a.id.slice(0, 4);
  assert.ok(b.id.startsWith(prefix));
  assert.equal(cli("read", "missing", "--as", "reader").status, 3);
  assert.equal(cli("read", prefix, "--as", "reader").status, 4);
  assert.equal(cli("ack", prefix, "--as", "reader").status, 4);
});

test("CLI variadic ack handles all ids and reports partial failures", async (t) => {
  const { cli, send, n } = await fixture(t);
  const a = send("a"), b = send("b");
  const r = cli("ack", a.id, "missing", b.id, "--as", "reader");
  assert.equal(r.status, 3);
  assert.match(r.stdout, new RegExp(a.id)); assert.match(r.stdout, new RegExp(b.id));
  assert.equal(n.inbox("reader").length, 0);
});

test("CLI ack supports thread selection and all remaining mail", async (t) => {
  const { cli, send, n } = await fixture(t);
  const a = send("a"); send("reply", "sender", a.thread); const other = send("other");
  assert.equal(cli("ack", "--thread", a.id, "--as", "reader").status, 0);
  assert.deepEqual(n.inbox("reader").map(m => m.id), [other.id]);
  assert.equal(cli("ack", "--all", "--as", "reader").status, 0);
  assert.equal(n.inbox("reader").length, 0);
});

test("CLI inbox JSON retains envelope fields and combines filters", async (t) => {
  const { cli, send, n } = await fixture(t);
  const a = send("a"); send("other", "other");
  n.send({ from: "sender", to: ["reader"], subject: "status", body: "body", needs_reply: false });
  const r = cli("inbox", "--as", "reader", "--json", "--needs-reply", "--from", "sender");
  assert.equal(r.status, 0, r.stderr);
  const rows = JSON.parse(r.stdout);
  assert.equal(rows.length, 1);
  for (const key of ["id", "to", "thread", "reply_to", "needs_reply", "refs"]) assert.deepEqual(rows[0][key], a[key as keyof typeof a]);
});

test("CLI shell senders can send unverified new mail but cannot read or reply as a mailbox", async (t) => {
  const { cli, n } = await fixture(t, false);
  const sent = cli("send", "--as", "shell-sender", "--to", "receiver", "--subject", "registration", "-m", "hello", "--json");
  assert.equal(sent.status, 0, sent.stderr);
  const id = JSON.parse(sent.stdout).id;
  assert.match(sent.stderr, /unverified-sender/);
  assert.equal(n.agents().find(a => a.name === "shell-sender")?.cli, "cli");
  assert.equal(JSON.parse(n.message(id)!.envelope).meta.sender_verification, "unverified");
  assert.equal(cli("send", "--as", "receiver", "--to", "shell-sender", "--reply-to", id, "-m", "reply").status, 1);
  assert.equal(cli("inbox", "--as", "receiver", "--json").status, 1);
  assert.equal(n.inbox("receiver")[0].state, "delivered");
});
