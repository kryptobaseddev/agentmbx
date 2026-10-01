import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { canonical, fingerprint, generateKeyPair, signData } from "../src/crypto.ts";
import { MbxNode } from "../src/node.ts";
import { IdentityLeases } from "../src/identity-leases.ts";
import { applyIdentityTakeover, buildIdentityTakeover, type IdentityTakeoverPayload } from "../src/identity-takeover.ts";
import type { IdentityControlDescriptor } from "../src/identity-control.ts";

function setup(t: { after: (fn: () => void) => void }) {
  const home = mkdtempSync(join(tmpdir(), "mbx-takeover-")), node = new MbxNode(home, { host: "alpha" }), owner = generateKeyPair();
  writeFileSync(join(home, "owner.json"), JSON.stringify({ v: 1, backend: "keychain", public_key: owner.publicKey }), { mode: 0o600 });
  t.after(() => { node.close(); rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
  const leases = new IdentityLeases(node.store, { inspect: () => ({ alive: true, start: "fixture" }) });
  const oldKey = generateKeyPair();
  const old = leases.claim("occupied", { pid: process.pid, start: "fixture", keyFp: fingerprint(oldKey.publicKey), cli: "claude", sessionId: "old" });
  const claimant: IdentityControlDescriptor = { v: 1, cli: "codex", session_id: "new", lease_session_id: "new", control_key: "2222-2222-2222-2222",
    mcp_pid: process.pid, mcp_start: "fixture", parent_pid: process.ppid, parent_start: "fixture", agent: "detached", generation: null };
  const payload = buildIdentityTakeover(node, claimant, "occupied");
  const sign = (p: IdentityTakeoverPayload) => ({ payload: p, sig: signData(owner.privateKey, canonical(p)) });
  const replace = () => leases.claim("occupied", { pid: process.pid, start: "fixture", keyFp: claimant.control_key, cli: claimant.cli, sessionId: claimant.lease_session_id });
  const run = (p = payload, operation = replace) => leases.prepare(["occupied"], [process.pid], () => applyIdentityTakeover(node, leases, sign(p), claimant, operation));
  return { home, node, owner, leases, old, oldKey, claimant, payload, sign, replace, run };
}

test("signed takeover preserves history, fences the old holder, and is single use", t => {
  const { node, leases, old, payload, run } = setup(t);
  node.send({ from: "sender", to: ["occupied"], subject: "history", body: "kept" });
  const messages = node.store.db.prepare("SELECT * FROM messages").all();
  const next = run(); assert.notEqual(next.token, old.token);
  assert.throws(() => leases.withHeld("occupied", old.token, () => {}), { code: "IDENTITY_LEASE_LOST" });
  assert.deepEqual(node.store.db.prepare("SELECT * FROM messages").all(), messages);
  assert.equal(node.unreadCount("occupied"), 1);
  assert.ok(node.store.get(`identity-takeover-used:${payload.id}`));
  assert.throws(() => run(), /already used/);
});

test("takeover retires displaced bindings and remembered names atomically", t => {
  const { node, oldKey, run, payload } = setup(t);
  node.bindSession({ agent: "occupied", cli: "claude", session_id: "old", pid: process.pid, session_key: oldKey.publicKey });
  node.keepName("claude", "old", "occupied");
  node.store.set(`mcp-process:${oldKey.publicKey}`, "fixture");
  assert.equal(node.callerAgent([process.pid])?.agent, "occupied");
  const before = node.store.db.prepare("SELECT * FROM sessions").all();
  assert.throws(() => run(payload, () => { throw new Error("rollback cleanup"); }), /rollback cleanup/);
  assert.deepEqual(node.store.db.prepare("SELECT * FROM sessions").all(), before);
  assert.equal(node.store.get("name:claude:old"), "occupied");
  assert.equal(node.store.get(`mcp-process:${oldKey.publicKey}`), "fixture");
  run();
  assert.equal(node.callerAgent([process.pid]), null);
  assert.deepEqual(node.store.db.prepare("SELECT * FROM sessions WHERE session_key=?").all(oldKey.publicKey), []);
  assert.equal(node.store.get("name:claude:old"), undefined);
  assert.equal(node.store.get(`mcp-process:${oldKey.publicKey}`), undefined);
});

test("takeover binds canonical lease session while allowing a distinct control alias", t => {
  const { node, claimant, run, replace, leases } = setup(t);
  claimant.session_id = "hook-alias";
  const approved = buildIdentityTakeover(node, claimant, "occupied");
  assert.equal(approved.claimant_session, "hook-alias");
  assert.equal(approved.claimant_lease_session, "new");
  assert.throws(() => run(approved, () => leases.claim("occupied", { pid: process.pid, start: "fixture", keyFp: claimant.control_key, cli: claimant.cli, sessionId: "wrong" })), /did not install/);
  assert.equal(run(approved, replace).session_id, "new");
});

test("takeover failures preserve the old generation and do not consume approval", t => {
  const { node, leases, old, claimant, payload, sign, replace, run } = setup(t);
  const before = () => node.store.db.prepare("SELECT * FROM identity_leases WHERE name='occupied'").get();
  const initial = before();
  for (const p of [{ ...payload, expires_at: Date.now() - 1 }, { ...payload, host: "other" },
    { ...payload, claimant_session: "other" }, { ...payload, previous: { ...payload.previous, generation: "0".repeat(64) } }]) {
    assert.throws(() => run(p)); assert.deepEqual(before(), initial);
  }
  assert.throws(() => applyIdentityTakeover(node, leases, { payload, sig: signData(generateKeyPair().privateKey, canonical(payload)) }, claimant, replace), /signature/);
  assert.throws(() => applyIdentityTakeover(node, leases, { ...sign(payload), payload: { ...payload, name: "other" } }, claimant, replace), /signature/);
  assert.throws(() => run(payload, () => { replace(); throw new Error("receipt failure"); }), /receipt failure/);
  assert.deepEqual(before(), initial); assert.equal(node.store.get(`identity-takeover-used:${payload.id}`), undefined);
  assert.equal(leases.withHeld("occupied", old.token, () => true), true);
  assert.throws(() => run(payload, () => old), /did not install/); assert.deepEqual(before(), initial);
  assert.notEqual(run().token, old.token, "rollback leaves approval usable for the unchanged generation");
});

for (const cli of ["claude", "codex", "kimi", "opencode"]) test(`${cli} CLI owner-approved takeover reaches the existing MCP holder`, async t => {
  const client = new Client({ name: cli, version: "test" }), displaced = new Client({ name: `${cli}-old`, version: "test" });
  t.after(async () => { await client.close(); await displaced.close(); });
  const { home, node, owner } = setup(t);
  const helper = join(home, "fake-owner-helper.mjs"), crypto = new URL("../src/crypto.ts", import.meta.url).href;
  writeFileSync(join(home, "fixture-key.json"), JSON.stringify(owner), { mode: 0o600 });
  writeFileSync(helper, `#!/usr/bin/env node\nimport {readFileSync} from 'node:fs'; import {signData} from ${JSON.stringify(crypto)};
    const [cmd,file]=process.argv.slice(2); if(cmd!=='sign') process.exit(5);
    if(process.env.FIXTURE_OWNER_CANCEL==='1') process.exit(6);
    const key=JSON.parse(readFileSync(new URL('./fixture-key.json',import.meta.url),'utf8'));
    console.log(signData(key.privateKey,readFileSync(file,'utf8')));`, { mode: 0o700 });
  const fixtureToken = node.store.db.prepare("SELECT token FROM identity_leases WHERE name='occupied'").get()!.token as string;
  new IdentityLeases(node.store).release("occupied", fixtureToken);
  await displaced.connect(new StdioClientTransport({ command: process.execPath, args: [resolve("bin/agentmbx.js"), "mcp"],
    env: { ...process.env, MBX_HOME: home, MBX_AGENT: "occupied", MBX_CLI: cli, AGENTMBX_DEV: "1" } as Record<string,string> }));
  assert.equal((await displaced.callTool({ name: "mbx_whoami", arguments: {} })).isError, undefined);
  const old = node.store.db.prepare("SELECT token FROM identity_leases WHERE name='occupied'").get()!.token;
  const displacedKey = node.store.db.prepare("SELECT session_key FROM sessions WHERE agent='occupied'").get()!.session_key;
  const transport = new StdioClientTransport({ command: process.execPath, args: [resolve("bin/agentmbx.js"), "mcp"],
    env: { ...process.env, MBX_HOME: home, MBX_AGENT: "destination", MBX_CLI: cli, AGENTMBX_DEV: "1" } as Record<string,string> });
  await client.connect(transport);
  const meta = cli === "codex" ? { threadId: "44444444-4444-4444-8444-444444444444" } : cli === "opencode" ? { sessionID: "ses_takeover" } : undefined;
  const call = (name: string, args: Record<string,unknown> = {}) => client.callTool({ name, arguments: args, ...(meta ? { _meta: meta } : {}) });
  const me = (await call("mbx_whoami")).structuredContent as { agent: string };
  const sid = node.store.db.prepare("SELECT session_id FROM sessions WHERE agent=? AND session_key IS NOT NULL").get(me.agent)!.session_id as string;
  const history = node.send({ from: "sender", to: ["occupied"], subject: "history", body: "kept" }).envelope.id;
  assert.notEqual((await call("mbx_identity", { action: "release" })).isError, true);
  assert.equal((await call("mbx_identity", { action: "claim", name: "occupied" })).isError, true);
  const invoke = (force: boolean, cancel = false) => spawnSync(process.execPath, [resolve("bin/agentmbx.js"), "identity", "takeover", "occupied", ...(force ? ["--force"] : []), "--cli", cli, "--session", sid, "--json"], {
    encoding: "utf8", timeout: 10000, env: { ...process.env, MBX_HOME: home, MBX_AUTH_HELPER: helper, FIXTURE_OWNER_CANCEL: cancel ? "1" : "0", AGENTMBX_DEV: "1" },
  });
  assert.equal(invoke(false).status, 2);
  const requestCount = () => node.store.db.prepare("SELECT COUNT(*) n FROM kv WHERE k GLOB 'identity-request:*'").get()!.n;
  const beforeCancel = requestCount();
  const cancelled = invoke(true, true);
  assert.equal(cancelled.status, 1); assert.match(cancelled.stderr, /cancelled|not approved/);
  assert.equal(requestCount(), beforeCancel, "cancelling approval must not submit a control request");
  assert.equal(node.store.db.prepare("SELECT token FROM identity_leases WHERE name='occupied'").get()!.token, old);
  const messages = node.store.db.prepare("SELECT * FROM messages").all();
  node.store.db.exec(`CREATE TRIGGER reject_takeover_receipt BEFORE UPDATE ON kv
    WHEN NEW.k GLOB 'identity-request:*' AND json_extract(NEW.v,'$.status')='completed' AND json_extract(NEW.v,'$.action')='takeover'
    BEGIN SELECT RAISE(ABORT, 'injected takeover receipt failure'); END`);
  const failed = invoke(true);
  assert.equal(failed.status, 1, failed.stderr + failed.stdout);
  const receipt = JSON.parse(failed.stdout);
  assert.equal(receipt.status, "failed"); assert.match(receipt.error, /injected takeover receipt failure/);
  node.store.db.exec("DROP TRIGGER reject_takeover_receipt");
  const restored = node.store.db.prepare("SELECT token,released_at FROM identity_leases WHERE name='occupied'").get()!;
  assert.equal(restored.token, old); assert.equal(restored.released_at, null);
  assert.equal(node.store.get(`identity-takeover-used:${receipt.approval.payload.id}`), undefined);
  assert.equal((await call("mbx_whoami")).isError, true, "failed takeover restores the destination's detached in-memory state");
  assert.equal((await call("mbx_identity", { action: "claim", name: "occupied" })).isError, true);
  assert.deepEqual(node.store.db.prepare("SELECT * FROM messages").all(), messages);
  const result = invoke(true); assert.equal(result.status, 0, result.stderr + result.stdout);
  assert.equal(JSON.parse(result.stdout).status, "completed");
  assert.equal(JSON.parse(result.stdout).result.agent, "occupied");
  assert.ok(!result.stdout.includes(old as string));
  assert.equal(((await call("mbx_whoami")).structuredContent as { agent: string }).agent, "occupied");
  assert.equal((await displaced.callTool({ name: "mbx_inbox", arguments: {} })).isError, true, "displaced live MCP holder is fenced");
  assert.notEqual((await displaced.callTool({ name: "mbx_identity", arguments: { action: "list" } })).isError, true, "recovery controls stay available");
  assert.equal((await displaced.callTool({ name: "mbx_identity", arguments: { action: "claim", name: "occupied" } })).isError, true, "old holder cannot reclaim the occupied successor generation");
  assert.deepEqual(node.store.db.prepare("SELECT * FROM sessions WHERE session_key=?").all(displacedKey), []);
  assert.equal(node.inbox("occupied")[0].id, history);
  assert.equal(node.store.db.prepare("SELECT holder_pid FROM identity_leases WHERE name='occupied'").get()!.holder_pid, transport.pid);
});
