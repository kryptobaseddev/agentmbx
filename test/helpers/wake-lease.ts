import { canonical, fingerprint, generateKeyPair, signData } from "../../src/crypto.ts";
import { IdentityLeases, inspectLeaseProcess } from "../../src/identity-leases.ts";
import { identityGeneration, publishIdentityControl } from "../../src/identity-control.ts";
import { createOwnerKey, unlockOwnerKey } from "../../src/owner.ts";
import { acceptSigned, makePolicy } from "../../src/policy.ts";
import type { MbxNode } from "../../src/node.ts";

const holders = new WeakMap<MbxNode, Map<string, { key: ReturnType<typeof generateKeyPair>; token: string; canonicalSession: string }>>();
/** Component fixture with real process birth evidence, an explicit lease and a signed test-only owner policy. */
export function bindWakeLease(n: MbxNode, s: { agent: string; cli: string; session_id: string; pid: number; channel?: boolean; cwd?: string }) {
  let map = holders.get(n); if (!map) { map = new Map(); holders.set(n, map); }
  const leases = new IdentityLeases(n.store), start = inspectLeaseProcess(process.pid).start!;
  let holder = map.get(s.agent);
  if (!holder) {
    const key = generateKeyPair();
    const lease = leases.claim(s.agent, { pid: process.pid, start, keyFp: fingerprint(key.publicKey), cli: s.cli, sessionId: s.session_id });
    holder = { key, token: lease.token, canonicalSession: s.session_id }; map.set(s.agent, holder);
  }
  n.bindSession({ ...s, session_key: holder.key.publicKey, mcp_pid: process.pid });
  publishIdentityControl(n.store, { v: 1, agent: s.agent, cli: s.cli, session_id: s.session_id, lease_session_id: holder.canonicalSession,
    control_key: fingerprint(holder.key.publicKey), mcp_pid: process.pid, mcp_start: start, parent_pid: s.pid,
    parent_start: inspectLeaseProcess(s.pid).start!, generation: identityGeneration(holder.token) });
  delegateWake(n, s.agent);
  return { token: holder.token, release: () => leases.release(s.agent, holder!.token) };
}

export function delegateWake(n: MbxNode, agent: string, level: "collaborate" | "autonomous" = "autonomous") {
  if (!n.ownerPub) { createOwnerKey(n.home, "test-only-passphrase"); n.syncOwner(); }
  const owner = unlockOwnerKey(n.home, "test-only-passphrase");
  const rec = makePolicy({ level, agents: [agent], hosts: [n.host], ownerPub: owner.publicKey });
  const error = acceptSigned(n.store.db, { rec, sig: signData(owner.privateKey, canonical(rec)) }, n.host);
  if (error) throw new Error(error);
}
