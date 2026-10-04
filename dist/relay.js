// Untrusted store-and-forward relay — reference implementation (ADR-035, T007; durable since T165).
// The relay decides nothing about authority: it stores opaque items (sealed envelopes, delivery receipts) in per-host
// queues, authenticates hosts by their host signing keys, enforces quotas, and never sees plaintext bodies.
// All state lives in a RelayStore (src/relay-store.ts): every successful answer follows a committed transaction, so a
// restart loses nothing (docs/spec/relay-durability.md). The relay has its own key, which signs accept receipts (§3).
// Hosts are identified by key; a host name is a label (unique only inside a proven account, §2).
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { canonical, generateKeyPair, keyPairFromPrivate, signData, verifyData, nonce as newNonce } from "./crypto.js";
import { checkEncAd } from "./enc-ad.js";
import { checkShape } from "./envelope.js";
import { checkRotation } from "./key-rotation.js";
import { ReceiptRecord } from "./remote-receipts.js";
import { SqliteRelayStore } from "./relay-store.js";
import { version } from "./version.js";
/** Owner decision 2026-10-02: 14 days, 50 MB / 10,000 queued per owner (charged per host key until accounts prove owners). */
export const DEFAULT_QUOTA = {
    maxQueueDepth: 10_000, maxQueueBytes: 50 * 1024 * 1024, maxSenderItems: 2_000, maxSenderBytes: 20 * 1024 * 1024,
    maxOwnerDepth: 10_000, maxOwnerBytes: 50 * 1024 * 1024, maxEnvelopeBytes: 256 * 1024 * 2, maxBatch: 200, pushesPerMinute: 120,
    maxPull: 500, maxPullBytes: 8 * 1024 * 1024, maxTargets: 64, retentionDays: 14,
    maxEnrolments: 100_000, maxPendingChallenges: 10_000, challengeTtlMs: 300_000, enrolPerMinutePerIp: 30, maxPerName: 16,
};
export const MAX_SENDERS = 1024;
const IP_TABLE_MAX = 50_000;
/** The self-hosted default: any host that answers the challenge with its key may enrol; key and sender quotas bound it. */
export const hostKeyChallengeAuthority = { name: "host-key-challenge", authorize: () => ({ ok: true }) };
export const HEARTBEAT_MS = 30_000;
export const HEARTBEAT_STALE_MS = 10 * 60_000;
/** The retention sweep runs at startup and then this often (§6). */
export const SWEEP_MS = 10 * 60_000;
/** Dedup rows outlive their item by this much beyond retention (§7: the dedup horizon is retention + 7 days). */
export const DEDUP_GRACE_DAYS = 7;
/** Lowercase hex SHA-256 of the exact wire bytes. */
export const wireHash = (b) => createHash("sha256").update(b).digest("hex");
const err = (code, message) => Object.assign(new Error(message), { code });
const HOST_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/;
const OWNER_FP_RE = /^[A-Za-z0-9._-]{0,64}$/;
const B64_RE = /^[A-Za-z0-9+/]+={0,2}$/;
const isPubkey = (k) => typeof k === "string" && k.length === 44 && B64_RE.test(k) && Buffer.from(k, "base64").length === 32;
const ITEM_ID_MAX = 300;
/** The relay signing key from MBX_RELAY_KEY or relay.key: a raw base64 private key (what `agentmbx relay keygen` prints)
 *  or the JSON key pair `relay serve` writes. The pair is always derived from the private key, and a stored public key
 *  must match it. Errors never echo key material. */
export function parseRelayKey(text) {
    const t = text.trim();
    if (t.startsWith("{")) {
        let j;
        try {
            j = JSON.parse(t);
        }
        catch {
            throw new Error("not a valid relay key file");
        }
        if (typeof j.privateKey !== "string")
            throw new Error("not a valid relay key file");
        let pair;
        try {
            pair = keyPairFromPrivate(j.privateKey);
        }
        catch {
            throw new Error("not a valid relay key file");
        }
        if (j.publicKey !== undefined && j.publicKey !== pair.publicKey)
            throw new Error("the stored public key does not match the private key");
        return pair;
    }
    try {
        return keyPairFromPrivate(t);
    }
    catch {
        throw new Error("not a valid relay key (expected the value agentmbx relay keygen prints)");
    }
}
export class RelayCore {
    store;
    quota;
    key;
    authority;
    pending = new Map(); // host pubkey -> enrolment challenge (bounded, expiring)
    pushes = new Map(); // sender pubkey -> push timestamps (rate window)
    ipCalls = new Map(); // client address -> challenge/enrol timestamps
    constructor(quota = DEFAULT_QUOTA, o = {}) {
        this.quota = { ...DEFAULT_QUOTA, ...quota };
        this.store = o.store ?? new SqliteRelayStore();
        this.key = o.key ?? generateKeyPair();
        this.authority = o.authority ?? hostKeyChallengeAuthority;
        const pinned = this.store.meta("relay_pubkey");
        if (pinned && pinned !== this.key.publicKey)
            throw err("RELAY_KEY", "this relay store belongs to another relay key: keep relay.key with its store");
        if (!pinned)
            this.store.setMeta("relay_pubkey", this.key.publicKey);
        // A store whose heartbeat is stale may be a restored copy (a volume restore restarts the service): rotate the epoch so
        // senders re-push and receivers re-pull at once. A long outage rotates too, which dedup makes harmless (spec §5). So
        // does a heartbeat from the future: the clock went back, or the store was written under a clock that ran ahead, and
        // its age proves nothing. The operator gets one line either way (T333).
        const now = (o.now ?? Date.now)(), beat = Number(this.store.meta("heartbeat") ?? NaN), stale = o.heartbeatStaleMs ?? HEARTBEAT_STALE_MS;
        if (Number.isFinite(beat) && Math.abs(now - beat) > stale) {
            const from = this.store.epoch(), to = this.store.rotateEpoch(), ahead = beat > now;
            const heartbeat = Math.abs(beat) <= 8.64e15 ? new Date(beat).toISOString() : String(beat); // a corrupt value must not stop the relay
            const cause = ahead ? "clock went back, or store written under a clock that ran ahead" : "restore or long outage";
            const reason = `${ahead ? "heartbeat ahead of the clock" : "stale heartbeat"} (${cause})`;
            this.store.setMeta("epoch_rotated", JSON.stringify({ from, to, at: new Date(now).toISOString(), heartbeat, reason }));
            this.store.logOp("epoch-rotated", { v: 1, type: "relay-epoch-rotated", at: new Date(now).toISOString(), from, to, heartbeat, reason, by: "startup" }, new Date(now).toISOString());
            (o.log ?? ((l) => console.error(l)))(`[agentmbx] relay epoch rotated at startup: stored heartbeat ${heartbeat} is ${Math.round(Math.abs(now - beat) / 60_000)} min ${ahead ? "ahead of this clock" : "old"} (${cause}); epoch ${from} -> ${to}: senders re-push, receivers re-pull`);
        }
        this.beat(now);
    }
    /** The running relay records that it is alive; startRelayServer calls this every HEARTBEAT_MS. */
    beat(now = Date.now()) { this.store.setMeta("heartbeat", String(now)); }
    /** Public relay facts for `relay set` pinning and client feature detection (§1). With a caller, also its queue head
     *  and the enc-key ad stored for it (T168), so a host reconciles its enrolment and ad against this store, not a flag. */
    info(caller) {
        const q = this.quota;
        const ad = caller ? this.getEncAdByKey(caller.pubkey) : null;
        return { v: 2, relay_pubkey: this.key.publicKey, epoch: this.store.epoch(), version: version(),
            limits: { max_item_bytes: q.maxEnvelopeBytes, max_batch: q.maxBatch, max_pull: q.maxPull, max_pull_bytes: q.maxPullBytes, max_targets: q.maxTargets,
                retention_days: q.retentionDays, max_queue_items: q.maxQueueDepth, max_queue_bytes: q.maxQueueBytes, max_sender_items: q.maxSenderItems,
                max_sender_bytes: q.maxSenderBytes, max_owner_items: q.maxOwnerDepth, max_owner_bytes: q.maxOwnerBytes },
            ...(caller ? { you: { host: caller.host, pubkey: caller.pubkey, head_seq: this.store.lastSeq(caller.pubkey), acked_through: this.store.ackedThrough(caller.pubkey),
                    enc_ad: ad ? { enc_pub: ad.ad?.enc_pub ?? null, exp: ad.ad?.exp ?? null, v1: ad.sig !== undefined ? ad.enc_pub : null } : null } } : {}) };
    }
    /** Aggregate stored items across every host of one proven account. */
    accountDepth(account) { return this.store.accountUsage(account).items; }
    window(map, key, limit) {
        const now = Date.now(), recent = (map.get(key) ?? []).filter((t) => now - t < 60_000);
        if (recent.length >= limit) {
            map.set(key, recent);
            return false;
        }
        recent.push(now);
        map.set(key, recent);
        if (map.size > IP_TABLE_MAX) {
            for (const [k, v] of map)
                if (!v.some((t) => now - t < 60_000))
                    map.delete(k); // forget idle keys
            for (const k of map.keys()) {
                if (map.size <= IP_TABLE_MAX)
                    break;
                map.delete(k);
            } // hard cap: spoofed keys cannot grow it
        }
        return true;
    }
    /** Challenge and enrolment calls per client address (HTTP adapter passes it; in-process callers are trusted). */
    allowEnrolCall(ip) { return ip === undefined || this.window(this.ipCalls, ip, this.quota.enrolPerMinutePerIp); }
    /** Enrolment step 1: the relay issues a single-use challenge for a host key. Bounded and expiring (a public relay). */
    challenge(host, pubkey) {
        if (!HOST_RE.test(host))
            throw err("BAD_REQUEST", "bad host name");
        if (!isPubkey(pubkey))
            throw err("BAD_REQUEST", "bad host key");
        const now = Date.now();
        for (const [k, v] of this.pending)
            if (now - v.at > this.quota.challengeTtlMs)
                this.pending.delete(k);
        if (!this.pending.has(pubkey) && this.pending.size >= this.quota.maxPendingChallenges)
            throw err("BUSY", "too many open enrolment challenges; retry later");
        const n = newNonce();
        this.pending.set(pubkey, { n, at: now });
        return n;
    }
    /** Enrolment step 2: the host signs (challenge, its key, its claimed owner); the relay verifies, asks its
     *  EnrolmentAuthority (§8), and binds with the account the authority proved. A revoked key stays revoked. owner_fp is
     *  recorded but proves nothing. A denial stores nothing and answers DENIED (403). */
    enrol(host, pubkey, owner_fp, sig, proof) {
        if (!HOST_RE.test(host) || !isPubkey(pubkey) || typeof owner_fp !== "string" || !OWNER_FP_RE.test(owner_fp))
            throw err("BAD_REQUEST", "bad enrolment fields");
        const p = this.pending.get(pubkey);
        if (!p || Date.now() - p.at > this.quota.challengeTtlMs)
            throw new Error("no pending enrolment challenge");
        if (typeof sig !== "string" || !verifyData(pubkey, canonical({ v: 1, challenge: p.n, host, pubkey, owner_fp }), sig))
            throw new Error("bad enrolment signature");
        this.pending.delete(pubkey);
        let d;
        try {
            d = this.authority.authorize({ host_name: host, host_pubkey: pubkey, owner_fp, proof });
        }
        catch {
            d = { ok: false, reason: "the enrolment authority is unavailable" };
        }
        if (!d?.ok)
            throw err("DENIED", `enrolment not authorized${d?.reason ? `: ${String(d.reason).slice(0, 200)}` : ""}`);
        this.store.transaction(() => {
            const known = this.store.getEnrolment(pubkey);
            if (!known && this.store.liveEnrolmentCount() >= this.quota.maxEnrolments)
                throw err("FULL", "relay enrolment capacity reached");
            this.store.putEnrolment({ host, pubkey, owner_fp, at: new Date().toISOString(), account: d.account ?? null, authorized_by: this.authority.name });
        });
    }
    /** T030 rotation (§2): the old key's signed rotation record moves its name, account and queue to the new key and
     *  revokes the old key. Both keys signed the record; the old key must be the enrolled one. */
    rotate(s) {
        const oldPub = s?.rec?.old_pub;
        const old = typeof oldPub === "string" ? this.store.getEnrolment(oldPub) : null;
        if (!old || old.revoked_at)
            throw err("NOT_ENROLLED", "the rotated key is not enrolled here");
        const bad = checkRotation(s, old.pubkey);
        if (bad)
            throw err("BAD_ROTATION", bad);
        if (s.rec.host !== old.host || !isPubkey(s.rec.new_pub))
            throw err("BAD_ROTATION", "rotation names another host");
        const moved = this.store.rebind(old.pubkey, { ...old, pubkey: s.rec.new_pub, at: new Date().toISOString(), authorized_by: old.authorized_by ?? "host-rotation", revoked_at: null });
        return { moved };
    }
    requireEnrolled(pubkey) {
        const e = this.store.getEnrolment(pubkey);
        if (!e || e.revoked_at)
            throw new Error("host is not enrolled");
        return e;
    }
    /** v1 name routing: a name resolves only when exactly one live enrolment carries it, or exactly one inside the
     *  caller's proven account. Anything else is ambiguous and routes nowhere: an unproven owner claim or a newer squatter
     *  never wins (v1 senders drop their row on a 200, so a wrong guess would lose mail silently). */
    resolveName(host, viewer) {
        const all = this.store.enrolmentsByName(host);
        if (all.length > this.quota.maxPerName)
            return { enrolment: null, ambiguous: true }; // crowded counts as ambiguous
        if (all.length === 1)
            return { enrolment: all[0], ambiguous: false };
        const mine = viewer?.account ? all.filter((e) => e.account === viewer.account) : [];
        if (mine.length === 1)
            return { enrolment: mine[0], ambiguous: false };
        return { enrolment: null, ambiguous: all.length > 1 };
    }
    enrolmentByName(host, viewer) { return this.resolveName(host, viewer).enrolment; }
    /** A target publishes the sender keys it accepts, signed by its host key; a newer list replaces an older one. */
    publishSenders(target, list, sig) {
        if (list?.v !== 1 || list.type !== "relay-senders" || list.host_pubkey !== target.pubkey || typeof list.iat !== "string" || !Number.isFinite(Date.parse(list.iat))
            || !Array.isArray(list.senders) || list.senders.length > MAX_SENDERS || !list.senders.every(isPubkey))
            throw err("BAD_REQUEST", "bad sender list");
        if (Date.parse(list.iat) > Date.now() + 5 * 60_000)
            throw err("BAD_REQUEST", "sender list iat is in the future");
        if (typeof sig !== "string" || !verifyData(target.pubkey, canonical(list), sig))
            throw err("BAD_SIGNATURE", "sender list is not signed by the target");
        const cur = this.store.senderList(target.pubkey);
        if (cur && Date.parse(cur.iat) >= Date.parse(list.iat))
            throw err("STALE", "a newer sender list is already stored");
        this.store.transaction(() => this.store.putSenderList(target.pubkey, [...new Set(list.senders)], list.iat, canonical(list), sig));
    }
    senderAllowed(target, sender) {
        const l = this.store.senderList(target.pubkey);
        return !l || l.senders.includes(sender);
    }
    /** Hop authentication: by key when the caller sends x-mbx-key (v2), else by name, letting the signature pick among
     *  the enrolments that carry the name (v1). */
    authenticate(headers, method, signedPath, body) {
        const ts = headers["x-mbx-ts"], sig = headers["x-mbx-sig"];
        if (!ts || !sig || !Number.isFinite(Number(ts)) || Math.abs(Date.now() - Number(ts)) > 300_000)
            return null;
        const payload = canonical({ method, path: signedPath, ts, body: `${method}:${signedPath}:${ts}:${body}` });
        const key = headers["x-mbx-key"], name = headers["x-mbx-host"];
        const byName = !key && name ? this.store.enrolmentsByName(name) : [];
        if (byName.length > this.quota.maxPerName)
            return null; // a crowded name: v1 callers must upgrade to key headers
        const candidates = key ? [this.store.getEnrolment(key)].filter((e) => !!e && !e.revoked_at) : byName;
        return candidates.find((e) => verifyData(e.pubkey, payload, sig)) ?? null;
    }
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
    /** T168: the signed, expiring v2 ad (src/enc-ad.ts). Refused unless it is the caller's own, current and validly signed. */
    publishEncAdRecord(caller, ad, sig) {
        const bad = checkEncAd(ad, sig, { host: caller.host, host_pubkey: caller.pubkey });
        if (bad)
            throw err("BAD_AD", `enc-key ad refused: ${bad}`);
        this.store.transaction(() => this.store.putEncAdRecord({ host_pubkey: caller.pubkey, record: canonical(ad), sig, at: new Date().toISOString() }));
    }
    getEncAd(host, viewer) {
        const e = this.resolveName(host, viewer).enrolment;
        return e ? this.getEncAdByKey(e.pubkey) : null;
    }
    /** Both shapes a host published: v1 (`enc_pub`, `sig`) for older senders, and the v2 record (`ad`, `ad_sig`). */
    getEncAdByKey(pubkey) {
        const v1 = this.store.encAd(pubkey), rec = this.store.encAdRecord(pubkey);
        const ad = rec ? JSON.parse(rec.record) : null;
        if (!v1 && !ad)
            return null;
        return { host: v1?.host ?? ad.host, host_pubkey: pubkey, enc_pub: v1?.enc_pub ?? ad.enc_pub, ...(v1 ? { sig: v1.sig } : {}), ...(ad ? { ad, ad_sig: rec.sig } : {}) };
    }
    expiry(now) { return new Date(now + this.quota.retentionDays * 86_400_000).toISOString(); }
    /** Quota check for adding one item to a target: the target's queue, this sender's share of it, and a proven account. */
    quotaError(target, sender, bytes) {
        const t = this.store.targetUsage(target.pubkey), s = this.store.senderUsage(sender, target.pubkey);
        if (t.items + 1 > this.quota.maxQueueDepth)
            return `queue depth exceeded for ${target.host}`;
        if (t.bytes + bytes > this.quota.maxQueueBytes)
            return `queue bytes exceeded for ${target.host}`;
        if (s.items + 1 > this.quota.maxSenderItems || s.bytes + bytes > this.quota.maxSenderBytes)
            return `sender share exceeded for ${target.host}`;
        if (target.account) {
            const a = this.store.accountUsage(target.account);
            if (a.items + 1 > this.quota.maxOwnerDepth)
                return `owner queue depth exceeded for ${target.host}`;
            if (a.bytes + bytes > this.quota.maxOwnerBytes)
                return `owner queue bytes exceeded for ${target.host}`;
        }
        return null;
    }
    /** v1 push (kept for one release, §11): envelopes routed by recipient host name, id-only dedup (v1 senders re-seal on
     *  every retry), now atomic per envelope and durable. */
    push(from, envelopes) {
        const sender = this.requireEnrolled(from.pubkey);
        if (envelopes.length > this.quota.maxBatch)
            return { stored: 0, error: `batch over limit ${this.quota.maxBatch}` };
        if (!this.window(this.pushes, sender.pubkey, this.quota.pushesPerMinute))
            return { stored: 0, error: `push rate exceeded (${this.quota.pushesPerMinute}/min)` };
        let stored = 0;
        for (const e of envelopes) {
            if (checkShape(e))
                return { stored, error: `bad envelope: ${checkShape(e)}` };
            const wire = Buffer.from(JSON.stringify(e)), bytes = wire.length;
            if (bytes > this.quota.maxEnvelopeBytes)
                return { stored, error: "envelope over size limit" };
            const names = [...new Set(e.to.map((r) => r.split("@")[1]))];
            const targets = [];
            for (const hostPart of names) {
                const r = hostPart ? this.resolveName(hostPart, sender) : { enrolment: null, ambiguous: false };
                if (r.ambiguous)
                    return { stored, error: `recipient host ambiguous: ${hostPart} (several hosts use that name here; upgrade to address hosts by key)` };
                const target = r.enrolment;
                if (!target)
                    return { stored, error: `recipient host not enrolled: ${hostPart}` };
                if (!this.senderAllowed(target, sender.pubkey))
                    return { stored, error: `sender not accepted by ${hostPart}` };
                if (!targets.some((t) => t.pubkey === target.pubkey))
                    targets.push(target);
            }
            // v1 dedup: an envelope id this sender already stored counts as stored for every target (exactly-once storage)
            if (targets.every((t) => this.store.dedup(from.pubkey, e.id, t.pubkey))) {
                stored++;
                continue;
            }
            for (const t of targets) {
                const q = this.quotaError(t, from.pubkey, bytes);
                if (q)
                    return { stored, error: q };
            }
            const at = new Date().toISOString();
            // A v1 item never expires (expires_at NULL) while v1 exists: a v1 sender deleted its row on the 200 and v1 pulls drop
            // non-envelopes, so it could never learn of an expiry notice. v1 had no expiry before T167 either: no regression.
            this.store.transaction(() => {
                for (const t of targets)
                    if (!this.store.dedup(from.pubkey, e.id, t.pubkey))
                        this.store.insertItem({ target_pubkey: t.pubkey, kind: "envelope", item_id: e.id, sender_pubkey: from.pubkey, sender_host: from.host,
                            wire, wire_hash: wireHash(wire), bytes, accepted_at: at, expires_at: null });
            });
            stored++;
        }
        return { stored };
    }
    /** v1 pull: envelopes after a cursor, a bounded page; `cursor` is the last allocated seq, or the last seq read when
     *  the page is full (the client acks it and pulls again). */
    pull(pubkey, after = 0) {
        this.requireEnrolled(pubkey);
        const rows = this.store.pull(pubkey, after, this.quota.maxPull + 1), page = rows.slice(0, this.quota.maxPull);
        const cursor = rows.length > this.quota.maxPull ? page[page.length - 1].seq : this.store.lastSeq(pubkey);
        return { items: page.filter((r) => r.kind === "envelope").map((r) => ({ seq: r.seq, envelope: JSON.parse(r.wire.toString("utf8")), from: r.sender_host })), cursor };
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
        const sender = this.requireEnrolled(from.pubkey);
        if (!Array.isArray(items) || items.length > this.quota.maxBatch)
            throw err("BAD_BATCH", `batch must be an array of at most ${this.quota.maxBatch}`);
        const rateOk = this.window(this.pushes, sender.pubkey, this.quota.pushesPerMinute);
        return items.map((it) => {
            const id = typeof it?.item_id === "string" ? it.item_id : "";
            const reject = (why) => ({ item_id: id, status: `rejected:${why}`, targets: [] });
            if (!rateOk)
                return reject("rate");
            if (!id || id.length > ITEM_ID_MAX)
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
                if (!this.senderAllowed(target, sender.pubkey))
                    return reject("sender not accepted by target");
                if (prepared.some((p) => p.target.pubkey === target.pubkey))
                    return reject("duplicate target"); // the sender merges a host's recipients
                if (typeof t.wire_b64 !== "string" || !B64_RE.test(t.wire_b64))
                    return reject("bad wire");
                const wire = Buffer.from(t.wire_b64, "base64"), bytes = wire.length;
                if (bytes > this.quota.maxEnvelopeBytes)
                    return reject("item over size limit");
                const shapeError = this.checkWire(it.kind, id, wire, sender.pubkey);
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
                            out.push({ host_pubkey: p.target.pubkey, seq: hit.seq, wire_hash: hit.wire_hash, fresh: false, accepted_at: hit.accepted_at });
                            continue;
                        }
                        const q = this.quotaError(p.target, from.pubkey, p.bytes);
                        if (q)
                            throw err("QUOTA", `quota:${q}`);
                        const seq = this.store.insertItem({ target_pubkey: p.target.pubkey, kind: it.kind, item_id: id, sender_pubkey: from.pubkey,
                            sender_host: from.host, wire: p.wire, wire_hash: p.wire_hash, bytes: p.bytes, accepted_at: at, expires_at: this.expiry(now) });
                        out.push({ host_pubkey: p.target.pubkey, seq, wire_hash: p.wire_hash, fresh: true, accepted_at: at });
                    }
                    return out;
                });
                // A pure duplicate is the same acceptance as before: it carries the original time, so the sender's deadline (§3)
                // stays accepted_at + retention + grace however often it retries (also after a restore, or past an expiry).
                const first = done.some((d) => d.fresh) ? at : done.map((d) => d.accepted_at).sort()[0] ?? at;
                const accept = { v: 1, type: "relay-accept", relay_pubkey: this.key.publicKey, epoch: this.store.epoch(), sender_pubkey: from.pubkey,
                    item_id: id, targets: done.map(({ host_pubkey, seq, wire_hash }) => ({ host_pubkey, seq, wire_hash })), at: first };
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
    /** The relay stores opaque items, but never a plaintext body (ADR-035) and never something that is not what it claims:
     *  envelopes are sealed and carry the item id; receipts are well-formed T218 records signed by the sending host, whose
     *  item id is receipt:<msg>:<recipient>:<seq>. */
    checkWire(kind, id, wire, senderPub) {
        let v;
        try {
            v = JSON.parse(wire.toString("utf8"));
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
        const rec = ReceiptRecord.safeParse(r?.rec);
        if (!rec.success || typeof r.sig !== "string")
            return "bad receipt";
        if (id !== `receipt:${rec.data.msg}:${rec.data.recipient}:${rec.data.seq}`)
            return "item id is not the receipt id";
        if (!verifyData(senderPub, canonical(rec.data), r.sig))
            return "receipt is not signed by the sending host";
        return null;
    }
    /** v2 pull (§4): items after `after`, at most `limit` and about maxPullBytes (always at least one); `last_seq` is the
     *  last seq returned, `head_seq` the last seq allocated. A head below the receiver's checkpoint in the same epoch means
     *  the store went back in time: the receiver treats it like an epoch change (§5). */
    pullItems(pubkey, after = 0, limit = this.quota.maxPull, epoch) {
        this.requireEnrolled(pubkey);
        if (epoch !== undefined && epoch !== this.store.epoch())
            throw err("EPOCH", "relay epoch changed: pull again from 0");
        const from = Math.max(0, Math.floor(after) || 0), n = Math.max(1, Math.min(this.quota.maxPull, Math.floor(limit) || this.quota.maxPull));
        const rows = this.store.pull(pubkey, from, n + 1);
        const page = [];
        let bytes = 0;
        for (const r of rows.slice(0, n)) {
            if (page.length && bytes + r.bytes > this.quota.maxPullBytes)
                break;
            page.push(r);
            bytes += r.bytes;
        }
        return { epoch: this.store.epoch(), head_seq: this.store.lastSeq(pubkey),
            items: page.map((r) => ({ seq: r.seq, kind: r.kind, item_id: r.item_id, sender_pubkey: r.sender_pubkey, wire_b64: r.wire.toString("base64") })),
            last_seq: page.length ? page[page.length - 1].seq : from, more: rows.length > page.length };
    }
    /** v2 ack (§4): the host processed everything through `through` in this epoch. Never past what was allocated. */
    ackItems(pubkey, epoch, through) {
        this.requireEnrolled(pubkey);
        if (epoch !== this.store.epoch())
            throw err("EPOCH", "relay epoch changed: pull again from 0");
        const t = Math.floor(through);
        if (!Number.isSafeInteger(t) || t < 0 || t > this.store.lastSeq(pubkey))
            throw err("BAD_ACK", "ack beyond the last allocated seq: treat as an epoch change");
        const deleted = this.store.ack(pubkey, t);
        return { acked_through: this.store.ackedThrough(pubkey), deleted, head_seq: this.store.lastSeq(pubkey) };
    }
    /**
     * The retention sweep (§6). Only v2 items expire: v1 pushes, and items queued before this store enforced expiry, carry
     * no `expires_at` and stay until acked, as before (see SqliteRelayStore `expiry_from`).
     * Items whose `expires_at` has passed are deleted; their dedup row stays as a tombstone until
     * the dedup horizon, so a late retry is a duplicate, never a re-delivery after expiry. Each expired envelope queues a
     * notice signed by the relay key for its sender, in the same transaction, unless the sender's key is no longer enrolled
     * or its own queue is at its cap (the sender's deadline covers those, §3). Expired receipts and notices go without a
     * notice. Live items (not yet expired) are never touched. Bounded per call; anything left waits for the next sweep.
     */
    sweep(now = Date.now(), o = {}) {
        const at = new Date(now).toISOString(), batch = o.batch ?? 500, maxBatches = o.maxBatches ?? 20;
        const r = { v: 1, type: "relay-sweep", at, retention_days: this.quota.retentionDays, expired: { envelope: 0, receipt: 0, expired: 0 }, notices: 0,
            notices_skipped: { not_enrolled: 0, over_cap: 0 }, dedup_pruned: 0, freed_bytes: 0 };
        for (let i = 0; i < maxBatches; i++) {
            const n = this.store.transaction(() => {
                const rows = this.store.expiredItems(at, batch);
                for (const it of rows) {
                    this.store.deleteItem(it.target_pubkey, it.seq);
                    r.expired[it.kind]++;
                    r.freed_bytes += it.bytes;
                    if (it.kind !== "envelope")
                        continue; // receipts are advisory; a notice about a notice tells nobody anything
                    const sender = this.store.getEnrolment(it.sender_pubkey);
                    if (!sender || sender.revoked_at) {
                        r.notices_skipped.not_enrolled++;
                        continue;
                    }
                    const notice = { v: 1, type: "relay-expired", item_id: it.item_id, target_pubkey: it.target_pubkey, accepted_at: it.accepted_at, expired_at: at };
                    const noticeId = `expired:${it.item_id}:${it.target_pubkey}`;
                    if (this.store.dedup(this.key.publicKey, noticeId, sender.pubkey))
                        continue; // already told (a sweep after a restore)
                    const wire = Buffer.from(canonical({ notice, sig: signData(this.key.privateKey, canonical(notice)) }));
                    const u = this.store.targetUsage(sender.pubkey);
                    if (u.items + 1 > this.quota.maxQueueDepth || u.bytes + wire.length > this.quota.maxQueueBytes) {
                        r.notices_skipped.over_cap++;
                        continue;
                    }
                    this.store.insertItem({ target_pubkey: sender.pubkey, kind: "expired", item_id: noticeId, sender_pubkey: this.key.publicKey, sender_host: "relay",
                        wire, wire_hash: wireHash(wire), bytes: wire.length, accepted_at: at, expires_at: this.expiry(now) });
                    r.notices++;
                }
                return rows.length;
            });
            if (n < batch)
                break;
        }
        r.dedup_pruned = this.store.transaction(() => this.store.pruneDedup(new Date(now - (this.quota.retentionDays + DEDUP_GRACE_DAYS) * 86_400_000).toISOString()));
        if (r.expired.envelope + r.expired.receipt + r.expired.expired + r.dedup_pruned)
            this.store.logOp("sweep", { ...r }, at);
        return r;
    }
    /** Test/ops introspection: how a relay operator sees stored mail — bodies must be sealed. Bounded like a pull. */
    inspect(pubkey, limit = 1000) {
        return this.store.pull(pubkey, 0, limit).filter((r) => r.kind === "envelope")
            .map((r) => ({ seq: r.seq, envelope: JSON.parse(r.wire.toString("utf8")), from: r.sender_host, at: r.accepted_at }));
    }
}
// ---- HTTP adapter --------------------------------------------------------------------------------
/** Bodies stop at RELAY_MAX_BODY while streaming (T029): an oversized upload is refused before it is buffered. */
export const RELAY_MAX_BODY = 8 * 1024 * 1024;
/** Enrolment calls are tiny; a pubkey or challenge body larger than this is refused before parsing. */
const ENROL_MAX_BODY = 8192;
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
/** Hop-style auth for enrolled hosts, reusing the same signed-hop shape as host-to-host HTTP (the signature covers the
 *  method, path, timestamp and the full body). For /v2 the signed `path` includes the query string (§3), so a pull
 *  cursor cannot be altered in transit; v2 callers also send x-mbx-key so the relay finds them by key, not by name. */
export const relayHop = (host, priv, method, path, body, now = Date.now(), pubkey) => ({
    "x-mbx-host": host, ...(pubkey ? { "x-mbx-key": pubkey } : {}), "x-mbx-ts": String(now),
    "x-mbx-sig": signData(priv, canonical({ method, path, ts: String(now), body: `${method}:${path}:${now}:${body}` })),
});
export function clientAddress(headers, socketAddr, mode) {
    if (mode === "cloudflare") {
        const cf = headers["cf-connecting-ip"];
        if (typeof cf === "string" && cf.trim())
            return cf.trim().slice(0, 64);
    }
    if (mode === "xff") {
        const parts = String(headers["x-forwarded-for"] ?? "").split(",").map((x) => x.trim()).filter(Boolean);
        if (parts.length)
            return parts[parts.length - 1].slice(0, 64);
    }
    return socketAddr ?? "unknown";
}
export function startRelayServer(core, port = 0, bind = "127.0.0.1", o = {}) {
    const server = createServer(async (req, res) => {
        const send = (code, obj) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(obj)); };
        try {
            const url = new URL(req.url ?? "/", "http://x");
            const enrolCall = req.method === "POST" && (url.pathname === "/v1/relay/challenge" || url.pathname === "/v1/relay/enrol" || url.pathname === "/v2/relay/rotate");
            const body = await readBody(req, enrolCall ? ENROL_MAX_BODY : RELAY_MAX_BODY);
            if (body === null) { // answer, then discard (never buffer) the rest for up to 2 s so the client reads the 413, not a reset
                send(413, { error: "request body too large" });
                req.resume();
                return void setTimeout(() => req.complete || req.destroy(), 2_000).unref();
            }
            const signedPath = url.pathname.startsWith("/v2/") ? url.pathname + url.search : url.pathname;
            if (req.method === "GET" && url.pathname === "/v2/relay/info") {
                const caller = req.headers["x-mbx-sig"] ? core.authenticate(req.headers, "GET", signedPath, body) : null;
                return send(200, core.info(caller ?? undefined));
            }
            if (enrolCall) {
                if (!core.allowEnrolCall(clientAddress(req.headers, req.socket.remoteAddress, o.trustProxy)))
                    return send(429, { error: "too many enrolment calls; retry in a minute" });
                if (url.pathname === "/v2/relay/rotate") { // self-authenticating: both keys signed the record (a rotated host signs hops with its new key)
                    const { rotation } = JSON.parse(body);
                    try {
                        return send(200, core.rotate(rotation));
                    }
                    catch (e) {
                        const c = e.code;
                        return send(c === "NOT_ENROLLED" ? 404 : c === "ROTATION_TARGET" ? 409 : 400, { error: e.message });
                    }
                }
                const j = JSON.parse(body);
                if (url.pathname === "/v1/relay/challenge") {
                    if (!j.host || !j.pubkey)
                        return send(400, { error: "host and pubkey required" });
                    try {
                        return send(200, { challenge: core.challenge(j.host, j.pubkey) });
                    }
                    catch (e) {
                        const c = e.code;
                        return send(c === "BUSY" ? 503 : 400, { error: e.message });
                    }
                }
                if (!j.host || !j.pubkey || j.owner_fp === undefined || !j.sig)
                    return send(400, { error: "incomplete enrolment" });
                try {
                    core.enrol(j.host, j.pubkey, j.owner_fp, j.sig, j.proof);
                    return send(200, { ok: true });
                }
                catch (e) {
                    const c = e.code;
                    return send(c === "REVOKED" || c === "DENIED" ? 403 : c === "NAME_TAKEN" ? 409 : c === "FULL" ? 503 : c === "BAD_REQUEST" ? 400 : 401, { error: e.message, ...(c ? { code: c } : {}) });
                }
            }
            // below here requires an enrolled, hop-authenticated host
            const enrol = core.authenticate(req.headers, req.method ?? "GET", signedPath, body);
            if (!enrol)
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
            if (req.method === "GET" && url.pathname === "/v2/relay/items") {
                const epoch = url.searchParams.get("epoch") ?? undefined;
                try {
                    return send(200, core.pullItems(enrol.pubkey, Number(url.searchParams.get("after") ?? 0), Number(url.searchParams.get("limit") ?? core.quota.maxPull), epoch));
                }
                catch (e) {
                    return send(e.code === "EPOCH" ? 409 : 400, { error: e.message, epoch: core.store.epoch() });
                }
            }
            if (req.method === "POST" && url.pathname === "/v2/relay/ack") {
                const { epoch, through } = JSON.parse(body);
                try {
                    return send(200, core.ackItems(enrol.pubkey, String(epoch ?? ""), Number(through)));
                }
                catch (e) {
                    const c = e.code;
                    return send(c === "EPOCH" ? 409 : 400, { error: e.message, code: c, epoch: core.store.epoch(), head_seq: core.store.lastSeq(enrol.pubkey) });
                }
            }
            if (req.method === "POST" && url.pathname === "/v2/relay/senders") {
                const { list, sig } = JSON.parse(body);
                try {
                    core.publishSenders(enrol, list, String(sig ?? ""));
                    return send(200, { ok: true });
                }
                catch (e) {
                    const c = e.code;
                    return send(c === "STALE" ? 409 : c === "BAD_SIGNATURE" ? 401 : 400, { error: e.message });
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
            if (req.method === "POST" && url.pathname === "/v2/relay/enc-key") {
                const j = JSON.parse(body);
                try {
                    core.publishEncAdRecord(enrol, j.ad, String(j.sig ?? ""));
                    return send(200, { ok: true });
                }
                catch (e) {
                    return send(400, { error: e.message });
                }
            }
            if (req.method === "GET" && (url.pathname === "/v1/relay/enc-key" || url.pathname === "/v2/relay/enc-key")) {
                const pubkey = url.searchParams.get("pubkey"), host = url.searchParams.get("host");
                const ad = pubkey ? core.getEncAdByKey(pubkey) : host ? core.getEncAd(host, enrol) : null;
                return ad ? send(200, ad) : send(404, { error: "unknown host" });
            }
            return send(404, { error: "not found" });
        }
        catch (e) {
            return send(400, { error: e.message });
        }
    });
    Object.assign(server, { headersTimeout: 10_000, requestTimeout: 30_000, keepAliveTimeout: 5_000 }); // slow clients cannot hold sockets open
    const beat = setInterval(() => { try {
        core.beat();
    }
    catch { /* store closed */ } }, HEARTBEAT_MS);
    // The retention sweep (§6): once now, so a store restored from an old copy or a long outage settles at once, then periodically.
    const log = o.log ?? ((l) => console.error(l));
    const sweep = () => {
        try {
            const r = core.sweep(), gone = r.expired.envelope + r.expired.receipt + r.expired.expired;
            if (gone || r.dedup_pruned)
                log(`[agentmbx] relay sweep: ${gone} expired item(s) (${r.expired.envelope} envelope(s), ${r.expired.receipt} receipt(s), ${r.expired.expired} notice(s)), ${r.notices} expiry notice(s) queued for senders${r.notices_skipped.not_enrolled + r.notices_skipped.over_cap ? `, ${r.notices_skipped.not_enrolled + r.notices_skipped.over_cap} sender(s) not told (key gone or queue full; their own deadline alerts them)` : ""}, ${r.dedup_pruned} dedup row(s) past the horizon`);
        }
        catch (e) {
            if (!/not open|closed/i.test(e.message))
                log(`[agentmbx] relay sweep failed: ${e.message}`);
        }
    };
    sweep();
    const sweeper = setInterval(sweep, o.sweepMs ?? SWEEP_MS);
    beat.unref();
    sweeper.unref();
    server.on("close", () => { clearInterval(beat); clearInterval(sweeper); });
    return new Promise((resolve, reject) => { server.once("error", reject); server.listen(port, bind, () => resolve(server)); });
}
