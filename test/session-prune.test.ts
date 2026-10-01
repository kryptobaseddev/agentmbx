// T046: the daemon drops session rows whose process is provably gone, and nothing else.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MbxNode } from "../src/node.ts";
import { _resetProcCache, procStart } from "../src/proc.ts";

test("dead and PID-reused session rows are pruned; live and unprovable rows stay, and chosen names survive", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "mbx-prune-"));
  const n = new MbxNode(home, { host: "alpha" });
  t.after(() => { n.close(); rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"]);
  await new Promise((r) => child.once("spawn", r));
  const deadPid = child.pid!;
  child.kill("SIGKILL");
  await new Promise((r) => child.once("exit", r));
  _resetProcCache();
  const insert = n.store.db.prepare("INSERT INTO sessions (agent,cli,session_id,cwd,pid,session_key,channel,updated_at,pid_start) VALUES (?,?,?,NULL,?,NULL,0,?,?)");
  const now = new Date().toISOString(), me = procStart(process.pid);
  insert.run("gone", "codex", "thread-dead", deadPid, now, "Mon Jan  1 00:00:00 2024");
  insert.run("reused", "claude", "session-reused", process.pid, now, "Mon Jan  1 00:00:00 2024");
  insert.run("alive", "claude", "session-live", process.pid, now, me);
  insert.run("legacy", "kimi", "session-legacy", null, now, null);
  insert.run("unproven", "opencode", "ses-unproven", process.pid, now, null);
  n.store.set("name:codex:thread-dead", "gone");
  assert.equal(n.pruneDeadSessions(), 2);
  const left = (n.store.db.prepare("SELECT session_id FROM sessions ORDER BY session_id").all() as { session_id: string }[]).map((r) => r.session_id);
  assert.deepEqual(left, ["ses-unproven", "session-legacy", "session-live"]);
  assert.equal(n.store.get("name:codex:thread-dead"), "gone", "the chosen name is kept for the next bind");
  assert.ok(n.store.db.prepare("SELECT 1 FROM audit WHERE event='sessions.pruned'").get());
  assert.equal(n.pruneDeadSessions(), 0, "idempotent");
});
