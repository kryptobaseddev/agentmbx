import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, chmodSync, lstatSync, mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
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
const event = (type: string, turn_id = "turn") => `${JSON.stringify({ type: "event_msg", payload: { type, turn_id } })}\n`;
function fixture(t: TestContext) {
  const home = mkdtempSync(join(tmpdir(), "mbx-codex-activity-")), store = new Store(home);
  t.after(() => { store.close(); rmSync(home, { recursive: true, force: true }); });
  const now = Date.now(), claimed = now - SHARED_IDLE_MS - 60_000;
  let evidence: ProcessEvidence = { alive: true, start: "birth" };
  const leases = new IdentityLeases(store, { clock: () => claimed, inspect: () => evidence });
  const lease = leases.claim("reader", { pid: 10, start: "birth", keyFp: "aaaa-aaaa-aaaa-aaaa", cli: "codex", sessionId: THREAD });
  store.set(activityKey(lease.name), JSON.stringify({ at: claimed, shared: true }));
  const sampler = new CodexActivity(home), holder = { ...lease, shared: true };
  const rollout = (thread: string, at: number, day = "09", body = "not JSON; use metadata fallback") => {
    const dir = join(home, "sessions", "2026", "10", day); mkdirSync(dir, { recursive: true });
    const path = join(dir, `rollout-2026-10-${day}T12-00-00-${thread}.jsonl`);
    writeFileSync(path, body, { mode: body.startsWith("{") ? 0o600 : 0o000 });
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

test("a silent open turn stays unclaimable after >10 min without mbx calls or rollout writes", t => {
  const f = fixture(t), path = f.rollout(THREAD, f.claimed - 1000, "09", event("task_started"));
  const writtenAt = lstatSync(path).mtimeMs;
  assert.equal(f.record(), true);
  const later = f.now + SHARED_IDLE_MS + 1000;
  t.mock.method(Date, "now", () => later);
  assert.equal(f.record(), true, "the same open turn remains active without a new write");
  assert.equal(f.activity().at, later);
  assert.equal(lstatSync(path).mtimeMs, writtenAt);
  assert.equal(identityAvailability({ lease: f.lease, activity: f.activity(), evidence: { alive: true, start: "birth" }, now: later }).claimable, false);
});

test("a completed turn past the idle threshold remains claimable", t => {
  const f = fixture(t);
  f.rollout(THREAD, f.claimed - 1000, "09", event("task_started") + event("task_complete"));
  assert.equal(f.record(), false);
  assert.deepEqual(f.activity(), { at: f.claimed, shared: true });
  assert.equal(identityAvailability({ lease: f.lease, activity: f.activity(), evidence: { alive: true, start: "birth" }, now: f.now }).claimable, true);
});

for (const end of ["task_complete", "turn_end", "turn_aborted"])
  test(`${end} closes only its matching open turn and restores quiet recovery`, t => {
    const f = fixture(t), path = f.rollout(THREAD, f.claimed - 1000, "09", event("task_started", "working") + event(end, "other"));
    assert.equal(f.record(), true, "an unrelated turn end must not close this turn");
    appendFileSync(path, event(end, "working"));
    utimesSync(path, f.claimed / 1000, f.claimed / 1000);
    const later = f.now + SHARED_IDLE_MS + 1000;
    t.mock.method(Date, "now", () => later);
    assert.equal(f.record(), false, "a completed quiet turn must not refresh observation time");
    assert.equal(identityAvailability({ lease: f.lease, activity: f.activity(), evidence: { alive: true, start: "birth" }, now: later }).claimable, true);
  });

for (const change of ["missing", "unreadable", "rotated", "truncated"])
  test(`${change} rollout discards cached open-turn protection and falls back to mtime`, t => {
    const f = fixture(t), path = f.rollout(THREAD, f.claimed - 1000, "09", event("task_started"));
    assert.equal(f.record(), true);
    if (change === "missing") rmSync(path);
    else if (change === "unreadable") chmodSync(path, 0o000);
    else {
      if (change === "rotated") renameSync(path, `${path}.old`);
      writeFileSync(path, event("task_started"), { mode: 0o600 });
      if (change === "truncated") writeFileSync(path, "");
      utimesSync(path, (f.claimed - 1000) / 1000, (f.claimed - 1000) / 1000);
    }
    const later = f.now + SHARED_IDLE_MS + 1000;
    t.mock.method(Date, "now", () => later);
    assert.equal(f.record(), false);
    assert.equal(identityAvailability({ lease: f.lease, activity: f.activity(), evidence: { alive: true, start: "birth" }, now: later }).claimable, true);
  });

test("non-event payloads and malformed rollouts cannot manufacture an open turn", t => {
  const f = fixture(t), path = f.rollout(THREAD, f.claimed - 1000, "09",
    JSON.stringify({ type: "response_item", payload: { type: "task_started", turn_id: "fake" } }));
  assert.equal(f.record(), false);
  writeFileSync(path, `${event("task_started")}not JSON\n`);
  utimesSync(path, (f.claimed - 1000) / 1000, (f.claimed - 1000) / 1000);
  assert.equal(f.record(), false);
  assert.deepEqual(f.activity(), { at: f.claimed, shared: true });
});

test("quiet rollout and missing evidence preserve idle recovery", t => {
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
    const f = fixture(t); f.rollout(THREAD, f.now - 1000, "09", event("task_started"));
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

for (const open of [false, true]) test(`the existing MCP heartbeat records ${open ? "a silent open turn" : "exact-thread mtime"} without another mbx call`, async t => {
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
  writeFileSync(path, open ? event("task_started") : "unreadable rollout contents", { mode: open ? 0o600 : 0o000 });
  if (open) utimesSync(path, (lease.claimed_at - SHARED_IDLE_MS - 1000) / 1000, (lease.claimed_at - SHARED_IDLE_MS - 1000) / 1000);
  const at = Math.floor(lstatSync(path).mtimeMs);
  assert.equal(at > lease.claimed_at, !open);
  let activity = parseActivity(node.store.get(activityKey(lease.name)));
  for (let i = 0; i < 40 && !(open ? (activity?.at ?? 0) > lease.claimed_at : activity?.at === at); i++) {
    await new Promise(resolve => setTimeout(resolve, 50)); activity = parseActivity(node.store.get(activityKey(lease.name)));
  }
  if (open) assert.ok(activity!.at > lease.claimed_at);
  else assert.deepEqual(activity, { at, shared: true });
  const first = activity!.at;
  await new Promise(resolve => setTimeout(resolve, 200));
  if (open) assert.ok(parseActivity(node.store.get(activityKey(lease.name)))!.at > first);
  else assert.equal(parseActivity(node.store.get(activityKey(lease.name)))?.at, at, "an idle heartbeat does not substitute now");
  assert.equal(Math.floor(lstatSync(path).mtimeMs), at, "heartbeats do not write the rollout");
});
