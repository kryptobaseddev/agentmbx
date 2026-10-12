// T188: the bounded resume notice on Kimi's supported entry (spec t184-provider-resume-adapters R5-R9).
// Kimi drops SessionStart output (binding-only), so each entry — a new conversation, --continue/--session//resume,
// a /clear rotation, a hosted bind-ticket link — delivers the notice on its first bound UserPromptSubmit. Terminal
// and hosted shapes are both covered; states that cannot speak (unbound, stale) defer to the first bound turn.
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { MbxNode } from "../src/node.ts";
import { RESUME_NOTICE_MAX_CHARS, RESUME_NOTICE_MAX_LINES } from "../src/resume-notice.ts";
import { sendLeased } from "./helpers/leased-send.ts";

const bin = join(import.meta.dirname, "../bin/agentmbx.js");
const AGENT = "t188-staff";

/** A terminal-Kimi holder: MCP server for this test process, one identity, and the provider's own hook. */
async function kimiHolder(t: TestContext) {
  const home = mkdtempSync(join(tmpdir(), "mbx-t188-")), project = mkdtempSync(join(tmpdir(), "mbx-t188-work-"));
  const cwd = realpathSync(project);
  const n = new MbxNode(home, { host: "alpha" });
  const c = new Client({ name: "kimi", version: "test" });
  t.after(async () => { await c.close(); n.close(); rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); rmSync(project, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
  const env = { ...process.env, AGENTMBX_DEV: "1", MBX_HOME: home, MBX_CLI: "kimi", MBX_AGENT: "", MBX_NO_DESKTOP: "1" } as Record<string, string>;
  await c.connect(new StdioClientTransport({ command: process.execPath, args: [bin, "mcp"], env, cwd: project }));
  assert.notEqual((await c.callTool({ name: "mbx_identity", arguments: { action: "register", name: AGENT, role: "builder" } })).isError, true);
  const hook = (event: string, sid: string, extra: Record<string, unknown> = {}) =>
    spawnSync(process.execPath, [resolve(bin), "hook", event, "--cli", "kimi"],
      { input: JSON.stringify({ session_id: sid, cwd, ...extra }), encoding: "utf8", env });
  const youAre = (s: string) => (s.match(new RegExp(`\\[mbx\\] You are ${AGENT}@alpha`, "g")) ?? []).length;
  return { n, c, hook, youAre, cwd, env };
}

/** Snapshot what R4 says must not move: deliveries, the catch-up checkpoint and the leases. Entries (resume-entry:*) may. */
const still = (n: MbxNode) => JSON.stringify([
  n.store.db.prepare("SELECT msg_id,agent,state FROM deliveries ORDER BY msg_id").all(),
  n.store.get(`catchup:${AGENT}`),
  n.store.db.prepare("SELECT name,cli,session_id,released_at FROM identity_leases ORDER BY name").all()]);

test("kimi (T188): a fresh conversation's first bound prompt carries the bounded resume notice once; counts only, nothing moves", async t => {
  const { n, c, hook, youAre } = await kimiHolder(t);
  sendLeased(n, { from: "boss", to: [AGENT], subject: "PRIVATE SUBJECT", body: "SECRET BODY", kind: "request" });
  hook("session-start", "fresh-A");
  const before = still(n);
  const p1 = hook("prompt", "fresh-A");
  assert.equal(p1.status, 0, p1.stderr);
  assert.equal(youAre(p1.stdout), 1, "the notice rides the first bound prompt");
  assert.match(p1.stdout, /\[mbx\] 1 unread for t188-staff@alpha: mbx_inbox\./, "the unread line keeps its place");
  assert.match(p1.stdout, /\(role: builder\)\. When the owner ends this session/, "identity and role");
  assert.match(p1.stdout, /not caught up on; call mbx_catchup/, "the catch-up hint, verbatim");
  assert.match(p1.stdout, /\[mbx\] 1 open thread\(s\) with unacked mail\./);
  assert.doesNotMatch(p1.stdout, /PRIVATE SUBJECT|SECRET BODY/, "counts only, never mail content");
  const notice = p1.stdout.split("\n").filter(l => /You are t188-staff|not caught up on|open thread/.test(l)).join("\n");
  assert.ok(notice.length <= RESUME_NOTICE_MAX_CHARS && notice.split("\n").length <= RESUME_NOTICE_MAX_LINES, notice);
  const p2 = hook("prompt", "fresh-A");
  assert.equal(youAre(p2.stdout), 0, "said once per entry, not every prompt");
  assert.equal(still(n), before, "no delivery state, checkpoint or lease moved");
  const who = JSON.stringify(await c.callTool({ name: "mbx_whoami", arguments: {} }));
  assert.match(who, /not caught up on; call mbx_catchup/, "the MCP fallback still carries the hint");
});

test("kimi (T188): each entry — fresh, and a resumed process on the same id — gets exactly one notice", async t => {
  const { n, hook, youAre } = await kimiHolder(t);
  hook("session-start", "conv-A");
  assert.equal(youAre(hook("prompt", "conv-A").stdout), 1, "fresh conversation");
  assert.equal(youAre(hook("prompt", "conv-A").stdout), 0, "not every prompt");
  const pid = (n.store.db.prepare("SELECT pid FROM sessions WHERE cli='kimi' AND session_id='conv-A'").get() as { pid: number }).pid;
  assert.match(n.store.get(`resume-entry:kimi:${pid}`)!, /^.+ conv-A$/, "the entry records this process's start time with the id");
  // `kimi --continue` is a new process: a new pid keys a fresh entry; a recycled pid is told apart by its start time.
  // The recycled-pid shape is what a fixture can simulate: same key, other start, same id.
  n.store.set(`resume-entry:kimi:${pid}`, "an-earlier-process-start conv-A");
  assert.equal(youAre(hook("prompt", "conv-A").stdout), 1, "a resumed process (other start time) on the same id");
  assert.equal(youAre(hook("prompt", "conv-A").stdout), 0);
});

test("kimi (T188): a wake prompt is itself the notice: the unread line is suppressed, the entry notice still rides once", async t => {
  const { n, hook, youAre } = await kimiHolder(t);
  sendLeased(n, { from: "boss", to: [AGENT], subject: "w", body: "b", kind: "request" });
  hook("session-start", "wake-A");
  const wake = hook("prompt", "wake-A", { prompt: "[mbx] 1 new message(s) for t188-staff from boss@alpha [local] (ids 01X). mbx_inbox or mbx_read." });
  assert.equal(wake.status, 0, wake.stderr);
  assert.doesNotMatch(wake.stdout, /\[mbx\] 1 unread for/, "the wake text is the unread notice");
  assert.equal(youAre(wake.stdout), 1, "but the entry's resume notice still rides the first turn");
  assert.equal(youAre(hook("prompt", "wake-A", { prompt: "[mbx] 1 new message(s) for t188-staff from boss@alpha [local] (ids 01X). mbx_inbox or mbx_read." }).stdout), 0,
    "a second wake in the same entry adds nothing");
});

test("kimi (T188): an unbound turn gets no notice and starts no entry; the first bound turn after the claim carries it", async t => {
  const { n, c, hook, youAre, cwd, env } = await kimiHolder(t);
  await c.callTool({ name: "mbx_identity", arguments: { action: "release" } });
  const start = hook("session-start", "later-A");
  assert.equal(start.status, 0, start.stderr);
  assert.match(start.stdout, /no mailbox identity yet|claim or register/, "the unbound guidance goes out at session-start");
  const unbound = hook("prompt", "later-A");
  assert.equal(unbound.status, 0, unbound.stderr);
  assert.equal(unbound.stdout, "", "once guided, an unbound prompt stays quiet");
  assert.equal(youAre(unbound.stdout), 0, "no identity, no notice");
  assert.equal(n.store.db.prepare("SELECT COUNT(*) n FROM kv WHERE k LIKE 'resume-entry:%'").get()!.n, 0, "no entry is recorded");
  assert.notEqual((await c.callTool({ name: "mbx_identity", arguments: { action: "claim", name: AGENT } })).isError, true);
  assert.equal(youAre(hook("prompt", "later-A").stdout), 1, "deferred to the first bound turn");
  assert.equal(youAre(hook("prompt", "later-A").stdout), 0);
  // a hosted conversation of the same parent that never binds consumes no entry either
  const daimon = mkdtempSync(join(tmpdir(), "mbx-t188-dm-"));
  mkdirSync(join(daimon, "agents/main"), { recursive: true });
  writeFileSync(join(daimon, "agents/main/runner.state.json"), JSON.stringify({ control: { endpoint: { url: "ws://127.0.0.1:9/control", pid: process.pid, auth: { token: "x" } } } }));
  const env2 = { ...env, MBX_KIMI_DESKTOP_DAIMON: daimon };
  t.after(() => rmSync(daimon, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  const stray = spawnSync(process.execPath, [resolve(bin), "hook", "prompt", "--cli", "kimi"],
    { input: JSON.stringify({ session_id: "conv-stray", cwd }), encoding: "utf8", env: env2 });
  assert.equal(stray.status, 0, stray.stderr);
  assert.match(stray.stdout, /bind=/, "an unlinked hosted conversation gets its ticket, not a notice");
  assert.equal(youAre(stray.stdout), 0);
  const entries = () => (n.store.db.prepare("SELECT COUNT(*) n FROM kv WHERE k LIKE 'resume-entry:%'").get() as { n: number }).n;
  assert.equal(entries(), 1, "the delivered notice recorded exactly the conv-A entry");
  assert.equal(entries(), 1, "and the stray conversation starts no entry");
});

/** A fake desktop daimon whose control endpoint names this test process (the parent of every child). */
function fakeDaimon() {
  const dir = mkdtempSync(join(tmpdir(), "mbx-t188-daimon-"));
  mkdirSync(join(dir, "agents/main"), { recursive: true });
  writeFileSync(join(dir, "agents/main/runner.state.json"), JSON.stringify({ control: { endpoint: { url: "ws://127.0.0.1:9/control", pid: process.pid, auth: { token: "fixture" } } } }));
  return dir;
}

test("kimi (T188, hosted): the notice defers to the ticket bind, delivers once, and a new daimon generation re-delivers", async t => {
  const home = mkdtempSync(join(tmpdir(), "mbx-t188-hosted-")), daimon = fakeDaimon();
  const work = mkdtempSync(join(tmpdir(), "mbx-t188-hosted-work-")), project = join(work, "orbit"), plugin = join(work, "agentmbx");
  mkdirSync(project); mkdirSync(plugin);
  const n = new MbxNode(home, { host: "alpha" });
  const env = { ...process.env, AGENTMBX_DEV: "1", MBX_HOME: home, MBX_CLI: "kimi", MBX_AGENT: "", MBX_NO_DESKTOP: "1", MBX_KIMI_DESKTOP_DAIMON: daimon } as Record<string, string>;
  const a = new Client({ name: "conv-a", version: "1" }), b = new Client({ name: "conv-a-again", version: "1" });
  t.after(async () => { for (const x of [a, b]) await x.close(); n.close(); for (const d of [home, daimon, work]) rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
  const connect = (x: Client) => x.connect(new StdioClientTransport({ command: process.execPath, args: [resolve(bin), "mcp"], env, cwd: plugin }));
  await connect(a);
  const hook = (event: string, sid: string) => spawnSync(process.execPath, [resolve(bin), "hook", event, "--cli", "kimi"],
    { input: JSON.stringify({ session_id: sid, cwd: realpathSync(project) }), encoding: "utf8", env });
  const ticketOf = (out: string) => /bind="([a-f0-9]{32})"/.exec(out)?.[1];
  const youAre = (s: string) => (s.match(/\[mbx\] You are t188-hosted@alpha/g) ?? []).length;

  // before the ticket binds: the ticket, not a notice; no entry is consumed
  const pre = hook("prompt", "conv-aaa");
  assert.equal(pre.status, 0, pre.stderr);
  assert.ok(ticketOf(pre.stdout), "an unlinked conversation is ticketed");
  assert.equal(youAre(pre.stdout), 0, "no binding, no notice");
  assert.equal(n.store.db.prepare("SELECT COUNT(*) n FROM kv WHERE k LIKE 'resume-entry:%'").get()!.n, 0, "no entry before the bind");

  // link, register, first bound prompt delivers once
  const nonce = ticketOf(pre.stdout)!;
  const linked = (await a.callTool({ name: "mbx_whoami", arguments: { bind: nonce } })).structuredContent as { agent: string | null };
  assert.equal(linked.agent, null);
  assert.notEqual((await a.callTool({ name: "mbx_identity", arguments: { action: "register", name: "t188-hosted", role: "builder" } })).isError, true);
  sendLeased(n, { from: "boss", to: ["t188-hosted"], subject: "h", body: "b", kind: "request" });
  assert.equal(youAre(hook("prompt", "conv-aaa").stdout), 1, "the first bound prompt after the link carries it");
  assert.equal(youAre(hook("prompt", "conv-aaa").stdout), 0, "once per entry");

  // daimon restart: re-link under the same generation is silent (no re-entry)...
  await a.close();
  await connect(b);
  const again = hook("prompt", "conv-aaa");
  assert.ok(ticketOf(again.stdout), "a conversation whose server ended is ticketed again");
  assert.equal(((await b.callTool({ name: "mbx_whoami", arguments: { bind: ticketOf(again.stdout)! } })).structuredContent as { agent: string }).agent, "t188-hosted");
  assert.equal(youAre(hook("prompt", "conv-aaa").stdout), 0, "the same daimon generation re-linking is not an entry");

  // ...a new daimon generation (different start time) on the same conversation is: re-delivers once
  const pid = process.pid;
  n.store.set(`resume-entry:kimi:${pid}`, "an-earlier-daimon-start conv-aaa");
  assert.equal(youAre(hook("prompt", "conv-aaa").stdout), 1, "a new daimon generation re-delivers");
  assert.equal(youAre(hook("prompt", "conv-aaa").stdout), 0);

  // a second conversation of the same daimon: its own ticket, identity and notice…
  const c2 = new Client({ name: "conv-b", version: "1" });
  t.after(() => c2.close());
  await connect(c2);
  const bPre = hook("prompt", "conv-bbb");
  assert.ok(ticketOf(bPre.stdout), "its own ticket");
  assert.equal(youAre(bPre.stdout), 0);
  assert.equal(((await c2.callTool({ name: "mbx_whoami", arguments: { bind: ticketOf(bPre.stdout)! } })).structuredContent as { agent: string | null }).agent, null);
  assert.notEqual((await c2.callTool({ name: "mbx_identity", arguments: { action: "register", name: "t188-hosted-b", role: "builder" } })).isError, true);
  assert.equal((hook("prompt", "conv-bbb").stdout.match(/\[mbx\] You are t188-hosted-b@alpha/g) ?? []).length, 1, "conv-bbb's first bound prompt carries its own notice");
  assert.equal(youAre(hook("prompt", "conv-bbb").stdout), 0);
  // …and switching back to conv-aaa is an entry again (spec-faithful, unclamped)
  assert.equal(youAre(hook("prompt", "conv-aaa").stdout), 1, "switching back to an earlier conversation re-arms its notice");
});
