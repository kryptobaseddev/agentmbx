import { generateKeyPair } from "../src/crypto.ts";
import { makeGrant } from "../src/envelope.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { MbxNode } from "../src/node.ts";
import { Store, SCHEMA_VERSION } from "../src/store.ts";

for (const cli of ["claude", "codex", "kimi", "opencode"]) test(`${cli} status and whoami require the exact current lease and preserve metadata`, async t => {
  const home = mkdtempSync(join(tmpdir(), "mbx-status-")), n = new MbxNode(home, { host: "alpha" });
  const client = new Client({ name: "status-test", version: "1" });
  t.after(async () => { await client.close(); n.close(); rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [resolve("bin/agentmbx.js"), "mcp"],
    env: { ...process.env, MBX_HOME: home, MBX_AGENT: "folder", MBX_CLI: cli, AGENTMBX_DEV: "1" } as Record<string, string> }));
  const meta = cli === "codex" ? { threadId: "66666666-6666-4666-8666-666666666666" } : cli === "opencode" ? { sessionID: "ses_statustest" } : undefined;
  const call = (name: string, args: Record<string, unknown> = {}) => client.callTool({ name, arguments: args, ...(meta ? { _meta: meta } : {}) });
  // Claude/Kimi rename their launch identity; a Codex/OpenCode session starts unbound and registers this one (T204).
  assert.notEqual((await call("mbx_whoami", { name: "renamed", role: "builder" })).isError, true);
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
  // Outgoing queue counts belong to the exact sender, not every agent on this host.
  const unrelated = send("unrelated");
  const outgoing = n.send({ from: "renamed", to: ["receiver"], subject: "queued", body: "history" }).envelope.id;
  const queue = n.store.db.prepare("INSERT INTO outbox(msg_id,host,next_at,created_at) VALUES (?,?,?,?)");
  queue.run(unrelated, "offline", new Date().toISOString(), new Date().toISOString());
  assert.equal(JSON.parse(run("status", ["--json"]).stdout).outbox, 0);
  for (const host of ["offline", "also-offline"]) queue.run(outgoing, host, new Date().toISOString(), new Date().toISOString());
  assert.equal(JSON.parse(run("status", ["--json"]).stdout).outbox, 1, "one message queued for two hosts counts once");
  const who = run("whoami"); assert.equal(who.status, 0, who.stderr); assert.match(who.stdout, /renamed@alpha/);
  assert.deepEqual(n.agents().map(({ last_seen, ...a }) => a), before, "read queries do not register or relabel agents");
  assert.equal(n.inbox("renamed")[0].state, "delivered");
  const edited = run("whoami", ["--role", "reviewer", "--description", "leased caller"]);
  assert.equal(edited.status, 0, edited.stderr);
  assert.equal(n.agents().find(a => a.name === "renamed")!.cli, cli, "metadata edits retain provider identity");
  assert.equal(n.agents().find(a => a.name === "renamed")!.role, "reviewer");
  const owner = generateKeyPair(), master = generateKeyPair();
  writeFileSync(join(home, "owner.json"), JSON.stringify({ backend: "keychain", public_key: owner.publicKey }), { mode: 0o600 });
  const grant = makeGrant(owner.publicKey, owner.privateKey, master.publicKey, "master", n.host, ["task.assign"]);
  const assigned = n.send({ from: "master", to: ["renamed"], subject: "owner task", body: "do it", kind: "task" },
    { pub: master.publicKey, priv: master.privateKey, grant }).envelope.id;
  assert.equal(JSON.parse(run("status", ["--json"]).stdout).owner_authority, 1);
  n.store.db.prepare("INSERT INTO grants VALUES (?,?,?,?,1)").run(grant.id, grant.sub, JSON.stringify(grant), grant.exp);
  assert.equal(JSON.parse(run("status", ["--json"]).stdout).owner_authority, 0, "status rechecks current grant revocation");
  assert.equal(JSON.parse(run("status", ["--json"]).stdout).unread, 2);
  const receipt = n.store.db.prepare("SELECT authority FROM messages WHERE id=?").get(assigned) as { authority: string };
  assert.equal(JSON.parse(receipt.authority).ok, true, "historical receipt remains unchanged");
  const read = await call("mbx_read", { ids: [assigned] });
  assert.doesNotMatch(JSON.stringify(read.content), /authority: OWNER/);
  assert.match(JSON.stringify(read.content), /grant revoked/);
  n.ack(assigned, "renamed");
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
  t.after(() => { n.close(); rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
  n.registerAgent("offline", { cli: "claude", role: "original" });
  n.bindSession({ agent: "offline", cli: "claude", session_id: "legacy", pid: process.pid });
  for (const args of [["status", "--cli", "claude", "--session", "legacy", "--json"], ["whoami", "--as", "offline", "--role", "forbidden"]]) {
    const r = spawnSync(process.execPath, [resolve("bin/agentmbx.js"), ...args], { encoding: "utf8", env: { ...process.env, MBX_HOME: home, AGENTMBX_DEV: "1" } });
    assert.notEqual(r.status, 0); assert.equal(r.stdout, "");
  }
  assert.equal(n.agents().find(a => a.name === "offline")!.role, "original");
});

test("sender outbox index is added to existing stores without changing mail or schema version", t => {
  const home = mkdtempSync(join(tmpdir(), "mbx-status-index-")), n = new MbxNode(home, { host: "alpha" });
  t.after(() => rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  const query = "SELECT count(DISTINCT o.msg_id) n FROM outbox o JOIN messages m ON m.id=o.msg_id WHERE m.from_addr=?";
  const columns = () => n.store.db.prepare("PRAGMA index_info(messages_sender)").all().map(r => r.name);
  assert.deepEqual(columns(), ["from_addr", "id"], "fresh stores have the covering sender index");
  const messages = [
    n.send({ from: "sender", to: ["recipient"], subject: "one", body: "mail" }).envelope.id,
    n.send({ from: "sender", to: ["recipient"], subject: "two", body: "mail" }).envelope.id,
    n.send({ from: "other", to: ["recipient"], subject: "other", body: "mail" }).envelope.id,
  ];
  const now = new Date().toISOString();
  const queue = n.store.db.prepare("INSERT INTO outbox(msg_id,host,next_at,created_at) VALUES (?,?,?,?)");
  for (const id of messages) for (const host of ["offline", "also-offline"]) queue.run(id, host, now, now);
  n.ack(messages[0], "recipient");
  const tables = ["messages", "deliveries", "outbox"];
  const before = tables.map(table => n.store.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all());
  n.store.db.exec("DROP INDEX messages_sender");
  assert.equal(n.store.schemaVersion(), SCHEMA_VERSION);
  n.close();

  const reopened = new Store(home);
  t.after(() => reopened.close());
  assert.equal(reopened.schemaVersion(), SCHEMA_VERSION, "additive indexes do not change compatibility version");
  assert.deepEqual(reopened.db.prepare("PRAGMA index_info(messages_sender)").all().map(r => r.name), ["from_addr", "id"]);
  assert.deepEqual(tables.map(table => reopened.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()), before,
    "opening an existing current-schema database preserves envelopes, ACK state, queue and retries");
  assert.equal(reopened.db.prepare(query).get("sender@alpha")!.n, 2, "multiple queued peers count each sender message once");
  assert.equal(reopened.db.prepare(query).get("other@alpha")!.n, 1);
  assert.equal(reopened.db.prepare(query).get("sender@another-host")!.n, 0, "host is part of exact sender identity");
  assert.match(reopened.db.prepare("EXPLAIN QUERY PLAN " + query).all("sender@alpha").map(r => r.detail).join("\n"),
    /SEARCH m USING COVERING INDEX messages_sender \(from_addr=\?\)/,
    "sender lookup uses the covering index without forcing a planner hint");
});
