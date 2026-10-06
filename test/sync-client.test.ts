// T262: link gate, seq, backoff, resume, and the daemon loader's allowlist.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { canonical, fingerprint, signData, ulid } from "../src/crypto.ts";
import { MbxNode } from "../src/node.ts";
import { createOwnerKey, unlockOwnerKey } from "../src/owner.ts";
import { acceptSigned, makePolicy } from "../src/policy.ts";
import { registerIdentity } from "../src/registry.ts";
import { LINK_KEY, STATE_KEY, postUrl, syncOnce, type Kv, type SyncLink } from "../src/sync-client.ts";
import { loadSyncSnapshot, policyScope, syncTick } from "../src/sync-daemon.ts";
import { PATH_FLAG_PREFIX, type AgentInput, type HostInput, type SyncSnapshot } from "../src/sync-projection.ts";

const KEY = "github.com/example/widget";
const PASS = "correct horse battery staple";

function mem(): Kv & { raw: Map<string, string> } {
  const raw = new Map<string, string>();
  return { raw, get: (k) => raw.get(k), set: (k, v) => { raw.set(k, v); } };
}
function link(over: Partial<SyncLink> = {}): SyncLink {
  return { v: 1, sync_url: "https://cloud.example/v1/host/sync", token: "sekret-token-value", contract: { min: 1, max: 1 }, ...over };
}
function host(): HostInput {
  return { daemon_version: "0.5.10", os: "macos", owner_fp: null, authority_owner: false, relay_enrolled: false, peers: [], findings: [] };
}
function body(): Omit<SyncSnapshot, "now" | "seq" | "full" | "contract" | "contractAllowsProjectPaths" | "sentReceipts"> {
  return { host: host(), agents: [], threads: [], receipts: [], policies: [], approvals: [], paths: [] };
}
function ok(seq: number, extra: Record<string, unknown> = {}, status = 200, headers?: Record<string, string>): Response {
  return new Response(JSON.stringify({ ack_seq: seq, next_sync_seconds: 15, ...extra }), { status, headers });
}
function tempNode(t: { after: (fn: () => void) => void }, hostName = "alpha"): MbxNode {
  const home = mkdtempSync(join(tmpdir(), "mbx-sync-"));
  const n = new MbxNode(home, { host: hostName });
  t.after(() => { n.close(); rmSync(home, { recursive: true, force: true }); });
  return n;
}

test("postUrl rewrites a websocket sync URL to HTTP", () => {
  assert.equal(postUrl("wss://cloud.example/v1/host/sync"), "https://cloud.example/v1/host/sync");
  assert.equal(postUrl("ws://cloud.example/v1/host/sync"), "http://cloud.example/v1/host/sync");
  assert.equal(postUrl("https://cloud.example/v1/host/sync"), "https://cloud.example/v1/host/sync");
});

test("no link means no fetch and no source call", async () => {
  let fetches = 0, sources = 0;
  const result = await syncOnce({
    kv: mem(), now: 0,
    fetch: async () => { fetches++; return ok(1); },
    source: () => { sources++; return body(); },
  });
  assert.deepEqual(result, { outcome: "unlinked" });
  assert.equal(fetches, 0);
  assert.equal(sources, 0);
});

test("a contract range that excludes version 1 makes no network call", async () => {
  const kv = mem();
  kv.set(LINK_KEY, JSON.stringify(link({ contract: { min: 2, max: 4 } })));
  const audits: string[] = [];
  let fetches = 0;
  const result = await syncOnce({
    kv, now: 0, fetch: async () => { fetches++; return ok(1); }, source: () => body(),
    audit: (event) => { audits.push(event); },
  });
  assert.deepEqual(result, { outcome: "sync.contract" });
  assert.equal(fetches, 0);
  assert.deepEqual(audits, ["sync.contract"]);
});

test("over cap does not fetch", async () => {
  const kv = mem();
  kv.set(LINK_KEY, JSON.stringify(link()));
  let fetches = 0;
  const result = await syncOnce({
    kv, now: 0, fetch: async () => { fetches++; return ok(1); },
    source: () => ({ ...body(), agents: Array.from({ length: 501 }, () => ({ name: "worker" } as AgentInput)) }),
  });
  assert.deepEqual(result, { outcome: "sync.cap" });
  assert.equal(fetches, 0);
});

test("seq resumes the same bytes, then a delta, and a path command does not change the opt-in", async () => {
  const kv = mem();
  kv.set(LINK_KEY, JSON.stringify(link({ sync_url: "wss://cloud.example/v1/host/sync", project_paths: true })));
  const absolute = "/Users/zzadaqq/work/zzadaqq/repo";
  const sent: { url: string; body: string; auth: string }[] = [];
  let sources = 0;
  let step = 0;
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const headers = init?.headers as Record<string, string>;
    sent.push({ url: String(input), body: String(init?.body), auth: headers.authorization });
    step++;
    if (step === 1) throw new Error("reset");
    if (step === 2) return ok(1, { commands: [{ key: `${PATH_FLAG_PREFIX}${KEY}`, value: "1" }, { local_path: absolute }] });
    return ok(JSON.parse(String(init?.body)).seq as number);
  };
  const source = () => {
    sources++;
    return { ...body(), paths: [{ project_key: KEY, absolute, home: "/Users/zzadaqq", username: "zzadaqq", windows: false }] };
  };
  const first = await syncOnce({ kv, fetch, now: 0, source });
  assert.deepEqual(first, { outcome: "retry", seq: 1 });
  assert.equal(sources, 1);
  assert.equal(JSON.parse(kv.get(STATE_KEY)!).snapshot_hash, undefined);
  const second = await syncOnce({ kv, fetch, now: 5_000, source });
  assert.deepEqual(second, { outcome: "acked", seq: 1 });
  assert.equal(sources, 1, "a drop before ack resends the stored bytes");
  assert.equal(sent[0].body, sent[1].body);
  assert.equal(sent[1].url, "https://cloud.example/v1/host/sync");
  assert.equal(sent[1].auth, "Bearer sekret-token-value");
  assert.equal(sent[1].body.includes("sekret-token-value"), false);
  assert.equal(sent[1].body.includes("zzadaqq"), false);
  assert.equal(sent[1].body.includes("project_paths"), false);
  assert.equal(JSON.parse(sent[1].body).full, true);
  assert.equal([...kv.raw.keys()].some((k) => k.startsWith(PATH_FLAG_PREFIX)), false);
  const third = await syncOnce({ kv, fetch, now: 20_000, source });
  assert.equal(third.outcome, "acked");
  assert.equal(JSON.parse(sent[2].body).full, false);
  assert.equal(sources, 2);
});

test("429 waits at least the last next_sync_seconds and never more than 300s", async () => {
  const kv = mem();
  kv.set(LINK_KEY, JSON.stringify(link()));
  const waits: number[] = [];
  let n = 0;
  const fetch: typeof globalThis.fetch = async () => {
    n++;
    if (n === 1) return ok(1, { next_sync_seconds: 40 });
    const header = n === 2 ? "1" : "1000";
    return new Response(JSON.stringify({ ack_seq: 1 }), { status: 429, headers: { "retry-after": header } });
  };
  await syncOnce({ kv, fetch, now: 1_000, source: () => body() });
  await syncOnce({ kv, fetch, now: 1_000 + 40_000, source: () => body() });
  waits.push(JSON.parse(kv.get(STATE_KEY)!).next_at);
  await syncOnce({ kv, fetch, now: waits[0], source: () => body() });
  const afterCap = JSON.parse(kv.get(STATE_KEY)!).next_at as number;
  assert.equal(waits[0], 1_000 + 40_000 + 40_000, "Retry-After 1s cannot outrun the 40s floor");
  assert.equal(afterCap - waits[0], 300_000);
});

test("401 retries the same seq and 409 forces a new full snapshot at ack+1", async () => {
  const kv = mem();
  kv.set(LINK_KEY, JSON.stringify(link()));
  const seqs: number[] = [];
  let n = 0;
  const fetch: typeof globalThis.fetch = async (_url, init) => {
    const batch = JSON.parse(String(init?.body)) as { seq: number; full: boolean };
    seqs.push(batch.seq);
    n++;
    if (n === 1) return new Response("{}", { status: 401 });
    if (n === 2) return new Response(JSON.stringify({ ack_seq: 7, error: "SYNC_GAP" }), { status: 409 });
    assert.equal(batch.full, true);
    return ok(batch.seq);
  };
  await syncOnce({ kv, fetch, now: 0, source: () => body() });
  await syncOnce({ kv, fetch, now: 5_000, source: () => body() });
  const result = await syncOnce({ kv, fetch, now: 5_000, source: () => body() });
  assert.deepEqual(seqs, [1, 1, 8]);
  assert.deepEqual(result, { outcome: "acked", seq: 8 });
});

test("the daemon tick stays silent without a link, and a linked tick does not send secrets", async (t) => {
  const n = tempNode(t);
  const absolute = `${homedir()}/projects/${userInfo().username}/SECRETPATH-9f3a`;
  const ts = "2026-10-05T00:00:00.000Z";
  registerIdentity(n.store, { name: "worker", role: "builder" });
  n.registerAgent("worker", { cli: "grok", role: "builder", description: "SECRETDESC-9f3a" });
  n.store.db.prepare("INSERT INTO identity_projects (name, project, first_seen, last_seen) VALUES (?,?,?,?)").run("worker", absolute, ts, ts);
  n.store.db.prepare("INSERT INTO identity_projects (name, project, first_seen, last_seen) VALUES (?,?,?,?)").run("worker", `${homedir()}/old/SECRETPATH-9f3a`, ts, "2026-10-04T00:00:00.000Z");
  n.store.set(`${PATH_FLAG_PREFIX}${KEY}`, "1");
  const id = ulid();
  n.store.db.prepare(`INSERT INTO messages (id,ts,from_addr,thread,reply_to,kind,subject,body,envelope,origin,trust,authority,received_at)
    VALUES (?,?,?,?,NULL,'task',?,?,?,'local','legacy',NULL,?)`).run(
    id, ts, "lead@fedora", id, "SECRETSUBJECT-9f3a", "SECRETBODY-9f3a",
    JSON.stringify({ meta: { hop: 3 }, body: "SECRETBODY-9f3a", cwd: "/tmp/SECRETCWD-9f3a", path: absolute }), ts);
  n.store.addDelivery(id, "worker", "notified");
  n.store.db.prepare("UPDATE deliveries SET note=? WHERE msg_id=?").run("SECRETNOTE-9f3a", id);
  n.store.db.prepare("INSERT INTO sessions (agent, cli, session_id, cwd, pid, session_key, channel, updated_at) VALUES ('worker','grok',?,?,1,'SECRETKEY-9f3a',0,?)")
    .run("SECRETSESSION-9f3a", "/tmp/SECRETCWD-9f3a", ts);
  n.store.db.prepare(`INSERT INTO identity_leases (name, token, holder_pid, holder_start, key_fp, cli, session_id, claimed_at, heartbeat_at, idle_ttl)
    VALUES ('worker', ?, 1, 'start', 'fp', 'grok', ?, ?, ?, 60000)`).run("SECRETTOKEN-9f3a", "SECRETSESSION-9f3a", Date.now(), Date.now());
  n.store.db.prepare(`INSERT INTO peers (host,pubkey,owner_pubkey,addr,state,code,nonce_local,nonce_remote,created_at) VALUES ('fedora',?,NULL,?,'approved',NULL,NULL,NULL,?)`)
    .run(n.key.publicKey, "https://peer.example/SECRETADDR-9f3a", ts);
  n.store.db.prepare(`INSERT INTO peers (host,pubkey,owner_pubkey,addr,state,code,nonce_local,nonce_remote,created_at) VALUES ('pending',?,NULL,?,'pending',NULL,NULL,NULL,?)`)
    .run(n.key.publicKey, "https://peer.example/SECRETPENDING-9f3a", ts);
  n.store.db.prepare("INSERT INTO policies (id, record, sig, owner_fp, iat, exp, revoked, received_at) VALUES ('bad','not-json-policy','x','dead-beef-dead-beef',?,?,0,?)")
    .run(ts, "2099-01-01T00:00:00.000Z", ts);

  let keyed = 0;
  const keyOf = () => { keyed++; return KEY; };
  const unlinked = await syncTick(n, { now: 0, projectKeyOf: keyOf, fetch: async () => { throw new Error("fetch"); } });
  assert.deepEqual(unlinked, { outcome: "unlinked" });
  assert.equal(keyed, 0);

  const allowed = loadSyncSnapshot(n, { contractAllowsProjectPaths: true }, () => KEY);
  assert.equal(allowed.paths[0]?.absolute, absolute, "the newest checkout is the one that would be shaped");
  assert.deepEqual(loadSyncSnapshot(n, { contractAllowsProjectPaths: false }, () => KEY).paths, []);
  n.store.set(`${PATH_FLAG_PREFIX}${KEY}`, "0");
  assert.deepEqual(loadSyncSnapshot(n, { contractAllowsProjectPaths: true }, () => KEY).paths, []);
  n.store.set(`${PATH_FLAG_PREFIX}${KEY}`, "1");

  const previous = process.env.MBX_RELAY_URL;
  process.env.MBX_RELAY_URL = "https://relay.example/SECRETRELAY-9f3a";
  t.after(() => { if (previous === undefined) delete process.env.MBX_RELAY_URL; else process.env.MBX_RELAY_URL = previous; });
  n.store.set(LINK_KEY, JSON.stringify(link({ project_paths: true })));
  let posted = "";
  const result = await syncTick(n, {
    now: 0, projectKeyOf: keyOf,
    fetch: async (_url, init) => { posted = String(init?.body); const seq = JSON.parse(posted).seq as number; return ok(seq); },
  });
  assert.equal(result.outcome, "acked");
  for (const secret of ["SECRETBODY-9f3a", "SECRETSUBJECT-9f3a", "SECRETNOTE-9f3a", "SECRETDESC-9f3a", "SECRETSESSION-9f3a", "SECRETCWD-9f3a", "SECRETTOKEN-9f3a", "SECRETKEY-9f3a", "SECRETADDR-9f3a", "SECRETPENDING-9f3a", "SECRETRELAY-9f3a", "SECRETPATH-9f3a", "not-json-policy", "dead-beef-dead-beef", homedir()]) {
    assert.equal(posted.includes(secret), false, secret);
  }
  const user = userInfo().username;
  if (user.length >= 4 && !"github.com/example/widget alpha fedora worker unknown macos".includes(user)) assert.equal(posted.includes(user), false, "username");
  const batch = JSON.parse(posted) as { full: boolean; contract: number; host: { project_paths?: unknown; relay: { enrolled: boolean; last_pull_at: null }; peers: { host_name: string }[] }; agents: { upsert: { cli: string; state: string; holder: { cli: string } | null }[] }; threads: { upsert: { flags: unknown[]; trust: string[]; subject_hash: null; max_relay_depth: number }[] } };
  assert.equal(batch.full, true);
  assert.equal(batch.contract, 1);
  assert.equal(batch.host.project_paths, undefined);
  assert.equal(batch.host.relay.enrolled, true);
  assert.equal(batch.host.relay.last_pull_at, null);
  assert.deepEqual(batch.host.peers.map((peer) => peer.host_name), ["fedora"]);
  assert.equal(batch.agents.upsert[0].cli, "unknown");
  assert.equal(batch.agents.upsert[0].holder?.cli, "unknown");
  assert.equal(batch.agents.upsert[0].state, "live");
  assert.deepEqual(batch.threads.upsert[0].flags, []);
  assert.deepEqual(batch.threads.upsert[0].trust, ["unverified"]);
  assert.equal(batch.threads.upsert[0].subject_hash, null);
  assert.equal(batch.threads.upsert[0].max_relay_depth, 3);
  assert.equal(posted.includes(`"grok"`), false);
  assert.equal(posted.includes(fingerprint(n.key.publicKey)), true);
});

test("a local policy path is not sent and an invalid policy reason is not sent", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "mbx-sync-pol-"));
  createOwnerKey(home, PASS);
  const n = new MbxNode(home, { host: "alpha" });
  t.after(() => { n.close(); rmSync(home, { recursive: true, force: true }); });
  const owner = unlockOwnerKey(home, PASS);
  const secret = `${homedir()}/SECRET-POLICY-PATH`;
  const rec = makePolicy({ level: "collaborate", agents: ["worker"], hosts: ["alpha"], projects: [secret, KEY], ownerPub: owner.publicKey });
  assert.equal(acceptSigned(n.store.db, { rec, sig: signData(owner.privateKey, canonical(rec)) }, n.host), null);
  n.store.set(LINK_KEY, JSON.stringify(link()));
  let posted = "";
  const result = await syncTick(n, {
    now: 0, projectKeyOf: () => undefined,
    fetch: async (_url, init) => { posted = String(init?.body); return ok(JSON.parse(posted).seq as number); },
  });
  assert.equal(result.outcome, "acked");
  assert.equal(posted.includes("SECRET-POLICY-PATH"), false);
  assert.equal(posted.includes(homedir()), false);
  const policies = JSON.parse(posted).policies.upsert as { project_keys: string[]; has_local_scope: boolean; source: string }[];
  assert.equal(policies.length, 1);
  assert.deepEqual(policies[0].project_keys, [KEY]);
  assert.equal(policies[0].has_local_scope, true);
  assert.equal(policies[0].source, "cli");
  assert.deepEqual(policyScope([secret, KEY]), { project_keys: [KEY], has_local_scope: true });
});
