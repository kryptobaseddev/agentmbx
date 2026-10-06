// T460: Hermes hooks, watcher wake and receipts. Hermes (TUI/CLI) cannot be pushed a turn from outside; a finished
// `terminal(background=true, notify=true)` process starts one, so `agentmbx watch` is its wake path.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MbxNode, HERMES_NO_PUSH } from "../src/node.ts";
import { HERMES_WATCHER_INSTRUCTION, selfWatchInstruction } from "../src/mcp.ts";
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
