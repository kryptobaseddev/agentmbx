// S4 validates evidence only. S6 owns authorization; S7 must demonstrate an adapter before enabling one.
import { z } from "zod";
import { realpathSync } from "node:fs";
import { canonical, fingerprint, nonce, sha256, verifyData } from "./crypto.ts";
import { checkShape, verifyEnvelope, type Envelope } from "./envelope.ts";
import { IdentityLeases, identityLeaseStatus, inspectLeaseProcess, type IdentityLease } from "./identity-leases.ts";
import { activeLead } from "./lead-record.ts";
import { resolveProject } from "./project-key.ts";
import { readSessionExposure } from "./session-taint.ts";
import type { MbxNode } from "./node.ts";

const text = z.string().min(1).max(1024).refine(s => s === s.trim() && !/[\u0000-\u001f\u007f-\u009f]/u.test(s) && s !== "*");
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const id = z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/);
const actor = z.object({ agent: text, cli: text, session_id: text }).strict();
const binding = z.object({ worker: actor, request_id: id, project: text,
  operation: z.enum(["push", "draft-pr"]), destination: text }).strict();
export type ActionBinding = z.infer<typeof binding>;

const root = z.object({ message_id: id, content_sha256: digest }).strict();
const capture = z.object({
  sealed: z.literal(true), history_excluded: z.literal(true), workspace_proved: z.literal(true),
  inputs: z.array(z.object({ source_id: text, content_sha256: digest, ancestry_proof: digest,
    kind: z.enum(["request", "agent", "workspace", "toolchain"]), parents: z.array(text).max(128) }).strict()).min(1).max(128),
  excluded_roots: z.array(root).max(64),
  artifact: z.object({ head: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/), worktree_generation: digest,
    output_sha256: digest }).strict(),
}).strict();
export type IsolationCapture = z.infer<typeof capture>;

/** Installed broker code, never a tool argument. capture must measure a sealed run and current output below the model. */
export interface IsolationAdapter {
  id: string; version: string; capability: "sealed-inputs-and-action-v1"; publicKey: string;
  capture(binding: ActionBinding): IsolationCapture | null;
}
/** No provider's process/session metadata currently proves input isolation. */
export const PRODUCTION_ISOLATION_ADAPTERS: readonly IsolationAdapter[] = Object.freeze([]);
const adapterRef = z.object({ id: text, version: text, capability: z.literal("sealed-inputs-and-action-v1") }).strict();
const context = z.object({ role: z.enum(["worker", "lead"]), actor,
  binding_sha256: digest, lease_sha256: digest, exposure_sha256: digest, generation: z.number().int().positive(),
  roots: z.array(root).max(64) }).strict();
const snapshot = z.object({ host: text, project_key: text, worktree: text, request_sha256: digest,
  request_kind: z.enum(["owner", "lead"]), lead_record: id.nullable(),
  contexts: z.array(context).min(1).max(64), capture }).strict();
const receipt = z.object({ v: z.literal(1), type: z.literal("isolated-action"),
  nonce: z.string().regex(/^[A-Za-z0-9_-]{22}$/), adapter: adapterRef, binding,
  snapshot, iat: z.number().int().nonnegative(), exp: z.number().int().nonnegative() }).strict();
export type IsolationReceipt = z.infer<typeof receipt>;
const signedReceipt = z.object({ rec: receipt, sig: z.string().max(128) }).strict();
export interface IsolationResult { ok: boolean; reason: string }
const MAX_RECEIPT_MS = 60_000;
const key = (n: string) => `action-context:${n}`;
const equal = (a: unknown, b: unknown) => canonical(a) === canonical(b);
function fail(reason: string): never { throw new Error(reason); }

/** No public registration/receipt tool and no approval path. Explicit adapter injection is for trusted broker code/fixtures. */
export class ActionContextBoundary {
  #node: MbxNode;
  #adapters: Map<string, IsolationAdapter>;
  constructor(node: MbxNode, adapters: readonly IsolationAdapter[] = PRODUCTION_ISOLATION_ADAPTERS) {
    this.#node = node;
    this.#adapters = new Map();
    for (const a of adapters) {
      adapterRef.parse({ id: a.id, version: a.version, capability: a.capability });
      if (this.#adapters.has(a.id) || Buffer.from(a.publicKey, "base64").length !== 32 || typeof a.capture !== "function") fail("invalid adapter registry");
      this.#adapters.set(a.id, Object.freeze({ ...a }));
    }
  }

  #adapter(ref: z.infer<typeof adapterRef>): IsolationAdapter {
    const a = this.#adapters.get(ref.id);
    if (!a || a.version !== ref.version || a.capability !== ref.capability) fail("unsupported isolation adapter/version/capability");
    return a;
  }

  #facts(b: ActionBinding, now: number, inspect: boolean) {
    const node = this.#node, worktree = realpathSync(b.project), project = resolveProject(worktree);
    const row = node.message(b.request_id, b.worker.agent);
    if (!row) fail("request is not visible to the worker");
    const e = JSON.parse(row.envelope) as Envelope;
    if (checkShape(e) || e.from !== row.from_addr || e.sig?.host !== node.host
      || !node.hostKeys(node.host).some(pub => verifyEnvelope(e, pub))) fail("request is not locally authenticated");
    if (!e.meta.project || resolveProject(realpathSync(e.meta.project)).key !== project.key) fail("request project mismatch");
    if (!["request", "task"].includes(e.kind)) fail("message is not a request/assignment");
    const authority = node.authorityFor(row);
    const owner = authority?.ok === true && authority.session === "signed by the owner";
    const lead = owner ? null : activeLead(node, worktree, new Date(now));
    if (!owner && (!lead || lead.host !== node.host || e.from !== `${lead.agent}@${node.host}` || lead.agent === b.worker.agent
      || e.meta.sender_verification !== "leased")) fail("request is not from the owner/current local lead");
    const wanted: { role: "worker" | "lead"; actor: ActionBinding["worker"] }[] = [{ role: "worker", actor: b.worker }];
    if (lead) {
      const lease = node.store.db.prepare("SELECT * FROM identity_leases WHERE name=?").get(lead.agent) as IdentityLease | undefined;
      if (!lease) fail("lead lease missing");
      const scopes = new Map([[canonical([lease.cli, lease.session_id]), { agent: lead.agent, cli: lease.cli, session_id: lease.session_id }]]);
      for (const s of node.store.db.prepare("SELECT cli,session_id FROM sessions WHERE agent=? LIMIT 65").all(lead.agent) as { cli: string; session_id: string }[])
        scopes.set(canonical([s.cli, s.session_id]), { agent: lead.agent, ...s });
      if (scopes.size > 63) fail("lead context coverage overflow");
      for (const s of [...scopes.values()].sort((a, b) => canonical(a).localeCompare(canonical(b)))) wanted.push({ role: "lead", actor: s });
    }
    const contexts = wanted.map(({ role, actor: who }) => {
      const s = node.store.db.prepare("SELECT * FROM sessions WHERE cli=? AND session_id=?").get(who.cli, who.session_id) as
        { agent: string; cli: string; session_id: string; pid: number | null; pid_start: string | null; session_key: string | null; cwd: string | null; updated_at: string } | undefined;
      const lease = node.store.db.prepare("SELECT * FROM identity_leases WHERE name=?").get(who.agent) as IdentityLease | undefined;
      if (!s || s.agent !== who.agent || !s.pid || !s.session_key || !s.cwd || !Number.isFinite(Date.parse(s.updated_at))
        || (role === "worker" ? realpathSync(s.cwd) !== worktree : resolveProject(realpathSync(s.cwd)).key !== project.key)
        || !lease || lease.cli !== who.cli || lease.released_at !== null
        || Date.parse(s.updated_at) > now || fingerprint(s.session_key) !== lease.key_fp || lease.heartbeat_at > now || now - lease.heartbeat_at >= lease.idle_ttl)
        fail("conversation/lease/project binding is not current");
      if (inspect && (!node.sameSession(s.pid, s, { proof: true })
        || identityLeaseStatus(lease, now, inspectLeaseProcess(lease.holder_pid)).state !== "live")) fail("conversation process is not proven live");
      const x = readSessionExposure(node.store, node.host, who.cli, who.session_id, now);
      if (!x.record || x.record.unknown) fail("incomplete exposure coverage");
      return { role, actor: who, binding_sha256: sha256(canonical(s)), lease_sha256: sha256(canonical({ token: lease.token, key: lease.key_fp, claimed: lease.claimed_at })),
        exposure_sha256: sha256(canonical(x.record)), generation: x.record.generation,
        roots: x.record.roots.map(r => ({ message_id: r.source.message_id, content_sha256: r.source.content_sha256 })).sort((a, b) => a.message_id.localeCompare(b.message_id)) };
    });
    return { host: node.host, project_key: project.key, worktree, request_sha256: sha256(canonical(e)),
      request_kind: owner ? "owner" as const : "lead" as const, lead_record: lead?.id ?? null, contexts };
  }

  #snapshot(b: ActionBinding, a: IsolationAdapter, now: number): z.infer<typeof snapshot> {
    const measured = capture.parse(a.capture(structuredClone(b))), facts = this.#facts(b, now, true);
    const roots = new Map<string, z.infer<typeof root>>();
    for (const c of facts.contexts) for (const r of c.roots) {
      if (roots.has(r.message_id) && !equal(roots.get(r.message_id), r)) fail("conflicting exposure roots");
      roots.set(r.message_id, r);
    }
    const sorted = (rs: z.infer<typeof root>[]) => [...rs].sort((a, b) => a.message_id.localeCompare(b.message_id));
    if (!equal(sorted(measured.excluded_roots), sorted([...roots.values()]))) fail("exposed lead/worker roots are not excluded");
    const inputs = new Map(measured.inputs.map(i => [i.source_id, i]));
    const outsideDigests = new Set([...roots.values()].map(r => r.content_sha256));
    if (inputs.size !== measured.inputs.length || measured.inputs.some(i => roots.has(i.source_id) || outsideDigests.has(i.content_sha256)
      || new Set(i.parents).size !== i.parents.length || i.parents.some(p => !inputs.has(p) || roots.has(p)))) fail("unproved or outside input ancestry");
    const request = inputs.get(b.request_id);
    if (!request || request.kind !== "request" || request.content_sha256 !== facts.request_sha256) fail("exact request input is not proved");
    // A cycle supplies no grounded ancestor, even if every parent id appears in the manifest.
    const complete = new Set<string>();
    for (let pass = 0; pass < inputs.size; pass++) for (const i of inputs.values())
      if (i.parents.every(p => complete.has(p))) complete.add(i.source_id);
    if (complete.size !== inputs.size) fail("cyclic input ancestry");
    return snapshot.parse({ ...facts, capture: measured });
  }

  #held<T>(b: ActionBinding, facts: Omit<z.infer<typeof snapshot>, "capture">, leaseToken: string, now: number, checkedAt: number, fn: (currentNow: number) => T): T {
    const node = this.#node;
    return new IdentityLeases(node.store).withHeld(b.worker.agent, leaseToken, () => {
      const elapsed = Math.ceil(performance.now() - checkedAt), currentNow = Math.max(Date.now(), now + elapsed);
      if (elapsed > 5000 || !equal(this.#facts(b, currentNow, false), facts)) fail("context changed before receipt use");
      return fn(currentNow);
    });
  }

  /** Ask an approved adapter to sign this exact daemon-captured challenge; no key or capability comes from the model. */
  challenge(value: ActionBinding, adapterId: string, leaseToken: string, now = Date.now()): IsolationReceipt {
    const b = binding.parse(value), a = this.#adapters.get(adapterId);
    if (!a) fail("unsupported isolation adapter/version/capability");
    if (!Number.isSafeInteger(now) || now < 0) fail("invalid receipt time");
    const checkedAt = performance.now(), observed = this.#snapshot(b, a, now), { capture: _, ...facts } = observed;
    const rec: IsolationReceipt = { v: 1, type: "isolated-action", nonce: nonce(), adapter: { id: a.id, version: a.version, capability: a.capability },
      binding: b, snapshot: observed, iat: now, exp: now + MAX_RECEIPT_MS };
    return this.#held(b, facts, leaseToken, now, checkedAt, () => {
      this.#node.store.set(key(rec.nonce), canonical(rec));
      this.#node.store.audit("action_context.challenge", { nonce: rec.nonce, request_id: b.request_id, adapter: rec.adapter });
      return rec;
    });
  }

  /** Consume one proof atomically. A valid proof still grants no action class or provider approval. */
  consume(value: unknown, current: ActionBinding, leaseToken: string, now = Date.now()): IsolationResult {
    const checkedAt = performance.now();
    try {
      const { rec, sig } = signedReceipt.parse(value), b = binding.parse(current), a = this.#adapter(rec.adapter);
      if (!Number.isSafeInteger(now) || now < rec.iat || rec.exp <= now || rec.exp - rec.iat > MAX_RECEIPT_MS || rec.exp <= rec.iat) fail("stale or invalid receipt lifetime");
      if (!verifyData(a.publicKey, canonical(rec), sig)) fail("untrusted adapter signature");
      if (!equal(b, rec.binding)) fail("request/action/conversation binding changed");
      if (this.#node.store.get(key(rec.nonce)) !== canonical(rec)) fail("unknown, altered or consumed dispatch nonce");
      const observed = this.#snapshot(b, a, now), { capture: _, ...facts } = observed;
      if (!equal(observed, rec.snapshot)) fail("input/root/artifact context changed");
      return this.#held(b, facts, leaseToken, now, checkedAt, currentNow => {
        if (rec.exp <= currentNow) fail("expired receipt at final use");
        const deleted = this.#node.store.db.prepare("DELETE FROM kv WHERE k=? AND v=?").run(key(rec.nonce), canonical(rec)).changes;
        if (deleted !== 1) fail("dispatch nonce already consumed");
        this.#node.store.audit("action_context.receipt_consumed", { nonce: rec.nonce, request_id: b.request_id, adapter: rec.adapter });
        return { ok: true, reason: "isolation receipt validated; no action authority granted" };
      });
    } catch (error) { return { ok: false, reason: error instanceof Error ? error.message : "unreadable isolation evidence" }; }
  }
}
