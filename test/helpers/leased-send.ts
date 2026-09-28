import { fingerprint, generateKeyPair } from "../../src/crypto.ts";
import { IdentityLeases, inspectLeaseProcess } from "../../src/identity-leases.ts";
import type { Draft } from "../../src/envelope.ts";
import type { MbxNode } from "../../src/node.ts";

/** A component sender with a real process lease, rather than a fabricated verification marker. */
export function sendLeased(node: MbxNode, draft: Draft) {
  const name = draft.from.split("@")[0], leases = new IdentityLeases(node.store), key = generateKeyPair();
  const claim = leases.claim(name, { pid: process.pid, start: inspectLeaseProcess(process.pid).start!, keyFp: fingerprint(key.publicKey), cli: "test", sessionId: "sender-fixture" });
  try { return leases.withHeld(name, claim.token, () => node.send(draft)); }
  finally { leases.release(name, claim.token); }
}
