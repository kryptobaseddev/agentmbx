// T493 slice 1: the project mailbox registry, the bare-name rewrite, and the guards that keep a project slot out of every place that
// lists mailbox names. AC1 (one durable project delivery), the enumeration contract, and the deliveries-query ratchet.
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonical, fingerprint, generateKeyPair, signData } from "../src/crypto.ts";
import { createOwnerKey, unlockOwnerKey } from "../src/owner.ts";
import { strandedMail } from "../src/doctor.ts";
import { checkAuthority, verifyEnvelope, type Envelope } from "../src/envelope.ts";
import { IdentityLeases, inspectLeaseProcess } from "../src/identity-leases.ts";
import { randomUUID } from "node:crypto";
import { applyForward, buildForward, pruneCandidates } from "../src/identity-cleanup.ts";
import { listIdentityStatus } from "../src/identity-status.ts";
import { makeLead, makeLeadRevocation, revokeLead, storeLead } from "../src/lead-record.ts";
import { MbxNode } from "../src/node.ts";
import { allocateProjectMailbox, aliasFor, projectMailboxByAlias, projectMailboxBySlot, projectReader, reservedByProjectMailbox, rewriteProjectAliases } from "../src/project-mailbox.ts";
import { SLOT_GLOB, isSlotName, notSlot, slotFor } from "../src/project-slot.ts";
import { mailboxLiveness } from "../src/receipts.ts";
import { escalateUnheldMail, returnNeverClaimed } from "../src/stranded.ts";
import { loadSyncSnapshot } from "../src/sync-daemon.ts";
import { dispatchWakes } from "../src/wake.ts";

const CLEO_ID = "071b70b3-551d-44bb-b993-1e84bfa2fe09";
const tmp = (p: string) => mkdtempSync(join(tmpdir(), p));

/** A host with an owner it trusts, a project folder with a commented .cleo/project-id, and the legacy alias that used to catch the bare name. */
function world(t: TestContext, o: { folder?: string; cleo?: boolean } = {}) {
  const n = new MbxNode(tmp("mbx-pm-"), { host: "testhost", bind: "127.0.0.1", port: 0 });
  createOwnerKey(n.home, "test-only-passphrase");
  const owner = unlockOwnerKey(n.home, "test-only-passphrase");
  t.after(() => { try { n.close(); } catch { /* reopened and closed by the test */ } rmSync(n.home, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); });
  const dir = join(n.home, o.folder ?? "agentmbx");
  mkdirSync(dir, { recursive: true });
  if (o.cleo !== false) { mkdirSync(join(dir, ".cleo"), { recursive: true }); writeFileSync(join(dir, ".cleo", "project-id"), `# CLEO project id: write once, commit it\n${CLEO_ID}\n`); }
  const folder = realpathSync(dir);
  for (const name of ["agentmbx-lead", "agentmbx-builder"]) n.registerAgent(name);
  n.store.set("alias:agentmbx", "agentmbx-lead"); // the legacy forward that used to catch the bare project name
  const sign = (rec: unknown) => signData(owner.privateKey, canonical(rec));
  const draft = (to: string[], extra: Record<string, unknown> = {}) => ({ from: "agentmbx-builder", to, subject: "for the project", body: "please look", kind: "message" as const, ...extra });
  const lead = (agent = "agentmbx-lead", now?: Date) => { const rec = makeLead({ project: folder, agent, host: n.host, ownerPub: owner.publicKey, now }); return storeLead(n, rec, sign(rec)); };
  const hold = (name: string, sid: string) => new IdentityLeases(n.store).claim(name, { pid: process.pid, start: inspectLeaseProcess(process.pid).start!, keyFp: fingerprint(generateKeyPair().publicKey), cli: "claude", sessionId: sid });
  const deliveriesOf = (id: string) => n.store.db.prepare("SELECT agent,state FROM deliveries WHERE msg_id=? ORDER BY agent").all(id).map((r) => ({ ...r })) as { agent: string; state: string }[];
  return { n, owner, folder, sign, draft, lead, hold, deliveriesOf };
}

// ── AC1 ─────────────────────────────────────────────────────────────────────────────────────────────────────

test("T493 AC1: mail to the bare project name is one durable delivery to the project mailbox, not to the legacy alias target", async (t) => {
  const w = world(t);
  const { mailbox, created } = allocateProjectMailbox(w.n, w.folder);
  assert.equal(created, true);
  assert.equal(mailbox.alias, "agentmbx"); assert.equal(mailbox.key, CLEO_ID); assert.equal(mailbox.slot, slotFor(CLEO_ID)); assert.equal(mailbox.home_host, "testhost");
  assert.match(mailbox.slot, /^pm-[0-9a-f]{32}$/);

  const r = w.n.send(w.draft(["agentmbx"]));
  assert.deepEqual(r.local, [mailbox.slot]);
  assert.deepEqual(r.envelope.to, [mailbox.slot], "the signed envelope names the destination that is used");
  assert.equal(verifyEnvelope(r.envelope, w.n.key.publicKey), true);
  assert.ok(r.warnings.some((x) => /project mailbox/.test(x)), "the sender is told");
  assert.equal(r.warnings.some((x) => /not a known agent/.test(x)), false, "an allocated slot is a known mailbox");
  assert.equal((w.n.store.db.prepare("SELECT count(*) n FROM messages").get() as { n: number }).n, 1);
  assert.deepEqual(w.deliveriesOf(r.envelope.id), [{ agent: mailbox.slot, state: "delivered" }], "one delivery, to the slot, none to the legacy target or to an agent named agentmbx");
  assert.equal(w.n.unreadCount("agentmbx-lead"), 0); assert.equal(w.n.unreadCount("agentmbx"), 0);
  for (const sql of ["SELECT 1 FROM agents WHERE name=?", "SELECT 1 FROM identities WHERE name=?", "SELECT 1 FROM identity_leases WHERE name=?"])
    assert.equal(w.n.store.db.prepare(sql).get(mailbox.slot), undefined, sql);

  // The explicit local spelling is the same destination, and the two spellings collapse to one recipient.
  const again = w.n.send(w.draft(["agentmbx@testhost", "agentmbx"]));
  assert.deepEqual(again.envelope.to, [mailbox.slot]); assert.deepEqual(w.deliveriesOf(again.envelope.id), [{ agent: mailbox.slot, state: "delivered" }]);
  // Direct mail to the persona is untouched.
  const direct = w.n.send(w.draft(["agentmbx-lead"]));
  assert.deepEqual(w.deliveriesOf(direct.envelope.id), [{ agent: "agentmbx-lead", state: "delivered" }]);

  // It is durable: a restart keeps the registry row, the alias and the unread delivery.
  const home = w.n.home; w.n.close();
  const reopened = new MbxNode(home, { host: "testhost", bind: "127.0.0.1", port: 0 });
  t.after(() => reopened.close());
  assert.equal(projectMailboxByAlias(reopened.store, "agentmbx")?.slot, mailbox.slot);
  assert.equal((reopened.store.db.prepare("SELECT count(*) n FROM deliveries WHERE agent=? AND state<>'acked'").get(mailbox.slot) as { n: number }).n, 2);
});

test("T493 AC1: an owner-signed send to the bare name is rewritten before the owner signs, and its bytes still verify", async (t) => {
  const w = world(t);
  const { mailbox } = allocateProjectMailbox(w.n, w.folder);
  const r = await w.n.sendAsOwner({ ...w.draft(["agentmbx"]), from: "owner" }, async (payload) => ({ sig: signData(w.owner.privateKey, payload) }));
  assert.deepEqual(r.envelope.to, [mailbox.slot]);
  assert.equal(verifyEnvelope(r.envelope, w.n.key.publicKey), true);
  const auth = checkAuthority(r.envelope, w.owner.publicKey, new Set());
  assert.equal(auth.ok, true, auth.ok ? "" : auth.reason);
  assert.deepEqual(w.deliveriesOf(r.envelope.id), [{ agent: mailbox.slot, state: "delivered" }]);
});

test("T493 AC1: a bare name with no allocated project mailbox behaves exactly as before", (t) => {
  const w = world(t);
  const r = w.n.send(w.draft(["agentmbx"]));
  assert.deepEqual(r.envelope.to, ["agentmbx"]);
  assert.deepEqual(w.deliveriesOf(r.envelope.id), [{ agent: "agentmbx-lead", state: "delivered" }], "the legacy alias still catches it until a project mailbox exists");
  const other = w.n.send(w.draft(["some-other-project"]));
  assert.deepEqual(other.local, ["some-other-project"]);
  assert.ok(other.warnings.some((x) => /not a known agent/.test(x)));
});

test("T493 AC1: only an allocated alias is rewritten; broadcast, role, owner and lead tokens and other hosts pass through", (t) => {
  const w = world(t);
  allocateProjectMailbox(w.n, w.folder);
  const slot = slotFor(CLEO_ID);
  const rw = (to: string[]) => rewriteProjectAliases(w.n, to).to;
  assert.deepEqual(rw(["*", "owner", "lead", "role:lead", "role:builder", "agentmbx-lead", "agentmbx@otherhost", "agentmbx-builder@testhost"]),
    ["*", "owner", "lead", "role:lead", "role:builder", "agentmbx-lead", "agentmbx@otherhost", "agentmbx-builder@testhost"]);
  assert.deepEqual(rw(["agentmbx", "agentmbx-lead"]), [slot, "agentmbx-lead"]);
  assert.deepEqual(rw(["agentmbx-lead", "agentmbx@testhost", "agentmbx"]), ["agentmbx-lead", slot]);
  // A live mailbox of the same name is called out; it does not receive the mail.
  w.n.registerAgent("agentmbx"); w.hold("agentmbx", "legacy-session");
  const note = rewriteProjectAliases(w.n, ["agentmbx"]).notes[0] ?? "";
  assert.match(note, /live mailbox of the same name exists/);
});

// ── allocation and names ────────────────────────────────────────────────────────────────────────────────────

test("T493: allocation is idempotent, keeps the first alias and home host, and one CLEO project is one mailbox from every checkout", (t) => {
  const w = world(t);
  const first = allocateProjectMailbox(w.n, w.folder);
  const second = allocateProjectMailbox(w.n, w.folder);
  assert.equal(second.created, false); assert.deepEqual({ ...second.mailbox }, { ...first.mailbox });
  const clone = join(w.n.home, "agentmbx-clone", "deep"); mkdirSync(join(w.n.home, "agentmbx-clone", ".cleo"), { recursive: true });
  writeFileSync(join(w.n.home, "agentmbx-clone", ".cleo", "project-id"), `${CLEO_ID}\n`); mkdirSync(clone, { recursive: true });
  const fromClone = allocateProjectMailbox(w.n, realpathSync(clone));
  assert.equal(fromClone.created, false); assert.equal(fromClone.mailbox.slot, first.mailbox.slot); assert.equal(fromClone.mailbox.alias, "agentmbx");
  assert.equal((w.n.store.db.prepare("SELECT count(*) n FROM project_mailboxes").get() as { n: number }).n, 1);
  const audits = w.n.store.db.prepare("SELECT count(*) n FROM audit WHERE event='project_mailbox.allocated'").get() as { n: number };
  assert.equal(audits.n, 1);
});

test("T493: a folder without a CLEO id is keyed by its path; another project cannot take a name that is already a project's", (t) => {
  const w = world(t);
  allocateProjectMailbox(w.n, w.folder);
  const plain = join(w.n.home, "elsewhere", "agentmbx"); mkdirSync(plain, { recursive: true });
  const dup = allocateProjectMailbox(w.n, realpathSync(plain));
  assert.equal(dup.created, true); assert.equal(dup.mailbox.source, "folder"); assert.equal(dup.mailbox.key, realpathSync(plain));
  assert.equal(dup.mailbox.alias, null);
  assert.ok(dup.warnings.some((x) => /already names another project's mailbox/.test(x)));
  assert.notEqual(dup.mailbox.slot, slotFor(CLEO_ID));
  assert.equal(projectMailboxByAlias(w.n.store, "agentmbx")?.key, CLEO_ID, "the first project keeps the name");
});

test("T493: folder names become mailbox aliases; unusable and reserved names get none", () => {
  assert.equal(aliasFor("/x/Agent MBX_v2", null), "agent-mbx-v2");
  assert.equal(aliasFor("/x/ok-name", "/x/other-root"), "other-root", "the project root names it, not a subfolder");
  assert.equal(aliasFor("/x/!!!", null), null);
  assert.equal(aliasFor("/x/a", null), null, "one character is below the mailbox name minimum");
  assert.equal(aliasFor("/x/owner", null), null); assert.equal(aliasFor("/x/lead", null), null);
  assert.equal(aliasFor(`/x/${"a".repeat(80)}`, null)?.length, 40);
});

const SLOT_OWNERS: Record<string, (n: MbxNode, slot: string) => void> = {
  "an agents row": (n, slot) => { n.store.db.prepare("INSERT INTO agents (name,host) VALUES (?,?)").run(slot, n.host); },
  "an identity": (n, slot) => { n.store.db.prepare("INSERT INTO identities (name,role,registered_at) VALUES (?,?,?)").run(slot, "builder", new Date().toISOString()); },
  "a lease": (n, slot) => { n.store.db.prepare("INSERT INTO identity_leases (name,token,holder_pid,holder_start,key_fp,cli,session_id,claimed_at,heartbeat_at,idle_ttl) VALUES (?,?,?,?,?,?,?,?,?,?)").run(slot, "t", 1, "s", "fp", "claude", "sid", 1, 1, 1); },
  "mail already delivered under the name": (n, slot) => { n.send({ from: "agentmbx-builder", to: ["agentmbx-lead"], subject: "x", body: "y", kind: "message" }); n.store.addDelivery((n.store.db.prepare("SELECT id FROM messages LIMIT 1").get() as { id: string }).id, slot); },
  "a rename alias": (n, slot) => { n.store.set(`alias:${slot}`, "agentmbx-lead"); },
};
for (const [owner, give] of Object.entries(SLOT_OWNERS)) test(`T493: allocation refuses a slot name that already belongs to ${owner}`, (t) => {
  const w = world(t);
  const slot = slotFor(CLEO_ID);
  give(w.n, slot);
  assert.throws(() => allocateProjectMailbox(w.n, w.folder), /refusing to allocate over it/);
  assert.equal(projectMailboxBySlot(w.n.store, slot), undefined);
});

test("T493: slot-shaped names and an allocated project's bare name are reserved for the project mailbox", (t) => {
  const w = world(t);
  assert.equal(reservedByProjectMailbox(w.n.store, "agentmbx"), false, "nothing allocated yet");
  allocateProjectMailbox(w.n, w.folder);
  assert.equal(reservedByProjectMailbox(w.n.store, "agentmbx"), true);
  assert.equal(reservedByProjectMailbox(w.n.store, "agentmbx-lead"), false);
  assert.equal(reservedByProjectMailbox(w.n.store, "pm-" + "a".repeat(32)), true, "any slot shape, allocated or not");
  assert.equal(isSlotName("pm-" + "a".repeat(31)), false); assert.equal(isSlotName("pm-" + "a".repeat(33)), false); assert.equal(isSlotName("pm-" + "A".repeat(32)), false); assert.equal(isSlotName("xpm-" + "a".repeat(32)), false);
  assert.equal(slotFor(CLEO_ID).length, 35);
});

test("T493: the slot guard excludes exactly the slot shape in SQL", (t) => {
  const w = world(t);
  const slot = slotFor(CLEO_ID);
  const rows = (names: string[]) => w.n.store.db.prepare(`SELECT value v FROM json_each(?) WHERE ${notSlot("value")}`).all(JSON.stringify(names)).map((r) => (r as { v: string }).v);
  assert.deepEqual(rows([slot, "agentmbx-lead", "pm-short", "pm-" + "g".repeat(32), "pm-" + "a".repeat(33)]), ["agentmbx-lead", "pm-short", "pm-" + "g".repeat(32), "pm-" + "a".repeat(33)]);
  assert.match(SLOT_GLOB, /^pm-(\[0-9a-f\]){32}$/);
});

// ── the reader ──────────────────────────────────────────────────────────────────────────────────────────────

test("T493: a project mailbox is live exactly when the project's current lead on this host is", (t) => {
  const w = world(t);
  const { mailbox } = allocateProjectMailbox(w.n, w.folder);
  const none = mailboxLiveness(w.n, mailbox.slot);
  assert.equal(none.live, false); assert.match(none.detail, /project mailbox agentmbx: no owner-designated lead/);
  assert.equal(projectReader(w.n, mailbox.slot)?.lead, null);
  const l = w.lead();
  assert.equal(projectReader(w.n, mailbox.slot)?.lead?.id, l.id);
  assert.equal(mailboxLiveness(w.n, mailbox.slot).live, false, "designated but nobody holds the lead's mailbox");
  w.hold("agentmbx-lead", "lead-session");
  const live = mailboxLiveness(w.n, mailbox.slot);
  assert.equal(live.live, true); assert.match(live.detail, /project mailbox agentmbx, read by its lead agentmbx-lead: held by claude session/);
  const rv = makeLeadRevocation(l.id, w.owner.publicKey); revokeLead(w.n, rv, w.sign(rv));
  assert.equal(mailboxLiveness(w.n, mailbox.slot).live, false, "a revoked lead reads nothing");
  assert.equal(mailboxLiveness(w.n, slotFor("not-allocated")).live, false);
});

test("T493: a lead record designated for another host does not make the home mailbox live here", (t) => {
  const w = world(t);
  const { mailbox } = allocateProjectMailbox(w.n, w.folder);
  const rec = makeLead({ project: w.folder, agent: "agentmbx-lead", host: "elsewhere", ownerPub: w.owner.publicKey });
  storeLead(w.n, rec, w.sign(rec));
  w.hold("agentmbx-lead", "lead-session");
  assert.equal(projectReader(w.n, mailbox.slot)?.lead, null);
  assert.equal(mailboxLiveness(w.n, mailbox.slot).live, false);
});

// ── enumeration contract: a slot is never an agent, a candidate, a cloud row or a thing to claim ──────────────

test("T493 enumeration contract: no place that lists mailbox names out of deliveries lists a project slot", async (t) => {
  const w = world(t);
  const { mailbox } = allocateProjectMailbox(w.n, w.folder);
  const slot = mailbox.slot;
  const urgent = w.n.send(w.draft(["agentmbx"], { kind: "request", needs_reply: true }));
  const calm = w.n.send(w.draft(["agentmbx"], { kind: "status" }));
  w.n.send(w.draft(["agentmbx-lead"], { kind: "status" })); // a normal persona delivery next to it
  assert.equal(w.deliveriesOf(urgent.envelope.id)[0]?.agent, slot);

  assert.equal(w.n.agents().some((a) => a.name === slot), false, "never an agent");
  const prune = pruneCandidates(w.n, { days: 0, now: Date.now() + 40 * 86_400_000 });
  assert.equal([...prune.retire, ...prune.kept].some((r: { name: string }) => r.name === slot), false, "never a prune candidate");
  assert.throws(() => buildForward(w.n, slot, "agentmbx-lead"), /project mailbox cannot be a forward/);
  assert.throws(() => buildForward(w.n, "agentmbx-lead", slot), /project mailbox cannot be a forward/);
  // An owner-signed approval that names a slot is refused too, and moves nothing.
  const now = Date.now();
  for (const [from, to] of [[slot, "agentmbx-lead"], ["agentmbx-lead", slot]] as const) {
    const payload = { v: 1 as const, type: "identity-forward" as const, id: randomUUID(), owner_fp: fingerprint(w.owner.publicKey), host: w.n.host, host_fp: fingerprint(w.n.key.publicKey),
      from, to, unread: 1, issued_at: now - 1000, expires_at: now + 60_000 };
    assert.throws(() => applyForward(w.n, { payload, sig: signData(w.owner.privateKey, canonical(payload)) }, now), /project mailbox cannot be a forward/);
  }
  assert.equal((w.n.store.db.prepare("SELECT count(*) n FROM deliveries WHERE agent=? AND state<>'acked'").get(slot) as { n: number }).n, 2, "nothing moved");
  const status = listIdentityStatus(w.n.home, { now: Date.now() });
  assert.equal(status.identities.some((i) => i.name === slot), false, "never an identity row");
  const snapshot = JSON.stringify(loadSyncSnapshot(w.n, { contractAllowsProjectPaths: false }));
  assert.equal(snapshot.includes(slot), false, "never in the cloud read model");

  // Stranded diagnostics recognise it: no "claim pm-..." remedy, the lead's remedy instead.
  const notices: string[] = [];
  const esc = escalateUnheldMail(w.n, Date.now(), (_s, body) => notices.push(body));
  assert.deepEqual(esc.map((e) => e.id), [urgent.envelope.id], "only the urgent copy escalates");
  assert.equal(notices.length, 1);
  assert.match(notices[0]!, /project mailbox agentmbx@testhost has no live reader/); assert.match(notices[0]!, /lead set/);
  assert.equal(/claim the mailbox|identity forward/.test(notices[0]!), false);
  assert.deepEqual(escalateUnheldMail(w.n, Date.now(), () => assert.fail("escalated twice")), [], "once per copy");
  assert.deepEqual(returnNeverClaimed(w.n, Date.now() + 30 * 86_400_000, 1), [], "not an unclaimed name that mail goes back from");
  const checks = strandedMail(w.n);
  const row = checks.find((c) => c.label.includes("project mailbox agentmbx"));
  assert.ok(row, "doctor lists it as a project mailbox");
  assert.match(row.label, /3? ?unread message\(s\) waiting/); assert.match(row.fix ?? "", /lead set/);
  assert.equal(checks.some((c) => c.label.includes(slot) || /claim.*pm-/.test(`${c.label} ${c.fix ?? ""}`)), false);

  // The wake dispatcher leaves slot rows alone: they stay delivered, nothing is woken or marked.
  const woken = await dispatchWakes(w.n, Date.now());
  assert.equal(woken.some((x) => x.agent === slot), false);
  assert.equal((w.n.store.db.prepare("SELECT state FROM deliveries WHERE msg_id=? AND agent=?").get(calm.envelope.id, slot) as { state: string }).state, "delivered");
});

// ── ratchet: every deliveries query is classified, so a new one cannot silently list project slots ──────────

type Category = "enumerator (excludes project slots, asserted in the enumeration contract)" | "by name (the caller's own mailbox)" | "per message" | "owner-level aggregate" | "writer" | "schema";
const RATCHET: Record<string, { max: number; category: Category; why: string }> = {
  "src/cli.ts": { max: 7, category: "by name (the caller's own mailbox)", why: "inbox/read/status/watch/hook paths all take an agent; the whole-store counter in `status` is an owner-level aggregate" },
  "src/diagnostics.ts": { max: 2, category: "by name (the caller's own mailbox)", why: "scoped to one mailbox argument" },
  "src/doctor.ts": { max: 1, category: "enumerator (excludes project slots, asserted in the enumeration contract)", why: "strandedMail recognises slots and shows the lead's remedy instead of 'claim'" },
  "src/hud.ts": { max: 2, category: "by name (the caller's own mailbox)", why: "counts for the session's own agent" },
  "src/identity-cleanup.ts": { max: 6, category: "enumerator (excludes project slots, asserted in the enumeration contract)", why: "prune names exclude slots; forward refuses a slot as source or target (T495 owns lifting that)" },
  "src/identity-status.ts": { max: 1, category: "enumerator (excludes project slots, asserted in the enumeration contract)", why: "identity listing" },
  "src/loop-detector.ts": { max: 1, category: "per message", why: "the recipient list of one message" },
  "src/mcp.ts": { max: 3, category: "by name (the caller's own mailbox)", why: "handoff counts and the channel loop for the caller's agent" },
  "src/node.ts": { max: 11, category: "by name (the caller's own mailbox)", why: "inbox/ack/canSee/search and the writers; slice 2 puts the lead-only read scope here" },
  "src/probe.ts": { max: 1, category: "per message", why: "one message and one target" },
  "src/project-ledger.ts": { max: 1, category: "by name (the caller's own mailbox)", why: "members' deliveries; slice 2 makes the exclusion caller-aware before LIMIT" },
  "src/project-mailbox.ts": { max: 1, category: "writer", why: "allocation checks that a slot name has no deliveries" },
  "src/receipts.ts": { max: 1, category: "per message", why: "the recipients of one message; a slot shows as a project mailbox" },
  "src/relay-v2.ts": { max: 1, category: "per message", why: "re-queues receipts for one message" },
  "src/retention.ts": { max: 6, category: "per message", why: "an unacked slot delivery keeps its message from being pruned" },
  "src/store.ts": { max: 3, category: "schema", why: "triggers and the legacy visibility backfill" },
  "src/stranded.ts": { max: 3, category: "enumerator (excludes project slots, asserted in the enumeration contract)", why: "established-name gated; a slot is recognised, not claimed" },
  "src/sync-daemon.ts": { max: 2, category: "enumerator (excludes project slots, asserted in the enumeration contract)", why: "cloud read model" },
  "src/wake.ts": { max: 4, category: "enumerator (excludes project slots, asserted in the enumeration contract)", why: "the dispatcher skips slot rows; reconcile works per message and agent" },
};

test("T493 ratchet: every query over deliveries is classified, so a new one cannot silently list a project mailbox slot", () => {
  const src = join(import.meta.dirname, "../src");
  const rx = /\b(?:FROM|JOIN|INTO|UPDATE)\s+deliveries\b/g;
  const found: Record<string, number> = {};
  for (const f of readdirSync(src).filter((x) => x.endsWith(".ts")).sort()) {
    const n = (readFileSync(join(src, f), "utf8").match(rx) ?? []).length;
    if (n) found[`src/${f}`] = n;
  }
  const problems: string[] = [];
  for (const [file, n] of Object.entries(found)) {
    const allowed = RATCHET[file];
    if (!allowed) problems.push(`${file} has ${n} new deliveries query(ies) and is not classified`);
    else if (n > allowed.max) problems.push(`${file} went from ${allowed.max} to ${n} deliveries queries`);
  }
  assert.deepEqual(problems, [], "Classify each new deliveries query in RATCHET (test/project-mailbox.test.ts). If it lists mailbox NAMES from deliveries.agent, "
    + "it must exclude project slots with notSlot() from src/project-slot.ts (or recognise them on purpose) and be covered by the enumeration contract test above; "
    + "then raise the count here.");
});
