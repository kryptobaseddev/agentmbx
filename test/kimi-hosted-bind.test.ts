// T033: hosted Kimi (desktop daimon, kimi web) runs one mbx server per conversation under one shared parent. The
// conversation's hook issues a one-time bind ticket and its own server links itself to the real session; the desktop
// adapter then wakes that conversation through the app's control socket.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { MbxNode } from "../src/node.ts";
import { issueBindTicket, takeBindTicket } from "../src/bind-ticket.ts";
import { RpcError, type KimiDesktop } from "../src/kimi-desktop.ts";
import { wakeKimiDesktop } from "../src/wake.ts";

/** A fake desktop daimon whose control endpoint names this test process as the daimon (the parent of every child). */
function fakeDaimon() {
  const dir = mkdtempSync(join(tmpdir(), "mbx-daimon-"));
  mkdirSync(join(dir, "agents/main"), { recursive: true });
  writeFileSync(join(dir, "agents/main/runner.state.json"), JSON.stringify({ control: { endpoint: { url: "ws://127.0.0.1:9/control", pid: process.pid, auth: { token: "fixture" } } } }));
  return dir;
}

test("bind tickets are single use, reused per session while fresh, and only fit their own parent process", t => {
  const home = mkdtempSync(join(tmpdir(), "mbx-ticket-")), n = new MbxNode(home, { host: "alpha" });
  t.after(() => { n.close(); rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
  const now = Date.now(), base = { cli: "kimi", session_id: "conv-1", cwd: "/work/a", parent_pid: 4242 };
  const a = issueBindTicket(n.store, base, now);
  assert.equal(issueBindTicket(n.store, base, now + 1000), a, "the same session gets the same ticket");
  assert.notEqual(issueBindTicket(n.store, { ...base, session_id: "conv-2" }, now), a);
  assert.equal(takeBindTicket(n.store, a, "kimi", 999, now), null, "another app process can't take it");
  assert.equal(takeBindTicket(n.store, a, "claude", 4242, now), null);
  assert.equal(takeBindTicket(n.store, a, "kimi", 4242, now)?.session_id, "conv-1");
  assert.equal(takeBindTicket(n.store, a, "kimi", 4242, now), null, "single use");
  const old = issueBindTicket(n.store, { ...base, session_id: "conv-3" }, now);
  assert.equal(takeBindTicket(n.store, old, "kimi", 4242, now + 16 * 60_000), null, "expired");
  assert.equal(takeBindTicket(n.store, "not-a-ticket", "kimi", 4242, now), null);
});

test("a desktop conversation links its own mbx server by ticket, takes its folder name, and its hooks then work", async t => {
  const home = mkdtempSync(join(tmpdir(), "mbx-hosted-")), daimon = fakeDaimon();
  const work = mkdtempSync(join(tmpdir(), "mbx-hosted-work-")), project = join(work, "orbit"), plugin = join(work, "agentmbx");
  mkdirSync(project); mkdirSync(plugin);
  const n = new MbxNode(home, { host: "alpha" });
  const env = { ...process.env, AGENTMBX_DEV: "1", MBX_HOME: home, MBX_CLI: "kimi", MBX_AGENT: "", MBX_NO_DESKTOP: "1", MBX_KIMI_DESKTOP_DAIMON: daimon } as Record<string, string>;
  const a = new Client({ name: "conv-a", version: "1" }), b = new Client({ name: "conv-b", version: "1" });
  t.after(async () => { await a.close(); await b.close(); n.close(); for (const d of [home, daimon, work]) rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
  // two conversations of one app process: both servers start in the plugin folder, under the same parent
  for (const c of [a, b]) await c.connect(new StdioClientTransport({ command: process.execPath, args: [resolve("bin/agentmbx.js"), "mcp"], env, cwd: plugin }));
  const hook = (event: string, sid: string) => spawnSync(process.execPath, [resolve("bin/agentmbx.js"), "hook", event, "--cli", "kimi"],
    { input: JSON.stringify({ session_id: sid, cwd: project }), encoding: "utf8", env });

  const start = hook("session-start", "conv-aaa");
  assert.equal(start.status, 0, start.stderr);
  const nonce = /bind="([a-f0-9]{32})"/.exec(start.stdout)?.[1];
  assert.ok(nonce, `the hook hands the conversation a ticket: ${start.stdout}`);
  assert.doesNotMatch(start.stdout, /agentmbx watch|CronCreate/, "a desktop conversation is woken by the app, not a watcher");

  const who = (await a.callTool({ name: "mbx_whoami", arguments: { bind: nonce } })).structuredContent as { agent: string; delivery: string };
  assert.equal(who.agent, "orbit", "the linked server takes the conversation's folder name");
  assert.match(who.delivery, /^push \(kimi web or desktop app\)/);
  const row = n.store.db.prepare("SELECT agent, cwd, pid FROM sessions WHERE cli='kimi' AND session_id='conv-aaa'").get() as { agent: string; cwd: string; pid: number };
  assert.deepEqual({ ...row }, { agent: "orbit", cwd: realpathSync(project), pid: process.pid });
  assert.equal((await b.callTool({ name: "mbx_whoami", arguments: { bind: nonce } })).isError, true, "a used ticket links nothing else");
  // a second conversation in the same folder: the folder name is held, so it takes a readable variant
  const second = /bind="([a-f0-9]{32})"/.exec(hook("prompt", "conv-bbb").stdout)?.[1];
  assert.ok(second, "the prompt hook hands an unlinked conversation its ticket (Kimi drops SessionStart context)");
  assert.equal(((await b.callTool({ name: "mbx_whoami", arguments: { bind: second } })).structuredContent as { agent: string }).agent, "orbit-kimi-app");

  n.send({ from: "boss", to: ["orbit"], subject: "s", body: "b", kind: "request" });
  const prompt = hook("prompt", "conv-aaa");
  assert.match(prompt.stdout, /1 unread mbx message\(s\) for orbit@alpha/, "hooks now resolve the linked conversation");
  assert.doesNotMatch(prompt.stdout, /bind=/);
});

const desktop: KimiDesktop = { url: "ws://127.0.0.1:9/control", token: "t", pid: 1, dir: "/x" };
const listing = { conversations: [{ conversationKey: "agent:main:main:conversation:c1", kernelSessionId: "conv-aaa" }] };

test("wakeKimiDesktop maps the session to its conversation and starts a turn when idle", async () => {
  const calls: string[] = [];
  const rpc = (async (_d: KimiDesktop, c: [string, Record<string, unknown>][], o?: { sent?: () => void }) => {
    calls.push(...c.map(([m, p]) => `${m}:${JSON.stringify(p)}`)); o?.sent?.();
    const m = c[0][0];
    return [m === "conversations.list" ? listing : m === "conversations.getBusy" ? { busy: false } : { accepted: true, kernelSessionId: "conv-aaa", turnId: "turn-1" }];
  }) as never;
  const r = await wakeKimiDesktop({ session_id: "conv-aaa", pid: 1 }, "[mbx] hint", { desktop, rpc });
  assert.equal(r.ok, true);
  assert.equal(r.outcome?.kind, "admitted");
  assert.deepEqual(calls.slice(1), ['conversations.getBusy:{"conversationKey":"agent:main:main:conversation:c1"}',
    'conversations.send:{"conversationKey":"agent:main:main:conversation:c1","text":"[mbx] hint"}']);
});

test("wakeKimiDesktop outcomes: busy, conversation busy error, no conversation, lost response, bad receipt", async () => {
  const make = (send: () => unknown, busy = false) => (async (_d: KimiDesktop, c: [string, Record<string, unknown>][], o?: { sent?: () => void }) => {
    const m = c[0][0];
    if (m === "conversations.list") return [listing];
    if (m === "conversations.getBusy") return [{ busy }];
    o?.sent?.(); return [send()];
  }) as never;
  const s = { session_id: "conv-aaa", pid: 1 };
  assert.equal((await wakeKimiDesktop(s, "x", { desktop, rpc: make(() => ({}), true) })).outcome?.kind, "busy");
  assert.equal((await wakeKimiDesktop(s, "x", { desktop, rpc: make(() => { throw new RpcError("busy", -32010); }) })).outcome?.kind, "busy");
  assert.equal((await wakeKimiDesktop({ ...s, session_id: "conv-zzz" }, "x", { desktop, rpc: make(() => ({})) })).outcome?.kind, "not_submitted");
  assert.equal((await wakeKimiDesktop(s, "x", { desktop, rpc: make(() => { throw new Error("kimi desktop control timed out"); }) })).outcome?.kind, "unknown");
  assert.equal((await wakeKimiDesktop(s, "x", { desktop, rpc: make(() => ({ accepted: true, kernelSessionId: "other", turnId: "t" })) })).outcome?.kind, "unknown");
  assert.equal((await wakeKimiDesktop(s, "x", { desktop, rpc: make(() => { throw new RpcError("bad params", -32602); }) })).outcome?.kind, "failed");
  assert.equal((await wakeKimiDesktop(s, "x", { desktop: null })).outcome?.kind, "not_submitted");
});

test("doctor flags a kimi web server that started before its AgentMBX hooks were written", async t => {
  const { kimiServerHooks } = await import("../src/doctor.ts");
  const kimi = mkdtempSync(join(tmpdir(), "mbx-kimi-home-"));
  t.after(() => rmSync(kimi, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  mkdirSync(join(kimi, "server/instances"), { recursive: true });
  writeFileSync(join(kimi, "server.token"), "tok");
  writeFileSync(join(kimi, "config.toml"), '[[hooks]]\nevent = "UserPromptSubmit"\ncommand = "agentmbx hook prompt --cli kimi"\n');
  writeFileSync(join(kimi, "server/instances/old.json"), JSON.stringify({ pid: process.pid, port: 5, host: "127.0.0.1", started_at: Date.now() - 86_400_000 }));
  const [c] = kimiServerHooks("/nowhere", kimi);
  assert.equal(c?.level, "warn");
  assert.match(c.label, new RegExp(`kimi web server pid ${process.pid} .*get no mbx hooks`));
  writeFileSync(join(kimi, "server/instances/old.json"), JSON.stringify({ pid: process.pid, port: 5, host: "127.0.0.1", started_at: Date.now() + 60_000 }));
  assert.deepEqual(kimiServerHooks("/nowhere", kimi), [], "a server started after setup is fine");
});
