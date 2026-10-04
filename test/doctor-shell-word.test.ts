import { test } from "node:test";
import assert from "node:assert/strict";
import { firstShellWord } from "../src/doctor.ts";
import { shJoin } from "../src/setup.ts";

test("doctor reads back every script path setup writes, including spaces and quotes (T347 re-review)", () => {
  for (const p of ["/Users/a/.claude/skills/mbx/scripts/claude-statusline.sh", "/Users/Jane Doe/x/claude-statusline.sh", "/tmp/it's here/kimi-statusline.sh", "/a/$HOME/b"]) {
    assert.equal(firstShellWord(shJoin(["sh", p]).slice(3)), p);
  }
  assert.equal(firstShellWord(`"/Users/Jane Doe/s.sh" extra`), "/Users/Jane Doe/s.sh");
  assert.equal(firstShellWord(`/bare/path.sh`), "/bare/path.sh");
  assert.equal(firstShellWord(`'unterminated`), null);
  assert.equal(firstShellWord(`   `), null);
});
