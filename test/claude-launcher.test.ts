// T044: `agentmbx claude` starts Claude Code with the mbx channel and passes everything else through.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claudeChannelArgs } from "../src/cli.ts";

test("the mbx channel is added once, and never duplicated when the caller already enabled it", () => {
  assert.deepEqual(claudeChannelArgs([]), ["--dangerously-load-development-channels", "server:mbx"]);
  assert.deepEqual(claudeChannelArgs(["--resume", "abc"]), ["--dangerously-load-development-channels", "server:mbx", "--resume", "abc"]);
  assert.deepEqual(claudeChannelArgs(["--channels", "server:mbx"]), ["--channels", "server:mbx"]);
  assert.deepEqual(claudeChannelArgs(["--dangerously-load-development-channels=server:mbx"]), ["--dangerously-load-development-channels=server:mbx"]);
  assert.deepEqual(claudeChannelArgs(["--channels", "plugin:telegram@x"]).slice(0, 2), ["--dangerously-load-development-channels", "server:mbx"],
    "another channel does not stand in for mbx");
});

test("the launcher runs the real binary with the channel, passes arguments through and returns its exit code", () => {
  const dir = mkdtempSync(join(tmpdir(), "mbx-claude-"));
  try {
    const fake = join(dir, "claude"), out = join(dir, "args.json");
    writeFileSync(fake, `#!/bin/sh\nnode -e 'require("fs").writeFileSync(process.argv[1], JSON.stringify(process.argv.slice(2)))' ${JSON.stringify(out)} "$@"\nexit 7\n`);
    chmodSync(fake, 0o755);
    const r = spawnSync(process.execPath, [join(import.meta.dirname, "../bin/agentmbx.js"), "claude", "--model", "opus", "-p", "hi there"],
      { env: { ...process.env, AGENTMBX_DEV: "1", MBX_CLAUDE_BIN: fake, MBX_HOME: dir }, encoding: "utf8" });
    assert.equal(r.status, 7, r.stderr);
    assert.deepEqual(JSON.parse(readFileSync(out, "utf8")), ["--dangerously-load-development-channels", "server:mbx", "--model", "opus", "-p", "hi there"]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
