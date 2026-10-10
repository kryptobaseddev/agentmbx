// Host-to-host HTTP: pairing, envelope exchange, agent directory. Every request except /v1/pair*, read-only
// /v1/status, the loopback /v1/opencode-wake queue, and the loopback /v1/opencode-permission decision
// carries a signed hop (X-Mbx-Host / -Ts / -Sig over method, path, ts, sha256(body)); freshness is
// checked on the hop only.
import { createServer, type IncomingMessage, type Server } from "node:http";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { hostname, networkInterfaces } from "node:os";
import {
  canonical, fingerprint, joinTranscript, nonce as newNonce, pairingCode, pairMac, pairTokenKey, safeEqual, sha256, signData, verifyData, type PairParty,
} from "./crypto.ts";
import { NAME_RE, sealEnvelope, type Envelope } from "./envelope.ts";
import { MbxNode, RETRY_HOURS } from "./node.ts";
import { resolveStatusIdentity } from "./status-identity.ts";
import { hudStatus, hudStatusV2 } from "./hud.ts";
import { STATUS_V2_SCHEMA } from "./status-schema.ts";
import { notifyDesktop } from "./wake.ts";
import { cancelOpencodeWake, completeOpencodeWake, listOpencodeWakeWaiters, waitForOpencodeWake } from "./opencode-wake-queue.ts";
import { opencodePermissionDecision } from "./opencode-permission.ts";
import { version } from "./version.ts";
import { rotationLog, saveRotationLog, type SignedRotation } from "./key-rotation.ts";
import { storedPolicies, acceptSigned, policyUnexpired, type AnyRecord, type Signed } from "./policy.ts";
import { acceptReceipt, dueReceipts, RECEIPT_BATCH, receiptsDeferred, receiptsSent, signReceipt } from "./remote-receipts.ts";

export const HOP_SKEW_MS = 5 * 60_000;
const HELLO_TTL_MS = 2 * 60_000;
const TOKEN_REQS_PER_MIN = 30;

const hopPayload = (method: string, path: string, ts: string, body: string) => `${method}\n${path}\n${ts}\n${sha256(body)}`;

export function signHop(node: MbxNode, method: string, path: string, body: string): Record<string, string> {
  const ts = new Date().toISOString();
  // x-mbx-port is an unsigned hint for address healing (learnPeerAddr): it is only ever used after a key-checked probe.
  return { "x-mbx-host": node.host, "x-mbx-ts": ts, "x-mbx-sig": signData(node.key.privateKey, hopPayload(method, path, ts, body)),
    "x-mbx-port": String(node.config.port), "content-type": "application/json" };
}

/** Returns the paired peer host name, or throws with the reason. */
export function verifyHop(node: MbxNode, headers: Record<string, string | string[] | undefined>, method: string, path: string, body: string, now = Date.now()): string {
  const h = String(headers["x-mbx-host"] ?? ""), ts = String(headers["x-mbx-ts"] ?? ""), sig = String(headers["x-mbx-sig"] ?? "");
  const peer = node.approvedPeer(h);
  if (!peer) throw new Error("host not paired");
  const t = Date.parse(ts);
  if (Number.isNaN(t) || Math.abs(now - t) > HOP_SKEW_MS) throw new Error("stale or bad hop timestamp (check clocks)");
  if (!verifyData(peer.pubkey, hopPayload(method, path, ts, body), sig)) throw new Error("bad hop signature");
  return h;
}

// ---- address healing and presence (T151) -------------------------------------------------------
// A peer's address is pinned at pairing, but DHCP moves machines. Trust never depends on the address (hops are signed,
// bodies sealed to pinned keys), so the address may move, but only to a place that proves it is the peer: a challenge
// probe (GET /v1/status?challenge=N) must come back signed by the PINNED host key over the fresh challenge and the
// addresses the peer itself reports, and the candidate's IP must be one of those signed addresses. A replayed hop or a
// proxied status can't pass: the proxy can't sign, and a relayed answer names the real peer's IPs, not the proxy's.
// Candidates come from: a verified hop from a new IP; a signed presence beacon (POST /v1/presence); alternates stored
// from earlier beacons; mDNS; or `agentmbx peers addr`. Plain /v1/status stays public and unsigned.

/** Split "host:port", "[v6]:port" or "host". */
export function splitAddr(addr: string): { host: string; port: number | null } {
  const v6 = /^\[([^\]]+)\](?::(\d+))?$/.exec(addr);
  if (v6) return { host: v6[1], port: v6[2] ? Number(v6[2]) : null };
  const i = addr.lastIndexOf(":");
  if (i > 0 && addr.indexOf(":") === i && /^\d+$/.test(addr.slice(i + 1))) return { host: addr.slice(0, i), port: Number(addr.slice(i + 1)) };
  return { host: addr, port: null };
}
export const joinAddr = (host: string, port: number) => (isIP(host) === 6 ? `[${host}]:${port}` : `${host}:${port}`);
const validPort = (p: unknown) => { const n = Number(p); return Number.isInteger(n) && n > 0 && n < 65536 ? n : null; };
const unmap = (ip: string) => ip.replace(/^::ffff:/i, "");
const resolveName = async (name: string) => (await lookup(name, { all: true })).map((r) => r.address);

/** This host's own reachable addresses (LAN IPv4 + the listening port), for presence and signed status. */
export const selfAddrs = (node: MbxNode, ifaces: ReturnType<typeof networkInterfaces> = networkInterfaces()): string[] =>
  process.env.MBX_SELF_ADDRS ? process.env.MBX_SELF_ADDRS.split(",").filter(Boolean)
    : announcedIPv4(ifaces).map((ip) => joinAddr(ip, node.config.port));

/** Container bridges and VPN tunnels: not where a LAN peer can reach us. */
const VIRTUAL_IFACE = /^(docker|br-|bridge|vmnet|veth|virbr|podman|cni|flannel|utun|tun|tap|awdl|llw|anpi)/i; // bridge/vmnet: macOS VM and container hosts
/** Non-internal IPv4 addresses worth announcing: physical interfaces first; virtual ones only when nothing else is
 *  left, so a VPN-only host still announces something. */
export function announcedIPv4(ifaces: ReturnType<typeof networkInterfaces>): string[] {
  const all = Object.entries(ifaces).flatMap(([name, list]) => (list ?? []).filter((i) => i.family === "IPv4" && !i.internal).map((i) => ({ name, ip: i.address })));
  const real = all.filter((x) => !VIRTUAL_IFACE.test(x.name));
  return (real.length ? real : all).map((x) => x.ip);
}

const statusPayload = (s: { host: string; host_pubkey: string; challenge: string; addrs: string[]; version: string; at: string }) =>
  canonical({ v: 1, kind: "status", host: s.host, host_pubkey: s.host_pubkey, challenge: s.challenge, addrs: s.addrs, version: s.version, at: s.at });

/** Answer a status challenge: the same public fields, plus addrs, signed by this host's key. */
export function signedStatus(node: MbxNode, challenge: string) {
  const s = { host: node.host, host_pubkey: node.key.publicKey, challenge, addrs: selfAddrs(node), version: version(), at: new Date().toISOString() };
  return { v: 1, service: "agentmbx", ...s, sig: signData(node.key.privateKey, statusPayload(s)) };
}

/** Challenge-probe `addr`: true only if it answers as `host`, signed by the pinned key over our fresh challenge, and
 *  lists `addr`'s IP among its own signed addresses. Peers without challenge support never pass (no unsigned moves). */
export async function probePeer(node: MbxNode, host: string, addr: string, f: typeof fetch = fetch, opts: { ownerTyped?: boolean; resolve?: (name: string) => Promise<string[]> } = {}): Promise<boolean> {
  const p = node.approvedPeer(host);
  if (!p) return false;
  const challenge = newNonce();
  try {
    const res = await f(`http://${addr}/v1/status?challenge=${encodeURIComponent(challenge)}`, { redirect: "error", signal: AbortSignal.timeout(3_000) });
    if (!res.ok) { await res.body?.cancel(); return false; }
    const s = await res.json() as { host?: unknown; host_pubkey?: unknown; challenge?: unknown; addrs?: unknown; version?: unknown; at?: unknown; sig?: unknown };
    if (s.host !== host || s.host_pubkey !== p.pubkey || s.challenge !== challenge || typeof s.sig !== "string") return false;
    if (!Array.isArray(s.addrs) || !s.addrs.every((a) => typeof a === "string") || typeof s.version !== "string" || typeof s.at !== "string") return false;
    if (!verifyData(p.pubkey, statusPayload({ host, host_pubkey: p.pubkey, challenge, addrs: s.addrs as string[], version: s.version, at: s.at }), s.sig)) return false;
    const want = unmap(splitAddr(addr).host);
    const signed = new Set((s.addrs as string[]).map((a) => unmap(splitAddr(a).host)));
    if (isIP(want)) return signed.has(want);
    // A name: a relaying proxy would pass the signature, so its IPs must be among the signed addrs too. Only an
    // owner-typed `peers addr` may point at a name the peer doesn't list (e.g. a DNS name for a NAT or tunnel).
    if (opts.ownerTyped) return true;
    const ips = await (opts.resolve ?? resolveName)(want).catch(() => [] as string[]);
    return ips.some((ip) => signed.has(unmap(ip)));
  } catch { return false; }
}

/** Point `host` at `addr` if a challenge probe there proves it is that host. Returns the new address or null. */
export async function healPeerAddr(node: MbxNode, host: string, addr: string, via: string, f: typeof fetch = fetch): Promise<string | null> {
  const p = node.approvedPeer(host);
  if (!p || p.addr === addr || !(await probePeer(node, host, addr, f, { ownerTyped: via === "cli" }))) return null;
  if (!node.setPeerAddr(host, addr, via)) return null;
  node.store.set(`peer-heal:${host}`, JSON.stringify({ via, at: new Date().toISOString(), from: p.addr, to: addr }));
  process.stderr.write(`[agentmbx] ${host} moved: ${p.addr} -> ${addr} (${via}, challenge verified)\n`);
  return addr;
}

const failing = (node: MbxNode, host: string) => !!node.store.db.prepare("SELECT 1 FROM outbox WHERE host=? AND attempts>0 LIMIT 1").get(host);
const listKv = (node: MbxNode, k: string): string[] => { try { const v = JSON.parse(node.store.get(k) ?? "[]"); return Array.isArray(v) ? v.filter((x) => typeof x === "string") : []; } catch { return []; } };
/** Should a candidate replace the pinned address? A pinned IP that the peer no longer reports, or mail that fails. A
 *  working pinned name (x.local) is kept: it survives DHCP better than an IP. */
function shouldMove(node: MbxNode, host: string, pinned: string, reported: string[] | null): boolean {
  if (failing(node, host)) return true;
  const ph = splitAddr(pinned).host;
  if (!isIP(ph)) return false;
  return reported ? !reported.some((a) => splitAddr(a).host === ph) : true;
}

const learnTried = new Map<string, number>();
/** After a verified hop from `host`: remember the source IP, and if it differs from the pinned one, try it (port from
 *  the peer's hint, else the pinned port, else 7373). One probe a minute per peer. */
export async function learnPeerAddr(node: MbxNode, host: string, remoteIp: string, portHint?: unknown, f: typeof fetch = fetch, now = Date.now()): Promise<string | null> {
  const p = node.approvedPeer(host);
  const ip = unmap(remoteIp);
  if (!p || !isIP(ip)) return null;
  const pinned = splitAddr(p.addr);
  const cand = joinAddr(ip, validPort(portHint) ?? pinned.port ?? 7373);
  node.store.set(`peer-lastseen:${host}`, cand);
  if (pinned.host === ip || !shouldMove(node, host, p.addr, null)) return null;
  if (now - (learnTried.get(host) ?? 0) < 60_000) return null;
  learnTried.set(host, now);
  return healPeerAddr(node, host, cand, "verified-hop", f);
}
const presenceTried = new Map<string, number>();
export const resetLearnThrottle = () => { learnTried.clear(); presenceTried.clear(); };

/** Receiver of POST /v1/presence (hop already verified). Answers at once after the replay and shape checks; candidates
 *  are challenge-probed in the background (at most one healing run a minute per peer), so a slow or dead candidate never
 *  holds the sender's request open. `healing` resolves to the new address, if any (tests await it). */
export function acceptPresence(node: MbxNode, host: string, body: unknown, remoteIp: string, f: typeof fetch = fetch, now = Date.now()): { ok: boolean; error?: string; healing?: Promise<string | null> } {
  const b = body as { v?: unknown; seq?: unknown; port?: unknown; addrs?: unknown };
  if (b?.v !== 1 || !Number.isSafeInteger(b.seq) || !Array.isArray(b.addrs) || b.addrs.length > 16 || !b.addrs.every((a) => typeof a === "string" && a.length <= 64))
    return { ok: false, error: "bad presence" };
  const last = Number(node.store.get(`peer-presence-seq:${host}`) ?? 0);
  if ((b.seq as number) <= last) return { ok: false, error: "stale presence (seq)" };
  node.store.set(`peer-presence-seq:${host}`, String(b.seq));
  node.store.set(`peer-presence-at:${host}`, new Date().toISOString());
  const addrs = b.addrs as string[];
  node.store.set(`peer-alts:${host}`, JSON.stringify(addrs));
  const p = node.approvedPeer(host);
  if (!p || !shouldMove(node, host, p.addr, addrs)) return { ok: true };
  if (now - (presenceTried.get(host) ?? 0) < 60_000) return { ok: true };
  presenceTried.set(host, now);
  const ip = unmap(remoteIp), port = validPort(b.port);
  const cands = [...new Set([...(isIP(ip) && port ? [joinAddr(ip, port)] : []), ...addrs])].filter((a) => a !== p.addr);
  const healing = (async () => {
    for (const c of cands) { const moved = await healPeerAddr(node, host, c, "presence", f); if (moved) return moved; }
    return null;
  })().catch(() => null);
  return { ok: true, healing };
}

/** Send a signed presence beacon to peers: to the pinned address, and for peers with failing mail to every known
 *  alternate too. Old peers (404) are ignored. Returns the hosts that accepted it. */
export async function sendPresence(node: MbxNode, f: typeof fetch = fetch, only?: string[]): Promise<string[]> {
  const body = JSON.stringify({ v: 1, seq: Date.now(), port: node.config.port, addrs: selfAddrs(node), version: version() });
  const ok: string[] = [];
  await Promise.all(node.peers().filter((p) => p.state === "approved" && (!only || only.includes(p.host))).map(async (p) => {
    const targets = [...new Set([p.addr, ...(failing(node, p.host) ? [...listKv(node, `peer-alts:${p.host}`), node.store.get(`peer-lastseen:${p.host}`) ?? ""] : [])])].filter(Boolean);
    for (const t of targets) {
      try {
        const res = await f(`http://${t}/v1/presence`, { method: "POST", headers: signHop(node, "POST", "/v1/presence", body), body, redirect: "error", signal: AbortSignal.timeout(3_000) });
        await res.body?.cancel();
        if (res.ok) { ok.push(p.host); return; }
      } catch { /* next target */ }
    }
  }));
  return ok;
}

/** Failure ladder for peers whose mail keeps failing: last inbound IP, stored alternates, then mDNS. Each rung is a
 *  challenge probe. Run once a minute by the daemon; costs nothing while mail flows. */
export async function healStuckPeers(node: MbxNode, find: () => Promise<{ host: string; fp: string; addr: string }[]>, f: typeof fetch = fetch): Promise<string[]> {
  const stuck = (node.store.db.prepare("SELECT DISTINCT host FROM outbox WHERE attempts>=2").all() as { host: string }[])
    .map((r) => node.approvedPeer(r.host)).filter((p) => !!p);
  const moved: string[] = [];
  let seen: { host: string; fp: string; addr: string }[] | null = null;
  for (const p of stuck) {
    const ladder = [node.store.get(`peer-lastseen:${p.host}`) ?? "", ...listKv(node, `peer-alts:${p.host}`)];
    let done = false;
    for (const c of [...new Set(ladder)].filter((c) => c && c !== p.addr)) if (await healPeerAddr(node, p.host, c, "ladder", f)) { done = true; break; }
    if (!done) {
      seen ??= await find();
      const hit = seen.find((s) => s.host === p.host && s.fp === fingerprint(p.pubkey));
      if (hit && await healPeerAddr(node, p.host, hit.addr, "mdns", f)) done = true;
    }
    if (done) moved.push(p.host);
  }
  return moved;
}
/** @deprecated name kept for callers of the first T151 patch. */
export const healPeersViaDiscovery = healStuckPeers;

/** A fingerprint of this host's addresses: the daemon re-announces presence when it changes (DHCP, Wi-Fi switch). */
export const addrSignature = (node: MbxNode) => selfAddrs(node).slice().sort().join(",");

export const advertisedAddr = (node: MbxNode) => process.env.MBX_ADVERTISE || `${hostname().replace(/\.local$/, "").toLowerCase()}.local:${node.config.port}`;

/** Server limits (T029). Timeouts bound slowloris clients; the body cap is enforced while streaming; the per-peer
 *  rate covers every signed-hop request (a daemon polls a peer roughly 30-60 times a minute). */
export interface ServerLimits { maxRequestBytes: number; peerReqsPerMin: number; headersTimeoutMs: number; requestTimeoutMs: number; keepAliveTimeoutMs: number }
export const DEFAULT_LIMITS: ServerLimits = { maxRequestBytes: 4 * 1024 * 1024, peerReqsPerMin: 600, headersTimeoutMs: 10_000, requestTimeoutMs: 30_000, keepAliveTimeoutMs: 5_000 };

const httpError = (status: number, message: string) => Object.assign(new Error(message), { status });

/** True when a request arrived over loopback (IPv4, IPv6, or a v4-mapped address). T407 session-scoped
 *  status reads are restricted to these: same-host plugins need them, and the snapshot is host-local. */
export const isLoopbackRemote = (addr: string): boolean =>
  addr === "127.0.0.1" || addr === "::1" || addr === "::ffff:127.0.0.1";
const readBody = (req: IncomingMessage, max: number) => new Promise<string>((res, rej) => {
  const tooBig = () => httpError(413, `request body over ${max} bytes`);
  if (Number(req.headers["content-length"]) > max) return rej(tooBig());
  let n = 0; const chunks: Buffer[] = [];
  req.on("data", (c: Buffer) => { if ((n += c.length) > max) { chunks.length = 0; rej(tooBig()); } else chunks.push(c); });
  req.on("end", () => res(Buffer.concat(chunks).toString("utf8"))); req.on("error", rej);
});

// ---- pairing ---------------------------------------------------------------------------------
export interface PairOffer extends PairParty { addr: string; v: 1 }

export function localParty(node: MbxNode, n: string): PairOffer {
  return { v: 1, host: node.host, host_pubkey: node.key.publicKey, owner_pubkey: node.ownerPub, nonce: n, addr: advertisedAddr(node) };
}

function acceptOffer(node: MbxNode, remote: PairOffer, localNonce: string): string {
  if (remote.host === node.host) throw new Error("peer has the same host name as this host; rename one (config.json)");
  const code = pairingCode(localParty(node, localNonce), remote);
  node.upsertPendingPeer({ host: remote.host, pubkey: remote.host_pubkey, owner_pubkey: remote.owner_pubkey, addr: remote.addr, code, nonce_local: localNonce, nonce_remote: remote.nonce });
  return code;
}

/** Initiator side of `mbx pair <addr>`. Returns the code both humans must compare. Commit-reveal (T032): the initiator
 *  commits to its offer, the responder answers with its own, then the initiator reveals. Neither side sees the other's
 *  nonce before its own is fixed, so a party in the middle cannot grind a nonce until the two 6-digit codes match. */
export async function pairWith(node: MbxNode, addr: string): Promise<{ host: string; code: string; key: string; owner: string | null }> {
  const n = newNonce(), offer = localParty(node, n);
  const ask = async (body: unknown) => {
    const res = await fetch(`http://${addr}/v1/pair`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new Error(`pairing refused by ${addr}: ${await res.text()} (code-compare pairing needs AgentMBX with commit-reveal on both hosts)`);
    return res.json();
  };
  const remote = await ask({ v: 2, commit: sha256(canonical(offer)) }) as PairOffer;
  if (remote?.v !== 1 || !validParty(remote)) throw new Error(`${addr} sent a malformed pairing offer`);
  await ask({ v: 2, offer });
  const code = acceptOffer(node, { ...remote, addr }, n);
  return { host: remote.host, code, key: fingerprint(remote.host_pubkey), owner: remote.owner_pubkey ? fingerprint(remote.owner_pubkey) : null };
}

// ---- token pairing (agentmbx pair  →  agentmbx join <addr> <token>) --------------------------
/** GET /v1/pair/hello: this host's public party plus a fresh single-use nonce (nonce_a). */
export interface PairHello extends PairParty { v: 1 }
/** POST /v1/pair/join: the joiner's party, the hello nonce it answers, and HMAC(token, transcript). */
export interface JoinRequest extends PairParty { v: 1; addr: string; nonce_a: string; mac: string }

const isStr = (x: unknown, max = 256) => typeof x === "string" && x.length > 0 && x.length <= max;
const validParty = (p: Partial<PairParty> | null | undefined) => !!p && isStr(p.host, 40) && NAME_RE.test(p.host!) && isStr(p.host_pubkey, 64)
  && (p.owner_pubkey === null || isStr(p.owner_pubkey, 64)) && isStr(p.nonce, 64);

/** Joiner side of `agentmbx join <addr> <token>`: prove the token to A, check A's proof, then trust A. */
export async function pairJoin(node: MbxNode, addr: string, token: string): Promise<{ host: string; key: string; owner: string | null }> {
  const key = pairTokenKey(token);
  const h = await fetch(`http://${addr}/v1/pair/hello`, { signal: AbortSignal.timeout(10_000) });
  if (!h.ok) throw new Error(`${addr} refused pairing: ${await h.text()}`);
  const hello = await h.json() as PairHello;
  if (hello?.v !== 1 || !validParty(hello)) throw new Error(`${addr} sent a malformed pairing hello`);
  if (hello.host === node.host) throw new Error("peer has the same host name as this host; rename one (config.json)");
  const cur = node.approvedPeer(hello.host);
  if (cur && cur.pubkey !== hello.host_pubkey) throw new Error(`host ${hello.host} is already paired with a different key; remove it first (agentmbx peers remove ${hello.host})`);
  const me = { host: node.host, host_pubkey: node.key.publicKey, owner_pubkey: node.ownerPub, nonce: newNonce(), addr: advertisedAddr(node) };
  const transcript = joinTranscript(hello, me);
  const req: JoinRequest = { v: 1, ...me, nonce_a: hello.nonce, mac: pairMac(key, "join", transcript) };
  const res = await fetch(`http://${addr}/v1/pair/join`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(req), signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`${hello.host} (${addr}) refused the join: ${((await res.json().catch(() => ({}))) as { error?: string }).error ?? res.status}`);
  const r = await res.json() as { mac?: unknown };
  if (typeof r.mac !== "string" || !safeEqual(pairMac(key, "accept", transcript), r.mac)) {
    node.store.audit("pair.join.failed", { host: hello.host, addr, why: "peer could not prove the token" });
    throw new Error(`${addr} did not prove it knows the token. NOT paired: something may be intercepting the connection.`);
  }
  node.addApprovedPeer({ host: hello.host, pubkey: hello.host_pubkey, owner_pubkey: hello.owner_pubkey, addr }, "token");
  node.store.audit("pair.joined", { host: hello.host, addr, role: "joiner" });
  return { host: hello.host, key: fingerprint(hello.host_pubkey), owner: hello.owner_pubkey ? fingerprint(hello.owner_pubkey) : null };
}

/** Token-holder side: verify a join and, if the MAC checks out against a live token, approve the joiner. */
function handleJoin(node: MbxNode, j: JoinRequest, hellos: Map<string, number>, remote: string): { code: number; body: Record<string, unknown> } {
  if (j?.v !== 1 || !validParty(j) || !isStr(j.addr) || !isStr(j.nonce_a, 64) || !isStr(j.mac, 128)) return { code: 400, body: { error: "bad join request" } };
  const exp = hellos.get(j.nonce_a); hellos.delete(j.nonce_a); // each hello nonce answers at most one join
  if (!exp || exp < Date.now()) return { code: 401, body: { error: "unknown or expired hello nonce; run join again" } };
  const tokens = node.livePairTokens();
  if (!tokens.length) return { code: 401, body: { error: `no live pairing token on ${node.host} (expired, used or burned); run 'agentmbx pair' there again` } };
  const transcript = joinTranscript(localParty(node, j.nonce_a), j);
  const match = tokens.find((t) => safeEqual(pairMac(t.key, "join", transcript), j.mac));
  if (!match) {
    node.pairTokenFailure(tokens.map((t) => t.id));
    node.store.audit("pair.join.failed", { from: j.host, addr: j.addr, remote, why: "token or transcript does not verify" });
    return { code: 401, body: { error: "pairing token or transcript does not verify" } };
  }
  if (j.host === node.host) return { code: 409, body: { error: "peer has the same host name as this host; rename one (config.json)" } };
  const cur = node.approvedPeer(j.host);
  if (cur && cur.pubkey !== j.host_pubkey) return { code: 409, body: { error: `${node.host} already has ${j.host} paired with a different key; run 'agentmbx peers remove ${j.host}' there first` } };
  if (!node.consumePairToken(match.id, j.host)) return { code: 401, body: { error: "pairing token was just used" } };
  node.addApprovedPeer({ host: j.host, pubkey: j.host_pubkey, owner_pubkey: j.owner_pubkey, addr: j.addr }, "token");
  node.store.audit("pair.joined", { host: j.host, addr: j.addr, remote, role: "token-holder", token: match.id });
  process.stderr.write(`\n[agentmbx] paired with ${j.host} (${j.addr}) using pairing token ${match.id}\n`);
  void notifyDesktop({ body: `Paired with ${j.host}` });
  return { code: 200, body: { v: 1, host: node.host, mac: pairMac(match.key, "accept", transcript) } };
}

// ---- server ----------------------------------------------------------------------------------
export function startServer(node: MbxNode, port = node.config.port, bind = node.config.bind, onEnvelope?: () => void, limits: Partial<ServerLimits> = {}): Promise<Server> {
  const L = { ...DEFAULT_LIMITS, ...limits };
  const peerReqs = new Map<string, number[]>(); // authenticated host → request times in the last minute
  const runtime = { service: "agentmbx", v: 1, host: node.host, host_pubkey: node.key.publicKey, version: version(), started_at: new Date().toISOString() };
  let pairAttempts: number[] = [], tokenAttempts: number[] = [], rotateAttempts: number[] = [];
  const hellos = new Map<string, number>(); // hello nonce → expiry
  const commits = new Map<string, { n: string; exp: number }>(); // SAS offer commitment → this host's nonce for it
  const server = createServer({ headersTimeout: L.headersTimeoutMs, requestTimeout: L.requestTimeoutMs, keepAliveTimeout: L.keepAliveTimeoutMs,
    connectionsCheckingInterval: Math.min(1_000, L.headersTimeoutMs) }, async (req, res) => {
    const send = (code: number, obj: unknown) => {
      if (res.headersSent) return void res.end();
      res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(obj));
    };
    try {
      const url = new URL(req.url ?? "/", "http://x"); const body = await readBody(req, L.maxRequestBytes);
      // Public diagnostic metadata only: this neither issues pairing nonces nor grants authority.
      if (url.pathname === "/v1/status") {
        if (req.method !== "GET") return send(405, { error: "method not allowed" });
        // T407: session-scoped status for in-harness renderers (the Claude mod, #143; the OpenCode
        // sidebar, T399). `cli`+`session` answer with the same mbx.status snapshot the T311 CLI and
        // the statusline adapters produce: identity resolution is by (cli, session_id) alone, so a
        // query can never surface another identity's data (T308 AC2), and an unknown session gets
        // an explicit `unbound` snapshot rather than an error. Session-scoped reads are loopback
        // only: they carry one mailbox's unread counts, which is host-local information; peers keep
        // the public runtime/challenge contract below. The default answer is the v1 snapshot;
        // `schema=mbx.status/v2` (T404) returns the v2 model from src/status-schema.ts — the mod
        // and the sidebar migrate by changing one query parameter, nothing else.
        const cli = url.searchParams.get("cli"), session = url.searchParams.get("session");
        if (cli && session) {
          if (!isLoopbackRemote(req.socket.remoteAddress ?? ""))
            return send(403, { error: "session-scoped status is loopback only" });
          const resolved = resolveStatusIdentity(node, cli, { sessionId: session });
          res.setHeader("cache-control", "no-store");
          if (url.searchParams.get("schema") === STATUS_V2_SCHEMA)
            return send(200, hudStatusV2(node, {
              cli, sessionId: session, agent: resolved.name, state: resolved.state,
              resolvedBy: resolved.resolved_by ?? "none", candidates: resolved.candidates,
              includeInbox: url.searchParams.get("include") === "inbox",
            }));
          return send(200, hudStatus(node, {
            agent: resolved.name, state: resolved.state,
            resolvedBy: resolved.resolved_by ?? "none", candidates: resolved.candidates,
          }));
        }
        const challenge = url.searchParams.get("challenge");
        if (challenge === null) return send(200, runtime);
        if (!isStr(challenge, 64)) return send(400, { error: "bad challenge" });
        return send(200, signedStatus(node, challenge)); // proves this host's key and its own addresses (T151)
      }
      // T519: the plugin inside a standalone OpenCode serve long-polls this, then admits the text
      // in-process. It sits before verifyHop because that plugin has no hop key. Loopback only:
      // the body is a wake pointer for a session on this machine. A 20s hold fits requestTimeoutMs.
      // T520: doctor reads the unoffered pollers on /waiters. Same loopback rule, no wake text.
      if (url.pathname === "/v1/opencode-wake/waiters") {
        if (!isLoopbackRemote(req.socket.remoteAddress ?? "")) return send(403, { error: "opencode wake queue is loopback only" });
        if (req.method !== "GET") return send(405, { error: "method not allowed" });
        return send(200, { waiters: listOpencodeWakeWaiters() });
      }
      if (url.pathname === "/v1/opencode-wake") {
        if (!isLoopbackRemote(req.socket.remoteAddress ?? "")) return send(403, { error: "opencode wake queue is loopback only" });
        if (req.method === "GET") {
          const sessionID = url.searchParams.get("session") ?? "";
          const pidRaw = url.searchParams.get("pid") ?? "";
          if (!sessionID || sessionID.length > 256 || !/^[1-9]\d{0,9}$/.test(pidRaw)) return send(400, { error: "bad session or pid" });
          const pid = Number(pidRaw);
          let gone = false;
          const onClose = () => { if (!res.writableEnded) { gone = true; cancelOpencodeWake(sessionID, pid); } };
          req.on("close", onClose);
          const text = await waitForOpencodeWake(sessionID, pid);
          req.off("close", onClose);
          if (gone || res.writableEnded) return;
          if (!text) { res.writeHead(204); return res.end(); }
          return send(200, { text });
        }
        if (req.method === "POST") {
          const j = JSON.parse(body || "{}") as { sessionID?: unknown; id?: unknown };
          if (typeof j.sessionID !== "string" || typeof j.id !== "string" || !j.sessionID || j.sessionID.length > 256)
            return send(400, { error: "bad receipt" });
          if (!completeOpencodeWake(j.sessionID, j.id)) return send(409, { error: "no wake is waiting for that receipt" });
          return send(200, { ok: true });
        }
        return send(405, { error: "method not allowed" });
      }
      // T521: the plugin inside a standalone OpenCode serve asks whether it may set effect "allow"
      // on the in-process evaluate hook. Before hop auth, loopback only, and never a wake slot.
      if (url.pathname === "/v1/opencode-permission") {
        if (!isLoopbackRemote(req.socket.remoteAddress ?? "")) return send(403, { error: "opencode permission route is loopback only" });
        if (req.method !== "GET") return send(405, { error: "method not allowed" });
        const sessionID = url.searchParams.get("session") ?? "";
        const pidRaw = url.searchParams.get("pid") ?? "";
        if (!sessionID || sessionID.length > 256 || !/^[1-9]\d{0,9}$/.test(pidRaw)) return send(400, { error: "bad session or pid" });
        return send(200, opencodePermissionDecision(node, sessionID, Number(pidRaw)));
      }
      if (url.pathname === "/v1/pair/hello" || url.pathname === "/v1/pair/join") {
        tokenAttempts = tokenAttempts.filter((t) => Date.now() - t < 60_000);
        if (tokenAttempts.push(Date.now()) > TOKEN_REQS_PER_MIN) return send(429, { error: "too many pairing attempts; wait a minute" });
        if (req.method === "GET" && url.pathname === "/v1/pair/hello") {
          const now = Date.now();
          for (const [n, exp] of hellos) if (exp < now || hellos.size > 256) hellos.delete(n);
          const n = newNonce(); hellos.set(n, now + HELLO_TTL_MS);
          const { addr: _addr, ...party } = localParty(node, n);
          return send(200, party satisfies PairHello);
        }
        if (req.method === "POST") {
          const r = handleJoin(node, JSON.parse(body) as JoinRequest, hellos, req.socket.remoteAddress ?? "?");
          return send(r.code, r.body);
        }
        return send(405, { error: "method not allowed" });
      }
      if (req.method === "POST" && url.pathname === "/v1/pair") {
        pairAttempts = pairAttempts.filter((t) => Date.now() - t < 60_000);
        if (pairAttempts.push(Date.now()) > 10) return send(429, { error: "too many pairing attempts" }); // two requests per pairing
        const j = JSON.parse(body) as { v?: number; commit?: unknown; offer?: PairOffer };
        if (j?.v === 2 && isStr(j.commit, 64)) { // step 1: answer with this host's party before the initiator reveals its own
          const now = Date.now();
          for (const [c, x] of commits) if (x.exp < now || commits.size > 256) commits.delete(c);
          const n = newNonce(); commits.set(j.commit as string, { n, exp: now + HELLO_TTL_MS });
          return send(200, localParty(node, n));
        }
        const offer = j?.v === 2 ? j.offer : undefined;
        if (offer?.v !== 1 || !validParty(offer) || !isStr(offer.addr)) return send(400, { error: "bad offer: code-compare pairing commits before it reveals (v2); upgrade AgentMBX on the initiating host" });
        const key = sha256(canonical(offer)), c = commits.get(key); commits.delete(key);
        if (!c || c.exp < Date.now()) return send(401, { error: "no live commitment matches this offer; run pair --compare again" });
        const code = acceptOffer(node, offer, c.n);
        node.store.audit("pair.request", { from: offer.host, addr: offer.addr, code });
        process.stderr.write(`\n[agentmbx] pairing request from ${offer.host} (${offer.addr}). Code ${code}. Approve with: agentmbx pair approve ${offer.host} ${code}\n`);
        return send(200, { ok: true });
      }
      if (req.method === "POST" && url.pathname === "/v1/rotate") {
        // Self-authenticating (T030): each record is signed by the key this host pinned, so a rotated peer whose hops
        // no longer verify can still move its pin. Nothing else is reachable without a verified hop.
        rotateAttempts = rotateAttempts.filter((t) => Date.now() - t < 60_000);
        if (rotateAttempts.push(Date.now()) > 30) return send(429, { error: "too many key rotation announcements; retry later" });
        const { records } = JSON.parse(body) as { records: SignedRotation[] };
        if (!Array.isArray(records) || records.length > 50) return send(400, { error: "bad batch" });
        return send(200, { results: records.map((r) => node.acceptRotation(r)) });
      }
      const peer = verifyHop(node, req.headers, req.method ?? "GET", url.pathname, body);
      if (url.pathname !== "/v1/presence") void learnPeerAddr(node, peer, req.socket.remoteAddress ?? "", req.headers["x-mbx-port"]).catch(() => {});
      try { node.peerIsBack(peer); } catch { /* db busy: the back-off retry still delivers */ }
      const now = Date.now(), recent = (peerReqs.get(peer) ?? []).filter((t) => now - t < 60_000);
      peerReqs.set(peer, recent);
      if (recent.push(now) > L.peerReqsPerMin) return send(429, { error: `rate limit: over ${L.peerReqsPerMin} requests a minute from ${peer}; retry later` });
      if (req.method === "POST" && url.pathname === "/v1/presence") {
        const { healing: _h, ...r } = acceptPresence(node, peer, JSON.parse(body), req.socket.remoteAddress ?? "");
        return send(r.ok ? 202 : 400, r);
      }
      if (req.method === "POST" && url.pathname === "/v1/unpair") {
        // The peer removed this pairing: drop it here too, so mail stops queueing for a host that refuses it.
        node.removePeer(peer);
        node.store.audit("pair.removed_by_peer", { host: peer });
        process.stderr.write(`\n[agentmbx] ${peer} removed its pairing with this host; removed ${peer} here too\n`);
        return send(200, { ok: true });
      }
      if (req.method === "POST" && ["/v1/envelopes", "/v2/envelopes"].includes(url.pathname)) {
        const { envelopes } = JSON.parse(body) as { envelopes: unknown[] };
        if (!Array.isArray(envelopes) || envelopes.length > 200) return send(400, { error: "bad batch: envelopes must be an array of at most 200" });
        const results = envelopes.map((e) => ({ id: (e as Envelope)?.id, result: node.receive(e, peer) }));
        if (results.some((r) => r.result === "accepted")) onEnvelope?.();
        return send(200, { results });
      }
      if (req.method === "POST" && url.pathname === "/v1/receipts") {
        // Delivery receipts for mail this host sent (T218): each is signed by the recipient host, which must be this peer.
        const { receipts } = JSON.parse(body) as { receipts: unknown[] };
        if (!Array.isArray(receipts) || receipts.length > RECEIPT_BATCH) return send(400, { error: `bad batch: receipts must be an array of at most ${RECEIPT_BATCH}` });
        return send(200, { results: receipts.map((r) => acceptReceipt(node, r, peer)) });
      }
      if (req.method === "POST" && url.pathname === "/v1/policy") {
        const { items } = JSON.parse(body) as { items: Signed<AnyRecord>[] };
        if (!Array.isArray(items) || items.length > 200) return send(400, { error: "bad batch: items must be an array of at most 200" });
        return send(200, { results: items.map((it) => ({ id: it?.rec?.id, error: acceptSigned(node.store.db, it, node.host, { hostPub: node.key.publicKey }) })) });
      }
      if (req.method === "GET" && url.pathname === "/v1/policies") {
        // stable cursor (kind rank + ULID), so records added between pages never shift or hide others
        const after = url.searchParams.get("after") ?? "", limit = Math.min(1000, Math.max(1, Number(url.searchParams.get("limit")) || 1000));
        const rest = signedRecords(node).filter((r) => recordKey(r) > after);
        return send(200, { items: rest.slice(0, limit), more: rest.length > limit });
      }
      if (req.method === "GET" && url.pathname === "/v1/agents") {
        return send(200, { host: node.host, agents: node.agents().filter((a) => a.host === node.host).map(({ name, role, cli, description, last_seen }) => ({ name, role, cli, description, last_seen })) });
      }
      if (req.method === "GET" && url.pathname === "/v1/enc-key") {
        // Pairwise body-encryption key (T028 Option A). The channel is peer-authenticated by verifyHop
        // above; the signature lets the requester pin enc_pub to THIS host's already-pinned signing key.
        const payload = canonical({ v: 1, host: node.host, enc_pub: node.encKey.publicKey });
        return send(200, { v: 1, host: node.host, enc_pub: node.encKey.publicKey, sig: signData(node.key.privateKey, payload) });
      }
      return send(404, { error: "not found" });
    } catch (e) {
      const { message: msg, status } = e as Error & { status?: number };
      // oversized body: answer, then discard (never buffer) the rest for up to 2 s so the client reads the 413, not a reset
      if (status === 413) { send(413, { error: msg }); req.resume(); return void setTimeout(() => req.complete || req.destroy(), 2_000).unref(); }
      send(status ?? (/paired|signature|timestamp/.test(msg) ? 401 : 400), { error: msg });
    }
  });
  return new Promise((resolve, reject) => { server.once("error", reject); server.listen(port, bind, () => resolve(server)); });
}

// ---- client: outbox + directory --------------------------------------------------------------
async function post(node: MbxNode, addr: string, path: string, obj: unknown) {
  const body = JSON.stringify(obj);
  const res = await fetch(`http://${addr}${path}`, { method: "POST", headers: signHop(node, "POST", path, body), body, redirect: "error", signal: AbortSignal.timeout(15_000) });
  if (!res.ok) {
    if (path === "/v2/envelopes" && [404, 405, 501].includes(res.status)) {
      await res.body?.cancel();
      throw new Error("peer does not support verified-sender delivery (/v2/envelopes); upgrade the receiving AgentMBX; no legacy fallback");
    }
    throw new Error(`${res.status} ${await res.text()}`);
  }
  return res.json();
}

/** Push due outbox rows to their hosts. Network errors back off; rejections and 72 h expiry alert the sender. */
export async function flushOutbox(node: MbxNode, now = Date.now()): Promise<{ sent: number; failed: number }> {
  const due = node.store.db.prepare(`SELECT o.msg_id, o.host, o.attempts, o.created_at, m.envelope FROM outbox o JOIN messages m ON m.id=o.msg_id
    WHERE o.next_at <= ? ORDER BY o.created_at LIMIT 200`).all(new Date(now).toISOString()) as { msg_id: string; host: string; attempts: number; created_at: string; envelope: string }[];
  const byHost = new Map<string, typeof due>();
  for (const r of due) byHost.set(r.host, [...(byHost.get(r.host) ?? []), r]);
  let sent = 0, failed = 0;
  // A row the relay accepted before a restore is back here for a re-push (state `repush`, T167). A LAN delivery settles
  // it; a LAN rejection ends it `rejected` (its sender is alerted below, doctor shows it); the relay deadline
  // (relaySettle), not the LAN's 72 h, decides when it is given up.
  const done = (id: string, host: string, delivered = false) => node.store.tx(() => {
    node.store.db.prepare("DELETE FROM outbox WHERE msg_id=? AND host=?").run(id, host);
    if (node.store.db.prepare("UPDATE relay_sent SET state=?, settled_at=? WHERE msg_id=? AND host=? AND state='repush'").run(delivered ? "settled" : "rejected", new Date(now).toISOString(), id, host).changes)
      node.store.db.prepare("DELETE FROM relay_wire WHERE msg_id=? AND host=?").run(id, host);
  });
  const heldByRelay = (id: string, host: string) => !!node.store.db.prepare("SELECT 1 FROM relay_sent WHERE msg_id=? AND host=? AND state='repush'").get(id, host);
  const alertSender = (r: (typeof due)[number], why: string) => {
    const e = JSON.parse(r.envelope) as Envelope;
    node.send({ from: "mbx", to: [e.from.split("@")[0]], kind: "alert", subject: `Undelivered to ${r.host}: ${e.subject}`, body: `Message ${e.id} could not be delivered to host ${r.host}: ${why}` });
  };
  for (const [host, rows] of byHost) {
    let peer = node.approvedPeer(host);
    try {
      if (!peer) throw new Error("host is no longer paired");
      if (!peer.enc_pub) { await refreshPeerEncKeys(node, fetch, host); peer = node.approvedPeer(host); }
      // Bodies never cross the LAN in plaintext (T028): without the peer's pinned enc key, keep retrying.
      const encPub = peer?.enc_pub;
      if (!peer || !encPub) throw new Error(`${host} has not published a body-encryption key; upgrade AgentMBX there (bodies are never sent in plaintext)`);
      // This endpoint requires sender-proof-aware receivers. Never retry via v1: older
      // receivers can grant policy authority to unverified or missing-marker envelopes.
      const envelopes = rows.map((r) => sealEnvelope(JSON.parse(r.envelope) as Envelope, encPub, node.host, node.key.publicKey, node.key.privateKey));
      const { results } = await post(node, peer.addr, "/v2/envelopes", { envelopes }) as { results: { id: string; result: string }[] };
      for (const r of rows) {
        const res = results.find((x) => x.id === r.msg_id)?.result ?? "rejected:missing result";
        done(r.msg_id, host, !res.startsWith("rejected"));
        if (res.startsWith("rejected")) { failed++; alertSender(r, res); } else sent++;
      }
    } catch (err) {
      for (const r of rows) {
        if (now - Date.parse(r.created_at) > RETRY_HOURS * 3_600_000 && !heldByRelay(r.msg_id, host)) { done(r.msg_id, host); failed++; alertSender(r, `gave up after ${RETRY_HOURS} h (${(err as Error).message})`); continue; }
        const wait = Math.min(5_000 * 2 ** r.attempts, 3_600_000);
        node.store.db.prepare("UPDATE outbox SET attempts=attempts+1, next_at=?, last_error=? WHERE msg_id=? AND host=?")
          .run(new Date(now + wait).toISOString(), (err as Error).message.slice(0, 300), r.msg_id, host);
      }
    }
  }
  return { sent, failed };
}

/** Push the delivery receipts this host owes the hosts its received mail came from (T218). Receipts are advisory: a peer
 *  without the endpoint (an older AgentMBX) is retried hourly and its receipts expire after RETRY_HOURS, with no alert. */
export async function flushReceipts(node: MbxNode, now = Date.now()): Promise<{ sent: number; deferred: number }> {
  let sent = 0, deferred = 0;
  for (const [host, rows] of dueReceipts(node, now)) {
    const peer = node.approvedPeer(host);
    if (!peer) { receiptsDeferred(node, host, "host is not paired", now); deferred += rows.length; continue; }
    try {
      const { results } = await post(node, peer.addr, "/v1/receipts", { receipts: rows.map((r) => signReceipt(node, r)) }) as { results: string[] };
      if (!Array.isArray(results) || results.length !== rows.length) throw new Error("bad receipts response");
      const rejected = rows.map((r, i) => ({ seq: r.seq, msg: r.msg_id, result: String(results[i]) })).filter((r) => r.result.startsWith("rejected"));
      if (rejected.length) node.store.audit("receipt.rejected", { host, items: rejected.slice(0, 10) });
      receiptsSent(node, rows.map((r) => r.seq)); sent += rows.length;
    } catch (e) {
      const msg = (e as Error).message, unsupported = /^(404|405|501) /.test(msg);
      receiptsDeferred(node, host, unsupported ? `${host} does not accept receipts yet (older AgentMBX)` : msg, now, unsupported);
      deferred += rows.length;
    }
  }
  return { sent, deferred };
}

/** Deliver this host's key rotations to every peer that has not accepted them yet (T030). */
const rotationTried = new Map<string, number>();
export async function announceRotations(node: MbxNode, f: typeof fetch = fetch, force = false, now = Date.now()): Promise<{ host: string; ok: boolean; error?: string }[]> {
  const log = rotationLog(node.home);
  if (!log.records.length) return [];
  const out: { host: string; ok: boolean; error?: string }[] = [];
  for (const p of node.peers().filter((x) => x.state === "approved" && (log.delivered[x.host] ?? 0) < log.records.length)) {
    if (!force && now - (rotationTried.get(p.host) ?? 0) < 60_000) continue; // an offline peer is retried once a minute
    rotationTried.set(p.host, now);
    try {
      const body = JSON.stringify({ records: log.records.slice(log.delivered[p.host] ?? 0) });
      const res = await f(`http://${p.addr}/v1/rotate`, { method: "POST", headers: { "content-type": "application/json" }, body, redirect: "error", signal: AbortSignal.timeout(5_000) });
      if (!res.ok) throw new Error(res.status === 404 ? "peer does not support key rotation; upgrade AgentMBX there" : `${res.status} ${await res.text()}`);
      const { results } = await res.json() as { results: string[] };
      const bad = results.find((r) => r.startsWith("rejected"));
      if (bad) throw new Error(bad);
      const fresh = rotationLog(node.home); // re-read: another process may have rotated again meanwhile
      fresh.delivered[p.host] = Math.max(fresh.delivered[p.host] ?? 0, log.records.length);
      saveRotationLog(node.home, fresh);
      out.push({ host: p.host, ok: true });
    } catch (e) { out.push({ host: p.host, ok: false, error: (e as Error).message }); }
  }
  return out;
}

/** Tell a peer this host is removing their pairing (best effort: an offline peer learns when its hops start failing). */
export async function notifyUnpair(node: MbxNode, host: string): Promise<boolean> {
  const p = node.approvedPeer(host);
  if (!p) return false;
  try { return (await post(node, p.addr, "/v1/unpair", {}) as { ok?: boolean }).ok === true; } catch { return false; }
}

/** Pull each paired host's agent list so bare names and `mbx agents` work across machines. */
export async function refreshDirectory(node: MbxNode) {
  for (const p of node.peers().filter((x) => x.state === "approved")) {
    try {
      const path = "/v1/agents";
      const res = await fetch(`http://${p.addr}${path}`, { headers: signHop(node, "GET", path, ""), signal: AbortSignal.timeout(5_000) });
      if (!res.ok) continue;
      const { agents } = await res.json() as { agents: { name: string; role: string | null; cli: string | null; description: string | null; last_seen: string | null }[] };
      for (const a of agents.slice(0, 500)) {
        if (!NAME_RE.test(a.name)) continue;
        node.store.db.prepare(`INSERT INTO agents (name,host,role,cli,description,last_seen) VALUES (?,?,?,?,?,?) ON CONFLICT(name,host)
          DO UPDATE SET role=excluded.role, cli=excluded.cli, description=excluded.description, last_seen=excluded.last_seen`)
          .run(a.name, p.host, a.role, a.cli, a.description, a.last_seen);
      }
    } catch { /* peer offline; try next time */ }
  }
}

/**
 * Learn each approved peer's body-encryption key (T028 Option A) over the already-authenticated
 * host channel. The response signature is checked against the peer's PINNED host signing key, so a
 * man-in-the-middle cannot substitute its own enc key. The LAN send path seals every body with it.
 */
export async function refreshPeerEncKeys(node: MbxNode, f: typeof fetch = fetch, only?: string): Promise<void> {
  for (const p of node.peers().filter((x) => x.state === "approved" && !x.enc_pub && (only === undefined || x.host === only))) {
    try {
      const path = "/v1/enc-key";
      const res = await f(`http://${p.addr}${path}`, { headers: signHop(node, "GET", path, ""), redirect: "error", signal: AbortSignal.timeout(5_000) });
      if (!res.ok) continue;
      const j = await res.json() as { v?: number; host?: string; enc_pub?: string; sig?: string };
      if (j.v !== 1 || j.host !== p.host || typeof j.enc_pub !== "string" || typeof j.sig !== "string") continue;
      if (!verifyData(p.pubkey, canonical({ v: 1, host: p.host, enc_pub: j.enc_pub }), j.sig)) {
        node.store.audit("enc_key.rejected", { host: p.host, reason: "signature does not verify against the pinned host key" });
        continue;
      }
      node.store.db.prepare("UPDATE peers SET enc_pub=? WHERE host=?").run(j.enc_pub, p.host);
      node.store.audit("enc_key.learned", { host: p.host });
    } catch { /* peer offline or too old; try next pass */ }
  }
}

// ---- policies: push on set/revoke, pull every minute so offline hosts catch up ----------------------------
/** Everything a peer may need: unexpired policies and their retained signed revocations. */
const RANK: Record<string, number> = { device: 0, revocation: 1, policy: 2 };
/** Sync order: devices (trust first), then revocations (a kill switch never loses to the policy it kills), then policies. */
export const recordKey = (s: Signed<AnyRecord>) => `${RANK[s.rec.type] ?? 9}:${s.rec.id}`;

export function signedRecords(node: MbxNode): Signed<AnyRecord>[] {
  const db = node.store.db, now = new Date().toISOString(), since = new Date(Date.now() - 30 * 86_400_000).toISOString();
  // A long-offline peer must still see the revocation of a never-expiring policy.
  // Finite policies outlive neither the 30-day window nor their expiry; kill switches
  // and targeted revocations of permanent records must remain in the sync snapshot.
  const rs = db.prepare(`SELECT record, sig FROM policy_revocations WHERE iat > ? OR target='*'
    OR target IN (SELECT id FROM policies WHERE exp IS NULL)`).all(since) as { record: string; sig: string }[];
  const ds = db.prepare("SELECT record, sig FROM devices").all() as { record: string; sig: string }[];
  const ps = storedPolicies(db).valid.filter(p => policyUnexpired(p.rec.exp, Date.parse(now))).map(({ rec, sig }) => ({ rec, sig }));
  return [...[...rs, ...ds].map((r) => ({ rec: JSON.parse(r.record) as AnyRecord, sig: r.sig })), ...ps].sort((a, b) => (recordKey(a) < recordKey(b) ? -1 : 1));
}

/** Send signed records to the paired hosts they concern. Returns per-host results; offline hosts get them on their next pull. */
export async function pushPolicy(node: MbxNode, items: Signed<AnyRecord>[]): Promise<{ host: string; ok: boolean; error?: string }[]> {
  const out: { host: string; ok: boolean; error?: string }[] = [];
  for (const p of node.peers().filter((x) => x.state === "approved")) {
    const mine = items.filter((it) => it.rec.type === "revocation" || (it.rec.type === "device" ? it.rec.host === p.host : it.rec.to.hosts.includes("*") || it.rec.to.hosts.includes(p.host)));
    if (!mine.length) continue;
    try {
      const { results } = await post(node, p.addr, "/v1/policy", { items: mine }) as { results: { id: string; error: string | null }[] };
      const bad = results.filter((r) => r.error);
      out.push({ host: p.host, ok: !bad.length, ...(bad.length ? { error: bad.map((b) => b.error).join("; ") } : {}) });
    } catch (e) { out.push({ host: p.host, ok: false, error: (e as Error).message }); }
  }
  return out;
}

/** Pull every record a paired host serves, in sync order; rejected records and incomplete syncs go to the audit log. */
export async function pullPolicies(node: MbxNode) {
  for (const p of node.peers().filter((x) => x.state === "approved")) {
    let received = 0, complete = false;
    const rejected: { id: string; error: string }[] = [];
    try {
      for (let after = "", pages = 0; pages < 200; pages++) {
        const path = "/v1/policies";
        const res = await fetch(`http://${p.addr}${path}?after=${encodeURIComponent(after)}&limit=1000`, { headers: signHop(node, "GET", path, ""), signal: AbortSignal.timeout(5_000) });
        if (!res.ok) break;
        const { items, more } = await res.json() as { items: Signed<AnyRecord>[]; more?: boolean };
        for (const it of items) {
          received++;
          if (it?.rec?.type === "policy" && !it.rec.to.hosts.includes("*") && !it.rec.to.hosts.includes(node.host)) continue;
          if (it?.rec?.type === "device" && it.rec.host !== node.host) continue;
          const err = acceptSigned(node.store.db, it, node.host, { hostPub: node.key.publicKey });
          if (err) rejected.push({ id: it?.rec?.id, error: err });
        }
        if (!items.length || !more) { complete = true; break; }
        after = recordKey(items[items.length - 1]);
      }
    } catch { /* peer offline: reported below */ }
    // audit problems once per change of state, not every minute while a peer stays offline
    const state = JSON.stringify({ complete, rejected: rejected.map((r) => r.id).slice(0, 20) }), key = `policy-sync:${p.host}`;
    if (node.store.get(key) !== state) {
      node.store.set(key, state);
      if (rejected.length || !complete) node.store.audit("policy.sync", { host: p.host, received, complete, rejected: rejected.slice(0, 20) });
      else node.store.audit("policy.sync", { host: p.host, received, complete });
    }
  }
}
