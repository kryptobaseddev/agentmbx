// T033: a session with no external wake API (Kimi Code terminal) wakes itself with a background `agentmbx watch`,
// which exits with a no-body hint when mail that wants it arrives. While it runs the daemon defers to it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { MbxNode } from "../src/node.ts";
import { IdentityLeases } from "../src/identity-leases.ts";
import { dispatchWakes, liveWatcher } from "../src/wake.ts";
import { selfWatchInstruction, WATCHER_INSTRUCTION } from "../src/mcp.ts";
import { delegateWake } from "./helpers/wake-lease.ts";
import { sendLeased } from "./helpers/leased-send.ts";

const until = async (ok: () => boolean, ms = 10_000) => { for (const end = Date.now() + ms; !ok() && Date.now() < end;) await new Promise(r => setTimeout(r, 50)); return ok(); };

test("agentmbx watch skips status mail, exits with a no-body hint for a request, and the daemon defers meanwhile", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "mbx-watch-"));
  const n = new MbxNode(home, { host: "alpha" }), c = new Client({ name: "watch-test", version: "1" });
  t.after(async () => { await c.close(); n.close(); rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
  const env = { ...process.env, AGENTMBX_DEV: "1", MBX_HOME: home, MBX_CLI: "kimi", MBX_AGENT: "worker", MBX_NO_DESKTOP: "1", MBX_DEBUG: "" } as Record<string, string>;
  await c.connect(new StdioClientTransport({ command: process.execPath, args: [resolve("bin/agentmbx.js"), "mcp"], env }));
  delegateWake(n, "worker");

  const child = spawn(process.execPath, [resolve("bin/agentmbx.js"), "watch"], { env: { ...env, MBX_AGENT: "", MBX_WATCH_INTERVAL_MS: "200" } });
  let out = ""; child.stdout.on("data", d => { out += d; });
  const exited = new Promise<number | null>(r => child.on("exit", r));
  t.after(() => { child.kill(); });
  assert.ok(await until(() => liveWatcher(n, "worker")), "the watcher registers itself");
  assert.match(n.deliveryMode("worker"), /^push \(mbx watcher/);

  const status = sendLeased(n, { from: "boss", to: ["worker"], subject: "fyi", body: "status body", kind: "status" }).envelope;
  assert.ok(await until(() => (n.store.db.prepare("SELECT state FROM deliveries WHERE msg_id=?").get(status.id) as { state: string }).state === "notified"));
  assert.equal(child.exitCode, null, "status never wakes");

  const m = sendLeased(n, { from: "boss", to: ["worker"], subject: "please review", body: "secret body", kind: "request" }).envelope;
  assert.deepEqual((await dispatchWakes(n)).filter(r => r.agent === "worker"), [], "the daemon defers to a live watcher");
  assert.equal(await exited, 0);
  assert.match(out, /^\[mbx\] 1 new message\(s\) for worker/);
  assert.ok(out.includes(m.id) && !out.includes("secret body") && !out.includes(status.id), "ids of wanted mail only, never bodies");
  assert.match(out, /start this watcher again/);
  assert.equal(liveWatcher(n, "worker"), false, "an exited watcher no longer holds wakes back");
  assert.ok(n.store.db.prepare("SELECT 1 FROM audit WHERE event='wake.attempt' AND detail LIKE '%watcher%'").get());
});

test("agentmbx watch outside any session lease stops with a reason", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "mbx-watch-none-"));
  new MbxNode(home, { host: "alpha" }).close();
  t.after(() => rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  const child = spawn(process.execPath, [resolve("bin/agentmbx.js"), "watch"], { env: { ...process.env, AGENTMBX_DEV: "1", MBX_HOME: home, MBX_AGENT: "", MBX_WATCH_INTERVAL_MS: "200" } });
  let out = ""; child.stdout.on("data", d => { out += d; });
  assert.equal(await new Promise(r => child.on("exit", r)), 1);
  assert.match(out, /^\[mbx-watch\] stopped: no current identity lease/);
});

test("Kimi sessions get the event-driven watcher instruction; other no-push CLIs keep the cron self-check", () => {
  assert.equal(selfWatchInstruction({ delegated: false, cli: "kimi", env: {} }), WATCHER_INSTRUCTION);
  assert.match(WATCHER_INSTRUCTION, /"agentmbx watch", run_in_background true, disable_timeout true/);
  assert.match(WATCHER_INSTRUCTION, /confirmed running, delete that cron job \(CronDelete\).*watcher replaces it/s, "T348: legacy crons go only once the watcher is confirmed running");
  assert.match(WATCHER_INSTRUCTION, /cannot run background tasks, skip the watcher and keep/, "T348 review: a session without background tasks keeps its cron");
  assert.match(selfWatchInstruction({ delegated: true, cli: "kimi", env: { MBX_SELF_WATCH: "15" } })!, /cron/);
  assert.match(selfWatchInstruction({ delegated: true, cli: "kimi", env: { MBX_SELF_WATCH: "off" } })!, /mbx watcher/);
  assert.equal(selfWatchInstruction({ delegated: false, cli: "hermes", env: {} }), null);
});

test("a terminal Kimi prompt carries the watcher instruction until a watcher runs (Kimi drops SessionStart context)", async (t) => {
  const { spawnSync } = await import("node:child_process");
  const home = mkdtempSync(join(tmpdir(), "mbx-watch-hint-"));
  const n = new MbxNode(home, { host: "alpha" }), c = new Client({ name: "watch-hint", version: "1" });
  t.after(async () => { await c.close(); n.close(); rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
  const env = { ...process.env, AGENTMBX_DEV: "1", MBX_HOME: home, MBX_CLI: "kimi", MBX_AGENT: "worker", MBX_NO_DESKTOP: "1", MBX_DEBUG: "" } as Record<string, string>;
  await c.connect(new StdioClientTransport({ command: process.execPath, args: [resolve("bin/agentmbx.js"), "mcp"], env }));
  const prompt = () => spawnSync(process.execPath, [resolve("bin/agentmbx.js"), "hook", "prompt", "--cli", "kimi"],
    { input: JSON.stringify({ session_id: "kimi-term-1", cwd: process.cwd(), prompt: "hi" }), encoding: "utf8", env }).stdout;
  assert.match(prompt(), /start one now with your shell tool: command "agentmbx watch"/);
  n.store.set("watcher:worker", JSON.stringify({ pid: process.pid, at: Date.now() }));
  assert.doesNotMatch(prompt(), /agentmbx watch/, "no nagging while a watcher is live");
});

// T343: liveness comes from the lease row's heartbeat, not a ps spawn per poll. While the holder
// heartbeats, an idle watcher pays zero process evidence after startup; a stale heartbeat pays one
// probe (alive holder → carry on); a dead holder stops the watcher.
const spawnDebug = (env: Record<string, string>, extra: Record<string, string> = {}) => {
  const child = spawn(process.execPath, [resolve("bin/agentmbx.js"), "watch"],
    { env: { ...env, MBX_AGENT: "", MBX_WATCH_INTERVAL_MS: "200", MBX_WATCH_DEBUG: "1", ...extra } });
  let out = "", err = "";
  child.stdout.on("data", d => { out += d; });
  child.stderr.on("data", d => { err += d; });
  return { child, out: () => out, err: () => err, exited: new Promise<number | null>(r => child.on("exit", r)) };
};
const spawnCounts = (err: string) => {
  const m = /probes (\d+) evidence spawns: startup (\d+) total (\d+)/.exec(err);
  return m ? { probes: Number(m[1]), startup: Number(m[2]), total: Number(m[3]) } : null;
};

test("T343: an idle watcher pays zero process evidence; a quiet-but-alive holder pays one rate-limited probe", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "mbx-watch-t343-"));
  const n = new MbxNode(home, { host: "alpha" }), c = new Client({ name: "watch-t343", version: "1" });
  t.after(async () => { await c.close(); n.close(); rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
  const env = { ...process.env, AGENTMBX_DEV: "1", MBX_HOME: home, MBX_CLI: "kimi", MBX_AGENT: "worker", MBX_NO_DESKTOP: "1", MBX_DEBUG: "" } as Record<string, string>;
  const transport = new StdioClientTransport({ command: process.execPath, args: [resolve("bin/agentmbx.js"), "mcp"], env });
  await c.connect(transport);
  const w = spawnDebug(env);
  t.after(() => { w.child.kill(); });
  assert.ok(await until(() => liveWatcher(n, "worker")), "the watcher registers");
  n.store.db.prepare("UPDATE identity_leases SET heartbeat_at=? WHERE name='worker'").run(Date.now()); // flake fix: anchor the idle window
  await new Promise(r => setTimeout(r, 3_000)); // ~15 ticks inside one staleness window: nothing to probe
  w.child.kill("SIGTERM");
  assert.equal(await w.exited, 143);
  const idle = spawnCounts(w.err());
  assert.ok(idle && idle.total - idle.startup === 0 && idle.probes === 0,
    `zero evidence work across ~15 ticks on every platform: ${JSON.stringify(idle)}`);

  // A holder that stays quiet past the 60 s staleness window while ALIVE: SIGSTOP freezes it (no
  // heartbeats, but kill(pid,0) and its start time still prove life — a dead holder it is not).
  // ONE rate-limited probe proves it alive; the watcher continues. Real-clock wait.
  assert.ok(transport.pid, "the MCP child has a pid");
  const w2 = spawnDebug(env, { MBX_WATCH_STALE_MS: "60000" }); // the clamp floor: one 60 s window, not the 180 s default
  assert.ok(await until(() => liveWatcher(n, "worker")), "the second watcher registers");
  process.kill(transport.pid!, "SIGSTOP");
  t.after(() => { try { process.kill(transport.pid!, "SIGCONT"); } catch { /* already gone */ } });
  assert.ok(await until(() => /probe live/.test(w2.err()), 75_000), "the probe fired inside the window (polled, not guessed — load-dependent timing)"); // one full staleness window, real clock
  assert.ok(liveWatcher(n, "worker"), "a quiet-but-alive holder does not stop the watcher");
  process.kill(transport.pid!, "SIGCONT");
  w2.child.kill("SIGTERM");
  assert.equal(await w2.exited, 143);
  const stale = spawnCounts(w2.err());
  // Probes are counted at the probe call, not as ps spawns (ubuntu CI: Linux reads /proc and never
  // spawns ps): at least one probe fired, and the rate limit held on every platform.
  assert.ok(stale && stale.probes >= 1, `the quiet holder paid at least one probe: ${JSON.stringify(stale)}`);
  assert.ok(stale && stale.probes <= 3, `probes are rate-limited across the whole quiet stretch: ${JSON.stringify(stale)}`);
});

test("T343: a dead holder stops the watcher with the probe's reason", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "mbx-watch-dead-"));
  const n = new MbxNode(home, { host: "alpha" }), c = new Client({ name: "watch-t343-dead", version: "1" });
  t.after(async () => { n.close(); rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
  const env = { ...process.env, AGENTMBX_DEV: "1", MBX_HOME: home, MBX_CLI: "kimi", MBX_AGENT: "worker", MBX_NO_DESKTOP: "1", MBX_DEBUG: "" } as Record<string, string>;
  const transport = new StdioClientTransport({ command: process.execPath, args: [resolve("bin/agentmbx.js"), "mcp"], env });
  await c.connect(transport);
  const w = spawnDebug(env, { MBX_WATCH_STALE_MS: "60000" }); // the clamp floor: the probe fires after one 60 s window, not 180
  assert.ok(await until(() => liveWatcher(n, "worker")), "the watcher registers");
  assert.ok(transport.pid, "the MCP child has a pid");
  process.kill(transport.pid!, "SIGKILL"); // review major 3: a crash, never the graceful release path
  // real-clock: the probe fires after one staleness window (60 s), then five strikes stop it
  assert.equal(await w.exited, 1);
  assert.match(w.out(), /^\[mbx-watch\] stopped: the holder process for worker is gone/, "the probe's own reason, not a release path");
});

test("T343: a lease that moves to another holder stops the pinned watcher and invalidates liveWatcher", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "mbx-watch-takeover-"));
  const n = new MbxNode(home, { host: "alpha" });
  t.after(async () => { n.close(); rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
  const envA = { ...process.env, AGENTMBX_DEV: "1", MBX_HOME: home, MBX_CLI: "kimi", MBX_AGENT: "worker", MBX_NO_DESKTOP: "1", MBX_DEBUG: "" } as Record<string, string>;
  const cA = new Client({ name: "watch-takeover-a", version: "1" });
  t.after(async () => { await cA.close().catch(() => {}); });
  await cA.connect(new StdioClientTransport({ command: process.execPath, args: [resolve("bin/agentmbx.js"), "mcp"], env: envA }));
  const w = spawnDebug(envA);
  assert.ok(await until(() => liveWatcher(n, "worker")), "session A's watcher registers");
  // A releases; B (a different parent process) claims the same name with a NEW token.
  const leases = new IdentityLeases(n.store);
  const row = n.store.db.prepare("SELECT token FROM identity_leases WHERE name='worker'").get() as { token: string };
  leases.release("worker", row.token);
  const cB = new Client({ name: "watch-takeover-b", version: "1" });
  t.after(async () => { await cB.close().catch(() => {}); });
  await cB.connect(new StdioClientTransport({ command: process.execPath, args: [resolve("bin/agentmbx.js"), "mcp"], env: envA }));
  assert.equal(await w.exited, 1, "the pinned watcher stops when the lease moves");
  assert.match(w.out(), /moved to another holder/, "with the pinning reason");
  assert.equal(liveWatcher(n, "worker"), false, "a token-mismatched watcher record does not count as live");
});

// T348 review mediums 1-2 + the session-start gate: the CronDelete cleanup is conditional, and it
// reaches a live-watcher + legacy-cron session through the prompt hook (Kimi drops SessionStart).
test("a live watcher plus a legacy [mbx-watch] cron prompt gets the one-line cleanup; the session-start instruction is gated", async (t) => {
  const { spawnSync } = await import("node:child_process");
  const home = mkdtempSync(join(tmpdir(), "mbx-watch-cleanup-"));
  const n = new MbxNode(home, { host: "alpha" }), c = new Client({ name: "watch-cleanup", version: "1" });
  t.after(async () => { await c.close(); n.close(); rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
  const env = { ...process.env, AGENTMBX_DEV: "1", MBX_HOME: home, MBX_CLI: "kimi", MBX_AGENT: "worker", MBX_NO_DESKTOP: "1", MBX_DEBUG: "" } as Record<string, string>;
  await c.connect(new StdioClientTransport({ command: process.execPath, args: [resolve("bin/agentmbx.js"), "mcp"], env }));
  const hook = (event: string, prompt?: string) => spawnSync(process.execPath, ["bin/agentmbx.js", "hook", event, "--cli", "kimi"],
    { input: JSON.stringify({ session_id: "kimi-cleanup-1", cwd: process.cwd(), ...(prompt !== undefined ? { prompt } : {}) }), encoding: "utf8", env }).stdout;

  // no watcher yet: a [mbx-watch] prompt gets no cleanup line (the watcher isn't confirmed running)
  assert.doesNotMatch(hook("prompt", "[mbx-watch] Periodic self-check"), /delete this cron job/);

  // a live watcher (token-pinned record, as the real watcher writes it)
  const token = (n.store.db.prepare("SELECT token FROM identity_leases WHERE name='worker'").get() as { token: string }).token;
  n.store.set("watcher:worker", JSON.stringify({ pid: process.pid, at: Date.now(), token }));
  const cleanup = hook("prompt", "[mbx-watch] Periodic self-check for worker@alpha: call mbx_inbox.");
  assert.match(cleanup, /One wake mechanism only.*delete this cron job \(CronDelete\)/s, "the owner-visible case: live watcher + legacy cron prompt");

  // the session-start instruction is gated on no live watcher
  assert.doesNotMatch(hook("session-start"), /agentmbx watch|CronCreate/, "no wake instruction while a watcher is alive");
  // a moved lease invalidates the record (shared #94 fix): the cleanup stops and the instruction returns
  n.store.db.prepare("UPDATE identity_leases SET token='other-token' WHERE name='worker'").run();
  assert.doesNotMatch(hook("prompt", "[mbx-watch] Periodic self-check"), /delete this cron job/, "a token-mismatched record is not a live watcher");
});
