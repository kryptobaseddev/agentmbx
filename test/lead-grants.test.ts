// T499: owner-signed grants carried by a project lead record. AC1 format, AC2 how the lead approves, AC3 taint/expiry/revocation, AC4 audit.
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonical, fingerprint, generateKeyPair, signData, ulid } from "../src/crypto.ts";
import { IdentityLeases, inspectLeaseProcess } from "../src/identity-leases.ts";
import { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { activeLead, makeLead, makeLeadRevocation, revokeLead, storeLead, type LeadRecord } from "../src/lead-record.ts";
import { DELEGABLE_CLASSES, leadGrantFor, leadGrantsView, makeLeadGrants, storeLeadGrants, verifiedLeadGrants, withLeadGrants, type LeadGrants } from "../src/lead-grants.ts";
import { MbxNode } from "../src/node.ts";
import { approveKimi, decidePermission, type Lookup } from "../src/permission.ts";
import { acceptSigned, hasClass, makePolicy, makeRevocation } from "../src/policy.ts";
import { noteProject } from "../src/registry.ts";
import { taintKey, writeSessionTaint } from "../src/session-taint.ts";

process.env.GIT_CONFIG_GLOBAL = "/dev/null";
process.env.GIT_CONFIG_NOSYSTEM = "1";
delete process.env.GIT_CONFIG_COUNT;
delete process.env.GIT_CONFIG_PARAMETERS;

const H = 3_600_000;
/** A frozen copy of the strict v1 lead-record schema as shipped before T499: what an older, still-running reader parses with. */
const OldLeadRecord = z.object({
  v: z.literal(1), type: z.literal("lead"), id: z.string().min(10).max(40), project: z.string().min(1).max(1024),
  agent: z.string().regex(/^[a-z0-9][a-z0-9-]{1,39}$/), host: z.string().min(1).max(40), iat: z.string().datetime(), exp: z.string().datetime(),
  owner_fp: z.string().min(4).max(64),
}).strict();
const git = (cwd: string, ...a: string[]) => execFileSync("git", a, { cwd, stdio: "ignore" });
/** A work tree with a feature branch and an origin it can push to, so the hook's Git preflight has something real to inspect. */
function repo(dir: string): string {
  mkdirSync(dir, { recursive: true });
  const cwd = realpathSync(dir);
  git(cwd, "init", "-b", "trunk");
  git(cwd, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--allow-empty", "-m", "fixture");
  git(cwd, "branch", "feature"); git(cwd, "clone", "--bare", cwd, join(cwd, "remote.git")); git(cwd, "remote", "add", "origin", join(cwd, "remote.git"));
  return cwd;
}

function world(t: TestContext, opt: { members?: string[] } = {}) {
  const n = new MbxNode(mkdtempSync(join(tmpdir(), "mbx-lead-grants-")), { host: "testhost", bind: "127.0.0.1", port: 0 });
  const owner = generateKeyPair(), peer = generateKeyPair();
  t.after(() => { try { n.close(); } catch { /* a test that reopened the store already closed it */ } rmSync(n.home, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); });
  n.addApprovedPeer({ host: "ownerhost", pubkey: peer.publicKey, owner_pubkey: owner.publicKey, addr: "127.0.0.1:1" }, "test");
  n.adoptOwner("ownerhost");
  const cwd = repo(join(n.home, "proj"));
  for (const name of ["lead", "api-dev", "web-dev", "other"]) n.registerAgent(name);
  for (const m of opt.members ?? ["api-dev", "web-dev"]) noteProject(n.store, m, cwd, true);
  const sign = (rec: unknown) => signData(owner.privateKey, canonical(rec));
  const lead = (o: { ttlMs?: number; now?: Date; project?: string; agent?: string } = {}) => {
    const rec = makeLead({ project: o.project ?? cwd, agent: o.agent ?? "lead", host: n.host, ownerPub: owner.publicKey, ttlMs: o.ttlMs, now: o.now });
    return storeLead(n, rec, sign(rec));
  };
  const grant = (l: LeadRecord, agents: string[] = ["api-dev"], o: { classes?: string[]; ttlMs?: number; now?: Date } = {}) => {
    const g = makeLeadGrants({ lead: l, classes: o.classes ?? ["outward-reversible"], agents, ownerPub: owner.publicKey, ttlMs: o.ttlMs, now: o.now });
    storeLeadGrants(n, g, sign(g), o.now);
    return g;
  };
  /** A bound session on its own pid: the persona on this process, the lead on its parent, as two separate CLIs would be. */
  const bind = (agent: string, cli: string, sid: string, dir = cwd, pid = process.pid) => {
    const key = generateKeyPair();
    new IdentityLeases(n.store).claim(agent, { pid, start: inspectLeaseProcess(pid).start!, keyFp: fingerprint(key.publicKey), cli, sessionId: sid });
    n.bindSession({ agent, cli, session_id: sid, cwd: dir, pid, session_key: key.publicKey });
  };
  const own: Lookup = (agent, ctx) => hasClass(n.store.db, agent, n.host, ctx?.class ?? "permissions", { cwd: ctx?.cwd });
  const lookup = withLeadGrants(n, own);
  const input = (command: string, dir = cwd, extra: Record<string, unknown> = {}) =>
    ({ session_id: "s1", cwd: dir, hook_event_name: "PermissionRequest", tool_name: "Bash", tool_input: { command }, ...extra });
  const ask = (command = "git push origin feature", cli = "claude", dir = cwd) => decidePermission(input(command, dir), cli, lookup, { node: n, pid: process.pid });
  const used = () => (n.store.db.prepare("SELECT detail FROM audit WHERE event='lead.grant_used'").all() as { detail: string }[]).map((r) => JSON.parse(r.detail));
  const taint = (cli: string, sid: string, rootAgo = 0) => writeSessionTaint(n.store, { v: 1, cli, session_id: sid, root: Date.now() - rootAgo, from: "outside", id: "message_test", how: "declared", relay_depth: [] });
  const row = (id: string) => n.store.db.prepare("SELECT record, sig, grants, grants_sig FROM project_leads WHERE id=?").get(id) as { record: string; sig: string; grants: string | null; grants_sig: string | null };
  /** The lead is live and its heartbeat outlasts the test clock jumps below, so only the thing under test can end a grant. */
  const keepAlive = () => n.store.db.prepare("UPDATE identity_leases SET idle_ttl=?, heartbeat_at=? WHERE name='lead'").run(10 * 365 * 24 * H, Date.now());
  return { n, owner, cwd, sign, lead, grant, bind, own, lookup, input, ask, used, taint, row, keepAlive, ppid: process.ppid };
}

/** The standard live setup: lead live on the parent pid, persona bound, grants naming api-dev. */
function live(t: TestContext, personaCli = "claude") {
  const w = world(t);
  const l = w.lead(); const g = w.grant(l);
  w.bind("lead", "claude", "lead-s1", w.cwd, w.ppid); w.bind("api-dev", personaCli, "s1");
  return { ...w, l, g };
}

// ── AC1: format ─────────────────────────────────────────────────────────────────────────────────────────────

test("T499 AC1: the grants are a second signed blob; the signed lead record stays byte-identical and an older strict reader still sees the lead", (t) => {
  const w = world(t);
  const l = w.lead();
  const before = w.row(l.id);
  const g = w.grant(l, ["api-dev", "web-dev"]);
  const after = w.row(l.id);
  assert.equal(after.record, before.record); assert.equal(after.sig, before.sig);
  assert.equal(after.grants, JSON.stringify(g)); assert.ok(after.grants_sig);
  assert.deepEqual(Object.keys(JSON.parse(after.record)).sort(), ["agent", "exp", "host", "iat", "id", "owner_fp", "project", "type", "v"]);
  // The pre-change reader: the strict v1 schema over the lead record, and a query that names only the pre-change columns.
  const old = w.n.store.db.prepare("SELECT record,sig,revocation,revocation_sig FROM project_leads WHERE project=? ORDER BY id DESC").all(w.cwd) as { record: string }[];
  assert.equal(OldLeadRecord.safeParse(JSON.parse(old[0]!.record)).success, true);
  assert.equal(OldLeadRecord.safeParse({ ...JSON.parse(old[0]!.record), grants: {} }).success, false, "the reason the grants are not inside the record");
  assert.equal(activeLead(w.n, w.cwd)?.id, l.id);
  assert.deepEqual(verifiedLeadGrants(w.n, l)?.agents, ["api-dev", "web-dev"]);
});

test("T499 AC1: a store from before this change gains the columns and keeps its leads", (t) => {
  const w = world(t);
  const l = w.lead();
  const home = w.n.home;
  w.n.close();
  const db = new DatabaseSync(join(home, "mbx.db"));
  db.exec("ALTER TABLE project_leads DROP COLUMN grants; ALTER TABLE project_leads DROP COLUMN grants_sig;");
  db.close();
  const again = new MbxNode(home, { host: "testhost", bind: "127.0.0.1", port: 0 });
  t.after(() => again.close());
  const cols = (again.store.db.prepare("PRAGMA table_info(project_leads)").all() as { name: string }[]).map((c) => c.name);
  assert.ok(cols.includes("grants") && cols.includes("grants_sig"));
  assert.equal(activeLead(again, w.cwd)?.id, l.id);
});

test("T499 AC1: only outward-reversible can be delegated; read, edit, outward, permissions and unknown classes are refused with the reason", (t) => {
  const w = world(t);
  const l = w.lead();
  assert.deepEqual([...DELEGABLE_CLASSES], ["outward-reversible"]);
  for (const [cls, why] of [["read", /no enforcement point/], ["edit", /no enforcement point/], ["outward", /never delegated/], ["permissions", /never delegated/], ["frobnicate", /unknown class/]] as const) {
    assert.throws(() => makeLeadGrants({ lead: l, classes: [cls], agents: ["api-dev"], ownerPub: w.owner.publicKey }), why, cls);
    // Not only at make time: a hand-built, correctly signed blob is refused on store too.
    const g = { v: 1, type: "lead-grants", id: ulid(), lead: l.id, classes: [cls], agents: ["api-dev"], iat: new Date().toISOString(), exp: new Date(Date.now() + H).toISOString(), owner_fp: fingerprint(w.owner.publicKey) };
    assert.throws(() => storeLeadGrants(w.n, g, w.sign(g)), why, `store ${cls}`);
  }
  assert.throws(() => makeLeadGrants({ lead: l, classes: ["outward-reversible", "edit"], agents: ["api-dev"], ownerPub: w.owner.publicKey }), /no enforcement point/);
});

test("T499 AC1: a grants blob is refused unless owner-signed, bound to the current record, bounded by it, named and unique", (t) => {
  const w = world(t);
  const l = w.lead({ ttlMs: 48 * H });
  const base = (over: Record<string, unknown> = {}): Record<string, unknown> => ({ v: 1, type: "lead-grants", id: ulid(), lead: l.id, classes: ["outward-reversible"], agents: ["api-dev"],
    iat: new Date().toISOString(), exp: new Date(Date.now() + H).toISOString(), owner_fp: fingerprint(w.owner.publicKey), ...over });
  const store = (rec: Record<string, unknown>, sig = w.sign(rec)) => storeLeadGrants(w.n, rec, sig);
  const stranger = generateKeyPair();
  assert.throws(() => store(base(), w.sign({ other: 1 })), /not signed by an owner key/, "forged signature");
  assert.throws(() => store(base({ owner_fp: fingerprint(stranger.publicKey) }), signData(stranger.privateKey, canonical(base()))), /not signed by an owner key/, "foreign owner");
  assert.throws(() => store(base({ lead: "01ZZZZZZZZZZZZZZZZZZZZZZZZ" })), /no lead record/, "unknown record");
  assert.throws(() => store(base({ exp: new Date(Date.parse(l.exp) + H).toISOString(), iat: new Date(Date.now() - 6 * H).toISOString() })), /cannot outlive the lead record/, "beyond the lead");
  assert.throws(() => store(base({ agents: [] })), /invalid lead grants/, "empty agents");
  assert.throws(() => store(base({ agents: ["*", "api-dev"] })), /only agent selector/, "* mixed");
  assert.throws(() => store(base({ agents: ["Not A Name!"] })), /not a mailbox name/, "bad name");
  assert.throws(() => store(base({ exp: new Date(Date.now() - H).toISOString(), iat: new Date(Date.now() - 2 * H).toISOString() })), /already expired/, "expired");
  assert.throws(() => store(base({ extra: 1 })), /invalid lead grants/, "strict: extra key");
  const long = w.lead({ ttlMs: 90 * 24 * H, project: join(w.n.home, "other") });
  assert.throws(() => makeLeadGrants({ lead: long, classes: ["outward-reversible"], agents: ["api-dev"], ownerPub: w.owner.publicKey, ttlMs: 31 * 24 * H }), /at most 720 h/, "30 day cap");
  assert.equal(makeLeadGrants({ lead: long, classes: ["outward-reversible"], agents: ["api-dev"], ownerPub: w.owner.publicKey }).exp.slice(0, 10) <= new Date(Date.now() + 720 * H).toISOString().slice(0, 10), true, "default ttl is capped");
  // The accepted case, then a second blob for the same record.
  store(base());
  assert.throws(() => store(base()), /already carries grants/, "second blob");
  // A superseded record that never had grants, and a revoked one, cannot be given any.
  const old = w.lead({ project: join(w.n.home, "p2"), now: new Date(Date.now() - 2000) });
  const next = w.lead({ project: join(w.n.home, "p2"), now: new Date(Date.now() + 1000) });
  assert.throws(() => store(base({ lead: old.id })), /not the project's current lead record/, "superseded record");
  assert.equal(w.row(old.id).grants, null);
  const rv = makeLeadRevocation(next.id, w.owner.publicKey); revokeLead(w.n, rv, w.sign(rv));
  assert.throws(() => store(base({ lead: next.id })), /not the project's current lead record|no active/, "revoked record");
  assert.equal(w.row(next.id).grants, null);
});

test("T499 AC1: a stored blob that was edited, re-pointed or signed by someone else gives no authority", (t) => {
  const w = live(t);
  const db = w.n.store.db;
  const orig = w.row(w.l.id);
  const mutate = (grants: string | null, sig: string | null = orig.grants_sig) => db.prepare("UPDATE project_leads SET grants=?, grants_sig=? WHERE id=?").run(grants, sig, w.l.id);
  const probe = () => leadGrantFor(w.n, "api-dev", { cwd: w.cwd, class: "outward-reversible" }).ok;
  assert.equal(probe(), true);
  mutate(JSON.stringify({ ...JSON.parse(orig.grants!), agents: ["api-dev", "web-dev"] })); assert.equal(probe(), false, "tampered agents");
  mutate(JSON.stringify({ ...JSON.parse(orig.grants!), classes: ["outward"] })); assert.equal(probe(), false, "tampered class");
  mutate(JSON.stringify({ ...JSON.parse(orig.grants!), lead: "01ZZZZZZZZZZZZZZZZZZZZZZZZ" })); assert.equal(probe(), false, "re-pointed");
  mutate(orig.grants, "AAAA"); assert.equal(probe(), false, "bad signature");
  mutate("{not json"); assert.equal(probe(), false, "corrupt");
  mutate(orig.grants); assert.equal(probe(), true, "restored");
});

test("T499 AC1: a correctly signed blob copied onto a different lead record gives nothing there", (t) => {
  const w = live(t);
  const p2 = join(w.n.home, "proj2"); mkdirSync(p2, { recursive: true });
  noteProject(w.n.store, "api-dev", p2, true);
  const l2 = w.lead({ project: p2 });
  assert.equal(leadGrantFor(w.n, "api-dev", { cwd: p2, class: "outward-reversible" }).ok, false, "no grants of its own");
  const src = w.row(w.l.id);
  w.n.store.db.prepare("UPDATE project_leads SET grants=?, grants_sig=? WHERE id=?").run(src.grants, src.grants_sig, l2.id);
  assert.equal(leadGrantFor(w.n, "api-dev", { cwd: p2, class: "outward-reversible" }).ok, false, "the blob names another record");
  assert.equal(leadGrantFor(w.n, "api-dev", { cwd: w.cwd, class: "outward-reversible" }).ok, true, "and still works on its own record");
});

test("T499 AC1: a signed blob that breaks the rules is refused on use too, not only on store (a row written behind the CLI)", (t) => {
  const w = world(t);
  const l = w.lead({ ttlMs: 90 * 24 * H });
  w.bind("lead", "claude", "lead-s1", w.cwd, w.ppid); w.keepAlive();
  const inject = (over: Record<string, unknown>) => {
    const g = { v: 1, type: "lead-grants", id: ulid(), lead: l.id, classes: ["outward-reversible"], agents: ["api-dev"], iat: new Date().toISOString(),
      exp: new Date(Date.now() + H).toISOString(), owner_fp: fingerprint(w.owner.publicKey), ...over };
    w.n.store.db.prepare("UPDATE project_leads SET grants=?, grants_sig=? WHERE id=?").run(JSON.stringify(g), w.sign(g), l.id);
    return leadGrantFor(w.n, "api-dev", { cwd: w.cwd, class: "outward-reversible" }).ok;
  };
  assert.equal(inject({}), true, "the injection itself works");
  assert.equal(inject({ classes: ["outward-reversible", "permissions"] }), false, "permissions");
  assert.equal(inject({ classes: ["outward-reversible", "edit"] }), false, "edit");
  assert.equal(inject({ classes: ["outward-reversible", "outward"] }), false, "outward");
  assert.equal(inject({ agents: ["*", "api-dev"] }), false, "* mixed with names");
  assert.equal(inject({ agents: ["api-dev", "api-dev"] }), false, "duplicate names");
  assert.equal(inject({ iat: new Date(Date.now() - 31 * 24 * H).toISOString() }), false, "longer than 30 days");
  assert.equal(inject({ exp: new Date(Date.now() - H).toISOString(), iat: new Date(Date.now() - 2 * H).toISOString() }), false, "expired");
  assert.equal(inject({ exp: new Date(Date.parse(l.exp) + H).toISOString() }), false, "past the lead record");
  assert.equal(inject({}), true, "and a clean one works again");
});

test("T499 AC1: with two trusted owners, grants must come from the owner who signed the lead record", (t) => {
  const w = world(t);
  const l = w.lead();
  const owner2 = generateKeyPair();
  w.n.store.db.prepare("INSERT INTO principals (fp,pub,role,label,via,added_at,peer) VALUES (?,?,'owner',NULL,?,?,?)").run(fingerprint(owner2.publicKey), owner2.publicKey, "pair:second", new Date().toISOString(), "second");
  const g = makeLeadGrants({ lead: l, classes: ["outward-reversible"], agents: ["api-dev"], ownerPub: owner2.publicKey });
  assert.throws(() => storeLeadGrants(w.n, g, signData(owner2.privateKey, canonical(g))), /same owner as the lead record/, "stored by another owner");
  w.bind("lead", "claude", "lead-s1", w.cwd, w.ppid);
  w.n.store.db.prepare("UPDATE project_leads SET grants=?, grants_sig=? WHERE id=?").run(JSON.stringify(g), signData(owner2.privateKey, canonical(g)), l.id);
  assert.equal(leadGrantFor(w.n, "api-dev", { cwd: w.cwd, class: "outward-reversible" }).ok, false, "injected");
  // The kill switch follows policy.ts: it ends records of the owner who signed it. A second owner's does not end the first owner's grants.
  const w2 = live(t);
  const o2 = generateKeyPair();
  w2.n.store.db.prepare("INSERT INTO principals (fp,pub,role,label,via,added_at,peer) VALUES (?,?,'owner',NULL,?,?,?)").run(fingerprint(o2.publicKey), o2.publicKey, "pair:second", new Date().toISOString(), "second");
  const rv = makeRevocation("*", o2.publicKey, new Date(Date.parse(w2.g.iat) + 1000));
  assert.equal(acceptSigned(w2.n.store.db, { rec: rv, sig: signData(o2.privateKey, canonical(rv)) }, w2.n.host), null);
  assert.equal(leadGrantFor(w2.n, "api-dev", { cwd: w2.cwd, class: "outward-reversible" }).ok, true, "another owner's kill switch");
});

test("T499 AC3: a kill switch only counts when its signature verifies", (t) => {
  const w = live(t);
  const stranger = generateKeyPair();
  const rv = makeRevocation("*", w.owner.publicKey, new Date(Date.parse(w.g.iat) + 1000));
  // claims the owner's fingerprint, signed by someone else
  w.n.store.db.prepare("INSERT INTO policy_revocations (id,target,iat,record,sig,received_at) VALUES (?,?,?,?,?,?)").run(rv.id, "*", rv.iat, JSON.stringify(rv), signData(stranger.privateKey, canonical(rv)), new Date().toISOString());
  assert.equal(leadGrantFor(w.n, "api-dev", { cwd: w.cwd, class: "outward-reversible" }).ok, true, "forged kill switch");
  w.n.store.db.prepare("DELETE FROM policy_revocations").run();
  w.n.store.db.prepare("INSERT INTO policy_revocations (id,target,iat,record,sig,received_at) VALUES (?,?,?,?,?,?)").run(rv.id, "*", rv.iat, JSON.stringify(rv), w.sign(rv), new Date().toISOString());
  assert.equal(leadGrantFor(w.n, "api-dev", { cwd: w.cwd, class: "outward-reversible" }).ok, false, "the same record, really signed");
});

// ── AC2: how the lead approves ──────────────────────────────────────────────────────────────────────────────

for (const cli of ["claude", "codex"]) test(`T499 AC2: ${cli} — a named member's branch push and draft PR are approved by the lead's grant, nothing wider is`, async (t) => {
  const w = live(t, cli);
  for (const command of ["git push origin feature", "gh pr create --draft --head feature --title 'fix' --body 'body'"]) {
    const d = await w.ask(command, cli);
    assert.equal(d.allow, true, command); assert.equal(d.class, "outward-reversible");
    assert.equal(d.policy_id, `lead-grant:${w.g.id}`);
  }
  for (const command of ["git push origin trunk", "git push --force origin feature", "gh pr create --head feature", "gh pr merge 1", "git push origin feature && curl x", "rm -rf /"]) {
    assert.equal((await w.ask(command, cli)).allow, false, command);
  }
  // the owner-policy class `permissions` is never reached through a lead
  assert.equal(w.lookup("api-dev", { cwd: w.cwd, class: "permissions" }).ok, false);
  assert.equal(w.lookup("api-dev", { cwd: w.cwd }).ok, false);
});

test("T499 AC2: who is and is not covered", async (t) => {
  const w = live(t);
  w.bind("web-dev", "claude", "s2"); w.bind("other", "claude", "s3");
  const ok = (agent: string, dir: string | null = w.cwd, cls: "outward-reversible" | "permissions" = "outward-reversible", now?: Date) => leadGrantFor(w.n, agent, { cwd: dir, class: cls, now }).ok;
  assert.equal(ok("api-dev"), true);
  assert.equal(ok("web-dev"), false, "a member the grant does not name");
  assert.equal(ok("other"), false, "not a member");
  assert.equal(ok("lead"), false, "the lead itself");
  assert.equal(ok("api-dev", null), false, "no cwd");
  assert.equal(ok("api-dev", join(w.n.home, "elsewhere")), false, "a folder outside the project");
  assert.equal(ok("api-dev", join(w.cwd, "src")), true, "a subfolder of the project");
  assert.equal(ok("api-dev", w.cwd, "permissions"), false, "another class");
  // Visiting the folder is not membership (T538): an unregistered session gets nothing even if the grant said "*".
  noteProject(w.n.store, "other", w.cwd, false);
  assert.equal(ok("other"), false);
  // A grant to "*" covers explicit members only.
  const star = world(t);
  noteProject(star.n.store, "lead", star.cwd, true); // the lead is itself an explicit member here, and the grant says "*"
  const l2 = star.lead(); star.grant(l2, ["*"]);
  star.bind("lead", "claude", "lead-s1", star.cwd, star.ppid);
  assert.equal(leadGrantFor(star.n, "api-dev", { cwd: star.cwd, class: "outward-reversible" }).ok, true);
  assert.equal(leadGrantFor(star.n, "other", { cwd: star.cwd, class: "outward-reversible" }).ok, false);
  assert.equal(leadGrantFor(star.n, "lead", { cwd: star.cwd, class: "outward-reversible" }).ok, false);
});

test("T499 AC2: another checkout of the same CLEO project is covered; a lead on another host or with no grants is not", async (t) => {
  const w = world(t, { members: [] });
  const a = join(w.n.home, "checkout-a"), b = join(w.n.home, "checkout-b");
  for (const d of [a, b]) { repo(d); mkdirSync(join(d, ".cleo"), { recursive: true }); writeFileSync(join(d, ".cleo", "project-id"), "T499-shared-id\n"); }
  const ra = realpathSync(a), rb = realpathSync(b);
  noteProject(w.n.store, "api-dev", rb, true);
  const l = w.lead({ project: ra }); w.grant(l);
  w.bind("lead", "claude", "lead-s1", ra, w.ppid); w.bind("api-dev", "claude", "s1", rb);
  assert.equal((await w.ask("git push origin feature", "claude", rb)).allow, true, "the member's own checkout of the lead's project");
  // Registered at checkout B, working in a third checkout of the same CLEO project: the shared key covers it.
  const c = join(w.n.home, "checkout-c"); mkdirSync(join(c, ".cleo"), { recursive: true }); writeFileSync(join(c, ".cleo", "project-id"), "T499-shared-id\n");
  assert.equal(leadGrantFor(w.n, "api-dev", { cwd: realpathSync(c), class: "outward-reversible" }).ok, true, "a third checkout");
  const unrelated = join(w.n.home, "checkout-d"); mkdirSync(join(unrelated, ".cleo"), { recursive: true }); writeFileSync(join(unrelated, ".cleo", "project-id"), "some-other-project\n");
  assert.equal(leadGrantFor(w.n, "api-dev", { cwd: realpathSync(unrelated), class: "outward-reversible" }).ok, false, "a different CLEO project");
  // No grants on a lead record: nothing.
  const bare = world(t); const l2 = bare.lead(); bare.bind("lead", "claude", "lead-s1", bare.cwd, bare.ppid);
  assert.equal(leadGrantFor(bare.n, "api-dev", { cwd: bare.cwd, class: "outward-reversible" }).ok, false);
  assert.equal(leadGrantsView(bare.n, l2).state, "none");
  // A lead designated on another host never grants here: its taint is not visible.
  const far = world(t); far.bind("lead", "claude", "lead-s1", far.cwd, far.ppid);
  const rec = makeLead({ project: far.cwd, agent: "lead", host: "elsewhere-host", ownerPub: far.owner.publicKey });
  storeLead(far.n, rec, far.sign(rec));
  const farGrant = makeLeadGrants({ lead: rec, classes: ["outward-reversible"], agents: ["api-dev"], ownerPub: far.owner.publicKey });
  storeLeadGrants(far.n, farGrant, far.sign(farGrant));
  assert.equal(leadGrantFor(far.n, "api-dev", { cwd: far.cwd, class: "outward-reversible" }).ok, false);
});

test("T499 AC2: the persona's own checks still apply — a tainted persona session is refused although the lead grant holds", async (t) => {
  const w = live(t);
  assert.equal((await w.ask()).allow, true);
  w.taint("claude", "s1");
  assert.equal((await w.ask()).allow, false);
});

test("T499 AC2: wiring — the CLI's permission lookup is the owner's policy first and the lead grant behind it", () => {
  const cli = readFileSync(join(import.meta.dirname, "../src/cli.ts"), "utf8");
  assert.match(cli, /const permissionLookup = \(node: MbxNode\): Lookup => withLeadGrants\(node, \(agent, ctx\) => hasClass\(node\.store\.db, agent, node\.host, ctx\?\.class \?\? "permissions", \{ cwd: ctx\?\.cwd \}\)\);/);
});

// ── AC3: taint, liveness, expiry, revocation ───────────────────────────────────────────────────────────────

test("T499 AC3: taint on any conversation the store knows for the lead suspends the grant, and an aged-out root resumes it", (t) => {
  const w = live(t);
  const probe = (now?: Date) => leadGrantFor(w.n, "api-dev", { cwd: w.cwd, class: "outward-reversible", now }).ok;
  assert.equal(probe(), true);
  w.taint("claude", "lead-s1");
  assert.equal(probe(), false, "the lease's own conversation");
  assert.equal(leadGrantsView(w.n, w.l).state, "suspended: lead tainted");
  w.n.store.db.prepare("DELETE FROM kv WHERE k=?").run(taintKey("claude", "lead-s1"));
  assert.equal(probe(), true, "cleared");
  // A different conversation of the same lead persona (a sessions row that is not the lease's).
  w.n.bindSession({ agent: "lead", cli: "codex", session_id: "lead-other", cwd: w.cwd, pid: w.ppid });
  w.taint("codex", "lead-other");
  assert.equal(probe(), false, "another sessions row of the lead");
  w.n.store.db.prepare("DELETE FROM kv WHERE k=?").run(taintKey("codex", "lead-other"));
  // The record is corrupt: unreadable is not clean.
  w.n.store.set(taintKey("claude", "lead-s1"), "{not json");
  assert.equal(probe(), false, "corrupt taint fails closed");
  w.n.store.db.prepare("DELETE FROM kv WHERE k=?").run(taintKey("claude", "lead-s1"));
  // A root 50 minutes old is still live for ten minutes; twenty minutes later (heartbeat still fresh) it has aged out.
  w.taint("claude", "lead-s1", 50 * 60_000);
  assert.equal(probe(), false);
  assert.equal(probe(new Date(Date.now() + 20 * 60_000)), true, "the root aged out");
});

test("T499 AC3: a lead that is not live suspends the grant", (t) => {
  const w = live(t);
  const probe = (now?: Date) => leadGrantFor(w.n, "api-dev", { cwd: w.cwd, class: "outward-reversible", now }).ok;
  assert.equal(probe(), true);
  assert.equal(probe(new Date(Date.now() + 31 * 60_000)), false, "heartbeat older than the lease's idle TTL");
  assert.equal(leadGrantsView(w.n, w.l, new Date(Date.now() + 31 * 60_000)).state, "suspended: lead not live");
  w.n.store.db.prepare("UPDATE identity_leases SET released_at=? WHERE name='lead'").run(Date.now());
  assert.equal(probe(), false, "released");
  w.n.store.db.prepare("DELETE FROM identity_leases WHERE name='lead'").run();
  assert.equal(probe(), false, "no lease");
});

test("T499 AC3: expiry, lead revocation, a newer lead record and the owner kill switch each end the grant", (t) => {
  const probe = (w: ReturnType<typeof live>, now?: Date) => leadGrantFor(w.n, "api-dev", { cwd: w.cwd, class: "outward-reversible", now }).ok;
  { // the grants' own expiry, while the lead record is still valid
    const w = world(t); const l = w.lead({ ttlMs: 48 * H }); w.grant(l, ["api-dev"], { ttlMs: 2 * H });
    w.bind("lead", "claude", "lead-s1", w.cwd, w.ppid); w.keepAlive();
    const x = { ...w, l, g: {} as LeadGrants } as ReturnType<typeof live>;
    assert.equal(probe(x, new Date(Date.now() + H)), true);
    assert.equal(probe(x, new Date(Date.now() + 3 * H)), false, "grants expired; lead record still valid");
    assert.equal(activeLead(w.n, w.cwd, new Date(Date.now() + 3 * H))?.id, l.id);
  }
  { // the lead record's expiry
    const w = world(t); const l = w.lead({ ttlMs: 3 * H }); w.grant(l, ["api-dev"], { ttlMs: 2 * H });
    w.bind("lead", "claude", "lead-s1", w.cwd, w.ppid); w.keepAlive();
    assert.equal(probe({ ...w } as ReturnType<typeof live>, new Date(Date.now() + 4 * H)), false);
  }
  { // lead revoke
    const w = live(t); assert.equal(probe(w), true);
    const rv = makeLeadRevocation(w.l.id, w.owner.publicKey); revokeLead(w.n, rv, w.sign(rv));
    assert.equal(probe(w), false);
  }
  { // a newer lead record without grants supersedes the old one and its grants
    const w = live(t); assert.equal(probe(w), true);
    const next = w.lead({ now: new Date(Date.now() + 1000) });
    assert.equal(w.row(next.id).grants, null);
    assert.equal(probe(w), false);
    // and a new grants blob on the new record restores authority only because the owner signed it
    w.grant(next, ["api-dev"], { now: new Date(Date.now() + 1000) });
    assert.equal(probe(w), true);
  }
  { // policy revoke --all
    const w = live(t); assert.equal(probe(w), true);
    const after = makeRevocation("*", w.owner.publicKey, new Date(Date.parse(w.g.iat) + 1000));
    assert.equal(acceptSigned(w.n.store.db, { rec: after, sig: w.sign(after) }, w.n.host), null);
    assert.equal(probe(w), false, "kill switch signed after the grants");
    assert.equal(leadGrantsView(w.n, w.l).state, "killed");
    // a kill switch signed BEFORE the grants does not touch them; one from a stranger is not accepted at all
    const w2 = live(t);
    const before = makeRevocation("*", w2.owner.publicKey, new Date(Date.parse(w2.g.iat) - 60_000));
    assert.equal(acceptSigned(w2.n.store.db, { rec: before, sig: w2.sign(before) }, w2.n.host), null);
    assert.equal(probe(w2), true, "an older kill switch");
    const stranger = generateKeyPair(); const forged = makeRevocation("*", stranger.publicKey, new Date(Date.parse(w2.g.iat) + 1000));
    w2.n.store.db.prepare("INSERT INTO policy_revocations (id,target,iat,record,sig,received_at) VALUES (?,?,?,?,?,?)").run(forged.id, "*", forged.iat, JSON.stringify(forged), signData(stranger.privateKey, canonical(forged)), new Date().toISOString());
    assert.equal(probe(w2), true, "a revocation from a key this host does not trust");
  }
});

// ── AC4: audit ──────────────────────────────────────────────────────────────────────────────────────────────

for (const cli of ["claude", "codex"]) test(`T499 AC4: ${cli} — exactly one lead.grant_used per approved decision, none per refusal or lookup`, async (t) => {
  const w = live(t, cli);
  leadGrantFor(w.n, "api-dev", { cwd: w.cwd, class: "outward-reversible" }); w.lookup("api-dev", { cwd: w.cwd, class: "outward-reversible" });
  assert.equal(w.used().length, 0, "lookups alone are not uses");
  assert.equal((await w.ask("git push origin trunk", cli)).allow, false);
  assert.equal(w.used().length, 0, "a refusal");
  assert.equal((await w.ask("git push origin feature", cli)).allow, true);
  assert.equal(w.used().length, 1);
  assert.equal((await w.ask("gh pr create --draft --head feature --title 't' --body 'b'", cli)).allow, true);
  const rows = w.used();
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0], { persona: "api-dev", cli, session_id: "s1", tool: "Bash", class: "outward-reversible", action: rows[0].action, cwd: w.cwd,
    lead: "lead@testhost", record: w.l.id, grants: w.g.id, exp: w.g.exp });
  assert.notEqual(rows[0].action, rows[1].action);
  // The pre-existing yolo_allow evidence is unchanged and now names the grant.
  const yolo = (w.n.store.db.prepare("SELECT detail FROM audit WHERE event='yolo_allow'").all() as { detail: string }[]).map((r) => JSON.parse(r.detail));
  assert.equal(yolo.length, 2); assert.equal(yolo[0].policy_id, `lead-grant:${w.g.id}`);
});

test("T499 AC4: kimi — the use is recorded once, when the approval is committed, with the web route", async (t) => {
  const w = live(t, "kimi");
  const d = await decidePermission(w.input("git push origin feature", w.cwd, { tool_name: "Shell", id: "approval_lead" }), "kimi", w.lookup, { node: w.n, pid: process.pid });
  assert.equal(d.allow, true); assert.ok(d.grant);
  assert.equal(w.used().length, 0, "deciding is not using");
  let posts = 0;
  const fake = (async (_u: unknown, init?: RequestInit) => {
    if (init?.method === "POST") { posts++; return Response.json({ code: 0 }); }
    return Response.json({ code: 0, data: { items: [{ approval_id: "approval_lead" }] } });
  }) as typeof fetch;
  assert.equal(await approveKimi(w.n, d, { server: { url: "http://test.invalid", token: "t" }, fetch: fake, recheck: () => w.lookup(d.agent!, { cwd: d.cwd, class: d.class }).ok }), true);
  assert.equal(posts, 1);
  const rows = w.used();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].persona, "api-dev"); assert.equal(rows[0].cli, "kimi"); assert.equal(rows[0].via, "kimi web"); assert.equal(rows[0].record, w.l.id); assert.equal(rows[0].grants, w.g.id);
  // A grant that fails the re-check at approval time is not used, and not recorded.
  w.taint("claude", "lead-s1");
  assert.equal(await approveKimi(w.n, d, { server: { url: "http://test.invalid", token: "t" }, fetch: fake, recheck: () => w.lookup(d.agent!, { cwd: d.cwd, class: d.class }).ok }), false);
  assert.equal(w.used().length, 1);
});

test("T499 AC4: storing grants is itself audited, with who is covered and until when", (t) => {
  const w = world(t); const l = w.lead(); const g = w.grant(l, ["api-dev", "web-dev"]);
  const rows = (w.n.store.db.prepare("SELECT detail FROM audit WHERE event='lead.grants_set'").all() as { detail: string }[]).map((r) => JSON.parse(r.detail));
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0], { id: g.id, lead: l.id, project: w.cwd, agent: "lead@testhost", classes: ["outward-reversible"], agents: ["api-dev", "web-dev"], exp: g.exp });
});

test("T499: a collaborate policy for the persona still decides on its own; the lead grant is only the fallback", async (t) => {
  const w = live(t);
  const p = makePolicy({ level: "collaborate", classes: ["outward-reversible"], agents: ["api-dev"], hosts: [w.n.host], projects: [w.cwd], ownerPub: w.owner.publicKey });
  assert.equal(acceptSigned(w.n.store.db, { rec: p, sig: w.sign(p) }, w.n.host), null);
  const d = await w.ask();
  assert.equal(d.allow, true); assert.equal(d.policy_id, p.id);
  assert.equal(w.used().length, 0, "the owner's own policy decided; no lead grant was used");
});
