import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { MbxNode } from "../src/node.ts";
import { RelayCore, startRelayServer } from "../src/relay.ts";
import { relayDrainOutbox, relayEnrol, relayFor, relayPull } from "../src/relay-client.ts";

const pair = (a: MbxNode, b: MbxNode, addr: string) => {
  a.addApprovedPeer({ host: b.host, pubkey: b.key.publicKey, owner_pubkey: null, addr }, "fixture");
  b.addApprovedPeer({ host: a.host, pubkey: a.key.publicKey, owner_pubkey: null, addr: "unused" }, "fixture");
};

test("relayFor reads MBX_RELAY_URL first, then config.json", () => {
  const home = mkdtempSync(join(tmpdir(), "mbx-relaycfg-"));
  const n = new MbxNode(home, { host: "alpha" });
  const old = process.env.MBX_RELAY_URL;
  try {
    delete process.env.MBX_RELAY_URL;
    assert.equal(relayFor(n), null);
    (n.config as { relay?: string }).relay = "http://cfg:9";
    assert.equal(relayFor(n), "http://cfg:9");
    process.env.MBX_RELAY_URL = "http://env:8";
    assert.equal(relayFor(n), "http://env:8");
  } finally {
    if (old === undefined) delete process.env.MBX_RELAY_URL; else process.env.MBX_RELAY_URL = old;
    n.close(); rmSync(home, { recursive: true, force: true });
  }
});

test("an offline paired peer receives sealed mail purely over the relay", async (t) => {
  const homes = [mkdtempSync(join(tmpdir(), "mbx-rc-a-")), mkdtempSync(join(tmpdir(), "mbx-rc-b-"))];
  const a = new MbxNode(homes[0], { host: "alpha" }), b = new MbxNode(homes[1], { host: "beta" });
  const core = new RelayCore();
  const server = await startRelayServer(core, 0, "127.0.0.1");
  t.after(() => { a.close(); b.close(); homes.forEach((h) => rmSync(h, { recursive: true, force: true })); return new Promise<void>((r) => server.close(() => r())); });
  const relay = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  pair(a, b, "unused"); // LAN addr deliberately dead: the relay is the only path
  assert.equal(await relayEnrol(a, relay), true);
  assert.equal(await relayEnrol(b, relay), true);
  assert.equal(core.getEncAd("beta")?.enc_pub, b.encKey.publicKey, "enrolment publishes the enc key for sealing");

  a.send({ from: "alice", to: ["bob@beta"], subject: "via relay", body: "sealed for the offline peer" });
  assert.equal(a.store.db.prepare("SELECT COUNT(*) n FROM outbox").get()!.n, 1);
  const drained = await relayDrainOutbox(a, relay);
  assert.deepEqual(drained, { pushed: 1, failed: 0 });
  assert.equal(a.store.db.prepare("SELECT COUNT(*) n FROM outbox").get()!.n, 0, "durable relay storage replaces the local outbox row");
  const stored = core.inspect(b.key.publicKey);
  assert.equal(stored.length, 1);
  assert.notEqual(stored[0].envelope.body, "sealed for the offline peer", "relay stored ciphertext only");

  const received = await relayPull(b, relay);
  assert.equal(received, 1);
  const inbox = b.inbox("bob");
  assert.equal(inbox.length, 1);
  assert.match(inbox[0].body, /sealed for the offline peer/, "receive decrypted and routed the relayed envelope");
  assert.equal(await relayPull(b, relay), 0, "cursor ack drained the queue");
  assert.equal(core.inspect(b.key.publicKey).length, 0);
  // a replayed pull after ack yields nothing: exactly-once at the receiver too
  const again = await relayPull(b, relay);
  assert.equal(again, 0);
  assert.equal(b.inbox("bob").length, 1, "duplicate ids never re-deliver");
});

test("relayDrainOutbox refuses to push plaintext when the peer published no enc key", async (t) => {
  const homes = [mkdtempSync(join(tmpdir(), "mbx-rc2-a-")), mkdtempSync(join(tmpdir(), "mbx-rc2-b-"))];
  const a = new MbxNode(homes[0], { host: "alpha" }), b = new MbxNode(homes[1], { host: "beta" });
  const core = new RelayCore();
  const server = await startRelayServer(core, 0, "127.0.0.1");
  t.after(() => { a.close(); b.close(); homes.forEach((h) => rmSync(h, { recursive: true, force: true })); return new Promise<void>((r) => server.close(() => r())); });
  const relay = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  pair(a, b, "unused");
  await relayEnrol(a, relay);
  await relayEnrol(b, relay);
  // strip beta's enc advertisement: without it the relay must not carry bodies
  (core as unknown as { encAds: Map<string, unknown> }).encAds.delete("beta");
  a.send({ from: "alice", to: ["bob@beta"], subject: "x", body: "plaintext must not flow" });
  const drained = await relayDrainOutbox(a, relay);
  assert.deepEqual(drained, { pushed: 0, failed: 1 });
  assert.equal(core.inspect(b.key.publicKey).length, 0, "no plaintext ever reaches the relay");
  assert.equal(a.store.db.prepare("SELECT COUNT(*) n FROM outbox").get()!.n, 1, "mail stays queued for a later retry");
});
