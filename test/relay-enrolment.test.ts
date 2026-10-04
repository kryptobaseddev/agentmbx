// Relay encryption advertisements and enrolment recovery (T168, docs/spec/relay-durability.md §1, §8):
// - AC1: tampered, expired, wrong-peer, unsigned (and unexpiring v1) enc-key ads never give a sender a key to seal for;
// - AC2: a relay reset or a store that no longer knows this host makes the daemon re-enrol with a signed challenge and
//   republish its ad in the same pass, never fall back to v1 or plaintext;
// - AC3: key rotation, revocation and refused enrolment keep queued mail and tell doctor the truth;
// plus `relay set --key` pinning and the pluggable EnrolmentAuthority.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { MbxNode } from "../src/node.ts";
import { fingerprint, generateKeyPair } from "../src/crypto.ts";
import { checkEncAd, encFromRelayAnswer, signEncAd, ENC_AD_TTL_MS } from "../src/enc-ad.ts";
import { RelayCore, startRelayServer, type EnrolmentAuthority } from "../src/relay.ts";
import { SqliteRelayStore } from "../src/relay-store.ts";
import { relayOpen, relayPin, relayPushOutbox, relayReceive, relayRoute, relayState } from "../src/relay-v2.ts";
import { generateEncKeyPair, openBody } from "../src/body-encryption.ts";

const RELAY = "http://relay.test:7374"; // the URL the hosts know; the routed fetch sends it to whichever relay runs now
const count = (n: MbxNode, sql: string, ...args: (string | number)[]) => Number((n.store.db.prepare(sql).get(...args) as { c: number }).c);
const lanFailedTwice = (n: MbxNode) => n.store.db.prepare("UPDATE outbox SET attempts=2, next_at=?").run(new Date(Date.now() - 1000).toISOString());
const audits = (n: MbxNode, event: string) => (n.store.db.prepare("SELECT detail FROM audit WHERE event=? ORDER BY rowid").all(event) as { detail: string }[]).map((r) => r.detail);

async function world(t: { after: (fn: () => unknown) => void }, o: { core?: RelayCore } = {}) {
  const homes = [mkdtempSync(join(tmpdir(), "mbx-t168-a-")), mkdtempSync(join(tmpdir(), "mbx-t168-b-"))];
  const a = new MbxNode(homes[0], { host: "alpha" }), b = new MbxNode(homes[1], { host: "beta" });
  a.addApprovedPeer({ host: "beta", pubkey: b.key.publicKey, owner_pubkey: null, addr: "127.0.0.1:1" }, "fixture");
  b.addApprovedPeer({ host: "alpha", pubkey: a.key.publicKey, owner_pubkey: null, addr: "127.0.0.1:1" }, "fixture");
  b.registerAgent("bob"); a.registerAgent("alice");
  const servers: Server[] = [];
  const route = { url: "" };
  /** Start (or restart, after a reset) the relay behind RELAY. */
  const serve = async (core: RelayCore) => {
    const s = await startRelayServer(core, 0, "127.0.0.1");
    servers.push(s);
    route.url = `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
    return core;
  };
  let core = await serve(o.core ?? new RelayCore());
  t.after(() => {
    a.close(); b.close(); homes.forEach((h) => rmSync(h, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
    return Promise.all(servers.map((s) => new Promise<void>((r) => { s.closeAllConnections(); s.close(() => r()); })));
  });
  const f: typeof fetch = (input, init) => fetch(String(input).replace(RELAY, route.url), init);
  const open = async (n: MbxNode, ff: typeof fetch = f) => relayOpen(n, RELAY, ff);
  const reset = async (next: RelayCore) => { core = await serve(next); return core; };
  return { a, b, f, open, reset, route, get core() { return core; } };
}

/** A fetch that answers GET enc-key with whatever `edit` makes of the relay's real answer: a lying relay. */
const lyingEncKey = (f: typeof fetch, edit: (j: Record<string, unknown>) => Record<string, unknown>): typeof fetch => async (input, init) => {
  const res = await f(input, init);
  if (!(String(input).includes("/relay/enc-key") && (init?.method ?? "GET") === "GET") || res.status !== 200) return res;
  return new Response(JSON.stringify(edit(await res.json() as Record<string, unknown>)), { status: 200, headers: { "content-type": "application/json" } });
};

async function doctorLines(n: MbxNode): Promise<string[]> {
  const { doctor } = await import("../src/doctor.ts");
  const old = process.env.MBX_RELAY_URL;
  process.env.MBX_RELAY_URL = RELAY;
  try { return (await doctor({ home: n.home, cmd: ["agentmbx"], which: () => null, useClis: false } as never, n.home, { peerTimeoutMs: 500 })).map((c) => `${c.level} ${c.label}${c.fix ? ` | fix: ${c.fix}` : ""}`); }
  finally { if (old === undefined) delete process.env.MBX_RELAY_URL; else process.env.MBX_RELAY_URL = old; }
}

test("AC1: an enc-key ad counts only when signed by the pinned key, naming that peer, inside its validity window", () => {
  const beta = generateKeyPair(), gamma = generateKeyPair(), enc = generateEncKeyPair().publicKey, now = Date.now();
  const peer = { host: "beta", pubkey: beta.publicKey };
  const good = signEncAd("beta", beta, enc, now);
  const answer = (ad: unknown, ad_sig: unknown, extra: Record<string, unknown> = {}) => ({ host: "beta", host_pubkey: beta.publicKey, ad, ad_sig, ...extra });
  assert.deepEqual(encFromRelayAnswer(answer(good.ad, good.sig), peer, now), { enc_pub: enc, iat: good.ad.iat });
  const reason = (j: Record<string, unknown>) => (encFromRelayAnswer(j, peer, now) as { reason?: string }).reason;
  // tampered: another key in the signed record, or an added field
  assert.equal(reason(answer({ ...good.ad, enc_pub: generateEncKeyPair().publicKey }, good.sig)), "bad signature");
  assert.equal(reason(answer({ ...good.ad, note: "x" }, good.sig)), "bad signature");
  assert.deepEqual(encFromRelayAnswer(answer(good.ad, good.sig, { enc_pub: generateEncKeyPair().publicKey, sig: "c2ln" }), peer, now), { enc_pub: enc, iat: good.ad.iat },
    "a v1 key served beside a valid record is ignored: only the signed record counts");
  // expired, not yet valid, or valid for too long (all validly signed by the right key)
  const old = signEncAd("beta", beta, enc, now - ENC_AD_TTL_MS - 1000);
  assert.equal(reason(answer(old.ad, old.sig)), "expired");
  const future = signEncAd("beta", beta, enc, now + 3_600_000);
  assert.equal(reason(answer(future.ad, future.sig)), "not yet valid");
  const forever = signEncAd("beta", beta, enc, now, 365 * 86_400_000);
  assert.equal(reason(answer(forever.ad, forever.sig)), "lifetime over the maximum");
  // wrong peer: gamma's own valid ad, or beta's key under another name
  const g = signEncAd("gamma", gamma, enc, now);
  assert.equal(reason(answer(g.ad, g.sig)), "wrong peer");
  const renamed = signEncAd("not-beta", beta, enc, now);
  assert.equal(reason(answer(renamed.ad, renamed.sig)), "wrong peer");
  assert.equal(checkEncAd(g.ad, g.sig, { host_pubkey: gamma.publicKey }, now), null, "gamma's ad is fine for gamma");
  // unsigned, malformed, and unexpiring v1
  assert.equal(reason(answer(good.ad, undefined)), "unsigned");
  assert.equal(reason({ enc_pub: enc }), "unsigned");
  assert.equal(reason(answer({ ...good.ad, enc_pub: "short" }, good.sig)), "malformed");
  assert.match(reason({ host: "beta", enc_pub: enc, sig: "c2ln" })!, /unexpiring v1/);
});

test("AC1: the relay stores only the caller's own, current, validly signed v2 ad", async (t) => {
  const { a, b, core, open } = await world(t);
  assert.ok(await open(b));
  const enrol = core.store.getEnrolment(b.key.publicKey)!;
  const served = core.getEncAdByKey(b.key.publicKey)!;
  assert.equal(served.ad?.enc_pub, b.encKey.publicKey, "the daemon published the signed v2 record");
  assert.equal(served.sig !== undefined, true, "and the v1 pair for older senders");
  const refuse = (ad: unknown, sig: string, why: RegExp) => assert.throws(() => core.publishEncAdRecord(enrol, ad as never, sig), why);
  const other = signEncAd("alpha", a.key, a.encKey.publicKey);
  refuse(other.ad, other.sig, /wrong peer/);
  const stale = signEncAd("beta", b.key, b.encKey.publicKey, Date.now() - ENC_AD_TTL_MS - 1000);
  refuse(stale.ad, stale.sig, /expired/);
  const good = signEncAd("beta", b.key, b.encKey.publicKey);
  refuse({ ...good.ad, enc_pub: a.encKey.publicKey }, good.sig, /bad signature/);
  refuse(good.ad, "", /unsigned/);
  assert.equal(core.getEncAdByKey(b.key.publicKey)!.ad?.enc_pub, b.encKey.publicKey, "nothing replaced the real ad");
});

test("AC1: a lying relay's tampered, expired, wrong-peer, unsigned or v1-only ad never seals mail; it stays queued and doctor says why", async (t) => {
  const { a, b, f, open } = await world(t);
  assert.ok(await open(b));
  const mallory = generateEncKeyPair(), other = generateKeyPair();
  const lies: [string, (j: Record<string, unknown>) => Record<string, unknown>, RegExp][] = [
    ["tampered", (j) => ({ ...j, enc_pub: mallory.publicKey, ad: { ...(j.ad as object), enc_pub: mallory.publicKey } }), /bad signature/],
    ["expired", (j) => { const x = signEncAd("beta", b.key, b.encKey.publicKey, Date.now() - ENC_AD_TTL_MS - 60_000); return { ...j, ad: x.ad, ad_sig: x.sig }; }, /expired/],
    ["wrong peer", (j) => { const x = signEncAd("gamma", other, mallory.publicKey); return { ...j, enc_pub: mallory.publicKey, ad: x.ad, ad_sig: x.sig }; }, /wrong peer/],
    ["unsigned", (j) => { const { ad_sig: _, ...rest } = j; return rest; }, /unsigned/],
    ["v1 only", (j) => { const { ad: _a, ad_sig: _s, ...rest } = j; return rest; }, /unexpiring v1/],
  ];
  a.send({ from: "alice", to: ["bob@beta"], subject: "s", body: "for beta only" }); lanFailedTwice(a);
  for (const [name, edit, why] of lies) {
    const lying = lyingEncKey(f, edit);
    const s = await open(a, lying);
    assert.ok(s, name);
    assert.deepEqual(await relayPushOutbox(a, s!), { accepted: 0, rejected: 0 }, name);
    assert.equal(count(a, "SELECT COUNT(*) c FROM outbox"), 1, `${name}: the row stays queued`);
    assert.equal(count(a, "SELECT COUNT(*) c FROM relay_wire"), 0, `${name}: nothing was sealed`);
    assert.match(JSON.parse(a.store.get("relay-enc-rejected:beta")!).reason, why, name);
    assert.ok(audits(a, "enc_key.rejected").some((d) => why.test(d)), `${name}: audited`);
    lanFailedTwice(a);
  }
  const lines = await doctorLines(a);
  assert.ok(lines.some((l) => /^warn 1 message\(s\) for beta wait: the relay offers no valid encryption key ad for it \(unexpiring v1/.test(l)), lines.join("\n"));
  // the honest relay's ad works, and the reason clears
  const s = await open(a);
  assert.deepEqual(await relayPushOutbox(a, s!), { accepted: 1, rejected: 0 });
  assert.equal(a.store.get("relay-enc-rejected:beta") ?? null, null);
});

test("AC2: a relay reset (fresh store, same key) makes both hosts re-enrol with a signed challenge and republish; mail is re-pushed sealed, once", async (t) => {
  const w = await world(t);
  const { a, b } = w;
  assert.ok(await w.open(b));
  a.send({ from: "alice", to: ["bob@beta"], subject: "before the reset", body: "sealed please" }); lanFailedTwice(a);
  assert.equal((await relayPushOutbox(a, (await w.open(a))!)).accepted, 1);
  // the relay loses everything but its key: a new store, a new epoch, no enrolments, no ads
  const fresh = await w.reset(new RelayCore(undefined, { store: new SqliteRelayStore(), key: w.core.key }));
  assert.equal(fresh.store.getEnrolment(b.key.publicKey), null);
  assert.ok(await w.open(b), "beta re-enrols in the same pass");
  const sa = await w.open(a);
  assert.ok(sa, "alpha re-enrols in the same pass");
  for (const n of [a, b]) {
    const e = fresh.store.getEnrolment(n.key.publicKey)!;
    assert.equal(e.authorized_by, "host-key-challenge", "a signed challenge, not a remembered flag");
    assert.equal(fresh.getEncAdByKey(n.key.publicKey)?.ad?.enc_pub, n.encKey.publicKey, "the signed ad is back");
    assert.ok(audits(n, "relay.enrolled").length >= 2);
    assert.equal(relayState(n, RELAY)?.state, "ok");
  }
  assert.equal(count(a, "SELECT COUNT(*) c FROM outbox"), 1, "the new epoch put the relay-accepted row back in the outbox");
  assert.equal((await relayPushOutbox(a, sa!)).accepted, 1);
  for (const { envelope: e } of fresh.inspect(b.key.publicKey)) {
    assert.ok(e.enc, "sealed");
    assert.notEqual(e.body, "sealed please");
    assert.equal(openBody(e.enc!, b.encKey.privateKey, e.id), "sealed please");
  }
  assert.equal(await relayReceive(b, (await w.open(b))!), 1);
  assert.equal(b.inbox("bob").length, 1, "delivered once");
});

test("AC2: a store that lost this host's enrolment or ad in the same epoch is caught by the signed info answer, not trusted from a local flag", async (t) => {
  const { a, b, core, open } = await world(t);
  assert.ok(await open(b)); assert.ok(await open(a));
  const db = (core.store as SqliteRelayStore).db;
  // alpha's row vanishes (a restore that kept its epoch, an operator's mistake); its local flag still says enrolled
  db.prepare("DELETE FROM enrolments WHERE host_pubkey=?").run(a.key.publicKey);
  db.prepare("DELETE FROM enc_ads WHERE host_pubkey=?").run(a.key.publicKey);
  db.prepare("DELETE FROM enc_ad_records WHERE host_pubkey=?").run(a.key.publicKey);
  // beta's ad at the relay names a stale key
  db.prepare("UPDATE enc_ads SET enc_pub=? WHERE host_pubkey=?").run(generateEncKeyPair().publicKey, b.key.publicKey);
  a.send({ from: "alice", to: ["bob@beta"], subject: "s", body: "b" }); lanFailedTwice(a);
  const sa = await open(a);
  assert.ok(sa);
  assert.equal(audits(a, "relay.enrolment_lost").length, 1);
  assert.ok(core.store.getEnrolment(a.key.publicKey), "re-enrolled in the same pass");
  assert.equal(core.getEncAdByKey(a.key.publicKey)?.ad?.enc_pub, a.encKey.publicKey);
  // beta's stale v1 pair does not matter to alpha: only the signed v2 record counts, and mail moves in the same pass
  assert.equal((await relayPushOutbox(a, sa!)).accepted, 1, "and mail moves in the same pass");
  // beta notices its stale v1 pair (older senders still read it) and republishes
  assert.ok(await open(b));
  assert.equal(audits(b, "relay.enc_ad_missing").length, 1, "beta saw its stale ad and republished");
  assert.equal(core.getEncAdByKey(b.key.publicKey)?.enc_pub, b.encKey.publicKey);
});

test("AC3: this host's key rotation re-enrols the new key, republishes its ad, keeps the queued row and delivers it", async (t) => {
  const { a, b, core, open } = await world(t);
  assert.ok(await open(b)); assert.ok(await open(a));
  a.send({ from: "alice", to: ["bob@beta"], subject: "across a rotation", body: "still here" }); lanFailedTwice(a);
  const oldKey = a.key.publicKey, rotation = a.rotateKeys();
  assert.equal(count(a, "SELECT COUNT(*) c FROM outbox"), 1);
  const sa = await open(a);
  assert.ok(sa, "the relay took the rotation and the new key is enrolled");
  assert.equal(core.store.getEnrolment(oldKey)?.revoked_at !== null, true, "the old key is revoked there");
  const ad = core.getEncAdByKey(a.key.publicKey)!;
  assert.equal(ad.ad?.host_pubkey, a.key.publicKey);
  assert.equal(ad.ad?.enc_pub, a.encKey.publicKey, "the ad names the new enc key");
  assert.equal(core.getEncAdByKey(oldKey), null, "no ad for the retired key");
  assert.equal((await relayPushOutbox(a, sa!)).accepted, 1);
  assert.equal(b.acceptRotation(rotation), "rotated"); // the LAN rotation record reaches beta
  assert.equal(await relayReceive(b, (await open(b))!), 1);
  assert.equal(b.inbox("bob")[0]?.body, "still here");
});

test("AC3: a revoked host key keeps its mail queued, never falls back to v1, and doctor tells the truth", async (t) => {
  const { a, b, core, f, open } = await world(t);
  assert.ok(await open(b)); assert.ok(await open(a));
  a.send({ from: "alice", to: ["bob@beta"], subject: "s", body: "b" }); lanFailedTwice(a);
  (core.store as SqliteRelayStore).revokeEnrolment(a.key.publicKey, new Date().toISOString());
  const route = await relayRoute(a, RELAY, f);
  assert.equal(route.mode, "skip", "no session, and never v1");
  assert.equal(count(a, "SELECT COUNT(*) c FROM outbox"), 1);
  assert.equal(count(a, "SELECT COUNT(*) c FROM relay_sent"), 0);
  assert.equal(core.inspect(b.key.publicKey).length, 0);
  const st = relayState(a, RELAY)!;
  assert.equal(st.state, "enrol-failed");
  assert.equal(st.status, 403);
  assert.match(st.detail!, /revoked/);
  const lines = await doctorLines(a);
  assert.ok(lines.some((l) => l.startsWith(`warn relay configured: ${RELAY} (not yet enrolled`)), "a stale flag is not enrolment:\n" + lines.join("\n"));
  assert.ok(lines.some((l) => /^fail relay .* refused this host's enrolment .*403: this host key was revoked.*relay mail is paused; 1 message\(s\) wait in the outbox \(the LAN keeps trying/.test(l)), lines.join("\n"));
});

test("EnrolmentAuthority: a denial stores nothing and is reported; a grant records the account and the authority", async (t) => {
  const authority: EnrolmentAuthority = {
    name: "stub-accounts",
    authorize: (r) => r.host_name === "beta" ? { ok: true, account: "acct-1" } : { ok: false, reason: "no account for this host" },
  };
  const { a, b, core, open } = await world(t, { core: new RelayCore(undefined, { authority }) });
  // world() opened nothing yet for alpha; beta is granted
  assert.ok(await open(b));
  const e = core.store.getEnrolment(b.key.publicKey)!;
  assert.equal(e.account, "acct-1");
  assert.equal(e.authorized_by, "stub-accounts");
  assert.equal(await open(a), null);
  assert.equal(core.store.getEnrolment(a.key.publicKey), null, "a denial stores nothing");
  const st = relayState(a, RELAY)!;
  assert.equal(st.state, "enrol-failed");
  assert.equal(st.status, 403);
  assert.match(st.detail!, /no account for this host/);
  // an authority that throws denies (fail closed)
  const broken = new RelayCore(undefined, { authority: { name: "down", authorize: () => { throw new Error("jwks unreachable"); } } });
  const k = generateKeyPair(), { canonical, signData } = await import("../src/crypto.ts");
  const challenge = broken.challenge("gamma", k.publicKey);
  assert.throws(() => broken.enrol("gamma", k.publicKey, "", signData(k.privateKey, canonical({ v: 1, challenge, host: "gamma", pubkey: k.publicKey, owner_fp: "" }))), /not authorized: the enrolment authority is unavailable/);
  assert.equal(broken.store.getEnrolment(k.publicKey), null);
});

test("relay set --key pins only the named key; a changed relay key stops relay use until the owner confirms it", async (t) => {
  const w = await world(t);
  const { a, f } = w;
  const fp = fingerprint(w.core.key.publicKey);
  assert.equal((await relayPin(a, RELAY, "not-a-fingerprint", f)).ok, false);
  const wrong = await relayPin(a, RELAY, fingerprint(generateKeyPair().publicKey), f);
  assert.equal(wrong.ok, false);
  assert.match(wrong.message, new RegExp(`serves key ${fp}, not .*nothing was pinned`));
  assert.equal(a.store.get(`relay-key:${RELAY}`) ?? null, null);
  const ok = await relayPin(a, RELAY, fp.replace(/-/g, "").toUpperCase(), f); // any case, dashes optional
  assert.equal(ok.ok, true, ok.message);
  assert.equal(a.store.get(`relay-key:${RELAY}`), w.core.key.publicKey);
  assert.ok(await w.open(a));
  let lines = await doctorLines(a);
  assert.ok(lines.some((l) => l.startsWith(`ok relay configured: ${RELAY} (enrolled); relay key ${fp} pinned by the owner (relay set --key)`)), lines.join("\n"));
  // the relay comes back with another key (and so another store): relay use stops, doctor fails with the exact fix
  const next = await w.reset(new RelayCore());
  const nfp = fingerprint(next.key.publicKey);
  assert.equal(await w.open(a), null);
  assert.equal(relayState(a, RELAY)?.state, "key-mismatch");
  lines = await doctorLines(a);
  assert.ok(lines.some((l) => l.startsWith(`fail relay ${RELAY} now serves a different key than the one pinned`) && l.includes(`agentmbx relay set ${RELAY} --key ${nfp}`)), lines.join("\n"));
  const bare = await relayPin(a, RELAY, undefined, f);
  assert.equal(bare.ok, false, "a bare relay set never accepts a changed key");
  assert.match(bare.message, new RegExp(`--key ${nfp}`));
  const confirmed = await relayPin(a, RELAY, nfp, f);
  assert.equal(confirmed.ok, true, confirmed.message);
  assert.equal(audits(a, "relay.key_confirmed").length, 1);
  assert.ok(await w.open(a), "confirmed: the relay is used again (new key, new epoch, re-enrolled)");
  assert.ok(next.store.getEnrolment(a.key.publicKey));
  lines = await doctorLines(a);
  assert.ok(!lines.some((l) => /now serves a different key/.test(l)), lines.join("\n"));
});

test("relay set --key while the relay is unreachable: the daemon later pins only that key", async (t) => {
  const w = await world(t);
  const { a, f } = w;
  const down: typeof fetch = async () => { throw new Error("connect ECONNREFUSED"); };
  const real = fingerprint(w.core.key.publicKey);
  const r = await relayPin(a, RELAY, fingerprint(generateKeyPair().publicKey), down);
  assert.equal(r.ok, true);
  assert.match(r.message, /only when it serves key/);
  assert.equal(await w.open(a), null, "the relay serves another key: not pinned, not used");
  assert.equal(a.store.get(`relay-key:${RELAY}`) ?? null, null);
  assert.ok((await doctorLines(a)).some((l) => l.startsWith(`fail relay ${RELAY} now serves a different key than the one relay set --key named`)));
  assert.equal((await relayPin(a, RELAY, real, down)).ok, true);
  assert.ok(await w.open(a, f));
  assert.equal(a.store.get(`relay-key-src:${RELAY}`), "owner");
});

test("agentmbx relay set <url> --key: a mismatch exits 1 and changes nothing; the right key is pinned and shown", async (t) => {
  const { execFile } = await import("node:child_process");
  const home = mkdtempSync(join(tmpdir(), "mbx-t168-cli-"));
  const core = new RelayCore();
  const server = await startRelayServer(core, 0, "127.0.0.1");
  t.after(() => { rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); return new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); }); });
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const bin = join(import.meta.dirname, "../bin/agentmbx.js");
  const env = { ...process.env, MBX_HOME: home, MBX_NO_DESKTOP: "1" } as Record<string, string>;
  const run = (...args: string[]) => new Promise<{ code: number; out: string; err: string }>((res) =>
    execFile(process.execPath, [bin, ...args], { env }, (e, out, err) => res({ code: e ? Number((e as { code?: number }).code ?? 1) : 0, out: String(out), err: String(err) })));
  const relayInConfig = () => { try { return (JSON.parse(readFileSync(join(home, "config.json"), "utf8")) as { relay?: string }).relay; } catch { return undefined; } };
  const fp = fingerprint(core.key.publicKey);
  const bad = await run("relay", "set", url, "--key", fingerprint(generateKeyPair().publicKey));
  assert.equal(bad.code, 1, bad.err);
  assert.match(bad.err, new RegExp(`serves key ${fp}, not`));
  assert.equal(relayInConfig(), undefined, "nothing changed");
  const garbage = await run("relay", "set", url, "--key", "nope");
  assert.equal(garbage.code, 2, garbage.err);
  const good = await run("relay", "set", url, "--key", fp);
  assert.equal(good.code, 0, good.err);
  assert.match(good.out, new RegExp(`relay key ${fp} pinned \\(confirmed with --key\\)`));
  assert.equal(relayInConfig(), url);
});

// ---- review round 1 ---------------------------------------------------------------------------------------------------

/** A relay answering `status` to one route (method and path), the real relay for everything else. */
const answering = (f: typeof fetch, method: string, path: string, status: number): typeof fetch => async (input, init) =>
  new URL(String(input)).pathname === path && (init?.method ?? "GET") === method
    ? new Response(JSON.stringify({ error: "gone" }), { status, headers: { "content-type": "application/json" } })
    : f(input, init);

test("review: a relay that retired /v1 (404 or 410 to the v1 ad) is audited once and never stops relay use", async (t) => {
  const { a, b, core, f, open } = await world(t);
  let v2Posts = 0;
  const counting: typeof fetch = (input, init) => { if (String(input).endsWith("/v2/relay/enc-key") && init?.method === "POST") v2Posts++; return f(input, init); };
  const gone410 = answering(counting, "POST", "/v1/relay/enc-key", 410);
  for (let i = 0; i < 3; i++) assert.ok(await open(b, gone410), `pass ${i}: the session opens`);
  assert.equal(audits(b, "relay.enc_v1_retired").length, 1, "audited once");
  assert.equal(v2Posts, 1, "a retired v1 pair is no reason to republish every pass");
  assert.equal(core.getEncAdByKey(b.key.publicKey)?.sig, undefined, "no v1 pair at the relay");
  assert.equal(relayState(b, RELAY)?.state, "ok");
  // senders need only the v2 record
  a.send({ from: "alice", to: ["bob@beta"], subject: "s", body: "v2 only" }); lanFailedTwice(a);
  assert.equal((await relayPushOutbox(a, (await open(a))!)).accepted, 1);
  // 404 is the same; another v1 failure is audited but not fatal once the v2 record is stored
  for (const k of [`relay-enc-ad:${RELAY}`, `relay-enc-v1-down:${RELAY}`]) b.store.db.prepare("DELETE FROM kv WHERE k=?").run(k);
  assert.ok(await open(b, answering(f, "POST", "/v1/relay/enc-key", 404)));
  assert.equal(audits(b, "relay.enc_v1_retired").length, 2);
  b.store.db.prepare("DELETE FROM kv WHERE k=?").run(`relay-enc-ad:${RELAY}`);
  assert.ok(await open(b, answering(f, "POST", "/v1/relay/enc-key", 500)));
  assert.ok(audits(b, "relay.enc_publish_failed").some((d) => /"shape":"v1".*"fatal":false/.test(d)));
  // but on a relay too old for v2 records, the v1 pair is all there is: its failure stops the session
  b.store.db.prepare("DELETE FROM kv WHERE k=?").run(`relay-enc-ad:${RELAY}`);
  assert.equal(await open(b, answering(answering(f, "POST", "/v2/relay/enc-key", 404), "POST", "/v1/relay/enc-key", 410)), null);
  assert.equal(relayState(b, RELAY)?.state, "enc-ad-failed");
});

test("review: an older ad naming another key (a regenerated enc.key rolled back by a replay) is refused with its own doctor reason", async (t) => {
  const { a, b, core, f, open } = await world(t);
  assert.ok(await open(b));
  const first = core.getEncAdByKey(b.key.publicKey)!; // what a relay could keep and replay for 30 days
  a.send({ from: "alice", to: ["bob@beta"], subject: "one", body: "1" }); lanFailedTwice(a);
  assert.equal((await relayPushOutbox(a, (await open(a))!)).accepted, 1);
  assert.equal(await relayReceive(b, (await open(b))!), 1);
  // beta's enc.key is regenerated under the same host key (the old private key is gone); it republishes a newer ad
  await new Promise((r) => setTimeout(r, 5));
  b.encKey = generateEncKeyPair();
  assert.ok(await open(b));
  assert.equal(core.getEncAdByKey(b.key.publicKey)?.ad?.enc_pub, b.encKey.publicKey);
  a.send({ from: "alice", to: ["bob@beta"], subject: "two", body: "2" }); lanFailedTwice(a);
  assert.equal((await relayPushOutbox(a, (await open(a))!)).accepted, 1, "the newer ad is accepted");
  // the relay replays the first ad: still unexpired and validly signed, but older and naming a key beta no longer holds
  const replay = lyingEncKey(f, () => ({ ...first }));
  a.send({ from: "alice", to: ["bob@beta"], subject: "three", body: "3" }); lanFailedTwice(a);
  assert.equal((await relayPushOutbox(a, (await open(a, replay))!)).accepted, 0);
  assert.equal(count(a, "SELECT COUNT(*) c FROM outbox"), 1, "the row stays queued");
  assert.equal(count(a, "SELECT COUNT(*) c FROM relay_wire WHERE msg_id NOT IN (SELECT msg_id FROM relay_sent)"), 0, "nothing sealed for the old key");
  assert.match(JSON.parse(a.store.get("relay-enc-rejected:beta")!).reason, /^rolled back: /);
  const lines = await doctorLines(a);
  assert.ok(lines.some((l) => /^warn 1 message\(s\) for beta wait: the relay served an older encryption key ad for it than one already accepted, a possible replay/.test(l)), lines.join("\n"));
  // an older ad naming the current key rolls nothing back (a publisher's clock may step back): accepted
  const newest = () => JSON.parse(a.store.get(`relay-enc-newest:${b.key.publicKey}`)!) as { iat: string; enc_pub: string };
  const before = newest();
  assert.equal(before.enc_pub, b.encKey.publicKey);
  const sameKeyOlder = signEncAd("beta", b.key, b.encKey.publicKey, Date.now() - 3_600_000);
  lanFailedTwice(a);
  assert.equal((await relayPushOutbox(a, (await open(a, lyingEncKey(f, (j) => ({ ...j, ad: sameKeyOlder.ad, ad_sig: sameKeyOlder.sig }))))!)).accepted, 1);
  assert.deepEqual(newest(), before, "an older same-key ad never lowers the newest accepted iat");
  assert.equal(await relayReceive(b, (await open(b))!), 2, "two and three arrive, sealed for the key beta holds");
  assert.equal(count(b, "SELECT COUNT(*) c FROM relay_quarantine"), 0, "nothing was sealed for the key beta no longer holds");
});

/** The relay's view of a host whose signed hops it refuses (as it does for a clock off by more than 5 min): challenge and
 *  enrol work, a signed info answer carries no `you`, every other signed call is 401 with a Date `relayOffsetMs` from ours. */
function refusingSigned(f: typeof fetch, relayOffsetMs: number, seen: { challenges: number }): typeof fetch {
  return async (input, init) => {
    const path = new URL(String(input)).pathname, h = { ...(init?.headers as Record<string, string> | undefined) };
    if (path === "/v1/relay/challenge") seen.challenges++;
    if (!h["x-mbx-sig"] || path === "/v1/relay/challenge" || path === "/v1/relay/enrol") return f(input, init);
    if (path === "/v2/relay/info") { delete h["x-mbx-sig"]; return f(input, { ...init, headers: h }); } // answered, but no `you`
    return new Response(JSON.stringify({ error: "bad relay hop" }), { status: 401, headers: { "content-type": "application/json", date: new Date(Date.now() + relayOffsetMs).toUTCString() } });
  };
}

test("review: a host whose clock is off re-enrols with backoff, not every tick, and doctor says clock skew", async (t) => {
  const { a, core, f, open } = await world(t);
  const seen = { challenges: 0 }, skewed = refusingSigned(f, -10 * 60_000, seen); // this host runs 10 min ahead
  assert.equal(await open(a, skewed), null);
  assert.ok(core.store.getEnrolment(a.key.publicKey), "the unsigned enrolment itself worked");
  let st = relayState(a, RELAY)!;
  assert.equal(st.state, "clock-skew");
  assert.match(st.detail!, /about 10 min ahead of the relay's/);
  const since = st.at;
  const backoff = () => JSON.parse(a.store.get(`relay-enrol-backoff:${RELAY}`)!) as { n: number; next_at: string };
  const due = (n?: number) => a.store.set(`relay-enrol-backoff:${RELAY}`, JSON.stringify({ n: n ?? backoff().n, next_at: new Date(Date.now() - 1).toISOString() }));
  assert.equal(backoff().n, 1);
  assert.ok(Date.parse(backoff().next_at) - Date.now() > 50_000);
  for (let i = 0; i < 3; i++) assert.equal(await open(a, skewed), null);
  assert.equal(seen.challenges, 1, "no re-enrolment while the backoff runs");
  await new Promise((r) => setTimeout(r, 5));
  due();
  assert.equal(await open(a, skewed), null);
  assert.equal(seen.challenges, 2);
  assert.equal(backoff().n, 2);
  assert.ok(Date.parse(backoff().next_at) - Date.now() > 110_000, "the wait doubles");
  assert.equal(relayState(a, RELAY)!.at, since, "doctor's since stays at the start of the episode");
  due(12);
  assert.equal(await open(a, skewed), null);
  const wait = Date.parse(backoff().next_at) - Date.now();
  assert.ok(wait <= 3_600_000 && wait > 3_590_000, `capped at 1 h (${wait} ms)`);
  assert.equal(audits(a, "relay.clock_skew").length, 1, "audited once per episode");
  const lines = await doctorLines(a);
  assert.ok(lines.some((l) => l.startsWith(`fail relay ${RELAY} refuses this host's signed requests right after enrolling it (since ${since})`) && l.includes("about 10 min ahead") && l.includes("network time")), lines.join("\n"));
  assert.ok(!lines.some((l) => /encryption key ad since/.test(l)), "not reported as an enc-ad failure");
  // the clock is fixed: the next signed answer ends the backoff at once
  assert.ok(await open(a, f));
  assert.equal(a.store.get(`relay-enrol-backoff:${RELAY}`) ?? null, null);
  st = relayState(a, RELAY)!;
  assert.equal(st.state, "ok");
});

test("review 2: a 401 right after enrolment while the clocks agree backs off but is not called clock skew", async (t) => {
  const { a, f, open } = await world(t);
  const seen = { challenges: 0 };
  assert.equal(await open(a, refusingSigned(f, 20_000, seen)), null); // 20 s apart: inside the relay's 5 min window
  const st = relayState(a, RELAY)!;
  assert.equal(st.state, "refused-after-enrol");
  assert.match(st.detail!, /refused right after enrolment; clocks agree \((19|20|21) s apart\)/); // Date has 1 s resolution
  assert.equal((JSON.parse(a.store.get(`relay-enrol-backoff:${RELAY}`)!) as { n: number }).n, 1, "the backoff still applies");
  assert.equal(audits(a, "relay.clock_skew").length, 0);
  assert.equal(audits(a, "relay.signed_refused").length, 1);
  const lines = await doctorLines(a);
  const line = lines.find((l) => l.startsWith(`fail relay ${RELAY} refuses this host's signed requests right after enrolling it`));
  assert.ok(line && /clocks agree/.test(line) && !/network time|clock right/.test(line), lines.join("\n"));
});

test("review 2: an answer confirming the enrolment ends a leftover backoff, so the next skew episode starts at 1 min", async (t) => {
  const { a, core, f, open } = await world(t);
  const k = `relay-enrol-backoff:${RELAY}`;
  assert.ok(await open(a));
  a.store.set(k, JSON.stringify({ n: 6, next_at: new Date(Date.now() + 3_600_000).toISOString() })); // left from an old episode
  // the relay confirms the enrolment, then the session fails for another reason: the confirmation alone ends the backoff
  a.store.db.prepare("DELETE FROM kv WHERE k=?").run(`relay-enc-ad:${RELAY}`);
  assert.equal(await open(a, answering(f, "POST", "/v2/relay/enc-key", 500)), null);
  assert.equal(relayState(a, RELAY)?.state, "enc-ad-failed");
  assert.equal(a.store.get(k) ?? null, null, "confirmed: the counter is gone");
  // a new episode: the relay lost the enrolment and the clock is off
  (core.store as SqliteRelayStore).db.prepare("DELETE FROM enrolments WHERE host_pubkey=?").run(a.key.publicKey);
  assert.equal(await open(a, refusingSigned(f, -10 * 60_000, { challenges: 0 })), null);
  const bo = JSON.parse(a.store.get(k)!) as { n: number; next_at: string };
  assert.equal(bo.n, 1);
  const wait = Date.parse(bo.next_at) - Date.now();
  assert.ok(wait <= 60_000 && wait > 50_000, `starts at 1 min (${wait} ms)`);
  assert.equal(audits(a, "relay.clock_skew").length, 1);
});

test("review 2: a stale v1 key beside the current v2 ad (v1 retired, enc.key regenerated) never strands mail; the publisher's doctor warns", async (t) => {
  const { a, b, core, f, open } = await world(t);
  assert.ok(await open(b)); // v1 pair and v2 record for beta's first key
  const oldEnc = b.encKey.publicKey;
  const gone = answering(f, "POST", "/v1/relay/enc-key", 410); // the relay retires /v1
  await new Promise((r) => setTimeout(r, 5));
  b.encKey = generateEncKeyPair(); // enc.key regenerated under the same host key
  assert.ok(await open(b, gone));
  const served = core.getEncAdByKey(b.key.publicKey)!;
  assert.equal(served.enc_pub, oldEnc, "the relay still serves the old v1 key");
  assert.equal(served.ad?.enc_pub, b.encKey.publicKey, "beside the new v2 record");
  a.send({ from: "alice", to: ["bob@beta"], subject: "s", body: "sealed for the new key" }); lanFailedTwice(a);
  assert.equal((await relayPushOutbox(a, (await open(a))!)).accepted, 1, "the sender takes the signed v2 record and ignores the v1 key");
  assert.equal(a.store.get("relay-enc-rejected:beta") ?? null, null);
  assert.equal(await relayReceive(b, (await open(b, gone))!), 1);
  assert.equal(b.inbox("bob")[0]?.body, "sealed for the new key");
  // the publisher is told: older senders would still seal for the old key
  const st = relayState(b, RELAY)!;
  assert.equal(st.state, "ok");
  assert.equal(st.v1_stale, fingerprint(oldEnc));
  const lines = await doctorLines(b);
  assert.ok(lines.some((l) => l.startsWith(`warn relay ${RELAY} still serves an old v1 encryption key for this host (${fingerprint(oldEnc)}) and refuses v1 updates (410)`)), lines.join("\n"));
});

test("review 2: a persistent v1 error (403) is audited once, retried only at the daily refresh, and never trips drift", async (t) => {
  const { b, f, open } = await world(t);
  const posts = { v1: 0, v2: 0 };
  const counting = (g: typeof fetch): typeof fetch => (input, init) => {
    if (init?.method === "POST" && String(input).endsWith("/v1/relay/enc-key")) posts.v1++;
    if (init?.method === "POST" && String(input).endsWith("/v2/relay/enc-key")) posts.v2++;
    return g(input, init);
  };
  const forbidden = counting(answering(f, "POST", "/v1/relay/enc-key", 403));
  for (let i = 0; i < 5; i++) assert.ok(await open(b, forbidden), `pass ${i}`);
  assert.deepEqual(posts, { v1: 1, v2: 1 }, "one publish in five passes");
  const v1Failures = () => audits(b, "relay.enc_publish_failed").filter((d) => d.includes('"shape":"v1"')).length;
  assert.equal(v1Failures(), 1, "audited once");
  assert.equal(audits(b, "relay.enc_ad_missing").length, 0, "the missing v1 pair is not drift");
  assert.equal(relayState(b, RELAY)?.v1_down, 403);
  // the daily refresh retries both; the same status is not audited again
  const aged = () => { const r = JSON.parse(b.store.get(`relay-enc-ad:${RELAY}`)!); b.store.set(`relay-enc-ad:${RELAY}`, JSON.stringify({ ...r, iat: new Date(Date.now() - 25 * 3_600_000).toISOString() })); };
  aged();
  assert.ok(await open(b, forbidden));
  assert.deepEqual(posts, { v1: 2, v2: 2 });
  assert.equal(v1Failures(), 1);
  // /v1 works again at the next refresh: the failure is forgotten
  aged();
  assert.ok(await open(b, counting(f)));
  assert.equal(b.store.get(`relay-enc-v1-down:${RELAY}`) ?? null, null);
  assert.equal(relayState(b, RELAY)?.v1_down, null);
});

test("with T167: relay restore keeps the newer signed v2 ad, and a host's own guard state never moves with the relay's", async (t) => {
  const { backupStore, lockStore, restoreStore } = await import("../src/relay-ops.ts");
  const dir = mkdtempSync(join(tmpdir(), "mbx-t168-restore-"));
  t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  const key = generateKeyPair(), storeAt = () => new SqliteRelayStore(join(dir, "relay.db"));
  const w = await world(t, { core: new RelayCore(undefined, { store: storeAt(), key }) });
  const { a, b } = w;
  const send = async (subject: string, accepted = 1) => { a.send({ from: "alice", to: ["bob@beta"], subject, body: subject }); lanFailedTwice(a); assert.equal((await relayPushOutbox(a, (await w.open(a))!)).accepted, accepted); };
  assert.ok(await w.open(b));
  await send("m1");
  assert.equal(await relayReceive(b, (await w.open(b))!), 1);
  const backup = await backupStore(dir, join(dir, "backups", "relay-1.db")); // holds beta's first ad
  const first = w.core.getEncAdByKey(b.key.publicKey)!.ad!;
  // after the backup beta regenerates enc.key and republishes; alpha accepts the newer ad
  await new Promise((r) => setTimeout(r, 5));
  b.encKey = generateEncKeyPair();
  assert.ok(await w.open(b));
  const second = w.core.getEncAdByKey(b.key.publicKey)!.ad!;
  assert.ok(Date.parse(second.iat) > Date.parse(first.iat));
  await send("m2");
  const guard = a.store.get(`relay-enc-newest:${b.key.publicKey}`);
  assert.equal(JSON.parse(guard!).iat, second.iat);
  a.store.set(`relay-enrol-backoff:${RELAY}`, JSON.stringify({ n: 3, next_at: new Date(Date.now() - 1).toISOString() })); // a host-side row
  // the operator restores the backup (the relay stopped)
  w.core.store.close();
  const lock = lockStore(dir)!; // what `relay serve` holds; the restore runs under it
  const r = await restoreStore(dir, backup.file, { lock });
  lock.release();
  assert.equal(r.carried.enc_ad_records, 1, "the live store's newer v2 record is carried");
  const core = await w.reset(new RelayCore(undefined, { store: storeAt(), key }));
  assert.deepEqual(core.getEncAdByKey(b.key.publicKey)!.ad, second, "the restored relay serves the newer ad, never the backup's older one");
  assert.equal(a.store.get(`relay-enc-newest:${b.key.publicKey}`), guard, "the sender's guard lives in its own store: untouched by the restore");
  assert.equal(JSON.parse(a.store.get(`relay-enrol-backoff:${RELAY}`)!).n, 3, "so does the enrolment backoff");
  // everyone converges on the new epoch: alpha re-pushes the unconfirmed m1 and m2 with m3; beta gets m2 and m3 sealed
  // for the key it holds, and m1 again as a duplicate
  assert.ok(await w.open(b));
  await send("m3", 3);
  assert.equal(await relayReceive(b, (await w.open(b))!), 2);
  assert.deepEqual(b.inbox("bob").map((m) => m.subject).sort(), ["m1", "m2", "m3"]);
  assert.equal(a.store.get(`relay-enrol-backoff:${RELAY}`) ?? null, null, "a confirmed enrolment ended the host's backoff");
});
