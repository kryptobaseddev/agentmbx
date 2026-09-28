// Host-to-host HTTP: pairing, envelope exchange, agent directory. Every request except /v1/pair* and read-only /v1/status carries a
// signed hop (X-Mbx-Host / -Ts / -Sig over method, path, ts, sha256(body)); freshness is checked on the hop only.
import { createServer, type IncomingMessage, type Server } from "node:http";
import { hostname } from "node:os";
import {
  fingerprint, joinTranscript, nonce as newNonce, pairingCode, pairMac, pairTokenKey, safeEqual, sha256, signData, verifyData, type PairParty,
} from "./crypto.ts";
import { NAME_RE, type Envelope } from "./envelope.ts";
import { MbxNode, RETRY_HOURS } from "./node.ts";
import { notifyDesktop } from "./wake.ts";
import { version } from "./version.ts";
import { storedPolicies, acceptSigned, type AnyRecord, type Signed } from "./policy.ts";

export const HOP_SKEW_MS = 5 * 60_000;
const MAX_REQ = 4 * 1024 * 1024;
const HELLO_TTL_MS = 2 * 60_000;
const TOKEN_REQS_PER_MIN = 30;

const hopPayload = (method: string, path: string, ts: string, body: string) => `${method}\n${path}\n${ts}\n${sha256(body)}`;

export function signHop(node: MbxNode, method: string, path: string, body: string): Record<string, string> {
  const ts = new Date().toISOString();
  return { "x-mbx-host": node.host, "x-mbx-ts": ts, "x-mbx-sig": signData(node.key.privateKey, hopPayload(method, path, ts, body)), "content-type": "application/json" };
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

export const advertisedAddr = (node: MbxNode) => process.env.MBX_ADVERTISE || `${hostname().replace(/\.local$/, "").toLowerCase()}.local:${node.config.port}`;

const readBody = (req: IncomingMessage) => new Promise<string>((res, rej) => {
  let n = 0; const chunks: Buffer[] = [];
  req.on("data", (c: Buffer) => { n += c.length; if (n > MAX_REQ) { rej(new Error("request too large")); req.destroy(); } else chunks.push(c); });
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

/** Initiator side of `mbx pair <addr>`. Returns the code both humans must compare. */
export async function pairWith(node: MbxNode, addr: string): Promise<{ host: string; code: string; key: string; owner: string | null }> {
  const n = newNonce();
  const res = await fetch(`http://${addr}/v1/pair`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(localParty(node, n)), signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`pairing refused by ${addr}: ${await res.text()}`);
  const remote = await res.json() as PairOffer;
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
export function startServer(node: MbxNode, port = node.config.port, bind = node.config.bind, onEnvelope?: () => void): Promise<Server> {
  const runtime = { service: "agentmbx", v: 1, host: node.host, host_pubkey: node.key.publicKey, version: version(), started_at: new Date().toISOString() };
  let pairAttempts: number[] = [], tokenAttempts: number[] = [];
  const hellos = new Map<string, number>(); // hello nonce → expiry
  const server = createServer(async (req, res) => {
    const send = (code: number, obj: unknown) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(obj)); };
    try {
      const url = new URL(req.url ?? "/", "http://x"); const body = await readBody(req);
      // Public diagnostic metadata only: this neither issues pairing nonces nor grants authority.
      if (url.pathname === "/v1/status") return req.method === "GET"
        ? send(200, runtime) : send(405, { error: "method not allowed" });
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
        if (pairAttempts.push(Date.now()) > 5) return send(429, { error: "too many pairing attempts" });
        const offer = JSON.parse(body) as PairOffer;
        if (offer?.v !== 1 || typeof offer.host !== "string" || typeof offer.host_pubkey !== "string") return send(400, { error: "bad offer" });
        const n = newNonce();
        const code = acceptOffer(node, offer, n);
        node.store.audit("pair.request", { from: offer.host, addr: offer.addr, code });
        process.stderr.write(`\n[agentmbx] pairing request from ${offer.host} (${offer.addr}). Code ${code}. Approve with: agentmbx pair approve ${offer.host} ${code}\n`);
        return send(200, localParty(node, n));
      }
      const peer = verifyHop(node, req.headers, req.method ?? "GET", url.pathname, body);
      if (req.method === "POST" && ["/v1/envelopes", "/v2/envelopes"].includes(url.pathname)) {
        const { envelopes } = JSON.parse(body) as { envelopes: unknown[] };
        if (!Array.isArray(envelopes) || envelopes.length > 200) return send(400, { error: "bad batch" });
        const results = envelopes.map((e) => ({ id: (e as Envelope)?.id, result: node.receive(e, peer) }));
        if (results.some((r) => r.result === "accepted")) onEnvelope?.();
        return send(200, { results });
      }
      if (req.method === "POST" && url.pathname === "/v1/policy") {
        const { items } = JSON.parse(body) as { items: Signed<AnyRecord>[] };
        if (!Array.isArray(items) || items.length > 200) return send(400, { error: "bad batch" });
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
      return send(404, { error: "not found" });
    } catch (e) {
      const msg = (e as Error).message;
      send(/paired|signature|timestamp/.test(msg) ? 401 : 400, { error: msg });
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
  const done = (id: string, host: string) => node.store.db.prepare("DELETE FROM outbox WHERE msg_id=? AND host=?").run(id, host);
  const alertSender = (r: (typeof due)[number], why: string) => {
    const e = JSON.parse(r.envelope) as Envelope;
    node.send({ from: "mbx", to: [e.from.split("@")[0]], kind: "alert", subject: `Undelivered to ${r.host}: ${e.subject}`, body: `Message ${e.id} could not be delivered to host ${r.host}: ${why}` });
  };
  for (const [host, rows] of byHost) {
    const peer = node.approvedPeer(host);
    try {
      if (!peer) throw new Error("host is no longer paired");
      // This endpoint requires sender-proof-aware receivers. Never retry via v1: older
      // receivers can grant policy authority to unverified or missing-marker envelopes.
      const { results } = await post(node, peer.addr, "/v2/envelopes", { envelopes: rows.map((r) => JSON.parse(r.envelope)) }) as { results: { id: string; result: string }[] };
      for (const r of rows) {
        const res = results.find((x) => x.id === r.msg_id)?.result ?? "rejected:missing result";
        done(r.msg_id, host);
        if (res.startsWith("rejected")) { failed++; alertSender(r, res); } else sent++;
      }
    } catch (err) {
      for (const r of rows) {
        if (now - Date.parse(r.created_at) > RETRY_HOURS * 3_600_000) { done(r.msg_id, host); failed++; alertSender(r, `gave up after ${RETRY_HOURS} h (${(err as Error).message})`); continue; }
        const wait = Math.min(5_000 * 2 ** r.attempts, 3_600_000);
        node.store.db.prepare("UPDATE outbox SET attempts=attempts+1, next_at=?, last_error=? WHERE msg_id=? AND host=?")
          .run(new Date(now + wait).toISOString(), (err as Error).message.slice(0, 300), r.msg_id, host);
      }
    }
  }
  return { sent, failed };
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

// ---- policies: push on set/revoke, pull every minute so offline hosts catch up ----------------------------
/** Everything a peer may need: unexpired policies and revocations from the last 30 days, as signed records. */
const RANK: Record<string, number> = { device: 0, revocation: 1, policy: 2 };
/** Sync order: devices (trust first), then revocations (a kill switch never loses to the policy it kills), then policies. */
export const recordKey = (s: Signed<AnyRecord>) => `${RANK[s.rec.type] ?? 9}:${s.rec.id}`;

export function signedRecords(node: MbxNode): Signed<AnyRecord>[] {
  const db = node.store.db, now = new Date().toISOString(), since = new Date(Date.now() - 30 * 86_400_000).toISOString();
  const rs = db.prepare("SELECT record, sig FROM policy_revocations WHERE iat > ?").all(since) as { record: string; sig: string }[];
  const ds = db.prepare("SELECT record, sig FROM devices").all() as { record: string; sig: string }[];
  const ps = storedPolicies(db).valid.filter(p => Date.parse(p.rec.exp) > Date.parse(now)).map(({ rec, sig }) => ({ rec, sig }));
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
