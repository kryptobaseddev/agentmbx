// Local CLI-to-MCP coordination, not isolation against another process with access to this user's DB.
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { canonical, sha256 } from "./crypto.ts";
import { NAME_RE } from "./envelope.ts";
import { inspectLeaseProcess } from "./identity-leases.ts";
import { procTable, withProcSnapshot } from "./proc.ts";
import type { Store } from "./store.ts";
import { identityTakeoverApprovalSchema, type IdentityTakeoverApproval } from "./identity-takeover.ts";
import { SCHEMA_VERSION } from "./store.ts";

const pid = z.number().int().positive(), label = z.string().min(1).max(300);
const descriptorSchema = z.object({ v: z.literal(1), cli: label, session_id: label, lease_session_id: label, control_key: label,
  mcp_pid: pid, mcp_start: label, parent_pid: pid, parent_start: label, agent: z.string().regex(NAME_RE),
  generation: z.string().regex(/^[a-f0-9]{64}$/).nullable() }).strict();
export type IdentityControlDescriptor = z.infer<typeof descriptorSchema>;
const requestSchema = z.object({ v: z.literal(1), id: z.string().uuid(), action: z.enum(["claim", "release", "takeover"]),
  name: z.string().regex(NAME_RE).optional(), approval: identityTakeoverApprovalSchema.optional(), target: descriptorSchema, requester_pid: pid, requester_start: label,
  created_at: z.number().int().nonnegative(), expires_at: z.number().int().nonnegative(), status: z.literal("pending") }).strict().refine(r => r.action === "takeover" ? !!r.name && !!r.approval : !r.approval, "takeover requires a name and owner approval; other actions cannot carry approval");
export type IdentityControlRequest = z.infer<typeof requestSchema>;
export type IdentityControlReceipt = Omit<IdentityControlRequest, "status"> & {
  status: "pending" | "completed" | "failed"; completed_at?: number; result?: unknown; error?: string;
};
const fail = (message: string) => Object.assign(new Error(message), { code: "IDENTITY_CONTROL_REFUSED" });
export const identityControlKey = (cli: string, sessionId: string) => `identity-control:${sha256(canonical([cli, sessionId]))}`;
export const identityRequestKey = (id: string) => `identity-request:${z.string().uuid().parse(id)}`;
export const identityGeneration = (token?: string) => token ? sha256(token) : null;

export function publishIdentityControl(store: Store, descriptor: IdentityControlDescriptor) {
  const valid = descriptorSchema.parse(descriptor);
  store.set(identityControlKey(valid.cli, valid.session_id), JSON.stringify(valid));
}
export function findIdentityControl(store: Store, cli: string, sessionId: string): IdentityControlDescriptor {
  const raw = store.get(identityControlKey(cli, sessionId));
  if (!raw) throw fail("no running MCP control endpoint for that provider/session; call mbx_whoami in that session first");
  const descriptor = descriptorSchema.parse(JSON.parse(raw));
  if (descriptor.cli !== cli || descriptor.session_id !== sessionId) throw fail("control endpoint identity mismatch");
  return descriptor;
}
export function listIdentityControls(store: Store): IdentityControlDescriptor[] {
  return store.db.prepare("SELECT v FROM kv WHERE k GLOB 'identity-control:*'").all().flatMap(row => {
    try { const parsed = descriptorSchema.safeParse(JSON.parse(row.v as string)); return parsed.success ? [parsed.data] : []; }
    catch { return []; }
  });
}
export function identityControlAliases(store: Store, controlKey: string): IdentityControlDescriptor[] {
  return listIdentityControls(store).filter(descriptor => descriptor.control_key === controlKey);
}
export function removeIdentityControl(store: Store, controlKey: string) {
  for (const descriptor of identityControlAliases(store, controlKey)) store.db.prepare("DELETE FROM kv WHERE k=?").run(identityControlKey(descriptor.cli, descriptor.session_id));
}

/** All process inspection precedes the operation's transaction. Missing proof never authorizes it. */
export function inspectIdentityControlCaller(target: IdentityControlDescriptor, requesterPid: number, requesterStart: string) {
  const at = performance.now();
  const requester = inspectLeaseProcess(requesterPid), parent = inspectLeaseProcess(target.parent_pid), mcp = inspectLeaseProcess(target.mcp_pid);
  const related = withProcSnapshot(() => {
    const table = procTable();
    let current = requesterPid;
    for (let depth = 0; depth < 64; depth++) {
      const parent = table.get(current)?.ppid;
      if (!parent || parent === current) return false;
      // PID 1 can be the provider in a container. Its recorded birth and liveness
      // must still match; generic shell-discovery helpers deliberately omit it.
      if (parent === target.parent_pid) return true;
      current = parent;
    }
    return false;
  });
  return { at, valid: related && requester.alive === true && requester.start === requesterStart
    && parent.alive === true && parent.start === target.parent_start && mcp.alive === true && mcp.start === target.mcp_start };
}

export function submitIdentityControl(store: Store, target: IdentityControlDescriptor, action: "claim" | "release" | "takeover", name?: string, approval?: IdentityTakeoverApproval): IdentityControlRequest {
  if (action === "release" && name) throw fail("release does not accept a target name");
  const requester = inspectLeaseProcess(process.pid);
  if (requester.alive !== true || !requester.start) throw fail("cannot verify requester process identity");
  const proof = inspectIdentityControlCaller(target, process.pid, requester.start), now = Date.now();
  const request = requestSchema.parse({ v: 1, id: randomUUID(), action, ...(name ? { name } : {}), ...(approval ? { approval } : {}), target,
    requester_pid: process.pid, requester_start: requester.start, created_at: now, expires_at: now + 10_000, status: "pending" });
  return store.tx(() => {
    if (!proof.valid || performance.now() - proof.at > 5000) throw fail("run this command inside the selected provider session; its process ancestry could not be verified");
    if (canonical(findIdentityControl(store, target.cli, target.session_id)) !== canonical(target)) throw fail("control endpoint changed; inspect the session again");
    store.set(identityRequestKey(request.id), JSON.stringify(request));
    return request;
  });
}

export function pendingIdentityControls(store: Store, controlKey: string): IdentityControlRequest[] {
  const rows = store.db.prepare(`SELECT v FROM kv WHERE k GLOB 'identity-request:*'
    AND CASE WHEN json_valid(v) THEN json_extract(v,'$.status')='pending' AND json_extract(v,'$.target.control_key')=? ELSE 0 END LIMIT 20`).all(controlKey);
  return rows.flatMap(row => { const parsed = requestSchema.safeParse(JSON.parse(row.v as string)); return parsed.success ? [parsed.data] : []; });
}

/** Mutation and receipt share a transaction; failed callbacks roll back before the failure receipt. */
export function consumeIdentityControl(store: Store, request: IdentityControlRequest, current: IdentityControlDescriptor,
  proof: { at: number; valid: boolean }, operation: () => unknown, rollbackState: () => void): IdentityControlReceipt | null {
  return store.tx(() => {
    const key = identityRequestKey(request.id), raw = store.get(key);
    if (!raw || canonical(JSON.parse(raw)) !== canonical(request)) return null;
    let receipt: IdentityControlReceipt;
    try {
      return store.tx(() => {
        const now = Date.now();
        if (request.expires_at <= now || request.created_at > now || request.expires_at - request.created_at > 10_000) throw fail("identity request expired or has an invalid deadline");
        if (!proof.valid || performance.now() - proof.at > 5000) throw fail("requester process evidence is unavailable or stale");
        if (canonical(current) !== canonical(request.target)
          || canonical(findIdentityControl(store, current.cli, current.session_id)) !== canonical(current)) throw fail("identity or control generation changed after the request");
        if (operation.constructor.name === "AsyncFunction") throw fail("identity control operations must be synchronous");
        const result = operation();
        if (result && typeof (result as { then?: unknown }).then === "function") { void Promise.resolve(result).catch(() => {}); throw fail("identity control operations must be synchronous"); }
        receipt = { ...request, status: "completed", completed_at: Date.now(), result };
        store.set(key, JSON.stringify(receipt));
        return receipt;
      });
    } catch (error) {
      rollbackState();
      receipt = { ...request, status: "failed", completed_at: Date.now(), error: (error as Error).message };
      store.set(key, JSON.stringify(receipt));
      return receipt;
    }
  });
}

export function identityControlReceipt(store: Store, id: string): IdentityControlReceipt | null {
  const raw = store.get(identityRequestKey(id));
  return raw ? JSON.parse(raw) as IdentityControlReceipt : null;
}
export function readIdentityControlReceipt(home: string, id: string): IdentityControlReceipt | null {
  const key = identityRequestKey(id), path = join(home, "mbx.db");
  if (!existsSync(path)) return null;
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    db.exec("PRAGMA busy_timeout=5000; PRAGMA query_only=ON");
    if (Number(db.prepare("PRAGMA user_version").get()!.user_version) > SCHEMA_VERSION) throw fail("mailbox schema is newer than this runtime");
    const row = db.prepare("SELECT v FROM kv WHERE k=?").get(key);
    return row ? JSON.parse(row.v as string) as IdentityControlReceipt : null;
  } finally { db.close(); }
}

/** Settle an abandoned request only after excluding an in-flight writer. Never execute it. */
export function resolveIdentityControlReceipt(home: string, id: string): IdentityControlReceipt | null {
  const observed = readIdentityControlReceipt(home, id);
  if (!observed || observed.status !== "pending" || observed.expires_at > Date.now()) return observed;
  const key = identityRequestKey(id), db = new DatabaseSync(join(home, "mbx.db"));
  try {
    db.exec("PRAGMA busy_timeout=5000; BEGIN IMMEDIATE");
    // This path does not initialize or migrate a store, even when migration is enabled elsewhere.
    if (Number(db.prepare("PRAGMA user_version").get()!.user_version) !== SCHEMA_VERSION) throw fail("receipt finalization requires the current mailbox schema");
    const row = db.prepare("SELECT v FROM kv WHERE k=?").get(key);
    let receipt = row ? JSON.parse(row.v as string) as IdentityControlReceipt : null;
    const now = Date.now();
    if (receipt?.status === "pending" && receipt.expires_at <= now) {
      const request = requestSchema.parse(receipt);
      if (request.id !== id) throw fail("identity receipt ID mismatch");
      receipt = { ...request, status: "failed", completed_at: now, error: "identity request expired before execution" };
      db.prepare("UPDATE kv SET v=? WHERE k=?").run(JSON.stringify(receipt), key);
    }
    db.exec("COMMIT");
    return receipt;
  } catch (error) {
    if (db.isTransaction) db.exec("ROLLBACK");
    throw error;
  } finally { db.close(); }
}
