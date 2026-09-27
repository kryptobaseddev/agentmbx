import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MbxNode } from "../src/node.ts";

test("Claude post-tool hook surfaces arrivals once, including linked names and equal-count replacements", () => {
  const n = new MbxNode(mkdtempSync(join(tmpdir(), "mbx-hooks-")), { host: "alpha" });
  try {
    n.bindSession({ agent: "builder", cli: "claude", session_id: "mcp-builder", pid: process.pid, session_key: "k" });
    const run = (session = "s1", cli = "claude") => {
      const r = spawnSync(process.execPath, ["bin/agentmbx.js", "hook", "post-tool", "--cli", cli], {
        input: JSON.stringify({ session_id: session, tool_name: "Bash" }), encoding: "utf8",
        env: { ...process.env, MBX_HOME: n.home, AGENTMBX_DEV: "1" },
      });
      assert.equal(r.status, 0, r.stderr);
      return r.stdout;
    };
    assert.equal(run(), "", "empty inbox is silent");
    const send = (to = "builder") => n.send({ from: "sender", to: [to], subject: "PRIVATE SUBJECT", body: "SECRET BODY", kind: "request" }).envelope.id;
    const first = send();
    const output = JSON.parse(run()).hookSpecificOutput;
    assert.equal(output.hookEventName, "PostToolUse");
    assert.match(output.additionalContext, /1 unread mbx message.*builder@alpha/);
    assert.doesNotMatch(output.additionalContext, /SECRET BODY|PRIVATE SUBJECT/);
    assert.equal(n.inbox("builder")[0].state, "delivered", "notice neither reads nor acknowledges mail");
    assert.equal(run(), "", "unchanged inbox is silent");
    n.ack(first, "builder");
    const second = send();
    assert.match(run(), /1 unread mbx message/, "new message at the same count still notifies");
    assert.equal(run(), "");
    assert.match(run("s2"), /1 unread mbx message/, "deduplication is session scoped");
    n.linkIdentity("shell-name", "builder");
    const linked = send("shell-name");
    assert.match(run(), /shell-name \(1; agentmbx inbox --as shell-name\)/);
    assert.equal(run(), "");
    n.ack(second, "builder");
    assert.equal(run(), "", "acknowledging a message does not repeat the remaining notice");
    n.ack(linked, "shell-name");
    assert.equal(run(), "");
    send();
    assert.equal(run("s1", "codex"), "", "unsupported providers do not receive Claude hook output");
    assert.match(run(), /1 unread mbx message/);
  } finally { n.close(); }
});
