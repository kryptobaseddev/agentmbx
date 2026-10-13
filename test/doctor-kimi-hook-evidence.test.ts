// T611: the doctor row that detects a bound Kimi session whose process records no hook evidence —
// terminal or app-restart-resumed kimi-code processes may silently dispatch none of their configured
// hooks (Kimi fails hook errors open), leaving the agent without unread notices, the resume notice
// and Stop continuation even though doctor's wiring rows are green.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MbxNode } from "../src/node.ts";
import { kimiHookEvidence } from "../src/doctor.ts";

const fixture = (t: { after: (fn: () => void) => unknown }) => {
  const home = mkdtempSync(join(tmpdir(), "mbx-t611-")), kimiHome = join(home, "kimi-code");
  mkdirSync(kimiHome, { recursive: true });
  // setup writes the resolved bin path, not the bare "agentmbx hook" form.
  writeFileSync(join(kimiHome, "config.toml"), '[[hooks]]\nevent = "UserPromptSubmit"\ncommand = "/usr/bin/node /home/u/.local/bin/agentmbx.js hook prompt --cli kimi"\n');
  const n = new MbxNode(home, { host: "alpha" });
  t.after(() => { n.close(); rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
  return { n, kimiHome };
};

const bind = (n: MbxNode, agent: string, session: string) =>
  n.bindSession({ agent, cli: "kimi", session_id: session, cwd: process.cwd(), pid: process.pid });

test("kimiHookEvidence: a live bound session with no hook evidence since its process started warns, naming the session", async t => {
  const { n, kimiHome } = fixture(t);
  bind(n, "t611-agent", "session_t611");
  const later = Date.now() + 11 * 60_000; // past the 10-minute grace period
  const [check] = kimiHookEvidence(n, kimiHome, later);
  assert.equal(check?.level, "warn");
  assert.match(check.label, /session_t611/);
  assert.match(check.label, new RegExp(`pid ${process.pid}`));
  assert.match(check.label, /t611-agent/);
  assert.match(check.label, /may not be dispatching/);
  assert.match(check.fix!, /Orca pane|report to Kimi/);
});

test("kimiHookEvidence: a per-process resume-entry key is hook evidence and silences the row", async t => {
  const { n, kimiHome } = fixture(t);
  bind(n, "t611-agent", "session_t611");
  n.store.set(`resume-entry:kimi:${process.pid}`, `some-start session_t611`);
  assert.deepEqual(kimiHookEvidence(n, kimiHome, Date.now() + 11 * 60_000), []);
});

test("kimiHookEvidence: a human-prompt at/after the process start is hook evidence and silences the row", async t => {
  const { n, kimiHome } = fixture(t);
  bind(n, "t611-agent", "session_t611");
  n.store.set("human-prompt:t611-agent", new Date(Date.now() + 12 * 60_000).toISOString());
  assert.deepEqual(kimiHookEvidence(n, kimiHome, Date.now() + 11 * 60_000), []);
});

test("kimiHookEvidence: a young process is not yet diagnosable; a stale or provisional row never warns", async t => {
  const { n, kimiHome } = fixture(t);
  bind(n, "t611-agent", "session_t611");
  assert.deepEqual(kimiHookEvidence(n, kimiHome), [], "inside the grace period: silent");
  n.bindSession({ agent: "t611-stale", cli: "kimi", session_id: "session_stale", cwd: process.cwd(), pid: 2 ** 22 + 1 });
  n.bindSession({ agent: "t611-mcp", cli: "kimi", session_id: "mcp-123", cwd: process.cwd(), pid: process.pid });
  const later = Date.now() + 11 * 60_000;
  const out = kimiHookEvidence(n, kimiHome, later);
  assert.equal(out.length, 1, "only the one live, evidence-less real session warns");
  assert.match(out[0].label, /session_t611/);
});

test("kimiHookEvidence: no agentmbx hooks configured means nothing to miss", async t => {
  const { n, kimiHome } = fixture(t);
  bind(n, "t611-agent", "session_t611");
  writeFileSync(join(kimiHome, "config.toml"), '[[hooks]]\nevent = "UserPromptSubmit"\ncommand = "echo hi"\n');
  assert.deepEqual(kimiHookEvidence(n, kimiHome, Date.now() + 11 * 60_000), []);
  rmSync(join(kimiHome, "config.toml"));
  assert.deepEqual(kimiHookEvidence(n, kimiHome, Date.now() + 11 * 60_000), [], "an unreadable config is silent, like the wiring rows");
});
