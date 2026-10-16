// T384: Grok setup installs SessionStart, UserPromptSubmit and PostToolUse hooks that pass
// --cli grok; an unbound session hears the register prompt on PostToolUse; those hooks record
// the session hint under cli grok; doctor fails when the configured MCP command path is gone.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parse as parseToml } from "smol-toml";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { doctor } from "../src/doctor.ts";
import { inspectLeaseProcess } from "../src/identity-leases.ts";
import { MbxNode } from "../src/node.ts";
import { registerIdentity, sessionHint, sessionHintKey } from "../src/registry.ts";
import { runSetup, type SetupCtx } from "../src/setup.ts";
import { sendLeased } from "./helpers/leased-send.ts";

const CMD = ["/opt/bin/agentmbx"];
const EVENTS = [["SessionStart", "session-start"], ["UserPromptSubmit", "prompt"], ["PostToolUse", "post-tool"], ["Stop", "stop"]] as const;

function homeWithGrok(): string {
  const home = mkdtempSync(join(tmpdir(), "mbx-grok-hooks-"));
  mkdirSync(join(home, ".grok"), { recursive: true });
  return home;
}
const ctxFor = (home: string, cmd = CMD): SetupCtx => ({ home, cmd, which: () => null, useClis: false });
const cfgPath = (home: string) => join(home, ".grok/config.toml");
const rd = (home: string) => readFileSync(cfgPath(home), "utf8");
const writeCfg = (home: string, body: string) => writeFileSync(cfgPath(home), body);

function commands(text: string, event: string): string[] {
  const parsed = parseToml(text) as { hooks?: Record<string, { hooks?: { command?: string }[] }[]> };
  const tables = parsed.hooks?.[event];
  assert.ok(Array.isArray(tables), `${event} missing in ${JSON.stringify(parsed.hooks ?? parsed)}`);
  return tables.flatMap((table) => (table.hooks ?? []).map((hook) => hook.command ?? ""));
}

function install(home: string, cmd = CMD) {
  return runSetup(ctxFor(home, cmd), { mode: "install", only: ["grok"], stamp: "T384" });
}
function uninstall(home: string, cmd = CMD) {
  return runSetup(ctxFor(home, cmd), { mode: "uninstall", only: ["grok"], stamp: "T384U" });
}

test("T384 AC1: setup installs grok hooks and uninstalls them byte-exactly", () => {
  const home = homeWithGrok();
  try {
    const rows = install(home);
    assert.ok(rows.some((r) => r.item.startsWith("hooks") && r.action === "added"), JSON.stringify(rows));
    const text = rd(home);
    for (const [event, sub] of EVENTS) {
      assert.deepEqual(commands(text, event), [`/opt/bin/agentmbx hook ${sub} --cli grok`]);
    }
    assert.doesNotMatch(text, /PermissionRequest/);
    assert.equal(install(home).filter((r) => r.cli === "grok" && r.action !== "unchanged" && r.action !== "skipped").length, 0, "second install is a no-op");
    assert.equal(rd(home), text);
    uninstall(home);
    assert.equal(existsSync(cfgPath(home)), false, "a setup-created config.toml is deleted");
  } finally { rmSync(home, { recursive: true, force: true }); }

  for (const [name, before] of [
    ["LF", `[models]\nb = 2\n\n[[hooks.SessionStart]]\nhooks = [{ type = "command", command = "my-session.sh", timeout = 5 }]\n\n[[hooks.PostToolUse]]\nmatcher = "Bash"\nhooks = [{ type = "command", command = "my-tool.sh", timeout = 5 }]\n`],
    ["LF no trailing newline", `[models]\nb = 2\n\n[[hooks.SessionStart]]\nhooks = [{ type = "command", command = "my-session.sh", timeout = 5 }]\n\n[[hooks.PostToolUse]]\nmatcher = "Bash"\nhooks = [{ type = "command", command = "my-tool.sh", timeout = 5 }]`],
    ["CRLF", `[models]\r\nb = 2\r\n\r\n[[hooks.SessionStart]]\r\nhooks = [{ type = "command", command = "my-session.sh", timeout = 5 }]\r\n\r\n[[hooks.PostToolUse]]\r\nmatcher = "Bash"\r\nhooks = [{ type = "command", command = "my-tool.sh", timeout = 5 }]\r\n`],
    ["CRLF no trailing newline", `[models]\r\nb = 2\r\n\r\n[[hooks.SessionStart]]\r\nhooks = [{ type = "command", command = "my-session.sh", timeout = 5 }]\r\n\r\n[[hooks.PostToolUse]]\r\nmatcher = "Bash"\r\nhooks = [{ type = "command", command = "my-tool.sh", timeout = 5 }]`],
  ] as const) {
    const home = homeWithGrok();
    try {
      writeCfg(home, before);
      install(home);
      const installed = rd(home);
      assert.ok(installed.includes("my-session.sh") && installed.includes("my-tool.sh") && installed.includes('matcher = "Bash"'), `${name}: user hooks stay`);
      for (const [event, sub] of EVENTS) assert.ok(commands(installed, event).includes(`/opt/bin/agentmbx hook ${sub} --cli grok`), `${name}: ${event}`);
      assert.equal(install(home).every((r) => r.action === "unchanged" || r.action === "skipped"), true, `${name}: idempotent`);
      uninstall(home);
      assert.equal(rd(home), before, `${name}: byte-identical after uninstall`);
    } finally { rmSync(home, { recursive: true, force: true }); }
  }

  const invalid = homeWithGrok();
  try {
    const broken = "this is not [valid toml";
    writeCfg(invalid, broken);
    install(invalid);
    assert.equal(rd(invalid), broken, "invalid TOML is not written");
  } finally { rmSync(invalid, { recursive: true, force: true }); }

  const conflict = homeWithGrok();
  try {
    const table = "[hooks]\nenabled = true\n";
    writeCfg(conflict, table);
    install(conflict);
    assert.match(rd(conflict), /\[mcp_servers\.mbx\]/, "the MCP section is a separate edit");
    assert.doesNotMatch(rd(conflict), /\[\[hooks/, "a [hooks] table blocks the array tables");
    assert.match(rd(conflict), /\[hooks\]\nenabled = true\n/);
    uninstall(conflict);
    assert.equal(rd(conflict), table, "uninstall restores the conflicting file byte-exactly");
  } finally { rmSync(conflict, { recursive: true, force: true }); }

  const stale = homeWithGrok();
  try {
    writeCfg(stale, `[models]\nb = 2\n\n[[hooks.PostToolUse]]\nmatcher = "Bash"\nhooks = [{ type = "command", command = "/old/agentmbx hook post-tool --cli grok", timeout = 30 }]\n`);
    install(stale);
    const rewritten = rd(stale);
    assert.match(rewritten, /matcher = "Bash"/);
    assert.match(rewritten, /timeout = 30/);
    assert.match(rewritten, /command = "\/opt\/bin\/agentmbx hook post-tool --cli grok"/);
    assert.doesNotMatch(rewritten, /\/old\/agentmbx hook post-tool/);
    assert.equal(commands(rewritten, "PostToolUse").filter((c) => c.includes("--cli grok")).length, 1, "the stale table is rewritten, not duplicated");
    assert.ok(rewritten.includes("my-") === false);
    uninstall(stale);
    assert.match(rd(stale), /\[models\]\nb = 2\n/);
    assert.doesNotMatch(rd(stale), /\[\[hooks/);
  } finally { rmSync(stale, { recursive: true, force: true }); }

  const composed = homeWithGrok();
  try {
    const before = `[[hooks.SessionStart]]\nhooks = [{ type = "command", command = "my.sh; /old/agentmbx hook session-start --cli grok", timeout = 10 }]\n`;
    writeCfg(composed, before);
    install(composed);
    const installed = rd(composed);
    assert.match(installed, /my\.sh; \/old\/agentmbx hook session-start --cli grok/, "a composed command stays foreign");
    assert.ok(commands(installed, "SessionStart").includes("/opt/bin/agentmbx hook session-start --cli grok"));
    uninstall(composed);
    assert.equal(rd(composed), before, "uninstall removes only our appended tables");
  } finally { rmSync(composed, { recursive: true, force: true }); }

  const dup = homeWithGrok();
  try {
    const table = (event: string, sub: string) => `[[hooks.${event}]]\nhooks = [{ type = "command", command = "/opt/bin/agentmbx hook ${sub} --cli grok", timeout = 10 }]\n`;
    writeCfg(dup, `${table("SessionStart", "session-start")}${table("SessionStart", "session-start")}${table("UserPromptSubmit", "prompt")}${table("PostToolUse", "post-tool")}`);
    install(dup);
    const installed = rd(dup);
    assert.equal((installed.match(/\[\[hooks\.SessionStart\]\]/g) ?? []).length, 1, "a duplicate of our own table is dropped");
    for (const [event, sub] of EVENTS) assert.deepEqual(commands(installed, event), [`/opt/bin/agentmbx hook ${sub} --cli grok`]);
  } finally { rmSync(dup, { recursive: true, force: true }); }

  const spaced = homeWithGrok();
  try {
    const cmd = ["/opt/my dir/agentmbx"];
    install(spaced, cmd);
    const text = rd(spaced);
    for (const [, sub] of EVENTS) assert.ok(text.includes(`'/opt/my dir/agentmbx' hook ${sub} --cli grok`), sub);
    assert.equal(install(spaced, cmd).filter((r) => r.action === "updated" || r.action === "added").length, 0);
    uninstall(spaced, cmd);
    assert.equal(existsSync(cfgPath(spaced)), false);
  } finally { rmSync(spaced, { recursive: true, force: true }); }
});

function hook(home: string, event: string, session: string) {
  const env: NodeJS.ProcessEnv = { ...process.env, MBX_HOME: home, AGENTMBX_DEV: "1" };
  delete env.MBX_AGENT;
  delete env.MBX_ROLE;
  delete env.MBX_DESCRIPTION;
  return spawnSync(process.execPath, [resolve("bin/agentmbx.js"), "hook", event, "--cli", "grok"], {
    input: JSON.stringify({ session_id: session, cwd: "/work" }),
    encoding: "utf8",
    timeout: 20_000,
    env,
  });
}

test("T384 AC2: an unbound grok session gets the register prompt on every PostToolUse", () => {
  const home = mkdtempSync(join(tmpdir(), "mbx-grok-unbound-"));
  const node = new MbxNode(home, { host: "alpha" });
  try {
    const sid = "grok-unbound-sid";
    const first = hook(home, "post-tool", sid);
    assert.equal(first.status, 0, first.stderr);
    const parsed = JSON.parse(first.stdout) as { hookSpecificOutput: { hookEventName: string; additionalContext: string } };
    assert.equal(parsed.hookSpecificOutput.hookEventName, "PostToolUse");
    assert.match(parsed.hookSpecificOutput.additionalContext, /no mailbox identity yet/);
    assert.match(parsed.hookSpecificOutput.additionalContext, /"action":"claim"/);
    assert.match(parsed.hookSpecificOutput.additionalContext, /"action":"register"/);
    const again = hook(home, "post-tool", sid);
    assert.equal(again.status, 0, again.stderr);
    assert.match(JSON.parse(again.stdout).hookSpecificOutput.additionalContext, /no mailbox identity yet/, "every unbound post-tool, not once");
    const prompt = hook(home, "prompt", sid);
    assert.equal(prompt.status, 0, prompt.stderr);
    assert.match(prompt.stdout, /mbx disconnected: reconnect/, "T503 reconnect guidance reaches a disconnected prompt");
    assert.doesNotMatch(prompt.stdout, /no mailbox identity yet/, "registration guidance stays on PostToolUse");
    const stop = hook(home, "stop", sid);
    assert.equal(stop.status, 0, stop.stderr);
    assert.equal(stop.stdout, "", "grok stop stays off this change");
    const start = hook(home, "session-start", sid);
    assert.equal(start.status, 0, start.stderr);
    assert.equal(JSON.parse(start.stdout).hookSpecificOutput.hookEventName, "SessionStart");
  } finally { node.close(); rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
});

test("T384 AC3: a grok post-tool hint rebinds a provisional grok MCP session", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "mbx-grok-hint-"));
  const sessions = join(home, "active_sessions.json");
  writeFileSync(sessions, "[]");
  const node = new MbxNode(home, { host: "alpha" });
  const client = new Client({ name: "grok-hint", version: "1" });
  const sid = "grok-real-sid";
  t.after(async () => {
    await client.close();
    node.close();
    rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  registerIdentity(node.store, { name: "agentmbx-grok", role: "grok", by: "test" });
  node.keepName("grok", sid, "agentmbx-grok");
  const unbound = hook(home, "post-tool", sid);
  assert.equal(unbound.status, 0, unbound.stderr);
  assert.match(unbound.stdout, /no mailbox identity yet/);
  const start = inspectLeaseProcess(process.pid).start;
  assert.ok(start, "the test process has birth-time evidence");
  assert.equal(sessionHint(node.store, "grok", process.pid, start), sid);
  assert.equal(node.store.get(sessionHintKey("claude", process.pid)) ?? null, null, "the grok hook does not record a claude hint");

  const env: Record<string, string> = { ...process.env, MBX_HOME: home, MBX_CLI: "grok", AGENTMBX_DEV: "1", MBX_GROK_SESSIONS_FILE: sessions };
  delete env.MBX_AGENT;
  delete env.MBX_ROLE;
  delete env.MBX_DESCRIPTION;
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [resolve("bin/agentmbx.js"), "mcp"], env }));
  const who = (await client.callTool({ name: "mbx_whoami", arguments: {} })).structuredContent as { agent?: string | null };
  assert.equal(who.agent, "agentmbx-grok", `provisional grok MCP did not rebind via the grok hint: ${JSON.stringify(who)}`);
  const lease = node.store.db.prepare("SELECT cli, session_id FROM identity_leases WHERE name=?").get("agentmbx-grok") as { cli: string; session_id: string };
  assert.equal(lease.cli, "grok");
  assert.equal(lease.session_id, sid, "the resumed lease uses the hinted session id");

  const bound = hook(home, "post-tool", sid);
  assert.equal(bound.status, 0, bound.stderr);
  assert.doesNotMatch(bound.stdout, /no mailbox identity yet/, "a leased grok post-tool does not repeat the register prompt");
  assert.equal(sessionHint(node.store, "grok", process.pid, start), sid, "the leased post-tool still records the grok hint");
});

test("T657: one live provisional grok control is the post-tool binding; two stay unbound", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "mbx-grok-provisional-"));
  const sessions = join(home, "active_sessions.json");
  writeFileSync(sessions, "{");
  const node = new MbxNode(home, { host: "alpha" });
  const first = new Client({ name: "grok-provisional", version: "1" });
  const second = new Client({ name: "grok-provisional-2", version: "1" });
  const sid = "t657-real-sid";
  t.after(async () => {
    await second.close().catch(() => {});
    await first.close().catch(() => {});
    node.close();
    rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  const envFor = (agent: string): Record<string, string> => {
    const env: Record<string, string> = { ...process.env, MBX_HOME: home, MBX_CLI: "grok", AGENTMBX_DEV: "1", MBX_AGENT: agent, MBX_ROLE: "grok", MBX_NO_DESKTOP: "1", MBX_GROK_SESSIONS_FILE: sessions };
    delete env.MBX_DESCRIPTION;
    return env;
  };
  const mcp = (client: Client, agent: string) => client.connect(new StdioClientTransport({ command: process.execPath, args: [resolve("bin/agentmbx.js"), "mcp"], env: envFor(agent) }));
  await mcp(first, "worker");
  const who = (await first.callTool({ name: "mbx_whoami", arguments: {} })).structuredContent as { agent?: string | null; harness_session?: string };
  assert.equal(who.agent, "worker");
  assert.match(who.harness_session ?? "", /^mcp-\d+$/, "a half-written sessions file leaves the lease provisional");
  const bound = hook(home, "post-tool", sid);
  assert.equal(bound.status, 0, bound.stderr);
  assert.doesNotMatch(bound.stdout, /no mailbox identity yet/, "the one live provisional control is this provider's binding");
  assert.match(bound.stdout, /No live mbx watcher/);
  const lease = node.store.db.prepare("SELECT session_id FROM identity_leases WHERE name=?").get("worker") as { session_id: string };
  assert.match(lease.session_id, /^mcp-\d+$/, "the post-tool does not claim or move the lease");
  await mcp(second, "scout");
  const other = (await second.callTool({ name: "mbx_whoami", arguments: {} })).structuredContent as { agent?: string | null; harness_session?: string };
  assert.equal(other.agent, "scout");
  assert.match(other.harness_session ?? "", /^mcp-\d+$/);
  const ambiguous = hook(home, "post-tool", sid);
  assert.equal(ambiguous.status, 0, ambiguous.stderr);
  assert.match(ambiguous.stdout, /no mailbox identity yet/, "two live provisional controls stay on the register prompt");
});

test("T657: a grok post-tool during mcp-starting says the identity is still resuming", (t) => {
  const home = mkdtempSync(join(tmpdir(), "mbx-grok-starting-"));
  const node = new MbxNode(home, { host: "alpha" });
  const sleeper = spawn("sleep", ["30"], { stdio: "ignore" });
  t.after(() => {
    sleeper.kill();
    node.close();
    rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  mkdirSync(join(home, "mcp-starting"), { recursive: true });
  writeFileSync(join(home, "mcp-starting", `${sleeper.pid}.json`), JSON.stringify({
    pid: sleeper.pid, parent: process.pid, cli: "grok", createdAt: Date.now(), generation: "t657b",
  }));
  const sid = "grok-starting-sid";
  const ran = hook(home, "post-tool", sid);
  assert.equal(ran.status, 0, ran.stderr);
  const parsed = JSON.parse(ran.stdout) as { hookSpecificOutput: { hookEventName: string; additionalContext: string } };
  assert.equal(parsed.hookSpecificOutput.hookEventName, "PostToolUse");
  assert.match(parsed.hookSpecificOutput.additionalContext, /identity is still resuming/);
  assert.doesNotMatch(parsed.hookSpecificOutput.additionalContext, /no mailbox identity yet/);
  assert.doesNotMatch(parsed.hookSpecificOutput.additionalContext, /"action":"claim"/);
  assert.doesNotMatch(parsed.hookSpecificOutput.additionalContext, /"action":"register"/);
  const start = inspectLeaseProcess(process.pid).start;
  assert.ok(start, "the test process has birth-time evidence");
  assert.equal(sessionHint(node.store, "grok", process.pid, start), null, "still resuming does not take the hint");
});

test("T384 AC4: doctor fails when a wired grok MCP command path does not exist", async () => {
  const binDir = mkdtempSync(join(tmpdir(), "mbx-grok-bin-"));
  const bin = join(binDir, "agentmbx");
  writeFileSync(bin, "");
  const home = homeWithGrok();
  const mbx = join(home, ".local/share/agentmbx");
  new MbxNode(mbx, { host: "alpha", port: 1 }).close();
  try {
    install(home, [bin]);
    const present = await doctor(ctxFor(home, [bin]), mbx);
    assert.ok(present.some((c) => c.level === "ok" && /^grok: MCP server wired/.test(c.label)), JSON.stringify(present));
    assert.equal(present.some((c) => c.label.includes("MCP command path does not exist")), false, JSON.stringify(present));
    rmSync(bin);
    const gone = await doctor(ctxFor(home, [bin]), mbx);
    assert.ok(gone.some((c) => c.level === "fail" && c.label === `grok: MCP command path does not exist (${bin})` && c.fix === "agentmbx setup --only grok"), JSON.stringify(gone));
    assert.ok(gone.some((c) => c.level === "ok" && /^grok: MCP server wired/.test(c.label)), "the command text still matches setup");
  } finally { rmSync(home, { recursive: true, force: true }); rmSync(binDir, { recursive: true, force: true }); }

  const missingHome = homeWithGrok();
  const missingMbx = join(missingHome, ".local/share/agentmbx");
  new MbxNode(missingMbx, { host: "alpha", port: 1 }).close();
  const missing = join(missingHome, "no-such-agentmbx");
  try {
    install(missingHome, [missing]);
    const checks = await doctor(ctxFor(missingHome, [missing]), missingMbx);
    assert.ok(checks.some((c) => c.level === "ok" && /^grok: MCP server wired/.test(c.label)), JSON.stringify(checks));
    assert.ok(checks.some((c) => c.level === "fail" && c.label === `grok: MCP command path does not exist (${missing})`), JSON.stringify(checks));
  } finally { rmSync(missingHome, { recursive: true, force: true }); }

  const bareHome = homeWithGrok();
  const bareMbx = join(bareHome, ".local/share/agentmbx");
  new MbxNode(bareMbx, { host: "alpha", port: 1 }).close();
  try {
    writeCfg(bareHome, `[mcp_servers.mbx]\ncommand = "agentmbx"\nargs = ["mcp"]\nenabled = true\n`);
    const checks = await doctor(ctxFor(bareHome, ["agentmbx"]), bareMbx);
    assert.equal(checks.some((c) => c.label.includes("MCP command path does not exist")), false, `a PATH name is not a missing file: ${JSON.stringify(checks)}`);
  } finally { rmSync(bareHome, { recursive: true, force: true }); }
});

// ---- T599: the bounded resume notice on the first bound PostToolUse (spec t184-provider-resume-adapters) ----
const noticeLines = (text: string) => text.split("\n").filter(l => /You are worker|not caught up on|open thread/.test(l));

async function grokHolder(t: { after: (fn: () => Promise<void> | void) => void }, session = "grok-A") {
  const home = mkdtempSync(join(tmpdir(), "mbx-grok-notice-"));
  const sessions = join(home, "active_sessions.json");
  const writeSid = (id: string) => writeFileSync(sessions, JSON.stringify([{ session_id: id, pid: process.pid, cwd: "/work", opened_at: new Date().toISOString() }]));
  writeSid(session);
  const n = new MbxNode(home, { host: "alpha" });
  const c = new Client({ name: "grok-notice", version: "1" });
  const env: Record<string, string> = { ...process.env, AGENTMBX_DEV: "1", MBX_HOME: home, MBX_CLI: "grok", MBX_AGENT: "worker", MBX_ROLE: "grok", MBX_NO_DESKTOP: "1", MBX_GROK_SESSIONS_FILE: sessions };
  delete env.MBX_DESCRIPTION;
  t.after(async () => { await c.close(); n.close(); rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
  await c.connect(new StdioClientTransport({ command: process.execPath, args: [resolve("bin/agentmbx.js"), "mcp"], env }));
  await c.callTool({ name: "mbx_whoami", arguments: {} });
  const hookEnv: NodeJS.ProcessEnv = { ...process.env, MBX_HOME: home, AGENTMBX_DEV: "1", MBX_NO_DESKTOP: "1" };
  delete hookEnv.MBX_AGENT; delete hookEnv.MBX_ROLE; delete hookEnv.MBX_DESCRIPTION;
  const hookCli = (cli: string, event: string, sid: string) => spawnSync(process.execPath, [resolve("bin/agentmbx.js"), "hook", event, "--cli", cli], {
    input: JSON.stringify({ session_id: sid, cwd: "/work" }), encoding: "utf8", timeout: 20_000, env: hookEnv,
  });
  const ctx = (out: string) => out.trim()
    ? ((JSON.parse(out) as { hookSpecificOutput?: { additionalContext?: string } }).hookSpecificOutput?.additionalContext ?? "")
    : "";
  const entries = () => (n.store.db.prepare("SELECT COUNT(*) n FROM kv WHERE k LIKE 'resume-entry:%'").get() as { n: number }).n;
  return { n, c, writeSid, hookCli, ctx, entries, follow: () => c.callTool({ name: "mbx_whoami", arguments: {} }) };
}

test("grok hooks (T599): SessionStart then the first bound PostToolUse carries the notice once; nothing moves", async t => {
  const { n, hookCli, ctx, entries } = await grokHolder(t);
  sendLeased(n, { from: "boss", to: ["worker"], subject: "PRIVATE SUBJECT", body: "SECRET BODY", kind: "request" });
  const state = () => JSON.stringify([
    n.store.db.prepare("SELECT msg_id,agent,state FROM deliveries ORDER BY msg_id").all(),
    n.store.get("catchup:worker"),
    n.store.db.prepare("SELECT name,cli,session_id,released_at FROM identity_leases ORDER BY name").all(),
  ]);
  const start = hookCli("grok", "session-start", "grok-A");
  assert.equal(start.status, 0, start.stderr);
  assert.equal(JSON.parse(start.stdout).hookSpecificOutput.hookEventName, "SessionStart");
  assert.equal(noticeLines(ctx(start.stdout)).filter(l => /not caught up on|open thread/.test(l)).length, 0, "SessionStart does not carry the notice");
  assert.equal(entries(), 0, "SessionStart does not take the entry");
  const before = state();
  const first = hookCli("grok", "post-tool", "grok-A");
  assert.equal(first.status, 0, first.stderr);
  const c1 = ctx(first.stdout);
  assert.equal(JSON.parse(first.stdout).hookSpecificOutput.hookEventName, "PostToolUse");
  const notice = noticeLines(c1).join("\n");
  assert.match(notice, /\[mbx\] You are worker@alpha \(role: grok\)\. When the owner ends this session/);
  assert.match(notice, /\[mbx\] worker has 1 message\(s\) since \S+ not caught up on; call mbx_catchup/);
  assert.match(notice, /\[mbx\] 1 open thread\(s\) with unacked mail\./);
  assert.doesNotMatch(c1, /PRIVATE SUBJECT|SECRET BODY/);
  assert.equal(noticeLines(c1).length, 3);
  const second = hookCli("grok", "post-tool", "grok-A");
  assert.equal(second.status, 0, second.stderr);
  assert.equal(noticeLines(ctx(second.stdout)).length, 0, "the same entry is not told again");
  assert.doesNotMatch(ctx(second.stdout), /No live mbx watcher/, "the watcher reminder waits");
  n.store.set("watchnag:grok:grok-A", new Date(Date.now() - 11 * 60_000).toISOString());
  const third = hookCli("grok", "post-tool", "grok-A");
  assert.match(ctx(third.stdout), /No live mbx watcher/, "after 10 minutes the reminder returns");
  assert.equal(state(), before, "no delivery state, checkpoint or lease moved");
});

test("grok hooks (T599): a new session id, a return to the old id, and a new process start each deliver once", async t => {
  const { n, hookCli, ctx, writeSid, follow } = await grokHolder(t);
  const told = (sid: string) => noticeLines(ctx(hookCli("grok", "post-tool", sid).stdout)).some(l => /You are worker/.test(l));
  hookCli("grok", "session-start", "grok-A");
  assert.equal(told("grok-A"), true);
  assert.equal(told("grok-A"), false);
  writeSid("grok-session-B");
  await follow();
  hookCli("grok", "session-start", "grok-session-B");
  assert.equal(told("grok-session-B"), true, "a new session id");
  assert.equal(told("grok-session-B"), false);
  writeSid("grok-A");
  await follow();
  hookCli("grok", "session-start", "grok-A");
  assert.equal(told("grok-A"), true, "back to an earlier id");
  const pid = (n.store.db.prepare("SELECT pid FROM sessions WHERE cli='grok' AND session_id='grok-A'").get() as { pid: number }).pid;
  n.store.set(`resume-entry:grok:${pid}`, "an-earlier-process-start grok-A");
  assert.equal(told("grok-A"), true, "a different pid_start on the same id");
  assert.equal(told("grok-A"), false);
});

test("grok hooks (T599): an unbound PostToolUse records no entry; the first bound one after the claim does", async t => {
  const home = mkdtempSync(join(tmpdir(), "mbx-grok-unbound-notice-"));
  const sessions = join(home, "active_sessions.json");
  writeFileSync(sessions, JSON.stringify([{ session_id: "later-A", pid: process.pid, cwd: "/work", opened_at: new Date().toISOString() }]));
  const n = new MbxNode(home, { host: "alpha" });
  const entries = () => (n.store.db.prepare("SELECT COUNT(*) n FROM kv WHERE k LIKE 'resume-entry:%'").get() as { n: number }).n;
  const unbound = hook(home, "post-tool", "later-A");
  assert.equal(unbound.status, 0, unbound.stderr);
  assert.match(unbound.stdout, /no mailbox identity yet/);
  assert.equal(entries(), 0);
  const c = new Client({ name: "grok-later", version: "1" });
  t.after(async () => { await c.close(); n.close(); rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
  const env: Record<string, string> = { ...process.env, AGENTMBX_DEV: "1", MBX_HOME: home, MBX_CLI: "grok", MBX_AGENT: "worker", MBX_ROLE: "grok", MBX_NO_DESKTOP: "1", MBX_GROK_SESSIONS_FILE: sessions };
  delete env.MBX_DESCRIPTION;
  await c.connect(new StdioClientTransport({ command: process.execPath, args: [resolve("bin/agentmbx.js"), "mcp"], env }));
  await c.callTool({ name: "mbx_whoami", arguments: {} });
  const start = hook(home, "session-start", "later-A");
  assert.equal(start.status, 0, start.stderr);
  assert.equal(entries(), 0, "the bound SessionStart still does not take the entry");
  const bound = hook(home, "post-tool", "later-A");
  assert.equal(bound.status, 0, bound.stderr);
  assert.match(bound.stdout, /You are worker@alpha/);
  assert.equal(entries(), 1);
});

test("grok hooks (T599): the Claude compatibility PostToolUse emits no notice and does not take the entry", async t => {
  const { hookCli, ctx, entries } = await grokHolder(t, "grok-compat");
  hookCli("grok", "session-start", "grok-compat");
  const claude = hookCli("claude", "post-tool", "grok-compat");
  assert.equal(claude.status, 0, claude.stderr);
  assert.equal(claude.stdout, "");
  assert.equal(entries(), 0, "the compat hook does not consume the entry");
  const grok = hookCli("grok", "post-tool", "grok-compat");
  assert.equal(grok.status, 0, grok.stderr);
  assert.match(ctx(grok.stdout), /You are worker@alpha/);
  assert.equal(entries(), 1);
});

test("grok hooks (T668): a released mailbox is invited by name and stays unclaimed", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "mbx-grok-t668-"));
  const sid = "grok-t668";
  const sessions = join(home, "active_sessions.json");
  writeFileSync(sessions, JSON.stringify([{ session_id: sid, pid: process.pid, cwd: "/work", opened_at: new Date().toISOString() }]));
  const n = new MbxNode(home, { host: "alpha" });
  const first = new Client({ name: "t668", version: "1" });
  const env: Record<string, string> = {
    ...process.env, AGENTMBX_DEV: "1", MBX_HOME: home, MBX_CLI: "grok", MBX_AGENT: "worker", MBX_ROLE: "grok",
    MBX_NO_DESKTOP: "1", MBX_GROK_SESSIONS_FILE: sessions,
  };
  delete env.MBX_DESCRIPTION;
  const second = new Client({ name: "t668-next", version: "1" });
  t.after(async () => {
    await second.close();
    await first.close();
    n.close();
    rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  await first.connect(new StdioClientTransport({ command: process.execPath, args: [resolve("bin/agentmbx.js"), "mcp"], env }));
  await first.callTool({ name: "mbx_whoami", arguments: {} });
  const held = n.store.db.prepare("SELECT session_id, released_at FROM identity_leases WHERE name='worker'").get() as { session_id: string; released_at: number | null };
  assert.equal(held.session_id, sid);
  assert.equal(held.released_at, null);
  await first.callTool({ name: "mbx_identity", arguments: { action: "release" } });
  await first.close();
  const released = n.store.db.prepare("SELECT session_id, release_reason, released_at FROM identity_leases WHERE name='worker'").get() as { session_id: string; release_reason: string; released_at: number | null };
  assert.equal(released.session_id, sid);
  assert.equal(released.release_reason, "released");
  assert.ok(released.released_at);
  assert.equal(n.store.get(`name:grok:${sid}`) ?? null, null);
  assert.deepEqual(n.store.db.prepare("SELECT name FROM identity_projects").all(), []);

  const expectInvite = (out: { status: number | null; stderr: string; stdout: string }, event: string) => {
    assert.equal(out.status, 0, out.stderr);
    const ctx = (JSON.parse(out.stdout) as { hookSpecificOutput: { hookEventName: string; additionalContext: string } }).hookSpecificOutput;
    assert.equal(ctx.hookEventName, event);
    assert.match(ctx.additionalContext, /no mailbox identity yet/);
    assert.match(ctx.additionalContext, /worker was released by this session/);
    assert.match(ctx.additionalContext, /"action":"claim","name":"worker"/);
    assert.doesNotMatch(ctx.additionalContext, /"action":"register"/);
  };
  expectInvite(hook(home, "session-start", sid), "SessionStart");

  const nextEnv = { ...env };
  delete nextEnv.MBX_AGENT;
  delete nextEnv.MBX_ROLE;
  await second.connect(new StdioClientTransport({ command: process.execPath, args: [resolve("bin/agentmbx.js"), "mcp"], env: nextEnv }));
  const body = (result: unknown) => {
    const content = (result as { content?: { type?: string; text?: string }[] }).content ?? [];
    return content.find((part) => part.type === "text")?.text ?? "";
  };
  const who = JSON.parse(body(await second.callTool({ name: "mbx_whoami", arguments: {} }))) as { agent: string | null; unbound?: boolean };
  assert.equal(who.agent, null);
  assert.equal(who.unbound, true);
  expectInvite(hook(home, "post-tool", sid), "PostToolUse");
  const whoAfter = JSON.parse(body(await second.callTool({ name: "mbx_whoami", arguments: {} }))) as { agent: string | null; unbound?: boolean };
  assert.equal(whoAfter.agent, null);
  assert.equal(whoAfter.unbound, true);
  const still = n.store.db.prepare("SELECT release_reason, released_at FROM identity_leases WHERE name='worker'").get() as { release_reason: string; released_at: number | null };
  assert.equal(still.release_reason, "released");
  assert.ok(still.released_at);
});
