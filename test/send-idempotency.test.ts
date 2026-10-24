// T735: agentmbx send --idempotency-key sends once per sender and key (CLEO's watcher retries).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { MbxNode } from "../src/node.ts";

test("T735 a repeated send with the same idempotency key returns the original message and sends nothing new", (t) => {
  const home = mkdtempSync(join(tmpdir(), "mbx-t735-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  { const n0 = new MbxNode(home, { host: "alpha" }); n0.registerAgent("drum", { cli: "cli" }); n0.close(); }
  const env = { ...process.env, AGENTMBX_DEV: "1", MBX_HOME: home, MBX_NO_DESKTOP: "1" };
  const send = (key: string, body: string) => spawnSync(process.execPath, [resolve("bin/agentmbx.js"), "send", "--as", "cleo-watcher", "--to", "drum",
    "--subject", "doctor digest", "-m", body, "--idempotency-key", key, "--json"], { encoding: "utf8", env, input: "" });
  const first = send("digest-2026-10-24", "one");
  assert.equal(first.status, 0, first.stderr);
  const a = JSON.parse(first.stdout) as { id: string; thread: string };
  const again = send("digest-2026-10-24", "two");
  assert.equal(again.status, 0, again.stderr);
  const b = JSON.parse(again.stdout) as { id: string; thread: string; duplicate: boolean };
  assert.deepEqual([b.id, b.thread, b.duplicate], [a.id, a.thread, true]);
  const other = JSON.parse(send("digest-2026-10-25", "three").stdout) as { id: string };
  assert.notEqual(other.id, a.id);
  const n = new MbxNode(home);
  t.after(() => n.close());
  assert.equal((n.store.db.prepare("SELECT count(*) AS c FROM messages").get() as { c: number }).c, 2);
});
