// T681 (run 2 of the v0.5.42 live round): busy declines mid-turn, then one offer whose receipt never comes back (lost-response,
// outcome unknown), then the turn ends. `unknown` sets the delivery to notified/unknown for UNKNOWN_HOLD_MS (10 min), and T675
// skips the stop note when the session reports idle, so nothing surfaced the mail after the turn. The idle report now also
// reconciles that session's unknown-held mail, so the next normal pass wakes exactly once.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import type { Server as HttpServer } from "node:http";
import { MbxNode } from "../src/node.ts";
import { startServer } from "../src/http.ts";
import { opencodePluginSource } from "../src/setup.ts";
import { version } from "../src/version.ts";
import { dispatchWakes } from "../src/wake.ts";
import { opencodeHostSeams } from "../src/opencode-provider.ts";
import {
  completeOpencodeWake, listOpencodeWakeWaiters, OPENCODE_WAKE_BUSY, OPENCODE_WAKE_IDLE, opencodeWakeWaiting, resetOpencodeWakeQueue, waitForOpencodeWake,
} from "../src/opencode-wake-queue.ts";
import { bindWakeLease } from "./helpers/wake-lease.ts";
import { sendLeased } from "./helpers/leased-send.ts";

const SID = "ses_run2";

/** A scripted standalone serve poller: each offer is answered from the script ("busy", "lose" = never answer, "admit"). */
function poller(script: string[]) {
  const offers: string[] = [];
  let stop = false;
  void (async () => {
    while (!stop) {
      const text = await waitForOpencodeWake(SID, process.pid, 500);
      if (stop) return;
      if (!text) { await new Promise((r) => setTimeout(r, 20)); continue; } // a still-offered slot answers null at once
      offers.push(text);
      const step = script.shift() ?? "admit";
      if (step === "busy") completeOpencodeWake(SID, OPENCODE_WAKE_BUSY, null, process.pid);
      else if (step === "admit") completeOpencodeWake(SID, `msg_${offers.length}`, null, process.pid);
      // "lose": the plugin took the text, but its receipt POST never arrives
    }
  })();
  return { offers, stop: () => { stop = true; } };
}

test("T681: busy declines, a lost-response offer, then the turn ends: the idle report brings exactly one post-turn wake", { timeout: 60_000 }, async (t) => {
  resetOpencodeWakeQueue();
  const home = mkdtempSync(join(tmpdir(), "mbx-t681-")), node = new MbxNode(home, { host: "alpha" });
  const real = opencodeHostSeams.args, prevDesk = process.env.MBX_NO_DESKTOP;
  opencodeHostSeams.args = () => new Map([[process.pid, ["/usr/local/bin/opencode", "--standalone"]]]);
  process.env.MBX_NO_DESKTOP = "1";
  const p = poller(["busy", "busy", "lose"]);
  t.after(() => { p.stop(); opencodeHostSeams.args = real; if (prevDesk === undefined) delete process.env.MBX_NO_DESKTOP; else process.env.MBX_NO_DESKTOP = prevDesk;
    resetOpencodeWakeQueue(); node.close(); rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); });
  bindWakeLease(node, { agent: "worker", cli: "opencode", session_id: SID, pid: process.pid });
  const mail = sendLeased(node, { from: "boss", to: ["worker"], subject: "mid-turn", body: "b", kind: "request", needs_reply: true }).envelope;
  const state = () => node.store.db.prepare("SELECT state, note FROM deliveries WHERE msg_id=? AND agent='worker'").get(mail.id) as { state: string; note: string | null };
  const attempts = () => (node.store.db.prepare("SELECT detail FROM audit WHERE event='wake.attempt' ORDER BY rowid").all() as { detail: string }[])
    .map((x) => (JSON.parse(x.detail) as { outcome: string }).outcome);
  const polling = async () => { for (let i = 0; i < 200 && !opencodeWakeWaiting(SID, process.pid); i++) await new Promise((r) => setTimeout(r, 10)); };
  const pass = async () => { await polling(); node.store.db.prepare("DELETE FROM kv WHERE k GLOB 'wake-busy:*'").run(); node.store.db.prepare("DELETE FROM wakes").run(); await dispatchWakes(node); };

  await pass(); await pass(); // mid-turn: declined twice
  assert.deepEqual(attempts(), ["busy", "busy"]);
  await pass();               // the third offer is taken and its receipt is lost (5 s receipt wait)
  assert.deepEqual(attempts(), ["busy", "busy", "unknown"]);
  assert.deepEqual({ ...state() }, { state: "notified", note: "unknown" }, "held for UNKNOWN_HOLD_MS");

  // the turn ends: the plugin reports idle (T675), and the stop note is skipped
  assert.equal(completeOpencodeWake(SID, OPENCODE_WAKE_IDLE), true);
  await pass();
  assert.deepEqual(attempts(), ["busy", "busy", "unknown", "admitted"], "the post-turn wake still happens");
  assert.equal(p.offers.length, 4);
  assert.match(p.offers[3]!, new RegExp(mail.id));
  assert.equal(state().state, "notified");
  await pass();
  assert.deepEqual(attempts(), ["busy", "busy", "unknown", "admitted"], "exactly one");
});

type Spawn = (bin: string[], args: string[], input: string, cb: (out: string) => void) => void;
const g = globalThis as { __mbxSpawn?: Spawn; __mbxWakePort?: string | null };
const until = async (pred: () => boolean, ms = 3_000) => { const end = Date.now() + ms; while (Date.now() < end) { if (pred()) return true; await new Promise((r) => setTimeout(r, 10)); } return pred(); };

test("T681 AC3: the plugin logs a failed wake HTTP call to MBX_HOME/logs/opencode-plugin.log, at most once per kind in 10 s", { timeout: 60_000 }, async (t) => {
  resetOpencodeWakeQueue();
  const home = mkdtempSync(join(tmpdir(), "mbx-t681-log-")), dir = mkdtempSync(join(tmpdir(), "mbx-t681-p-"));
  const node = new MbxNode(home, { host: "alpha" });
  const server = await startServer(node, 0, "127.0.0.1");
  const prevPort = g.__mbxWakePort, prevHome = process.env.MBX_HOME, real = opencodeHostSeams.args;
  g.__mbxWakePort = String((server.address() as AddressInfo).port);
  g.__mbxSpawn = (_b, _a, _i, cb) => cb("");
  process.env.MBX_HOME = home;
  opencodeHostSeams.args = () => new Map([[process.pid, ["/usr/local/bin/opencode", "--standalone"]]]);
  t.after(async () => { g.__mbxWakePort = prevPort; delete g.__mbxSpawn; opencodeHostSeams.args = real;
    if (prevHome === undefined) delete process.env.MBX_HOME; else process.env.MBX_HOME = prevHome;
    resetOpencodeWakeQueue(); await new Promise<void>((r) => { (server as HttpServer).closeAllConnections?.(); server.close(() => r()); }); node.close();
    rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); rmSync(dir, { recursive: true, force: true }); });
  writeFileSync(join(dir, "agentmbx.ts"), opencodePluginSource(["/opt/bin/agentmbx"], version()));
  const mod = await import(join(dir, "agentmbx.ts")) as { default: { setup: (ctx: unknown) => Promise<() => void> } };
  const events: { type: string; data: unknown }[] = [];
  const hooks: ((e: unknown) => unknown)[] = [];
  const stop = await mod.default.setup({ session: { synthetic: async (b: { id: string }) => ({ id: b.id }) }, location: { directory: "/work" },
    tool: { hook: (_n: string, fn: (e: unknown) => unknown) => { hooks.push(fn); } },
    event: { subscribe: async function* ({ signal }: { signal: AbortSignal }) {
      while (!signal.aborted) { const next = events.shift(); if (next) { yield next; continue; } await new Promise((r) => setTimeout(r, 20)); }
    } } });
  t.after(() => stop());
  const emit = async (type: string) => { events.push({ type, data: { sessionID: "ses_log" } }); await until(() => events.length === 0); };
  await emit("session.execution.started");
  await hooks[0]!({ sessionID: "ses_log", status: "completed", result: { content: "ok" } });
  assert.equal(await until(() => listOpencodeWakeWaiters().some((w) => w.sessionID === "ses_log")), true, "the wake poll is live");
  const log = join(home, "logs", "opencode-plugin.log");
  assert.equal(existsSync(log), false, "nothing to log while every call succeeds");
  g.__mbxWakePort = "1"; // the daemon is unreachable from here on: the turn end's idle POST fails
  await emit("session.execution.succeeded");
  const idleLines = () => existsSync(log) ? readFileSync(log, "utf8").split("\n").filter((l) => / idle session=ses_log pid=\d+ /.test(l)) : [];
  assert.equal(await until(() => idleLines().length === 1), true, "one line for the failed idle receipt");
  assert.match(idleLines()[0]!, /^\d{4}-\d\d-\d\dT[\d:.]+Z idle session=ses_log pid=\d+ \S/);
  await emit("session.execution.started");
  await emit("session.execution.interrupted"); // a second failed idle POST inside 10 s
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(idleLines().length, 1, "rate-limited per kind");
});
