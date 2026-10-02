# Durable relay: transactional persistence, acceptance and recovery (T164)

## Goal

T164 specifies how the AgentMBX cloud relay (ADR-035, `agentmbx relay serve`) stores, accepts, delivers and recovers
mail so that two hosts on different networks (home and work, T147) can rely on it. A relay restart, a crash at any
point, a lost response, a key rotation or a restore from backup MUST NOT silently lose or duplicate a message. This
revision changes no runtime behavior; it is the design review gate for T165–T168. MUST/MUST NOT/SHOULD/MAY follow
RFC 2119.

It builds on the plan items R1, R2, D1 and E1 in `docs/plan/production-network-wake-readiness.md`, the threat model
(`docs/THREAT-MODEL.md`: B4/A5, D4, F4, F12), and the cross-host delivery receipt record of T218
(`src/remote-receipts.ts`), which the relay carries byte for byte.

Out of scope: pairing through the relay, presence and key rotation announcements over the relay (later, same item
mechanism), account UI, billing, multi-relay federation.

## Terms

- **Relay**: one `agentmbx relay serve` process with its store. It is untrusted for content: it sees sealed bodies only
  and the metadata in `docs/THREAT-MODEL.md`. It never grants authority.
- **Host key**: a host's Ed25519 signing key, pinned by its paired peers. Rotations (T030) keep retired keys valid for
  verification.
- **Target**: a recipient host, identified by its **host key**, never by its name alone.
- **Item**: one unit the relay stores for one target: a sealed envelope (`kind: "envelope"`) or a delivery receipt
  (`kind: "receipt"`). One message addressed to agents on three hosts is three items.
- **Wire bytes**: the exact bytes a sender asked the relay to store for one target (for an envelope, the sealed
  envelope; for a receipt, canonical JSON of `{rec, sig}`).
- **Accept receipt**: the relay's signed statement that it durably committed an item. It is a transport fact, not a
  delivery or an ACK of the mailbox.
- **Received-through**: the highest relay sequence a receiving host has durably processed contiguously.
- **Delivery receipt**: the T218 record (`type:"receipt"`), signed by the recipient host, saying delivered, notified,
  read or acked.
- **Epoch**: a random id of the relay store generation. It changes only on an explicit reset or a restore.

## Current state (0.5.3) and the gaps this spec closes

All references are to `main` at the time of writing.

| # | Gap | Where |
|---|---|---|
| G1 | Every piece of relay state (queues, enrolments, enc-key ads, sequence counters, dedup set, challenges) is in-process memory. A restart loses all of it. | `src/relay.ts:18-23,69` |
| G2 | The sender deletes its outbox row on any HTTP 200, before anything is durable, and without reading `stored`/`error`. A partial batch also answers 200. | `src/relay-client.ts:81`, `src/relay.ts:172` |
| G3 | Fan-out to several recipient hosts is not atomic: a failure on recipient k leaves earlier rows queued, and the id is not marked seen, so a retry duplicates them. | `src/relay.ts:79-105` |
| G4 | Dedup is a global set of envelope ids, unbound to sender or target, unbounded, in memory. | `src/relay.ts:21`, F12 |
| G5 | Routing matches the recipient host by name (first match); another key can enrol the same name. | `src/relay.ts:89-99`, F4 |
| G6 | After a relay restart the client never re-enrols (a permanent kv flag) and never republishes its enc-key ad: 401 forever. | `src/relay-client.ts:27-52` |
| G7 | Sequence numbers restart at 1 after a restart while clients keep their old cursor: new items stay invisible. | `src/relay.ts:96`, `src/relay-client.ts:88-107` |
| G8 | The pull cursor returned is the last allocated seq, not the last returned one; pull has no page size; the `after` query is not covered by the hop signature. | `src/relay.ts:108-113,136-139` |
| G9 | Items the receiver rejects (undecryptable, bad signature, host not paired) are acked and dropped silently. | `src/relay-client.ts:95-106` |
| G10 | Broadcast, role and bare-name mail cannot go through the relay (no `@host`), and is retried every tick. | `src/relay.ts:91` |
| G11 | Delivery receipts (T218) are LAN-only. | `src/http.ts:514-536` |
| G12 | No retention: an item for a host that never comes back stays forever; nothing tells the sender. | `src/relay.ts` |
| G13 | `doctor` checks `relay-enrolled:<relay>` while the client writes `relay-enrolled:<relay>:<hostPub>`, so it always says "not yet enrolled". | `src/doctor.ts:238` |

## Design

### 1. Relay identity and discovery

The relay MUST have its own Ed25519 key, generated on first start and kept in its store directory. `GET
/v2/relay/info` returns `{v:2, relay_pubkey, epoch, limits:{max_item_bytes, max_batch, max_pull, retention_days},
version}`. A host pins the relay key when the owner runs `agentmbx relay set <url>`. The command shows the key's
fingerprint and MUST accept an optional `--key <fingerprint>` to pin it without trust on first use. A later change of
`relay_pubkey` MUST stop relay use and be reported by `doctor` until the owner confirms the new key.

### 2. Server store (T165)

The relay core MUST talk to its state only through a `RelayStore` interface: enrolments, enc-key ads, item insert
with dedup and seq allocation, pull, ack, expiry sweep, quotas, epoch and meta, and `transaction(fn)`. This lets a
later backend (a Railway database container or Neon) replace it without touching the protocol. The first and only
implementation (owner decision, 2026-10-02) is `node:sqlite` on a persistent volume path (Railway volume): no
Postgres dependency now. The relay MUST keep all state in that one database (WAL, `synchronous=FULL`, a single
writer process). Every successful response MUST be sent only after its transaction commits. Required tables:

- `enrolments(host_pubkey PK, host_name UNIQUE, owner_fp, device_record, enrolled_at, revoked_at)`. The host name is
  unique, which closes F4: a second key for the same name is rejected until the owner revokes the first one.
- `enc_ads(host_pubkey PK, enc_pub, sig, at)`. Only signed advertisements are stored, as today.
- `items(target_pubkey, seq, kind, item_id, sender_pubkey, wire BLOB, wire_hash, bytes, accepted_at, expires_at,
  PRIMARY KEY(target_pubkey, seq))`.
- `dedup(sender_pubkey, item_id, target_pubkey, wire_hash, seq, accepted_at, PRIMARY KEY(sender_pubkey, item_id,
  target_pubkey))`. It is kept for the dedup horizon (§7) after its item is acked or expired, which closes G4 and F12.
- `seqs(target_pubkey PK, next_seq)`. Sequence numbers never restart and are never reused (G7).
- `acked(target_pubkey PK, acked_through)`.
- `meta(epoch, relay_pubkey, schema_version)`.

Challenges and rate windows MAY stay in memory. A restart only invalidates outstanding challenges, and clients
retry them.

### 3. Push and acceptance (T165, T166)

`POST /v2/relay/items` with a signed hop. The hop signature MUST cover the method, the path **including the query
string**, the timestamp and the body hash (G8). Body: `{items:[{kind, item_id, targets:[{host_pubkey, wire_b64}]}]}`,
at most `max_batch` items.

- **Senders resolve targets.** A sender MUST address items by the pinned host key of each target and MUST NOT send
  broadcast, role or bare names to the relay. It expands them to concrete hosts first, exactly as `route()` does for
  the LAN (closes G5 for routing, and G10). Wire bytes are sealed for each target separately, as today.
- **One transaction per item.** The relay validates every target (enrolled, not revoked, quotas, size) before
  writing anything. If any target fails, the whole item is rejected and nothing is stored (G3). Several addresses on
  the same host are one target.
- **Dedup.** For each target, `(sender_pubkey, item_id, target_pubkey)`:
  - absent → insert the item and the dedup row, and allocate a seq;
  - present with the same `wire_hash` → `duplicate`, returning the original seq;
  - present with a different `wire_hash` → `rejected:conflict`, and nothing changes.
- **Response.** `{results:[{item_id, status: "accepted"|"duplicate"|"rejected:<code>", targets:[{host_pubkey, seq}],
  accept: {v:1, type:"relay-accept", relay_pubkey, epoch, sender_pubkey, item_id, targets:[{host_pubkey, seq,
  wire_hash}], at}, sig}]}`. `sig` is the relay key over canonical(`accept`). HTTP 200 only means "the response is in
  this body"; the status of each item is in `results` (G2).

**Sender side.** The sender MUST:

- Persist the wire bytes for each outbox row before the first relay attempt, and reuse them on every retry. The
  same item id never yields two different ciphertexts, so a retry is a duplicate, not a conflict.
- Drop a row from the active outbox only on a valid accept receipt for that row's target: signature by the pinned
  relay key, matching `item_id`, `host_pubkey` and `wire_hash`. A 200 without a matching receipt, a rejected or
  missing result, or a lost response leaves the row pending.
- Keep the accepted row in state `relay-accepted` (with seq, epoch and the receipt) until the target's T218
  delivery receipt for that message arrives, or retention expires (§6). This is what makes a relay restore (§5)
  recoverable: the sender still holds the bytes.

### 4. Pull, receive and ack (T166)

`GET /v2/relay/items?after=<seq>&limit=<n>` (signed hop, `n ≤ max_pull`) returns `{epoch, items:[{seq, kind,
item_id, sender_pubkey, wire_b64}], last_seq, more}`. `last_seq` is the last seq **returned** (G8).

The receiving host MUST process items in seq order:

- An envelope goes to `node.receive()`. A receipt goes to `acceptReceipt(node, {rec, sig}, null)` (T218: the
  signature is checked against the recipient host's pinned and retired keys, and the message must be one this host
  sent and routed to that host). This closes G11.
- **Accepted** or **duplicate** → the item is done.
- **Rejected** (undecryptable, bad signature, unpaired, malformed) → the item is written to `relay_quarantine(relay,
  epoch, seq, item_id, sender_pubkey, reason, wire, at)` and is then done. It is never dropped silently (G9).
  `doctor` and `agentmbx relay quarantine` list it.
- `received_through` advances only over a contiguous run of done items and is persisted in the same transaction as
  the last one.

Only after that commit does the host call `POST /v2/relay/ack {epoch, through}`, with `through ≤ received_through`.
The relay deletes items with `seq ≤ through` for that target and records `acked_through`. An ack failure leaves
state retryable: the next pull starts at `received_through`, and the relay simply still holds those items.
`received_through` and the relay's `acked_through` are distinct facts. A transport ack is never a mailbox ack.

### 5. Restart, crash and restore (T167)

- **Restart / crash.** Every acknowledged effect is committed, so a restart loses nothing. The epoch is unchanged,
  sequences continue, and clients resume with their `received_through`.
- **Crash windows.** Each of these MUST be tested with a real child-process crash:
  - Relay commits but the response is lost → the sender retries, gets `duplicate` with the same seq, then drops the
    row.
  - Relay crashes before commit → the sender retries, and the item is accepted once.
  - Receiver commits but the checkpoint isn't written → it pulls again, the item is a `duplicate` at `receive()`, and
    the checkpoint advances.
  - Receiver checkpoints but the ack is lost → the next ack covers it.
- **Restore from backup.** A restore MUST rotate the epoch. On seeing a new epoch, in either a push or a pull
  response:
  - A sender re-pushes every outbox row in `relay-accepted` state whose delivery receipt hasn't arrived. Dedup
    makes this safe even where the restored store still has the item.
  - A receiver resets its relay position for that relay to 0 and pulls everything. Receiver dedup by message id
    (`node.receive` → `duplicate`) and `acceptReceipt` (state rank, then seq) make repeats harmless.

  Post-backup mail is therefore recovered from senders rather than lost.
- **Backup.** `agentmbx relay backup <file>` uses the SQLite online backup API. It is safe while the relay runs.
  `agentmbx relay restore <file>` refuses while the relay runs, writes a new epoch, and records the restore in the
  relay log. Backups contain only ciphertext bodies plus the metadata in the threat model.

### 6. Retention and expiry (T167)

Every item has `expires_at = accepted_at + retention`. Retention is an owner decision (below); the recommended value
is 14 days. Expired items are deleted by a periodic sweep in one transaction with a tombstone in `dedup`, so a late
retry is a `duplicate`, not a re-delivery after expiry.

When an envelope item expires, the relay enqueues for the **sender** a `kind:"expired"` notice item: `{v:1,
type:"relay-expired", item_id, target_pubkey, accepted_at, expired_at}`, signed by the relay key. On pull, the
sender's daemon marks its `relay-accepted` row expired and sends the local sender the same alert the LAN outbox
sends after 72 h ("Undelivered to <host>"). Nothing expires silently (G12). Expired receipt items are dropped without
notice, because receipts are advisory.

### 7. Quotas and bounds

Per target: `max_queue_items` and `max_queue_bytes`. Per owner fingerprint (per account once §8's account authority
exists): 50 MB and 10,000 queued items (decision 3), plus pushes per minute, as today.
Per request: `max_batch` and the body cap (`RELAY_MAX_BODY`), checked while streaming. Per pull: `max_pull`. The
dedup horizon is retention + 7 days. A quota failure rejects the whole item (§3) with `rejected:quota:<which>`, and
the sender keeps its row and retries with backoff.

### 8. Enrolment and enc-key advertisement recovery (T168)

- Enrolment is persisted (§2). Re-enrolling the same host key is idempotent.
- The client MUST treat `401 not enrolled` (and an epoch change after a restore) as a reason to re-run challenge,
  enrol and enc-key publish. The kv enrolled flag becomes a cache keyed by `(relay, relay_pubkey, epoch,
  host_pubkey)`, never a permanent short-circuit (G6). The `doctor` key mismatch is fixed with it (G13).
- The client MUST republish its enc-key ad after its own key rotation (T030), and MUST check the result.
- **Enrolment authority is pluggable.** `enrol` asks an `EnrolmentAuthority` whether a host key may enrol:
  `authorize({host_name, host_pubkey, owner_fp, proof}) → {ok, account?, reason?}`. Two implementations are in
  scope:
  - **host-key challenge:** today's behavior, the default.
  - **an extension point** where "this host is authorized by an account" plugs in. The account/device design is
    being planned as its own saga (multi-user accounts that own devices and agents, device authorization, API keys,
    a web console). Its implementation is not part of T165–T168.

  The authority's answer is stored with the enrolment (`account`, `authorized_by`), so revoking an account or
  device can revoke its enrolments. Quotas are then counted per account instead of per self-asserted
  `owner_fp`.

### 9. Receipts over the relay (T166, with T218)

A T218 receipt for a message whose sending host is reachable only through the relay is pushed as an item: `kind:
"receipt"`, `item_id = "receipt:" + msg + ":" + recipient + ":" + seq`, one target (the sending host's pinned key),
and wire bytes = canonical(`{rec, sig}`). This is the unsigned routing envelope `{to_host, item}` agreed with T218,
with `to_host` expressed as the target key. The receiver applies it with `acceptReceipt(node, item, null)`. A
`relay-accepted` envelope row moves to done when its delivery receipt (state `delivered` or later) arrives this way,
or over the LAN.

### 10. Transport selection

The relay is the second transport after the LAN (`docs/spec/cross-machine.md`). A row moves to the relay when its
LAN attempts have failed at least twice and the target is enrolled, **or** when the peer's last known LAN address
is unreachable. The relay pass MUST respect the row's backoff (`next_at`) rather than taking every row each tick.
Once a target is reachable on the LAN again, new rows go over the LAN. `relay-accepted` rows are not re-sent over
the LAN; their delivery receipt settles them.

### 11. Compatibility

The `/v1/relay/*` endpoints stay for one minor release with their current behavior. A 0.5.x client talking to a v2
relay keeps working with v1 semantics. A v2 client uses `/v2` when `GET /v2/relay/info` answers, and falls back to
v1 otherwise. Mixed hosts work because items are opaque to the relay, and receivers dedup by id.

## Owner decisions (2026-10-02)

1. **Hosting:** Railway. One always-on service running `agentmbx relay serve`, with a persistent volume for the
   `node:sqlite` store (§2).
2. **Domain and TLS:** `relay.agentmbx.com` in the owner's Cloudflare DNS, with managed TLS.
3. **Retention:** 14 days, then a signed expiry notice to the sender (§6). Per-owner (later per-account) caps of
   50 MB and 10,000 queued messages (§7).
4. **Backups:** daily online backup, 7 kept (§5); ciphertext only.
5. **Accounts and secrets:** the owner authorized the release lead to create the Railway project and the DNS
   record. The relay key fingerprint is recorded at deploy time for `relay set --key` (§1).
6. **Who may enrol:** **pending: account/device design (saga).** Until then the default authority is the host-key
   challenge, behind the pluggable `EnrolmentAuthority` (§8).

## Tasks and acceptance

- **T165: persist the relay store.** §2 and §3 server side, §7.
  - Tests: restart after commit and before response, and before commit; partial fan-out and quota failure; conflicting
    id reuse; duplicate retries; several addresses on one host; schema creation and upgrade.
- **T166: durable acceptance and the receive checkpoint.** §3 sender side, §4, §9, §10.
  - Tests: a lost push response; 200 with a rejected result; a reordered or duplicate pull; a rejected item in
    quarantine; an ack failure; a receipt item end to end; a relay-accepted row settled by its delivery receipt;
    `next_at` respected.
- **T167: crash recovery, backup, retention.** §5, §6.
  - Tests: real child-process crashes at every commit, response and checkpoint boundary; backup while running; a
    restore that rotates the epoch, re-pushes from senders and lets receivers re-pull without duplicates; the expiry
    sweep and the expiry notice to the sender.
- **T168: enrolment and enc-ad recovery.** §1, §8 (`EnrolmentAuthority` with the host-key implementation), the G13
  doctor fix.
  - Tests: re-enrolment after a restart and after a restore; host-name squatting rejected; a relay key change stops
    use; enc-ad republish after rotation; a stub authority denying or granting by account recorded on the
    enrolment.
- **T147 (with the owner):** deploy per decisions 1–5 (Railway, `relay.agentmbx.com`) and run the home-to-work proof. Mail both ways with each host
  on a different network, the relay restarted mid-flight, and one restore drill.
