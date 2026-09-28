# Conduit mapping experiment: verified result

Verified on 2026-09-28 against AgentMBX 4ab6c47 with `AGENTMBX_DEV=1 node --test test/conduit-transport.test.ts`: 6 passed, 0 failed, 1 explicit TODO. The copied CLEO contract is pinned in the test to CLEO revision 6a9d753b42938a8861ea8cc825079ea7101698ca; this does not assert conformance to an uninspected newer contract.

The local experiment proves connect/disconnect/name behavior, push returning the persisted ID, non-destructive poll, conversation/reply mapping, recipient-specific acknowledgement, and exclusive sender-timestamp filtering before the limit. It runs against the production MbxNode without modifying its implementation for the experiment.

The attribution diagnostic is a demonstrated missing capability: two different session keypairs can send ordinary messages with the same local `lead` label; both host signatures verify, neither message carries either session identity, and the receiver cannot distinguish their principals. The TODO expresses the required future property, not a passing attribution test. This does not demonstrate owner-authority forgery.

The test's INVENTED list records eleven adapter choices: experiment name/local connection; unauthenticated agentId label; empty apiKey and mbx URL; unsupported options and connection-state behavior; generated subject/default kind and no grant; conversation/reply mapping; exclusive sender-ts cutoff/default limit; unbounded local inbox scan; ack identity/state mapping; trust/authority/reply metadata; and unsupported optional topic/subscription/payload/group/peer-id projections.

The experiment is complete as T063 evidence. Production conduit cutover remains gated on T065 per-session attribution and T066 immutable IDs, plus production transport semantics and scaling. No LAN/relay conformance, secure name ownership or production-ready adapter is claimed. Identity lease work is planned separately in agentmbx-identity-lease-migration (T081).