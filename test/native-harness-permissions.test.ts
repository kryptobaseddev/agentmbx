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
