import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync, spawnSync } from "node:child_process";
import { join } from "node:path";

test("OpenCode native harness preserves permission prompts without approving or deleting", () => {
  execFileSync("python3", [join(import.meta.dirname, "../scripts/e2e/test_wake_opencode.py")], { timeout: 10_000, stdio: "pipe" });
});

for (const provider of ["claude", "codex"]) {
  test(`${provider} legacy harness blocks before starting a provider`, () => {
    const result = spawnSync("python3", [join(import.meta.dirname, `../scripts/e2e/wake-${provider}.py`)], {
      timeout: 5_000, encoding: "utf8",
      // No CLI binaries or user configuration are available to the harness.
      env: { PATH: "/usr/bin:/bin", HOME: "/nonexistent-agentmbx-harness-home" },
    });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 3);
    assert.equal(result.stderr, "");
    const report = JSON.parse(result.stdout);
    assert.equal(report.provider, provider);
    assert.equal(report.outcome, "blocked_harness_unsupported");
    assert.equal(report.provider_started, false);
    assert.equal(report.receipt_verified, false);
  });
}

test("wake receipt inspector observes real mailbox replies and acknowledgments without writing", async (t) => {
  const { MbxNode } = await import("../src/node.ts");
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const home = mkdtempSync(join(tmpdir(), "mbx-native-receipt-"));
  const node = new MbxNode(home, { host: "e2e" });
  t.after(() => { node.close(); rmSync(home, { recursive: true, force: true }); });
  const request = node.send({ from: "tester", to: ["oc-agent"], subject: "wake", body: "PONG-exact", kind: "request" }).envelope;
  const inspect = () => JSON.parse(execFileSync("python3", ["-c",
    "import json,runpy,sys; print(json.dumps(runpy.run_path(sys.argv[1])['inspect_receipt'](*sys.argv[2:])))",
    join(import.meta.dirname, "../scripts/e2e/wake_receipt.py"), home, request.id, "oc-agent", "PONG-exact",
  ], { encoding: "utf8", timeout: 5_000 }));
  assert.equal(inspect().receipt_verified, false);
  const reply = node.send({ from: "oc-agent", to: ["tester"], subject: "reply", body: "PONG-exact", kind: "reply", reply_to: request.id, thread: request.thread }).envelope;
  assert.deepEqual(inspect().reply_ids, [reply.id]);
  assert.equal(inspect().acked, false);
  assert.equal(inspect().receipt_verified, false);
  node.ack(request.id, "oc-agent");
  const before = node.store.db.prepare("SELECT * FROM deliveries ORDER BY msg_id,agent").all();
  assert.equal(inspect().receipt_verified, true);
  assert.deepEqual(node.store.db.prepare("SELECT * FROM deliveries ORDER BY msg_id,agent").all(), before);
});

test("owner terminal preparation preserves argv and requires a terminal before launch", () => {
  execFileSync("python3", [join(import.meta.dirname, "../scripts/e2e/test_prepare_terminal.py")], { timeout: 10_000, stdio: "pipe" });
});
