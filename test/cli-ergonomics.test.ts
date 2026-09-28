import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { MbxNode } from "../src/node.ts";

function fixture(t: { after: (fn: () => void) => void }) {
  const home = mkdtempSync(join(tmpdir(), "mbx-cli-"));
  const n = new MbxNode(home, { host: "test-host" });
  t.after(() => { n.close(); rmSync(home, { recursive: true, force: true }); });
  const cli = (...args: string[]) => spawnSync(process.execPath, [resolve("bin/agentmbx.js"), ...args], {
    encoding: "utf8", input: "", env: { ...process.env, MBX_HOME: home, MBX_AGENT: "", MBX_DEBUG: "", AGENTMBX_DEV: "1" }, timeout: 5000,
  });
  const send = (subject: string, from = "sender", thread?: string) => n.send({ from, to: ["reader"], subject, body: "body", thread, needs_reply: true, refs: ["src/cli.ts"] }).envelope;
  return { n, cli, send };
}

test("CLI usage errors are one line, with help hints and exit 2", (t) => {
  const { cli } = fixture(t);
  for (const args of [["send", "--as", "sender", "-m", "body"], ["inbox", "--unknown"], ["bad\ncommand"]]) {
    const r = cli(...args);
    assert.equal(r.status, 2, r.stderr);
    assert.equal(r.stderr.trim().split("\n").length, 1);
    assert.match(r.stderr, /see: agentmbx/);
    assert.doesNotMatch(r.stderr, /at run|at main/);
  }
});

test("CLI command help retains send options and respects option terminators", (t) => {
  const { cli } = fixture(t);
  const help = cli("send", "--help");
  assert.equal(help.status, 0);
  assert.match(help.stdout, /--needs-reply/);
  assert.match(help.stdout, /--reply-to/);
  assert.doesNotMatch(help.stdout, /agentmbx daemon/);
  const literal = cli("read", "--as", "reader", "--", "--help");
  assert.equal(literal.status, 3);
  assert.match(literal.stderr, /no message --help/);
});

test("CLI read and ack preserve missing and ambiguous exit codes", (t) => {
  const { cli, send } = fixture(t);
  const a = send("a"), b = send("b");
  const prefix = a.id.slice(0, 4);
  assert.ok(b.id.startsWith(prefix));
  assert.equal(cli("read", "missing", "--as", "reader").status, 3);
  assert.equal(cli("read", prefix, "--as", "reader").status, 4);
  assert.equal(cli("ack", prefix, "--as", "reader").status, 4);
});

test("CLI variadic ack handles all ids and reports partial failures", (t) => {
  const { cli, send, n } = fixture(t);
  const a = send("a"), b = send("b");
  const r = cli("ack", a.id, "missing", b.id, "--as", "reader");
  assert.equal(r.status, 3);
  assert.match(r.stdout, new RegExp(a.id)); assert.match(r.stdout, new RegExp(b.id));
  assert.equal(n.inbox("reader").length, 0);
});

test("CLI ack supports thread selection and all remaining mail", (t) => {
  const { cli, send, n } = fixture(t);
  const a = send("a"); send("reply", "sender", a.thread); const other = send("other");
  assert.equal(cli("ack", "--thread", a.id, "--as", "reader").status, 0);
  assert.deepEqual(n.inbox("reader").map(m => m.id), [other.id]);
  assert.equal(cli("ack", "--all", "--as", "reader").status, 0);
  assert.equal(n.inbox("reader").length, 0);
});

test("CLI inbox JSON retains envelope fields and combines filters", (t) => {
  const { cli, send, n } = fixture(t);
  const a = send("a"); send("other", "other");
  n.send({ from: "sender", to: ["reader"], subject: "status", body: "body", needs_reply: false });
  const r = cli("inbox", "--as", "reader", "--json", "--needs-reply", "--from", "sender");
  assert.equal(r.status, 0, r.stderr);
  const rows = JSON.parse(r.stdout);
  assert.equal(rows.length, 1);
  for (const key of ["id", "to", "thread", "reply_to", "needs_reply", "refs"]) assert.deepEqual(rows[0][key], a[key as keyof typeof a]);
});

test("CLI shell senders enter the directory and receive replies without unknown-agent warnings", (t) => {
  const { cli } = fixture(t);
  const receiver = cli("whoami", "--as", "receiver", "--role", "reviewer", "--description", "shell receiver");
  assert.equal(receiver.status, 0, receiver.stderr);
  assert.match(receiver.stdout, /receiver@test-host.*role:reviewer/);
  const sent = cli("send", "--as", "shell-sender", "--to", "receiver", "--subject", "registration", "-m", "hello", "--json");
  assert.equal(sent.status, 0, sent.stderr);
  const id = JSON.parse(sent.stdout).id;
  const agents = cli("agents");
  assert.equal(agents.status, 0, agents.stderr);
  assert.match(agents.stdout, /shell-sender@test-host\tlive\t\tcli\t/);
  assert.match(agents.stdout, /receiver@test-host\tlive\treviewer\tcli\t.*shell receiver/);
  const reply = cli("send", "--as", "receiver", "--to", "shell-sender", "--reply-to", id, "-m", "reply", "--json");
  assert.equal(reply.status, 0, reply.stderr);
  assert.equal(reply.stderr, "");
  assert.deepEqual(JSON.parse(reply.stdout).warnings, []);
  const inbox = cli("inbox", "--as", "shell-sender", "--json");
  assert.equal(inbox.status, 0, inbox.stderr);
  const rows = JSON.parse(inbox.stdout);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].reply_to, id);
  assert.equal(rows[0].subject, "Re: registration");
});
