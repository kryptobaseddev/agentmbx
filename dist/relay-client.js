// Daemon-side relay transport (T007): enrol this host with a relay, publish our enc key so peers can
// seal for us, push undeliverable outbox envelopes to the relay (sealed — the relay never sees bodies),
// and poll for incoming relay mail through the normal node.receive path (signature-verified, decrypted).
import { canonical, signData, verifyData } from "./crypto.js";
import { sealEnvelope } from "./envelope.js";
/** Where the daemon learns the relay address: MBX_RELAY_URL wins, then config.json's relay field. */
export const relayFor = (node) => process.env.MBX_RELAY_URL ?? node.config.relay ?? null;
const hop = (node, method, path, body) => {
    const ts = String(Date.now());
    const signedPath = path.replace(/^https?:\/\/[^/]+/, "").split("?")[0]; // the hop signs the pathname only
    return { "content-type": "application/json", "x-mbx-host": node.host, "x-mbx-ts": ts,
        "x-mbx-sig": signData(node.key.privateKey, canonical({ method, path: signedPath, ts, body: `${method}:${signedPath}:${ts}:${body}` })) };
};
const call = async (node, method, path, obj, f) => {
    const body = obj === undefined ? "" : JSON.stringify(obj);
    const res = await f(path, { method, headers: hop(node, method, path, body), body: body || undefined, signal: AbortSignal.timeout(10_000) }).catch(() => null);
    if (!res)
        return { status: 0, json: { error: "relay unreachable" } };
    return { status: res.status, json: await res.json().catch(() => ({})) };
};
const url = (relay, path) => `${relay.replace(/\/$/, "")}${path}`;
/** Enrolment state per relay, so restarts don't re-run the challenge dance. */
// keyed by the host key too: a rotated host (T030) enrols its new key
const enrolledFlag = (relay, hostPub) => `relay-enrolled:${relay}:${hostPub}`;
export async function relayEnrol(node, relay, f = fetch) {
    if (node.store.get(enrolledFlag(relay, node.key.publicKey)))
        return true;
    const ownerFp = fingerprintOf(node);
    const chal = await call(node, "POST", url(relay, "/v1/relay/challenge"), { host: node.host, pubkey: node.key.publicKey }, f);
    const challenge = chal.json.challenge;
    if (!challenge)
        return false;
    const sig = signData(node.key.privateKey, canonical({ v: 1, challenge, host: node.host, pubkey: node.key.publicKey, owner_fp: ownerFp }));
    const r = await call(node, "POST", url(relay, "/v1/relay/enrol"), { host: node.host, pubkey: node.key.publicKey, owner_fp: ownerFp, sig }, f);
    if (r.status === 200) {
        node.store.set(enrolledFlag(relay, node.key.publicKey), new Date().toISOString());
        await relayPublishEnc(node, relay, f);
        return true;
    }
    return false;
}
const fingerprintOf = (node) => node.store.db.prepare("SELECT fp FROM principals WHERE role='owner' AND via='local' LIMIT 1").get()?.fp ?? "";
export async function relayPublishEnc(node, relay, f = fetch) {
    const enc_pub = node.encKey.publicKey;
    const sig = signData(node.key.privateKey, canonical({ v: 1, host: node.host, enc_pub }));
    await call(node, "POST", url(relay, "/v1/relay/enc-key"), { enc_pub, sig }, f);
}
/** A paired peer's enc key: the pinned one, else the relay's copy only if the peer's PINNED host key signed it (the LAN
 *  enc-key exchange may be unreachable for exactly the peers we relay). The relay is untrusted: it, or anyone enrolling
 *  the peer's host name there, could otherwise hand out its own key and read the sealed bodies (T032). */
export async function relayPeerEnc(node, relay, peerHost, f = fetch) {
    const p = node.approvedPeer(peerHost);
    if (!p)
        return null;
    if (p.enc_pub)
        return p.enc_pub;
    const r = await call(node, "GET", url(relay, `/v1/relay/enc-key?host=${encodeURIComponent(peerHost)}`), undefined, f);
    const { enc_pub, sig } = r.json;
    if (r.status !== 200 || typeof enc_pub !== "string" || typeof sig !== "string")
        return null;
    if (verifyData(p.pubkey, canonical({ v: 1, host: peerHost, enc_pub }), sig))
        return enc_pub;
    node.store.audit("enc_key.rejected", { host: peerHost, via: "relay", reason: "signature does not verify against the pinned host key" });
    return null;
}
/** Seal an outbox envelope for a peer and push it to the relay; the local outbox row is dropped on success. */
export async function relayDrainOutbox(node, relay, f = fetch) {
    if (!await relayEnrol(node, relay, f))
        return { pushed: 0, failed: 0 };
    const due = node.store.db.prepare(`SELECT o.msg_id, o.host, m.envelope FROM outbox o JOIN messages m ON m.id=o.msg_id ORDER BY o.created_at LIMIT 200`)
        .all();
    let pushed = 0, failed = 0;
    for (const row of due) {
        const peerEnc = await relayPeerEnc(node, relay, row.host, f);
        if (!peerEnc) {
            failed++;
            continue;
        } // never push plaintext bodies to the relay (ADR-035)
        const e = JSON.parse(row.envelope);
        const wire = sealEnvelope(e, peerEnc, node.host, node.key.publicKey, node.key.privateKey);
        const r = await call(node, "POST", url(relay, "/v1/relay/messages"), { envelopes: [wire] }, f);
        if (r.status === 200) {
            node.store.db.prepare("DELETE FROM outbox WHERE msg_id=? AND host=?").run(row.msg_id, row.host);
            pushed++;
        }
        else
            failed++;
    }
    return { pushed, failed };
}
/** Poll the relay, feed envelopes through the normal signature-verified receive path, then ack the cursor. */
export async function relayPull(node, relay, f = fetch) {
    if (!await relayEnrol(node, relay, f))
        return 0;
    const cursorKey = `relay-cursor:${relay}`;
    const after = Number(node.store.get(cursorKey) ?? 0);
    const path = "/v1/relay/messages";
    const r = await f(url(relay, `${path}?after=${after}`), { headers: hop(node, "GET", path, ""), signal: AbortSignal.timeout(10_000) }).catch(() => null);
    if (!r || !r.ok)
        return 0;
    const { items, cursor } = await r.json();
    let received = 0;
    for (const item of items) {
        const fromHost = item.envelope.from.split("@")[1] ?? item.from;
        const res = node.receive(item.envelope, fromHost);
        if (res === "accepted" || res === "duplicate")
            received++;
    }
    if (typeof cursor === "number" && cursor > after) {
        await call(node, "POST", url(relay, "/v1/relay/ack"), { cursor }, f);
        node.store.set(cursorKey, String(cursor));
    }
    return received;
}
