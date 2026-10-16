import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { lstatSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { CodexActivity } from "../src/codex-activity.ts";
import { activityKey, identityAvailability, parseActivity, SHARED_IDLE_MS } from "../src/identity-availability.ts";
import { IdentityLeases, type IdentityLease, type ProcessEvidence } from "../src/identity-leases.ts";
import { Store } from "../src/store.ts";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { MbxNode } from "../src/node.ts";

const THREAD = "44444444-4444-4444-8444-444444444444", SIBLING = "55555555-5555-4555-8555-555555555555";
function fixture(t: TestContext) {
  const home = mkdtempSync(join(tmpdir(), "mbx-codex-activity-")), store = new Store(home);
  t.after(() => { store.close(); rmSync(home, { recursive: true, force: true }); });
  const now = Date.now(), claimed = now - SHARED_IDLE_MS - 60_000;
  let evidence: ProcessEvidence = { alive: true, start: "birth" };
  const leases = new IdentityLeases(store, { clock: () => claimed, inspect: () => evidence });
  const lease = leases.claim("reader", { pid: 10, start: "birth", keyFp: "aaaa-aaaa-aaaa-aaaa", cli: "codex", sessionId: THREAD });
  store.set(activityKey(lease.name), JSON.stringify({ at: claimed, shared: true }));
  const sampler = new CodexActivity(home), holder = { ...lease, shared: true };
  const rollout = (thread: string, at: number, day = "09") => {
    const dir = join(home, "sessions", "2026", "10", day); mkdirSync(dir, { recursive: true });
    const path = join(dir, `rollout-2026-10-${day}T12-00-00-${thread}.jsonl`);
    writeFileSync(path, "not JSON; the rollout body must never be read", { mode: 0o000 });
    utimesSync(path, at / 1000, at / 1000);
    return path;
  };
  return { home, store, leases, lease, holder, sampler, now, claimed, rollout,
    record: () => sampler.record(store, leases, holder),
    activity: () => parseActivity(store.get(activityKey(lease.name)))!,
    evidence: (value: ProcessEvidence) => { evidence = value; } };
}

test("exact-thread rollout activity keeps a writing thread live after >10 min without an mbx call", t => {
  const f = fixture(t), at = f.now - 1000;
  f.rollout(THREAD, at); f.rollout(SIBLING, f.now);
  const before = f.activity();
  assert.equal(identityAvailability({ lease: f.lease, activity: before, evidence: { alive: true, start: "birth" }, now: f.now }).claimable, true);
  assert.equal(f.record(), true);
  assert.deepEqual(f.activity(), { at, shared: true }, "use the actual mtime, never observation time");
  assert.equal(identityAvailability({ lease: f.lease, activity: f.activity(), evidence: { alive: true, start: "birth" }, now: f.now }).claimable, false);
  assert.equal(f.record(), false, "an unchanged rollout must not synthesize another heartbeat");
});

test("quiet rollout and missing evidence preserve idle recovery and the silent-turn gap", t => {
  const f = fixture(t);
  f.rollout(SIBLING, f.now - 1000);
  assert.equal(f.record(), false, "a sibling's rollout is not this thread's activity");
  f.rollout(THREAD, f.claimed - 1000);
  assert.equal(f.record(), false, "pre-lease mtime is not activity of this holder");
  assert.deepEqual(f.activity(), { at: f.claimed, shared: true });
  assert.equal(identityAvailability({ lease: f.lease, activity: f.activity(), evidence: { alive: true, start: "birth" }, now: f.now }).claimable, true);
});

test("a cached rollout advances only with a newer timestamp and never shortens mbx activity", t => {
  const f = fixture(t), path = f.rollout(THREAD, f.now - 3000);
  assert.equal(f.record(), true);
  utimesSync(path, (f.now - 2000) / 1000, (f.now - 2000) / 1000);
  assert.equal(f.record(), true); assert.equal(f.activity().at, f.now - 2000);
  f.store.set(activityKey(f.lease.name), JSON.stringify({ at: f.now - 1000, shared: false }));
  assert.equal(f.record(), false); assert.deepEqual(f.activity(), { at: f.now - 1000, shared: false });
  utimesSync(path, (f.now - 500) / 1000, (f.now - 500) / 1000);
  assert.equal(f.record(), true); assert.deepEqual(f.activity(), { at: f.now - 500, shared: false });
});

test("future, ambiguous, non-file, missing and provisional evidence writes nothing", t => {
  const f = fixture(t), path = f.rollout(THREAD, f.now + 60_000);
  assert.equal(f.record(), false);
  rmSync(path); assert.equal(f.record(), false, "a missing cached file is unknown");
  f.rollout(THREAD, f.now - 1000); f.rollout(THREAD, f.now - 500, "10");
  assert.equal(f.record(), false, "ambiguous exact-thread paths are unknown");
  rmSync(join(f.home, "sessions"), { recursive: true });
  const sibling = f.rollout(SIBLING, f.now - 1000);
  symlinkSync(sibling, path); assert.equal(f.record(), false, "a symlink is not a rollout file");
  rmSync(path); mkdirSync(path); assert.equal(f.record(), false, "a directory is not a rollout file");
  assert.equal(f.sampler.record(f.store, f.leases, { ...f.holder, session_id: "mcp-provisional" }), false);
  assert.deepEqual(f.activity(), { at: f.claimed, shared: true });
});

for (const changed of ["token", "holder_pid", "holder_start", "session_id", "cli", "released_at"] as const)
  test(`rollout evidence is fenced against a changed lease ${changed}`, t => {
    const f = fixture(t); f.rollout(THREAD, f.now - 1000);
    const value = changed === "holder_pid" ? 20 : changed === "released_at" ? f.now : changed === "session_id" ? SIBLING : "changed";
    f.store.db.prepare(`UPDATE identity_leases SET ${changed}=? WHERE name=?`).run(value, f.lease.name);
    assert.equal(f.record(), false); assert.deepEqual(f.activity(), { at: f.claimed, shared: true });
  });

for (const [state, evidence] of Object.entries({ dead: { alive: false, start: null }, reused: { alive: true, start: "reborn" } } satisfies Record<string, ProcessEvidence>))
  test(`${state} holder process cannot record rollout activity`, t => {
    const f = fixture(t); f.rollout(THREAD, f.now - 1000); f.evidence(evidence);
    assert.equal(f.record(), false); assert.deepEqual(f.activity(), { at: f.claimed, shared: true });
  });

test("unknown process evidence writes no activity and performs no synthetic renewal", t => {
  const f = fixture(t); f.rollout(THREAD, f.now - 1000); f.evidence({ alive: null, start: null });
  f.leases.prepare([f.lease.name], [], () => assert.equal(f.record(), false));
  assert.deepEqual(f.activity(), { at: f.claimed, shared: true });
  const lease = f.store.db.prepare("SELECT * FROM identity_leases WHERE name=?").get(f.lease.name) as unknown as IdentityLease;
  assert.equal(lease.token, f.lease.token); assert.equal(lease.heartbeat_at, f.claimed); assert.equal(lease.released_at, null);
});

test("the existing MCP heartbeat records exact-thread mtime without another mbx call", async t => {
  const home = mkdtempSync(join(tmpdir(), "mbx-codex-heartbeat-")), node = new MbxNode(home, { host: "alpha" });
  const client = new Client({ name: "codex-activity", version: "1" }), preload = join(home, "heartbeat.mjs");
  writeFileSync(preload, "const interval=globalThis.setInterval; globalThis.setInterval=(fn,ms,...args)=>interval(fn,ms===60000?50:ms,...args);");
  const transport = new StdioClientTransport({ command: process.execPath, args: ["--import", preload, resolve("bin/agentmbx.js"), "mcp"],
    env: { ...process.env, MBX_HOME: home, CODEX_HOME: home, MBX_AGENT: "transport", MBX_CLI: "codex", AGENTMBX_DEV: "1" } as Record<string, string> });
  t.after(async () => { await client.close(); node.close(); rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
  await client.connect(transport);
  assert.notEqual((await client.callTool({ name: "mbx_identity", arguments: { action: "register", name: "active-thread", role: "test" }, _meta: { threadId: THREAD } })).isError, true);
  const lease = node.store.db.prepare("SELECT * FROM identity_leases WHERE name='active-thread'").get() as unknown as IdentityLease;
  node.store.set(activityKey(lease.name), JSON.stringify({ at: Date.now() - SHARED_IDLE_MS - 1000, shared: true }));
  const dir = join(home, "sessions", "2026", "10", "16"); mkdirSync(dir, { recursive: true });
  const path = join(dir, `rollout-2026-10-16T12-00-00-${THREAD}.jsonl`);
  writeFileSync(path, "unreadable rollout contents", { mode: 0o000 });
  const at = Math.floor(lstatSync(path).mtimeMs);
  assert.ok(at > lease.claimed_at);
  let activity = parseActivity(node.store.get(activityKey(lease.name)));
  for (let i = 0; i < 40 && activity?.at !== at; i++) {
    await new Promise(resolve => setTimeout(resolve, 50)); activity = parseActivity(node.store.get(activityKey(lease.name)));
  }
  assert.deepEqual(activity, { at, shared: true });
  await new Promise(resolve => setTimeout(resolve, 200));
  assert.equal(parseActivity(node.store.get(activityKey(lease.name)))?.at, at, "an idle heartbeat does not substitute now");
});
