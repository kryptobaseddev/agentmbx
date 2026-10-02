// Durable relay client (T166, docs/spec/relay-durability.md §3, §4, §5, §9, §10). A row goes to the relay only after it
// failed twice on the LAN and its backoff is due; its sealed bytes are persisted before the first push and reused on
// every retry; it leaves the outbox only on a valid accept signed by the pinned relay key, then waits in relay_sent for
// the target's delivery receipt or the sender-side deadline. The receiving side processes items in seq order, keeps
// what it cannot accept in quarantine, checkpoints, and only then acks. An epoch change (a restore) or a queue head
// below the checkpoint makes senders re-push and receivers re-pull; dedup on both ends makes that safe.
import { canonical, fingerprint, signData, verifyData } from "./crypto.js";
import { sealEnvelope } from "./envelope.js";
import { rotationLog } from "./key-rotation.js";
import { acceptReceipt, receiptsSent, signReceipt } from "./remote-receipts.js";
import { createHash } from "node:crypto";
/** A LAN row moves to the relay after this many failed LAN attempts (spec §10). */
export const RELAY_AFTER_ATTEMPTS = 2;
/** Sender-side grace after the relay's retention before an unconfirmed relay delivery is reported (spec §3). */
export const RELAY_DEADLINE_GRACE_MS = 24 * 3_600_000;
const PAGES_PER_TICK = 20;
const base = (relay) => relay.replace(/\/$/, "");
const sha256hex = (b) => createHash("sha256").update(b).digest("hex");
const kv = (node, k) => node.store.get(k);
const iso = (ms) => new Date(ms).toISOString();
/** A signed v2 hop: method, path with its query, timestamp and body; the host key header lets the relay find us by key. */
function hop(node, method, pathAndQuery, body) {
    const ts = String(Date.now());
    return { "content-type": "application/json", "x-mbx-host": node.host, "x-mbx-key": node.key.publicKey, "x-mbx-ts": ts,
        "x-mbx-sig": signData(node.key.privateKey, canonical({ method, path: pathAndQuery, ts, body: `${method}:${pathAndQuery}:${ts}:${body}` })) };
}
async function call(s, node, method, pathAndQuery, obj) {
    const body = obj === undefined ? "" : JSON.stringify(obj);
    const res = await s.f(base(s.relay) + pathAndQuery, { method, headers: hop(node, method, pathAndQuery, body), body: body || undefined, signal: AbortSignal.timeout(15_000) }).catch(() => null);
    if (!res)
        return { status: 0, json: { error: "relay unreachable" } };
    if (res.status === 401)
        node.store.db.prepare("DELETE FROM kv WHERE k LIKE ?").run(`relay-enrolled-v2:${s.relay}:%`); // re-enrol next pass (G6)
    return { status: res.status, json: await res.json().catch(() => ({})) };
}
/** GET /v2/relay/info; null for a v1-only relay (or none at all). */
export async function relayInfo(relay, f = fetch) {
    const res = await f(`${base(relay)}/v2/relay/info`, { signal: AbortSignal.timeout(10_000) }).catch(() => null);
    if (!res || res.status !== 200)
        return null;
    const j = await res.json().catch(() => null);
    return j && j.v === 2 && typeof j.relay_pubkey === "string" && typeof j.epoch === "string" && j.limits ? j : null;
}
/**
 * Open a v2 session for this tick: pin the relay key (trust on first use until `relay set --key`, T168; a changed key
 * stops relay use), notice an epoch change, make sure this host is enrolled with its enc key published, and hand the
 * relay any key rotation it has not seen. Null: use v1 (or nothing) this tick.
 */
export async function relayOpen(node, relay, f = fetch) {
    const info = await relayInfo(relay, f);
    if (!info)
        return null;
    const pinned = kv(node, `relay-key:${relay}`);
    if (!pinned)
        node.store.set(`relay-key:${relay}`, info.relay_pubkey);
    else if (pinned !== info.relay_pubkey) {
        node.store.audit("relay.key_changed", { relay, pinned: fingerprint(pinned), served: fingerprint(info.relay_pubkey) });
        return null; // never trust accepts from another key; the owner confirms the new key (agentmbx relay set --key, T168)
    }
    const s = { relay, info, f };
    const known = kv(node, `relay-epoch:${relay}`);
    if (known !== info.epoch) {
        if (known)
            relayEpochChanged(node, relay, info.epoch, "epoch");
        else
            node.store.set(`relay-epoch:${relay}`, info.epoch);
    }
    await announceRotationsToRelay(node, s);
    if (!await ensureEnrolled(node, s))
        return null;
    return s;
}
async function ensureEnrolled(node, s) {
    const flag = `relay-enrolled-v2:${s.relay}:${node.key.publicKey}:${s.info.relay_pubkey}:${s.info.epoch}`;
    if (kv(node, flag))
        return true;
    const ownerFp = node.store.db.prepare("SELECT fp FROM principals WHERE role='owner' AND via='local' LIMIT 1").get()?.fp ?? "";
    const chal = await call(s, node, "POST", "/v1/relay/challenge", { host: node.host, pubkey: node.key.publicKey });
    const challenge = chal.json.challenge;
    if (typeof challenge !== "string") {
        node.store.audit("relay.enrol_failed", { relay: s.relay, status: chal.status, error: String(chal.json.error ?? "") });
        return false;
    }
    const sig = signData(node.key.privateKey, canonical({ v: 1, challenge, host: node.host, pubkey: node.key.publicKey, owner_fp: ownerFp }));
    const r = await call(s, node, "POST", "/v1/relay/enrol", { host: node.host, pubkey: node.key.publicKey, owner_fp: ownerFp, sig });
    if (r.status !== 200) {
        node.store.audit("relay.enrol_failed", { relay: s.relay, status: r.status, error: String(r.json.error ?? "") });
        return false;
    }
    const enc_pub = node.encKey.publicKey;
    const ad = await call(s, node, "POST", "/v1/relay/enc-key", { enc_pub, sig: signData(node.key.privateKey, canonical({ v: 1, host: node.host, enc_pub })) });
    if (ad.status !== 200) {
        node.store.audit("relay.enc_publish_failed", { relay: s.relay, status: ad.status });
        return false;
    }
    node.store.set(flag, new Date().toISOString());
    return true;
}
/** T030 rotations the relay has not seen: the relay moves our name and queue to the new key (spec §2). */
async function announceRotationsToRelay(node, s) {
    const log = rotationLog(node.home), k = `relay-rotations:${s.relay}`, done = Number(kv(node, k) ?? 0);
    for (let i = done; i < log.records.length; i++) {
        const res = await s.f(`${base(s.relay)}/v2/relay/rotate`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ rotation: log.records[i] }), signal: AbortSignal.timeout(10_000) }).catch(() => null);
        if (!res)
            return;
        if (res.status !== 200 && res.status !== 404) {
            node.store.audit("relay.rotate_failed", { relay: s.relay, status: res.status });
            return;
        }
        node.store.set(k, String(i + 1)); // 404: the old key was never enrolled there; the new key enrols normally
    }
}
/** A peer's enc key: the pinned one, else the relay's copy only if the peer's pinned host key signed it (T032). */
async function peerEnc(node, s, host) {
    const p = node.approvedPeer(host);
    if (!p)
        return null;
    if (p.enc_pub)
        return p.enc_pub;
    const r = await call(s, node, "GET", `/v2/relay/enc-key?pubkey=${encodeURIComponent(p.pubkey)}`);
    const { enc_pub, sig } = r.json;
    if (r.status !== 200 || typeof enc_pub !== "string" || typeof sig !== "string")
        return null;
    if (verifyData(p.pubkey, canonical({ v: 1, host, enc_pub }), sig))
        return enc_pub;
    node.store.audit("enc_key.rejected", { host, via: "relay", reason: "signature does not verify against the pinned host key" });
    return null;
}
/** An accept is ours only if the pinned relay key signed it, for this item, this target and exactly these bytes. */
function validAccept(s, node, r, itemId, target, wireHash) {
    if (!r || (r.status !== "accepted" && r.status !== "duplicate") || !r.accept || typeof r.sig !== "string")
        return null;
    const a = r.accept;
    if (a.type !== "relay-accept" || a.relay_pubkey !== s.info.relay_pubkey || a.sender_pubkey !== node.key.publicKey || a.item_id !== itemId)
        return null;
    const t = a.targets?.find((x) => x.host_pubkey === target);
    if (!t || t.wire_hash !== wireHash || !Number.isSafeInteger(t.seq))
        return null;
    return verifyData(s.info.relay_pubkey, canonical(a), r.sig) ? a : null;
}
/**
 * Push outbox rows the LAN could not deliver (≥ RELAY_AFTER_ATTEMPTS failures, backoff due). Runs before the LAN pass,
 * so a due row tries the relay first and then the LAN, under one shared backoff.
 */
export async function relayPushOutbox(node, s, now = Date.now()) {
    const rows = node.store.db.prepare(`SELECT o.msg_id, o.host, o.created_at, m.envelope FROM outbox o JOIN messages m ON m.id=o.msg_id
    WHERE o.attempts >= ? AND o.next_at <= ? ORDER BY o.created_at LIMIT ?`).all(RELAY_AFTER_ATTEMPTS, iso(now), s.info.limits.max_batch);
    const batch = [];
    for (const row of rows) {
        const peer = node.approvedPeer(row.host);
        if (!peer)
            continue;
        let w = node.store.db.prepare("SELECT target_pubkey, wire, wire_hash FROM relay_wire WHERE msg_id=? AND host=? AND relay=?").get(row.msg_id, row.host, s.relay);
        if (w && w.target_pubkey !== peer.pubkey) { // the peer rotated its key: seal again for the new key
            node.store.db.prepare("DELETE FROM relay_wire WHERE msg_id=? AND host=? AND relay=?").run(row.msg_id, row.host, s.relay);
            w = undefined;
        }
        if (!w) {
            const enc = await peerEnc(node, s, row.host);
            if (!enc)
                continue; // never push a plaintext body (ADR-035)
            const wire = Buffer.from(JSON.stringify(sealEnvelope(JSON.parse(row.envelope), enc, node.host, node.key.publicKey, node.key.privateKey)));
            w = { target_pubkey: peer.pubkey, wire, wire_hash: sha256hex(wire) };
            node.store.db.prepare("INSERT INTO relay_wire (msg_id,host,relay,target_pubkey,wire,wire_hash,created_at) VALUES (?,?,?,?,?,?,?)")
                .run(row.msg_id, row.host, s.relay, w.target_pubkey, w.wire, w.wire_hash, iso(now));
        }
        batch.push({ row, target: w.target_pubkey, wire: Buffer.from(w.wire), hash: w.wire_hash });
    }
    if (!batch.length)
        return { accepted: 0, rejected: 0 };
    const r = await call(s, node, "POST", "/v2/relay/items", { items: batch.map((b) => ({ kind: "envelope", item_id: b.row.msg_id, targets: [{ host_pubkey: b.target, wire_b64: b.wire.toString("base64") }] })) });
    const results = Array.isArray(r.json.results) ? r.json.results : [];
    if (r.status === 200 && results.length && results[0].accept?.epoch && results[0].accept.epoch !== kv(node, `relay-epoch:${s.relay}`))
        relayEpochChanged(node, s.relay, results[0].accept.epoch, "epoch");
    let accepted = 0, rejected = 0;
    for (const b of batch) {
        const res = results.find((x) => x?.item_id === b.row.msg_id);
        const a = r.status === 200 ? validAccept(s, node, res, b.row.msg_id, b.target, b.hash) : null;
        if (!a) {
            if (res?.status?.startsWith("rejected")) {
                rejected++;
                node.store.audit("relay.push_rejected", { relay: s.relay, msg: b.row.msg_id, host: b.row.host, status: res.status });
            }
            continue; // the LAN pass applies the shared backoff; the row stays until a valid accept
        }
        const seq = a.targets.find((x) => x.host_pubkey === b.target).seq;
        const deadline = Date.parse(a.at) + s.info.limits.retention_days * 86_400_000 + RELAY_DEADLINE_GRACE_MS;
        node.store.tx(() => {
            node.store.db.prepare(`INSERT INTO relay_sent (msg_id,host,relay,target_pubkey,epoch,seq,accept,sig,queued_at,accepted_at,deadline_at,state)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,'relay-accepted') ON CONFLICT(msg_id,host) DO UPDATE SET relay=excluded.relay, target_pubkey=excluded.target_pubkey,
        epoch=excluded.epoch, seq=excluded.seq, accept=excluded.accept, sig=excluded.sig, accepted_at=excluded.accepted_at, deadline_at=excluded.deadline_at, state='relay-accepted', settled_at=NULL`)
                .run(b.row.msg_id, b.row.host, s.relay, b.target, a.epoch, seq, JSON.stringify(a), res.sig, b.row.created_at, a.at, iso(deadline));
            node.store.db.prepare("DELETE FROM outbox WHERE msg_id=? AND host=?").run(b.row.msg_id, b.row.host);
        });
        accepted++;
    }
    return { accepted, rejected };
}
/** Delivery receipts owed to hosts the LAN could not reach go over the relay as `receipt` items (spec §9). */
export async function relayPushReceipts(node, s, now = Date.now()) {
    const rows = node.store.db.prepare(`SELECT seq,msg_id,agent,host,state,note,at FROM receipt_outbox WHERE attempts >= ? AND next_at <= ? ORDER BY seq LIMIT ?`)
        .all(RELAY_AFTER_ATTEMPTS, iso(now), s.info.limits.max_batch);
    const items = [];
    for (const row of rows) {
        const peer = node.approvedPeer(row.host);
        if (!peer)
            continue;
        const signed = signReceipt(node, row);
        items.push({ seq: row.seq, id: `receipt:${signed.rec.msg}:${signed.rec.recipient}:${signed.rec.seq}`, target: peer.pubkey, wire: Buffer.from(canonical(signed)) });
    }
    if (!items.length)
        return 0;
    const r = await call(s, node, "POST", "/v2/relay/items", { items: items.map((i) => ({ kind: "receipt", item_id: i.id, targets: [{ host_pubkey: i.target, wire_b64: i.wire.toString("base64") }] })) });
    const results = Array.isArray(r.json.results) ? r.json.results : [];
    const sent = r.status === 200 ? items.filter((i) => validAccept(s, node, results.find((x) => x?.item_id === i.id), i.id, i.target, sha256hex(i.wire))) : [];
    if (sent.length)
        receiptsSent(node, sent.map((i) => i.seq));
    return sent.length;
}
/**
 * The relay went back in time (a new epoch, a queue head below our checkpoint, or BAD_ACK): unsettled relay-accepted
 * rows go back to the outbox to be re-pushed (their persisted bytes make them duplicates if the relay still has them),
 * and our receive position restarts at 0 (receive() and acceptReceipt() dedup what we already have).
 */
export function relayEpochChanged(node, relay, epoch, why) {
    const now = new Date().toISOString();
    node.store.tx(() => {
        const rows = node.store.db.prepare("SELECT msg_id, host, queued_at FROM relay_sent WHERE relay=? AND state='relay-accepted'").all(relay);
        for (const r of rows)
            node.store.db.prepare(`INSERT INTO outbox (msg_id,host,attempts,next_at,last_error,created_at) VALUES (?,?,?,?,?,?)
      ON CONFLICT(msg_id,host) DO NOTHING`).run(r.msg_id, r.host, RELAY_AFTER_ATTEMPTS, now, `relay ${why}: re-push`, r.queued_at);
        node.store.db.prepare("DELETE FROM relay_sent WHERE relay=? AND state='relay-accepted'").run(relay);
        node.store.db.prepare(`INSERT INTO relay_position (relay,epoch,received_through,updated_at) VALUES (?,?,0,?)
      ON CONFLICT(relay) DO UPDATE SET epoch=excluded.epoch, received_through=0, updated_at=excluded.updated_at`).run(relay, epoch, now);
        node.store.set(`relay-epoch:${relay}`, epoch);
        node.store.db.prepare("DELETE FROM kv WHERE k LIKE ?").run(`relay-acked:${relay}:%`);
        node.store.audit("relay.epoch_changed", { relay, epoch, why, repush: rows.length });
    });
}
function position(node, s) {
    const p = node.store.db.prepare("SELECT epoch, received_through FROM relay_position WHERE relay=?").get(s.relay);
    return p ? { epoch: p.epoch, through: Number(p.received_through) } : { epoch: s.info.epoch, through: 0 };
}
function setPosition(node, relay, epoch, through) {
    node.store.db.prepare(`INSERT INTO relay_position (relay,epoch,received_through,updated_at) VALUES (?,?,?,?)
    ON CONFLICT(relay) DO UPDATE SET epoch=excluded.epoch, received_through=excluded.received_through, updated_at=excluded.updated_at`).run(relay, epoch, through, new Date().toISOString());
}
/** Process one relay item. True when it is done (accepted, duplicate or quarantined). */
function processItem(node, relay, epoch, it) {
    const wire = Buffer.from(it.wire_b64, "base64");
    let result;
    try {
        const v = JSON.parse(wire.toString("utf8"));
        if (it.kind === "envelope") {
            const e = v, host = typeof e?.from === "string" ? e.from.split("@")[1] ?? "" : "";
            result = node.receive(e, host);
        }
        else if (it.kind === "receipt")
            result = acceptReceipt(node, v, null);
        else if (it.kind === "expired")
            result = "accepted"; // relay expiry notices (§6) are handled by T167; the deadline covers them meanwhile
        else
            result = "rejected:unknown item kind";
    }
    catch {
        result = "rejected:unreadable item";
    }
    if (result.startsWith("rejected")) {
        node.store.db.prepare(`INSERT INTO relay_quarantine (relay,epoch,seq,kind,item_id,sender_pubkey,reason,wire,at) VALUES (?,?,?,?,?,?,?,?,?)
      ON CONFLICT(relay,epoch,seq) DO NOTHING`).run(relay, epoch, it.seq, String(it.kind).slice(0, 20), String(it.item_id).slice(0, 300), String(it.sender_pubkey).slice(0, 64), result.slice(0, 300), wire, new Date().toISOString());
        node.store.audit("relay.quarantined", { relay, seq: it.seq, item: String(it.item_id).slice(0, 80), reason: result.slice(0, 200) });
    }
    return result;
}
/** Pull, process in seq order, checkpoint, then ack (spec §4). Returns how many items were accepted. */
export async function relayReceive(node, s) {
    let accepted = 0;
    for (let page = 0; page < PAGES_PER_TICK; page++) {
        const pos = position(node, s);
        const r = await call(s, node, "GET", `/v2/relay/items?after=${pos.through}&limit=${s.info.limits.max_pull}&epoch=${encodeURIComponent(pos.epoch)}`);
        if (r.status === 409 && typeof r.json.epoch === "string") {
            relayEpochChanged(node, s.relay, r.json.epoch, "epoch");
            continue;
        }
        if (r.status !== 200)
            return accepted;
        const body = r.json;
        if (body.epoch !== pos.epoch) {
            relayEpochChanged(node, s.relay, body.epoch, "epoch");
            continue;
        }
        if (typeof body.head_seq === "number" && body.head_seq < pos.through) {
            relayEpochChanged(node, s.relay, body.epoch, "rewind");
            continue;
        }
        let through = pos.through;
        for (const it of [...(body.items ?? [])].sort((a, b) => a.seq - b.seq)) {
            if (it.seq <= through)
                continue;
            const res = processItem(node, s.relay, body.epoch, it);
            if (res === "accepted")
                accepted++;
            through = it.seq;
            setPosition(node, s.relay, body.epoch, through); // receive() and acceptReceipt() are idempotent, so a crash here re-pulls harmlessly
        }
        const ackedKey = `relay-acked:${s.relay}:${body.epoch}`;
        if (through > Number(kv(node, ackedKey) ?? 0)) { // also re-sends an ack an earlier pass lost
            const ack = await call(s, node, "POST", "/v2/relay/ack", { epoch: body.epoch, through });
            if (ack.status === 200)
                node.store.set(ackedKey, String(through));
            else if (ack.status === 409 && typeof ack.json.epoch === "string") {
                relayEpochChanged(node, s.relay, ack.json.epoch, "epoch");
                continue;
            }
            else if (ack.status === 400 && ack.json.code === "BAD_ACK") {
                relayEpochChanged(node, s.relay, body.epoch, "rewind");
                continue;
            }
            // any other ack failure: the next pass acks again; the relay simply still holds those items
        }
        if (!body.more)
            break;
    }
    return accepted;
}
/**
 * Settle relay-accepted rows whose target reported delivery (T218), and enforce the sender-side deadline: a row the
 * target never confirmed by accepted_at + retention + grace alerts its sender, without waiting on the relay (§3).
 */
export function relaySettle(node, now = Date.now()) {
    const settled = Number(node.store.db.prepare(`UPDATE relay_sent SET state='settled', settled_at=? WHERE state='relay-accepted' AND EXISTS (
    SELECT 1 FROM remote_receipts r WHERE r.msg_id=relay_sent.msg_id AND substr(r.recipient, instr(r.recipient,'@')+1)=relay_sent.host
      AND r.state IN ('delivered','notified','read','acked'))`).run(iso(now)).changes);
    if (settled)
        node.store.db.prepare("DELETE FROM relay_wire WHERE (msg_id, host) IN (SELECT msg_id, host FROM relay_sent WHERE state='settled')").run();
    const late = node.store.db.prepare(`SELECT s.msg_id, s.host, m.envelope FROM relay_sent s JOIN messages m ON m.id=s.msg_id
    WHERE s.state='relay-accepted' AND s.deadline_at <= ?`).all(iso(now));
    for (const r of late) {
        const e = JSON.parse(r.envelope);
        const everConfirmed = node.store.db.prepare("SELECT 1 FROM remote_receipts WHERE substr(recipient, instr(recipient,'@')+1)=? LIMIT 1").get(r.host);
        const why = everConfirmed ? "the relay accepted it, but the recipient's host never confirmed delivery"
            : "the relay accepted it, but there is no delivery confirmation (the recipient's host may run AgentMBX older than 0.5.3, which sends none)";
        node.store.tx(() => {
            node.store.db.prepare("UPDATE relay_sent SET state='unconfirmed', settled_at=? WHERE msg_id=? AND host=?").run(iso(now), r.msg_id, r.host);
            node.send({ from: "mbx", to: [e.from.split("@")[0]], kind: "alert", subject: `Undelivered/unconfirmed to ${r.host}: ${e.subject}`,
                body: `Message ${e.id} to host ${r.host}: ${why}.` });
        });
    }
    return { settled, unconfirmed: late.length };
}
