import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonical, generateKeyPair, sha256, signData } from "../src/crypto.ts";
import { generateEncKeyPair, openBody } from "../src/body-encryption.ts";
import { buildEnvelope, checkShape, EXTERNAL_TAINT_MS, externalExposure, readContentProvenance, sealEnvelope, signEnvelope, verifyEnvelope,
  type ContentProvenance, type Envelope, type ProvenanceSources } from "../src/envelope.ts";
import { readSessionExposure, recordSessionExposure, readSessionTaint, sessionUntainted, taintKey, writeSessionTaint } from "../src/session-taint.ts";
import { Store } from "../src/store.ts";

const time = Date.parse("2026-10-14T10:00:00.000Z"), iso = (n: number) => new Date(n).toISOString();
const key = generateKeyPair(), otherKey = generateKeyPair();
function world() {
  const messages = new Map<string, Envelope>();
  const sources: ProvenanceSources = { publicKey: host => host === "alpha" ? key.publicKey : undefined, message: id => messages.get(id) };
  const sign = (e: Envelope) => signEnvelope(e, "alpha", key.publicKey, key.privateKey);
  const put = (e: Envelope) => { const signed = sign(e); messages.set(e.id, signed); return signed; };
  const make = (kind: ContentProvenance["kind"], parents: Envelope[] = [], at = time, body = "payload") => {
    const e = buildEnvelope({ from: "sender@alpha", to: ["worker@alpha"], subject: "source", body }, new Date(at));
    const roots = kind === "firsthand-outside" ? [{ message_id: e.id, from: e.from, content_sha256: sha256(body), since: e.ts }]
      : [...new Map(parents.flatMap(p => p.meta.provenance!.roots).map(r => [r.message_id, r])).values()];
    e.meta.provenance = { v: 2, kind, content_sha256: sha256(body), roots, parents: parents.map(p => p.id) };
    return put(e);
  };
  return { messages, sources, sign, put, make, read: (e: unknown, now = time + 1000) => readContentProvenance(e, sources, now) };
}
function database(t: { after(fn: () => void): void }) {
  const home = mkdtempSync(join(tmpdir(), "mbx-provenance-records-"));
  let store = new Store(home);
  t.after(() => { store.close(); rmSync(home, { recursive: true, force: true }); });
  return { get store() { return store; }, reopen() { store.close(); store = new Store(home); }, home };
}
const rootOf = (e: Envelope) => e.meta.provenance!.roots[0];

for (const kind of ["agent", "firsthand-outside", "derived-outside", "unknown"] as const) {
  test(`signed v2 distinguishes ${kind}`, () => {
    const w = world(), raw = w.make("firsthand-outside"), e = w.make(kind, kind === "derived-outside" ? [raw] : []);
    const r = w.read(e);
    assert.equal(r.kind, kind);
    assert.equal(r.reason === null, kind !== "unknown");
  });
}
test("digest/root/parent bytes are signed, and a trusted key comes from the host directory", () => {
  const w = world(), e = w.make("firsthand-outside");
  assert.equal(verifyEnvelope(e, key.publicKey), true);
  for (const changed of [{ ...e, body: "substituted" }, { ...e, meta: { ...e.meta, provenance: { ...e.meta.provenance!, roots: [] } } },
    signEnvelope(e, "alpha", otherKey.publicKey, otherKey.privateKey), signEnvelope(e, "beta", key.publicKey, key.privateKey)]) {
    assert.equal(w.read(changed).kind, "unknown");
  }
  assert.equal(readContentProvenance(e, { ...w.sources, publicKey: () => undefined }, time).kind, "unknown");
  assert.equal(w.read(w.sign({ ...e, body: "resigned but digest still wrong" })).kind, "unknown");
});
test("a sealed stored envelope checks both the host signature and exact opened plaintext", () => {
  const w = world(), e = w.make("firsthand-outside"), recipient = generateEncKeyPair();
  const wire = sealEnvelope(e, recipient.publicKey, "alpha", key.publicKey, key.privateKey);
  assert.equal(w.read(wire).kind, "unknown", "ciphertext is not an opened payload");
  const stored = { ...wire, body: openBody(wire.enc!, recipient.privateKey, e.id) };
  assert.equal(w.read(stored).kind, "firsthand-outside");
  assert.equal(verifyEnvelope({ ...stored, body: "different plaintext" }, key.publicKey), true, "legacy host verification binds ciphertext");
  assert.equal(w.read({ ...stored, body: "different plaintext" }).kind, "unknown", "signed provenance binds opened plaintext as well");
});
test("first-hand roots bind exact message, sender, digest and time; a URL is not evidence", () => {
  const w = world(), e = w.make("firsthand-outside"), root = rootOf(e);
  for (const bad of [{ ...root, message_id: w.make("agent").id }, { ...root, from: "other@alpha" }, { ...root, content_sha256: sha256("other") },
    { ...root, since: iso(time - 1) }, { ...root, since: iso(time + 1) }, { ...root, url: "https://example.invalid" }]) {
    const changed = structuredClone(e); changed.meta.provenance!.roots = [bad];
    assert.equal(w.read(w.sign(changed)).kind, "unknown", canonical(bad));
  }
});
test("exact parent union survives 100 exchanges and expiry without renewing/declassifying roots", () => {
  const w = world(), a = w.make("firsthand-outside"), b = w.make("firsthand-outside", [], time + 1, "second source");
  let e = w.make("derived-outside", [a, b], time + 2);
  for (let i = 0; i < 100; i++) e = w.make("derived-outside", [e], time + 3 + i);
  const r = w.read(e, time + EXTERNAL_TAINT_MS * 10);
  assert.equal(r.kind, "derived-outside");
  assert.deepEqual(r.roots, [rootOf(a), rootOf(b)]);
  assert.equal(r.roots[0].since, iso(time));
});
test("missing, forged, later, legacy and unknown parents cannot establish derived/agent provenance", () => {
  const w = world(), raw = w.make("firsthand-outside"), e = w.make("derived-outside", [raw], time + 1);
  const missing = structuredClone(e); missing.meta.provenance!.parents = [w.make("agent").id];
  w.messages.delete(missing.meta.provenance!.parents[0]);
  assert.equal(w.read(w.sign(missing)).kind, "unknown");
  for (const changed of [w.make("agent"), { ...raw, body: "tampered parent" }, buildEnvelope({ from: "sender@alpha", to: ["worker"], subject: "old", body: "old" }),
    w.make("unknown"), w.make("firsthand-outside", [], time + 2)]) {
    w.messages.set(raw.id, changed);
    assert.equal(w.read(e).kind, "unknown");
  }
  w.messages.set(raw.id, raw);
  for (const patch of [{ roots: [] }, { kind: "agent" }, { parents: [] }, { roots: [{ ...rootOf(raw), since: iso(time + 1) }] }]) {
    const changed = structuredClone(e); Object.assign(changed.meta.provenance!, patch);
    assert.equal(w.read(w.sign(changed)).kind, "unknown");
  }
});
test("cycles and throwing source readers fail closed", () => {
  const w = world(), raw = w.make("firsthand-outside"), e = w.make("derived-outside", [raw]);
  const cyclic = structuredClone(e); cyclic.meta.provenance!.parents = [e.id]; w.put(cyclic);
  assert.equal(w.read(w.messages.get(e.id)).kind, "unknown");
  assert.equal(readContentProvenance(e, { ...w.sources, message() { throw new Error("unavailable"); } }, time).kind, "unknown");
});
test("shared parent ancestry unions once, and contradictory signed bytes for one ID fail closed", () => {
  const w = world(), raw = w.make("firsthand-outside"), left = w.make("derived-outside", [raw]), right = w.make("derived-outside", [raw]);
  const joined = w.make("derived-outside", [left, right]);
  assert.deepEqual(w.read(joined).roots, [rootOf(raw)]);
  let reads = 0;
  const substituted = structuredClone(raw); substituted.body = "different signed source";
  substituted.meta.provenance!.content_sha256 = sha256(substituted.body); substituted.meta.provenance!.roots[0].content_sha256 = sha256(substituted.body);
  const changing = { ...w.sources, message(id: string) { return id === raw.id && ++reads > 1 ? w.sign(substituted) : w.messages.get(id); } };
  assert.match(readContentProvenance(joined, changing, time).reason!, /contradictory/);
  const duplicate = structuredClone(joined); duplicate.meta.provenance!.parents = [left.id, left.id];
  assert.equal(w.read(w.sign(duplicate)).kind, "unknown");
});
test("hostile ancestry beyond the work bound fails closed without unbounded source resolution", () => {
  const w = world(); let e = w.make("firsthand-outside");
  for (let i = 0; i < 1030; i++) e = w.make("derived-outside", [e]);
  let reads = 0;
  const result = readContentProvenance(e, { ...w.sources, message(id) { reads++; return w.messages.get(id); } }, time);
  assert.equal(result.kind, "unknown"); assert.ok(reads <= 1024, `bounded lookup count: ${reads}`);
});
test("64 roots are valid; duplicate, overflowing roots/parents and overflowed unions are unknown", () => {
  const w = world(), roots = Array.from({ length: 65 }, (_, i) => w.make("firsthand-outside", [], time + i, String(i)));
  const e = w.make("derived-outside", roots.slice(0, 64), time + 100);
  assert.equal(w.read(e).roots.length, 64);
  for (const refs of [roots, [roots[0], roots[0]]]) {
    const changed = structuredClone(e); changed.meta.provenance!.roots = refs.map(rootOf);
    assert.equal(w.read(w.sign(changed)).kind, "unknown");
  }
  const tooManyParents = structuredClone(e); tooManyParents.meta.provenance!.parents = roots.map(x => x.id);
  assert.equal(w.read(w.sign(tooManyParents)).kind, "unknown");
  const left = w.make("derived-outside", roots.slice(0, 40), time + 100), right = w.make("derived-outside", roots.slice(40), time + 100);
  const union = w.make("derived-outside", [left, right], time + 101); union.meta.provenance!.roots = union.meta.provenance!.roots.slice(0, 64);
  assert.match(w.read(w.sign(union)).reason!, /overflow/);
});
for (const patch of [null, { v: 1 }, { v: 99 }, { v: 2, roots: "not roots" }, { v: 2, kind: "clean" }]) {
  test(`malformed/missing provenance stays unknown: ${JSON.stringify(patch)}`, () => {
    const w = world(), e = w.make("agent"); Object.assign(e.meta, { provenance: patch });
    assert.equal(w.read(w.sign(e)).kind, "unknown");
  });
}
test("invalid/future times and non-canonical instants do not become clean", () => {
  const w = world();
  for (const ts of [iso(time + 2000), "2026-10-14T10:00:00Z", "2026-02-30T10:00:00.000Z", "invalid"]) {
    const e = w.make("agent"); e.ts = ts;
    assert.equal(w.read(w.sign(e)).kind, "unknown");
  }
});
test("v1 signing bytes, origin projection and one-hour approval expiry remain unchanged", t => {
  const db = database(t), w = world();
  const e = buildEnvelope({ from: "sender@alpha", to: ["worker"], subject: "old", body: "body", origin: "external", external_since: iso(time) }, new Date(time + 1));
  const oldUnsigned = { v: 3, id: e.id, ts: iso(time + 1), from: "sender@alpha", to: ["worker"], thread: e.id, reply_to: null, kind: "message",
    subject: "old", body: "body", needs_reply: false, refs: [], meta: { mentions: [], directives: [], tags: [], task_refs: [], origin: "external", external_since: iso(time), external_source: "inherited" }, authority: null, enc: null };
  assert.equal(w.sign(e).sig!.value, signData(key.privateKey, canonical(oldUnsigned)));
  assert.equal(Object.hasOwn(e.meta, "provenance"), false);
  assert.equal(checkShape(e), null);
  assert.equal(w.read(w.sign(e)).kind, "unknown");
  assert.deepEqual(externalExposure(e, time + EXTERNAL_TAINT_MS), { how: "inherited", root: time });
  const record = { v: 1 as const, cli: "codex", session_id: "session", root: time, from: "sender@alpha", id: e.id, how: "inherited" as const, relay_depth: [] };
  writeSessionTaint(db.store, record, time);
  const before = db.store.get(taintKey("codex", "session"));
  recordSessionExposure(db.store, "alpha", "codex", "session", w.make("firsthand-outside"), w.sources, time);
  assert.equal(db.store.get(taintKey("codex", "session")), before);
  assert.equal(readSessionTaint(db.store, "codex", "session", time)!.root, time);
  assert.equal(sessionUntainted(db.store, "codex", "session", time), false);
  assert.equal(sessionUntainted(db.store, "codex", "session", time + EXTERNAL_TAINT_MS), true);
  assert.equal(readSessionTaint(db.store, "codex", "session", time + EXTERNAL_TAINT_MS), null);
  writeSessionTaint(db.store, record, time + EXTERNAL_TAINT_MS);
  assert.equal(db.store.get(taintKey("codex", "session")), undefined, "existing v1 expired-write deletion is unchanged");
  assert.equal(readSessionExposure(db.store, "alpha", "codex", "session", time + EXTERNAL_TAINT_MS).record!.unknown, true, "legacy evidence cannot silently become clean");
});
test("durable root union and local disclosure times survive reopen, persona changes and shared sessions", t => {
  const db = database(t), w = world(), raw = w.make("firsthand-outside"), derived = w.make("derived-outside", [raw], time + 1);
  const record = (e: Envelope, at: number) => recordSessionExposure(db.store, "alpha", "codex", "shared", e, w.sources, at);
  const first = record(derived, time + 10).record!;
  assert.equal(first.roots[0].derived_at, time + 10);
  assert.equal(first.roots[0].raw_at, null);
  const rawRead = record(raw, time + 20).record!;
  assert.equal(rawRead.roots[0].raw_at, time + 20);
  assert.deepEqual(record(raw, time + 30).record, rawRead, "repeat raw read keeps first local disclosure");
  db.store.set("name:codex:shared", "new-persona");
  db.reopen();
  const secondTransport = new Store(db.home); t.after(() => secondTransport.close());
  const another = w.make("firsthand-outside", [], time + 40, "independent");
  recordSessionExposure(secondTransport, "alpha", "codex", "shared", another, w.sources, time + 50);
  const later = readSessionExposure(db.store, "alpha", "codex", "shared", time + EXTERNAL_TAINT_MS * 10).record!;
  assert.deepEqual(later.roots.map(x => x.source), [rootOf(raw), rootOf(another)]);
  assert.equal(later.roots[0].source.since, iso(time));
  assert.equal(later.generation, 3);
  for (const [host, cli, session] of [["beta", "codex", "shared"], ["alpha", "claude", "shared"], ["alpha", "codex", "sibling"]])
    assert.equal(readSessionExposure(db.store, host, cli, session, time).record, null);
});
test("missing/unknown history and clean labels never clear durable exposure", t => {
  const db = database(t), w = world(), agent = w.make("agent"), raw = w.make("firsthand-outside");
  assert.match(readSessionExposure(db.store, "alpha", "codex", "session", time).reason!, /missing/);
  assert.equal(recordSessionExposure(db.store, "alpha", "codex", "session", agent, w.sources, time).record, null);
  recordSessionExposure(db.store, "alpha", "codex", "session", raw, w.sources, time);
  const unknown = recordSessionExposure(db.store, "alpha", "codex", "session", w.make("unknown"), w.sources, time).record!;
  assert.equal(unknown.unknown, true);
  const later = recordSessionExposure(db.store, "alpha", "codex", "session", agent, w.sources, time + EXTERNAL_TAINT_MS * 10).record!;
  assert.deepEqual(later, unknown);
});
test("new disclosures advance the snapshot generation without renewing source lineage", t => {
  const db = database(t), w = world(), raw = w.make("firsthand-outside"), derived = w.make("derived-outside", [raw], time + 1);
  const record = (e: unknown, at: number) => recordSessionExposure(db.store, "alpha", "codex", "session", e, w.sources, at).record!;
  const first = record(raw, time + 10);
  const summary = record(derived, time + 20);
  assert.equal(summary.generation, first.generation + 1, "new payload with the same roots is a new exposure");
  assert.equal(summary.roots[0].last_message_id, derived.id);
  const reread = record(raw, time + EXTERNAL_TAINT_MS + 10);
  assert.equal(reread.roots[0].raw_at, time + EXTERNAL_TAINT_MS + 10);
  assert.equal(reread.roots[0].first_raw_at, time + 10);
  assert.equal(reread.roots[0].source.since, iso(time));
  const unknown = record(null, time + EXTERNAL_TAINT_MS + 20);
  assert.equal(record(null, time + EXTERNAL_TAINT_MS + 30).generation, unknown.generation + 1, "future unknown reads also advance the high-water mark");
  assert.equal(db.store.db.prepare("SELECT count(*) AS n FROM audit WHERE event='provenance.exposure_observed'").get()!.n, 5);
});
test("durable 65th root preserves the first 64 and marks history unknown", t => {
  const db = database(t), w = world();
  for (let i = 0; i < 65; i++) recordSessionExposure(db.store, "alpha", "codex", "session", w.make("firsthand-outside", [], time + i, String(i)), w.sources, time + i);
  const r = readSessionExposure(db.store, "alpha", "codex", "session", time + 100).record!;
  assert.equal(r.roots.length, 64); assert.equal(r.unknown, true); assert.equal(r.roots[0].source.since, iso(time));
});
test("a conflicting signed source cannot replace a retained root or clear unknown history", t => {
  const db = database(t), w = world(), raw = w.make("firsthand-outside");
  recordSessionExposure(db.store, "alpha", "codex", "session", raw, w.sources, time);
  const conflict = structuredClone(raw); conflict.body = "conflicting source"; conflict.meta.provenance!.content_sha256 = sha256(conflict.body);
  conflict.meta.provenance!.roots[0].content_sha256 = sha256(conflict.body);
  const r = recordSessionExposure(db.store, "alpha", "codex", "session", w.sign(conflict), w.sources, time).record!;
  assert.equal(r.unknown, true); assert.deepEqual(r.roots[0].source, rootOf(raw));
});
test("audit failure rolls back exposure roots and generation atomically", t => {
  const db = database(t), w = world(), first = w.make("firsthand-outside"), second = w.make("firsthand-outside", [], time, "second");
  recordSessionExposure(db.store, "alpha", "codex", "session", first, w.sources, time);
  const before = readSessionExposure(db.store, "alpha", "codex", "session", time), audit = db.store.audit;
  db.store.audit = () => { throw new Error("audit unavailable"); };
  try { assert.throws(() => recordSessionExposure(db.store, "alpha", "codex", "session", second, w.sources, time), /audit unavailable/); }
  finally { db.store.audit = audit; }
  assert.deepEqual(readSessionExposure(db.store, "alpha", "codex", "session", time), before);
  assert.equal(db.store.db.prepare("SELECT count(*) AS n FROM audit WHERE event='provenance.exposure_observed'").get()!.n, 1);
});
test("corrupt, future, legacy and unknown-version durable records are preserved and never clean", t => {
  const db = database(t), w = world(), raw = w.make("firsthand-outside");
  const valid = recordSessionExposure(db.store, "alpha", "codex", "session", raw, w.sources, time).record!;
  for (const bytes of ["{bad", "null", "[]", JSON.stringify({ ...valid, v: 1 }), JSON.stringify({ ...valid, v: 3 }), JSON.stringify({ ...valid, session_id: "sibling" }),
    JSON.stringify({ ...valid, roots: [] }), JSON.stringify({ ...valid, roots: [{ ...valid.roots[0], raw_at: time + 1 }] })]) {
    db.store.db.prepare("UPDATE session_exposures SET record=?").run(bytes);
    assert.equal(readSessionExposure(db.store, "alpha", "codex", "session", time).record, null, bytes);
    assert.equal(recordSessionExposure(db.store, "alpha", "codex", "session", raw, w.sources, time).record, null);
    assert.equal((db.store.db.prepare("SELECT record FROM session_exposures").get() as { record: string }).record, bytes);
  }
  assert.equal(readSessionExposure(db.store, "alpha", "codex", "bad\nkey", time).record, null);
  assert.equal(readSessionExposure(db.store, "alpha", "codex", "bad\n", time).record, null);
  assert.throws(() => recordSessionExposure(db.store, "alpha", "codex", "bad\n", raw, w.sources, time));
  const unavailable = new Store(db.home); unavailable.close();
  assert.equal(readSessionExposure(unavailable, "alpha", "codex", "session", time).record, null);
});
test("additive store migration preserves existing messages, v1 bytes and schema version", t => {
  const db = database(t), w = world(), legacy = w.sign(buildEnvelope({ from: "sender@alpha", to: ["worker"], subject: "old", body: "body" }, new Date(time)));
  db.store.insertMessage(legacy, "local", "local", null);
  const bytes = db.store.get("legacy") ?? "{\"v\":1,\"root\":42}"; db.store.set("legacy", bytes);
  const schema = db.store.schemaVersion();
  db.store.db.exec("DROP TABLE session_exposures"); db.reopen();
  assert.equal(db.store.hasMessage(legacy.id), true);
  assert.equal(db.store.get("legacy"), bytes);
  assert.equal(db.store.schemaVersion(), schema);
  assert.equal(db.store.db.prepare("SELECT count(*) AS n FROM session_exposures").get()!.n, 0);
});
