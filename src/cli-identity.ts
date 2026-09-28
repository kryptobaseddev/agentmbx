// CLI ownership comes from the provider's exact current MCP lease, never from --as alone.
import { canonical } from "./crypto.ts";
import { findIdentityControl, identityControlKey, identityGeneration, inspectIdentityControlCaller, listIdentityControls, type IdentityControlDescriptor } from "./identity-control.ts";
import { IdentityLeases, inspectLeaseProcess, type IdentityLease } from "./identity-leases.ts";
import { kimiInstances } from "./kimi-web.ts";
import type { MbxNode } from "./node.ts";

const refused = (message: string) => Object.assign(new Error(message), { code: "IDENTITY_LEASE_REQUIRED" });
const rowFor = (node: MbxNode, name: string) => node.store.db.prepare("SELECT * FROM identity_leases WHERE name=?").get(name) as unknown as IdentityLease | undefined;
const matches = (d: IdentityControlDescriptor, row: IdentityLease | undefined): row is IdentityLease => !!row && row.released_at === null
  && identityGeneration(row.token) === d.generation && row.key_fp === d.control_key && row.cli === d.cli
  && row.session_id === d.lease_session_id && row.holder_pid === d.mcp_pid && row.holder_start === d.mcp_start;

export interface CliIdentitySelection { as?: string; cli?: string; session?: string; readOnly?: boolean }

/** Proof collection happens outside SQLite; authorization and operation share the lease transaction. */
export function withCliIdentity<T>(node: MbxNode, selection: CliIdentitySelection, operation: (agent: string) => T): T {
  if (operation.constructor.name === "AsyncFunction") throw refused("mailbox operations must be synchronous");
  if (!!selection.cli !== !!selection.session) throw refused("select both --cli and --session, or neither");
  const descriptors = selection.cli && selection.session ? [findIdentityControl(node.store, selection.cli, selection.session)] : listIdentityControls(node.store);
  return withIdentity(node, selection, descriptors, operation);
}

/** Hook bootstrap requires one holder; only Claude may change real session IDs within that holder. */
export function withHookIdentity<T>(node: MbxNode, cli: string, session: string | undefined,
  operation: (agent: string, descriptor: IdentityControlDescriptor, bootstrap: boolean) => T, allowBootstrap = false): T {
  if (operation.constructor.name === "AsyncFunction") throw refused("hook operations must be synchronous");
  if (!session || session.length > 300 || session !== session.trim() || /[\u0000-\u001f\u007f-\u009f]/u.test(session) || session.startsWith("mcp-"))
    throw refused("hook requires a valid non-provisional session id");
  const all = listIdentityControls(node.store).filter(d => d.cli === cli && d.parent_pid === process.ppid);
  let descriptors: IdentityControlDescriptor[], bootstrap = false;
  const rebindClaude = allowBootstrap && cli === "claude" && !node.store.db.prepare("SELECT 1 FROM sessions WHERE cli=? AND session_id=?").get(cli, session);
  if (node.store.get(identityControlKey(cli, session)) !== undefined && !rebindClaude) descriptors = [findIdentityControl(node.store, cli, session)];
  else {
    // Hosted providers must first publish an exact session binding. Never bootstrap by directory.
    if (!allowBootstrap || !["claude", "kimi"].includes(cli) || (cli === "kimi" && kimiInstances().some(instance => instance.pid === process.ppid)) || new Set(all.map(d => d.control_key)).size !== 1
      || all.some(d => !d.lease_session_id.startsWith("mcp-") || (cli !== "claude" && !d.session_id.startsWith("mcp-"))
        || !matches(d, rowFor(node, d.agent)) || canonical({ ...d, session_id: "" }) !== canonical({ ...all[0], session_id: "" })))
      throw refused("hook session has no exact current MCP binding");
    descriptors = all; bootstrap = true;
  }
  if (descriptors.some(d => d.parent_pid !== process.ppid)) throw refused("hook does not belong to this provider process");
  return withIdentity(node, {}, descriptors, (agent, descriptor) => {
    if (bootstrap && canonical(listIdentityControls(node.store).filter(d => d.cli === cli && d.parent_pid === process.ppid)) !== canonical(all))
      throw refused("hook bootstrap bindings changed before the operation");
    return operation(agent, descriptor, bootstrap);
  });
}

function withIdentity<T>(node: MbxNode, selection: CliIdentitySelection, descriptors: IdentityControlDescriptor[],
  operation: (agent: string, descriptor: IdentityControlDescriptor) => T): T {
  if (operation.constructor.name === "AsyncFunction") throw refused("mailbox operations must be synchronous");
  const requester = inspectLeaseProcess(process.pid);
  if (requester.alive !== true || !requester.start) throw refused("cannot verify the calling process");
  const candidates = new Map<string, { descriptor: IdentityControlDescriptor; token: string; proof: { at: number; valid: boolean } }>();
  for (const descriptor of descriptors) {
    const row = rowFor(node, descriptor.agent);
    if (!matches(descriptor, row)) continue;
    const proof = inspectIdentityControlCaller(descriptor, process.pid, requester.start);
    if (proof.valid) candidates.set(descriptor.control_key, { descriptor, token: row.token, proof });
  }
  // --as must not pick a different hosted session merely because it shares a provider parent.
  if (candidates.size !== 1) throw Object.assign(refused(candidates.size ? "ambiguous provider sessions: specify --cli and --session" : "no current identity lease belongs to this caller. Run mailbox commands inside the provider session that holds the lease (your agent session, through its mbx tools); inspect holders with `agentmbx identity list`. The owner can replace a live holder with `agentmbx identity takeover <name> --force --cli <provider> --session <id>`"),
    { code: candidates.size ? "IDENTITY_LEASE_REQUIRED" : "IDENTITY_NO_CALLER_LEASE" });
  const { descriptor, token, proof } = [...candidates.values()][0];
  const [name, host, extra] = selection.as?.split("@") ?? [descriptor.agent];
  if (name !== descriptor.agent || (host !== undefined && host !== node.host) || extra !== undefined)
    throw refused(`this session holds ${descriptor.agent}@${node.host}, not the requested identity`);
  const leases = new IdentityLeases(node.store);
  return leases.prepare([descriptor.agent], [descriptor.mcp_pid], () => {
    const guarded = () => {
      if (!proof.valid || performance.now() - proof.at > 5000) throw refused("caller process evidence became stale; retry after inspection");
      if (canonical(findIdentityControl(node.store, descriptor.cli, descriptor.session_id)) !== canonical(descriptor)
        || !matches(descriptor, rowFor(node, descriptor.agent))) throw refused("identity binding changed before the operation");
      return operation(descriptor.agent, descriptor);
    };
    return selection.readOnly ? leases.withHeldRead(descriptor.agent, token, guarded) : leases.withHeld(descriptor.agent, token, guarded);
  });
}
