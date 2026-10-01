// Address healing and presence (T151/T201): a paired host that moved (DHCP) is found again without re-pairing, and the
// pin only ever moves to an address that answers a fresh challenge signed by the PINNED key and lists its own IP.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo, Server } from "node:net";
import {
  acceptPresence, announcedIPv4, flushOutbox, healPeerAddr, healStuckPeers, learnPeerAddr, pairWith, probePeer, resetLearnThrottle, sendPresence, signedStatus, splitAddr, startServer,
} from "../src/http.ts";
import { fingerprint } from "../src/crypto.ts";
import { MbxNode } from "../src/node.ts";

const tmp = () => mkdtempSync(join(tmpdir(), "mbx-heal-"));
process.env.MBX_NO_DESKTOP = "1";
process.env.MBX_SELF_ADDRS = "127.0.0.1:1"; // every test host "lives" on 127.0.0.1 (signed addrs are checked by IP)

async function up(host: string) {
  const n = new MbxNode(tmp(), { host, bind: "127.0.0.1", port: 0 });
  const s = await startServer(n, 0, "127.0.0.1");
  const port = (s.address() as AddressInfo).port;
  n.config.port = port;
  return { n, s, port, addr: `127.0.0.1:${port}` };
}
const down = (...xs: { n: MbxNode; s: Server }[]) => xs.forEach((x) => { x.s.close(); x.n.close(); });

async function paired() {
  resetLearnThrottle();
  const A = await up("alpha"), B = await up("beta");
  process.env.MBX_ADVERTISE = A.addr;
  const r = await pairWith(A.n, B.addr);
  delete process.env.MBX_ADVERTISE;
  A.n.approvePeer("beta", r.code); B.n.approvePeer("alpha", r.code);
  return { A, B };
}
const stale = (n: MbxNode, host: string, addr: string) => n.store.db.prepare("UPDATE peers SET addr=? WHERE host=?").run(addr, host);
const outboxCount = (n: MbxNode) => (n.store.db.prepare("SELECT count(*) n FROM outbox").get() as { n: number }).n;
const json = (obj: unknown) => new Response(JSON.stringify(obj), { status: 200, headers: { "content-type": "application/json" } });

test("splitAddr handles host:port, [v6]:port and bare hosts", () => {
  assert.deepEqual(splitAddr("10.0.10.42:7373"), { host: "10.0.10.42", port: 7373 });
  assert.deepEqual(splitAddr("[fe80::1]:7373"), { host: "fe80::1", port: 7373 });
  assert.deepEqual(splitAddr("mac.local"), { host: "mac.local", port: null });
  assert.deepEqual(splitAddr("fe80::1"), { host: "fe80::1", port: null });
});

test("a verified hop from a new IP moves the peer, and queued mail flows at once", async () => {
  const { A, B } = await paired();
  stale(B.n, "alpha", "127.0.0.9:1"); // alpha "moved"; beta still dials the old address
  B.n.send({ from: "vida-dev", to: ["mac-dev@alpha"], subject: "stuck", body: "x" });
  await flushOutbox(B.n);
  assert.equal(outboxCount(B.n), 1, "dead address: mail waits");
  A.n.send({ from: "mac-dev", to: ["vida-dev@beta"], subject: "hi", body: "y" });
  await flushOutbox(A.n);
  for (let i = 0; i < 50 && B.n.peer("alpha")!.addr !== A.addr; i++) await new Promise((r) => setTimeout(r, 20));
  assert.equal(B.n.peer("alpha")!.addr, A.addr);
  assert.deepEqual(await flushOutbox(B.n), { sent: 1, failed: 0 });
  assert.equal(A.n.inbox("mac-dev")[0].subject, "stuck");
  assert.ok(B.n.store.db.prepare("SELECT 1 FROM audit WHERE event='peer.addr'").get(), "the move is audited");
  assert.equal(JSON.parse(B.n.store.get("peer-heal:alpha")!).via, "verified-hop");
  down(A, B);
});

test("plain /v1/status stays public and unsigned; a challenge gets a signed answer", async () => {
  const { A, B } = await paired();
  const plain = await (await fetch(`http://${A.addr}/v1/status`)).json() as Record<string, unknown>;
  assert.equal(plain.host, "alpha"); assert.equal(plain.sig, undefined);
  const signed = await (await fetch(`http://${A.addr}/v1/status?challenge=abc`)).json() as Record<string, unknown>;
  assert.equal(signed.challenge, "abc"); assert.equal(typeof signed.sig, "string");
  assert.equal(await probePeer(B.n, "alpha", A.addr), true);
  down(A, B);
});

test("the pin never moves on an unsigned status, an impostor key, a replayed answer or a proxied answer", async () => {
  const { A, B } = await paired();
  stale(B.n, "alpha", "127.0.0.9:1");
  const pinnedKey = A.n.key.publicKey;
  // an older peer (or a forger) answering the unsigned shape with the right public key
  assert.equal(await healPeerAddr(B.n, "alpha", "10.9.9.9:7373", "t", async () => json({ host: "alpha", host_pubkey: pinnedKey })), null);
  // an impostor with the same name and its own key
  const C = await up("alpha");
  assert.equal(await healPeerAddr(B.n, "alpha", C.addr, "t"), null);
  // a replayed signed answer (old challenge)
  const old = signedStatus(A.n, "old-challenge");
  assert.equal(await healPeerAddr(B.n, "alpha", "10.9.9.9:7373", "t", async () => json(old)), null);
  // a proxy at 10.9.9.9 that relays our fresh challenge to the real alpha: signed, but alpha's signed addrs don't list 10.9.9.9
  const proxy: typeof fetch = async (url) => fetch(String(url).replace("10.9.9.9:7373", A.addr));
  assert.equal(await healPeerAddr(B.n, "alpha", "10.9.9.9:7373", "t", proxy), null);
  assert.equal(B.n.peer("alpha")!.addr, "127.0.0.9:1");
  down(A, B, C);
});

test("a pinned name is kept while mail to it works; probes are throttled", async () => {
  const { A, B } = await paired();
  stale(B.n, "alpha", "alpha.local:7373");
  assert.equal(await learnPeerAddr(B.n, "alpha", "127.0.0.1", A.port), null, "no failing mail: keep the name");
  assert.equal(B.n.store.get("peer-lastseen:alpha"), A.addr, "the source is remembered for the failure ladder");
  B.n.store.db.prepare("INSERT INTO outbox (msg_id, host, attempts, next_at, created_at) VALUES ('m1','alpha',3,?,?)").run(new Date().toISOString(), new Date().toISOString());
  assert.equal(await learnPeerAddr(B.n, "alpha", "::ffff:127.0.0.1", A.port), A.addr);
  stale(B.n, "alpha", "127.0.0.9:1");
  assert.equal(await learnPeerAddr(B.n, "alpha", "127.0.0.1", A.port), null, "second probe within a minute is skipped");
  down(A, B);
});

test("presence: a signed beacon moves the peer even when no mail is flowing, and replays are refused", async () => {
  const { A, B } = await paired();
  stale(B.n, "alpha", "127.0.0.9:1"); // alpha moved and has nothing to send
  // alpha's beacon reaches beta (beta's address is still right)
  assert.deepEqual(await sendPresence(A.n), ["beta"]);
  for (let i = 0; i < 50 && B.n.peer("alpha")!.addr !== A.addr; i++) await new Promise((r) => setTimeout(r, 20));
  assert.equal(B.n.peer("alpha")!.addr, A.addr);
  assert.equal(JSON.parse(B.n.store.get("peer-heal:alpha")!).via, "presence");
  assert.ok(B.n.store.get("peer-presence-at:alpha"));
  // the same seq again is a replay
  const seq = Number(B.n.store.get("peer-presence-seq:alpha"));
  assert.deepEqual(acceptPresence(B.n, "alpha", { v: 1, seq, port: A.port, addrs: [] }, "127.0.0.1"), { ok: false, error: "stale presence (seq)" });
  assert.equal(acceptPresence(B.n, "alpha", { v: 1, seq: "x", addrs: [] }, "127.0.0.1").error, "bad presence");
  down(A, B);
});

test("failure ladder: stored alternates, then mDNS on a matching fingerprint", async () => {
  const { A, B } = await paired();
  stale(B.n, "alpha", "127.0.0.9:1");
  B.n.send({ from: "vida-dev", to: ["mac-dev@alpha"], subject: "q", body: "z" });
  B.n.store.db.prepare("UPDATE outbox SET attempts=2").run();
  B.n.store.set("peer-alts:alpha", JSON.stringify([A.addr]));
  assert.deepEqual(await healStuckPeers(B.n, async () => []), ["alpha"]);
  assert.equal(JSON.parse(B.n.store.get("peer-heal:alpha")!).via, "ladder");
  stale(B.n, "alpha", "127.0.0.9:1"); B.n.store.set("peer-alts:alpha", "[]");
  assert.deepEqual(await healStuckPeers(B.n, async () => [{ host: "alpha", fp: "0000-0000-0000-0000", addr: A.addr }]), []);
  assert.deepEqual(await healStuckPeers(B.n, async () => [{ host: "alpha", fp: fingerprint(A.n.key.publicKey), addr: A.addr }]), ["alpha"]);
  assert.equal(B.n.peer("alpha")!.addr, A.addr);
  down(A, B);
});

test("a name candidate must resolve to one of the peer's signed addrs, unless the owner typed it", async () => {
  const { A, B } = await paired();
  stale(B.n, "alpha", "127.0.0.9:1");
  const name = `alpha-test.invalid:${A.port}`;
  const viaName: typeof fetch = async (url) => fetch(String(url).replace(`alpha-test.invalid:${A.port}`, A.addr));
  // a proxy name that resolves somewhere else: the relayed, signed answer must not pass
  assert.equal(await probePeer(B.n, "alpha", name, viaName, { resolve: async () => ["10.9.9.9"] }), false);
  // a name resolving to one of alpha's signed addrs passes
  assert.equal(await probePeer(B.n, "alpha", name, viaName, { resolve: async () => ["127.0.0.1"] }), true);
  // an owner-typed `peers addr` may name a host alpha doesn't list (NAT / tunnel names)
  assert.equal(await probePeer(B.n, "alpha", name, viaName, { ownerTyped: true, resolve: async () => [] }), true);
  down(A, B);
});

test("presence answers before any probe finishes; healing runs in the background, throttled per peer", async () => {
  const { A, B } = await paired();
  stale(B.n, "alpha", "127.0.0.9:1");
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const slow: typeof fetch = async (url, init) => { await gate; return fetch(url, init); };
  const t0 = Date.now();
  const r = acceptPresence(B.n, "alpha", { v: 1, seq: Date.now(), port: A.port, addrs: [A.addr] }, "127.0.0.1", slow);
  assert.equal(r.ok, true);
  assert.ok(Date.now() - t0 < 50, "the answer does not wait for probes");
  assert.equal(B.n.peer("alpha")!.addr, "127.0.0.9:1", "not moved yet");
  // a second beacon within the minute starts no second healing run
  assert.equal(acceptPresence(B.n, "alpha", { v: 1, seq: Date.now() + 1, port: A.port, addrs: [A.addr] }, "127.0.0.1", slow).healing, undefined);
  release();
  assert.equal(await r.healing, A.addr);
  assert.equal(B.n.peer("alpha")!.addr, A.addr);
  // and over HTTP the beacon is answered 202
  const res = await fetch(`http://${B.addr}/v1/presence`, { method: "POST", headers: (await import("../src/http.ts")).signHop(A.n, "POST", "/v1/presence", '{"v":1,"seq":1,"addrs":[]}'), body: '{"v":1,"seq":1,"addrs":[]}' });
  assert.equal(res.status, 400, "seq 1 is a replay by now");
  down(A, B);
});

test("announced addresses skip container bridges and VPN tunnels, but never announce nothing", () => {
  const nic = (address: string) => [{ address, family: "IPv4", internal: false, netmask: "255.255.255.0", mac: "00:00:00:00:00:00", cidr: null }] as never;
  assert.deepEqual(announcedIPv4({ wlo1: nic("10.0.10.136"), docker0: nic("172.17.0.1"), "br-1a2b": nic("172.20.0.1"), veth9: nic("172.20.0.5"),
    virbr0: nic("192.168.122.1"), podman0: nic("10.88.0.1"), utun3: nic("100.64.0.2"), tun0: nic("10.8.0.2"), lo: [{ address: "127.0.0.1", family: "IPv4", internal: true }] as never }), ["10.0.10.136"]);
  assert.deepEqual(announcedIPv4({ utun3: nic("100.64.0.2"), lo: [{ address: "127.0.0.1", family: "IPv4", internal: true }] as never }), ["100.64.0.2"], "VPN-only host still announces");
  assert.deepEqual(announcedIPv4({}), []);
});
