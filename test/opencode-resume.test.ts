// T187: the OpenCode plugin's resume-entry path. Fresh and quiet-resume hooks show the bounded
// notice. A busy turn, a missing binding, a stale connector, or a host with no session note API
// keeps the note and says so, without a wake and without a fake receipt.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { opencodePluginSource } from "../src/setup.ts";
import { version } from "../src/version.ts";

const CMD = ["/opt/bin/agentmbx"];
const NOTICE = [
  "[mbx] You are worker@alpha (role: builder).",
  "[mbx] 1 unread mbx message(s): call mbx_inbox.",
  "[mbx] Not caught up: call mbx_catchup.",
  "[mbx] 1 open thread(s) with unacked mail.",
].join("\n");
const FALLBACK = "[mbx] Resume note was not admitted. Call mbx_whoami, then mbx_inbox. Mail is unchanged.";

interface Note { sessionID: string; id: string; text: string; delivery: string; resume: boolean }
interface Spawned { args: string[]; input: Record<string, unknown> }
type Hooks = {
  event: (event: unknown) => Promise<void>;
  "tool.execute.after": (input: unknown, output?: { output?: string }) => Promise<void>;
};

async function loadPlugin() {
  (globalThis as { __mbxWakePort?: string | null }).__mbxWakePort = null;
  const dir = mkdtempSync(join(tmpdir(), "mbx-oc-resume-"));
  const file = join(dir, "agentmbx.ts");
  writeFileSync(file, opencodePluginSource(CMD, version()));
  try {
    const mod = await import(file) as { AgentMBXHooks: (ctx: unknown) => Promise<Hooks> };
    return { mod, dir };
  } catch (e) { rmSync(dir, { recursive: true, force: true }); throw e; }
}

function stubSpawn(calls: Spawned[], script: (c: Spawned) => string) {
  (globalThis as { __mbxSpawn?: unknown }).__mbxSpawn = (bin: string[], args: string[], input: string, cb: (out: string) => void) => {
    const c = { args, input: JSON.parse(input) as Record<string, unknown> };
    calls.push(c);
    cb(script(c));
  };
  return () => { delete (globalThis as { __mbxSpawn?: unknown }).__mbxSpawn; };
}

function stubSession(notes: Note[]) {
  return { synthetic: async (body: Note) => { notes.push(body); return body; } };
}

const envelope = (sid: string, text: string) => JSON.stringify({ mbx_resume: { session_id: sid, text } });

test("T187: a fresh session admits the bounded notice once, to that session only", async () => {
  const { mod, dir } = await loadPlugin(), calls: Spawned[] = [], notes: Note[] = [];
  const restore = stubSpawn(calls, c => {
    if (c.args[1] === "session-start" && c.input.session_id === "ses_fresh") return envelope("ses_fresh", NOTICE);
    if (c.input.session_id === "ses_other") return envelope("ses_fresh", NOTICE);
    return "";
  });
  try {
    const hooks = await mod.AgentMBXHooks({ directory: "/work", session: stubSession(notes) });
    await hooks.event({ event: { type: "session.created", properties: { info: { id: "ses_fresh" } } } });
    assert.equal(notes.length, 1);
    assert.equal(notes[0].sessionID, "ses_fresh");
    assert.equal(notes[0].text, NOTICE);
    assert.equal(notes[0].resume, false);
    assert.equal(notes[0].delivery, "queue");
    assert.ok(NOTICE.length <= 1200 && NOTICE.split("\n").length <= 8);
    assert.match(NOTICE, /mbx_inbox/);
    assert.match(NOTICE, /mbx_catchup/);
    assert.doesNotMatch(NOTICE, /PRIVATE/);
    await hooks["tool.execute.after"]({ sessionID: "ses_fresh" });
    await hooks.event({ event: { type: "session.created", properties: { info: { id: "ses_other" } } } });
    assert.equal(notes.length, 1, "an empty follow-up and a mismatched envelope do not admit again");
    assert.ok(notes.every(n => n.resume === false));
  } finally { restore(); rmSync(dir, { recursive: true, force: true }); }
});

test("T187: a quiet resume places the same notice in that tool result and does not queue a copy", async () => {
  const { mod, dir } = await loadPlugin(), notes: Note[] = [];
  let once = false;
  const restore = stubSpawn([], c => {
    if (!once && c.args[1] === "post-tool" && c.input.session_id === "ses_resume") { once = true; return envelope("ses_resume", NOTICE); }
    return "";
  });
  const output = { output: "tool ok" };
  try {
    const hooks = await mod.AgentMBXHooks({ directory: "/work", session: stubSession(notes) });
    await hooks["tool.execute.after"]({ sessionID: "ses_resume" }, output);
    assert.equal(notes.length, 0, "the tool result is the admission; nothing is queued behind the turn");
    assert.match(output.output, /You are worker@alpha/);
    assert.match(output.output, /mbx_inbox/);
    assert.match(output.output, /mbx_catchup/);
    assert.doesNotMatch(output.output, /Resume note was not admitted/);
    const again = { output: "next tool" };
    await hooks["tool.execute.after"]({ sessionID: "ses_resume" }, again);
    assert.equal(again.output, "next tool", "the same turn does not repeat the notice");
    assert.equal(notes.length, 0);
  } finally { restore(); rmSync(dir, { recursive: true, force: true }); }
});

test("T187: a busy turn keeps the resume note, reports the fallback once, and admits it when the turn ends", async () => {
  const { mod, dir } = await loadPlugin(), notes: Note[] = [];
  let tools = 0;
  const restore = stubSpawn([], c => {
    if (c.args[1] !== "post-tool") return "";
    return ++tools === 1 ? "" : envelope("ses_busy", NOTICE);
  });
  try {
    const hooks = await mod.AgentMBXHooks({ directory: "/work", session: stubSession(notes) });
    await hooks["tool.execute.after"]({ sessionID: "ses_busy" }, { output: "first" });
    const mid = { output: "mid" };
    await hooks["tool.execute.after"]({ sessionID: "ses_busy" }, mid);
    assert.equal(notes.length, 0, "a running turn does not admit the note");
    assert.ok(mid.output.includes(FALLBACK));
    assert.doesNotMatch(mid.output, /mbx_catchup/, "the full note stays pending");
    const third = { output: "third" };
    await hooks["tool.execute.after"]({ sessionID: "ses_busy" }, third);
    assert.equal(third.output, "third", "the fallback is once per pending note");
    await hooks.event({ event: { type: "session.idle", properties: { info: { id: "ses_busy" } } } });
    assert.equal(notes.length, 1);
    assert.equal(notes[0].sessionID, "ses_busy");
    assert.equal(notes[0].text, NOTICE);
    assert.equal(notes[0].resume, false, "ending the turn admits the note; it does not start a wake");
  } finally { restore(); rmSync(dir, { recursive: true, force: true }); }
});

test("T187: a missing binding holds the register fallback and never admits a resume note", async () => {
  const { mod, dir } = await loadPlugin(), notes: Note[] = [];
  const unbound = "[mbx] This session has no mailbox identity yet.\n[mbx] Register or claim, then call mbx_inbox.";
  let started = false;
  const restore = stubSpawn([], c => {
    if (c.args[1] === "session-start" && !started) { started = true; return unbound; }
    return "";
  });
  const output = { output: "tool ok" };
  try {
    const hooks = await mod.AgentMBXHooks({ directory: "/work", session: stubSession(notes) });
    await hooks.event({ event: { type: "session.created", properties: { info: { id: "ses_unbound" } } } });
    assert.equal(notes.length, 0, "an unbound start note is held, not admitted");
    await hooks["tool.execute.after"]({ sessionID: "ses_unbound" }, output);
    assert.match(output.output, /no mailbox identity yet/);
    assert.match(output.output, /mbx_inbox/);
    assert.doesNotMatch(output.output, /Resume note was not admitted/);
    assert.equal(notes.length, 0);
    await hooks.event({ event: { type: "session.idle", properties: { info: { id: "ses_unbound" } } } });
    assert.equal(notes.length, 0, "idle does not turn the fallback into a resume admission");
  } finally { restore(); rmSync(dir, { recursive: true, force: true }); }
});

test("T187: a stale connector shows the disconnect line and does not admit a resume note", async () => {
  const { mod, dir } = await loadPlugin(), notes: Note[] = [];
  const line = "[mbx] mbx disconnected: reconnect it with /mcps in OpenCode (select mbx); this session no longer holds stale-worker@alpha.";
  const restore = stubSpawn([], c => c.args[1] === "post-tool" ? line : "");
  const output = { output: "tool ok" };
  try {
    const hooks = await mod.AgentMBXHooks({ directory: "/work", session: stubSession(notes) });
    await hooks["tool.execute.after"]({ sessionID: "ses_stale" }, output);
    assert.match(output.output, /mbx disconnected/);
    assert.match(output.output, /stale-worker@alpha/);
    assert.equal(notes.length, 0);
    await hooks.event({ event: { type: "session.idle", properties: { info: { id: "ses_stale" } } } });
    assert.equal(notes.length, 0, "the disconnect line is not kept as a resume note");
    assert.ok(notes.every(n => n.resume === false));
  } finally { restore(); rmSync(dir, { recursive: true, force: true }); }
});

test("T187: a host with no session note API keeps the note and a later tool result can show it", async () => {
  const { mod, dir } = await loadPlugin();
  const home = process.env.MBX_HOME;
  process.env.MBX_HOME = dir;
  const restore = stubSpawn([], c => c.args[1] === "session-start" ? envelope("ses_noapi", NOTICE) : "");
  const output = { output: "tool ok" };
  try {
    const hooks = await mod.AgentMBXHooks({ directory: "/work", session: {} });
    await hooks.event({ event: { type: "session.created", properties: { info: { id: "ses_noapi" } } } });
    const log = readFileSync(join(dir, "logs", "opencode-plugin.log"), "utf8");
    assert.match(log, /resume session=ses_noapi/);
    assert.match(log, /not admitted; mail unchanged/);
    await hooks["tool.execute.after"]({ sessionID: "ses_noapi" }, output);
    assert.match(output.output, /You are worker@alpha/);
    assert.match(output.output, /mbx_inbox/);
    assert.doesNotMatch(output.output, /Resume note was not admitted/, "the tool result shows the note itself");
    await hooks.event({ event: { type: "session.idle", properties: { info: { id: "ses_noapi" } } } });
    assert.equal(output.output.includes(NOTICE), true);
  } finally {
    if (home === undefined) delete process.env.MBX_HOME; else process.env.MBX_HOME = home;
    restore(); rmSync(dir, { recursive: true, force: true });
  }
});
