// T661: doctor names every live connector that is behind the installed build (any harness), and a live OpenCode session is
// told once per (connector version, installed version) pair how it switches, appended to the next real wake it gets.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MbxNode } from "../src/node.ts";
import {
  compareVersions, connectorSkewChecks, liveConnectors, markSkewNoted, opencodePluginStep, pluginSkewNoteKey, skewNoteKey, skewNoteText, skewSeams, wakeSkewNote, type OpencodePluginState,
} from "../src/connector-skew.ts";
import { completeOpencodeWake, resetOpencodeWakeQueue, waitForOpencodeWake } from "../src/opencode-wake-queue.ts";
import { opencodeHostSeams } from "../src/opencode-provider.ts";
import { dispatchWakes } from "../src/wake.ts";
import { inspectLeaseProcess } from "../src/identity-leases.ts";
import { ulid } from "../src/crypto.ts";
import { version } from "../src/version.ts";
import { sendLeased } from "./helpers/leased-send.ts";
import { bindWakeLease } from "./helpers/wake-lease.ts";

const START = "ps-utc:Thu Oct 15 13:55:50 2026";
const CURRENT_PLUGIN: OpencodePluginState = { headerVersion: "0.5.38", mtimeMs: Date.UTC(2026, 9, 15, 13, 0, 0), templateCurrent: true };

function fixture(t: { after: (fn: () => void) => unknown }) {
  const home = mkdtempSync(join(tmpdir(), "mbx-t661-")), n = new MbxNode(home, { host: "alpha" });
  t.after(() => { n.close(); resetOpencodeWakeQueue(); rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
  const alive = new Set<number>();
  /** A connector self-report from `pid`, optionally holding `agent` for (cli, session). */
  const connector = (pid: number, ver: unknown, hold?: { agent: string; cli: string; session: string; servePid?: number; serveStart?: string }) => {
    alive.add(pid);
    n.store.set(`connector:${pid}`, JSON.stringify({ v: 1, pid, start: START, version: ver, build: `${ver}:x`, tools: [], cli: hold?.cli ?? "claude", at: new Date().toISOString() }));
    if (!hold) return;
    n.registerAgent(hold.agent);
    n.store.db.prepare(`INSERT INTO identity_leases (name,token,holder_pid,holder_start,key_fp,cli,session_id,claimed_at,heartbeat_at,idle_ttl,released_at,release_reason)
      VALUES (?,?,?,?,?,?,?,?,?,?,NULL,NULL)`).run(hold.agent, "tok", pid, START, "fp", hold.cli, hold.session, Date.now(), Date.now(), 3_600_000);
    if (hold.servePid) n.store.db.prepare("INSERT INTO sessions (agent,cli,session_id,pid,pid_start,updated_at) VALUES (?,?,?,?,?,?)")
      .run(hold.agent, hold.cli, hold.session, hold.servePid, hold.serveStart ?? "Thu Oct 15 14:00:00 2026", new Date().toISOString());
  };
  const inspect = (pids: number[]) => new Map(pids.map(p => [p, alive.has(p) ? { alive: true, start: START } : { alive: false, start: null }]));
  return { n, connector, inspect, alive };
}

test("T661: compareVersions orders releases and refuses what it cannot compare", () => {
  assert.equal(compareVersions("0.5.36", "0.5.38"), -1);
  assert.equal(compareVersions("0.5.38", "0.5.38"), 0);
  assert.equal(compareVersions("0.6.0", "0.5.38"), 1);
  assert.equal(compareVersions("0.5.9", "0.5.10"), -1, "numeric, not lexical");
  assert.equal(compareVersions("0.5.38-rc.1", "0.5.38"), -1, "a prerelease is behind its release");
  assert.equal(compareVersions("0.5.38", "0.5.38-rc.1"), 1, "a release is ahead of its prerelease");
  assert.equal(compareVersions(null, "0.5.38"), null);
  assert.equal(compareVersions("dev", "0.5.38"), null);
});

test("T661: doctor warns per live connector behind the installed build, naming the session and both versions", (t) => {
  const { n, connector, inspect } = fixture(t);
  connector(501, "0.5.36", { agent: "axiom-dev", cli: "opencode", session: "ses_old" });
  connector(502, "0.5.38", { agent: "agentmbx-lead", cli: "claude", session: "16df9abc" });
  connector(503, "0.5.34", { agent: "agentmbx-grok", cli: "grok", session: "01a13139" });
  connector(504, "0.5.35"); // unbound connector: still a running old build
  const checks = connectorSkewChecks(n, { installed: "0.5.38", inspect, plugin: CURRENT_PLUGIN });
  const warns = checks.filter(c => c.level === "warn").map(c => c.label);
  assert.deepEqual(warns.sort(), [
    "connectors: 1 unbound connector(s) behind 0.5.38: claude pid 504 on 0.5.35",
    "grok: session 01a13139 (agentmbx-grok) runs connector 0.5.34; installed 0.5.38",
    "opencode: session ses_old (axiom-dev) runs connector 0.5.36; installed 0.5.38",
  ]);
  for (const c of checks.filter(c => c.level === "warn" && !c.label.startsWith("connectors:"))) assert.match(c.fix!, /next mbx tool call switches it to the installed build in place/);
  assert.equal(checks.some(c => c.label.includes("agentmbx-lead")), false, "an equal version is not reported");
});

test("T661: equal versions give one ok row; unknown versions are never called behind; dead or reused pids do not count", (t) => {
  const { n, connector, inspect, alive } = fixture(t);
  connector(601, "0.5.38", { agent: "agent-a", cli: "codex", session: "s1" });
  connector(602, "0.5.38");
  assert.deepEqual(connectorSkewChecks(n, { installed: "0.5.38", inspect, plugin: CURRENT_PLUGIN }).map(c => [c.level, c.label]),
    [["ok", "connectors: 2 live connector(s), none behind 0.5.38"]]);
  connector(603, "weird-build");
  connector(604, 7);
  const mixed = connectorSkewChecks(n, { installed: "0.5.38", inspect, plugin: CURRENT_PLUGIN });
  assert.equal(mixed.filter(c => c.level === "warn").length, 0, "unknown is not behind");
  assert.ok(mixed.some(c => c.level === "info" && /2 live connector\(s\) report no comparable version \(pid 603, 604\)/.test(c.label)));
  connector(605, "0.5.30");
  alive.delete(605); // the process is gone; its report is not a running build
  assert.equal(liveConnectors(n, { installed: "0.5.38", inspect }).some(c => c.pid === 605), false);
  const reused = (pids: number[]) => new Map(pids.map(p => [p, { alive: true, start: "ps-utc:Fri Oct 16 01:00:00 2026" }]));
  assert.deepEqual(liveConnectors(n, { installed: "0.5.38", inspect: reused }), [], "a reused pid (different birth) is not that connector");
  assert.deepEqual(connectorSkewChecks(n, { installed: "0.5.38", inspect: () => new Map(), plugin: CURRENT_PLUGIN }), [], "no live connector: no row");
});

test("T661: the fix names the plugin step: setup when the template is stale, reopen when the tab loaded an older file", (t) => {
  const { n, connector, inspect } = fixture(t);
  connector(701, "0.5.36", { agent: "axiom-dev", cli: "opencode", session: "ses_tab", servePid: 9001, serveStart: "Thu Oct 15 12:00:00 2026" });
  const stale: OpencodePluginState = { headerVersion: "0.5.36", mtimeMs: Date.UTC(2026, 9, 15, 10, 0, 0), templateCurrent: false };
  const fixFor = (plugin: OpencodePluginState) => connectorSkewChecks(n, { installed: "0.5.38", inspect, plugin }).find(c => c.level === "warn")!.fix!;
  assert.match(fixFor(stale), /for its OpenCode plugin, run `agentmbx setup --only opencode`, then reopen the tab$/);
  // the serve started (local lstart, 12:00) before the current file was written
  const newerFile: OpencodePluginState = { headerVersion: "0.5.38", mtimeMs: new Date(2026, 9, 15, 12, 30, 0).getTime(), templateCurrent: true };
  assert.match(fixFor(newerFile), /for its OpenCode plugin, reopen the tab to load the plugin file written since it started$/);
  const olderFile: OpencodePluginState = { headerVersion: "0.5.38", mtimeMs: new Date(2026, 9, 15, 11, 0, 0).getTime(), templateCurrent: true };
  assert.doesNotMatch(fixFor(olderFile), /OpenCode plugin/, "the tab already loaded the current file");
  assert.equal(opencodePluginStep(olderFile, null), null, "no recorded serve start: no claim");
});

// ---- the note rides a real wake (dispatchWakes), never a turn of its own ----

const STANDALONE = ["/Users/x/.opencode/bin/opencode", "serve", "--stdio", "--port", "0"];
const SESSION = "ses_skew";

/** A leased standalone OpenCode session for this process, whose connector self-report says `connectorVersion`. */
function wakeable(t: { after: (fn: () => void) => unknown }, connectorVersion: string) {
  const home = mkdtempSync(join(tmpdir(), "mbx-t661w-")), n = new MbxNode(home, { host: "alpha" });
  const realArgs = opencodeHostSeams.args, realPlugin = skewSeams.plugin, prevDesk = process.env.MBX_NO_DESKTOP;
  opencodeHostSeams.args = (pids) => new Map(pids.map(p => [p, STANDALONE]));
  skewSeams.plugin = () => CURRENT_PLUGIN;
  process.env.MBX_NO_DESKTOP = "1";
  t.after(() => { opencodeHostSeams.args = realArgs; skewSeams.plugin = realPlugin;
    if (prevDesk === undefined) delete process.env.MBX_NO_DESKTOP; else process.env.MBX_NO_DESKTOP = prevDesk;
    n.close(); resetOpencodeWakeQueue(); rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
  bindWakeLease(n, { agent: "worker", cli: "opencode", session_id: SESSION, pid: process.pid });
  n.store.set(`connector:${process.pid}`, JSON.stringify({ v: 1, pid: process.pid, start: inspectLeaseProcess(process.pid).start, version: connectorVersion,
    build: "x", tools: [], cli: "opencode", at: new Date().toISOString() }));
  /** One wake through the real poller queue; returns the text the plugin received, or null when no wake was offered. */
  const wakeOnce = async (subject: string | null) => {
    if (subject) sendLeased(n, { from: "sender", to: ["worker"], subject, body: "b", kind: "request" });
    const poll = waitForOpencodeWake(SESSION, process.pid, 400);
    const dispatched = dispatchWakes(n);
    const text = await poll;
    if (text) completeOpencodeWake(SESSION, `msg_${ulid()}`);
    await dispatched;
    return text;
  };
  return { n, wakeOnce };
}

const noted = (n: MbxNode) => n.store.db.prepare("SELECT count(*) c FROM audit WHERE event='connector.skew_noted'").get() as { c: number };

test("T661: the note rides the next admitted wake once, appended to the wake text, and is not repeated", async (t) => {
  const { n, wakeOnce } = wakeable(t, "0.0.1");
  const first = await wakeOnce("first");
  assert.ok(first, "a real wake was offered");
  assert.match(first!, /\[mbx\] 1 new message\(s\) for worker/);
  const line = skewNoteText("0.0.1", version(), null);
  assert.ok(first!.endsWith(`\n${line}`), "the one-line note is appended to that wake");
  assert.match(line, /^\[mbx\] AgentMBX .+ is installed; this session's mbx connector still runs 0\.0\.1\. Your next mbx tool call switches it to .+ in place, with no restart\.$/);
  assert.match(n.store.get(skewNoteKey(SESSION, "0.0.1", version()))!, /"receipt":"msg_/);
  assert.equal(noted(n).c, 1);
  n.store.db.prepare("DELETE FROM wakes").run(); // the per-agent batching window has passed
  const second = await wakeOnce("second");
  assert.ok(second, "the next mail still wakes");
  assert.equal(second!.includes("still runs 0.0.1"), false, "the note is not repeated");
  assert.equal(noted(n).c, 1);
  assert.ok(wakeSkewNote(n, { agent: "worker", cli: "opencode", session_id: SESSION }, { installed: "999.0.0" }), "a newer install is a new pair");
});

test("T661: no mail, no wake: an idle session behind the installed build is never woken for the note", async (t) => {
  const { n, wakeOnce } = wakeable(t, "0.0.1");
  assert.equal(await wakeOnce(null), null, "nothing offered to the poller");
  assert.equal(n.store.db.prepare("SELECT count(*) c FROM audit WHERE event LIKE 'wake%'").get()!.c, 0);
  assert.equal(n.store.get(skewNoteKey(SESSION, "0.0.1", version())), undefined, "and nothing marked");
});

test("T661: a wake that is not admitted does not mark the note; an equal connector gets none", async (t) => {
  const { n } = wakeable(t, "0.0.1");
  sendLeased(n, { from: "sender", to: ["worker"], subject: "nobody polling", body: "b", kind: "request" });
  await dispatchWakes(n); // no poller registered: not submitted
  assert.equal(n.store.get(skewNoteKey(SESSION, "0.0.1", version())), undefined, "only an admitted wake marks it");
  assert.equal(noted(n).c, 0);
  const s = { agent: "worker", cli: "opencode", session_id: SESSION };
  assert.ok(wakeSkewNote(n, s), "behind and unmarked: the next admitted wake would carry it");
  assert.equal(wakeSkewNote(n, { ...s, cli: "claude" }), null, "only OpenCode wakes carry it");
  assert.equal(wakeSkewNote(n, s, { inspect: (pids) => new Map(pids.map(p => [p, { alive: false, start: null }])) }), null, "a dead connector is not that session's build");
  n.store.set(`connector:${process.pid}`, JSON.stringify({ v: 1, pid: process.pid, start: inspectLeaseProcess(process.pid).start, version: version(),
    build: "x", tools: [], cli: "opencode", at: new Date().toISOString() }));
  assert.equal(wakeSkewNote(n, { agent: "worker", cli: "opencode", session_id: SESSION }), null, "an equal connector needs no note");
});

test("T661: the note names the plugin step when the tab's plugin cannot switch in place", (t) => {
  const { n } = wakeable(t, "0.0.1");
  const stale: OpencodePluginState = { headerVersion: "0.0.1", mtimeMs: 1, templateCurrent: false };
  const note = wakeSkewNote(n, { agent: "worker", cli: "opencode", session_id: SESSION }, { plugin: stale });
  assert.match(note!.text, /in place, with no restart\. The OpenCode plugin is not switched that way: run `agentmbx setup --only opencode`, then reopen the tab\.$/);
});

// ---- T669: the plugin module a serve already loaded is stale even when the connector is current ----

/** A plugin file written after the serve started, so that serve is running the previous plugin code. */
const STALE_FILE: OpencodePluginState = { headerVersion: "0.5.38", mtimeMs: Date.now() + 60_000, templateCurrent: true };

test("T669: doctor names a stale plugin module even though no connector is behind", (t) => {
  const { n, connector, inspect } = fixture(t);
  connector(801, "0.5.38", { agent: "axiom-dev", cli: "opencode", session: "ses_tab", servePid: 9002, serveStart: "Thu Oct 15 12:00:00 2026" });
  const newerFile: OpencodePluginState = { headerVersion: "0.5.38", mtimeMs: new Date(2026, 9, 15, 12, 30, 0).getTime(), templateCurrent: true };
  const checks = connectorSkewChecks(n, { installed: "0.5.38", inspect, plugin: newerFile });
  const row = checks.find(c => c.label.includes("older plugin module"));
  assert.ok(row, "the plugin module is named although every connector is current");
  assert.equal(row!.level, "warn");
  assert.match(row!.label, /^opencode: session ses_tab \(axiom-dev\) runs an older plugin module than the installed 0\.5\.38$/);
  assert.match(row!.fix!, /^its mbx connector switches in place and needs no restart; the plugin does not: reopen the tab to load the plugin file written since it started$/);
  assert.ok(checks.some(c => c.level === "ok" && /none behind 0\.5\.38/.test(c.label)), "the connector row still reports the connectors as current");
  const staleTemplate: OpencodePluginState = { headerVersion: "0.5.36", mtimeMs: 1, templateCurrent: false };
  assert.match(connectorSkewChecks(n, { installed: "0.5.38", inspect, plugin: staleTemplate }).find(c => c.label.includes("older plugin module"))!.fix!,
    /the plugin does not: run `agentmbx setup --only opencode`, then reopen the tab$/);
  assert.equal(connectorSkewChecks(n, { installed: "0.5.38", inspect, plugin: CURRENT_PLUGIN }).some(c => c.label.includes("older plugin module")), false,
    "a current plugin file adds no row");
});

test("T669: a behind connector and a stale plugin make one row, not two", (t) => {
  const { n, connector, inspect } = fixture(t);
  connector(802, "0.5.36", { agent: "axiom-dev", cli: "opencode", session: "ses_tab", servePid: 9003, serveStart: "Thu Oct 15 12:00:00 2026" });
  const newerFile: OpencodePluginState = { headerVersion: "0.5.38", mtimeMs: new Date(2026, 9, 15, 12, 30, 0).getTime(), templateCurrent: true };
  const rows = connectorSkewChecks(n, { installed: "0.5.38", inspect, plugin: newerFile }).filter(c => c.label.includes("ses_tab"));
  assert.equal(rows.length, 1, "one row per session");
  assert.match(rows[0]!.fix!, /next mbx tool call switches it to the installed build in place/);
  assert.match(rows[0]!.fix!, /for its OpenCode plugin, reopen the tab to load the plugin file written since it started$/);
});

test("T669: a stale plugin with a current connector gets one note naming the reload step, once per plugin file", (t) => {
  const { n } = wakeable(t, version()); // the connector is current
  const s = { agent: "worker", cli: "opencode", session_id: SESSION, pid_start: "Thu Oct 15 12:00:00 2026" };
  const plugin: OpencodePluginState = { headerVersion: "0.5.38", mtimeMs: new Date(2026, 9, 15, 12, 30, 0).getTime(), templateCurrent: true };
  const note = wakeSkewNote(n, s, { plugin });
  assert.ok(note, "a current connector does not suppress the plugin note");
  assert.equal(note!.connector, null);
  assert.equal(note!.plugin, `0.5.38@${plugin.mtimeMs!}`);
  assert.match(note!.text, new RegExp(`^\\[mbx\\] AgentMBX ${version().replace(/\./g, "\\.")} is installed; this session's OpenCode plugin still runs the code its serve loaded at start\\.`));
  assert.match(note!.text, /The mbx connector switches in place, the plugin does not: reopen the tab to load the plugin file written since it started\.$/);
  markSkewNoted(n, note!, "msg_one");
  assert.equal(wakeSkewNote(n, s, { plugin }), null, "never twice for the same plugin file");
  assert.ok(n.store.get(pluginSkewNoteKey(SESSION, plugin))!.includes("msg_one"));
  assert.ok(wakeSkewNote(n, s, { plugin: { ...plugin, mtimeMs: plugin.mtimeMs! + 1000 } }), "a rewritten plugin file is a new note");
  assert.equal(wakeSkewNote(n, { ...s, pid_start: "Thu Oct 15 12:45:00 2026" }, { plugin }), null, "a serve that started after the file needs nothing");
  assert.equal(wakeSkewNote(n, { ...s, cli: "claude" }, { plugin }), null, "only OpenCode");
});

test("T669: a stale plugin with a current connector rides the next admitted wake, once", async (t) => {
  const { n, wakeOnce } = wakeable(t, version());
  skewSeams.plugin = () => STALE_FILE; // the serve loaded an older file than the one on disk
  const first = await wakeOnce("plugin note");
  assert.ok(first, "a real wake was offered");
  assert.match(first!, /\[mbx\] 1 new message\(s\) for worker/);
  assert.match(first!, /OpenCode plugin still runs the code its serve loaded at start/);
  assert.match(first!.trimEnd(), /reopen the tab to load the plugin file written since it started\.$/);
  assert.match(n.store.get(pluginSkewNoteKey(SESSION, STALE_FILE))!, /"receipt":"msg_/);
  assert.equal(noted(n).c, 1, "one note");
  n.store.db.prepare("DELETE FROM wakes").run();
  const second = await wakeOnce("second");
  assert.ok(second, "the next mail still wakes");
  assert.equal(second!.includes("plugin does not"), false, "the note is not repeated");
  assert.equal(noted(n).c, 1);
});

test("T669: a behind connector and a stale plugin ride one wake as a single note", async (t) => {
  const { n, wakeOnce } = wakeable(t, "0.0.1");
  skewSeams.plugin = () => STALE_FILE;
  const text = await wakeOnce("both stale");
  assert.match(text!, /still runs 0\.0\.1/);
  assert.match(text!, /The OpenCode plugin is not switched that way: reopen the tab to load the plugin file written since it started\.$/);
  assert.match(n.store.get(skewNoteKey(SESSION, "0.0.1", version()))!, /"receipt":"msg_/);
  assert.equal(n.store.get(pluginSkewNoteKey(SESSION, STALE_FILE)), undefined, "the plugin note is not sent as a second note");
  assert.equal(noted(n).c, 1);
});
