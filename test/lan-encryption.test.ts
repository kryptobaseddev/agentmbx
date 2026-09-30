// T028: direct LAN delivery seals every body for the receiving host; owner authority survives sealing.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo, Server } from "node:net";
import { flushOutbox, startServer } from "../src/http.ts";
import { MbxNode } from "../src/node.ts";
import { generateKeyPair } from "../src/crypto.ts";

process.env.MBX_NO_DESKTOP = "1";

async function up(host: string) {
  const home = mkdtempSync(join(tmpdir(), "mbx-lanenc-"));
  const n = new MbxNode(home, { host, bind: "127.0.0.1", port: 0 });
  const s = await startServer(n, 0, "127.0.0.1");
  return { n, s, home, addr: `127.0.0.1:${(s.address() as AddressInfo).port}` };
}
const down = (...xs: { n: MbxNode; s: Server; home: string }[]) => xs.forEach((x) => { x.s.close(); x.n.close(); rmSync(x.home, { recursive: true, force: true }); });

/** Record every request body the sender puts on the wire. */
function captureFetch(t: { after: (fn: () => void) => void }) {
  const bodies: string[] = [], real = globalThis.fetch;
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    if (typeof init?.body === "string") bodies.push(init.body);
    return real(input, init);
  }) as typeof fetch;
  t.after(() => { globalThis.fetch = real; });
  return bodies;
}

const pairFixture = (A: { n: MbxNode; addr: string }, B: { n: MbxNode; addr: string }, owners: { a?: string; b?: string } = {}) => {
  A.n.addApprovedPeer({ host: B.n.host, pubkey: B.n.key.publicKey, owner_pubkey: owners.b ?? null, addr: B.addr }, "fixture");
  B.n.addApprovedPeer({ host: A.n.host, pubkey: A.n.key.publicKey, owner_pubkey: owners.a ?? null, addr: A.addr }, "fixture");
};

test("LAN delivery learns the peer enc key, seals the body on the wire and stores plaintext on arrival", async (t) => {
  const A = await up("alpha"), B = await up("beta");
  t.after(() => down(A, B));
  pairFixture(A, B);
  const wire = captureFetch(t);
  const secret = "wire-secret-7f3a9c";
  A.n.send({ from: "mac-dev", to: ["vida-dev@beta"], subject: "sealed", body: secret });
  assert.deepEqual(await flushOutbox(A.n), { sent: 1, failed: 0 });
  assert.ok(A.n.peer("beta")!.enc_pub, "the peer enc key was learned on demand");
  const posted = wire.filter((b) => b.includes('"envelopes"'));
  assert.equal(posted.length, 1);
  assert.ok(!posted[0].includes(secret), "the plaintext body never crosses the wire");
  assert.ok(JSON.parse(posted[0]).envelopes[0].enc, "the wire envelope is sealed");
  const got = B.n.inbox("vida-dev");
  assert.equal(got.length, 1);
  assert.equal(got[0].body, secret);
  assert.equal(got[0].trust, "verified");
  const local = JSON.parse((A.n.store.db.prepare("SELECT envelope FROM messages WHERE id=?").get(got[0].id) as { envelope: string }).envelope);
  assert.equal(local.enc, null, "the sender's own copy stays unsealed plaintext (D001)");
});

test("a peer without a published enc key gets nothing: mail waits in the outbox with an upgrade hint", async (t) => {
  const A = await up("alpha"), B = await up("beta");
  t.after(() => down(A, B));
  pairFixture(A, B);
  const wire = captureFetch(t);
  const real = globalThis.fetch;
  // Simulate a pre-0.4 receiver: its enc-key endpoint does not exist.
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) =>
    String(input).endsWith("/v1/enc-key") ? new Response("not found", { status: 404 }) : real(input, init)) as typeof fetch;
  A.n.send({ from: "mac-dev", to: ["vida-dev@beta"], subject: "held", body: "must not leak" });
  assert.deepEqual(await flushOutbox(A.n), { sent: 0, failed: 0 });
  assert.equal(wire.filter((b) => b.includes('"envelopes"')).length, 0, "no envelope was posted");
  const row = A.n.store.db.prepare("SELECT attempts, last_error FROM outbox").get() as { attempts: number; last_error: string };
  assert.equal(row.attempts, 1);
  assert.match(row.last_error, /body-encryption key; upgrade AgentMBX/);
  assert.equal(B.n.inbox("vida-dev").length, 0);
});

test("owner-signed authority verifies after sealing, on arrival and when re-checked from storage", async (t) => {
  const A = await up("alpha"), B = await up("beta");
  t.after(() => down(A, B));
  const owner = generateKeyPair();
  pairFixture(A, B, { a: owner.publicKey });
  A.n.send({ from: "mac-dev", to: ["vida-dev@beta"], kind: "task", subject: "owner task", body: "do the thing" }, undefined, { pub: owner.publicKey, priv: owner.privateKey });
  assert.deepEqual(await flushOutbox(A.n), { sent: 1, failed: 0 });
  const [m] = B.n.inbox("vida-dev");
  const stored = JSON.parse(m.envelope);
  assert.ok(stored.enc, "arrived sealed");
  const auth = B.n.authorityFor(m);
  assert.equal(auth?.ok, true, `authority re-verifies from storage: ${JSON.stringify(auth)}`);
  const receipt = B.n.store.db.prepare("SELECT * FROM messages WHERE id=?").get(m.id) as Record<string, unknown>;
  assert.ok(!JSON.stringify(receipt).includes("owner signature invalid"), "arrival receipt did not record a broken owner signature");
});
