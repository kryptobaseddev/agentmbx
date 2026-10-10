// T392: the autonomy probe. Planning and reporting are pure; store I/O sits behind ProbeIO; the
// waiting loop takes the clock and sleep, so pass/no-wake/no-reply all run without real time.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { MbxNode } from "../src/node.ts";
import type { IdentityStatus } from "../src/identity-status.ts";
import {
  PROBE_REPLY_MARKER, PROBE_SUBJECT_PREFIX, buildProbeReport, globMatch, planProbe, probeBody, probeSubject, runProbe,
  storeProbeIO, type ProbeIO, type SentProbe, type TargetObservation,
} from "../src/probe.ts";
import { noteProject } from "../src/registry.ts";
import { bindWakeLease } from "./helpers/wake-lease.ts";

const identity = (name: string, state: IdentityStatus["state"], holder: IdentityStatus["holder"] = null): IdentityStatus =>
  ({ name, state, claimable: false, reason: `${state} fixture`, role: null, description: null, registered: true,
    projects: [], unread: 0, messages: 0, last_activity: null, holder });

test("planProbe addresses every live leased identity and excludes the sender", () => {
  const plan = planProbe([
    identity("idle-agent", "idle", { cli: "kimi", session_id: "s1", pid: 1 }),
    identity("held-agent", "held", { cli: "claude", session_id: "s2", pid: 2 }),
    identity("sender", "held", { cli: "kimi", session_id: "me", pid: 3 }),
    identity("available", "available"),
    identity("unknown", "unknown"),
    identity("conflict", "conflict"),
    identity("legacy", "legacy"),
  ], "sender");
  assert.deepEqual(plan.map((t) => [t.name, t.state]), [["held-agent", "held"], ["idle-agent", "idle"]]);
  assert.deepEqual(plan[0].holder, { cli: "claude", session_id: "s2" });
});

test("the convention contract: subject prefix and the probe ok body", () => {
  assert.ok(probeSubject(new Date("2026-10-05T12:00:00Z")).startsWith(`${PROBE_SUBJECT_PREFIX} autonomy probe 2026-10-05T12:00:00.000Z`));
  const body = probeBody();
  for (const required of [PROBE_SUBJECT_PREFIX, PROBE_REPLY_MARKER, "mbx_reply", "mbx_ack", "wake line",
    'section "Autonomy probes"', "pre-authorised by the owner's installed skill"])
    assert.ok(body.includes(required), `probe body mentions ${required}`);
});

const OBS = (over: Partial<TargetObservation> = {}): TargetObservation =>
  ({ wake: null, readAt: null, ackedAt: null, ackNote: null, reply: null, ...over });

test("buildProbeReport: default gate passes on the reply alone; strict demands an admitted idle wake", () => {
  const plan = planProbe([identity("worker", "held", { cli: "kimi", session_id: "s", pid: 1 })], "owner");
  const sent = new Map([["worker", { id: "m1", thread: "t1", at: 1_000 }]]);
  const base = { plan, sent, startedAt: 1_000, finishedAt: 61_000, deadlineMs: 60_000, host: "alpha", sender: "owner" };
  const admitted = { outcome: "admitted", via: "watcher", receipt: "transport", session: "conv-1", at: 1_500 };
  const inTurn = OBS({ reply: { id: "r1", at: 4_000 }, readAt: 3_500 });

  // Default: the reply is the gate — no wake row at all is a pass on the "in-turn" path.
  const defaultPass = buildProbeReport({ ...base, observations: new Map([["worker", inTurn]]) });
  assert.equal(defaultPass.ok, true);
  assert.equal(defaultPass.targets[0].path, "in-turn");
  assert.equal(defaultPass.targets[0].reason, null);
  assert.equal(defaultPass.require_idle_wake, false);

  // Strict: the same in-turn answer fails with the strict reason.
  const strictFail = buildProbeReport({ ...base, requireIdleWake: true, observations: new Map([["worker", inTurn]]) });
  assert.equal(strictFail.ok, false);
  assert.equal(strictFail.require_idle_wake, true);
  assert.equal(strictFail.targets[0].path, "in-turn");
  assert.match(strictFail.targets[0].reason!, /in-turn answer without an admitted idle wake .*--require-idle-wake requires one/);

  // Strict with an admitted wake + reply passes on the "idle-wake" path.
  const strictPass = buildProbeReport({ ...base, requireIdleWake: true,
    observations: new Map([["worker", OBS({ wake: admitted, reply: { id: "r1", at: 4_000 }, readAt: 2_000, ackedAt: 3_000 })]]) });
  assert.equal(strictPass.ok, true);
  assert.equal(strictPass.targets[0].path, "idle-wake");

  // A wake attempted but not admitted, with no reply, reports the outcome and via either way.
  for (const requireIdleWake of [false, true]) {
    const r = buildProbeReport({ ...base, requireIdleWake,
      observations: new Map([["worker", OBS({ wake: { outcome: "not_submitted", via: "kimi web", receipt: null, session: null, at: 2_000 } })]]) });
    assert.match(r.targets[0].reason!, /never admitted \(last outcome: not_submitted via kimi web\)/);
  }
});

test("requireIdleWake: a watcher admit counts only with the session that observes the exit", () => {
  const plan = planProbe([identity("worker", "held", { cli: "kimi", session_id: "s", pid: 1 })], "owner");
  const sent = new Map([["worker", { id: "m1", thread: "t1", at: 1_000 }]]);
  const base = { plan, sent, startedAt: 1_000, finishedAt: 61_000, deadlineMs: 60_000, host: "alpha", sender: "owner" };
  const reply = { id: "r1", at: 4_000 };
  const printed = OBS({ wake: { outcome: "admitted", via: "watcher", receipt: "transport", session: null, at: 1_500 }, reply, readAt: 2_000 });
  const leased = OBS({ wake: { outcome: "admitted", via: "watcher", receipt: "transport", session: "mcp-40673", at: 1_500 }, reply, readAt: 2_000 });
  const observed = OBS({ wake: { outcome: "admitted", via: "watcher", receipt: "transport", session: "conv-1", at: 1_500 }, reply, readAt: 2_000 });

  const strictPrinted = buildProbeReport({ ...base, requireIdleWake: true, observations: new Map([["worker", printed]]) });
  assert.equal(strictPrinted.ok, false);
  assert.equal(strictPrinted.targets[0].path, "in-turn");
  assert.match(strictPrinted.targets[0].reason!, /--require-idle-wake requires one/);

  const strictLeased = buildProbeReport({ ...base, requireIdleWake: true, observations: new Map([["worker", leased]]) });
  assert.equal(strictLeased.ok, false);
  assert.equal(strictLeased.targets[0].path, "in-turn");

  const strictObserved = buildProbeReport({ ...base, requireIdleWake: true, observations: new Map([["worker", observed]]) });
  assert.equal(strictObserved.ok, true);
  assert.equal(strictObserved.targets[0].path, "idle-wake");

  const defaultPrinted = buildProbeReport({ ...base, observations: new Map([["worker", printed]]) });
  assert.equal(defaultPrinted.ok, true);
  assert.equal(defaultPrinted.targets[0].path, "in-turn");
});

test("buildProbeReport: pass needs an admitted wake and a reply; reasons name the failure", () => {
  const plan = planProbe([identity("worker", "held", { cli: "kimi", session_id: "s", pid: 1 })], "owner");
  const sent = new Map([["worker", { id: "m1", thread: "t1", at: 1_000 }]]);
  const base = { plan, sent, startedAt: 1_000, finishedAt: 61_000, deadlineMs: 60_000, host: "alpha", sender: "owner" };
  const admitted = { outcome: "admitted", via: "watcher", receipt: "transport", session: "conv-1", at: 1_500 };

  const pass = buildProbeReport({ ...base, observations: new Map([["worker", OBS({ wake: admitted, readAt: 2_000, ackedAt: 3_000, ackNote: "done", reply: { id: "r1", at: 4_000 } })]]) });
  assert.equal(pass.ok, true);
  const t = pass.targets[0];
  assert.equal(t.path, "idle-wake");
  assert.equal(t.wake!.latency_ms, 500);
  assert.equal(t.read!.latency_ms, 1_000);
  assert.equal(t.ack!.note, "done");
  assert.equal(t.reply!.latency_ms, 3_000);
  assert.equal(t.reason, null);
  assert.deepEqual(pass.summary, { total: 1, passed: 1, failed: 0 });

  const noWakeNoReply = buildProbeReport({ ...base, observations: new Map([["worker", OBS()]]) });
  assert.equal(noWakeNoReply.ok, false);
  assert.match(noWakeNoReply.targets[0].reason!, /no wake\.attempt for worker within 60s/);
  const notAdmitted = buildProbeReport({ ...base, observations: new Map([["worker", OBS({ wake: { outcome: "not_submitted", via: "kimi web", receipt: null, session: null, at: 2_000 }, reply: { id: "r", at: 3_000 } })]]) });
  assert.equal(notAdmitted.ok, true, "a reply rescues a non-admitted wake on the default gate");
  assert.equal(notAdmitted.targets[0].path, "in-turn");
  const noReply = buildProbeReport({ ...base, observations: new Map([["worker", OBS({ wake: admitted, readAt: 2_000 })]]) });
  assert.match(noReply.targets[0].reason!, /worker woke but did not reply/);
  const sendError = buildProbeReport({ ...base, sendErrors: new Map([["worker", "mailbox is closed"]]), observations: new Map([["worker", OBS()]]) });
  assert.match(sendError.targets[0].reason!, /could not be sent: mailbox is closed/);
});

/** A scripted fake IO: observations per target by poll round, counting polls and sleeps. */
function fakeIO(targets: IdentityStatus[], script: Record<string, TargetObservation[]>): ProbeIO & { polls: Map<string, number>; sends: string[] } {
  const polls = new Map<string, number>();
  const sends: string[] = [];
  return {
    polls, sends,
    host: () => "alpha",
    listTargets: () => targets,
    send: (name) => { sends.push(name); return { id: `msg-${name}`, thread: `thread-${name}`, at: 0 }; },
    observe: (name) => {
      const round = polls.get(name) ?? 0;
      polls.set(name, round + 1);
      return script[name]?.[Math.min(round, script[name]!.length - 1)] ?? OBS();
    },
  };
}

const noSleep = () => Promise.resolve();

test("runProbe passes when every target wakes, reads and replies, and stops polling early", async () => {
  const done = OBS({ wake: { outcome: "admitted", via: "watcher", receipt: "transport", session: "conv-1", at: 100 },
    readAt: 200, ackedAt: 300, reply: { id: "r1", at: 400 } });
  const io = fakeIO([identity("a", "held", { cli: "kimi", session_id: "s", pid: 1 }), identity("b", "held", { cli: "claude", session_id: "s", pid: 1 })],
    { a: [OBS(), done], b: [done] });
  let clock = 0;
  const report = await runProbe(io, { sender: "owner", deadlineMs: 60_000, now: () => clock, sleep: async () => { clock += 1_000; }, pollMs: 1_000 });
  assert.equal(report.ok, true);
  assert.deepEqual(io.sends.sort(), ["a", "b"]);
  assert.equal(io.polls.get("b"), 1, "b completed on the first poll: no further polls for it after the loop breaks");
  assert.equal(io.polls.get("a"), 2);
  assert.equal(report.reason, null);
});

test("runProbe: no-wake and no-reply fail with reasons, waiting out the deadline", async () => {
  const noWakeIO = fakeIO([identity("ghost", "held", { cli: "kimi", session_id: "s", pid: 1 })], { ghost: [OBS()] });
  let clock = 0;
  let sleeps = 0;
  const noWake = await runProbe(noWakeIO, { sender: "owner", deadlineMs: 5_000, now: () => clock,
    sleep: async () => { sleeps += 1; clock += 1_000; }, pollMs: 1_000 });
  assert.equal(noWake.ok, false);
  assert.match(noWake.reason!, /no wake\.attempt for ghost/);
  assert.equal(sleeps, 5, "the loop slept until the deadline (5 x 1s polls)");

  const noReplyIO = fakeIO([identity("quiet", "held", { cli: "kimi", session_id: "s", pid: 1 })],
    { quiet: [OBS({ wake: { outcome: "admitted", via: "watcher", receipt: "transport", session: "conv-1", at: 100 }, readAt: 200 })] });
  clock = 0;
  const noReply = await runProbe(noReplyIO, { sender: "owner", deadlineMs: 3_000, now: () => clock, sleep: async () => { clock += 1_000; }, pollMs: 1_000 });
  assert.equal(noReply.ok, false);
  assert.match(noReply.reason!, /quiet woke but did not reply/);
});

test("runProbe with no live targets fails with a clear reason and sends nothing", async () => {
  const io = fakeIO([identity("sender", "held", { cli: "kimi", session_id: "me", pid: 1 }), identity("free", "available")], {});
  const report = await runProbe(io, { sender: "sender", deadlineMs: 1_000, now: () => 0, sleep: noSleep });
  assert.equal(report.ok, false);
  assert.match(report.reason!, /no live leased identities to probe/);
  assert.deepEqual(io.sends, []);
});

// ---- the real store-backed IO -----------------------------------------------------------------------

test("storeProbeIO against a real store: admitted wake + read + reply + ack passes with latencies", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "mbx-probe-pass-"));
  const n = new MbxNode(home, { host: "alpha" });
  t.after(() => { n.close(); rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
  bindWakeLease(n, { agent: "worker", cli: "kimi", session_id: "term-1", pid: process.pid });
  bindWakeLease(n, { agent: "probe-runner", cli: "claude", session_id: "runner-1", pid: process.pid });

  const base = storeProbeIO(n, { sender: "probe-runner" });
  let probe: SentProbe = { id: "", thread: "", at: 0 };
  const io: ProbeIO = { ...base, send: (name) => { probe = base.send(name); return probe; } };
  let clock = Date.now();
  let step = 0;
  const report = await runProbe(io, {
    sender: "probe-runner", deadlineMs: 60_000, now: () => clock, pollMs: 1_000,
    sleep: async () => {
      clock += 1_000;
      step += 1;
      if (step === 1) {
        n.store.audit("wake.attempt", { agent: "worker", outcome: "admitted", receipt: "transport", via: "watcher", session: "term-1" });
      } else if (step === 2) {
        // one autonomous wake turn: read, reply in the thread, then ack
        n.setDelivery(probe.id, "worker", "read");
        n.send({ from: "worker", to: ["probe-runner"], subject: `Re: ${PROBE_SUBJECT_PREFIX} autonomy probe`, body: `${PROBE_REPLY_MARKER} [mbx] 1 new message(s) for worker`, thread: probe.thread, reply_to: probe.id });
        n.ack(probe.id, "worker");
      }
    },
  });
  const target = report.targets.find((x) => x.name === "worker")!;
  assert.equal(report.ok, true, JSON.stringify(report.targets));
  assert.equal(target.message_id, probe.id);
  assert.equal(target.wake!.outcome, "admitted");
  assert.equal(target.wake!.via, "watcher");
  assert.equal(target.wake!.session, "term-1");
  assert.equal(target.path, "idle-wake");
  assert.equal(target.read!.latency_ms! >= 0, true);
  assert.match(target.reply!.id, /^[0-9A-Z]/);
  assert.equal(target.ack !== null, true);
});

test("storeProbeIO: an in-turn answer (reply, no wake row) passes by default and fails under --require-idle-wake", async (t) => {
  // The agent is mid-turn when the probe lands: its in-turn hook surfaces the mail, the
  // dispatcher logs no wake.attempt, and the agent answers with no human input.
  const world = () => {
    const home = mkdtempSync(join(tmpdir(), "mbx-probe-inturn-"));
    const n = new MbxNode(home, { host: "alpha" });
    bindWakeLease(n, { agent: "worker", cli: "kimi", session_id: "term-1", pid: process.pid });
    bindWakeLease(n, { agent: "probe-runner", cli: "claude", session_id: "runner-1", pid: process.pid });
    const base = storeProbeIO(n, { sender: "probe-runner" });
    let probe: SentProbe = { id: "", thread: "", at: 0 };
    const io: ProbeIO = { ...base, send: (name) => { probe = base.send(name); return probe; } };
    return { n, home, io, probe: () => probe };
  };
  const drive = (n: MbxNode, probe: SentProbe) => {
    n.send({ from: "worker", to: ["probe-runner"], subject: `Re: ${PROBE_SUBJECT_PREFIX} x`, body: `${PROBE_REPLY_MARKER} (no wake line) — saw the mail mid-turn`, thread: probe.thread, reply_to: probe.id });
  };

  const defaultWorld = world();
  t.after(() => { defaultWorld.n.close(); rmSync(defaultWorld.home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
  let clock = Date.now();
  let step = 0;
  const passed = await runProbe(defaultWorld.io, { sender: "probe-runner", deadlineMs: 10_000, now: () => clock, pollMs: 1_000,
    sleep: async () => { clock += 1_000; step += 1; if (step === 1) drive(defaultWorld.n, defaultWorld.probe()); } });
  const passTarget = passed.targets.find((x) => x.name === "worker")!;
  assert.equal(passed.ok, true, JSON.stringify(passed.targets));
  assert.equal(passTarget.path, "in-turn");
  assert.equal(passTarget.wake, null, "no wake row was logged");
  assert.equal(passTarget.reply !== null, true);

  const strictWorld = world();
  t.after(() => { strictWorld.n.close(); rmSync(strictWorld.home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
  clock = Date.now();
  step = 0;
  const failed = await runProbe(strictWorld.io, { sender: "probe-runner", deadlineMs: 10_000, requireIdleWake: true, now: () => clock, pollMs: 1_000,
    sleep: async () => { clock += 1_000; step += 1; if (step === 1) drive(strictWorld.n, strictWorld.probe()); } });
  const failTarget = failed.targets.find((x) => x.name === "worker")!;
  assert.equal(failed.ok, false);
  assert.equal(failed.require_idle_wake, true);
  assert.equal(failTarget.path, "in-turn");
  assert.match(failTarget.reason!, /--require-idle-wake requires one/);
});

test("storeProbeIO: admitted wake without a reply is a no-reply failure", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "mbx-probe-noreply-"));
  const n = new MbxNode(home, { host: "alpha" });
  t.after(() => { n.close(); rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
  bindWakeLease(n, { agent: "worker", cli: "kimi", session_id: "term-1", pid: process.pid });
  bindWakeLease(n, { agent: "probe-runner", cli: "claude", session_id: "runner-1", pid: process.pid });

  const base = storeProbeIO(n, { sender: "probe-runner" });
  let probe: SentProbe = { id: "", thread: "", at: 0 };
  const io: ProbeIO = { ...base, send: (name) => { probe = base.send(name); return probe; } };
  let clock = Date.now();
  let step = 0;
  const report = await runProbe(io, {
    sender: "probe-runner", deadlineMs: 10_000, now: () => clock, pollMs: 1_000,
    sleep: async () => {
      clock += 1_000;
      step += 1;
      if (step === 1) {
        n.store.audit("wake.attempt", { agent: "worker", outcome: "admitted", receipt: "strong", native: "native-1" });
        n.setDelivery(probe.id, "worker", "read");
      }
    },
  });
  const target = report.targets.find((x) => x.name === "worker")!;
  assert.equal(report.ok, false);
  assert.match(target.reason!, /woke but did not reply/);
  assert.equal(target.wake!.outcome, "admitted");
});

test("storeProbeIO fences each send inside the sender's held lease (sender_verification leased)", (t) => {
  const home = mkdtempSync(join(tmpdir(), "mbx-probe-fence-"));
  const n = new MbxNode(home, { host: "alpha" });
  t.after(() => { n.close(); rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
  bindWakeLease(n, { agent: "runner", cli: "claude", session_id: "r1", pid: process.pid });
  const io = storeProbeIO(n, { sender: "runner" });
  const sent = io.send("worker");
  const envelope = JSON.parse((n.store.db.prepare("SELECT envelope FROM messages WHERE id=?").get(sent.id) as { envelope: string }).envelope) as { meta: { sender_verification?: string } };
  assert.equal(envelope.meta.sender_verification, "leased", "the probe send carries the lease fence, not a raw node.send");
});

test("storeProbeIO refuses to send when the sender's lease is gone after planning; nothing is stored", (t) => {
  const home = mkdtempSync(join(tmpdir(), "mbx-probe-released-"));
  const n = new MbxNode(home, { host: "alpha" });
  t.after(() => { n.close(); rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
  const { release } = bindWakeLease(n, { agent: "runner", cli: "claude", session_id: "r1", pid: process.pid });
  release(); // the lease is gone between sender resolution and the send
  const io = storeProbeIO(n, { sender: "runner" });
  assert.throws(() => io.send("worker"), /sender runner no longer holds its lease/);
  const count = (n.store.db.prepare("SELECT COUNT(*) c FROM messages").get() as { c: number }).c;
  assert.equal(count, 0, "no unfenced message may be stored");
});

// ---- the CLI dispatch ---------------------------------------------------------------------------------

/** The spawn env: no MBX_AGENT (an explicit identity is a test choice), throwaway home. */
const cliEnv = (home: string) => {
  const env = { ...process.env, AGENTMBX_DEV: "1", MBX_HOME: home, MBX_NO_DESKTOP: "1" } as Record<string, string>;
  delete env.MBX_AGENT;
  return env;
};
const probeCli = (home: string, ...args: string[]) =>
  spawnSync(process.execPath, [resolve("bin/agentmbx.js"), "probe", ...args], { encoding: "utf8", env: cliEnv(home) });

test("CLI: usage errors exit 2 with the hint", (t) => {
  const home = mkdtempSync(join(tmpdir(), "mbx-probe-cli-usage-"));
  t.after(() => rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  new MbxNode(home, { host: "alpha" }).close();
  for (const [args, hint] of [
    [["extra"], /options, not positional arguments .*probe --help/s],
    [["--deadline", "soon"], /not a duration like 120s/],
  ] as const) {
    const r = probeCli(home, ...args);
    assert.equal(r.status, 2, `${args}: ${r.stderr}`);
    assert.match(r.stderr, hint);
  }
});

test("CLI: a caller without a held identity is refused (exit 2) and nothing is sent", (t) => {
  const home = mkdtempSync(join(tmpdir(), "mbx-probe-cli-refused-"));
  t.after(() => rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  const n = new MbxNode(home, { host: "alpha" });
  n.send({ from: "boss", to: ["worker"], subject: "seed", body: "b" }); // a known world, no lease for the caller
  n.close();
  const r = probeCli(home, "--deadline", "2s");
  assert.equal(r.status, 2, r.stderr);
  assert.match(r.stderr, /probe sends as your session's held identity/);
  const check = new MbxNode(home, { host: "alpha" });
  t.after(() => check.close());
  const count = (check.store.db.prepare("SELECT COUNT(*) c FROM messages").get() as { c: number }).c;
  assert.equal(count, 1, "the refused probe sent nothing");
});

test("CLI: --as a name this session does not hold is refused (exit 2)", (t) => {
  const home = mkdtempSync(join(tmpdir(), "mbx-probe-cli-as-"));
  t.after(() => rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  const n = new MbxNode(home, { host: "alpha" });
  bindWakeLease(n, { agent: "probe-runner", cli: "claude", session_id: "s1", pid: process.pid });
  n.close();
  const r = probeCli(home, "--as", "someone-else", "--deadline", "2s");
  assert.equal(r.status, 2, r.stderr);
  assert.match(r.stderr, /held identity/);
});

test("CLI: --json prints the report shape; the sender is excluded from its own targets", (t) => {
  const home = mkdtempSync(join(tmpdir(), "mbx-probe-cli-json-"));
  t.after(() => rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  const n = new MbxNode(home, { host: "alpha" });
  // the descriptor names this test process as the provider parent, so the spawned probe
  // (its child) resolves the held identity through the same ancestry proof `agentmbx send` uses
  bindWakeLease(n, { agent: "probe-runner", cli: "claude", session_id: "s1", pid: process.pid });
  n.close();
  const r = probeCli(home, "--json", "--deadline", "2s");
  assert.equal(r.status, 1, r.stderr);
  const report = JSON.parse(r.stdout);
  assert.equal(report.schema, "mbx.probe/v1");
  assert.equal(report.ok, false);
  assert.equal(report.require_idle_wake, false);
  assert.equal(report.sender, "probe-runner");
  assert.deepEqual(report.targets, []);
  assert.deepEqual(report.summary, { total: 0, passed: 0, failed: 0 });
  assert.match(report.reason, /no live leased identities to probe/);
});

test("planProbe: historical project membership is not enough — the live holder must work in the project (T445)", () => {
  const identities = [
    identity("local-worker", "held", { cli: "kimi", session_id: "s1", pid: 1 }),
    identity("outsider", "held", { cli: "claude", session_id: "s2", pid: 2 }),
    identity("no-holder", "idle", null),
  ];
  const cwdOf = new Map([["kimi:s1", "/proj"], ["claude:s2", "/other"]]);
  const holderProject = (h: { cli: string; session_id: string }) => cwdOf.get(`${h.cli}:${h.session_id}`) ?? null;
  const plan = planProbe(identities, "sender", { project: "/proj", holderProject });
  assert.deepEqual(plan.map((t) => t.name), ["local-worker"]);
  // No project: the cwd check stays inactive (previous behaviour).
  assert.equal(planProbe(identities, "sender").length, 3);
});

test("planProbe matches subdirectories, excludes shared-prefix siblings, and falls back to git-origin key", () => {
  const ids = [
    identity("root", "held", { cli: "kimi", session_id: "r", pid: 1 }),
    identity("src-subdir", "held", { cli: "kimi", session_id: "s", pid: 1 }),
    identity("cloud", "held", { cli: "kimi", session_id: "c", pid: 1 }),
    identity("other", "held", { cli: "kimi", session_id: "o", pid: 1 }),
    identity("worktree", "held", { cli: "kimi", session_id: "w", pid: 1 }),
  ];
  const cwdOf = new Map([
    ["kimi:r", "/x/agentmbx"],
    ["kimi:s", "/x/agentmbx/src"],
    ["kimi:c", "/x/agentmbx-cloud"],
    ["kimi:o", "/y/other"],
    ["kimi:w", "/z/agentmbx-worktree"],
  ]);
  const holderProject = (h: { cli: string; session_id: string }) => cwdOf.get(`${h.cli}:${h.session_id}`) ?? null;
  const keyOf = (p: string) => {
    if (p.includes("agentmbx") && !p.includes("cloud")) return "agentmbx-key";
    if (p.includes("other")) return "other-key";
    return undefined;
  };
  const plan = planProbe(ids, "sender", { project: "/x/agentmbx", holderProject, projectKeyOf: keyOf });
  assert.deepEqual(plan.map((t) => t.name), ["root", "src-subdir", "worktree"]);
});

test("planProbe: --only restricts and --exclude drops exact names and globs", () => {
  const ids = ["a1", "a2", "b1", "axiom-lab-staff"].map((n) => identity(n, "held", { cli: "kimi", session_id: n, pid: 1 }));
  assert.deepEqual(planProbe(ids, "sender", { only: ["a1", "b1"] }).map((t) => t.name), ["a1", "b1"]);
  assert.deepEqual(planProbe(ids, "sender", { exclude: ["a*"] }).map((t) => t.name), ["b1"]);
  assert.deepEqual(planProbe(ids, "sender", { exclude: ["axiom-*"] }).map((t) => t.name), ["a1", "a2", "b1"]);
  assert.deepEqual(planProbe(ids, "sender", { only: ["a1", "b1"], exclude: ["b1"] }).map((t) => t.name), ["a1"]);
  assert.ok(globMatch("axiom-*", "axiom-lab-staff"));
  assert.ok(!globMatch("axiom-*", "b1"));
  assert.ok(globMatch("a?1", "ax1"));
  assert.ok(!globMatch("a?1", "ax12"));
});

test("runProbe --plan computes the report but sends nothing", async () => {
  const sends: string[] = [];
  const io: ProbeIO = {
    host: () => "alpha",
    listTargets: () => [identity("a", "held", { cli: "kimi", session_id: "s", pid: 1 }), identity("b", "idle", { cli: "kimi", session_id: "s2", pid: 1 })],
    send: (name) => { sends.push(name); return { id: `msg-${name}`, thread: `thread-${name}`, at: 0 }; },
    observe: () => ({ wake: null, readAt: null, ackedAt: null, ackNote: null, reply: null }),
  };
  const report = await runProbe(io, { sender: "me", planOnly: true, deadlineMs: 1000 });
  assert.deepEqual(sends, [], "--plan must not send");
  assert.deepEqual(report.targets.map((t) => [t.name, t.state]), [["a", "held"], ["b", "idle"]]);
  assert.equal(report.ok, true);
  assert.equal(report.targets.every((t) => t.reason === null), true, "planned-only targets carry no failure reasons");
});

test("storeProbeIO: historical membership but a live session elsewhere is not targeted (T445)", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "mbx-probe-t445-"));
  const n = new MbxNode(home, { host: "alpha" });
  t.after(() => { n.close(); rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
  bindWakeLease(n, { agent: "local-worker", cli: "kimi", session_id: "term-local", pid: process.pid, cwd: "/proj" });
  bindWakeLease(n, { agent: "cwd-only", cli: "codex", session_id: "term-cwd", pid: process.pid, cwd: "/proj" });
  bindWakeLease(n, { agent: "outsider", cli: "claude", session_id: "term-elsewhere", pid: process.pid, cwd: "/other" });
  bindWakeLease(n, { agent: "probe-runner", cli: "claude", session_id: "runner-1", pid: process.pid, cwd: "/proj" });
  // A session cwd is not membership (T515). local-worker is a member because of the binding, and the live cwd still has to match (T445).
  noteProject(n.store, "local-worker", "/proj", true);
  // outsider once worked in /proj — historical identity_projects membership only.
  n.store.db.prepare("INSERT INTO identity_projects (name,project,first_seen,last_seen) VALUES (?,?,?,?)")
    .run("outsider", "/proj", new Date().toISOString(), new Date().toISOString());
  const report = await runProbe(storeProbeIO(n, { sender: "probe-runner", project: "/proj" }),
    { sender: "probe-runner", project: "/proj", planOnly: true, deadlineMs: 1000 });
  assert.deepEqual(report.targets.map((x) => x.name), ["local-worker"], JSON.stringify(report.targets));
});
