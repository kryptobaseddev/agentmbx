// T407: GET /v1/status?cli=&session= — the one core endpoint both in-harness renderers
// (the Claude mod #143 and the OpenCode sidebar T399) read. Contract:
//   cli+session  → session-scoped mbx.status snapshot (v1 shape; v2 arrives with T404)
//   unknown sid  → explicit `unbound` snapshot, never an error, never another identity (T308 AC2)
//   no params    → today's public runtime response, unchanged (peer back-compat)
//   challenge=N  → signed host status, unchanged (T151)
// Session-scoped reads are loopback-only; the guard helper is unit-tested below.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { isLoopbackRemote, signedStatus, startServer } from "../src/http.ts";
import { MbxNode } from "../src/node.ts";

const newNode = () => new MbxNode(join(mkdtempSync(join(tmpdir(), "mbx-t407-")), "store"));
/** Bind a session row the way the T310 resolver expects (store.ts keeps its own insert helpers private). */
const bindSession = (n: MbxNode, cli: string, sid: string, agent: string) =>
  n.store.db.prepare("INSERT INTO sessions (agent, cli, session_id, updated_at) VALUES (?, ?, ?, ?)")
    .run(agent, cli, sid, new Date().toISOString());

test("isLoopbackRemote covers v4, v6 and v4-mapped loopback, rejects everything else", () => {
  assert.equal(isLoopbackRemote("127.0.0.1"), true);
  assert.equal(isLoopbackRemote("::1"), true);
  assert.equal(isLoopbackRemote("::ffff:127.0.0.1"), true);
  assert.equal(isLoopbackRemote("192.168.1.5"), false);
  assert.equal(isLoopbackRemote("::ffff:192.168.1.5"), false);
  assert.equal(isLoopbackRemote("fe80::1"), false);
  assert.equal(isLoopbackRemote(""), false);
});

test("/v1/status without params keeps the public runtime response", async () => {
  const n = newNode();
  const s = await startServer(n, 0, "127.0.0.1");
  try {
    const { port } = s.address() as AddressInfo;
    const res = await fetch(`http://127.0.0.1:${port}/v1/status`);
    assert.equal(res.status, 200);
    const j = await res.json() as Record<string, unknown>;
    assert.equal(j.service, "agentmbx");
    assert.equal(j.v, 1);
    assert.ok(typeof j.host_pubkey === "string" && j.host_pubkey.length > 0);
    assert.ok(!("identity" in j), "runtime response must not carry identity-scoped data");
  } finally { s.close(); n.store.db.close?.(); }
});

test("/v1/status?cli=&session= returns the session-scoped snapshot for a bound session", async () => {
  const n = newNode();
  bindSession(n, "opencode", "ses_t407bound", "axiom-lab-staff");
  const s = await startServer(n, 0, "127.0.0.1");
  try {
    const { port } = s.address() as AddressInfo;
    const res = await fetch(`http://127.0.0.1:${port}/v1/status?cli=opencode&session=ses_t407bound`);
    assert.equal(res.status, 200);
    const j = await res.json() as { schema: string; identity: { name: string | null; state: string }; resolved_by: string; unread: number };
    assert.equal(j.schema, "mbx.status/v1");
    assert.equal(j.identity.name, "axiom-lab-staff");
    assert.equal(j.identity.state, "bound");
    assert.equal(j.resolved_by, "session_id");
    assert.equal(j.unread, 0);
  } finally { s.close(); n.store.db.close?.(); }
});

test("/v1/status?cli=&session=<unknown> is an explicit unbound snapshot, not an error, with no other identity leaked", async () => {
  const n = newNode();
  bindSession(n, "opencode", "ses_t407other", "someone-else");
  const s = await startServer(n, 0, "127.0.0.1");
  try {
    const { port } = s.address() as AddressInfo;
    const res = await fetch(`http://127.0.0.1:${port}/v1/status?cli=opencode&session=ses_t407unknown`);
    assert.equal(res.status, 200);
    const j = await res.json() as { schema: string; identity: { name: string | null; state: string }; unread: number };
    assert.equal(j.schema, "mbx.status/v1");
    assert.equal(j.identity.name, null);
    assert.equal(j.identity.state, "unbound");
    assert.equal(j.unread, 0, "unbound must not surface anyone's unread counts (T308 AC2)");
  } finally { s.close(); n.store.db.close?.(); }
});

test("/v1/status?challenge= still answers the signed host status (T151, unchanged)", async () => {  const n = newNode();
  const s = await startServer(n, 0, "127.0.0.1");
  try {
    const { port } = s.address() as AddressInfo;
    const challenge = "a".repeat(64);
    const res = await fetch(`http://127.0.0.1:${port}/v1/status?challenge=${challenge}`);
    assert.equal(res.status, 200);
    const j = await res.json() as { v: number; service: string; challenge: string; sig: string };
    assert.equal(j.service, "agentmbx");
    assert.equal(j.challenge, challenge);
    assert.ok(typeof j.sig === "string" && j.sig.length > 0);
  } finally { s.close(); n.store.db.close?.(); }
});

test("/v1/status?cli=&session=&schema=mbx.status/v2 returns the unified v2 model (T404)", async () => {
  const n = newNode();
  bindSession(n, "claude", "ses_v2bound", "axiom-lab-staff");
  n.send({ from: "boss", to: ["axiom-lab-staff"], subject: "one", body: "b" });
  n.send({ from: "boss", to: ["axiom-lab-staff"], subject: "two", body: "b", needs_reply: true });
  n.send({ from: "boss", to: ["someone-else"], subject: "not yours", body: "b" });
  const s = await startServer(n, 0, "127.0.0.1");
  try {
    const { port } = s.address() as AddressInfo;
    const res = await fetch(`http://127.0.0.1:${port}/v1/status?cli=claude&session=ses_v2bound&schema=${encodeURIComponent("mbx.status/v2")}`);
    assert.equal(res.status, 200);
    const j = await res.json() as Record<string, any>;
    assert.equal(j.schema, "mbx.status/v2");
    assert.deepEqual(j.identity, { name: "axiom-lab-staff", role: null, state: "bound" });
    assert.equal(j.inbox.unread, 2, "only the resolved identity's mail is counted (T308 AC2)");
    assert.equal(j.inbox.needs_reply, 1);
    assert.deepEqual(j.registration, { registered: false, lease: null }, "no lease claim in this fixture");
    assert.equal(j.harness.cli, "claude");
    assert.equal(j.harness.session_id, "ses_v2bound");
    assert.equal(j.harness.wake_path, "channel", "claude's wiring is the inbox channel (no channel row needed for the map)");
    assert.equal(j.resolved_by, "session_id");
    assert.deepEqual(j.devices, []);
    assert.deepEqual(j.cloud.relay, { url: null, state: "unset", last_ack: null });
    assert.equal(j.project, null, "the raw binding inserted no cwd");
    assert.ok(typeof j.mbx_version === "string");
  } finally { s.close(); n.store.db.close?.(); }
});

test("/v1/status v2 for an unknown session is an explicit unbound result", async () => {
  const n = newNode();
  bindSession(n, "claude", "ses_v2other", "someone-else");
  const s = await startServer(n, 0, "127.0.0.1");
  try {
    const { port } = s.address() as AddressInfo;
    const res = await fetch(`http://127.0.0.1:${port}/v1/status?cli=claude&session=ses_v2unknown&schema=${encodeURIComponent("mbx.status/v2")}`);
    assert.equal(res.status, 200);
    const j = await res.json() as Record<string, any>;
    assert.equal(j.schema, "mbx.status/v2");
    assert.deepEqual(j.identity, { name: null, role: null, state: "unbound" });
    assert.deepEqual(j.registration, { registered: false, lease: null });
    assert.equal(j.inbox.unread, 0, "unbound never surfaces anyone's counts (T308 AC2)");
    assert.equal(j.harness.wake_path, "none");
    assert.equal(j.project, null);
  } finally { s.close(); n.store.db.close?.(); }
});

test("/v1/status without schema keeps answering v1 (the mod migrates by adding one parameter)", async () => {
  const n = newNode();
  bindSession(n, "opencode", "ses_default", "axiom-lab-staff");
  const s = await startServer(n, 0, "127.0.0.1");
  try {
    const { port } = s.address() as AddressInfo;
    const res = await fetch(`http://127.0.0.1:${port}/v1/status?cli=opencode&session=ses_default`);
    assert.equal(res.status, 200);
    const j = await res.json() as Record<string, any>;
    assert.equal(j.schema, "mbx.status/v1");
    assert.equal(j.identity.name, "axiom-lab-staff");
  } finally { s.close(); n.store.db.close?.(); }
});

test("/v1/status POST is still 405", async () => {
  const n = newNode();
  const s = await startServer(n, 0, "127.0.0.1");
  try {
    const { port } = s.address() as AddressInfo;
    const res = await fetch(`http://127.0.0.1:${port}/v1/status`, { method: "POST" });
    assert.equal(res.status, 405);
  } finally { s.close(); n.store.db.close?.(); }
});
