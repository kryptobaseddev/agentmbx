import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MbxNode } from "../src/node.ts";
import { sessionReadiness } from "../src/doctor.ts";

for (const state of ["absent", "stale", "provisional", "real", "channel", "mixed"]) test(`doctor reports ${state} binding evidence without claiming receipt`, (t) => {
  const home = mkdtempSync(join(tmpdir(), "mbx-doctor-"));
  const n = new MbxNode(home, { host: "alpha" });
  t.after(() => { n.close(); rmSync(home, { recursive: true, force: true }); });
  n.bindSession({ agent: "other", cli: "kimi", session_id: "other", pid: process.pid });
  if (state !== "absent") n.bindSession({ agent: "worker", cli: "codex", session_id: state === "real" || state === "mixed" ? "thread" : "mcp-test", pid: process.pid, channel: state === "channel" });
  if (state === "stale") n.store.db.prepare("UPDATE sessions SET pid_start='previous-process' WHERE cli='codex'").run();
  if (state === "mixed") n.store.db.prepare("INSERT INTO sessions (agent,cli,session_id,pid,pid_start,updated_at) VALUES ('old','codex','old',?,'previous-process',?)").run(process.pid, new Date().toISOString());
  const before = n.store.db.prepare("SELECT * FROM sessions ORDER BY cli,session_id").all();
  const check = sessionReadiness(n, "codex");
  assert.match(check.label, /receipt not tested/);
  assert.equal(check.level, state === "stale" || state === "provisional" ? "warn" : "info");
  if (state === "absent") assert.match(check.label, /no mailbox session bindings/);
  if (state === "stale") assert.match(check.label, /no verified live.*1 stale/);
  if (state === "provisional") { assert.match(check.label, /1 verified live.*0 real.*0 channel/); assert.ok(check.fix); }
  if (state === "real") assert.match(check.label, /1 verified live.*1 real/);
  if (state === "channel") { assert.match(check.label, /1 channel/); assert.equal(check.fix, undefined); }
  if (state === "mixed") assert.match(check.label, /1 verified live.*1 stale/);
  assert.deepEqual(n.store.db.prepare("SELECT * FROM sessions ORDER BY cli,session_id").all(), before);
});
