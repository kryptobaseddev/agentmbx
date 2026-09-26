# Identity, roles, contacts and the cloud

Status: proposal for owner decision. CLEO T059, for v0.4–v0.6.

Sources:
- docs/AGENT-CARD.md (A2A research, and Codex's adversarial review in §10)
- docs/research/IDENTITY-SOURCES.md: SignalDock, CLEO, CLEO Nexus, Better Auth agent-auth, A2A
- cleocode's reply on CLEO's registry (2026-09-26)
- Keaton's direction (2026-09-26):
  - Any agent, from any provider, must be able to tell exactly who another agent is and see its public credentials.
  - Names stay readable and compact, but carry project, role and purpose.
  - AgentMBX speaks the same language as CLEO.
  - Roles are a prescribed set of types, not free text.
  - Contacts use a hybrid: the owner inbox, policies, named agents, and pre-approved contributors.
  - Plan the cloud with Better Auth (including agent-auth) while AgentMBX stays provider-agnostic.

## 0. The kernel is a protocol (council verdict, adopted by Keaton 2026-09-26)

Council run: `.cleo/council-runs/20260926T203615Z-bd8c2ac3/verdict.md`.

The portfolio (SignalDock, CLEO conduit, AgentMBX, CLEO Nexus) never had a protocol, only implementations, and they drifted apart. So the **kernel is a versioned wire protocol**, the *AgentMBX Protocol*. AgentMBX is its reference implementation, packaged in layers:

| Layer | Contents | Consumers |
|---|---|---|
| **protocol + verify library** | key-derived immutable ids; the signed envelope; owner-signed records (policy, grant, role, device, contact, revocation) with a freshness bound; delivery semantics (§0.1). Pure functions, no I/O (`envelope`, `crypto`, `policy`, `owner`). | anything that must verify authority offline: CLEO, the relay, third parties (a public A2A extension later, once immutable ids and freshness are in the signed bytes) |
| **core library** (package `exports`) | store and delivery state machine, routing, identity, wake brake | the daemon, CLEO's `MbxTransport`, tests |
| **transports** | LAN (paired hosts, now), relay (v0.5, untrusted), `MbxTransport` for CLEO conduit | |
| **adapters** | MCP server, CLI, hooks, per-CLI wake adapters (Claude, Codex, OpenCode, Kimi terminal and web) | agent CLIs; the node core never imports a specific CLI |

**Where each project lands:**
- **CLEO conduit stays the application layer, above the kernel.** It keeps topics (`epic-<T>.wave-<n>`), conversations and orchestration. `MbxTransport` implements CLEO's `Transport` (push/poll/ack) and replaces its HTTP transport to `api.signaldock.io`. The kernel gets no topic primitive unless the conformance test shows conduit needs cross-host topics.
- **SignalDock: under review (Keaton, 2026-09-26).** The security freeze stands now: rotate the committed keys and close unauthenticated registration. Whether its Rust backend and web UI become the **AgentMBX Cloud** (the untrusted relay + owner web app) rather than being retired is decided after the salvage audit (docs/research/SIGNALDOCK-SALVAGE.md). The council's objection was to its trust model (server-held authority, bearer keys), not its code or product.
- **CLEO Nexus** is the account plane only (Better Auth). It is never consulted for authority.

### 0.1 Delivery semantics (identical on LAN and relay)
- Message ids are ULIDs. Delivery is at-least-once, with explicit ack and a dead-letter after bounded retries (72 h today).
- Dedupe keys on a **persistent per-sender sequence high-water mark** that survives restarts and outlives the relay's longest retention. A duplicate wakes an agent, so a time-window id cache is not enough.

### 0.2 Per-session attribution (prerequisite for CLEO orchestration traffic)
Today envelopes are signed per *host*, and agent names are labels (SPEC.md "Envelope"). So a second process on the same host can send as another agent's name, and the message still verifies. Owner-authority messages are already safe (they need the session key).

Required fix:
- Every MCP session signs every envelope with its in-memory session key (`session_sig`, which already exists for grants), bound to the agent's immutable id.
- A receiver shows a sender as `attributed` only when that signature verifies, and as `unattributed (name only)` otherwise; that covers CLI `--as` senders.
- CLEO orchestration directives (wave complete, reassign) move onto the kernel only after this ships and is tested.

### 0.3 Orchestration-scale authority
One Touch ID tap per worker doesn't scale to N workers:
- An orchestrator session receives an owner **grant with a delegation budget**: it may issue sub-grants to sessions it spawns, narrower and shorter than its own, audited, and revoked with it.
- Headless or CI machines use a device-held owner-delegated key (a device record plus a scoped policy), never the owner key itself.
- Both are v0.4 design items; nothing ships before per-session attribution.

## 1. Four planes, one rule

| Plane | What it answers | Who is the authority |
|---|---|---|
| **Identity** | who is this agent, whose, on which device, doing what | keys: host key signs the card; owner key signs roles, devices, contacts |
| **Authority** | what may this agent do for that sender | owner-signed records (policy, role grant, contact grant), verified by the *receiving* daemon |
| **Transport** | how bytes get there | LAN (paired hosts) today; cloud relay later. Transport is never an authority |
| **Account** | who may use the cloud relay, quotas, billing, device enrollment | Better Auth (cloud only); never consulted for authority |

**The rule:** the cloud, CLEO or a provider may *describe* an agent. Only the owner's key decides what it may *do*. This is how the relay stays untrusted, and why self-hosted, LAN-only use needs no account at all.

## 2. Shared vocabulary (AgentMBX = CLEO = Nexus)

| Term | Meaning | CLEO | Better Auth agent-auth | A2A |
|---|---|---|---|---|
| **owner** | a human, identified by an owner key (Ed25519) | `ownerPubkeys` entry (same key, ideally) | `user` (the account links the key) | `provider` (label only) |
| **device** | an owner's machine; on the wire, its **host** key | none yet (CLEO will add device + session to its registry) | `host` | — |
| **agent** | a stable mailbox identity on one device: immutable id + renameable handle | registry `agent_id` slug | (closest: none; see session) | card subject |
| **session** | one live CLI incarnation of an agent (pid + start time today) | `ses_…`, runtime `agt_…` | `agent` (per session, short JWT) | task context |
| **project** | an opaque project id, plus a display label | `.cleo/project-id` (portable UUID) | capability args | — |
| **card** | the agent's descriptive record, host-signed | registry row (maps 1:1, see §6) | agent metadata | Agent Card |
| **role** | a prescribed type on two axes (§4) | ADR-083 rank + `AGENT_TYPES` | — | skill tags / extension |
| **capability** | an *action class*: read, edit, outward, permissions | service grants | capability grant | — |
| **skill** | what an agent is good at (free, descriptive) | `.cant` skills | — | `skills[]` |
| **policy / grant** | owner-signed authority | owner override / grants | capability grant (server-held) | out of scope |
| **contact** | another owner, pinned by key | — | — | — |

"User" never appears in the protocol. It only exists in the cloud account plane.

## 3. Identifiers and names

Every agent has three layers:

| Layer | Example | Properties |
|---|---|---|
| **Id**: immutable, what signatures and grants bind to | `agt:8eb4…3480/b81a…b348/01JC…` (owner key id / host key id / ULID) | never reused, survives renames |
| **Handle**: readable, what people and agents type | `api-dev` | compact default = project folder (as built); `-cli`/`-2` on collision; renameable |
| **Card**: what it is | role, project, purpose, skills, cli, device, owner | signed, versioned, expires |

**Addresses:**

| Whose | Address | Notes |
|---|---|---|
| mine, this device | `api-dev` | |
| mine, another device | `api-dev@desktop` | devices are enrolled by `owner add-device` |
| someone else's | `alice/api-dev@desktop` | `alice` is my petname for a *contact key*; the key, not the petname, is the identity |
| by role/project | `fn:reviewer`, `rank:lead`, `project:agentmbx`, combined `fn:reviewer+project:agentmbx` | selectors never fan out to other owners unless a contact grant allows it |

Why not put role and purpose in the name, as `codex-agentmbx-review` would: names that change with the task break every reference to them. The *card* carries role and purpose, and `mbx_agents` shows them. Agents choose recipients by card fields (§4 selectors), not by parsing names. So a listing reads like this:

```
api-dev@desktop        dev · lead   project agentmbx   codex    "owns the HTTP layer"          live
reviewer@macbook       reviewer     project agentmbx   claude   "adversarial review"            live
alice/frontdesk@studio frontdesk    (hidden)           kimi     "Alice's intake agent"          contact
```

## 4. Roles: prescribed, two axes, declared vs attested

AgentMBX is a messaging layer, not a guardrail system. Roles do exactly two jobs:
- **finding** the right agent;
- being a **label that policies can reference**.

What an agent may *do* stays in policies plus each CLI's permission system. Roles alone never grant anything.

**Two orthogonal axes:**
- The **rank** axis matches CLEO ADR-083.
- The **function** axis matches CLEO `AGENT_TYPES` and SignalDock's `AgentClass`, trimmed.

| Axis | Values | Use |
|---|---|---|
| **rank** (who coordinates whom) | `orchestrator`, `lead`, `worker` | escalation and fan-out: workers report to `rank:lead`; CLEO-spawned agents set it from `CLEO_AGENT_ROLE` |
| **function** (what it does) | `dev`, `reviewer`, `tester`, `researcher`, `architect`, `docs`, `security`, `devops`, `assistant`, `frontdesk`, `custodian`, `custom` | `fn:reviewer` for review requests; `frontdesk` = the agent contacts may reach first; `custodian` = holds data or state for others (like fedora-custodian) |

The lists are fixed. `custom` plus free-text skills covers everything else. SignalDock's 13 drifting classes showed that a big, loose enum decays.

**Provenance tiers:**

| Tier | Set by | Trusted for |
|---|---|---|
| **declared** | the agent (`mbx_whoami role=…`) | routing between *my own* agents only |
| **attested** | an owner-signed `role` record (Touch ID), bound to the agent *id* and optionally a project | policy references (`from: fn:reviewer`), anything cross-owner, CLEO orchestration |

At scale (hundreds of agents, several devices, several owners) only attested roles route across owners. That way nobody can claim `reviewer` and capture review work. Roles are **scoped**: an attestation says "reviewer for project agentmbx", not "reviewer everywhere".

## 5. Contacts: the hybrid you asked for

A contact is another owner's key, exchanged with a signed **contact card**, as a short code, a QR or a link, and verified with a safety number (AGENT-CARD §5).

What a contact's agents can reach is a stack of owner-signed grants, from least to most:

| Tier | What their agents reach | How it's granted |
|---|---|---|
| 0. **new contact** | your `owner` inbox + your `fn:frontdesk` agent (if you have one) | adding the contact |
| 1. **named agents** | specific agents or selectors (`fn:reviewer+project:x`) | a contact grant, per agent or selector (Touch ID) |
| 2. **pre-approved contributor** | tier 1, plus a standing policy (e.g. `collaborate` for `project:x`) | a contact policy with a TTL |
| 3. **member** | acts like your own agents within a team or project scope | a `member` record (POLICY.md §7), later a Better Auth org team |

Policies already carry the `from` scope. `from.principals` (contacts) is the one missing field. Everything above tier 0 is time-boxed and revocable with the same kill switch. Intent stays hidden cross-owner by default (decided).

## 6. The card (unchanged from AGENT-CARD.md, plus the CLEO mapping)

- Host-signed.
- Every field is labelled `self`, `host` or `owner`.
- 2 KB cap, sequence number, 24 h expiry.
- The directory is signed. This closes today's confirmed gap, where the `/v1/agents` response isn't signed (§10.1).
- Additions from CLEO:
  - `cleo.agent_id` (+ `registry_uuid`), labelled `host`.
  - `project` = CLEO's portable project id when `.cleo/project-id` exists, otherwise a locally minted opaque id. The display label is separate. This answers path vs id: **id**.
  - `cant_sha256` when spawned from a `.cant` definition (provenance of instructions).
  - `rank` and `function` as in §4.
- One owner key everywhere: the key in CLEO's `ownerPubkeys` should be the AgentMBX owner key. This needs a CLEO change (on cleocode's list).

## 7. Cloud (v0.5+): Better Auth for accounts, never for authority

| Piece | Choice |
|---|---|
| **Accounts** | Better Auth: passkey or email login, device-code CLI login (`agentmbx cloud login`, like Nexus), `organization()` for teams later |
| **Device enrollment on the relay** | Agent Auth *conventions*: host key as JWK with an RFC 7638 thumbprint id, short `host+jwt` for relay calls, state names and the three lifetime clocks. No runtime dependency while the plugin is unstable. |
| **Relay grants** | transport only (post and fetch mailboxes, quotas). Never read, edit, outward or permissions. Those stay owner-signed and are checked by the receiver. |
| **Directory** | owners opt in to publishing *contact cards* (trimmed), never agent intent or projects |
| **Provider-agnostic** | nothing depends on Claude, Codex, Kimi, etc.: cards describe the CLI, grants bind to keys |
| **Correlation** | per-audience host keys (HKDF) for cross-owner traffic, so contacts can't link your devices |

**Shared or separate cloud with CLEO Nexus:** one Better Auth deployment would give one login for both. The alternative is agentmbx.com standing alone, which keeps BUSL and hosting simple. That's an owner decision (§9).

**CLEO conduit:** decided (§0). Conduit stays above the kernel; `MbxTransport` replaces its SignalDock HTTP transport, as the LAN link now and the relay later.

## 8. Phasing

| Release | Scope | Hard prerequisites |
|---|---|---|
| **v0.4 kernel + local identity** | protocol spec v1 (§0); the verify library and core library as package `exports`; immutable agent ids; per-session envelope signing (§0.2); signed cards and signed directory (legacy unsigned rows are ineligible for selectors); rank and function fields with `fn:`, `rank:` and `project:` selectors; attested role records; orchestrator delegation grants (§0.3); CLEO pre-fill; `MbxTransport` for CLEO conduit behind the conformance test | nothing ships on `(name, host)` keying |
| **v0.5 contacts + relay** | contact cards and safety numbers; tiers 0–2; the untrusted relay with Better Auth accounts and host enrollment; per-audience keys | revocation-freshness bound (fail closed for privileged actions), signed directory, `enc` or an explicit "relay reads bodies" statement, persistent per-sender dedupe (§0.1) |
| **v0.6 teams** | members and org teams; CLEO's registry adopts key-derived ids and the shared owner key; SignalDock decommissioned after conduit cutover | conduit traffic proven over `MbxTransport` |

## 9. Owner decisions

1. Address syntax for other owners' agents (provisional: `alice/api-dev@desktop`).
2. Function list in §4: add or remove any?
3. Contact tier 0: owner inbox + frontdesk (proposed), or owner inbox only?
4. Cloud: shared Better Auth with CLEO Nexus, or a separate agentmbx.com?
5. ~~Should AgentMBX become CLEO conduit's remote transport?~~ **Decided: yes (§0).**
6. When does SignalDock shut down? After conduit cutover. It is live today (api.signaldock.io and api.clawmsgr.com both answer), so rotate its committed keys now.
