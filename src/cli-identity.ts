// CLI ownership comes from the provider's exact current MCP lease, never from --as alone.
import { canonical } from "./crypto.ts";
import { findIdentityControl, identityGeneration, inspectIdentityControlCaller, listIdentityControls, type IdentityControlDescriptor } from "./identity-control.ts";
import { IdentityLeases, inspectLeaseProcess, type IdentityLease } from "./identity-leases.ts";
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
  const requester = inspectLeaseProcess(process.pid);
  if (requester.alive !== true || !requester.start) throw refused("cannot verify the calling process");
  const descriptors = selection.cli && selection.session ? [findIdentityControl(node.store, selection.cli, selection.session)] : listIdentityControls(node.store);
  const candidates = new Map<string, { descriptor: IdentityControlDescriptor; token: string; proof: { at: number; valid: boolean } }>();
  for (const descriptor of descriptors) {
    const row = rowFor(node, descriptor.agent);
    if (!matches(descriptor, row)) continue;
    const proof = inspectIdentityControlCaller(descriptor, process.pid, requester.start);
    if (proof.valid) candidates.set(descriptor.control_key, { descriptor, token: row.token, proof });
  }
  // --as must not pick a different hosted session merely because it shares a provider parent.
  if (candidates.size !== 1) throw refused(candidates.size ? "ambiguous provider sessions: specify --cli and --session" : "no current identity lease belongs to this caller; claim through the provider session first");
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
      return operation(descriptor.agent);
    };
    return selection.readOnly ? leases.withHeldRead(descriptor.agent, token, guarded) : leases.withHeld(descriptor.agent, token, guarded);
  });
}
