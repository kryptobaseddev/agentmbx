// Daemon-side relay transport (T007): enrol this host with a relay, publish our enc key so peers can
// seal for us, push undeliverable outbox envelopes to the relay (sealed — the relay never sees bodies),
// and poll for incoming relay mail through the normal node.receive path (signature-verified, decrypted).
import { canonical, signData, verifyData } from "./crypto.ts";
import { sealEnvelope, type Envelope } from "./envelope.ts";
import type { MbxNode } from "./node.ts";

export interface RelayRef { url: string }
/** Where the daemon learns the relay address: MBX_RELAY_URL wins, then config.json's relay field. */
export const relayFor = (node: MbxNode): string | null =>
  process.env.MBX_RELAY_URL ?? (node.config as { relay?: string }).relay ?? null;

const hop = (node: MbxNode, method: string, path: string, body: string) => {
  const ts = String(Date.now());
  const signedPath = path.replace(/^https?:\/\/[^/]+/, "").split("?")[0]; // the hop signs the pathname only
  return { "content-type": "application/json", "x-mbx-host": node.host, "x-mbx-ts": ts,
    "x-mbx-sig": signData(node.key.privateKey, canonical({ method, path: signedPath, ts, body: `${method}:${signedPath}:${ts}:${body}` })) };
};
const call = async (node: MbxNode, method: string, path: string, obj: unknown, f: typeof fetch): Promise<{ status: number; json: Record<string, unknown> }> => {
  const body = obj === undefined ? "" : JSON.stringify(obj);
  const res = await f(path, { method, headers: hop(node, method, path, body), body: body || undefined, signal: AbortSignal.timeout(10_000) }).catch(() => null);
  if (!res) return { status: 0, json: { error: "relay unreachable" } };
  return { status: res.status, json: await res.json().catch(() => ({})) as Record<string, unknown> };
};
const url = (relay: string, path: string) => `${relay.replace(/\/$/, "")}${path}`;

/** Enrolment state per relay, so restarts don't re-run the challenge dance. */
// keyed by the host key too: a rotated host (T030) enrols its new key
const enrolledFlag = (relay: string, hostPub: string) => `relay-enrolled:${relay}:${hostPub}`;

export async function relayEnrol(node: MbxNode, relay: string, f: typeof fetch = fetch): Promise<boolean> {
  if (node.store.get(enrolledFlag(relay, node.key.publicKey))) return true;
  const ownerFp = fingerprintOf(node);
  const chal = await call(node, "POST", url(relay, "/v1/relay/challenge"), { host: node.host, pubkey: node.key.publicKey }, f);
  const challenge = chal.json.challenge as string | undefined;
  if (!challenge) return false;
  const sig = signData(node.key.privateKey, canonical({ v: 1, challenge, host: node.host, pubkey: node.key.publicKey, owner_fp: ownerFp }));
  const r = await call(node, "POST", url(relay, "/v1/relay/enrol"), { host: node.host, pubkey: node.key.publicKey, owner_fp: ownerFp, sig }, f);
  if (r.status === 200) {
    node.store.set(enrolledFlag(relay, node.key.publicKey), new Date().toISOString());
    await relayPublishEnc(node, relay, f);
    return true;
  }
  return false;
}
const fingerprintOf = (node: MbxNode): string => node.store.db.prepare("SELECT fp FROM principals WHERE role='owner' AND via='local' LIMIT 1").get()?.fp as string ?? "";

export async function relayPublishEnc(node: MbxNode, relay: string, f: typeof fetch = fetch): Promise<void> {
  const enc_pub = node.encKey.publicKey;
  const sig = signData(node.key.privateKey, canonical({ v: 1, host: node.host, enc_pub }));
  await call(node, "POST", url(relay, "/v1/relay/enc-key"), { enc_pub, sig }, f);
}

/** Discover a peer's enc key through the relay (LAN enc-key exchange may be unreachable for exactly the peers we relay). */
export async function relayPeerEnc(node: MbxNode, relay: string, peerHost: string, f: typeof fetch = fetch): Promise<string | null> {
  const r = await call(node, "GET", url(relay, `/v1/relay/enc-key?host=${encodeURIComponent(peerHost)}`), undefined, f);
  return r.status === 200 && typeof r.json.enc_pub === "string" ? r.json.enc_pub : null;
}

/** Seal an outbox envelope for a peer and push it to the relay; the local outbox row is dropped on success. */
export async function relayDrainOutbox(node: MbxNode, relay: string, f: typeof fetch = fetch): Promise<{ pushed: number; failed: number }> {
  if (!await relayEnrol(node, relay, f)) return { pushed: 0, failed: 0 };
  const due = node.store.db.prepare(`SELECT o.msg_id, o.host, m.envelope FROM outbox o JOIN messages m ON m.id=o.msg_id ORDER BY o.created_at LIMIT 200`)
    .all() as { msg_id: string; host: string; envelope: string }[];
  let pushed = 0, failed = 0;
  for (const row of due) {
    const peerEnc = await relayPeerEnc(node, relay, row.host, f);
    if (!peerEnc) { failed++; continue; } // never push plaintext bodies to the relay (ADR-035)
    const e = JSON.parse(row.envelope) as Envelope;
    const wire = sealEnvelope(e, peerEnc, node.host, node.key.publicKey, node.key.privateKey);
    const r = await call(node, "POST", url(relay, "/v1/relay/messages"), { envelopes: [wire] }, f);
    if (r.status === 200) { node.store.db.prepare("DELETE FROM outbox WHERE msg_id=? AND host=?").run(row.msg_id, row.host); pushed++; }
    else failed++;
  }
  return { pushed, failed };
}

/** Poll the relay, feed envelopes through the normal signature-verified receive path, then ack the cursor. */
export async function relayPull(node: MbxNode, relay: string, f: typeof fetch = fetch): Promise<number> {
  if (!await relayEnrol(node, relay, f)) return 0;
  const cursorKey = `relay-cursor:${relay}`;
  const after = Number(node.store.get(cursorKey) ?? 0);
  const path = "/v1/relay/messages";
  const r = await f(url(relay, `${path}?after=${after}`), { headers: hop(node, "GET", path, ""), signal: AbortSignal.timeout(10_000) }).catch(() => null);
  if (!r || !r.ok) return 0;
  const { items, cursor } = await r.json() as { items: { seq: number; envelope: Envelope; from: string }[]; cursor: number };
  let received = 0;
  for (const item of items) {
    const fromHost = item.envelope.from.split("@")[1] ?? item.from;
    const res = node.receive(item.envelope, fromHost);
    if (res === "accepted" || res === "duplicate") received++;
  }
  if (typeof cursor === "number" && cursor > after) {
    await call(node, "POST", url(relay, "/v1/relay/ack"), { cursor }, f);
    node.store.set(cursorKey, String(cursor));
  }
  return received;
}
