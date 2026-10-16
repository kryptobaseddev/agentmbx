// T675: after a turn that ended with unread mail, OpenCode showed two notices for it. The stop hook's note is admitted with
// resume:false (T518), so it never started a turn; it waited in OpenCode's queue. The daemon's wake, retried with a backoff of up
// to 60 s after the mid-turn busy answers (T647), then started a turn, the queued stop note showed first, and the wake's own text
// showed last, after the agent had already acked the mail. Now, when the session's wake poll is live, a turn end skips the stop
// hook and reports "idle" to the daemon; the next normal dispatch pass skips the busy backoff and wakes once, only for mail still
// unhandled. The idle report admits nothing by itself and is harmless for a session with no lease or poll.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import type { Server as HttpServer } from "node:http";
import { MbxNode } from "../src/node.ts";
import { startServer } from "../src/http.ts";
import { opencodePluginSource } from "../src/setup.ts";
import { dispatchWakes } from "../src/wake.ts";
import { opencodeHostSeams } from "../src/opencode-provider.ts";
import {
  completeOpencodeWake, listOpencodeWakeWaiters, OPENCODE_WAKE_IDLE, opencodeIdleAt, pushOpencodeWake, resetOpencodeWakeQueue, waitForOpencodeWake,
} from "../src/opencode-wake-queue.ts";
import { version } from "../src/version.ts";
import { bindWakeLease } from "./helpers/wake-lease.ts";
import { sendLeased } from "./helpers/leased-send.ts";

type Note = { sessionID: string; id: string; text: string; resume: boolean; delivery: string };
type Spawn = (bin: string[], args: string[], input: string, cb: (out: string) => void) => void;
const g = globalThis as { __mbxSpawn?: Spawn; __mbxWakePort?: string | null };
const until = async (pred: () => boolean, ms = 2_000) => { const end = Date.now() + ms; while (Date.now() < end) { if (pred()) return true; await new Promise((r) => setTimeout(r, 10)); } return pred(); };
const closeServer = (s: HttpServer) => new Promise<void>((r) => { s.closeAllConnections?.(); s.close(() => r()); });
const STOP_REASON = "[mbx] 1 new message(s) for worker from boss@alpha arrived while you worked. Before stopping: mbx_inbox.";

/** A real daemon HTTP server, a leased OpenCode binding, and the generated plugin (v2 event stream) polling for its session. */
async function rig(t: { after: (fn: () => unknown) => void }, sid: string) {
  resetOpencodeWakeQueue();
  const home = mkdtempSync(join(tmpdir(), "mbx-t675-d-")), dir = mkdtempSync(join(tmpdir(), "mbx-t675-p-"));
  const node = new MbxNode(home, { host: "alpha" });
  const server = await startServer(node, 0, "127.0.0.1");
  const port = String((server.address() as AddressInfo).port);
  const prevPort = g.__mbxWakePort, real = opencodeHostSeams.args, prevDesk = process.env.MBX_NO_DESKTOP;
  g.__mbxWakePort = port;
  const spawned: string[] = [];
  // The stop hook would answer with a continuation reason; every other hook is quiet.
  g.__mbxSpawn = (_b, args, _i, cb) => { spawned.push(args[1]!); cb(args[1] === "stop" ? JSON.stringify({ decision: "block", reason: STOP_REASON }) : ""); };
  opencodeHostSeams.args = () => new Map([[process.pid, ["/usr/local/bin/opencode", "--standalone"]]]);
  process.env.MBX_NO_DESKTOP = "1";
  t.after(async () => { g.__mbxWakePort = prevPort; delete g.__mbxSpawn; opencodeHostSeams.args = real;
    if (prevDesk === undefined) delete process.env.MBX_NO_DESKTOP; else process.env.MBX_NO_DESKTOP = prevDesk;
    resetOpencodeWakeQueue(); await closeServer(server); node.close();
    rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); rmSync(dir, { recursive: true, force: true }); });
  bindWakeLease(node, { agent: "worker", cli: "opencode", session_id: sid, pid: process.pid });
  writeFileSync(join(dir, "agentmbx.ts"), opencodePluginSource(["/opt/bin/agentmbx"], version()));
  const mod = await import(join(dir, "agentmbx.ts")) as { default: { setup: (ctx: unknown) => Promise<() => void> } };
  const admitted: Note[] = [], queued: Note[] = [];
  const session = { synthetic: async (b: Note) => { (b.resume ? admitted : queued).push(b); return { id: b.id }; } };
  let toolHook: ((e: unknown) => unknown) | null = null;
  const events: { type: string; data: unknown }[] = [];
  let kick: (() => void) | null = null;
  const stop = await mod.default.setup({ session, location: { directory: "/work" },
    tool: { hook: (_n: string, fn: (e: unknown) => unknown) => { toolHook = fn; } },
    event: { subscribe: async function* ({ signal }: { signal: AbortSignal }) {
      while (!signal.aborted) {
        const next = events.shift();
        if (next) { yield next; continue; }
        await new Promise<void>((r) => { kick = r; setTimeout(r, 50); });
      }
    } } });
  t.after(() => stop());
  const emit = async (type: string) => { events.push({ type, data: { sessionID: sid } }); kick?.(); await until(() => events.length === 0); };
  const tool = async () => { await (toolHook as (e: unknown) => unknown)({ sessionID: sid, status: "completed", result: { content: "ok" } }); };
  const polling = () => until(() => listOpencodeWakeWaiters().some((w) => w.sessionID === sid && w.pid === process.pid));
  const send = (subject: string) => sendLeased(node, { from: "boss", to: ["worker"], subject, body: "b", kind: "request", needs_reply: true }).envelope;
  const state = (id: string) => (node.store.db.prepare("SELECT state FROM deliveries WHERE msg_id=? AND agent='worker'").get(id) as { state: string }).state;
  const attempts = () => (node.store.db.prepare("SELECT detail FROM audit WHERE event='wake.attempt' ORDER BY rowid").all() as { detail: string }[])
    .map((x) => (JSON.parse(x.detail) as { outcome: string }).outcome);
  const busy = () => JSON.parse(node.store.get("wake-busy:worker") ?? "null") as { n: number; next: number; at?: number } | null;
  return { node, port, spawned, admitted, queued, emit, tool, polling, send, state, attempts, busy };
}

/** A turn runs (execution started plus a tool call), and mail arrives in it: the dispatcher's offer is declined busy. */
async function midTurnMail(r: Awaited<ReturnType<typeof rig>>, subject: string) {
  await r.emit("session.execution.started");
  await r.tool();
  assert.equal(await r.polling(), true);
  const mail = r.send(subject);
  await dispatchWakes(r.node);
  assert.deepEqual(r.attempts().slice(-1), ["busy"]);
  assert.equal(r.state(mail.id), "delivered");
  const b = r.busy();
  assert.ok(b && b.next > Date.now() && typeof b.at === "number", "the busy record carries when it was set");
  return mail;
}

test("T675: a turn ending with unread mail gives one notice: the stop hook is skipped and the next pass wakes once, without the backoff", async (t) => {
  const r = await rig(t, "ses_one");
  const mail = await midTurnMail(r, "unread at the turn end");
  const before = r.spawned.length;
  await r.emit("session.execution.succeeded");
  assert.equal(await until(() => opencodeIdleAt("ses_one") !== undefined), true, "the plugin reported idle");
  assert.equal(r.spawned.slice(before).includes("stop"), false, "no stop hook spawn while the wake poll is live");
  assert.equal(r.queued.length, 0, "no queued stop note");
  assert.equal(await r.polling(), true);
  const pass = dispatchWakes(r.node); // the backoff (2 s) has not run out: only the idle report lets this pass through
  assert.equal(await until(() => r.admitted.length === 1), true, "woken on the next pass");
  await pass;
  assert.match(r.admitted[0]!.text, new RegExp(mail.id));
  assert.deepEqual(r.attempts(), ["busy", "admitted"]);
  assert.equal(r.state(mail.id), "notified");
  assert.equal(r.busy(), null, "an admitted wake clears the backoff");
  assert.deepEqual(await dispatchWakes(r.node), [], "and nothing is offered twice");
  assert.equal(r.admitted.length, 1);
});

test("T675: mail handled during the turn: the idle report wakes nothing (the pass keeps its usual checks)", async (t) => {
  const r = await rig(t, "ses_handled");
  const mail = await midTurnMail(r, "handled in the turn");
  r.node.markRead([r.node.message(mail.id, "worker")!], "worker");
  r.node.ack(mail.id, "worker");
  await r.emit("session.execution.succeeded");
  assert.equal(await until(() => opencodeIdleAt("ses_handled") !== undefined), true);
  assert.deepEqual(await dispatchWakes(r.node), []);
  assert.equal(r.admitted.length, 0);
  assert.equal(r.queued.length, 0);
  assert.deepEqual(r.attempts(), ["busy"]);
});

test("T675: an interrupted or failed turn reports idle too, and the next pass wakes for mail still unhandled", async (t) => {
  for (const end of ["session.execution.interrupted", "session.execution.failed"]) {
    const sid = `ses_${end.split(".").pop()}`;
    const r = await rig(t, sid);
    const mail = await midTurnMail(r, `before ${end}`);
    await r.emit(end);
    assert.equal(await until(() => opencodeIdleAt(sid) !== undefined), true, end);
    assert.equal(await r.polling(), true);
    const pass = dispatchWakes(r.node);
    assert.equal(await until(() => r.admitted.length === 1), true, end);
    await pass;
    assert.match(r.admitted[0]!.text, new RegExp(mail.id));
  }
});

test("T675: when the daemon does not take the idle report, the turn end runs the stop hook as before", async (t) => {
  const r = await rig(t, "ses_down");
  await midTurnMail(r, "daemon unreachable at the turn end");
  g.__mbxWakePort = "1"; // nothing listens there: the idle POST fails
  const before = r.spawned.length;
  await r.emit("session.execution.succeeded");
  assert.equal(await until(() => r.spawned.slice(before).includes("stop")), true, "the stop hook is the fallback");
  assert.equal(await until(() => r.queued.some((n) => n.text === STOP_REASON)), true, "and its note is queued as before");
  assert.equal(opencodeIdleAt("ses_down"), undefined);
});

test("T675: a busy record without `at` (written by an older daemon) keeps its backoff after an idle report", async (t) => {
  const r = await rig(t, "ses_old");
  await midTurnMail(r, "older busy record");
  const b = r.busy()!;
  r.node.store.set("wake-busy:worker", JSON.stringify({ n: b.n, next: Date.now() + 60_000 }));
  await r.emit("session.execution.succeeded");
  assert.equal(await until(() => opencodeIdleAt("ses_old") !== undefined), true);
  assert.deepEqual(await dispatchWakes(r.node), [], "still backing off");
  assert.equal(r.admitted.length, 0);
});

test("T675 queue: idle needs no offered slot, settles none, and admits nothing; any session is harmless", async () => {
  resetOpencodeWakeQueue();
  try {
    assert.equal(completeOpencodeWake("ses_nobody", OPENCODE_WAKE_IDLE), true, "no lease, no poll: recorded, nothing else");
    assert.equal(typeof opencodeIdleAt("ses_nobody"), "number");
    const waiting = waitForOpencodeWake("ses_q", 7, 2_000);
    const pushed = pushOpencodeWake("ses_q", 7, "hello", 1_000);
    assert.equal(await waiting, "hello");
    assert.equal(completeOpencodeWake("ses_q", OPENCODE_WAKE_IDLE, null, 7), true);
    assert.equal(completeOpencodeWake("ses_q", "msg_real", null, 7), true, "the offered wake is still waiting for its receipt");
    assert.deepEqual(await pushed, { ok: true, id: "msg_real", turnSince: null });
  } finally { resetOpencodeWakeQueue(); }
});
