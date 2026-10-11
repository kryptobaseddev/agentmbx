// T328: an unbound session-start names the claimable mailboxes for this directory and nothing else.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { IdentityLeases, inspectLeaseProcess } from "../src/identity-leases.ts";
import { MbxNode } from "../src/node.ts";
import { noteProject, projectOf, registerIdentity } from "../src/registry.ts";
import { sendLeased } from "./helpers/leased-send.ts";

const BIN = fileURLToPath(new URL("../bin/agentmbx.js", import.meta.url));
const CLIS = ["claude", "codex", "opencode", "kimi"] as const;

function contextOf(cli: string, stdout: string): string {
  if (cli === "kimi" || cli === "opencode") return stdout.trim();
  return (JSON.parse(stdout) as { hookSpecificOutput: { additionalContext: string } }).hookSpecificOutput.additionalContext.trim();
}

function start(home: string, cli: string, cwd: string, session: string) {
  return spawnSync(process.execPath, [BIN, "hook", "session-start", "--cli", cli], {
    input: JSON.stringify({ session_id: session, cwd }),
    encoding: "utf8",
    env: { ...process.env, MBX_HOME: home, AGENTMBX_DEV: "1" },
  });
}

test("T328 session-start lists only this directory's claimable mailboxes, the same way on every start path", () => {
  const root = mkdtempSync(join(tmpdir(), "mbx-t328-"));
  const dir = join(root, "orbit");
  const other = join(root, "elsewhere");
  mkdirSync(dir);
  mkdirSync(other);
  const home = join(root, "home");
  const node = new MbxNode(home);
  const here = projectOf(dir);
  assert.ok(here);
  registerIdentity(node.store, { name: "orbit-grok", role: "grok" });
  noteProject(node.store, "orbit-grok", here, true);
  registerIdentity(node.store, { name: "orbit-held", role: "reviewer" });
  noteProject(node.store, "orbit-held", here, true);
  registerIdentity(node.store, { name: "elsewhere-codex", role: "codex" });
  noteProject(node.store, "elsewhere-codex", projectOf(other)!, true);
  const startTime = inspectLeaseProcess(process.pid).start;
  assert.ok(startTime);
  new IdentityLeases(node.store).claim("orbit-held", {
    pid: process.pid, start: startTime, keyFp: "aaaa-bbbb-cccc-dddd", cli: "claude", sessionId: "held-fixture",
  });
  sendLeased(node, { from: "poster", to: ["orbit-grok"], subject: "SECRET SUBJECT", body: "SECRET BODY" });
  sendLeased(node, { from: "poster", to: ["orbit-held"], subject: "HELD SUBJECT", body: "HELD BODY" });
  const leasesBefore = node.store.db.prepare("SELECT name, session_id FROM identity_leases ORDER BY name").all();
  let seen = "";
  try {
    for (const cli of CLIS) {
      const session = `start-${cli}`;
      const result = start(home, cli, dir, session);
      assert.equal(result.status, 0, result.stderr);
      const context = contextOf(cli, result.stdout);
      if (!seen) seen = context;
      else assert.equal(context, seen, cli);
      assert.match(context, /This session has no mailbox identity yet/);
      assert.match(context, /orbit-grok role=grok last=\d{4}-\d{2}-\d{2}T\S* unread=1/);
      assert.match(context, /mbx_identity \{"action":"claim","name":"<name>"\}/);
      assert.match(context, /mbx_identity \{"action":"register","name":"orbit-<role>","role":"<role>"\}/);
      assert.match(context, /The session stays unbound until you claim or register/);
      assert.equal(context.split("\n").at(-1), "[mbx] When the owner ends this session or hands it off, call mbx_identity release after your final mailbox work.");
      assert.doesNotMatch(context, /orbit-held|elsewhere-codex|SECRET SUBJECT|SECRET BODY|HELD SUBJECT|HELD BODY|\d+ unread/);
      for (const line of context.split("\n")) assert.match(line, /^\[mbx\] /, line);
      assert.equal(node.store.db.prepare("SELECT session_id FROM sessions WHERE session_id=?").get(session), undefined);
    }
    assert.deepEqual(node.store.db.prepare("SELECT name, session_id FROM identity_leases ORDER BY name").all(), leasesBefore);
  } finally {
    node.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("T328 an empty directory says so and suggests the folder name", () => {
  const root = mkdtempSync(join(tmpdir(), "mbx-t328-empty-"));
  const dir = join(root, "emptybox");
  mkdirSync(dir);
  const home = join(root, "home");
  const node = new MbxNode(home);
  try {
    const result = start(home, "claude", dir, "start-empty");
    assert.equal(result.status, 0, result.stderr);
    const context = contextOf("claude", result.stdout);
    assert.match(context, /No mailboxes for this directory/);
    assert.match(context, /emptybox-<role>/);
    assert.match(context, /"action":"register"/);
    assert.doesNotMatch(context, /mbx_identity list/);
  } finally {
    node.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("T328 caps the claimable list at ten and points at mbx_identity list", () => {
  const root = mkdtempSync(join(tmpdir(), "mbx-t328-cap-"));
  const dir = join(root, "crowded");
  mkdirSync(dir);
  const home = join(root, "home");
  const node = new MbxNode(home);
  const here = projectOf(dir)!;
  for (let n = 1; n <= 11; n++) {
    const name = `box-${String(n).padStart(2, "0")}`;
    registerIdentity(node.store, { name, role: "grok" });
    noteProject(node.store, name, here, true);
  }
  try {
    const result = start(home, "opencode", dir, "start-cap");
    assert.equal(result.status, 0, result.stderr);
    const context = contextOf("opencode", result.stdout);
    for (let n = 1; n <= 10; n++) assert.match(context, new RegExp(`box-${String(n).padStart(2, "0")} role=grok`));
    assert.doesNotMatch(context, /box-11/);
    assert.match(context, /\[mbx\] \+1 more: mbx_identity list/);
  } finally {
    node.close();
    rmSync(root, { recursive: true, force: true });
  }
});
