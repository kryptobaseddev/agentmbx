// Host-to-host HTTP: pairing, envelope exchange, agent directory. Every request except /v1/pair carries a
// signed hop (X-Mbx-Host / -Ts / -Sig over method, path, ts, sha256(body)); freshness is checked on the hop only.
import { createServer, type IncomingMessage, type Server } from "node:http";
import { hostname } from "node:os";
import { fingerprint, nonce as newNonce, pairingCode, sha256, signData, verifyData, type PairParty } from "./crypto.ts";
import { NAME_RE, type Envelope } from "./envelope.ts";
import { MbxNode, RETRY_HOURS } from "./node.ts";

export const HOP_SKEW_MS = 5 * 60_000;
const MAX_REQ = 4 * 1024 * 1024;

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

// ---- server ----------------------------------------------------------------------------------
export function startServer(node: MbxNode, port = node.config.port, bind = node.config.bind, onEnvelope?: () => void): Promise<Server> {
  let pairAttempts: number[] = [];
  const server = createServer(async (req, res) => {
    const send = (code: number, obj: unknown) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(obj)); };
    try {
      const url = new URL(req.url ?? "/", "http://x"); const body = await readBody(req);
      if (req.method === "POST" && url.pathname === "/v1/pair") {
        pairAttempts = pairAttempts.filter((t) => Date.now() - t < 60_000);
        if (pairAttempts.push(Date.now()) > 5) return send(429, { error: "too many pairing attempts" });
        const offer = JSON.parse(body) as PairOffer;
        if (offer?.v !== 1 || typeof offer.host !== "string" || typeof offer.host_pubkey !== "string") return send(400, { error: "bad offer" });
        const n = newNonce();
        const code = acceptOffer(node, offer, n);
        node.store.audit("pair.request", { from: offer.host, addr: offer.addr, code });
        process.stderr.write(`\n[mbx] pairing request from ${offer.host} (${offer.addr}). Code ${code}. Approve with: mbx pair approve ${offer.host} ${code}\n`);
        return send(200, localParty(node, n));
      }
      const peer = verifyHop(node, req.headers, req.method ?? "GET", url.pathname, body);
      if (req.method === "POST" && url.pathname === "/v1/envelopes") {
        const { envelopes } = JSON.parse(body) as { envelopes: unknown[] };
        if (!Array.isArray(envelopes) || envelopes.length > 200) return send(400, { error: "bad batch" });
        const results = envelopes.map((e) => ({ id: (e as Envelope)?.id, result: node.receive(e, peer) }));
        if (results.some((r) => r.result === "accepted")) onEnvelope?.();
        return send(200, { results });
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
  const res = await fetch(`http://${addr}${path}`, { method: "POST", headers: signHop(node, "POST", path, body), body, signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
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
      const { results } = await post(node, peer.addr, "/v1/envelopes", { envelopes: rows.map((r) => JSON.parse(r.envelope)) }) as { results: { id: string; result: string }[] };
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
