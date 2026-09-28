import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { join } from "node:path";

test("OpenCode native harness preserves permission prompts without approving or deleting", () => {
  execFileSync("python3", [join(import.meta.dirname, "../scripts/e2e/test_wake_opencode.py")], { timeout: 10_000, stdio: "pipe" });
});
