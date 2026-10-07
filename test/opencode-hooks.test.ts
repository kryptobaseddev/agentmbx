// T391: OpenCode setup installs the hooks PLUGIN (OpenCode has no settings-file hooks) that maps
// session.created/tool.execute.after/session.idle onto the shared `agentmbx hook --cli opencode`
// contract; install is byte-exact, uninstall removes only ours, a local edit turns the file
// foreign and is never overwritten (T347 bar); doctor's opencode-service check runs only when an
// opencode mailbox is bound and says how to start the service when it is down. The generated
// plugin captures hook stdout and injects block reasons and [mbx] notes back into the session
// through the plugin client (B1b/B2), embeds the agentmbx argv as an array (B3), and `hook stop
// --cli opencode` emits a block once then stays silent on the second Stop (stopseen bound).
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { MbxNode } from "../src/node.ts";
import { opencodePluginPath, opencodePluginSource, runSetup, type SetupCtx } from "../src/setup.ts";
import { opencodeServiceCheck } from "../src/doctor.ts";
import { version } from "../src/version.ts";
import { sendLeased } from "./helpers/leased-send.ts";
import { bindWakeLease } from "./helpers/wake-lease.ts";

const CMD = ["/opt/bin/agentmbx"];
const ctxFor = (home: string, cmd = CMD): SetupCtx => ({ home, cmd, which: () => null, useClis: false });
const pluginPath = (home: string) => opencodePluginPath(home);

function homeWithConfig(): string {
  const home = mkdtempSync(join(tmpdir(), "mbx-opencode-hooks-"));
  mkdirSync(join(home, ".config/opencode"), { recursive: true });
  writeFileSync(join(home, ".config/opencode/opencode.jsonc"), `{\n  "$schema": "https://opencode.ai/config.json"\n}\n`);
  return home;
}

const install = (home: string) => runSetup(ctxFor(home), { mode: "install", only: ["opencode"] });

test("T391 install writes the plugin byte-exact and idempotently (AC1)", () => {
  const home = homeWithConfig();
  try {
    const rows = install(home);
    const ours = rows.find((r) => r.item.includes("plugin"))!;
    const want = opencodePluginSource(CMD, version());
    assert.ok(existsSync(pluginPath(home)), "plugin file written");
    assert.equal(readFileSync(pluginPath(home), "utf8"), want, "byte-exact ours");
    assert.equal(ours.action, "added");
    const again = install(home);
    assert.equal(again.find((r) => r.item.includes("plugin"))!.action, "unchanged");
    assert.equal(readFileSync(pluginPath(home), "utf8"), want);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("T391 generated plugin maps OpenCode events, embeds argv as an array, injects reasons (AC1, B1-B3)", () => {
  const src = opencodePluginSource(CMD, version());
  assert.match(src, /^\/\/ agentmbx-plugin v1 \(T391\)/, "ours marker on line 1");
  assert.ok(src.includes("session.created") && src.includes('"session-start"'), "session.created -> session-start");
  assert.ok(src.includes("session.idle") && src.includes('"stop"'), "session.idle -> stop (Stop continuation)");
  assert.ok(src.includes('"tool.execute.after"') && src.includes('"post-tool"'), "tool.execute.after -> post-tool");
  assert.ok(src.includes(`runFor(${JSON.stringify(CMD)}, `), "agentmbx argv embedded as a JSON string[] (B3)");
  assert.ok(!src.includes(`runFor(${JSON.stringify(CMD.join(" "))}, `), "no single-string shJoin form (B3)");
  assert.ok(src.includes("delete env.AGENTMBX_DEV"), "AGENTMBX_DEV stripped from the child env (2026-10-06 poison immunity)");
  assert.ok(src.includes("ctx.event.subscribe"), "v2 setup consumes the context event stream (opencode-goal pattern)");
  assert.ok(src.includes('ctx?.tool?.hook?.("execute.after"'), "v2 setup registers the post-tool context hook");
  assert.ok(src.includes('"session.execution.succeeded"'), "v2 session.execution.succeeded maps to the stop contract");
  assert.ok(src.includes(".quiet()") === false, "no Bun-$ shell dependency left");
  assert.ok(src.includes("/api/session/") && src.includes("/synthetic"), "B1c: daemon's synthetic endpoint (wake.ts wakeOpencode)");
  assert.ok(src.includes('delivery: "queue"') && src.includes("resume: true"), "synthetic body matches the daemon's wake contract");
  assert.ok(src.includes('r.id.startsWith("msg_")') && src.includes('r.type === "synthetic"'), "admission receipt validated like wake.ts");
  assert.match(src, /export default \{\r?\n  id: "agentmbx-hooks",/, "OpenCode v2 default export object (err_2b28184e fix)");
  assert.ok(src.includes("server: AgentMBXHooks"), "v1 factory under server");
  assert.ok(src.includes("async setup(ctx:"), "v2 setup uses the context API, distinct from the v1 factory");
});

function shJoinedQuoted(): string { return JSON.stringify(CMD.join(" ")); }

test("T391 uninstall removes ours byte-exact, keeps foreign, upgrades ours-stale (AC1)", () => {
  const home = homeWithConfig();
  try {
    install(home);
    runSetup(ctxFor(home), { mode: "uninstall", only: ["opencode"] });
    assert.ok(!existsSync(pluginPath(home)), "ours removed");
    const foreign = "// my own plugin\nexport const Mine = async () => ({});\n";
    mkdirSync(join(home, ".config/opencode/plugins"), { recursive: true });
    writeFileSync(pluginPath(home), foreign);
    assert.equal(install(home).find((r) => r.item.includes("plugin"))!.action, "unchanged");
    assert.equal(readFileSync(pluginPath(home), "utf8"), foreign, "foreign not overwritten");
    runSetup(ctxFor(home), { mode: "uninstall", only: ["opencode"] });
    assert.equal(readFileSync(pluginPath(home), "utf8"), foreign, "foreign not deleted");
    const stale = opencodePluginSource(CMD, version()).replace('"stop"', '"session-end"');
    writeFileSync(pluginPath(home), stale);
    assert.equal(install(home).find((r) => r.item.includes("plugin"))!.action, "updated");
    assert.equal(readFileSync(pluginPath(home), "utf8"), opencodePluginSource(CMD, version()));
    runSetup(ctxFor(home), { mode: "uninstall", only: ["opencode"] });
    assert.ok(!existsSync(pluginPath(home)), "stale ours removed on uninstall");
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("T391 doctor service check: silent unbound, ok reachable, warn with fix down (AC3)", async () => {
  const home = mkdtempSync(join(tmpdir(), "mbx-opencode-svc-"));
  try {
    const node = new MbxNode(home, { host: "alpha" });
    const up = async () => ({ url: "http://127.0.0.1:49374", auth: "" });
    const down = async () => null;
    assert.equal(await opencodeServiceCheck(node, up), null);
    assert.equal(await opencodeServiceCheck(node, down), null);
    node.store.db.prepare("INSERT INTO sessions (agent, cli, session_id, channel, updated_at) VALUES (?, 'opencode', ?, 0, ?)")
      .run("agentmbx-opencode", "ses_test1", new Date().toISOString());
    const ok = await opencodeServiceCheck(node, up);
    assert.equal(ok?.level, "ok");
    assert.match(ok?.label ?? "", /service reachable/);
    const warn = await opencodeServiceCheck(node, down);
    assert.equal(warn?.level, "warn");
    assert.match(warn?.label ?? "", /cannot be woken/);
    assert.match(warn?.fix ?? "", /opencode/);
    node.close();
  } finally { rmSync(home, { recursive: true, force: true }); }
});

// ---- B4: evaluate the GENERATED plugin with a stubbed spawn and a stubbed OpenCode service ----

/** Importable copy of the generated plugin source under test (Node 24 strips the erasable types). */
async function loadPlugin() {
  const dir = mkdtempSync(join(tmpdir(), "mbx-opencode-plugin-eval-"));
  const file = join(dir, "agentmbx.ts");
  writeFileSync(file, opencodePluginSource(CMD, version()));
  try {
    const mod = await import(file);
    return { mod: mod as unknown as { AgentMBXHooks: (ctx: unknown) => Promise<Record<string, unknown>>; default: { id?: unknown; server?: unknown; setup?: (ctx: unknown) => unknown } }, dir };
  } catch (e) { rmSync(dir, { recursive: true, force: true }); throw e; }
}

interface Spawned { bin: string[]; args: string[]; input: Record<string, unknown> }

/** Install the __mbxSpawn seam the generated plugin reads: records calls, replays scripted
 *  stdout (default: the real CLI's captured output is passed per-test), can be told to fail. */
function stubSpawn(calls: Spawned[], script: (c: Spawned) => string) {
  (globalThis as { __mbxSpawn?: unknown }).__mbxSpawn = (bin: string[], args: string[], input: string, cb: (out: string) => void) => {
    const c = { bin, args, input: JSON.parse(input) as Record<string, unknown> };
    calls.push(c);
    cb(script(c));
  };
  return () => { delete (globalThis as { __mbxSpawn?: unknown }).__mbxSpawn; };
}

interface SyntheticPost { url: string; body: { text: string; delivery: string; resume: boolean }; auth: string }

/** Stub the plugin's injection transport (B1c): records synthetic POSTs and answers with the
 *  receipt shape wake.ts validates. Installs MBX_OPENCODE_URL so no service-status spawn happens. */
function stubSynthetic(posts: SyntheticPost[]) {
  const realFetch = globalThis.fetch;
  const realUrl = process.env.MBX_OPENCODE_URL;
  process.env.MBX_OPENCODE_URL = "http://127.0.0.1:9";
  globalThis.fetch = (async (url: unknown, init?: { body?: unknown; headers?: unknown }) => {
    const body = JSON.parse(String(init?.body)) as SyntheticPost["body"];
    posts.push({ url: String(url), body, auth: String((init?.headers as Record<string, string> | undefined)?.authorization ?? "") });
    const sid = /\/api\/session\/([^/]+)\/synthetic$/.exec(String(url))?.[1] ?? "";
    return new Response(JSON.stringify({ data: { id: "msg_stub0001", sessionID: decodeURIComponent(sid), type: "synthetic", delivery: "queue", payload: { text: body.text }, time: { created: Date.now() } } }), { status: 200 });
  }) as typeof fetch;
  return () => {
    if (realUrl === undefined) delete process.env.MBX_OPENCODE_URL; else process.env.MBX_OPENCODE_URL = realUrl;
    globalThis.fetch = realFetch;
  };
}

test("T391 default export satisfies OpenCode v2's plugin schema: id + setup (load-fix)", async () => {
  const { mod, dir } = await loadPlugin();
  try {
    const def = mod.default;
    assert.ok(def, "module has a default export");
    assert.equal(def.id, "agentmbx-hooks", "plugin id");
    assert.equal(typeof def.server, "function", "v1 factory under server");
    assert.equal(typeof def.setup, "function", "v2 setup present (distinct from the v1 factory)");
    assert.notEqual(def.setup, def.server, "v2 setup uses the context API, not the v1 factory");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("T391 v2 setup: ctx.event.subscribe drives session-start and stop; ctx.tool.hook drives post-tool", async () => {
  const { mod, dir } = await loadPlugin();
  const calls: Spawned[] = [], posts: SyntheticPost[] = [];
  const restoreSpawn = stubSpawn(calls, (c) => (c.args[1] === "stop" ? JSON.stringify({ decision: "block", reason: "[mbx] 1 new message(s) for worker." }) : "[mbx] You are worker@alpha.\\n[mbx] 1 unread mbx message(s): call mbx_inbox."));
  const restoreFetch = stubSynthetic(posts);
  let toolHook: ((input: unknown) => unknown) | null = null;
  try {
    const stop = await (mod.default.setup as (c: unknown) => Promise<() => unknown>)({
      location: { directory: "/work" },
      event: { subscribe: async function* () { for (const e of [
        { type: "session.created", location: { directory: "/work" }, data: { info: { id: "ses_v2a", directory: "/work" } } },
        { type: "session.execution.succeeded", location: { directory: "/work" }, data: { info: { id: "ses_v2a" } } },
        { type: "session.tool.called", location: { directory: "/elsewhere" }, data: { info: { id: "ses_v2a" } } }, // filtered by location
        { type: "session.usage.updated", location: { directory: "/work" }, data: { info: { id: "ses_v2a" } } }, // ignored type
      ]) yield e; } },
      tool: { hook: (_n: string, fn: (input: unknown) => unknown) => { toolHook = fn; } },
    });
    await new Promise((r) => setTimeout(r, 50));
    (toolHook as ((input: unknown) => unknown) | null)?.({ sessionID: "ses_v2a" });
    await new Promise((r) => setTimeout(r, 50));
    assert.deepEqual(calls.filter((c) => c.args[1] === "session-start").map((c) => c.input.session_id), ["ses_v2a"], "v1 session.created maps through the v2 stream");
    assert.deepEqual(calls.filter((c) => c.args[1] === "stop").map((c) => c.input.session_id), ["ses_v2a"], "v2 session.execution.succeeded maps to the stop contract");
    assert.equal(calls.filter((c) => c.args[1] === "post-tool").length, 1, "post-tool once: tool.hook wins, session.tool.called is the fallback only");
    assert.equal(calls.filter((c) => c.args[1] === "session-start" || c.args[1] === "stop" || c.args[1] === "post-tool").length, 3, "no other event type fires a hook");
    assert.equal(posts.length, 3, "session-start, stop and post-tool notes all inject (B2b)");
    assert.match(posts[0].body.text, /You are worker@alpha/);
    assert.match(posts[0].body.text, /1 unread/, "the whole [mbx] run in one message (B2b)");
    assert.match(posts.find((p) => /new message/.test(p.body.text))!.body.text, /new message\(s\)/, "stop block reason injected");
    assert.equal(posts[0].body.delivery, "queue");
    assert.equal(posts[0].body.resume, true);
    assert.ok(posts.every((p) => p.url.endsWith("/api/session/ses_v2a/synthetic")), "the daemon's cited endpoint (B1c)");
    const fin = stop;
    assert.equal(typeof fin, "function", "setup resolves to a cleanup that aborts the stream");
  } finally { restoreSpawn(); restoreFetch(); rmSync(dir, { recursive: true, force: true }); }
});

test("T466 OpenCode 2.0.24 turn end is session.execution.succeeded with data.sessionID and no location", async () => {
  const { mod, dir } = await loadPlugin();
  const calls: Spawned[] = [], posts: SyntheticPost[] = [];
  const restoreSpawn = stubSpawn(calls, () => JSON.stringify({ decision: "block", reason: "[mbx] 1 new message(s) for worker." }));
  const restoreFetch = stubSynthetic(posts);
  try {
    // Captured from ctx.event.subscribe on OpenCode 2.0.24. There is no location and no session.idle.
    await (mod.default.setup as (c: unknown) => Promise<unknown>)({
      location: { directory: "/work" },
      event: { subscribe: async function* () {
        yield {
          type: "session.execution.succeeded",
          data: { sessionID: "ses_t466frame" },
          durable: { aggregateID: "ses_t466frame", seq: 1, version: "1" },
        };
      } },
      tool: { hook: () => undefined },
    });
    await new Promise((r) => setTimeout(r, 50));
    const stops = calls.filter((c) => c.args[1] === "stop");
    assert.equal(stops.length, 1, "one stop for the one turn-end frame");
    assert.equal(stops[0]?.input.session_id, "ses_t466frame");
    assert.equal(calls.filter((c) => c.args[1] === "session-start" || c.args[1] === "post-tool").length, 0, "the turn-end frame is not a session-start or post-tool");
    assert.equal(posts.length, 1, "one synthetic continuation for that stop");
    assert.ok(posts[0]?.url.endsWith("/api/session/ses_t466frame/synthetic"));
  } finally { restoreSpawn(); restoreFetch(); rmSync(dir, { recursive: true, force: true }); }
});

test("T391 B4(a): v1 factory session.created runs session-start with the sid (generated plugin)", async () => {
  const { mod, dir } = await loadPlugin();
  const calls: Spawned[] = [], posts: SyntheticPost[] = [];
  const restoreSpawn = stubSpawn(calls, () => "[mbx] You are agentmbx-opencode@alpha.\\n[mbx] 2 unread mbx message(s): call mbx_inbox.");
  const restoreFetch = stubSynthetic(posts);
  try {
    const hooks = await mod.AgentMBXHooks({ directory: "/work" });
    const event = hooks.event as (e: unknown) => Promise<void>;
    await event({ event: { type: "session.created", properties: { info: { id: "ses_eval1", directory: "/work/proj" } } } });
    assert.equal(calls.length, 1, "one hook call");
    assert.deepEqual(calls[0].bin, CMD, "agentmbx argv passed as a literal array (B3)");
    assert.equal(calls[0].args[0], "hook");
    assert.equal(calls[0].args[1], "session-start");
    assert.equal(calls[0].args[2], "--cli");
    assert.equal(calls[0].args[3], "opencode");
    assert.equal(calls[0].input.session_id, "ses_eval1");
    assert.equal(calls[0].input.cwd, "/work");
    assert.equal(posts.length, 1, "the [mbx] note is injected (B2)");
    assert.ok(posts[0].url.endsWith("/api/session/ses_eval1/synthetic"), "injected into that session (B1c)");
    assert.match(posts[0].body.text, /You are agentmbx-opencode/, "first line of the run");
    assert.match(posts[0].body.text, /2 unread/, "the whole [mbx] run, not just its first line (B2b)");
    assert.equal(posts[0].body.delivery, "queue");
    assert.equal(posts[0].body.resume, true);
  } finally { restoreSpawn(); restoreFetch(); rmSync(dir, { recursive: true, force: true }); }
});

test("T391 B4(b): v1 factory session.idle with a block reason injects exactly one continuation", async () => {
  const { mod, dir } = await loadPlugin();
  const calls: Spawned[] = [], posts: SyntheticPost[] = [];
  let script = JSON.stringify({ decision: "block", reason: "[mbx] 1 new message(s) for agentmbx-opencode from lead arrived while you worked." });
  const restoreSpawn = stubSpawn(calls, () => script);
  const restoreFetch = stubSynthetic(posts);
  try {
    const hooks = await mod.AgentMBXHooks({ directory: "/work" });
    const event = hooks.event as (e: unknown) => Promise<void>;
    await event({ event: { type: "session.idle", properties: { info: { id: "ses_eval2" } } } });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].args[1], "stop");
    assert.equal(posts.length, 1, "exactly one injected continuation");
    assert.ok(posts[0].url.endsWith("/api/session/ses_eval2/synthetic"), "into that session");
    assert.match(posts[0].body.text, /new message\(s\)/);
    assert.equal(posts[0].body.resume, true, "resume:true continues the ended turn");
    // The second Stop is silent (the stopseen marker bounded the loop): nothing injects again.
    script = "";
    await event({ event: { type: "session.idle", properties: { info: { id: "ses_eval2" } } } });
    assert.equal(posts.length, 1, "no second injection on a silent Stop");
  } finally { restoreSpawn(); restoreFetch(); rmSync(dir, { recursive: true, force: true }); }
});

test("T391 B4(c): a failing hook never throws out of the plugin and injects nothing", async () => {
  const { mod, dir } = await loadPlugin();
  const calls: Spawned[] = [], posts: SyntheticPost[] = [];
  const restoreSpawn = stubSpawn(calls, () => { throw new Error("spawn died"); });
  const restoreFetch = stubSynthetic(posts);
  try {
    const hooks = await mod.AgentMBXHooks({ directory: "/work" });
    const event = hooks.event as (e: unknown) => Promise<void>;
    await assert.doesNotReject(() => event({ event: { type: "session.idle", properties: { info: { id: "ses_eval3" } } } }));
    assert.equal(posts.length, 0, "nothing injected when the hook fails");
  } finally { restoreSpawn(); restoreFetch(); rmSync(dir, { recursive: true, force: true }); }
});

// ---- B4: the CLI stop path for opencode -------------------------------------------------------

const SID = "opencode-hooks-sid";

function runHook(home: string, event: string, body: Record<string, unknown> = {}) {
  const env: NodeJS.ProcessEnv = { ...process.env, MBX_HOME: home, AGENTMBX_DEV: "1" };
  delete env.MBX_AGENT;
  delete env.MBX_ROLE;
  delete env.MBX_DESCRIPTION;
  return spawnSync(process.execPath, [resolve("bin/agentmbx.js"), "hook", event, "--cli", "opencode"], {
    input: JSON.stringify({ session_id: SID, cwd: "/work", ...body }),
    encoding: "utf8",
    timeout: 20_000,
    env,
  });
}

test("T391 B4: hook stop --cli opencode emits a block once, then stays silent (no loop)", () => {
  const home = mkdtempSync(join(tmpdir(), "mbx-opencode-stop-"));
  const n = new MbxNode(home, { host: "alpha" });
  try {
    bindWakeLease(n, { agent: "worker", cli: "opencode", session_id: SID, pid: process.pid });
    sendLeased(n, { from: "sender", to: ["worker"], subject: "during turn", body: "private", kind: "request" });
    const first = runHook(home, "stop");
    assert.equal(first.status, 0, first.stderr);
    const parsed = JSON.parse(first.stdout) as { decision?: string; reason?: string };
    assert.equal(parsed.decision, "block", "first Stop blocks with the mail reason");
    assert.match(parsed.reason ?? "", /new message\(s\) for worker/);
    // The stopseen marker advanced with the first Stop: the second Stop has nothing fresh to
    // surface, emits nothing, and the plugin therefore injects nothing — the loop is bounded.
    const second = runHook(home, "stop");
    assert.equal(second.status, 0, second.stderr);
    assert.equal(second.stdout.trim(), "", "second Stop stays silent (stopseen bound)");
  } finally { n.close(); rmSync(home, { recursive: true, force: true }); }
});

// ---- B2b: the CLI's REAL hook stdout, fed through the GENERATED plugin -------------------------

test("T391 B2b(a): real session-start stdout is plain [mbx] lines and injects as ONE synthetic message", async () => {
  const home = mkdtempSync(join(tmpdir(), "mbx-opencode-start-"));
  const n = new MbxNode(home, { host: "alpha" });
  try {
    bindWakeLease(n, { agent: "worker", cli: "opencode", session_id: SID, pid: process.pid });
    sendLeased(n, { from: "sender", to: ["worker"], subject: "hello", body: "note", kind: "message" });
    const r = runHook(home, "session-start");
    assert.equal(r.status, 0, r.stderr);
    assert.ok(!r.stdout.includes("hookSpecificOutput"), "opencode gets plain stdout, not Claude's JSON shape (B2b)");
    assert.match(r.stdout, /\[mbx\] You are worker@alpha/, "held-identity line");
    assert.match(r.stdout, /1 unread mbx message\(s\)/, "unread line");
    const { mod, dir } = await loadPlugin();
    const calls: Spawned[] = [], posts: SyntheticPost[] = [];
    const restoreSpawn = stubSpawn(calls, () => r.stdout);
    const restoreFetch = stubSynthetic(posts);
    try {
      const hooks = await mod.AgentMBXHooks({ directory: "/work" });
      const event = hooks.event as (e: unknown) => Promise<void>;
      await event({ event: { type: "session.created", properties: { info: { id: SID, directory: "/work" } } } });
      assert.equal(posts.length, 1, "exactly one injection for the whole note");
      assert.ok(posts[0].url.endsWith(`/api/session/${SID}/synthetic`), "the daemon's cited endpoint (B1c)");
      assert.match(posts[0].body.text, /You are worker@alpha/, "held line survives");
      assert.match(posts[0].body.text, /1 unread mbx message\(s\)/, "unread line in the SAME message (B2b run capture)");
      assert.equal(posts[0].body.delivery, "queue");
      assert.equal(posts[0].body.resume, true);
    } finally { restoreSpawn(); restoreFetch(); rmSync(dir, { recursive: true, force: true }); }
  } finally { n.close(); rmSync(home, { recursive: true, force: true }); }
});

test("T391 B2b(b): real post-tool stdout surfaces fresh unread once, then stays silent", async () => {
  const home = mkdtempSync(join(tmpdir(), "mbx-opencode-posttool-"));
  const n = new MbxNode(home, { host: "alpha" });
  try {
    bindWakeLease(n, { agent: "worker", cli: "opencode", session_id: SID, pid: process.pid });
    sendLeased(n, { from: "sender", to: ["worker"], subject: "fresh", body: "note", kind: "request" });
    const first = runHook(home, "post-tool");
    assert.equal(first.status, 0, first.stderr);
    assert.match(first.stdout, /\[mbx\] 1 unread for worker@alpha: mbx_inbox before continuing\./, "post-tool surfaces unread for opencode (B2b)");
    const second = runHook(home, "post-tool");
    assert.equal(second.status, 0, second.stderr);
    assert.equal(second.stdout.trim(), "", "nothing new: toolseen keeps the second post-tool silent");
    const { mod, dir } = await loadPlugin();
    const calls: Spawned[] = [], posts: SyntheticPost[] = [];
    let postToolCalls = 0;
    const restoreSpawn = stubSpawn(calls, (c) => (c.args[1] === "post-tool" ? (postToolCalls++ === 0 ? first.stdout : second.stdout) : ""));
    const restoreFetch = stubSynthetic(posts);
    try {
      const hooks = await mod.AgentMBXHooks({ directory: "/work" });
      const after = hooks["tool.execute.after"] as (input: unknown) => Promise<void>;
      await after({ sessionID: SID });
      assert.equal(posts.length, 1, "fresh unread injects between tool calls");
      assert.match(posts[0].body.text, /mbx_inbox before continuing/);
      // The silent second call injects nothing: the loop stays bounded.
      await after({ sessionID: SID });
      await after({ sessionID: SID });
      assert.equal(posts.length, 1, "silent post-tool injects nothing");
    } finally { restoreSpawn(); restoreFetch(); rmSync(dir, { recursive: true, force: true }); }
  } finally { n.close(); rmSync(home, { recursive: true, force: true }); }
});
