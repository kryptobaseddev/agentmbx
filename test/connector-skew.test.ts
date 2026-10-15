// T661: doctor names every live connector that is behind the installed build (any harness), and a live standalone OpenCode
// session is told once per (connector version, installed version) pair how it switches, through the poller queue.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MbxNode } from "../src/node.ts";
import {
  compareVersions, connectorSkewChecks, liveConnectors, noteConnectorSkew, opencodePluginStep, skewNoteKey, skewNoteText, type OpencodePluginState,
} from "../src/connector-skew.ts";
import { completeOpencodeWake, resetOpencodeWakeQueue, waitForOpencodeWake } from "../src/opencode-wake-queue.ts";

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

test("T661: a live OpenCode session gets one note per (connector, installed) pair through the poller queue", async (t) => {
  const { n, connector, inspect } = fixture(t);
  connector(801, "0.5.36", { agent: "axiom-dev", cli: "opencode", session: "ses_live", servePid: process.pid });
  const deps = { installed: "0.5.38", inspect, plugin: CURRENT_PLUGIN, live: () => true };
  // the plugin's long-poll for this exact (session, serve)
  const poll = waitForOpencodeWake("ses_live", process.pid, 3_000);
  const pass = noteConnectorSkew(n, deps);
  const text = await poll;
  assert.equal(text, skewNoteText("0.5.36", "0.5.38", null));
  assert.match(text!, /^\[mbx\] AgentMBX 0\.5\.38 is installed; this session's mbx connector still runs 0\.5\.36\. Your next mbx tool call switches it to 0\.5\.38 in place, with no restart\.$/);
  assert.equal(completeOpencodeWake("ses_live", "msg_note1"), true);
  assert.deepEqual(await pass, ["ses_live"]);
  assert.match(n.store.get(skewNoteKey("ses_live", "0.5.36", "0.5.38"))!, /"receipt":"msg_note1"/);
  assert.match((n.store.db.prepare("SELECT detail FROM audit WHERE event='connector.skew_noted'").get() as { detail: string }).detail, /"connector":"0.5.36","installed":"0.5.38"/);

  // the same pair is never noted again, even with the poller waiting
  let pushes = 0;
  const counting = { ...deps, push: async () => { pushes++; return { ok: true as const, id: "msg_x", turnSince: null }; } };
  assert.deepEqual(await noteConnectorSkew(n, counting), []);
  assert.equal(pushes, 0);
  // a newer install is a new pair: one more note
  assert.deepEqual(await noteConnectorSkew(n, { ...counting, installed: "0.5.39" }), ["ses_live"]);
  assert.equal(pushes, 1);
  assert.deepEqual(await noteConnectorSkew(n, { ...counting, installed: "0.5.39" }), []);
  assert.equal(pushes, 1);
});

test("T661: no note for an equal or unknown connector, a session that is not polling, or a refused push (retried later)", async (t) => {
  const { n, connector, inspect } = fixture(t);
  connector(901, "0.5.38", { agent: "eq", cli: "opencode", session: "ses_eq", servePid: 9101 });
  connector(902, "dev", { agent: "unk", cli: "opencode", session: "ses_unk", servePid: 9102 });
  connector(903, "0.5.36", { agent: "idle", cli: "opencode", session: "ses_nopoll", servePid: 9103 });
  connector(904, "0.5.36", { agent: "claude-one", cli: "claude", session: "c1" }); // not OpenCode: doctor only
  // even when an OpenCode row with that agent and session id exists, a Claude connector is never noted through OpenCode
  n.store.db.prepare("INSERT INTO sessions (agent,cli,session_id,pid,pid_start,updated_at) VALUES ('claude-one','opencode','c1',9104,NULL,?)").run(new Date().toISOString());
  let pushes = 0;
  const push = async () => { pushes++; return { ok: false as const, handedOff: false }; };
  const base = { installed: "0.5.38", inspect, plugin: CURRENT_PLUGIN, push };
  assert.deepEqual(await noteConnectorSkew(n, { ...base, live: () => false }), []);
  assert.equal(pushes, 0, "equal, unknown and non-OpenCode are skipped; the behind one is not polling");
  assert.deepEqual(await noteConnectorSkew(n, { ...base, live: () => true }), []);
  assert.equal(pushes, 1, "only the behind OpenCode session is offered");
  assert.equal(n.store.get(skewNoteKey("ses_nopoll", "0.5.36", "0.5.38")), undefined, "a refused push frees the claim");
  // a push whose receipt never came back still left: it counts as delivered and is not repeated
  const handed = { ...base, live: () => true, push: async () => { pushes++; return { ok: false as const, handedOff: true }; } };
  assert.deepEqual(await noteConnectorSkew(n, handed), ["ses_nopoll"]);
  assert.deepEqual(await noteConnectorSkew(n, handed), []);
  assert.equal(pushes, 2);
});

test("T661: the note carries the plugin step when the tab's plugin cannot switch in place", async (t) => {
  const { n, connector, inspect } = fixture(t);
  connector(951, "0.5.36", { agent: "tab", cli: "opencode", session: "ses_stale", servePid: 9501 });
  let text = "";
  const push = async (_s: string, _p: number, x: string) => { text = x; return { ok: true as const, id: "msg_s", turnSince: null }; };
  const stale: OpencodePluginState = { headerVersion: "0.5.36", mtimeMs: 1, templateCurrent: false };
  await noteConnectorSkew(n, { installed: "0.5.38", inspect, plugin: stale, live: () => true, push });
  assert.match(text, /in place, with no restart\. The OpenCode plugin is not switched that way: run `agentmbx setup --only opencode`, then reopen the tab\.$/);
});
