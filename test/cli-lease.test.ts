import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { verifyEnvelope } from "../src/envelope.ts";
import { MbxNode, trustLabel } from "../src/node.ts";

const cliCommand = (home: string, ...args: string[]) => spawnSync(process.execPath, [resolve("bin/agentmbx.js"), ...args], {
  encoding: "utf8", timeout: 10_000, env: { ...process.env, MBX_HOME: home, AGENTMBX_DEV: "1" },
});

const guarded = (home: string, selection: Record<string, unknown>, action = "inbox", id = "") => spawnSync(process.execPath, ["--input-type=module", "-e", `
  import { MbxNode } from ${JSON.stringify(new URL("../src/node.ts", import.meta.url).href)};
  import { withCliIdentity } from ${JSON.stringify(new URL("../src/cli-identity.ts", import.meta.url).href)};
  import { DatabaseSync } from 'node:sqlite';
  const node = new MbxNode(process.argv[1]);
  try {
    const result = withCliIdentity(node, JSON.parse(process.argv[2]), agent => {
      if (process.argv[3] === 'ack') return node.ack(process.argv[4], agent);
      if (process.argv[3] === 'locked') {
        const other = new DatabaseSync(node.home + '/mbx.db');
        try { other.exec('PRAGMA busy_timeout=0; BEGIN IMMEDIATE'); return false; }
        catch (e) { return /locked/.test(e.message); } finally { other.close(); }
      }
      if (process.argv[3] === 'write') return node.store.set('must-not-write', 'value');
      return {agent, ids:node.inbox(agent).map(m=>m.id)};
    });
    console.log(JSON.stringify(result));
  } catch(e) { console.error(e.code + ': ' + e.message); process.exitCode=1; }
  finally { node.close(); }
`, home, JSON.stringify(selection), action, id], { encoding: "utf8", timeout: 10_000 });

for (const cli of ["claude", "codex", "kimi", "opencode"]) test(`${cli} CLI guard binds exact current lease through reads and writes`, async t => {
  const home = mkdtempSync(join(tmpdir(), "mbx-cli-lease-")), node = new MbxNode(home, { host: "alpha" });
  const client = new Client({ name: cli, version: "test" });
  t.after(async () => { await client.close(); node.close(); rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [resolve("bin/agentmbx.js"), "mcp"],
    env: { ...process.env, MBX_HOME: home, MBX_AGENT: "reader", MBX_CLI: cli, AGENTMBX_DEV: "1" } as Record<string,string> }));
  const meta = cli === "codex" ? { threadId: "55555555-5555-4555-8555-555555555555" } : cli === "opencode" ? { sessionID: "ses_clilease" } : undefined;
  const call = (name: string, args: Record<string,unknown> = {}) => client.callTool({ name, arguments: args, ...(meta ? { _meta: meta } : {}) });
  // A shared transport's session starts unbound and registers its own identity (T204); MBX_AGENT names only the transport.
  if (meta) assert.notEqual((await call("mbx_identity", { action: "register", name: "session-reader", role: "reader" })).isError, true);
  const me = (await call("mbx_whoami")).structuredContent as { agent: string };
  const sid = node.store.db.prepare("SELECT session_id FROM sessions WHERE agent=? AND session_key IS NOT NULL").get(me.agent)!.session_id as string;
  const selection = { cli, session: sid, as: me.agent };
  const message = node.send({ from: "sender", to: [me.agent], subject: "guarded", body: "preserved" }).envelope.id;
  const read = guarded(home, { ...selection, readOnly: true });
  assert.equal(read.status, 0, read.stderr); assert.deepEqual(JSON.parse(read.stdout), { agent: me.agent, ids: [message] });
  const locked = guarded(home, selection, "locked"); assert.equal(locked.status, 0, locked.stderr); assert.equal(JSON.parse(locked.stdout), true);
  assert.equal(guarded(home, { ...selection, readOnly: true }, "write").status, 1);
  assert.equal(node.store.get("must-not-write"), undefined);
  assert.equal(guarded(home, { ...selection, as: "someone-else" }).status, 1);
  assert.equal(guarded(home, { ...selection, as: `${me.agent}@other-host` }).status, 1);
  const implicit = guarded(home, { as: me.agent });
  assert.equal(implicit.status, meta ? 1 : 0, implicit.stderr);
  if (meta) assert.match(implicit.stderr, /ambiguous/);
  const mismatchedSend = cliCommand(home, "send", "--as", "victim", "--to", "sender", "--subject", "forbidden fallback", "-m", "body");
  assert.equal(mismatchedSend.status, 1, "a leased or ambiguous caller cannot downgrade to another sender");
  assert.equal(node.search("forbidden fallback").length, 0);
  const selected = ["--cli", cli, "--session", sid, "--as", me.agent];
  assert.equal(cliCommand(home, "inbox", ...selected, "--json").status, 0);
  const content = cliCommand(home, "read", message, ...selected); assert.equal(content.status, 0, content.stderr); assert.match(content.stdout, /preserved/);
  assert.equal(cliCommand(home, "thread", message, ...selected).status, 0);
  assert.equal(cliCommand(home, "search", "guarded", ...selected).status, 0);
  const reply = cliCommand(home, "send", ...selected, "--reply-to", message, "--to", "sender", "-m", "reply", "--json");
  assert.equal(reply.status, 0, reply.stderr);
  assert.equal(JSON.parse(node.message(JSON.parse(reply.stdout).id)!.envelope).meta.sender_verification, "leased");
  assert.equal(cliCommand(home, "ack", message, ...selected).status, 0);
  const acked = guarded(home, selection, "ack", message); assert.equal(acked.status, 0, acked.stderr);
  assert.equal(node.inbox(me.agent).length, 0);
  assert.notEqual((await call("mbx_identity", { action: "release" })).isError, true);
  assert.equal(guarded(home, selection).status, 1, "a released descriptor cannot authorize a mailbox operation");
  for (const args of [["inbox"], ["read", message], ["thread", message], ["search", "guarded"], ["ack", message], ["send", "--reply-to", message, "--to", "sender", "-m", "forbidden"]]) {
    assert.equal(cliCommand(home, ...args, ...selected).status, 1, `released CLI ${args[0]} must be fenced`);
  }
});

test("shell names and historical links never establish CLI ownership", t => {
  const home = mkdtempSync(join(tmpdir(), "mbx-cli-no-lease-")), node = new MbxNode(home, { host: "alpha" });
  t.after(() => { node.close(); rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
  const id = node.send({ from: "sender", to: ["offline"], subject: "private", body: "kept" }).envelope.id;
  node.store.set("ident:offline", "shell");
  const denied = guarded(home, { as: "offline" }, "ack", id);
  assert.equal(denied.status, 1); assert.match(denied.stderr, /no current identity lease/);
  assert.equal(node.inbox("offline")[0].state, "delivered");
  assert.equal(guarded(home, { cli: "codex" }).status, 1);
  for (const args of [["inbox", "--as", "offline"], ["read", id, "--as", "offline"], ["ack", id, "--as", "offline"], ["thread", id], ["search", "private"]]) {
    const deniedCli = cliCommand(home, ...args); assert.equal(deniedCli.status, 1, deniedCli.stderr);
    assert.doesNotMatch(deniedCli.stdout, /private|kept/);
  }
  assert.equal(node.store.get("ident:offline"), undefined);
  assert.ok(node.store.db.prepare("SELECT 1 FROM audit WHERE event='identity.link.retired' AND json_extract(detail,'$.name')='offline'").get());
  node.registerAgent("recipient"); // T205: sends need an existing recipient
  const sent = cliCommand(home, "send", "--as", "offline", "--to", "recipient", "--subject", "new", "-m", "unverified", "--json");
  assert.equal(sent.status, 0, sent.stderr);
  const row = node.message(JSON.parse(sent.stdout).id)!;
  const envelope = JSON.parse(row.envelope);
  assert.equal(envelope.meta.sender_verification, "unverified");
  assert.equal(verifyEnvelope(envelope, node.key.publicKey), true);
  assert.match(trustLabel(row), /unverified-sender/);
  assert.equal(node.policyFor(row, "recipient").level, "ask");
  assert.equal(node.inbox("offline")[0].state, "delivered");
  node.store.db.prepare(`INSERT INTO identity_leases (name,token,holder_pid,holder_start,key_fp,cli,session_id,claimed_at,heartbeat_at,idle_ttl)
    VALUES ('held','fixture',?,'fixture','fixture','claude','other',?,?,1800000)`).run(process.pid, Date.now(), Date.now());
  const held = cliCommand(home, "send", "--as", "held", "--to", "recipient", "--subject", "held impersonation", "-m", "body");
  assert.equal(held.status, 1); assert.match(held.stderr, /sender name is leased/);
  assert.equal(node.search("held impersonation").length, 0);
});
