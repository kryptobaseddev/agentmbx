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
