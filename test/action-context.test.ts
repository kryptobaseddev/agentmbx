import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ActionContextBoundary, PRODUCTION_ISOLATION_ADAPTERS, type ActionBinding, type IsolationAdapter, type IsolationCapture, type IsolationReceipt } from "../src/action-context.ts";
import { canonical, fingerprint, generateKeyPair, sha256, signData } from "../src/crypto.ts";
import { buildEnvelope, createContentProvenance, signEnvelope, type Envelope } from "../src/envelope.ts";
import { IdentityLeases, inspectLeaseProcess } from "../src/identity-leases.ts";
import { makeLead, storeLead } from "../src/lead-record.ts";
import { MbxNode } from "../src/node.ts";
import { readSessionExposure } from "../src/session-taint.ts";
import { decidePermission } from "../src/permission.ts";

function fixture(t: TestContext, leadRequest = false) {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "mbx-action-context-")));
  mkdirSync(join(home, ".cleo")); writeFileSync(join(home, ".cleo", "project-id"), sha256(home).slice(0, 16));
  const node = new MbxNode(home, { host: "alpha" }), leases = new IdentityLeases(node.store);
  t.after(() => { node.close(); rmSync(home, { recursive: true, force: true }); });
  // An installed fixture adapter measures a real output file; it does not demonstrate provider isolation.
  const output = join(home, "output"), owner = generateKeyPair(), adapterKey = generateKeyPair();
  writeFileSync(output, "independent output");
  // Use a real existing directory for exact worktree/project binding.
  const folder = home;
  writeFileSync(join(home, "owner.json"), JSON.stringify({ v: 1, backend: "keychain", public_key: owner.publicKey })); node.syncOwner();
  const bindings = new Map<string, { scope: ActionBinding["worker"]; token: string; publicKey: string }>();
  function bind(agent: string, session = agent) {
    const k = generateKeyPair(), scope = { agent, cli: "codex", session_id: session };
    node.bindSession({ ...scope, pid: process.pid, session_key: k.publicKey, cwd: folder });
    const l = leases.claim(agent, { pid: process.pid, start: inspectLeaseProcess(process.pid).start!, keyFp: fingerprint(k.publicKey), cli: scope.cli, sessionId: session });
    const value = { scope, token: l.token, publicKey: k.publicKey }; bindings.set(agent, value); return value;
  }
  const worker = bind("worker");
  function raw(to: string, session = to, at = Date.now()) {
    const e = buildEnvelope({ from: "source@alpha", to: [to], subject: "outside", body: "untrusted", origin: "external" }, new Date(at));
    e.meta.sender_verification = "leased";
    e.meta.provenance = createContentProvenance(e, [], node.provenanceSources(e), "firsthand-outside").record;
    const signed = signEnvelope(e, "alpha", node.key.publicKey, node.key.privateKey);
    node.store.insertMessage(signed, "local", "local", null); node.store.addDelivery(signed.id, to);
    node.observeRead(node.read(signed.id, to), "codex", session, "full", at); return signed;
  }
  raw("worker");
  let leadId: string | null = null;
  if (leadRequest) {
    bind("leader"); raw("leader");
    const r = makeLead({ project: folder, agent: "leader", host: "alpha", ownerPub: owner.publicKey });
    storeLead(node, r, signData(owner.privateKey, canonical(r))); leadId = r.id;
  }
  const draft = { from: leadRequest ? "leader" : "owner", to: ["worker"], kind: "task" as const, subject: "independent task", body: "publish independent output", project: folder };
  const request = leadRequest ? leases.withHeld("leader", bindings.get("leader")!.token, () => node.send(draft).envelope)
    : node.send(draft, undefined, { pub: owner.publicKey, priv: owner.privateKey }).envelope;
  const b: ActionBinding = { worker: worker.scope, request_id: request.id, project: folder, operation: "push", destination: "origin:refs/heads/task/fixture" };
  let head = "a".repeat(40), generation = "generation-1", override: ((c: IsolationCapture) => IsolationCapture) | undefined;
  const adapter: IsolationAdapter = { id: "trusted-fixture", version: "1", capability: "sealed-inputs-and-action-v1", publicKey: adapterKey.publicKey,
    capture: () => {
      const excluded = new Map<string, { message_id: string; content_sha256: string }>();
      for (const { scope } of bindings.values()) for (const r of readSessionExposure(node.store, node.host, scope.cli, scope.session_id).record?.roots ?? [])
        excluded.set(r.source.message_id, { message_id: r.source.message_id, content_sha256: r.source.content_sha256 });
      const c: IsolationCapture = { sealed: true, history_excluded: true, workspace_proved: true,
        inputs: [{ source_id: request.id, content_sha256: sha256(canonical(request)), ancestry_proof: sha256("fixture sealed request capture"), kind: "request", parents: [] },
          { source_id: "workspace-input", content_sha256: sha256("independent base"), ancestry_proof: sha256("fixture sealed workspace capture"), kind: "workspace", parents: [] }],
        excluded_roots: [...excluded.values()], artifact: { head, worktree_generation: sha256(generation), output_sha256: sha256(readFileSync(output)) } };
      return override ? override(c) : c;
    } };
  const boundary = new ActionContextBoundary(node, [adapter]);
  const sign = (rec: IsolationReceipt, privateKey = adapterKey.privateKey) => ({ rec, sig: signData(privateKey, canonical(rec)) });
  return { node, leases, worker, b, request, adapter, boundary, sign, raw, bind, bindings, owner, output, leadId,
    setHead: (h: string) => { head = h; }, setGeneration: (g: string) => { generation = g; },
    override: (f: (c: IsolationCapture) => IsolationCapture) => { override = f; } };
}

for (const lead of [false, true]) test(`S4 trusted ${lead ? "lead assignment" : "owner request"} receipt binds live context and is consumed exactly once`, t => {
  const f = fixture(t, lead), rec = f.boundary.challenge(f.b, f.adapter.id, f.worker.token), signed = f.sign(rec);
  assert.equal(rec.snapshot.lead_record, f.leadId);
  assert.deepEqual(rec.snapshot.contexts.map(c => c.role), lead ? ["worker", "lead"] : ["worker"]);
  assert.equal(rec.snapshot.contexts.every(c => c.roots.length > 0), true);
  assert.equal(JSON.stringify(rec).includes(f.worker.token), false);
  assert.equal(f.boundary.consume(signed, f.b, f.worker.token).ok, true);
  assert.equal(f.boundary.consume(signed, f.b, f.worker.token).ok, false);
  const events = f.node.store.db.prepare("SELECT event FROM audit WHERE event='action_context.receipt_consumed'").all();
  assert.equal(events.length, 1);
  assert.equal(new ActionContextBoundary(f.node, [f.adapter]).consume(signed, f.b, f.worker.token).ok, false, "new broker cannot replay a consumed nonce");
});

test("S4 production table is empty and neither model flags nor host signatures create a capability", t => {
  const f = fixture(t), rec = f.boundary.challenge(f.b, f.adapter.id, f.worker.token), production = new ActionContextBoundary(f.node);
  assert.equal(PRODUCTION_ISOLATION_ADAPTERS.length, 0); assert.equal(Object.isFrozen(PRODUCTION_ISOLATION_ADAPTERS), true);
  assert.throws(() => production.challenge(f.b, f.adapter.id, f.worker.token), /unsupported/);
  assert.equal(production.consume(f.sign(rec), f.b, f.worker.token).ok, false);
  assert.equal(f.boundary.consume({ clean: true, isolated: true }, f.b, f.worker.token).ok, false);
  assert.equal(f.boundary.consume(f.sign(rec, f.node.key.privateKey), f.b, f.worker.token).ok, false);
});

for (const field of ["nonce", "adapter", "binding", "snapshot", "iat", "exp"] as const) test(`S4 unsigned or re-signed altered ${field} cannot replace issued daemon evidence`, t => {
  const f = fixture(t), rec = f.boundary.challenge(f.b, f.adapter.id, f.worker.token), altered = structuredClone(rec);
  if (field === "nonce") altered.nonce = "B".repeat(22);
  if (field === "adapter") altered.adapter.version = "unknown";
  if (field === "binding") altered.binding.destination = "origin:refs/heads/other";
  if (field === "snapshot") altered.snapshot.capture.artifact.output_sha256 = "b".repeat(64);
  if (field === "iat") altered.iat--;
  if (field === "exp") altered.exp++;
  assert.equal(f.boundary.consume({ rec: altered, sig: f.sign(rec).sig }, f.b, f.worker.token).ok, false);
  assert.equal(f.boundary.consume(f.sign(altered), f.b, f.worker.token).ok, false);
  assert.equal(f.boundary.consume(f.sign(rec), f.b, f.worker.token).ok, true, "invalid attempts do not consume the genuine nonce");
});

for (const mutation of ["session", "cli", "agent", "project", "operation", "destination", "request", "host", "lease", "release", "binding", "roots", "output", "head", "generation", "expiry", "future"]) test(`S4 current ${mutation} substitution/change denies`, t => {
  const f = fixture(t), rec = f.boundary.challenge(f.b, f.adapter.id, f.worker.token), b = structuredClone(f.b);
  if (mutation === "session") b.worker.session_id = "sibling";
  if (mutation === "cli") b.worker.cli = "claude";
  if (mutation === "agent") b.worker.agent = "other";
  if (mutation === "project") b.project = tmpdir();
  if (mutation === "operation") b.operation = "draft-pr";
  if (mutation === "destination") b.destination = "another repository";
  if (mutation === "request") b.request_id = f.raw("worker").id;
  if (mutation === "host") f.node.config.host = "other";
  if (mutation === "lease") f.node.store.db.prepare("UPDATE identity_leases SET token='replacement' WHERE name='worker'").run();
  if (mutation === "release") f.leases.release("worker", f.worker.token);
  if (mutation === "binding") f.node.store.db.prepare("UPDATE sessions SET session_key=? WHERE agent='worker'").run(generateKeyPair().publicKey);
  if (mutation === "roots") f.raw("worker");
  if (mutation === "output") writeFileSync(f.output, "altered output");
  if (mutation === "head") f.setHead("b".repeat(40));
  if (mutation === "generation") f.setGeneration("generation-2");
  const now = mutation === "expiry" ? rec.exp : mutation === "future" ? rec.iat - 1 : Date.now();
  assert.equal(f.boundary.consume(f.sign(rec), b, f.worker.token, now).ok, false);
});

for (const mutation of ["unsealed", "history", "workspace", "unknown", "missing-proof", "raw-parent", "unknown-parent", "duplicate-parent", "duplicate-input", "outside-input", "outside-digest", "missing-root", "extra-root", "wrong-root-digest", "request-digest", "cycle", "overflow", "clean-flag"]) test(`S4 adapter capture rejects ${mutation}`, t => {
  const f = fixture(t);
  f.override(c => {
    const bad = c as unknown as Record<string, unknown>;
    if (mutation === "unsealed") c.sealed = false as true;
    if (mutation === "history") c.history_excluded = false as true;
    if (mutation === "workspace") c.workspace_proved = false as true;
    if (mutation === "unknown") c.inputs[1].kind = "unknown" as "workspace";
    if (mutation === "missing-proof") delete (c.inputs[1] as Partial<typeof c.inputs[number]>).ancestry_proof;
    if (mutation === "raw-parent") c.inputs[1].parents = [c.excluded_roots[0].message_id];
    if (mutation === "unknown-parent") c.inputs[1].parents = ["unproved ancestor"];
    if (mutation === "duplicate-parent") c.inputs[1].parents = [c.inputs[0].source_id, c.inputs[0].source_id];
    if (mutation === "duplicate-input") c.inputs.push(c.inputs[0]);
    if (mutation === "outside-input") c.inputs[1].source_id = c.excluded_roots[0].message_id;
    if (mutation === "outside-digest") c.inputs[1].content_sha256 = c.excluded_roots[0].content_sha256;
    if (mutation === "missing-root") c.excluded_roots = [];
    if (mutation === "extra-root") c.excluded_roots.push({ message_id: "0".repeat(26), content_sha256: "a".repeat(64) });
    if (mutation === "wrong-root-digest") c.excluded_roots[0].content_sha256 = "b".repeat(64);
    if (mutation === "request-digest") c.inputs[0].content_sha256 = "b".repeat(64);
    if (mutation === "cycle") c.inputs[1].parents = [c.inputs[1].source_id];
    if (mutation === "overflow") c.inputs = Array.from({ length: 129 }, () => c.inputs[0]);
    if (mutation === "clean-flag") bad.clean = true;
    return c;
  });
  assert.throws(() => f.boundary.challenge(f.b, f.adapter.id, f.worker.token));
});

for (const mutation of ["new-lead-context", "new-lead-root", "lead-lease", "replaced-lead", "unknown-exposures", "corrupt-exposures", "unsigned-request"]) test(`S4 ${mutation} cannot launder an exposed assignment`, t => {
  const f = fixture(t, true), rec = f.boundary.challenge(f.b, f.adapter.id, f.worker.token);
  if (mutation === "new-lead-context") {
    const leader = f.bindings.get("leader")!;
    f.node.bindSession({ agent: "leader", cli: "codex", session_id: "lead-sibling", pid: process.pid, session_key: leader.publicKey, cwd: f.b.project });
    f.raw("leader", "lead-sibling");
  }
  if (mutation === "new-lead-root") f.raw("leader");
  if (mutation === "lead-lease") f.leases.release("leader", f.bindings.get("leader")!.token);
  if (mutation === "replaced-lead") {
    const r = makeLead({ project: f.b.project, agent: "other-lead", host: "alpha", ownerPub: f.owner.publicKey });
    storeLead(f.node, r, signData(f.owner.privateKey, canonical(r)));
  }
  if (mutation === "unknown-exposures") f.node.store.db.prepare("DELETE FROM session_exposures WHERE session_id='leader'").run();
  if (mutation === "corrupt-exposures") f.node.store.db.prepare("UPDATE session_exposures SET record='{}' WHERE session_id='worker'").run();
  if (mutation === "unsigned-request") {
    const e = { ...f.request, body: "tampered assignment" } as Envelope;
    f.node.store.db.prepare("UPDATE messages SET envelope=? WHERE id=?").run(JSON.stringify(e), e.id);
  }
  assert.equal(f.boundary.consume(f.sign(rec), f.b, f.worker.token).ok, false);
});

test("S4 valid observation receipts never relax the existing real permission fence", async t => {
  const f = fixture(t), rec = f.boundary.challenge(f.b, f.adapter.id, f.worker.token);
  assert.equal(f.boundary.consume(f.sign(rec), f.b, f.worker.token).ok, true);
  const result = await decidePermission({ session_id: "worker", tool_name: "Bash", tool_input: { command: "git push origin HEAD:task/fixture" }, cwd: f.b.project },
    "codex", () => ({ ok: true }), { node: f.node, pid: process.pid, preflight: async () => true });
  assert.equal(result.allow, false);
  assert.equal(f.node.store.db.prepare("SELECT count(*) n FROM audit WHERE event IN ('yolo_allow','lead.grant_used')").get()!.n, 0);
});

test("S4 caller must already possess the exact worker lease token below receipt arguments", t => {
  const f = fixture(t), rec = f.boundary.challenge(f.b, f.adapter.id, f.worker.token);
  assert.throws(() => f.boundary.challenge(f.b, f.adapter.id, "guessed-token"));
  assert.equal(f.boundary.consume(f.sign(rec), f.b, "guessed-token").ok, false);
  assert.equal(f.boundary.consume(f.sign(rec), f.b, f.worker.token).ok, true);
});

test("S4 exposed lead conversation may bind another checkout of the same receiving project", t => {
  const f = fixture(t, true), cwd = join(f.b.project, "lead-checkout"); mkdirSync(cwd);
  f.node.bindSession({ ...f.bindings.get("leader")!.scope, pid: process.pid, session_key: f.bindings.get("leader")!.publicKey, cwd });
  const rec = f.boundary.challenge(f.b, f.adapter.id, f.worker.token);
  assert.equal(f.boundary.consume(f.sign(rec), f.b, f.worker.token).ok, true);
});

test("S4 final database fence catches a worker exposure acquired after its first snapshot", t => {
  const f = fixture(t, true), rec = f.boundary.challenge(f.b, f.adapter.id, f.worker.token);
  const original = f.node.sameSession.bind(f.node), locked: boolean[] = []; let raced = false;
  f.node.sameSession = (pid, row, options) => {
    locked.push(f.node.store.db.isTransaction);
    const result = original(pid, row, options);
    if (!raced && (row as { agent?: string }).agent === "leader") { raced = true; f.raw("worker", "worker", rec.iat); }
    return result;
  };
  const result = f.boundary.consume(f.sign(rec), f.b, f.worker.token);
  assert.equal(raced, true); assert.equal(result.ok, false);
  assert.match(result.reason, /context changed before receipt use/);
  assert.equal(locked.every(value => !value), true, "process evidence is collected outside the SQLite write lock");
  assert.equal(f.node.store.get(`action-context:${rec.nonce}`), canonical(rec), "failed final recheck never consumes the nonce");
});

test("S4 failed consumption audit rolls back the nonce rather than losing retriable evidence", t => {
  const f = fixture(t), rec = f.boundary.challenge(f.b, f.adapter.id, f.worker.token);
  const audit = f.node.store.audit.bind(f.node.store);
  f.node.store.audit = (event, detail) => { if (event === "action_context.receipt_consumed") throw new Error("fixture audit failure"); return audit(event, detail); };
  assert.equal(f.boundary.consume(f.sign(rec), f.b, f.worker.token).ok, false);
  assert.equal(f.node.store.get(`action-context:${rec.nonce}`), canonical(rec));
  f.node.store.audit = audit;
  assert.equal(f.boundary.consume(f.sign(rec), f.b, f.worker.token).ok, true);
});

test("S4 receipt expiring during adapter capture cannot be consumed", t => {
  const f = fixture(t), rec = f.boundary.challenge(f.b, f.adapter.id, f.worker.token);
  f.override(c => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10); return c; });
  const result = f.boundary.consume(f.sign(rec), f.b, f.worker.token, rec.exp - 1);
  assert.equal(result.ok, false);
  assert.match(result.reason, /expired receipt at final use/);
  assert.equal(f.node.store.get(`action-context:${rec.nonce}`), canonical(rec));
});

test("S4 final receipt deadline includes decoding and signature validation", t => {
  const f = fixture(t), rec = f.boundary.challenge(f.b, f.adapter.id, f.worker.token), signed = f.sign(rec);
  const input = { get rec() { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20); return rec; }, sig: signed.sig };
  const result = f.boundary.consume(input, f.b, f.worker.token, rec.exp - 10);
  assert.equal(result.ok, false); assert.match(result.reason, /expired receipt at final use/);
  assert.equal(f.node.store.get(`action-context:${rec.nonce}`), canonical(rec));
});
