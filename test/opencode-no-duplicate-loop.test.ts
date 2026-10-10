// T524 containment: AgentMBX must never make the shared `opencode serve --service` start a second agent
// loop on a session that a standalone serve (`opencode --standalone` -> `opencode serve --stdio --port 0`)
// hosts. A synthetic POST with resume:true does exactly that, so (1) the generated plugin posts only when it
// is itself loaded by the service process, (2) the daemon's wakeOpencode posts only when the binding's
// provider pid is the service, and (3) doctor no longer claims a push wake for standalone-hosted bindings.
// Everything runs against temp HOMEs and fakes: no real OpenCode config, process or service is touched.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MbxNode } from "../src/node.ts";
import { opencodePluginPath, opencodePluginSource, runSetup, type SetupCtx } from "../src/setup.ts";
import { opencodeServiceCheck } from "../src/doctor.ts";
import { OPENCODE_STANDALONE_NO_PUSH, wakeOpencode } from "../src/wake.ts";
import { isOpencodeServiceArgv, opencodeHostOf } from "../src/opencode-provider.ts";
import { version } from "../src/version.ts";

const CMD = ["/opt/bin/agentmbx"];
const SERVICE = ["/Users/x/.opencode/bin/opencode", "serve", "--service"];
const STANDALONE = ["/Users/x/.opencode/bin/opencode", "serve", "--stdio", "--port", "0"];
const noFetch = (async () => { throw new Error("T524: no request may reach the shared service"); }) as typeof fetch;
const noService = async () => { throw new Error("T524: service discovery must not run for a standalone-hosted session"); };

test("argv detection: only `serve --service` without --stdio is the shared service", () => {
  assert.equal(isOpencodeServiceArgv(SERVICE.slice(1)), true);
  assert.equal(isOpencodeServiceArgv(["serve", "--service=default"]), true);
  assert.equal(isOpencodeServiceArgv(STANDALONE.slice(1)), false);
  assert.equal(isOpencodeServiceArgv(["--standalone"]), false);
  assert.equal(isOpencodeServiceArgv(["serve", "--service", "--stdio"]), false);
});

test("host classification: service, standalone, node runtime hop, foreign and unreadable", () => {
  const table = new Map([[100, { ppid: 1 }], [200, { ppid: 1 }], [300, { ppid: 100 }], [400, { ppid: 1 }]]);
  const args = new Map([[100, SERVICE], [200, STANDALONE], [300, ["node", "/x/runtime.js"]], [400, ["/bin/zsh"]]]);
  assert.equal(opencodeHostOf(100, args, table), "service");
  assert.equal(opencodeHostOf(200, args, table), "standalone");
  assert.equal(opencodeHostOf(300, args, table), "service", "a node/bun runtime child resolves to its opencode parent");
  assert.equal(opencodeHostOf(400, args, table), "unknown", "a non-opencode process is never treated as the service");
  assert.equal(opencodeHostOf(999, args, table), "unknown", "an unreadable pid fails closed");
  assert.equal(opencodeHostOf(null, args, table), "unknown");
});

test("plugin template admits in-process and never calls the shared service", () => {
  const src = opencodePluginSource(CMD, version());
  assert.ok(!src.includes("inService"), "no service-process gate");
  assert.ok(!src.includes('["service", "status"]') && !src.includes("opencode service status"), "no service discovery");
  assert.ok(!src.includes("/api/session"), "no session fetch");
  assert.ok(src.includes("session?.synthetic") && src.includes('delivery: "queue"'), "in-process admission");
  assert.ok(src.includes('id: noteId(sid, hook, text), text, resume: false'), "hook notes stay resume:false (T518)");
  assert.ok(src.includes('id: noteId(sid, "wake", text), text, resume: true'), "a daemon wake resumes the idle turn (T544)");
});

async function loadPlugin() {
  // T519 polls the daemon unless this seam is null. These cases must not touch port 7373.
  (globalThis as { __mbxWakePort?: string | null }).__mbxWakePort = null;
  const dir = mkdtempSync(join(tmpdir(), "mbx-t524-plugin-"));
  const file = join(dir, "agentmbx.ts");
  writeFileSync(file, opencodePluginSource(CMD, version()));
  return { mod: await import(file) as { AgentMBXHooks: (ctx: unknown) => Promise<Record<string, unknown>> }, dir };
}

for (const argv of [undefined, STANDALONE]) test(`plugin in a standalone serve (${argv ? "--stdio argv" : "test-runner argv"}) injects in-process and never posts`, async () => {
  const { mod, dir } = await loadPlugin();
  const g = globalThis as { __mbxSpawn?: unknown; __mbxArgv?: string[] };
  const spawned: string[][] = [];
  const notes: Array<{ sessionID: string; resume: boolean; delivery: string }> = [];
  const realFetch = globalThis.fetch, realUrl = process.env.MBX_OPENCODE_URL;
  let fetched = 0;
  g.__mbxSpawn = (_bin: string[], args: string[], _input: string, cb: (out: string) => void) => {
    spawned.push(args);
    cb(args[0] === "hook" ? JSON.stringify({ decision: "block", reason: "[mbx] 1 new message(s) for worker." }) : "http://127.0.0.1:9");
  };
  if (argv) g.__mbxArgv = argv; else delete g.__mbxArgv;
  delete process.env.MBX_OPENCODE_URL;
  globalThis.fetch = (async () => { fetched++; throw new Error("no service call"); }) as typeof fetch;
  try {
    const hooks = await mod.AgentMBXHooks({ directory: "/work", session: { synthetic: async (body: { sessionID: string; resume: boolean; delivery: string }) => { notes.push(body); return body; } } });
    await (hooks.event as (e: unknown) => Promise<void>)({ event: { type: "session.idle", properties: { info: { id: "ses_standalone" } } } });
    assert.deepEqual(spawned.map((a) => a.slice(0, 2)), [["hook", "stop"]], "the hook still runs; no service discovery");
    assert.equal(fetched, 0, "no request to the shared service");
    assert.equal(notes.length, 1);
    assert.equal(notes[0].sessionID, "ses_standalone");
    assert.equal(notes[0].resume, false);
    assert.equal(notes[0].delivery, "queue");
  } finally {
    delete g.__mbxSpawn; delete g.__mbxArgv; globalThis.fetch = realFetch;
    if (realUrl === undefined) delete process.env.MBX_OPENCODE_URL; else process.env.MBX_OPENCODE_URL = realUrl;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("setup rewrites an installed pre-T524 plugin (a body change, not header-only drift)", () => {
  const home = mkdtempSync(join(tmpdir(), "mbx-t524-setup-"));
  try {
    mkdirSync(join(home, ".config/opencode/plugins"), { recursive: true });
    writeFileSync(join(home, ".config/opencode/opencode.jsonc"), `{\n  "$schema": "https://opencode.ai/config.json"\n}\n`);
    const current = opencodePluginSource(CMD, version());
    const legacy = current.replace("resume: false", "resume: true").replace(/\(agentmbx [^)]*\)/, "(agentmbx 0.5.19)");
    assert.notEqual(legacy, current);
    writeFileSync(opencodePluginPath(home), legacy);
    const ctx: SetupCtx = { home, cmd: CMD, which: () => null, useClis: false };
    runSetup(ctx, { mode: "install", only: ["opencode"] });
    assert.equal(readFileSync(opencodePluginPath(home), "utf8"), current, "the guarded template replaces the old one");
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("T518: each hook calls synthetic once, and a retry with the same id is one admission", async () => {
  const { mod, dir } = await loadPlugin();
  const g = globalThis as { __mbxSpawn?: unknown };
  const notes: Array<{ sessionID: string; id: string; text: string; resume: boolean; delivery: string }> = [];
  const admitted = new Map<string, unknown>();
  g.__mbxSpawn = (_bin: string[], args: string[], _input: string, cb: (out: string) => void) => {
    cb(args[0] === "hook" ? JSON.stringify({ decision: "block", reason: "[mbx] 1 new message(s) for worker." }) : "");
  };
  const realFetch = globalThis.fetch;
  let fetched = 0;
  globalThis.fetch = (async () => { fetched++; throw new Error("no service call"); }) as typeof fetch;
  try {
    const hooks = await mod.AgentMBXHooks({
      directory: "/work",
      session: { synthetic: async (body: { sessionID: string; id: string; text: string; resume: boolean; delivery: string }) => { notes.push(body); if (!admitted.has(body.id)) admitted.set(body.id, body); return body; } },
    });
    const event = hooks.event as (e: unknown) => Promise<void>;
    const after = hooks["tool.execute.after"] as (input: unknown) => Promise<void>;
    await event({ event: { type: "session.created", properties: { info: { id: "ses_one" } } } });
    await event({ event: { type: "session.idle", properties: { info: { id: "ses_one" } } } });
    await after({ sessionID: "ses_one" });
    assert.equal(notes.length, 3, "session-start, stop and post-tool each call synthetic once");
    assert.deepEqual(notes.map((n) => n.sessionID), ["ses_one", "ses_one", "ses_one"]);
    assert.ok(notes.every((n) => n.resume === false && n.delivery === "queue" && n.id.startsWith("msg_")));
    assert.equal(new Set(notes.map((n) => n.id)).size, 3);
    const first = notes[0].id;
    await event({ event: { type: "session.created", properties: { info: { id: "ses_one" } } } });
    assert.equal(notes[3].id, first, "the retry reuses the id");
    assert.equal(admitted.size, 3, "the same id does not create a second row");
    assert.equal(fetched, 0);
  } finally { delete g.__mbxSpawn; globalThis.fetch = realFetch; rmSync(dir, { recursive: true, force: true }); }
});

test("T518: a host without synthetic falls back to prompt and still does not fetch", async () => {
  const { mod, dir } = await loadPlugin();
  const g = globalThis as { __mbxSpawn?: unknown };
  const prompts: Array<{ sessionID: string; resume: boolean; delivery: string }> = [];
  g.__mbxSpawn = (_bin: string[], args: string[], _input: string, cb: (out: string) => void) => {
    cb(JSON.stringify({ decision: "block", reason: "[mbx] 1 new message(s) for worker." }));
  };
  const realFetch = globalThis.fetch;
  let fetched = 0;
  globalThis.fetch = (async () => { fetched++; throw new Error("no service call"); }) as typeof fetch;
  try {
    const hooks = await mod.AgentMBXHooks({
      directory: "/work",
      session: { prompt: async (body: { sessionID: string; resume: boolean; delivery: string }) => { prompts.push(body); return body; } },
    });
    await (hooks.event as (e: unknown) => Promise<void>)({ event: { type: "session.idle", properties: { info: { id: "ses_prompt" } } } });
    assert.equal(prompts.length, 1);
    assert.equal(prompts[0].sessionID, "ses_prompt");
    assert.equal(prompts[0].resume, false);
    assert.equal(prompts[0].delivery, "queue");
    assert.equal(fetched, 0);
  } finally { delete g.__mbxSpawn; globalThis.fetch = realFetch; rmSync(dir, { recursive: true, force: true }); }
});

test("wakeOpencode: a standalone-hosted session is not_submitted/no-target with no service call", async () => {
  for (const host of ["standalone", "unknown"] as const) {
    const r = await wakeOpencode("ses_standalone", "[mbx] hint", { pid: 4242, host: () => host, service: noService, fetch: noFetch });
    assert.equal(r.ok, false);
    assert.equal(r.outcome?.kind, "not_submitted");
    assert.equal(r.outcome?.kind === "not_submitted" && r.outcome.reason, "no-target");
    if (host === "standalone") assert.equal(r.outcome?.kind === "not_submitted" && r.outcome.detail, OPENCODE_STANDALONE_NO_PUSH);
    assert.match(r.error ?? "", /duplicate agent loop/);
  }
  // the real classifier with no recorded pid fails closed the same way
  const none = await wakeOpencode("ses_x", "[mbx] hint", { pid: null, service: noService, fetch: noFetch });
  assert.equal(none.outcome?.kind === "not_submitted" && none.outcome.reason, "no-target");
});

test("wakeOpencode: a service-hosted session still posts exactly once with a validated receipt", async () => {
  let posts = 0;
  const r = await wakeOpencode("ses_svc", "[mbx] hint", {
    pid: 4242, host: (pid) => (pid === 4242 ? "service" : "unknown"),
    service: async () => ({ url: "http://127.0.0.1:1", auth: "" }),
    fetch: (async (url: string | URL | Request, init?: RequestInit) => {
      posts++;
      assert.equal(String(url), "http://127.0.0.1:1/api/session/ses_svc/synthetic");
      assert.deepEqual(JSON.parse(String(init?.body)), { text: "[mbx] hint", delivery: "queue", resume: true });
      return Response.json({ data: { id: "msg_1", sessionID: "ses_svc", type: "synthetic", delivery: "queue", payload: { text: "[mbx] hint" }, time: { created: 1 } } });
    }) as typeof fetch,
  });
  assert.equal(r.ok, true);
  assert.equal(r.outcome?.kind, "admitted");
  assert.equal(posts, 1);
});

test("T520: a service-hosted OpenCode binding is classified service-hosted", async () => {
  const home = mkdtempSync(join(tmpdir(), "mbx-t520-service-"));
  const node = new MbxNode(home, { host: "alpha" });
  try {
    node.store.db.prepare("INSERT INTO sessions (agent, cli, session_id, pid, channel, updated_at) VALUES (?, 'opencode', ?, ?, 0, ?)")
      .run("agent-svc", "ses_svc", 100, new Date().toISOString());
    let asked = 0;
    const up = async () => { asked++; return { url: "http://127.0.0.1:49374", auth: "" }; };
    const row = await opencodeServiceCheck(node, up, () => "service", () => false);
    assert.equal(row?.level, "ok");
    assert.match(row?.label ?? "", /wake path for 1 service-hosted/);
    assert.doesNotMatch(row?.label ?? "", /unwakeable|plugin consumer/);
    assert.equal(row?.fix, undefined);
    assert.equal(asked, 1);
  } finally { node.close(); rmSync(home, { recursive: true, force: true }); }
});

test("T520: a standalone binding with a live plugin consumer is classified as wakeable", async () => {
  const home = mkdtempSync(join(tmpdir(), "mbx-t520-plugin-"));
  const node = new MbxNode(home, { host: "alpha" });
  try {
    node.store.db.prepare("INSERT INTO sessions (agent, cli, session_id, pid, channel, updated_at) VALUES (?, 'opencode', ?, ?, 0, ?)")
      .run("agent-live", "ses_live", 200, new Date().toISOString());
    let asked = 0;
    const up = async () => { asked++; return { url: "http://127.0.0.1:49374", auth: "" }; };
    const row = await opencodeServiceCheck(node, up, () => "standalone", (sid, pid) => sid === "ses_live" && pid === 200);
    assert.equal(row?.level, "ok");
    assert.match(row?.label ?? "", /1 standalone binding\(s\) with a live plugin consumer/);
    assert.doesNotMatch(row?.label ?? "", /unwakeable|wake path for/);
    assert.equal(row?.fix, undefined);
    assert.equal(asked, 0, "a plugin consumer does not probe the shared service");
  } finally { node.close(); rmSync(home, { recursive: true, force: true }); }
});

test("T520: a standalone binding with no plugin consumer is an unwakeable warning", async () => {
  const home = mkdtempSync(join(tmpdir(), "mbx-t520-unwakeable-"));
  const node = new MbxNode(home, { host: "alpha" });
  try {
    const add = (sid: string, pid: number) => node.store.db.prepare("INSERT INTO sessions (agent, cli, session_id, pid, channel, updated_at) VALUES (?, 'opencode', ?, ?, 0, ?)")
      .run(`agent-${sid}`, sid, pid, new Date().toISOString());
    add("ses_alone", 200);
    add("ses_unknown", 201);
    const host = (pid: number | null) => (pid === 200 ? "standalone" as const : "unknown" as const);
    const row = await opencodeServiceCheck(node, async () => { throw new Error("service must not be probed"); }, host, () => false);
    assert.equal(row?.level, "warn");
    assert.match(row?.label ?? "", /2 unwakeable binding\(s\): standalone with no plugin consumer, or an unknown host/);
    assert.match(row?.fix ?? "", /agentmbx setup --only opencode/);
    assert.doesNotMatch(`${row?.label ?? ""} ${row?.fix ?? ""}`, /no push wake yet/);
  } finally { node.close(); rmSync(home, { recursive: true, force: true }); }
});

test("T520: a missing daemon waiter read fails closed as unwakeable and does not probe the service", async () => {
  const home = mkdtempSync(join(tmpdir(), "mbx-t520-deaf-"));
  const node = new MbxNode(home, { host: "alpha", port: 1 });
  try {
    node.store.db.prepare("INSERT INTO sessions (agent, cli, session_id, pid, channel, updated_at) VALUES (?, 'opencode', ?, ?, 0, ?)")
      .run("agent-deaf", "ses_deaf", 300, new Date().toISOString());
    const row = await opencodeServiceCheck(node, async () => { throw new Error("service must not be probed"); }, () => "standalone");
    assert.equal(row?.level, "warn");
    assert.match(row?.label ?? "", /1 unwakeable binding\(s\): standalone with no plugin consumer, or an unknown host/);
    assert.match(row?.fix ?? "", /agentmbx setup --only opencode/);
  } finally { node.close(); rmSync(home, { recursive: true, force: true }); }
});
