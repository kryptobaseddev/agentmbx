// T495: a pruned generated mailbox hands its unread mail to its project's mailbox (AC1), and the project's current lead can move mail
// between mailboxes of its own project without the owner's signature (AC2) while every other caller, project, host and state still
// needs it (AC3). The audit row names who allowed each move (AC4).
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonical, fingerprint, generateKeyPair, signData } from "../src/crypto.ts";
import { createOwnerKey, unlockOwnerKey } from "../src/owner.ts";
import { IdentityLeases, inspectLeaseProcess } from "../src/identity-leases.ts";
import { applyPrune, authorizeLeadForward, isRetired, leadForward, pruneCandidates, reviveMailbox } from "../src/identity-cleanup.ts";
import { makeLead, makeLeadRevocation, revokeLead, storeLead } from "../src/lead-record.ts";
import { MbxNode } from "../src/node.ts";
import { pruneSummary } from "../src/doctor.ts";
import { allocateProjectMailbox, leadingReaders, projectKeysOf, projectsLedBy } from "../src/project-mailbox.ts";
import { recipientReceipts } from "../src/receipts.ts";
import { noteProject, registerIdentity } from "../src/registry.ts";
import { slotFor } from "../src/project-slot.ts";

const CLEO_A = "071b70b3-551d-44bb-b993-1e84bfa2fe09", CLEO_B = "5c0a8d52-1b3f-4a39-9d6e-0b8f6f1c2a77";
const tmp = (p: string) => mkdtempSync(join(tmpdir(), p));
const DAY = 86_400_000;
const GEN = (c: string) => `orbit-mcp-${c.repeat(16)}`; // a generated name (AUTO_NAME_RE)

/** One host, an owner it trusts, and two CLEO projects: A (the one under test) and B. */
function world(t: TestContext) {
  const n = new MbxNode(tmp("mbx-t495-"), { host: "testhost", bind: "127.0.0.1", port: 0 });
  createOwnerKey(n.home, "test-only-passphrase");
  const owner = unlockOwnerKey(n.home, "test-only-passphrase");
  t.after(() => { try { n.close(); } catch { /* closed by the test */ } rmSync(n.home, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); });
  const folderOf = (dirName: string, id: string | null) => {
    const dir = join(n.home, dirName);
    mkdirSync(join(dir, ".cleo"), { recursive: true });
    if (id) writeFileSync(join(dir, ".cleo", "project-id"), `# CLEO project id: write once, commit it\n${id}\n`);
    return realpathSync(dir);
  };
  const A = folderOf("alpha", CLEO_A), B = folderOf("beta", CLEO_B);
  const sign = (rec: unknown) => signData(owner.privateKey, canonical(rec));
  const lead = (project: string, agent: string, o: { now?: Date; host?: string } = {}) => {
    const rec = makeLead({ project, agent, host: o.host ?? n.host, ownerPub: owner.publicKey, now: o.now });
    return storeLead(n, rec, sign(rec));
  };
  /** A lease held by a live process, as an open session holds one. */
  const hold = (name: string, sid: string, pid = process.pid) => new IdentityLeases(n.store).claim(name, { pid, start: inspectLeaseProcess(pid).start!, keyFp: fingerprint(generateKeyPair().publicKey), cli: "claude", sessionId: sid });
  const mail = (to: string, subject = "m", from = "boss") => n.send({ from, to: [to], subject, body: subject }).envelope.id;
  const deliveriesOf = (id: string) => n.store.db.prepare("SELECT agent,state FROM deliveries WHERE msg_id=? ORDER BY agent").all(id).map((r) => ({ ...r })) as { agent: string; state: string }[];
  const audits = (kind: string) => (n.store.db.prepare("SELECT detail FROM audit WHERE event=? ORDER BY rowid").all(kind) as { detail: string }[]).map((r) => JSON.parse(r.detail) as Record<string, unknown>);
  /** Everything a mailbox name appears in; the long inactive period makes it prune-eligible. */
  const age = (name: string, days = 40) => {
    const at = new Date(Date.now() - days * DAY).toISOString();
    n.store.db.prepare("UPDATE deliveries SET updated_at=? WHERE agent=?").run(at, name);
    n.store.db.prepare("UPDATE agents SET last_seen=? WHERE name=?").run(at, name);
    n.store.db.prepare("UPDATE messages SET ts=?, received_at=?").run(at, at);
  };
  const member = (name: string, folder: string) => { n.registerAgent(name); noteProject(n.store, name, folder, true); };
  return { n, owner, A, B, sign, lead, hold, mail, deliveriesOf, audits, age, member };
}

// ── AC1: prune hands unread mail to the project mailbox ──────────────────────────────────────────────────

test("T495 AC1: a pruned generated mailbox's unread mail moves to its project mailbox, the mailbox is retired, and the old name still routes there", (t) => {
  const w = world(t);
  const { mailbox } = allocateProjectMailbox(w.n, w.A);
  const dead = GEN("a"), empty = GEN("b");
  w.member(dead, w.A); w.member(empty, w.A);
  const done = w.mail(dead, "already handled"); w.n.ack(done, dead);
  const unread1 = w.mail(dead, "one"), unread2 = w.mail(dead, "two");
  w.age(dead); w.age(empty); w.age("boss");

  const dry = pruneCandidates(w.n, { days: 7 });
  const row = dry.retire.find((r) => r.name === dead)!;
  assert.deepEqual(row.forward, { slot: mailbox.slot, label: "alpha", unread: 2 });
  assert.match(row.reason, /2 unread message\(s\) go to the project mailbox alpha/);
  assert.equal(dry.retire.find((r) => r.name === empty)!.forward, undefined, "a mailbox with no unread mail retires exactly as before");
  // A dry run moves nothing.
  assert.deepEqual(w.deliveriesOf(unread1), [{ agent: dead, state: "delivered" }]);
  assert.equal(isRetired(w.n, dead), false);

  assert.match(pruneSummary(w.n).label, /^2 generated mailbox\(es\) with no holder and no recent traffic would be retired \(1 with unread mail that goes to its project mailbox\)$/);
  const out = applyPrune(w.n, dry.retire, "test");
  assert.deepEqual(out, { retired: 2, forwarded: 2 });
  assert.deepEqual(w.deliveriesOf(unread1), [{ agent: mailbox.slot, state: "delivered" }], "the SAME message id, now in the project mailbox");
  assert.deepEqual(w.deliveriesOf(unread2), [{ agent: mailbox.slot, state: "delivered" }]);
  assert.deepEqual(w.deliveriesOf(done), [{ agent: dead, state: "acked" }], "acked history stays where it was");
  assert.equal(isRetired(w.n, dead), true); assert.equal(isRetired(w.n, empty), true);
  assert.equal(w.n.unreadCount(dead), 0);
  assert.equal(w.n.store.get(`alias:${dead}`), mailbox.slot, "the dead name routes to its project's mailbox from now on");
  assert.equal(w.n.store.get(`alias:${empty}`), undefined, "nothing to forward, no alias");
  assert.equal(w.n.store.db.prepare("SELECT 1 FROM messages WHERE id=?").get(unread1) !== undefined, true, "messages are never deleted");

  // AC4: the audit row names the authority and the project.
  const fwd = w.audits("identity.forward");
  assert.equal(fwd.length, 1);
  assert.deepEqual({ ...fwd[0], ids: undefined }, { from: dead, to: mailbox.slot, moved: 2, authority: "prune", project: CLEO_A, ids: undefined });
  assert.deepEqual([...(fwd[0]!.ids as string[])].sort(), [unread1, unread2].sort());
  assert.equal(w.audits("identity.retired").length, 2);

  // New mail to the old name lands in the project mailbox, not in a revived dead mailbox.
  const sent = w.n.send({ from: "boss", to: [dead], subject: "after the prune", body: "x" });
  assert.deepEqual(w.deliveriesOf(sent.envelope.id), [{ agent: mailbox.slot, state: "delivered" }]);
  // The sender is told where it went, by the project's name and never by the reserved slot name.
  const receipt = recipientReceipts(w.n, sent.envelope.id, sent.targets)[0]!;
  assert.equal(receipt.state, "forwarded");
  assert.match(receipt.detail, new RegExp(`^${dead} was renamed to the project mailbox alpha; `));
  assert.equal(receipt.detail.includes(mailbox.slot), false);
  // Prune is idempotent.
  assert.deepEqual(pruneCandidates(w.n, { days: 7 }).retire, []);
});

test("T495 AC1: a name that a session claims again drops the alias, so the project mailbox does not hijack a revived mailbox", (t) => {
  const w = world(t);
  const { mailbox } = allocateProjectMailbox(w.n, w.A);
  const dead = GEN("c");
  w.member(dead, w.A); w.mail(dead); w.age(dead); w.age("boss");
  applyPrune(w.n, pruneCandidates(w.n, { days: 7 }).retire, "test");
  assert.equal(w.n.store.get(`alias:${dead}`), mailbox.slot);
  assert.equal(w.deliveriesOf(w.mail(dead, "while nobody holds it")).map((d) => d.agent)[0], mailbox.slot);
  // A session explicitly claims the generated name again: binding it drops the alias, and the mailbox is un-retired.
  w.n.bindSession({ agent: dead, cli: "claude", session_id: "s-again", cwd: w.A, pid: process.pid });
  reviveMailbox(w.n, dead);
  assert.equal(w.n.store.get(`alias:${dead}`), undefined);
  const mine = w.mail(dead, "to the revived mailbox");
  assert.deepEqual(w.deliveriesOf(mine), [{ agent: dead, state: "delivered" }], "the revived mailbox gets it, not the project mailbox");
});

test("T495 AC1: unread mail still keeps a mailbox that has no project mailbox to go to, with the reason", (t) => {
  const w = world(t);
  const { mailbox } = allocateProjectMailbox(w.n, w.A);
  allocateProjectMailbox(w.n, w.B); // B has one too, so the several-projects case is about the binding, not the mailbox
  const noBinding = GEN("1"), twoProjects = GEN("2"), noMailbox = GEN("3"), elsewhere = GEN("4");
  w.n.registerAgent(noBinding);
  w.member(twoProjects, w.A); noteProject(w.n.store, twoProjects, w.B, true);
  const C = join(w.n.home, "gamma"); mkdirSync(join(C, ".cleo"), { recursive: true }); writeFileSync(join(C, ".cleo", "project-id"), "# id\n9d1f7a30-6b52-4c0e-8a41-3f2e5d7b9c10\n");
  w.member(noMailbox, realpathSync(C));
  // A project whose mailbox lives on another host: this host cannot hand mail to it.
  const D = join(w.n.home, "delta"); mkdirSync(join(D, ".cleo"), { recursive: true }); writeFileSync(join(D, ".cleo", "project-id"), "# id\n2a4c6e80-1357-4bdf-9a8c-0e2d4f6a8b10\n");
  const keyD = "2a4c6e80-1357-4bdf-9a8c-0e2d4f6a8b10";
  w.n.store.db.prepare("INSERT INTO project_mailboxes (key,slot,alias,home_host,source,folder,created_at) VALUES (?,?,?,?,?,?,?)").run(keyD, slotFor(keyD), "delta", "otherhost", "cleo", realpathSync(D), new Date().toISOString());
  w.member(elsewhere, realpathSync(D));
  for (const name of [noBinding, twoProjects, noMailbox, elsewhere]) { w.mail(name, `for ${name}`); w.age(name); }
  w.age("boss");

  const { retire, kept } = pruneCandidates(w.n, { days: 7 });
  assert.deepEqual(retire, []);
  const why = Object.fromEntries(kept.map((k) => [k.name, k.reason]));
  assert.match(why[noBinding]!, /^1 unread: forward it first \(agentmbx identity forward /);
  assert.match(why[twoProjects]!, /^1 unread: bound to 2 projects: forward it first/);
  assert.match(why[noMailbox]!, /^1 unread: its project has no project mailbox on testhost yet \(agentmbx lead set\), or forward it first/);
  assert.match(why[elsewhere]!, /^1 unread: its project has no project mailbox on testhost yet/);
  assert.deepEqual(applyPrune(w.n, retire, "test"), { retired: 0, forwarded: 0 });
  for (const name of [noBinding, twoProjects, noMailbox, elsewhere]) assert.equal(w.n.unreadCount(name), 1, `${name} keeps its mail`);
  assert.equal(w.n.store.db.prepare("SELECT count(*) n FROM deliveries WHERE agent=?").get(mailbox.slot)!.n, 0);
});

test("T495 AC1: the other prune gates still apply to a mailbox with unread mail: held, recently active, chosen name and registered stay", (t) => {
  const w = world(t);
  allocateProjectMailbox(w.n, w.A);
  const held = GEN("5"), active = GEN("6"), chosen = "orbit-lead", registered = GEN("7");
  for (const name of [held, active, registered]) w.member(name, w.A);
  w.member(chosen, w.A);
  for (const name of [held, active, chosen, registered]) w.mail(name);
  for (const name of [held, chosen, registered]) w.age(name);
  w.age("boss");
  // Held by a live session that has been quiet for 10 days: only the holder gate keeps it.
  w.n.store.db.prepare(`INSERT INTO identity_leases (name,token,holder_pid,holder_start,key_fp,cli,session_id,claimed_at,heartbeat_at,idle_ttl,released_at,release_reason)
    VALUES (?,'t',?, 'live','k','claude','s-held',?,?,?,NULL,NULL)`).run(held, process.pid, Date.now(), Date.now() - 10 * DAY, 40 * DAY);
  // `active` keeps its fresh traffic: it is recent. `registered` has a role.
  registerIdentity(w.n.store, { name: registered, role: "builder" });
  const { retire, kept } = pruneCandidates(w.n, { days: 7, inspect: () => ({ alive: true, start: "live" }) });
  assert.deepEqual(retire, []);
  const why = Object.fromEntries(kept.map((k) => [k.name, k.reason]));
  assert.match(why[held]!, /held by live claude session/); assert.match(why[active]!, /active within 7 days/);
  assert.equal(why[chosen], "chosen name"); assert.equal(why[registered], "registered");
  for (const name of [held, active, chosen, registered]) assert.equal(w.n.unreadCount(name), 1);
});

test("T495: projectKeysOf is a slot's own project, a persona's explicit bindings, and nothing for an unbound name", (t) => {
  const w = world(t);
  const { mailbox } = allocateProjectMailbox(w.n, w.A);
  w.member("p-one", w.A); w.member("p-two", w.A); noteProject(w.n.store, "p-two", w.B, true);
  w.n.registerAgent("loner");
  assert.deepEqual(projectKeysOf(w.n.store, mailbox.slot), [CLEO_A]);
  assert.deepEqual(projectKeysOf(w.n.store, "p-one"), [CLEO_A]);
  assert.deepEqual(projectKeysOf(w.n.store, "p-two"), [CLEO_A, CLEO_B].sort());
  assert.deepEqual(projectKeysOf(w.n.store, "loner"), []);
  // A folder with no CLEO id is its own key.
  const plain = join(w.n.home, "plain"); mkdirSync(plain); const real = realpathSync(plain);
  noteProject(w.n.store, "loner", real, true);
  assert.deepEqual(projectKeysOf(w.n.store, "loner"), [real]);
});

// ── AC2 / AC3: the lead's forward ────────────────────────────────────────────────────────────────────────

/** Project A with a mailbox, its lead alpha-lead (holding a lease), members alpha-w1..w3, and project B with its own lead and member. */
function leadWorld(t: TestContext) {
  const w = world(t);
  const holders: ReturnType<typeof spawn>[] = [];
  t.after(() => { for (const h of holders) h.kill("SIGKILL"); });
  const ls = new IdentityLeases(w.n.store);
  /** A real lease on its own live pid, so `withHeld` can observe a holder. */
  const lease = (name: string, cli = "claude") => {
    const child = spawn("sleep", ["600"], { stdio: "ignore" }); holders.push(child);
    return w.hold(name, `s-${name}`, child.pid!);
  };
  const boxA = allocateProjectMailbox(w.n, w.A).mailbox, boxB = allocateProjectMailbox(w.n, w.B).mailbox;
  for (const name of ["alpha-lead", "alpha-w1", "alpha-w2", "alpha-w3", "beta-lead", "beta-w1"]) w.n.registerAgent(name);
  for (const name of ["alpha-lead", "alpha-w1", "alpha-w2", "alpha-w3"]) noteProject(w.n.store, name, w.A, true);
  for (const name of ["beta-lead", "beta-w1"]) noteProject(w.n.store, name, w.B, true);
  w.n.registerAgent("alpha-both"); noteProject(w.n.store, "alpha-both", w.A, true); noteProject(w.n.store, "alpha-both", w.B, true);
  const leadRec = w.lead(w.A, "alpha-lead"); w.lead(w.B, "beta-lead");
  const tokens = new Map<string, string>();
  const as = <T>(name: string, fn: () => T): T => {
    if (!tokens.has(name)) tokens.set(name, lease(name).token);
    return ls.withHeld(name, tokens.get(name)!, fn);
  };
  const snapshot = () => JSON.stringify([
    w.n.store.db.prepare("SELECT msg_id,agent,state FROM deliveries ORDER BY msg_id,agent").all().map((r) => ({ ...r })),
    w.n.store.db.prepare("SELECT k,v FROM kv WHERE k LIKE 'alias:%' ORDER BY k").all().map((r) => ({ ...r })),
  ]);
  return { ...w, boxA, boxB, ls, lease, as, leadRec, snapshot };
}

test("T495 AC2: the project's current lead moves mail persona to persona, persona to project mailbox and project mailbox to persona, with no owner signature", (t) => {
  const w = leadWorld(t);
  const m1 = w.mail("alpha-w1", "one"), m2 = w.mail("alpha-w1", "two"), done = w.mail("alpha-w1", "done"); w.n.ack(done, "alpha-w1");
  const proj = w.mail("alpha", "project mail"); // hits the slot through the bare-name rewrite
  assert.deepEqual(w.deliveriesOf(proj), [{ agent: w.boxA.slot, state: "delivered" }]);

  // persona -> persona
  const r1 = w.as("alpha-lead", () => leadForward(w.n, "alpha-lead", "alpha-w1", "alpha-w2"));
  assert.deepEqual({ ...r1, ids: undefined }, { ok: true, moved: 2, ids: undefined, project: CLEO_A, label: "alpha" });
  assert.deepEqual(w.deliveriesOf(m1), [{ agent: "alpha-w2", state: "delivered" }], "the SAME message id, re-delivered");
  assert.deepEqual(w.deliveriesOf(done), [{ agent: "alpha-w1", state: "acked" }], "acked history stays");
  assert.equal(w.n.store.get("alias:alpha-w1"), "alpha-w2");
  assert.equal(w.n.store.db.prepare("SELECT count(*) n FROM messages WHERE id IN (?,?)").get(m1, m2)!.n, 2, "no forward envelope and no new message");

  // persona -> project mailbox (the alias follows)
  const m3 = w.mail("alpha-w3", "three");
  const r2 = w.as("alpha-lead", () => leadForward(w.n, "alpha-lead", "alpha-w3", w.boxA.slot));
  assert.equal(r2.ok, true);
  assert.deepEqual(w.deliveriesOf(m3), [{ agent: w.boxA.slot, state: "delivered" }]);
  assert.equal(w.n.store.get("alias:alpha-w3"), w.boxA.slot);

  // project mailbox -> persona: NO alias, future project mail keeps going to the project mailbox
  const r3 = w.as("alpha-lead", () => leadForward(w.n, "alpha-lead", w.boxA.slot, "alpha-w1"));
  assert.equal(r3.ok && r3.moved, 2, "the project mail and the one just moved in");
  assert.equal(w.n.store.get(`alias:${w.boxA.slot}`), undefined);
  assert.deepEqual(w.deliveriesOf(proj), [{ agent: "alpha-w1", state: "delivered" }]);
  assert.deepEqual(w.deliveriesOf(w.mail("alpha", "later project mail")), [{ agent: w.boxA.slot, state: "delivered" }]);

  // AC4: every move left an audit row naming who allowed it, which lead record, which project and which messages.
  const rows = w.audits("identity.forward");
  assert.equal(rows.length, 3);
  for (const r of rows) {
    assert.equal(r.authority, "lead"); assert.equal(r.lead, "alpha-lead@testhost"); assert.equal(r.project, CLEO_A); assert.equal(r.lead_record, w.leadRec.id);
  }
  assert.deepEqual(rows.map((r) => [r.from, r.to, r.moved]), [["alpha-w1", "alpha-w2", 2], ["alpha-w3", w.boxA.slot, 1], [w.boxA.slot, "alpha-w1", 2]]);
  assert.deepEqual([...(rows[0]!.ids as string[])].sort(), [m1, m2].sort());
  assert.equal(w.audits("identity.forward_refused").length, 0);
  // No owner approval was asked for or consumed.
  assert.equal(w.n.store.db.prepare("SELECT count(*) n FROM kv WHERE k LIKE 'forward-used:%'").get()!.n, 0);
  assert.equal(w.audits("identity.forward").some((r) => "owner_fp" in r || "approval" in r), false);
});

test("T495 AC3: nothing but the current lead's own lease moves mail: every other caller, project, host and state is refused and moves nothing", (t) => {
  const w = leadWorld(t);
  const m1 = w.mail("alpha-w1", "one"), mb = w.mail("beta-w1", "beta one");
  const refuse = (label: string, caller: string, from: string, to: string, why: RegExp, run: <T>(fn: () => T) => T = (fn) => w.as(caller, fn)) => {
    const before = w.snapshot(), audited = w.audits("identity.forward_refused").length;
    const r = run(() => leadForward(w.n, caller, from, to));
    assert.equal(r.ok, false, `${label}: must be refused`);
    assert.match((r as { reason: string }).reason, why, label);
    assert.equal(w.snapshot(), before, `${label}: moved nothing`);
    assert.equal(w.audits("identity.forward_refused").length, audited + 1, `${label}: the refusal is audited`);
    assert.equal(w.audits("identity.forward").length, 0, `${label}: and no move is recorded`);
  };

  // A role label is not a lead record; an ordinary member and a persona of another project are not the lead either.
  registerIdentity(w.n.store, { name: "alpha-decoy", role: "lead" }); w.n.registerAgent("alpha-decoy", { role: "lead" }); noteProject(w.n.store, "alpha-decoy", w.A, true);
  refuse("role-label decoy", "alpha-decoy", "alpha-w1", "alpha-w2", /not the current lead of any project/);
  refuse("an ordinary member", "alpha-w2", "alpha-w1", "alpha-lead", /not the current lead of any project/);
  // The lead of project B moves nothing of project A's, and nothing between A and B.
  refuse("the lead of another project", "beta-lead", "alpha-w1", "alpha-w2", /not both mailboxes of one project that beta-lead leads/);
  refuse("both projects at once", "alpha-lead", "alpha-w1", "beta-w1", /not both mailboxes of one project/);
  refuse("a target outside the project", "alpha-lead", "alpha-w1", "beta-lead", /not both mailboxes of one project/);
  refuse("a source outside the project", "alpha-lead", "beta-w1", "alpha-w2", /not both mailboxes of one project/);
  // A persona that also works for another project, as source or as target, stays owner-only.
  refuse("a multi-project source", "alpha-lead", "alpha-both", "alpha-w2", /not both mailboxes of one project/);
  refuse("a multi-project target", "alpha-lead", "alpha-w1", "alpha-both", /not both mailboxes of one project/);
  // A name with no binding at all, and one that is not a mailbox.
  w.n.registerAgent("alpha-unbound");
  refuse("an unbound persona", "alpha-lead", "alpha-unbound", "alpha-w2", /not both mailboxes of one project/);
  noteProject(w.n.store, "alpha-ghost", w.A, true); // bound to the project but never a mailbox on this host
  refuse("a target that is not a mailbox here", "alpha-lead", "alpha-w3", "alpha-ghost", /alpha-ghost is not a mailbox on testhost/);
  refuse("the same mailbox twice", "alpha-lead", "alpha-w1", "alpha-w1", /two different mailboxes/);
  refuse("slot to another slot", "alpha-lead", w.boxA.slot, w.boxB.slot, /another project mailbox/);
  refuse("slot of another project", "alpha-lead", "alpha-w1", w.boxB.slot, /not both mailboxes of one project/);
  // A live session holds the source: its own session should rename itself.
  const holder = spawn("sleep", ["600"], { stdio: "ignore" }); t.after(() => holder.kill("SIGKILL"));
  w.hold("alpha-w1", "s-w1", holder.pid!);
  refuse("a live-held source", "alpha-lead", "alpha-w1", "alpha-w2", /alpha-w1 is held by live claude session/);
  // Outside the caller's own lease: a plain call, a read-only lease, and another persona's lease.
  const bare = w.snapshot(), bareAudits = w.audits("identity.forward_refused").length;
  const noLease = leadForward(w.n, "alpha-lead", "alpha-w3", "alpha-w1");
  assert.equal(noLease.ok, false); assert.match((noLease as { reason: string }).reason, /not running inside the caller's own session lease/);
  assert.equal(w.snapshot(), bare); assert.equal(w.audits("identity.forward_refused").length, bareAudits + 1);
  const leadToken = w.as("alpha-lead", () => w.n.store.db.prepare("SELECT token FROM identity_leases WHERE name=?").get("alpha-lead")!.token as string);
  const readOnly = w.ls.withHeldRead("alpha-lead", leadToken, () => authorizeLeadForward(w.n, "alpha-lead", "alpha-w3", "alpha-w1"));
  assert.equal(readOnly.ok, false, "a read-only scope is not a write scope"); assert.match((readOnly as { reason: string }).reason, /not running inside the caller's own session lease/);
  assert.equal(w.ls.withHeld("alpha-lead", leadToken, () => authorizeLeadForward(w.n, "alpha-lead", "alpha-w3", "alpha-w1").ok), true, "the same check passes in the write scope");
  const borrowed = w.as("alpha-w2", () => leadForward(w.n, "alpha-lead", "alpha-w3", "alpha-w1"));
  assert.equal(borrowed.ok, false, "another persona's lease does not speak for the lead"); assert.match((borrowed as { reason: string }).reason, /not running inside the caller's own session lease/);
  assert.deepEqual(w.deliveriesOf(m1), [{ agent: "alpha-w1", state: "delivered" }]); assert.deepEqual(w.deliveriesOf(mb), [{ agent: "beta-w1", state: "delivered" }]);
});

test("T495 AC3: an expired, revoked, replaced or other-host lead record is not a lead, and the fence holds between the check and the move", (t) => {
  const w = leadWorld(t);
  w.mail("alpha-w1", "one");
  const attempt = () => w.as("alpha-lead", () => leadForward(w.n, "alpha-lead", "alpha-w1", "alpha-w2"));
  const ok = (): boolean => attempt().ok;
  const reset = () => { w.n.store.db.prepare("UPDATE deliveries SET agent='alpha-w1' WHERE agent='alpha-w2'").run(); w.n.store.db.prepare("DELETE FROM kv WHERE k='alias:alpha-w1'").run(); };
  const spent = (label: string, designate: () => void) => { designate(); assert.equal(ok(), false, label); assert.equal(w.deliveriesOf(w.n.store.db.prepare("SELECT id FROM messages").get()!.id as string)[0]?.agent, "alpha-w1", `${label}: moved nothing`); };

  // Replaced: a newer record names someone else, so the previous lead is no longer one.
  const second = w.lead(w.A, "alpha-w2");
  assert.equal(ok(), false, "replaced by another lead");
  assert.deepEqual(projectsLedBy(w.n, "alpha-lead").map((m) => m.key), [], "and the single lookup agrees");
  // T562: a revoked replacement stays the head; the prior designation never silently regains authority.
  const rv2 = makeLeadRevocation(second.id, w.owner.publicKey); revokeLead(w.n, rv2, w.sign(rv2));
  assert.equal(ok(), false, "revoking the replacement leaves no lead instead of reviving the prior designation");
  reset();
  const rv1 = makeLeadRevocation(w.leadRec.id, w.owner.publicKey); revokeLead(w.n, rv1, w.sign(rv1));
  assert.equal(ok(), false, "revoked");
  // Re-designated for the old lead it works again; designated for another host it does not; expired it does not.
  w.lead(w.A, "alpha-lead"); assert.equal(ok(), true, "a fresh record");
  reset();
  spent("designated for another host", () => { const rec = makeLead({ project: w.A, agent: "alpha-lead", host: "elsewhere", ownerPub: w.owner.publicKey, now: new Date(Date.now() + 1000) }); storeLead(w.n, rec, w.sign(rec)); });
  spent("expired", () => { const rec = makeLead({ project: w.A, agent: "alpha-lead", host: "testhost", ownerPub: w.owner.publicKey, now: new Date(Date.now() - 400 * DAY) }); storeLead(w.n, rec, w.sign(rec)); });

  // The fence: authorised a moment ago, replaced before the move. The move re-checks inside its own transaction.
  const w2 = leadWorld(t);
  const id = w2.mail("alpha-w1", "one");
  w2.as("alpha-lead", () => {
    assert.equal(authorizeLeadForward(w2.n, "alpha-lead", "alpha-w1", "alpha-w2").ok, true, "authorised");
    w2.lead(w2.A, "alpha-w2"); // the owner replaces the lead right now
    const r = leadForward(w2.n, "alpha-lead", "alpha-w1", "alpha-w2");
    assert.equal(r.ok, false, "the move did not trust the earlier check");
  });
  assert.deepEqual(w2.deliveriesOf(id), [{ agent: "alpha-w1", state: "delivered" }]);
  assert.equal(leadingReaders(w2.n, "alpha-lead").length, 0);

  // The real race: the owner replaces the lead AFTER leadForward's early look and BEFORE its transaction opens. Single-threaded code cannot
  // interleave that, so the transaction is interposed: the replacement lands in the gap, and the move must notice it inside the transaction.
  const w3 = leadWorld(t);
  const id3 = w3.mail("alpha-w1", "one");
  w3.as("alpha-lead", () => {
    const store = w3.n.store as unknown as { tx: (fn: () => unknown) => unknown };
    const real = store.tx.bind(store);
    store.tx = (fn) => { store.tx = real; w3.lead(w3.A, "alpha-w2"); return real(fn); };
    const r = leadForward(w3.n, "alpha-lead", "alpha-w1", "alpha-w2");
    assert.equal(r.ok, false, "the authority was re-checked inside the transaction, after the replacement");
  });
  assert.deepEqual(w3.deliveriesOf(id3), [{ agent: "alpha-w1", state: "delivered" }], "and nothing moved");
  assert.equal(w3.audits("identity.forward").length, 0);
});
