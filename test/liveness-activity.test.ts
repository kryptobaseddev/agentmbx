import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { identityAvailability, SHARED_IDLE_MS } from "../src/identity-availability.ts";
import type { IdentityLease } from "../src/identity-leases.ts";

const THREAD = "44444444-4444-4444-8444-444444444444";
/** A pid the OS has already reaped: the Grok dead-harness check must not depend on a fabricated pid being free. */
const exitedPid = (): number => spawnSync(process.execPath, ["-e", ""]).pid!;
const live = { alive: true as const, start: "birth" };

function lease(cli: string, sessionId: string, now: number): IdentityLease {
  return {
    name: "reader", token: "t", holder_pid: 10, holder_start: "birth", key_fp: "aaaa-aaaa-aaaa-aaaa",
    cli, session_id: sessionId, claimed_at: now - SHARED_IDLE_MS - 60_000, heartbeat_at: now,
    idle_ttl: 30 * 60_000, released_at: null, release_reason: null,
  };
}

function dir(): string {
  const home = mkdtempSync(join(tmpdir(), "mbx-liveness-"));
  return home;
}

test("a writing Codex thread with a stale mbx call reads as active", () => {
  const now = Date.now(), home = dir(), at = now - 1000;
  const day = join(home, "sessions", "2026", "10", "17");
  mkdirSync(day, { recursive: true });
  const path = join(day, `rollout-2026-10-17T12-00-00-${THREAD}.jsonl`);
  writeFileSync(path, "metadata only", { mode: 0o000 });
  utimesSync(path, at / 1000, at / 1000);
  try {
    const got = identityAvailability({
      lease: lease("codex", THREAD, now), evidence: live, now, homes: { codexHome: home },
      activity: { at: now - SHARED_IDLE_MS - 60_000, shared: true },
    });
    assert.equal(got.claimable, false);
    assert.equal(got.state, "live");
    assert.match(got.reason, /last activity 1 min ago \(codex rollout\)/);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("a live Grok session with a stale mbx call reads as active", () => {
  const now = Date.now(), home = dir();
  const file = join(home, "active_sessions.json");
  writeFileSync(file, JSON.stringify([{ session_id: "grok-t583", pid: process.pid, cwd: home, opened_at: new Date(now).toISOString() }]));
  try {
    const got = identityAvailability({
      lease: lease("grok", "grok-t583", now), evidence: live, now, homes: { grokSessionsFile: file },
      activity: { at: now - SHARED_IDLE_MS - 60_000, shared: true },
    });
    assert.equal(got.claimable, false);
    assert.equal(got.state, "live");
    assert.match(got.reason, /last activity 1 min ago \(grok session\)/);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("a dead harness still reads as stale", () => {
  const now = Date.now(), home = dir();
  const file = join(home, "active_sessions.json");
  writeFileSync(file, JSON.stringify([{ session_id: "grok-t583", pid: exitedPid(), cwd: home, opened_at: new Date(now).toISOString() }]));
  const day = join(home, "sessions", "2026", "10", "17");
  mkdirSync(day, { recursive: true });
  const path = join(day, `rollout-2026-10-17T12-00-00-${THREAD}.jsonl`);
  writeFileSync(path, "old");
  const quietAt = now - SHARED_IDLE_MS - 1000;
  utimesSync(path, quietAt / 1000, quietAt / 1000);
  const stale = { at: now - SHARED_IDLE_MS - 60_000, shared: true };
  try {
    const grok = identityAvailability({
      lease: lease("grok", "grok-t583", now), evidence: live, now, homes: { grokSessionsFile: file }, activity: stale,
    });
    assert.equal(grok.claimable, true);
    assert.equal(grok.takeover, "idle-conversation");
    assert.match(grok.reason, /no mbx activity/);
    assert.doesNotMatch(grok.reason, /\(grok session\)/);
    const codex = identityAvailability({
      lease: lease("codex", THREAD, now), evidence: live, now, homes: { codexHome: home }, activity: stale,
    });
    assert.equal(codex.claimable, true);
    assert.equal(codex.takeover, "idle-conversation");
    assert.match(codex.reason, /no mbx activity/);
    assert.doesNotMatch(codex.reason, /\(codex rollout\)/);
  } finally { rmSync(home, { recursive: true, force: true }); }
});
