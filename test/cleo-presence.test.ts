// T497: session start fills task and lane from CLEO, and leaves a session without CLEO alone.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fillCleoPresence } from "../src/cleo-presence.ts";
import { MbxNode } from "../src/node.ts";
import { setSessionPresence } from "../src/presence.ts";

process.env.MBX_NO_DESKTOP = "1";

function world(t: { after: (fn: () => void) => void }) {
  const home = mkdtempSync(join(tmpdir(), "mbx-cleo-"));
  const n = new MbxNode(home, { host: "alpha" });
  t.after(() => { n.close(); rmSync(home, { recursive: true, force: true }); });
  n.bindSession({ agent: "worker", cli: "grok", session_id: "s", pid: process.pid });
  const row = () => n.store.db.prepare("SELECT task, lane FROM sessions WHERE cli='grok' AND session_id='s'").get() as { task: string | null; lane: string | null };
  return { n, row };
}

test("CLEO_TASK_ID sets the task and does not spawn cleo", (t) => {
  const { n, row } = world(t);
  let spawned = false;
  fillCleoPresence(n, { cli: "grok", sessionId: "s", env: { ...process.env, CLEO_TASK_ID: "T497" }, which: () => { spawned = true; return "/cleo"; }, current: () => { spawned = true; return { currentTask: "T1" }; } });
  assert.equal(spawned, false);
  assert.equal(row().task, "T497");
  assert.equal(row().lane, null);
});

test("cleo current fills task and lane, and a missing cleo writes nothing", (t) => {
  const { n, row } = world(t);
  setSessionPresence(n, { cli: "grok", sessionId: "s", lane: "kept" });
  fillCleoPresence(n, { cli: "grok", sessionId: "s", env: { ...process.env, CLEO_TASK_ID: "" }, which: () => null, current: () => { throw new Error("cleo was spawned"); } });
  assert.equal(row().task, null);
  assert.equal(row().lane, "kept");
  fillCleoPresence(n, {
    cli: "grok", sessionId: "s", env: { ...process.env, CLEO_TASK_ID: "nope" }, which: () => "/cleo",
    current: () => ({ currentTask: { id: "T497" }, currentPhase: "implementation" }),
  });
  assert.equal(row().task, "T497");
  assert.equal(row().lane, "implementation");
  fillCleoPresence(n, {
    cli: "grok", sessionId: "s", env: { ...process.env, CLEO_TASK_ID: "" }, which: () => "/cleo",
    current: () => ({ currentTask: { id: "T500" }, currentPhase: null }),
  });
  assert.equal(row().task, "T500");
  assert.equal(row().lane, "implementation");
  fillCleoPresence(n, {
    cli: "grok", sessionId: "s", env: {}, which: () => "/cleo",
    current: () => { throw new Error("down"); },
  });
  assert.equal(row().task, "T500");
});
