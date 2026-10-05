// T384: Grok setup installs SessionStart, UserPromptSubmit and PostToolUse hooks that pass
// --cli grok; an unbound session hears the register prompt on PostToolUse; those hooks record
// the session hint under cli grok; doctor fails when the configured MCP command path is gone.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
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

const CMD = ["/opt/bin/agentmbx"];
const EVENTS = [["SessionStart", "session-start"], ["UserPromptSubmit", "prompt"], ["PostToolUse", "post-tool"]] as const;

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
    assert.doesNotMatch(text, /hook stop --cli grok|PermissionRequest/);
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
    assert.equal(prompt.stdout, "", "grok prompt guidance stays empty");
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
