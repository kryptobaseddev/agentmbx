// T548 AC3: mbx_whoami's `harness_session` is the session id the status surfaces key on. This test
// binds an identity through a live MCP server (OpenCode multi-session transport), reads
// `harness_session` from mbx_whoami, hands it to `agentmbx statusline <cli>` exactly as the
// harness wiring does, and asserts the bound segment comes back — while `session`/`lease_key` stay
// the lease key fingerprint for old clients.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { MbxNode } from "../src/node.ts";
import { writeHud } from "../src/hud.ts";

const bin = join(import.meta.dirname, "../bin/agentmbx.js");

const statusline = (h: string, cli: string, sessionId: string) =>
  spawnSync(process.execPath, [resolve(bin), "statusline", cli],
    { input: JSON.stringify({ session_id: sessionId }), encoding: "utf8",
      env: { ...process.env, AGENTMBX_DEV: "1", MBX_HOME: h, MBX_NO_DESKTOP: "1" } });

test("whoami's harness_session feeds the statusline and renders the bound segment (T548)", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "mbx-whoami-harness-")), n = new MbxNode(home, { host: "alpha" });
  const c = new Client({ name: "opencode", version: "test" });
  t.after(async () => { await c.close(); n.close(); rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
  await c.connect(new StdioClientTransport({ command: process.execPath, args: [bin, "mcp"],
    env: { ...process.env, AGENTMBX_DEV: "1", MBX_HOME: home, MBX_CLI: "opencode", MBX_AGENT: "oc-t548", MBX_NO_DESKTOP: "1" } as Record<string, string> }));
  const call = (sid: string, name: string, args = {}) => c.callTool({ name, arguments: args, _meta: { sessionID: sid } });

  assert.notEqual((await call("ses_t548", "mbx_identity", { action: "register", name: "t548-staff", role: "builder" })).isError, true);
  const who = (await call("ses_t548", "mbx_whoami", {})).structuredContent as
    { agent: string; session: string; harness_session: string; lease_key: string };
  assert.equal(who.agent, "t548-staff");
  assert.equal(who.harness_session, "ses_t548", "harness_session is the harness session id, not the lease key fingerprint");
  assert.equal(who.lease_key, who.session, "lease_key labels what `session` has always carried: the lease key fingerprint");
  assert.notEqual(who.harness_session, who.session, "the two ids must not collapse into one another");

  // The same id, handed to the statusline the way the harness wiring hands it over stdin.
  n.send({ from: "boss", to: ["t548-staff"], subject: "one", body: "b" });
  writeHud(n);
  const own = statusline(home, "opencode", who.harness_session);
  assert.equal(own.status, 0, own.stderr);
  assert.match(own.stdout, /^mbx t548-staff/, "whoami's harness_session renders this session's segment");
  assert.ok(own.stdout.includes("1↑"), "the segment carries this identity's counts");
  const unknown = statusline(home, "opencode", "ses_nope");
  assert.equal(unknown.stdout.trim(), "", "an unknown session still renders nothing (T308 AC2)");
});

// T571 AC3: after an in-place upgrade a Kimi server's lease keeps the provisional `mcp-<pid>` id while the
// provider's hooks bind the real session. whoami must report the hook-bound id as `harness_session` (the id the
// statusline keys on), without collapsing `session`/`lease_key` into it.
test("a provisional mcp-<pid> lease reports the hook-bound real session as harness_session (T571)", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "mbx-whoami-t571-")), project = mkdtempSync(join(tmpdir(), "mbx-t571-work-"));
  const n = new MbxNode(home, { host: "alpha" });
  const c = new Client({ name: "kimi", version: "test" });
  t.after(async () => { await c.close(); n.close(); for (const d of [home, project]) rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
  const env = { ...process.env, AGENTMBX_DEV: "1", MBX_HOME: home, MBX_CLI: "kimi", MBX_AGENT: "", MBX_NO_DESKTOP: "1" } as Record<string, string>;
  await c.connect(new StdioClientTransport({ command: process.execPath, args: [bin, "mcp"], env, cwd: project }));
  const whoami = () => c.callTool({ name: "mbx_whoami", arguments: {} }).then(r => r.structuredContent as { agent: string; session: string; harness_session: string; lease_key: string });

  assert.notEqual((await c.callTool({ name: "mbx_identity", arguments: { action: "register", name: "t571-staff", role: "builder" } })).isError, true);
  const before = await whoami();
  assert.equal(before.agent, "t571-staff");
  assert.match(before.harness_session, /^mcp-\d+$/, "the standalone Kimi lease starts provisional");

  // The provider's hook binds the real session of this same parent process (as after an in-place upgrade).
  const hook = spawnSync(process.execPath, [resolve(bin), "hook", "prompt", "--cli", "kimi"],
    { input: JSON.stringify({ session_id: "session_t571", cwd: realpathSync(project) }), encoding: "utf8", env });
  assert.equal(hook.status, 0, hook.stderr);

  const who = await whoami();
  assert.equal(who.harness_session, "session_t571", "whoami reports the hook-bound session, not the provisional lease id");
  assert.equal(who.lease_key, who.session, "lease_key still labels what `session` carries: the lease key fingerprint");
  assert.notEqual(who.harness_session, who.session, "the two ids must not collapse into one another");

  // The same id, handed to the statusline the way the harness wiring hands it over stdin.
  n.send({ from: "boss", to: ["t571-staff"], subject: "one", body: "b" });
  writeHud(n);
  const own = statusline(home, "kimi", who.harness_session);
  assert.equal(own.status, 0, own.stderr);
  assert.match(own.stdout, /^mbx t571-staff/, "whoami's harness_session renders this session's segment");
  assert.ok(own.stdout.includes("1↑"), "the segment carries this identity's counts");
  const stale = statusline(home, "kimi", before.harness_session);
  assert.equal(stale.stdout.trim(), "", "the retired provisional id renders nothing");
});
