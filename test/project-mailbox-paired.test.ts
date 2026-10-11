// T493 slice 3: a paired SENDER reaches a project mailbox on its home host (AC5), and the lead's watcher is woken by it.
// Real HTTP between two hosts: alpha is the home (its owner designates the lead), beta only sends. The directory, the rewrite before
// signing, receive, the signed receipts back, the rename, and every refusal that must be visible.
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { canonical, fingerprint, generateKeyPair, signData } from "../src/crypto.ts";
import { flushOutbox, flushReceipts, refreshDirectory, signedDirectory, startServer } from "../src/http.ts";
import { IdentityLeases, inspectLeaseProcess } from "../src/identity-leases.ts";
import { makeLead, storeLead } from "../src/lead-record.ts";
import { MbxNode } from "../src/node.ts";
import { createOwnerKey, unlockOwnerKey } from "../src/owner.ts";
import { acceptPeerProjects, advertisedProjects, homesOfKey, peerProjects, peerProjectsState } from "../src/project-directory.ts";
import { resolveProject } from "../src/project-key.ts";
import { projectMailboxByAlias, projectsLedBy } from "../src/project-mailbox.ts";
import { slotFor } from "../src/project-slot.ts";
import { acceptReceipt, type ReceiptRecord } from "../src/remote-receipts.ts";
import { sentPage } from "../src/receipts.ts";
import { dispatchWakes, liveWatcher, muteWakes } from "../src/wake.ts";
import { delegateWake } from "./helpers/wake-lease.ts";
import { sendLeased } from "./helpers/leased-send.ts";

process.env.MBX_NO_DESKTOP = "1";
const PASS = "test-only-passphrase";
const CLEO_ID = "5c1a9d3e-7b2f-4a60-9e11-0a1b2c3d4e5f";
const OTHER_ID = "9f8e7d6c-5b4a-4321-8fed-cba987654321";
const until = async (ok: () => boolean, ms = 10_000) => { for (const end = Date.now() + ms; !ok() && Date.now() < end;) await new Promise((r) => setTimeout(r, 50)); return ok(); };
const codeOf = (e: unknown) => (e as { code?: string }).code;

interface Up { n: MbxNode; s: Server; home: string; addr: string }
async function up(host: string): Promise<Up> {
  const home = mkdtempSync(join(tmpdir(), `mbx-pmp-${host}-`));
  const n = new MbxNode(home, { host, bind: "127.0.0.1", port: 0 });
  const s = await startServer(n, 0, "127.0.0.1");
  return { n, s, home, addr: `127.0.0.1:${(s.address() as AddressInfo).port}` };
}

function folder(root: string, name: string, id?: string): string {
  const d = join(root, name); mkdirSync(d, { recursive: true });
  if (id) { mkdirSync(join(d, ".cleo"), { recursive: true }); writeFileSync(join(d, ".cleo", "project-id"), `# CLEO project id\n${id}\n`); }
  return realpathSync(d);
}

/** alpha = the project's home (the owner designates its lead there), beta = a paired sender in a different folder with the same CLEO id. */
async function world(t: TestContext) {
  const A = await up("alpha"), B = await up("beta");
  const root = mkdtempSync(join(tmpdir(), "mbx-pmp-root-"));
  t.after(async () => {
    for (const x of [A, B]) { await new Promise<void>((r) => x.s.close(() => r())); x.n.close(); rmSync(x.home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  A.n.addApprovedPeer({ host: "beta", pubkey: B.n.key.publicKey, owner_pubkey: null, addr: B.addr }, "fixture");
  B.n.addApprovedPeer({ host: "alpha", pubkey: A.n.key.publicKey, owner_pubkey: null, addr: A.addr }, "fixture");
  createOwnerKey(A.home, PASS);
  const owner = unlockOwnerKey(A.home, PASS);
  A.n.syncOwner();
  const homeFolder = folder(root, "agentmbx", CLEO_ID), senderFolder = folder(root, "clone-of-it", CLEO_ID);
  A.n.registerAgent("agentmbx-lead"); B.n.registerAgent("agentmbx-builder");
  const sign = (rec: unknown) => signData(owner.privateKey, canonical(rec));
  const designate = (agent = "agentmbx-lead", project = homeFolder) => { const rec = makeLead({ project, agent, host: "alpha", ownerPub: owner.publicKey }); return storeLead(A.n, rec, sign(rec)); };
  const leases = new IdentityLeases(A.n.store);
  /** A live, leased `agentmbx-lead` on alpha (a real process lease), and a way to run reads as that holder. */
  const hold = (name = "agentmbx-lead") => {
    const lease = leases.claim(name, { pid: process.pid, start: inspectLeaseProcess(process.pid).start!, keyFp: fingerprint(generateKeyPair().publicKey), cli: "claude", sessionId: `${name}-s` });
    return {
      asHolder: <T>(fn: () => T) => leases.withHeldRead(name, lease.token, fn),
      asWriter: <T>(fn: () => T) => leases.withHeld(name, lease.token, fn),
      release: () => leases.release(name, lease.token),
    };
  };
  const send = (to: string[], extra: Record<string, unknown> = {}) =>
    B.n.send({ from: "agentmbx-builder", to, subject: "from beta", body: "zebrafish body", kind: "request", project: senderFolder, ...extra } as never);
  return { A, B, root, owner, homeFolder, senderFolder, designate, hold, send, sign };
}

const advert = (n: MbxNode) => advertisedProjects(n);
const stored = (n: MbxNode, id: string) => n.store.db.prepare("SELECT agent,state FROM deliveries WHERE msg_id=? ORDER BY agent").all(id).map((r) => ({ ...r })) as { agent: string; state: string }[];

// ── AC5 ─────────────────────────────────────────────────────────────────────────────────────────────────────

test("T493 AC5: a paired sender in another folder with the same CLEO id reaches the home project mailbox once, gets signed receipts from the slot, and a rename of the home folder keeps the key, the mail and the unread count", async (t) => {
  const w = await world(t);
  w.designate();
  const slot = slotFor(CLEO_ID);
  assert.deepEqual(advert(w.A.n), [{ slot, alias: "agentmbx", source: "cleo", key: CLEO_ID }], "the home host advertises its project mailbox");
  assert.equal(JSON.stringify(advert(w.A.n)).includes(w.homeFolder), false, "no folder path leaves the home host");

  assert.equal(peerProjects(w.B.n).length, 0, "nothing is known before the directory is refreshed");
  await refreshDirectory(w.B.n);
  assert.deepEqual(peerProjects(w.B.n), [{ host: "alpha", slot, key: CLEO_ID, alias: "agentmbx", source: "cleo" }]);
  assert.equal(peerProjectsState(w.B.n.store, "alpha")?.state, "ok");

  // The sender uses the bare name. The slot is chosen before the envelope is signed, so the signed bytes name the real destination.
  const first = w.send(["agentmbx"]);
  assert.deepEqual(first.envelope.to, [`${slot}@alpha`]);
  assert.deepEqual(first.remote, ["alpha"]); assert.deepEqual(first.local, []);
  assert.ok(first.warnings.some((x) => /project mailbox on alpha/.test(x)), first.warnings.join("|"));
  const rcpt = (await import("../src/receipts.ts")).recipientReceipts(w.B.n, first.envelope.id, first.targets)[0]!;
  assert.match(rcpt.detail, /addressed to the project mailbox agentmbx on alpha, read by its lead there; queued for paired host alpha/);
  assert.equal(rcpt.address, `${slot}@alpha`);
  assert.deepEqual(await flushOutbox(w.B.n), { sent: 1, failed: 0 });

  // Home: one delivery, to the project's slot, and to no persona.
  assert.deepEqual(stored(w.A.n, first.envelope.id), [{ agent: slot, state: "delivered" }]);
  assert.equal((w.A.n.store.db.prepare("SELECT count(*) n FROM agents WHERE name='agentmbx'").get() as { n: number }).n, 0, "no phantom persona was minted");
  const lead = w.hold();
  assert.equal(lead.asHolder(() => w.A.n.projectInboxes("agentmbx-lead")[0]?.messages.map((m) => m.id).join()), first.envelope.id, "its lead reads it, inside its lease");
  assert.deepEqual(w.A.n.projectInboxes("agentmbx-lead"), [], "and nobody outside the lease does");

  // Signed receipts come back from the slot and carry the project's name on the sender side.
  assert.deepEqual(await flushReceipts(w.A.n), { sent: 1, deferred: 0 });
  const seen = () => sentPage(w.B.n, "agentmbx-builder").messages.find((m) => m.id === first.envelope.id)!.recipients.filter((r) => r.address.endsWith("@alpha"));
  assert.equal(seen().length, 1); assert.equal(seen()[0]!.address, `${slot}@alpha`); assert.equal(seen()[0]!.state, "delivered");
  assert.match(seen()[0]!.liveness, /addressed to the project mailbox agentmbx on alpha.*signed receipt/);

  // Rename the home folder: the CLEO id file moves with it, so the key, the slot, the mail and the unread count do not change.
  const moved = join(w.root, "agentmbx-renamed");
  renameSync(w.homeFolder, moved);
  assert.equal(resolveProject(moved).key, CLEO_ID);
  const before = lead.asHolder(() => w.A.n.projectInboxes("agentmbx-lead")[0]!.unread);
  assert.equal(before, 1);
  assert.deepEqual(projectsLedBy(w.A.n, "agentmbx-lead").map((m) => m.slot), [slot], "the lead is still the lead of the same project after the rename");
  const second = w.send(["agentmbx"]); // the sender's directory is unchanged: the bare name still routes
  assert.deepEqual(second.envelope.to, [`${slot}@alpha`]);
  assert.deepEqual(await flushOutbox(w.B.n), { sent: 1, failed: 0 });
  assert.deepEqual(stored(w.A.n, second.envelope.id), [{ agent: slot, state: "delivered" }]);
  assert.equal(lead.asHolder(() => w.A.n.projectInboxes("agentmbx-lead")[0]!.unread), 2);
  assert.equal(projectMailboxByAlias(w.A.n.store, "agentmbx")?.slot, slot, "the alias is not renamed with the folder");

  // The lead acknowledges one; the sender sees the acked state, with its did, from the slot.
  lead.asWriter(() => w.A.n.ack(first.envelope.id, "agentmbx-lead", null, "reviewed", { project: "agentmbx" }));
  assert.equal((await flushReceipts(w.A.n)).deferred, 0);
  assert.equal(seen().length, 1); assert.equal(seen()[0]!.state, "acked"); assert.equal(seen()[0]!.did, "reviewed");
  assert.equal(lead.asHolder(() => w.A.n.projectInboxes("agentmbx-lead")[0]!.unread), 1);
  lead.release();
});

// ── visible refusals ────────────────────────────────────────────────────────────────────────────────────────

test("T493 S3: a peer that publishes no project mailboxes is unsupported, and a slot is never sent to it", async (t) => {
  const w = await world(t);
  w.designate();
  await refreshDirectory(w.B.n);
  const slot = slotFor(CLEO_ID);
  assert.equal(peerProjects(w.B.n).length, 1);
  const old = (body: Record<string, unknown>): typeof fetch => (async () => Response.json(body)) as typeof fetch;
  // The oldest form of the directory: an agents list with no signature at all. It publishes no project mailboxes either.
  await refreshDirectory(w.B.n, old({ v: 1, host: "alpha", agents: [] }));
  assert.equal(peerProjectsState(w.B.n.store, "alpha")?.state, "unsupported");
  assert.equal(peerProjects(w.B.n).length, 0, "an unsigned legacy directory clears what was cached");
  await refreshDirectory(w.B.n);
  assert.equal(peerProjects(w.B.n).length, 1, "and the honest directory restores it");
  // The same peer, as a newer-but-not-project-aware runtime would answer: a signed agents list and no projects at all.
  const agents: unknown[] = [];
  const signedAgents = { v: 1, host: "alpha", agents, sig: signData(w.A.n.key.privateKey, canonical({ v: 1, host: "alpha", agents })) };
  await refreshDirectory(w.B.n, old(signedAgents));
  const state = peerProjectsState(w.B.n.store, "alpha")!;
  assert.equal(state.state, "unsupported"); assert.match(state.reason!, /does not publish project mailboxes/);
  assert.equal(peerProjects(w.B.n).length, 0, "an older peer has none, so none are kept");
  assert.ok(w.B.n.store.db.prepare("SELECT 1 FROM audit WHERE event='directory.projects_unsupported'").get(), "and it is recorded, once");
  await refreshDirectory(w.B.n, old(signedAgents));
  assert.equal((w.B.n.store.db.prepare("SELECT count(*) n FROM audit WHERE event='directory.projects_unsupported'").get() as { n: number }).n, 2, "each change to unsupported is audited once; repeating it is not");

  assert.throws(() => w.send([`${slot}@alpha`]), (e) => codeOf(e) === "PROJECT_PEER_UNSUPPORTED" && /does not publish project mailboxes \(older agentmbx\)/.test((e as Error).message));
  assert.equal((w.B.n.store.db.prepare("SELECT count(*) n FROM messages WHERE origin='local'").get() as { n: number }).n, 0, "nothing was stored or queued");
  // The bare name is not turned into the peer's legacy persona mailbox either: it is left exactly as the sender typed it.
  const bare = w.send(["agentmbx"]);
  assert.ok(!bare.envelope.to.some((x) => x.includes(slot)), bare.envelope.to.join());
});

test("T493 S3: a malformed, forged or oversize project advertisement is rejected with a reason and changes nothing", async (t) => {
  const w = await world(t);
  w.designate();
  await refreshDirectory(w.B.n);
  const good = peerProjects(w.B.n);
  assert.equal(good.length, 1);
  const peer = { host: "alpha", pubkey: w.A.n.key.publicKey };
  const sign = (projects: unknown) => signData(w.A.n.key.privateKey, canonical({ v: 1, host: "alpha", projects }));
  const attempt = (projects: unknown, sig = sign(projects)) => acceptPeerProjects(w.B.n, peer, { projects, projects_sig: sig });
  const slot = slotFor(CLEO_ID), row = { slot, alias: "agentmbx", source: "cleo", key: CLEO_ID };

  const cases: [string, unknown, string | undefined, RegExp][] = [
    ["wrong signature", [row], signData(generateKeyPair().privateKey, "x"), /signature does not verify against the pinned host key/],
    ["slot does not match its project id", [{ ...row, slot: slotFor(OTHER_ID) }], undefined, /slot does not match its project id/],
    ["a path as the project id", [{ ...row, key: "/Users/someone/agentmbx" }], undefined, /no valid project id/],
    ["a folder-keyed row that carries a key", [{ slot: slotFor("/x"), alias: "xproject", source: "folder", key: "/x" }], undefined, /folder-keyed project row carries a key/],
    ["a bare name that is a slot", [{ ...row, alias: slotFor(OTHER_ID) }], undefined, /invalid bare name/],
    ["a slot that is not a slot", [{ ...row, slot: "agentmbx-lead" }], undefined, /no valid slot/],
    ["the same slot twice", [row, row], undefined, /listed twice/],
    ["the same slot twice under different names", [{ ...row, alias: null }, { ...row, alias: "other-name" }], undefined, /listed twice/],
    ["the same name for two slots", [row, { ...row, slot: slotFor(OTHER_ID), key: OTHER_ID }], undefined, /listed twice/],
    ["too many", Array.from({ length: 201 }, (_, i) => ({ slot: slotFor(`k${i}`), alias: null, source: "folder" })), undefined, /more than 200/],
  ];
  for (const [name, projects, sig, why] of cases) {
    const state = attempt(projects, sig);
    assert.equal(state.state, "rejected", name); assert.match(state.reason!, why, name);
    assert.deepEqual(peerProjects(w.B.n), good, `${name}: the previous verified list is kept`);
  }
  assert.ok(w.B.n.store.db.prepare("SELECT 1 FROM audit WHERE event='directory.projects_rejected'").get());
  for (const reserved of ["owner", "lead"]) assert.match(attempt([{ ...row, alias: reserved }]).reason!, /invalid bare name/, `a peer cannot advertise ${reserved} as a project name`);
  assert.equal(acceptPeerProjects(w.B.n, peer, { projects: [row] }).state, "rejected", "projects without projects_sig");
  assert.equal(attempt([row]).state, "ok", "and the honest list is accepted again");
  assert.deepEqual(peerProjects(w.B.n), good);
});

test("T493 S3: a host whose directory was rejected cannot be sent project mail until it is republished; an unpaired host is left to routing", async (t) => {
  const w = await world(t);
  const g = generateKeyPair();
  w.B.n.addApprovedPeer({ host: "gamma", pubkey: g.publicKey, owner_pubkey: null, addr: "127.0.0.1:9" }, "fixture");
  const slot = slotFor(OTHER_ID);
  const bad = acceptPeerProjects(w.B.n, { host: "gamma", pubkey: g.publicKey }, { projects: [{ slot, alias: "x-proj", source: "cleo", key: OTHER_ID }], projects_sig: signData(generateKeyPair().privateKey, "nope") });
  assert.equal(bad.state, "rejected");
  assert.throws(() => w.send([`${slot}@gamma`]), (e) => codeOf(e) === "PROJECT_DIRECTORY_REJECTED" && /was rejected \(projects signature does not verify/.test((e as Error).message));
  // A host that is not paired at all is not this layer's business: the address is left as typed and routing says it is not paired.
  const unpaired = w.send([`${slot}@nowhere`]);
  assert.deepEqual(unpaired.envelope.to, [`${slot}@nowhere`]);
  assert.ok(unpaired.warnings.some((x) => /nowhere is not paired/.test(x)));
  // Republished honestly, it works.
  const projects = [{ slot, alias: "x-proj", source: "cleo", key: OTHER_ID }];
  assert.equal(acceptPeerProjects(w.B.n, { host: "gamma", pubkey: g.publicKey }, { projects, projects_sig: signData(g.privateKey, canonical({ v: 1, host: "gamma", projects })) }).state, "ok");
  assert.deepEqual(w.send([`${slot}@gamma`]).envelope.to, [`${slot}@gamma`]);
});

test("T493 S3: a project keyed by a folder is advertised by its slot and name only: no key, no path", async (t) => {
  const w = await world(t);
  const plain = folder(w.root, "plain-project"); // no .cleo/project-id: the home host keys it by its folder
  const rec = makeLead({ project: plain, agent: "agentmbx-lead", host: "alpha", ownerPub: w.owner.publicKey });
  storeLead(w.A.n, rec, w.sign(rec));
  const ad = advert(w.A.n);
  assert.deepEqual(ad, [{ slot: slotFor(plain), alias: "plain-project", source: "folder" }]);
  assert.equal(JSON.stringify(signedDirectory(w.A.n)).includes(plain), false, "the folder path is nowhere in the signed directory");
  await refreshDirectory(w.B.n);
  assert.deepEqual(peerProjects(w.B.n), [{ host: "alpha", slot: slotFor(plain), key: null, alias: "plain-project", source: "folder" }]);
  assert.deepEqual(w.send(["plain-project"]).envelope.to, [`${slotFor(plain)}@alpha`], "it is still addressable by its name");
});

test("T493 S3: the recipient owner and a broadcast are never turned into a project, whatever the cache holds", async (t) => {
  const w = await world(t);
  // A peer cannot advertise the name owner (the list is rejected), but a cache row is only as good as what wrote it: the rewrite does not trust it either.
  w.B.n.store.db.prepare("INSERT INTO peer_project_mailboxes (host,slot,key,alias,source,seen_at) VALUES ('alpha',?,?,'owner','cleo',?)").run(slotFor("k-owner"), OTHER_ID, new Date().toISOString());
  assert.deepEqual(w.send(["owner"]).envelope.to, ["owner"]);
  assert.deepEqual(w.send(["*"]).envelope.to, ["*"]);
});

test("T493 S3: two projects with one bare name need name@host; the sender's own project breaks the tie; a local mailbox of that name comes first", async (t) => {
  const w = await world(t);
  w.designate();
  await refreshDirectory(w.B.n);
  const g = generateKeyPair();
  w.B.n.addApprovedPeer({ host: "gamma", pubkey: g.publicKey, owner_pubkey: null, addr: "127.0.0.1:9" }, "fixture");
  const otherSlot = slotFor(OTHER_ID), slot = slotFor(CLEO_ID);
  const projects = [{ slot: otherSlot, alias: "agentmbx", source: "cleo", key: OTHER_ID }];
  assert.equal(acceptPeerProjects(w.B.n, { host: "gamma", pubkey: g.publicKey }, { projects, projects_sig: signData(g.privateKey, canonical({ v: 1, host: "gamma", projects })) }).state, "ok");

  // The sender sits in a folder of project CLEO_ID: its own project wins the tie, silently, because the key says so.
  assert.deepEqual(w.send(["agentmbx"]).envelope.to, [`${slot}@alpha`]);
  // A sender in an unrelated folder gets a visible refusal that names the way out, and nothing is stored.
  const stranger = folder(w.root, "stranger");
  const before = (w.B.n.store.db.prepare("SELECT count(*) n FROM messages").get() as { n: number }).n;
  assert.throws(() => w.send(["agentmbx"], { project: stranger }), (e) => codeOf(e) === "PROJECT_AMBIGUOUS" && /agentmbx@alpha, agentmbx@gamma/.test((e as Error).message));
  assert.equal((w.B.n.store.db.prepare("SELECT count(*) n FROM messages").get() as { n: number }).n, before);
  // name@host is exact.
  assert.deepEqual(w.send(["agentmbx@gamma"], { project: stranger }).envelope.to, [`${otherSlot}@gamma`]);
  assert.deepEqual(w.send(["agentmbx@alpha"], { project: stranger }).envelope.to, [`${slot}@alpha`]);
  // A host-qualified name that is not a project goes on as an ordinary agent address.
  assert.deepEqual(w.send(["agentmbx-lead@alpha"], { project: stranger }).envelope.to, ["agentmbx-lead@alpha"]);

  // A local mailbox of the same name comes first: bare `agentmbx` is not stolen from a local agent.
  w.B.n.registerAgent("agentmbx");
  const local = w.send(["agentmbx"], { project: stranger });
  assert.deepEqual(local.envelope.to, ["agentmbx"], "the local agent keeps its own name");
  assert.deepEqual(w.send(["agentmbx@alpha"], { project: stranger }).envelope.to, [`${slot}@alpha`], "the project stays reachable as name@host");
});

test("T493 S3: a project claimed by two hosts is not routed to by name or by slot", async (t) => {
  const w = await world(t);
  w.designate();
  await refreshDirectory(w.B.n);
  const slot = slotFor(CLEO_ID);
  const g = generateKeyPair();
  w.B.n.addApprovedPeer({ host: "gamma", pubkey: g.publicKey, owner_pubkey: null, addr: "127.0.0.1:9" }, "fixture");
  const projects = [{ slot, alias: "agentmbx", source: "cleo", key: CLEO_ID }];
  acceptPeerProjects(w.B.n, { host: "gamma", pubkey: g.publicKey }, { projects, projects_sig: signData(g.privateKey, canonical({ v: 1, host: "gamma", projects })) });
  assert.deepEqual(homesOfKey(w.B.n, CLEO_ID), ["alpha", "gamma"]);
  const refuses = (to: string) => assert.throws(() => w.send([to]), (e) => codeOf(e) === "PROJECT_HOME_CONFLICT" && /claimed by more than one host \(alpha, gamma\)/.test((e as Error).message), to);
  refuses("agentmbx"); refuses("agentmbx@alpha"); refuses(`${slot}@gamma`);
  // A mailbox this host allocated itself conflicts with a peer's claim to the same project too.
  const local = new MbxNode(mkdtempSync(join(tmpdir(), "mbx-pmp-own-")), { host: "beta" });
  t.after(() => { local.close(); });
  assert.equal((await import("../src/project-mailbox.ts")).allocateProjectMailbox(local, w.senderFolder).created, true);
  const gk = generateKeyPair();
  local.addApprovedPeer({ host: "alpha", pubkey: gk.publicKey, owner_pubkey: null, addr: "127.0.0.1:9" }, "fixture");
  acceptPeerProjects(local, { host: "alpha", pubkey: gk.publicKey }, { projects, projects_sig: signData(gk.privateKey, canonical({ v: 1, host: "alpha", projects })) });
  assert.throws(() => local.send({ from: "agentmbx-builder", to: ["clone-of-it"], subject: "s", body: "b", project: w.senderFolder } as never), (e) => codeOf(e) === "PROJECT_HOME_CONFLICT");
  // A revoked peer's claim stops counting at once.
  w.B.n.store.db.prepare("UPDATE peers SET state='revoked' WHERE host='gamma'").run();
  assert.deepEqual(homesOfKey(w.B.n, CLEO_ID), ["alpha"]);
  assert.deepEqual(w.send(["agentmbx"]).envelope.to, [`${slot}@alpha`]);
});

test("T493 S3: a slot a host does not advertise is refused with the reason; a host never heard from is its own reason", async (t) => {
  const w = await world(t);
  w.designate();
  const slot = slotFor(CLEO_ID);
  assert.throws(() => w.send([`${slot}@alpha`]), (e) => codeOf(e) === "PROJECT_DIRECTORY_UNKNOWN" && /no project directory has been received from alpha yet/.test((e as Error).message));
  await refreshDirectory(w.B.n);
  assert.throws(() => w.send([`${slotFor(OTHER_ID)}@alpha`]), (e) => codeOf(e) === "PROJECT_NOT_ADVERTISED" && /alpha does not advertise the project mailbox pm-/.test((e as Error).message));
  assert.deepEqual(w.send([`${slot}@alpha`]).envelope.to, [`${slot}@alpha`], "the explicit slot of an advertised project is fine");
  assert.deepEqual(w.send(["someone@alpha"]).envelope.to, ["someone@alpha"], "ordinary addresses are untouched");
});

// ── receive and receipts ────────────────────────────────────────────────────────────────────────────────────

test("T493 S3: the home host delivers a peer's mail only to an allocated slot, and accepts a slot receipt only for a slot the message addressed", async (t) => {
  const w = await world(t);
  w.designate();
  await refreshDirectory(w.B.n);
  const slot = slotFor(CLEO_ID), ghost = slotFor("never-allocated");
  // A stale or forged sender-side cache can name a slot alpha never allocated: alpha stores the message and delivers it to no one.
  w.B.n.store.db.prepare("INSERT INTO peer_project_mailboxes (host,slot,key,alias,source,seen_at) VALUES ('alpha',?,NULL,NULL,'folder',?)").run(ghost, new Date().toISOString());
  const stray = w.send([`${ghost}@alpha`]);
  assert.deepEqual(await flushOutbox(w.B.n), { sent: 1, failed: 0 });
  assert.deepEqual(stored(w.A.n, stray.envelope.id), [], "no phantom delivery was minted");
  assert.equal((w.A.n.store.db.prepare("SELECT count(*) n FROM deliveries WHERE agent=?").get(ghost) as { n: number }).n, 0);
  assert.ok(w.A.n.store.db.prepare("SELECT 1 FROM audit WHERE event='receive.skipped' AND detail LIKE '%not a project mailbox%'").get(), "and it is recorded");

  const ok = w.send(["agentmbx"]);
  assert.deepEqual(await flushOutbox(w.B.n), { sent: 1, failed: 0 });
  assert.deepEqual(stored(w.A.n, ok.envelope.id), [{ agent: slot, state: "delivered" }]);

  // Receipts: alpha may report on the slot the signed envelope named, and on no other slot.
  const make = (recipient: string, seq: number) => {
    const rec: ReceiptRecord = { v: 1, type: "receipt", msg: ok.envelope.id, recipient, state: "read", at: new Date().toISOString(), seq } as ReceiptRecord;
    return { rec, sig: signData(w.A.n.key.privateKey, canonical(rec)) };
  };
  assert.equal(acceptReceipt(w.B.n, make(`${slot}@alpha`, 5), "alpha"), "accepted");
  assert.match(acceptReceipt(w.B.n, make(`${ghost}@alpha`, 6), "alpha"), /^rejected:pm-[0-9a-f]{32}@alpha was not addressed by this message$/);
  assert.equal(acceptReceipt(w.B.n, make("anyone@alpha", 7), "alpha"), "accepted", "the existing bounds for ordinary recipients are unchanged");
});

// ── the lead's watcher ──────────────────────────────────────────────────────────────────────────────────────

/** One home with a project whose lead is `agentmbx-lead`, and one session (`as`) with its own `agentmbx watch`. Two sessions of one test process are ambiguous to `watch`, so each test has one. */
async function watchWorld(t: TestContext, as: string, via: "watch" | "socket" = "watch") {
  const home = mkdtempSync(join(tmpdir(), "mbx-pmp-watch-"));
  const root = mkdtempSync(join(tmpdir(), "mbx-pmp-watch-root-"));
  const n = new MbxNode(home, { host: "alpha" });
  let client: Client | null = null;
  t.after(async () => { await client?.close().catch(() => {}); n.close(); for (const d of [home, root]) rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
  const project = folder(root, "agentmbx", CLEO_ID);
  for (const name of ["agentmbx-lead", "agentmbx-worker"]) { n.registerAgent(name); delegateWake(n, name); }
  const owner = unlockOwnerKey(home, PASS);
  const rec = makeLead({ project, agent: "agentmbx-lead", host: "alpha", ownerPub: owner.publicKey });
  storeLead(n, rec, signData(owner.privateKey, canonical(rec)));
  // A Claude session reachable through its inbox socket (named for the MCP server's parent, as Claude Code names it): the server pushes itself.
  const dir = mkdtempSync(join(tmpdir(), "mbx-pmp-sock-")), sock = join(dir, `${process.pid}.sock`), pushed: Record<string, any>[] = [];
  const inbox = createServer((c) => { let buf = ""; c.on("data", (d) => { buf += d; let i; while ((i = buf.indexOf("\n")) >= 0) { pushed.push(JSON.parse(buf.slice(0, i))); buf = buf.slice(i + 1); } }); });
  if (via === "socket") await new Promise<void>((r) => inbox.listen(sock, r));
  t.after(() => { inbox.close(); rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
  const env = { ...process.env, AGENTMBX_DEV: "1", MBX_HOME: home, MBX_CLI: via === "socket" ? "claude" : "kimi", MBX_AGENT: as, MBX_NO_DESKTOP: "1", MBX_DEBUG: "",
    ...(via === "socket" ? { CLAUDE_CODE_MESSAGING_SOCKET: sock, CLAUDE_CODE_MESSAGING_TOKEN: "tok" } : {}) } as Record<string, string>;
  client = new Client({ name: `pm-watch-${as}`, version: "1" });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [resolve("bin/agentmbx.js"), "mcp"], env, cwd: project }));
  if (via === "socket") return { n, project, slot: slotFor(CLEO_ID), pushed, watcher: null as never };
  const child = spawn(process.execPath, [resolve("bin/agentmbx.js"), "watch"], { env: { ...env, MBX_AGENT: "", MBX_WATCH_INTERVAL_MS: "200" }, cwd: project });
  let out = "", err = ""; child.stdout.on("data", (d) => { out += d; }); child.stderr.on("data", (d) => { err += d; });
  t.after(() => { child.kill(); });
  const watcher = { child, out: () => out, err: () => err, exited: new Promise<number | null>((r) => child.on("exit", r)) };
  assert.ok(await until(() => liveWatcher(n, as)), `${as}'s watcher registers itself: ${err.slice(0, 300)} ${out.slice(0, 200)}`);
  return { n, project, slot: slotFor(CLEO_ID), watcher, pushed };
}

test("T493 S3: the lead's watcher wakes on project mail with a no-body hint that names the project mailbox", async (t) => {
  const { n, project, slot, watcher: lead } = await watchWorld(t, "agentmbx-lead");
  const status = sendLeased(n, { from: "boss", to: ["agentmbx"], subject: "fyi", body: "status body", kind: "status", project } as never).envelope;
  assert.deepEqual(stored(n, status.id), [{ agent: slot, state: "delivered" }]);
  assert.ok(await until(() => stored(n, status.id)[0]?.state === "notified"), "status mail to the project is marked seen without waking");
  assert.equal(lead.child.exitCode, null, "status never wakes");

  const req = sendLeased(n, { from: "boss", to: ["agentmbx"], subject: "please review", body: "secret project body", kind: "request", project } as never).envelope;
  assert.deepEqual((await dispatchWakes(n)).filter((r) => r.agent === "agentmbx-lead" || r.agent === slot), [], "the daemon dispatcher leaves slot rows alone and defers to the live watcher");
  assert.equal(await lead.exited, 0);
  assert.match(lead.out(), /^\[mbx\] 1 new message\(s\) for agentmbx-lead in the project mailbox agentmbx from boss@alpha/);
  assert.ok(lead.out().includes(req.id) && !lead.out().includes("secret project body") && !lead.out().includes(status.id), "ids of wanted mail only, never bodies");
  assert.match(lead.out(), /mbx_ack project=agentmbx/);
  assert.equal(lead.out().includes(slot), false, "the reserved slot name is not shown");
  assert.deepEqual(stored(n, req.id), [{ agent: slot, state: "notified" }]);
  assert.ok(n.store.db.prepare("SELECT 1 FROM audit WHERE event='wake.attempt' AND detail LIKE '%agentmbx-lead%' AND detail LIKE '%watcher%'").get(), "recorded against the lead, not the slot");
});

test("T493 S3: a muted lead is not woken by project mail, and mail to the project stays delivered", async (t) => {
  const { n, project, slot, watcher: lead } = await watchWorld(t, "agentmbx-lead");
  muteWakes(n, "agentmbx-lead", new Date(Date.now() + 3_600_000));
  const req = sendLeased(n, { from: "boss", to: ["agentmbx"], subject: "please review", body: "b", kind: "request", project } as never).envelope;
  await new Promise((r) => setTimeout(r, 1500));
  assert.equal(lead.child.exitCode, null, "the lead's mute applies to its project mailbox");
  assert.deepEqual(stored(n, req.id), [{ agent: slot, state: "delivered" }]);
  muteWakes(n, "agentmbx-lead", null);
  assert.equal(await lead.exited, 0, "and unmuted, the same mail wakes it");
  assert.match(lead.out(), /in the project mailbox agentmbx/);
});

test("T493 S3: a recent wake of the lead batches project mail into the same window, so one lead is not woken twice", async (t) => {
  const { n, project, slot, watcher: lead } = await watchWorld(t, "agentmbx-lead");
  assert.equal(n.reserveWake("agentmbx-lead", null).brake, null, "the lead was just woken for something else");
  const req = sendLeased(n, { from: "boss", to: ["agentmbx"], subject: "please review", body: "b", kind: "request", project } as never).envelope;
  await new Promise((r) => setTimeout(r, 1500));
  assert.equal(lead.child.exitCode, null, "the batching window is the lead's, not the slot's");
  assert.deepEqual(stored(n, req.id), [{ agent: slot, state: "delivered" }], "and the mail waits for the next window");
});

test("T493 S3: a Claude lead's own MCP server pushes project mail through its session socket with the same no-body hint", async (t) => {
  const { n, project, slot, pushed } = await watchWorld(t, "agentmbx-lead", "socket");
  const req = sendLeased(n, { from: "boss", to: ["agentmbx"], subject: "please review", body: "secret project body", kind: "request", project } as never).envelope;
  assert.ok(await until(() => pushed.length >= 2, 15_000), "the hint reaches the session socket");
  assert.deepEqual(pushed[0], { type: "auth", token: "tok" });
  const hint = pushed[1]!.message.content as string;
  assert.match(hint, /^\[mbx\] 1 new message\(s\) for agentmbx-lead in the project mailbox agentmbx from boss@alpha/);
  assert.ok(hint.includes(req.id) && !hint.includes("secret project body") && !hint.includes(slot), "ids only: no body and no reserved slot name");
  assert.ok(await until(() => stored(n, req.id)[0]?.state === "notified"), "the project copy is marked notified");
  assert.ok(n.store.db.prepare("SELECT 1 FROM audit WHERE event='wake.attempt' AND detail LIKE '%agentmbx-lead%' AND detail LIKE '%session socket%'").get());
  assert.deepEqual((await dispatchWakes(n)).filter((r) => r.agent === slot), [], "the daemon leaves slot rows alone");
});

test("T493 S3: a muted Claude lead is not pushed project mail until it is unmuted", async (t) => {
  const { n, project, slot, pushed } = await watchWorld(t, "agentmbx-lead", "socket");
  muteWakes(n, "agentmbx-lead", new Date(Date.now() + 3_600_000));
  const req = sendLeased(n, { from: "boss", to: ["agentmbx"], subject: "please review", body: "b", kind: "request", project } as never).envelope;
  await new Promise((r) => setTimeout(r, 3_500)); // more than two channel ticks
  assert.deepEqual(pushed, [], "muted: nothing reaches the session");
  assert.deepEqual(stored(n, req.id), [{ agent: slot, state: "delivered" }]);
  muteWakes(n, "agentmbx-lead", null);
  assert.ok(await until(() => pushed.length >= 2, 15_000), "unmuted, the same mail is pushed");
});

test("T493 S3: a watcher that is not the project lead's is not woken by project mail, and the mail stays where it is", async (t) => {
  const { n, project, slot, watcher: worker } = await watchWorld(t, "agentmbx-worker");
  const req = sendLeased(n, { from: "boss", to: ["agentmbx"], subject: "please review", body: "secret project body", kind: "request", project } as never).envelope;
  await new Promise((r) => setTimeout(r, 1500));
  assert.equal(worker.child.exitCode, null, "a worker's watcher does not wake for the project's mail");
  assert.equal(worker.out(), "");
  assert.deepEqual(stored(n, req.id), [{ agent: slot, state: "delivered" }], "untouched: not marked notified by a watcher that is not the lead's");
});

test("T493 S3: the signed directory still verifies for a reader that knows only `agents`", async (t) => {
  const w = await world(t);
  w.designate();
  const j = signedDirectory(w.A.n);
  const { verifyData } = await import("../src/crypto.ts");
  assert.equal(verifyData(w.A.n.key.publicKey, canonical({ v: 1, host: j.host, agents: j.agents }), j.sig), true, "an older peer rebuilds {v, host, agents} and the extra keys are invisible to it");
  assert.equal(verifyData(w.A.n.key.publicKey, canonical({ v: 1, host: j.host, projects: j.projects }), j.projects_sig), true);
  assert.equal(JSON.stringify(j.agents).includes("pm-"), false, "no slot appears among the agent rows");
});
