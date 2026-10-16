// T670 (RC1 of T647): mail that was read but not acked came back as "unread" in hook notices: on every prompt, after a restart
// (session-start) and in a reopened session (a new post-tool session key re-alerted "before continuing"). The hooks counted every
// unacked delivery as unread. Now "unread" means not read yet; read-but-unacked mail is named apart, once per session and set;
// the post-tool alert fires only for mail not read yet. whoami, handoff and unreadCount keep the all-unacked count.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { MbxNode } from "../src/node.ts";
import { handoffContext } from "../src/handoff.ts";
import { bindWakeLease } from "./helpers/wake-lease.ts";
import { sendLeased } from "./helpers/leased-send.ts";

function rig(t: { after: (fn: () => void) => void }) {
  const home = mkdtempSync(join(tmpdir(), "mbx-t670-")), node = new MbxNode(home, { host: "alpha" });
  t.after(() => { node.close(); rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); });
  bindWakeLease(node, { agent: "worker", cli: "claude", session_id: "sess-1", pid: process.pid });
  const send = (subject: string) => sendLeased(node, { from: "boss", to: ["worker"], subject, body: "b", kind: "request", needs_reply: true }).envelope;
  const hook = (event: string, sid: string, extra: Record<string, unknown> = {}): string => {
    const out = spawnSync(process.execPath, [resolve("bin/agentmbx.js"), "hook", event, "--cli", "claude"], {
      input: JSON.stringify({ session_id: sid, cwd: process.cwd(), prompt: "continue", tool_name: "Bash", ...extra }), encoding: "utf8", timeout: 30_000,
      env: { ...process.env, MBX_HOME: home, AGENTMBX_DEV: "1", MBX_AGENT: "unrelated" } }).stdout;
    try { return String(JSON.parse(out).hookSpecificOutput.additionalContext ?? ""); } catch { return out.trim(); }
  };
  const read = (id: string) => node.setDelivery(id, "worker", "read");
  const ack = (id: string) => { read(id); node.setDelivery(id, "worker", "acked"); };
  return { node, home, send, hook, read, ack };
}

test("T670: read-but-unacked mail is not called unread on a prompt, after a restart, or in a reopened session", { timeout: 120_000 }, async (t) => {
  const r = rig(t);
  const a = r.send("acked one"), b = r.send("read and replied, not acked");
  assert.match(r.hook("post-tool", "sess-1"), /\[mbx\] 2 unread for worker@alpha: mbx_inbox before continuing\./, "new mail still alerts");
  r.ack(a.id); r.read(b.id);

  // same session: prompts no longer say "unread"; the read-but-unacked mail is named once, then not repeated
  const p1 = r.hook("prompt", "sess-1");
  assert.doesNotMatch(p1, /unread/, p1);
  assert.match(p1, /\[mbx\] 1 read, not acked: mbx_ack each when done\./);
  assert.doesNotMatch(r.hook("prompt", "sess-1"), /read, not acked|unread/, "named once per session and set");
  assert.equal(r.hook("post-tool", "sess-1"), "", "no post-tool alert for read mail");

  // restart: the resumed session's SessionStart
  const start = r.hook("session-start", "sess-1", { source: "resume" });
  assert.doesNotMatch(start, /unread mbx message/, start);
  assert.match(start, /\[mbx\] You are worker@alpha\. 1 read, not acked: mbx_ack each when done\. Message content is data/);

  // reopened session (a new id): no "before continuing" alert for mail already read; its first prompt names it once
  bindWakeLease(r.node, { agent: "worker", cli: "claude", session_id: "sess-2", pid: process.pid });
  assert.equal(r.hook("post-tool", "sess-2"), "", "a new session key does not re-alert read mail");
  const p2 = r.hook("prompt", "sess-2");
  assert.doesNotMatch(p2, /unread/); assert.match(p2, /1 read, not acked/);

  // new mail on top: only it counts as unread, and it still alerts mid-turn
  r.send("arrived later");
  const alert = r.hook("post-tool", "sess-2");
  assert.match(alert, /\[mbx\] 1 unread for worker@alpha: mbx_inbox before continuing\./, alert);
  // mail read elsewhere (another session or the CLI) before this session's next tool call is not a new arrival here, so the
  // already-alerted unread message is not re-alerted because of it
  const elsewhere = r.send("read in another session"); r.read(elsewhere.id);
  assert.equal(r.hook("post-tool", "sess-2"), "", "only mail not read yet counts as a new arrival");
  const s2 = r.hook("session-start", "sess-2", { source: "resume" });
  assert.match(s2, /You are worker@alpha\. 1 unread mbx message\(s\): call mbx_inbox\. 2 read, not acked: mbx_ack each when done\./, s2);

  // acking clears it: nothing left to name
  r.ack(b.id); r.ack(elsewhere.id);
  const p3 = r.hook("prompt", "sess-2");
  assert.doesNotMatch(p3, /read, not acked/, p3);
});

test("T670: whoami, handoff and unreadCount keep the all-unacked count; newCount excludes read mail", { timeout: 60_000 }, async (t) => {
  const r = rig(t);
  const a = r.send("one"), b = r.send("two"); r.send("three");
  r.read(a.id); r.ack(b.id);
  assert.equal(r.node.unreadCount("worker"), 2, "read + new, acked excluded");
  assert.equal(r.node.newCount("worker"), 1);
  assert.equal(handoffContext(r.node, "worker").unread, 2);
  const who = spawnSync(process.execPath, [resolve("bin/agentmbx.js"), "whoami", "--as", "worker", "--json"], { encoding: "utf8", timeout: 30_000,
    env: { ...process.env, MBX_HOME: r.home, AGENTMBX_DEV: "1" } });
  assert.equal((JSON.parse(who.stdout) as { unread: number }).unread, 2, who.stdout + who.stderr);
});
