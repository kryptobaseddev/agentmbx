import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { MbxNode } from "../src/node.ts";
import { refreshPeerEncKeys, signHop, startServer } from "../src/http.ts";

const encPub = (n: MbxNode, host: string) => (n.store.db.prepare("SELECT enc_pub FROM peers WHERE host=?").get(host) as { enc_pub: string | null } | undefined)?.enc_pub ?? null;

test("peers learn each other's enc keys over the authenticated channel", async (t) => {
  const homes = [mkdtempSync(join(tmpdir(), "mbx-enk-a-")), mkdtempSync(join(tmpdir(), "mbx-enk-b-"))];
  const a = new MbxNode(homes[0], { host: "alpha" }), b = new MbxNode(homes[1], { host: "beta" });
  const server = await startServer(b, 0, "127.0.0.1");
  t.after(async () => { await new Promise<void>((r) => server.close(() => r())); a.close(); b.close(); homes.forEach((h) => rmSync(h, { recursive: true, force: true })); });
  const addr = `127.0.0.1:${(server.address() as AddressInfo).port}`;
  a.addApprovedPeer({ host: "beta", pubkey: b.key.publicKey, owner_pubkey: null, addr }, "fixture");
  b.addApprovedPeer({ host: "alpha", pubkey: a.key.publicKey, owner_pubkey: null, addr: "unused" }, "fixture");

  assert.equal(encPub(a, "beta"), null, "no enc key before the exchange");
  await refreshPeerEncKeys(a);
  assert.equal(encPub(a, "beta"), b.encKey.publicKey, "alpha pins beta's enc key");
  const learned = a.store.db.prepare("SELECT detail FROM audit WHERE event='enc_key.learned'").all() as { detail: string }[];
  assert.equal(learned.length, 1);

  await refreshPeerEncKeys(a); // idempotent: already known, no second fetch needed
  assert.equal(a.store.db.prepare("SELECT COUNT(*) n FROM audit WHERE event='enc_key.learned'").get()!.n, 1);
});

test("an enc key that does not verify against the pinned host key is refused and audited", async (t) => {
  const homes = [mkdtempSync(join(tmpdir(), "mbx-enk-mitm-")), mkdtempSync(join(tmpdir(), "mbx-enk-b-"))];
  const a = new MbxNode(homes[0], { host: "alpha" }), b = new MbxNode(homes[1], { host: "beta" });
  const server = await startServer(b, 0, "127.0.0.1");
  t.after(async () => { await new Promise<void>((r) => server.close(() => r())); a.close(); b.close(); homes.forEach((h) => rmSync(h, { recursive: true, force: true })); });
  const addr = `127.0.0.1:${(server.address() as AddressInfo).port}`;
  const attacker = new MbxNode(mkdtempSync(join(tmpdir(), "mbx-enk-x-")), { host: "beta" }); // same name, different keys
  a.addApprovedPeer({ host: "beta", pubkey: attacker.key.publicKey, owner_pubkey: null, addr }, "fixture");
  b.addApprovedPeer({ host: "alpha", pubkey: a.key.publicKey, owner_pubkey: null, addr: "unused" }, "fixture");

  await refreshPeerEncKeys(a);
  assert.equal(encPub(a, "beta"), null, "the response signed by the real beta cannot verify against the attacker's pinned key");
  const rejected = a.store.db.prepare("SELECT detail FROM audit WHERE event='enc_key.rejected'").all() as { detail: string }[];
  assert.equal(rejected.length, 1);
  attacker.close();
});

test("the enc-key endpoint answers only to authenticated peers", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "mbx-enk-solo-"));
  const n = new MbxNode(home, { host: "solo" });
  const server = await startServer(n, 0, "127.0.0.1");
  t.after(async () => { await new Promise<void>((r) => server.close(() => r())); n.close(); rmSync(home, { recursive: true, force: true }); });
  const addr = `127.0.0.1:${(server.address() as AddressInfo).port}`;
  const anon = await fetch(`http://${addr}/v1/enc-key`);
  assert.equal(anon.status, 401, "no hop signature, no key material");
  const path = "/v1/enc-key";
  const authed = await fetch(`http://${addr}${path}`, { headers: signHop(n, "GET", path, "") });
  assert.equal(authed.status, 401, "a self-signed hop from an unpaired host is also refused");
});
