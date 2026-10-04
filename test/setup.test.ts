// `agentmbx setup` / `doctor` against a fake HOME whose configs copy the STRUCTURE of real ones (fake values only).
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { doctor, failed } from "../src/doctor.ts";
import { insertMember, member, parseJsonc, removeMember } from "../src/jsonc.ts";
import { MbxNode } from "../src/node.ts";
import { runSetup, skillDest, type SetupCtx } from "../src/setup.ts";

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
  assert.equal(s.hooks.PostToolUse[0].hooks[0].command, "/opt/bin/agentmbx hook post-tool --cli claude");
  assert.equal(s.hooks.SessionEnd[0].hooks[0].command, "/opt/bin/agentmbx hook session-end --cli claude");

  // Codex
  assert.match(rd(home, ".codex/config.toml"), /\[mcp_servers\.mbx\]\ncommand = "\/opt\/bin\/agentmbx"\nargs = \["mcp"\]\ndefault_tools_approval_mode = "approve"\n$/);
  const ch = JSON.parse(rd(home, ".codex/hooks.json")).hooks;
  assert.equal(ch.SessionStart.length, 2); assert.equal(ch.SessionStart[0].hooks[0].command, ORCA);
  assert.equal(ch.UserPromptSubmit[1].hooks[0].command, "/opt/bin/agentmbx hook prompt --cli codex");
  assert.equal(ch.PostToolUse, undefined, "only install the provider-supported hook");

  // OpenCode: comments survive, mbx sits under mcp.servers
  const oc = rd(home, ".config/opencode/opencode.jsonc");
  for (const c of ["// my MCP servers", "// trailing comment", "/* block comment */"]) assert.ok(oc.includes(c), c);
  assert.ok(oc.includes(`"mbx": { "type": "local", "command": ["/opt/bin/agentmbx", "mcp"] },`));
  assert.ok(member(member(member(parseJsonc(oc), "mcp")!.value, "servers")!.value, "mbx"));

  // Kimi: mcp.json created, hooks appended after Orca's block
  assert.deepEqual(JSON.parse(rd(home, ".kimi-code/mcp.json")), { mcpServers: { mbx: { command: "/opt/bin/agentmbx", args: ["mcp"] } } });
  const kt = rd(home, ".kimi-code/config.toml");
  assert.ok(kt.startsWith(FILES[".kimi-code/config.toml"]));
  assert.match(kt, /event = "UserPromptSubmit"\ncommand = "\/opt\/bin\/agentmbx hook prompt --cli kimi"/);

  // Hermes
  assert.match(rd(home, ".hermes/config.yaml"), /\nmcp_servers:\n  mbx:\n    command: "\/opt\/bin\/agentmbx"\n    args: \["mcp"\]\n$/);

  // Skill copied + linked
  assert.match(readFileSync(join(skillDest(home), "SKILL.md"), "utf8"), /^---\nname: agentmbx\n/);
  assert.match(readFileSync(join(skillDest(home), "SKILL.md"), "utf8"), /Ending a session and handing off its mailbox/);
  assert.equal(readFileSync(join(skillDest(home), "scripts/claude-statusline.sh"), "utf8"),
    readFileSync(join(import.meta.dirname, "../skill/scripts/claude-statusline.sh"), "utf8"));
  for (const d of [".claude/skills/agentmbx", ".codex/skills/agentmbx"]) assert.equal(readlinkSync(join(home, d)), skillDest(home));

  // second run: the only change is upgrading PostToolUse to the bundled sh fast path (the first
  // run installed the skill after the hooks row ran, so the script appeared in between); no other
  // file changes, no duplicates, no new backups
  const snapshot = Object.fromEntries(Object.keys(FILES).map((rel) => [rel, rd(home, rel)]));
  const again = runSetup(ctx, { mode: "install", stamp: "T2" });
  const changed = again.filter((r) => r.action !== "unchanged" && r.action !== "skipped");
  assert.deepEqual(changed, [{ action: "updated", cli: "claude", item: "hooks SessionStart + SessionEnd + UserPromptSubmit + PostToolUse + PermissionRequest + Stop",
    path: join(home, ".claude/settings.json"), backup: join(home, ".claude/settings.json.bak-agentmbx-T2") }]);
  assert.match(JSON.parse(rd(home, ".claude/settings.json")).hooks.PostToolUse.at(-1).hooks[0].command, /claude-posttool\.sh/);
  // third run: fully clean
  const third = runSetup(ctx, { mode: "install", stamp: "T3" });
  assert.deepEqual(third.filter((r) => r.action !== "unchanged" && r.action !== "skipped"), []);
  for (const rel of Object.keys(FILES)) {
    if (rel === ".claude/settings.json") continue; // the one file the fast-path upgrade legitimately rewrites
    assert.equal(rd(home, rel), snapshot[rel], `${rel} unchanged after the upgrade settles`);
  }
  assert.ok(!readdirSync(join(home, ".codex")).some((f) => f.includes("T2")));
  assert.ok(!readdirSync(join(home, ".codex")).some((f) => f.includes("T3")));
});

test("setup updates a stale command path in place instead of adding a duplicate", () => {
  const home = fakeHome();
  runSetup(ctxFor(home, ["/old/agentmbx"]), { mode: "install", stamp: "A" });
  const rows = runSetup(ctxFor(home, ["/new/bin/agentmbx"]), { mode: "install", stamp: "B" });
  assert.ok(rows.filter((r) => r.cli !== "skill" && r.action !== "manual").every((r) => r.action === "updated"), JSON.stringify(rows));
  const s = JSON.parse(rd(home, ".claude/settings.json"));
  assert.equal(s.hooks.SessionStart.length, 2);
  assert.equal(s.hooks.SessionStart[1].hooks[0].command, "/new/bin/agentmbx hook session-start --cli claude");
  assert.equal((rd(home, ".codex/config.toml").match(/\[mcp_servers\.mbx\]/g) ?? []).length, 1);
  assert.equal((rd(home, ".config/opencode/opencode.jsonc").match(/"mbx"/g) ?? []).length, 1);
  assert.equal((rd(home, ".kimi-code/config.toml").match(/>>> agentmbx/g) ?? []).length, 1);
  assert.equal((rd(home, ".hermes/config.yaml").match(/mbx:/g) ?? []).length, 1);
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

test("uninstall removes exactly what setup added", () => {
  const home = fakeHome();
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
