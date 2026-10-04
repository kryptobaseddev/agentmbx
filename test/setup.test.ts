// `agentmbx setup` / `doctor` against a fake HOME whose configs copy the STRUCTURE of real ones (fake values only).
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { doctor, failed } from "../src/doctor.ts";
import { insertMember, member, parseJsonc, removeMember } from "../src/jsonc.ts";
import { MbxNode } from "../src/node.ts";
import { grokSessionId } from "../src/proc.ts";
import { runSetup, skillDest, statuslineState, type SetupCtx } from "../src/setup.ts";

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
  assert.match(cfg, /\[mcp_servers\.mbx\]\ncommand = "\/opt\/bin\/agentmbx"\nargs = \["mcp"\]\nenabled = true/, "grok's own MCP schema");
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
