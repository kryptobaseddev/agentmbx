// Untrusted store-and-forward relay — reference implementation (ADR-035, T007).
// The relay holds no private keys and decides nothing: it stores opaque envelopes in per-host queues,
// authenticates hosts by their existing host signing keys (challenge-signature enrolment), enforces
// per-owner quotas, and never sees plaintext bodies (wire envelopes carry sealed bodies, T028).
import { createServer } from "node:http";
import { canonical, signData, verifyData, nonce as newNonce } from "./crypto.js";
import { checkShape } from "./envelope.js";
export const DEFAULT_QUOTA = { maxQueueDepth: 1000, maxEnvelopeBytes: 256 * 1024 * 2, maxBatch: 200, maxOwnerDepth: 2000, pushesPerMinute: 120 };
export class RelayCore {
    enrolments = new Map(); // pubkey -> enrolment
    queues = new Map(); // recipient host pubkey -> queue
    cursors = new Map();
    seen = new Set(); // global id dedupe: exactly-once storage
    pending = new Map(); // host -> enrolment challenge nonce
    pushes = new Map(); // owner_fp -> push timestamps (rate window)
    quota;
    constructor(quota = DEFAULT_QUOTA) { this.quota = quota; }
    /** Aggregate stored rows across every host enrolled under one owner fingerprint. */
    ownerDepth(ownerFp) {
        const pubs = new Set([...this.enrolments.values()].filter((e) => e.owner_fp === ownerFp).map((e) => e.pubkey));
        let depth = 0;
        for (const [pub, q] of this.queues)
            if (pubs.has(pub))
                depth += q.length;
        return depth;
    }
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
    challenge(host, pubkey) {
        const n = newNonce();
        this.pending.set(pubkey, n);
        return n;
    }
    /** Enrolment step 2: the host signs (challenge, its key, its claimed owner); the relay verifies and binds. */
    enrol(host, pubkey, owner_fp, sig) {
        const n = this.pending.get(pubkey);
        if (!n)
            throw new Error("no pending enrolment challenge");
        if (!verifyData(pubkey, canonical({ v: 1, challenge: n, host, pubkey, owner_fp }), sig))
            throw new Error("bad enrolment signature");
        this.pending.delete(pubkey);
        this.enrolments.set(pubkey, { host, pubkey, owner_fp, at: new Date().toISOString() });
    }
    requireEnrolled(pubkey) {
        const e = this.enrolments.get(pubkey);
        if (!e)
            throw new Error("host is not enrolled");
        return e;
    }
    /** A host publishes its enc key, signed by its host key; any enrolled host can read it (T028 via relay). */
    encAds = new Map();
    publishEncAd(host, pubkey, encPub, sig) {
        const e = this.requireEnrolled(pubkey);
        if (e.host !== host)
            throw new Error("host mismatch");
        if (!verifyData(pubkey, canonical({ v: 1, host, enc_pub: encPub }), sig))
            throw new Error("bad enc-key signature");
        this.encAds.set(host, { host, enc_pub: encPub });
    }
    getEncAd(host) { return this.encAds.get(host) ?? null; }
    /** Push envelopes addressed to recipient host keys. Opaque storage; bodies must already be sealed. */
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
            if (Buffer.byteLength(JSON.stringify(e)) > this.quota.maxEnvelopeBytes)
                return { stored, error: "envelope over size limit" };
            if (this.seen.has(e.id)) {
                stored++;
                continue;
            } // exactly-once: a relay retry confirms durable storage, never duplicates
            for (const recipient of e.to) {
                const hostPart = recipient.split("@")[1];
                const target = [...this.enrolments.values()].find((en) => en.host === hostPart);
                if (!target)
                    return { stored, error: `recipient host not enrolled: ${hostPart}` };
                if (this.ownerDepth(target.owner_fp) >= this.quota.maxOwnerDepth)
                    return { stored, error: `owner queue depth exceeded for ${hostPart}` };
                const q = this.queues.get(target.pubkey) ?? [];
                if (q.length >= this.quota.maxQueueDepth)
                    return { stored, error: `queue depth exceeded for ${hostPart}` };
                const seq = (this.cursors.get(target.pubkey) ?? 0) + 1;
                this.cursors.set(target.pubkey, seq);
                q.push({ seq, envelope: e, from: from.host, at: new Date().toISOString() });
                this.queues.set(target.pubkey, q);
            }
            this.seen.add(e.id);
            stored++;
        }
        return { stored };
    }
    /** Pull everything after a cursor for an enrolled host. */
    pull(pubkey, after = 0) {
        this.requireEnrolled(pubkey);
        const q = this.queues.get(pubkey) ?? [];
        const items = q.filter((r) => r.seq > after).map(({ seq, envelope, from }) => ({ seq, envelope, from }));
        return { items, cursor: this.cursors.get(pubkey) ?? 0 };
    }
    /** Ack a cursor: the host got everything up to here; the relay drops it. */
    ack(pubkey, cursor) {
        this.requireEnrolled(pubkey);
        const q = this.queues.get(pubkey) ?? [];
        this.queues.set(pubkey, q.filter((r) => r.seq > cursor));
    }
    /** Test/ops introspection: how a relay operator sees stored mail — bodies must be sealed. */
    inspect(pubkey) { return [...(this.queues.get(pubkey) ?? [])]; }
}
// ---- HTTP adapter --------------------------------------------------------------------------------
const readBody = (req) => new Promise((r) => { let b = ""; req.on("data", (c) => b += c); req.on("end", () => r(b)); });
/** Hop-style auth for enrolled hosts, reusing the same signed-hop shape as host-to-host HTTP. */
export const relayHop = (host, priv, method, path, body, now = Date.now()) => ({
    "x-mbx-host": host, "x-mbx-ts": String(now), "x-mbx-sig": signData(priv, canonical({ method, path, ts: String(now), body: `${method}:${path}:${now}:${body}` })),
});
export function startRelayServer(core, port = 0, bind = "127.0.0.1") {
    const byHost = new Map([...core.enrolments.values()].map((e) => [e.host, e]));
    const server = createServer(async (req, res) => {
        const send = (code, obj) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(obj)); };
        try {
            const url = new URL(req.url ?? "/", "http://x");
            const body = await readBody(req);
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
                    byHost.set(j.host, core.enrolments.get(j.pubkey));
                    return send(200, { ok: true });
                }
                catch (e) {
                    return send(401, { error: e.message });
                }
            }
            // below here requires an enrolled, hop-authenticated host
            const h = req.headers["x-mbx-host"], ts = req.headers["x-mbx-ts"], sig = req.headers["x-mbx-sig"];
            const enrol = h ? byHost.get(h) : undefined;
            if (!enrol || !ts || !sig || Math.abs(Date.now() - Number(ts)) > 300_000
                || !verifyData(enrol.pubkey, canonical({ method: req.method ?? "GET", path: url.pathname, ts, body: `${req.method}:${url.pathname}:${ts}:${body}` }), sig))
                return send(401, { error: "bad relay hop" });
            if (req.method === "POST" && url.pathname === "/v1/relay/messages") {
                const { envelopes } = JSON.parse(body);
                if (!Array.isArray(envelopes))
                    return send(400, { error: "bad batch" });
                const r = core.push({ host: enrol.host, pubkey: enrol.pubkey }, envelopes);
                return send(r.error && r.stored === 0 ? 413 : 200, r);
            }
            if (req.method === "GET" && url.pathname === "/v1/relay/messages") {
                const after = Number(url.searchParams.get("after") ?? 0);
                return send(200, core.pull(enrol.pubkey, after));
            }
            if (req.method === "POST" && url.pathname === "/v1/relay/ack") {
                const { cursor } = JSON.parse(body);
                core.ack(enrol.pubkey, Number(cursor ?? 0));
                return send(200, { ok: true });
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
    return new Promise((resolve, reject) => { server.once("error", reject); server.listen(port, bind, () => resolve(server)); });
}
