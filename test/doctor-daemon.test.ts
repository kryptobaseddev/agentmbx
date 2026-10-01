import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { MbxNode } from "../src/node.ts";
import { startServer } from "../src/http.ts";
import { version } from "../src/version.ts";
import { daemonReadiness, doctor } from "../src/doctor.ts";

const port = (server: Server) => (server.address() as { port: number }).port;
const listen = (server: Server) => new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
const close = (server: Server) => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); });

test("doctor does not call an unrelated HTTP responder a healthy daemon", async t => {
  const server = createServer((_req, res) => { res.writeHead(401); res.end("unrelated service"); });
  await listen(server);
  const home = mkdtempSync(join(tmpdir(), "mbx-doctor-http-"));
  new MbxNode(home, { host: "alpha", port: port(server) }).close();
  t.after(async () => { await close(server); rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
  const checks = await doctor({ home, cmd: ["agentmbx"], which: () => null, useClis: false }, home);
  assert.equal(checks.some(c => c.level === "ok" && c.label.startsWith("daemon")), false);
  assert.ok(checks.some(c => c.level === "warn" && /identity unverified/.test(c.label)));
});


for (const defect of ["legacy", "html", "wrong-host", "wrong-key", "bad-version", "bad-time", "version-mismatch", "large", "stalled", "redirect"]) {
  test(`daemon identity probe handles ${defect} response`, async t => {
    const home = mkdtempSync(join(tmpdir(), "mbx-probe-")), n = new MbxNode(home, { host: "alpha" });
    let redirects = 0;
    const target = createServer((_req, res) => { redirects++; res.end("unexpected"); }); await listen(target);
    const server = createServer((_req, res) => {
      const body = { service: "agentmbx", v: 1, host: n.host, host_pubkey: n.key.publicKey, version: version(), started_at: new Date().toISOString() };
      if (defect === "legacy") { res.writeHead(404); return res.end(); }
      if (defect === "html") return res.end("<html>other service</html>");
      if (defect === "redirect") { res.writeHead(302, { location: `http://127.0.0.1:${port(target)}/` }); return res.end(); }
      if (defect === "large") return res.end("x".repeat(9000));
      if (defect === "stalled") { res.writeHead(200); res.write("{"); return; }
      if (defect === "wrong-host") body.host = "other";
      if (defect === "wrong-key") body.host_pubkey = "other-key";
      if (defect === "bad-version") body.version = "invalid";
      if (defect === "bad-time") body.started_at = "yesterday";
      if (defect === "version-mismatch") body.version = "999.0.0";
      res.end(JSON.stringify(body));
    }); await listen(server); n.config.port = port(server);
    t.after(async () => { await close(server); await close(target); n.close(); rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
    const check = await daemonReadiness(n, 200);
    assert.equal(check.level, "warn", check.label);
    assert.match(check.label, defect === "version-mismatch" ? /differs from CLI/ : /identity unverified/);
    assert.equal(redirects, 0);
  });
}

test("real status probe is bounded read-only metadata and does not spend pairing budget", async t => {
  const home = mkdtempSync(join(tmpdir(), "mbx-status-")), n = new MbxNode(home, { host: "alpha" });
  const server = await startServer(n, 0, "127.0.0.1"); n.config.port = port(server);
  t.after(async () => { await close(server); n.close(); rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
  for (let i = 0; i < 35; i++) {
    const check = await daemonReadiness(n);
    assert.equal(check.level, "ok", check.label); assert.match(check.label, /receipt not tested/);
  }
  const url = `http://127.0.0.1:${port(server)}`;
  const status = await (await fetch(url + "/v1/status")).json() as Record<string, unknown>;
  assert.deepEqual(Object.keys(status).sort(), ["host", "host_pubkey", "service", "started_at", "v", "version"]);
  assert.equal(status.host_pubkey, n.key.publicKey);
  assert.equal((await fetch(url + "/v1/pair/hello")).status, 200, "status probes do not consume pairing requests");
  assert.equal((await fetch(url + "/v1/status", { method: "POST" })).status, 405);
  assert.equal((await fetch(url + "/v1/agents")).status, 401, "status access does not authorize mailbox operations");
  assert.equal((n.store.db.prepare("SELECT count(*) n FROM messages").get() as { n: number }).n, 0);
  await close(server);
  const check = await daemonReadiness(n, 200); assert.equal(check.level, "fail"); assert.match(check.label, /not answering/);
});

test("doctor reports each peer's presence age and how its address was last healed (T201)", async t => {
  const home = mkdtempSync(join(tmpdir(), "mbx-doctor-heal-")), n = new MbxNode(home, { host: "alpha", port: 1 });
  t.after(() => { n.close(); rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
  n.store.db.prepare("INSERT INTO peers (host,pubkey,addr,state,created_at,approved_at) VALUES ('beta','k','127.0.0.1:9','approved',?,?)").run(new Date().toISOString(), new Date().toISOString());
  n.store.set("peer-heal:beta", JSON.stringify({ via: "verified-hop", at: "2026-10-01T16:47:43.137Z", from: "10.0.10.29:7373", to: "127.0.0.1:9" }));
  n.store.set("peer-presence-at:beta", "2026-10-01T16:43:09.116Z");
  const checks = await doctor({ home, cmd: ["agentmbx"], which: () => null, useClis: false }, home, { peerTimeoutMs: 300 });
  assert.ok(checks.some(c => c.label === "peer beta: address healed 10.0.10.29:7373 -> 127.0.0.1:9 via verified-hop at 2026-10-01T16:47:43.137Z; last presence 2026-10-01T16:43:09.116Z"),
    checks.map(c => c.label).join("\n"));
});
