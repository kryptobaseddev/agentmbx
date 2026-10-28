import { writeCodexQueueStub } from "./helpers/codex-queue.ts";
// T557: the daemon wake dispatcher keys project-mailbox mail to the project's current lead.
// A slot has no session of its own. Mail delivered to it wakes the owner-signed, unrevoked, unexpired lead designated on this host, through that
// lead's own verified session, and nobody else; a lead change or a released lease is honoured at the last moment; with no lead to wake, the mail waits.
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonical, signData } from "../src/crypto.ts";
import { makeLead, makeLeadRevocation, revokeLead, storeLead } from "../src/lead-record.ts";
import { MbxNode } from "../src/node.ts";
import { unlockOwnerKey } from "../src/owner.ts";
import { leadAgentOf, projectsLedBy } from "../src/project-mailbox.ts";
import { slotFor } from "../src/project-slot.ts";
import { dispatchWakes } from "../src/wake.ts";
import { captureWakeIdentity } from "../src/wake-identity.ts";
import { bindWakeLease } from "./helpers/wake-lease.ts";
import { sendLeased } from "./helpers/leased-send.ts";

const PASS = "test-only-passphrase";
const CLEO_ID = "5c1a9d3e-7b2f-4a60-9e11-0a1b2c3d4e5f";
const SLOT = slotFor(CLEO_ID);

function fixture(t: TestContext) {
  const home = mkdtempSync(join(tmpdir(), "mbx-t557-")), root = mkdtempSync(join(tmpdir(), "mbx-t557-root-"));
  const n = new MbxNode(home, { host: "alpha" });
  const log = join(home, "calls"), bin = join(home, "codex");
  const markers = join(home, "markers");
  writeCodexQueueStub(bin, { format: "args" });
  const old = { MBX_CODEX_BIN: process.env.MBX_CODEX_BIN, MBX_TEST_WAKE_LOG: process.env.MBX_TEST_WAKE_LOG, MBX_NO_DESKTOP: process.env.MBX_NO_DESKTOP, MBX_TEST_DB: process.env.MBX_TEST_DB, MBX_TEST_MARKERS: process.env.MBX_TEST_MARKERS, MBX_TEST_KILL: process.env.MBX_TEST_KILL };
  Object.assign(process.env, { MBX_CODEX_BIN: bin, MBX_TEST_WAKE_LOG: log, MBX_NO_DESKTOP: "1", MBX_TEST_DB: join(home, "mbx.db"), MBX_TEST_MARKERS: markers });
  t.after(() => {
    n.close();
    for (const d of [home, root]) rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    for (const [k, v] of Object.entries(old)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  });
  const project = join(root, "agentmbx");
  mkdirSync(join(project, ".cleo"), { recursive: true });
  writeFileSync(join(project, ".cleo", "project-id"), `# CLEO project id\n${CLEO_ID}\n`);
  const folder = realpathSync(project);
  const bound = new Map<string, ReturnType<typeof bindWakeLease>>();
  const bind = (agent: string, session: string, cli = "codex") => {
    n.registerAgent(agent);
    const h = bindWakeLease(n, { agent, cli, session_id: session, pid: process.pid });
    bound.set(agent, h);
    return h;
  };
  /** The calls the fake binary saw: each an array of its arguments. */
  const calls = () => existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean).map((l) => l.split("\x1f").filter(Boolean)) : [];
  const inFlight = () => existsSync(markers) ? readFileSync(markers, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as { agent: string; messageIds: string[]; deliveries: { id: string; agent: string }[] }) : [];
  const woke = (session: string) => calls().filter((c) => c.includes(session));
  let owner: ReturnType<typeof unlockOwnerKey> | null = null;
  const designate = (agent: string, offsetMs = 0, extra: { ttlMs?: number; host?: string } = {}) => {
    owner ??= unlockOwnerKey(home, PASS);
    const rec = makeLead({ project: folder, agent, host: extra.host ?? "alpha", ownerPub: owner.publicKey, now: new Date(Date.now() + offsetMs), ...(extra.ttlMs ? { ttlMs: extra.ttlMs } : {}) });
    return storeLead(n, rec, signData(owner.privateKey, canonical(rec)));
  };
  const send = (to: string[], extra: Record<string, unknown> = {}) => sendLeased(n, { from: "boss", to, subject: "please review", body: "secret project body", kind: "request", project: folder, ...extra } as never).envelope;
  const rowOf = (id: string, agent: string) => { const r = n.store.db.prepare("SELECT state,note FROM deliveries WHERE msg_id=? AND agent=?").get(id, agent) as { state: string; note: string | null } | undefined; return r && { ...r }; };
  const audits = (event: string) => (n.store.db.prepare("SELECT count(*) c FROM audit WHERE event=?").get(event) as { c: number }).c;
  return { n, home, folder, bind, bound, calls, inFlight, woke, designate, send, rowOf, audits, revoke: (id: string) => { const rv = makeLeadRevocation(id, owner!.publicKey); revokeLead(n, rv, signData(owner!.privateKey, canonical(rv))); } };
}

// ── AC1 and AC2 ─────────────────────────────────────────────────────────────────────────────────────────────

test("T557 AC1/AC2: project mail wakes the current lead's own session and no other persona, with a no-body hint that names the project", async (t) => {
  const f = fixture(t);
  f.bind("agentmbx-lead", "lead-sess"); f.bind("agentmbx-worker", "worker-sess"); f.bind("decoy", "decoy-sess"); f.bind("foreign-dev", "foreign-sess");
  f.n.registerAgent("decoy", { role: "lead" }); // a role label is not the lead
  f.designate("agentmbx-lead");

  const req = f.send(["agentmbx"]);
  assert.deepEqual(f.n.store.db.prepare("SELECT agent FROM deliveries WHERE msg_id=?").all(req.id).map((r) => r.agent), [SLOT], "stored once, in the project mailbox");
  const out = await dispatchWakes(f.n);
  assert.deepEqual(out.map((o) => o.agent), ["agentmbx-lead"], "the dispatcher answered for the lead and for no one else");
  assert.equal(f.calls().length, 1, "one native wake in total");
  assert.equal(f.woke("lead-sess").length, 1);
  for (const other of ["worker-sess", "decoy-sess", "foreign-sess"]) assert.equal(f.woke(other).length, 0, `${other} was not woken`);
  const hint = f.calls()[0]!.join(" ");
  assert.match(hint, /1 new message\(s\) for agentmbx-lead in the project mailbox agentmbx from boss@alpha/);
  assert.ok(hint.includes(req.id), "ids");
  assert.equal(hint.includes("secret project body"), false, "never the body");
  assert.equal(hint.includes(SLOT), false, "never the reserved slot name");
  assert.deepEqual(f.rowOf(req.id, SLOT), { state: "notified", note: null }, "the project copy is the one marked, on the slot");
  for (const other of ["agentmbx-worker", "decoy", "foreign-dev"]) assert.equal(f.rowOf(req.id, other), undefined, `${other} has no delivery of it`);

  // The dispatcher still wakes ordinary personal mail as before.
  const mine = f.send(["agentmbx-worker"]);
  await dispatchWakes(f.n);
  assert.equal(f.woke("worker-sess").length, 1); assert.equal(f.rowOf(mine.id, "agentmbx-worker")?.state, "notified");
  assert.equal(f.woke("lead-sess").length, 1, "and the lead is not woken again for it");
});

test("T557: the in-flight attempt marker names the project row on the slot; status mail to the project is marked seen on the slot without waking anyone", async (t) => {
  const f = fixture(t);
  f.bind("agentmbx-lead", "lead-sess");
  f.designate("agentmbx-lead");
  const fyi = f.send(["agentmbx"], { kind: "status", subject: "fyi" });
  assert.deepEqual(await dispatchWakes(f.n), [], "status never wakes");
  assert.equal(f.calls().length, 0);
  assert.deepEqual(f.rowOf(fyi.id, SLOT), { state: "notified", note: null }, "seen on the slot, as the watcher does");
  assert.equal(f.rowOf(fyi.id, "agentmbx-lead"), undefined, "and no delivery appeared under the lead's name");
  const req = f.send(["agentmbx"]);
  await dispatchWakes(f.n);
  const seen = f.inFlight();
  assert.equal(seen.length, 1, "the fake binary saw one durable marker before the native write");
  assert.equal(seen[0]!.agent, "agentmbx-lead");
  assert.deepEqual(seen[0]!.deliveries, [{ id: req.id, agent: SLOT }], "the marker pairs the message with the slot it sits in");
  assert.deepEqual(seen[0]!.messageIds, [req.id]);
  assert.equal(f.n.store.get("wake-attempt:agentmbx-lead"), undefined, "and it is cleared once the wake is recorded");
});

test("T557: a wake whose outcome is unknown holds the project row on the slot, not under the lead's name", async (t) => {
  const f = fixture(t);
  f.bind("agentmbx-lead", "lead-sess");
  f.designate("agentmbx-lead");
  const personal = f.send(["agentmbx-lead"], { subject: "mine" }), project = f.send(["agentmbx"]);
  process.env.MBX_TEST_KILL = "1";
  const out = await dispatchWakes(f.n);
  assert.equal(f.calls().length, 1, "one native write was made, then the process was killed");
  assert.equal((out[0]?.result as { outcome?: { kind: string } } | undefined)?.outcome?.kind, "unknown");
  assert.deepEqual(f.rowOf(personal.id, "agentmbx-lead"), { state: "notified", note: "unknown" });
  assert.deepEqual(f.rowOf(project.id, SLOT), { state: "notified", note: "unknown" }, "held on the slot");
  assert.equal(f.rowOf(project.id, "agentmbx-lead"), undefined, "no delivery was minted under the lead's name");
  assert.equal(f.audits("wake.unknown"), 1);
  assert.equal(f.n.store.get("wake-attempt:agentmbx-lead"), undefined, "and the attempt marker is cleared");
});

test("T557: when the desktop-notice limit is reached the lead's personal mail is marked and the project mail beside it is not", async (t) => {
  const f = fixture(t);
  f.bind("agentmbx-lead", "lead-claude", "claude");
  f.designate("agentmbx-lead");
  f.n.store.set("desktop-notices", JSON.stringify(Array.from({ length: 6 }, () => Date.now()))); // NOTICES_PER_MINUTE already used
  const personal = f.send(["agentmbx-lead"], { subject: "mine" }), project = f.send(["agentmbx"]);
  const out = await dispatchWakes(f.n);
  assert.match(String((out[0]?.result as { error?: string } | undefined)?.error ?? ""), /notice skipped/);
  assert.equal(f.audits("wake.notice_skipped"), 1);
  assert.deepEqual(f.rowOf(personal.id, "agentmbx-lead"), { state: "notified", note: "stalled" });
  assert.deepEqual(f.rowOf(project.id, SLOT), { state: "delivered", note: null }, "project mail is never marked desktop, limit or not");
});

test("T557: a lead with personal and project mail is woken once, with one hint that names both", async (t) => {
  const f = fixture(t);
  f.bind("agentmbx-lead", "lead-sess");
  f.designate("agentmbx-lead");
  const personal = f.send(["agentmbx-lead"], { subject: "mine" }), project = f.send(["agentmbx"]);
  const out = await dispatchWakes(f.n);
  assert.equal(out.length, 1); assert.equal(f.calls().length, 1, "one wake for both");
  const hint = f.calls()[0]!.join(" ");
  assert.match(hint, /new message\(s\) for agentmbx-lead from boss@alpha/); assert.match(hint, /in the project mailbox agentmbx/);
  assert.ok(hint.includes(personal.id) && hint.includes(project.id));
  assert.equal(f.rowOf(personal.id, "agentmbx-lead")?.state, "notified"); assert.equal(f.rowOf(project.id, SLOT)?.state, "notified");
});

// ── AC3 ─────────────────────────────────────────────────────────────────────────────────────────────────────

test("T557 AC3: after a lead change the new lead is woken for the unread project mail and the old one is not", async (t) => {
  const f = fixture(t);
  f.bind("agentmbx-lead", "lead-sess"); f.bind("agentmbx-second", "second-sess");
  f.designate("agentmbx-lead");
  const req = f.send(["agentmbx"]);
  assert.equal(leadAgentOf(f.n, SLOT), "agentmbx-lead");
  f.designate("agentmbx-second", 2_000); // the owner signs a different lead before anything was dispatched
  assert.equal(leadAgentOf(f.n, SLOT), "agentmbx-second");
  const out = await dispatchWakes(f.n);
  assert.deepEqual(out.map((o) => o.agent), ["agentmbx-second"]);
  assert.equal(f.woke("second-sess").length, 1); assert.equal(f.woke("lead-sess").length, 0, "the replaced lead is not woken");
  assert.deepEqual(f.rowOf(req.id, SLOT), { state: "notified", note: null });
  assert.deepEqual(f.n.store.db.prepare("SELECT agent FROM deliveries WHERE msg_id=?").all(req.id).map((r) => r.agent), [SLOT], "the same single delivery: no forward, no copy");
});

test("T557 AC3: a released lead lease wakes no one, the mail stays delivered, and a later lead is woken for it", async (t) => {
  const f = fixture(t);
  const lead = f.bind("agentmbx-lead", "lead-sess"); f.bind("agentmbx-second", "second-sess");
  f.designate("agentmbx-lead");
  const req = f.send(["agentmbx"]);
  lead.release();
  assert.deepEqual(await dispatchWakes(f.n), [], "the lead has no live session: nothing to wake and nothing reported");
  assert.equal(f.calls().length, 0);
  assert.deepEqual(f.rowOf(req.id, SLOT), { state: "delivered", note: null }, "the mail waits, untouched: not notified, no desktop note");
  assert.equal(f.audits("wake"), 0, "and the dispatcher recorded no failed wake");
  assert.equal(f.audits("wake.notice_skipped"), 0);
  assert.equal(f.n.reserveWake("agentmbx-lead", null).brake, null, "no batching budget was spent on it");
  // The same mail is still there on the next pass; a different persona becoming lead is woken for it.
  assert.deepEqual(await dispatchWakes(f.n), []);
  f.designate("agentmbx-second", 2_000);
  assert.deepEqual((await dispatchWakes(f.n)).map((o) => o.agent), ["agentmbx-second"]);
  assert.equal(f.woke("second-sess").length, 1);
  assert.equal(f.rowOf(req.id, SLOT)?.state, "notified");
});

test("T557 fence: the wake is checked against the lead's read scope inside its own lease at the last moment", async (t) => {
  const f = fixture(t);
  f.bind("agentmbx-lead", "lead-sess"); f.bind("agentmbx-second", "second-sess");
  const rec = f.designate("agentmbx-lead");
  const req = f.send(["agentmbx"]);

  // Directly: inside the holder's guard the lead may read the slot; after the owner replaces it, the very same guard may not.
  const guard = captureWakeIdentity(f.n, f.n.sessionsFor("agentmbx-lead")[0]!)!;
  assert.deepEqual(guard.run(() => f.n.readableSlots("agentmbx-lead")), [SLOT]);
  f.designate("agentmbx-second", 2_000);
  assert.deepEqual(guard.run(() => f.n.readableSlots("agentmbx-lead")), [], "a replaced lead has no read scope in its own lease");
  assert.deepEqual(captureWakeIdentity(f.n, f.n.sessionsFor("agentmbx-second")[0]!)!.run(() => f.n.readableSlots("agentmbx-second")), [SLOT]);

  // Through the dispatcher: the lead is chosen, then loses the scope before the native write. Nothing is submitted.
  f.designate("agentmbx-lead", 4_000);
  const real = f.n.readableSlots.bind(f.n);
  let asked = 0;
  f.n.readableSlots = () => { asked++; return []; };
  const out = await dispatchWakes(f.n);
  f.n.readableSlots = real;
  assert.ok(asked > 0, "the dispatcher asked the read-scope predicate");
  assert.equal(f.calls().length, 0, "no native wake was written");
  assert.equal(f.audits("wake.fenced"), 1);
  assert.match(String((out[0]?.result as { error?: string } | undefined)?.error ?? ""), /wake authority changed/);
  assert.deepEqual(f.rowOf(req.id, SLOT), { state: "delivered", note: null }, "the delivery is retained for a later pass");
  assert.equal(rec.agent, "agentmbx-lead");
});

// ── no one to wake ──────────────────────────────────────────────────────────────────────────────────────────

test("T557: expired, revoked and other-host leads, an unallocated slot and a lead with no wake path wake no one and leave the mail delivered", async (t) => {
  const f = fixture(t);
  f.bind("agentmbx-lead", "lead-sess");
  // 1. an expired lead
  f.designate("agentmbx-lead", -60_000, { ttlMs: 1_000 });
  const a = f.send(["agentmbx"]);
  assert.equal(leadAgentOf(f.n, SLOT), null);
  assert.deepEqual(await dispatchWakes(f.n), []);
  // 2. a lead designated for another host
  f.designate("agentmbx-lead", 2_000, { host: "elsewhere" });
  assert.equal(leadAgentOf(f.n, SLOT), null, "a lead on another host cannot read the home mailbox (T552)");
  assert.deepEqual(await dispatchWakes(f.n), []);
  // 3. a revoked lead
  const live = f.designate("agentmbx-lead", 4_000);
  assert.equal(leadAgentOf(f.n, SLOT), "agentmbx-lead");
  f.revoke(live.id);
  assert.equal(leadAgentOf(f.n, SLOT), null);
  assert.deepEqual(await dispatchWakes(f.n), []);
  // 4. a phantom slot nobody allocated: not an agent, never woken, never minted
  const phantom = slotFor("never-allocated");
  f.n.store.db.prepare("INSERT INTO deliveries (msg_id,agent,state,updated_at) VALUES (?,?,'delivered',?)").run(a.id, phantom, new Date().toISOString());
  assert.deepEqual(await dispatchWakes(f.n), []);
  assert.equal(f.calls().length, 0);
  assert.equal(f.rowOf(a.id, SLOT)?.state, "delivered"); assert.equal(f.rowOf(a.id, phantom)?.state, "delivered");
  assert.equal((f.n.store.db.prepare("SELECT count(*) c FROM agents WHERE name LIKE 'pm-%'").get() as { c: number }).c, 0);
  assert.equal(f.audits("wake"), 0);
});

test("T557: a lead whose session cannot be pushed keeps its project mail delivered, spends no batching budget and gets no desktop mark", async (t) => {
  const f = fixture(t);
  f.bind("agentmbx-lead", "lead-claude", "claude"); // a verified session of a CLI the dispatcher has no native wake for
  f.designate("agentmbx-lead");
  const req = f.send(["agentmbx"]);
  const out = await dispatchWakes(f.n);
  assert.deepEqual(out, [], "nothing to report: the lead's own watcher, channel or inbox is how it learns");
  assert.deepEqual(f.rowOf(req.id, SLOT), { state: "delivered", note: null }, "not marked desktop: the rebind re-wake only knows agent names");
  assert.equal(f.n.reserveWake("agentmbx-lead", null).brake, null, "the reservation was refunded: no native write was attempted");
  assert.equal(f.audits("wake"), 0);
});

test("T557: the lead's personal mail still falls back to a desktop mark when it cannot be pushed, and the project mail beside it does not", async (t) => {
  const f = fixture(t);
  f.bind("agentmbx-lead", "lead-claude", "claude");
  f.designate("agentmbx-lead");
  const personal = f.send(["agentmbx-lead"], { subject: "mine" }), project = f.send(["agentmbx"]);
  await dispatchWakes(f.n);
  assert.deepEqual(f.rowOf(personal.id, "agentmbx-lead"), { state: "notified", note: "stalled" }, "personal mail no notice reached is stalled");
  assert.deepEqual(f.rowOf(project.id, SLOT), { state: "delivered", note: null }, "project mail is never marked desktop");
});

// ── attempt markers ─────────────────────────────────────────────────────────────────────────────────────────

test("T557: an interrupted wake holds each (message, mailbox) pair as unknown, and a marker an older daemon wrote still replays", async (t) => {
  const f = fixture(t);
  f.bind("agentmbx-lead", "lead-sess");
  f.designate("agentmbx-lead");
  const personal = f.send(["agentmbx-lead"], { subject: "mine" }), project = f.send(["agentmbx"]);
  // A daemon killed between submitting and recording: the marker names the pairs it had in flight.
  f.n.store.set("wake-attempt:agentmbx-lead", JSON.stringify({ attemptId: "a1", agent: "agentmbx-lead", messageIds: [personal.id, project.id],
    deliveries: [{ id: personal.id, agent: "agentmbx-lead" }, { id: project.id, agent: SLOT }], sessionId: "lead-sess", at: new Date().toISOString() }));
  await dispatchWakes(f.n, Date.now());
  assert.deepEqual(f.rowOf(personal.id, "agentmbx-lead"), { state: "notified", note: "unknown" });
  assert.deepEqual(f.rowOf(project.id, SLOT), { state: "notified", note: "unknown" }, "the project row is held on the slot, not on the lead's name");
  assert.equal(f.rowOf(project.id, "agentmbx-lead"), undefined, "no stray delivery was created under the lead's name");
  // A marker from before this change has only ids and one agent (mail that arrives later is a separate wake, so this message is created now).
  const legacy = f.send(["agentmbx-lead"], { subject: "legacy" });
  f.n.store.set("wake-attempt:agentmbx-lead", JSON.stringify({ attemptId: "a0", agent: "agentmbx-lead", messageIds: [legacy.id], sessionId: "lead-sess", at: new Date().toISOString() }));
  await dispatchWakes(f.n, Date.now());
  assert.deepEqual(f.rowOf(legacy.id, "agentmbx-lead"), { state: "notified", note: "unknown" });
  assert.equal(f.audits("wake.unknown"), 2);
});

// ── one source of truth ─────────────────────────────────────────────────────────────────────────────────────

test("T557: who the dispatcher wakes and who may read the slot are the same answer for every kind of lead record", async (t) => {
  const f = fixture(t);
  for (const a of ["agentmbx-lead", "agentmbx-second"]) f.bind(a, `${a}-s`);
  const answers = () => ({ wakes: leadAgentOf(f.n, SLOT), reads: ["agentmbx-lead", "agentmbx-second"].filter((a) => projectsLedBy(f.n, a).some((m) => m.slot === SLOT)) });
  f.designate("agentmbx-lead");
  assert.deepEqual(answers(), { wakes: "agentmbx-lead", reads: ["agentmbx-lead"] });
  f.designate("agentmbx-second", 2_000);
  assert.deepEqual(answers(), { wakes: "agentmbx-second", reads: ["agentmbx-second"] }, "replaced");
  const gone = f.designate("agentmbx-lead", 4_000);
  f.revoke(gone.id);
  assert.deepEqual(answers(), { wakes: null, reads: [] }, "T562: a revoked head restores neither the previous reader nor its wake target");
  f.designate("agentmbx-lead", 6_000, { host: "elsewhere" });
  assert.deepEqual(answers(), { wakes: null, reads: [] }, "a newer designation for another host: neither wakes nor reads here");
});
