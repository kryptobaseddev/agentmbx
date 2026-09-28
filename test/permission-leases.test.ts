import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MbxNode } from "../src/node.ts";
import { generateKeyPair, fingerprint } from "../src/crypto.ts";
import { IdentityLeases, inspectLeaseProcess } from "../src/identity-leases.ts";
import { decidePermission, approveKimi, opencodePermissionPass } from "../src/permission.ts";

const yes = () => ({ ok: true, policy_id: "test-policy" });
function fixture(t: TestContext, cli: string, sessionId = "s1") {
  const home = mkdtempSync(join(tmpdir(), "mbx-permission-lease-")), node = new MbxNode(home, { host: "alpha" });
  t.after(() => { node.close(); rmSync(home, { recursive: true, force: true }); });
  const key = generateKeyPair(), leases = new IdentityLeases(node.store);
  const holder = { pid: process.pid, start: inspectLeaseProcess(process.pid).start!, keyFp: fingerprint(key.publicKey), cli, sessionId };
  node.bindSession({ agent: "worker", cli, session_id: sessionId, pid: process.pid, session_key: key.publicKey, cwd: "/work" });
  const lease = leases.claim("worker", holder);
  const input = { session_id: sessionId, hook_event_name: "PermissionRequest", tool_name: "Bash", cwd: "/work", id: "approval_test" };
  return { node, leases, lease, holder, input };
}

test("permission process checks run before the approval transaction locks SQLite", t => {
  const { node, input } = fixture(t, "claude"), checks: boolean[] = [];
  const sameSession = node.sameSession.bind(node), kill = process.kill;
  node.sameSession = (...args) => { checks.push(node.store.db.isTransaction); return sameSession(...args); };
  process.kill = ((...args: Parameters<typeof process.kill>) => { checks.push(node.store.db.isTransaction); return kill(...args); }) as typeof process.kill;
  try {
    const result = decidePermission(input, "claude", () => { assert.equal(node.store.db.isTransaction, true); return yes(); }, { node, pid: process.pid });
    assert.equal(result.allow, true); assert.ok(checks.length > 0); assert.ok(checks.every(locked => !locked));
  } finally { process.kill = kill; node.sameSession = sameSession; }
});

for (const cli of ["claude", "codex", "kimi"]) test(`${cli} permission decision requires the live lease and matching session key`, t => {
  const { node, leases, lease, holder, input } = fixture(t, cli);
  const decide = () => decidePermission(input, cli, yes, { node, pid: process.pid });
  assert.equal(decide().allow, true);
  node.store.db.prepare("UPDATE identity_leases SET heartbeat_at=0 WHERE name='worker'").run();
  assert.equal(decide().allow, false, "expired lease cannot authorize despite a live parent process and policy");
  const other = generateKeyPair();
  leases.claim("worker", { ...holder, keyFp: fingerprint(other.publicKey) });
  assert.equal(decide().allow, false, "replacement generation belongs to a different key");
  assert.equal(leases.release("worker", lease.token), false);
});

for (const cli of ["codex", "kimi"]) test(`${cli} unknown thread cannot inherit the sole leased mailbox on a shared process`, t => {
  const { node, input } = fixture(t, cli);
  assert.equal(decidePermission({ ...input, session_id: "unbound-other-thread" }, cli, yes, { node, pid: process.pid }).allow, false);
});

for (const mutation of ["release", "replace", "rebind"]) test(`Kimi permission rechecks captured authority after polling: ${mutation}`, async t => {
  const { node, leases, lease, holder, input } = fixture(t, "kimi");
  const decision = decidePermission(input, "kimi", yes, { node, pid: process.pid });
  assert.equal(decision.allow, true);
  let posts = 0;
  const fake = (async (_url: unknown, init?: RequestInit) => {
    if (init?.method === "POST") { posts++; return Response.json({ code: 0 }); }
    if (mutation === "rebind") node.store.db.prepare("UPDATE sessions SET session_key=? WHERE session_id='s1'").run(generateKeyPair().publicKey);
    else {
      leases.release("worker", lease.token);
      if (mutation === "replace") leases.claim("worker", holder); // even the same key cannot revive an old decision
    }
    return Response.json({ code: 0, data: { items: [{ approval_id: "approval_test" }] } });
  }) as typeof fetch;
  assert.equal(await approveKimi(node, decision, { server: { url: "http://test.invalid", token: "test" }, fetch: fake, recheck: () => true }), false);
  assert.equal(posts, 0);
});

for (const mutation of ["none", "release", "replace", "rebind"]) test(`OpenCode permission rechecks captured authority before posting: ${mutation}`, async t => {
  const { node, leases, lease, holder } = fixture(t, "opencode", "ses_test");
  let posts = 0;
  const fake = (async (_url: unknown, init?: RequestInit) => {
    if (init?.method === "POST") { posts++; return new Response(null, { status: 204 }); }
    if (mutation === "rebind") node.store.db.prepare("UPDATE sessions SET session_key=? WHERE session_id='ses_test'").run(generateKeyPair().publicKey);
    if (mutation === "release" || mutation === "replace") {
      leases.release("worker", lease.token);
      if (mutation === "replace") leases.claim("worker", holder);
    }
    return Response.json({ data: [{ id: "per_test", sessionID: "ses_test", action: "Bash" }] });
  }) as typeof fetch;
  const result = await opencodePermissionPass(node, yes, async () => ({ url: "http://test.invalid", auth: "" }), fake);
  assert.equal(result, mutation === "none" ? 1 : 0);
  assert.equal(posts, mutation === "none" ? 1 : 0);
});

test("leased OpenCode provisional mailbox cannot approve an unbound same-folder session", async t => {
  const { node } = fixture(t, "opencode", "mcp-test");
  let calls = 0;
  const fake = (async () => { calls++; return Response.json({ data: [{ id: "per_test", sessionID: "ses_unknown", action: "Bash" }] }); }) as typeof fetch;
  assert.equal(await opencodePermissionPass(node, yes, async () => ({ url: "http://test.invalid", auth: "" }), fake), 0);
  assert.equal(calls, 0);
});
