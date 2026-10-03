// T311: `agentmbx status --json` emits the mbx.status/v1 document for harnesses. Identity comes
// from the T310 resolver (never a shared directory name), so the answer is right after /clear and
// before a session has claimed anything.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { MbxNode } from "../src/node.ts";
import { writeHud } from "../src/hud.ts";
import { IdentityLeases, inspectLeaseProcess } from "../src/identity-leases.ts";

const home = () => mkdtempSync(join(tmpdir(), "mbx-status-json-"));

test("status --json emits mbx.status/v1 with the resolver's identity, counts and provenance", (t) => {
  const h = home(), n = new MbxNode(h, { host: "alpha" });
  t.after(() => { n.close(); rmSync(h, { recursive: true, force: true }); });
  n.bindSession({ agent: "drum", cli: "kimi", session_id: "sess-json-1", pid: process.pid, session_key: "k" });
  new IdentityLeases(n.store).claim("drum", { pid: process.pid, start: inspectLeaseProcess(process.pid).start!, keyFp: "aaaa-bbbb-cccc-dddd", cli: "kimi", sessionId: "sess-json-1" });
  n.send({ from: "boss", to: ["drum"], subject: "one", body: "b", needs_reply: true });
  writeHud(n); // not needed for --json (it reads live) but keeps the fixture realistic
  const run = (args: string[]) => spawnSync(process.execPath, [resolve("bin/agentmbx.js"), "status", "--json", "--schema", "mbx.status/v1", ...args], {
    encoding: "utf8", env: { ...process.env, AGENTMBX_DEV: "1", MBX_HOME: h, MBX_NO_DESKTOP: "1" },
  });
  const bySession = run(["--cli", "kimi", "--session", "sess-json-1"]);
  assert.equal(bySession.status, 0, bySession.stderr);
  const doc = JSON.parse(bySession.stdout);
  assert.equal(doc.schema, "mbx.status/v1");
  assert.equal(doc.identity.name, "drum");
  assert.equal(doc.identity.state, "bound");
  assert.equal(doc.resolved_by, "session_id");
  assert.equal(doc.unread, 1);
  assert.equal(doc.needs_reply, 1);
  assert.ok("mbx_version" in doc && "update_available" in doc && "from_owner" in doc && "outbox_unsent" in doc && "policy" in doc);
  const unknown = run(["--cli", "kimi", "--session", "sess-nope"]);
  assert.equal(unknown.status, 0, unknown.stderr);
  const notBound = JSON.parse(unknown.stdout);
  assert.equal(notBound.identity.name, null, "an explicit session id that does not resolve is unbound — never the pid holder's");
  assert.equal(notBound.identity.state, "unbound");
  assert.equal(notBound.resolved_by, "none");
  const viaPid = spawnSync(process.execPath, [resolve("bin/agentmbx.js"), "status", "--json", "--schema", "mbx.status/v1", "--cli", "kimi"], {
    encoding: "utf8", env: { ...process.env, AGENTMBX_DEV: "1", MBX_HOME: h, MBX_NO_DESKTOP: "1" },
  });
  const pidDoc = JSON.parse(viaPid.stdout);
  assert.equal(pidDoc.identity.name, "drum", "with no --session at all, the provider pid binding answers");
  assert.equal(pidDoc.identity.state, "bound");
  assert.equal(pidDoc.resolved_by, "pid");
  const empty = home();
  t.after(() => rmSync(empty, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  const none = spawnSync(process.execPath, [resolve("bin/agentmbx.js"), "status", "--json", "--schema", "mbx.status/v1", "--cli", "kimi", "--session", "sess-x"], {
    encoding: "utf8", env: { ...process.env, AGENTMBX_DEV: "1", MBX_HOME: empty, MBX_NO_DESKTOP: "1" },
  });
  const unbound = JSON.parse(none.stdout);
  assert.equal(unbound.identity.name, null);
  assert.equal(unbound.identity.state, "unbound");
  assert.equal(unbound.resolved_by, "none");
  assert.equal(unbound.unread, 0);
});
