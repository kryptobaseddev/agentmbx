// T186: Codex SessionStart carries the bounded resume notice (spec t184-provider-resume-adapters, Codex section).
import { sendLeased } from "./helpers/leased-send.ts";
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { canonical, signData } from "../src/crypto.ts";
import { createOwnerKey, unlockOwnerKey } from "../src/owner.ts";
import { acceptSigned, makePolicy } from "../src/policy.ts";
import { MbxNode } from "../src/node.ts";
import { RESUME_NOTICE_MAX_CHARS, RESUME_NOTICE_MAX_LINES } from "../src/resume-notice.ts";
import { identityControlKey, listIdentityControls } from "../src/identity-control.ts";
import { bindWakeLease } from "./helpers/wake-lease.ts";

const BIN = resolve("bin/agentmbx.js");
const additional = (stdout: string): string => stdout
  ? (JSON.parse(stdout) as { hookSpecificOutput: { additionalContext: string } }).hookSpecificOutput.additionalContext : "";
const hinted = (text: string) => (text.match(/not caught up on; call mbx_catchup/g) ?? []).length;

async function holder(t: TestContext, cli: "codex" | "claude", sid = "77777777-7777-4777-8777-777777777777") {
  const home = mkdtempSync(join(tmpdir(), "mbx-codex-hook-"));
  createOwnerKey(home, "test-only-passphrase");
  const n = new MbxNode(home, { host: "alpha" }), owner = unlockOwnerKey(home, "test-only-passphrase");
  const client = new Client({ name: "codex-hook-test", version: "1" });
  t.after(async () => { await client.close(); n.close(); rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
  const shared = cli === "codex";
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [BIN, "mcp"],
    env: { ...process.env, MBX_HOME: home, MBX_AGENT: shared ? "" : "builder", MBX_CLI: cli, AGENTMBX_DEV: "1" } as Record<string, string> }));
  const meta = shared ? { threadId: sid } : undefined;
  const call = (name: string, args: Record<string, unknown> = {}, thread = sid) => client.callTool({
    name, arguments: args, _meta: shared ? { threadId: thread } : meta });
  if (shared) assert.notEqual((await call("mbx_identity", { action: "register", name: "builder", role: "builder" })).isError, true);
  const agent = ((await call("mbx_whoami")).structuredContent as { agent: string }).agent;
  const rec = makePolicy({ level: "autonomous", agents: [agent], hosts: ["alpha"], ownerPub: owner.publicKey });
  assert.equal(acceptSigned(n.store.db, { rec, sig: signData(owner.privateKey, canonical(rec)) }, "alpha"), null);
  const run = (event: string, session = sid, provider = cli, input: Record<string, unknown> = {}) => spawnSync(process.execPath,
    [BIN, "hook", event, "--cli", provider], { input: JSON.stringify({ session_id: session, cwd: process.cwd(), ...input }),
      encoding: "utf8", timeout: 10_000, env: { ...process.env, MBX_HOME: home, MBX_AGENT: "unrelated", AGENTMBX_DEV: "1" } });
  const send = () => sendLeased(n, { from: "sender", to: [agent], subject: "PRIVATE SUBJECT", body: "SECRET BODY", kind: "request" }).envelope.id;
  return { n, home, call, agent, sid, run, send };
}

test("T186: a bound Codex SessionStart replaces the identity line with one notice; the next prompt does not repeat it", async t => {
  const { n, agent, run, send } = await holder(t, "codex");
  send();
  const state = () => JSON.stringify([
    n.store.db.prepare("SELECT msg_id,agent,state FROM deliveries ORDER BY msg_id").all(),
    n.store.get(`catchup:${agent}`),
    n.store.db.prepare("SELECT name,cli,session_id,released_at,token FROM identity_leases ORDER BY name").all(),
  ]);
  const start = (source?: string) => {
    const r = run("session-start", undefined, "codex", source === undefined ? {} : { source });
    assert.equal(r.status, 0, r.stderr);
    const parsed = JSON.parse(r.stdout) as { hookSpecificOutput: { hookEventName: string; additionalContext: string } };
    assert.equal(parsed.hookSpecificOutput.hookEventName, "SessionStart");
    return parsed.hookSpecificOutput.additionalContext;
  };
  const before = state();
  const first = start("startup");
  assert.equal((first.match(/\(role: builder\)/g) ?? []).length, 1, "identity once, inside the notice");
  assert.equal(hinted(first), 1);
  assert.match(first, /\[mbx\] 1 open thread\(s\) with unacked mail\./);
  assert.match(first, /1 unread/);
  assert.doesNotMatch(first, /PRIVATE SUBJECT|SECRET BODY/);
  const notice = first.split("\n").filter(l => /role: builder|not caught up on|open thread/.test(l)).join("\n");
  assert.ok(notice.length <= RESUME_NOTICE_MAX_CHARS && notice.split("\n").length <= RESUME_NOTICE_MAX_LINES, notice);
  assert.equal(hinted(additional(run("prompt", undefined, "codex", { prompt: "go on" }).stdout)), 0, "SessionStart took the entry");
  for (const source of ["startup", "resume", "clear", "compact", undefined]) {
    assert.equal(hinted(start(source)), 1, `${source ?? "missing"} re-injects on the same thread id`);
    assert.equal(hinted(additional(run("prompt", undefined, "codex", { prompt: "again" }).stdout)), 0);
  }
  const other = start("fork");
  assert.equal(hinted(other), 0, "a source Codex does not send stays the plain identity line");
  assert.match(other, /You are builder@alpha/);
  assert.equal(state(), before, "no delivery, checkpoint or lease moved");
  const claude = await holder(t, "claude", "real-hook-session");
  claude.send();
  const cx = additional(claude.run("session-start", "real-hook-session", "claude", { source: "resume" }).stdout);
  assert.match(cx, /You are builder@alpha/);
  assert.equal(hinted(cx), 1, "Claude's SessionStart carries T185's notice too");
});

test("T186: an unbound or still-resuming Codex SessionStart records no entry; the first bound prompt does", async t => {
  const home = mkdtempSync(join(tmpdir(), "mbx-codex-defer-"));
  createOwnerKey(home, "test-only-passphrase");
  const n = new MbxNode(home, { host: "alpha" });
  const sid = "77777777-7777-4777-8777-777777777777";
  const run = (event: string, input: Record<string, unknown> = {}) => spawnSync(process.execPath, [BIN, "hook", event, "--cli", "codex"], {
    input: JSON.stringify({ session_id: sid, cwd: process.cwd(), ...input }), encoding: "utf8", timeout: 10_000,
    env: { ...process.env, MBX_HOME: home, MBX_AGENT: "unrelated", AGENTMBX_DEV: "1" } });
  const entries = () => Number(n.store.db.prepare("SELECT COUNT(*) n FROM kv WHERE k LIKE 'resume-entry:%'").get()!.n);
  const unbound = run("session-start", { source: "startup" });
  assert.equal(unbound.status, 0, unbound.stderr);
  assert.equal(hinted(additional(unbound.stdout)), 0);
  assert.match(additional(unbound.stdout), /no mailbox identity yet/);
  assert.equal(entries(), 0);
  const sleeper = spawn("sleep", ["30"], { stdio: "ignore" });
  t.after(() => { sleeper.kill(); n.close(); rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
  mkdirSync(join(home, "mcp-starting"), { recursive: true });
  writeFileSync(join(home, "mcp-starting", `${sleeper.pid}.json`), JSON.stringify({
    pid: sleeper.pid, parent: process.pid, cli: "codex", createdAt: Date.now(), generation: "t186" }));
  const resuming = run("session-start", { source: "resume" });
  assert.equal(resuming.status, 0, resuming.stderr);
  assert.match(additional(resuming.stdout), /identity is still resuming/);
  assert.equal(hinted(additional(resuming.stdout)), 0);
  assert.equal(entries(), 0, "still resuming does not take the entry");
  sleeper.kill();
  const owner = unlockOwnerKey(home, "test-only-passphrase");
  const client = new Client({ name: "codex-defer", version: "1" });
  t.after(() => client.close());
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [BIN, "mcp"],
    env: { ...process.env, MBX_HOME: home, MBX_AGENT: "", MBX_CLI: "codex", AGENTMBX_DEV: "1" } as Record<string, string> }));
  const call = (name: string, args: Record<string, unknown> = {}) => client.callTool({ name, arguments: args, _meta: { threadId: sid } });
  assert.notEqual((await call("mbx_identity", { action: "register", name: "builder", role: "builder" })).isError, true);
  const agent = ((await call("mbx_whoami")).structuredContent as { agent: string }).agent;
  const rec = makePolicy({ level: "autonomous", agents: [agent], hosts: ["alpha"], ownerPub: owner.publicKey });
  assert.equal(acceptSigned(n.store.db, { rec, sig: signData(owner.privateKey, canonical(rec)) }, "alpha"), null);
  sendLeased(n, { from: "sender", to: [agent], subject: "PRIVATE SUBJECT", body: "SECRET BODY", kind: "request" });
  const first = run("prompt", { prompt: "hi" });
  assert.equal(first.status, 0, first.stderr);
  assert.equal(hinted(additional(first.stdout)), 1, "deferred to the first bound prompt");
  assert.doesNotMatch(additional(first.stdout), /PRIVATE SUBJECT|SECRET BODY/);
  assert.equal(hinted(additional(run("prompt", { prompt: "again" }).stdout)), 0);
  assert.equal(entries(), 1);
});

test("T614: a restarted Codex thread says resuming before its first mailbox call, then delivers the bound notice once", async t => {
  const home = mkdtempSync(join(tmpdir(), "mbx-codex-restart-")), n = new MbxNode(home, { host: "alpha" });
  const old = spawn("sleep", ["600"], { stdio: "ignore" });
  const client = new Client({ name: "codex-restart", version: "1" });
  t.after(async () => { await client.close().catch(() => {}); old.kill("SIGKILL"); n.close(); rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
  const sid = "77777777-7777-4777-8777-777777777777";
  const held = bindWakeLease(n, { agent: "builder", cli: "codex", session_id: sid, pid: old.pid! });
  const key = n.sessionsFor("builder")[0].session_key!;
  n.store.db.prepare("DELETE FROM kv WHERE k IN (?,?)").run(identityControlKey("codex", sid), `mcp-process:${key}`);
  assert.equal(held.release(), true);
  old.kill("SIGKILL"); await once(old, "exit");
  sendLeased(n, { from: "sender", to: ["builder"], subject: "PRIVATE SUBJECT", body: "SECRET BODY", kind: "request" });
  const run = (event: string) => {
    const r = spawnSync(process.execPath, [BIN, "hook", event, "--cli", "codex"], {
      input: JSON.stringify({ session_id: sid, cwd: process.cwd(), source: "resume", prompt: "continue" }), encoding: "utf8", timeout: 10_000,
      env: { ...process.env, MBX_HOME: home, MBX_AGENT: "unrelated", AGENTMBX_DEV: "1" } });
    assert.equal(r.status, 0, r.stderr);
    return additional(r.stdout);
  };
  const entries = () => Number(n.store.db.prepare("SELECT COUNT(*) n FROM kv WHERE k LIKE 'resume-entry:codex:%'").get()!.n);
  const state = () => JSON.stringify([
    n.store.db.prepare("SELECT * FROM identity_leases ORDER BY name").all(),
    n.store.db.prepare("SELECT msg_id,agent,state FROM deliveries ORDER BY msg_id").all(),
    n.store.get("catchup:builder"),
  ]);
  const resuming = () => {
    const before = state();
    for (const event of ["session-start", "prompt"]) {
      assert.equal(run(event), "[mbx] Resuming builder@alpha: this session's mailbox server is still connecting. Call mbx_whoami and wait for its result before claiming or registering.");
      assert.equal(entries(), 0, "advisory delivery does not consume the entry");
    }
    assert.equal(state(), before, "no lease, delivery or catch-up position moved");
  };
  resuming(); // The provider restarted, before it even launches its mailbox server.
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [BIN, "mcp"],
    env: { ...process.env, MBX_HOME: home, MBX_AGENT: "", MBX_CLI: "codex", AGENTMBX_DEV: "1" } as Record<string, string> }));
  await client.listTools(); // SDK ready, no thread metadata yet: the startup marker no longer covers this state.
  const controls = listIdentityControls(n.store).filter(d => d.cli === "codex" && d.parent_pid === process.pid);
  assert.ok(controls.length > 0 && controls.every(d => !d.agent && d.session_id.startsWith("mcp-")));
  resuming();

  const who = (await client.callTool({ name: "mbx_whoami", arguments: {}, _meta: { threadId: sid } })).structuredContent as { agent: string; harness_session: string };
  assert.equal(who.agent, "builder");
  assert.equal(who.harness_session, sid);
  assert.equal(entries(), 0, "the first tool call still leaves notice delivery to the hook");
  const before = state(), bound = run("prompt");
  assert.match(bound, /\[mbx\] You are builder@alpha\b/);
  assert.equal(hinted(bound), 1);
  assert.match(bound, /1 open thread\(s\) with unacked mail/);
  assert.doesNotMatch(bound, /Resuming|mbx disconnected|no mailbox identity yet|PRIVATE SUBJECT|SECRET BODY/);
  const notice = bound.split("\n").filter(l => /You are builder@alpha|not caught up on|open thread/.test(l)).join("\n");
  assert.ok(notice.length <= RESUME_NOTICE_MAX_CHARS && notice.split("\n").length <= RESUME_NOTICE_MAX_LINES);
  assert.equal(entries(), 1);
  assert.doesNotMatch(run("prompt"), /You are builder@alpha|Resuming|not caught up on|PRIVATE SUBJECT|SECRET BODY/,
    "the notice is once per entry; unread reminders can still repeat");
  assert.equal(entries(), 1);
  assert.equal(state(), before, "the notice changes no mailbox state");
});

test("T186: two Codex threads on one app-server each get only their own identity", async t => {
  const home = mkdtempSync(join(tmpdir(), "mbx-codex-threads-"));
  createOwnerKey(home, "test-only-passphrase");
  const n = new MbxNode(home, { host: "alpha" }), owner = unlockOwnerKey(home, "test-only-passphrase");
  const client = new Client({ name: "codex-threads", version: "1" });
  t.after(async () => { await client.close(); n.close(); rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [BIN, "mcp"],
    env: { ...process.env, MBX_HOME: home, MBX_AGENT: "", MBX_CLI: "codex", AGENTMBX_DEV: "1" } as Record<string, string> }));
  const a = "77777777-7777-4777-8777-777777777777", b = "88888888-8888-4888-8888-888888888888";
  const call = (thread: string, name: string, args: Record<string, unknown> = {}) => client.callTool({ name, arguments: args, _meta: { threadId: thread } });
  assert.notEqual((await call(a, "mbx_identity", { action: "register", name: "thread-a", role: "alpha" })).isError, true);
  assert.notEqual((await call(b, "mbx_identity", { action: "register", name: "thread-b", role: "beta" })).isError, true);
  for (const agent of ["thread-a", "thread-b"]) {
    const rec = makePolicy({ level: "autonomous", agents: [agent], hosts: ["alpha"], ownerPub: owner.publicKey });
    assert.equal(acceptSigned(n.store.db, { rec, sig: signData(owner.privateKey, canonical(rec)) }, "alpha"), null);
  }
  sendLeased(n, { from: "sender", to: ["thread-a"], subject: "PRIVATE SUBJECT", body: "SECRET BODY", kind: "request" });
  const start = (sid: string) => {
    const r = spawnSync(process.execPath, [BIN, "hook", "session-start", "--cli", "codex"], {
      input: JSON.stringify({ session_id: sid, cwd: process.cwd(), source: "startup" }), encoding: "utf8", timeout: 10_000,
      env: { ...process.env, MBX_HOME: home, MBX_AGENT: "unrelated", AGENTMBX_DEV: "1" } });
    assert.equal(r.status, 0, r.stderr);
    return additional(r.stdout);
  };
  const left = start(a), right = start(b);
  assert.match(left, /You are thread-a@alpha \(role: alpha\)/);
  assert.equal(hinted(left), 1);
  assert.doesNotMatch(left, /thread-b|PRIVATE SUBJECT|SECRET BODY/);
  assert.match(right, /You are thread-b@alpha \(role: beta\)/);
  assert.doesNotMatch(right, /thread-a|not caught up on|PRIVATE SUBJECT|SECRET BODY/);
});
