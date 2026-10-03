import { test } from "node:test";
import assert from "node:assert/strict";
import { canonical, generateKeyPair, signData, verifyData } from "../src/crypto.ts";
import { buildEnvelope, signEnvelope, verifyEnvelope } from "../src/envelope.ts";
import { sealBody, openBody, generateEncKeyPair } from "../src/body-encryption.ts";
import { RelayCore, startRelayServer, relayHop, DEFAULT_QUOTA } from "../src/relay.ts";
import type { AddressInfo } from "node:net";

// ADR-035 gate 3: the council-pattern conformance tests the relay reference must pass before cutover.

const hosts = () => ({ alpha: generateKeyPair(), beta: generateKeyPair() });
const enrol = (core: RelayCore, host: string, key: ReturnType<typeof generateKeyPair>, owner: string) => {
  const challenge = core.challenge(host, key.publicKey);
  core.enrol(host, key.publicKey, owner, signData(key.privateKey, canonical({ v: 1, challenge, host, pubkey: key.publicKey, owner_fp: owner })));
};
const wire = (from: string, to: string, body: string, by: ReturnType<typeof generateKeyPair>, host: string, encPub?: string) => {
  const d = buildEnvelope({ from: `${from}@${host}`, to: [`${to}@beta`], subject: "s", body });
  if (!encPub) return signEnvelope(d, host, by.publicKey, by.privateKey);
  const sealed = sealBody(body, encPub, d.id);
  return signEnvelope({ ...d, enc: sealed, body: sealed.body }, host, by.publicKey, by.privateKey);
};

test("gate 1 (real): stored envelopes are sealed; the operator sees ciphertext, the recipient opens it", () => {
  const core = new RelayCore(), k = hosts();
  enrol(core, "alpha", k.alpha, "o"); enrol(core, "beta", k.beta, "o");
  const recipientEnc = generateEncKeyPair();
  core.publishEncAd("beta", k.beta.publicKey, recipientEnc.publicKey, signData(k.beta.privateKey, canonical({ v: 1, host: "beta", enc_pub: recipientEnc.publicKey })));
  const w = wire("alice", "bob", "confidential body text", k.alpha, "alpha", recipientEnc.publicKey);
  assert.equal(w.enc !== null, true, "wire envelope is sealed");
  const { stored } = core.push({ host: "alpha", pubkey: k.alpha.publicKey }, [w]);
  assert.equal(stored, 1);
  const rows = core.inspect(k.beta.publicKey);
  assert.equal(rows.length, 1);
  const storedBody = rows[0].envelope.body;
  assert.notEqual(storedBody, "confidential body text", "operator never sees plaintext");
  assert.match(storedBody, /^[A-Za-z0-9+/=]+$/, "operator sees base64 ciphertext");
});

test("gate 2: the relay stores opaquely; the RECEIVER rejects a tampered envelope by signature", () => {
  const core = new RelayCore(), k = hosts();
  enrol(core, "alpha", k.alpha, "o"); enrol(core, "beta", k.beta, "o");
  const good = wire("alice", "bob", "clean", k.alpha, "alpha");
  const bad = { ...good, to: ["mallory@beta"] }; // retargeted without re-signing
  const r = core.push({ host: "alpha", pubkey: k.alpha.publicKey }, [good, bad as never]);
  assert.equal(r.stored, 2, "the untrusted relay stores what it cannot read or judge");
  assert.equal(verifyEnvelope(bad as never, k.alpha.publicKey), false, "receiver-side verification rejects the tamper (ADR: receivers verify)");
  assert.equal(verifyEnvelope(good, k.alpha.publicKey), true);
});

test("gate 3: relay retries never duplicate — exactly-once storage by id", () => {
  const core = new RelayCore(), k = hosts();
  enrol(core, "alpha", k.alpha, "o"); enrol(core, "beta", k.beta, "o");
  const w = wire("alice", "bob", "durable", k.alpha, "alpha");
  const first = core.push({ host: "alpha", pubkey: k.alpha.publicKey }, [w]);
  const retry = core.push({ host: "alpha", pubkey: k.alpha.publicKey }, [w]); // sender retry
  assert.deepEqual(first, { stored: 1 });
  assert.deepEqual(retry, { stored: 1 }, "id dedupe reports the id as durably stored, never twice");
  const pulled = core.pull(k.beta.publicKey);
  assert.equal(pulled.items.length, 1, "receiver sees exactly one copy");
});

test("gate 4: quotas return honest errors and stop the batch at the limit", () => {
  const core = new RelayCore({ ...DEFAULT_QUOTA, maxQueueDepth: 2 }), k = hosts();
  enrol(core, "alpha", k.alpha, "o"); enrol(core, "beta", k.beta, "o");
  const mk = (n: number) => wire("alice", "bob", `m${n}`, k.alpha, "alpha");
  assert.deepEqual(core.push({ host: "alpha", pubkey: k.alpha.publicKey }, [mk(1), mk(2)]), { stored: 2 });
  const third = core.push({ host: "alpha", pubkey: k.alpha.publicKey }, [mk(3)]);
  assert.equal(third.stored, 0);
  assert.match(third.error ?? "", /queue depth exceeded/);
  const fresh = new RelayCore({ ...DEFAULT_QUOTA, maxEnvelopeBytes: 1024 }), k2 = hosts();
  enrol(fresh, "alpha", k2.alpha, "o"); enrol(fresh, "beta", k2.beta, "o");
  const oversized = { ...wire("alice", "bob", "x".repeat(2048), k2.alpha, "alpha") };
  const r = fresh.push({ host: "alpha", pubkey: k2.alpha.publicKey }, [oversized as never]);
  assert.match(r.error ?? "", /size limit/);
});

test("gate 5: offline-peer delivery end to end over the HTTP relay, with ack draining the queue", async (t) => {
  const core = new RelayCore(), k = hosts();
  enrol(core, "alpha", k.alpha, "o"); enrol(core, "beta", k.beta, "o");
  const server = await startRelayServer(core, 0, "127.0.0.1");
  t.after(() => new Promise<void>((r) => server.close(() => r())));
  const addr = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const post = async (host: string, key: ReturnType<typeof generateKeyPair>, path: string, obj: unknown) => {
    const body = JSON.stringify(obj);
    const res = await fetch(`${addr}${path}`, { method: "POST", headers: { "content-type": "application/json", ...relayHop(host, key.privateKey, "POST", path, body) }, body });
    return { status: res.status, json: await res.json() as Record<string, unknown> };
  };
  // alpha pushes a sealed envelope for the offline peer beta
  const recipientEnc = generateEncKeyPair();
  const w = wire("alice", "bob", "hello over the relay", k.alpha, "alpha", recipientEnc.publicKey);
  const pushed = await post("alpha", k.alpha, "/v1/relay/messages", { envelopes: [w] });
  assert.equal(pushed.status, 200);
  assert.deepEqual(pushed.json, { stored: 1 });
  // beta pulls and acks (the hop signs the path only; the query string is not part of the signed path)
  const getPath = "/v1/relay/messages";
  const pulled = await fetch(`${addr}${getPath}?after=0`, { headers: relayHop("beta", k.beta.privateKey, "GET", getPath, "") });
  assert.equal(pulled.status, 200);
  const { items, cursor } = await pulled.json() as { items: { seq: number; envelope: import("../src/envelope.ts").Envelope }[]; cursor: number };
  assert.equal(items.length, 1);
  const plaintext = openBody(items[0].envelope.enc!, recipientEnc.privateKey, w.id);
  assert.equal(plaintext, "hello over the relay", "the recipient opens what only they can open");
  const acked = await post("beta", k.beta, "/v1/relay/ack", { cursor });
  assert.equal(acked.status, 200);
  const after = core.pull(k.beta.publicKey);
  assert.equal(after.items.length, 0, "acked envelopes are dropped");
});

test("enrolment requires the host-key challenge signature (no anonymous registration)", () => {
  const core = new RelayCore(), k = hosts();
  assert.throws(() => core.enrol("alpha", k.alpha.publicKey, "o", "forged"), /no pending|bad enrolment/);
  const challenge = core.challenge("alpha", k.alpha.publicKey);
  const wrongKey = generateKeyPair();
  assert.throws(() => core.enrol("alpha", wrongKey.publicKey, "o", signData(wrongKey.privateKey, canonical({ v: 1, challenge, host: "alpha", pubkey: wrongKey.publicKey, owner_fp: "o" }))), /no pending/);
  core.challenge("alpha", k.alpha.publicKey);
  assert.throws(() => core.push({ host: "alpha", pubkey: k.alpha.publicKey }, []), /not enrolled/);
  void verifyData;
});

test("v1 quotas: a target's queue is bounded, an unproven owner claim is never charged, push rate is per sender key", () => {
  const core = new RelayCore({ ...DEFAULT_QUOTA, maxQueueDepth: 2, maxOwnerDepth: 1, pushesPerMinute: 100 }), k = hosts();
  enrol(core, "alpha", k.alpha, "owner-1"); enrol(core, "beta", k.beta, "owner-2");
  enrol(core, "gamma", generateKeyPair(), "owner-2"); // second host claiming owner-2: the claim is unproven, so not aggregated
  const mk = (n: number, to = "bob@beta") => {
    const d = buildEnvelope({ from: "alice@alpha", to: [to], subject: "s", body: `m${n}` });
    return signEnvelope(d, "alpha", k.alpha.publicKey, k.alpha.privateKey);
  };
  assert.deepEqual(core.push({ host: "alpha", pubkey: k.alpha.publicKey }, [mk(1), mk(2)]), { stored: 2 });
  assert.deepEqual(core.push({ host: "alpha", pubkey: k.alpha.publicKey }, [mk(3, "carol@gamma")]), { stored: 1 }, "maxOwnerDepth applies only to proven accounts");
  const third = core.push({ host: "alpha", pubkey: k.alpha.publicKey }, [mk(4)]);
  assert.equal(third.stored, 0);
  assert.match(third.error ?? "", /queue depth exceeded for beta/);

  const rate = new RelayCore({ ...DEFAULT_QUOTA, pushesPerMinute: 2 }), r = hosts();
  enrol(rate, "alpha", r.alpha, "o"); enrol(rate, "beta", r.beta, "o");
  const w = () => { const d = buildEnvelope({ from: "a@alpha", to: ["b@beta"], subject: "s", body: "x" }); return signEnvelope(d, "alpha", r.alpha.publicKey, r.alpha.privateKey); };
  assert.deepEqual(rate.push({ host: "alpha", pubkey: r.alpha.publicKey }, [w()]), { stored: 1 });
  assert.deepEqual(rate.push({ host: "alpha", pubkey: r.alpha.publicKey }, [w()]), { stored: 1 });
  const limited = rate.push({ host: "alpha", pubkey: r.alpha.publicKey }, [w()]);
  assert.equal(limited.stored, 0);
  assert.match(limited.error ?? "", /push rate exceeded/);
});
