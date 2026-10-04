// Durable relay client (T166, docs/spec/relay-durability.md §3, §4, §5, §9, §10). A row goes to the relay only after it
// failed twice on the LAN and its backoff is due; its sealed bytes are persisted before the first push and reused on
// every retry; it leaves the outbox only on a valid accept signed by the pinned relay key, then waits in relay_sent for
// the target's delivery receipt or the sender-side deadline. The receiving side processes items in seq order, keeps
// what it cannot accept in quarantine, checkpoints, and only then acks. An epoch change (a restore) or a queue head
// below the checkpoint makes senders re-push and receivers re-pull; dedup on both ends makes that safe. A row the relay
// accepted keeps its relay deadline through a re-push (state `repush`), and a relay expiry notice ends it with an alert
// (T167): accepted mail never leaves this host's books without the sender being told.
import { canonical, fingerprint, signData, verifyData } from "./crypto.ts";
import { sealEnvelope, type Envelope } from "./envelope.ts";
import { rotationLog } from "./key-rotation.ts";
import type { MbxNode } from "./node.ts";
import { acceptReceipt, receiptsSent, signReceipt } from "./remote-receipts.ts";
import { createHash } from "node:crypto";

export interface RelayInfo {
  v: number; relay_pubkey: string; epoch: string;
  limits: { max_batch: number; max_pull: number; retention_days: number; max_item_bytes: number };
}
interface AcceptStatement { v: 1; type: "relay-accept"; relay_pubkey: string; epoch: string; sender_pubkey: string; item_id: string; targets: { host_pubkey: string; seq: number; wire_hash: string }[]; at: string }
interface PushResult { item_id: string; status: string; accept?: AcceptStatement; sig?: string }
export interface RelaySession { relay: string; info: RelayInfo; f: typeof fetch }

/** A LAN row moves to the relay after this many failed LAN attempts (spec §10). */
export const RELAY_AFTER_ATTEMPTS = 2;
/** Sender-side grace after the relay's retention before an unconfirmed relay delivery is reported (spec §3). */
export const RELAY_DEADLINE_GRACE_MS = 24 * 3_600_000;
const PAGES_PER_TICK = 20;

const base = (relay: string) => relay.replace(/\/$/, "");
const sha256hex = (b: Buffer) => createHash("sha256").update(b).digest("hex");
const kv = (node: MbxNode, k: string) => node.store.get(k);
const iso = (ms: number) => new Date(ms).toISOString();

/** A signed v2 hop: method, path with its query, timestamp and body; the host key header lets the relay find us by key. */
function hop(node: MbxNode, method: string, pathAndQuery: string, body: string) {
  const ts = String(Date.now());
  return { "content-type": "application/json", "x-mbx-host": node.host, "x-mbx-key": node.key.publicKey, "x-mbx-ts": ts,
    "x-mbx-sig": signData(node.key.privateKey, canonical({ method, path: pathAndQuery, ts, body: `${method}:${pathAndQuery}:${ts}:${body}` })) };
}
async function call(s: RelaySession, node: MbxNode, method: string, pathAndQuery: string, obj?: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  const body = obj === undefined ? "" : JSON.stringify(obj);
  const res = await s.f(base(s.relay) + pathAndQuery, { method, headers: hop(node, method, pathAndQuery, body), body: body || undefined, signal: AbortSignal.timeout(15_000) }).catch(() => null);
  if (!res) return { status: 0, json: { error: "relay unreachable" } };
  if (res.status === 401) node.store.db.prepare("DELETE FROM kv WHERE k LIKE ?").run(`relay-enrolled-v2:${s.relay}:%`); // re-enrol next pass (G6)
  return { status: res.status, json: await res.json().catch(() => ({})) as Record<string, unknown> };
}

/** GET /v2/relay/info: the info, or the HTTP status that came instead (0 = unreachable). */
async function fetchInfo(relay: string, f: typeof fetch): Promise<{ info: RelayInfo | null; status: number }> {
  const res = await f(`${base(relay)}/v2/relay/info`, { signal: AbortSignal.timeout(10_000) }).catch(() => null);
  if (!res) return { info: null, status: 0 };
  if (res.status !== 200) return { info: null, status: res.status };
  const j = await res.json().catch(() => null) as RelayInfo | null;
  return { info: j && j.v === 2 && typeof j.relay_pubkey === "string" && typeof j.epoch === "string" && j.limits ? j : null, status: 200 };
}
export async function relayInfo(relay: string, f: typeof fetch = fetch): Promise<RelayInfo | null> { return (await fetchInfo(relay, f)).info; }

/**
 * How to use this relay this tick. v1 is allowed only for a relay that answers 404 to /v2/relay/info and never spoke v2
 * to us (no pinned key): v1 senders drop a row on any 200, so falling back after a key change, an enrolment failure
 * or an error would lose mail silently. Anything else that is not a usable v2 session skips the relay for this tick.
 */
export async function relayRoute(node: MbxNode, relay: string, f: typeof fetch = fetch): Promise<{ mode: "v2"; session: RelaySession } | { mode: "v1" } | { mode: "skip"; why: string }> {
  const { info, status } = await fetchInfo(relay, f);
  if (!info) return status === 404 && !kv(node, `relay-key:${relay}`) ? { mode: "v1" } : { mode: "skip", why: status ? `relay info answered ${status}` : "relay unreachable" };
  const session = await relayOpen(node, relay, f, info).catch(() => null);
  return session ? { mode: "v2", session } : { mode: "skip", why: "relay session could not open (see doctor)" };
}

/**
 * Open a v2 session for this tick: pin the relay key (trust on first use until `relay set --key`, T168; a changed key
 * stops relay use), notice an epoch change, make sure this host is enrolled with its enc key published, and hand the
 * relay any key rotation it has not seen. Null: use v1 (or nothing) this tick.
 */
export async function relayOpen(node: MbxNode, relay: string, f: typeof fetch = fetch, given?: RelayInfo): Promise<RelaySession | null> {
  const info = given ?? await relayInfo(relay, f);
  if (!info) return null;
  const pinned = kv(node, `relay-key:${relay}`);
  if (!pinned) node.store.set(`relay-key:${relay}`, info.relay_pubkey);
  else if (pinned !== info.relay_pubkey) {
    node.store.audit("relay.key_changed", { relay, pinned: fingerprint(pinned), served: fingerprint(info.relay_pubkey) });
    return null; // never trust accepts from another key; the owner confirms the new key (agentmbx relay set --key, T168)
  }
  const s: RelaySession = { relay, info, f };
  const known = kv(node, `relay-epoch:${relay}`);
  if (known !== info.epoch) {
    if (known) relayEpochChanged(node, relay, info.epoch, "epoch");
    else node.store.set(`relay-epoch:${relay}`, info.epoch);
  }
  await announceRotationsToRelay(node, s);
  if (!await ensureEnrolled(node, s)) return null;
  await publishSenders(node, s);
  return s;
}

async function ensureEnrolled(node: MbxNode, s: RelaySession): Promise<boolean> {
  const flag = `relay-enrolled-v2:${s.relay}:${node.key.publicKey}:${s.info.relay_pubkey}:${s.info.epoch}`;
  if (kv(node, flag)) return true;
  const ownerFp = (node.store.db.prepare("SELECT fp FROM principals WHERE role='owner' AND via='local' LIMIT 1").get() as { fp?: string } | undefined)?.fp ?? "";
  const chal = await call(s, node, "POST", "/v1/relay/challenge", { host: node.host, pubkey: node.key.publicKey });
  const challenge = chal.json.challenge;
  if (typeof challenge !== "string") { node.store.audit("relay.enrol_failed", { relay: s.relay, status: chal.status, error: String(chal.json.error ?? "") }); return false; }
  const sig = signData(node.key.privateKey, canonical({ v: 1, challenge, host: node.host, pubkey: node.key.publicKey, owner_fp: ownerFp }));
  const r = await call(s, node, "POST", "/v1/relay/enrol", { host: node.host, pubkey: node.key.publicKey, owner_fp: ownerFp, sig });
  if (r.status !== 200) { node.store.audit("relay.enrol_failed", { relay: s.relay, status: r.status, error: String(r.json.error ?? "") }); return false; }
  const enc_pub = node.encKey.publicKey;
  const ad = await call(s, node, "POST", "/v1/relay/enc-key", { enc_pub, sig: signData(node.key.privateKey, canonical({ v: 1, host: node.host, enc_pub })) });
  if (ad.status !== 200) { node.store.audit("relay.enc_publish_failed", { relay: s.relay, status: ad.status }); return false; }
  node.store.set(flag, new Date().toISOString());
  return true;
}

/** T030 rotations the relay has not seen: the relay moves our name and queue to the new key (spec §2). */
async function announceRotationsToRelay(node: MbxNode, s: RelaySession) {
  const log = rotationLog(node.home), k = `relay-rotations:${s.relay}`, done = Number(kv(node, k) ?? 0);
  for (let i = done; i < log.records.length; i++) {
    const res = await s.f(`${base(s.relay)}/v2/relay/rotate`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ rotation: log.records[i] }), signal: AbortSignal.timeout(10_000) }).catch(() => null);
    if (!res) return;
    if (res.status !== 200 && res.status !== 404) { node.store.audit("relay.rotate_failed", { relay: s.relay, status: res.status }); return; }
    node.store.set(k, String(i + 1)); // 404: the old key was never enrolled there; the new key enrols normally
    if (res.status === 200) { // our queue was re-sequenced under the new key: read it again from the start
      node.store.db.prepare("UPDATE relay_position SET received_through=0, updated_at=? WHERE relay=?").run(new Date().toISOString(), s.relay);
      node.store.db.prepare("DELETE FROM kv WHERE k LIKE ?").run(`relay-acked:${s.relay}:%`);
    }
  }
}

/** Tell the relay which sender keys we accept: our approved peers (spec §2). Only fake keys are kept out; republished
 *  whenever the peer set changes. */
async function publishSenders(node: MbxNode, s: RelaySession) {
  const all = [...new Set(node.peers().filter((p) => p.state === "approved").map((p) => p.pubkey))].sort();
  if (all.length > 1024) node.store.audit("relay.senders_truncated", { relay: s.relay, peers: all.length, kept: 1024 });
  const senders = all.slice(0, 1024);
  const digest = createHash("sha256").update(`${node.key.publicKey}:${senders.join(",")}`).digest("hex"), k = `relay-senders:${s.relay}`;
  if (kv(node, k) === digest) return;
  const list = { v: 1, type: "relay-senders", host_pubkey: node.key.publicKey, senders, iat: new Date().toISOString() };
  const r = await call(s, node, "POST", "/v2/relay/senders", { list, sig: signData(node.key.privateKey, canonical(list)) });
  if (r.status === 200) node.store.set(k, digest);
  else node.store.audit("relay.senders_failed", { relay: s.relay, status: r.status, error: String(r.json.error ?? "") });
}

/** A peer's enc key: the pinned one, else the relay's copy only if the peer's pinned host key signed it (T032). */
async function peerEnc(node: MbxNode, s: RelaySession, host: string): Promise<string | null> {
  const p = node.approvedPeer(host);
  if (!p) return null;
  if (p.enc_pub) return p.enc_pub;
  const r = await call(s, node, "GET", `/v2/relay/enc-key?pubkey=${encodeURIComponent(p.pubkey)}`);
  const { enc_pub, sig } = r.json;
  if (r.status !== 200 || typeof enc_pub !== "string" || typeof sig !== "string") return null;
  if (verifyData(p.pubkey, canonical({ v: 1, host, enc_pub }), sig)) return enc_pub;
  node.store.audit("enc_key.rejected", { host, via: "relay", reason: "signature does not verify against the pinned host key" });
  return null;
}

/** An accept is ours only if the pinned relay key signed it, for this item, this target and exactly these bytes. */
function validAccept(s: RelaySession, node: MbxNode, r: PushResult | undefined, itemId: string, target: string, wireHash: string): AcceptStatement | null {
  if (!r || (r.status !== "accepted" && r.status !== "duplicate") || !r.accept || typeof r.sig !== "string") return null;
  const a = r.accept;
  if (a.type !== "relay-accept" || a.relay_pubkey !== s.info.relay_pubkey || a.sender_pubkey !== node.key.publicKey || a.item_id !== itemId) return null;
  const t = a.targets?.find((x) => x.host_pubkey === target);
  if (!t || t.wire_hash !== wireHash || !Number.isSafeInteger(t.seq)) return null;
  return verifyData(s.info.relay_pubkey, canonical(a), r.sig) ? a : null;
}

/**
 * Push outbox rows the LAN could not deliver (≥ RELAY_AFTER_ATTEMPTS failures, backoff due). Runs before the LAN pass,
 * so a due row tries the relay first and then the LAN, under one shared backoff.
 */
export async function relayPushOutbox(node: MbxNode, s: RelaySession, now = Date.now()): Promise<{ accepted: number; rejected: number }> {
  const rows = node.store.db.prepare(`SELECT o.msg_id, o.host, o.created_at, m.envelope FROM outbox o JOIN messages m ON m.id=o.msg_id
    WHERE o.attempts >= ? AND o.next_at <= ? ORDER BY o.created_at LIMIT ?`).all(RELAY_AFTER_ATTEMPTS, iso(now), s.info.limits.max_batch) as { msg_id: string; host: string; created_at: string; envelope: string }[];
  const batch: { row: typeof rows[number]; target: string; wire: Buffer; hash: string }[] = [];
  for (const row of rows) {
    const peer = node.approvedPeer(row.host);
    if (!peer) continue;
    let w = node.store.db.prepare("SELECT target_pubkey, wire, wire_hash FROM relay_wire WHERE msg_id=? AND host=? AND relay=?").get(row.msg_id, row.host, s.relay) as { target_pubkey: string; wire: Uint8Array; wire_hash: string } | undefined;
    if (w && w.target_pubkey !== peer.pubkey) { // the peer rotated its key: seal again for the new key
      node.store.db.prepare("DELETE FROM relay_wire WHERE msg_id=? AND host=? AND relay=?").run(row.msg_id, row.host, s.relay); w = undefined;
    }
    if (!w) {
      const enc = await peerEnc(node, s, row.host);
      if (!enc) continue; // never push a plaintext body (ADR-035)
      const wire = Buffer.from(JSON.stringify(sealEnvelope(JSON.parse(row.envelope) as Envelope, enc, node.host, node.key.publicKey, node.key.privateKey)));
      w = { target_pubkey: peer.pubkey, wire, wire_hash: sha256hex(wire) };
      node.store.db.prepare("INSERT INTO relay_wire (msg_id,host,relay,target_pubkey,wire,wire_hash,created_at) VALUES (?,?,?,?,?,?,?)")
        .run(row.msg_id, row.host, s.relay, w.target_pubkey, w.wire, w.wire_hash, iso(now));
    }
    batch.push({ row, target: w.target_pubkey, wire: Buffer.from(w.wire), hash: w.wire_hash });
  }
  if (!batch.length) return { accepted: 0, rejected: 0 };
  const r = await call(s, node, "POST", "/v2/relay/items", { items: batch.map((b) => ({ kind: "envelope", item_id: b.row.msg_id, targets: [{ host_pubkey: b.target, wire_b64: b.wire.toString("base64") }] })) });
  const results = Array.isArray(r.json.results) ? r.json.results as PushResult[] : [];
  if (r.status === 200 && results.length && results[0]!.accept?.epoch && results[0]!.accept.epoch !== kv(node, `relay-epoch:${s.relay}`))
    relayEpochChanged(node, s.relay, results[0]!.accept.epoch, "epoch");
  let accepted = 0, rejected = 0;
  for (const b of batch) {
    const res = results.find((x) => x?.item_id === b.row.msg_id);
    const a = r.status === 200 ? validAccept(s, node, res, b.row.msg_id, b.target, b.hash) : null;
    if (!a) {
      if (res?.status?.startsWith("rejected")) { rejected++; node.store.audit("relay.push_rejected", { relay: s.relay, msg: b.row.msg_id, host: b.row.host, status: res.status }); }
      continue; // the LAN pass applies the shared backoff; the row stays until a valid accept
    }
    const seq = a.targets.find((x) => x.host_pubkey === b.target)!.seq;
    const deadline = Date.parse(a.at) + s.info.limits.retention_days * 86_400_000 + RELAY_DEADLINE_GRACE_MS;
    node.store.tx(() => {
      node.store.db.prepare(`INSERT INTO relay_sent (msg_id,host,relay,target_pubkey,epoch,seq,accept,sig,queued_at,accepted_at,deadline_at,state)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,'relay-accepted') ON CONFLICT(msg_id,host) DO UPDATE SET relay=excluded.relay, target_pubkey=excluded.target_pubkey,
        epoch=excluded.epoch, seq=excluded.seq, accept=excluded.accept, sig=excluded.sig, accepted_at=excluded.accepted_at, deadline_at=excluded.deadline_at, state='relay-accepted', settled_at=NULL`)
        .run(b.row.msg_id, b.row.host, s.relay, b.target, a.epoch, seq, JSON.stringify(a), res!.sig!, b.row.created_at, a.at, iso(deadline));
      node.store.db.prepare("DELETE FROM outbox WHERE msg_id=? AND host=?").run(b.row.msg_id, b.row.host);
    });
    accepted++;
  }
  return { accepted, rejected };
}

/** Delivery receipts owed to hosts the LAN could not reach go over the relay as `receipt` items (spec §9). */
export async function relayPushReceipts(node: MbxNode, s: RelaySession, now = Date.now()): Promise<number> {
  const rows = node.store.db.prepare(`SELECT seq,msg_id,agent,host,state,note,at FROM receipt_outbox WHERE attempts >= ? AND next_at <= ? ORDER BY seq LIMIT ?`)
    .all(RELAY_AFTER_ATTEMPTS, iso(now), s.info.limits.max_batch) as { seq: number; msg_id: string; agent: string; host: string; state: string; note: string | null; at: string }[];
  const items: { seq: number; id: string; target: string; wire: Buffer }[] = [];
  for (const row of rows) {
    const peer = node.approvedPeer(row.host);
    if (!peer) continue;
    // signed once and kept: a re-signed receipt (e.g. a did recorded later) would be a conflict at the relay
    let w = node.store.db.prepare("SELECT item_id, wire FROM relay_receipt_wire WHERE seq=?").get(row.seq) as { item_id: string; wire: Uint8Array } | undefined;
    if (!w) {
      const signed = signReceipt(node, row);
      w = { item_id: `receipt:${signed.rec.msg}:${signed.rec.recipient}:${signed.rec.seq}`, wire: Buffer.from(canonical(signed)) };
      node.store.db.prepare("INSERT INTO relay_receipt_wire (seq,item_id,wire,created_at) VALUES (?,?,?,?)").run(row.seq, w.item_id, w.wire, iso(now));
    }
    items.push({ seq: row.seq, id: w.item_id, target: peer.pubkey, wire: Buffer.from(w.wire) });
  }
  if (!items.length) return 0;
  const r = await call(s, node, "POST", "/v2/relay/items", { items: items.map((i) => ({ kind: "receipt", item_id: i.id, targets: [{ host_pubkey: i.target, wire_b64: i.wire.toString("base64") }] })) });
  const results = Array.isArray(r.json.results) ? r.json.results as PushResult[] : [];
  const sent = r.status === 200 ? items.filter((i) => validAccept(s, node, results.find((x) => x?.item_id === i.id), i.id, i.target, sha256hex(i.wire))) : [];
  if (sent.length) receiptsSent(node, sent.map((i) => i.seq)); // also drops their kept bytes
  return sent.length;
}

/**
 * The relay went back in time (a new epoch, a queue head below our checkpoint, or BAD_ACK): unsettled relay-accepted
 * rows go back to the outbox to be re-pushed (their persisted bytes make them duplicates if the relay still has them),
 * and our receive position restarts at 0 (receive() and acceptReceipt() dedup what we already have). Each row stays in
 * relay_sent as `repush` with its relay deadline (T167), so the LAN's 72 h give-up never drops mail the relay accepted
 * (the target may need days to come back and re-enrol); the deadline, a delivery receipt or an expiry notice ends it.
 */
export function relayEpochChanged(node: MbxNode, relay: string, epoch: string, why: "epoch" | "rewind") {
  const now = new Date().toISOString();
  node.store.tx(() => {
    const rows = node.store.db.prepare("SELECT msg_id, host, queued_at FROM relay_sent WHERE relay=? AND state IN ('relay-accepted','repush')").all(relay) as { msg_id: string; host: string; queued_at: string }[];
    for (const r of rows) node.store.db.prepare(`INSERT INTO outbox (msg_id,host,attempts,next_at,last_error,created_at) VALUES (?,?,?,?,?,?)
      ON CONFLICT(msg_id,host) DO NOTHING`).run(r.msg_id, r.host, RELAY_AFTER_ATTEMPTS, now, `relay ${why}: re-push`, r.queued_at);
    node.store.db.prepare("UPDATE relay_sent SET state='repush' WHERE relay=? AND state='relay-accepted'").run(relay);
    node.store.db.prepare(`INSERT INTO relay_position (relay,epoch,received_through,updated_at) VALUES (?,?,0,?)
      ON CONFLICT(relay) DO UPDATE SET epoch=excluded.epoch, received_through=0, updated_at=excluded.updated_at`).run(relay, epoch, now);
    node.store.set(`relay-epoch:${relay}`, epoch);
    node.store.db.prepare("DELETE FROM kv WHERE k LIKE ?").run(`relay-acked:${relay}:%`);
    node.store.audit("relay.epoch_changed", { relay, epoch, why, repush: rows.length });
  });
}

function position(node: MbxNode, s: RelaySession): { epoch: string; through: number } {
  const p = node.store.db.prepare("SELECT epoch, received_through FROM relay_position WHERE relay=?").get(s.relay) as { epoch: string; received_through: number } | undefined;
  return p ? { epoch: p.epoch, through: Number(p.received_through) } : { epoch: s.info.epoch, through: 0 };
}
function setPosition(node: MbxNode, relay: string, epoch: string, through: number) {
  node.store.db.prepare(`INSERT INTO relay_position (relay,epoch,received_through,updated_at) VALUES (?,?,?,?)
    ON CONFLICT(relay) DO UPDATE SET epoch=excluded.epoch, received_through=excluded.received_through, updated_at=excluded.updated_at`).run(relay, epoch, through, new Date().toISOString());
}

/** The host an envelope says it comes from: the host receive() checks the pairing of. */
const envelopeHost = (e: Envelope | null) => typeof e?.from === "string" ? e.from.split("@")[1] ?? "" : "";

/**
 * A relay duplicate means its sender pushed it again, so it is still waiting for our delivery receipt: after a relay
 * restore, the receipt the relay accepted after its backup is gone with it (T167). Queue the current state of each local
 * delivery of that message again (as the deliveries triggers would), unless one is already queued, so the sender settles
 * instead of alerting at its deadline. A receipt older than the receipt window still expires (receipts are advisory).
 */
function resendReceipts(node: MbxNode, msgId: string) {
  node.store.db.prepare(`INSERT INTO receipt_outbox (msg_id,agent,host,state,note,at,next_at)
    SELECT d.msg_id, d.agent, substr(m.from_addr, instr(m.from_addr,'@')+1), d.state, d.note, d.updated_at, ?
    FROM deliveries d JOIN messages m ON m.id=d.msg_id WHERE d.msg_id=? AND m.origin<>'local' AND instr(m.from_addr,'@')>0
      AND d.state IN ${DELIVERED} AND NOT EXISTS (SELECT 1 FROM receipt_outbox r WHERE r.msg_id=d.msg_id AND r.agent=d.agent)`).run(iso(Date.now()), msgId);
}

/** Process one relay item. True when it is done (accepted, duplicate or quarantined). */
function processItem(node: MbxNode, relay: string, epoch: string, it: { seq: number; kind: string; item_id: string; sender_pubkey: string; wire_b64: string }): string {
  const wire = Buffer.from(it.wire_b64, "base64");
  let result: string;
  try {
    const v = JSON.parse(wire.toString("utf8")) as unknown;
    if (it.kind === "envelope") {
      const e = v as Envelope;
      result = node.receive(e, envelopeHost(e));
      if (result === "duplicate") resendReceipts(node, e.id);
    } else if (it.kind === "receipt") result = acceptReceipt(node, v, null);
    else if (it.kind === "expired") result = applyExpiryNotice(node, relay, v, it.sender_pubkey);
    else result = "rejected:unknown item kind";
  } catch { result = "rejected:unreadable item"; }
  if (result.startsWith("rejected")) {
    node.store.db.prepare(`INSERT INTO relay_quarantine (relay,epoch,seq,kind,item_id,sender_pubkey,reason,wire,at) VALUES (?,?,?,?,?,?,?,?,?)
      ON CONFLICT(relay,epoch,seq) DO NOTHING`).run(relay, epoch, it.seq, String(it.kind).slice(0, 20), String(it.item_id).slice(0, 300), String(it.sender_pubkey).slice(0, 64), result.slice(0, 300), wire, new Date().toISOString());
    node.store.audit("relay.quarantined", { relay, seq: it.seq, item: String(it.item_id).slice(0, 80), reason: result.slice(0, 200) });
  }
  return result;
}

const DELIVERED = "('delivered','notified','read','acked')";
/** The target host already reported this message delivered (a receipt over the LAN or the relay). */
const confirmed = (node: MbxNode, msg: string, host: string) => !!node.store.db.prepare(`SELECT 1 FROM remote_receipts WHERE msg_id=?
  AND substr(recipient, instr(recipient,'@')+1)=? AND state IN ${DELIVERED} LIMIT 1`).get(msg, host);

/**
 * A relay expiry notice (§6, T167): the relay dropped an envelope we pushed because its target never collected it within
 * retention. Only the pinned relay key's signature counts, and only for the row with that message and that target key
 * (a row re-sealed for a rotated key is not the one that expired). The row ends `expired` with the alert the LAN outbox
 * sends after 72 h, and leaves the outbox if a re-push was pending. If the target already confirmed delivery (its pull
 * raced the sweep), the row settles instead and nobody is alarmed. A row already final makes the notice a duplicate.
 */
export function applyExpiryNotice(node: MbxNode, relay: string, v: unknown, from: string, now = Date.now()): string {
  const pinned = kv(node, `relay-key:${relay}`);
  const { notice, sig } = (v ?? {}) as { notice?: { v?: unknown; type?: unknown; item_id?: unknown; target_pubkey?: unknown; accepted_at?: unknown; expired_at?: unknown }; sig?: unknown };
  if (!pinned || from !== pinned || !notice || notice.v !== 1 || notice.type !== "relay-expired" || typeof sig !== "string" || typeof notice.item_id !== "string"
    || typeof notice.target_pubkey !== "string" || typeof notice.accepted_at !== "string" || typeof notice.expired_at !== "string"
    || !verifyData(pinned, canonical(notice), sig)) return "rejected:bad expiry notice";
  const row = node.store.db.prepare(`SELECT s.msg_id, s.host, s.state, m.envelope FROM relay_sent s LEFT JOIN messages m ON m.id=s.msg_id
    WHERE s.msg_id=? AND s.relay=? AND s.target_pubkey=?`).get(notice.item_id, relay, notice.target_pubkey) as { msg_id: string; host: string; state: string; envelope: string | null } | undefined;
  if (!row || (row.state !== "relay-accepted" && row.state !== "repush")) return "duplicate"; // settled, expired or unconfirmed already
  const at = iso(now), days = Math.max(1, Math.round((Date.parse(notice.expired_at) - Date.parse(notice.accepted_at)) / 86_400_000));
  node.store.tx(() => {
    node.store.db.prepare("DELETE FROM outbox WHERE msg_id=? AND host=?").run(row.msg_id, row.host); // a pending re-push is moot either way
    node.store.db.prepare("DELETE FROM relay_wire WHERE msg_id=? AND host=?").run(row.msg_id, row.host);
    if (confirmed(node, row.msg_id, row.host)) {
      node.store.db.prepare("UPDATE relay_sent SET state='settled', settled_at=? WHERE msg_id=? AND host=?").run(at, row.msg_id, row.host);
      return;
    }
    node.store.db.prepare("UPDATE relay_sent SET state='expired', settled_at=? WHERE msg_id=? AND host=?").run(at, row.msg_id, row.host);
    node.store.audit("relay.expired", { relay, msg: row.msg_id, host: row.host, accepted_at: notice.accepted_at, expired_at: notice.expired_at });
    if (!row.envelope) return;
    const e = JSON.parse(row.envelope) as Envelope;
    node.send({ from: "mbx", to: [e.from.split("@")[0]!], kind: "alert", subject: `Undelivered to ${row.host}: ${e.subject}`,
      body: `Message ${e.id} could not be delivered to host ${row.host}: the relay held it for ${days} day(s) (accepted ${notice.accepted_at}) and ${row.host} never collected it, so the relay expired it at ${notice.expired_at}.` });
  });
  return "accepted";
}

/**
 * Items quarantined only because their sender was not paired yet get another chance once it is: once the host the
 * envelope names is paired with the key that pushed it (T333). The sender key being paired is not enough. receive()
 * checks the envelope's host, so a key paired under another host name (the published allowlist lets it push, but the
 * envelope names a host we never paired) failed again and was re-quarantined, and audited, on every tick. Now a retried
 * item either lands or fails for another reason, and is never retried again.
 */
function retryUnpairedQuarantine(node: MbxNode, relay: string): number {
  const keys = node.peers().filter((p) => p.state === "approved").map((p) => p.pubkey);
  if (!keys.length) return 0;
  let n = 0, tried = 0;
  const rows = node.store.db.prepare(`SELECT epoch, seq, kind, item_id, sender_pubkey, wire FROM relay_quarantine WHERE relay=? AND reason='rejected:host not paired'
    AND sender_pubkey IN (SELECT value FROM json_each(?)) ORDER BY at, seq`).all(relay, JSON.stringify(keys)) as { epoch: string; seq: number; kind: string; item_id: string; sender_pubkey: string; wire: Uint8Array }[];
  for (const r of rows) {
    if (tried >= 100) break;
    let host = "";
    try { host = envelopeHost(JSON.parse(Buffer.from(r.wire).toString("utf8")) as Envelope); } catch { continue; }
    if (node.approvedPeer(host)?.pubkey !== r.sender_pubkey) continue; // the key receive() verifies the envelope with
    tried++;
    node.store.db.prepare("DELETE FROM relay_quarantine WHERE relay=? AND epoch=? AND seq=?").run(relay, r.epoch, r.seq);
    const res = processItem(node, relay, r.epoch, { seq: r.seq, kind: r.kind, item_id: r.item_id, sender_pubkey: r.sender_pubkey, wire_b64: Buffer.from(r.wire).toString("base64") });
    if (res === "accepted") n++;
  }
  return n;
}

/** Pull, process in seq order, checkpoint, then ack (spec §4). Returns how many items were accepted. */
export async function relayReceive(node: MbxNode, s: RelaySession): Promise<number> {
  let accepted = retryUnpairedQuarantine(node, s.relay);
  for (let page = 0; page < PAGES_PER_TICK; page++) {
    const pos = position(node, s);
    const r = await call(s, node, "GET", `/v2/relay/items?after=${pos.through}&limit=${s.info.limits.max_pull}&epoch=${encodeURIComponent(pos.epoch)}`);
    if (r.status === 409 && typeof r.json.epoch === "string") { relayEpochChanged(node, s.relay, r.json.epoch, "epoch"); continue; }
    if (r.status !== 200) return accepted;
    const body = r.json as { epoch: string; head_seq: number; items: { seq: number; kind: string; item_id: string; sender_pubkey: string; wire_b64: string }[]; last_seq: number; more: boolean };
    if (body.epoch !== pos.epoch) { relayEpochChanged(node, s.relay, body.epoch, "epoch"); continue; }
    if (typeof body.head_seq === "number" && body.head_seq < pos.through) { relayEpochChanged(node, s.relay, body.epoch, "rewind"); continue; }
    let through = pos.through;
    for (const it of [...(body.items ?? [])].sort((a, b) => a.seq - b.seq)) {
      if (it.seq <= through) continue;
      const res = processItem(node, s.relay, body.epoch, it);
      if (res === "accepted") accepted++;
      through = it.seq;
      setPosition(node, s.relay, body.epoch, through); // receive() and acceptReceipt() are idempotent, so a crash here re-pulls harmlessly
    }
    const ackedKey = `relay-acked:${s.relay}:${body.epoch}`;
    if (through > Number(kv(node, ackedKey) ?? 0)) { // also re-sends an ack an earlier pass lost
      const ack = await call(s, node, "POST", "/v2/relay/ack", { epoch: body.epoch, through });
      if (ack.status === 200) node.store.set(ackedKey, String(through));
      else if (ack.status === 409 && typeof ack.json.epoch === "string") { relayEpochChanged(node, s.relay, ack.json.epoch, "epoch"); continue; }
      else if (ack.status === 400 && ack.json.code === "BAD_ACK") { relayEpochChanged(node, s.relay, body.epoch, "rewind"); continue; }
      // any other ack failure: the next pass acks again; the relay simply still holds those items
    }
    if (!body.more) break;
  }
  return accepted;
}

/**
 * Settle relay-accepted rows whose target reported delivery (T218), and enforce the sender-side deadline: a row the
 * target never confirmed by accepted_at + retention + grace alerts its sender, without waiting on the relay (§3).
 */
export function relaySettle(node: MbxNode, now = Date.now()): { settled: number; unconfirmed: number } {
  // a repush row the target confirmed needs no re-push: it leaves the outbox with it
  const settled = node.store.tx(() => {
    node.store.db.prepare(`DELETE FROM outbox WHERE (msg_id, host) IN (SELECT msg_id, host FROM relay_sent s WHERE s.state='repush' AND EXISTS (
      SELECT 1 FROM remote_receipts r WHERE r.msg_id=s.msg_id AND substr(r.recipient, instr(r.recipient,'@')+1)=s.host AND r.state IN ${DELIVERED}))`).run();
    return Number(node.store.db.prepare(`UPDATE relay_sent SET state='settled', settled_at=? WHERE state IN ('relay-accepted','repush') AND EXISTS (
      SELECT 1 FROM remote_receipts r WHERE r.msg_id=relay_sent.msg_id AND substr(r.recipient, instr(r.recipient,'@')+1)=relay_sent.host
        AND r.state IN ${DELIVERED})`).run(iso(now)).changes);
  });
  if (settled) node.store.db.prepare("DELETE FROM relay_wire WHERE (msg_id, host) IN (SELECT msg_id, host FROM relay_sent WHERE state='settled')").run();
  const late = node.store.db.prepare(`SELECT s.msg_id, s.host, m.envelope FROM relay_sent s LEFT JOIN messages m ON m.id=s.msg_id
    WHERE s.state IN ('relay-accepted','repush') AND s.deadline_at <= ?`).all(iso(now)) as { msg_id: string; host: string; envelope: string | null }[];
  for (const r of late) {
    const everConfirmed = node.store.db.prepare("SELECT 1 FROM remote_receipts WHERE substr(recipient, instr(recipient,'@')+1)=? LIMIT 1").get(r.host);
    const why = everConfirmed ? "the relay accepted it, but the recipient's host never confirmed delivery"
      : "the relay accepted it, but there is no delivery confirmation (the recipient's host may run AgentMBX older than 0.5.3, which sends none)";
    node.store.tx(() => {
      node.store.db.prepare("UPDATE relay_sent SET state='unconfirmed', settled_at=? WHERE msg_id=? AND host=?").run(iso(now), r.msg_id, r.host);
      node.store.db.prepare("DELETE FROM relay_wire WHERE msg_id=? AND host=?").run(r.msg_id, r.host);
      node.store.db.prepare("DELETE FROM outbox WHERE msg_id=? AND host=?").run(r.msg_id, r.host); // a re-push still pending ends here too
      if (!r.envelope) return void node.store.audit("relay.unconfirmed", { msg: r.msg_id, host: r.host, why: "message no longer stored" });
      const e = JSON.parse(r.envelope) as Envelope;
      node.send({ from: "mbx", to: [e.from.split("@")[0]!], kind: "alert", subject: `Undelivered/unconfirmed to ${r.host}: ${e.subject}`,
        body: `Message ${e.id} to host ${r.host}: ${why}.` });
    });
  }
  return { settled, unconfirmed: late.length };
}
