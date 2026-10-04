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
  assert.deepEqual(encFromRelayAnswer(answer(good.ad, good.sig), peer, now), { enc_pub: enc });
  const reason = (j: Record<string, unknown>) => (encFromRelayAnswer(j, peer, now) as { reason?: string }).reason;
  // tampered: another key in the signed record, or an added field
  assert.equal(reason(answer({ ...good.ad, enc_pub: generateEncKeyPair().publicKey }, good.sig)), "bad signature");
  assert.equal(reason(answer({ ...good.ad, note: "x" }, good.sig)), "bad signature");
  assert.match(reason(answer(good.ad, good.sig, { enc_pub: generateEncKeyPair().publicKey }))!, /^tampered/, "a relay answering two keys");
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
  // beta's v1 pair and v2 record now disagree: alpha refuses both until beta republishes
  assert.equal((await relayPushOutbox(a, sa!)).accepted, 0);
  assert.match(JSON.parse(a.store.get("relay-enc-rejected:beta")!).reason, /^tampered/);
  assert.ok(await open(b));
  assert.equal(audits(b, "relay.enc_ad_missing").length, 1, "beta saw its stale ad and republished");
  assert.equal(core.getEncAdByKey(b.key.publicKey)?.enc_pub, b.encKey.publicKey);
  lanFailedTwice(a);
  assert.equal((await relayPushOutbox(a, (await open(a))!)).accepted, 1, "mail moves once beta's ad is current again");
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
