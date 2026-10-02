// Status displays resolve the exact mailbox of a provider session: session id, then the provider process's live holder,
// else unbound. Never a directory name (T310).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MbxNode } from "../src/node.ts";
import { IdentityLeases } from "../src/identity-leases.ts";
import { resolveStatusIdentity } from "../src/status-identity.ts";

test("status identity: session id, then the provider pid's live holder, else unbound or ambiguous", (t) => {
  const home = mkdtempSync(join(tmpdir(), "mbx-status-id-"));
  const n = new MbxNode(home, { host: "alpha" });
  t.after(() => { n.close(); rmSync(home, { recursive: true, force: true }); });
  const leases = new IdentityLeases(n.store, { inspect: () => ({ alive: true, start: "fixture" }) });
  let k = 0;
  const hold = (name: string, sid: string, pid: number) => {
    const keyFp = `aaaa-bbbb-cccc-000${++k}`;
    leases.claim(name, { pid: process.pid, start: "fixture", keyFp, cli: "claude", sessionId: sid });
    n.store.db.prepare("INSERT INTO sessions (agent,cli,session_id,cwd,pid,session_key,channel,updated_at) VALUES (?,?,?,?,?,NULL,0,?)")
      .run(name, "claude", sid, "/shared", pid, new Date().toISOString());
  };
  hold("app-dev", "sid-a", 111);
  n.registerAgent("app"); // the folder-named mailbox another CLI registered first: never a fallback
  assert.deepEqual(resolveStatusIdentity(n, "claude", { sessionId: "sid-a" }), { name: "app-dev", state: "bound", resolved_by: "session_id" });
  assert.deepEqual(resolveStatusIdentity(n, "claude", { sessionId: "sid-after-clear", pid: 111 }), { name: "app-dev", state: "bound", resolved_by: "pid" });
  assert.deepEqual(resolveStatusIdentity(n, "claude", { sessionId: "unknown", pid: 999 }), { name: null, state: "unbound", resolved_by: null });
  assert.equal(resolveStatusIdentity(n, "codex", { sessionId: "sid-a" }).state, "unbound", "another provider's binding never matches");
  hold("app-review", "sid-b", 111);
  assert.deepEqual(resolveStatusIdentity(n, "claude", { pid: 111 }), { name: null, state: "ambiguous", resolved_by: null, candidates: ["app-dev", "app-review"] });
  const lease = n.store.db.prepare("SELECT token FROM identity_leases WHERE name='app-review'").get() as { token: string };
  leases.release("app-review", lease.token);
  assert.equal(resolveStatusIdentity(n, "claude", { pid: 111 }).name, "app-dev", "a released holder no longer counts");
});
