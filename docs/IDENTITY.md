# Identity, roles, contacts and the cloud

Status: proposal for owner decision. CLEO T059, for v0.4–v0.6.

Reconciled with the shipped code on 2026-10-10 (T500). Every address, selector and field below is either **built**
(with a `file:line` in `src/`) or **planned** (with a task id). §3.1 is the selector reference; §3.2 and §3.3 record the
owner decisions of 2026-10-09 (role personas, the project mailbox, the CLEO project key); the ADR is
`docs/adr/adr-037-project-mailbox-role-personas.md`. Where a table cell says *planned*, the sentence around it
describes the design, not what runs today.

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
| **Id**: immutable, what signatures and grants bind to | `agt:8eb4…3480/b81a…b348/01JC…` (owner key id / host key id / ULID) | never reused, survives renames. **Planned (T066).** Today the mailbox name is the key and a rename is an alias (`resolveAlias`, `src/node.ts:347`) |
| **Handle**: readable, what people and agents type | `agentmbx-reviewer` | chosen, never derived from the folder or the CLI (§3.2); 2–40 characters of `a-z0-9-` (`NAME_RE`, `src/envelope.ts:14`); renameable with `mbx_whoami name=…` (`src/mcp.ts:1333`). **Built** |
| **Card**: what it is | role, project, purpose, skills, cli, device, owner | signed, versioned, expires. **Planned (T059, T068).** Today `mbx_agents` returns name, host, role, CLI, description and last-seen (`src/mcp.ts:1568`; the directory behind `/v1/agents`, `src/http.ts:499`, is unsigned) |

**Addresses:**

| Whose | Address | Status | Notes |
|---|---|---|---|
| mine, this device | `agentmbx-reviewer` | built | `src/node.ts:598-625` |
| mine, another device | `agentmbx-reviewer@desktop` | built | the host must be paired; `owner add-device` certifies a paired machine as yours (`src/cli.ts:128`, `:1179`) |
| someone else's | `alice/api-dev@desktop` | planned (T171; design T037) | `alice` is my petname for a *contact key*; the key, not the petname, is the identity |
| by role, project or task | `role:reviewer`, `lead`, `task:<id>`, `fn:reviewer+project:agentmbx` | per selector, see §3.1 | selectors never fan out to other owners unless a contact grant allows it (planned with contacts, T171) |

Why not put role and purpose in the name, as `codex-agentmbx-review` would: names that change with the task break every reference to them. The *card* carries role and purpose, and `mbx_agents` shows them. Agents choose recipients by card fields (§4 selectors), not by parsing names. So a listing will read like this. **Planned:** the live roster with harness, project and lead badge is T496, and rank and function are T069. Today `mbx_agents` prints `name@host  role:<role>  (<cli>)  last seen …  — description` (`src/mcp.ts:1568-1580`).

```
api-dev@desktop        dev · lead   project agentmbx   codex    "owns the HTTP layer"          live
reviewer@macbook       reviewer     project agentmbx   claude   "adversarial review"            live
alice/frontdesk@studio frontdesk    (hidden)           kimi     "Alice's intake agent"          contact
```

### 3.1 Selector reference

What `to` accepts in `mbx_send` (`src/mcp.ts:1433`) and `agentmbx send --to` (`src/cli.ts:68`). Local routing is `MbxNode.route` (`src/node.ts:570-628`); `lead` and `role:lead` are resolved before the envelope is signed (`src/node.ts:683`).

| Selector | Reaches | Status | Where |
|---|---|---|---|
| `name` | the mailbox on this host. If this host has none, the unique paired host that has it; otherwise this host's inbox, with an "is not a known agent" warning | **built** | `src/node.ts:598-625` |
| `name@host` | the mailbox on a paired host, or on this host | **built** | `src/node.ts:588-597` |
| `role:<role>` | every *live* session on this host whose registered role equals `<role>`, plus every approved paired host (each matches its own agents). A role with no live holder receives nothing | **built** | `src/node.ts:581-586` |
| `*` | every live session on this host and every approved paired host | **built** | `src/node.ts:576-580` |
| `owner` | the owner inbox on this host | **built** | `src/node.ts:587` |
| `lead`, `role:lead` | the owner-designated lead of the sender's project (`agentmbx lead set`), rewritten to its `agent[@host]` before signing. `NO_PROJECT` or `NO_LEAD` when there is none. With no live holder the send is `queued-no-holder` and the owner is notified (T491). This is **not** the generic `role:<role>` match above, and an agent whose registered role is `lead` is not this address (T393) | **built** | `src/lead-record.ts:105`, `:116-132`; `src/receipts.ts:70-76` |
| bare project name (`agentmbx`) | planned: the project mailbox, read by the live lead (§3.3). Today it is an ordinary mailbox name | **planned** T493 (migration T494, draining T495) | |
| `task:<id>` | planned: every live persona working on that CLEO task, one receipt per recipient | **planned** T497 | |
| `fn:<function>`, `rank:<rank>`, `project:<id>`, and `+` combinations | planned: attested role axes (§4). Nothing in `src/` parses these tokens | **planned** T069 | |
| `<contact>/name@host` | planned: another owner's agent, through a contact grant (§5) | **planned** T171 (design T037) | |

Two things look like selectors and are not addresses. An owner-authority message to `*` or `role:<role>` additionally needs the `broadcast` capability (`src/envelope.ts:252`). A policy's `from` list accepts `principal:<fp>` for an owner key (`agentmbx policy set --from … principal:<fp>`, `src/cli.ts:134`, `src/policy.ts:275-285`): that names who may act, not where mail goes.

### 3.2 Role personas: the naming rule

Owner decision of 2026-10-09: "the agent inbox name is more than just the project and definitely not the cli".

1. **A mailbox is a role persona on a project: `<project>-<role>`.** Examples: `agentmbx-lead`, `agentmbx-builder`, `agentmbx-reviewer`. It must also satisfy `NAME_RE`. The role is the registered label (`ROLE_RE`, `src/registry.ts:15`), a short word, never a sentence.
2. **Harness-agnostic.** The persona belongs to the role, not to the program running it. Claude, Codex, Kimi, OpenCode, Grok or Hermes can claim the same persona in turn, one at a time, and it keeps its mail, role and project history. The CLI is an attribute of the current holder (`mbx_agents` prints it), never part of the name. The cross-harness claim test is T492 AC3.
3. **Never derived.** AgentMBX does not make up a name from the folder or from the CLI (`src/registry.ts:1-5`). A session with no identity is unbound and chooses: claim an existing persona of its project, or register `<project>-<role>` (`mbx_identity`, `src/mcp.ts:1295`). The one launch-time source of a name is `MBX_AGENT`, set by the owner (`agentName` is called only then, `src/mcp.ts:514`). **Built.**
4. **Not project-only and not CLI-named.** `<project>` alone is reserved for the project mailbox (§3.3). `<project>-<cli>`, which the council had recommended, was superseded by the owner. Refusing the bare project name and newly generated names that end in a CLI pattern, on both register and claim, is **planned** (T492). Existing mailboxes with those names stay readable and claimable.
5. **The role label is one free label today.** It is set by `mbx_identity register`/`mbx_whoami role=…` and matched by `role:<role>`. The two-axis model in §4 replaces it with `rank` and `function` (**planned**, T069).

### 3.3 The project mailbox and the project key

Owner decisions of 2026-10-09, recorded in `docs/adr/adr-037-project-mailbox-role-personas.md` with the rejected options (lead-as-inbox, `role:lead` only, a copied root inbox, `<project>-<cli>` names, the folder basename as key).

- **Project mailbox.** Mail to the bare `<project>` is stored once in a mailbox owned by the project, not by any persona. The owner-designated lead reads it while it holds a live lease; it shows as a labelled section of its inbox and one ack clears it. A new lead sees unread mail with no forward. A session that is not the lead sees neither bodies nor counts (T308 AC2). **Planned** T493. What already ships is the escalation half: a send to `lead`/`role:lead` with no live holder is `queued-no-holder` (T491, `src/receipts.ts:70-76`), and the bare name joins it in T493.
- **Project key = the CLEO project id.** The key is the id in `.cleo/project-id`, a write-once UUID committed to the repository, the same on every checkout, clone and device. The folder basename is a display alias. When a folder has no CLEO project, the key falls back to the folder path (T493). The mailbox follows a folder rename (**planned**, T493 AC5).
- **What is keyed how today (T543, built).** One helper, `resolveProject` (`src/project-key.ts:134`), decides it. The local key is the CLEO id (`.cleo/project-id`, else the `id` of `.cleo/project.json`, searched upward from the session folder, stopping before `$HOME` and at a repository boundary, `findCleoId`, `src/project-key.ts:91`) and otherwise the folder path. It keys `identity_projects` and `project_leads` through an additive nullable `project_key` column (`src/store.ts:147`), written when a binding or lead is stored (`noteProject`, `src/registry.ts:60`; `storeLead`, `src/lead-record.ts:47`) and backfilled when the store opens (`backfillProjectKeys`, `src/registry.ts:137`). Reads match the folder or the key (`projectIdentities`, `src/registry.ts:74`; `leadFor`, `src/lead-record.ts:75`), so every checkout of one CLEO project shares members and lead; the owner-signed lead record keeps the folder it was signed for and is never rewritten, and a row whose folder is gone stays path-keyed. The key that travels is the CLEO id, else the git origin, else none and never a path (`crossHostKey`, `src/project-key.ts:144`, stamped as `project_key`, `src/mcp.ts:1006`); the ledger still matches mail stamped with the git origin (`ledgerWhere`, `src/project-ledger.ts:42`), and `projectKey` keeps meaning the git origin, which the cloud read model accepts. A session's project folder is still its cwd realpath (`projectOf`, `src/registry.ts:27`). `agentmbx doctor` names the key and its source (`projectKeyChecks`, `src/doctor.ts:243`). T493 moves the project mailbox to the same helper.

## 4. Roles: prescribed, two axes, declared vs attested

**Status.** Today a mailbox has one role label (§3.2 rule 5). The rank and function axes, the `fn:`/`rank:`/`project:` selectors and owner-attested role records below are **planned** (T069). `CLEO_AGENT_ROLE` is not read anywhere in `src/` yet (T069).

AgentMBX is a messaging layer, not a guardrail system. Roles do exactly two jobs:
- **finding** the right agent;
- being a **label that policies can reference**.

What an agent may *do* stays in policies plus each CLI's permission system. Roles alone never grant anything.

**Two orthogonal axes:**
- The **rank** axis matches CLEO ADR-083.
- The **function** axis matches CLEO `AGENT_TYPES` and SignalDock's `AgentClass`, trimmed.

| Axis | Values | Use (**planned**, T069) |
|---|---|---|
| **rank** (who coordinates whom) | `orchestrator`, `lead`, `worker` | escalation and fan-out: workers report to `rank:lead`; CLEO-spawned agents set it from `CLEO_AGENT_ROLE` |
| **function** (what it does) | `dev`, `reviewer`, `tester`, `researcher`, `architect`, `docs`, `security`, `devops`, `assistant`, `frontdesk`, `custodian`, `custom` | `fn:reviewer` for review requests; `frontdesk` = the agent contacts may reach first; `custodian` = holds data or state for others (like fedora-custodian) |

The lists are fixed. `custom` plus free-text skills covers everything else. SignalDock's 13 drifting classes showed that a big, loose enum decays.

**Provenance tiers:**

| Tier | Set by | Trusted for |
|---|---|---|
| **declared** | the agent (`mbx_whoami role=…`, **built** for the single label, `src/mcp.ts:1333`; the axes are **planned**, T069) | routing between *my own* agents only |
| **attested** | an owner-signed `role` record (Touch ID), bound to the agent *id* and optionally a project (**planned**, T069, T066) | policy references (`from: fn:reviewer`), anything cross-owner, CLEO orchestration |

At scale (hundreds of agents, several devices, several owners) only attested roles route across owners. That way nobody can claim `reviewer` and capture review work. Roles are **scoped**: an attestation says "reviewer for project agentmbx", not "reviewer everywhere".

## 5. Contacts: the hybrid you asked for

**Status: planned (T171, design T037).** Nothing in this section is built except the `principal:<fp>` entry in a policy's `from` list (§3.1). A contact is another owner's key, exchanged with a signed **contact card**, as a short code, a QR or a link, and verified with a safety number (AGENT-CARD §5).

What a contact's agents can reach is a stack of owner-signed grants, from least to most:

| Tier | What their agents reach | How it's granted (all **planned**, T171) |
|---|---|---|
| 0. **new contact** | your `owner` inbox + your `fn:frontdesk` agent (if you have one) | adding the contact |
| 1. **named agents** | specific agents or selectors (`fn:reviewer+project:x`) | a contact grant, per agent or selector (Touch ID) |
| 2. **pre-approved contributor** | tier 1, plus a standing policy (e.g. `collaborate` for `project:x`) | a contact policy with a TTL |
| 3. **member** | acts like your own agents within a team or project scope | a `member` record (POLICY.md §7), later a Better Auth org team |

Policies already carry the `from` scope, and it already accepts `principal:<fp>` (`src/policy.ts:275-285`). A separate `from.principals` field and the contact cards themselves are the missing parts (T171). Everything above tier 0 is time-boxed and revocable with the same kill switch. Intent stays hidden cross-owner by default (decided).

## 6. The card (unchanged from AGENT-CARD.md, plus the CLEO mapping)

**Status: planned (T059, T068).** No signed card or signed directory ships yet.

- Host-signed.
- Every field is labelled `self`, `host` or `owner`.
- 2 KB cap, sequence number, 24 h expiry.
- The directory is signed (T068). This closes today's confirmed gap, where the `/v1/agents` response isn't signed (`src/http.ts:499`).
- Additions from CLEO:
  - `cleo.agent_id` (+ `registry_uuid`), labelled `host`.
  - `project` = CLEO's portable project id from `.cleo/project-id`. When a folder has no CLEO project it falls back to the folder path (decided 2026-10-09, §3.3; this replaces the earlier "locally minted opaque id"). The display label is separate. This answers path vs id: **id**.
  - `cant_sha256` when spawned from a `.cant` definition (provenance of instructions).
  - `rank` and `function` as in §4.
- One owner key everywhere: the key in CLEO's `ownerPubkeys` should be the AgentMBX owner key. This needs a CLEO change (on cleocode's list; no AgentMBX task).

## 7. Cloud (v0.5+): Better Auth for accounts, never for authority

| Piece | Choice |
|---|---|
| **Accounts** | Better Auth: passkey or email login, device-code CLI login (**built** as `agentmbx login`, RFC 8628, `src/cli.ts:97`; like Nexus), `organization()` for teams later |
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
| **v0.4 kernel + local identity** (T065–T070) | protocol spec v1 (§0); the verify library and core library as package `exports`; immutable agent ids; per-session envelope signing (§0.2); signed cards and signed directory (legacy unsigned rows are ineligible for selectors); rank and function fields with `fn:`, `rank:` and `project:` selectors; attested role records; orchestrator delegation grants (§0.3); CLEO pre-fill; `MbxTransport` for CLEO conduit behind the conformance test | nothing ships on `(name, host)` keying |
| **v0.5 contacts + relay** (contacts: T171, design T037) | contact cards and safety numbers; tiers 0–2; the untrusted relay with Better Auth accounts and host enrollment; per-audience keys | revocation-freshness bound (fail closed for privileged actions), signed directory, `enc` or an explicit "relay reads bodies" statement, persistent per-sender dedupe (§0.1) |
| **v0.6 teams** | members and org teams; CLEO's registry adopts key-derived ids and the shared owner key; SignalDock decommissioned after conduit cutover | conduit traffic proven over `MbxTransport` |

Where the items stand (2026-10-10). **Built:** project lead records and `lead`/`role:lead` (T208, T393), `queued-no-holder` with owner escalation (T491), membership by `identity_projects` only (T515), the `outward-reversible` class (T498, `docs/POLICY.md`), uncapped acting grants (T537), lead-carried grants for that class (T499, `docs/POLICY.md` "Lead-carried grants"; `read`/`edit` delegation and the lead-delegated policy line are T551). **Planned, pending:** immutable ids (T066), per-session envelope signing (T065; `session_sig` exists today only inside owner grants, `src/envelope.ts:35`), package split (T067), signed cards and directory (T068), role axes and `fn:`/`rank:`/`project:` (T069), delegation grants (T070), `MbxTransport` (T071), the project mailbox and role-persona rules (T492–T495), live roster (T496), `task:<id>` (T497), contacts (T171).

## 9. Owner decisions

1. Address syntax for other owners' agents (provisional: `alice/api-dev@desktop`).
2. Function list in §4: add or remove any?
3. Contact tier 0: owner inbox + frontdesk (proposed), or owner inbox only?
4. Cloud: shared Better Auth with CLEO Nexus, or a separate agentmbx.com?
5. ~~Should AgentMBX become CLEO conduit's remote transport?~~ **Decided: yes (§0).**
6. When does SignalDock shut down? After conduit cutover. It is live today (api.signaldock.io and api.clawmsgr.com both answer), so rotate its committed keys now.
7. ~~Should the bare project name be a lead alias, a copied root inbox, or `role:lead` only?~~ **Decided 2026-10-09: a project mailbox read by the live lead (§3.3, ADR-037).**
8. ~~Default session names?~~ **Decided 2026-10-09: no defaults. Mailboxes are harness-agnostic role personas `<project>-<role>`, never CLI-named and never project-only (§3.2).**
9. ~~Project key: folder basename or CLEO project id?~~ **Decided 2026-10-09: the CLEO project id; the basename is a display alias (§3.3).**
10. The key's fallback when a folder has no CLEO project is settled by T543: the folder path locally, and for the cross-host key the git origin, else none. Open: the project mailbox's own id format, which is T493's to settle on top of `resolveProject`.
