// T406: `agentmbx status --cli <provider> --session <id> --json --schema mbx.status/v2` emits the
// unified v2 model (src/status-schema.ts) through the same T310 resolver rules as the v1 HUD branch:
// no lease needed, an explicit --session that does not resolve is unbound, never another identity.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { MbxNode } from "../src/node.ts";
import { IdentityLeases, inspectLeaseProcess } from "../src/identity-leases.ts";

const home = () => mkdtempSync(join(tmpdir(), "mbx-status-v2-"));

const statusJson = (h: string, args: string[]) =>
  spawnSync(process.execPath, [resolve("bin/agentmbx.js"), "status", ...args, "--json"],
    { encoding: "utf8", env: { ...process.env, AGENTMBX_DEV: "1", MBX_HOME: h, MBX_NO_DESKTOP: "1" } });

test("status --schema mbx.status/v2 emits the v2 model for a bound session", (t) => {
  const h = home(), n = new MbxNode(h, { host: "alpha" });
  t.after(() => { n.close(); rmSync(h, { recursive: true, force: true }); });
  n.bindSession({ agent: "drum", cli: "kimi", session_id: "sess-v2", pid: process.pid, session_key: "k" });
  new IdentityLeases(n.store).claim("drum", { pid: process.pid, start: inspectLeaseProcess(process.pid).start!, keyFp: "aaaa-bbbb-cccc-dddd", cli: "kimi", sessionId: "sess-v2" });
  n.send({ from: "boss", to: ["drum"], subject: "one", body: "b", needs_reply: true });
  const r = statusJson(h, ["--cli", "kimi", "--session", "sess-v2", "--schema", "mbx.status/v2"]);
  assert.equal(r.status, 0, r.stderr);
  const j = JSON.parse(r.stdout) as Record<string, any>;
  assert.equal(j.schema, "mbx.status/v2");
  assert.equal(j.identity.name, "drum");
  assert.equal(j.identity.state, "bound");
  assert.equal(j.inbox.unread, 1);
  assert.equal(j.inbox.needs_reply, 1);
  assert.equal(j.harness.cli, "kimi");
  assert.equal(j.harness.session_id, "sess-v2");
  assert.equal(j.harness.wake_path, "watcher", "terminal kimi wakes through the watcher");
  assert.equal(j.registration.lease.verified, true, "the holder pid is this live test process");
  assert.equal(j.resolved_by, "session_id");
});

test("status --schema mbx.status/v2 for an unknown session is unbound, not an error", (t) => {
  const h = home(), n = new MbxNode(h, { host: "alpha" });
  t.after(() => { n.close(); rmSync(h, { recursive: true, force: true }); });
  n.bindSession({ agent: "drum", cli: "kimi", session_id: "sess-other", pid: process.pid, session_key: "k" });
  const r = statusJson(h, ["--cli", "kimi", "--session", "sess-nope", "--schema", "mbx.status/v2"]);
  assert.equal(r.status, 0, r.stderr);
  const j = JSON.parse(r.stdout) as Record<string, any>;
  assert.equal(j.schema, "mbx.status/v2");
  assert.deepEqual(j.identity, { name: null, role: null, state: "unbound" });
  assert.equal(j.inbox.unread, 0, "unbound never surfaces another identity's counts");
});
