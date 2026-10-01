import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { MbxNode } from "../src/node.ts";
import { buildEnvelope } from "../src/envelope.ts";
import { flushOutbox, signHop, startServer } from "../src/http.ts";
import { sendLeased } from "./helpers/leased-send.ts";

test("unsupported peers retain queued mail without legacy fallback, then deliver after upgrade", async t => {
  const homes = [mkdtempSync(join(tmpdir(), "mbx-compat-a-")), mkdtempSync(join(tmpdir(), "mbx-compat-b-"))];
  const a = new MbxNode(homes[0], { host: "alpha" }), b = new MbxNode(homes[1], { host: "beta" });
  const paths: string[] = [];
  let oldDeliveries = 0, redirect = false;
  let server = createServer((req, res) => {
    paths.push(req.url!); req.resume(); res.setHeader("connection", "close");
    if (req.url === "/v1/envelopes") { oldDeliveries++; res.writeHead(200).end('{"results":[]}'); }
    else if (redirect) res.writeHead(307, { location: "/v1/envelopes" }).end();
    else res.writeHead(404).end("old receiver: unknown endpoint");
  });
  t.after(async () => { await new Promise<void>(resolve => server.close(() => resolve())); a.close(); b.close(); homes.forEach(h => rmSync(h, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })); });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port, addr = `127.0.0.1:${port}`;
  a.addApprovedPeer({ host: "beta", pubkey: b.key.publicKey, owner_pubkey: null, addr }, "fixture");
  b.addApprovedPeer({ host: "alpha", pubkey: a.key.publicKey, owner_pubkey: null, addr: "unused" }, "fixture");
  a.store.db.prepare("UPDATE peers SET enc_pub=? WHERE host='beta'").run(b.encKey.publicKey); // learned earlier (T028): exercise the v2 path
  const unverified = a.send({ from: "sender", to: ["recipient@beta"], subject: "unverified", body: "readable" }).envelope;
  const leased = sendLeased(a, { from: "sender", to: ["recipient@beta"], subject: "leased", body: "verified holder" }).envelope;
  assert.deepEqual(await flushOutbox(a), { sent: 0, failed: 0 });
  assert.deepEqual(paths, ["/v2/envelopes"]); assert.equal(oldDeliveries, 0);
  const queued = a.store.db.prepare("SELECT attempts,last_error FROM outbox").all();
  assert.equal(queued.length, 2); assert.ok(queued.every(r => r.attempts === 1 && /upgrade.*no legacy fallback/.test(String(r.last_error))));
  assert.equal(b.inbox("recipient").length, 0);
  redirect = true;
  assert.deepEqual(await flushOutbox(a, Date.now() + 60_000), { sent: 0, failed: 0 });
  assert.deepEqual(paths, ["/v2/envelopes", "/v2/envelopes"]); assert.equal(oldDeliveries, 0, "redirects cannot silently downgrade delivery");
  assert.equal(a.store.db.prepare("SELECT count(*) n FROM outbox").get()?.n, 2);
  await new Promise<void>(resolve => server.close(() => resolve()));
  server = await startServer(b, port, "127.0.0.1");
  assert.deepEqual(await flushOutbox(a, Date.now() + 120_000), { sent: 2, failed: 0 }, JSON.stringify(a.store.db.prepare("SELECT attempts,next_at,last_error FROM outbox").all()));
  assert.equal(a.store.db.prepare("SELECT count(*) n FROM outbox").get()?.n, 0);
  assert.deepEqual(b.inbox("recipient").map(m => m.id).sort(), [unverified.id, leased.id].sort());
  assert.equal(b.policyFor(b.message(unverified.id)!, "recipient").level, "ask");
  // Old senders may upload historical mail, but receive no sender proof merely by using v1.
  const draft = { from: "legacy", to: ["recipient@beta"], subject: "old sender", body: "missing marker" };
  const old = a.send(draft, undefined, undefined, buildEnvelope({ ...draft, from: "legacy@alpha" })).envelope;
  const body = JSON.stringify({ envelopes: [old] }), path = "/v1/envelopes";
  assert.equal((await fetch(`http://${addr}${path}`, { method: "POST", headers: signHop(a, "POST", path, body), body })).status, 200);
  assert.equal(b.policyFor(b.message(old.id)!, "recipient").level, "ask");
  assert.equal((await fetch(`http://${addr}/v2/envelopes`, { method: "POST", headers: signHop(a, "POST", path, body), body })).status, 401, "the hop signature binds the endpoint");
});
