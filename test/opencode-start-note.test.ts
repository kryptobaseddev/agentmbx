// T643: session.created fires with the first prompt, so the queued session-start note always landed after the first turn, and an
// unbound one ("no mailbox identity yet") was false by then if that turn claimed or registered. The plugin now holds the unbound
// note: the next tool result carries it while the session is still unbound, a bind (the post-tool marker changes) drops it, and a
// turn that ends with it still held and unbound queues it for the next turn.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { opencodePluginSource } from "../src/setup.ts";
import { version } from "../src/version.ts";

const UNBOUND = "[mbx] This session has no mailbox identity yet. No mailboxes for this directory.";
type Note = { sessionID: string; id: string; text: string; resume: boolean; delivery: string };
type Spawn = (bin: string[], args: string[], input: string, cb: (out: string) => void) => void;
const g = globalThis as { __mbxSpawn?: Spawn; __mbxWakePort?: string | null };

/** The generated plugin (v1 hooks). session-start answers `start` (the unbound note by default); post-tool and stop answer nothing,
 *  so every note seen comes from the session-start path. bindOnStart writes the marker as the hook runs, as bindSession does. */
async function plugin(t: { after: (fn: () => unknown) => void }, opts: { start?: string; bindOnStart?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "mbx-t643-")), home = join(dir, "home"), posttool = join(home, "posttool");
  mkdirSync(posttool, { recursive: true });
  const prevHome = process.env.MBX_HOME, prevPort = g.__mbxWakePort;
  process.env.MBX_HOME = home; g.__mbxWakePort = null;
  const notes: Note[] = [], spawns: string[] = [];
  const bind = (sid: string, m = "bound-" + Date.now()) => writeFileSync(join(posttool, `opencode-${sid}.marker`), m);
  g.__mbxSpawn = (_b, args, input, cb) => {
    spawns.push(args[1]);
    if (args[1] === "session-start" && opts.bindOnStart) bind(JSON.parse(input).session_id);
    cb(args[1] === "session-start" ? (opts.start ?? UNBOUND) : "");
  };
  t.after(() => { delete g.__mbxSpawn; g.__mbxWakePort = prevPort; if (prevHome === undefined) delete process.env.MBX_HOME; else process.env.MBX_HOME = prevHome; rmSync(dir, { recursive: true, force: true }); });
  writeFileSync(join(dir, "agentmbx.ts"), opencodePluginSource(["/opt/bin/agentmbx"], version()));
  const mod = await import(join(dir, "agentmbx.ts")) as { AgentMBXHooks: (ctx: unknown) => Promise<Record<string, (...a: unknown[]) => Promise<void>>> };
  const hooks = await mod.AgentMBXHooks({ directory: "/work", session: { synthetic: async (b: Note) => { notes.push(b); return { id: b.id }; } } });
  const created = (sid: string) => hooks.event({ event: { type: "session.created", properties: { info: { id: sid, directory: "/work" } } } });
  const idle = (sid: string) => hooks.event({ event: { type: "session.idle", properties: { info: { id: sid } } } });
  const tool = async (sid: string, output = "ok") => { const o = { title: "bash", output, metadata: {} }; await hooks["tool.execute.after"]({ sessionID: sid }, o); return o.output; };
  const toolRaw = (sid: string, o: Record<string, unknown>) => hooks["tool.execute.after"]({ sessionID: sid }, o);
  return { created, idle, tool, toolRaw, bind, notes, spawns };
}

test("unbound start, then a tool: the note rides that tool's result and nothing is queued", async (t) => {
  const p = await plugin(t);
  await p.created("ses_a");
  assert.deepEqual(p.notes, [], "not queued at session.created: the first turn is already running");
  assert.equal(await p.tool("ses_a", "ZERO"), `ZERO\n\n${UNBOUND}`);
  await p.idle("ses_a");
  assert.deepEqual(p.notes, [], "placed once, never queued as well");
});

test("a bind during the first tool drops the note: no tool result and no queue carry it", async (t) => {
  const p = await plugin(t);
  await p.created("ses_b");
  p.bind("ses_b"); // mbx_identity register ran in this tool call
  assert.equal(await p.tool("ses_b", "registered isoworker"), "registered isoworker");
  await p.idle("ses_b");
  assert.deepEqual(p.notes, []);
});

test("unbound start, a turn with no tool: queued once at the turn's end, for the next turn", async (t) => {
  const p = await plugin(t);
  await p.created("ses_c");
  await p.idle("ses_c");
  assert.equal(p.notes.length, 1);
  assert.equal(p.notes[0].text, UNBOUND);
  assert.equal(p.notes[0].delivery, "queue");
  await p.idle("ses_c");
  assert.equal(await p.tool("ses_c", "later"), "later", "a delivered note is not repeated");
  assert.equal(p.notes.length, 1);
});

test("unbound start, bound before the turn ends with no tool: dropped", async (t) => {
  const p = await plugin(t);
  await p.created("ses_d");
  p.bind("ses_d");
  await p.idle("ses_d");
  assert.deepEqual(p.notes, []);
});

test("bound at session start: the start note is queued as before (its identity line stays true)", async (t) => {
  const BOUND = "[mbx] You are isoworker@alpha (role: builder).";
  const p = await plugin(t, { start: BOUND, bindOnStart: true });
  await p.created("ses_e");
  assert.equal(p.notes.length, 1);
  assert.equal(p.notes[0].text, BOUND);
  assert.equal(await p.tool("ses_e", "x"), "x");
});

test("the note is placed once, not on later tool calls; a result with no text keeps it for the next tool", async (t) => {
  const p = await plugin(t);
  await p.created("ses_f");
  const noText: Record<string, unknown> = { title: "read", metadata: {} };
  await p.toolRaw("ses_f", noText);
  assert.equal(noText.output, undefined, "a result without text output is not edited");
  assert.deepEqual(p.notes, [], "and the note is not queued mid-turn");
  assert.equal(await p.tool("ses_f", "one"), `one\n\n${UNBOUND}`);
  assert.equal(await p.tool("ses_f", "two"), "two");
  await p.idle("ses_f");
  assert.deepEqual(p.notes, []);
});
