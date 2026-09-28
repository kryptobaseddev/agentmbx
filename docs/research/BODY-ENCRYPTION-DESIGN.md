# Envelope body encryption (`enc`) — design options for T028

Status: design options for owner decision; not a shipped protocol. This is the hard gate named by SPEC.md ("no
relay carries bodies until `enc` is implemented") and by the cloud relay design (docs/research/CLOUD-RELAY-DESIGN.md).

## What exists today

- Envelopes are signed with **Ed25519 host keys** (`signEnvelope`/`verifyEnvelope`); the `enc` field is reserved
  and `checkShape` rejects any non-null value ("unsupported enc") — receivers fail closed.
- Pairing already pins host keys on both sides (SAS covers both host keys); `sender_verification` metadata and
  `trust` labels ride in the clear.
- Bodies are stored **plaintext at rest** on the receiving host by decision D001 (local same-user
  confidentiality, T085) — encryption here is about *transit over untrusted hops* (relay/cloud), not local at-rest.
- The store is per-host SQLite; outbox is per peer host — a natural place to hold encrypted blobs until pull.

## The decision: how each recipient gets the body key

### Option A — pairwise sender↔recipient host keys (recommended)

Derive an X25519 key-agreement key from each host's Ed25519 key (the standard birational map, no new key types
to manage), and agree a per-pair secret at pairing time (both sides compute it independently). Body encryption
uses an AEAD (XChaCha20-Poly1305) with a random per-envelope key; the envelope key is wrapped for the recipient
host. `enc = { v: 1, alg: "x25519+xchacha20", wrap: <wrapped key>, nonce: <24B>, body: <ciphertext> }`.

- **Pros**: no new keys to enroll; pairing already establishes the trust anchor the wrap relies on; a relay
  compromise exposes only pairwise ciphertext; revoking a pairing kills that pair's readability going forward.
- **Cons**: N×M key wraps when a host has many peers (fine at mailbox scale); group sends (`to: [...]) become
  per-recipient envelope copies at the outbox edge (already per-host, so this is natural); a host that re-keys
  must re-wrap in-flight outbox items.

### Option B — owner-key-sealed envelopes

The sender's owner key seals the envelope key; the recipient opens it via a member/device record chain.

- **Pros**: one wrap per envelope regardless of peers; readable across all of an owner's devices by construction.
- **Cons**: owner keys are Ed25519 signing keys — sealing needs a converted or additional encryption key on the
  owner key (new ceremony, owner-key migration); forwarding readability to *all* devices of an owner widens any
  future compromise; per-recipient revocation is weaker; substantially more spec churn than A.

## Recommendation

**Option A.** It reuses the pairing trust anchor the protocol already has, adds no new key types at enrollment,
keeps per-pair blast radius minimal, and matches the per-host outbox shape. Owner-sealed variants can be added
later as an `enc.v2` for the multi-device story if it proves necessary.

## What changes in the code (when built)

1. `crypto.ts`: Ed25519→X25519 conversion helpers (or `node:crypto` ECDH), XChaCha20-Poly1305 (or AES-GCM) seal/open.
2. Envelope: define `enc` shape; `checkShape` accepts `enc.v1` when the receiver supports it.
3. Send path: daemon encrypts the body when the recipient is a paired host *and* the peer advertises `enc`
   support (capability recorded at pairing/refresh — peers on old code keep receiving plaintext LAN envelopes).
4. Receive path: decrypt after signature verification; store plaintext locally (D001 unchanged) or keep the
   wrapped body and unwrap on read if T085 ever tightens.
5. Tests first (council pattern): relay-hop ciphertext is unreadable without the pair secret; tampered
   ciphertext rejected; mixed enc/plain in one outbox; old-code receiver gets a clean capability refusal.

## Open question for the owner

Pairwise (A) vs owner-sealed (B) — and, under A, whether LAN delivery also adopts `enc` once peers support it,
or encryption stays a relay/cloud-hop feature with LAN plaintext by design (D001's local-trust stance suggests
the latter for v1).
