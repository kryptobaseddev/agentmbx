import { sendLeased } from "./helpers/leased-send.ts";
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { writeHud } from "../src/hud.ts";
import { posttoolFileCount } from "../src/posttool.ts";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { canonical, signData } from "../src/crypto.ts";
import { createOwnerKey, unlockOwnerKey } from "../src/owner.ts";
import { acceptSigned, makePolicy } from "../src/policy.ts";
import { MbxNode } from "../src/node.ts";
import { IdentityLeases } from "../src/identity-leases.ts";
import { applyForward, buildForward } from "../src/identity-cleanup.ts";

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
  assert.match(prompt.stdout, /1 unread for .*: mbx_inbox/); assert.doesNotMatch(prompt.stdout, /PRIVATE SUBJECT|SECRET BODY|unrelated/);
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
  const repeat = run("stop");
  assert.equal(repeat.stdout, "", "the same mail does not block twice");
  // T435: a terminal kimi with no live watcher still continues once, to re-arm. That is the
  // watcher instruction, not the mail that was already surfaced.
  if (cli === "kimi") { assert.equal(repeat.status, 2); assert.match(repeat.stderr, /agentmbx watch/); assert.doesNotMatch(repeat.stderr, /Before stopping/); }
  n.ack(id, agent);
  n.send({ from: "claimed", to: [agent], subject: "unverified", body: "not delegated", kind: "request", unverifiedSender: true });
  const unverified = run("stop");
  assert.equal(unverified.stdout, "");
  if (cli === "kimi") {
    assert.equal(unverified.status, 2, unverified.stderr);
    assert.match(unverified.stderr, /agentmbx watch/);
    assert.doesNotMatch(unverified.stderr, /unverified|not delegated/, "unverified mail does not continue the turn");
  } else assert.equal(unverified.status, 0, unverified.stderr);
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

// T342: the bundled sh wrapper must decide "nothing changed" without starting node — two small
// file reads — and every doubt must fall through to the full hook, whose decisions are unchanged.
test("T342: the post-tool wrapper skips steady state without node; markers bump on bind and delivery; the sweep prunes", async t => {
  const { n, agent, sid, run, send } = await holder(t, "claude");
  const script = resolve("skill/scripts/claude-posttool.sh");
  const dir = join(n.home, "posttool");
  const markerFile = join(dir, `claude-${sid}.marker`), lastFile = join(dir, `claude-${sid}.last`);
  // The wrapper takes the hook's resolved command as arguments (review high — never PATH agentmbx).
  // For the full-path run we hand it THIS checkout; for the node-absent steady run a sentinel that
  // proves any exec.
  const sentinelDir = mkdtempSync(join(tmpdir(), "mbx-t342-sentinel-"));
  t.after(() => rmSync(sentinelDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  const sentinel = join(sentinelDir, "spawned");
  const sentinelScript = join(sentinelDir, "runme");
  writeFileSync(sentinelScript, `#!/bin/sh\ntouch "${sentinel}"\nexit 0\n`, { mode: 0o700 });
  const wrap = (argv: string[], path: string, session: unknown = sid) => spawnSync("/bin/sh", [script, ...argv], {
    input: JSON.stringify({ session_id: session, cwd: process.cwd() }), encoding: "utf8",
    env: { ...process.env, MBX_HOME: n.home, AGENTMBX_DEV: "1", PATH: path } });

  // The prompt hook binds the session; the bind bumps the fast-path marker into existence.
  assert.equal(run("prompt").status, 0);
  assert.ok(existsSync(markerFile), "a claude bind writes the marker");

  // New mail bumps the marker (delivery = the unacked-id set grew, so the hook decision may change).
  const before = readFileSync(markerFile, "utf8");
  send();
  const after = readFileSync(markerFile, "utf8");
  assert.notEqual(after, before, "a local delivery bumps the marker");

  // The wrapper falls through to the full hook (this checkout's), which notifies and records .last.
  const notice = wrap([process.execPath, resolve("bin/agentmbx.js")], process.env.PATH!);
  assert.equal(notice.status, 0, notice.stderr); assert.match(notice.stdout, /1 unread/);
  assert.equal(readFileSync(lastFile, "utf8"), after, "the full path records the marker it processed");

  // Steady state: marker == last. With node absent from PATH the wrapper must skip silently and
  // never exec the hook command at all (the sentinel stays untouched).
  const steady = wrap([sentinelScript], "/bin:/usr/bin");
  assert.equal(steady.status, 0, steady.stderr);
  assert.equal(steady.stdout, "");
  assert.ok(!existsSync(sentinel), "steady state execs nothing");
  assert.equal(run("post-tool").stdout, "", "full path still silent in steady state");

  // An invalid session id falls through (it cannot key a marker).
  const badSid = wrap([sentinelScript], "/bin:/usr/bin", "bad id!");
  assert.equal(badSid.stdout, "", "no session id, no marker: silent without node is fine (Claude re-runs nothing)");

  // The daemon-tick sweep prunes markers whose binding vanished.
  n.store.db.prepare("DELETE FROM sessions WHERE cli='claude' AND session_id=?").run(sid);
  writeHud(n);
  assert.ok(!existsSync(markerFile) && !existsSync(lastFile), "an unbound session's marker and last are swept");
  assert.equal(posttoolFileCount(n.home), 0);
});

// Review medium 2: every other way a mailbox gains unread mail must also bump the marker.
test("T342: rename and owner forward bump the fast-path markers", t => {
  const home = mkdtempSync(join(tmpdir(), "mbx-t342-m2-"));
  t.after(() => rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  const n = new MbxNode(home, { host: "alpha" });
  t.after(() => n.close());
  n.bindSession({ agent: "renamer", cli: "claude", session_id: "rn-1", pid: process.pid });
  const markerFile = join(n.home, "posttool/claude-rn-1.marker");
  const first = readFileSync(markerFile, "utf8");
  sendLeased(n, { from: "boss", to: ["renamer"], subject: "hi", body: "b" });
  const afterSend = readFileSync(markerFile, "utf8");
  assert.notEqual(afterSend, first);
  n.addAlias("renamer", "renamed", process.pid);
  assert.notEqual(readFileSync(markerFile, "utf8"), afterSend, "a rename bumps the marker under the new name");

  // owner forward: unread mail moving to a mailbox whose claude session is bound bumps its marker
  const home2 = mkdtempSync(join(tmpdir(), "mbx-t342-fwd-"));
  t.after(() => rmSync(home2, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  createOwnerKey(home2, "test-only-passphrase");
  const n2 = new MbxNode(home2, { host: "alpha" });
  t.after(() => n2.close());
  const owner2 = unlockOwnerKey(home2, "test-only-passphrase");
  n2.registerAgent("orbit-lead"); n2.registerAgent("orbit-mcp-0123456789abcdef");
  n2.bindSession({ agent: "orbit-lead", cli: "claude", session_id: "fwd-1", pid: process.pid });
  const fwdMarker = join(home2, "posttool/claude-fwd-1.marker");
  const fwdBefore = readFileSync(fwdMarker, "utf8");
  sendLeased(n2, { from: "boss", to: ["orbit-mcp-0123456789abcdef"], subject: "one", body: "1" });
  const payload = buildForward(n2, "orbit-mcp-0123456789abcdef", "orbit-lead");
  applyForward(n2, { payload, sig: signData(owner2.privateKey, canonical(payload)) });
  assert.notEqual(readFileSync(fwdMarker, "utf8"), fwdBefore, "an owner forward bumps the target's marker");
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

test("lean notices: a wake prompt adds no second notice, and the policy recap is sent once per session", async t => {
  const { n, agent, run, send } = await holder(t, "claude");
  send();
  const first = run("prompt", "real-hook-session", "claude", {}, { prompt: "please continue" });
  assert.match(first.stdout, /1 unread for .*: mbx_inbox\. Policies \(separate grants; each message.s mbx_read header applies\): autonomous/);
  const second = run("prompt", "real-hook-session", "claude", {}, { prompt: "and now?" });
  assert.match(second.stdout, /1 unread for .*: mbx_inbox\./); assert.doesNotMatch(second.stdout, /Policies/, "recap only once per session");
  const wake = run("prompt", "real-hook-session", "claude", {}, { prompt: `[mbx] 1 new message(s) for ${agent} from sender@alpha [local] (ids X). mbx_read, reply, ack.` });
  assert.doesNotMatch(wake.stdout, /unread for/, "the wake prompt is the notice");
  void n;
});
