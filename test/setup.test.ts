// `agentmbx setup` / `doctor` against a fake HOME whose configs copy the STRUCTURE of real ones (fake values only).
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";
import { doctor, failed, statuslineChecks, VERSION } from "../src/doctor.ts";
import { parse as parseToml } from "smol-toml";
import { insertMember, member, parseJsonc, removeMember, valueOf } from "../src/jsonc.ts";
import { detectHost } from "../src/mcp.ts";
import { MbxNode } from "../src/node.ts";
import { grokSessionId } from "../src/proc.ts";
import { mcpConfiguredCmd, mcpConfiguredTimeout, resolveCommand, runSetup, skillDest, statuslineState, type SetupCtx } from "../src/setup.ts";

const ORCA = "if [ -f \"$HOME/.orca/agent-hooks/hook.sh\" ]; then /bin/sh \"$HOME/.orca/agent-hooks/hook.sh\"; fi";
const orcaGroups = (events: string[]) => Object.fromEntries(events.map((e) => [e, [{ hooks: [{ type: "command", command: ORCA, timeout: 10 }] }]]));

const FILES: Record<string, string> = {
  ".claude.json": JSON.stringify({ numStartups: 4, mcpServers: { context7: { type: "http", url: "https://example.invalid/mcp", headers: { "X-API-KEY": "fake-key" } } }, projects: {} }, null, 2),
  ".claude/settings.json": JSON.stringify({ permissions: { allow: ["Bash(ls:*)"] }, hooks: { ...orcaGroups(["SessionStart", "UserPromptSubmit", "Stop"]), PreToolUse: [{ matcher: "*", hooks: [{ type: "command", command: ORCA }] }] }, theme: "dark" }, null, 2) + "\n",
  ".codex/config.toml": `model = "fake-model"

[mcp_servers.context7]
url = "https://example.invalid/mcp"

[mcp_servers.context7.env_http_headers]
API_KEY = "fake"

[projects."/tmp/x"]
trust_level = "trusted"
`,
  ".codex/hooks.json": JSON.stringify({ hooks: orcaGroups(["SessionStart", "UserPromptSubmit", "PreToolUse"]) }, null, 2) + "\n",
  ".config/opencode/opencode.jsonc": `{
  "$schema": "https://opencode.ai/config.json",
  // my MCP servers
  "mcp": {
    "servers": {
      "cloudflare": { "type": "remote", "url": "https://example.invalid/mcp", "oauth": {} }, // trailing comment
      /* block comment */
      "playwright": {
        "type": "local",
        "command": ["npx", "-y", "@playwright/mcp@latest"],
      },
    }
  }
}
`,
  ".kimi-code/config.toml": `default_model = "fake"
# >>> orca-managed-kimi-hooks (managed by Orca; do not edit) >>>
[[hooks]]
event = "UserPromptSubmit"
command = "true"
timeout = 10
# <<< orca-managed-kimi-hooks <<<
`,
  ".hermes/config.yaml": `model:
  default: fake-model
  provider: custom
agent:
  max_turns: 200
`,
};

function fakeHome() {
  const home = mkdtempSync(join(tmpdir(), "mbx-setup-"));
  for (const [rel, body] of Object.entries(FILES)) { mkdirSync(dirname(join(home, rel)), { recursive: true }); writeFileSync(join(home, rel), body); }
  mkdirSync(join(home, ".claude/skills"), { recursive: true });
  mkdirSync(join(home, ".codex/skills"), { recursive: true });
  return home;
}
const ctxFor = (home: string, cmd = ["/opt/bin/agentmbx"]): SetupCtx => ({ home, cmd, which: () => null, useClis: false });
const rd = (home: string, rel: string) => readFileSync(join(home, rel), "utf8");

test("setup wires every CLI, backs files up, leaves other hook groups alone, and is idempotent", () => {
  const home = fakeHome(); const ctx = ctxFor(home);
  const rows = runSetup(ctx, { mode: "install", stamp: "T1" });
  assert.ok(!rows.some((r) => r.action === "error"), JSON.stringify(rows.filter((r) => r.action === "error")));
  for (const cli of ["claude", "codex", "opencode", "kimi", "hermes"]) assert.ok(rows.some((r) => r.cli === cli && r.action === "added"), `${cli} added`);

  // backups of every pre-existing file that changed; none for files that did not exist
  for (const rel of Object.keys(FILES)) assert.equal(readFileSync(join(home, `${rel}.bak-agentmbx-T1`), "utf8"), FILES[rel], `backup of ${rel}`);
  assert.ok(!existsSync(join(home, ".kimi-code/mcp.json.bak-agentmbx-T1")));

  // Claude: MCP server + two appended hook groups; Orca's groups untouched and still first
  assert.deepEqual(JSON.parse(rd(home, ".claude.json")).mcpServers.mbx, { type: "stdio", command: "/opt/bin/agentmbx", args: ["mcp"], env: {} });
  const s = JSON.parse(rd(home, ".claude/settings.json"));
  assert.deepEqual(s.hooks.SessionStart[0], orcaGroups(["SessionStart"]).SessionStart[0]);
  assert.equal(s.hooks.SessionStart[1].hooks[0].command, "/opt/bin/agentmbx hook session-start --cli claude");
  assert.equal(s.hooks.UserPromptSubmit[1].hooks[0].command, "/opt/bin/agentmbx hook prompt --cli claude");
  assert.equal(s.hooks.Stop.length, 2); assert.equal(s.hooks.Stop[1].hooks[0].command, "/opt/bin/agentmbx hook stop --cli claude");
  assert.equal(s.hooks.PreToolUse.length, 1);
  // Review major 5: the skill installs before the edits, so the first run already wires the bundled
  // sh fast path (the script path, then the resolved command as arguments).
  assert.match(s.hooks.PostToolUse[0].hooks[0].command, /^sh .*claude-posttool\.sh \/opt\/bin\/agentmbx$/, "PostToolUse is the bundled fast path on the first run");
  assert.equal(s.hooks.SessionEnd[0].hooks[0].command, "/opt/bin/agentmbx hook session-end --cli claude");

  // Codex
  assert.match(rd(home, ".codex/config.toml"), /\[mcp_servers\.mbx\]\ncommand = "\/opt\/bin\/agentmbx"\nargs = \["mcp"\]\ndefault_tools_approval_mode = "approve"\nstartup_timeout_sec = 30\n$/);
  const ch = JSON.parse(rd(home, ".codex/hooks.json")).hooks;
  assert.equal(ch.SessionStart.length, 2); assert.equal(ch.SessionStart[0].hooks[0].command, ORCA);
  assert.equal(ch.UserPromptSubmit[1].hooks[0].command, "/opt/bin/agentmbx hook prompt --cli codex");
  assert.equal(ch.PostToolUse, undefined, "only install the provider-supported hook");

  // OpenCode: comments survive, mbx sits under mcp.servers
  const oc = rd(home, ".config/opencode/opencode.jsonc");
  for (const c of ["// my MCP servers", "// trailing comment", "/* block comment */"]) assert.ok(oc.includes(c), c);
  assert.ok(oc.includes(`"mbx": { "type": "local", "command": ["/opt/bin/agentmbx", "mcp"], "timeout": { "startup": 30000, "catalog": 30000 } },`));
  assert.ok(member(member(member(parseJsonc(oc), "mcp")!.value, "servers")!.value, "mbx"));

  // Kimi: mcp.json created, hooks appended after Orca's block
  assert.deepEqual(JSON.parse(rd(home, ".kimi-code/mcp.json")), { mcpServers: { mbx: { command: "/opt/bin/agentmbx", args: ["mcp"] } } });
  const kt = rd(home, ".kimi-code/config.toml");
  assert.ok(kt.startsWith(FILES[".kimi-code/config.toml"]));
  assert.match(kt, /event = "UserPromptSubmit"\ncommand = "\/opt\/bin\/agentmbx hook prompt --cli kimi"/);

  // Hermes: the MCP server, then (T460) the shell hooks and their approvals
  const hy = rd(home, ".hermes/config.yaml");
  assert.match(hy, /\nmcp_servers:\n  mbx:\n    command: "\/opt\/bin\/agentmbx"\n    args: \["mcp"\]\n    connect_timeout: 60\n/);
  assert.match(hy, /\nhooks:  # managed by agentmbx setup\n  on_session_start:  # managed by agentmbx setup\n    - command: "\/opt\/bin\/agentmbx hook session-start --cli hermes"\n      timeout: 10\n  pre_llm_call:  # managed by agentmbx setup\n    - command: "\/opt\/bin\/agentmbx hook prompt --cli hermes"\n      timeout: 10\n$/);
  assert.deepEqual(JSON.parse(rd(home, ".hermes/shell-hooks-allowlist.json")).approvals.map((a: { event: string; command: string }) => [a.event, a.command]),
    [["on_session_start", "/opt/bin/agentmbx hook session-start --cli hermes"], ["pre_llm_call", "/opt/bin/agentmbx hook prompt --cli hermes"]]);
  assert.equal((statSync(join(home, ".hermes/shell-hooks-allowlist.json")).mode & 0o777), 0o600, "a file setup creates for consent is private");

  // Skill copied + linked
  assert.match(readFileSync(join(skillDest(home), "SKILL.md"), "utf8"), /^---\nname: agentmbx\n/);
  assert.match(readFileSync(join(skillDest(home), "SKILL.md"), "utf8"), /Ending a session and handing off its mailbox/);
  assert.equal(readFileSync(join(skillDest(home), "scripts/claude-statusline.sh"), "utf8"),
    readFileSync(join(import.meta.dirname, "../skill/scripts/claude-statusline.sh"), "utf8"));
  for (const d of [".claude/skills/agentmbx", ".codex/skills/agentmbx"]) assert.equal(readlinkSync(join(home, d)), skillDest(home));

  // Review major 5: the skill installs BEFORE the CLI edits, so the very first run already wires
  // the bundled sh adapters — no upgrade run needed afterwards.
  const firstSettings = JSON.parse(rd(home, ".claude/settings.json"));
  assert.match(firstSettings.hooks.PostToolUse.at(-1).hooks[0].command, /claude-posttool\.sh/, "PostToolUse is the bundled fast path on the first run");
  assert.match(firstSettings.statusLine.command, /claude-statusline\.sh/, "the statusLine is the bundled pure-sh adapter on the first run");

  // second run: nothing changes, no duplicates, no new backups
  const snapshot = Object.fromEntries(Object.keys(FILES).map((rel) => [rel, rd(home, rel)]));
  const again = runSetup(ctx, { mode: "install", stamp: "T2" });
  assert.deepEqual(again.filter((r) => r.action !== "unchanged" && r.action !== "skipped"), []);
  for (const rel of Object.keys(FILES)) assert.equal(rd(home, rel), snapshot[rel], `${rel} unchanged on rerun`);
  assert.ok(!readdirSync(join(home, ".codex")).some((f) => f.includes("T2")));
});

test("setup updates a stale command path in place instead of adding a duplicate", () => {
  const home = fakeHome();
  runSetup(ctxFor(home, ["/old/agentmbx"]), { mode: "install", stamp: "A" });
  const rows = runSetup(ctxFor(home, ["/new/bin/agentmbx"]), { mode: "install", stamp: "B" });
  assert.ok(rows.filter((r) => r.cli !== "skill" && r.action !== "manual" && r.action !== "skipped" && r.action !== "unchanged").every((r) => r.action === "updated"), JSON.stringify(rows));
  // the status lines legitimately stay: the bundled sh adapter's command names the script path,
  // which does not move with the agentmbx command
  assert.equal(rows.find((r) => r.item.startsWith("statusLine"))?.action, "unchanged");
  assert.equal(rows.find((r) => r.item.startsWith("[status_line]"))?.action, "unchanged");
  const s = JSON.parse(rd(home, ".claude/settings.json"));
  assert.equal(s.hooks.SessionStart.length, 2);
  assert.equal(s.hooks.SessionStart[1].hooks[0].command, "/new/bin/agentmbx hook session-start --cli claude");
  assert.equal((rd(home, ".codex/config.toml").match(/\[mcp_servers\.mbx\]/g) ?? []).length, 1);
  assert.equal((rd(home, ".config/opencode/opencode.jsonc").match(/"mbx"/g) ?? []).length, 1);
  assert.equal((rd(home, ".kimi-code/config.toml").match(/>>> agentmbx/g) ?? []).length, 1);
  assert.equal((rd(home, ".hermes/config.yaml").match(/mbx:/g) ?? []).length, 1);
  // T460: a moved binary rewrites our hook commands in place and replaces (never accumulates) the approvals
  const hy = rd(home, ".hermes/config.yaml");
  assert.equal((hy.match(/agentmbx hook /g) ?? []).length, 2, "still exactly two hook commands");
  assert.match(hy, /command: "\/new\/bin\/agentmbx hook prompt --cli hermes"/);
  assert.doesNotMatch(hy, /\/opt\/bin\/agentmbx hook/);
  assert.deepEqual(JSON.parse(rd(home, ".hermes/shell-hooks-allowlist.json")).approvals.map((a: { command: string }) => a.command),
    ["/new/bin/agentmbx hook session-start --cli hermes", "/new/bin/agentmbx hook prompt --cli hermes"]);
});

test("dry run writes nothing; --only limits the CLIs", () => {
  const home = fakeHome();
  const rows = runSetup(ctxFor(home), { mode: "install", dryRun: true });
  assert.ok(rows.some((r) => r.action === "added"));
  for (const rel of Object.keys(FILES)) assert.equal(rd(home, rel), FILES[rel]);
  assert.ok(!existsSync(join(home, ".kimi-code/mcp.json")) && !existsSync(skillDest(home)));
  const only = runSetup(ctxFor(home), { mode: "install", only: ["codex"] });
  assert.deepEqual([...new Set(only.map((r) => r.cli))], ["codex"]);
  assert.equal(rd(home, ".claude/settings.json"), FILES[".claude/settings.json"]);
});

test("doctor reports wiring per CLI and fails until setup ran", async () => {
  const home = fakeHome(); const mbx = join(home, ".local/share/agentmbx");
  new MbxNode(mbx, { host: "alpha", port: 1 }).close(); // nothing listens on port 1
  const before = await doctor(ctxFor(home), mbx);
  assert.ok(failed(before));
  assert.ok(before.some((c) => c.level === "fail" && /^claude: MCP server not wired/.test(c.label) && c.fix === "agentmbx setup --only claude"));
  runSetup(ctxFor(home), { mode: "install" });
  const after = await doctor(ctxFor(home), mbx);
  for (const re of [/^claude: MCP server wired/, /^claude: hooks wired/, /^codex: MCP server wired/, /^codex: hooks wired/, /^opencode: MCP server wired/,
    /^kimi: MCP server wired/, /^kimi: hooks wired/, /^hermes: MCP server wired/, /^skill installed/, /^host alpha initialized/])
    assert.ok(after.some((c) => c.level === "ok" && re.test(c.label)), `${re}: ${JSON.stringify(after)}`);
  assert.ok(after.some((c) => c.level === "fail" && /daemon not answering/.test(c.label)), "no daemon in the test");
});

// T502: every harness whose MCP config has a real startup-timeout field gets one written explicitly
// (>= 30s); doctor warns (never fails) on a missing or too-short one, and the next setup run repairs it.
test("T502: setup writes an explicit MCP startup timeout for codex, opencode and hermes, and grok", async () => {
  const home = fakeHome(); const ctx = ctxFor(home);
  const rows = runSetup(ctx, { mode: "install", stamp: "T502" });
  assert.ok(!rows.some((r) => r.action === "error"), JSON.stringify(rows.filter((r) => r.action === "error")));

  // codex: startup_timeout_sec (seconds) — codex aborts an MCP whose startup exceeds it.
  const codex = rd(home, ".codex/config.toml");
  assert.match(codex, /\[mcp_servers\.mbx\]\ncommand = "\/opt\/bin\/agentmbx"\nargs = \["mcp"\]\ndefault_tools_approval_mode = "approve"\nstartup_timeout_sec = 30\n/);
  assert.equal(mcpConfiguredTimeout(home, "codex"), 30);

  // opencode: timeout is {startup, catalog} in milliseconds (T541). A number is what 2.0 drops.
  const oc = rd(home, ".config/opencode/opencode.jsonc");
  const mbx = member(member(member(parseJsonc(oc), "mcp")!.value, "servers")!.value, "mbx")!.value;
  assert.deepEqual((valueOf(oc, mbx) as { timeout: unknown }).timeout, { startup: 30_000, catalog: 30_000 });
  assert.equal(mcpConfiguredTimeout(home, "opencode"), 30);

  // hermes: connect_timeout (seconds) — the initial-connection/startup knob.
  const hy = rd(home, ".hermes/config.yaml");
  assert.match(hy, /\n  mbx:\n    command: "\/opt\/bin\/agentmbx"\n    args: \["mcp"\]\n    connect_timeout: 60\n/);
  assert.equal(mcpConfiguredTimeout(home, "hermes"), 60);

  // grok's own schema has startup_timeout_sec too (claude and kimi have no such field: nothing written).
  const homeG = fakeHome(); mkdirSync(join(homeG, ".grok"), { recursive: true });
  runSetup(ctxFor(homeG), { mode: "install", stamp: "T502g" });
  assert.match(rd(homeG, ".grok/config.toml"), /\[mcp_servers\.mbx\]\ncommand = "\/opt\/bin\/agentmbx"\nargs = \["mcp"\]\nenabled = true\nstartup_timeout_sec = 30\n/);
  assert.equal(mcpConfiguredTimeout(homeG, "grok"), 30);
  assert.equal(mcpConfiguredTimeout(home, "claude"), null, "claude's MCP entry has no timeout field");
  assert.equal(mcpConfiguredTimeout(home, "kimi"), null, "kimi's MCP entry has no timeout field");

  // the readers see exactly what was configured
  assert.deepEqual(mcpConfiguredCmd(home, "codex"), ["/opt/bin/agentmbx"]);
  assert.deepEqual(mcpConfiguredCmd(home, "hermes"), ["/opt/bin/agentmbx"]);
  assert.deepEqual(mcpConfiguredCmd(home, "claude"), ["/opt/bin/agentmbx"]);
  assert.deepEqual(mcpConfiguredCmd(homeG, "grok"), ["/opt/bin/agentmbx"]);
  rmSync(homeG, { recursive: true, force: true });

  // a config an older setup wrote (no timeout) stays "wired"; doctor warns, and the next setup run repairs it.
  const mbxHome = join(home, ".local/share/agentmbx");
  new MbxNode(mbxHome, { host: "alpha", port: 1 }).close();
  writeFileSync(join(home, ".codex/config.toml"), `model = "fake-model"\n\n[mcp_servers.mbx]\ncommand = "/opt/bin/agentmbx"\nargs = ["mcp"]\ndefault_tools_approval_mode = "approve"\n`);
  let checks = await doctor(ctxFor(home), mbxHome);
  assert.ok(checks.some((c) => c.level === "ok" && /^codex: MCP server wired/.test(c.label)), "an old entry without a timeout is still wired");
  assert.ok(checks.some((c) => c.level === "warn" && c.label === "codex: MCP startup timeout is not set" && c.fix === "agentmbx setup --only codex"), JSON.stringify(checks));
  const repair = runSetup(ctxFor(home), { mode: "install", only: ["codex"], stamp: "T502b" });
  assert.ok(repair.some((r) => r.cli === "codex" && r.item === "[mcp_servers.mbx]" && r.action === "updated"), JSON.stringify(repair));
  assert.equal(mcpConfiguredTimeout(home, "codex"), 30);
  checks = await doctor(ctxFor(home), mbxHome);
  assert.ok(!checks.some((c) => /^codex: MCP startup timeout/.test(c.label)), "no warning once the timeout is in place");

  // a too-short timeout warns with the value, and setup raises it.
  writeFileSync(join(home, ".codex/config.toml"), rd(home, ".codex/config.toml").replace("startup_timeout_sec = 30", "startup_timeout_sec = 5"));
  checks = await doctor(ctxFor(home), mbxHome);
  assert.ok(checks.some((c) => c.level === "warn" && c.label === "codex: MCP startup timeout is 5s (< 30s)"), JSON.stringify(checks));
  runSetup(ctxFor(home), { mode: "install", only: ["codex"], stamp: "T502c" });
  assert.equal(mcpConfiguredTimeout(home, "codex"), 30);
});

// T541: OpenCode 2.0 drops mcp.servers.mbx when timeout is a number. Setup writes {startup, catalog},
// rewrites a numeric timeout in place, and a second run leaves the file alone. Doctor reads the
// object (startup seconds) and warns on a number with the setup fix command.
test("T541: OpenCode timeout is {startup,catalog}; a number is rewritten in place and a re-run is unchanged", async () => {
  const home = fakeHome();
  const ctx = ctxFor(home);
  const other = `"other": { "type": "remote", "url": "https://example.invalid/mcp", "timeout": 5000 }`;
  const before = `{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "servers": {
      ${other},
      "mbx": { "type": "local", "command": ["/opt/bin/agentmbx", "mcp"], "enabled": true, "timeout": 30000 }
    }
  }
}
`;
  writeFileSync(join(home, ".config/opencode/opencode.jsonc"), before);
  const mbxHome = join(home, ".local/share/agentmbx");
  new MbxNode(mbxHome, { host: "alpha", port: 1 }).close();
  assert.equal(mcpConfiguredTimeout(home, "opencode"), null, "a numeric timeout is not the v2 form");
  let checks = await doctor(ctx, mbxHome);
  assert.ok(checks.some((c) => c.level === "ok" && /^opencode: MCP server wired/.test(c.label)), "a numeric timeout is still wired");
  assert.ok(checks.some((c) => c.level === "warn" && c.label === "opencode: MCP startup timeout is not set" && c.fix === "agentmbx setup --only opencode"), JSON.stringify(checks));

  const rows = runSetup(ctx, { mode: "install", only: ["opencode"], stamp: "T541" });
  assert.ok(rows.some((r) => r.cli === "opencode" && r.item === "mcp.servers.mbx" && r.action === "updated"), JSON.stringify(rows));
  const after = rd(home, ".config/opencode/opencode.jsonc");
  assert.ok(after.includes(other), "the other server, including its own numeric timeout, stays byte-identical");
  assert.ok(after.includes(`"mbx": { "type": "local", "command": ["/opt/bin/agentmbx", "mcp"], "enabled": true, "timeout": { "startup": 30000, "catalog": 30000 } }`));
  assert.equal(mcpConfiguredTimeout(home, "opencode"), 30);
  checks = await doctor(ctx, mbxHome);
  assert.ok(!checks.some((c) => /^opencode: MCP startup timeout/.test(c.label)), JSON.stringify(checks));

  const again = runSetup(ctx, { mode: "install", only: ["opencode"], stamp: "T541b" });
  assert.ok(again.some((r) => r.cli === "opencode" && r.item === "mcp.servers.mbx" && r.action === "unchanged"), JSON.stringify(again));
  assert.equal(rd(home, ".config/opencode/opencode.jsonc"), after);
});

// T504: the MCP command setup registers is the absolute node binary plus the absolute, symlink-resolved
// agentmbx entry script — never the mise shim — and doctor fails the row when that command cannot
// resolve agentmbx or resolves a different version than this install.
test("T504: resolveCommand is the absolute node binary plus the resolved entry script", () => {
  const cmd = resolveCommand();
  assert.equal(cmd.length, 2, "not the single shim/binary form");
  assert.equal(cmd[0], process.execPath, "the actual node binary running setup");
  assert.ok(isAbsolute(cmd[0]));
  assert.equal(cmd[1], realpathSync(join(import.meta.dirname, "../bin/agentmbx.js")), "the realpath of the agentmbx entry script");
  assert.ok(existsSync(cmd[1]));
});

test("T504: doctor fails a wired MCP command whose path is missing or whose version differs", async () => {
  // a fake install layout: node + script, with a package.json naming the version the script resolves to.
  const installDir = mkdtempSync(join(tmpdir(), "mbx-t504-install-"));
  const script = join(installDir, "bin", "agentmbx.js");
  mkdirSync(dirname(script), { recursive: true });
  writeFileSync(script, "#!/usr/bin/env node\n");
  const pkg = (v: string) => writeFileSync(join(installDir, "package.json"), JSON.stringify({ name: "agentmbx", version: v }));
  pkg(VERSION);
  const cmd = [process.execPath, script];
  const home = fakeHome(); const ctx = ctxFor(home, cmd);
  const mbxHome = join(home, ".local/share/agentmbx");
  new MbxNode(mbxHome, { host: "alpha", port: 1 }).close();
  try {
    const rows = runSetup(ctx, { mode: "install", stamp: "T504" });
    assert.ok(!rows.some((r) => r.action === "error"), JSON.stringify(rows.filter((r) => r.action === "error")));
    // setup registered the node + script form in every harness config
    assert.deepEqual(mcpConfiguredCmd(home, "claude"), cmd);
    assert.deepEqual(mcpConfiguredCmd(home, "codex"), cmd);
    assert.deepEqual(mcpConfiguredCmd(home, "opencode"), cmd);
    assert.deepEqual(mcpConfiguredCmd(home, "kimi"), cmd);
    assert.deepEqual(mcpConfiguredCmd(home, "hermes"), cmd);
    assert.equal(JSON.parse(rd(home, ".claude.json")).mcpServers.mbx.command, process.execPath);
    assert.deepEqual(JSON.parse(rd(home, ".claude.json")).mcpServers.mbx.args, [script, "mcp"]);
    assert.match(rd(home, ".codex/config.toml"), new RegExp(`command = "${process.execPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"`));

    // everything resolves: no command-path failure
    let checks = await doctor(ctxFor(home, cmd), mbxHome);
    assert.ok(!checks.some((c) => /MCP command (path|node binary) does not exist|MCP command resolves agentmbx/.test(c.label)), JSON.stringify(checks));

    // missing command path: every wired CLI fails its row, with the repair
    rmSync(script);
    checks = await doctor(ctxFor(home, cmd), mbxHome);
    for (const cli of ["claude", "codex", "opencode", "kimi", "hermes"])
      assert.ok(checks.some((c) => c.level === "fail" && c.label === `${cli}: MCP command path does not exist (${script})` && c.fix === `agentmbx setup --only ${cli}`), `${cli}: ${JSON.stringify(checks)}`);

    // a script that resolves a different agentmbx version than this install fails the row
    writeFileSync(script, "#!/usr/bin/env node\n");
    pkg("0.0.0-old");
    checks = await doctor(ctxFor(home, cmd), mbxHome);
    assert.ok(checks.some((c) => c.level === "fail" && c.label === `codex: MCP command resolves agentmbx 0.0.0-old, but this install is ${VERSION} (${script})`), JSON.stringify(checks));
    assert.ok(!checks.some((c) => /MCP command path does not exist/.test(c.label)), "the path exists again: only the version fails");

    // and setup repairs both by rewriting the entry to this install
    const repair = runSetup(ctxFor(home, [process.execPath, realpathSync(join(import.meta.dirname, "../bin/agentmbx.js"))]), { mode: "install", only: ["codex"], stamp: "T504b" });
    assert.equal(repair.find((r) => r.cli === "codex" && r.item === "[mcp_servers.mbx]")?.action, "updated");
  } finally { rmSync(installDir, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true }); }
});

test("uninstall removes exactly what setup added", () => {  const home = fakeHome();
  runSetup(ctxFor(home), { mode: "install" });
  const rows = runSetup(ctxFor(home), { mode: "uninstall", stamp: "U" });
  assert.ok(!rows.some((r) => r.action === "error"));
  for (const rel of Object.keys(FILES)) assert.equal(rd(home, rel), FILES[rel], `${rel} restored`);
  assert.ok(!existsSync(join(home, ".kimi-code/mcp.json")), "file setup created is removed");
  assert.ok(!existsSync(skillDest(home)));
  for (const d of [".claude/skills/agentmbx", ".codex/skills/agentmbx"]) assert.throws(() => lstatSync(join(home, d)));
  assert.deepEqual(runSetup(ctxFor(home), { mode: "uninstall" }).filter((r) => r.action === "removed"), []);
});

test("jsonc: insert and remove keep surrounding text byte-for-byte", () => {
  const src = `{\n  // c\n  "a": 1, /* x */\n  "b": [1, 2,],\n}\n`;
  const root = parseJsonc(src);
  const ins = insertMember(src, root, "mbx", `{ "x": 1 }`);
  assert.equal(removeMember(ins, parseJsonc(ins), "mbx"), src);
  const last = `{\n  "a": 1,\n  "b": 2\n}`;
  assert.equal(removeMember(last, parseJsonc(last), "b"), `{\n  "a": 1\n}`);
  const empty = insertMember(`{}`, parseJsonc(`{}`), "k", "1");
  assert.deepEqual(JSON.parse(empty), { k: 1 });
});

test("self-watch: only when delegated or forced, even intervals, off removes the job", async () => {
  const { selfWatchInstruction, watchCron } = await import("../src/mcp.ts");
  assert.equal(selfWatchInstruction({ delegated: false, env: {} }), null);
  assert.match(selfWatchInstruction({ delegated: true, env: {} })!, /cron "\*\/15 \* \* \* \*"/);
  assert.match(selfWatchInstruction({ delegated: false, env: { MBX_SELF_WATCH: "5" } })!, /\*\/5 /);
  assert.equal(selfWatchInstruction({ delegated: true, env: { MBX_SELF_WATCH: "7" } }), null); // not a divisor of 60
  assert.match(selfWatchInstruction({ delegated: true, env: { MBX_SELF_WATCH: "0" } })!, /CronDelete/);
  assert.match(selfWatchInstruction({ delegated: true, env: { MBX_KIMI_WATCH: "off" } })!, /CronDelete/);
  assert.equal(watchCron(60), "0 * * * *");
});

test("setup policy default: collaborate (ratified), explicit wins, no terminal + passphrase backend signs nothing", async () => {
  const { setupPolicyLevel } = await import("../src/cli.ts");
  assert.equal(setupPolicyLevel({ answer: "", keychain: true }), "collaborate");
  assert.equal(setupPolicyLevel({ answer: "1", keychain: true }), "ask");
  assert.equal(setupPolicyLevel({ answer: "4", keychain: false }), "yolo");
  assert.equal(setupPolicyLevel({ keychain: true }), "collaborate");
  assert.equal(setupPolicyLevel({ keychain: false }), undefined);
  assert.equal(setupPolicyLevel({ explicit: "ask", keychain: true }), "ask");
});

// T347 (review round 2): exact-match ours, additive key preservation, robust section detection,
// byte-exact uninstall, skill-first wiring.
test("T347: setup wires statuslines, never overwrites a user's, reports the snippet", () => {
  // Claude: a user's own statusLine is foreign — even one that mentions our script path in another form.
  for (const foreign of ["my-own-statusline.sh", "bash ~/bin/claude-statusline.sh"]) {
    const home = fakeHome(); const ctx = ctxFor(home);
    writeFileSync(join(home, ".claude/settings.json"), JSON.stringify({ hooks: {}, statusLine: { type: "command", command: foreign } }));
    const rows = runSetup(ctx, { mode: "install", stamp: "S1" });
    assert.equal(JSON.parse(rd(home, ".claude/settings.json")).statusLine.command, foreign, `a foreign statusLine is never overwritten: ${foreign}`);
    const manual = rows.find((r) => r.cli === "claude" && r.action === "manual" && r.item === "statusLine");
    assert.ok(manual, "the foreign status line is reported");
    assert.match(manual!.note!, /left alone/);
    assert.match(manual!.note!, /statusline claude|claude-statusline\.sh/, "and the report prints our snippet");
    runSetup(ctx, { mode: "uninstall", stamp: "S2" });
    assert.equal(JSON.parse(rd(home, ".claude/settings.json")).statusLine.command, foreign, "uninstall never removes a foreign statusLine");
    rmSync(home, { recursive: true, force: true });
  }

  // Claude: keep the user's other keys when normalizing ours (padding survives).
  const home2 = fakeHome(); const ctx2 = ctxFor(home2);
  writeFileSync(join(home2, ".claude/settings.json"), JSON.stringify({ hooks: {}, statusLine: { type: "command", command: "/opt/bin/agentmbx statusline claude", padding: 2 } }));
  runSetup(ctx2, { mode: "install", stamp: "S3" });
  const kept = JSON.parse(rd(home2, ".claude/settings.json")).statusLine;
  assert.equal(kept.padding, 2, "the user's padding survives normalization");
  assert.equal(kept.type, "command");
  assert.match(kept.command, /claude-statusline\.sh/, "normalized to the bundled adapter (skill-first)");
  runSetup(ctx2, { mode: "uninstall", stamp: "S4" });
  assert.equal(JSON.parse(rd(home2, ".claude/settings.json")).statusLine, undefined, "uninstall drops the whole statusLine once our command is out — Claude may reject a command-less one (re-review item 3)");

  // Claude absent: script form on the first run (skill-first), no-op afterwards, uninstall removes it.
  rmSync(home2, { recursive: true, force: true });
  const home3 = fakeHome(); const ctx3 = ctxFor(home3);
  runSetup(ctx3, { mode: "install", stamp: "S5" });
  assert.match(JSON.parse(rd(home3, ".claude/settings.json")).statusLine.command, /claude-statusline\.sh/);
  assert.equal(runSetup(ctx3, { mode: "install", stamp: "S6" }).filter((r) => r.cli === "claude" && r.item.startsWith("statusLine") && r.action !== "unchanged").length, 0);
  runSetup(ctx3, { mode: "uninstall", stamp: "S7" });
  assert.equal(JSON.parse(rd(home3, ".claude/settings.json")).statusLine, undefined);
  rmSync(home3, { recursive: true, force: true });

  // Kimi re-review item 1: a user's own [status_line] with items and NO command is foreign —
  // setup never adds to their section; it reports and prints the snippet.
  const home4 = fakeHome(); const ctx4 = ctxFor(home4);
  writeFileSync(join(home4, ".kimi-code/tui.toml"), `theme = "dark"\n\n[status_line]\nitems = ["mode","model"]\n`);
  const rows4 = runSetup(ctx4, { mode: "install", stamp: "S8" });
  const untouched = rd(home4, ".kimi-code/tui.toml");
  assert.equal(untouched, `theme = "dark"\n\n[status_line]\nitems = ["mode","model"]\n`, "their section is never edited");
  assert.ok(rows4.find((r) => r.cli === "kimi" && r.action === "manual"), "and it is reported");
  runSetup(ctx4, { mode: "uninstall", stamp: "S9" });
  assert.equal(rd(home4, ".kimi-code/tui.toml"), untouched, "uninstall leaves it too");
  rmSync(home4, { recursive: true, force: true });

  // Kimi re-review item 3's sibling: OUR command plus their items — normalization keeps items.
  const home4b = fakeHome(); const ctx4b = ctxFor(home4b);
  writeFileSync(join(home4b, ".kimi-code/tui.toml"), `theme = "dark"\n\n[status_line]\ncommand = "agentmbx statusline kimi"\nitems = ["mode","model"]\n`);
  runSetup(ctx4b, { mode: "install", stamp: "S8b" });
  const normalized = rd(home4b, ".kimi-code/tui.toml");
  assert.match(normalized, /items = \["mode","model"\]/, "the user's items stay when our command is normalized");
  assert.match(normalized, /command = "[^"]*kimi-statusline\.sh"/, "and our command is the bundled adapter");
  runSetup(ctx4b, { mode: "uninstall", stamp: "S9b" });
  const removed = rd(home4b, ".kimi-code/tui.toml");
  assert.match(removed, /items = \["mode","model"\]/, "uninstall removes only our command line — items stay");
  assert.doesNotMatch(removed, /kimi-statusline\.sh|statusline kimi/);
  rmSync(home4b, { recursive: true, force: true });

  // Kimi: every non-section status_line form is foreign — never a duplicate table appended.
  for (const [name, body] of [
    ["inline table", `theme = "dark"\nstatus_line = { command = "mine.sh" }\n`],
    ["dotted key", `theme = "dark"\nstatus_line.items = ["mode"]\n`],
  ]) {
    const h = fakeHome(); const c = ctxFor(h);
    writeFileSync(join(h, ".kimi-code/tui.toml"), body);
    const rows = runSetup(c, { mode: "install", stamp: "SA" });
    assert.equal(rd(h, ".kimi-code/tui.toml"), body, `${name}: never written`);
    assert.ok(rows.find((r) => r.cli === "kimi" && r.action === "manual"), `${name}: reported`);
    rmSync(h, { recursive: true, force: true });
  }

  // Kimi: CRLF, a trailing comment, and inner spaces are the same section — no duplicate table.
  const home5 = fakeHome(); const ctx5 = ctxFor(home5);
  writeFileSync(join(home5, ".kimi-code/tui.toml"), `theme = "dark"\r\n\r\n[ status_line ] # mine\r\ncommand = "my-own.sh"\r\n`);
  runSetup(ctx5, { mode: "install", stamp: "SB" });
  assert.equal(rd(home5, ".kimi-code/tui.toml").match(/\[ *status_line *\]/g)!.length, 1, "no duplicate [status_line] table");
  assert.match(rd(home5, ".kimi-code/tui.toml"), /command = "my-own\.sh"/, "the foreign command is untouched");
  rmSync(home5, { recursive: true, force: true });

  // Kimi: byte-exact uninstall — a file setup created is deleted; a user's file keeps its bytes.
  const home6 = fakeHome(); const ctx6 = ctxFor(home6);
  runSetup(ctx6, { mode: "install", stamp: "SC" });
  assert.ok(existsSync(join(home6, ".kimi-code/tui.toml")), "setup creates tui.toml");
  runSetup(ctx6, { mode: "uninstall", stamp: "SD" });
  assert.ok(!existsSync(join(home6, ".kimi-code/tui.toml")), "uninstall removes a file it created entirely");
  rmSync(home6, { recursive: true, force: true });
  const home7 = fakeHome(); const ctx7 = ctxFor(home7);
  const userToml = `theme = "dark"\n\n\n[editor]\ncommand = "vim"\n`;
  writeFileSync(join(home7, ".kimi-code/tui.toml"), userToml);
  runSetup(ctx7, { mode: "install", stamp: "SE" });
  runSetup(ctx7, { mode: "uninstall", stamp: "SF" });
  assert.equal(rd(home7, ".kimi-code/tui.toml"), userToml, "byte-exact: the user's file returns to its exact bytes (blank lines and all)");
  rmSync(home7, { recursive: true, force: true });
});

// T337 (review round 2): grok is a first-class CLI — unique-pid session lookup with a staleness
// check, robust section detection, exact-match ours, keep-user-keys edits, scoped viaCli, and
// byte-exact uninstall.
test("T337: grok session detection, MCP and statusline wiring, never overwrites", () => {
  // grokSessionId: exactly one matching row, not older than the process — anything else is null.
  const sessions = mkdtempSync(join(tmpdir(), "mbx-grok-sess-"));
  const sessFile = join(sessions, "active_sessions.json");
  const prev = process.env.MBX_GROK_SESSIONS_FILE;
  process.env.MBX_GROK_SESSIONS_FILE = sessFile;
  const fresh = new Date(Date.now() + 60_000).toISOString(); // comfortably after this process started
  const stale = "2000-01-01T00:00:00.000Z";
  try {
    writeFileSync(sessFile, JSON.stringify([{ session_id: "sid-1", pid: process.pid, cwd: "/work", opened_at: fresh }]));
    assert.equal(grokSessionId(process.pid), "sid-1", "one fresh row resolves");
    assert.equal(grokSessionId(999999), null, "no pid match, no session id");
    writeFileSync(sessFile, JSON.stringify([
      { session_id: "sid-a", pid: process.pid, cwd: "/a", opened_at: fresh },
      { session_id: "sid-b", pid: process.pid, cwd: "/b", opened_at: fresh },
    ]));
    assert.equal(grokSessionId(process.pid), null, "one process hosting two sessions: never guess (review high 1)");
    writeFileSync(sessFile, JSON.stringify([{ session_id: "sid-old", pid: process.pid, cwd: "/w", opened_at: stale }]));
    assert.equal(grokSessionId(process.pid), null, "a row older than the process is a reused pid's leftover");
    writeFileSync(sessFile, "not json at all");
    assert.equal(grokSessionId(process.pid), null, "a malformed registry is no session id");
    writeFileSync(sessFile, `[{"session_id": "sid-h`);
    assert.equal(grokSessionId(process.pid), null, "a half-written registry is no session id");
  } finally { if (prev === undefined) delete process.env.MBX_GROK_SESSIONS_FILE; else process.env.MBX_GROK_SESSIONS_FILE = prev; }

  // setup: MCP server section (grok's exact schema, verified against `grok mcp add`) + [ui.status_line]
  const home = fakeHome(); const ctx = ctxFor(home);
  mkdirSync(join(home, ".grok"), { recursive: true });
  const rows = runSetup(ctx, { mode: "install", stamp: "G1" });
  const cfg = rd(home, ".grok/config.toml");
  assert.match(cfg, /\[mcp_servers\.mbx\]\ncommand = "\/opt\/bin\/agentmbx"\nargs = \["mcp"\]\nenabled = true\nstartup_timeout_sec = 30/, "grok's own MCP schema");
  assert.match(cfg, /\[ui\.status_line\]\ntype = "command"\ncommand = "\/opt\/bin\/agentmbx statusline grok"/, "the status line section");
  assert.ok(rows.some((r) => r.cli === "grok" && r.action === "added"));
  assert.equal(runSetup(ctx, { mode: "install", stamp: "G2" }).filter((r) => r.cli === "grok" && r.action !== "unchanged" && r.action !== "skipped").length, 0, "idempotent");
  runSetup(ctx, { mode: "uninstall", stamp: "G3" });
  assert.ok(!existsSync(join(home, ".grok/config.toml")), "byte-exact: a setup-created config.toml is deleted (review low 9)");
  rmSync(home, { recursive: true, force: true });

  // CRLF + a trailing comment parse as the same section — no duplicate table (review high 2)
  const home2 = fakeHome(); const ctx2 = ctxFor(home2);
  mkdirSync(join(home2, ".grok"), { recursive: true });
  writeFileSync(join(home2, ".grok/config.toml"), `[ui]\r\nmax_thoughts_width = 120\r\n\r\n[ui.status_line] # mine\r\ntype = "command"\r\ncommand = "my-own.sh"\r\n`);
  runSetup(ctx2, { mode: "install", stamp: "G4" });
  assert.equal(rd(home2, ".grok/config.toml").match(/\[ *ui\.status_line *\]/g)!.length, 1, "no duplicate [ui.status_line] table");
  assert.match(rd(home2, ".grok/config.toml"), /command = "my-own\.sh"/, "the foreign command is untouched");
  rmSync(home2, { recursive: true, force: true });

  // a status_line key in another form is foreign — never appended (review high 2)
  for (const body of [`[ui]\nstatus_line = { command = "mine.sh" }\n`, `ui.status_line.type = "command"\n`]) {
    const h = fakeHome(); const c = ctxFor(h);
    mkdirSync(join(h, ".grok"), { recursive: true });
    writeFileSync(join(h, ".grok/config.toml"), body);
    const rows2 = runSetup(c, { mode: "install", stamp: "G5" });
    const out = rd(h, ".grok/config.toml");
    assert.match(out, /\[mcp_servers\.mbx\]/, "an unrelated MCP edit still lands");
    assert.doesNotMatch(out, /\[ui\.status_line\]|statusline grok/, "but a non-section status_line key never gets a status line appended (review high 2)");
    assert.ok(rows2.find((r) => r.cli === "grok" && r.action === "manual"), "and it is reported");
    rmSync(h, { recursive: true, force: true });
  }

  // exact-match ours: a composed command and an old-path direct command are foreign (review med 5)
  const home3 = fakeHome(); const ctx3 = ctxFor(home3);
  mkdirSync(join(home3, ".grok"), { recursive: true });
  writeFileSync(join(home3, ".grok/config.toml"), `[ui.status_line]\ntype = "command"\ncommand = "~/my-line.sh; /old/agentmbx statusline grok"\n`);
  runSetup(ctx3, { mode: "install", stamp: "G6" });
  assert.match(rd(home3, ".grok/config.toml"), /~\/my-line\.sh; \/old\/agentmbx statusline grok/, "a composed command is foreign, never overwritten");
  rmSync(home3, { recursive: true, force: true });

  // T536: a mise shim is ours but not current. setup rewrites it in place; doctor warns until then.
  // any existing binary plus this install's entry is current for both, so neither rewrites nor warns.
  {
    const entry = realpathSync(fileURLToPath(new URL("../bin/agentmbx.js", import.meta.url)));
    const node = process.execPath;
    const h = fakeHome();
    const c = ctxFor(h, [node, entry]);
    mkdirSync(join(h, ".grok"), { recursive: true });
    writeFileSync(join(h, ".grok/config.toml"), `[ui.status_line]\ntype = "command"\ncommand = "/Users/keatonhoskins/.local/share/mise/shims/agentmbx statusline grok"\nrefresh_interval = 15\n`);
    assert.ok(statuslineChecks(c, "grok").some((x) => x.level === "warn" && /older AgentMBX form/.test(x.label)), "doctor warns on the shim form");
    const rows536 = runSetup(c, { mode: "install", stamp: "G536" });
    assert.equal(rows536.find((r) => r.cli === "grok" && r.item.includes("status_line"))?.action, "updated");
    const cfg536 = rd(h, ".grok/config.toml");
    assert.match(cfg536, /type = "command"\ncommand = /, "the rewrite keeps the newline before command");
    assert.match(cfg536, new RegExp(JSON.stringify(`${node} ${entry} statusline grok`).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.match(cfg536, /refresh_interval = 15/, "the user's other key stays");
    assert.ok(!statuslineChecks(c, "grok").some((x) => /older AgentMBX form/.test(x.label)), "doctor is quiet once the command is current");
    writeFileSync(join(h, ".grok/config.toml"), `[ui.status_line]\ntype = "command"\ncommand = ${JSON.stringify(`/usr/bin/true ${entry} statusline grok`)}\n`);
    const kept536 = runSetup(c, { mode: "install", stamp: "G536b" });
    assert.equal(kept536.find((r) => r.cli === "grok" && r.item.includes("status_line"))?.action, "unchanged", "another existing binary plus this install's entry is current");
    assert.ok(!statuslineChecks(c, "grok").some((x) => /older AgentMBX form/.test(x.label)));
    rmSync(h, { recursive: true, force: true });
  }

  // keep the user's other keys in our sections (review med 6)
  const home4 = fakeHome(); const ctx4 = ctxFor(home4);
  mkdirSync(join(home4, ".grok"), { recursive: true });
  writeFileSync(join(home4, ".grok/config.toml"), `[mcp_servers.mbx]\ncommand = "/old/agentmbx"\nargs = ["mcp"]\nenabled = true\nrefresh_interval = 30\n`);
  runSetup(ctx4, { mode: "install", stamp: "G7" });
  const kept = rd(home4, ".grok/config.toml");
  assert.match(kept, /command = "\/opt\/bin\/agentmbx"/, "our path is normalized");
  assert.match(kept, /refresh_interval = 30/, "the user's refresh_interval stays");
  rmSync(home4, { recursive: true, force: true });

  // a foreign [mcp_servers.mbx] (someone else's mbx) is never overwritten
  const home5 = fakeHome(); const ctx5 = ctxFor(home5);
  mkdirSync(join(home5, ".grok"), { recursive: true });
  writeFileSync(join(home5, ".grok/config.toml"), `[mcp_servers.mbx]\ncommand = "/usr/bin/other-mbx"\nargs = ["serve"]\nenabled = true\n`);
  runSetup(ctx5, { mode: "install", stamp: "G8" });
  assert.match(rd(home5, ".grok/config.toml"), /"\/usr\/bin\/other-mbx"/, "another mbx server someone else manages is never overwritten");
  rmSync(home5, { recursive: true, force: true });
  rmSync(sessions, { recursive: true, force: true });
});

test("T337: detectHost classifies grok on the binary name only — never ngrok, never grok's args", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mbx-grok-shim-"));
  symlinkSync("/bin/sleep", join(dir, "grok"));
  symlinkSync("/bin/sleep", join(dir, "ngrok"));
  const classify = (bin: string): Promise<string> => new Promise((resolve, reject) => {
    delete process.env.MBX_CLI; // detectHost sticks its first classification into the env for re-exec children
    const child = spawn(join(dir, bin), ["60"]);
    child.on("spawn", () => {
      try { resolve(detectHost(child.pid!).cli); }
      catch (e) { reject(e); }
      finally { child.kill(); }
    });
    child.on("error", reject);
  });
  try {
    assert.equal(await classify("grok"), "grok", "a grok binary is grok");
    assert.notEqual(await classify("ngrok"), "grok", "ngrok is not grok (review med 4)");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// T337 re-review: quoted keys are foreign, no-trailing-newline round-trips byte-exactly, quoted
// paths stay ours, and the smol-toml guard refuses unverifiable writes.
test("T337: grok guard rails — quoted keys, byte-exact round-trips, escaping, parse guard", () => {
  // quoted key parts are the same section or foreign, never a duplicate table (re-review D)
  for (const body of [
    `[ui."status_line"]\ntype = "command"\ncommand = "mine.sh"\n`,
    `[ui]\n"status_line".type = "command"\n`,
    `ui = { status_line = { type = "command", command = "mine.sh" } }\n`,
  ]) {
    const h = fakeHome(); const c = ctxFor(h);
    mkdirSync(join(h, ".grok"), { recursive: true });
    writeFileSync(join(h, ".grok/config.toml"), body);
    const rows = runSetup(c, { mode: "install", stamp: "Q1" });
    const out = rd(h, ".grok/config.toml");
    assert.doesNotMatch(out, /statusline grok/, `no status line appended: ${JSON.stringify(body.slice(0, 30))}`);
    assert.ok(rows.find((r) => r.cli === "grok" && r.action === "manual"), "and it is reported");
    rmSync(h, { recursive: true, force: true });
  }

  // a no-trailing-newline file round-trips byte-exactly (re-review D)
  const h2 = fakeHome(); const c2 = ctxFor(h2);
  mkdirSync(join(h2, ".grok"), { recursive: true });
  writeFileSync(join(h2, ".grok/config.toml"), `[ui]\nmax_thoughts_width = 120`);
  runSetup(c2, { mode: "install", stamp: "Q2" });
  runSetup(c2, { mode: "uninstall", stamp: "Q3" });
  assert.equal(rd(h2, ".grok/config.toml"), `[ui]\nmax_thoughts_width = 120`, "no trailing newline gained");
  rmSync(h2, { recursive: true, force: true });

  // a command path containing a quote round-trips as ours (re-review D: JSON.stringify + unescape)
  const h3 = fakeHome();
  const c3 = ctxFor(h3, [`/opt/weird"bin/agentmbx`]);
  mkdirSync(join(h3, ".grok"), { recursive: true });
  runSetup(c3, { mode: "install", stamp: "Q4" });
  assert.match(rd(h3, ".grok/config.toml"), /\[ui\.status_line\]/, "the section is written even with a quote in the path");
  assert.equal(statuslineState(h3, "grok", c3.cmd), "ours", "and it round-trips as ours, not foreign");
  rmSync(h3, { recursive: true, force: true });

  // the smol-toml guard: invalid TOML is never written into (re-review E)
  const h4 = fakeHome(); const c4 = ctxFor(h4);
  mkdirSync(join(h4, ".grok"), { recursive: true });
  writeFileSync(join(h4, ".grok/config.toml"), `this is not [valid toml`);
  const before = rd(h4, ".grok/config.toml");
  runSetup(c4, { mode: "install", stamp: "Q5" });
  assert.equal(rd(h4, ".grok/config.toml"), before, "an unparseable file is never written into");
  rmSync(h4, { recursive: true, force: true });
});

// #98 re-review regression: install then uninstall BOTH grok sections on LF and CRLF files with a
// user section before them — the bytes must come back identical (never an orphaned \r, never a
// lost final newline, never a doubled blank line).
test("T337: install+uninstall of both sections round-trips LF and CRLF files byte-exactly", () => {
  for (const [name, before] of [
    ["LF", `[models]\nb = 2\n`],
    ["LF no trailing newline", `[models]\nb = 2`],
    ["CRLF", `[models]\r\nb = 2\r\n`],
    ["CRLF no trailing newline", `[models]\r\nb = 2`],
  ] as const) {
    const h = fakeHome(); const c = ctxFor(h);
    mkdirSync(join(h, ".grok"), { recursive: true });
    writeFileSync(join(h, ".grok/config.toml"), before);
    runSetup(c, { mode: "install", stamp: "RT1" });
    const installed = rd(h, ".grok/config.toml");
    assert.match(installed, /\[mcp_servers\.mbx\]/, `${name}: mcp section installed`);
    assert.match(installed, /\[ui\.status_line\]/, `${name}: status line installed`);
    runSetup(c, { mode: "uninstall", stamp: "RT2" });
    assert.equal(rd(h, ".grok/config.toml"), before, `${name}: byte-identical after removing both sections`);
    rmSync(h, { recursive: true, force: true });
  }
});

// T526: Hermes rewrites ~/.hermes/config.yaml itself and folds long scalars onto indented
// continuation lines. Setup must recognise its own folded entries semantically, repair them to the
// canonical single line in place (never append a duplicate), and stay idempotent; a foreign hook in
// the same event list is never touched. A `command:` that visibly looks like ours but cannot be
// parsed is reported as a manual row — never appended next to.
test("T526: Hermes folded hook scalars are recognised and repaired in place; unparseable ours is a manual row", () => {
  const home = fakeHome(); const ctx = ctxFor(home);
  const before = `model:
  default: fake
hooks:
  on_session_start:
    - command: /opt/very/long/path/that/hermes/folds/because/it/is/far/too/long/for/one/line/agentmbx hook
        session-start --cli hermes
      timeout: 10
    - command: /usr/bin/foreign-hook --watch
      timeout: 5
  pre_llm_call:
    - command: "/opt/very/long/path/that/hermes/folds/because/it/is/far/too/long/for/one/line/agentmbx hook
        prompt --cli hermes"
      timeout: 10
`;
  writeFileSync(join(home, ".hermes/config.yaml"), before);
  const rows = runSetup(ctx, { mode: "install", only: ["hermes"], stamp: "T526a" });
  assert.ok(rows.some((r) => r.cli === "hermes" && r.item.startsWith("hooks") && (r.action === "updated" || r.action === "unchanged")), JSON.stringify(rows));
  const hy = rd(home, ".hermes/config.yaml");
  // each agentmbx hook exactly once, in the canonical single-line form; the folded lines are gone
  assert.equal((hy.match(/agentmbx hook /g) ?? []).length, 2, "each agentmbx hook exactly once");
  assert.match(hy, /- command: "\/opt\/bin\/agentmbx hook session-start --cli hermes"\n      timeout: 10\n/);
  assert.match(hy, /- command: "\/opt\/bin\/agentmbx hook prompt --cli hermes"\n      timeout: 10\n/);
  assert.doesNotMatch(hy, /^\s+session-start --cli hermes/m, "no folded continuation lines left");
  assert.doesNotMatch(hy, /^\s+prompt --cli hermes/m, "no folded continuation lines left");
  // the foreign hook keeps its bytes
  assert.match(hy, /- command: \/usr\/bin\/foreign-hook --watch\n      timeout: 5\n/, "foreign hook untouched");
  assert.match(hy, /^model:\n  default: fake\n/, "everything above hooks: is byte-preserved");
  // AC1/AC3: a second run reports unchanged and nothing moves
  const snapshot = rd(home, ".hermes/config.yaml");
  const again = runSetup(ctx, { mode: "install", only: ["hermes"], stamp: "T526b" });
  assert.ok(again.every((r) => r.action === "unchanged" || r.action === "skipped"), JSON.stringify(again));
  assert.equal(rd(home, ".hermes/config.yaml"), snapshot);

  // the amendment: an unparseable `command:` that looks like ours -> manual row, hooks untouched
  const home2 = fakeHome(); const ctx2 = ctxFor(home2);
  const hooks2 = `hooks:
  on_session_start:
    - command: "/opt/bin/agentmbx hook session-start
      timeout: 10
`;
  writeFileSync(join(home2, ".hermes/config.yaml"), hooks2);
  const rows2 = runSetup(ctx2, { mode: "install", only: ["hermes"], stamp: "T526c" });
  const manual = rows2.find((r) => r.cli === "hermes" && r.item.startsWith("hooks"));
  assert.equal(manual?.action, "manual", JSON.stringify(rows2));
  assert.ok(manual?.note?.includes("agentmbx hook entry could not be parsed; fix by hand"), manual?.note);
  assert.ok(rd(home2, ".hermes/config.yaml").startsWith(hooks2), "the hooks block is not touched");
});

// T532: grok configs hold older agentmbx entries in several shapes — the mise-shim binary in grok's
// own nested [[hooks.<Event>.hooks]] form (the incident), a bare `agentmbx` in setup's inline form,
// and the current node+script form. All are recognised by meaning and replaced in place; setup never
// appends next to its own older entry, foreign hooks stay, and the result parses as TOML.
test("T532: grok shim/bare/current forms are replaced in place, never duplicated", () => {
  const shim = "/Users/dev/.local/share/mise/shims/agentmbx";
  const nodeCmd = ["/opt/bin/node", "/opt/app/bin/agentmbx.js"];
  // the incident shape: nested form with shim commands, a line-folded command, a foreign nested
  // hook in its own [[hooks.SessionStart]] element, and a shim MCP section.
  const home = fakeHome(); const ctx = ctxFor(home, nodeCmd);
  mkdirSync(join(home, ".grok"), { recursive: true });
  writeFileSync(join(home, ".grok/config.toml"), `[mcp_servers.mbx]
command = "${shim}"
args = ["mcp"]
enabled = true

[[hooks.SessionStart]]

[[hooks.SessionStart.hooks]]
type = "command"
command = "${shim} hook session-start --cli grok"
timeout = 10

[[hooks.UserPromptSubmit]]

[[hooks.UserPromptSubmit.hooks]]
type = "command"
command = "${shim} hook prompt --cli grok"
timeout = 10

[[hooks.Stop]]

[[hooks.Stop.hooks]]
type = "command"
command = "${shim} hook stop --cli grok"
timeout = 10

[[hooks.SessionStart]]

[[hooks.SessionStart.hooks]]
type = "command"
command = "my-own.sh --watch"
timeout = 30
`);
  const rows = runSetup(ctx, { mode: "install", only: ["grok"], stamp: "T532a" });
  assert.ok(!rows.some((r) => r.cli === "grok" && r.action === "error"), JSON.stringify(rows));
  let out = rd(home, ".grok/config.toml");
  assert.doesNotThrow(() => parseToml(out), "the result parses as TOML");
  // exactly one of each hook, ours in the node+script form; the shim commands are gone
  for (const [event, sub] of [["SessionStart", "session-start"], ["UserPromptSubmit", "prompt"], ["Stop", "stop"], ["PostToolUse", "post-tool"]] as const) {
    const want = `${nodeCmd.join(" ")} hook ${sub} --cli grok`;
    assert.equal((out.match(new RegExp(`command = ${JSON.stringify(want)}`, "g")) ?? []).length, 1, `exactly one ${event} hook of ours`);
  }
  assert.equal((out.match(/mise\/shims\/agentmbx/g) ?? []).length, 0, "no shim command is left next to a new one");
  assert.match(out, /command = "my-own\.sh --watch"\n/, "the foreign hook keeps its bytes");
  assert.equal((out.match(/\[mcp_servers\.mbx\]/g) ?? []).length, 1, "exactly one MCP section");
  assert.match(out, /\[mcp_servers\.mbx\]\ncommand = "\/opt\/bin\/node"\nargs = \["\/opt\/app\/bin\/agentmbx\.js", "mcp"\]\n/, "the shim MCP entry is replaced in place");
  // AC2: a second run reports unchanged
  const snapshot = out;
  const again = runSetup(ctx, { mode: "install", only: ["grok"], stamp: "T532b" });
  assert.ok(again.every((r) => r.action === "unchanged" || r.action === "skipped"), JSON.stringify(again));
  assert.equal(rd(home, ".grok/config.toml"), snapshot);
  // uninstall removes our entries in every recognised form and keeps the foreign one
  const removed = runSetup(ctx, { mode: "uninstall", only: ["grok"], stamp: "T532c" });
  assert.ok(removed.some((r) => r.cli === "grok" && r.item.startsWith("hooks") && r.action === "removed"), JSON.stringify(removed));
  out = rd(home, ".grok/config.toml");
  assert.doesNotThrow(() => parseToml(out));
  assert.doesNotMatch(out, /agentmbx|mcp_servers/, "our shim MCP and hook entries are removed");
  assert.match(out, /my-own\.sh --watch/, "the foreign hook survives uninstall");

  // bare form: setup's inline table spelling with a bare `agentmbx` binary
  const home2 = fakeHome(); const ctx2 = ctxFor(home2, nodeCmd);
  mkdirSync(join(home2, ".grok"), { recursive: true });
  writeFileSync(join(home2, ".grok/config.toml"), `[mcp_servers.mbx]
command = "agentmbx"
args = ["mcp"]
enabled = true

[[hooks.SessionStart]]
hooks = [{ type = "command", command = "agentmbx hook session-start --cli grok", timeout = 10 }]
`);
  runSetup(ctx2, { mode: "install", only: ["grok"], stamp: "T532d" });
  out = rd(home2, ".grok/config.toml");
  assert.doesNotThrow(() => parseToml(out));
  assert.equal((out.match(/command = "\/opt\/bin\/node \/opt\/app\/bin\/agentmbx\.js hook session-start --cli grok"/g) ?? []).length, 1,
    "the bare hook is replaced in place (exactly one SessionStart command line)");
  assert.doesNotMatch(out, /command = "agentmbx/, "no bare command is left next to the new one");
  assert.match(out, /hooks = \[{ type = "command", command = "\/opt\/bin\/node \/opt\/app\/bin\/agentmbx\.js hook session-start --cli grok", timeout = 10 }\]/);
  assert.match(out, /\[mcp_servers\.mbx\]\ncommand = "\/opt\/bin\/node"\nargs = \["\/opt\/app\/bin\/agentmbx\.js", "mcp"\]\n/, "the bare MCP entry is replaced in place");
  const again2 = runSetup(ctx2, { mode: "install", only: ["grok"], stamp: "T532e" });
  assert.ok(again2.every((r) => r.action === "unchanged" || r.action === "skipped"), JSON.stringify(again2));

  // current form: written by this very cmd, a second run is byte-identical
  const home3 = fakeHome(); const ctx3 = ctxFor(home3, nodeCmd);
  mkdirSync(join(home3, ".grok"), { recursive: true });
  runSetup(ctx3, { mode: "install", only: ["grok"], stamp: "T532f" });
  const current = rd(home3, ".grok/config.toml");
  const again3 = runSetup(ctx3, { mode: "install", only: ["grok"], stamp: "T532g" });
  assert.ok(again3.every((r) => r.action === "unchanged" || r.action === "skipped"), JSON.stringify(again3));
  assert.equal(rd(home3, ".grok/config.toml"), current);

  // a line-folded command makes the file unparseable for smol-toml (its parse guard): the file is
  // conservatively left untouched — reported, never written into and never appended next to.
  const home4 = fakeHome(); const ctx4 = ctxFor(home4, nodeCmd);
  mkdirSync(join(home4, ".grok"), { recursive: true });
  const folded = `[[hooks.SessionStart]]\n\n[[hooks.SessionStart.hooks]]\ntype = "command"\ncommand = "${shim} hook session-start \\\n  --cli grok"\ntimeout = 10\n`;
  writeFileSync(join(home4, ".grok/config.toml"), folded);
  const rows4 = runSetup(ctx4, { mode: "install", only: ["grok"], stamp: "T532h" });
  assert.equal(rd(home4, ".grok/config.toml"), folded, "a folded (unparseable) config is left byte-alone — no duplicate appended");
});

// T533: doctor and setup compared the exact node path, so a shell whose shim resolves another node
// reported every harness "not wired" and setup rewrote every config. [any existing node, this
// install's entry script] is wired-and-current from any node: setup leaves the bytes alone, and a
// configured node that no longer exists is still rewritten to this shell's command.
test("T533: a config wired by another shell's node + this install's entry stays put; a dead node is rewritten", async () => {
  const entry = realpathSync(join(import.meta.dirname, "../bin/agentmbx.js"));
  const otherNode = process.execPath; // stands in for e.g. Homebrew node while ctx asks for another
  const mbxHome = (home: string) => { const d = join(home, ".local/share/agentmbx"); new MbxNode(d, { host: "alpha", port: 1 }).close(); return d; };

  // grok (TOML command+args fields)
  const home = fakeHome();
  mkdirSync(join(home, ".grok"), { recursive: true });
  writeFileSync(join(home, ".grok/config.toml"), `[mcp_servers.mbx]\ncommand = ${JSON.stringify(otherNode)}\nargs = ${JSON.stringify([entry, "mcp"])}\nenabled = true\nstartup_timeout_sec = 30\n`);
  const ctx = ctxFor(home, ["/nonexistent/other-node", "/opt/app/bin/agentmbx.js"]);
  const rows = runSetup(ctx, { mode: "install", only: ["grok"], stamp: "T533g" });
  assert.ok(rows.some((r) => r.cli === "grok" && r.item.startsWith("[mcp_servers") && r.action === "unchanged"), JSON.stringify(rows));
  assert.ok(rd(home, ".grok/config.toml").includes(JSON.stringify(otherNode)), "the other node's bytes stay");
  let checks = await doctor(ctx, mbxHome(home));
  assert.ok(checks.some((c) => c.level === "ok" && /^grok: MCP server wired/.test(c.label)), JSON.stringify(checks));
  // the same entry under a node that no longer exists is ours-but-stale: rewritten in place
  writeFileSync(join(home, ".grok/config.toml"), `[mcp_servers.mbx]\ncommand = "/nonexistent/node-gone"\nargs = ${JSON.stringify([entry, "mcp"])}\nenabled = true\nstartup_timeout_sec = 30\n`);
  const rows2 = runSetup(ctx, { mode: "install", only: ["grok"], stamp: "T533h" });
  assert.ok(rows2.some((r) => r.cli === "grok" && r.item.startsWith("[mcp_servers") && r.action === "updated"), JSON.stringify(rows2));
  assert.match(rd(home, ".grok/config.toml"), /command = "\/nonexistent\/other-node"\nargs = \["\/opt\/app\/bin\/agentmbx\.js", "mcp"\]/);

  // claude (JSON object)
  const homeC = fakeHome();
  const claudeJson = JSON.parse(rd(homeC, ".claude.json")) as { mcpServers: Record<string, unknown> };
  claudeJson.mcpServers.mbx = { type: "stdio", command: otherNode, args: [entry, "mcp"], env: {} };
  writeFileSync(join(homeC, ".claude.json"), JSON.stringify(claudeJson, null, 2));
  const ctxC = ctxFor(homeC, ["/nonexistent/other-node", "/opt/app/bin/agentmbx.js"]);
  const rowsC = runSetup(ctxC, { mode: "install", only: ["claude"], stamp: "T533c" });
  assert.ok(rowsC.some((r) => r.cli === "claude" && r.item.startsWith("MCP server") && r.action === "unchanged"), JSON.stringify(rowsC));
  checks = await doctor(ctxC, mbxHome(homeC));
  assert.ok(checks.some((c) => c.level === "ok" && /^claude: MCP server wired/.test(c.label)), JSON.stringify(checks));

  // hermes (YAML command+args)
  const homeH = fakeHome();
  writeFileSync(join(homeH, ".hermes/config.yaml"), `model:\n  default: fake\nmcp_servers:\n  mbx:\n    command: ${JSON.stringify(otherNode)}\n    args: ${JSON.stringify([entry, "mcp"])}\n    connect_timeout: 60\n`);
  const ctxH = ctxFor(homeH, ["/nonexistent/other-node", "/opt/app/bin/agentmbx.js"]);
  const rowsH = runSetup(ctxH, { mode: "install", only: ["hermes"], stamp: "T533m" });
  assert.ok(rowsH.some((r) => r.cli === "hermes" && r.item.toLowerCase().startsWith("mcp") && r.action === "unchanged"), JSON.stringify(rowsH));
  assert.ok(rd(homeH, ".hermes/config.yaml").includes(JSON.stringify(otherNode)), "the other node's bytes stay");
  checks = await doctor(ctxH, mbxHome(homeH));
  assert.ok(checks.some((c) => c.level === "ok" && /^hermes: MCP server wired/.test(c.label)), JSON.stringify(checks));
});

// T526 addendum: block scalars (| and >), including Hermes's backslash line-continuation fold,
// are our own entries too — repaired to the canonical single line in place, never duplicated.
test("T526: Hermes block scalars and backslash folds are repaired in place, idempotently", () => {
  const home = fakeHome(); const ctx = ctxFor(home);
  const before = `hooks:
  on_session_start:
    - command: /opt/very/long/path/that/hermes/folds/because/it/exceeds/the/width/agentmbx hook \\
        session-start --cli hermes
      timeout: 10
  pre_llm_call:
    - command: |
        /opt/x/agentmbx hook prompt --cli hermes
      timeout: 10
`;
  writeFileSync(join(home, ".hermes/config.yaml"), before);
  const rows = runSetup(ctx, { mode: "install", only: ["hermes"], stamp: "T526d" });
  assert.ok(rows.some((r) => r.cli === "hermes" && r.item.startsWith("hooks") && r.action === "updated"), JSON.stringify(rows));
  const hy = rd(home, ".hermes/config.yaml");
  assert.equal((hy.match(/agentmbx hook /g) ?? []).length, 2, "each agentmbx hook exactly once");
  assert.match(hy, /- command: "\/opt\/bin\/agentmbx hook session-start --cli hermes"\n      timeout: 10\n/);
  assert.match(hy, /- command: "\/opt\/bin\/agentmbx hook prompt --cli hermes"\n      timeout: 10\n/);
  assert.doesNotMatch(hy, /[|>][+-]?\s*$/, "no block scalar header left on a command line");
  const again = runSetup(ctx, { mode: "install", only: ["hermes"], stamp: "T526e" });
  assert.ok(again.every((r) => r.action === "unchanged" || r.action === "skipped"), JSON.stringify(again));
  assert.equal(rd(home, ".hermes/config.yaml"), hy);
});

// T533 addendum: codex (TOML), kimi (JSON) and opencode (JSONC) MCP entries, and hook commands of
// codex/hermes naming [another existing node, this install's entry], are wired-and-current from
// any node — setup leaves the bytes alone, doctor passes.
test("T533: codex/kimi/opencode MCP and codex/hermes hooks wired by another node stay put", async () => {
  const entry = realpathSync(join(import.meta.dirname, "../bin/agentmbx.js"));
  const otherNode = process.execPath; // stands in for e.g. Homebrew node while ctx asks for another
  const mbxHome = (home: string) => { const d = join(home, ".local/share/agentmbx"); new MbxNode(d, { host: "alpha", port: 1 }).close(); return d; };

  const home = fakeHome();
  // codex: MCP table + all four hook groups in the other-node node+script form, after Orca's
  writeFileSync(join(home, ".codex/config.toml"), `model = "fake-model"\n\n[mcp_servers.mbx]\ncommand = ${JSON.stringify(otherNode)}\nargs = ${JSON.stringify([entry, "mcp"])}\ndefault_tools_approval_mode = "approve"\nstartup_timeout_sec = 30\n`);
  const codexHooks = JSON.parse(rd(home, ".codex/hooks.json")) as { hooks: Record<string, { hooks: { type: string; command: string; timeout: number }[] }[]> };
  for (const ev of ["SessionStart", "UserPromptSubmit", "PermissionRequest", "Stop"])
    codexHooks.hooks[ev] = [...(codexHooks.hooks[ev] ?? []), { hooks: [{ type: "command", command: `${otherNode} ${entry} hook ${ev === "SessionStart" ? "session-start" : ev === "UserPromptSubmit" ? "prompt" : ev === "PermissionRequest" ? "permission" : "stop"} --cli codex`, timeout: 10 }] }];
  writeFileSync(join(home, ".codex/hooks.json"), JSON.stringify(codexHooks, null, 2));
  // kimi mcp.json in the other-node form
  writeFileSync(join(home, ".kimi-code/mcp.json"), JSON.stringify({ mcpServers: { mbx: { command: otherNode, args: [entry, "mcp"] } } }));
  // opencode jsonc in the other-node form
  writeFileSync(join(home, ".config/opencode/opencode.jsonc"), `{\n  "mcp": { "servers": { "mbx": { "type": "local", "command": [${JSON.stringify(otherNode)}, ${JSON.stringify(entry)}, "mcp"], "timeout": { "startup": 30000, "catalog": 30000 } } } }\n}\n`);

  const ctx = ctxFor(home, ["/nonexistent/other-node", "/opt/app/bin/agentmbx.js"]);
  const snapshot = { codex: rd(home, ".codex/config.toml"), hooks: rd(home, ".codex/hooks.json"), kimi: rd(home, ".kimi-code/mcp.json"), oc: rd(home, ".config/opencode/opencode.jsonc") };
  const rows = runSetup(ctx, { mode: "install", only: ["codex", "kimi", "opencode"], stamp: "T533x" });
  for (const [cli, item] of [["codex", "[mcp_servers.mbx]"], ["kimi", "mcpServers.mbx"], ["opencode", "mcp.servers.mbx"]] as const)
    assert.ok(rows.some((r) => r.cli === cli && r.item === item && r.action === "unchanged"), `${cli}: ${JSON.stringify(rows)}`);
  assert.ok(rows.some((r) => r.cli === "codex" && r.item.startsWith("hooks") && r.action === "unchanged"), JSON.stringify(rows));
  assert.equal(rd(home, ".codex/config.toml"), snapshot.codex, "codex config bytes stay");
  assert.equal(rd(home, ".codex/hooks.json"), snapshot.hooks, "codex hooks bytes stay");
  assert.equal(rd(home, ".kimi-code/mcp.json"), snapshot.kimi, "kimi mcp.json bytes stay");
  assert.equal(rd(home, ".config/opencode/opencode.jsonc"), snapshot.oc, "opencode jsonc bytes stay");
  const checks = await doctor(ctx, mbxHome(home));
  for (const cli of ["codex", "kimi", "opencode"])
    assert.ok(checks.some((c) => c.level === "ok" && new RegExp(`^${cli}: MCP server wired`).test(c.label)), `${cli}: ${JSON.stringify(checks)}`);
  assert.ok(checks.some((c) => c.level === "ok" && /^codex: hooks wired/.test(c.label)), JSON.stringify(checks));

  // hermes hook commands in the other-node form: wired, bytes untouched
  const homeH = fakeHome();
  writeFileSync(join(homeH, ".hermes/config.yaml"), `hooks:\n  on_session_start:\n    - command: ${JSON.stringify(`${otherNode} ${entry} hook session-start --cli hermes`)}\n      timeout: 10\n  pre_llm_call:\n    - command: ${JSON.stringify(`${otherNode} ${entry} hook prompt --cli hermes`)}\n      timeout: 10\nmcp_servers:\n  mbx:\n    command: ${JSON.stringify(otherNode)}\n    args: ${JSON.stringify([entry, "mcp"])}\n    connect_timeout: 60\n`);
  const ctxH = ctxFor(homeH, ["/nonexistent/other-node", "/opt/app/bin/agentmbx.js"]);
  const rowsH = runSetup(ctxH, { mode: "install", only: ["hermes"], stamp: "T533y" });
  assert.ok(rowsH.some((r) => r.cli === "hermes" && r.item.startsWith("hooks") && r.action === "unchanged"), JSON.stringify(rowsH));
  assert.ok(rd(homeH, ".hermes/config.yaml").includes(otherNode), "hermes hook keeps the other node's bytes");
  const checksH = await doctor(ctxH, mbxHome(homeH));
  assert.ok(checksH.some((c) => c.level === "ok" && /^hermes: hooks wired/.test(c.label)), JSON.stringify(checksH));
});
