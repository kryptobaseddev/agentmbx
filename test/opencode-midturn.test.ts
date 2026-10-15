// T642: urgent mail that arrives during a long OpenCode turn must reach the model within the turn. The post-tool notice goes into
// the tool result (v2 execute.after result.content, v1 output.output), which the model reads with that tool's output; the queue
// (delivery "queue", held until the turn ends) is only the fallback, and its id no longer repeats when the unread count repeats
// (a repeated id was silently dropped for the session's lifetime). A wake admitted behind a running turn says so in the receipts
// (T647: a current plugin declines a mid-turn wake instead; the receipt path still covers a plugin that reports turn_since).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import type { Server as HttpServer } from "node:http";
import { MbxNode } from "../src/node.ts";
import { startServer } from "../src/http.ts";
import { opencodePluginSource } from "../src/setup.ts";
import { deliveryReceipts, receiptLine } from "../src/receipts.ts";
import { dispatchWakes, OPENCODE_QUEUED_BEHIND_TURN, wakeOpencode } from "../src/wake.ts";
import { opencodeHostSeams } from "../src/opencode-provider.ts";
import { bindWakeLease } from "./helpers/wake-lease.ts";
import { completeOpencodeWake, listOpencodeWakeWaiters, resetOpencodeWakeQueue, waitForOpencodeWake } from "../src/opencode-wake-queue.ts";
import { version } from "../src/version.ts";
import { sendLeased } from "./helpers/leased-send.ts";

const NOTICE = "[mbx] 7 unread for worker@alpha: mbx_inbox before continuing.";
type Note = { sessionID: string; id: string; text: string; resume: boolean; delivery: string };
type Spawn = (bin: string[], args: string[], input: string, cb: (out: string) => void) => void;
const g = globalThis as { __mbxSpawn?: Spawn; __mbxWakePort?: string | null };
const noFetch = (async () => { throw new Error("the shared service must not be called"); }) as typeof fetch;
const noService = async () => { throw new Error("service discovery must not run"); };
const until = async (pred: () => boolean, ms = 2_000) => { const end = Date.now() + ms; while (Date.now() < end) { if (pred()) return true; await new Promise((r) => setTimeout(r, 10)); } return pred(); };
const closeServer = (s: HttpServer) => new Promise<void>((r) => { s.closeAllConnections?.(); s.close(() => r()); });

/** The generated plugin, with a spawn stub that answers every post-tool hook with NOTICE and counts spawns, an MBX_HOME whose
 *  post-tool marker the test controls, and a session API that records queue admissions. */
async function plugin(t: { after: (fn: () => unknown) => void }) {
  const dir = mkdtempSync(join(tmpdir(), "mbx-t642-")), home = join(dir, "home");
  mkdirSync(join(home, "posttool"), { recursive: true });
  const prevHome = process.env.MBX_HOME, prevPort = g.__mbxWakePort;
  process.env.MBX_HOME = home; g.__mbxWakePort = null;
  const spawns: string[] = [], notes: Note[] = [];
  g.__mbxSpawn = (_b, args, _i, cb) => { spawns.push(args[1]); cb(args[1] === "post-tool" ? NOTICE : ""); };
  t.after(() => { delete g.__mbxSpawn; g.__mbxWakePort = prevPort; if (prevHome === undefined) delete process.env.MBX_HOME; else process.env.MBX_HOME = prevHome; rmSync(dir, { recursive: true, force: true }); });
  writeFileSync(join(dir, "agentmbx.ts"), opencodePluginSource(["/opt/bin/agentmbx"], version()));
  const mod = await import(join(dir, "agentmbx.ts")) as { AgentMBXHooks: (ctx: unknown) => Promise<Record<string, (...a: unknown[]) => Promise<void>>>; default: { setup: (ctx: unknown) => Promise<() => void> } };
  const session = { synthetic: async (body: Note) => { notes.push(body); return { id: body.id }; } };
  let toolHook: ((e: unknown) => unknown) | null = null;
  await mod.default.setup({ session, location: { directory: "/work" }, event: { subscribe: async function* () { /* none */ } },
    tool: { hook: (_n: string, fn: (e: unknown) => unknown) => { toolHook = fn; } } });
  const v1 = await mod.AgentMBXHooks({ directory: "/work", session });
  const marker = (sid: string, m: string, last = "") => { writeFileSync(join(home, "posttool", `opencode-${sid}.marker`), m); writeFileSync(join(home, "posttool", `opencode-${sid}.last`), last); };
  return { v2: async (e: unknown) => { await (toolHook as (e: unknown) => unknown)(e); }, v1, spawns, notes, marker };
}

test("AC1 (v2): a post-tool notice is appended to the completed tool result's content, string or array, and not queued", async (t) => {
  const p = await plugin(t);
  p.marker("ses_a", "m1");
  const str = { sessionID: "ses_a", status: "completed", result: { content: "npm test: 412 passing", metadata: { exit: 0 } } };
  await p.v2(str);
  assert.equal(str.result.content, `npm test: 412 passing\n\n${NOTICE}`, "the model reads the notice with this tool's output");
  assert.deepEqual(str.result.metadata, { exit: 0 }, "the rest of the result is kept");
  p.marker("ses_a", "m2");
  const arr = { sessionID: "ses_a", status: "completed", result: { content: [{ type: "text", text: "ok" }] } };
  await p.v2(arr);
  assert.deepEqual(arr.result.content, [{ type: "text", text: "ok" }, { type: "text", text: NOTICE }]);
  assert.deepEqual(p.notes, [], "nothing goes to the end-of-turn queue");
});

test("AC1 (v1): tool.execute.after appends the notice to output.output", async (t) => {
  const p = await plugin(t);
  p.marker("ses_b", "m1");
  const output = { title: "bash", output: "done", metadata: {} };
  await p.v1["tool.execute.after"]({ sessionID: "ses_b" }, output);
  assert.equal(output.output, `done\n\n${NOTICE}`);
  assert.deepEqual(p.notes, []);
});

test("D1a/D2a: an error result or one without text content is left alone and the notice falls back to the queue", async (t) => {
  const p = await plugin(t);
  p.marker("ses_c", "m1");
  const err = { sessionID: "ses_c", status: "error", error: { message: "boom" }, result: { content: "partial" } };
  await p.v2(err);
  assert.deepEqual([err.error, err.result], [{ message: "boom" }, { content: "partial" }], "an error result is not edited");
  p.marker("ses_c", "m2");
  const structured = { sessionID: "ses_c", status: "completed", result: { output: { rows: 3 } } };
  await p.v2(structured);
  assert.deepEqual(structured.result, { output: { rows: 3 } });
  assert.equal(p.notes.length, 2);
  assert.ok(p.notes.every((n) => n.text === NOTICE && n.resume === false && n.delivery === "queue"));
});

test("RC1: a repeated unread count is a new admission (per-occurrence id), and steady state spawns nothing", async (t) => {
  const p = await plugin(t);
  const fire = async (m: string) => { p.marker("ses_d", m); await p.v2({ sessionID: "ses_d", status: "error", error: {} }); };
  await fire("m1"); await fire("m2");
  assert.equal(p.notes.length, 2);
  assert.notEqual(p.notes[0].id, p.notes[1].id, "the same text for a later delivery must not reuse the earlier message id");
  await fire("m1");
  assert.equal(p.notes[2].id, p.notes[0].id, "one occurrence keeps one id (a T187 retry is the same admission)");
  const before = p.spawns.length;
  p.marker("ses_d", "m9", "m9");
  const steady = { sessionID: "ses_d", status: "completed", result: { content: "x" } };
  await p.v2(steady);
  assert.equal(p.spawns.length, before, "marker == last: no node process (T341)");
  assert.equal(steady.result.content, "x");
});

test("AC3: a wake admitted while the session's turn runs is recorded queued-behind-turn, and the sender's receipt says so", async (t) => {
  resetOpencodeWakeQueue();
  const home = mkdtempSync(join(tmpdir(), "mbx-t642-d-"));
  const node = new MbxNode(home, { host: "alpha" });
  const server = await startServer(node, 0, "127.0.0.1");
  const dir = mkdtempSync(join(tmpdir(), "mbx-t642-p-"));
  const prevPort = g.__mbxWakePort;
  g.__mbxWakePort = String((server.address() as AddressInfo).port);
  g.__mbxSpawn = (_b, _a, _i, cb) => cb("");
  t.after(async () => { g.__mbxWakePort = prevPort; delete g.__mbxSpawn; resetOpencodeWakeQueue(); await closeServer(server); node.close();
    rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); rmSync(dir, { recursive: true, force: true }); });
  writeFileSync(join(dir, "agentmbx.ts"), opencodePluginSource(["/opt/bin/agentmbx"], version()));
  const mod = await import(join(dir, "agentmbx.ts")) as { AgentMBXHooks: (ctx: unknown) => Promise<Record<string, (...a: unknown[]) => Promise<void>>> };
  const hooks = await mod.AgentMBXHooks({ directory: "/work", session: { synthetic: async (b: Note) => ({ id: b.id }) } });
  const waiting = () => until(() => listOpencodeWakeWaiters().some((w) => w.sessionID === "ses_turn" && w.pid === process.pid));
  const wake = (text: string) => wakeOpencode("ses_turn", text, { pid: process.pid, host: () => "standalone", service: noService, fetch: noFetch });

  await hooks["tool.execute.after"]({ sessionID: "ses_turn" }, { output: "" }); // a tool call: the turn is running
  assert.equal(await waiting(), true);
  // T647: mid-turn the plugin declines the wake (it would only queue until the turn ends); the outcome is busy, nothing admitted.
  const busy = await wake("[mbx] 1 new message(s) for worker");
  assert.equal(busy.outcome?.kind, "busy", JSON.stringify(busy));
  await hooks.event({ event: { type: "session.idle", properties: { info: { id: "ses_turn" } } } }); // the turn ended
  assert.equal(await waiting(), true);
  const idle = await wake("[mbx] 1 new message(s) for worker again");
  assert.equal(idle.outcome?.kind === "admitted" && idle.outcome.receipt.nativeStatus, "queued", "an idle session's wake starts its turn");

  // Through the real dispatcher: the plugin reports the running turn, the dispatcher records it per message, and mbx_sent and
  // thread views say the wake waits behind that turn until the message is read.
  const real = opencodeHostSeams.args;
  opencodeHostSeams.args = () => new Map([[process.pid, ["/usr/local/bin/opencode", "--standalone"]]]);
  const prevDesk = process.env.MBX_NO_DESKTOP; process.env.MBX_NO_DESKTOP = "1";
  t.after(() => { opencodeHostSeams.args = real; if (prevDesk === undefined) delete process.env.MBX_NO_DESKTOP; else process.env.MBX_NO_DESKTOP = prevDesk; });
  bindWakeLease(node, { agent: "worker", cli: "opencode", session_id: "ses_disp", pid: process.pid });
  const offered = waitForOpencodeWake("ses_disp", process.pid);
  const m = { id: sendLeased(node, { from: "boss", to: ["worker"], subject: "s", body: "b", kind: "request", needs_reply: true }).envelope.id };
  const row = node.store.db.prepare("SELECT * FROM messages WHERE id=?").get(m.id) as never;
  assert.equal(deliveryReceipts(node, row)[0].wake, undefined, "nothing claimed before a wake");
  const dispatched = dispatchWakes(node);
  assert.match((await offered) ?? "", /new message/);
  assert.equal(completeOpencodeWake("ses_disp", "msg_disp", "2026-10-14T20:35:01.000Z"), true);
  const [out] = await dispatched;
  assert.equal(out?.result.ok, true, JSON.stringify(out));
  const r = deliveryReceipts(node, row)[0];
  assert.match(r.wake ?? "", /^wake queued behind the session's running turn: the model sees a notice with its next tool result, the wake when the turn ends \(admitted \d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ\)$/);
  assert.match(receiptLine(r), / · wake queued behind the session's running turn/);
  const audit = JSON.parse((node.store.db.prepare("SELECT detail FROM audit WHERE event='wake.attempt' ORDER BY rowid DESC LIMIT 1").get() as { detail: string }).detail);
  assert.equal(audit.nativeStatus, OPENCODE_QUEUED_BEHIND_TURN);
  node.ack(m.id, "worker");
  assert.equal(deliveryReceipts(node, row)[0].wake, undefined, "a handled message no longer claims to wait");
});
