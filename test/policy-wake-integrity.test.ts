import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { MbxNode } from "../src/node.ts";
import { dispatchWakes } from "../src/wake.ts";
import { bindWakeLease } from "./helpers/wake-lease.ts";
import { sendLeased } from "./helpers/leased-send.ts";

for (const defect of ["json", "signature", "expiry-cache"]) test(`valid lease cannot wake through a policy with corrupt ${defect}`, async t => {
  const home = mkdtempSync(join(tmpdir(), "mbx-policy-wake-")), n = new MbxNode(home, { host: "alpha" });
  const log = join(home, "calls"), bin = join(home, "codex");
  writeFileSync(bin, '#!/bin/sh\nprintf "%s\\n" "$3" >> "$MBX_TEST_WAKE_LOG"\n', { mode: 0o700 });
  const old = { MBX_CODEX_BIN: process.env.MBX_CODEX_BIN, MBX_TEST_WAKE_LOG: process.env.MBX_TEST_WAKE_LOG, MBX_NO_DESKTOP: process.env.MBX_NO_DESKTOP };
  Object.assign(process.env, { MBX_CODEX_BIN: bin, MBX_TEST_WAKE_LOG: log, MBX_NO_DESKTOP: "1" });
  t.after(() => {
    for (const [k, v] of Object.entries(old)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    n.close(); rmSync(home, { recursive: true, force: true });
  });
  bindWakeLease(n, { agent: "worker", cli: "codex", session_id: "exact-session", pid: process.pid });
  const policy = n.store.db.prepare("SELECT id,record,sig,exp FROM policies").get() as { id: string; record: string; sig: string; exp: string };
  if (defect === "json") n.store.db.prepare("UPDATE policies SET record='{' WHERE id=?").run(policy.id);
  if (defect === "signature") n.store.db.prepare("UPDATE policies SET sig='invalid' WHERE id=?").run(policy.id);
  if (defect === "expiry-cache") n.store.db.prepare("UPDATE policies SET exp='2099-01-01T00:00:00Z' WHERE id=?").run(policy.id);
  sendLeased(n, { from: "sender", to: ["worker"], subject: "retained", body: "private", kind: "request" });
  await dispatchWakes(n);
  assert.equal(existsSync(log), false, "invalid policy must not submit a provider prompt");
  assert.equal(n.unreadCount("worker"), 1);
  assert.equal((n.store.db.prepare("SELECT state FROM deliveries").get() as { state: string }).state, "notified", "desktop-only notice does not consume the unread message");
  // Restore the original fixture evidence to prove the lease/adapter setup is a working positive control.
  n.store.db.prepare("UPDATE policies SET record=?,sig=?,exp=? WHERE id=?").run(policy.record, policy.sig, policy.exp, policy.id);
  n.store.db.prepare("DELETE FROM wakes").run();
  sendLeased(n, { from: "sender", to: ["worker"], subject: "positive control", body: "private", kind: "request" });
  assert.equal((await dispatchWakes(n))[0]?.result.ok, true);
  assert.equal(readFileSync(log, "utf8"), "exact-session\n");
});
