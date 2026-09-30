// T031: retention pruning (window, unacked, outbox, dry run, VACUUM, explicit replay gaps) and host identity
// export/import for machine replacement (pairings survive: signed, sealed mail still flows over real HTTP).
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import type { AddressInfo, Server } from "node:net";
import { flushOutbox, startServer } from "../src/http.ts";
import { MbxNode } from "../src/node.ts";
import { generateKeyPair } from "../src/crypto.ts";
import { IdentityLeases, inspectLeaseProcess } from "../src/identity-leases.ts";
import { prune } from "../src/retention.ts";
import { exportIdentity, importIdentity, openBundle } from "../src/identity-backup.ts";

process.env.MBX_NO_DESKTOP = "1";
const PASS = "correct horse battery staple";
const DAY = 86_400_000;
const tmp = (t: TestContext, prefix: string) => { const d = mkdtempSync(join(tmpdir(), prefix)); t.after(() => rmSync(d, { recursive: true, force: true })); return d; };
const ago = (days: number) => new Date(Date.now() - days * DAY).toISOString();
const tables = (n: MbxNode) => JSON.stringify(["messages", "deliveries", "mailbox_visibility", "mailbox_pruned", "outbox"].map((x) => n.store.db.prepare(`SELECT * FROM ${x}`).all()));

function mailbox(t: TestContext) {
  const home = tmp(t, "mbx-retain-"), node = new MbxNode(home, { host: "alpha" });
  t.after(() => node.close());
  node.addApprovedPeer({ host: "beta", pubkey: generateKeyPair().publicKey, owner_pubkey: null, addr: "127.0.0.1:9" }, "fixture");
  const send = (subject: string, to = ["reader"]) => node.send({ from: "sender", to, subject, body: `body-${subject}` }).envelope.id;
  const age = (id: string, received: number, updated = received) => {
    node.store.db.prepare("UPDATE messages SET received_at=? WHERE id=?").run(ago(received), id);
    node.store.db.prepare("UPDATE deliveries SET updated_at=? WHERE msg_id=?").run(ago(updated), id);
  };
  const ack = (id: string) => node.store.setDelivery(id, "reader", "acked");
  const leases = new IdentityLeases(node.store);
  const token = leases.claim("reader", { pid: process.pid, start: inspectLeaseProcess(process.pid).start!, keyFp: "aaaa-aaaa-aaaa-aaaa", cli: "test", sessionId: "test" }).token;
  return { home, node, send, age, ack, token };
}

test("pruning removes only settled mail outside the window; the dry run changes nothing; VACUUM runs", (t) => {
  const f = mailbox(t);
  const old = f.send("oldacked"); f.ack(old); f.age(old, 40);
  const unacked = f.send("oldunacked"); f.age(unacked, 40);
  const notified = f.send("oldnotified"); f.node.setDelivery(notified, "reader", "notified"); f.age(notified, 40);
  const queued = f.send("oldqueued", ["someone@beta"]); f.age(queued, 40);
  const recent = f.send("recent"); f.ack(recent); f.age(recent, 5);
  const lateAck = f.send("lateack"); f.ack(lateAck); f.age(lateAck, 40, 1);
  const before = tables(f.node);

  const dry = prune(f.node.store, 30, { dryRun: true, vacuum: true });
  assert.equal(tables(f.node), before, "a dry run writes nothing");
  assert.deepEqual({ messages: dry.messages, deliveries: dry.deliveries, kept: dry.kept, vacuumed: dry.vacuumed },
    { messages: 1, deliveries: 1, kept: { unacked: 2, outbox: 1, recent_activity: 1 }, vacuumed: false });

  const real = prune(f.node.store, 30, { vacuum: true });
  assert.equal(real.messages, 1); assert.equal(real.vacuumed, true);
  assert.equal(Number(f.node.store.db.prepare("PRAGMA freelist_count").get()!.freelist_count), 0, "VACUUM returned free pages");
  const left = (f.node.store.db.prepare("SELECT id FROM messages").all() as { id: string }[]).map((r) => r.id).sort();
  assert.deepEqual(left, [unacked, notified, queued, recent, lateAck].sort());
  assert.equal(f.node.store.db.prepare("SELECT 1 FROM deliveries WHERE msg_id=?").get(old), undefined);
  assert.equal(f.node.search("body-oldacked").length, 0, "the full-text index forgets pruned mail");
  assert.equal(f.node.search("body-recent").length, 1);
  assert.equal(f.node.store.db.prepare("SELECT count(*) n FROM outbox").get()!.n, 1, "queued mail stays queued");
  assert.equal(f.node.inbox("reader").length, 2, "unacked mail is intact");
  assert.ok(f.node.store.db.prepare("SELECT 1 FROM audit WHERE event='retention.pruned'").get());
  assert.equal(prune(f.node.store, 30, { vacuum: true }).messages, 0, "idempotent");
  assert.equal(prune(f.node.store, 30).vacuumed, false);
  assert.throws(() => prune(f.node.store, 0), /1 to/);
});

test("replay reports pruned history explicitly and old cursors stay valid", (t) => {
  const f = mailbox(t);
  const a = f.send("a"), b = f.send("b"), c = f.send("c");
  const first = f.node.replay("reader", f.token, { limit: 1 });
  assert.deepEqual(first.messages.map((m) => m.id), [a]);
  assert.equal(first.history_pruned, undefined, "no pruning, no field: existing output is unchanged");
  for (const id of [b, c]) { f.ack(id); f.age(id, 60); }
  assert.equal(prune(f.node.store, 30).messages, 2);
  const next = f.node.replay("reader", f.token, { cursor: first.next_cursor });
  assert.deepEqual(next.messages, []);
  assert.equal(next.history_pruned, 2, "the gap is reported, not skipped silently");
  assert.equal(next.has_more, false);
  const rewind = f.node.replay("reader", f.token);
  assert.deepEqual(rewind.messages.map((m) => m.id), [a]);
  assert.equal(rewind.history_pruned, 2);
  // Every position of a mailbox pruned: a completed cursor still polls instead of failing as "beyond history".
  f.ack(a); f.age(a, 60); prune(f.node.store, 30);
  const d = f.send("d");
  const poll = f.node.replay("reader", f.token, { cursor: next.next_cursor });
  assert.deepEqual(poll.messages.map((m) => m.id), [d]);
  assert.equal(poll.history_pruned, undefined);
});

async function up(t: TestContext, host: string, home = tmp(t, "mbx-idhost-")) {
  const n = new MbxNode(home, { host, bind: "127.0.0.1", port: 0 });
  const s = await startServer(n, 0, "127.0.0.1");
  let closed = false;
  const down = () => { if (closed) return; closed = true; s.close(); n.close(); };
  t.after(down);
  return { n, s, home, down, addr: `127.0.0.1:${(s.address() as AddressInfo).port}` };
}

test("a host identity restored on a new machine keeps its pairings: signed, sealed mail flows both ways", async (t) => {
  const A = await up(t, "alpha"), B = await up(t, "beta");
  A.n.addApprovedPeer({ host: "beta", pubkey: B.n.key.publicKey, owner_pubkey: null, addr: B.addr }, "fixture");
  B.n.addApprovedPeer({ host: "alpha", pubkey: A.n.key.publicKey, owner_pubkey: null, addr: A.addr }, "fixture");
  A.n.send({ from: "mac-dev", to: ["vida-dev@beta"], subject: "before", body: "before the move" });
  assert.deepEqual(await flushOutbox(A.n), { sent: 1, failed: 0 });
  const learnedEnc = A.n.peer("beta")!.enc_pub;
  assert.equal(learnedEnc, B.n.encKey.publicKey);

  const out = tmp(t, "mbx-bundle-"), file = join(out, "beta.identity");
  assert.deepEqual(exportIdentity(B.n, file, PASS), { host: "beta", peers: 1, owner: null });
  assert.equal(statSync(file).mode & 0o777, 0o600);
  const raw = readFileSync(file, "utf8");
  assert.ok(!raw.includes(B.n.key.privateKey) && !raw.includes(B.n.encKey.privateKey) && !raw.includes(A.n.key.publicKey), "the bundle is sealed");
  assert.throws(() => exportIdentity(B.n, file, PASS), /EEXIST/, "never overwrites a file silently");
  assert.throws(() => exportIdentity(B.n, join(out, "short"), "short"), /12 characters/);
  const oldKey = B.n.key, oldEnc = B.n.encKey;
  B.down(); // the old machine is retired

  const home2 = join(tmp(t, "mbx-newmachine-"), "home");
  assert.throws(() => importIdentity(home2, raw, "wrong passphrase!!"), (e: Error & { code?: string }) => e.code === "BAD_PASSPHRASE");
  assert.ok(!existsSync(join(home2, "host.key")), "a failed import writes nothing");
  const r = importIdentity(home2, raw, PASS);
  assert.deepEqual({ host: r.host, peers: r.peers, backup: r.backup }, { host: "beta", peers: ["alpha"], backup: null });
  for (const f of ["config.json", "host.key", "enc.key"]) assert.equal(statSync(join(home2, f)).mode & 0o777, 0o600);
  const B2 = await up(t, "ignored", home2);
  assert.equal(B2.n.host, "beta");
  assert.deepEqual(B2.n.key, oldKey); assert.deepEqual(B2.n.encKey, oldEnc);
  const pinned = B2.n.approvedPeer("alpha")!;
  assert.equal(pinned.pubkey, A.n.key.publicKey);
  // The replacement machine has a new address; the peer is pointed at it (its pinned keys are untouched).
  A.n.store.db.prepare("UPDATE peers SET addr=? WHERE host='beta'").run(B2.addr);
  B2.n.store.db.prepare("UPDATE peers SET addr=? WHERE host='alpha'").run(A.addr);

  A.n.send({ from: "mac-dev", to: ["vida-dev@beta"], subject: "after", body: "sealed after the move" });
  assert.deepEqual(await flushOutbox(A.n), { sent: 1, failed: 0 });
  assert.equal(A.n.peer("beta")!.enc_pub, learnedEnc, "the cached body key still seals for the restored host");
  const [got] = B2.n.inbox("vida-dev");
  assert.equal(got.body, "sealed after the move"); assert.equal(got.trust, "verified");
  assert.ok(JSON.parse(got.envelope).enc, "arrived sealed");

  B2.n.send({ from: "vida-dev", to: ["mac-dev@alpha"], subject: "reply", body: "signed by the same host key" });
  assert.deepEqual(await flushOutbox(B2.n), { sent: 1, failed: 0 });
  const [back] = A.n.inbox("mac-dev");
  assert.equal(back.body, "signed by the same host key"); assert.equal(back.trust, "verified");
});

test("import refuses an initialized home without --force; --force backs up the old identity first", (t) => {
  const src = tmp(t, "mbx-src-"), dst = tmp(t, "mbx-dst-"), file = join(tmp(t, "mbx-bundle-"), "x.identity");
  const a = new MbxNode(src, { host: "gamma" });
  writeFileSync(join(src, "owner.json"), JSON.stringify({ v: 1, backend: "keychain", public_key: generateKeyPair().publicKey, created_at: new Date().toISOString() }) + "\n", { mode: 0o600 });
  exportIdentity(a, file, PASS);
  a.close();
  const bundle = openBundle(readFileSync(file, "utf8"), PASS);
  assert.equal(bundle.owner?.backend, "keychain");
  assert.ok(!("file" in bundle.owner!), "a Keychain owner private key is never exported");

  const b = new MbxNode(dst, { host: "delta" });
  const oldKey = readFileSync(join(dst, "host.key"), "utf8");
  b.close();
  assert.throws(() => importIdentity(dst, readFileSync(file, "utf8"), PASS), (e: Error & { code?: string }) => e.code === "IDENTITY_EXISTS");
  assert.equal(readFileSync(join(dst, "host.key"), "utf8"), oldKey, "refusal changes nothing");

  const r = importIdentity(dst, readFileSync(file, "utf8"), PASS, { force: true });
  assert.ok(r.backup && existsSync(join(r.backup, "mbx.db")));
  assert.equal(readFileSync(join(r.backup!, "host.key"), "utf8"), oldKey, "the old identity is backed up first");
  assert.equal(statSync(join(r.backup!, "host.key")).mode & 0o777, 0o600);
  assert.equal(JSON.parse(readFileSync(join(r.backup!, "config.json"), "utf8")).host, "delta");
  assert.ok(!existsSync(join(dst, "owner.json")), "no unusable Keychain owner record is restored");
  const c = new MbxNode(dst);
  t.after(() => c.close());
  assert.equal(c.host, "gamma"); assert.deepEqual(c.key, bundle.host_key);
});

test("CLI: prune needs an explicit window by default; retention is opt-in config; identity import needs --force", (t) => {
  const home = tmp(t, "mbx-cli-retain-"), n = new MbxNode(home, { host: "alpha" }); n.close();
  const run = (...args: string[]) => spawnSync(process.execPath, [resolve("bin/agentmbx.js"), ...args], {
    encoding: "utf8", timeout: 20000, env: { ...process.env, MBX_HOME: home, AGENTMBX_DEV: "1", MBX_IDENTITY_PASSPHRASE: PASS } });
  const none = run("prune", "--dry-run");
  assert.equal(none.status, 2); assert.match(none.stderr, /no retention is configured/);
  assert.match(run("retention").stdout, /retention off \(default\)/);
  assert.equal(run("retention", "set", "90").status, 0);
  assert.equal(JSON.parse(readFileSync(join(home, "config.json"), "utf8")).retention_days, 90);
  const dry = run("prune", "--dry-run", "--json");
  assert.equal(dry.status, 0, dry.stderr);
  assert.deepEqual([JSON.parse(dry.stdout).dry_run, JSON.parse(dry.stdout).older_than_days], [true, 90]);
  assert.equal(run("retention", "off").status, 0);
  assert.equal(JSON.parse(readFileSync(join(home, "config.json"), "utf8")).retention_days, undefined);
  const file = join(home, "..", `${home.split("/").pop()}.identity`);
  t.after(() => rmSync(file, { force: true }));
  const exp = run("identity", "export", file);
  assert.equal(exp.status, 0, exp.stderr); assert.match(exp.stderr, /WARNING/);
  const imp = run("identity", "import", file);
  assert.equal(imp.status, 1); assert.match(imp.stderr, /already has a host identity/);
});
