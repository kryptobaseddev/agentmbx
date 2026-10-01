import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { MbxNode } from "../src/node.ts";
import { daemonReadiness } from "../src/doctor.ts";
import { version } from "../src/version.ts";
const exec = promisify(execFile);

for (const kind of ["unverified-service", "unverified-manual", "matching-service", "matching-manual", "absent"]) test(`setup handles ${kind}`, async t => {
  const home = mkdtempSync(join(tmpdir(), "mbx-setup-daemon-")), mbx = join(home, "mail"), bin = join(home, "bin");
  mkdirSync(bin);
  const canary = join(home, "service-manager-called");
  for (const tool of ["systemctl", "launchctl"]) writeFileSync(join(bin, tool), '#!/bin/sh\nprintf called > "$MBX_TEST_SERVICE_CANARY"\nexit 42\n', { mode: 0o700 });
  let n: MbxNode;
  const server = createServer((_req, res) => {
    if (kind.startsWith("unverified")) { res.writeHead(401); res.end("another service"); }
    else res.end(JSON.stringify({ service: "agentmbx", v: 1, host: n.host, host_pubkey: n.key.publicKey, version: version(), started_at: new Date().toISOString() }));
  });
  await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
  n = new MbxNode(mbx, { host: "alpha", port: (server.address() as { port: number }).port });
  const service = process.platform === "darwin" ? join(home, "Library/LaunchAgents/com.agentmbx.daemon.plist") : join(home, ".config/systemd/user/agentmbx.service");
  if (kind.endsWith("service")) { mkdirSync(dirname(service), { recursive: true }); writeFileSync(service, "existing service definition"); }
  if (kind === "absent") await new Promise<void>(r => server.close(() => r()));
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); n.close(); rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
  // HOME is isolated and service-manager executables are canaries; no test can touch a real daemon service.
  const args = [resolve("bin/agentmbx.js"), "setup", "--only", "daemon", "--no-owner", "--yes", ...(kind === "absent" ? ["--dry-run"] : [])];
  let result: { stdout: string; stderr: string; code?: number };
  try { result = await exec(process.execPath, args, { env: { ...process.env, HOME: home, MBX_HOME: mbx, MBX_SERVICE_LABEL: "", PATH: bin, AGENTMBX_DEV: "1", MBX_TEST_SERVICE_CANARY: canary }, timeout: 20_000 }); }
  catch (e) { result = e as typeof result; }
  const output = result.stdout + result.stderr;
  assert.equal(existsSync(canary), false, output);
  if (kind.endsWith("service")) assert.equal(readFileSync(service, "utf8"), "existing service definition");
  if (kind.startsWith("unverified")) {
    assert.equal(result.code, 1, output);
    assert.match(output, /identity unverified/); assert.match(output, /automatic daemon installation skipped/);
    assert.doesNotMatch(output, /already running|would install|install failed/);
  } else if (kind === "matching-service") {
    assert.equal(result.code, undefined, output); assert.match(output, /matching AgentMBX already running/);
  } else if (kind === "matching-manual") {
    assert.equal(result.code, undefined, output); assert.match(output, /without a service definition/); assert.doesNotMatch(output, /install failed/);
  } else { assert.equal(result.code, undefined, output); assert.match(output, /would install and start/); }
});


for (const kind of ["stalled-headers", "reset", "refused"]) test(`setup probe preserves ${kind} connection evidence`, async t => {
  const home = mkdtempSync(join(tmpdir(), "mbx-setup-probe-"));
  const server = createServer((req, _res) => { if (kind === "reset") req.socket.destroy(); });
  await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
  const n = new MbxNode(home, { host: "alpha", port: (server.address() as { port: number }).port });
  if (kind === "refused") await new Promise<void>(r => server.close(() => r()));
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); n.close(); rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
  const check = await daemonReadiness(n, 100);
  assert.equal(check.state, kind === "refused" ? "unreachable" : "unverified");
});
