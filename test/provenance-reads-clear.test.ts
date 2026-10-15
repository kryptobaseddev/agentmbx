import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { canonical, fingerprint, generateKeyPair, sha256, signData } from "../src/crypto.ts";
import { buildEnvelope, EXTERNAL_TAINT_MS, readContentProvenance, signEnvelope, type Envelope } from "../src/envelope.ts";
import { MbxNode, messageReadView } from "../src/node.ts";
import { sessionClearanceSummary } from "../src/owner.ts";
import { issueSigned, makeRevocation, type Signed } from "../src/policy.ts";
import { acceptSessionClearance, buildSessionClearance, currentSessionClearance, readSessionExposure, readSessionTaint,
  recordSessionExposure, sessionUntainted, taintKey, validateSessionClearance, writeSessionTaint, type SessionClearance } from "../src/session-taint.ts";

const NOW = Date.now() - 1000;
function fixture(t: { after(fn: () => void | Promise<void>): void }) {
  const home = mkdtempSync(join(tmpdir(), "mbx-read-clear-")), owner = generateKeyPair();
  writeFileSync(join(home, "owner.json"), JSON.stringify({ v: 1, backend: "keychain", public_key: owner.publicKey, created_at: new Date(NOW).toISOString() }), { mode: 0o600 });
  const node = new MbxNode(home, { host: "alpha" }); node.registerAgent("reader");
  t.after(() => { node.close(); rmSync(home, { recursive: true, force: true }); });
  const scope = { host: "alpha", cli: "claude", session_id: "sessionA", project_key: home };
  const raw = (body = "PAYLOAD_MARKER " + "x".repeat(600), at = NOW) => {
    const e = buildEnvelope({ from: "sender@alpha", to: ["reader"], subject: "SUBJECT_MARKER", body, origin: "external", refs: ["FILE_MARKER"] }, new Date(at));
    e.meta.sender_verification = "leased";
    e.meta.provenance = { v: 2, kind: "firsthand-outside", content_sha256: sha256(body), parents: [], roots: [{ message_id: e.id, from: e.from, content_sha256: sha256(body), since: e.ts }] };
    const signed = signEnvelope(e, "alpha", node.key.publicKey, node.key.privateKey);
    node.store.insertMessage(signed, "local", "local", null); node.store.addDelivery(signed.id, "reader"); return signed;
  };
  const expose = (e: Envelope, now = NOW) => recordSessionExposure(node.store, "alpha", scope.cli, scope.session_id, e, node.provenanceSources(e), now);
  const sign = (rec: SessionClearance): Signed<SessionClearance> => ({ rec, sig: signData(owner.privateKey, canonical(rec)) });
  const prepare = () => { const e = raw(); expose(e); return sign(buildSessionClearance(node.store, scope, owner.publicKey, "clear", "reviewed current inputs", 15 * 60_000, NOW)); };
  return { home, node, owner, scope, raw, expose, sign, prepare };
}

test("metadata exposes identifiers/counts/policy and root digests without sender text or exposure", t => {
  const f = fixture(t), e = f.raw(), row = f.node.read(e.id, "reader");
  const view = messageReadView(f.node, row, "reader", "metadata", NOW), encoded = JSON.stringify(view);
  for (const marker of ["PAYLOAD_MARKER", "SUBJECT_MARKER", "FILE_MARKER"]) assert.equal(encoded.includes(marker), false);
  assert.equal(view.id, e.id); assert.equal(view.counts.body_bytes, Buffer.byteLength(e.body)); assert.equal(view.provenance.roots[0].content_sha256, sha256(e.body));
  f.node.observeRead(row, f.scope.cli, f.scope.session_id, "metadata", NOW);
  assert.equal(readSessionExposure(f.node.store, "alpha", f.scope.cli, f.scope.session_id, NOW).record, null);
  assert.equal(f.node.store.get(taintKey(f.scope.cli, f.scope.session_id)), undefined);
});
test("sender-controlled thread/reply/project/tag/filename fields cannot leak through metadata", t => {
  const f = fixture(t), e = f.raw();
  e.thread = "THREAD_MARKER"; e.reply_to = "REPLY_MARKER"; e.meta.project = "PROJECT_MARKER"; e.meta.tags = ["TAG_MARKER"];
  const signed = signEnvelope(e, "alpha", f.node.key.publicKey, f.node.key.privateKey), row = { ...f.node.read(e.id), envelope: JSON.stringify(signed), thread: e.thread, reply_to: e.reply_to };
  const view = messageReadView(f.node, row, "reader", "metadata", NOW);
  assert.equal(view.thread, null); assert.equal(view.reply_to, null);
  assert.equal(/MARKER/.test(JSON.stringify(view)), false);
});
test("quarantine is a labelled bounded derived read; full opening separately records raw exposure", t => {
  const f = fixture(t), e = f.raw("UNTRUSTED " + "😀".repeat(600)), row = f.node.read(e.id);
  const view = messageReadView(f.node, row, "reader", "quarantine", NOW + 10);
  assert.match(view.warning!, /UNTRUSTED derived-outside/); assert.equal(view.summary!.returned_characters, 512); assert.equal(view.summary!.truncated, true);
  assert.equal(view.provenance.kind, "derived-outside"); assert.deepEqual(view.provenance.parents, [e.id]);
  f.node.observeRead(row, f.scope.cli, f.scope.session_id, "quarantine", NOW + 10);
  const first = readSessionExposure(f.node.store, "alpha", f.scope.cli, f.scope.session_id, NOW + 10).record!;
  assert.equal(first.roots[0].raw_at, null); assert.equal(first.roots[0].derived_at, NOW + 10); assert.equal(first.roots[0].source.since, e.ts);
  f.node.observeRead(row, f.scope.cli, f.scope.session_id, "quarantine", NOW + 20);
  assert.deepEqual(readSessionExposure(f.node.store, "alpha", f.scope.cli, f.scope.session_id, NOW + 20).record, first);
  f.node.observeRead(row, f.scope.cli, f.scope.session_id, "full", NOW + 30);
  const full = readSessionExposure(f.node.store, "alpha", f.scope.cli, f.scope.session_id, NOW + 30).record!;
  assert.equal(full.roots[0].raw_at, NOW + 30); assert.equal(full.roots[0].source.since, e.ts);
  assert.equal(readSessionTaint(f.node.store, f.scope.cli, f.scope.session_id, NOW + 30)!.root, NOW + 30);
});
test("quarantine inherits old source time without declassification or a renewed derived root", t => {
  const f = fixture(t), e = f.raw("old outside text", NOW - EXTERNAL_TAINT_MS * 2), row = f.node.read(e.id);
  f.node.observeRead(row, f.scope.cli, f.scope.session_id, "quarantine", NOW);
  assert.equal(readSessionExposure(f.node.store, "alpha", f.scope.cli, f.scope.session_id, NOW).record!.roots[0].source.since, e.ts);
  assert.equal(messageReadView(f.node, row, "reader", "quarantine", NOW).provenance.kind, "derived-outside");
  assert.equal(readSessionTaint(f.node.store, f.scope.cli, f.scope.session_id, NOW), null);
});
test("v1 repeated raw reads A/B/A keep each first local disclosure inside the hour", t => {
  const f = fixture(t), a = f.raw("A"), b = f.raw("B", NOW + 10);
  delete a.meta.provenance; delete b.meta.provenance;
  const row = (e: Envelope) => ({ ...f.node.read(e.id), envelope: JSON.stringify(signEnvelope(e, "alpha", f.node.key.publicKey, f.node.key.privateKey)) });
  f.node.observeRead(row(a), f.scope.cli, f.scope.session_id, "full", NOW);
  f.node.observeRead(row(b), f.scope.cli, f.scope.session_id, "full", NOW + 10);
  f.node.observeRead(row(a), f.scope.cli, f.scope.session_id, "full", NOW + 20);
  assert.equal(readSessionTaint(f.node.store, f.scope.cli, f.scope.session_id, NOW + 20)!.root, NOW + 10);
});
test("corrupt or ambiguous legacy first-read receipts cannot establish disclosure time", t => {
  const f = fixture(t), e = f.raw(); delete e.meta.provenance;
  const row = { ...f.node.read(e.id), envelope: JSON.stringify(signEnvelope(e, "alpha", f.node.key.publicKey, f.node.key.privateKey)) };
  for (const value of [null, [[e.id, -1]], [[e.id, NOW + 1]], [[e.id, NOW], [e.id, NOW]], Array(501).fill([e.id, NOW])]) {
    f.node.store.set(`session-firsthand:${canonical([f.scope.cli, f.scope.session_id])}`, JSON.stringify(value));
    assert.throws(() => f.node.observeRead(row, f.scope.cli, f.scope.session_id, "full", NOW), /invalid first-hand disclosure history/);
    assert.equal(f.node.store.get(taintKey(f.scope.cli, f.scope.session_id)), undefined);
  }
});
test("reading a prior own outside message records disclosure in this conversation", t => {
  const f = fixture(t), e = f.raw(); e.from = "reader@alpha"; e.meta.provenance!.roots[0].from = e.from;
  const signed = signEnvelope(e, "alpha", f.node.key.publicKey, f.node.key.privateKey), row = { ...f.node.read(e.id), from_addr: e.from, envelope: JSON.stringify(signed) };
  f.node.observeRead(row, f.scope.cli, f.scope.session_id, "full", NOW);
  assert.equal(readSessionExposure(f.node.store, "alpha", f.scope.cli, f.scope.session_id, NOW).record!.roots[0].raw_at, NOW);
  assert.equal(readSessionTaint(f.node.store, f.scope.cli, f.scope.session_id, NOW)!.root, NOW);
});
test("pinned current and retired host keys validate mixed-key parent ancestry; unknown keys stay unknown", t => {
  const f = fixture(t), retired = f.node.key; f.node.rotateKeys(); const first = f.raw();
  const parent = buildEnvelope({ from: "sender@alpha", to: ["reader"], subject: "parent", body: "derived" }, new Date(NOW));
  parent.meta.provenance = { v: 2, kind: "derived-outside", content_sha256: sha256(parent.body), parents: [first.id], roots: first.meta.provenance!.roots };
  const signed = signEnvelope(parent, "alpha", retired.publicKey, retired.privateKey); f.node.store.insertMessage(signed, "local", "local", null);
  const child = buildEnvelope({ from: "sender@alpha", to: ["reader"], subject: "child", body: "derived again" }, new Date(NOW));
  child.meta.provenance = { ...parent.meta.provenance, content_sha256: sha256(child.body), parents: [signed.id] };
  const final = signEnvelope(child, "alpha", f.node.key.publicKey, f.node.key.privateKey);
  assert.equal(readContentProvenance(final, f.node.provenanceSources(final), NOW).kind, "derived-outside");
  const unknown = generateKeyPair(), forged = signEnvelope(child, "alpha", unknown.publicKey, unknown.privateKey);
  assert.equal(readContentProvenance(forged, f.node.provenanceSources(forged), NOW).kind, "unknown");
});
for (const effect of ["clear", "attest"] as const) test(`${effect} signs the full current snapshot, applies idempotently and grants no class`, t => {
  const f = fixture(t), e = f.raw(); f.expose(e);
  const before = readSessionExposure(f.node.store, "alpha", f.scope.cli, f.scope.session_id, NOW).record!;
  writeSessionTaint(f.node.store, { v: 1, cli: f.scope.cli, session_id: f.scope.session_id, root: NOW, from: e.from, id: e.id, how: "declared", relay_depth: [{ hop: 3, from: e.from, at: NOW }] }, NOW);
  const v1 = f.node.store.get(taintKey(f.scope.cli, f.scope.session_id));
  const signed = f.sign(buildSessionClearance(f.node.store, f.scope, f.owner.publicKey, effect, "reviewed", 60_000, NOW));
  assert.deepEqual(signed.rec.exposure, before); assert.equal(Object.hasOwn(signed.rec, "classes"), false);
  assert.equal(acceptSessionClearance(f.node.store, signed, f.scope, NOW).ok, true);
  assert.equal(acceptSessionClearance(f.node.store, signed, f.scope, NOW + 1).already_applied, true);
  assert.equal(currentSessionClearance(f.node.store, f.scope, NOW + 2)!.rec.exp, signed.rec.exp);
  assert.equal(f.node.store.get(taintKey(f.scope.cli, f.scope.session_id)), v1);
  assert.equal(sessionUntainted(f.node.store, f.scope.cli, f.scope.session_id, NOW), false);
  assert.deepEqual(readSessionExposure(f.node.store, "alpha", f.scope.cli, f.scope.session_id, NOW).record, before);
});
test("expiry, lifetime cap, future issuance, wrong owner/signature/session/project/host all refuse", t => {
  const f = fixture(t), signed = f.prepare(), other = generateKeyPair();
  assert.equal(validateSessionClearance(f.node.store, signed, f.scope, NOW + 15 * 60_000).ok, false);
  assert.throws(() => buildSessionClearance(f.node.store, f.scope, f.owner.publicKey, "clear", "reviewed", EXTERNAL_TAINT_MS + 1, NOW), /at most one hour/);
  for (const changed of [{ ...signed.rec, exp: new Date(NOW + EXTERNAL_TAINT_MS + 1).toISOString() }, { ...signed.rec, iat: new Date(NOW + 1).toISOString() }, { ...signed.rec, owner_fp: fingerprint(other.publicKey) }, { ...signed.rec, classes: ["outward"] }])
    assert.equal(validateSessionClearance(f.node.store, f.sign(changed), f.scope, NOW).ok, false);
  assert.equal(validateSessionClearance(f.node.store, { ...signed, sig: signData(other.privateKey, canonical(signed.rec)) }, f.scope, NOW).ok, false);
  for (const scope of [{ ...f.scope, host: "beta" }, { ...f.scope, cli: "codex" }, { ...f.scope, session_id: "sibling" }, { ...f.scope, project_key: "other-project" }])
    assert.equal(validateSessionClearance(f.node.store, signed, scope, NOW).ok, false);
});
test("new-root and same-root new-disclosure races invalidate the signed snapshot", t => {
  const f = fixture(t), signed = f.prepare();
  const extra = f.raw("new root", NOW + 1); f.expose(extra, NOW + 1);
  assert.equal(acceptSessionClearance(f.node.store, signed, f.scope, NOW + 1).ok, false);
  const latest = f.sign(buildSessionClearance(f.node.store, f.scope, f.owner.publicKey, "attest", "reviewed again", 60_000, NOW + 1));
  assert.equal(acceptSessionClearance(f.node.store, latest, f.scope, NOW + 1).ok, true);
  const row = f.node.read(extra.id); f.node.observeRead(row, f.scope.cli, f.scope.session_id, "quarantine", NOW + 2);
  const changed = readSessionExposure(f.node.store, "alpha", f.scope.cli, f.scope.session_id, NOW + 2);
  assert.equal(changed.reason, null); assert.equal(changed.record!.roots[1].last_read_at, NOW + 2);
  assert.equal(currentSessionClearance(f.node.store, f.scope, NOW + 2), null);
  assert.equal(f.node.store.get(`session-clearance:${latest.rec.id}`), canonical(latest), "history retained");
});
test("a reply is a new raw disclosure with the original source and first-read history intact", t => {
  const f = fixture(t), signed = f.prepare(), row = f.node.read(signed.rec.exposure.roots[0].source.message_id);
  assert.equal(acceptSessionClearance(f.node.store, signed, f.scope, NOW).ok, true);
  f.node.observeRead(row, f.scope.cli, f.scope.session_id, "full", NOW + 10, true);
  const root = readSessionExposure(f.node.store, "alpha", f.scope.cli, f.scope.session_id, NOW + 10).record!.roots[0];
  assert.equal(root.first_raw_at, NOW); assert.equal(root.raw_at, NOW + 10); assert.equal(root.source.since, row.ts);
  assert.equal(readSessionTaint(f.node.store, f.scope.cli, f.scope.session_id, NOW + 10)!.root, NOW + 10);
  assert.equal(currentSessionClearance(f.node.store, f.scope, NOW + 10), null);
});
test("unknown/corrupt/missing histories and signed record collisions are refused", t => {
  const f = fixture(t);
  assert.throws(() => buildSessionClearance(f.node.store, f.scope, f.owner.publicKey, "clear", "reviewed", 60_000, NOW), /incomplete/);
  const signed = f.prepare(); assert.equal(acceptSessionClearance(f.node.store, signed, f.scope, NOW).ok, true);
  const collision = f.sign({ ...signed.rec, reason: "changed reason" });
  assert.equal(acceptSessionClearance(f.node.store, collision, f.scope, NOW).ok, false);
  f.node.store.set(`session-clearance:${signed.rec.id}`, canonical(f.sign({ ...signed.rec, id: f.raw("unread").id })));
  assert.equal(currentSessionClearance(f.node.store, f.scope, NOW), null, "signed receipt must match its stored id");
  f.node.store.db.prepare("UPDATE session_exposures SET record=?").run("{bad");
  assert.equal(validateSessionClearance(f.node.store, signed, f.scope, NOW).ok, false);
  assert.throws(() => buildSessionClearance(f.node.store, f.scope, f.owner.publicKey, "attest", "reviewed", 60_000, NOW), /incomplete/);
});
test("signed targeted revocation and owner kill switch each invalidate clearance", t => {
  for (const target of ["self", "*"]) {
    const f = fixture(t), signed = f.prepare(); assert.equal(acceptSessionClearance(f.node.store, signed, f.scope, NOW).ok, true);
    const rec = makeRevocation(target === "self" ? signed.rec.id : "*", f.owner.publicKey, new Date(NOW + 1));
    assert.equal(issueSigned(f.node.store.db, { rec, sig: signData(f.owner.privateKey, canonical(rec)) }, "alpha"), null);
    assert.equal(validateSessionClearance(f.node.store, signed, f.scope, NOW + 1).ok, false);
  }
});
test("clearance audit rejection rolls back receipt/index without changing exposures", t => {
  const f = fixture(t), signed = f.prepare(), old = f.node.store.audit;
  f.node.store.audit = () => { throw new Error("audit unavailable"); };
  try { assert.throws(() => acceptSessionClearance(f.node.store, signed, f.scope, NOW), /audit unavailable/); }
  finally { f.node.store.audit = old; }
  assert.equal(f.node.store.get(`session-clearance:${signed.rec.id}`), undefined);
  assert.equal(currentSessionClearance(f.node.store, f.scope, NOW), null);
});
test("session-wide preview enumerates all current roots and finite expiry without future selectors", t => {
  const f = fixture(t), a = f.raw(), b = f.raw("other"); f.expose(a); f.expose(b);
  const rec = buildSessionClearance(f.node.store, f.scope, f.owner.publicKey, "clear", "reviewed", EXTERNAL_TAINT_MS, NOW), preview = sessionClearanceSummary(rec);
  for (const e of [a, b]) { assert.ok(preview.includes(e.id)); assert.ok(preview.includes(sha256(e.body))); }
  assert.ok(preview.includes(rec.exp)); assert.match(preview, /across this session's tasks/); assert.match(preview, /never future/);
});
test("native clearance preview shows exact snapshot and refuses unknown/invalid/oversized requests", { skip: process.platform !== "darwin" }, t => {
  const f = fixture(t), signed = f.prepare(), helper = join(f.home, "fixture-auth");
  execFileSync("swiftc", ["-Onone", resolve("macos/Auth/main.swift"), "-o", helper], { timeout: 180_000, stdio: "pipe" });
  const summary = (rec: unknown) => { const file = join(f.home, "preview.json"); writeFileSync(file, canonical(rec)); return spawnSync(helper, ["summary", file], { encoding: "utf8" }); };
  const good = summary(signed.rec); assert.equal(good.status, 0, good.stderr);
  for (const value of [f.scope.session_id, signed.rec.exp, signed.rec.exposure.roots[0].source.message_id, signed.rec.exposure.roots[0].source.content_sha256]) assert.ok(good.stdout.includes(value));
  assert.match(good.stdout, /ALL 1 current exposure/); assert.match(good.stdout, /never future/);
  for (const changed of [{ ...signed.rec, type: "unknown" }, { ...signed.rec, exp: new Date(NOW + EXTERNAL_TAINT_MS + 1).toISOString() }, { ...signed.rec, exposure: { ...signed.rec.exposure, unknown: true } }, { ...signed.rec, project_key: "*" }])
    assert.equal(summary(changed).status, 5);
  for (let i = 0; i < 10; i++) f.expose(f.raw(String(i), NOW + i), NOW + i);
  const large = buildSessionClearance(f.node.store, f.scope, f.owner.publicKey, "attest", "reviewed", 60_000, NOW + 10);
  const refused = summary(large); assert.equal(refused.status, 5); assert.match(refused.stderr, /complete current exposure snapshot exceeds/);
});

test("CLI/MCP read and thread modes obey leases and share exposure/legacy send fences", async t => {
  const client = new Client({ name: "reads-clear", version: "test" });
  const f = fixture({ after: cleanup => t.after(async () => { await client.close(); await cleanup(); }) });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [resolve("bin/agentmbx.js"), "mcp"],
    env: { ...process.env, MBX_HOME: f.home, MBX_AGENT: "reader", MBX_CLI: "claude", AGENTMBX_DEV: "1", MBX_NO_DESKTOP: "1", MBX_SESSION_SOCKET: "0" } as Record<string, string> }));
  const who = await client.callTool({ name: "mbx_whoami", arguments: {} }); assert.notEqual(who.isError, true);
  const sid = f.node.store.db.prepare("SELECT session_id FROM sessions WHERE agent='reader'").get()!.session_id as string;
  const e = f.raw();
  const call = async (name: string, args: Record<string, unknown>) => { const result = await client.callTool({ name, arguments: args }); assert.notEqual(result.isError, true, JSON.stringify(result.content)); return result; };
  const meta = await call("mbx_read", { ids: [e.id], mode: "metadata" });
  assert.equal(/MARKER/.test(JSON.stringify(meta)), false);
  assert.equal(readSessionExposure(f.node.store, "alpha", "claude", sid).record, null);
  assert.equal(f.node.store.get(taintKey("claude", sid)), undefined);
  assert.equal(f.node.store.db.prepare("SELECT state FROM deliveries WHERE msg_id=? AND agent='reader'").get(e.id)!.state, "read");
  const cli = (mode: string, command = "read", session = sid) => spawnSync(process.execPath, [resolve("bin/agentmbx.js"), command, e.id, "--as", "reader", "--cli", "claude", "--session", session, "--mode", mode], { encoding: "utf8", timeout: 20_000,
    env: { ...process.env, MBX_HOME: f.home, AGENTMBX_DEV: "1", MBX_NO_DESKTOP: "1" } });
  const metadata = cli("metadata"); assert.equal(metadata.status, 0, metadata.stderr); assert.equal(/MARKER/.test(metadata.stdout), false);
  assert.equal(readSessionExposure(f.node.store, "alpha", "claude", sid).record, null);
  const derived = await call("mbx_read", { ids: [e.id], mode: "quarantine" });
  assert.match(JSON.stringify(derived), /UNTRUSTED derived-outside/);
  const first = readSessionExposure(f.node.store, "alpha", "claude", sid).record!;
  const quarantine = cli("quarantine"); assert.equal(quarantine.status, 0, quarantine.stderr); assert.equal(JSON.parse(quarantine.stdout).provenance.kind, "derived-outside");
  const exposure = readSessionExposure(f.node.store, "alpha", "claude", sid).record!; assert.equal(exposure.roots[0].raw_at, null); assert.ok(exposure.roots[0].derived_at);
  assert.deepEqual(exposure, first);
  f.node.ack(e.id, "reader", "RECEIPT_NOTE_MARKER");
  const thread = await call("mbx_thread", { id: e.id, mode: "metadata" }); assert.equal(/MARKER/.test(JSON.stringify(thread)), false);
  await call("mbx_thread", { id: e.id, mode: "quarantine" });
  const cliThread = cli("metadata", "thread"); assert.equal(cliThread.status, 0, cliThread.stderr); assert.equal(/MARKER/.test(cliThread.stdout), false);
  assert.equal(cli("quarantine", "thread").status, 0);
  assert.notEqual(cli("metadata", "read", "wrong-session").status, 0);
  assert.deepEqual(readSessionExposure(f.node.store, "alpha", "claude", sid).record, first);
  assert.equal(f.node.store.db.prepare("SELECT state FROM deliveries WHERE msg_id=? AND agent='reader'").get(e.id)!.state, "acked");
  assert.equal(cli("full").status, 0);
  const raw = readSessionExposure(f.node.store, "alpha", "claude", sid).record!; assert.ok(raw.roots[0].raw_at! > first.roots[0].derived_at!);
  const live = readSessionTaint(f.node.store, "claude", sid)!;
  assert.equal(((await call("mbx_whoami", {})).structuredContent as { external: { tainted: boolean } }).external.tainted, true);
  f.node.registerAgent("recipient");
  await call("mbx_send", { to: ["recipient"], subject: "parity", body: "fresh prose" });
  const sent = f.node.inbox("recipient")[0], envelope = JSON.parse(sent.envelope);
  assert.equal(envelope.meta.origin, "external"); assert.equal(envelope.meta.external_since, new Date(live.root).toISOString());
  assert.equal(cli("bogus").status, 2);
});

test("owner CLI fixture signer records clear/attest, revokes, and rechecks exposure/project after signing", t => {
  const f = fixture(t), helper = join(f.home, "fixture-auth.mjs"), payload = join(f.home, "signed.json");
  writeFileSync(join(f.home, "fixture-key.json"), JSON.stringify(f.owner), { mode: 0o600 });
  writeFileSync(helper, `#!${process.execPath}
import { readFileSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { signData } from ${JSON.stringify(new URL("../src/crypto.ts", import.meta.url).href)};
if (process.argv[2] !== "sign") process.exit(2);
const text = readFileSync(process.argv[3], "utf8"), key = JSON.parse(readFileSync(${JSON.stringify(join(f.home, "fixture-key.json"))}, "utf8"));
writeFileSync(${JSON.stringify(payload)}, text, { mode: 0o600 });
if (process.env.FIXTURE_RACE) {
  const db = new DatabaseSync(${JSON.stringify(join(f.home, "mbx.db"))});
  if (process.env.FIXTURE_RACE === "project") db.prepare("UPDATE sessions SET cwd=?").run(${JSON.stringify(join(f.home, "moved"))});
  else { const r = JSON.parse(db.prepare("SELECT record FROM session_exposures").get().record); r.generation++; db.prepare("UPDATE session_exposures SET record=?").run(JSON.stringify(r)); }
  db.close();
}
console.log(signData(key.privateKey, text));
`, { mode: 0o700 });
  f.node.bindSession({ agent: "reader", cli: f.scope.cli, session_id: f.scope.session_id, cwd: f.home, pid: process.pid, session_key: generateKeyPair().publicKey });
  f.expose(f.raw());
  const cli = (args: string[], race = "") => spawnSync(process.execPath, [resolve("bin/agentmbx.js"), "owner", ...args], { encoding: "utf8", timeout: 20_000,
    env: { ...process.env, MBX_HOME: f.home, MBX_AUTH_HELPER: helper, FIXTURE_RACE: race, AGENTMBX_DEV: "1", MBX_NO_DESKTOP: "1" } });
  const args = ["--cli", f.scope.cli, "--session", f.scope.session_id, "--project", f.home, "--reason", "reviewed fixture", "--ttl", "15m"];
  for (const effect of ["clear", "attest"]) {
    const issued = cli([effect, ...args]); assert.equal(issued.status, 0, issued.stderr);
    const rec: SessionClearance = JSON.parse(readFileSync(payload, "utf8")); assert.equal(rec.effect, effect);
    assert.equal(currentSessionClearance(f.node.store, f.scope)!.rec.id, rec.id);
    const revoked = cli(["revoke-clearance", rec.id]); assert.equal(revoked.status, 0, revoked.stderr);
    assert.equal(currentSessionClearance(f.node.store, f.scope), null);
  }
  assert.notEqual(cli(["clear", ...args, "--ttl", "2h"]).status, 0);
  assert.notEqual(cli(["clear", ...args], "exposure").status, 0);
  let denied: SessionClearance = JSON.parse(readFileSync(payload, "utf8")); assert.equal(f.node.store.get(`session-clearance:${denied.id}`), undefined);
  const moved = cli(["clear", ...args], "project"); assert.notEqual(moved.status, 0); assert.match(moved.stderr, /project changed while signing/);
  denied = JSON.parse(readFileSync(payload, "utf8")); assert.equal(f.node.store.get(`session-clearance:${denied.id}`), undefined);
});
