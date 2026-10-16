// T647: OpenCode showed "[mbx] N new message(s)" for mail the agent had already read and acked. A wake admitted while the session
// was mid-turn sat in OpenCode's queue (delivery "queue") until the turn ended, and the agent had handled that mail meanwhile
// through the post-tool notice. The plugin now declines a mid-turn wake as busy: nothing is admitted, the mail stays delivered,
// and the next pass after the turn wakes only for mail that is still unhandled.
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
import { dispatchWakes, OPENCODE_MIDTURN_BUSY, wakeOpencode } from "../src/wake.ts";
import { opencodeHostSeams } from "../src/opencode-provider.ts";
import {
  completeOpencodeWake, listOpencodeWakeWaiters, OPENCODE_WAKE_BUSY, pushOpencodeWake, resetOpencodeWakeQueue, waitForOpencodeWake,
} from "../src/opencode-wake-queue.ts";
import { version } from "../src/version.ts";
import { bindWakeLease } from "./helpers/wake-lease.ts";
import { sendLeased } from "./helpers/leased-send.ts";

type Note = { sessionID: string; id: string; text: string; resume: boolean; delivery: string };
type Spawn = (bin: string[], args: string[], input: string, cb: (out: string) => void) => void;
const g = globalThis as { __mbxSpawn?: Spawn; __mbxWakePort?: string | null };
const noFetch = (async () => { throw new Error("the shared service must not be called"); }) as typeof fetch;
const noService = async () => { throw new Error("service discovery must not run"); };
const until = async (pred: () => boolean, ms = 2_000) => { const end = Date.now() + ms; while (Date.now() < end) { if (pred()) return true; await new Promise((r) => setTimeout(r, 10)); } return pred(); };
const closeServer = (s: HttpServer) => new Promise<void>((r) => { s.closeAllConnections?.(); s.close(() => r()); });

/** A real daemon HTTP server and the generated plugin polling it for its own sessions (this process is the serve). */
async function rig(t: { after: (fn: () => unknown) => void }) {
  resetOpencodeWakeQueue();
  const home = mkdtempSync(join(tmpdir(), "mbx-t647-d-")), dir = mkdtempSync(join(tmpdir(), "mbx-t647-p-"));
  const node = new MbxNode(home, { host: "alpha" });
  const server = await startServer(node, 0, "127.0.0.1");
  const prevPort = g.__mbxWakePort, real = opencodeHostSeams.args, prevDesk = process.env.MBX_NO_DESKTOP;
  g.__mbxWakePort = String((server.address() as AddressInfo).port);
  g.__mbxSpawn = (_b, _a, _i, cb) => cb("");
  opencodeHostSeams.args = () => new Map([[process.pid, ["/usr/local/bin/opencode", "--standalone"]]]);
  process.env.MBX_NO_DESKTOP = "1";
  t.after(async () => { g.__mbxWakePort = prevPort; delete g.__mbxSpawn; opencodeHostSeams.args = real;
    if (prevDesk === undefined) delete process.env.MBX_NO_DESKTOP; else process.env.MBX_NO_DESKTOP = prevDesk;
    resetOpencodeWakeQueue(); await closeServer(server); node.close();
    rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); rmSync(dir, { recursive: true, force: true }); });
  writeFileSync(join(dir, "agentmbx.ts"), opencodePluginSource(["/opt/bin/agentmbx"], version()));
  const mod = await import(join(dir, "agentmbx.ts")) as { AgentMBXHooks: (ctx: unknown) => Promise<Record<string, (...a: unknown[]) => Promise<void>>> };
  const admitted: Note[] = [];
  const session = { synthetic: async (b: Note) => { if (b.resume) admitted.push(b); return { id: b.id }; } };
  const hooks = await mod.AgentMBXHooks({ directory: "/work", session });
  // The v2 entry point with a hand-fed event stream (OpenCode 2.x turn events: started, then succeeded | interrupted | failed).
  const queue: { type: string; data: unknown }[] = [];
  let wakeStream: (() => void) | null = null;
  const v2 = mod as unknown as { default: { setup: (ctx: unknown) => Promise<() => void> } };
  const stop = await v2.default.setup({ session, location: { directory: "/work" }, tool: { hook: () => undefined },
    event: { subscribe: async function* ({ signal }: { signal: AbortSignal }) {
      while (!signal.aborted) {
        const next = queue.shift();
        if (next) { yield next; continue; }
        await new Promise<void>((r) => { wakeStream = r; setTimeout(r, 50); });
      }
    } } });
  t.after(() => stop());
  const emit = async (type: string, sid: string) => { queue.push({ type, data: { sessionID: sid } }); wakeStream?.(); await until(() => queue.length === 0); await new Promise((r) => setTimeout(r, 20)); };
  const polling = (sid: string) => until(() => listOpencodeWakeWaiters().some((w) => w.sessionID === sid && w.pid === process.pid));
  const midTurn = (sid: string) => hooks["tool.execute.after"]({ sessionID: sid }, { output: "" });
  const turnEnds = (sid: string) => hooks.event({ event: { type: "session.idle", properties: { info: { id: sid } } } });
  return { node, admitted, polling, midTurn, turnEnds, emit };
}

test("T647: mid-turn the plugin declines the offered wake as busy, admits nothing, and takes the next one after the turn", async (t) => {
  const r = await rig(t);
  const wake = (text: string) => wakeOpencode("ses_turn", text, { pid: process.pid, host: () => "standalone", service: noService, fetch: noFetch });
  await r.midTurn("ses_turn");
  assert.equal(await r.polling("ses_turn"), true);
  const busy = await wake("[mbx] 1 new message(s) for worker (ids A)");
  assert.equal(busy.ok, false);
  assert.equal(busy.outcome?.kind, "busy");
  assert.equal(busy.error, OPENCODE_MIDTURN_BUSY);
  assert.equal((busy as { retry?: boolean }).retry, true, "busy is a retry: the dispatcher keeps the mail delivered");
  assert.equal(r.admitted.length, 0, "nothing was put into OpenCode's queue");
  await r.turnEnds("ses_turn");
  assert.equal(await r.polling("ses_turn"), true, "the plugin keeps polling");
  const idle = await wake("[mbx] 1 new message(s) for worker (ids B)");
  assert.equal(idle.outcome?.kind, "admitted", JSON.stringify(idle));
  assert.deepEqual(r.admitted.map((n) => n.text), ["[mbx] 1 new message(s) for worker (ids B)"]);
});

test("T647: mail acked during the turn is not alerted after it; mail still unhandled is", async (t) => {
  const r = await rig(t);
  bindWakeLease(r.node, { agent: "worker", cli: "opencode", session_id: "ses_disp", pid: process.pid });
  const state = (id: string) => (r.node.store.db.prepare("SELECT state FROM deliveries WHERE msg_id=? AND agent='worker'").get(id) as { state: string }).state;
  const attempts = () => (r.node.store.db.prepare("SELECT detail FROM audit WHERE event='wake.attempt' ORDER BY rowid").all() as { detail: string }[])
    .map((x) => (JSON.parse(x.detail) as { outcome: string }).outcome);
  const nextPass = () => { r.node.store.db.prepare("DELETE FROM kv WHERE k GLOB 'wake-busy:*'").run(); r.node.store.db.prepare("DELETE FROM wakes").run(); };

  await r.midTurn("ses_disp");
  assert.equal(await r.polling("ses_disp"), true);
  const handled = sendLeased(r.node, { from: "boss", to: ["worker"], subject: "handled in the turn", body: "b", kind: "request", needs_reply: true }).envelope;
  const [first] = await dispatchWakes(r.node);
  assert.equal(first?.result.ok, false);
  assert.equal(first?.result.via, "opencode synthetic");
  assert.deepEqual(attempts(), ["busy"]);
  assert.equal(state(handled.id), "delivered", "a declined wake leaves the mail delivered, not notified");
  assert.equal(r.admitted.length, 0);

  // the agent sees it through the post-tool notice and handles it within the same turn
  r.node.markRead([r.node.message(handled.id, "worker")!], "worker");
  r.node.ack(handled.id, "worker");
  await r.turnEnds("ses_disp");
  assert.equal(await r.polling("ses_disp"), true);
  nextPass();
  assert.deepEqual(await dispatchWakes(r.node), [], "nothing left to wake for");
  assert.equal(r.admitted.length, 0, "no stale alert for mail acked during the turn");

  // mail that arrived and was not handled during a turn still wakes the idle session afterwards, once
  await r.midTurn("ses_disp");
  const pending = sendLeased(r.node, { from: "boss", to: ["worker"], subject: "not handled yet", body: "b", kind: "request", needs_reply: true }).envelope;
  await dispatchWakes(r.node);
  assert.equal(state(pending.id), "delivered");
  await r.turnEnds("ses_disp");
  assert.equal(await r.polling("ses_disp"), true);
  nextPass();
  const offered = dispatchWakes(r.node);
  assert.equal(await until(() => r.admitted.length === 1), true, "the idle session is woken");
  assert.match(r.admitted[0]!.text, new RegExp(pending.id));
  assert.equal(r.admitted[0]!.text.includes(handled.id), false, "and only for the unhandled mail");
  await offered;
  assert.equal(state(pending.id), "notified");
});

for (const end of ["session.execution.interrupted", "session.execution.failed"]) {
  test(`T647: a turn that ends with ${end} (no succeeded, no idle) ends the decline; the next wake is admitted`, async (t) => {
    const r = await rig(t), sid = `ses_${end.split(".").pop()}`; // a session per case: an earlier rig's poll loop may outlive its test
    const wake = (text: string) => wakeOpencode(sid, text, { pid: process.pid, host: () => "standalone", service: noService, fetch: noFetch });
    await r.emit("session.execution.started", sid);
    await r.midTurn(sid); // the first tool call also starts the session's wake poll
    assert.equal(await r.polling(sid), true);
    assert.equal((await wake("[mbx] 1 new message(s) for worker (ids A)")).outcome?.kind, "busy", "mid-turn: declined");
    await r.emit(end, sid); // Esc or an error: OpenCode 2.x sends only this
    assert.equal(await r.polling(sid), true);
    const after = await wake("[mbx] 1 new message(s) for worker (ids B)");
    assert.equal(after.outcome?.kind, "admitted", JSON.stringify(after));
    assert.deepEqual(r.admitted.map((n) => n.text), ["[mbx] 1 new message(s) for worker (ids B)"]);
  });
}

test("T647 queue: a busy receipt settles the offer without admission; it needs an offered slot", async () => {
  resetOpencodeWakeQueue();
  try {
    assert.equal(completeOpencodeWake("ses_b", OPENCODE_WAKE_BUSY), false, "no offered wake: refused");
    const waiting = waitForOpencodeWake("ses_b", 7, 2_000);
    const pushed = pushOpencodeWake("ses_b", 7, "hello", 1_000);
    assert.equal(await waiting, "hello");
    assert.equal(completeOpencodeWake("ses_b", OPENCODE_WAKE_BUSY), true);
    assert.deepEqual(await pushed, { ok: false, handedOff: false, busy: true });
    assert.equal(completeOpencodeWake("ses_b", "msg_late"), false, "the declined offer is settled");
  } finally { resetOpencodeWakeQueue(); }
});
