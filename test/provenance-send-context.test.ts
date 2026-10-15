import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonical, fingerprint, generateKeyPair, sha256 } from "../src/crypto.ts";
import { buildEnvelope, createContentProvenance, EXTERNAL_TAINT_MS, ownerSign, readContentProvenance, signEnvelope,
  type Envelope, type ProvenanceSources } from "../src/envelope.ts";
import { IdentityLeases, inspectLeaseProcess } from "../src/identity-leases.ts";
import { MbxNode, formatFor, messageReadView, type SendProvenanceScope } from "../src/node.ts";
import { readSessionTaint } from "../src/session-taint.ts";

const time = Date.parse("2026-10-15T06:00:00.000Z");
function world() {
  const key = generateKeyPair(), messages = new Map<string, Envelope>();
  const sources: ProvenanceSources = { publicKey: host => host === "alpha" ? key.publicKey : undefined, message: id => messages.get(id) };
  const send = (parents: string[] = [], declared?: "agent" | "firsthand-outside" | "derived-outside", at = time, unknown = false) => {
    const e = buildEnvelope({ from: "writer@alpha", to: ["reader"], subject: "status", body: "own report" }, new Date(at));
    e.meta.sender_verification = "leased";
    const built = createContentProvenance(e, parents, sources, declared, unknown);
    e.meta.provenance = built.record;
    const signed = signEnvelope(e, "alpha", key.publicKey, key.privateKey); messages.set(signed.id, signed);
    return { e: signed, warnings: built.warnings, read: readContentProvenance(signed, sources, at) };
  };
  return { send, messages, sources };
}

test("S3 daemon-built ordinary agent and raw source payloads bind their exact signed body", () => {
  const w = world(), status = w.send(), outside = w.send([], "firsthand-outside");
  assert.equal(status.read.kind, "agent"); assert.deepEqual(status.read.roots, []);
  assert.equal(outside.read.kind, "firsthand-outside");
  assert.deepEqual(outside.read.roots, [{ message_id: outside.e.id, from: outside.e.from, content_sha256: sha256(outside.e.body), since: outside.e.ts }]);
});

test("S3 inherited inputs defeat an agent declaration and keep mixed payloads derived", () => {
  const w = world(), status = w.send(), outside = w.send([], "firsthand-outside");
  const mixed = w.send([status.e.id, outside.e.id], "agent", time + 1);
  assert.equal(mixed.read.kind, "derived-outside"); assert.deepEqual(mixed.read.roots, outside.read.roots);
  assert.match(mixed.warnings.join(" "), /overridden/);
});

test("S3 one hundred derived exchanges retain the original source after its caution timer ends", () => {
  const w = world(), raw = w.send([], "firsthand-outside"); let parent = raw;
  for (let i = 0; i < 100; i++) {
    parent = w.send([parent.e.id], undefined, time + i + 1);
    assert.equal(parent.read.kind, "derived-outside"); assert.deepEqual(parent.read.roots, raw.read.roots);
  }
  const expired = w.send([parent.e.id], undefined, time + EXTERNAL_TAINT_MS + 1);
  assert.equal(expired.read.kind, "derived-outside"); assert.deepEqual(expired.read.roots, raw.read.roots);
});

test("S3 declared outside content is never silently relabelled as agent", () => {
  const w = world(), raw = w.send([], "firsthand-outside");
  const impossible = w.send([raw.e.id], "firsthand-outside", time + 1);
  assert.equal(impossible.read.kind, "unknown"); assert.match(impossible.warnings.join(" "), /cannot replace/);
  assert.equal(w.send([], "derived-outside").read.kind, "unknown");
});

test("S3 missing, forged, future, legacy, duplicate and overflowing inputs stay unknown", () => {
  const w = world(), raw = w.send([], "firsthand-outside"), future = w.send([], "firsthand-outside", time + 5);
  const legacy = buildEnvelope({ from: "writer@alpha", to: ["reader"], subject: "legacy", body: "old" }, new Date(time));
  w.messages.set(legacy.id, legacy);
  for (const parents of [["bad"], ["0".repeat(26)], [future.e.id], [legacy.id], [raw.e.id, raw.e.id], Array(65).fill(raw.e.id)])
    assert.equal(w.send(parents).read.kind, "unknown");
  w.messages.set(raw.e.id, { ...raw.e, body: "forged" });
  assert.equal(w.send([raw.e.id]).read.kind, "unknown");
  assert.equal(w.send([], "agent", time, true).read.kind, "unknown");
});

test("S3 a 65-root union is unknown rather than a truncated apparently clean payload", () => {
  const w = world(), roots = Array.from({ length: 65 }, () => w.send([], "firsthand-outside"));
  const left = w.send(roots.slice(0, 40).map(x => x.e.id), undefined, time + 1);
  const right = w.send(roots.slice(40).map(x => x.e.id), undefined, time + 1);
  assert.equal(left.read.roots.length, 40); assert.equal(right.read.roots.length, 25);
  const joined = w.send([left.e.id, right.e.id], undefined, time + 2);
  assert.equal(joined.read.kind, "unknown"); assert.match(joined.warnings.join(" "), /overflow/);
});

function database(t: { after(fn: () => void): void }) {
  const home = mkdtempSync(join(tmpdir(), "mbx-send-context-")), node = new MbxNode(home, { host: "alpha" });
  t.after(() => { node.close(); rmSync(home, { recursive: true, force: true }); });
  const now = Date.now() - 1000, leases = new IdentityLeases(node.store), key = generateKeyPair();
  const scope = { cli: "codex", session_id: "conversation" };
  const lease = leases.claim("reader", { pid: process.pid, start: inspectLeaseProcess(process.pid).start!, keyFp: fingerprint(key.publicKey), cli: scope.cli, sessionId: scope.session_id });
  node.registerAgent("reader");
  const input = (kind: "agent" | "firsthand-outside" | "derived-outside", parents: Envelope[] = [], at = now) => {
    const e = buildEnvelope({ from: "writer@alpha", to: ["reader"], subject: "input", body: "data" }, new Date(at));
    e.meta.sender_verification = "leased";
    e.meta.provenance = createContentProvenance(e, parents.map(p => p.id), node.provenanceSources(e), kind).record;
    const signed = signEnvelope(e, "alpha", node.key.publicKey, node.key.privateKey);
    node.store.insertMessage(signed, "local", "local", null); node.store.addDelivery(signed.id, "reader");
    return signed;
  };
  const prepare = (extra: Partial<SendProvenanceScope> = {}, reply?: Envelope, at = now + 500) => leases.withHeld("reader", lease.token, () => {
    const e = buildEnvelope({ from: "reader@alpha", to: ["writer"], subject: "own status", body: "checks passed", kind: "status", origin: "agent", reply_to: reply?.id }, new Date(at));
    const built = node.prepareSendProvenance(e, "reader", { ...scope, ...extra });
    e.meta.provenance = built.record;
    return { ...built, e: signEnvelope(e, "alpha", node.key.publicKey, node.key.privateKey) };
  });
  return { home, node, now, scope, input, prepare, leases, lease };
}

test("S3 metadata does not select task inputs; full reads survive relabelled status/new-thread sends", t => {
  const f = database(t), raw = f.input("firsthand-outside");
  f.node.observeRead(f.node.read(raw.id, "reader"), f.scope.cli, f.scope.session_id, "metadata", f.now + 1);
  assert.equal(f.prepare().record.kind, "agent");
  f.node.observeRead(f.node.read(raw.id, "reader"), f.scope.cli, f.scope.session_id, "full", f.now + 2);
  for (const options of [{}, { payload: "agent" as const }, { sources: [] }]) {
    const sent = f.prepare(options);
    assert.equal(sent.record.kind, "derived-outside"); assert.deepEqual(sent.record.roots, raw.meta.provenance!.roots);
    assert.notEqual(sent.e.thread, raw.thread);
  }
});

test("S3 independently selected observed status keeps the writer fence and cannot erase reply inputs", t => {
  const f = database(t), raw = f.input("firsthand-outside"), clean = f.input("agent");
  f.node.observeRead(f.node.read(raw.id, "reader"), f.scope.cli, f.scope.session_id, "full", f.now + 1);
  f.node.observeRead(f.node.read(clean.id, "reader"), f.scope.cli, f.scope.session_id, "full", f.now + 2);
  assert.equal(f.prepare().record.kind, "derived-outside", "reading an unrelated status did not reset the active task");
  assert.equal(f.prepare({ context: clean.thread }).record.kind, "agent");
  assert.ok(readSessionTaint(f.node.store, f.scope.cli, f.scope.session_id, f.now + 500), "independent payload never clears writer exposure");
  assert.equal(f.prepare({ context: clean.thread }, raw).record.kind, "derived-outside");
  assert.equal(f.prepare({ context: clean.thread }).record.kind, "derived-outside", "omitting the reply reference cannot drop a now-known input");
});

test("S3 exact conversation and readable-source checks reject scope substitution and private guesses", t => {
  const f = database(t), raw = f.input("firsthand-outside");
  assert.throws(() => f.prepare({ cli: "claude" }), /does not match/);
  assert.throws(() => f.prepare({ session_id: "sibling" }), /does not match/);
  assert.throws(() => f.prepare({ context: raw.id }), /not been disclosed/);
  assert.throws(() => f.prepare({ sources: ["0".repeat(26)] }), /no message/);
  assert.throws(() => f.prepare({ sources: Array(65).fill(raw.id) }), /at most 64/);
  assert.throws(() => f.node.prepareSendProvenance(raw, "reader", f.scope), /current identity lease/);
  f.leases.release("reader", f.lease.token);
  assert.throws(() => f.prepare(), /lease/i);
});

test("S3 durable active inputs retain exact roots through 100 reads and sends beyond expiry", t => {
  const f = database(t), raw = f.input("firsthand-outside"); let parent = raw;
  for (let i = 0; i < 100; i++) {
    parent = i === 0 ? raw : f.input("derived-outside", [parent], f.now + i);
    f.node.observeRead(f.node.read(parent.id, "reader"), f.scope.cli, f.scope.session_id, "full", f.now + i + 1);
    const sent = f.prepare({}, undefined, f.now + i + 2);
    assert.equal(sent.record.kind, "derived-outside"); assert.deepEqual(sent.record.roots, raw.meta.provenance!.roots);
  }
  const late = f.prepare({}, undefined, f.now + EXTERNAL_TAINT_MS + 1);
  assert.equal(late.record.kind, "derived-outside"); assert.deepEqual(late.record.roots, raw.meta.provenance!.roots);
});

test("S3 corrupt retained context and missing active pointers remain unknown without overwriting evidence", t => {
  const f = database(t), raw = f.input("firsthand-outside");
  f.node.observeRead(f.node.read(raw.id, "reader"), f.scope.cli, f.scope.session_id, "full", f.now + 1);
  const prefix = `provenance-context:${sha256(canonical(["alpha", f.scope.cli, f.scope.session_id]))}:`;
  f.node.store.set(prefix + raw.thread, "{corrupt");
  assert.equal(f.prepare().record.kind, "unknown");
  assert.equal(f.node.store.get(prefix + raw.thread), "{corrupt");
  f.node.store.db.prepare("DELETE FROM kv WHERE k=?").run(prefix + "active");
  assert.equal(f.prepare().record.kind, "unknown");
  const clean = f.input("agent");
  f.node.observeRead(f.node.read(clean.id, "reader"), f.scope.cli, f.scope.session_id, "full", f.now + 2);
  assert.equal(f.prepare().record.kind, "unknown", "a new clean read cannot heal a missing pointer over retained context evidence");
});

test("S3 scoped sends sign known roots and expose the same immutable timing as reader views", t => {
  const f = database(t), raw = f.input("firsthand-outside");
  f.node.observeRead(f.node.read(raw.id, "reader"), f.scope.cli, f.scope.session_id, "full", f.now + 1);
  const sent = f.leases.withHeld("reader", f.lease.token, () => f.node.send({ from: "reader", to: ["writer"], subject: "own report", body: "pass", kind: "status", origin: "agent" }, undefined, undefined, undefined, f.scope));
  assert.equal(sent.provenance!.payload.kind, "derived-outside");
  assert.equal(sent.envelope.meta.origin, "external"); assert.equal(sent.provenance!.writer_fence.state, "active");
  const row = f.node.read(sent.envelope.id, "reader"), at = Date.now();
  const view = messageReadView(f.node, row, "reader", "metadata", at), status = f.node.provenanceStatus(sent.envelope, f.scope, at);
  assert.deepEqual(view.lineage.payload, status.payload);
  assert.match(formatFor(f.node, row, "reader"), /payload provenance: derived-outside/);
  assert.match(formatFor(f.node, row, "reader"), new RegExp(raw.id));
  const expired = f.node.provenanceStatus(sent.envelope, f.scope, f.now + EXTERNAL_TAINT_MS + 10);
  assert.equal(expired.payload.roots[0].remaining_ms, 0); assert.equal(expired.payload.roots[0].since, raw.ts);
  assert.equal(expired.legacy_projection.external, true, "timer expiry never makes old outside instructions authoritative");
});

test("S3 independent payload remains conservatively external while its writer is fenced", t => {
  const f = database(t), raw = f.input("firsthand-outside"), clean = f.input("agent");
  for (const e of [raw, clean]) f.node.observeRead(f.node.read(e.id, "reader"), f.scope.cli, f.scope.session_id, "full", f.now + 1);
  const sent = f.leases.withHeld("reader", f.lease.token, () => f.node.send({ from: "reader", to: ["writer"], subject: "test counts", body: "12 pass", origin: "agent" }, undefined, undefined, undefined, { ...f.scope, context: clean.thread, payload: "agent" }));
  assert.equal(sent.provenance!.payload.kind, "agent"); assert.deepEqual(sent.provenance!.payload.roots, []);
  assert.equal(sent.envelope.meta.origin, "external"); assert.equal(sent.provenance!.writer_fence.state, "active");
  const summary = messageReadView(f.node, f.node.read(sent.envelope.id, "reader"), "reader", "quarantine");
  assert.equal(summary.lineage.payload.kind, "derived-outside"); assert.match(summary.lineage.payload.reason!, /source roots unavailable/);
});

test("S3 an explicit raw send records its local source receipt and never silently relabels it", t => {
  const f = database(t);
  const sent = f.leases.withHeld("reader", f.lease.token, () => f.node.send({ from: "reader", to: ["writer"], subject: "copied issue", body: "outside text", origin: "external" }, undefined, undefined, undefined, { ...f.scope, payload: "agent" }));
  assert.equal(sent.provenance!.payload.kind, "firsthand-outside");
  assert.equal(sent.provenance!.payload.roots[0].message_id, sent.envelope.id);
  assert.equal(sent.provenance!.writer_fence.state, "active");
  assert.ok(readSessionTaint(f.node.store, f.scope.cli, f.scope.session_id));
  assert.match(sent.warnings.join(" "), /outside declaration retained/);
});

test("S3 changing persona preserves previously disclosed inputs without granting old mailbox access", t => {
  const f = database(t), raw = f.input("firsthand-outside");
  f.node.observeRead(f.node.read(raw.id, "reader"), f.scope.cli, f.scope.session_id, "full", f.now + 1);
  f.leases.release("reader", f.lease.token);
  const key = generateKeyPair(), next = f.leases.claim("new-reader", { pid: process.pid, start: inspectLeaseProcess(process.pid).start!, keyFp: fingerprint(key.publicKey), cli: f.scope.cli, sessionId: f.scope.session_id });
  assert.throws(() => f.node.read(raw.id, "new-reader"), /no message/);
  const sent = f.leases.withHeld("new-reader", next.token, () => f.node.send({ from: "new-reader", to: ["writer"], subject: "status", body: "same conversation" }, undefined, undefined, undefined, f.scope));
  assert.equal(sent.provenance!.payload.kind, "derived-outside"); assert.deepEqual(sent.envelope.meta.provenance!.roots, raw.meta.provenance!.roots);
  assert.throws(() => f.leases.withHeld("new-reader", next.token, () => f.node.send({ from: "new-reader", to: ["writer"], subject: "private ref", body: "cannot add new private input" }, undefined, undefined, undefined, { ...f.scope, sources: [raw.id] })), /no message/);
});

test("S3 upgrade restores S2 roots before a new clean read or send can drop their input context", t => {
  const f = database(t), raw = f.input("firsthand-outside");
  f.node.observeRead(f.node.read(raw.id, "reader"), f.scope.cli, f.scope.session_id, "full", f.now + 1);
  const prefix = `provenance-context:${sha256(canonical(["alpha", f.scope.cli, f.scope.session_id]))}:`;
  f.node.store.db.prepare("DELETE FROM kv WHERE k GLOB ?").run(prefix + "*");
  assert.deepEqual(f.prepare().record.roots, raw.meta.provenance!.roots);
  const clean = f.input("agent");
  f.node.observeRead(f.node.read(clean.id, "reader"), f.scope.cli, f.scope.session_id, "full", f.now + 2);
  assert.deepEqual(f.prepare().record.roots, raw.meta.provenance!.roots);
  assert.equal(f.prepare({ context: clean.thread }).record.kind, "agent");
});

test("S3 an unsupported raw declaration remains unknown on later relabelled sends", t => {
  const f = database(t), raw = f.input("firsthand-outside");
  f.node.observeRead(f.node.read(raw.id, "reader"), f.scope.cli, f.scope.session_id, "full", f.now + 1);
  assert.equal(f.prepare({ payload: "firsthand-outside" }).record.kind, "unknown");
  assert.equal(f.prepare({ payload: "agent" }).record.kind, "unknown");
  const sent = f.leases.withHeld("reader", f.lease.token, () => f.node.send({ from: "reader", to: ["writer"], subject: "new outside source", body: "fresh raw text", origin: "external" }, undefined, undefined, undefined, f.scope));
  assert.equal(sent.provenance!.payload.kind, "unknown"); assert.equal(sent.provenance!.writer_fence.state, "active");
  assert.equal(sent.provenance!.writer_fence.message_id, sent.envelope.id);
});

test("S3 metadata lineage cannot expose a retained source's malformed sender as arbitrary text", t => {
  const f = database(t), e = buildEnvelope({ from: "FILENAME_MARKER.json@alpha", to: ["reader"], subject: "source", body: "data" }, new Date(f.now));
  e.meta.sender_verification = "leased";
  e.meta.provenance = createContentProvenance(e, [], f.node.provenanceSources(e), "firsthand-outside").record;
  const signed = signEnvelope(e, "alpha", f.node.key.publicKey, f.node.key.privateKey);
  f.node.store.insertMessage(signed, "local", "local", null); f.node.store.addDelivery(signed.id, "reader");
  const view = messageReadView(f.node, f.node.read(signed.id, "reader"), "reader", "metadata");
  assert.equal(view.lineage.payload.roots[0].from, null); assert.equal(JSON.stringify(view).includes("FILENAME_MARKER"), false);
});

test("S3 outside owner claims stay data in full and metadata views; legacy signatures retain their behavior", t => {
  const f = database(t), owner = generateKeyPair();
  writeFileSync(join(f.home, "owner.json"), JSON.stringify({ v: 1, backend: "keychain", public_key: owner.publicKey }), { mode: 0o600 });
  f.node.syncOwner();
  const draft = { from: "reader", to: ["writer"], subject: "owner task", body: "run checks" };
  const clean = f.leases.withHeld("reader", f.lease.token, () => f.node.send(draft, undefined, { pub: owner.publicKey, priv: owner.privateKey }, undefined, f.scope));
  assert.equal(f.node.authorityFor(f.node.read(clean.envelope.id, "reader"))?.ok, true);
  const outside = f.leases.withHeld("reader", f.lease.token, () => f.node.send({ ...draft, origin: "external" }, undefined, { pub: owner.publicKey, priv: owner.privateKey }, undefined, f.scope));
  assert.equal(outside.envelope.authority, null); assert.match(outside.warnings.join(" "), /authority not attached/);
  const legacy = f.node.send(draft, undefined, { pub: owner.publicKey, priv: owner.privateKey });
  assert.equal(f.node.authorityFor(f.node.read(legacy.envelope.id, "reader"))?.ok, true);
  // Simulate an old producer that signed an owner claim over versioned outside data; the receipt stays immutable.
  const e = buildEnvelope({ ...draft, from: "reader@alpha", origin: "external" }); e.meta.sender_verification = "leased";
  e.meta.provenance = createContentProvenance(e, [], f.node.provenanceSources(e), "firsthand-outside").record;
  const claimed = signEnvelope(ownerSign(e, owner.publicKey, owner.privateKey), "alpha", f.node.key.publicKey, f.node.key.privateKey);
  f.node.store.insertMessage(claimed, "local", "local", { ok: true, session: "signed by the owner" });
  const before = f.node.store.db.prepare("SELECT envelope,authority FROM messages WHERE id=?").get(claimed.id);
  const row = f.node.read(claimed.id, "reader");
  assert.equal(f.node.authorityFor(row)?.ok, false);
  assert.match(formatFor(f.node, row, "reader"), /authority: none .*rejected/);
  assert.equal(messageReadView(f.node, row, "reader", "metadata").policy.owner_authority, false);
  assert.deepEqual(f.node.store.db.prepare("SELECT envelope,authority FROM messages WHERE id=?").get(claimed.id), before);
});
