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

All references are symbols on `main` (0.5.3) at the time of writing.

| # | Gap | Where |
|---|---|---|
| G1 | Every piece of relay state (queues, enrolments, enc-key ads, sequence counters, dedup set, challenges) is in-process memory. A restart loses all of it. | `RelayCore` fields `queues`, `cursors`, `seen`, `pending`, `encAds` |
| G2 | The sender deletes its outbox row on any HTTP 200, before anything is durable, and without reading `stored`/`error`. A partial batch also answers 200. | `relayDrainOutbox`, `startRelayServer` (`POST /v1/relay/messages`) |
| G3 | Fan-out to several recipient hosts is not atomic: a failure on recipient k leaves earlier rows queued, and the id is not marked seen, so a retry duplicates them. | `RelayCore.push` |
| G4 | Dedup is a global set of envelope ids, unbound to sender or target, unbounded, in memory. | `RelayCore.seen`, F12 |
| G5 | Routing matches the recipient host by name (first match); another key can enrol the same name. | `RelayCore.push`, `RelayCore.enrol`, F4 |
| G6 | After a relay restart the client never re-enrols (a permanent kv flag) and never republishes its enc-key ad: 401 forever. | `relayEnrol`, `relayPublishEnc` |
| G7 | Sequence numbers restart at 1 after a restart while clients keep their old cursor: new items stay invisible. | `RelayCore.cursors`, `relayPull` |
| G8 | The pull cursor returned is the last allocated seq, not the last returned one; pull has no page size; the `after` query is not covered by the hop signature. | `RelayCore.pull`, `relayHop`, `startRelayServer` |
| G9 | Items the receiver rejects (undecryptable, bad signature, host not paired) are acked and dropped silently. | `relayPull` |
| G10 | Broadcast, role and bare-name mail cannot go through the relay (no `@host`), and is retried every tick. | `RelayCore.push`, `relayDrainOutbox` |
| G11 | Delivery receipts (T218) are LAN-only. | `http.ts` `POST /v1/receipts`, `dueReceipts` |
| G12 | No retention: an item for a host that never comes back stays forever; nothing tells the sender. | `RelayCore.queues` |
| G13 | `doctor` checks `relay-enrolled:<relay>` while the client writes `relay-enrolled:<relay>:<hostPub>`, so it always says "not yet enrolled". | `doctor` relay check, `relayEnrol` |

## Design

### 1. Relay identity and discovery

The relay MUST have its own Ed25519 key, generated on first start and kept in its store directory. `GET
/v2/relay/info` returns `{v:2, relay_pubkey, epoch, limits:{…}, version}`; with a signed hop it also returns `you:{host,
pubkey, head_seq, acked_through}` for the caller. The key comes from `MBX_RELAY_KEY` (a deploy secret: the base64
private key `agentmbx relay keygen` prints) or from `relay.key` next to the store; a store MUST refuse a key that is
not its own, and errors MUST NOT echo key material. A host pins the relay key when the owner runs `agentmbx relay set <url>`. The command shows the key's
fingerprint and MUST accept an optional `--key <fingerprint>` to pin it without trust on first use. A later change of
`relay_pubkey` MUST stop relay use and be reported by `doctor` until the owner confirms the new key.

### 2. Server store (T165)

The relay core MUST talk to its state only through a `RelayStore` interface: enrolments, enc-key ads, item insert
with dedup and seq allocation, pull, ack, expiry sweep, quotas, epoch and meta, and `transaction(fn)`. This lets a
later backend (a Railway database container or Neon) replace it without touching the protocol. The first and only
implementation (owner decision, 2026-10-02) is `node:sqlite` on a persistent volume path (Railway volume): no
Postgres dependency now. The relay MUST keep all state in that one database (WAL, `synchronous=FULL`, a single
writer process). Every successful response MUST be sent only after its transaction commits. Required tables:

- `enrolments(host_pubkey PK, host_name, owner_fp, account, authorized_by, enrolled_at, revoked_at)`. **Hosts are
  identified by key; a name is a label.** A name is unique only inside a proven account (`UNIQUE(account, host_name)`
  for live rows), so two owners' `macbook` coexist on a shared relay and nobody can lock a name out. `owner_fp` is the
  host's own unproven claim and decides nothing. Re-enrolment MUST NOT clear `revoked_at`: a revoked key stays
  revoked, and a weaker authority (the host-key challenge) MUST NOT overwrite the `account` or `authorized_by` a
  stronger one recorded. Names match case-insensitively. A name carried by more than 16 live enrolments is *crowded*: v1 name lookups and v1 hops by name treat it as ambiguous, but an enrolment is never refused for it (common names could otherwise be pre-squatted; v2 is by key). F4 is closed
  by key addressing: v2 routing, hop authentication (`x-mbx-key`) and enc-ad lookup are by key. v1 lookups by name
  resolve only when exactly one live enrolment carries the name (or exactly one inside the caller's proven account);
  otherwise the lookup is ambiguous: a v1 push answers `recipient host ambiguous` and stores nothing, and an enc-ad
  lookup answers nothing. A v1 hop by name is authenticated by whichever enrolment of that name verifies the signature.
- **Sender allowlist.** `POST /v2/relay/senders {list:{v:1, type:"relay-senders", host_pubkey, senders[≤256], iat},
  sig}` (signed by the target's host key, newer `iat` replaces older) lists the sender keys a target accepts
  (at most 1,024), normally its pinned peers. An `iat` more than 5 minutes ahead of the relay clock is refused, so a
  future-dated list cannot freeze the allowlist. Once a target published one, pushes from other keys are refused (`rejected:sender not
  accepted by target`), v1 and v2 alike: enrolment is free, so without it many fake sender keys could each take a
  share of the target's queue. Stored in `sender_lists(target_pubkey PK, senders, iat, record, sig)`.
- **Rotation (T030).** `POST /v2/relay/rotate {rotation}` takes the signed rotation record (old and new key both
  signed it; self-authenticating, since a rotated host already signs hops with its new key). The relay moves the
  name, account and queued items to the new key (re-sequenced in order, dedup rows kept), moves its sender allowlist,
  swaps the old key for the new in other targets' allowlists, and revokes the old key. The new key MUST NOT be revoked; if it
  already has queued items, the old queue is appended after them (both keys signed the record, so nothing is stranded). The rotated host MUST reset its own
  receive position for that relay to 0 (its items were re-sequenced; dedup makes repeats harmless).
  A peer's own T030 rotation reaches this host over the LAN; a peer reachable only through the relay is rebound there
  (its new key replaces the old in our allowlist), but this host learns the new key only when the LAN rotation record
  arrives. Until then a republished allowlist names the old key and the peer's relay pushes are refused; the rows wait
  (backoff, deadline), nothing is lost, and the LAN record or a relay-carried rotation notice (later, same item
  mechanism) resolves it.
- `enc_ads(host_pubkey PK, enc_pub, sig, at)`. Only signed advertisements are stored, as today.
- `items(target_pubkey, seq, kind, item_id, sender_pubkey, wire BLOB, wire_hash, bytes, accepted_at, expires_at,
  PRIMARY KEY(target_pubkey, seq))`. `wire` is the exact bytes received; `wire_hash` is lowercase hex SHA-256 of those
  bytes (never of a decoded or re-encoded string).
- `dedup(sender_pubkey, item_id, target_pubkey, wire_hash, seq, accepted_at, PRIMARY KEY(sender_pubkey, item_id,
  target_pubkey))`. It is kept for the dedup horizon (§7) after its item is acked or expired, which closes G4 and F12.
- `seqs(target_pubkey PK, next_seq)`. Sequence numbers never restart and are never reused (G7). A new seq is
  `max(next_seq, now_ms)`: a store restored from an older copy keeps allocating above anything it handed out before
  the restore, so receivers never miss post-restore items even when senders push before they pull (§5).
- `acked(target_pubkey PK, acked_through)`.
- `meta(epoch, relay_pubkey, schema_version)`. A store MUST refuse to open when `schema_version` is newer than the
  binary, and MUST migrate older versions in a transaction (a migration keeps the epoch).

Challenges and rate windows MAY stay in memory, bounded: challenges expire (5 min) and are capped (10,000 open); host
names match `HOST_RE`, keys are 32-byte Ed25519, `owner_fp` is at most 64 safe characters; challenge and enrol are
rate-limited per client address (behind a proxy: the rightmost `X-Forwarded-For` entry, the one the trusted proxy
appended, with `--trust-proxy` / `MBX_RELAY_TRUST_PROXY=xff`, or `CF-Connecting-IP` with
`MBX_RELAY_TRUST_PROXY=cloudflare`; earlier XFF entries are client-controlled), and that rate table is hard-capped;
enrolment bodies are small; live enrolments are capped. A restart only invalidates outstanding challenges, and clients retry
them. Dedup rows are swept after the dedup horizon (§7, T167).

### 3. Push and acceptance (T165, T166)

`POST /v2/relay/items` with a signed hop. The hop signature MUST cover the method, the path **including the query
string**, the timestamp and the full body (the same signed-hop shape as host-to-host HTTP; G8). v2 callers send
`x-mbx-key` and are found by key. Body: `{items:[{kind, item_id, targets:[{host_pubkey, wire_b64}]}]}`,
at most `max_batch` items.

- **Senders resolve targets.** A sender MUST address items by the pinned host key of each target and MUST NOT send
  broadcast, role or bare names to the relay. It expands them to concrete hosts first, exactly as `route()` does for
  the LAN (closes G5 for routing, and G10). Wire bytes are sealed for each target separately, as today.
- **One transaction per item.** The relay validates every target (enrolled, not revoked, quotas, size) before
  writing anything. If any target fails, the whole item is rejected and nothing is stored (G3). Several addresses on
  the same host are one target: **the sender merges them** into one target per host, and the relay rejects a repeated
  target (`rejected:duplicate target`).
- **Receipts** MUST be well-formed T218 records signed by the pushing host, with `item_id =
  receipt:<msg>:<recipient>:<seq>`; envelopes MUST be sealed and carry `item_id` as their id.
- **Dedup.** For each target, `(sender_pubkey, item_id, target_pubkey)`:
  - absent → insert the item and the dedup row, and allocate a seq;
  - present with the same `wire_hash` → `duplicate`, returning the original seq. Its accept statement carries the
    original acceptance time as `at` (T167), so a retry, a re-push after a restore, or a retry after expiry never
    moves the sender's deadline;
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
  recoverable: the sender still holds the bytes. Through a re-push after an epoch change the row stays in
  `relay_sent` as `repush`, keeping its deadline (T167): the LAN outbox's 72 h give-up never applies to it, since the
  target may need days to come back and re-enrol. A LAN delivery or a delivery receipt settles it; a LAN rejection
  ends it `rejected` (the sender is alerted, `doctor` shows it); an expiry notice or the deadline ends it too. Local
  mailbox retention (`agentmbx prune`) never removes a message with a `relay-accepted` or `repush` row.
- **Own its deadline.** A `relay-accepted` row whose delivery receipt has not arrived by `accepted_at + retention +
  grace` (grace 24 h) is marked unconfirmed and the local sender gets "Undelivered/unconfirmed to <host>", without
  waiting for anything from the relay. The relay's expiry notice (§6) is an early signal, never the only one, because
  a relay that lost the item (wipe, bad restore) cannot send it. A target older than 0.5.3 never sends delivery
  receipts, so for it **the deadline settles the row**: when no receipt has ever arrived from that host, the alert
  says there is no delivery confirmation and the peer may be older than 0.5.3, instead of calling the mail lost.

### 4. Pull, receive and ack (T166)

`GET /v2/relay/items?after=<seq>&limit=<n>&epoch=<epoch>` (signed hop, `n ≤ max_pull`) returns `{epoch, head_seq,
items:[{seq, kind, item_id, sender_pubkey, wire_b64}], last_seq, more}`. `last_seq` is the last seq **returned** (G8);
`head_seq` is the last seq allocated for the caller. A page stops at `max_pull` items or about `max_pull_bytes`
(always at least one item). An `epoch` that is not current answers 409 with the current epoch.

**Going back in time is an epoch change.** If, in the same epoch, `head_seq < received_through`, or an ack answers
`BAD_ACK` (beyond the head), the store went back in time (a restore that kept its epoch). The receiver MUST handle it
exactly like a new epoch (§5): reset its position to 0 and re-pull; dedup makes repeats harmless.

The receiving host MUST process items in seq order:

- An envelope goes to `node.receive()`. A receipt goes to `acceptReceipt(node, {rec, sig}, null)` (T218: the
  signature is checked against the recipient host's pinned and retired keys, and the message must be one this host
  sent and routed to that host). This closes G11.
- **Accepted** or **duplicate** → the item is done.
- **Rejected** (undecryptable, bad signature, unpaired, malformed) → the item is written to `relay_quarantine(relay,
  epoch, seq, item_id, sender_pubkey, reason, wire, at)` and is then done. It is never dropped silently (G9).
  `doctor` and `agentmbx relay quarantine` list it. An envelope quarantined because its host was not paired is
  processed again once the host it names is paired with the key that pushed it (T333). A sender key that is paired
  under another host name does not qualify, so such an item is not re-quarantined on every pull.
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
- **Restore from backup.** A restore MUST rotate the epoch. Restores made by `agentmbx relay restore` do this; any
  other restore (a volume snapshot, a file copy) MUST be followed by `agentmbx relay rotate-epoch --store-dir <dir>`
  before the relay serves again. If that is missed, the seq floor (§2) still keeps every post-restore item above the
  receivers' checkpoints, and receivers that pull before any push detect the rewind (`head_seq < received_through`,
  §4). The relay also writes a heartbeat to its store every 30 s and, at startup, rotates the epoch itself when the
  stored heartbeat is more than 10 minutes old: a volume restore restarts the service on old data, and so does a long
  outage (an extra rotation only costs a re-push and a re-pull, which dedup absorbs). A heartbeat more than 10 minutes
  ahead of the relay clock rotates it too, since the clock went back or the store was written under another clock. The
  relay logs one line when it rotates at startup, with the heartbeat, its age and both epochs (T333). On seeing a new
  epoch, in either a push or a pull response:
  - A sender re-pushes every outbox row in `relay-accepted` state whose delivery receipt hasn't arrived. Dedup
    makes this safe even where the restored store still has the item.
  - A receiver resets its relay position for that relay to 0 and pulls everything. Receiver dedup by message id
    (`node.receive` → `duplicate`) and `acceptReceipt` (state rank, then seq) make repeats harmless.

  Post-backup mail is therefore recovered from senders rather than lost. A receiver that gets a relay item it already
  has (a duplicate) queues its delivery receipt for that message again (T167): the sender pushed it again, so it is
  still waiting, and the receipt the relay accepted after its backup was lost with it. A receiver also treats a
  message its own retention pruned as a duplicate: `agentmbx prune` records each pruned id in `pruned_ids` for 21 days
  (relay retention plus the dedup grace), so a restored relay never hands back acked, pruned mail as new.
- **Backup.** `agentmbx relay backup <file>` uses the SQLite online backup API. It is safe while the relay runs.
  `agentmbx relay restore <file>` refuses while the relay runs, writes a new epoch, and records the restore in the
  relay log. Backups contain only ciphertext bodies plus the metadata in the threat model.

#### 5.1 As implemented (T167)

- **One writer per store.** `relay serve` holds an exclusive SQLite lock on `relay.lock` in the store directory for
  its whole life (it waits up to 60 s for it at start, for an overlapping redeploy). The operating system releases it
  when the process dies, even by SIGKILL. `relay restore` takes the same lock, so it can never replace a store under a
  running relay, and a relay cannot start during a restore. For a store without `relay.lock` (a relay older than
  T167), a heartbeat younger than 90 s also refuses a restore unless `--force`.
- **Backup** (`src/relay-ops.ts` `backupStore`): one backup-API step (one consistent snapshot while the relay writes),
  written beside the target, switched to a rollback journal (a single self-contained file), integrity-checked, made
  owner-only (0600, in a directory created 0700; rollback copies and the restored store too), then renamed into place;
  an existing file is never overwritten. Receipt: `{type:"relay-backup", file, bytes, sha256,
  epoch, relay_fingerprint, schema_version, heartbeat, counts, restore}`, printed and appended to the relay log.
- **Restore** (`restoreStore`), all or nothing:
  1. The backup is copied (with its `-wal`, if it is a raw volume copy) and checked: integrity, a relay store (epoch
     and relay key), a schema this binary can open, and the **same relay key** as the store it replaces (clients
     pinned it, §1). The file given is never modified.
  2. The current store is copied to `rollback/relay-<time>.db` with the backup API, and the authority it holds is read.
     If it cannot be read, the restore stops unless `--force` (its raw files are then kept in `rollback/`).
  3. **A restore never recreates authority.** The copy keeps every revocation of the current store (a key revoked or
     rotated away after the backup stays revoked, and cannot re-enrol), the newer signed sender allowlist of each
     target and the newer signed enc-key ads (by `iat` / `at`), each target's sequence floor, and the relay log.
     Only what restricts, or what its owner signed, is carried; enrolments made after the backup are not (those hosts
     get `401` and re-enrol, §8).
  4. The epoch rotates, the heartbeat is set to now (so `serve` does not rotate again for the backup's age), and the
     receipt is logged in the copy.
  5. The copy is renamed over `relay.db`; the old store's WAL never meets the new file. A failure before the rename
     leaves the live store untouched.

  Receipt: `{type:"relay-restore", backup:{file, sha256, epoch, …}, replaced:{epoch, rollback, sha256, readable},
  epoch:{from, to}, carried:{revocations, sender_lists, enc_ads, seq_floors}, counts, rollback, next}`. `rollback` is
  the exact command that undoes it: restoring the rollback copy, which is itself a restore (a new epoch, clients
  converge again, dedup absorbs the repeats).
- **Hosted relays** cannot run `relay restore` beside the relay process (the container is the relay).
  `MBX_RELAY_RESTORE_FROM=<backup on the volume>` makes `relay serve` restore it at start, under its own lock. The path
  is consumed: every path a store was restored from is recorded (`meta.restored_paths`, carried across later
  restores), and a path already there is ignored with one log line ("ignored: already restored from <path> at
  <time>"), whatever the file there holds now. To restore again, use a new path. A failed startup restore is logged
  and the relay serves the current store unchanged.
- **The relay log** (`ops` table, last 1,000; `agentmbx relay log [--json]`) holds every receipt: backups, restores,
  operator and startup epoch rotations (with the stale or future heartbeat that caused them), and each retention sweep
  that changed something. A restore carries the current log into the restored store.
- **Crash drills** (`test/relay-crash-drills.test.ts`) kill real child processes with SIGKILL: the relay before and
  after the accept commit, before a pull answer, and before and after the ack commit; the sending host after
  persisting its bytes and after the relay answered; the receiving host after delivery before its checkpoint, after its
  checkpoint before the ack, and after the ack before recording it; and the real `agentmbx relay serve` mid-push and
  mid-pull. Each restart loses nothing, delivers nothing twice, keeps sequences increasing and keeps the epoch.

#### 5.2 Runbook (T167)

Self-hosted relay (`--store-dir DIR`, default `~/.local/share/agentmbx-relay`):

1. **Back up** (any time, relay running): `agentmbx relay backup /backups/relay-$(date +%F).db --store-dir DIR`. Keep
   the printed receipt (sha256). Keep `relay.key` (or the `MBX_RELAY_KEY` secret) separately: a backup holds no key.
2. **Restore**: stop the relay, then `agentmbx relay restore <backup> --store-dir DIR`. Keep the receipt; it names the
   rollback copy and the command that undoes the restore. Start the relay. Check `agentmbx relay log` and that
   `GET /v2/relay/info` shows the receipt's `epoch.to`.
3. **Roll back** a restore: stop the relay, run the receipt's `rollback` command, start the relay.
4. **Any other restore** (a volume snapshot, a file copy): run `agentmbx relay rotate-epoch --store-dir DIR` before or
   right after the relay starts (it is safe while it runs). A copy older than 10 minutes rotates at start by itself.

Hosted relay (Railway, `relay.agentmbx.com` and `relay-staging.agentmbx.com`; daily volume backups, 7 kept). These
steps need the live service and the owner, so they are a procedure, not a test; rehearse on staging first:

1. Before: `node scripts/relay-restore-check.mjs https://relay-staging.agentmbx.com > before.json` (read-only: the key
   fingerprint, epoch and version the relay serves).
2. **Volume restore**: restore the volume from a Railway backup. The service restarts on the old data; its heartbeat is
   hours old, so it rotates the epoch at start and logs one line with the heartbeat, its age and both epochs.
   **File restore**: the backup must be on the volume (for example one made over `railway ssh` with
   `agentmbx relay backup /data/backups/<file> --store-dir /data`). Set `MBX_RELAY_RESTORE_FROM=/data/backups/<file>`,
   redeploy, keep the receipt from the deploy log, then unset the variable.
3. After: `node scripts/relay-restore-check.mjs https://relay-staging.agentmbx.com --before before.json`. Exit 0 means
   a new epoch under the same relay key. A changed key means the wrong store or key secret: clients refuse the relay
   (§1), so restore the right one. An unchanged epoch means run `agentmbx relay rotate-epoch --store-dir /data` (via
   `railway ssh`).
4. Roll back a volume restore by restoring the newer volume backup, or a file restore with
   `MBX_RELAY_RESTORE_FROM=/data/rollback/relay-<time>.db` (the receipt in the deploy log names it).

Known limit: a message acked by its target before the backup whose delivery receipt the relay accepted after the
backup is not re-delivered (the restored store remembers it), so that receipt is not sent again; its sender alerts
"unconfirmed" at its deadline although the mail was delivered. Nothing is lost silently.

### 6. Retention and expiry (T167)

Every item has `expires_at = accepted_at + retention`. Retention is an owner decision (below); the recommended value
is 14 days. Expired items are deleted by a periodic sweep in one transaction with a tombstone in `dedup`, so a late
retry is a `duplicate`, not a re-delivery after expiry.

When an envelope item expires, the relay enqueues for the **sender** a `kind:"expired"` notice item: `{v:1,
type:"relay-expired", item_id, target_pubkey, accepted_at, expired_at}`, signed by the relay key. On pull, the
sender's daemon marks its `relay-accepted` row expired and sends the local sender the same alert the LAN outbox
sends after 72 h ("Undelivered to <host>"). Nothing expires silently (G12). Expired receipt items are dropped without
notice, because receipts are advisory. The notice is best effort: senders also enforce their own deadline (§3).

As implemented (T167): `relay serve` sweeps at start and every 10 minutes (`RelayCore.sweep`), in bounded batches,
each one transaction. Only items whose `expires_at` has passed are touched. **Expiry applies to v2 items only until
the v1 endpoints are retired:** a v1 sender deleted its row on the 200 and v1 pulls drop non-envelopes, so it could
never learn of a notice; v1 pushes therefore get no `expires_at`, and neither do items queued before a store first
enforced expiry (it cannot tell their protocol; `meta.expiry_from` records when it started). Neither expired before
T167, so nothing regresses; quotas still bound them. The notice is the item
`expired:<item_id>:<target_pubkey>` with wire bytes canonical(`{notice, sig}`); a sweep after a restore never queues the
same notice twice. A notice is not queued when the sender's key is no longer enrolled (revoked or rotated away) or when
the sender's own queue is at its item or byte cap: quotas hold, and the sender's deadline covers it. Expired items no
longer count against any quota. The sender applies a notice only if the pinned relay key signed it and it names the
row with that message **and that target key** (a row re-sealed for a rotated key is a different one); the row ends
`expired`, leaves the outbox if a re-push was pending, and the sender gets "Undelivered to <host>". If the target
already confirmed delivery (its pull raced the sweep), the row settles instead and nobody is alerted. A forged notice is
quarantined. Each sweep that changed something writes a receipt to the relay log (`relay-sweep`: expired by kind,
notices, notices skipped and why, dedup rows pruned, bytes freed).

### 7. Quotas and bounds

Quotas charge what the relay can prove. Per target host key: `max_queue_items` and `max_queue_bytes` (10,000 and
50 MB, decision 3). Per sender per target: a share (2,000 items, 20 MB), so one sender cannot fill another host's
queue; a target's sender allowlist (§2) closes the remaining gap of many fake sender keys. Per proven account (§8):
10,000 items and 50 MB across its hosts. A self-asserted `owner_fp` is never charged:
anyone could claim another owner's fingerprint and exhaust that owner's quota. Pushes per minute are counted per
sender key.
Per request: `max_batch` and the body cap (`RELAY_MAX_BODY`), checked while streaming. Per pull: `max_pull` and
`max_pull_bytes`. v1 pulls are bounded the same way. The
dedup horizon is retention + 7 days: the sweep deletes dedup rows accepted before it whose item is gone (acked or
expired); a row whose item is still queued is never pruned (T167). A quota failure rejects the whole item (§3) with `rejected:quota:<which>`, and
the sender keeps its row and retries with backoff.

### 8. Enrolment and enc-key advertisement recovery (T168)

- Enrolment is persisted (§2). Re-enrolling the same host key is idempotent.
- The client MUST treat `401 not enrolled` (and an epoch change after a restore) as a reason to re-run challenge,
  enrol and enc-key publish. The kv enrolled flag becomes a cache keyed by `(relay, relay_pubkey, epoch,
  host_pubkey)`, never a permanent short-circuit (G6). The `doctor` key mismatch is fixed with it (G13).
- The client MUST republish its enc-key ad after its own key rotation (T030), and MUST check the result.
- **Enrolment authority is pluggable.** `enrol` asks an `EnrolmentAuthority` whether a host key may enrol:
  `authorize({host_name, host_pubkey, owner_fp, proof}) → {ok, account?, org?, reason?}`. The answer is stored with
  the enrolment (`account`, `authorized_by`); quotas and name uniqueness then use the account.
- **Owner decision (2026-10-02, PLAN D7/D9 and §4.5):**
  - **Hosted relay (relay.agentmbx.com): account tokens.** A host enrols with a short-lived access token issued by
    accounts.agentmbx.com after `agentmbx login`, requested for the relay with an RFC 8707 resource indicator. The
    relay verifies it offline against the issuer's JWKS. Claims: `iss` (the accounts issuer), `aud` (the relay URL;
    the api's tokens are refused), `sub` (the host id), `account` and `org` (tenancy), `cnf.jkt` (the thumbprint of
    the host's cloud key, which the host key certified at enrolment, so the token is bound to the host), `client_id`,
    `iat`, `exp` (≤ 15 min), `jti`. The hop is still signed by the host key, and the relay checks that the token's
    host binding matches the hop key. JWKS is cached by `kid` and refreshed on an unknown `kid` (at most once per
    minute) and every 10 minutes; a key that leaves the JWKS stops verifying at once. If JWKS cannot be fetched, the
    relay keeps using cached keys until their cache expires (1 h), then fails closed for new enrolments while
    already-enrolled hosts keep pulling and pushing within their token lifetime.
  - **Revocation.** Revoking a host's cloud credential, or removing an account or organization, pushes a deny-list
    entry to the relay keyed by `host_fp` and `client_id`, kept at least as long as the longest token TTL, and
    closes the host's open relay sessions. LAN pairing is never touched.
  - **Per-account quotas** (decision 3) apply to the `account` claim.
  - **Self-hosted relays: host-key challenge**, the default `EnrolmentAuthority`, with key/sender quotas (§7).

### 9. Receipts over the relay (T166, with T218)

A T218 receipt for a message whose sending host is reachable only through the relay is pushed as an item: `kind:
"receipt"`, `item_id = "receipt:" + msg + ":" + recipient + ":" + seq`, one target (the sending host's pinned key),
and wire bytes = canonical(`{rec, sig}`). This is the unsigned routing envelope `{to_host, item}` agreed with T218,
with `to_host` expressed as the target key. The receiver applies it with `acceptReceipt(node, item, null)`. A
`relay-accepted` envelope row moves to done when its delivery receipt (state `delivered` or later) arrives this way,
or over the LAN.

The host that owes a receipt signs it for the relay once and keeps those bytes (`relay_receipt_wire`) for every
retry. The bytes go when the receipt leaves its outbox: delivered over the relay or the LAN, expired, or retired (T333).

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
   record. The lead generates the relay key at deploy (`agentmbx relay keygen`, stored as the `MBX_RELAY_KEY`
   secret) and records its fingerprint for `relay set --key` and account auto-config (§1).
6. **Who may enrol:** hosted relay: account-issued, host-key-bound tokens verified offline through JWKS; self-hosted
   relays: the host-key challenge (§8, PLAN D7/D9).

## Tasks and acceptance

- **T165: persist the relay store.** §2 and §3 server side, §7.
  - Tests: restart after commit and before response, and before commit; partial fan-out and quota failure; conflicting
    id reuse; duplicate retries; several addresses on one host; schema creation and upgrade; a restore that kept its
    epoch is visible through `head_seq`; names shared across owners; revoked keys stay revoked; rotation moves the
    queue; key and sender quotas; bounded enrolment state; exact wire bytes.
- **T166: durable acceptance and the receive checkpoint.** §3 sender side, §4, §9, §10.
  - Tests: a lost push response; 200 with a rejected result; the sender deadline without any relay notice; a pre-0.5.3
    target; a reordered or duplicate pull; a rejected item in
    quarantine; an ack failure; a receipt item end to end; a relay-accepted row settled by its delivery receipt;
    `next_at` respected.
- **T167: crash recovery, backup, retention.** §5, §6.
  - Tests: real child-process crashes at every commit, response and checkpoint boundary; backup while running; a
    restore that rotates the epoch, re-pushes from senders and lets receivers re-pull without duplicates; the expiry
    sweep and the expiry notice to the sender.
  - Done: `test/relay-crash-drills.test.ts` (relay, sender and receiver SIGKILLed at each boundary, and the real
    `relay serve` mid-push and mid-pull), `test/relay-recovery.test.ts` (backup while serving; restore with authority
    carried forward and rollback; refusals; the sweep, notices, tombstones and quota; no local expiry rule dropping
    accepted mail; the CLI and `MBX_RELAY_RESTORE_FROM`). The hosted restore drill is the runbook in §5.2, with
    `scripts/relay-restore-check.mjs`; it runs with the owner as part of T147.
- **T168: enrolment and enc-ad recovery.** §1, §8 (`EnrolmentAuthority` with the host-key implementation), the G13
  doctor fix.
  - Tests: re-enrolment after a restart and after a restore; a name squatter never receives a host's mail (key routing); a relay key change stops
    use; enc-ad republish after rotation; a stub authority denying or granting by account recorded on the
    enrolment.
- **T147 (with the owner):** deploy per decisions 1–5 (Railway, `relay.agentmbx.com`) and run the home-to-work proof. Mail both ways with each host
  on a different network, the relay restarted mid-flight, and one restore drill.
