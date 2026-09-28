# ADR-035: Cloud architecture and threat model

Status: **proposed — owner review required** (T035 acceptance: "ADR accepted with threat model")
Date: 2026-09-28
Related: T007 (cloud relay), T028 (body encryption — shipped), docs/research/CLOUD-RELAY-DESIGN.md,
docs/research/BODY-ENCRYPTION-DESIGN.md, docs/COUNCIL-VERDICT-2026-09-26.md, docs/IDENTITY-LEASE-MIGRATION.md

## Decision

Extend AgentMBX with an **untrusted store-and-forward relay** as a third transport behind the existing
multi-transport kernel (LAN primary, relay fallback). The relay:

1. carries only **opaque, encrypted** envelopes and the same signed record types hosts already exchange
   (policies, devices, revocations) — never plaintext bodies (T028 shipped: pairwise X25519 + XChaCha20-Poly1305,
   signatures commit to the ciphertext);
2. **never holds a private key and never decides authorization** — all authorization decisions stay on
   receiving hosts, which verify owner-signed records (SPEC trust model; council condition 2);
3. enrols hosts by **owner-key challenge-signature** — no bearer keys, no unauthenticated registration
   (the SignalDock failure mode, rejected by the salvage audit);
4. accounts (if any) bind **owner public keys**, never emails or passphrases (POLICY.md §7).

## Trust boundaries and assets

```
 agent session ──[MCP, leased]── daemon A ══[signed hop]══ relay ══[signed hop]══ daemon B ──[MCP, leased]── agent
        │ TRUSTED (local) │   TRUSTED (owner's host)  │ UNTRUSTED  │  TRUSTED        │ TRUSTED (local) │
```

Assets, and which boundary protects them:

| Asset | Protection |
|---|---|
| Message body content | pairwise AEAD (T028); relay sees only ciphertext |
| Envelope integrity + sender authenticity | sender host signature over the envelope; id-dedupe blocks substitution replays |
| Who may act on a message | receiver-side policy evaluation of owner-signed records; relay has no say |
| Owner key | never leaves the owner's machines; relay enrolment uses a challenge signature only |
| Identity/lease state | stays local per host (schema 2); the relay carries no lease state |
| Availability of mail | relay is a fallback transport; LAN path unchanged; outbox persists locally |

Explicitly visible to the relay operator (accepted, documented): envelope ids, from/to addresses,
subject, sizes, timing, hop counts. Not visible: bodies (ciphertext), authority grant contents are
owner-signed but readable, private keys of any kind.

## STRIDE analysis

**Spoofing.**
- *Relay impersonating a host to another host:* impossible without the host private key; the hop between
  daemon and relay is host-signed exactly like daemon-to-daemon today, and the relay cannot mint a valid
  `X-Mbx-Sig`. *Mitigation: existing hop signatures; relay is pinned per-host like any peer.*
- *One host impersonating another to the relay:* the relay authenticates hosts by their enrolled owner-key
  challenge; two hosts cannot share an enrolment. *Mitigation: enrolment record + per-host queues.*

**Tampering.**
- *Relay modifying a stored envelope:* breaks the sender's host signature at receive verification;
  receivers reject. Tested today for LAN (`rejected:bad signature`).
- *Swapping ciphertext between envelopes:* the signature commits to the exact ciphertext (`enc.body`
  substitution in `unsigned()`); grafting fails verification. Shipped with a regression test (PR #26).

**Repudiation.** Senders sign every envelope; the relay's logs are not trusted evidence, but receiver
audit logs (`audit` table) and signed records give the owner a verifiable local trail.

**Information disclosure.** Bodies are pairwise-encrypted before they reach the relay (T028 gate);
the enc key exchange is itself signed by the pinned host key, so a relay cannot substitute keys
(shipped: `enc_key.rejected` audit + tests). Remaining metadata exposure (addresses/subjects/timing)
is documented above and is the accepted cost of store-and-forward.

**Denial of service.**
- *Relay flooding a host:* hosts pull; the relay cannot push unrequested work beyond queue depth.
- *Host flooding the relay:* per-owner quotas on queue depth, envelope size, and push rate (SignalDock's
  rate-limit middleware shape is the harvested reference).
- *Mail bombs to an agent:* the wake brake is receiver-side and unchanged; the relay adds no wake path.

**Elevation of privilege.** None available through the relay by construction: the relay cannot sign,
cannot hold leases, cannot grant authority. A message that would be downgraded on LAN (caps exceeded,
policy `ask`) is delivered with `authority: none` + warning on the relay too — enforcement is identical
because it happens on the receiver (council condition 2, already tested).

## Abuse cases considered

1. *Malicious relay operator reading mail* → ciphertext only; keys cannot be substituted (signed enc-key exchange).
2. *Malicious relay dropping or delaying mail* → at-least-once notification semantics; exactly-once storage
   via id-dedupe; senders keep outbox copies with retry; owner sees undelivered alerts.
3. *Compromised paired host reading queued mail* → pairwise keys are per-pair; unpairing kills that pair's
   readability going forward (receiver stops accepting; sender stops sealing for that peer).
4. *Spam through the relay* → enrolment is owner-attested; quotas bound abuse; receiver-side policy still
   gates authority; unknown/unverified senders get `policy: ask` and no wake authority (shipped behaviour).
5. *Replay of old envelopes via the relay* → permanent id dedupe on receive; freshness is on the signed
   hop headers (council condition 4).

## What must be true before cutover (gates)

1. T028 encryption shipped and enabled on the relay path (**done**: PRs #24–#26).
2. Identity leases live (**done**: schema 2).
3. Relay reference implementation passes the council-pattern tests: relay cannot read a body; tampered
   envelope rejected; dedupe across relay retries; quota exceeded → honest error; offline-peer delivery e2e.
4. Owner reads and marks this ADR accepted (this document).

## Open risks (accepted or owned elsewhere)

- **Metadata visibility** to the relay operator (above) — mitigated further in future by padding/size
  bucketing if the threat model ever demands it; not in v1.
- **Relay availability** is a new dependency for cross-network mail — LAN path remains fully independent.
- **Quota economics** (metered vs hard caps, payments) — owner decision queued in CLOUD-RELAY-DESIGN.md;
  not required for v1 correctness.

## Decision record

Adopting this ADR unblocks the relay build (T007 implementation order in the design doc). Rejection or
amendment should name which trust assumption above changes; the encryption and identity foundations
stand independently of the relay.
