import { sendLeased } from "./helpers/leased-send.ts";
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { canonical, signData } from "../src/crypto.ts";
import { createOwnerKey, unlockOwnerKey } from "../src/owner.ts";
import { acceptSigned, makePolicy } from "../src/policy.ts";
import { MbxNode } from "../src/node.ts";
import { IdentityLeases } from "../src/identity-leases.ts";

for (const cli of ["claude", "codex", "kimi", "opencode"]) test(`${cli} startup offers recovery choices without claiming historical mail`, t => {
  const home = mkdtempSync(join(tmpdir(), "mbx-startup-choice-")), node = new MbxNode(home, { host: "alpha" });
  t.after(() => { node.close(); rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
  const leases = new IdentityLeases(node.store, { inspect: () => ({ alive: true, start: "fixture" }) });
  const lease = leases.claim("historical", { pid: process.pid, start: "fixture", keyFp: "aaaa-bbbb-cccc-dddd", cli, sessionId: "previous" });
  leases.release("historical", lease.token);
  node.send({ from: "sender", to: ["historical"], subject: "PRIVATE SUBJECT", body: "SECRET BODY" });
  const before = node.store.db.prepare("SELECT * FROM identity_leases").all();
  const result = spawnSync(process.execPath, ["bin/agentmbx.js", "hook", "session-start", "--cli", cli], {
    input: JSON.stringify({ session_id: "new-session", cwd: "/work" }), encoding: "utf8",
    env: { ...process.env, MBX_HOME: home, MBX_AGENT: "working", AGENTMBX_DEV: "1" },
  });
  assert.equal(result.status, 0, result.stderr);
  const context = cli === "kimi" ? result.stdout : JSON.parse(result.stdout).hookSpecificOutput.additionalContext;
  if (cli !== "kimi") assert.equal(JSON.parse(result.stdout).hookSpecificOutput.hookEventName, "SessionStart");
  assert.match(context, /no mailbox identity yet/); assert.match(context, /mbx_whoami/);
  assert.match(context, /"action\\?":\\?"claim\\?"/); assert.match(context, /"action\\?":\\?"register\\?"/);
  assert.doesNotMatch(context, /SECRET BODY|PRIVATE SUBJECT/);
  assert.deepEqual(node.store.db.prepare("SELECT * FROM identity_leases").all(), before);
  assert.equal(node.unreadCount("historical"), 1);
  assert.equal(node.unreadCount("working"), 0);
});


async function holder(t: TestContext, cli: string) {
  const home = mkdtempSync(join(tmpdir(), "mbx-hooks-"));
  createOwnerKey(home, "test-only-passphrase");
  const n = new MbxNode(home, { host: "alpha" }), owner = unlockOwnerKey(home, "test-only-passphrase");
  const client = new Client({ name: "hook-test", version: "1" });
  t.after(async () => { await client.close(); n.close(); rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
  // A shared transport (Codex, OpenCode) serves many sessions: each registers its own identity (T204).
  const shared = cli === "codex" || cli === "opencode";
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [resolve("bin/agentmbx.js"), "mcp"],
    env: { ...process.env, MBX_HOME: home, MBX_AGENT: shared ? "" : "builder", MBX_CLI: cli, AGENTMBX_DEV: "1" } as Record<string,string> }));
  const sid = cli === "codex" ? "77777777-7777-4777-8777-777777777777" : cli === "opencode" ? "ses_hooktest" : "real-hook-session";
  const meta = cli === "codex" ? { threadId: sid } : cli === "opencode" ? { sessionID: sid } : undefined;
  const call = (name: string, args: Record<string,unknown> = {}) => client.callTool({ name, arguments: args, ...(meta ? { _meta: meta } : {}) });
  if (shared) assert.notEqual((await call("mbx_identity", { action: "register", name: "builder", role: "builder" })).isError, true);
  const agent = ((await call("mbx_whoami")).structuredContent as { agent: string }).agent;
  const rec = makePolicy({ level: "autonomous", agents: [agent], hosts: ["alpha"], ownerPub: owner.publicKey });
  assert.equal(acceptSigned(n.store.db, { rec, sig: signData(owner.privateKey, canonical(rec)) }, "alpha"), null);
  const run = (event: string, session: unknown = sid, provider = cli, extraEnv: Record<string,string> = {}, input: Record<string,unknown> = {}) => spawnSync(process.execPath,
    [resolve("bin/agentmbx.js"), "hook", event, "--cli", provider], { input: JSON.stringify({ session_id: session, cwd: process.cwd(), ...input }),
      encoding: "utf8", timeout: 10_000, env: { ...process.env, MBX_HOME: home, MBX_AGENT: "unrelated", AGENTMBX_DEV: "1", ...extraEnv } });
  const send = (to = agent) => sendLeased(n, { from: "sender", to: [to], subject: "PRIVATE SUBJECT", body: "SECRET BODY", kind: "request" }).envelope.id;
  return { n, call, agent, sid, run, send };
}

test("Claude SessionEnd releases only the exact exiting holder and preserves mail", async t => {
  const { n, call, agent, sid, run, send } = await holder(t, "claude");
  assert.equal(run("prompt").status, 0); // establish the real SessionEnd session id
  const mail = send();
  const before = n.store.db.prepare("SELECT token,released_at FROM identity_leases WHERE name=?").get(agent)!;
  for (const reason of ["clear", "resume", "unknown", undefined]) {
    const result = run("session-end", sid, "claude", {}, { reason });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, "");
    assert.deepEqual(n.store.db.prepare("SELECT token,released_at FROM identity_leases WHERE name=?").get(agent), before);
  }
  assert.equal(run("session-end", "wrong-session", "claude", {}, { reason: "other" }).status, 0);
  assert.deepEqual(n.store.db.prepare("SELECT token,released_at FROM identity_leases WHERE name=?").get(agent), before);
  const result = run("session-end", sid, "claude", {}, { reason: "prompt_input_exit" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "", "completed shutdown must not report an uncertain result");
  assert.notEqual(n.store.db.prepare("SELECT released_at FROM identity_leases WHERE name=?").get(agent)!.released_at, null);
  assert.equal((await call("mbx_inbox")).isError, true);
  assert.equal(n.inbox(agent)[0].id, mail);
});

test("unbound SessionEnd hooks cannot release historical mailboxes", t => {
  const home = mkdtempSync(join(tmpdir(), "mbx-end-unbound-")), node = new MbxNode(home, { host: "alpha" });
  t.after(() => { node.close(); rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
  const leases = new IdentityLeases(node.store, { inspect: () => ({ alive: true, start: "fixture" }) });
  leases.claim("historical", { pid: process.pid, start: "fixture", keyFp: "aaaa-bbbb-cccc-dddd", cli: "claude", sessionId: "previous" });
  const before = node.store.db.prepare("SELECT * FROM identity_leases").all();
  const result = spawnSync(process.execPath, ["bin/agentmbx.js", "hook", "session-end", "--cli", "claude"], {
    input: JSON.stringify({ session_id: "previous", reason: "other" }), encoding: "utf8",
    env: { ...process.env, MBX_HOME: home, MBX_AGENT: "historical", AGENTMBX_DEV: "1" },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "");
  assert.deepEqual(node.store.db.prepare("SELECT * FROM identity_leases").all(), before);
});

for (const cli of ["claude", "codex", "kimi", "opencode"]) test(`${cli} hooks require current leases, bind exact IDs and stop after release`, async t => {
  const { n, call, agent, sid, run, send } = await holder(t, cli);
  const id = send();
  const prompt = run("prompt"); assert.equal(prompt.status, 0, prompt.stderr);
  assert.match(prompt.stdout, /1 unread mbx message/); assert.doesNotMatch(prompt.stdout, /PRIVATE SUBJECT|SECRET BODY|unrelated/);
  const rows = n.sessionsFor(agent); assert.equal(rows.length, 1); assert.equal(rows[0].session_id, sid); assert.ok(rows[0].session_key);
  assert.equal(n.inbox(agent)[0].state, "delivered");
  const startup = run("session-start"); assert.equal(startup.status, 0, startup.stderr);
  assert.match(startup.stdout, /1 unread/); assert.match(startup.stdout, /owner|Owner/);
  for (const unknown of [undefined, ...(cli === "claude" ? [] : ["missing-session"]), "", 42, {}]) {
    const before = n.store.db.prepare("SELECT * FROM sessions").all();
    // null represents absent/invalid session identity; the helper default is intentionally avoided.
    const r = run("prompt", unknown === undefined ? null : unknown);
    assert.equal(r.status, 0, r.stderr);
    // An unbound Kimi session is told once how to get an identity (Kimi drops SessionStart context); nothing else speaks.
    if (cli === "kimi" && unknown === "missing-session") assert.match(r.stdout, /no mailbox identity yet/); else assert.equal(r.stdout, "");
    assert.deepEqual(n.store.db.prepare("SELECT * FROM sessions").all(), before);
  }
  const stopped = run("stop");
  if (cli === "kimi") { assert.equal(stopped.status, 2); assert.match(stopped.stderr, /Before stopping/); }
  else if (cli !== "opencode") { assert.equal(stopped.status, 0); assert.equal(JSON.parse(stopped.stdout).decision, "block"); }
  else assert.equal(stopped.stdout, "");
  assert.equal(run("stop").stdout, "", "the same mail does not block twice");
  n.ack(id, agent);
  n.send({ from: "claimed", to: [agent], subject: "unverified", body: "not delegated", kind: "request", unverifiedSender: true });
  const unverified = run("stop"); assert.equal(unverified.status, 0, unverified.stderr); assert.equal(unverified.stdout, "");
  // autonomous has no relay depth limit (T104): even depth-1000 mail keeps the turn going like any delegated request
  const deep = sendLeased(n, { from: "sender", to: [agent], subject: "deep chain", body: "delegated", kind: "request", hop: 1000 }).envelope.id;
  const deepStop = run("stop");
  if (cli === "kimi") assert.equal(deepStop.status, 2);
  else if (cli !== "opencode") assert.equal(JSON.parse(deepStop.stdout).decision, "block");
  else assert.equal(deepStop.stdout, "");
  n.ack(deep, agent);
  assert.notEqual((await call("mbx_identity", { action: "release" })).isError, true);
  const before = n.store.db.prepare("SELECT * FROM sessions").all();
  for (const event of ["prompt", "post-tool", "stop", "session-start"]) {
    const r = run(event); assert.equal(r.status, 0, r.stderr);
    if (event === "session-start") { assert.match(r.stdout, /no mailbox identity yet/); assert.doesNotMatch(r.stdout, /You are|autonomous|new message|1 unread/); }
    else if (cli === "kimi" && event === "prompt") assert.match(r.stdout, /no mailbox identity yet/, "once, on the first unbound prompt");
    else assert.equal(r.stdout, "");
    assert.deepEqual(n.store.db.prepare("SELECT * FROM sessions").all(), before, "released hooks cannot recreate bindings");
  }
  assert.equal(n.inbox(agent).length, 1, "the unverified message (the deep one was acked)"); assert.ok(n.inbox(agent).every(m => m.state === "delivered"));
});

test("Claude post-tool deduplicates exact leased mailbox arrivals and ignores retired links", async t => {
  const { n, agent, run, send } = await holder(t, "claude");
  assert.equal(run("prompt").status, 0);
  assert.equal(run("post-tool").stdout, "");
  const first = send();
  assert.match(run("post-tool").stdout, /1 unread/); assert.equal(run("post-tool").stdout, "");
  n.ack(first, agent); send();
  assert.match(run("post-tool").stdout, /1 unread/); assert.equal(run("post-tool").stdout, "");
  n.store.set("ident:shell", agent); send("shell");
  assert.equal(run("post-tool").stdout, "");
  assert.equal(run("post-tool", "different-session").stdout, "");
});

test("unleased hooks neither rebind legacy sessions nor reveal mailbox counts", t => {
  const home = mkdtempSync(join(tmpdir(), "mbx-hook-legacy-")), n = new MbxNode(home, { host: "alpha" });
  t.after(() => { n.close(); rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
  n.bindSession({ agent: "builder", cli: "kimi", session_id: "legacy", pid: process.pid });
  sendLeased(n, { from: "sender", to: ["builder"], subject: "private", body: "private" });
  const before = n.store.db.prepare("SELECT * FROM sessions").all();
  for (const event of ["prompt", "stop", "session-start"]) {
    const r = spawnSync(process.execPath, [resolve("bin/agentmbx.js"), "hook", event, "--cli", "kimi"], {
      input: JSON.stringify({ session_id: "legacy" }), encoding: "utf8", env: { ...process.env, MBX_HOME: home, AGENTMBX_DEV: "1" } });
    assert.equal(r.status, 0, r.stderr); assert.doesNotMatch(r.stdout, /builder|1 unread|private/);
  }
  assert.deepEqual(n.store.db.prepare("SELECT * FROM sessions").all(), before);
});

test("hosted Kimi does not bootstrap an unknown thread from a provisional parent, even without a server token", async t => {
  const { n, run, send } = await holder(t, "kimi");
  send();
  const kimiHome = join(n.home, "kimi-fixture");
  mkdirSync(join(kimiHome, "server/instances"), { recursive: true });
  writeFileSync(join(kimiHome, "server/instances/test.json"), JSON.stringify({ pid: process.pid, port: 12345 }));
  const before = n.store.db.prepare("SELECT * FROM sessions").all();
  const r = run("prompt", "unknown-hosted-session", "kimi", { KIMI_CODE_HOME: kimiHome });
  assert.equal(r.status, 0, r.stderr); assert.doesNotMatch(r.stdout, /\d+ unread|PRIVATE|SECRET|You are/, "at most the generic identity guidance");
  assert.deepEqual(n.store.db.prepare("SELECT * FROM sessions").all(), before);
});

for (const cli of ["claude", "codex", "kimi", "opencode"]) test(`${cli} refuses malformed and provisional hook IDs without changing bindings`, async t => {
  const { n, run, send } = await holder(t, cli);
  send();
  const controls = n.store.db.prepare("SELECT v FROM kv WHERE k GLOB 'identity-control:*'").all().map(r => JSON.parse(r.v as string));
  const provisional = controls.find(d => d.session_id.startsWith("mcp-"))?.session_id ?? "mcp-12345";
  for (const sid of [" real-hook-session", "real-hook-session ", "bad\nline", "bad\u0000id", "bad\u007fid", "bad\u0085id", "x".repeat(301), provisional]) {
    const before = n.store.db.prepare("SELECT * FROM sessions").all();
    for (const event of ["prompt", "post-tool", "stop", "session-start"]) {
      const r = run(event, sid); assert.equal(r.status, 0, r.stderr);
      assert.doesNotMatch(r.stdout, /[0-9]+ unread|PRIVATE|SECRET|autonomous/);
      assert.deepEqual(n.store.db.prepare("SELECT * FROM sessions").all(), before);
    }
  }
});

test("Claude clear changes only the session alias of one current holder", async t => {
  const { n, call, agent, sid: originalSid, run, send } = await holder(t, "claude");
  send(); assert.match(run("prompt").stdout, /1 unread/);
  const original = n.sessionsFor(agent)[0];
  const lease = n.store.db.prepare("SELECT * FROM identity_leases WHERE name=?").get(agent);
  for (const sid of ["after-clear-1", "after-clear-2", originalSid]) {
    const r = run("session-start", sid); assert.equal(r.status, 0, r.stderr); assert.match(r.stdout, /1 unread/);
    const rows = n.sessionsFor(agent); assert.equal(rows.length, 1); assert.equal(rows[0].session_id, sid);
    assert.equal(rows[0].session_key, original.session_key); assert.equal(rows[0].channel, original.channel);
    assert.equal(n.store.db.prepare("SELECT token FROM identity_leases WHERE name=?").get(agent)?.token, lease?.token);
    assert.match(run("prompt", sid).stdout, /1 unread/);
    assert.notEqual((await call("mbx_inbox")).isError, true);
  }
  await call("mbx_identity", { action: "release" });
  assert.equal(run("prompt", "after-release").stdout, ""); assert.equal(n.sessionsFor(agent).length, 0);
});

test("Claude new session refuses two MCP holders sharing a parent", async t => {
  const { n, agent, run, send } = await holder(t, "claude");
  send(); assert.match(run("prompt").stdout, /1 unread/);
  const other = new Client({ name: "second-hook-holder", version: "1" });
  t.after(() => other.close());
  await other.connect(new StdioClientTransport({ command: process.execPath, args: [resolve("bin/agentmbx.js"), "mcp"],
    env: { ...process.env, MBX_HOME: n.home, MBX_AGENT: "other", MBX_CLI: "claude", AGENTMBX_DEV: "1" } as Record<string,string> }));
  await other.callTool({ name: "mbx_whoami", arguments: {} });
  const before = n.store.db.prepare("SELECT * FROM sessions").all();
  const r = run("prompt", "new-ambiguous-session"); assert.equal(r.status, 0, r.stderr); assert.equal(r.stdout, "");
  assert.deepEqual(n.store.db.prepare("SELECT * FROM sessions").all(), before);
  assert.equal(n.unreadCount(agent), 1);
});

for (const cli of ["claude", "codex", "kimi"]) test(`${cli} Stop honors a directly signed owner request without a broad policy`, async t => {
  const { n, agent, run } = await holder(t, cli);
  assert.equal(run("prompt").status, 0);
  n.store.db.prepare("DELETE FROM policies").run();
  const owner = unlockOwnerKey(n.home, "test-only-passphrase");
  await n.sendAsOwner({ from: "owner", to: [agent], subject: "owner task", body: "signed instruction", kind: "request" },
    async payload => ({ sig: signData(owner.privateKey, payload) }));
  const r = run("stop");
  if (cli === "kimi") { assert.equal(r.status, 2); assert.match(r.stderr, /Before stopping/); }
  else { assert.equal(r.status, 0, r.stderr); assert.equal(JSON.parse(r.stdout).decision, "block"); }
});

test("Claude /clear with a real session file: the hook rebinds the holder to the new id; a forged id is refused (T309)", async t => {
  // Claude writes ~/.claude/sessions/<pid>.json before it starts MCP servers, so the holder's lease carries the real id
  // (not a provisional mcp- id). /clear rewrites that file while the same process and MCP server live on.
  const home = mkdtempSync(join(tmpdir(), "mbx-clear-")), fakeHome = mkdtempSync(join(tmpdir(), "mbx-clear-home-"));
  const n = new MbxNode(home, { host: "alpha" });
  const client = new Client({ name: "clear-test", version: "1" });
  t.after(async () => { await client.close(); n.close(); for (const d of [home, fakeHome]) rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
  const sessions = join(fakeHome, ".claude/sessions"); mkdirSync(sessions, { recursive: true });
  const write = (sid: string) => writeFileSync(join(sessions, `${process.pid}.json`), JSON.stringify({ pid: process.pid, sessionId: sid }));
  write("real-before-clear");
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [resolve("bin/agentmbx.js"), "mcp"],
    env: { ...process.env, HOME: fakeHome, MBX_HOME: home, MBX_AGENT: "builder", MBX_CLI: "claude", AGENTMBX_DEV: "1" } as Record<string,string> }));
  assert.equal(((await client.callTool({ name: "mbx_whoami", arguments: {} })).structuredContent as { agent: string }).agent, "builder");
  assert.equal(n.store.db.prepare("SELECT session_id FROM identity_leases WHERE name='builder'").get()?.session_id, "real-before-clear");
  sendLeased(n, { from: "sender", to: ["builder"], subject: "s", body: "b", kind: "request" });
  const run = (event: string, sid: string) => spawnSync(process.execPath, [resolve("bin/agentmbx.js"), "hook", event, "--cli", "claude"],
    { input: JSON.stringify({ session_id: sid, cwd: process.cwd() }), encoding: "utf8", timeout: 10_000,
      env: { ...process.env, HOME: fakeHome, MBX_HOME: home, MBX_AGENT: "unrelated", AGENTMBX_DEV: "1" } });
  assert.match(run("prompt", "real-before-clear").stdout, /1 unread/);
  write("after-clear");
  const r = run("session-start", "after-clear"); assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /You are builder@alpha/); assert.match(r.stdout, /1 unread/);
  assert.deepEqual(n.sessionsFor("builder").map((s) => s.session_id), ["after-clear"]);
  assert.match(run("prompt", "after-clear").stdout, /1 unread/);
  // A session id the provider's own file does not name never rebinds the holder.
  const forged = run("prompt", "someone-else"); assert.equal(forged.status, 0, forged.stderr); assert.doesNotMatch(forged.stdout, /unread/);
  assert.deepEqual(n.sessionsFor("builder").map((s) => s.session_id), ["after-clear"]);
  assert.notEqual((await client.callTool({ name: "mbx_inbox", arguments: {} })).isError, true);
});
