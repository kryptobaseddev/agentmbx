# AgentMBX cloud relay — design synthesis (2026-09-28)

Status: design synthesis for owner review; not a shipped protocol. Feeds T007 (Cloud relay research and design),
T034 (relay vs NAT traversal vs hybrid), T035 (ADR: cloud architecture and threat model), T028 (envelope body
encryption). Grounded in SPEC.md, POLICY.md §7, IDENTITY-LEASE-MIGRATION.md, COUNCIL-VERDICT-2026-09-26.md and
the SignalDock salvage audit (docs/research/SIGNALDOCK-SALVAGE.md).

## What the cloud is

An **untrusted store-and-forward relay** that lets paired hosts exchange signed envelopes when LAN delivery is
impossible (different networks, NAT, offline peer). The relay:

- never holds a private key and never decides what an agent may do — receivers verify owner-signed records,
  the relay only stores and forwards opaque envelopes (SPEC.md; council condition 2: enforcement is on the receiver);
- carries the same signed record types as LAN delivery: envelopes, policies, device/member records (POLICY.md §7);
- exists for relay usage only — accounts, quotas and device enrollment. LAN use needs no account (SPEC.md).

## Hard gates before any envelope body crosses the relay

1. **Body encryption (`enc`)** — SPEC.md forbids relays carrying bodies until `enc` is implemented. Today every
   relay hop would expose plaintext bodies to the relay operator. T028 is the gate; until then a relay, if built,
   may carry only envelope metadata + signatures (useful for ack/sync, not for message bodies).
2. **T035 owner sign-off** — the threat-model ADR is accepted before the relay is built or conduit cutover starts.
3. **Identity leases are live** (schema 2, 2026-09-28) — the per-session attribution the conduit experiment showed
   was missing now exists; the relay inherits it rather than redesigning it.

## Identity, accounts, devices

- **Principal = an owner key.** Nothing else identifies a human. A cloud account links an owner public key to an
  account exactly the way a Git host links an SSH key: login, quotas, enrollment (POLICY.md §7).
- **Devices** are owner-certified host keys (`device` records); policies and grants signed on one machine apply
  on all of the owner's devices.
- **Members** join with `member`/`guest` roles via owner-signed records; `from.principals` policy selectors
  already parse.
- **Enrolment by key, not by bearer** (SignalDock lesson): challenge-signature enrolment; no `sk_live_`-style
  bearer secrets, no unauthenticated registration. SignalDock's bearer-key and server-held-authority model is
  explicitly rejected by the salvage audit.

## Mailbox and delivery model on the relay

Reuse the existing state machine rather than inventing one: the local deliveries model
(`queued → delivered → notified → read → acked`) maps directly onto relay semantics — the council's truthful label
is **"exactly-once storage, at-least-once notification"**.

- Per-host (per-pairing) queues of opaque envelopes; the relay stores by envelope id (permanent id dedupe is
  already the replay rule, council condition 4).
- **Acks are explicit and durable**: a host reports `acked` cursors per peer; the relay may drop acked envelopes.
  Envelope **expiry** is sender-signed; the relay drops expired envelopes without reading them.
- **Quotas** bound queue depth, envelope size and push rate per owner key — the rate-limit middleware shape and
  delivery-jobs/dead-letter worker are the two SignalDock components worth harvesting (under 1.5k LOC total);
  the relay itself is ~2–3k LOC of new code per the salvage audit.

## Transport selection (T034)

Hosts keep all three transports behind one kernel (SPEC.md): LAN (mDNS + pairing, primary), relay
(store-and-forward fallback), conduit (cleo integration). Selection rule: LAN while the peer is reachable
(alive pairing + recent delivery); relay otherwise; either way the envelope format, signatures, policies and
wake-brake are identical. The relay only changes where bytes are stored between push and pull — never who may
act. An offline peer (like the current `fedora` timeout) is exactly the case the relay exists for: mail
accumulates in the outbox/relay instead of desktop notifications.

## Threat model sketch (for T035 to ratify)

| STRIDE | Relay-world mitigation |
|---|---|
| Spoofing | envelope + host signatures; sender labels stay `verified (paired host X)` only on signature proof |
| Tampering | signed envelopes; relay cannot alter without detection; id-dedupe blocks substitution replays |
| Repudiation | local audit log + signed records; the relay logs are not trusted evidence |
| Info disclosure | **bodies never cross before `enc`**; metadata (addresses, ids, sizes, timing) is minimized and documented as visible-to-relay |
| Denial of service | quotas per owner key; wake brake unchanged (relay adds no wake authority) |
| Elevation of privilege | none available to the relay: authorization is receiver-side, policy records are owner-signed |

## Existing code anchors (2026-09-28 inventory)

The daemon is already a store-and-forward node for LAN peers; the relay externalizes the same pattern as a
third transport behind the multi-transport kernel:

- **Outbox queue** (`outbox` table: per-peer msg/host with attempts, next_at, last_error) + `flushOutbox` on the
  2-second daemon tick — the push side of store-and-forward already exists.
- **`POST /v1/envelopes`** (host-authenticated) — the envelope-batch endpoint a relay can front; `/v1/policy`,
  `/v1/policies`, `/v1/agents` carry the same signed records the relay must carry (POLICY §7).
- **Signed `hop` meta saturated at `MAX_RELAY_DEPTH` (1000) + `origin: external`** — the anti-relay-abuse
  machinery (T104) is envelope-level and transport-agnostic; a relay hop plugs into it without new rules.
- **Permanent id dedupe** on receipt — exactly-once storage holds across relay retries.

So the relay's new work is narrow: authenticated push/pull endpoints with per-owner cursors and quotas, plus the
`enc` body gate — not a new delivery model.

## Build plan sketch

1. Harvest the Axum/SSE skeleton + delivery-jobs/dead-letter worker from the SignalDock audit into a fresh relay crate.
2. Define the sync protocol (push/pull, cursors, acks, expiry, quotas) as an mbx spec addendum.
3. Ship `enc` (T028) — pairwise sender→recipient body encryption; decide the key establishment story (see open questions).
4. Failing tests first (council pattern): relay cannot read a body; tampered envelope rejected; dedupe across relay retries; quota exceeded → honest error; offline-peer delivery via relay e2e.
5. Owner reviews T035; only then enable relay transport in the daemon.

## Open questions for the owner

1. **Body encryption keys**: pairwise sender↔recipient keys established at pairing time (simplest), or
   owner-key-sealed envelopes (one recipient key per owner across devices)?
2. **Accounts vs account-free relay**: can v1 be quota-bound to owner keys alone (no login surface at all), or
   does the commercial cloud (T073) need accounts from day one?
3. **Quota shape**: hard caps vs metered; and does the relay charge anyone (SignalDock's payments module was
   explicitly out of scope for salvage)?
