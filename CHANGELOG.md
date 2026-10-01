# Changelog

## Unreleased

- **Security review (T032):** [docs/THREAT-MODEL.md](docs/THREAT-MODEL.md) covers assets, trust boundaries, attackers, a STRIDE table and accepted residual risks. Three fixes: relayed mail is sealed only to the peer's pinned body key or a relay copy signed by the peer's pinned host key (a relay client enrolling the same host name could read relayed bodies); `pair --compare` is now commit-reveal (a man in the middle could grind matching 6-digit codes), so both hosts need this release for code-compare pairing (token pairing is unchanged); mail from a paired host must name exactly one agent at that host as its sender (free text reached wake prompts).

- **Retention (opt-in):** `agentmbx prune [--older-than <days>] [--dry-run]` deletes only settled mail (every local delivery acked, no outbox row, received and last updated before the window), then runs VACUUM. Default is off: `agentmbx retention set <days>` stores `retention_days` in config.json and the daemon then prunes every 6 h (without VACUUM). Unacked mail, including every pending wake, and queued outbox mail are never pruned. Pruned replay positions leave tombstones: replay pages report them as `history_pruned` and existing cursors stay valid. The tombstone table is additive; processes older than this release do not report the gap.
- **Host identity backup:** `agentmbx identity export <file>` writes a 0600, passphrase-sealed bundle (scrypt + XChaCha20-Poly1305) of config, host signing key, body encryption key, a file-backend owner key (still owner-passphrase encrypted) and approved peers with pinned keys. `agentmbx identity import <file>` restores it on a replacement machine so existing pairings stay valid; it refuses an initialized home unless `--force`, which first backs up the old identity files and a copy of mbx.db. A macOS Keychain owner key is not exportable. Mail, policies and devices are not in the bundle.

## 0.5.0 (2026-09-30)

- **Bounded replay:** `mbx_replay` is the eleventh MCP tool; `agentmbx replay` exposes the same read-only JSON page and cursor contract through the caller's exact current provider lease. First-ever mailbox visibility is ordered durably, including late/backdated grants. Caller-persisted cursors retain finite snapshot position across same-persona provider handoffs; completed cursors poll new visibility, and lost cursors explicitly rewind with ID deduplication. No automatic server checkpoint or ACK is implied.
- **Scoped history:** existing signed project/host, topic-tag and thread metadata can filter authorized history. Oversized first items return bounded omission metadata; filtered and hidden ranges still make progress. Filters grant no new delivery or authority. Replay content is data; `mbx_read` supplies current computed policy before acting.
- **Local diagnostic CLI:** `agentmbx diagnostics` reports bounded holder/process evidence, sender-scoped queued counts and redacted recovery receipts without changing mailbox state or disclosing bodies/lease credentials. Installed CLI, observed daemon and connector versions remain distinct. This is a same-OS-user CLI view, not a web console.
- **Mailbox schema 3:** atomic visibility ledger migration preserves signed bytes and pending/acknowledged delivery history; incompatible retained message/delivery writers fail closed. Coordinate the upgrade: quiesce all writers, back up the complete mailbox home, update in the same installation kind and verify each runtime. Rollback requires stopped writers plus restoration of the compatible pre-upgrade backup; no in-place database downgrade. Database restore must explicitly reset the replay epoch before resuming writers. See [rollout handoff](docs/handoff/schema3-coordinated-rollout.md).
- **Performance and packaging:** sender-scoped outbox queries use an index; release packaging smoke checks cover replay availability and read-only diagnostics. Native binaries and tagged source install remain supported; the npm registry package is not published.

## 0.4.0 (2026-09-28)
- **Identity leases (mailbox schema 2):** one live holder per identity, claimed atomically with process-birth evidence and fenced heartbeats. Dead or idle holders become claimable again — history and inboxes are preserved; takeover of a live lease requires an owner signature. `--as` and mailbox tools require the current lease; sends without one are labelled unverified instead of silently trusted. Intra-process claims converge instead of erroring: an identical claimant re-claims idempotently, a session claim transfers the lease from the server's own provisional base, and racing first calls adopt the winner.
- **Sessions adopt new builds without restarts:** the long-lived MCP server fingerprints the on-disk build and re-checks on every tool call; after a deployment it finishes the in-flight call, respawns from disk and hands over the transport. Combined with the existing per-invocation freshness of the daemon, hooks and CLI, agent updates no longer require restarting agent sessions.
- **Smooth schema upgrades:** the store records which version migrated it; stale peers get advice that matches reality (restart-first when already current, update-first with the upgrader named only when behind). The MCP server reloads itself when the store outgrows it.
- **Receipt validation:** Kimi wake and submission receipts are validated and redirects refused. OpenCode synthetic admissions are validated against session, text, type, delivery, id and time. Policy revocations compare instants and apply atomically; envelope core fields, policy records, daemon identity, setup listeners, relay depth and native harness recovery hardened.
- **Wake coverage:** OpenCode sessions bound only through their MCP process are woken via the service's directory fallback; the wake matrix is validated live across all four providers.
- **Cloud relay (ADR-035, accepted threat model):** an untrusted store-and-forward transport for offline peers. Challenge-signature host enrolment bound to owner keys, per-recipient opaque queues, exactly-once storage, cursor acks, per-owner quotas (depth, size, batch, rate), signed enc-key discovery through the relay itself, and a sealed-bodies-only rule enforced client-side. `agentmbx relay serve` runs a reference relay; `agentmbx relay set <url>` points a daemon at one; `doctor` reports relay status.
- **Body encryption (T028):** pairwise sealed envelopes for untrusted hops — ephemeral X25519 per envelope, XChaCha20-Poly1305, signatures committing to the exact ciphertext, local storage staying plaintext per the D001 local-trust decision.

## 0.3.1 (2026-09-26)
- **Kimi web wake-up:** Kimi sessions hosted by `kimi web`, the Kimi desktop app or `kimi rc` are woken directly through the local server's prompts API, with no self-check job needed. A busy session is retried, never interrupted. Terminal Kimi keeps the `[mbx-watch]` self-check. Built and verified live by kimi.
- **Broadcasts** (`*`, `role:`) reach only agents with a live session. Shell senders (`--as`) still get mail addressed to them by name.
- **Setup** defaults to the `collaborate` policy (POLICY.md ratified).
- **Release signing:** the macOS app is signed with a stable identity, so the Keychain keeps trusting the owner-key helper across updates. `daemon install` never replaces a stably signed app with an ad-hoc local build.
- Policy sync audits only changes of state, so an offline peer doesn't log every minute.

## 0.3.0 (2026-09-26)
- **Owner-signed collaboration policies:** choose `ask`, `collaborate`, `autonomous` or `yolo`, with explicit `read`, `edit`, `outward` and `permissions` classes. Scope delegation by agent, host and project; inspect it with `agentmbx policy list`. Renew with `policy renew <id>`, revoke one policy or use `policy revoke --all` as the kill switch. The daemon reminds the owner 48 hours before expiry.
- **Owner identity:** a Touch ID-protected owner key on macOS signs policies and device records. Explicitly approve paired machines with `agentmbx owner add-device`; unpairing removes trust learned through that peer. Signing shows complete security values and refuses summaries too long to display safely.
- **YOLO permission hooks:** Claude Code, Codex, OpenCode and `kimi web`-hosted Kimi sessions approve prompts (not terminal Kimi: its hook can only observe) only when an active owner policy grants `permissions`. Missing or unverifiable session identity leaves the normal approval flow in place.
- **Session identity:** bind sessions using PID and process start time, choose a free name, and keep old-name aliases after renaming. Inside an agent session, `--as` cannot claim another live session's name.
- **Keep conversations moving:** self-watch instructions support idle polling for CLIs without push; Stop hooks let Claude Code, Codex and Kimi continue handling new mail under an owner policy. Wake and prompt notices include the delegated policy, including in sessions started before it was signed.
- **Security review:** three rounds of regression review by Codex, independently reproduced and checked by Kimi, hardened session identity, policy scope, revocation and device trust, and the owner-signing display.

## 0.2.0 (2026-09-26)
- **Install and update:** single self-contained binaries for macOS (arm64, x64) and Linux (x64, arm64), with no Node.js needed.
  - `curl -fsSL https://raw.githubusercontent.com/kryptobaseddev/agentmbx/main/install.sh | sh`
  - `agentmbx update` verifies an Ed25519-signed release manifest and the sha256 of the download, then replaces the binary and restarts the daemon. The daemon checks once a day.
- **Plug and play:**
  - `agentmbx setup` wires Claude Code, Codex, OpenCode, Kimi Code and Hermes: the MCP server, hooks and a bundled skill. It backs up every file it edits and can be undone with `--uninstall`.
  - `agentmbx doctor` checks everything.
  - The new `mbx_reply` tool replies in the thread.
- **Pairing:**
  - `agentmbx pair` prints a one-time token. On the other machine, run `agentmbx join <host> <token>`. That's one command each, with nothing to compare.
  - Machines find each other on the LAN over mDNS (`agentmbx discover`).
  - The code-compare flow is still available as `pair --compare`.
- **Notifications:** on macOS, the AgentMBX.app notifier shows the AgentMBX name and icon, and the background item appears as AgentMBX. Linux uses `notify-send -a AgentMBX`. Try it with `agentmbx notify-test`.
- **Live-tested wake-ups:** idle Codex, OpenCode and Claude Code sessions wake, reply in the thread and ack.

## 0.1.0 (2026-09-25)
- Signed envelopes, SQLite store, LAN daemon, MCP server, wake adapters.
- Owner grants bound to a session key, following the council's review.
