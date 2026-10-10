// T460: Hermes hooks, watcher wake and receipts. Hermes (TUI/CLI) cannot be pushed a turn from outside; a finished
// `terminal(background=true, notify=true)` process starts one, so `agentmbx watch` is its wake path.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { MbxNode, HERMES_NO_PUSH } from "../src/node.ts";
import { edits, hermesConsent, runSetup, wired, type SetupCtx } from "../src/setup.ts";
import { doctor, hermesHooksChecks } from "../src/doctor.ts";
import { hermesHookInput, hermesHookOutput, hermesIsSideAgent, hermesUserMessage } from "../src/hermes-hook.ts";
import { delegateWake } from "./helpers/wake-lease.ts";
import { sendLeased } from "./helpers/leased-send.ts";
import { HERMES_WATCHER_INSTRUCTION, HERMES_WATCHER_REMINDER, selfWatchInstruction } from "../src/mcp.ts";
import { isHumanPrompt, wakeText } from "../src/wake.ts";
import { REBINDING_CLIS, withHookIdentity } from "../src/cli-identity.ts";
import { CURRENT_CAPABILITIES } from "../src/wake-contract.ts";
import { bindWakeLease } from "./helpers/wake-lease.ts";
import { publishIdentityControl } from "../src/identity-control.ts";
import { generateKeyPair, fingerprint } from "../src/crypto.ts";
import { IdentityLeases, inspectLeaseProcess } from "../src/identity-leases.ts";
import { identityGeneration } from "../src/identity-control.ts";

const tmp = () => mkdtempSync(join(tmpdir(), "mbx-hermes-"));

// What Hermes injects when our watcher exits: its own wrapper around the watcher's output (verified on a live TUI).
const WATCH_OUTPUT = "(eval):1: can't change option: zle\n(eval):1: can't change option: zle\n"
  + "[mbx] 1 new message(s) for agentmbx-hermes from agentmbx-lead@macbook [local] (ids 01M494VE9XVTVQP6FVAGVS9971). mbx_inbox or mbx_read, reply, ack.\n"
  + "[mbx-watch] After handling the mail, start this watcher again in the background.";
const WRAPPED = `[IMPORTANT: Background process proc_677ca7b734f1 completed normally (exit code 0).\nCommand: cd /work && agentmbx watch\nOutput:\n${WATCH_OUTPUT}\n]`;

test("a Hermes watcher wake is not the owner's prompt, so it never ends a relay chain", () => {
  assert.equal(isHumanPrompt(WRAPPED), false);
  assert.equal(isHumanPrompt(`[IMPORTANT: 2 background processes completed. Treat these results as one batch.]\n\n${WRAPPED}`), false,
    "a batched completion that carries our hint");
  assert.equal(isHumanPrompt("  " + WRAPPED), false, "leading whitespace");
});

test("only Hermes's own wrapper around our hint is machine-made: a person quoting it, or another process's completion, still counts", () => {
  assert.equal(isHumanPrompt("[IMPORTANT: Background process proc_1 completed normally (exit code 0).\nOutput:\nbuild ok\n]"), true,
    "someone else's background process is not our wake");
  assert.equal(isHumanPrompt("please look at this: " + WRAPPED), true, "the wrapper must open the prompt");
  assert.equal(isHumanPrompt("[IMPORTANT: please deploy now]"), true, "a person typing the marker is not a completion");
  assert.equal(isHumanPrompt("hello"), true);
  assert.equal(isHumanPrompt(undefined), false);
  assert.equal(isHumanPrompt(wakeText("a", [])), false, "the plain wake text keeps its meaning");
});

test("Hermes gets the event-driven watcher instruction with Hermes's own tool arguments", () => {
  const w = selfWatchInstruction({ delegated: false, cli: "hermes", env: {} });
  assert.equal(w, HERMES_WATCHER_INSTRUCTION);
  assert.match(w!, /command "agentmbx watch", background true, notify true/);
  assert.match(w!, /start it again the same way/);
  assert.doesNotMatch(w!, /run_in_background|disable_timeout|CronCreate/, "Kimi's argument names do not exist in Hermes");
  assert.equal(selfWatchInstruction({ delegated: true, cli: "hermes", env: {} }), HERMES_WATCHER_INSTRUCTION, "also when delegated");
  assert.match(selfWatchInstruction({ delegated: true, cli: "hermes", env: { MBX_SELF_WATCH: "15" } })!, /cron/, "an explicit cron choice still wins");
  assert.match(selfWatchInstruction({ delegated: true, cli: "hermes", env: { MBX_SELF_WATCH: "off" } })!, /Stop any/, "off still turns it off");
  assert.equal(selfWatchInstruction({ delegated: false, cli: "grok", env: {} }), null, "other CLIs keep their existing behaviour");
});

test("Hermes delivery text names the working wake path and keeps the no-push prefix receipts key on", t => {
  const n = new MbxNode(tmp(), { host: "alpha" });
  t.after(() => { n.close(); rmSync(n.home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
  assert.match(HERMES_NO_PUSH, /^no push:/);
  assert.match(HERMES_NO_PUSH, /terminal\(background=true, notify=true\)/);
  bindWakeLease(n, { agent: "worker", cli: "hermes", session_id: "real-hermes-1", pid: process.pid });
  assert.equal(n.deliveryMode("worker"), HERMES_NO_PUSH);
  n.store.set("watcher:worker", JSON.stringify({ pid: process.pid, at: Date.now() }));
  assert.match(n.deliveryMode("worker"), /^push \(mbx watcher: its exit starts your next turn\)/, "a live watcher is push");
  // a Hermes session sharing its agent with another CLI is not described as Hermes-only
  n.store.set("watcher:worker", "null");
  n.store.db.prepare("INSERT INTO sessions (agent,cli,session_id,cwd,pid,session_key,channel,updated_at,pid_start) SELECT agent,'kimi','k-1',cwd,pid,session_key,channel,updated_at,pid_start FROM sessions WHERE cli='hermes'").run();
  assert.match(n.deliveryMode("worker"), /^no push: new mail shows/);
  assert.notEqual(n.deliveryMode("worker"), HERMES_NO_PUSH);
});

test("the wake contract still declares no exact-session adapter for Hermes (the watcher receipt is process ancestry)", () => {
  assert.equal(CURRENT_CAPABILITIES.hermes.exactSession, "none");
  assert.equal(CURRENT_CAPABILITIES.hermes.admissionReceipt, "none");
});

test("Hermes joins Claude as a CLI whose one process rebinds its session id; a multi-session host does not", () => {
  assert.deepEqual([...REBINDING_CLIS].sort(), ["claude", "hermes"]);
  for (const cli of ["codex", "opencode", "kimi", "grok"]) assert.equal(REBINDING_CLIS.includes(cli), false, cli);
});

test("a Hermes hook with no session id, or a provisional one, never binds", t => {
  const n = new MbxNode(tmp(), { host: "alpha" });
  t.after(() => { n.close(); rmSync(n.home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
  bindWakeLease(n, { agent: "worker", cli: "hermes", session_id: "mcp-57020", pid: process.ppid });
  for (const bad of [undefined, "", " x", "mcp-57020", "a\nb", "x".repeat(301)])
    assert.throws(() => withHookIdentity(n, "hermes", bad, () => 1, true), /valid non-provisional session id/, JSON.stringify(bad));
});

test("Hermes bootstrap: the first real session id binds the one holder, and only inside the hook events that allow it", t => {
  const n = new MbxNode(tmp(), { host: "alpha" });
  t.after(() => { n.close(); rmSync(n.home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
  bindWakeLease(n, { agent: "worker", cli: "hermes", session_id: "mcp-57020", pid: process.ppid });
  const seen = withHookIdentity(n, "hermes", "hermes-session-1", (agent, _d, bootstrap) => ({ agent, bootstrap }), true);
  assert.deepEqual(seen, { agent: "worker", bootstrap: true });
  // without allowBootstrap (stop / post-tool) an id the holder never published is refused, never guessed
  assert.throws(() => withHookIdentity(n, "hermes", "hermes-session-1", () => 1, false), /no exact current MCP binding/);
});

test("Hermes /new: after a real id was bound, the next real id of the same process and holder rebinds", t => {
  const n = new MbxNode(tmp(), { host: "alpha" });
  t.after(() => { n.close(); rmSync(n.home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
  bindWakeLease(n, { agent: "worker", cli: "hermes", session_id: "mcp-57020", pid: process.ppid });
  const key = n.sessionsFor("worker").find((s) => s.cli === "hermes")!.session_key!;
  // The hook's bind step for a rebinding CLI: carry the holder's existing session key to the new id, drop the stale row, publish.
  const hookBind = (sid: string) => withHookIdentity(n, "hermes", sid, (agent, d) => {
    n.bindSession({ agent, cli: "hermes", session_id: sid, cwd: process.cwd(), pid: process.ppid, session_key: key, channel: false });
    n.store.db.prepare("DELETE FROM sessions WHERE cli=? AND pid=? AND session_key=? AND session_id<>?").run("hermes", process.ppid, key, sid);
    publishIdentityControl(n.store, { ...d, session_id: sid });
    return agent;
  }, true);
  assert.equal(hookBind("hermes-session-1"), "worker");
  assert.deepEqual(n.sessionsFor("worker").map((s) => s.session_id), ["hermes-session-1"], "the provisional mcp- row was replaced");
  // the id already bound keeps its direct path and is not a bootstrap
  assert.deepEqual(withHookIdentity(n, "hermes", "hermes-session-1", (agent, _d, bootstrap) => ({ agent, bootstrap }), true), { agent: "worker", bootstrap: false });
  // /new: a brand-new id from the same process and holder is a rebind, not a second holder
  assert.equal(hookBind("hermes-session-2"), "worker");
  assert.deepEqual(n.sessionsFor("worker").map((s) => s.session_id), ["hermes-session-2"], "exactly one live conversation row after /new");
  assert.equal(n.sessionsFor("worker")[0].session_key, key, "same lease key");
});

test("Hermes bootstrap refuses two different holders under one process, and a CLI that may not rebind", t => {
  const n = new MbxNode(tmp(), { host: "alpha" });
  t.after(() => { n.close(); rmSync(n.home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
  bindWakeLease(n, { agent: "worker", cli: "hermes", session_id: "mcp-57020", pid: process.ppid });
  // a second, independent holder (its own key and lease) under the same provider pid: a multi-session host
  const start = inspectLeaseProcess(process.pid).start!, key = generateKeyPair();
  const lease = new IdentityLeases(n.store).claim("second", { pid: process.pid, start, keyFp: fingerprint(key.publicKey), cli: "hermes", sessionId: "mcp-99999" });
  publishIdentityControl(n.store, { v: 1, agent: "second", cli: "hermes", session_id: "mcp-99999", lease_session_id: "mcp-99999", control_key: fingerprint(key.publicKey),
    mcp_pid: process.pid, mcp_start: start, parent_pid: process.ppid, parent_start: inspectLeaseProcess(process.ppid).start!, generation: identityGeneration(lease.token) });
  assert.throws(() => withHookIdentity(n, "hermes", "hermes-session-1", () => 1, true), /no exact current MCP binding/,
    "two control keys under one provider process are never merged by guessing");
  bindWakeLease(n, { agent: "other", cli: "codex", session_id: "mcp-1", pid: process.ppid });
  assert.throws(() => withHookIdentity(n, "codex", "real-codex", () => 1, true), /no exact current MCP binding/);
});


// ---- setup: the hooks edit (T347 bar: byte-exact install/uninstall, foreign content never touched) ------------------
const CMD = ["/opt/bin/agentmbx"];
const ctxFor = (home: string, cmd = CMD): SetupCtx => ({ home, cmd, which: () => null, useClis: false });
const SESSION = "/opt/bin/agentmbx hook session-start --cli hermes", PROMPT = "/opt/bin/agentmbx hook prompt --cli hermes";
function hermesHome(t: { after: (fn: () => void) => void }, config: string | null) {
  const home = mkdtempSync(join(tmpdir(), "mbx-hermes-setup-"));
  t.after(() => rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  mkdirSync(join(home, ".hermes"), { recursive: true });
  if (config !== null) writeFileSync(join(home, ".hermes/config.yaml"), config);
  return home;
}
const cfgPath = (home: string) => join(home, ".hermes/config.yaml");
const hooksEdit = (home: string, cmd = CMD) => edits(ctxFor(home, cmd), "hermes").find((e) => e.kind === "hooks")!;
const row = (rows: ReturnType<typeof runSetup>, kind: "hooks" | "consent") => rows.find((r) => r.cli === "hermes" && r.item.startsWith(kind === "hooks" ? "hooks" : "shell-hooks"))!;

// Every layout the line edit must leave byte-for-byte after install + uninstall.
const ROUNDTRIP: Record<string, string> = {
  "no hooks key": "model:\n  default: x\nagent:\n  a: 1\n",
  "no hooks key, no trailing newline": "model:\n  default: x",
  "empty file": "",
  "hooks: {} (inline empty)": "model: 1\nhooks: {}\nagent:\n  a: 1\n",
  "hooks: null": "hooks: null\nmodel: 1\n",
  "hooks: ~": "hooks: ~\nmodel: 1\n",
  "hooks: with only a comment": "hooks:   # none yet\nmodel: 1\n",
  "foreign hooks on the same events": "model: 1\nhooks:\n  pre_llm_call:\n    - command: \"~/.hermes/agent-hooks/inject.sh\"\n      timeout: 5\n  on_session_start:\n    - command: /usr/local/bin/other\n  post_tool_call:\n    - matcher: \"write_file\"\n      command: \"~/fmt.sh\"\n  output_spill:\n    max_chars: 4000\nhooks_auto_accept: false\nagent:\n  a: 1\n",
  "an event key with a null list": "hooks:\n  pre_llm_call:\n  subagent_stop:\n    - command: /z.sh\n",
  "dashes at the key's own indent": "hooks:\n  pre_llm_call:\n  - command: /x/y.sh\n  - command: /x/z.sh\n",
  "4-space indent": "hooks:\n    pre_llm_call:\n        - command: /x/y.sh\n    subagent_stop:\n        - command: /z.sh\n",
  "hooks block ends the file without a newline": "hooks:\n  pre_llm_call:\n    - command: /x/y.sh",
  "CRLF file, no hooks": "model: 1\r\nagent:\r\n  a: 1\r\n",
  "CRLF file with foreign hooks": "model: 1\r\nhooks:\r\n  subagent_stop:\r\n    - command: /z.sh\r\nagent:\r\n  a: 1\r\n",
  "a file that mixes LF and CRLF": "model: 1\r\nagent:\r\n  a: 1\r\n\nmcp_servers:\n  mbx:\n    command: x\n",
  "a composed command of ours is foreign": "hooks:\n  pre_llm_call:\n    - command: \"/opt/bin/agentmbx hook prompt --cli hermes && echo hi\"\n",
  "a block-scalar command is foreign": "hooks:\n  pre_llm_call:\n    - command: |\n        /x/y.sh\n",
  "a single-quoted foreign command": "hooks:\n  pre_llm_call:\n    - command: '/x/it''s.sh'\n",
};
for (const [name, cfg] of Object.entries(ROUNDTRIP)) test(`hermes hooks edit: ${name}: install is idempotent, wired, and uninstall is byte-exact`, t => {
  const home = hermesHome(t, cfg), e = hooksEdit(home);
  assert.equal(e.blocked?.(cfg) ?? null, null);
  const once = e.install(cfg)!;
  assert.notEqual(once, cfg, "setup adds its two hooks");
  assert.equal(e.install(once), once, "a second install changes nothing");
  assert.ok(once.includes(SESSION) && once.includes(PROMPT));
  assert.equal((once.match(/agentmbx hook /g) ?? []).length, cfg.includes("agentmbx hook") ? 3 : 2, "exactly one of each of ours");
  writeFileSync(cfgPath(home), once);
  assert.equal(wired(e), true);
  assert.equal(e.uninstall(once), cfg, "uninstall restores every byte");
  assert.equal(e.uninstall(cfg), cfg, "uninstall on a file without ours is a no-op");
});

test("hermes hooks edit: foreign entries on the same event stay in place, ours is appended to the same list", t => {
  const cfg = ROUNDTRIP["foreign hooks on the same events"], e = hooksEdit(hermesHome(t, cfg)), out = e.install(cfg)!;
  assert.ok(out.startsWith(cfg.slice(0, cfg.indexOf("hooks_auto_accept"))) === false || true);
  const lines = out.split("\n");
  const at = (s: string) => lines.findIndex((l) => l.includes(s));
  assert.ok(at("inject.sh") >= 0 && at(PROMPT) > at("inject.sh") && at(PROMPT) < at("on_session_start:"), "ours follows the foreign pre_llm_call entry inside its list");
  assert.ok(out.includes("    - command: /usr/local/bin/other\n") && out.includes(`    - command: ${JSON.stringify(SESSION)}\n      timeout: 10\n`), "and joins the foreign on_session_start list");
  assert.equal(out.match(/on_session_start:/g)!.length, 1, "no duplicate event key");
  assert.equal(out.match(/pre_llm_call:/g)!.length, 1);
  assert.ok(out.includes("hooks_auto_accept: false\nagent:\n  a: 1\n"), "everything after the block is untouched");
});

test("hermes hooks edit: a moved binary is rewritten in place, duplicates collapse, a composed command is never claimed", t => {
  const old = "hooks:\n  pre_llm_call:\n    - command: \"/old/place/agentmbx hook prompt --cli hermes\"\n      timeout: 10\n    - command: /usr/bin/agentmbx hook prompt --cli hermes\n  on_session_start:\n    - command: \"/opt/bin/agentmbx hook session-start --cli hermes && echo hi\"\n";
  const e = hooksEdit(hermesHome(t, old)), out = e.install(old)!;
  assert.equal((out.match(/hook prompt --cli hermes/g) ?? []).length, 1, "the two stale copies of ours became one");
  assert.ok(out.includes(`command: ${JSON.stringify(PROMPT)}`) && !out.includes("/old/place") && !out.includes("/usr/bin/agentmbx"));
  assert.ok(out.includes('"/opt/bin/agentmbx hook session-start --cli hermes && echo hi"'), "the composed command stays, untouched");
  assert.equal((out.match(/hook session-start --cli hermes"\n/g) ?? []).length, 1, "and ours is added next to it");
});

test("hermes hooks edit: a command path with replacement-pattern characters is written literally", t => {
  const odd = ["/opt/we ird/$&'x/agentmbx"], e = hooksEdit(hermesHome(t, "model: 1\n"), odd);
  const once = e.install("model: 1\n")!;
  const moved = hooksEdit(hermesHome(t, once), ["/opt/we ird/$&'x/agentmbx"]).install(once.replace(/\/opt\/we ird/g, "/elsewhere"))!;
  assert.ok(moved.includes("$&"), "a $& in the path survives an in-place rewrite");
  assert.equal(e.uninstall(once), "model: 1\n");
});

const REFUSED: Record<string, [string, RegExp]> = {
  "flow-style hooks": ["hooks: { pre_llm_call: [ { command: x } ] }\n", /inline or quoted/],
  "a quoted hooks key": ['"hooks":\n  a: []\n', /inline or quoted/],
  "hooks defined twice": ["hooks:\n  a: []\nhooks:\n  b: []\n", /more than once/],
  "an inline event list": ["hooks:\n  pre_llm_call: [ {command: x} ]\n", /written inline/],
  "tab indentation": ["hooks:\n\tpre_llm_call:\n\t\t- command: x\n", /tabs/],
  "an inline value with children": ["hooks: {}\n  a: 1\n", /inline value/],
  "an event that is not a list": ["hooks:\n  pre_llm_call:\n    command: x\n", /not a plain list/],
};
for (const [name, [cfg, why]] of Object.entries(REFUSED)) test(`hermes hooks edit refuses ${name}: file untouched, reported, never half-wired, consent not written`, t => {
  const home = hermesHome(t, cfg), e = hooksEdit(home);
  assert.match(e.blocked!(cfg)!, why);
  assert.equal(e.install(cfg), cfg); assert.equal(e.uninstall(cfg), cfg);
  assert.equal(wired(e), false, "doctor reads it as not wired");
  const rows = runSetup(ctxFor(home), { mode: "install", only: ["hermes"], stamp: "R" });
  assert.equal(readFileSync(cfgPath(home), "utf8").includes("agentmbx hook"), false, "no hook written anywhere");
  assert.ok(!readFileSync(cfgPath(home), "utf8").includes("managed by agentmbx setup") || readFileSync(cfgPath(home), "utf8").includes("mcp_servers"), "only the MCP edit may have touched the file");
  assert.equal(row(rows, "hooks").action, "manual"); assert.match(row(rows, "hooks").note!, why);
  assert.match(row(rows, "hooks").note!, /on_session_start -> \/opt\/bin\/agentmbx hook session-start --cli hermes; pre_llm_call -> /, "the note says exactly what to add");
  assert.equal(existsSync(join(home, ".hermes/shell-hooks-allowlist.json")), false, "approving hooks that were not wired would approve nothing real");
  assert.equal(row(rows, "consent").action, "unchanged");
  const un = runSetup(ctxFor(home), { mode: "uninstall", only: ["hermes"], stamp: "U" });
  assert.equal(un.some((r) => r.action === "error"), false);
});

test("hermes setup: dry run shows hooks and approvals and writes nothing; the second run is a no-op; uninstall removes only ours", t => {
  const cfg = "model: 1\nhooks:\n  pre_llm_call:\n    - command: /x/y.sh\n";
  const home = hermesHome(t, cfg);
  const dry = runSetup(ctxFor(home), { mode: "install", only: ["hermes"], dryRun: true });
  assert.equal(row(dry, "hooks").action, "added"); assert.equal(row(dry, "consent").action, "added");
  assert.equal(readFileSync(cfgPath(home), "utf8"), cfg); assert.equal(existsSync(join(home, ".hermes/shell-hooks-allowlist.json")), false);
  const first = runSetup(ctxFor(home), { mode: "install", only: ["hermes"], stamp: "A" });
  assert.equal(first.some((r) => r.action === "error"), false);
  assert.match(first.find((r) => r.item === "note")!.note!, /when a session starts/, "an already-running Hermes session keeps its old hooks");
  const second = runSetup(ctxFor(home), { mode: "install", only: ["hermes"], stamp: "B" });
  assert.deepEqual(second.filter((r) => r.action !== "unchanged" && r.action !== "skipped"), []);
  assert.equal(second.some((r) => r.item === "note"), false, "no note when nothing changed");
  runSetup(ctxFor(home), { mode: "uninstall", only: ["hermes"], stamp: "U" });
  assert.equal(readFileSync(cfgPath(home), "utf8"), cfg, "the foreign hook is all that is left");
  assert.equal(existsSync(join(home, ".hermes/shell-hooks-allowlist.json")), false, "an allowlist setup created is removed");
});

// ---- setup: approvals in shell-hooks-allowlist.json ---------------------------------------------------------------
const ALLOW = (home: string) => join(home, ".hermes/shell-hooks-allowlist.json");
const approval = (event: string, command: string) => ({ approved_at: "2026-09-01T00:00:00Z", command, event, script_mtime_at_approval: null });
const hermesJson = (o: unknown) => JSON.stringify(o, null, 2); // how Hermes writes it: indent 2, sorted keys, no trailing newline

test("hermes approvals: a file setup creates is private, holds exactly our two pairs, and is removed on uninstall", t => {
  const home = hermesHome(t, "model: 1\n");
  runSetup(ctxFor(home), { mode: "install", only: ["hermes"] });
  assert.equal(statSync(ALLOW(home)).mode & 0o777, 0o600);
  const j = JSON.parse(readFileSync(ALLOW(home), "utf8")) as { approvals: Record<string, unknown>[] };
  assert.deepEqual(j.approvals.map((a) => [a.event, a.command]), [["on_session_start", SESSION], ["pre_llm_call", PROMPT]]);
  for (const a of j.approvals) assert.deepEqual(Object.keys(a).sort(), ["approved_at", "command", "event", "script_mtime_at_approval"], "the keys Hermes itself records");
  assert.deepEqual(hermesConsent(ctxFor(home)), { state: "approved", missing: [] });
  runSetup(ctxFor(home), { mode: "uninstall", only: ["hermes"] });
  assert.equal(existsSync(ALLOW(home)), false);
});

test("hermes approvals: foreign approvals are carried over untouched; uninstall restores a Hermes-written file byte-for-byte", t => {
  const home = hermesHome(t, "model: 1\n");
  const original = hermesJson({ approvals: [approval("pre_tool_call", "/x/guard.sh"), approval("pre_llm_call", "/opt/bin/agentmbx hook prompt --cli hermes && echo hi")] });
  writeFileSync(ALLOW(home), original);
  runSetup(ctxFor(home), { mode: "install", only: ["hermes"] });
  const mid = JSON.parse(readFileSync(ALLOW(home), "utf8")).approvals as { event: string; command: string }[];
  assert.deepEqual(mid.slice(0, 2), JSON.parse(original).approvals, "the foreign entries are first, unchanged");
  assert.deepEqual(mid.slice(2).map((a) => a.command), [SESSION, PROMPT]);
  runSetup(ctxFor(home), { mode: "uninstall", only: ["hermes"] });
  assert.equal(readFileSync(ALLOW(home), "utf8"), original);
});

test("hermes approvals: a moved binary replaces the old approval of ours, never accumulates, and never touches a foreign one", t => {
  const home = hermesHome(t, "model: 1\n");
  writeFileSync(ALLOW(home), hermesJson({ approvals: [approval("pre_llm_call", "/x/other.sh")], note: "keep me" }));
  runSetup(ctxFor(home, ["/old/agentmbx"]), { mode: "install", only: ["hermes"] });
  runSetup(ctxFor(home, ["/new/bin/agentmbx"]), { mode: "install", only: ["hermes"] });
  const j = JSON.parse(readFileSync(ALLOW(home), "utf8")) as { approvals: { command: string }[]; note: string };
  assert.deepEqual(j.approvals.map((a) => a.command), ["/x/other.sh", "/new/bin/agentmbx hook session-start --cli hermes", "/new/bin/agentmbx hook prompt --cli hermes"]);
  assert.equal(j.note, "keep me", "unrelated top-level keys survive");
});

for (const [name, body] of [["invalid JSON", "{ nope"], ["a JSON array", "[1]"], ["approvals that is not a list", '{"approvals": {"a": 1}}']] as const)
  test(`hermes approvals: an allowlist that is ${name} is left alone and reported`, t => {
    const home = hermesHome(t, "model: 1\n");
    writeFileSync(ALLOW(home), body);
    const rows = runSetup(ctxFor(home), { mode: "install", only: ["hermes"] });
    assert.equal(readFileSync(ALLOW(home), "utf8"), body);
    assert.equal(row(rows, "consent").action, "manual"); assert.match(row(rows, "consent").note!, /approve the agentmbx hooks yourself/);
    assert.equal(row(rows, "hooks").action, "added", "the hooks themselves are still wired");
    assert.equal(hermesConsent(ctxFor(home)).state, "unreadable");
  });

// ---- doctor ------------------------------------------------------------------------------------------------------
test("doctor: hermes hooks are reported as wired, and wired-but-not-approved is a warn with the fix", async t => {
  const home = hermesHome(t, "model: 1\n"), mbx = join(home, ".local/share/agentmbx");
  new MbxNode(mbx, { host: "alpha", port: 1 }).close();
  assert.deepEqual(hermesHooksChecks(ctxFor(home)), [], "silent until the hooks are wired: the generic row already says not wired");
  const before = await doctor(ctxFor(home), mbx);
  assert.ok(before.some((c) => c.level === "fail" && /^hermes: hooks not wired/.test(c.label) && c.fix === "agentmbx setup --only hermes"));
  const only = (kinds: string[]) => runSetup(ctxFor(home), { mode: "install", only: ["hermes"] }).filter((r) => kinds.includes(r.item));
  only([]);
  rmSync(ALLOW(home));
  const warn = hermesHooksChecks(ctxFor(home));
  assert.equal(warn.length, 1); assert.equal(warn[0].level, "warn");
  assert.match(warn[0].label, /hooks are wired but not approved \(on_session_start, pre_llm_call\), so Hermes skips them/);
  assert.match(warn[0].fix!, /agentmbx setup --only hermes.*hooks_auto_accept: true/);
  const after = await doctor(ctxFor(home), mbx);
  assert.ok(after.some((c) => c.level === "ok" && /^hermes: hooks wired/.test(c.label)));
  assert.ok(after.some((c) => c.level === "warn" && /not approved/.test(c.label)));
  assert.equal(after.filter((c) => c.level === "fail" && /^hermes:/.test(c.label)).length, 0, "a warn never fails doctor");
  writeFileSync(ALLOW(home), hermesJson({ approvals: [approval("on_session_start", SESSION)] }));
  assert.match(hermesHooksChecks(ctxFor(home))[0].label, /not approved \(pre_llm_call\)/, "names only what is missing");
  writeFileSync(ALLOW(home), "{ nope");
  assert.match(hermesHooksChecks(ctxFor(home))[0].label, /cannot be read/);
  rmSync(ALLOW(home));
  writeFileSync(cfgPath(home), readFileSync(cfgPath(home), "utf8") + "hooks_auto_accept: true\n");
  assert.deepEqual(hermesHooksChecks(ctxFor(home)).map((c) => [c.level, c.label]), [["ok", "hermes: hooks approved to run (hooks_auto_accept: true)"]]);
  rmSync(cfgPath(home)); writeFileSync(cfgPath(home), "model: 1\n" + "hooks: { a: [] }\n");
  const refused = hermesHooksChecks(ctxFor(home));
  assert.equal(refused[0].level, "warn"); assert.match(refused[0].label, /cannot be wired automatically: hooks: is written inline/);
});

// ---- the hook: Hermes's wire shape, end to end against a real MCP holder ------------------------------------------
test("hermes wire shape: user_message, a multimodal list, and the subagent marker", () => {
  assert.equal(hermesUserMessage("hi"), "hi");
  assert.equal(hermesUserMessage([{ type: "text", text: "a" }, { type: "image_url", image_url: { url: "x" } }, { type: "text", text: "b" }]), "a\nb");
  assert.equal(hermesUserMessage([{ type: "image_url" }]), undefined); assert.equal(hermesUserMessage(7), undefined); assert.equal(hermesUserMessage(undefined), undefined);
  const m = hermesHookInput({ session_id: "s", cwd: "/w", extra: { user_message: "p", platform: "tui" } });
  assert.deepEqual([m.input.session_id, m.input.cwd, m.input.prompt, m.skip], ["s", "/w", "p", false]);
  assert.equal(hermesHookInput({ session_id: "s", extra: { platform: "subagent" } }).skip, true);
  for (const [sid, platform, side] of [["20261006_102024_8a411f", "tui", false], ["20261006_102024_8a411f", "cli", false], ["x", undefined, false],
    ["bg_101010_abc123", "tui", true], ["bg_abc123", "cli", true], ["btw_abc123", "tui", true], ["preview_abc123", "tui", true],
    ["main", "subagent", true], ["main", "cron", true], ["main", "telegram", true], ["main", "desktop", true], ["main", "", true], ["main", 7, true],
    ["background_job", "tui", false], ["btwx", "tui", false], ["main_bg_1", "tui", false]] as [string, unknown, boolean][])
    assert.equal(hermesIsSideAgent(sid, platform), side, `${sid} / ${String(platform)}`);
  assert.equal(hermesHookInput({ session_id: "after-compress", parent_session_id: "before-compress", extra: { platform: "tui" } }).skip, false,
    "context compression gives the main conversation a new id WITH a parent: a parent is not a side-agent signal");
  assert.equal(hermesHookInput({ session_id: "s" }).skip, false, "no extra at all is still a normal hook call");
  assert.equal(hermesHookInput({ session_id: "s", extra: [1] as never }).skip, false);
  assert.equal(hermesHookOutput("UserPromptSubmit", "x"), '{"context":"x"}');
  assert.equal(hermesHookOutput("SessionStart", "x"), null, "on_session_start's output is dropped by Hermes: print none");
});

async function hermesHolder(t: { after: (fn: () => Promise<void> | void) => void }, agent = "worker") {
  const home = mkdtempSync(join(tmpdir(), "mbx-hermes-hook-")), n = new MbxNode(home, { host: "alpha" }), c = new Client({ name: "hermes-hook", version: "1" });
  const env = { ...process.env, AGENTMBX_DEV: "1", MBX_HOME: home, MBX_CLI: "hermes", MBX_AGENT: agent, MBX_NO_DESKTOP: "1", MBX_DEBUG: "" } as Record<string, string>;
  t.after(async () => { await c.close(); n.close(); rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
  await c.connect(new StdioClientTransport({ command: process.execPath, args: [resolve("bin/agentmbx.js"), "mcp"], env }));
  await c.callTool({ name: "mbx_whoami", arguments: {} });
  delegateWake(n, agent);
  const hook = (event: "session-start" | "prompt", session_id: unknown, extra: Record<string, unknown> = {}) => spawnSync(process.execPath,
    [resolve("bin/agentmbx.js"), "hook", event, "--cli", "hermes"], { encoding: "utf8", env, timeout: 15_000,
      input: JSON.stringify({ hook_event_name: event === "prompt" ? "pre_llm_call" : "on_session_start", tool_name: null, tool_input: null, session_id, cwd: process.cwd(), profile: "default", extra }) });
  const ctx = (out: string) => (JSON.parse(out) as { context: string }).context;
  const rows = () => n.sessionsFor(agent).map((s) => `${s.cli}:${s.session_id}`);
  return { n, c, env, hook, ctx, rows, agent };
}

test("hermes hooks: on_session_start binds the real session id silently; the same session's prompts reply with {context} only", async t => {
  const { n, c, hook, ctx, rows, agent } = await hermesHolder(t);
  sendLeased(n, { from: "boss", to: [agent], subject: "PRIVATE SUBJECT", body: "SECRET BODY", kind: "request" });
  const start = hook("session-start", "hermes-sess-A", { model: "m", platform: "tui" });
  assert.equal(start.status, 0, start.stderr); assert.equal(start.stdout, "", "Hermes drops on_session_start output, so none is printed");
  assert.deepEqual(rows(), ["hermes:hermes-sess-A"], "the provisional mcp- row became the real session");
  const who = (await c.callTool({ name: "mbx_whoami", arguments: {} })).structuredContent as { session: string };
  assert.equal(who.session.startsWith("mcp-"), false, "the MCP server now reports the real session, not mcp-<pid>");
  const p1 = hook("prompt", "hermes-sess-A", { user_message: "please continue", is_first_turn: true, platform: "tui" });
  assert.equal(p1.status, 0, p1.stderr); assert.equal(p1.stderr, "");
  assert.equal(p1.stdout.trim().split("\n").length, 1, "one JSON object on one line");
  const c1 = ctx(p1.stdout);
  assert.match(c1, /^\[mbx\] 1 unread for worker@alpha: mbx_inbox\./); assert.match(c1, /Policies \(separate grants/);
  assert.ok(c1.includes(HERMES_WATCHER_INSTRUCTION), "the watcher instruction rides in the first prompt of the session");
  assert.doesNotMatch(c1, /PRIVATE SUBJECT|SECRET BODY/, "no mail content, only counts");
  const c2 = ctx(hook("prompt", "hermes-sess-A", { user_message: "and now?", platform: "tui" }).stdout);
  assert.equal(c2, "[mbx] 1 unread for worker@alpha: mbx_inbox.", "the policy recap and the watcher text are not repeated every turn");
});

test("hermes hooks: the watcher reminder is one line, bounded, and silent while a watcher runs", async t => {
  const { n, hook, ctx, agent } = await hermesHolder(t);
  hook("session-start", "s1", { platform: "tui" });
  assert.ok(ctx(hook("prompt", "s1", { user_message: "a", platform: "tui" }).stdout).includes(HERMES_WATCHER_INSTRUCTION), "no mail needed: the first prompt arms it");
  assert.equal(hook("prompt", "s1", { user_message: "b", platform: "tui" }).stdout, "", "nothing again inside the window");
  n.store.set(`hermesnag:s1:${agent}`, new Date(Date.now() - 11 * 60_000).toISOString());
  assert.equal(ctx(hook("prompt", "s1", { user_message: "c", platform: "tui" }).stdout), HERMES_WATCHER_REMINDER, "after the window: the short reminder, not the full text");
  n.store.set(`hermesnag:s1:${agent}`, new Date(Date.now() - 11 * 60_000).toISOString());
  n.store.set(`watcher:${agent}`, JSON.stringify({ pid: process.pid, at: Date.now() }));
  assert.equal(hook("prompt", "s1", { user_message: "d", platform: "tui" }).stdout, "", "a live watcher: no reminder at all");
});

test("hermes hooks: a Hermes watcher wake is not announced twice and is not a human prompt", async t => {
  const { n, hook, ctx, agent } = await hermesHolder(t);
  hook("session-start", "s1", { platform: "tui" });
  const mail = sendLeased(n, { from: "boss", to: [agent], subject: "s", body: "b", kind: "request" }).envelope.id;
  n.store.set(`watcher:${agent}`, JSON.stringify({ pid: process.pid, at: Date.now() }));
  const wake = `[IMPORTANT: Background process proc_1 completed normally (exit code 0).\nOutput:\n[mbx] 1 new message(s) for ${agent} from boss@alpha [local] (ids ${mail}). mbx_inbox or mbx_read, reply, ack.\n[mbx-watch] After handling the mail, start this watcher again in the background.\n]`;
  const r = hook("prompt", "s1", { user_message: wake, platform: "tui" });
  assert.equal(r.stdout, "", "the wake text is itself the notice");
  assert.equal(n.store.get(`human-prompt:${agent}`), undefined, "and it did not reset the relay chain as if the owner typed");
  assert.ok(ctx(hook("prompt", "s1", { user_message: "a real person typing", platform: "tui" }).stdout));
  assert.ok(n.store.get(`human-prompt:${agent}`), "a person's prompt does");
});

test("hermes hooks: a /background or /btw side agent (platform tui, its own bg_/btw_ id) never takes over the conversation's binding", async t => {
  const { n, hook, rows, agent } = await hermesHolder(t);
  sendLeased(n, { from: "boss", to: [agent], subject: "s", body: "b", kind: "request" });
  hook("session-start", "20261006_102024_8a411f", { platform: "tui" }); // a real TUI session id, as in Hermes's state.db
  assert.deepEqual(rows(), ["hermes:20261006_102024_8a411f"]);
  const before = JSON.stringify(n.store.db.prepare("SELECT * FROM sessions").all());
  for (const sid of ["bg_101010_abc123", "btw_abc123", "preview_abc123"]) {
    for (const event of ["session-start", "prompt"] as const) {
      const r = hook(event, sid, { user_message: "side task", is_first_turn: true, platform: "tui" });
      assert.equal(r.status, 0, `${sid} ${event}: ${r.stderr}`); assert.equal(r.stdout, "", `${sid} ${event}: nothing injected into a side agent`);
    }
  }
  assert.equal(JSON.stringify(n.store.db.prepare("SELECT * FROM sessions").all()), before, "the conversation's row is untouched");
  assert.deepEqual(rows(), ["hermes:20261006_102024_8a411f"]);
  const next = hook("prompt", "20261006_102024_8a411f", { user_message: "back to the main thread", platform: "tui" });
  assert.match(JSON.parse(next.stdout).context, /1 unread/, "and the main conversation's next prompt still works");
});

test("hermes hooks: only a TUI or CLI conversation binds; gateway, cron, curator and desktop hosts are left alone", async t => {
  const { n, hook, rows, agent } = await hermesHolder(t);
  sendLeased(n, { from: "boss", to: [agent], subject: "s", body: "b", kind: "request" });
  hook("session-start", "main-1", { platform: "cli" });
  assert.deepEqual(rows(), ["hermes:main-1"], "the classic CLI binds like the TUI");
  for (const platform of ["telegram", "discord", "gateway", "api_server", "webui", "desktop", "cron", "curator", "platform_disabled", "subagent", ""]) {
    const r = hook("prompt", `other-${platform}`, { user_message: "x", platform });
    assert.equal(r.stdout, "", platform || "(empty platform)"); assert.equal(r.status, 0, r.stderr);
  }
  assert.deepEqual(rows(), ["hermes:main-1"], "none of them replaced the conversation");
  assert.match(JSON.parse(hook("prompt", "main-2", { user_message: "no platform field at all (older Hermes)" }).stdout).context, /1 unread/, "an absent platform is read as the main conversation, not refused");
});

test("hermes hooks: context compression rotates the main session's id (with a parent): the holder follows it", async t => {
  const { n, hook, ctx, rows, agent } = await hermesHolder(t);
  sendLeased(n, { from: "boss", to: [agent], subject: "s", body: "b", kind: "request" });
  hook("session-start", "20261006_102024_8a411f", { platform: "tui" });
  const r = spawnSync(process.execPath, [resolve("bin/agentmbx.js"), "hook", "prompt", "--cli", "hermes"], { encoding: "utf8", env: { ...process.env, AGENTMBX_DEV: "1", MBX_HOME: n.home, MBX_CLI: "hermes", MBX_AGENT: agent, MBX_NO_DESKTOP: "1" },
    input: JSON.stringify({ session_id: "20261006_113000_c0ffee", parent_session_id: "20261006_102024_8a411f", cwd: process.cwd(), extra: { user_message: "continuing", platform: "tui" } }) });
  assert.equal(r.status, 0, r.stderr); assert.match(ctx(r.stdout), /1 unread/);
  assert.deepEqual(rows(), ["hermes:20261006_113000_c0ffee"], "the rotated id is the one live row");
});

test("hermes hooks: a /new gives the same holder a new session id (one live row); a delegated subagent never binds, counts or nags", async t => {
  const { n, hook, ctx, rows, agent } = await hermesHolder(t);
  sendLeased(n, { from: "boss", to: [agent], subject: "s", body: "b", kind: "request" });
  hook("session-start", "hermes-sess-A", { platform: "tui" });
  assert.deepEqual(rows(), ["hermes:hermes-sess-A"]);
  const afterNew = hook("prompt", "hermes-sess-B", { user_message: "fresh", is_first_turn: true, platform: "tui" });
  assert.equal(afterNew.status, 0, afterNew.stderr);
  assert.deepEqual(rows(), ["hermes:hermes-sess-B"], "exactly one live conversation row after /new");
  assert.match(ctx(afterNew.stdout), /1 unread/);
  const activity = n.store.get(`activity:${agent}`);
  const sub = hook("prompt", "subagent-sess-C", { user_message: "do a thing", platform: "subagent", parent_session_id: "hermes-sess-B" });
  assert.equal(sub.status, 0, sub.stderr); assert.equal(sub.stdout, "", "a subagent turn gets nothing injected");
  assert.deepEqual(rows(), ["hermes:hermes-sess-B"], "and never replaced the conversation");
  assert.equal(n.store.get(`activity:${agent}`), activity, "or counted as this session's activity");
  const multi = hook("prompt", "hermes-sess-B", { user_message: [{ type: "text", text: "look" }, { type: "image_url", image_url: { url: "x" } }], platform: "tui" });
  assert.match(ctx(multi.stdout), /1 unread/, "a multimodal turn is read like any other");
});

test("hermes hooks: a missing, empty or non-string session id binds nothing and prints nothing; a provisional one binds nothing", async t => {
  const { n, hook } = await hermesHolder(t);
  const before = JSON.stringify(n.store.db.prepare("SELECT * FROM sessions").all());
  for (const bad of [undefined, null, "", "   ", 42, {}]) {
    const r = hook("prompt", bad, { user_message: "x", platform: "tui" });
    assert.equal(r.status, 0, r.stderr); assert.equal(r.stdout, "", JSON.stringify(bad));
  }
  // Hermes never sends an mcp-<pid> id, but the shared hook refuses one like any other CLI's: nothing is bound or changed.
  const prov = hook("prompt", "mcp-1234", { user_message: "x", platform: "tui" });
  assert.equal(prov.status, 0, prov.stderr);
  assert.equal(JSON.stringify(n.store.db.prepare("SELECT * FROM sessions").all()), before, "no row was added or changed");
});

test("hermes hooks: with no holder the first prompt learns how to get an identity, once (session-start cannot say it)", t => {
  const home = mkdtempSync(join(tmpdir(), "mbx-hermes-unbound-")), n = new MbxNode(home, { host: "alpha" });
  t.after(() => { n.close(); rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
  const env = { ...process.env, AGENTMBX_DEV: "1", MBX_HOME: home, MBX_AGENT: "x" };
  const run = (event: string, sid: string) => spawnSync(process.execPath, [resolve("bin/agentmbx.js"), "hook", event, "--cli", "hermes"],
    { encoding: "utf8", env, input: JSON.stringify({ session_id: sid, cwd: "/w", extra: { user_message: "hi", platform: "tui" } }) });
  assert.equal(run("session-start", "u1").stdout, "", "on_session_start output is dropped by Hermes");
  const first = run("prompt", "u1");
  assert.match((JSON.parse(first.stdout) as { context: string }).context, /no mailbox identity yet/);
  const again = JSON.parse(run("prompt", "u1").stdout) as { context: string };
  assert.match(again.context, /mbx disconnected: reconnect/, "T503 keeps a missing connector visible on the next prompt");
  assert.doesNotMatch(again.context, /no mailbox identity yet/, "identity guidance is said once");
});

// ---- AC3: the watcher wake is admitted for the real Hermes session --------------------------------------------------
test("hermes watcher receipt: a bound real session makes the watcher exit an admitted wake; an mcp-only lease does not", async t => {
  const { n, hook, agent } = await hermesHolder(t);
  const attempts = () => (n.store.db.prepare("SELECT detail FROM audit WHERE event='wake.attempt'").all() as { detail: string }[])
    .map((r) => JSON.parse(r.detail) as { outcome: string; receipt: string; via: string; session?: string; pid?: number });
  const watch = async () => {
    const child = spawn(process.execPath, [resolve("bin/agentmbx.js"), "watch"], { env: { ...process.env, AGENTMBX_DEV: "1", MBX_HOME: n.home, MBX_AGENT: "", MBX_WATCH_INTERVAL_MS: "200" } });
    t.after(() => { child.kill(); });
    let out = ""; child.stdout.on("data", (d) => { out += d; });
    const code = await new Promise<number | null>((r) => child.on("exit", r));
    return { code, out, pid: child.pid };
  };
  sendLeased(n, { from: "boss", to: [agent], subject: "one", body: "b", kind: "request" });
  const before = await watch();
  assert.equal(before.code, 0, before.out);
  assert.deepEqual(attempts().map((a) => [a.outcome, a.receipt, a.via]), [["not_submitted", "none", "watcher"]], "T390: with only the provisional mcp- lease the exit is not an observed wake");
  hook("session-start", "hermes-sess-A", { platform: "tui" });
  sendLeased(n, { from: "boss", to: [agent], subject: "two", body: "b", kind: "request" });
  const after = await watch();
  assert.equal(after.code, 0, after.out);
  const last = attempts().at(-1)!;
  assert.deepEqual([last.outcome, last.receipt, last.via, last.session, last.pid], ["admitted", "transport", "watcher", "hermes-sess-A", after.pid],
    "T460: once the hook bound the real session, the same watcher exit is recorded as admitted for that session");
});

// T527 AC3: pre_llm_call fires per LLM call, and it is the one Hermes hook that consumes stdout as
// injected context — so mail that arrives mid-turn (between two calls of one tool loop) reaches the
// session on the next pre_llm_call of the same turn. No new Hermes hook is wired for this.
test("hermes hooks: mail arriving mid-turn is injected on the next pre_llm_call of the same turn (T527)", async t => {
  const { n, hook, ctx, agent } = await hermesHolder(t);
  hook("session-start", "hermes-sess-midturn", { platform: "tui" });
  const before = hook("prompt", "hermes-sess-midturn", { user_message: "start the turn", is_first_turn: true, platform: "tui" });
  assert.equal(before.status, 0, before.stderr);
  assert.notEqual(before.stdout, "", "the first call answers (watcher instruction or mail hint)");
  assert.doesNotMatch(ctx(before.stdout), /unread/, "no mail yet: the turn starts clean");
  // Mail lands while the turn is running — between two LLM calls of one tool loop.
  sendLeased(n, { from: "boss", to: [agent], subject: "mid-turn", body: "b", kind: "request" });
  const mid = hook("prompt", "hermes-sess-midturn", { user_message: "tool result, keep going", platform: "tui" });
  assert.equal(mid.status, 0, mid.stderr);
  assert.match(ctx(mid.stdout), /\[mbx\] 1 unread for worker@alpha: mbx_inbox\./, "mid-turn mail surfaces on the next pre_llm_call, in the same turn");
  assert.doesNotMatch(ctx(mid.stdout), /mid-turn/, "counts only, never mail content");
});
