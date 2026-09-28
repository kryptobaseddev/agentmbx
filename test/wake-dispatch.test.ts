import { sendLeased } from "./helpers/leased-send.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { bindWakeLease, delegateWake } from "./helpers/wake-lease.ts";
import { MbxNode } from "../src/node.ts";
import { dispatchWakes, wakeOpencode } from "../src/wake.ts";

for (const invalid of ["dead-pid", "reused-pid", "missing-birth", "expired", "no-pid", "provisional", "stale-channel", "live-channel"])
  test(`wake dispatch validates ${invalid} targets`, async (t) => {
    const home = mkdtempSync(join(tmpdir(), "mbx-wake-target-"));
    const n = new MbxNode(home, { host: "alpha" });
    const log = join(home, "calls"), bin = join(home, "codex");
    writeFileSync(bin, '#!/bin/sh\nprintf "%s\\n" "$3" >> "$MBX_TEST_WAKE_LOG"\n', { mode: 0o700 });
    const old = { MBX_CODEX_BIN: process.env.MBX_CODEX_BIN, MBX_TEST_WAKE_LOG: process.env.MBX_TEST_WAKE_LOG, MBX_NO_DESKTOP: process.env.MBX_NO_DESKTOP };
    Object.assign(process.env, { MBX_CODEX_BIN: bin, MBX_TEST_WAKE_LOG: log, MBX_NO_DESKTOP: "1" });
    t.after(() => { for (const [k,v] of Object.entries(old)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } n.close(); rmSync(home, { recursive: true, force: true }); });
    if (invalid === "live-channel") bindWakeLease(n, { agent: "worker", cli: "claude", session_id: "mcp-bad", pid: process.pid, channel: true });
    else bindWakeLease(n, { agent: "worker", cli: "codex", session_id: "valid", pid: process.pid });
    const bad = (invalid === "provisional" || invalid === "live-channel") ? "mcp-bad" : "invalid";
    // Both rows existed historically; control ordering so the invalid row is attempted first.
    if (invalid !== "live-channel") n.store.db.prepare(`INSERT INTO sessions (agent,cli,session_id,pid,pid_start,channel,updated_at)
      SELECT agent,cli,?,pid,pid_start,0,'2099-01-01T00:00:00Z' FROM sessions WHERE session_id='valid'`).run(bad);
    if (invalid === "reused-pid" || invalid === "stale-channel") n.store.db.prepare("UPDATE sessions SET pid_start='previous-process' WHERE session_id=?").run(bad);
    if (invalid === "missing-birth") n.store.db.prepare("UPDATE sessions SET pid_start=NULL WHERE session_id=?").run(bad);
    if (invalid === "dead-pid") n.store.db.prepare("UPDATE sessions SET pid=2147483647 WHERE session_id=?").run(bad);
    if (invalid === "no-pid") n.store.db.prepare("UPDATE sessions SET pid=NULL WHERE session_id=?").run(bad);
    if (invalid === "expired") {
      n.store.db.prepare("UPDATE sessions SET updated_at='2000-01-01T00:00:00Z' WHERE session_id=?").run(bad);
      n.store.db.prepare("UPDATE sessions SET updated_at='1999-01-01T00:00:00Z' WHERE session_id='valid'").run();
      // Both rows are expired: no adapter may be called.
    }
    if (invalid === "stale-channel" || invalid === "live-channel") n.store.db.prepare("UPDATE sessions SET channel=1,cli='claude' WHERE session_id=?").run(bad);
    sendLeased(n, { from: "sender", to: ["worker"], subject: "wake", body: "private body", kind: "request" });
    const out = await dispatchWakes(n);
    if (invalid === "live-channel") {
      assert.equal(existsSync(log), false);
      assert.deepEqual(out, []);
      assert.equal((n.store.db.prepare("SELECT state FROM deliveries").get() as { state: string }).state, "delivered");
    } else if (invalid === "expired") {
      assert.equal(existsSync(log), false);
      assert.equal(out[0].result.ok, false);
    } else {
      assert.equal(out[0]?.result.ok, true);
      assert.equal(readFileSync(log, "utf8"), "valid\n");
    }
  });

for (const defect of ["released", "generation", "key", "parent", "missing-control", "legacy"]) test(`wake refuses ${defect} mailbox bindings`, async t => {
  const home = mkdtempSync(join(tmpdir(), "mbx-wake-fence-")), n = new MbxNode(home, { host: "alpha" });
  t.after(() => { n.close(); rmSync(home, { recursive: true, force: true }); });
  const holder = bindWakeLease(n, { agent: "worker", cli: "codex", session_id: "valid", pid: process.pid });
  if (defect === "released") holder.release();
  if (defect === "generation") n.store.db.prepare("UPDATE identity_leases SET token='replacement'").run();
  if (defect === "key") n.store.db.prepare("UPDATE sessions SET session_key='other'").run();
  if (defect === "parent") n.store.db.prepare("UPDATE sessions SET pid=?").run(process.ppid);
  if (defect === "missing-control") n.store.db.prepare("DELETE FROM kv WHERE k GLOB 'identity-control:*'").run();
  if (defect === "legacy") n.store.db.prepare("DELETE FROM identity_leases").run();
  const log = join(home, "calls"), bin = join(home, "codex");
  writeFileSync(bin, '#!/bin/sh\nprintf called >> "$MBX_TEST_WAKE_LOG"\n', { mode: 0o700 });
  const old = { MBX_CODEX_BIN: process.env.MBX_CODEX_BIN, MBX_TEST_WAKE_LOG: process.env.MBX_TEST_WAKE_LOG, MBX_NO_DESKTOP: process.env.MBX_NO_DESKTOP };
  Object.assign(process.env, { MBX_CODEX_BIN: bin, MBX_TEST_WAKE_LOG: log, MBX_NO_DESKTOP: "1" });
  t.after(() => { for (const [k,v] of Object.entries(old)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } });
  sendLeased(n, { from: "sender", to: ["worker"], subject: "retained", body: "private", kind: "request" });
  await dispatchWakes(n); assert.equal(existsSync(log), false); assert.equal(n.unreadCount("worker"), 1);
});

for (const current of [true, false]) test(`OpenCode rechecks after async service discovery (current: ${current})`, async () => {
  let calls = 0, ready = false;
  const result = await wakeOpencode("session-exact", "notification", {
    service: async () => { await Promise.resolve(); ready = true; return { url: "http://fixture.invalid", auth: "" }; },
    recheck: () => { assert.equal(ready, true); return current; },
    fetch: (async (input: string | URL | Request, options: RequestInit) => {
      calls++; assert.equal(String(input), "http://fixture.invalid/api/session/session-exact/synthetic");
      assert.deepEqual(JSON.parse(options.body as string), { text: "notification", delivery: "queue", resume: true });
      return Response.json({});
    }) as typeof fetch,
  });
  assert.equal(calls, current ? 1 : 0); assert.equal(result.ok, current);
});

test("daemon routes an actual MCP holder and refuses its stale binding after release", async t => {
  const home = mkdtempSync(join(tmpdir(), "mbx-wake-mcp-")), n = new MbxNode(home, { host: "alpha" });
  const client = new Client({ name: "wake-test", version: "1" });
  const log = join(home, "calls"), bin = join(home, "codex");
  writeFileSync(bin, '#!/bin/sh\nprintf "%s\n" "$3" >> "$MBX_TEST_WAKE_LOG"\n', { mode: 0o700 });
  const old = { MBX_CODEX_BIN: process.env.MBX_CODEX_BIN, MBX_TEST_WAKE_LOG: process.env.MBX_TEST_WAKE_LOG, MBX_NO_DESKTOP: process.env.MBX_NO_DESKTOP };
  Object.assign(process.env, { MBX_CODEX_BIN: bin, MBX_TEST_WAKE_LOG: log, MBX_NO_DESKTOP: "1" });
  t.after(async () => { await client.close(); n.close(); rmSync(home, { recursive: true, force: true });
    for (const [k,v] of Object.entries(old)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [resolve("bin/agentmbx.js"), "mcp"],
    env: { ...process.env, MBX_HOME: home, MBX_AGENT: "worker", MBX_CLI: "codex", AGENTMBX_DEV: "1" } as Record<string,string> }));
  const threadId = "88888888-8888-4888-8888-888888888888";
  const call = (name: string, args: Record<string,unknown> = {}) => client.callTool({ name, arguments: args, _meta: { threadId } });
  const agent = ((await call("mbx_whoami")).structuredContent as { agent: string }).agent;
  delegateWake(n, agent);
  const original = n.sessionsFor(agent)[0];
  sendLeased(n, { from: "sender", to: [agent], subject: "wake", body: "private", kind: "request" });
  assert.equal((await dispatchWakes(n))[0].result.ok, true);
  assert.equal(readFileSync(log, "utf8"), threadId + "\n");
  assert.notEqual((await call("mbx_identity", { action: "release" })).isError, true);
  // Even if an older hook recreates the old row, it has no current lease authority.
  n.store.db.prepare(`INSERT INTO sessions (agent,cli,session_id,pid,pid_start,session_key,channel,updated_at)
    VALUES (?,?,?,?,?,?,?,?)`).run(original.agent, original.cli, original.session_id, original.pid, original.pid_start, original.session_key, original.channel, original.updated_at);
  n.store.db.prepare("DELETE FROM wakes").run();
  sendLeased(n, { from: "sender", to: [agent], subject: "retained", body: "private", kind: "request" });
  await dispatchWakes(n);
  assert.equal(readFileSync(log, "utf8"), threadId + "\n", "released binding never submits another prompt");
  assert.equal(n.unreadCount(agent), 2);
});
