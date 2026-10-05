// T204 (v0.5.2 R1/R4): a mailbox name exists only because someone chose it. A session resumes the identity its own
// provider session held before, or stays unbound until it claims one from its project's list or registers one; nothing
// ever invents a name. Reproduces the 2026-10-01 reboot: many sessions of one folder resuming at the same instant.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { MbxNode } from "../src/node.ts";
import { registerIdentity } from "../src/registry.ts";
import { identityAvailability, SHARED_IDLE_MS } from "../src/identity-availability.ts";
import type { IdentityLease } from "../src/identity-leases.ts";

const BIN = resolve("bin/agentmbx.js");
/** A stand-in provider process: writes its Claude session file (HOME/.claude/sessions/<pid>.json), then runs the mbx server. */
const PROVIDER = `const { spawn } = require("node:child_process"); const fs = require("node:fs"); const path = require("node:path");
const dir = path.join(process.env.HOME, ".claude/sessions"); fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(path.join(dir, process.pid + ".json"), JSON.stringify({ sessionId: process.env.TEST_SESSION_ID }));
const c = spawn(process.execPath, [process.env.TEST_BIN, "mcp"], { stdio: "inherit", env: process.env });
c.on("exit", (code) => process.exit(code ?? 0)); process.on("SIGTERM", () => c.kill("SIGTERM"));`;

function fixture(t: { after: (fn: () => unknown) => void }) {
  const home = mkdtempSync(join(tmpdir(), "mbx-chosen-")), user = mkdtempSync(join(tmpdir(), "mbx-chosen-home-"));
  const project = join(mkdtempSync(join(tmpdir(), "mbx-chosen-work-")), "orbit");
  mkdirSync(project);
  const node = new MbxNode(home, { host: "alpha" });
  const clients: Client[] = [];
  t.after(async () => { for (const c of clients) await c.close().catch(() => {}); node.close(); for (const d of [home, user]) rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
  const connect = async (session: string, extra: Record<string, string> = {}) => {
    const c = new Client({ name: session, version: "test" });
    await c.connect(new StdioClientTransport({ command: process.execPath, args: ["-e", PROVIDER], cwd: project,
      env: { ...process.env, AGENTMBX_DEV: "1", MBX_HOME: home, HOME: user, MBX_CLI: "claude", MBX_AGENT: "", MBX_NO_DESKTOP: "1",
        CLAUDE_CODE_MESSAGING_SOCKET: "", TEST_SESSION_ID: session, TEST_BIN: BIN, ...extra } as Record<string, string> }));
    clients.push(c);
    return c;
  };
  return { home, node, project: realpathSync(project), connect };
}
const json = (r: unknown) => (r as { structuredContent?: Record<string, unknown> }).structuredContent ?? JSON.parse((r as { content: { text: string }[] }).content[0].text);
const textOf = (r: unknown) => (r as { content: { text: string }[] }).content.map(c => c.text).join("\n");

test("a fresh session is unbound until it registers a chosen name and role; mailbox tools say exactly what to do", async (t) => {
  const { node, project, connect } = fixture(t);
  const c = await connect("sess-a");
  const who = json(await c.callTool({ name: "mbx_whoami", arguments: {} }));
  assert.equal(who.agent, null);
  assert.equal(who.unbound, true);
  assert.equal(node.store.db.prepare("SELECT COUNT(*) n FROM identity_leases").get()!.n, 0, "no name was invented");
  const inbox = await c.callTool({ name: "mbx_inbox", arguments: {} });
  assert.equal(inbox.isError, true);
  assert.match(textOf(inbox), /no mbx identity yet.*mbx_identity \{"action":"list"\}/s);

  const noRole = await c.callTool({ name: "mbx_identity", arguments: { action: "register", name: "orbit-lead" } });
  assert.equal(noRole.isError, true);
  assert.match(textOf(noRole), /role/);
  const unreadable = await c.callTool({ name: "mbx_identity", arguments: { action: "register", name: "orbit-mcp-0123456789abcdef", role: "lead" } });
  assert.equal(unreadable.isError, true, "an auto-generated-looking name is refused");

  const reg = await c.callTool({ name: "mbx_identity", arguments: { action: "register", name: "orbit-lead", role: "lead", description: "runs the orbit project" } });
  assert.notEqual(reg.isError, true, textOf(reg));
  const me = json(await c.callTool({ name: "mbx_whoami", arguments: {} }));
  assert.deepEqual([me.agent, me.role, me.registered, me.project], ["orbit-lead", "lead", true, project]);
  assert.deepEqual({ ...node.store.db.prepare("SELECT name,role,description FROM identities").get() }, { name: "orbit-lead", role: "lead", description: "runs the orbit project" });
  assert.equal(node.store.db.prepare("SELECT project FROM identity_projects WHERE name='orbit-lead'").get()!.project, project);
  assert.notEqual((await c.callTool({ name: "mbx_inbox", arguments: {} })).isError, true, "mailbox tools work once bound");
});

test("a resumed session gets its own identity back; another session in the folder never takes it", async (t) => {
  const { node, connect } = fixture(t);
  const a = await connect("sess-a");
  await a.callTool({ name: "mbx_identity", arguments: { action: "register", name: "orbit-lead", role: "lead" } });
  const b = await connect("sess-b");
  assert.equal(json(await b.callTool({ name: "mbx_whoami", arguments: {} })).agent, null, "a second session stays unbound");
  const listed = json(await b.callTool({ name: "mbx_identity", arguments: { action: "list" } })) as { identities: { name: string; role: string; state: string; claimable: boolean; reason: string }[] };
  const lead = listed.identities.find(i => i.name === "orbit-lead")!;
  assert.deepEqual([lead.role, lead.state, lead.claimable], ["lead", "held", false]);
  const steal = await b.callTool({ name: "mbx_identity", arguments: { action: "claim", name: "orbit-lead" } });
  assert.equal(steal.isError, true);
  assert.match(textOf(steal), /held by live claude session sess-a/, "the claim refuses for the reason the list showed");

  await a.close();
  const a2 = await connect("sess-a");
  assert.equal(json(await a2.callTool({ name: "mbx_whoami", arguments: {} })).agent, "orbit-lead", "the resumed session is orbit-lead again");
  assert.equal(node.store.get("name:claude:sess-b"), undefined, "the unbound session remembers nothing");
});

test("reboot: 20 sessions of one folder start at once; remembered ones resume theirs, the rest stay unbound, nobody squats", async (t) => {
  const { node, connect } = fixture(t);
  // Before the reboot five sessions held chosen names; their holders are gone (dead pids).
  for (let i = 0; i < 5; i++) {
    registerIdentity(node.store, { name: `orbit-agent-${i}`, role: `role-${i}` });
    node.keepName("claude", `sess-${i}`, `orbit-agent-${i}`);
    node.store.db.prepare(`INSERT INTO identity_leases (name,token,holder_pid,holder_start,key_fp,cli,session_id,claimed_at,heartbeat_at,idle_ttl,released_at,release_reason)
      VALUES (?,?,?,?,?,?,?,?,?,?,NULL,NULL)`).run(`orbit-agent-${i}`, `old-${i}`, 2 ** 22 + 100 + i, "ps-utc:Thu Jan 1 00:00:00 2026", "0000-0000-0000-0000", "claude", `sess-${i}`, Date.now(), Date.now(), 1_800_000);
  }
  // The idle sessions start first, as in the incident, then everyone else in the same instant.
  const clients = await Promise.all(Array.from({ length: 20 }, (_, i) => connect(`sess-${(i + 5) % 20}`)));
  const names = await Promise.all(clients.map(async c => json(await c.callTool({ name: "mbx_whoami", arguments: {} })).agent));
  const bySession = new Map(clients.map((_, i) => [`sess-${(i + 5) % 20}`, names[i]]));
  for (let i = 0; i < 5; i++) assert.equal(bySession.get(`sess-${i}`), `orbit-agent-${i}`, `sess-${i} resumed its own identity`);
  for (let i = 5; i < 20; i++) assert.equal(bySession.get(`sess-${i}`), null, `sess-${i} stayed unbound`);
  const held = node.store.db.prepare("SELECT name FROM identity_leases WHERE released_at IS NULL ORDER BY name").all().map(r => r.name);
  assert.deepEqual(held, [0, 1, 2, 3, 4].map(i => `orbit-agent-${i}`), "no other identity exists");
});

test("a remembered identity held by another live session leaves this one unbound and pending; it resumes when the holder ends", async (t) => {
  const { node, connect } = fixture(t);
  const a = await connect("sess-a");
  await a.callTool({ name: "mbx_identity", arguments: { action: "register", name: "orbit-lead", role: "lead" } });
  node.keepName("claude", "sess-b", "orbit-lead"); // e.g. an older conversation of the same agent
  const b = await connect("sess-b");
  const who = json(await b.callTool({ name: "mbx_whoami", arguments: {} }));
  assert.deepEqual([who.agent, who.pending], [null, "orbit-lead"]);
  assert.equal(node.store.get("name:claude:sess-b"), "orbit-lead", "a failed resume never overwrites the remembered name");
  assert.equal(node.store.db.prepare("SELECT COUNT(*) n FROM identity_leases").get()!.n, 1, "and never mints a substitute");
  await a.close();
  assert.equal(json(await b.callTool({ name: "mbx_whoami", arguments: {} })).agent, "orbit-lead", "the pending identity resumes once its holder ended");
});

test("list and claim agree: a quiet conversation of a shared process can be claimed; the old conversation learns it lost the lease", async (t) => {
  const { node, connect } = fixture(t);
  const c = await connect("transport", { MBX_CLI: "opencode" });
  const call = (sid: string, name: string, args: Record<string, unknown> = {}) => c.callTool({ name, arguments: args, _meta: { sessionID: sid } } as never);
  assert.notEqual((await call("ses_A", "mbx_identity", { action: "register", name: "orbit-dev", role: "dev" })).isError, true);
  const list = async () => (json(await call("ses_B", "mbx_identity", { action: "list" })) as { identities: { name: string; state: string; claimable: boolean }[] }).identities.find(i => i.name === "orbit-dev")!;
  assert.deepEqual(await list().then(i => [i.state, i.claimable]), ["held", false]);
  assert.equal((await call("ses_B", "mbx_identity", { action: "claim", name: "orbit-dev" })).isError, true);
  node.store.set("lease-activity:orbit-dev", JSON.stringify({ at: Date.now() - SHARED_IDLE_MS - 1000, shared: true }));
  assert.deepEqual(await list().then(i => [i.state, i.claimable]), ["idle", true], "the list says claimable");
  const took = await call("ses_B", "mbx_identity", { action: "claim", name: "orbit-dev" });
  assert.notEqual(took.isError, true, textOf(took));
  const old = await call("ses_A", "mbx_inbox");
  assert.equal(old.isError, true);
  assert.match(textOf(old), /lost its identity lease for orbit-dev: opencode session ses_B claimed it/);
  assert.ok(node.store.db.prepare("SELECT 1 FROM audit WHERE event='identity.takeover' AND detail LIKE '%idle-conversation%'").get());
});

test("terminal Kimi resumes the identity its session held, from the session id its own hook reported", async (t) => {
  const { node, connect } = fixture(t);
  const { inspectLeaseProcess } = await import("../src/identity-leases.ts");
  const { recordSessionHint } = await import("../src/registry.ts");
  registerIdentity(node.store, { name: "orbit-kimi", role: "builder" });
  node.keepName("kimi", "kimi-session-7", "orbit-kimi");
  const c = await connect("unused", { MBX_CLI: "kimi" });
  assert.equal(json(await c.callTool({ name: "mbx_whoami", arguments: {} })).agent, null, "a provisional id alone resumes nothing");
  const server = node.store.db.prepare("SELECT v FROM kv WHERE k LIKE 'connector:%'").all().map(r => JSON.parse(r.v as string)).find(x => x.cli === "kimi");
  const provider = Number(/^\s*(\d+)/.exec((await import("node:child_process")).execFileSync("ps", ["-o", "ppid=", "-p", String(server.pid)], { encoding: "utf8" }))![1]);
  recordSessionHint(node.store, "kimi", provider, inspectLeaseProcess(provider).start, "kimi-session-7");
  assert.equal(json(await c.callTool({ name: "mbx_whoami", arguments: {} })).agent, "orbit-kimi");
});

test("identityAvailability: one answer for list and claim", () => {
  const now = Date.now();
  const lease = { name: "x", token: "t", holder_pid: 10, holder_start: "s", key_fp: "k", cli: "codex", session_id: "thread-1",
    claimed_at: now, heartbeat_at: now, idle_ttl: 1_800_000, released_at: null, release_reason: null } as IdentityLease;
  const live = { alive: true, start: "s" } as const;
  assert.equal(identityAvailability({ evidence: live, activity: null, now }).state, "free");
  assert.equal(identityAvailability({ lease: { ...lease, released_at: now, release_reason: "released" }, evidence: live, activity: null, now }).claimable, true);
  assert.equal(identityAvailability({ lease, evidence: { alive: false, start: null }, activity: null, now }).state, "offline");
  assert.deepEqual(Object.values(identityAvailability({ lease, evidence: { alive: null, start: null }, activity: null, now })).slice(0, 2), [false, "unknown"]);
  assert.equal(identityAvailability({ lease, evidence: live, activity: { at: now, shared: true }, now }).claimable, false);
  assert.equal(identityAvailability({ lease, evidence: live, activity: { at: now - SHARED_IDLE_MS, shared: true }, now }).takeover, "idle-conversation");
  assert.equal(identityAvailability({ lease, evidence: live, activity: { at: now - SHARED_IDLE_MS, shared: false }, now }).claimable, false, "a dedicated session is never idle-claimed");
  // T383: only a holder under a different (restarted) provider process is "older"; a live one under the caller's own provider keeps it.
  assert.equal(identityAvailability({ lease, evidence: live, activity: null, now, caller: { cli: "codex", sessionId: "thread-1", providerPid: 10, holderProviderPid: 20 } }).takeover, "same-session");
  assert.equal(identityAvailability({ lease, evidence: live, activity: null, now, caller: { cli: "codex", sessionId: "thread-1", providerPid: 10, holderProviderPid: 10 } }).claimable, false);
  assert.equal(identityAvailability({ lease, evidence: live, activity: null, now, conflict: true }).state, "conflict");
});

test("a server ended with SIGTERM releases its identity instead of leaving a dead holder", async (t) => {
  const { node, connect } = fixture(t);
  const c = await connect("sess-term", { MBX_AGENT: "orbit-term", MBX_ROLE: "tester" });
  assert.equal(json(await c.callTool({ name: "mbx_whoami", arguments: {} })).agent, "orbit-term");
  const pid = (node.store.db.prepare("SELECT holder_pid FROM identity_leases WHERE name='orbit-term'").get() as { holder_pid: number }).holder_pid;
  process.kill(pid, "SIGTERM");
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline && !(node.store.db.prepare("SELECT released_at FROM identity_leases WHERE name='orbit-term'").get() as { released_at: number | null }).released_at)
    await new Promise(r => setTimeout(r, 50));
  assert.equal((node.store.db.prepare("SELECT release_reason FROM identity_leases WHERE name='orbit-term'").get() as { release_reason: string }).release_reason, "released");
});
