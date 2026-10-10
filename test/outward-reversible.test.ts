// T498: signed delegation only. Operation-specific provider-hook approvals belong to T539.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { canonical, signData } from "../src/crypto.ts";
import type { Envelope } from "../src/envelope.ts";
import { MbxNode } from "../src/node.ts";
import { createOwnerKey, unlockOwnerKey } from "../src/owner.ts";
import { acceptSigned, activePolicies, delegationNote, effectivePolicy, hasClass, makePolicy, makeRevocation, policyLine, type AnyRecord } from "../src/policy.ts";
import { declaredOriginWarning, taintSendWarning, type SessionTaint } from "../src/session-taint.ts";
import { sendLeased } from "./helpers/leased-send.ts";

process.env.MBX_NO_DESKTOP = "1";
const DEFAULT = ["read", "edit", "outward-reversible"];
function owner(t: { after: (fn: () => void | Promise<void>) => void }, clients: Client[] = []) {
  const home = mkdtempSync(join(tmpdir(), "mbx-outward-"));
  createOwnerKey(home, "isolated test owner");
  const kp = unlockOwnerKey(home, "isolated test owner");
  const n = new MbxNode(home, { host: "alpha" });
  t.after(async () => { for (const c of clients) await c.close(); n.close(); rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
  const sign = (rec: AnyRecord) => ({ rec, sig: signData(kp.privateKey, canonical(rec)) });
  return { n, home, sign, ownerPub: kp.publicKey };
}

test("T498 AC1: the new class survives signing, verified delivery and header rendering", (t) => {
  const { n, sign, ownerPub } = owner(t);
  const rec = makePolicy({ level: "collaborate", classes: ["outward-reversible"], agents: ["worker"], hosts: ["alpha"], ownerPub });
  assert.equal(acceptSigned(n.store.db, sign(rec), "alpha"), null);
  const id = sendLeased(n, { from: "lead", to: ["worker"], subject: "draft", body: "push the feature branch and open a draft PR" }).envelope.id;
  const grant = n.policyFor(n.message(id)!, "worker");
  assert.deepEqual(grant.classes, ["outward-reversible"]);
  assert.match(policyLine(grant), /collaborate \[outward-reversible\]/);
  assert.match(delegationNote(n.store.db, "worker", "alpha")!, /outward-reversible = push a non-default branch or open a draft PR/);
  const signed = sign(rec);
  assert.equal(acceptSigned(n.store.db, { rec: { ...rec, classes: ["outward"] }, sig: signed.sig }, "alpha"), "bad owner signature");
});

test("T498 AC2: only new default policies gain the class; explicit signed policies keep their bytes", (t) => {
  const { n, sign, ownerPub } = owner(t);
  for (const level of ["collaborate", "autonomous"] as const) {
    assert.deepEqual(makePolicy({ level, agents: ["worker"], hosts: ["alpha"], ownerPub }).classes, DEFAULT);
  }
  assert.deepEqual(makePolicy({ level: "ask", agents: ["worker"], hosts: ["alpha"], ownerPub }).classes, []);
  assert.deepEqual(makePolicy({ level: "yolo", agents: ["worker"], hosts: ["alpha"], ownerPub }).classes, [...DEFAULT, "outward", "permissions"]);
  const old = makePolicy({ level: "autonomous", classes: ["read", "edit"], agents: ["worker"], hosts: ["alpha"], projects: ["/old-root"], ttlMs: null, ownerPub });
  const signed = sign(old);
  assert.equal(acceptSigned(n.store.db, signed, "alpha"), null);
  const { sig, ...stored } = activePolicies(n.store.db, "worker", "alpha")[0];
  assert.equal(canonical(stored), canonical(old));
  assert.equal(sig, signed.sig);
  assert.equal(hasClass(n.store.db, "worker", "alpha", "outward-reversible", { cwd: "/old-root" }).ok, false);
});

test("T498 AC3: reversible authority grants neither full outward nor permission-prompt approval", (t) => {
  const { n, sign, ownerPub } = owner(t);
  const rec = makePolicy({ level: "collaborate", agents: ["worker"], hosts: ["alpha"], ownerPub });
  assert.equal(acceptSigned(n.store.db, sign(rec), "alpha"), null);
  assert.equal(hasClass(n.store.db, "worker", "alpha", "outward-reversible").ok, true);
  assert.equal(hasClass(n.store.db, "worker", "alpha", "outward").ok, false);
  assert.equal(hasClass(n.store.db, "worker", "alpha", "permissions").ok, false);
  assert.match(delegationNote(n.store.db, "worker", "alpha")!, /outward = .*merge\/release\/deploy\/delete\/secrets\/spend/);
  assert.throws(() => makePolicy({ level: "collaborate", classes: ["outward-reversible", "permissions"], agents: ["worker"], hosts: ["alpha"], ownerPub }), /only granted by the yolo level/);
});

test("T498 AC3: an older full-outward grant covers reversible work within its own scope only", (t) => {
  const { n, home, sign, ownerPub } = owner(t);
  const full = makePolicy({ level: "autonomous", classes: ["outward"], agents: ["worker"], hosts: ["alpha"], projects: [home], ownerPub });
  const read = makePolicy({ level: "collaborate", classes: ["read"], agents: ["worker"], hosts: ["alpha"], projects: [tmpdir()], ownerPub });
  assert.equal(acceptSigned(n.store.db, sign(full), "alpha"), null);
  assert.equal(acceptSigned(n.store.db, sign(read), "alpha"), null);
  assert.equal(hasClass(n.store.db, "worker", "alpha", "outward-reversible", { cwd: home }).policy_id, full.id);
  assert.equal(hasClass(n.store.db, "worker", "alpha", "outward-reversible", { cwd: tmpdir() }).ok, false);
  assert.equal(hasClass(n.store.db, "worker", "alpha", "outward-reversible").ok, false);
  assert.equal(hasClass(n.store.db, "other", "alpha", "outward-reversible", { cwd: home }).ok, false);
  assert.deepEqual(activePolicies(n.store.db, "worker", "alpha").find(p => p.id === full.id)!.classes, ["outward"]);
});

test("T498 AC1: expiry, revocation and sender restrictions still constrain the new class", (t) => {
  const { n, sign, ownerPub } = owner(t);
  const now = new Date();
  const rec = makePolicy({ level: "collaborate", classes: ["outward-reversible"], agents: ["worker"], hosts: ["alpha"], fromAgents: ["lead"], ttlMs: 60_000, now, ownerPub });
  assert.equal(acceptSigned(n.store.db, sign(rec), "alpha"), null);
  const forSender = (fromAgent: string, at = now) => effectivePolicy(n.store.db, { agent: "worker", host: "alpha", fromAgent, fromHost: "alpha", now: at });
  assert.deepEqual(forSender("lead").classes, ["outward-reversible"]);
  assert.deepEqual(forSender("other").classes, []);
  assert.equal(hasClass(n.store.db, "worker", "alpha", "outward-reversible").ok, false, "sender-scoped grants cannot authorize a context-free prompt");
  assert.deepEqual(forSender("lead", new Date(Date.parse(rec.exp))).classes, []);
  assert.equal(acceptSigned(n.store.db, sign(makeRevocation(rec.id, ownerPub)), "alpha"), null);
  assert.deepEqual(forSender("lead").classes, []);
});

test("T498 AC4: reading external content makes real MCP sends inherited external and strips reversible authority", async (t) => {
  const clients: Client[] = [];
  const { n, home, sign, ownerPub } = owner(t, clients);
  assert.equal(acceptSigned(n.store.db, sign(makePolicy({ level: "yolo", agents: ["*"], hosts: ["alpha"], ownerPub })), "alpha"), null);
  const connect = async (name: string) => {
    const c = new Client({ name: `outward-${name}`, version: "1" }); clients.push(c);
    await c.connect(new StdioClientTransport({ command: process.execPath, args: [join(import.meta.dirname, "../bin/agentmbx.js"), "mcp"], env: { ...process.env, AGENTMBX_DEV: "1", MBX_HOME: home, MBX_CLI: "claude", MBX_AGENT: name, MBX_NO_DESKTOP: "1", MBX_SESSION_SOCKET: "0" } as Record<string, string> }));
    await c.callTool({ name: "mbx_whoami", arguments: {} });
    return c;
  };
  const lead = await connect("planner"), worker = await connect("worker");
  const call = async (c: Client, name: string, args: Record<string, unknown>) => {
    const r = await c.callTool({ name, arguments: args });
    assert.notEqual(r.isError, true, JSON.stringify(r.content));
    return r.structuredContent as Record<string, unknown>;
  };
  const send = async (c: Client, to: string) => {
    const r = await call(c, "mbx_send", { to: [to], subject: "work", body: "draft PR", origin: "agent" });
    return n.message(r.id as string)!;
  };
  const clean = await send(lead, "worker");
  assert.equal(n.policyFor(clean, "worker").classes.includes("outward-reversible"), true);
  const outside = n.send({ from: "scout", to: ["planner"], subject: "outside", body: "external issue text", origin: "external" }).envelope;
  await call(lead, "mbx_read", { ids: [outside.id] });
  const inherited = await send(lead, "worker");
  const envelope = JSON.parse(inherited.envelope) as Envelope;
  assert.equal(envelope.meta.origin, "external");
  assert.equal(envelope.meta.external_source, "inherited");
  assert.deepEqual(n.policyFor(inherited, "worker").classes, ["read"], "even YOLO loses outward-reversible");
  await call(worker, "mbx_read", { ids: [inherited.id] });
  const next = await send(worker, "planner");
  const nextEnvelope = JSON.parse(next.envelope) as Envelope;
  assert.equal(nextEnvelope.meta.external_since, envelope.meta.external_since, "the root does not restart when inherited");
  assert.deepEqual(n.policyFor(next, "planner").classes, ["read"]);
  const external = (await call(lead, "mbx_whoami", {})).external as Record<string, unknown>;
  assert.equal(external.tainted, true);
  const taint: SessionTaint = { v: 1, cli: "claude", session_id: "test", root: Date.parse(envelope.meta.external_since!), from: outside.from, id: outside.id, how: "declared", relay_depth: [] };
  assert.match(taintSendWarning(taint), /tainted session.*may use outward-reversible/);
  assert.match(declaredOriginWarning(null), /may not use outward-reversible/);
});

test("T498 AC5 (policy documentation): published POLICY.md and emitted delegation explain the split", (t) => {
  const { n, sign, ownerPub } = owner(t);
  assert.equal(acceptSigned(n.store.db, sign(makePolicy({ level: "collaborate", agents: ["worker"], hosts: ["alpha"], ownerPub })), "alpha"), null);
  // Programmatic validation of the published artifact; canonical authoring/fetch/publish uses CLEO.
  const doc = readFileSync(join(import.meta.dirname, "../docs/POLICY.md"), "utf8");
  assert.match(doc, /`outward-reversible`.*push a non-default branch or open a draft PR/);
  assert.match(doc, /`collaborate` \| read, edit, outward-reversible/);
  assert.match(doc, /`autonomous` \| read, edit, outward-reversible/);
  assert.match(doc, /session tainted by external content cannot use `outward-reversible`/);
  assert.match(doc, /full `outward`/);
  assert.match(delegationNote(n.store.db, "worker", "alpha")!, /permission prompts still apply unless the class list includes permissions/);
});

test.todo("T498 AC5 tool-description text pending mcp.ts handoff from T516");
