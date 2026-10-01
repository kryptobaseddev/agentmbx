# Cross-machine collaboration: transports, presence and wake

Status: draft for v0.5.1. Owned jointly by agentmbx-d4bacee4d3@macbook (lead) and claude@fedora. CLEO: T201 (presence and
address healing), T202 (Claude session socket wake), T146/T147 (relay and home↔work, next release).

## Goal

Agents on different machines collaborate without anyone knowing an IP address, launching a CLI with special flags, or
re-pairing after a network change. Trust never moves: hosts stay identified by the keys pinned at pairing. Addresses,
transports and wake paths are hints, used only after a signature from the pinned key proves who answered.

## Terms

- **Pinned key:** the host signing key stored at pairing (or moved by a signed rotation, docs/SPEC.md).
- **Address:** `host:port` (IPv4, `[IPv6]` or a name) where a peer's daemon answered last.
- **Alternates:** other addresses a peer has announced, tried in order when the address fails.
- **Presence:** a signed announcement of where a host can be reached now.

## Presence and address healing (T201)

A DHCP change silently broke Fedora→MacBook delivery: Fedora retried the MacBook's old address forever while the other
direction kept working. Learning only from inbound requests misses a peer that moved but has nothing to send, so
presence is announced proactively.

### Signed status challenge

`GET /v1/status` stays public and unsigned (doctor, humans). `GET /v1/status?challenge=<base64 32 bytes>` MUST return
`{host, host_pubkey, challenge, addrs, version, at}` plus `sig`, an Ed25519 signature over the canonical JSON of those
fields by the host key. A caller MUST accept an address only when `host` matches, `sig` verifies against the **pinned**
key, and `challenge` is its own fresh nonce. A proxied or replayed status cannot pass: the attacker cannot sign the
nonce.

### Presence announcements

`POST /v1/presence` is a signed hop carrying `{addrs: [host:port…], port, version, at, seq}`. The receiver:

1. verifies the hop against the pinned key;
2. ignores a `seq` that is not greater than the last one seen from that host (replay within the hop window cannot
   revert an address);
3. challenge-probes the announced addresses in order, moves the address to the first that verifies, and stores the
   rest as alternates;
4. makes queued outbox mail for that host due at once.

A host announces presence:

| When | To |
|---|---|
| Daemon start | every paired peer |
| Within ~10 s of an interface or IP change (`os.networkInterfaces()` polled every 10 s) | every paired peer |
| Every 5 min while idle (heartbeat) | every paired peer |
| Immediately when mail to a peer fails | that peer's address and each alternate |

### Inbound learning

A verified signed hop from an IP other than the pinned one triggers a challenge probe of that IP (port from the
`x-mbx-port` hint, else the pinned port). Probes are throttled to one a minute per peer. A pinned name such as
`mac.local` is replaced only while mail to it is failing.

### Failure ladder

For a peer with failing mail, try in order, each by challenge probe: pinned address → last inbound IP → alternates →
mDNS (when multicast reaches the peer; on the home LAN it does not in either direction today) → relay (T146/T147).
`agentmbx peers addr <host> <host:port>` is the manual escape hatch and is also challenge-checked.

If both hosts move at the same time, presence sent to old addresses fails; on a LAN without multicast only the relay rung
or the manual command recovers. That is acceptable for v0.5.1 and is a reason the relay transport exists.

### Doctor

For each peer: the address and how it was learned (pairing, inbound, presence, mDNS, manual), the age of the last verified
presence, and the outcome of a challenge probe (answers, answers as a different host or key, refused, unreachable).

### Compatibility

A peer without `/v1/presence` or the challenge (0.5.0) keeps today's behaviour: its pinned address is used and is never
moved without a signature. Unsigned evidence never moves an address.

## Claude session socket wake (T202)

Claude Code exports `CLAUDE_CODE_MESSAGING_SOCKET` and `CLAUDE_CODE_MESSAGING_TOKEN` to each session, its hooks and its
MCP servers. By default it delivers socket messages from the session's own child processes without any setting, and the
mbx MCP server is such a child. So the session's own mbx server, not the daemon, queues the standard no-body `[mbx]` hint
(NDJSON: `{"type":"auth","token"}` then `{"type":"user","message":{"role":"user","content"}}`) with the same wants-wake,
authority, mute and brake checks as the channel path, and registers as the push holder so the daemon defers. The token
never leaves that process's environment. A server uses the socket only when it is `<its Claude parent pid>.sock`, so a
server started by a command inside a session never pushes into it. Validated live on the MacBook on 2026-10-01 (a child
process posted into its session and the line arrived as a teammate message); Fedora validation is part of T202.

## Transports beyond the LAN (T146/T147, next release)

Each peer keeps an ordered transport list: direct LAN address(es), then the durable relay. Delivery fails over
automatically; pairing works through the relay so two networks can pair without a LAN. The relay sees only sealed bodies
and the metadata listed in docs/THREAT-MODEL.md.
