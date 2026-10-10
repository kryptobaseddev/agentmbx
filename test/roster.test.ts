// T496: the live agent roster behind mbx_agents. One test per acceptance criterion, plus the safety properties the
// council set (no counts on a row, a role label is not the lead, a remote row is never presented as verified).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonical, signData } from "../src/crypto.ts";
import { MbxNode } from "../src/node.ts";
import { IdentityLeases, type ProcessEvidence } from "../src/identity-leases.ts";
import { activeLeads, makeLead, storeLead } from "../src/lead-record.ts";
import { createOwnerKey, unlockOwnerKey } from "../src/owner.ts";
import { noteProject, registerIdentity } from "../src/registry.ts";
import { buildRoster, rosterText } from "../src/roster.ts";
import { activityKey } from "../src/identity-availability.ts";
import { retiredKey } from "../src/identity-cleanup.ts";
import { AGENTS_V1_SCHEMA, validateAgentsV1, type AgentsV1 } from "../src/status-schema.ts";

const PASS = "test-only-passphrase";
const FIXTURE = JSON.parse(readFileSync(join(import.meta.dirname, "fixtures", "agents-v1.json"), "utf8")) as AgentsV1;
const A = "/work/proj-a", B = "/work/proj-b", C = "/work/proj-c";

function world(t: { after: (fn: () => unknown) => void }) {
  const home = mkdtempSync(join(tmpdir(), "mbx-roster-"));
  const node = new MbxNode(home, { host: "alpha" });
  createOwnerKey(home, PASS);
  const owner = unlockOwnerKey(home, PASS);
  t.after(() => { node.close(); rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
  const NOW = Date.now();
  // Process evidence per holder pid; a pid with no entry is alive with its own birth time.
  const evidence = new Map<number, ProcessEvidence | "throw">();
  const inspect = (pid: number): ProcessEvidence => {
    const e = evidence.get(pid);
    if (e === "throw") throw new Error("unavailable");
    return e ?? { alive: true, start: `birth-${pid}` };
  };
  const leases = new IdentityLeases(node.store, { clock: () => NOW, idleTtlMs: 3_600_000, inspect });
  let nextPid = 1000;
  /** A persona with a lease held by a process: registered (unless told otherwise), bound to a project, in the directory. */
  const hold = (name: string, o: { cli?: string; role?: string; project?: string; registered?: boolean; pid?: number; description?: string } = {}) => {
    const pid = o.pid ?? nextPid++;
    leases.claim(name, { pid, start: `birth-${pid}`, cli: o.cli ?? "claude", sessionId: `s-${name}`, keyFp: "aaaa-bbbb-cccc-dddd" });
    if (o.registered !== false) registerIdentity(node.store, { name, role: o.role ?? "builder", description: o.description ?? null });
    node.registerAgent(name, { cli: o.cli ?? "claude", ...(o.role ? { role: o.role } : {}), ...(o.description ? { description: o.description } : {}) });
    if (o.project) noteProject(node.store, name, o.project, true);
    return pid;
  };
  const member = (name: string, project: string, role = "builder") => {
    registerIdentity(node.store, { name, role });
    node.registerAgent(name, { role });
    noteProject(node.store, name, project, true);
  };
  const designate = (agent: string, project: string, host = "alpha") => {
    const rec = makeLead({ project, agent, host, ownerPub: owner.publicKey });
    return storeLead(node, rec, signData(owner.privateKey, canonical(rec)));
  };
  const roster = (o: Parameters<typeof buildRoster>[1] = {}) => buildRoster(node, { now: NOW, inspect, ...o });
  return { node, NOW, evidence, leases, hold, member, designate, roster };
}

const names = (r: AgentsV1) => r.agents.map((a) => a.name);
const row = (r: AgentsV1, name: string) => r.agents.find((a) => a.name === name)!;

test("AC1: state comes from verified holder processes, not from last_seen", (t) => {
  const w = world(t);
  const live = w.hold("p-live", { project: A });
  const dead = w.hold("p-dead", { project: A });
  const quiet = w.hold("p-quiet", { project: A, cli: "opencode" });
  const unsure = w.hold("p-unsure", { project: A });
  w.evidence.set(dead, { alive: false, start: null });
  w.evidence.set(unsure, "throw");
  // A shared-process conversation (OpenCode/Codex/hosted Kimi) with no mbx call for 11 minutes.
  w.node.store.set(activityKey("p-quiet"), JSON.stringify({ at: w.NOW - 11 * 60_000, shared: true }));
  void live; void quiet;

  const r = w.roster({ project: A });
  // Every row was registered just now, so a last_seen-based roster would call all four live.
  for (const n of ["p-live", "p-dead", "p-quiet", "p-unsure"]) assert.ok(Date.parse(row(r, n).last_seen!) > w.NOW - 60_000, `${n} was seen a moment ago`);
  assert.deepEqual(Object.fromEntries(r.agents.map((a) => [a.name, a.state])),
    { "p-live": "live", "p-quiet": "idle", "p-unsure": "unknown", "p-dead": "offline" });
  assert.deepEqual(names(r), ["p-live", "p-quiet", "p-unsure", "p-dead"], "ordered live, idle, unknown, offline");
  assert.match(row(r, "p-dead").reason, /dead|expired|released|no heartbeat/i, "the reason says why it is offline");
});

test("AC2: a row carries role, harness, projects and the lead badge; a role label of lead is not the badge; no counts", (t) => {
  const w = world(t);
  w.hold("the-lead", { cli: "claude", role: "lead", project: A, description: "runs the project" });
  w.hold("worker", { cli: "codex", role: "builder", project: A });
  w.hold("decoy", { cli: "kimi", role: "lead", project: A });
  w.designate("the-lead", A);
  // Unread mail exists for the worker: the roster must not carry it.
  w.node.send({ from: "the-lead", to: ["worker"], subject: "work", body: "do it" });

  const r = w.roster({ project: A, self: "worker" });
  const lead = row(r, "the-lead"), worker = row(r, "worker"), decoy = row(r, "decoy");
  assert.deepEqual([lead.role, lead.harness, lead.projects, lead.lead_of, lead.description], ["lead", "claude", [A], [A], "runs the project"]);
  assert.deepEqual([worker.role, worker.harness, worker.projects, worker.lead_of, worker.self], ["builder", "codex", [A], [], true]);
  assert.deepEqual(decoy.lead_of, [], "role: lead is a label, not the designated lead (T393)");
  assert.equal(decoy.role, "lead");
  assert.equal(names(r)[0], "the-lead", "the lead sorts first within its state");
  for (const a of r.agents) {
    assert.equal(Object.hasOwn(a, "lead"), false, "no `lead` column: the badge is lead_of");
    for (const k of ["unread", "messages", "needs_reply", "from_owner"]) assert.equal(Object.hasOwn(a, k), false, `no ${k} on a roster row (T308 AC2)`);
  }
  assert.equal(r.lead?.address, "the-lead@alpha");
  assert.match(rosterText(r), /the-lead@alpha {2}live {2}LEAD of proj-a {2}role:lead {2}\(claude\)/);
  assert.match(rosterText(r), /worker@alpha {2}live {2}\(you\)/);
});

test("AC3: default is the session's project plus the leads of other projects; project * lists every project", (t) => {
  const w = world(t);
  w.hold("a-lead", { project: A, role: "lead" }); w.hold("a-dev", { project: A });
  w.hold("b-lead", { project: B, role: "lead" }); w.hold("b-dev", { project: B });
  w.designate("a-lead", A); w.designate("b-lead", B);
  // A paired host's rows, and a lead that lives there.
  w.node.store.db.prepare("INSERT INTO agents (name,host,role) VALUES ('far-dev','beta','builder')").run();
  w.designate("far-lead", C, "beta");

  const inA = w.roster({ project: A, self: "a-dev" });
  assert.deepEqual(names(inA).sort(), ["a-dev", "a-lead", "b-lead", "far-lead"], "A's members, B's lead and the remote lead, not B's dev or the remote dev");
  assert.deepEqual(row(inA, "b-lead").lead_of, [B], "another project's lead is a row with lead_of");
  assert.equal(inA.lead?.address, "a-lead@alpha", "the top-level lead stays this project's only");
  assert.equal(inA.scope.all_projects, false);

  const all = w.roster({ project: A, ask: "*" });
  assert.deepEqual(names(all).sort(), ["a-dev", "a-lead", "b-dev", "b-lead", "far-dev", "far-lead"]);
  assert.equal(all.scope.all_projects, true);

  const home = w.roster({});
  assert.deepEqual(names(home).sort(), ["a-lead", "b-lead", "far-lead"], "a session with no project sees the leads");
  assert.equal(home.lead, null);
  assert.equal(home.scope.project, null);

  // Remote rows are labelled and never claim a verified state or a harness.
  for (const n of ["far-dev", "far-lead"]) {
    const a = row(all, n);
    assert.deepEqual([a.state, a.host, a.harness, a.registered, a.retired], ["remote", "beta", null, null, null]);
    assert.match(a.reason, /cannot verify/);
  }
  assert.deepEqual(row(all, "far-lead").lead_of, [C]);

  assert.throws(() => w.roster({ project: A, ask: B }), (e: Error & { code?: string }) => e.code === "PROJECT_SCOPE");
  assert.throws(() => w.roster({ ask: A }), (e: Error & { code?: string }) => e.code === "PROJECT_SCOPE", "a session with no project may only ask for *");
  assert.equal(w.roster({ project: A, ask: A }).agents.length, inA.agents.length, "asking for its own folder is the default view");
});

test("AC4: retired and generated names are hidden unless live or idle; all:true lists them", (t) => {
  const w = world(t);
  w.hold("kept", { project: A });
  w.member("old-retired", A);
  w.node.store.set(retiredKey("old-retired"), "retired");
  w.node.registerAgent("agent-a1b2c3d4e5", { cli: "claude" });             // generated: never registered
  noteProject(w.node.store, "agent-a1b2c3d4e5", A, true);
  w.hold("agent-9f8e7d6c5b", { project: A, registered: false });           // generated name, but a live session holds it

  const r = w.roster({ project: A });
  assert.deepEqual(names(r).sort(), ["agent-9f8e7d6c5b", "kept"], "the held generated name stays, the unheld ones go");
  assert.equal(r.scope.hidden, 2);
  assert.equal(r.scope.include_hidden, false);
  assert.equal(row(r, "agent-9f8e7d6c5b").registered, false);
  assert.match(rosterText(r), /2 retired or generated name\(s\) hidden; pass all:true/);

  const all = w.roster({ project: A, all: true });
  assert.deepEqual(names(all).sort(), ["agent-9f8e7d6c5b", "agent-a1b2c3d4e5", "kept", "old-retired"]);
  assert.equal(all.scope.hidden, 0);
  assert.equal(all.scope.include_hidden, true);
  assert.deepEqual([row(all, "old-retired").retired, row(all, "old-retired").state], [true, "offline"]);
  assert.equal(row(all, "agent-a1b2c3d4e5").registered, false);

  // A retired or generated name that is the designated lead, or the caller, is never hidden.
  w.designate("old-retired", A);
  assert.ok(names(w.roster({ project: A })).includes("old-retired"), "a designated lead is always listed");
  assert.ok(names(w.roster({ project: A, self: "agent-a1b2c3d4e5" })).includes("agent-a1b2c3d4e5"), "the caller's own row is always listed");
});

test("AC5: the output validates against the mbx.agents/v1 schema and fixture", (t) => {
  assert.deepEqual(validateAgentsV1(FIXTURE), [], "the fixture satisfies the contract");
  assert.equal(FIXTURE.schema, AGENTS_V1_SCHEMA);
  assert.deepEqual([...new Set(FIXTURE.agents.map((a) => a.state))].sort(), ["idle", "live", "offline", "remote", "unknown"], "the fixture covers every state");

  const w = world(t);
  w.hold("lead-x", { project: A, role: "lead" }); w.hold("dev-x", { project: A, cli: "codex" });
  w.designate("lead-x", A);
  w.node.store.db.prepare("INSERT INTO agents (name,host) VALUES ('far','beta')").run();
  const real = w.roster({ project: A, ask: "*", self: "dev-x" });
  assert.deepEqual(validateAgentsV1(real), [], "the real roster validates");
  assert.deepEqual(Object.keys(real).sort(), Object.keys(FIXTURE).sort(), "top-level keys match the fixture");
  assert.deepEqual(Object.keys(real.scope).sort(), Object.keys(FIXTURE.scope).sort());
  assert.deepEqual(Object.keys(real.agents[0]).sort(), Object.keys(FIXTURE.agents[0]).sort(), "row keys match the fixture, so neither can drift alone");

  // The validator says no: a missing key, a retyped key, an unknown state, a harness on a persona nobody holds.
  const mutate = (f: (c: AgentsV1) => void) => { const c = structuredClone(FIXTURE); f(c); return validateAgentsV1(c); };
  assert.match(mutate((c) => { delete (c.agents[0] as Partial<typeof c.agents[0]>).lead_of; }).join(), /lead_of/);
  assert.match(mutate((c) => { (c.agents[0] as unknown as Record<string, unknown>).self = "yes"; }).join(), /self/);
  assert.match(mutate((c) => { (c.agents[0] as unknown as Record<string, unknown>).state = "online"; }).join(), /state/);
  assert.match(mutate((c) => { c.agents[4].harness = "claude"; }).join(), /harness/);
  assert.match(mutate((c) => { (c as unknown as Record<string, unknown>).schema = "mbx.agents/v2"; }).join(), /schema/);
  assert.match(mutate((c) => { c.scope.hidden = -1; }).join(), /hidden/);
  assert.deepEqual(validateAgentsV1(null), ["not an object"]);
  assert.deepEqual(mutate((c) => { (c as unknown as Record<string, unknown>).extra = 1; (c.agents[0] as unknown as Record<string, unknown>).extra = 1; }), [], "additive fields are allowed");
});

test("activeLeads lists each project's current lead and drops expired or revoked records", (t) => {
  const w = world(t);
  w.designate("lead-a", A); w.designate("lead-b", B);
  assert.deepEqual(activeLeads(w.node, new Date(w.NOW)).map((l) => [l.project, l.agent]), [[A, "lead-a"], [B, "lead-b"]]);
  assert.deepEqual(activeLeads(w.node, new Date(w.NOW + 400 * 86_400_000)), [], "past the expiry nothing is active");
  w.designate("lead-a2", A);
  assert.deepEqual(activeLeads(w.node, new Date(w.NOW)).filter((l) => l.project === A).map((l) => l.agent), ["lead-a2"], "the newest record for a project wins");
});
