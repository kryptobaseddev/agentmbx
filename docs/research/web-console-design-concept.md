# AgentMBX Web Console — Design Concept

**A human-facing cockpit for supervising agent mailboxes.**
Modern, clean, agent-focused. Local-first: the daemon on each device is the source of truth; the
cloud relay syncs state and routes approvals. The console is a supervisor, not a chat client.

---

## 1. Vision and Design Principles

**1. Supervise, don't chat.** Humans use the console to answer three questions at a glance: *Are my
agents healthy? Is anything waiting for my approval? Is anything talking that shouldn't be?* Full
conversation bodies stay in the local CLI; the console works at the level of agents, threads, and
signals.

**2. Calm by default, loud on signal.** Neutral surfaces. Color is spent only on state
(green/amber/gray/red) and on the one thing that needs the human right now (the approvals queue).
If nothing needs a human, the overview should look boring.

**3. Human authority is explicit.** Every sensitive action — granting access, revoking a device,
taking over an agent, forwarding an offline agent's mail — is an explicit, owner-confirmed step in
the UI. Agents can *request*; only the human (or an owner-signed grant) can *approve*. Nothing in
the console lets an agent escalate itself.

**4. Local-first, cloud-synced.** Devices, agent mailboxes, and message bodies live on the local
daemon. The cloud relay carries metadata, presence, and signed approvals — never message bodies in
v1. If the cloud is unreachable, the local network keeps working; the console shows stale markers,
not errors.

**5. One vocabulary.** Every concept in the UI maps 1:1 to an existing AgentMBX primitive (identity
lease, policy class, doctor check, forward, takeover, prune, pairing, relay). No new nouns.

---

## 2. Information Architecture

Five top-level sections, plus a global command palette. Ordered by frequency of use:

| Nav item      | Purpose                                                        | Primary user question                    |
|---------------|----------------------------------------------------------------|------------------------------------------|
| **Overview**  | Health strip + agent status grid + needs-attention list        | "Is everything okay?"                    |
| **Approvals** | Inbox of pending grants and action approvals (badge count)     | "What needs my yes?"                     |
| **Agents**    | Searchable directory of agent mailboxes with state and actions | "What's this agent, and what do I do?"   |
| **Devices**   | Authenticated devices, pairing, revocation, per-device agents  | "Which machines are mine and trusted?"   |
| **Mail Flow** | Sanitized agent-to-agent lanes: issues, states, remediation    | "Who is talking to whom, and what's off?"|

Global: command palette (`⌘K`) for agent search and every action; an alert bell aggregating
approval requests and new issues; the owner's identity chip (name, key fingerprint) top-right.

---

## 3. Page Designs

### 3.1 Overview

**Health strip** (one row, four cells):
- **This device** — daemon version, uptime, owner key present (✓).
- **Relay** — connected / unreachable / not configured, with latency.
- **Paired devices** — `2 online · 1 offline` (Fedora box last seen 3h ago).
- **Attention** — red/amber aggregate: `1 approval · 2 agents offline · 1 stranded mailbox`.

**Agent status grid** — cards, not a table, because humans scan faces not rows:
```
┌─────────────────────────────┐
● api-dev        live   3 unread   [home-mac]
 role: backend · ~/projects/api
 holder: claude session 6ffd9f…  missed: 0
└─────────────────────────────┘
```
Each card: status dot + name + role + project + host + live state + unread + missed count (from
catch-up). Click → agent detail. A card shows **amber** when pending/idle/shared-quiet, **gray**
when offline, **red** when conflicted or revoked.

**Needs attention** list (max 5, then "view all →"):
- Approval requests awaiting the owner.
- Offline agents with their doctor-style reason (`no heartbeat 42m`, `process unconfirmed`).
- Stranded mail (unread with no live holder) — one line each with a **Forward** action.
- Pending identities (a session waiting on a name another session holds).

Empty state: "All agents are healthy. Nothing needs you." — genuinely blank below.

### 3.2 Devices

**Device list** (rows):
```
Home Mac        ● online    macbook   key dc4f-6c32…   v0.5.3   12 agents   [Revoke]
Work Laptop     ● online    macbook2  key 91aa-02fe…   v0.5.3    4 agents   [Revoke]
Fedora Box      ○ offline   fedora    key 77b1-9c00…   v0.5.2    7 agents   [Revoke] [Heal address]
```

Row content: human-given name, host name, host key fingerprint (short, mono, full on hover),
daemon version, agent count, last presence, status dot. Actions per row:
- **Revoke** — emergency: unpairs the device, marks its agents offline, requires owner confirmation
  (and shows the consequence list before confirming).
- **Heal address** — (T201) re-points a moved device using its last-seen address, with the signed
  presence evidence shown.
- **Pair a device** — top-right button: shows the pairing code + approve flow (the six-digit code
  both machines display; owner confirms equality).

**Device drawer** (click a row): agents on this device with live states, projects they're
associated with, per-CLI wiring status (MCP + hooks installed per the doctor checks), and a link to
the device's diagnostics snapshot (read-only, no bodies).

### 3.3 Agents

**Search-first directory.** A prominent search field filters by name, role, project path, host, and
state (`is:offline`, `role:reviewer`, `project:agentmbx`). Results as compact rows:

```
drum@macbook    kimi    live     ~/…/agentmbx    0 unread · missed 2    […]
old-scraper     codex   offline  ~/…/scraper     14 unread — stranded!  [Forward] [Remediate]
```

**Agent detail** (drawer or page):
- Header: name, role, host, live state with reason ("held by claude session …, heartbeat 40s ago").
- Stats: unread, missed (catch-up), open threads, last activity.
- Projects: associated git folders (and the normalized repo key when paired).
- Actions (owner-confirmed, with consequence previews):
  - **Forward mail** → pick a successor agent; moves unread + future mail (existing `identity forward`).
  - **Take over** → owner-signed, for a stuck holder (existing takeover flow).
  - **Release / Claim** → for a session the human is standing at.
  - **Rename**, **Retire (prune)** → for generated dead names, with the doctor's prune preview.
  - **View ledger** → the project ledger for this agent's projects (metadata only).

**Offline remediation flow** (the key multi-step UX):
1. Agent shows offline with reason (`dead`, `idle`, `no heartbeat`, `pending identity`).
2. Console offers context-appropriate fixes as a checklist: *Restart the agent's session* (show the
   exact CLI hint), *Resume its identity* (claim guidance), *Forward its mail to a successor* (pick
   from live agents in the same project), or *Retire it* if it's a generated name with no traffic.
3. Each fix shows its before/after (e.g., Forward: "14 unread messages → sent to `new-scraper`").

### 3.4 Approvals (Permissions & Multi-User Collaboration)

Two tabs: **Action approvals** and **People & grants**.

**Action approvals** — cards in a queue, newest first:
```
┌──────────────────────────────────────────────────────┐
│ codex-lint (work-laptop) wants: edit                  │
│ on: ~/projects/api · from: fedora agents · 6h expiry  │
│ Policy: collaborate [read, edit]                      │
│            [Approve]   [Approve with limits…]  [Deny] │
└──────────────────────────────────────────────────────┘
```
Each card names the requesting agent, device, requested class (`read` / `edit` / `outward`),
scope (project, source hosts), and expiry. Owner-signed on approve; denial records a reason that
the requesting agent sees.

**People & grants:**
- **People list**: everyone with access — the owner plus approved collaborators (name, email/passkey
  label, devices they can reach, grants held). Add by passkey/public key; revoke per person.
- **Grant builder** (the multi-user collaboration core): pick a person → pick devices (grouped by
  *context*: Home / Work / Custom tags) → pick agents or "all agents on these devices" → pick a
  policy class → scope (projects, source hosts) → expiry. Preview in plain English before signing:
  *"Maya can read and edit any agent on your Work devices, from her paired machines, for 30 days."*
- **Active grants table** with one-click revoke and an audit trail (who granted what, when, signed
  by which owner key).

Cross-system support: devices carry a **context tag** (`home`, `work`, `lab`) set at pairing time;
grants reference contexts, so "Maya: work devices" survives you adding a new work laptop.

### 3.5 Mail Flow (Agent-to-Agent Communication)

**Sanitized lanes.** One lane per thread (or per agent pair, collapsed), showing metadata only —
never bodies:

```
#agentmbx-release    api-dev ⇄ review-bot    12 msgs · last 2h ago
 kinds: request ×4, status ×8     trust: verified (paired hosts)
 state: 1 awaiting reply · all delivered            [Mute] [Revoke access] [View receipts]
```

Lane row content: thread subject, participants, message count by kind, trust label, delivery state
(all delivered / queued for offline peer / relay-depth suppressed), and flags (unverified sender,
external origin). **Expand** shows per-message metadata lines (timestamp, from→to, kind, delivery
state, did line) — still no bodies. Bodies remain local-CLI-only by design.

**Issues strip** above the lanes (filter chips): `Unverified sender`, `Suppressed by relay depth`,
`Unreachable peer`, `External origin`. Clicking a chip filters lanes to the problematic ones.

**Per-lane actions:**
- **Revoke access** — takes the conversation's agents' holder offline / releases a lease
  (owner-confirmed; named consequence).
- **Forward** — for lanes where one participant is offline: route its future + unread mail to a
  chosen successor agent.
- **Mark resolved** — human acknowledges an issue; it leaves the strip (audit-logged).

**Offline remediation here mirrors Agents**: an offline participant in a lane gets a "Remediate"
button right in the row, no navigation required.

---

## 4. Key Flows

1. **First run / pair a device.** Owner opens console → Devices → "Pair a device" → both machines
   show a 6-digit code → owner confirms they match → devices exchange host keys → device appears in
   the list with a context tag prompt ("Is this Home or Work?").
2. **Approve a collaborator.** People → "Add person" (passkey) → Grant builder → devices/agents/
   class/scope/expiry → plain-English preview → owner signs → collaborator's devices see the grant
   on next sync.
3. **Approve an agent action.** Bell badge → Approvals → card describes exactly what's asked →
   Approve (signed) / Approve with limits (edit class/scope) / Deny with reason.
4. **Remediate an offline agent.** Overview or Mail Flow flags it → detail shows the reason and a
   checklist of fixes → pick Forward → choose successor → preview → confirm → console confirms
   "14 messages forwarded, new mail will follow `new-scraper`".
5. **Emergency revoke.** Devices (or agent card) → Revoke → consequence modal ("7 agents go offline,
   unread mail stays") → owner confirms → relay broadcasts revocation to all paired devices.
6. **Monitor agent chatter.** Mail Flow → scan lanes → an amber chip appears (`unverified sender`)
   → open lane → Revoke access or Mark resolved.

---

## 5. Design System (UI/UX Simplicity)

**Visual language.** Neutral, warm-gray surfaces (near-white `#FAFAF9` app bg, white cards, hairline
borders `#E7E5E4`). One accent color (indigo `#4F46E5`) used for primary actions and links only.
Status palette: green `#16A34A` live, amber `#D97706` pending/idle/attention, gray `#78716C`
offline, red `#DC2626` revoked/conflict/emergency. Dark mode: same palette, `#1C1917` base.

**Typography.** Inter (UI) + JetBrains Mono (IDs, fingerprints, versions, keys). Base 14px, titles
15–17px semibold; IDs never larger than 12px mono, always truncate-middle.

**Spacing & density.** 4px grid, 12px card padding, 16px section gaps. Favor breathing room over
information density — this is a supervisor's screen, not a log tail. Max content width 1200px,
centered.

**Core components.**
- `AgentCard` / `AgentRow`: dot, name, role, project, host, state, unread badge.
- `StatusPill`: dot + word ("live", "offline 3h", "pending"); never icon-only (accessibility).
- `DeviceRow`: name, fingerprint, version, agents, presence.
- `ApprovalCard`: who/what/scope/expiry + three explicit buttons.
- `LaneRow`: participants, counts by kind, trust label, state, flags.
- `EmptyState`: one sentence, no illustration clutter.
- `ConfirmModal`: used for every destructive/authority action; states consequences as a list.

**Motion.** 150ms fade for drawers, 200ms for modals; no parallax, no decorative animation. Status
dots pulse softly only while a long-running action (pairing, forwarding) is in flight.

**Accessibility.** WCAG 2.1 AA: 4.5:1 text contrast (status pairs verified in both themes), visible
focus rings, full keyboard navigation (`⌘K` palette, `j/k` row movement, `?` shortcut sheet),
screen-reader labels on every status dot ("api-dev, live, three unread messages").

---

## 6. Cloud Backend

### 6.1 Architecture

```
┌────────────┐   WSS (presence, metadata, approvals)   ┌───────────────────┐
│ Device A   │◄─────────────────────────────────────►│  Cloud Relay       │
│ (daemon =  │   envelopes: agent↔agent (E2E bodies)   │  + Console API     │
│  truth)    │◄─────────────────────────────────────►│  (control plane)   │
└────────────┘                                        └─────────▲─────────┘
┌────────────┐                                                  │ WSS / REST
│ Device B   │◄───────────────────────────────────────────────┘
│ (daemon)   │                                     ┌────────────┴───────┐
└────────────┘                                     │  Web Console (SPA) │
                                                   └────────────────────┘
```

- **Local daemon** (exists): source of truth — identities, mailboxes, bodies, leases, receipts.
- **Cloud relay** (planned): rendezvous + envelope routing + presence. Extended with two console
  channels: a **metadata sync** channel (daemon → cloud) and an **approvals** channel
  (cloud → daemon, owner-signed commands).
- **Console API** (new, small): per-owner read model (devices, agents, lanes, grants, approvals),
  auth, and audit. Holds no message bodies.

### 6.2 Sync model (v1: metadata only)

- **Up (daemon → cloud, every ~15s or on change):** device heartbeat (version, presence); per-agent
  state (name, role, project, live state, unread/missed counts); lane summaries (thread id,
  participants, kind counts, delivery states); issue flags; approval *requests*. Bodies never sync.
- **Down (cloud → daemon):** owner-signed approvals and grants; revocation orders; forward/takeover
  commands — each signed by the owner key, applied idempotently by the daemon, receipted back.
- **Consistency:** per-device version counter; last-writer-wins for state views; append-only audit
  log; idempotency keys on every command. Offline devices catch up from the relay's durable store
  (bounded retention, e.g. 7 days) — matching the relay-storage direction in the roadmap.
- **AuthN/Z:** owner enrolls the console with the local owner key (signs a console certificate);
  console sessions authenticate with passkeys; every write the console makes is signed and verified
  by the daemon against the owner key before application. Collaborators authenticate via their
  paired grants — they see only granted devices/agents and can only approve within their grant
  (everything else is request-only).

### 6.3 Data model (console API)

```
users(id, display_name, passkey_pub, created_at)
devices(id, owner_id, host_name, context, host_key_fp, daemon_version, last_presence, status)
agents(device_id, name, role, project, repo_key, state, state_reason, unread, missed, holder_cli, updated_at)
threads(id, device_id, subject_hash, participants[], kind_counts, trust, state, flags[], updated_at)
grants(id, owner_id, grantee_user_id, devices[]|contexts[], agents[]|all, class, scope, expires_at, signature, revoked_at)
approvals(id, requester, device_id, agent, requested_class, scope, expires_at, status, decided_by, signature, audit_id)
audit(id, owner_id, actor, action, target, at, signature)   -- append-only
```

Subjects are stored hashed by default (display only via daemon round-trip when the owner opens a
lane locally); counts and states are plaintext metadata.

### 6.4 Failure behavior

- Daemon offline → console marks its agents "stale · last seen HH:MM", approvals queue, commands
  pending; relay retries; everything reconciles on reconnect.
- Relay unreachable → local network unaffected (LAN paths in the daemon are untouched); console
  shows a relay banner; reads fall back to last synced snapshot, clearly labeled stale.
- Compromised relay → worst case is metadata disclosure (who talks to whom, when) and denial of
  service; bodies and approvals remain unforgeable (end-to-end signed; owner key never leaves the
  owner's devices).

### 6.5 API sketch (REST + WSS)

```
GET  /v1/overview                       → health strip + attention list
GET  /v1/agents?q=&state=&role=         → directory (paged)
GET  /v1/agents/{name}                  → detail
POST /v1/agents/{name}/forward          → { to }  (owner-signed)
POST /v1/agents/{name}/takeover         → { approval } (owner-signed)
GET  /v1/devices                        → list
POST /v1/devices/{id}/revoke            → (owner-signed)
POST /v1/devices/pair                   → begin pairing (code exchange)
POST /v1/grants                         → create grant (owner-signed)
DELETE /v1/grants/{id}                  → revoke
GET  /v1/approvals?status=pending       → queue
POST /v1/approvals/{id}:decide          → { approve|deny, limits?, reason }
GET  /v1/threads?flag=&participant=     → lanes (metadata only)
POST /v1/threads/{id}:remediate         → forward/mute/resolve
WSS  /v1/stream                         → per-owner live events (presence, approvals, issues)
```

All mutating endpoints verify the owner signature (or the collaborator's grant scope) and return an
accepted receipt; the daemon is the executor of record.

---

## 7. Prototype Scope (MVP Cut)

**In:** Overview (health strip, agent grid, attention list) · Agents directory with search +
offline remediation (forward flow) · Devices list with pair/revoke · Approvals queue (decide) ·
Mail Flow lanes with issue chips and mute/resolve · Grant builder (read/edit classes, contexts,
expiry) · Dark mode · `⌘K`.

**Out (post-MVP):** message-body reveal via local bridge, project ledger views, hosted-conversation
linking UI (bind tickets), prune/retire automation suggestions, per-lane rate analytics, mobile
app (responsive web first).

**Backend for the prototype:** real daemon talking to the relay for sync and approvals; a thin
in-memory console API is acceptable for the first frontend iteration, with the contract above as
the target.

---

## 8. Alignment with AgentMBX Primitives

| Console concept        | Existing primitive (shipped or specified)                        |
|------------------------|-------------------------------------------------------------------|
| Agent card state       | Identity leases + `mailboxLiveness` + doctor's stranded lines     |
| Missed counter         | `catchup:<name>` checkpoint + `mbx_catchup` (v0.5.3)              |
| Forward / remediate    | `identity forward`, doctor remediation guidance                   |
| Take over              | Owner-signed identity takeover                                    |
| Prune / retire         | `identity prune` candidates                                       |
| Approvals & grants     | Owner-signed policy records (classes read/edit/outward, expiry)   |
| Devices & pairing      | Host keys, pairing codes, peer presence/address healing           |
| Lane metadata          | Envelope meta (kinds, trust, relay depth), T207 delivery states   |
| Relay                  | Cloud relay: rendezvous, presence, durable queue (roadmap T146)   |
| No bodies in cloud     | Existing LAN/relay split; E2E signed envelopes                    |
| Pending identities     | Unbound-session flow (T204) + doctor pending-identity line        |

This table is the contract: the console introduces **no new authority** — it is a supervised window
over mechanisms the daemon already enforces.
