// T385: Grok has no idle-session inject. The wake adapter says so and submits nothing.
// A Stop hook continues only a turn that is ending, matching Grok's Stop Decision Control.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { sendLeased } from "./helpers/leased-send.ts";
import { bindWakeLease } from "./helpers/wake-lease.ts";
import { doctor } from "../src/doctor.ts";
import { GROK_NO_PUSH, MbxNode } from "../src/node.ts";
import { recipientReceipts } from "../src/receipts.ts";
import type { SetupCtx } from "../src/setup.ts";
import { dispatchWakes, wakeGrok } from "../src/wake.ts";

const SID = "grok-wake-sid";

function hook(home: string, reason?: string) {
  const env: NodeJS.ProcessEnv = { ...process.env, MBX_HOME: home, AGENTMBX_DEV: "1" };
  delete env.MBX_AGENT;
  delete env.MBX_ROLE;
  delete env.MBX_DESCRIPTION;
  return spawnSync(process.execPath, [resolve("bin/agentmbx.js"), "hook", "stop", "--cli", "grok"], {
    input: JSON.stringify({ session_id: SID, cwd: "/work", ...(reason ? { reason } : {}) }),
    encoding: "utf8",
    timeout: 20_000,
    env,
  });
}

test("wakeGrok submits nothing and names the missing inject", async () => {
  const held = await wakeGrok(SID, "[mbx] hint");
  assert.equal(held.ok, false);
  assert.equal(held.outcome?.kind, "not_submitted");
  if (held.outcome?.kind === "not_submitted") assert.equal(held.outcome.reason, "unsupported");
  assert.equal(held.outcome?.detail, GROK_NO_PUSH);
  const fenced = await wakeGrok(SID, "[mbx] hint", { recheck: () => false });
  assert.equal(fenced.outcome?.kind, "not_submitted");
  if (fenced.outcome?.kind === "not_submitted") assert.equal(fenced.outcome.reason, "fenced");
});

test("a live grok session receipt and dispatch state the gap, and a watcher still counts as push", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "mbx-grok-wake-"));
  const n = new MbxNode(home, { host: "alpha" });
  const old = process.env.MBX_NO_DESKTOP;
  process.env.MBX_NO_DESKTOP = "1";
  t.after(() => {
    if (old === undefined) delete process.env.MBX_NO_DESKTOP; else process.env.MBX_NO_DESKTOP = old;
    n.close();
    rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  bindWakeLease(n, { agent: "worker", cli: "grok", session_id: SID, pid: process.pid });
  assert.equal(n.deliveryMode("worker"), GROK_NO_PUSH);
  const sent = sendLeased(n, { from: "sender", to: ["worker"], subject: "ping", body: "private", kind: "request" });
  const receipt = recipientReceipts(n, sent.envelope.id, sent.targets)[0];
  assert.equal(receipt.state, "live-next-prompt");
  assert.equal(receipt.detail.endsWith(GROK_NO_PUSH), true, receipt.detail);
  const [out] = await dispatchWakes(n);
  assert.ok(out, "dispatch returned a wake");
  const result = out.result;
  assert.equal(result.ok, false);
  assert.ok("outcome" in result && result.outcome, JSON.stringify(result));
  assert.equal(result.outcome.kind, "not_submitted");
  if (result.outcome.kind === "not_submitted") assert.equal(result.outcome.reason, "unsupported");
  assert.equal(result.outcome.detail, GROK_NO_PUSH);
  n.store.set("watcher:worker", JSON.stringify({ pid: process.pid, at: Date.now() }));
  assert.match(n.deliveryMode("worker"), /^push \(mbx watcher/);
});

test("doctor records the grok gap as info", async () => {
  const home = mkdtempSync(join(tmpdir(), "mbx-grok-doctor-"));
  mkdirSync(join(home, ".grok"), { recursive: true });
  const mbx = join(home, ".local/share/agentmbx");
  new MbxNode(mbx, { host: "alpha", port: 1 }).close();
  const ctx: SetupCtx = { home, cmd: ["/opt/bin/agentmbx"], which: () => null, useClis: false };
  try {
    const checks = await doctor(ctx, mbx);
    assert.ok(checks.some((c) => c.level === "info" && c.label === `grok: ${GROK_NO_PUSH}`), JSON.stringify(checks));
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("grok stop continues an ending turn and ignores a session-end stop", () => {
  const home = mkdtempSync(join(tmpdir(), "mbx-grok-stop-"));
  const n = new MbxNode(home, { host: "alpha" });
  try {
    bindWakeLease(n, { agent: "worker", cli: "grok", session_id: SID, pid: process.pid });
    sendLeased(n, { from: "sender", to: ["worker"], subject: "during turn", body: "private", kind: "request" });
    const ending = hook(home, "end_turn");
    assert.equal(ending.status, 0, ending.stderr);
    const parsed = JSON.parse(ending.stdout) as { decision?: string; reason?: string };
    assert.equal(parsed.decision, "block");
    assert.match(parsed.reason ?? "", /new message\(s\) for worker/);
    const again = hook(home, "end_turn");
    assert.equal(again.stdout, "", "mail already surfaced does not continue again");
    sendLeased(n, { from: "sender", to: ["worker"], subject: "still open", body: "private", kind: "request" });
    const shutdown = hook(home, "shutdown");
    assert.equal(shutdown.status, 0, shutdown.stderr);
    assert.equal(shutdown.stdout, "", "a session-end Stop has no turn to continue");
    const later = hook(home, "end_turn");
    assert.equal(later.status, 0, later.stderr);
    const continued = JSON.parse(later.stdout) as { decision?: string; reason?: string };
    assert.equal(continued.decision, "block", "shutdown must not consume the mail a later end_turn continues");
  } finally { n.close(); rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
});
