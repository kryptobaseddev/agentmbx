// T368: static status line verification per CLI. Ours must be a CURRENT form (an older recognized
// form warns with the upgrade fix), ours pointing at a deleted bundled script warns, a user's own
// line is info — unless it embeds the agentmbx render command (a partial write) — and opencode has
// no custom status line feature, so it gets an explicit skip note. Every check is optional: none
// fails doctor.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { doctor, statuslineChecks } from "../src/doctor.ts";
import { MbxNode } from "../src/node.ts";
import { runSetup, skillDest, type SetupCtx } from "../src/setup.ts";

const home = () => mkdtempSync(join(tmpdir(), "mbx-doc-sl-"));
const ctxFor = (h: string): SetupCtx => ({ home: h, cmd: ["/opt/bin/agentmbx"], which: () => null, useClis: false });
const checks = (h: string, cli: string) => statuslineChecks(ctxFor(h), cli);
const one = (h: string, cli: string) => {
  const c = checks(h, cli);
  assert.equal(c.length, 1, `${cli}: exactly one status line line, got ${JSON.stringify(c)}`);
  return c[0];
};
const put = (h: string, rel: string, body: string) => { mkdirSync(dirname(join(h, rel)), { recursive: true }); writeFileSync(join(h, rel), body); };
const CONFIG: Record<string, [string, string]> = {
  claude: [".claude/settings.json", "{}\n"],
  kimi: [".kimi-code/tui.toml", "theme = \"dark\"\n"],
  grok: [".grok/config.toml", "model = \"fake\"\n"],
};

test("T368: ours with the current form passes — claude composes; kimi and grok state the replace-only contract", (t) => {
  for (const cli of ["claude", "kimi", "grok"]) {
    const h = home();
    t.after(() => rmSync(h, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
    const [rel, body] = CONFIG[cli];
    put(h, rel, body); // the CLI is detected
    runSetup(ctxFor(h), { mode: "install" }); // wires the bundled script form
    const check = one(h, cli);
    assert.equal(check.level, "ok", `${cli}: ${JSON.stringify(check)}`);
    assert.match(check.label, new RegExp(`^${cli}: status line wired`));
    assert.equal(check.fix, undefined);
    if (cli === "claude") assert.match(check.label, /composes with Claude's built-in items/);
    else {
      assert.match(check.label, /replaces the footer/, `${cli}: the replace-only contract is stated`);
      assert.doesNotMatch(check.label, /compos|items/i, `${cli}: never claims composition`);
    }
  }
});

test("T368: ours in an older recognized form warns with the upgrade fix", (t) => {
  const cases: [string, string][] = [
    ["claude", JSON.stringify({ statusLine: { type: "command", command: "/old/agentmbx statusline claude" } })],
    ["kimi", "[status_line]\ncommand = \"/old/agentmbx statusline kimi\"\n"],
    ["grok", "[ui.status_line]\ntype = \"command\"\ncommand = \"/old/agentmbx statusline grok\"\n"],
  ];
  for (const [cli, body] of cases) {
    const h = home();
    t.after(() => rmSync(h, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
    put(h, CONFIG[cli][0], body);
    const check = one(h, cli);
    assert.equal(check.level, "warn", `${cli}: ${JSON.stringify(check)}`);
    assert.match(check.label, /older AgentMBX form \(\/old\/agentmbx statusline/);
    assert.equal(check.fix, `agentmbx setup --only ${cli}`);
  }
});

test("T368: ours pointing at a deleted bundled script warns with the skill fix", (t) => {
  for (const cli of ["claude", "kimi"]) {
    const h = home();
    t.after(() => rmSync(h, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
    put(h, CONFIG[cli][0], CONFIG[cli][1]);
    runSetup(ctxFor(h), { mode: "install" });
    rmSync(join(skillDest(h), "scripts"), { recursive: true, force: true });
    const check = one(h, cli);
    assert.equal(check.level, "warn", `${cli}: ${JSON.stringify(check)}`);
    assert.match(check.label, /missing script/);
    assert.equal(check.fix, "agentmbx setup --only skill");
  }
});

test("T368: a user's own status line is info; one embedding the agentmbx render command is a partial write", (t) => {
  // truly foreign — info, no fix
  const mine = home();
  t.after(() => rmSync(mine, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  put(mine, ".claude/settings.json", JSON.stringify({ statusLine: { type: "command", command: "my-own-statusline.sh" } }));
  const c1 = one(mine, "claude");
  assert.equal(c1.level, "info");
  assert.match(c1.label, /left alone/);
  assert.equal(c1.fix, undefined);
  // foreign that embeds our render command with extra flags — a partial write, with the by-hand repair
  const flagged = home();
  t.after(() => rmSync(flagged, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  put(flagged, ".kimi-code/tui.toml", "[status_line]\ncommand = \"bash /opt/agentmbx statusline kimi --compact\"\n");
  const c2 = one(flagged, "kimi");
  assert.equal(c2.level, "warn");
  assert.match(c2.label, /partial AgentMBX write/);
  assert.match(c2.fix!, /remove the agentmbx reference by hand, then: agentmbx setup --only kimi/);
  // foreign that wraps OUR bundled script path — also a partial write
  const wrapped = home();
  t.after(() => rmSync(wrapped, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  put(wrapped, ".grok/config.toml", `[ui.status_line]\ntype = "command"\ncommand = "bash ${skillDest(wrapped)}/scripts/grok-statusline.sh"\n`);
  const c3 = one(wrapped, "grok");
  assert.equal(c3.level, "warn");
  assert.match(c3.label, /partial AgentMBX write/);
  // a foreign basename that merely resembles our script is NOT a partial write
  const alike = home();
  t.after(() => rmSync(alike, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  put(alike, ".claude/settings.json", JSON.stringify({ statusLine: { command: "bash ~/bin/claude-statusline.sh" } }));
  assert.equal(one(alike, "claude").level, "info");
});

test("T368: the configured command is read from the status line section, never another `command =` key", (t) => {
  // grok's config.toml carries [mcp_servers.mbx] with its own command — a whole-file scan would
  // mistake it for the status line command
  const grok = home();
  t.after(() => rmSync(grok, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  put(grok, ".grok/config.toml", `[mcp_servers.mbx]\ncommand = "/opt/bin/agentmbx"\nargs = ["mcp"]\n\n[ui.status_line]\ntype = "command"\ncommand = "/opt/bin/agentmbx statusline grok"\n`);
  const c1 = one(grok, "grok");
  assert.equal(c1.level, "ok", JSON.stringify(c1));
  assert.match(c1.label, /status line wired/);
  // a tui.toml whose status_line is a non-section key has no configured command — and a user
  // [editor] command must not be mistaken for one
  const kimi = home();
  t.after(() => rmSync(kimi, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  put(kimi, ".kimi-code/tui.toml", `[editor]\ncommand = "vim"\n\nstatus_line = { command = "mine.sh" }\n`);
  const c2 = one(kimi, "kimi");
  assert.equal(c2.level, "info", JSON.stringify(c2));
  assert.match(c2.label, /left alone/);
});

test("T368: opencode gets an explicit skip note — it has no custom status line feature to verify", (t) => {
  const h = home();
  t.after(() => rmSync(h, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  put(h, ".config/opencode/opencode.jsonc", "{\n  \"$schema\": \"https://opencode.ai/config.json\"\n}\n");
  const check = one(h, "opencode");
  assert.equal(check.level, "info");
  assert.match(check.label, /no custom status line feature/);
  assert.match(check.label, /anomalyco\/opencode#30295/);
  assert.equal(check.fix, undefined);
  // no config location is invented for it either
  assert.doesNotMatch(check.label, /opencode\.jsonc|\.config/);
});

test("T368: an absent status line says nothing — the optional segment stays silent", (t) => {
  for (const cli of ["claude", "kimi", "grok", "codex", "hermes"]) {
    const h = home();
    t.after(() => rmSync(h, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
    assert.deepEqual(checks(h, cli), [], `${cli}: no config, no checks`);
  }
  // the opencode skip note is unconditional in the helper; the doctor loop only asks for it when
  // opencode is actually detected, so an opencode-less machine still hears nothing there.
  const h = home();
  t.after(() => rmSync(h, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  assert.equal(one(h, "opencode").level, "info");
});

test("T368: a full doctor run surfaces the checks and the status line never fails it", async (t) => {
  const h = home(); const mbx = join(h, ".local/share/agentmbx");
  t.after(() => rmSync(h, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  new MbxNode(mbx, { host: "alpha", port: 1 }).close(); // nothing listens on port 1
  put(h, ".claude/settings.json", "{}\n");
  put(h, ".kimi-code/tui.toml", "theme = \"dark\"\n");
  put(h, ".grok/config.toml", "model = \"fake\"\n");
  put(h, ".config/opencode/opencode.jsonc", "{\n  \"$schema\": \"https://opencode.ai/config.json\"\n}\n");
  runSetup(ctxFor(h), { mode: "install" });
  const after = await doctor(ctxFor(h), mbx);
  const sl = after.filter((c) => /status line/.test(c.label));
  assert.ok(sl.some((c) => c.level === "ok" && /^claude: status line wired/.test(c.label)), JSON.stringify(sl));
  assert.ok(sl.some((c) => c.level === "ok" && /^kimi: status line wired/.test(c.label)));
  assert.ok(sl.some((c) => c.level === "ok" && /^grok: status line wired/.test(c.label)));
  assert.ok(sl.some((c) => c.level === "info" && /^opencode: no custom status line feature/.test(c.label)));
  assert.ok(!sl.some((c) => c.level === "fail"), "no status line check ever fails doctor");
  // swap kimi's wiring for a stale older form: the warn surfaces with its fix, still non-fatal
  writeFileSync(join(h, ".kimi-code/tui.toml"), "[status_line]\ncommand = \"/old/agentmbx statusline kimi\"\n");
  const stale = await doctor(ctxFor(h), mbx);
  const warn = stale.find((c) => /^kimi: status line uses an older AgentMBX form/.test(c.label));
  assert.ok(warn, JSON.stringify(stale.filter((c) => /status line/.test(c.label))));
  assert.equal(warn!.level, "warn");
  assert.equal(warn!.fix, "agentmbx setup --only kimi");
  assert.ok(!stale.some((c) => c.level === "fail" && /status line/.test(c.label)));
});
