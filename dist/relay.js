// Untrusted store-and-forward relay — reference implementation (ADR-035, T007; durable since T165).
// The relay decides nothing about authority: it stores opaque items (sealed envelopes, delivery receipts) in per-host
// queues, authenticates hosts by their host signing keys, enforces per-owner quotas, and never sees plaintext bodies.
// All state lives in a RelayStore (src/relay-store.ts): every successful answer follows a committed transaction, so a
// restart loses nothing (docs/spec/relay-durability.md). The relay has its own key, which signs accept receipts (§3).
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { canonical, generateKeyPair, signData, verifyData, nonce as newNonce } from "./crypto.js";
import { checkShape } from "./envelope.js";
import { SqliteRelayStore } from "./relay-store.js";
import { version } from "./version.js";
/** Owner decision 2026-10-02: 14 days, 50 MB / 10,000 queued per owner. */
export const DEFAULT_QUOTA = { maxQueueDepth: 1000, maxEnvelopeBytes: 256 * 1024 * 2, maxBatch: 200, maxOwnerDepth: 10_000,
    maxOwnerBytes: 50 * 1024 * 1024, pushesPerMinute: 120, maxPull: 500, maxTargets: 64, retentionDays: 14 };
export const wireHash = (s) => createHash("sha256").update(s).digest("hex");
const err = (code, message) => Object.assign(new Error(message), { code });
export class RelayCore {
    store;
    quota;
    key;
    pending = new Map(); // host pubkey -> enrolment challenge (a restart only voids open challenges)
    pushes = new Map(); // owner_fp -> push timestamps (rate window)
    constructor(quota = DEFAULT_QUOTA, o = {}) {
        this.quota = { ...DEFAULT_QUOTA, ...quota };
        this.store = o.store ?? new SqliteRelayStore();
        this.key = o.key ?? generateKeyPair();
        const pinned = this.store.meta("relay_pubkey");
        if (pinned && pinned !== this.key.publicKey)
            throw err("RELAY_KEY", "this relay store belongs to another relay key: keep relay.key with its store");
        if (!pinned)
            this.store.setMeta("relay_pubkey", this.key.publicKey);
    }
    /** Public relay facts for `relay set` pinning and client feature detection (§1). */
    info() {
        const q = this.quota;
        return { v: 2, relay_pubkey: this.key.publicKey, epoch: this.store.epoch(), version: version(),
            limits: { max_item_bytes: q.maxEnvelopeBytes, max_batch: q.maxBatch, max_pull: q.maxPull, max_targets: q.maxTargets, retention_days: q.retentionDays,
                max_owner_items: q.maxOwnerDepth, max_owner_bytes: q.maxOwnerBytes } };
    }
    /** Enrolled hosts, by key (read-only view kept for callers of the in-memory version). */
    get enrolments() { return new Map(this.store.enrolments().map((e) => [e.pubkey, e])); }
    /** Aggregate stored items across every host enrolled under one owner fingerprint. */
    ownerDepth(ownerFp) { return this.store.ownerUsage(ownerFp).items; }
    checkRate(ownerFp) {
        const now = Date.now(), window = this.pushes.get(ownerFp) ?? [];
        const recent = window.filter((t) => now - t < 60_000);
        if (recent.length >= this.quota.pushesPerMinute)
            return `push rate exceeded for owner (${this.quota.pushesPerMinute}/min)`;
        recent.push(now);
        this.pushes.set(ownerFp, recent);
        return null;
    }
    /** Enrolment step 1: the relay issues a single-use challenge for a host key. */
    challenge(_host, pubkey) {
        const n = newNonce();
        this.pending.set(pubkey, n);
        return n;
    }
    /** Enrolment step 2: the host signs (challenge, its key, its claimed owner); the relay verifies and binds. The host name
     *  stays bound to its first key (F4): another key cannot take it over. */
    enrol(host, pubkey, owner_fp, sig) {
        const n = this.pending.get(pubkey);
        if (!n)
            throw new Error("no pending enrolment challenge");
        if (!verifyData(pubkey, canonical({ v: 1, challenge: n, host, pubkey, owner_fp }), sig))
            throw new Error("bad enrolment signature");
        this.pending.delete(pubkey);
        this.store.transaction(() => this.store.putEnrolment({ host, pubkey, owner_fp, at: new Date().toISOString(), authorized_by: "host-key-challenge" }));
    }
    requireEnrolled(pubkey) {
        const e = this.store.getEnrolment(pubkey);
        if (!e || e.revoked_at)
            throw new Error("host is not enrolled");
        return e;
    }
    enrolmentByName(host) { return this.store.enrolmentByName(host); }
    /** A host publishes its enc key, signed by its host key; any enrolled host can read it (T028 via relay). The signature
     *  is served too: senders check it against the host key they pinned at pairing, never trusting the relay (T032). */
    publishEncAd(host, pubkey, encPub, sig) {
        const e = this.requireEnrolled(pubkey);
        if (e.host !== host)
            throw new Error("host mismatch");
        if (!verifyData(pubkey, canonical({ v: 1, host, enc_pub: encPub }), sig))
            throw new Error("bad enc-key signature");
        this.store.transaction(() => this.store.putEncAd({ host, host_pubkey: pubkey, enc_pub: encPub, sig, at: new Date().toISOString() }));
    }
    getEncAd(host) {
        const ad = this.store.encAdByName(host);
        return ad ? { host: ad.host, enc_pub: ad.enc_pub, sig: ad.sig } : null;
    }
    expiry(now) { return new Date(now + this.quota.retentionDays * 86_400_000).toISOString(); }
    /** Quota check for adding items and bytes to a target (and its owner). */
    quotaError(target, add) {
        const t = this.store.targetUsage(target.pubkey), o = this.store.ownerUsage(target.owner_fp);
        if (t.items + add.items > this.quota.maxQueueDepth)
            return `queue depth exceeded for ${target.host}`;
        if (o.items + add.items > this.quota.maxOwnerDepth)
            return `owner queue depth exceeded for ${target.host}`;
        if (o.bytes + add.bytes > this.quota.maxOwnerBytes)
            return `owner queue bytes exceeded for ${target.host}`;
        return null;
    }
    /** v1 push (kept for one release, §11): envelopes routed by recipient host name, id-only dedup (v1 senders re-seal on
     *  every retry), now atomic per envelope and durable. */
    push(from, envelopes) {
        const enrolment = this.requireEnrolled(from.pubkey);
        if (envelopes.length > this.quota.maxBatch)
            return { stored: 0, error: `batch over limit ${this.quota.maxBatch}` };
        const rateError = this.checkRate(enrolment.owner_fp);
        if (rateError)
            return { stored: 0, error: rateError };
        let stored = 0;
        for (const e of envelopes) {
            if (checkShape(e))
                return { stored, error: `bad envelope: ${checkShape(e)}` };
            const wire = JSON.stringify(e), bytes = Buffer.byteLength(wire);
            if (bytes > this.quota.maxEnvelopeBytes)
                return { stored, error: "envelope over size limit" };
            const names = [...new Set(e.to.map((r) => r.split("@")[1]))];
            const targets = [];
            for (const hostPart of names) {
                const target = hostPart ? this.store.enrolmentByName(hostPart) : null;
                if (!target)
                    return { stored, error: `recipient host not enrolled: ${hostPart}` };
                targets.push(target);
            }
            // v1 dedup: an envelope id this sender already stored counts as stored for every target (exactly-once storage)
            if (targets.every((t) => this.store.dedup(from.pubkey, e.id, t.pubkey))) {
                stored++;
                continue;
            }
            for (const t of targets) {
                const q = this.quotaError(t, { items: 1, bytes });
                if (q)
                    return { stored, error: q };
            }
            const now = Date.now(), at = new Date(now).toISOString();
            this.store.transaction(() => {
                for (const t of targets)
                    if (!this.store.dedup(from.pubkey, e.id, t.pubkey))
                        this.store.insertItem({ target_pubkey: t.pubkey, kind: "envelope", item_id: e.id, sender_pubkey: from.pubkey, sender_host: from.host,
                            wire, wire_hash: wireHash(wire), bytes, accepted_at: at, expires_at: this.expiry(now) });
            });
            stored++;
        }
        return { stored };
    }
    /** v1 pull: everything after a cursor; `cursor` is the last allocated seq, as before. */
    pull(pubkey, after = 0) {
        this.requireEnrolled(pubkey);
        const rows = this.store.pull(pubkey, after, 1_000_000).filter((r) => r.kind === "envelope");
        return { items: rows.map((r) => ({ seq: r.seq, envelope: JSON.parse(r.wire), from: r.sender_host })), cursor: this.store.lastSeq(pubkey) };
    }
    /** v1 ack: the host got everything up to here; the relay drops it. */
    ack(pubkey, cursor) {
        this.requireEnrolled(pubkey);
        this.store.ack(pubkey, Math.min(Math.max(0, Math.floor(cursor) || 0), this.store.lastSeq(pubkey)));
    }
    /** v2 push (§3): one transaction per item over all its targets; per-target dedup by (sender, item, target) with the
     *  wire hash deciding duplicate vs conflict; every accepted or duplicate item gets an accept statement signed by the
     *  relay key. Nothing is answered before it is committed. */
    pushItems(from, items) {
        const enrolment = this.requireEnrolled(from.pubkey);
        if (!Array.isArray(items) || items.length > this.quota.maxBatch)
            throw err("BAD_BATCH", `batch must be an array of at most ${this.quota.maxBatch}`);
        const rateError = this.checkRate(enrolment.owner_fp);
        return items.map((it) => {
            const id = typeof it?.item_id === "string" ? it.item_id : "";
            const reject = (why) => ({ item_id: id, status: `rejected:${why}`, targets: [] });
            if (rateError)
                return reject("rate");
            if (!id || id.length > 160)
                return reject("bad item id");
            if (it.kind !== "envelope" && it.kind !== "receipt")
                return reject("bad kind");
            if (!Array.isArray(it.targets) || !it.targets.length || it.targets.length > this.quota.maxTargets)
                return reject("bad targets");
            const prepared = [];
            for (const t of it.targets) {
                const target = typeof t?.host_pubkey === "string" ? this.store.getEnrolment(t.host_pubkey) : null;
                if (!target || target.revoked_at)
                    return reject("target not enrolled");
                if (prepared.some((p) => p.target.pubkey === target.pubkey))
                    return reject("duplicate target");
                if (typeof t.wire_b64 !== "string")
                    return reject("bad wire");
                const wire = Buffer.from(t.wire_b64, "base64").toString("utf8"), bytes = Buffer.byteLength(wire);
                if (bytes > this.quota.maxEnvelopeBytes)
                    return reject("item over size limit");
                const shapeError = this.checkWire(it.kind, id, wire);
                if (shapeError)
                    return reject(shapeError);
                prepared.push({ target, wire, wire_hash: wireHash(wire), bytes });
            }
            const now = Date.now(), at = new Date(now).toISOString();
            try {
                const done = this.store.transaction(() => {
                    const out = [];
                    for (const p of prepared) {
                        const hit = this.store.dedup(from.pubkey, id, p.target.pubkey);
                        if (hit) {
                            if (hit.wire_hash !== p.wire_hash)
                                throw err("CONFLICT", "conflict");
                            out.push({ host_pubkey: p.target.pubkey, seq: hit.seq, wire_hash: hit.wire_hash, fresh: false });
                            continue;
                        }
                        const q = this.quotaError(p.target, { items: 1, bytes: p.bytes });
                        if (q)
                            throw err("QUOTA", `quota:${q}`);
                        const seq = this.store.insertItem({ target_pubkey: p.target.pubkey, kind: it.kind, item_id: id, sender_pubkey: from.pubkey,
                            sender_host: from.host, wire: p.wire, wire_hash: p.wire_hash, bytes: p.bytes, accepted_at: at, expires_at: this.expiry(now) });
                        out.push({ host_pubkey: p.target.pubkey, seq, wire_hash: p.wire_hash, fresh: true });
                    }
                    return out;
                });
                const accept = { v: 1, type: "relay-accept", relay_pubkey: this.key.publicKey, epoch: this.store.epoch(), sender_pubkey: from.pubkey,
                    item_id: id, targets: done.map(({ host_pubkey, seq, wire_hash }) => ({ host_pubkey, seq, wire_hash })), at };
                return { item_id: id, status: done.some((d) => d.fresh) ? "accepted" : "duplicate", targets: done.map(({ host_pubkey, seq }) => ({ host_pubkey, seq })),
                    accept, sig: signData(this.key.privateKey, canonical(accept)) };
            }
            catch (e) {
                const code = e.code;
                if (code === "CONFLICT")
                    return reject("conflict");
                if (code === "QUOTA")
                    return reject(e.message);
                throw e;
            }
        });
    }
    /** The relay stores opaque items, but never a plaintext body (ADR-035) and never something that is not what it claims. */
    checkWire(kind, id, wire) {
        let v;
        try {
            v = JSON.parse(wire);
        }
        catch {
            return "bad wire";
        }
        if (kind === "envelope") {
            const e = v;
            if (checkShape(e))
                return `bad envelope: ${checkShape(e)}`;
            if (e.id !== id)
                return "item id is not the envelope id";
            if (!e.enc)
                return "envelope body is not sealed";
            return null;
        }
        const r = v;
        if (!r?.rec || r.rec.type !== "receipt" || typeof r.rec.msg !== "string" || typeof r.sig !== "string")
            return "bad receipt";
        return null;
    }
    /** v2 pull (§4): items after `after`, at most `limit`; `last_seq` is the last seq returned. */
    pullItems(pubkey, after = 0, limit = this.quota.maxPull) {
        this.requireEnrolled(pubkey);
        const from = Math.max(0, Math.floor(after) || 0), n = Math.max(1, Math.min(this.quota.maxPull, Math.floor(limit) || this.quota.maxPull));
        const rows = this.store.pull(pubkey, from, n + 1);
        const page = rows.slice(0, n);
        return { epoch: this.store.epoch(), items: page.map((r) => ({ seq: r.seq, kind: r.kind, item_id: r.item_id, sender_pubkey: r.sender_pubkey,
                wire_b64: Buffer.from(r.wire, "utf8").toString("base64") })), last_seq: page.length ? page[page.length - 1].seq : from, more: rows.length > n };
    }
    /** v2 ack (§4): the host processed everything through `through` in this epoch. Never past what was allocated. */
    ackItems(pubkey, epoch, through) {
        this.requireEnrolled(pubkey);
        if (epoch !== this.store.epoch())
            throw err("EPOCH", "relay epoch changed: pull again from 0");
        const t = Math.floor(through);
        if (!Number.isSafeInteger(t) || t < 0 || t > this.store.lastSeq(pubkey))
            throw err("BAD_ACK", "ack beyond the last allocated seq");
        const deleted = this.store.ack(pubkey, t);
        return { acked_through: this.store.ackedThrough(pubkey), deleted };
    }
    /** Test/ops introspection: how a relay operator sees stored mail — bodies must be sealed. */
    inspect(pubkey) {
        return this.store.pull(pubkey, 0, 1_000_000).filter((r) => r.kind === "envelope")
            .map((r) => ({ seq: r.seq, envelope: JSON.parse(r.wire), from: r.sender_host, at: r.accepted_at }));
    }
}
// ---- HTTP adapter --------------------------------------------------------------------------------
/** Bodies stop at RELAY_MAX_BODY while streaming (T029): an oversized upload is refused before it is buffered. */
export const RELAY_MAX_BODY = 8 * 1024 * 1024;
const readBody = (req, max = RELAY_MAX_BODY) => new Promise((r, rej) => {
    if (Number(req.headers["content-length"]) > max)
        return r(null);
    let n = 0;
    const chunks = [];
    req.on("data", (c) => { if ((n += c.length) > max) {
        chunks.length = 0;
        r(null);
    }
    else
        chunks.push(c); });
    req.on("end", () => r(Buffer.concat(chunks).toString("utf8")));
    req.on("error", rej);
});
/** Hop-style auth for enrolled hosts, reusing the same signed-hop shape as host-to-host HTTP. For /v2 the signed `path`
 *  includes the query string (§3), so a pull cursor cannot be altered in transit. */
export const relayHop = (host, priv, method, path, body, now = Date.now()) => ({
    "x-mbx-host": host, "x-mbx-ts": String(now), "x-mbx-sig": signData(priv, canonical({ method, path, ts: String(now), body: `${method}:${path}:${now}:${body}` })),
});
export function startRelayServer(core, port = 0, bind = "127.0.0.1") {
    const server = createServer(async (req, res) => {
        const send = (code, obj) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(obj)); };
        try {
            const url = new URL(req.url ?? "/", "http://x");
            const body = await readBody(req);
            if (body === null) { // answer, then discard (never buffer) the rest for up to 2 s so the client reads the 413, not a reset
                send(413, { error: `request body over ${RELAY_MAX_BODY} bytes` });
                req.resume();
                return void setTimeout(() => req.complete || req.destroy(), 2_000).unref();
            }
            if (req.method === "GET" && url.pathname === "/v2/relay/info")
                return send(200, core.info());
            if (req.method === "POST" && url.pathname === "/v1/relay/challenge") {
                const { host, pubkey } = JSON.parse(body);
                if (!host || !pubkey)
                    return send(400, { error: "host and pubkey required" });
                return send(200, { challenge: core.challenge(host, pubkey) });
            }
            if (req.method === "POST" && url.pathname === "/v1/relay/enrol") {
                const j = JSON.parse(body);
                if (!j.host || !j.pubkey || j.owner_fp === undefined || !j.sig)
                    return send(400, { error: "incomplete enrolment" });
                try {
                    core.enrol(j.host, j.pubkey, j.owner_fp, j.sig);
                    return send(200, { ok: true });
                }
                catch (e) {
                    return send(e.code === "NAME_TAKEN" ? 409 : 401, { error: e.message });
                }
            }
            // below here requires an enrolled, hop-authenticated host
            const h = req.headers["x-mbx-host"], ts = req.headers["x-mbx-ts"], sig = req.headers["x-mbx-sig"];
            const enrol = h ? core.enrolmentByName(h) : null;
            const signedPath = url.pathname.startsWith("/v2/") ? url.pathname + url.search : url.pathname;
            if (!enrol || !ts || !sig || Math.abs(Date.now() - Number(ts)) > 300_000
                || !verifyData(enrol.pubkey, canonical({ method: req.method ?? "GET", path: signedPath, ts, body: `${req.method}:${signedPath}:${ts}:${body}` }), sig))
                return send(401, { error: "bad relay hop" });
            const me = { host: enrol.host, pubkey: enrol.pubkey };
            if (req.method === "POST" && url.pathname === "/v1/relay/messages") {
                const { envelopes } = JSON.parse(body);
                if (!Array.isArray(envelopes))
                    return send(400, { error: "bad batch" });
                const r = core.push(me, envelopes);
                return send(r.error && r.stored === 0 ? 413 : 200, r);
            }
            if (req.method === "GET" && url.pathname === "/v1/relay/messages")
                return send(200, core.pull(enrol.pubkey, Number(url.searchParams.get("after") ?? 0)));
            if (req.method === "POST" && url.pathname === "/v1/relay/ack") {
                const { cursor } = JSON.parse(body);
                core.ack(enrol.pubkey, Number(cursor ?? 0));
                return send(200, { ok: true });
            }
            if (req.method === "POST" && url.pathname === "/v2/relay/items") {
                const { items } = JSON.parse(body);
                try {
                    return send(200, { results: core.pushItems(me, items) });
                }
                catch (e) {
                    return send(e.code === "BAD_BATCH" ? 400 : 500, { error: e.message });
                }
            }
            if (req.method === "GET" && url.pathname === "/v2/relay/items")
                return send(200, core.pullItems(enrol.pubkey, Number(url.searchParams.get("after") ?? 0), Number(url.searchParams.get("limit") ?? core.quota.maxPull)));
            if (req.method === "POST" && url.pathname === "/v2/relay/ack") {
                const { epoch, through } = JSON.parse(body);
                try {
                    return send(200, core.ackItems(enrol.pubkey, String(epoch ?? ""), Number(through)));
                }
                catch (e) {
                    return send(e.code === "EPOCH" ? 409 : 400, { error: e.message });
                }
            }
            if (req.method === "POST" && url.pathname === "/v1/relay/enc-key") {
                const j = JSON.parse(body);
                if (!j.enc_pub || !j.sig)
                    return send(400, { error: "enc_pub and sig required" });
                try {
                    core.publishEncAd(enrol.host, enrol.pubkey, j.enc_pub, j.sig);
                    return send(200, { ok: true });
                }
                catch (e) {
                    return send(401, { error: e.message });
                }
            }
            if (req.method === "GET" && url.pathname === "/v1/relay/enc-key") {
                const host = url.searchParams.get("host");
                const ad = host ? core.getEncAd(host) : null;
                return ad ? send(200, ad) : send(404, { error: "unknown host" });
            }
            return send(404, { error: "not found" });
        }
        catch (e) {
            return send(400, { error: e.message });
        }
    });
    Object.assign(server, { headersTimeout: 10_000, requestTimeout: 30_000, keepAliveTimeout: 5_000 }); // slow clients cannot hold sockets open
    return new Promise((resolve, reject) => { server.once("error", reject); server.listen(port, bind, () => resolve(server)); });
}
