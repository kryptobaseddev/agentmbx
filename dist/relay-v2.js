// Durable relay client (T166, docs/spec/relay-durability.md §3, §4, §5, §9, §10). A row goes to the relay only after it
// failed twice on the LAN and its backoff is due; its sealed bytes are persisted before the first push and reused on
// every retry; it leaves the outbox only on a valid accept signed by the pinned relay key, then waits in relay_sent for
// the target's delivery receipt or the sender-side deadline. The receiving side processes items in seq order, keeps
// what it cannot accept in quarantine, checkpoints, and only then acks. An epoch change (a restore) or a queue head
// below the checkpoint makes senders re-push and receivers re-pull; dedup on both ends makes that safe.
// T168 (spec §1, §8): the relay key is pinned by the owner (`relay set --key`) or on first use, and a changed key stops
// relay use; enrolment and this host's enc-key ad are reconciled against the relay's own store on every session (a
// local flag is only a cache), so a reset, restore, lost row or rotation re-enrols with a signed challenge; a peer's
// enc key comes only from a signed, current advertisement naming that peer's pinned key; every failure leaves mail
// queued and records what happened for doctor.
import { canonical, fingerprint, signData, verifyData } from "./crypto.js";
import { encFromRelayAnswer, ENC_AD_REFRESH_MS, signEncAd } from "./enc-ad.js";
import { sealEnvelope } from "./envelope.js";
import { rotationLog } from "./key-rotation.js";
import { acceptReceipt, receiptsSent, signReceipt } from "./remote-receipts.js";
import { createHash } from "node:crypto";
/** A LAN row moves to the relay after this many failed LAN attempts (spec §10). */
export const RELAY_AFTER_ATTEMPTS = 2;
/** Sender-side grace after the relay's retention before an unconfirmed relay delivery is reported (spec §3). */
export const RELAY_DEADLINE_GRACE_MS = 24 * 3_600_000;
const PAGES_PER_TICK = 20;
export function relayState(node, relay) {
    try {
        return JSON.parse(node.store.get(`relay-state:${relay}`) ?? "null");
    }
    catch {
        return null;
    }
}
/** `at` is when this state began: an unchanged state is not rewritten every tick. */
function setState(node, relay, st) {
    const { at, ...prev } = relayState(node, relay) ?? {};
    if (at && JSON.stringify(prev) === JSON.stringify(st))
        return;
    node.store.set(`relay-state:${relay}`, JSON.stringify({ ...st, at: new Date().toISOString() }));
}
const delKv = (node, k) => node.store.db.prepare("DELETE FROM kv WHERE k=?").run(k);
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
    return { status: res.status, json: await res.json().catch(() => ({})), date: res.headers.get("date") };
}
/** GET /v2/relay/info: the info, or the HTTP status that came instead (0 = unreachable). Signed when a node is given,
 *  so the answer says whether the relay's store knows this host (`you`). */
async function fetchInfo(relay, f, node) {
    const path = "/v2/relay/info";
    const res = await f(`${base(relay)}${path}`, { ...(node ? { headers: hop(node, "GET", path, "") } : {}), signal: AbortSignal.timeout(10_000) }).catch(() => null);
    if (!res)
        return { info: null, status: 0 };
    if (res.status !== 200)
        return { info: null, status: res.status };
    const j = await res.json().catch(() => null);
    return { info: j && j.v === 2 && typeof j.relay_pubkey === "string" && typeof j.epoch === "string" && j.limits ? j : null, status: 200 };
}
export async function relayInfo(relay, f = fetch) { return (await fetchInfo(relay, f)).info; }
/**
 * How to use this relay this tick. v1 is allowed only for a relay that answers 404 to /v2/relay/info and never spoke v2
 * to us (no pinned key): v1 senders drop a row on any 200, so falling back after a key change, an enrolment failure
 * or an error would lose mail silently. Anything else that is not a usable v2 session skips the relay for this tick.
 */
export async function relayRoute(node, relay, f = fetch) {
    const { info, status } = await fetchInfo(relay, f, node);
    if (!info) {
        if (status === 404 && !kv(node, `relay-key:${relay}`))
            return { mode: "v1" };
        const why = status ? `relay info answered ${status}` : "relay unreachable";
        setState(node, relay, { state: "unreachable", detail: why, status });
        return { mode: "skip", why };
    }
    const session = await relayOpen(node, relay, f, info).catch(() => null);
    return session ? { mode: "v2", session } : { mode: "skip", why: "relay session could not open (see doctor)" };
}
/** `relay set --key` accepts a fingerprint as `agentmbx relay serve` prints it (any case, with or without dashes) or the
 *  full base64 relay public key. Null when it is neither. */
export function parseRelayFingerprint(s) {
    const t = s.trim();
    if (t.length === 44 && /^[A-Za-z0-9+/]{43}=$/.test(t) && Buffer.from(t, "base64").length === 32)
        return fingerprint(t);
    const hex = t.toLowerCase().replace(/[-:\s]/g, "");
    return /^[0-9a-f]{16}$/.test(hex) ? hex.match(/.{4}/g).join("-") : null;
}
/** The pinned relay key decides (spec §1): pinned → it must match; none pinned but `relay set --key` named one → pin
 *  only that; neither → pin on first use. A mismatch stops relay use until the owner confirms (relay set --key). */
function checkRelayKey(node, relay, served) {
    const pinned = kv(node, `relay-key:${relay}`), expect = kv(node, `relay-key-expect:${relay}`), mk = `relay-key-mismatch:${relay}`;
    const want = pinned ? fingerprint(pinned) : expect;
    if (want && (pinned ? pinned !== served : expect !== fingerprint(served))) {
        const how = pinned ? "pinned" : "expected", got = fingerprint(served);
        const prev = kv(node, mk);
        if (!prev || JSON.parse(prev).served !== got)
            node.store.audit("relay.key_changed", { relay, [how]: want, served: got });
        node.store.set(mk, JSON.stringify({ how, pinned: want, served: got, at: new Date().toISOString() }));
        setState(node, relay, { state: "key-mismatch", detail: `${how} ${want}, served ${got}`, relay_fp: got });
        return false; // never trust accepts from another key; the owner confirms the new key (agentmbx relay set --key)
    }
    if (!pinned) {
        node.store.set(`relay-key:${relay}`, served);
        node.store.set(`relay-key-src:${relay}`, expect ? "owner" : "first use");
        if (expect)
            delKv(node, `relay-key-expect:${relay}`);
    }
    if (kv(node, mk))
        delKv(node, mk);
    return true;
}
/**
 * `agentmbx relay set <url> [--key <fingerprint>]` (spec §1). With --key, the relay must serve exactly that key or
 * nothing is pinned (fail closed); an unreachable relay records the expectation, and the daemon then pins only that key.
 * Without --key the served key is pinned now and shown, so the owner can compare it; a key that differs from the one
 * already pinned is refused until the owner confirms it with --key.
 */
export async function relayPin(node, relay, key, f = fetch) {
    const want = key === undefined ? null : parseRelayFingerprint(key);
    if (key !== undefined && !want)
        return { ok: false, message: `--key ${key}: not a relay key fingerprint (16 hex digits such as 1a2b-3c4d-5e6f-7a8b, as agentmbx relay serve and relay keygen print it)` };
    const pinned = kv(node, `relay-key:${relay}`);
    const { info, status } = await fetchInfo(relay, f);
    if (!info) {
        const why = status ? `answered ${status} to /v2/relay/info` : "is unreachable";
        if (!want)
            return { ok: true, message: `relay ${relay} ${why} right now: the daemon pins its key on first contact (trust on first use). To pin it without that: agentmbx relay set ${relay} --key <fingerprint>` };
        if (pinned && fingerprint(pinned) === want)
            return { ok: true, message: `relay ${relay} ${why} right now; its pinned key ${want} already matches --key` };
        if (pinned) {
            delKv(node, `relay-key:${relay}`);
            node.store.audit("relay.key_confirmed", { relay, from: fingerprint(pinned), to: want, pending: true });
        }
        node.store.set(`relay-key-expect:${relay}`, want);
        delKv(node, `relay-key-mismatch:${relay}`);
        return { ok: true, message: `relay ${relay} ${why} right now: the daemon will use it only when it serves key ${want}` };
    }
    const served = fingerprint(info.relay_pubkey);
    if (want && want !== served)
        return { ok: false, message: `relay ${relay} serves key ${served}, not ${want}: nothing was pinned and the relay is not used. Compare the fingerprint with the one its operator published (agentmbx relay serve prints it)` };
    if (!want && pinned && pinned !== info.relay_pubkey)
        return { ok: false, message: `relay ${relay} now serves key ${served}, not the pinned ${fingerprint(pinned)}: relay use stays stopped. If its operator rotated the relay key, confirm it: agentmbx relay set ${relay} --key ${served}` };
    if (pinned && pinned !== info.relay_pubkey)
        node.store.audit("relay.key_confirmed", { relay, from: fingerprint(pinned), to: served });
    const already = pinned === info.relay_pubkey;
    node.store.set(`relay-key:${relay}`, info.relay_pubkey);
    if (want || !already)
        node.store.set(`relay-key-src:${relay}`, want ? "owner" : "relay set");
    delKv(node, `relay-key-expect:${relay}`);
    delKv(node, `relay-key-mismatch:${relay}`);
    return { ok: true, message: want ? `relay key ${served} pinned (confirmed with --key)` : already ? `relay key ${served} (already pinned)`
            : `relay key ${served} pinned: compare it with the fingerprint the relay operator published, or pin it explicitly with --key ${served}` };
}
/**
 * Open a v2 session for this tick: check the relay key against the pin (T168: `relay set --key`, else first use; a
 * changed key stops relay use), notice an epoch change, hand the relay any key rotation it has not seen, make sure the
 * relay's store has this host enrolled and its current enc-key ad, and publish the senders it accepts. Null: nothing
 * goes over the relay this tick, and relayState says why.
 */
export async function relayOpen(node, relay, f = fetch, given) {
    const info = given ?? (await fetchInfo(relay, f, node)).info;
    if (!info)
        return null;
    if (!checkRelayKey(node, relay, info.relay_pubkey))
        return null;
    const s = { relay, info, f };
    const known = kv(node, `relay-epoch:${relay}`);
    if (known !== info.epoch) {
        if (known)
            relayEpochChanged(node, relay, info.epoch, "epoch");
        else
            node.store.set(`relay-epoch:${relay}`, info.epoch);
    }
    await announceRotationsToRelay(node, s);
    const enrolled = await ensureEnrolled(node, s);
    if (!enrolled)
        return null;
    const ad = await ensureEncAd(node, s);
    if (!ad.ok) {
        // enrolled a moment ago, then the first signed call is refused: the relay checks hop timestamps (±5 min), so this
        // host's clock is the likely cause. Back off instead of re-enrolling every tick, and say so.
        if (enrolled === "enrolled" && ad.status === 401)
            clockSkew(node, s, ad.date);
        else
            setState(node, relay, { state: "enc-ad-failed", status: ad.status, detail: ad.detail, relay_fp: fingerprint(info.relay_pubkey), epoch: info.epoch });
        return null;
    }
    delKv(node, `relay-enrol-backoff:${relay}`);
    await publishSenders(node, s);
    setState(node, relay, { state: "ok", relay_fp: fingerprint(info.relay_pubkey), epoch: info.epoch, enc_ad_exp: ad.exp });
    return s;
}
/** The relay rejects a hop whose timestamp is more than 5 minutes from its clock. */
const HOP_WINDOW_MS = 300_000;
/** Enrolment retries after a likely clock skew: 1 min, doubling, at most 1 h. */
export const ENROL_BACKOFF_BASE_MS = 60_000, ENROL_BACKOFF_MAX_MS = 3_600_000;
function clockSkew(node, s, date) {
    const k = `relay-enrol-backoff:${s.relay}`, now = Date.now();
    let prev = null;
    try {
        prev = JSON.parse(kv(node, k) ?? "null");
    }
    catch { /* start over */ }
    const n = (prev?.n ?? 0) + 1, next = new Date(now + Math.min(ENROL_BACKOFF_BASE_MS * 2 ** (n - 1), ENROL_BACKOFF_MAX_MS)).toISOString();
    node.store.set(k, JSON.stringify({ n, next_at: next }));
    const relayNow = date ? Date.parse(date) : NaN, off = Number.isFinite(relayNow) ? now - relayNow : NaN;
    const detail = Number.isFinite(off) && Math.abs(off) > HOP_WINDOW_MS
        ? `this host's clock is about ${Math.round(Math.abs(off) / 60_000)} min ${off > 0 ? "ahead of" : "behind"} the relay's (the relay accepts 5)`
        : "this host's clock is likely more than 5 min off the relay's";
    if (n === 1)
        node.store.audit("relay.clock_skew", { relay: s.relay, off_ms: Number.isFinite(off) ? off : null });
    setState(node, s.relay, { state: "clock-skew", status: 401, detail, next_at: next, relay_fp: fingerprint(s.info.relay_pubkey), epoch: s.info.epoch });
}
/**
 * Enrolment is what the relay's store says, not what a local flag remembers (spec §8, G6): the signed info answer carries
 * `you` only when the store has this key enrolled. Without it (a reset or restored store, a lost row, a rotation the relay
 * has not bound, a revocation) the host runs the signed challenge again; a refusal leaves every queued row where it is.
 * The kv flag, keyed by (relay, host key, relay key, epoch), only records the last confirmed enrolment.
 */
async function ensureEnrolled(node, s) {
    const flag = `relay-enrolled-v2:${s.relay}:${node.key.publicKey}:${s.info.relay_pubkey}:${s.info.epoch}`;
    if (s.info.you?.pubkey === node.key.publicKey && s.info.you.host === node.host) { // a renamed host re-enrols to carry its name
        if (!kv(node, flag))
            node.store.set(flag, new Date().toISOString());
        return "confirmed";
    }
    // a likely clock skew stopped the last attempt: wait out the backoff (a signed answer above ends it at once)
    try {
        const bo = JSON.parse(kv(node, `relay-enrol-backoff:${s.relay}`) ?? "null");
        if (bo?.next_at && Date.parse(bo.next_at) > Date.now())
            return false;
    }
    catch { /* malformed: try now */ }
    if (kv(node, flag))
        node.store.audit("relay.enrolment_lost", { relay: s.relay, epoch: s.info.epoch });
    node.store.db.prepare("DELETE FROM kv WHERE k LIKE ?").run(`relay-enrolled-v2:${s.relay}:%`);
    const failed = (status, error) => {
        const detail = `${status ? `${status}: ` : ""}${String(error ?? "") || (status ? "refused" : "relay unreachable")}`.slice(0, 300);
        node.store.audit("relay.enrol_failed", { relay: s.relay, status, error: String(error ?? "") });
        setState(node, s.relay, { state: "enrol-failed", status, detail, relay_fp: fingerprint(s.info.relay_pubkey), epoch: s.info.epoch });
        return false;
    };
    const ownerFp = node.store.db.prepare("SELECT fp FROM principals WHERE role='owner' AND via='local' LIMIT 1").get()?.fp ?? "";
    const chal = await call(s, node, "POST", "/v1/relay/challenge", { host: node.host, pubkey: node.key.publicKey });
    const challenge = chal.json.challenge;
    if (typeof challenge !== "string")
        return failed(chal.status, chal.json.error);
    const sig = signData(node.key.privateKey, canonical({ v: 1, challenge, host: node.host, pubkey: node.key.publicKey, owner_fp: ownerFp }));
    const r = await call(s, node, "POST", "/v1/relay/enrol", { host: node.host, pubkey: node.key.publicKey, owner_fp: ownerFp, sig });
    if (r.status !== 200)
        return failed(r.status, r.json.error);
    node.store.set(flag, new Date().toISOString());
    // a store that just (re-)enrolled us holds nothing else of ours: republish the enc-key ad and the sender list to it
    delKv(node, `relay-enc-ad:${s.relay}`);
    delKv(node, `relay-senders:${s.relay}`);
    node.store.audit("relay.enrolled", { relay: s.relay, epoch: s.info.epoch, relay_key: fingerprint(s.info.relay_pubkey) });
    return "enrolled";
}
/**
 * This host's enc-key ad at the relay (spec §8): a signed, expiring v2 record, plus the v1 pair older senders verify.
 * Republished when the relay's store lacks it or holds another key (a reset, a lost row, a rotation), when this host's
 * keys or the relay epoch change, and once a day. Every result is checked. The v1 pair is best effort once the v2 record
 * is stored: a relay that retired /v1 (404 or 410) is audited once and never stops relay use. Returns the v2 expiry
 * (null: the relay is too old to store v2 ads, so v1 is all it carries and must succeed).
 */
async function ensureEncAd(node, s) {
    const k = `relay-enc-ad:${s.relay}`, retiredK = `relay-enc-v1-retired:${s.relay}`, now = Date.now(), mine = node.encKey.publicKey;
    let cur = null;
    try {
        cur = JSON.parse(kv(node, k) ?? "null");
    }
    catch { /* republish */ }
    const served = s.info.you?.enc_ad, v1Retired = !!kv(node, retiredK); // undefined: a relay older than T168 does not say
    // the v2 record (enc_pub, exp) and, unless the relay retired v1, the v1 pair must name this host's current key
    const drift = served === null || (served !== undefined && (served.enc_pub !== mine || (!v1Retired && served.v1 !== mine) || !served.exp || Date.parse(served.exp) <= now));
    if (cur && !drift && cur.host_pubkey === node.key.publicKey && cur.enc_pub === mine && cur.epoch === s.info.epoch && now - Date.parse(cur.iat) < ENC_AD_REFRESH_MS)
        return { ok: true, exp: cur.exp };
    if (cur && drift)
        node.store.audit("relay.enc_ad_missing", { relay: s.relay, v2: served?.enc_pub ? fingerprint(served.enc_pub) : null, v1: served?.v1 ? fingerprint(served.v1) : null });
    const { ad, sig } = signEncAd(node.host, node.key, mine, now);
    const v2 = await call(s, node, "POST", "/v2/relay/enc-key", { ad, sig });
    const refused = (r, shape) => {
        node.store.audit("relay.enc_publish_failed", { relay: s.relay, shape, status: r.status, error: String(r.json.error ?? "") });
        return { ok: false, status: r.status, detail: `${r.status}: ${String(r.json.error ?? "refused")}`.slice(0, 300), date: r.date };
    };
    if (v2.status !== 200 && v2.status !== 404)
        return refused(v2, "v2"); // 404: a relay older than T168
    const v1 = await call(s, node, "POST", "/v1/relay/enc-key", { enc_pub: mine, sig: signData(node.key.privateKey, canonical({ v: 1, host: node.host, enc_pub: mine })) });
    if (v1.status === 200) {
        if (v1Retired)
            delKv(node, retiredK);
    }
    else if (v2.status !== 200)
        return refused(v1, "v1"); // an old relay carries only v1
    else if (v1.status === 404 || v1.status === 410) {
        if (!v1Retired) {
            node.store.audit("relay.enc_v1_retired", { relay: s.relay, status: v1.status });
            node.store.set(retiredK, new Date(now).toISOString());
        }
    }
    else
        node.store.audit("relay.enc_publish_failed", { relay: s.relay, shape: "v1", status: v1.status, error: String(v1.json.error ?? ""), fatal: false });
    const exp = v2.status === 200 ? ad.exp : null;
    node.store.set(k, JSON.stringify({ host_pubkey: node.key.publicKey, enc_pub: mine, iat: ad.iat, exp, epoch: s.info.epoch }));
    return { ok: true, exp };
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
        if (res.status === 200) { // our queue was re-sequenced under the new key: read it again from the start
            node.store.db.prepare("UPDATE relay_position SET received_through=0, updated_at=? WHERE relay=?").run(new Date().toISOString(), s.relay);
            node.store.db.prepare("DELETE FROM kv WHERE k LIKE ?").run(`relay-acked:${s.relay}:%`);
        }
    }
}
/** Tell the relay which sender keys we accept: our approved peers (spec §2). Only fake keys are kept out; republished
 *  whenever the peer set changes. */
async function publishSenders(node, s) {
    const all = [...new Set(node.peers().filter((p) => p.state === "approved").map((p) => p.pubkey))].sort();
    if (all.length > 1024)
        node.store.audit("relay.senders_truncated", { relay: s.relay, peers: all.length, kept: 1024 });
    const senders = all.slice(0, 1024);
    const digest = createHash("sha256").update(`${node.key.publicKey}:${senders.join(",")}`).digest("hex"), k = `relay-senders:${s.relay}`;
    if (kv(node, k) === digest)
        return;
    const list = { v: 1, type: "relay-senders", host_pubkey: node.key.publicKey, senders, iat: new Date().toISOString() };
    const r = await call(s, node, "POST", "/v2/relay/senders", { list, sig: signData(node.key.privateKey, canonical(list)) });
    if (r.status === 200)
        node.store.set(k, digest);
    else
        node.store.audit("relay.senders_failed", { relay: s.relay, status: r.status, error: String(r.json.error ?? "") });
}
/** The reason prefix doctor reports as a replayed (rolled-back) enc-key ad. */
export const ROLLBACK_REASON = "rolled back";
/**
 * The verdict on a relay's enc-key answer for a peer: its key, or null with the reason recorded for doctor
 * (`relay-enc-rejected:<host>`, cleared once a valid ad arrives or the key is pinned) and an audit when a served ad was
 * refused. Rollback guard: the newest accepted ad per peer host key is remembered (`relay-enc-newest:<host key>`), and an
 * ad that is not newer yet names another enc key is refused. The relay may replay any unexpired ad, so without this an
 * enc.key regenerated under the same host key could be rolled back to one nobody holds. An older ad naming the same
 * key changes nothing and is accepted (a publisher's clock may step back).
 */
export function relayEncVerdict(node, peer, status, got) {
    const k = `relay-enc-rejected:${peer.host}`;
    if ("enc_pub" in got && got.iat) {
        const nk = `relay-enc-newest:${peer.pubkey}`;
        let newest = null;
        try {
            newest = JSON.parse(kv(node, nk) ?? "null");
        }
        catch { /* none */ }
        if (newest && got.enc_pub !== newest.enc_pub && Date.parse(got.iat) <= Date.parse(newest.iat))
            got = { reason: `${ROLLBACK_REASON}: the relay served an ad from ${got.iat} naming key ${fingerprint(got.enc_pub)}, not newer than the ad from ${newest.iat} naming ${fingerprint(newest.enc_pub)} already accepted` };
        else if (!newest || Date.parse(got.iat) > Date.parse(newest.iat))
            node.store.set(nk, JSON.stringify({ iat: got.iat, enc_pub: got.enc_pub }));
    }
    if ("enc_pub" in got) {
        if (kv(node, k))
            delKv(node, k);
        return got.enc_pub;
    }
    if (status === 0)
        return null; // unreachable: nothing was learned
    let prev = null;
    try {
        prev = JSON.parse(kv(node, k) ?? "null");
    }
    catch { /* replaced below */ }
    if (status === 200 && prev?.reason !== got.reason)
        node.store.audit("enc_key.rejected", { host: peer.host, via: "relay", reason: got.reason });
    node.store.set(k, JSON.stringify({ reason: got.reason, at: new Date().toISOString() }));
    return null;
}
/** A peer's enc key: the pinned one, else the relay's copy only as a signed, current v2 ad by the peer's pinned host key
 *  naming that key and host (T032, T168). Tampered, expired, wrong-peer, unsigned and unexpiring v1 ads are refused. */
async function peerEnc(node, s, host) {
    const p = node.approvedPeer(host);
    if (!p)
        return null;
    if (p.enc_pub)
        return relayEncVerdict(node, p, 200, { enc_pub: p.enc_pub }); // pinned (LAN or rotation): no relay ad needed
    const r = await call(s, node, "GET", `/v2/relay/enc-key?pubkey=${encodeURIComponent(p.pubkey)}`);
    const got = r.status === 200 ? encFromRelayAnswer(r.json, { host, pubkey: p.pubkey })
        : { reason: r.status === 404 ? "the relay holds no advertisement for this peer" : `the relay answered ${r.status}` };
    return relayEncVerdict(node, p, r.status, got);
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
        // signed once and kept: a re-signed receipt (e.g. a did recorded later) would be a conflict at the relay
        let w = node.store.db.prepare("SELECT item_id, wire FROM relay_receipt_wire WHERE seq=?").get(row.seq);
        if (!w) {
            const signed = signReceipt(node, row);
            w = { item_id: `receipt:${signed.rec.msg}:${signed.rec.recipient}:${signed.rec.seq}`, wire: Buffer.from(canonical(signed)) };
            node.store.db.prepare("INSERT INTO relay_receipt_wire (seq,item_id,wire,created_at) VALUES (?,?,?,?)").run(row.seq, w.item_id, w.wire, iso(now));
        }
        items.push({ seq: row.seq, id: w.item_id, target: peer.pubkey, wire: Buffer.from(w.wire) });
    }
    if (!items.length)
        return 0;
    const r = await call(s, node, "POST", "/v2/relay/items", { items: items.map((i) => ({ kind: "receipt", item_id: i.id, targets: [{ host_pubkey: i.target, wire_b64: i.wire.toString("base64") }] })) });
    const results = Array.isArray(r.json.results) ? r.json.results : [];
    const sent = r.status === 200 ? items.filter((i) => validAccept(s, node, results.find((x) => x?.item_id === i.id), i.id, i.target, sha256hex(i.wire))) : [];
    if (sent.length)
        receiptsSent(node, sent.map((i) => i.seq)); // also drops their kept bytes
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
/** The host an envelope says it comes from: the host receive() checks the pairing of. */
const envelopeHost = (e) => typeof e?.from === "string" ? e.from.split("@")[1] ?? "" : "";
/** Process one relay item. True when it is done (accepted, duplicate or quarantined). */
function processItem(node, relay, epoch, it) {
    const wire = Buffer.from(it.wire_b64, "base64");
    let result;
    try {
        const v = JSON.parse(wire.toString("utf8"));
        if (it.kind === "envelope") {
            const e = v;
            result = node.receive(e, envelopeHost(e));
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
/**
 * Items quarantined only because their sender was not paired yet get another chance once it is: once the host the
 * envelope names is paired with the key that pushed it (T333). The sender key being paired is not enough. receive()
 * checks the envelope's host, so a key paired under another host name (the published allowlist lets it push, but the
 * envelope names a host we never paired) failed again and was re-quarantined, and audited, on every tick. Now a retried
 * item either lands or fails for another reason, and is never retried again.
 */
function retryUnpairedQuarantine(node, relay) {
    const keys = node.peers().filter((p) => p.state === "approved").map((p) => p.pubkey);
    if (!keys.length)
        return 0;
    let n = 0, tried = 0;
    const rows = node.store.db.prepare(`SELECT epoch, seq, kind, item_id, sender_pubkey, wire FROM relay_quarantine WHERE relay=? AND reason='rejected:host not paired'
    AND sender_pubkey IN (SELECT value FROM json_each(?)) ORDER BY at, seq`).all(relay, JSON.stringify(keys));
    for (const r of rows) {
        if (tried >= 100)
            break;
        let host = "";
        try {
            host = envelopeHost(JSON.parse(Buffer.from(r.wire).toString("utf8")));
        }
        catch {
            continue;
        }
        if (node.approvedPeer(host)?.pubkey !== r.sender_pubkey)
            continue; // the key receive() verifies the envelope with
        tried++;
        node.store.db.prepare("DELETE FROM relay_quarantine WHERE relay=? AND epoch=? AND seq=?").run(relay, r.epoch, r.seq);
        const res = processItem(node, relay, r.epoch, { seq: r.seq, kind: r.kind, item_id: r.item_id, sender_pubkey: r.sender_pubkey, wire_b64: Buffer.from(r.wire).toString("base64") });
        if (res === "accepted")
            n++;
    }
    return n;
}
/** Pull, process in seq order, checkpoint, then ack (spec §4). Returns how many items were accepted. */
export async function relayReceive(node, s) {
    let accepted = retryUnpairedQuarantine(node, s.relay);
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
            node.store.db.prepare("DELETE FROM relay_wire WHERE msg_id=? AND host=?").run(r.msg_id, r.host);
            node.send({ from: "mbx", to: [e.from.split("@")[0]], kind: "alert", subject: `Undelivered/unconfirmed to ${r.host}: ${e.subject}`,
                body: `Message ${e.id} to host ${r.host}: ${why}.` });
        });
    }
    return { settled, unconfirmed: late.length };
}
