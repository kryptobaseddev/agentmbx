// Token pairing (agentmbx pair → agentmbx join) between two hosts over real HTTP on localhost, plus mDNS discovery.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo, Server } from "node:net";
import { generateKeyPair, joinTranscript, nonce, normalizePairToken, pairingCode, pairMac, pairTokenKey, newPairToken } from "../src/crypto.ts";
import { advertise, browse, decodeTxt, encodeTxt } from "../src/discovery.ts";
import { flushOutbox, pairJoin, pairWith, startServer, type JoinRequest, type PairHello } from "../src/http.ts";
import { MbxNode } from "../src/node.ts";

process.env.MBX_NO_DESKTOP = "1";
const tmp = () => mkdtempSync(join(tmpdir(), "mbx-pair-"));

async function up(host: string) {
  const n = new MbxNode(tmp(), { host, bind: "127.0.0.1", port: 0 });
  const s = await startServer(n, 0, "127.0.0.1");
  const addr = `127.0.0.1:${(s.address() as AddressInfo).port}`;
  return { n, s, addr };
}
const down = (...xs: { n: MbxNode; s: Server }[]) => xs.forEach((x) => { x.s.close(); x.n.close(); });

/** B joins A the way `agentmbx join` does, advertising its own test address. */
async function join_(B: { n: MbxNode; addr: string }, addr: string, token: string) {
  process.env.MBX_ADVERTISE = B.addr;
  try { return await pairJoin(B.n, addr, token); } finally { delete process.env.MBX_ADVERTISE; }
}

/** A hand-built join (hello + body) so tests can tamper with individual fields. */
async function rawJoin(A: { addr: string }, B: { n: MbxNode; addr: string }, token: string, tamper: (b: JoinRequest) => void) {
  const hello = await (await fetch(`http://${A.addr}/v1/pair/hello`)).json() as PairHello;
  const me = { host: B.n.host, host_pubkey: B.n.key.publicKey, owner_pubkey: null, nonce: nonce(), addr: B.addr };
  const body: JoinRequest = { v: 1, ...me, nonce_a: hello.nonce, mac: pairMac(pairTokenKey(token), "join", joinTranscript(hello, me)) };
  tamper(body);
  return fetch(`http://${A.addr}/v1/pair/join`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
}

const count = (n: MbxNode, sql: string) => (n.store.db.prepare(sql).get() as { n: number }).n;

test("pairing tokens: 60-bit Crockford XXXX-XXXX-XXXX, forgiving input, only scrypt(token) stored", () => {
  const t = newPairToken();
  assert.match(t, /^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/);
  assert.equal(normalizePairToken(t.toLowerCase().replace(/-/g, " ")), t.replace(/-/g, ""));
  assert.equal(normalizePairToken("oooo-iiii-llll"), "000011111111");
  assert.throws(() => normalizePairToken("ABCD-EFGH"), /malformed/);
  assert.throws(() => normalizePairToken("ABCD-EFGH-JKMU"), /malformed/); // U is not Crockford
  const n = new MbxNode(tmp(), { host: "alpha" });
  const { token } = n.createPairToken();
  const row = n.store.db.prepare("SELECT * FROM pair_tokens").get() as { key: string };
  assert.equal(row.key, pairTokenKey(token));
  assert.ok(!JSON.stringify(row).includes(normalizePairToken(token)), "the token itself is never stored");
  assert.throws(() => n.createPairToken(2 * 3_600_000), /TTL/);
  n.close();
});

test("token pairing: one command per side, both approved, messages flow both ways, notifications audited", async () => {
  const A = await up("alpha"), B = await up("beta");
  const { token } = A.n.createPairToken();
  const r = await join_(B, A.addr, token);
  assert.equal(r.host, "alpha");
  assert.equal(A.n.approvedPeer("beta")?.pubkey, B.n.key.publicKey);
  assert.equal(B.n.approvedPeer("alpha")?.pubkey, A.n.key.publicKey);
  assert.equal(A.n.approvedPeer("beta")?.addr, B.addr);
  assert.equal(B.n.approvedPeer("alpha")?.addr, A.addr);
  assert.equal(count(A.n, "SELECT count(*) n FROM pair_tokens WHERE state='used'"), 1);
  assert.equal(count(A.n, "SELECT count(*) n FROM audit WHERE event='pair.joined'"), 1);
  assert.equal(count(B.n, "SELECT count(*) n FROM audit WHERE event='pair.joined'"), 1);

  A.n.send({ from: "mac-dev", to: ["vida-dev@beta"], subject: "hello beta", body: "x", kind: "request" });
  assert.deepEqual(await flushOutbox(A.n), { sent: 1, failed: 0 });
  const got = B.n.inbox("vida-dev")[0];
  assert.equal(got.trust, "verified");
  B.n.send({ from: "vida-dev", to: [got.from_addr], subject: "re: hello", body: "y", kind: "reply", reply_to: got.id, thread: got.thread });
  assert.deepEqual(await flushOutbox(B.n), { sent: 1, failed: 0 });
  assert.equal(A.n.inbox("mac-dev")[0].subject, "re: hello");
  down(A, B);
});

test("reused token is rejected", async () => {
  const A = await up("alpha"), B = await up("beta"), C = await up("gamma");
  const { token } = A.n.createPairToken();
  await join_(B, A.addr, token);
  await assert.rejects(join_(C, A.addr, token), /no live pairing token/);
  assert.equal(A.n.peer("gamma"), undefined);
  assert.equal(C.n.peer("alpha"), undefined);
  down(A, B, C);
});

test("expired token is rejected", async () => {
  const A = await up("alpha"), B = await up("beta");
  const { token } = A.n.createPairToken(1_000);
  A.n.store.db.prepare("UPDATE pair_tokens SET expires_at=?").run(new Date(Date.now() - 1).toISOString());
  await assert.rejects(join_(B, A.addr, token), /no live pairing token/);
  assert.equal(A.n.peer("beta"), undefined);
  assert.equal(B.n.peer("alpha"), undefined);
  down(A, B);
});

test("wrong token is rejected, and 5 wrong attempts burn the real token", async () => {
  const A = await up("alpha"), B = await up("beta");
  const { token } = A.n.createPairToken();
  let wrong = newPairToken();
  while (wrong === token) wrong = newPairToken();
  for (let i = 0; i < 5; i++) await assert.rejects(join_(B, A.addr, wrong), /does not verify/);
  assert.equal(count(A.n, "SELECT count(*) n FROM pair_tokens WHERE state='burned'"), 1);
  await assert.rejects(join_(B, A.addr, token), /no live pairing token/);
  assert.equal(A.n.peer("beta"), undefined);
  assert.equal(B.n.peer("alpha"), undefined);
  assert.equal(count(A.n, "SELECT count(*) n FROM audit WHERE event='pair.join.failed'"), 5);
  down(A, B);
});

test("tampered join transcripts are rejected: swapped owner key, host key, host name, addr, or a rewritten hello", async () => {
  const A = await up("alpha"), B = await up("beta");
  const { token } = A.n.createPairToken();
  const evil = generateKeyPair().publicKey;
  for (const tamper of [
    (b: JoinRequest) => { b.owner_pubkey = evil; },
    (b: JoinRequest) => { b.host_pubkey = evil; },
    (b: JoinRequest) => { b.host = "mallory"; },
    (b: JoinRequest) => { b.addr = "10.6.6.6:7373"; },
  ]) {
    const res = await rawJoin(A, B, token, tamper);
    assert.equal(res.status, 401);
  }
  // A MITM that rewrites A's hello (its own host key) cannot get a valid MAC past A either
  const res = await rawJoin(A, B, token, (b) => {
    const fakeHello = { host: "alpha", host_pubkey: evil, owner_pubkey: null, nonce: b.nonce_a };
    b.mac = pairMac(pairTokenKey(token), "join", joinTranscript(fakeHello, { host: b.host, host_pubkey: b.host_pubkey, owner_pubkey: b.owner_pubkey, nonce: b.nonce, addr: b.addr }));
  });
  assert.equal(res.status, 401);
  assert.equal(A.n.peer("beta"), undefined);
  // those were five failed MACs, so the token is burned and even an honest join now fails
  const honest = await rawJoin(A, B, token, () => {});
  assert.equal(honest.status, 401, "5 failures burned the token");
  down(A, B);
});

test("a hello nonce answers only one join; a correct untampered raw join succeeds", async () => {
  const A = await up("alpha"), B = await up("beta");
  const { token } = A.n.createPairToken();
  let saved: JoinRequest | undefined;
  const res = await rawJoin(A, B, token, (b) => { saved = { ...b }; });
  assert.equal(res.status, 200);
  assert.equal(A.n.approvedPeer("beta")?.pubkey, B.n.key.publicKey);
  const replay = await fetch(`http://${A.addr}/v1/pair/join`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(saved) });
  assert.equal(replay.status, 401);
  down(A, B);
});

test("joiner refuses a fake token holder that cannot prove the token", async () => {
  const B = await up("beta");
  const fake = generateKeyPair();
  const srv = createServer((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    if (req.url === "/v1/pair/hello") return res.end(JSON.stringify({ v: 1, host: "alpha", host_pubkey: fake.publicKey, owner_pubkey: null, nonce: nonce() }));
    req.resume(); req.on("end", () => res.end(JSON.stringify({ v: 1, host: "alpha", mac: "AAAA" })));
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  const addr = `127.0.0.1:${(srv.address() as AddressInfo).port}`;
  await assert.rejects(join_(B, addr, newPairToken()), /did not prove it knows the token/);
  assert.equal(B.n.peer("alpha"), undefined);
  srv.close(); down(B);
});

test("SAS compare flow still works alongside tokens", async () => {
  const A = await up("alpha"), B = await up("beta");
  process.env.MBX_ADVERTISE = A.addr;
  const r = await pairWith(A.n, B.addr);
  delete process.env.MBX_ADVERTISE;
  assert.equal(A.n.peer("beta")!.code, B.n.peer("alpha")!.code);
  A.n.approvePeer("beta", r.code); B.n.approvePeer("alpha", r.code);
  A.n.send({ from: "mac-dev", to: ["vida-dev@beta"], subject: "sas", body: "x" });
  assert.deepEqual(await flushOutbox(A.n), { sent: 1, failed: 0 });
  down(A, B);
});

test("SAS: a responder in the middle cannot grind its nonce to show the code the other host shows (T032)", async () => {
  // Mallory answers alpha's pair --compare while posing as beta. Its session with the real beta already fixed the code
  // beta displays (`target`); whenever alpha's party is visible before mallory must commit to its own, it grinds a nonce.
  const A = await up("alpha"), mallory = generateKeyPair(), target = "424242";
  const party = (n: string) => ({ v: 1, host: "beta", host_pubkey: mallory.publicKey, owner_pubkey: null, nonce: n, addr: "127.0.0.1:1" });
  let sent: ReturnType<typeof party> | null = null;
  const answer = (j: { commit?: string; offer?: unknown }) => {
    if (j.commit) return sent = party(nonce()); // must answer before alpha's party is known: nothing to grind against
    if (j.offer) return { ok: true };
    for (let i = 0; i < 3e7 && !sent; i++) if (pairingCode(j as never, party(`g${i}`)) === target) sent = party(`g${i}`);
    return sent;
  };
  const srv = createServer((req, res) => {
    let b = ""; req.on("data", (c) => b += c);
    req.on("end", () => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(answer(JSON.parse(b)))); });
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  try {
    const r = await pairWith(A.n, `127.0.0.1:${(srv.address() as AddressInfo).port}`).catch((e: Error) => ({ code: `refused: ${e.message}` }));
    assert.notEqual(r.code, target, "the code alpha shows must not be steerable by the party it pairs with");
  } finally { srv.close(); down(A); }
});

test("SAS: a reveal without a matching commitment is refused and pairs nothing (T032)", async () => {
  const B = await up("beta"), A = new MbxNode(tmp(), { host: "alpha" });
  try {
    const offer = { v: 1, host: "alpha", host_pubkey: A.key.publicKey, owner_pubkey: null, nonce: nonce(), addr: "127.0.0.1:1" };
    const post = (body: unknown) => fetch(`http://${B.addr}/v1/pair`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    assert.equal((await post(offer)).status, 400, "a bare v1 offer (no commitment) is refused");
    assert.equal((await post({ v: 2, offer })).status, 401, "a reveal nobody committed to is refused");
    assert.equal(B.n.peer("alpha"), undefined);
  } finally { down(B); A.close(); }
});

test("discovery TXT records round-trip", () => {
  const txt = encodeTxt({ host: "alpha", fp: "1234-5678-9abc-def0", v: "1" });
  assert.deepEqual(txt.map(String), ["v=1", "host=alpha", "fp=1234-5678-9abc-def0"]);
  assert.deepEqual(decodeTxt(txt), { host: "alpha", fp: "1234-5678-9abc-def0", v: "1" });
  assert.deepEqual(decodeTxt([Buffer.from("HOST=x"), Buffer.from("host=y"), Buffer.from("junk"), "fp=a=b"]), { host: "x", fp: "a=b", v: undefined });
  assert.deepEqual(decodeTxt(undefined), { host: undefined, fp: undefined, v: undefined });
});

test("discovery: loopback advertise + browse (skipped when multicast is unavailable)", async (t) => {
  const host = `zz-test-${process.pid}`;
  const errors: Error[] = [];
  const ad = advertise({ host, fp: "aaaa-bbbb-cccc-dddd", v: "1", port: 45_678 }, (e) => errors.push(e));
  const seen = await browse(2_000);
  await ad.stop();
  const hit = seen.find((s) => s.host === host);
  if (!hit) return t.skip(`multicast unavailable here${errors.length ? ` (${errors[0].message})` : ""}`);
  assert.equal(hit.fp, "aaaa-bbbb-cccc-dddd");
  assert.equal(hit.port, 45_678);
  assert.match(hit.addr, /:45678$/);
});
