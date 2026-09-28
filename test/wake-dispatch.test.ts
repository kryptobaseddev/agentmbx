import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { MbxNode } from "../src/node.ts";
import { dispatchWakes } from "../src/wake.ts";

for (const invalid of ["dead-pid", "reused-pid", "missing-birth", "expired", "no-pid", "provisional", "stale-channel", "live-channel"])
  test(`wake dispatch validates ${invalid} targets`, async (t) => {
    const home = mkdtempSync(join(tmpdir(), "mbx-wake-target-"));
    const n = new MbxNode(home, { host: "alpha" });
    const log = join(home, "calls"), bin = join(home, "codex");
    writeFileSync(bin, '#!/bin/sh\nprintf "%s\\n" "$3" >> "$MBX_TEST_WAKE_LOG"\n', { mode: 0o700 });
    const old = { MBX_CODEX_BIN: process.env.MBX_CODEX_BIN, MBX_TEST_WAKE_LOG: process.env.MBX_TEST_WAKE_LOG, MBX_NO_DESKTOP: process.env.MBX_NO_DESKTOP };
    Object.assign(process.env, { MBX_CODEX_BIN: bin, MBX_TEST_WAKE_LOG: log, MBX_NO_DESKTOP: "1" });
    t.after(() => { for (const [k,v] of Object.entries(old)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } n.close(); rmSync(home, { recursive: true, force: true }); });
    n.bindSession({ agent: "worker", cli: "codex", session_id: "valid", pid: process.pid });
    const bad = (invalid === "provisional" || invalid === "live-channel") ? "mcp-bad" : "invalid";
    // Both rows existed historically; control ordering so the invalid row is attempted first.
    n.store.db.prepare(`INSERT INTO sessions (agent,cli,session_id,pid,pid_start,channel,updated_at)
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
    n.send({ from: "sender", to: ["worker"], subject: "wake", body: "private body", kind: "request" });
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
