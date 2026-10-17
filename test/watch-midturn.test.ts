// T667: a watcher-exit wake that lands while a Kimi turn is running is dropped by the harness (the
// background-task completion is not queued). The wake must not be lost with it: the pending mail
// surfaces when the current turn ends (the Stop continuation) or at the next prompt.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { MbxNode } from "../src/node.ts";
import { dispatchWakes, liveWatcher } from "../src/wake.ts";
import { delegateWake } from "./helpers/wake-lease.ts";
import { sendLeased } from "./helpers/leased-send.ts";

const until = async (ok: () => boolean, ms = 10_000) => { for (const end = Date.now() + ms; !ok() && Date.now() < end;) await new Promise(r => setTimeout(r, 50)); return ok(); };

type HookResult = { status: number | null; stdout: string; stderr: string };
type World = { n: MbxNode; c: Client; home: string; env: Record<string, string>; hook: (event: string, extra?: Record<string, unknown>, envExtra?: Record<string, string>) => HookResult };
async function world(t: { after: (fn: () => unknown) => unknown }): Promise<World> {
  const home = mkdtempSync(join(tmpdir(), "mbx-midturn-"));
  const n = new MbxNode(home, { host: "alpha" }), c = new Client({ name: "midturn", version: "1" });
  t.after(async () => { await c.close(); n.close(); rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
  const env = { ...process.env, AGENTMBX_DEV: "1", MBX_HOME: home, MBX_CLI: "kimi", MBX_AGENT: "worker", MBX_NO_DESKTOP: "1", MBX_DEBUG: "" } as Record<string, string>;
  await c.connect(new StdioClientTransport({ command: process.execPath, args: [resolve("bin/agentmbx.js"), "mcp"], env }));
  delegateWake(n, "worker");
  const hook = (event: string, extra: Record<string, unknown> = {}, envExtra: Record<string, string> = {}): HookResult => {
    const r = spawnSync(process.execPath, [resolve("bin/agentmbx.js"), "hook", event, "--cli", "kimi"],
      { input: JSON.stringify({ session_id: "kimi-midturn-1", cwd: process.cwd(), ...extra }), encoding: "utf8", timeout: 10_000,
        env: { ...env, MBX_AGENT: "unrelated", ...envExtra } });
    return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
  };
  const bind = hook("prompt", { prompt: "hi" });
  assert.equal(bind.status, 0, bind.stderr);
  return { n, c, home, env, hook };
}

const arm = (w: World, t: { after: (fn: () => unknown) => unknown }) => {
  const child = spawn(process.execPath, [resolve("bin/agentmbx.js"), "watch", "--cli", "kimi", "--session", "kimi-midturn-1"],
    { env: { ...w.env, MBX_AGENT: "", MBX_WATCH_INTERVAL_MS: "200" } });
  let hint = ""; child.stdout.on("data", d => { hint += d; });
  const exited = new Promise<number | null>(r => child.on("exit", r));
  t.after(() => { child.kill(); });
  return { child, hint: () => hint, exited };
};

test("T667 AC1: a watcher-exit wake dropped mid-turn starts no turn of its own and the daemon does not re-drive it", async (t) => {
  const w = await world(t);
  const watcher = arm(w, t);
  assert.ok(await until(() => liveWatcher(w.n, "worker")), "the watcher registers");
  const m = sendLeased(w.n, { from: "boss", to: ["worker"], subject: "midturn", body: "secret body", kind: "request", needs_reply: true }).envelope;
  assert.equal(await watcher.exited, 0, "the watcher exits on the wanted mail");
  assert.match(watcher.hint(), /^\[mbx\] 1 new message\(s\) for worker/);
  assert.ok(watcher.hint().includes(m.id) && !watcher.hint().includes("secret body"), "ids only, never bodies");
  // The Kimi harness drops the background-task completion that arrives mid-turn: this test asserts
  // the store side of that drop — the wake was spent on an exit nobody observed.
  assert.equal(liveWatcher(w.n, "worker"), false, "an exited watcher no longer holds wakes back");
  const state = () => (w.n.store.db.prepare("SELECT state, note FROM deliveries WHERE msg_id=? AND agent='worker'").get(m.id) as { state: string; note: string | null }).state;
  assert.equal(state(), "notified", "the watcher reported the mail");
  const pass = await dispatchWakes(w.n);
  assert.equal(pass.filter(r => r.agent === "worker").length, 0, "the daemon does not re-drive a wake the watcher already spent");
  assert.equal(state(), "notified", "the dropped wake left the mail reported, not requeued");
});

test("T667 AC2: the dropped wake surfaces when the running turn ends (Stop continues exactly once), then stays quiet once handled", async (t) => {
  const w = await world(t);
  const watcher = arm(w, t);
  assert.ok(await until(() => liveWatcher(w.n, "worker")), "the watcher registers");
  const m = sendLeased(w.n, { from: "boss", to: ["worker"], subject: "midturn", body: "secret body", kind: "request", needs_reply: true }).envelope;
  assert.equal(await watcher.exited, 0, "the watcher exits; the harness drops the mid-turn completion");
  // The running turn ends: Stop must continue it for the dropped wake, naming the sender (ids stay in the watcher hint).
  const stop = w.hook("stop");
  assert.equal(stop.status, 2, `Stop continues the turn: ${stop.stderr}`);
  assert.match(stop.stderr, /1 new message\(s\) for worker from boss@alpha arrived while you worked/);
  assert.doesNotMatch(stop.stderr, /secret body/, "never bodies");
  // The agent handled the mail in the continued turn (read, not yet acked): the next Stop stays quiet.
  w.n.store.db.prepare("UPDATE deliveries SET state='read' WHERE msg_id=? AND agent='worker'").run(m.id);
  const quiet = w.hook("stop");
  assert.equal(quiet.status, 0, quiet.stderr);
  assert.equal(quiet.stderr, "", "handled mail does not block Stop twice");
});

test("T667 AC2: with the Stop digest on, mid-turn mail Stop does not cover surfaces at the next prompt instead", async (t) => {
  const w = await world(t);
  const watcher = arm(w, t);
  assert.ok(await until(() => liveWatcher(w.n, "worker")), "the watcher registers");
  const m = sendLeased(w.n, { from: "boss", to: ["worker"], subject: "midturn", body: "secret body", kind: "message", needs_reply: true }).envelope;
  assert.equal(await watcher.exited, 0, "the watcher exits; the harness drops the mid-turn completion");
  // Digest mode: only request/task/decision/alert continue Stop; a needs-reply message waits for the prompt.
  // The exit 2 here is the bounded watcher re-arm nag (no live watcher), not a mail continuation.
  const stop = w.hook("stop", {}, { MBX_STOP_DIGEST: "1" });
  assert.equal(stop.status, 2, `the watcher nag exits 2: ${stop.stderr}`);
  assert.doesNotMatch(stop.stderr, /arrived while you worked/, "digest Stop does not continue the turn for a message kind");
  const prompt = w.hook("prompt", { prompt: "the owner typed a new turn" });
  assert.equal(prompt.status, 0, prompt.stderr);
  assert.match(prompt.stdout + prompt.stderr, /1 unread for worker@alpha: mbx_inbox/, "the next prompt names the still-unread mail");
  assert.ok(!(prompt.stdout + prompt.stderr).includes("secret body"), "never bodies");
});

test("T667: mail landing during an exit-2 continuation turn is requeued once and reaches the next turn without an owner prompt", { timeout: 90_000 }, async (t) => {
  const w = await world(t);
  const marker = () => w.n.store.get("watch-reported:worker") ?? null;
  const audit = () => (w.n.store.db.prepare("SELECT detail FROM audit WHERE event='wake.reenqueue'").all() as { detail: string }[]).length;
  const state = (id: string) => (w.n.store.db.prepare("SELECT state FROM deliveries WHERE msg_id=? AND agent='worker'").get(id) as { state: string }).state;

  // m1 lands mid-turn; its watcher exit is dropped; the turn ends and Stop continues for it.
  const w1 = arm(w, t);
  assert.ok(await until(() => liveWatcher(w.n, "worker")));
  const m1 = sendLeased(w.n, { from: "boss", to: ["worker"], subject: "one", body: "s1", kind: "request", needs_reply: true }).envelope;
  assert.equal(await w1.exited, 0, "w1 exits on m1; the harness drops the completion");
  assert.ok(marker(), "the dropped exit left a marker");
  const stop1 = w.hook("stop");
  assert.equal(stop1.status, 2, "Stop continues for m1");
  assert.equal(state(m1.id), "notified");
  // the continuation turn handled m1 and re-armed the watcher; m2 lands mid-continuation and its exit is dropped too
  w.n.store.db.prepare("UPDATE deliveries SET state='read' WHERE msg_id=? AND agent='worker'").run(m1.id);
  assert.equal(marker(), null, "the Stop that surfaced m1 reconciled the marker");
  const w2 = arm(w, t);
  assert.ok(await until(() => liveWatcher(w.n, "worker")));
  const m2 = sendLeased(w.n, { from: "boss", to: ["worker"], subject: "two", body: "s2", kind: "request", needs_reply: true }).envelope;
  assert.equal(await w2.exited, 0, "w2 exits on m2; the harness drops the completion (no second Stop fires)");

  // the turn ended without surfacing m2; once the brake window the watcher's exit spent has passed,
  // the daemon requeues m2 once, and the session's next watcher reports it: no owner prompt involved.
  w.n.store.db.prepare("DELETE FROM wakes").run(); // test-only: expire the 30 s batching window
  const pass = await dispatchWakes(w.n);
  assert.equal(audit(), 1, "exactly one re-drive");
  assert.equal(marker(), null, "the requeue consumed the marker");
  assert.ok(state(m2.id) === "delivered" || state(m2.id) === "notified", "m2 re-entered the normal wake pool");
  w.n.store.db.prepare("DELETE FROM wakes").run(); // the re-drive pass spent its own brake window; let the next watcher report now
  const w3 = arm(w, t);
  const deadline = Date.now() + 10_000;
  let hint = "";
  w3.child.stdout.on("data", d => { hint += d; });
  while (Date.now() < deadline && !hint.includes(m2.id)) await new Promise(r => setTimeout(r, 100));
  assert.ok(hint.includes(m2.id), `the next watcher reports the requeued mail: ${JSON.stringify(hint)}`);
  assert.ok(!hint.includes("s2"), "ids only, never bodies");
  assert.equal(await w3.exited, 0, "the reporting watcher exits to start that turn");
});

test("T667: exactly one re-drive per message, and none while a live watcher would report it", { timeout: 90_000 }, async (t) => {
  const w = await world(t);
  const audit = () => (w.n.store.db.prepare("SELECT detail FROM audit WHERE event='wake.reenqueue'").all() as { detail: string }[]).length;
  const state = (id: string) => (w.n.store.db.prepare("SELECT state FROM deliveries WHERE msg_id=? AND agent='worker'").get(id) as { state: string }).state;

  const w1 = arm(w, t);
  assert.ok(await until(() => liveWatcher(w.n, "worker")));
  const m = sendLeased(w.n, { from: "boss", to: ["worker"], subject: "one", body: "s", kind: "request", needs_reply: true }).envelope;
  assert.equal(await w1.exited, 0, "w1 exits; the completion is dropped");

  // a live watcher holds the mail back: the daemon defers, no re-drive
  const w2 = arm(w, t);
  assert.ok(await until(() => liveWatcher(w.n, "worker")));
  w.n.store.db.prepare("DELETE FROM wakes").run();
  await dispatchWakes(w.n);
  assert.equal(audit(), 0, "no re-drive while a live watcher owns the wake path");
  assert.equal(state(m.id), "notified", "the mail stays reported, not flipped under a live watcher");
  w2.child.kill();

  // watcher gone, brake window expired: the first pass requeues exactly once
  assert.ok(await until(() => !liveWatcher(w.n, "worker"), 20_000));
  await dispatchWakes(w.n);
  assert.equal(audit(), 1, "the first eligible pass re-drives once");
  assert.equal(w.n.store.get("watch-reported:worker") ?? null, null, "the marker is consumed with the requeue");
  const after = state(m.id);
  assert.ok(after === "delivered" || after === "notified", "m re-entered the normal wake pool");
  // a later pass never re-drives the same message again
  await dispatchWakes(w.n);
  assert.equal(audit(), 1, "no second re-drive for the same message");
});

test("T667: no re-drive for mail read or acked before the turn ended, and never alongside a Stop continuation", { timeout: 90_000 }, async (t) => {
  const w = await world(t);
  const audit = () => (w.n.store.db.prepare("SELECT detail FROM audit WHERE event='wake.reenqueue'").all() as { detail: string }[]).length;

  // handled mail: read before any re-drive, the marker is pruned without requeueing
  const w1 = arm(w, t);
  assert.ok(await until(() => liveWatcher(w.n, "worker")));
  const m1 = sendLeased(w.n, { from: "boss", to: ["worker"], subject: "read case", body: "s", kind: "request", needs_reply: true }).envelope;
  assert.equal(await w1.exited, 0);
  w.n.store.db.prepare("UPDATE deliveries SET state='read' WHERE msg_id=? AND agent='worker'").run(m1.id);
  w.n.store.db.prepare("DELETE FROM wakes").run();
  await dispatchWakes(w.n);
  assert.equal(audit(), 0, "read mail is not re-driven");
  assert.equal(w.n.store.get("watch-reported:worker") ?? null, null, "read mail left the marker");

  // Stop-surfaced mail: the continuation owns it; the daemon must not also re-drive it
  const w2 = arm(w, t);
  assert.ok(await until(() => liveWatcher(w.n, "worker")));
  const m2 = sendLeased(w.n, { from: "boss", to: ["worker"], subject: "stop case", body: "s", kind: "request", needs_reply: true }).envelope;
  assert.equal(await w2.exited, 0);
  assert.ok(w.n.store.get("watch-reported:worker"), "m2 is marked after its dropped exit");
  const stop = w.hook("stop");
  assert.equal(stop.status, 2, "Stop continues for m2: the single surface");
  assert.equal(w.n.store.get("watch-reported:worker") ?? null, null, "surfacing m2 reconciled the marker");
  w.n.store.db.prepare("DELETE FROM wakes").run();
  await dispatchWakes(w.n);
  assert.equal(audit(), 0, "the re-drive never double-fires alongside the Stop continuation");
});

