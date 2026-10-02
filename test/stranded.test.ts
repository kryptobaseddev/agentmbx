// Stranded mail (S2): a received envelope never creates a phantom mailbox for a bare name that lives on the sender's
// host; legacy phantoms are retired on request; mail that waits in a never-held mailbox goes back to its sender.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildEnvelope, signEnvelope } from "../src/envelope.ts";
import { MbxNode } from "../src/node.ts";
import { phantomMailboxes, retirePhantoms, returnNeverClaimed } from "../src/stranded.ts";
import { registerIdentity } from "../src/registry.ts";

function pair(t: { after: (fn: () => void) => void }) {
  const home = mkdtempSync(join(tmpdir(), "mbx-stranded-"));
  const a = new MbxNode(join(home, "a"), { host: "alpha" });
  const b = new MbxNode(join(home, "b"), { host: "beta" });
  t.after(() => { a.close(); b.close(); rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
  b.upsertPendingPeer({ host: "alpha", pubkey: a.key.publicKey, owner_pubkey: null, addr: "127.0.0.1:0", code: "000000", nonce_local: "n", nonce_remote: "n" });
  b.approvePeer("alpha");
  const from = (to: string[], subject = "s") => signEnvelope(buildEnvelope({ from: "lead@alpha", to, subject, body: "b" }), "alpha", a.key.publicKey, a.key.privateKey);
  return { a, b, from };
}

test("receive: a bare name that is not an agent here is not delivered here; known bare names and explicit addresses are", (t) => {
  const { b, from } = pair(t);
  b.registerAgent("claude");
  const e = from(["claude@beta", "drum"]);
  assert.equal(b.receive(e, "alpha"), "accepted");
  assert.equal(b.inbox("claude").length, 1);
  assert.equal(b.inbox("drum").length, 0, "drum lives on alpha: no phantom mailbox on beta");
  assert.match(String((b.store.db.prepare("SELECT detail FROM audit WHERE event='receive.skipped'").get() as { detail: string }).detail), /drum: not an agent on beta/);
  assert.equal(b.receive(from(["claude"]), "alpha"), "accepted");
  assert.equal(b.inbox("claude").length, 2, "a bare name that exists here is still delivered");
  registerIdentity(b.store, { name: "reviewer", role: "review" });
  b.receive(from(["reviewer"]), "alpha");
  assert.equal(b.inbox("reviewer").length, 1, "a registered identity counts as established");
  b.receive(from(["newbie@beta"]), "alpha");
  assert.equal(b.inbox("newbie").length, 1, "an explicit name@thishost is delivered (return-to-sender covers typos)");
});

test("legacy phantom mailboxes are found and retired by doctor --fix; real mailboxes never are", (t) => {
  const { b, from } = pair(t);
  // a phantom left by the old receive path: delivered to drum here, and drum is an agent on alpha
  b.store.db.prepare("INSERT INTO agents (name,host,role,cli,description,last_seen) VALUES ('drum','alpha',NULL,'kimi',NULL,?)").run(new Date().toISOString());
  const e = from(["drum"], "v0.5.1 shipped");
  b.store.insertMessage(e, "alpha", "verified", null); b.store.addDelivery(e.id, "drum");
  // not phantoms: a local name with local mail, and a remote-only name that alpha doesn't know
  b.registerAgent("worker"); b.send({ from: "boss", to: ["worker"], subject: "s", body: "b" });
  const odd = from(["stranger@beta"]);
  b.store.insertMessage(odd, "alpha", "verified", null); b.store.addDelivery(odd.id, "stranger");
  assert.deepEqual(phantomMailboxes(b).map((p) => [p.name, p.hosts]), [["drum", ["alpha"]]]);
  assert.deepEqual(retirePhantoms(b, false).map((p) => p.name), ["drum"], "dry run changes nothing");
  assert.equal(b.inbox("drum").length, 1);
  retirePhantoms(b, true);
  assert.equal(b.inbox("drum").length, 0);
  const d = b.store.db.prepare("SELECT state,note FROM deliveries WHERE agent='drum'").get() as { state: string; note: string };
  assert.equal(d.state, "acked"); assert.match(d.note, /phantom mailbox retired: addressed to drum@alpha/);
  assert.ok(b.store.db.prepare("SELECT 1 FROM audit WHERE event='mailbox.phantom_retired'").get());
  assert.equal(b.inbox("worker").length, 1); assert.equal(b.inbox("stranger").length, 1);
  assert.deepEqual(phantomMailboxes(b), []);
});

test("never-claimed mail goes back to its sender after N days; older mail, held mailboxes and 0 days are left alone", (t) => {
  const home = mkdtempSync(join(tmpdir(), "mbx-return-"));
  const n = new MbxNode(home, { host: "alpha" });
  t.after(() => { n.close(); rmSync(home, { recursive: true, force: true }); });
  const now = Date.now(), day = 86_400_000, iso = (ms: number) => new Date(ms).toISOString();
  n.store.set("stranded-return-since", iso(now - 30 * day));
  n.registerAgent("boss");
  const send = (to: string, ageDays: number, subject: string) => {
    const id = n.send({ from: "boss", to: [to], subject, body: "b" }).envelope.id;
    n.store.db.prepare("UPDATE messages SET received_at=? WHERE id=?").run(iso(now - ageDays * day), id);
    return id;
  };
  const stale = send("ghost", 8, "typo'd recipient");
  const fresh = send("ghost", 2, "recent");
  const ancient = send("ghost", 40, "before the feature");
  assert.deepEqual(returnNeverClaimed(n, now, 0), [], "0 days turns it off");
  const r = returnNeverClaimed(n, now, 7);
  assert.deepEqual(r.map((x) => x.id), [stale]);
  const notice = n.inbox("boss").find((m) => m.subject.startsWith("Returned unread"))!;
  assert.match(notice.subject, /Returned unread: typo'd recipient/);
  assert.equal(notice.reply_to, stale); assert.match(notice.body, /there is no agent named ghost on alpha/);
  const d = n.store.db.prepare("SELECT state,note FROM deliveries WHERE msg_id=? AND agent='ghost'").get(stale) as { state: string; note: string };
  assert.equal(d.state, "acked"); assert.match(d.note, /returned to sender after 7 days \(mailbox never established\)/);
  assert.deepEqual(n.inbox("ghost").map((m) => m.id).sort(), [fresh, ancient].sort());
  assert.deepEqual(returnNeverClaimed(n, now, 7), [], "idempotent: nothing returned twice");
  // a mailbox a session once held is the owner's to decide (doctor lists it), never returned
  n.store.db.prepare(`INSERT INTO identity_leases (name,token,holder_pid,holder_start,key_fp,cli,session_id,claimed_at,heartbeat_at,idle_ttl,released_at,release_reason)
    VALUES ('held-once','t',1,'s','k','claude','sid',0,0,1,1,'released')`).run();
  send("held-once", 9, "to a released mailbox");
  assert.deepEqual(returnNeverClaimed(n, now, 7), []);
});

test("real mailboxes without a lease are never returned, and a copy is returned exactly once", (t) => {
  const home = mkdtempSync(join(tmpdir(), "mbx-return2-"));
  const n = new MbxNode(home, { host: "alpha" });
  t.after(() => { n.close(); rmSync(home, { recursive: true, force: true }); });
  const now = Date.now(), day = 86_400_000, iso = (ms: number) => new Date(ms).toISOString();
  n.store.set("stranded-return-since", iso(now - 30 * day));
  n.registerAgent("boss");
  const send = (to: string) => {
    const id = n.send({ from: "boss", to: [to], subject: `to ${to}`, body: "b" }).envelope.id;
    n.store.db.prepare("UPDATE messages SET received_at=? WHERE id=?").run(iso(now - 9 * day), id);
    return id;
  };
  // a script that reads with `agentmbx inbox`: registered by the CLI, never leased
  n.registerAgent("nightly-script", { cli: "cli" });
  registerIdentity(n.store, { name: "backfilled", role: "ops" });
  n.store.set("alias:old-name", "boss");
  for (const to of ["nightly-script", "backfilled"]) send(to);
  n.store.addDelivery(send("boss"), "old-name");
  assert.deepEqual(returnNeverClaimed(n, now, 7), [], "established mailboxes keep their mail");
  assert.equal(n.inbox("nightly-script").length, 1);
  // exactly once: a marker written before a crash means no second notice, only the ack
  const typo = send("typo");
  n.store.set(`returned:${typo}:typo`, iso(now));
  assert.deepEqual(returnNeverClaimed(n, now, 7), []);
  assert.equal(n.inbox("boss").filter((m) => m.subject.startsWith("Returned unread")).length, 0);
  assert.equal((n.store.db.prepare("SELECT state FROM deliveries WHERE msg_id=? AND agent='typo'").get(typo) as { state: string }).state, "acked");
  const typo2 = send("typo-two");
  assert.deepEqual(returnNeverClaimed(n, now, 7).map((x) => x.id), [typo2]);
  assert.deepEqual(returnNeverClaimed(n, now, 7), []);
  assert.equal(n.inbox("boss").filter((m) => m.subject === "Returned unread: to typo-two").length, 1);
  assert.match(n.inbox("boss").find((m) => m.subject === "Returned unread: to typo-two")!.body, /there is no agent named typo-two on alpha/);
});
