import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { MbxNode } from "../src/node.ts";

for (const cli of ["claude", "codex", "kimi", "opencode"]) test(`${cli} status and whoami require the exact current lease and preserve metadata`, async t => {
  const home = mkdtempSync(join(tmpdir(), "mbx-status-")), n = new MbxNode(home, { host: "alpha" });
  const client = new Client({ name: "status-test", version: "1" });
  t.after(async () => { await client.close(); n.close(); rmSync(home, { recursive: true, force: true }); });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [resolve("bin/agentmbx.js"), "mcp"],
    env: { ...process.env, MBX_HOME: home, MBX_AGENT: "folder", MBX_CLI: cli, AGENTMBX_DEV: "1" } as Record<string, string> }));
  const meta = cli === "codex" ? { threadId: "66666666-6666-4666-8666-666666666666" } : cli === "opencode" ? { sessionID: "ses_statustest" } : undefined;
  const call = (name: string, args: Record<string, unknown> = {}) => client.callTool({ name, arguments: args, ...(meta ? { _meta: meta } : {}) });
  assert.notEqual((await call("mbx_whoami", { name: "renamed" })).isError, true);
  const sid = n.store.db.prepare("SELECT session_id FROM sessions WHERE agent='renamed' AND session_key IS NOT NULL").get()!.session_id as string;
  const run = (cmd: string, extra: string[] = [], session = sid, provider = cli) => spawnSync(process.execPath,
    [resolve("bin/agentmbx.js"), cmd, "--cli", provider, "--session", session, ...extra], {
      encoding: "utf8", timeout: 10_000, env: { ...process.env, MBX_HOME: home, MBX_AGENT: "", AGENTMBX_DEV: "1" },
    });
  const send = (to: string, needs_reply = false) => n.send({ from: "sender", to: [to], subject: "PRIVATE", body: "SECRET", needs_reply }).envelope.id;
  send("unrelated", true);
  const id = send("renamed", true);
  n.store.set("ident:shell", "renamed"); send("shell");
  const before = n.agents().map(({ last_seen, ...a }) => a);
  const status = run("status", ["--json"]);
  assert.equal(status.status, 0, status.stderr);
  assert.deepEqual(JSON.parse(status.stdout), { agent: "renamed", host: "alpha", address: "renamed@alpha", cli,
    session_id: sid, mailboxes: ["renamed"], unread: 1, needs_reply: 1, owner_authority: 0, outbox: 0 });
  assert.doesNotMatch(status.stdout, /PRIVATE|SECRET/);
  const who = run("whoami"); assert.equal(who.status, 0, who.stderr); assert.match(who.stdout, /renamed@alpha/);
  assert.deepEqual(n.agents().map(({ last_seen, ...a }) => a), before, "read queries do not register or relabel agents");
  assert.equal(n.inbox("renamed")[0].state, "delivered");
  const edited = run("whoami", ["--role", "reviewer", "--description", "leased caller"]);
  assert.equal(edited.status, 0, edited.stderr);
  assert.equal(n.agents().find(a => a.name === "renamed")!.cli, cli, "metadata edits retain provider identity");
  assert.equal(n.agents().find(a => a.name === "renamed")!.role, "reviewer");
  for (const cmd of ["status", "whoami"]) {
    assert.notEqual(run(cmd, ["--as", "folder"]).status, 0);
    assert.notEqual(run(cmd, [], "missing").status, 0);
    assert.notEqual(run(cmd, [], sid, "wrong-provider").status, 0);
  }
  n.ack(id, "renamed");
  assert.equal(JSON.parse(run("status", ["--json"]).stdout).unread, 0);
  assert.notEqual((await call("mbx_identity", { action: "release" })).isError, true);
  assert.notEqual(run("status", ["--json"]).status, 0);
  assert.notEqual(run("whoami", ["--role", "forbidden"]).status, 0);
  assert.equal(n.agents().find(a => a.name === "renamed")!.role, "reviewer");
});

test("a live legacy session row does not authorize status or whoami", t => {
  const home = mkdtempSync(join(tmpdir(), "mbx-status-legacy-")), n = new MbxNode(home, { host: "alpha" });
  t.after(() => { n.close(); rmSync(home, { recursive: true, force: true }); });
  n.registerAgent("offline", { cli: "claude", role: "original" });
  n.bindSession({ agent: "offline", cli: "claude", session_id: "legacy", pid: process.pid });
  for (const args of [["status", "--cli", "claude", "--session", "legacy", "--json"], ["whoami", "--as", "offline", "--role", "forbidden"]]) {
    const r = spawnSync(process.execPath, [resolve("bin/agentmbx.js"), ...args], { encoding: "utf8", env: { ...process.env, MBX_HOME: home, AGENTMBX_DEV: "1" } });
    assert.notEqual(r.status, 0); assert.equal(r.stdout, "");
  }
  assert.equal(n.agents().find(a => a.name === "offline")!.role, "original");
});
