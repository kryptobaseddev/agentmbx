// T369: `agentmbx statusline suggest` — dry-run placement proposals (AC1: nothing is written
// unless the user confirms with --apply). Foreign configs get a manual wrapper proposal (setup
// never overwrites a user's own line — T347); absent/stale wiring is applied only via setup's own
// status line edit, with a backup whose restore is byte-exact; proposals resolve the calling
// session's own identity only (T308 AC2).
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MbxNode } from "../src/node.ts";
import { IdentityLeases, inspectLeaseProcess } from "../src/identity-leases.ts";
import { applyStatuslineProposal, runStatuslineSuggest, statuslineSuggest, type SuggestCli } from "../src/statusline-suggest.ts";
import { runSetup, skillDest, type SetupCtx } from "../src/setup.ts";

const home = () => mkdtempSync(join(tmpdir(), "mbx-suggest-"));
const ctxFor = (h: string, cmd = ["/opt/bin/agentmbx"]): SetupCtx => ({ home: h, cmd, which: () => null, useClis: false });
const CONFIG: Record<SuggestCli, { rel: string; foreign: string }> = {
  claude: { rel: ".claude/settings.json", foreign: JSON.stringify({ statusLine: { type: "command", command: "my-own-statusline.sh" } }) + "\n" },
  kimi: { rel: ".kimi-code/tui.toml", foreign: `theme = "dark"\n\n[status_line]\ncommand = "my-own-statusline.sh"\n` },
  grok: { rel: ".grok/config.toml", foreign: `model = "fake"\n\n[ui.status_line]\ntype = "command"\ncommand = "my-own-statusline.sh"\n` },
};
const put = (h: string, cli: SuggestCli) => { const { rel, foreign } = CONFIG[cli]; mkdirSync(join(h, rel.split("/")[0]), { recursive: true }); writeFileSync(join(h, rel), foreign); return { rel, before: foreign }; };

test("AC1: proposal only — a foreign status line yields a manual wrapper proposal and writes nothing", (t) => {
  for (const cli of ["kimi", "grok", "claude"] as const) {
    const h = home();
    t.after(() => rmSync(h, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
    const { rel, before } = put(h, cli);
    const path = join(h, rel);
    const mtime = statSync(path).mtimeMs;
    const p = statuslineSuggest({ ctx: ctxFor(h), cli });
    assert.equal(p.state, "foreign");
    assert.equal(p.action, "manual");
    assert.equal(p.apply.supported, false, `${cli}: a user's own line is never auto-applied (T347)`);
    assert.match(p.apply.reason!, /never overwrites/);
    assert.equal(p.contract, cli === "claude" ? "additive" : "replace-only");
    assert.ok(p.wrapper, `${cli}: the proposal carries the wrapper script`);
    assert.match(p.wrapper!.content, /REPLACE-ONLY|ADDITIVE/);
    assert.match(p.wrapper!.content, /my-own-statusline\.sh/, "the user's command is embedded");
    assert.match(p.wrapper!.content, new RegExp(`statusline ${cli}`), "the mbx half renders this CLI's segment");
    assert.match(p.renderCommand!, /-statusline-wrapper\.sh/);
    assert.ok(p.steps.length >= 2);
    assert.equal(p.undo, null);
    assert.equal(readFileSync(path, "utf8"), before, "config bytes untouched");
    assert.equal(statSync(path).mtimeMs, mtime, "config mtime untouched");
    assert.ok(!existsSync(p.wrapper!.path), "no wrapper file written by the proposal");
  }
});

test("contracts: claude proposes true composition; kimi/grok propose wrapping, never items+command", (t) => {
  const h = home();
  t.after(() => rmSync(h, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  // claude additive: original first line preserved, mbx appended
  put(h, "claude");
  const c = statuslineSuggest({ ctx: ctxFor(h), cli: "claude" });
  assert.equal(c.contract, "additive");
  assert.match(c.replaceNote!, /built-in items plus/);
  assert.match(c.wrapper!.content, /user=\$\(printf '%s\\n' "\$json" \| sh -c 'my-own-statusline\.sh' \| sed -n '1p'\)/);
  assert.ok(c.wrapper!.content.indexOf("user=") < c.wrapper!.content.indexOf("mbx="), "claude renders the user's line first");
  assert.match(c.wrapper!.content, /printf '%s %s\\n' "\$user" "\$mbx"/, "and appends the segment to it");
  // kimi replace-only: the alert wins when present; the user's command only runs when nothing shows
  const h2 = home();
  t.after(() => rmSync(h2, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  put(h2, "kimi");
  // the bundled kimi adapter is installed (as setup installs it): the wrapper must render through
  // it — one cat, no node cold start per footer refresh (review round 1)
  mkdirSync(join(skillDest(h2), "scripts"), { recursive: true });
  writeFileSync(join(skillDest(h2), "scripts", "kimi-statusline.sh"), "#!/bin/sh\n");
  const k = statuslineSuggest({ ctx: ctxFor(h2), cli: "kimi" });
  assert.equal(k.contract, "replace-only");
  assert.match(k.replaceNote!, /WRAPPED, not accompanied/);
  assert.match(k.replaceNote!, /never/i);
  assert.doesNotMatch(JSON.stringify(k), /items stay|items and command coexist|compose/i, "kimi never claims items+command coexist");
  assert.ok(k.wrapper!.content.indexOf("mbx=") < k.wrapper!.content.indexOf("sh -c"), "the mbx alert comes first");
  assert.match(k.wrapper!.content, /mbx=\$\(printf '%s\\n' "\$json" \| sh \S*kimi-statusline\.sh\)/,
    "the wrapper invokes the bundled pure-sh render (statuslineCommand), not the node direct form");
  assert.doesNotMatch(k.wrapper!.content, /mbx=\$\(printf '%s\\n' "\$json" \| \/\S* statusline kimi\)/,
    "no node cold start on the render path");
  assert.match(k.wrapper!.content, /if \[ -n "\$mbx" \]; then\n  printf '%s\\n' "\$mbx"\n  exit 0\nfi/);
  // grok: same replace-only shape, its own config + render command
  const h3 = home();
  t.after(() => rmSync(h3, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  put(h3, "grok");
  const g = statuslineSuggest({ ctx: ctxFor(h3), cli: "grok" });
  assert.equal(g.configPath, join(h3, ".grok/config.toml"));
  assert.equal(g.contract, "replace-only");
  assert.match(g.wrapper!.content, /statusline grok/);
});

test("missing config: proposes fresh wiring; --apply writes via setup's edit and undo is byte-exact", (t) => {
  // absent file: apply creates it; undo removes it
  const h = home();
  t.after(() => rmSync(h, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  const ctx = ctxFor(h);
  const p = statuslineSuggest({ ctx, cli: "kimi" });
  assert.equal(p.state, "absent");
  assert.equal(p.action, "wire");
  assert.equal(p.apply.supported, true);
  assert.equal(p.renderCommand, "/opt/bin/agentmbx statusline kimi");
  const r = applyStatuslineProposal(p, ctx, "T369");
  assert.ok(r.applied, r.detail);
  assert.deepEqual(r.written, [join(h, ".kimi-code/tui.toml")]);
  assert.equal(r.backup, null, "no backup was needed for a file that did not exist");
  assert.match(r.undo!, /rm .*tui\.toml/);
  assert.match(readFileSync(join(h, ".kimi-code/tui.toml"), "utf8"), /\[status_line\]\ncommand = "\/opt\/bin\/agentmbx statusline kimi"\n/);
  rmSync(join(h, ".kimi-code/tui.toml"));
  assert.ok(!existsSync(join(h, ".kimi-code/tui.toml")), "undo returns an absent file to absent");

  // pre-existing unrelated file: apply upgrades it; undo restores the exact bytes
  const h2 = home();
  t.after(() => rmSync(h2, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  const before = `theme = "dark"\n\n[editor]\ncommand = "vim"\n`;
  mkdirSync(join(h2, ".kimi-code"), { recursive: true });
  writeFileSync(join(h2, ".kimi-code/tui.toml"), before);
  const ctx2 = ctxFor(h2);
  const p2 = statuslineSuggest({ ctx: ctx2, cli: "kimi" });
  const r2 = applyStatuslineProposal(p2, ctx2, "T369");
  assert.ok(r2.applied, r2.detail);
  assert.ok(r2.backup && existsSync(r2.backup), "a backup of the user's file was made");
  assert.match(readFileSync(join(h2, ".kimi-code/tui.toml"), "utf8"), /command = "\/opt\/bin\/agentmbx statusline kimi"/);
  assert.match(readFileSync(join(h2, ".kimi-code/tui.toml"), "utf8"), /\[editor\]\ncommand = "vim"/, "the user's other keys stay");
  execFileSync("mv", [r2.backup!, join(h2, ".kimi-code/tui.toml")]);
  assert.equal(readFileSync(join(h2, ".kimi-code/tui.toml"), "utf8"), before, "undo restores the exact bytes");
});

test("stale form: proposes the upgrade and applies it through setup's edit; undo is byte-exact", (t) => {
  const h = home();
  t.after(() => rmSync(h, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  const before = `[status_line]\ncommand = "/old/agentmbx statusline kimi"\n`;
  mkdirSync(join(h, ".kimi-code"), { recursive: true });
  writeFileSync(join(h, ".kimi-code/tui.toml"), before);
  const ctx = ctxFor(h);
  const p = statuslineSuggest({ ctx, cli: "kimi" });
  assert.equal(p.state, "ours");
  assert.equal(p.action, "wire");
  const r = applyStatuslineProposal(p, ctx, "T369");
  assert.ok(r.applied, r.detail);
  assert.match(readFileSync(join(h, ".kimi-code/tui.toml"), "utf8"), /command = "\/opt\/bin\/agentmbx statusline kimi"/);
  execFileSync("mv", [r.backup!, join(h, ".kimi-code/tui.toml")]);
  assert.equal(readFileSync(join(h, ".kimi-code/tui.toml"), "utf8"), before, "undo restores the exact bytes");
});

test("already wired with the current form: nothing to propose, apply is a no-op", (t) => {
  const h = home();
  t.after(() => rmSync(h, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  // install the skill so the wired form is the bundled script (the current form); the .claude
  // dir must exist or setup's detection skips the CLI
  mkdirSync(join(h, ".claude"), { recursive: true });
  runSetup(ctxFor(h), { mode: "install" });
  const ctx = ctxFor(h);
  const p = statuslineSuggest({ ctx, cli: "claude" });
  assert.equal(p.state, "ours");
  assert.equal(p.action, "none");
  assert.equal(p.apply.supported, false);
  assert.match(p.summary, /already wired/);
  const r = applyStatuslineProposal(p, ctx, "T369");
  assert.equal(r.applied, false);
  // foreign + --apply: refused, nothing written
  const h2 = home();
  t.after(() => rmSync(h2, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  put(h2, "kimi");
  const p2 = statuslineSuggest({ ctx: ctxFor(h2), cli: "kimi" });
  const r2 = applyStatuslineProposal(p2, ctxFor(h2), "T369");
  assert.equal(r2.applied, false);
  assert.match(r2.detail, /never overwrites/);
  assert.equal(readFileSync(join(h2, ".kimi-code/tui.toml"), "utf8"), CONFIG.kimi.foreign, "foreign config untouched by apply");
});

test("T308 AC2: the proposal resolves the CALLING session's own identity — never another session's", (t) => {
  const mbx = home();
  t.after(() => rmSync(mbx, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  const n = new MbxNode(mbx, { host: "alpha" });
  t.after(() => n.close());
  const claim = (name: string, sid: string) =>
    new IdentityLeases(n.store).claim(name, { pid: process.pid, start: inspectLeaseProcess(process.pid).start!, keyFp: "aaaa-bbbb-cccc-dddd", cli: "kimi", sessionId: sid });
  n.bindSession({ agent: "drum", cli: "kimi", session_id: "kimi-a", pid: process.pid, session_key: "k1" });
  claim("drum", "kimi-a");
  n.bindSession({ agent: "seg", cli: "kimi", session_id: "kimi-b", pid: process.pid, session_key: "k2" });
  claim("seg", "kimi-b");
  const h = home();
  t.after(() => rmSync(h, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  put(h, "kimi");
  const p = statuslineSuggest({ ctx: ctxFor(h), cli: "kimi", node: n, sessionId: "kimi-a" });
  assert.equal(p.session.identity, "drum");
  assert.equal(p.session.state, "bound");
  assert.equal(p.session.resolvedBy, "session_id");
  assert.doesNotMatch(JSON.stringify(p), /"seg"/, "the proposal never references the other identity");
  const unbound = statuslineSuggest({ ctx: ctxFor(h), cli: "kimi", node: n, sessionId: "unknown" });
  assert.equal(unbound.session.identity, null);
  assert.equal(unbound.session.state, "unbound");
  // without a node (uninitialized mailbox home) the proposal still works, session marked unavailable
  const noNode = statuslineSuggest({ ctx: ctxFor(h), cli: "kimi", node: null });
  assert.equal(noNode.session.state, "unavailable");
});

test("runStatuslineSuggest: default invocation performs zero writes, even when it could apply", (t) => {
  const h = home();
  t.after(() => rmSync(h, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  mkdirSync(join(h, ".kimi-code"), { recursive: true }); // kimi detected, no status line configured
  const mbx = home();
  t.after(() => rmSync(mbx, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  runStatuslineSuggest({ cliFlag: "kimi", apply: false, json: true, positionals: [], home: h, mbxHome: mbx, callerPid: process.pid });
  assert.ok(!existsSync(join(h, ".kimi-code/tui.toml")), "no config written without --apply");
  assert.deepEqual(existsSync(join(mbx, "config.json")), false, "an uninitialized mailbox home gains no store from a proposal");
  assert.deepEqual(existsSync(join(mbx, "mbx.db")), false);
});

test("CLI: suggest dispatches, emits JSON, writes nothing; usage errors exit 2", (t) => {
  const h = home();
  t.after(() => rmSync(h, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  put(h, "kimi");
  const mbx = home();
  t.after(() => rmSync(mbx, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  const env = { ...process.env, AGENTMBX_DEV: "1", MBX_HOME: mbx, MBX_NO_DESKTOP: "1", HOME: h } as Record<string, string>;
  const run = (...args: string[]) =>
    spawnSync(process.execPath, [join(import.meta.dirname, "../bin/agentmbx.js"), "statusline", "suggest", ...args], { encoding: "utf8", env });
  const ok = run("--cli", "kimi", "--json");
  assert.equal(ok.status, 0, ok.stderr);
  const proposal = JSON.parse(ok.stdout);
  assert.equal(proposal.schema, "mbx.statusline-suggest/v1");
  assert.equal(proposal.cli, "kimi");
  assert.equal(proposal.state, "foreign");
  assert.equal(proposal.action, "manual");
  assert.equal(readFileSync(join(h, ".kimi-code/tui.toml"), "utf8"), CONFIG.kimi.foreign, "CLI proposal wrote nothing");
  // default CLI: only kimi is set up here
  const detected = run("--json");
  assert.equal(detected.status, 0, detected.stderr);
  assert.equal(JSON.parse(detected.stdout).cli, "kimi");
  // usage: unknown cli, several candidates, session without cli, extra positionals — all exit 2 with a hint
  for (const [args, hint] of [
    [["--cli", "opencode"], /use claude\|kimi\|grok/],
    [["--session", "x"], /--session requires --cli/],
    [["extra"], /options, not positional/],
  ] as const) {
    const bad = run(...args);
    assert.equal(bad.status, 2, `${args}: ${bad.stderr}`);
    assert.match(bad.stderr, hint);
    assert.match(bad.stderr, /see: agentmbx statusline --help/);
  }
  mkdirSync(join(h, ".claude"), { recursive: true });
  const ambiguous = run();
  assert.equal(ambiguous.status, 2);
  assert.match(ambiguous.stderr, /needs --cli.*claude, kimi/s);
  // foreign + --apply: refused, config untouched
  const refused = run("--cli", "kimi", "--apply", "--json");
  assert.equal(refused.status, 0, refused.stderr);
  assert.equal(JSON.parse(refused.stdout).applyResult.applied, false);
  assert.equal(readFileSync(join(h, ".kimi-code/tui.toml"), "utf8"), CONFIG.kimi.foreign);
});

test("CLI: --apply on a missing status line wires it via setup's edit and prints the undo", (t) => {
  const h = home();
  t.after(() => rmSync(h, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  mkdirSync(join(h, ".kimi-code"), { recursive: true });
  const mbx = home();
  t.after(() => rmSync(mbx, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  const env = { ...process.env, AGENTMBX_DEV: "1", MBX_HOME: mbx, MBX_NO_DESKTOP: "1", HOME: h } as Record<string, string>;
  const applied = spawnSync(process.execPath, [join(import.meta.dirname, "../bin/agentmbx.js"), "statusline", "suggest", "--cli", "kimi", "--apply"],
    { encoding: "utf8", env });
  assert.equal(applied.status, 0, applied.stderr);
  assert.match(applied.stdout, /applied: wired kimi via setup's text edit/);
  assert.match(applied.stdout, /before.*\(file absent\)/s);
  assert.match(applied.stdout, /after:/);
  assert.match(applied.stdout, /undo: rm .*tui\.toml/);
  assert.match(readFileSync(join(h, ".kimi-code/tui.toml"), "utf8"), /command = ".*statusline kimi"/);
  rmSync(join(h, ".kimi-code/tui.toml"));
  const again = spawnSync(process.execPath, [join(import.meta.dirname, "../bin/agentmbx.js"), "statusline", "suggest", "--cli", "kimi", "--json"],
    { encoding: "utf8", env });
  assert.equal(JSON.parse(again.stdout).state, "absent", "undo returned the config to absent");
});
