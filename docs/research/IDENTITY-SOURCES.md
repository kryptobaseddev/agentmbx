# Identity, roles and cloud: what the neighbouring systems do

Status: research, 2026-09-26. Nothing here is decided or built. Inputs: docs/AGENT-CARD.md (incl. §10 corrections), docs/POLICY.md §7, docs/SPEC.md, and read-only inspection of `~/projects/signaldock`, `~/projects/cleocode` (HEAD `6a9d753b4`), `~/projects/cleo-nexus`, plus Better Auth and Agent Auth Protocol docs fetched 2026-09-26.
Purpose: let AgentMBX use the same words as Keaton's other systems for agent, role, project, owner, device and permission, and plan the AgentMBX cloud (cross-LAN, cross-owner) without tying AgentMBX to one provider.

Paths below are relative to each repo root unless absolute.

## 1. SignalDock (predecessor, `~/projects/signaldock`)

A Rust/Axum backend plus a Next.js frontend, deployed on Railway at `api.signaldock.io` (earlier `api.clawmsgr.com`). It uses Postgres in production, SQLite locally, optional Redis for SSE fan-out, and S3 for attachments (`backend/railway.toml`). It is a hosted hub: all agents talk to one server.

**Identity.**
- `agents.id` is an internal UUID. `agents.agent_id` is a public slug chosen by the client and must be unique (`crates/signaldock-core/src/agent.rs` ~L130-180).
- The spec says slugs are lowercase plus hyphens, but the code does not check the format. It only rejects duplicates with 409 (`crates/signaldock-sdk/src/services/agent_service.rs:79`; `backend/docs/dev/specs/agent-identity.md`).
- Messages address agents by slug, while foreign keys use a mix of slug and UUID.
- Signup automatically creates a "personal agent" and sets it as `users.default_agent_id` (`backend/src/routes/auth.rs:105-150`).

**Taxonomies** (`crates/signaldock-core/src/agent.rs`):
- `AgentClass` has 13 values: personal_assistant, code_dev, research, orchestrator, security, devops, data, creative, support, testing, documentation, utility_bot, custom. `custom` is deprecated but is still the DB default.
- `CapabilityCategory`: communication, development, execution, analysis, coordination, devops.
- `SkillCategory`: language, framework, database, practice.
- `PrivacyTier`: public, discoverable, private.
- `AgentStatus`: online, offline, busy.
- User `role` is free text; the code uses user, admin and superadmin (`backend/src/routes/admin.rs:100,112,470`).
- The spec lists only 5 classes.

**Card.** `AgentCard` is the `Agent` record minus its secrets and owner fields. It includes endpoint, capabilities[], skills[], stats, status, isClaimed, lastSeen and paymentConfig (x402).
- Capabilities and skills are stored twice: as JSON on the agent row and in registry and junction tables. The registry is seeded with 19 capabilities and 36 skills (`crates/signaldock-storage/src/migrations/sqlite/0013_capability_skill_registry.sql`).
- `/.well-known/agent-card.json` returns a LAFS-schema card, not an A2A card.

**Registration and auth.**
- `POST /agents` requires no authentication. Anyone can register any unused slug and gets back `sk_live_<64 hex>`, stored as an unsalted SHA-256, plus a `connectionKit` (`backend/src/routes/agents.rs:29-78`; `agent_service.rs:42`).
- A human takes ownership through a claim code: the agent calls `POST /agents/{id}/claim-code`, then the human calls `POST /users/claim`. The code uses 8 characters derived from `subsec_nanos()`, which is not a CSPRNG (`agent_service.rs:289`).
- Agent requests use `X-Agent-Id` + `Bearer sk_live_…`. Users use an HS256 JWT with a 7-day lifetime and no refresh. User API keys are `sdp_live_…` (`backend/src/middleware/auth.rs`; `backend/src/routes/api_keys.rs`).
- There are no scopes on keys. An agent key can only be rotated or reset, not scoped or revoked. There is no request signing by agents; only outbound webhooks are HMAC-signed (`backend/docs/dev/specs/webhook-signing.md`).
- Orgs exist only as stubs (`organization`, `org_agent_keys`, `agents.organization_id`); the UI says "Organizations coming soon" (`frontend/src/components/settings/OrganizationsTab.tsx:19`).
- Agents have **no device, project or origin fields**.

**Routing.**
- Direct messages go to `toAgentId`. Conversations have a participants array; group sends fan out N rows that share a `group_id`.
- Mentions come from `metadata.mentions` or `@slug` in the text. `MessageMetadata` carries mentions, directives, tags and taskRefs (`backend/src/routes/messages.rs:33`).
- Delivery order is SSE > Webhook > poll (ADR-001, `backend/docs/dev/adr/`).

**What worked:** poll/SSE delivery with ack, a delivery-jobs/dead-letter pipeline with integration tests (`backend/tests/`), and real use by CLEO agents over `sk_live_` keys.

**What was over-engineered or broken:**
- Built but never wired: WebSocket, HTTP/2 and Redis transport adapters (`crates/signaldock-transport/src/adapters/`).
- Built but marginal: an x402 payments crate, a leaderboard and activity feed, an attachment-approval workflow, and a friend graph with no route to create connections.
- The schema is defined in three places that have drifted: sqlx migrations, Diesel migrations, and inline DDL in `backend/src/main.rs:150-452`.
- Spec and code disagree on the class list, claim-code length and default status.
- **Security:** live `sk_live_` keys are committed in `clawmsgr-signaldock-frontend-code_dev.json`. The untracked `agent-registry-report.json` holds plaintext passwords and keys. These need rotation, which is outside this task's read-only scope.

## 2. CLEO (`~/projects/cleocode`)

**Registry.** The global `cleo.db` holds 13 `agent_registry_*` tables, a rename of SignalDock's schema in "better-auth shape" (`packages/core/src/store/schema/cleo-global/agent-registry.ts`, header says T11622 / SG-AGENT-IDENTITY E4).
- The registry deliberately has no send/receive functions; messaging lives in conduit.
- `agent_registry_agents` keeps the SignalDock columns (`agent_id`, `class`, `privacy_tier`, `owner_id`, `api_key_encrypted`, `api_base_url` default `https://api.signaldock.io`, `transport_type`).
- It adds v3 columns: `tier`, `can_spawn`, `orch_level`, `reports_to`, `cant_path`, `cant_sha256`, `installed_from`.
- Enums: `AGENT_REGISTRY_USER_ROLES = ['user','admin']` and statuses `online|offline|busy|away` (L77-112).
- The user, org and session tables are empty, and no CLI path creates a user (cleo-nexus `docs/research/research-state-inventory.md`).

**IDs:**

| Kind | Format | Source |
|---|---|---|
| Runtime instance | `agt_{YYYYMMDDHHmmss}_{6hex}` | `packages/core/src/agents/registry.ts:35` |
| Spawned agent handle | `agent-<taskid>` | `packages/core/src/spawn/agent-identity.ts:54` |
| Session | `ses_{14digits}_{6hex}` | `packages/core/src/sessions/session-id.ts:23` |
| Persona | human slug from a `.cant` file | e.g. `cleo-subagent`, `project-dev-lead` (`packages/agents/`) |

**Role axes.** CLEO has several, and they are not fully consistent:
- **ADR-083** (`.cleo/adrs/ADR-083-cleo-persona-and-hierarchy-reconciliation.md` §2.2-2.3) locks **three roles, Orchestrator / Lead / Worker**, on an axis orthogonal to **four scopes, Saga / Epic / Task / Subtask**.
  - "Cleo" is a named persona (the root Orchestrator), not a role.
  - Orchestrators may nest to depth 3.
- Code enums:
  - `AgentSpawnCapability = 'orchestrator'|'lead'|'worker'` (`packages/contracts/src/agent-registry-v3.ts:49`)
  - `PeerKind` adds `'subagent'` (`packages/contracts/src/peer.ts:32`)
  - `SIGIL_ROLES` adds `specialist` and `validator` (`packages/core/src/store/schema/cleo-global/nexus.ts`)
  - `AGENT_TYPES = orchestrator, executor, researcher, architect, validator, documentor, custom` (`packages/contracts/src/facade.ts`, `agent-schema.ts`)
  - `AgentTier = project|global|packaged|fallback|universal` (resolution precedence, not rank)
- Inconsistencies:
  - `orch_level` means 0=worker in the schema comments but 0=orchestrator in `agent-registry-v3.ts` and `orchLevelToRole()` (`packages/core/src/orchestration/spawn.ts:499`).
  - ADR-083 writes Worker's spawn parameter as `role=leaf`, but the code uses `worker`.

**Projects.** There are three hashes in use:
- sha256(path)[:12] (`packages/core/src/nexus/hash.ts`)
- sha256(realpath)[:16] for worktrees (`packages/paths/src/worktree-paths.ts:59`)
- a canonical sha256(git root|name|remote)[:12] (`packages/paths/src/cleo-paths.ts:311`)

The new **portable project id** is a write-once UUID in the tracked `.cleo/project-id` (`packages/paths/src/portable-project-id.ts`, T12325; ADR-094 is cited but no file was found). The registry is `nexus_project_registry(project_id, project_hash, project_path, …)`.

**Owners and auth.**
- Each project has an Ed25519 key at `.cleo/keys/cleo-identity.json` that signs audit lines and severity attestations (`packages/core/src/identity/cleo-identity.ts`).
- `ownerPubkeys` in `.cleo/config.json` is an allowlist of owner keys.
- `--actor` is a free string.
- Agent `sk_live_` keys are encrypted with a machine-key KDF (ADR-037; `packages/core/src/crypto/credentials.ts`).
- Per-agent service grants allow/block/rate-limit/manual-approve (`cleo-global/services.ts:202`).
- `.cant` personas carry `permissions:` per domain (e.g. `tasks: read, write`).

**Orchestration.**
- `cleo orchestrate spawn` classifies each task to a persona and derives its role from `orch_level`. The isolation block always passes `role: 'worker'` (`spawn-prompt.ts:597`).
- It injects `CLEO_AGENT_ROLE`, `CLEO_AGENT_ID`, `CLEO_SESSION_ID` and `CLEO_PROJECT_HASH` (`packages/contracts/src/branch-lock.ts`).
- Messaging uses conduit (`.cleo/conduit.db`, with topics like `epic-<TID>.wave-<n>` per ADR-070). Transports are local, then SSE, then HTTP to `api.signaldock.io` (`packages/core/src/conduit/factory.ts`).
- A2A AgentCard exists only in `packages/lafs`.

## 3. CLEO Nexus cloud (`~/projects/cleo-nexus`)

Status: **planning only.** There is no code, schema or routes; there are docs and one static mockup (`README.md:14`). Work is tracked as saga T12320: Stage A CLI, Stage B cloud vault, Stage C concurrent writers (`docs/PLAN.md`).

**Planned auth.** Better Auth 1.7.x on Railway (`api.cleocode.dev`) with Neon Postgres, R2 and a Cloudflare Pages PWA (`docs/research/research-infra.md:81-106`). The plugins are:
- `deviceAuthorization` (RFC 8628 CLI login)
- `bearer()`
- `organization()`, with teams in Stage C
- `apiKey()` for "long-lived CLI/CI credentials", including org-owned keys
- passkey
- optionally `jwt()`

**No agent-auth plugin** is planned.

**Devices.** `device.json` in the CLEO home holds a UUIDv7 plus a name (`docs/proposal-v0.md:18`). Paths are device-local maps `(projectId, deviceId) → path`. Snapshot lineage is tracked per (project, device, generation).

**Agents.** Agents get no cloud credentials. The mockup says the device installation authenticates sync, and agents act through the local CLI with project-scoped permissions (`mockup/index.html`, Access & agents). The council floated "every agent is a replica with its own Ed25519 key" and deferred it (`docs/council/verdict.md:24,29`).

**Access roles** appear only as mockup copy: "Account owner", "Connected device", "Project collaborator" (Viewer/Editor). Stage C ops carry `deviceId` and `actorId` (`docs/research/research-sync-tech.md:114-128`).

**Other references.** There are no references to AgentMBX or A2A.

## 4. Better Auth agent-auth plugin and the Agent Auth Protocol

Sources: https://better-auth.com/docs/plugins/agent-auth.md (the page warns "not yet stable") and the Agent Auth Protocol v1.0-draft at https://agentauthprotocol.com/specification (§ numbers below refer to that draft).

**Principals** (§1.5-1.6, §2.7):
- A **host** is "the persistent identity of the client environment where agents run" (e.g. Claude Code on a laptop). It is an Ed25519 keypair (inline JWK or JWKS URL) with an optional linked `user_id` and `default_capabilities`.
- An **agent** is "a runtime AI actor scoped to a specific conversation, task, or session", registered under a host with its **own** Ed25519 key. Its private keys never leave the client (§4.1).
- A **client** (MCP server, CLI or SDK) holds the host identity and signs on the agent's behalf.
- Sub-agents share their parent's identity (§2.2).

**Modes** (§2.2):
- `delegated` (the default) acts for one user, and the user approves.
- `autonomous` has no user. It is granted by server policy, and when its host later links to a user it is "claimed": capabilities are revoked and history is attributed to the user (§2.10).

**Owner linkage** (§2.8-2.9):
- A host is established by dynamic registration (pending until approved) or by pre-registration in a dashboard.
- *Linking* binds a host to **at most one user**. A linked host may auto-approve delegated agents within its defaults.
- Unlinking revokes all delegated agents under it.

**Credentials** (§4.2-4.3, §4.6):
- Host JWT: `typ: host+jwt`, `iss` = RFC 7638 JWK thumbprint of the host key, with `aud`, `iat`, `exp` and `jti`.
- Agent JWT: `typ: agent+jwt`, `iss` = host thumbprint, `sub` = agent id (e.g. `agt_k7x9m2`), `aud` = the exact execute URL, and an optional `capabilities` array. It SHOULD expire within 60 s, and `jti` is used for replay detection.
- Optional proof-of-possession profiles are defined.

**Scopes** (§2.12-2.13, §3.3):
- *Capabilities* are named, described server actions with JSON-schema `input`.
- Each is granted per agent as an **agent capability grant** `{capability, status active|pending|denied, constraints, granted_by, expires_at}`.
- Constraints narrow the allowed inputs (exact values, or `max`/`min`/`in`/`not_in`). The server may narrow a grant but must never widen it without a new approval.
- Approval goes through RFC 8628 device authorization or CIBA (§7). The plugin can map approval strength per method (e.g. POST → webauthn).

**Lifecycle and revocation** (§2.3-2.6, §5.7-5.10, §8.5):
- Agent states: pending, active, expired, revoked, rejected, claimed.
- Three clocks: session TTL (idle), max lifetime (continuous use), absolute lifetime (after which the agent is revoked for good). Reactivation drops capabilities back to host defaults.
- Revocation can come from the agent itself, its host, the user or an admin.
- Revoking a host cascades to its agents, and deleting a user cascades to hosts.
- Endpoints `/agent/rotate-key` and `/host/rotate-key` exist.

**Discovery.** `/.well-known/agent-configuration` publishes the issuer, endpoints, `default_location`, modes and approval methods (§5.1). An MCP adapter and an OpenAPI adapter are included.

**Privacy.** One host key used across servers lets those servers correlate the host. Per-server keys derived with HKDF are the mitigation (§9.1).

**Related Better Auth plugins:**
- `organization()` has default roles `owner`, `admin` and `member`, plus custom roles via `createAccessControl`, invitations and teams (https://better-auth.com/docs/plugins/organization, "Roles").
- `apiKey()` keys can be user- or org-owned, with `permissions: Record<string,string[]>`, expiry, prefix and rate limits (https://better-auth.com/docs/plugins/api-key).

**Fit for an AgentMBX cloud.** The *vocabulary* matches closely:
- host = AgentMBX host daemon
- user = owner
- linking = the `device` record
- capability grant + constraints ≈ policy classes + project roots
- lifetime clocks ≈ grant/policy TTLs

The *trust model* does not match. Agent Auth makes the **server** the authority: it stores grants and verifies JWTs. AgentMBX makes **owner-signed records**, verified by each receiving daemon, the authority, and the relay is untrusted (POLICY.md §7, SPEC.md "Trust"). It could back the **account plane** (who may use the relay, device enrollment, billing, quotas), not the **authority plane**.

## 5. A2A additions (beyond AGENT-CARD.md §1)

AGENT-CARD.md already covers field mapping, signing, discovery and the JCS interop caveat. Two things are missing:
- A2A has **no owner, device or role concept**. `provider.organization` is a label, and roles can only be expressed as skill tags or extensions. So A2A cannot carry the vocabulary below except through an AgentMBX extension URI.
- CLEO already ships A2A card code in `packages/lafs` (`src/a2a/*`, `schemas/v1/agent-card.schema.json`). An `agentmbx card export --a2a` fixture could be cross-checked against that schema, but only after checking which A2A version it targets.

## 6. Comparison

| Concept | SignalDock | CLEO | CLEO Nexus (planned) | Better Auth agent-auth | A2A | AgentMBX today |
|---|---|---|---|---|---|---|
| Agent id | UUID PK + client-chosen unique slug `agent_id` | registry `agent_id` slug; runtime `agt_<ts>_<hex>`; spawn handle `agent-<task>` | none (agents act via device) | server-minted `agt_…`, own Ed25519 key | none (card `name`, URL) | `name@host`, `[a-z0-9-]{2,40}`, unique per live host; §10.2 proposes immutable `(owner_key_id, host_key_id, agent_id)` |
| Display name | `name` | `displayName` / persona slug | — | `name` (informational) | `name` | handle = display; card `description` |
| Role / kind | `AgentClass` 13 values (functional) | ADR-083 orchestrator/lead/worker (rank) + `AGENT_TYPES` (function) + `tier` (resolution) | mockup: account owner / device / collaborator | none (mode delegated/autonomous) | none (skill tags) | free-text `role` (`MBX_ROLE`), routing only; proposed owner-attested role record |
| Capabilities / skills | 19 caps / 36 skills registry + JSON | same catalogs (inherited) + `.cant` skills | — | server-defined capabilities with input schema | `skills[]` with tags | proposed `self.skills[]` (claim) |
| Project | none | portable UUID `.cleo/project-id`; several path hashes | synced `{projectId,name,remote}`; paths device-local | none (capability args) | none | `meta.project` label; policy `projects` = realpaths; §10.4: opaque local project id |
| Owner / human | `owner_id` via claim code; auto personal agent | `ownerPubkeys`, `--actor` string, empty users table | Better Auth user; orgs in Stage C | `user_id` on host (≤1) and agent | `provider` label | owner Ed25519 key = sole principal; `member`/`guest` records planned |
| Device / host | none | `CLEO_PROJECT_HASH`, worktree paths; no device id | `device.json` UUIDv7 + name, device-code login | **host**: keypair + optional user link | none | host Ed25519 key, paired; owner-signed `device` record planned |
| Credentials | `sk_live_` bearer (SHA-256), user JWT HS256 | encrypted `sk_live_`, project Ed25519 signing key | bearer session, device token, API keys | host JWT + agent JWT (EdDSA, ≤60 s, `jti`) | securitySchemes (OAuth etc.) | host-signed envelopes + hop sig; owner signature via Touch ID / tty |
| Permissions / scopes | none (admin role only) | service grants, `.cant` permissions, owner override | Viewer/Editor per project (concept) | capability grants + constraints, approval strength | out of scope | owner-signed policy: level + classes read/edit/outward/permissions, from/to, projects, TTL; grant caps |
| Discovery | public directory, privacy tier, `/.well-known/agent-card.json` (LAFS) | registry list, conduit topics | — | `/.well-known/agent-configuration`, directories | `/.well-known/agent-card.json` | mDNS (address only) + signed-hop `/v1/agents` (response unsigned today, §10.1) |
| Revocation | rotate/reset key only | key rotate, `is_active` | device revoke (concept) | agent/host revoke, cascade, 3 lifetime clocks | n/a | owner-signed revocation records; `peers remove`; kill switch `policy revoke --all` |

## 7. Proposals

### (a) Shared vocabulary

Canonical terms to use in AgentMBX docs, CLI and wire fields:
- **owner**: a human principal, identified by an owner key (Ed25519). In the cloud, a Better Auth *user* links the owner key the way a Git host links an SSH key. Never "user" in the protocol.
- **device**: a machine the owner has enrolled. "Device" is the owner-facing word (Nexus, Better Auth deviceAuthorization); "host" is the wire and key word (SPEC, Agent Auth). Keep both, with one rule: *a host is a device's AgentMBX key*.
- **agent**: a stable mailbox identity under one host, with an immutable id plus a renameable handle. It maps to CLEO's registry `agent_id` and to A2A's card subject.
- **session**: one live CLI incarnation of an agent. It maps to Agent Auth's "agent" (runtime actor, short-lived), CLEO's `ses_…` and instance `agt_…`. Grants bind to either agent or session, and say which (§10.2).
- **project**: an opaque id. Prefer CLEO's portable UUID (`.cleo/project-id`) when present, otherwise a locally assigned id. Paths stay device-local, which matches Nexus ADR-093.
- **card**: descriptive, host-signed; fields are labelled self/host/owner.
- **grant / policy**: owner-signed authority records.
- **contact**: another owner's key, pinned via invite.
- **capability**: reserve this word for *action classes* (read/edit/outward/permissions) to match Agent Auth. Use **skill** for what an agent is good at, which matches A2A.

**Role taxonomy.** Use two orthogonal prescribed axes, as CLEO does in ADR-083, plus a principal axis:

| Axis | Values | Use case | Source alignment |
|---|---|---|---|
| **rank** (who coordinates whom) | `orchestrator`, `lead`, `worker` | fan-out and escalation: `role:lead` gets status, workers report up; matches `CLEO_AGENT_ROLE` so a CLEO-spawned agent can set it automatically | ADR-083, `AgentSpawnCapability` |
| **function** (what it does) | `dev`, `reviewer`, `researcher`, `architect`, `validator`, `docs`, `security`, `devops`, `assistant`, `frontdesk` | `role:reviewer` for review requests; `frontdesk` = the agent a contact may reach by default (AGENT-CARD §9 Q3); `assistant` = a personal/general agent | CLEO `AGENT_TYPES` (executor→dev, documentor→docs), SignalDock `AgentClass` (code_dev, research, security, devops, personal_assistant) |
| **principal role** (humans) | `owner`, `member`, `guest`, `contact` | who may send and at what default level | POLICY.md §7 ↔ Better Auth org `owner`/`member`; `admin` only if multi-owner orgs arrive |

Selectors become `rank:lead`, `fn:reviewer` (keeping `role:` as an alias for `fn:`), or `project:<id>`. Free-text values stay allowed but are shown as `custom`. SignalDock's experience argues against a large enum: 13 classes drifted from a 5-value spec and defaulted to a deprecated `custom`.

**Provenance.** A self-declared rank or function is a claim. An owner role record is required before either may appear in policy.

**Origin.** Every envelope and card already carries `host`; add `owner_fp`. The pair (owner, device) answers "which human, which machine". Never ship an email or username.

### (b) Defer vs stay independent

**Defer to (reuse the shape, not the dependency):**
- CLEO for the role enums and project id. Read `CLEO_AGENT_ROLE`, `CLEO_AGENT_ID` and `.cleo/project-id` when present to pre-fill the card as `host` provenance. Reading them is optional, so non-CLEO users are unaffected.
- Better Auth for the **cloud account plane**:
  - user, passkey and `deviceAuthorization` for `agentmbx cloud login` (the same pattern as Nexus T12337)
  - `organization()` for multi-owner teams later
  - `apiKey()` or bearer for relay quotas
  - If Nexus and the AgentMBX cloud share one Better Auth deployment, one login would cover both. That needs an owner decision.
- Agent Auth conventions for **host enrollment on the relay**:
  - host key as JWK, id = RFC 7638 thumbprint
  - `host+jwt` for relay requests
  - the agent/host state names and the three lifetime clocks
  - the "server may narrow, never widen" rule
  - Adopt these as conventions; do not take a runtime dependency while the plugin is unstable.

**Stay independent:**
- **Authority.** Policies, grants, roles and revocations stay owner-signed and are verified by the receiving daemon. The relay or cloud never decides what an agent may do, unlike Agent Auth and SignalDock, where the server is the authority.
- The LAN-only mode must work with no account at all (SPEC non-goals).
- Card format (AGENT-CARD decision 4), envelope signing and pairing.
- Not Better Auth's `organization` roles as policy input. They gate cloud administration only.
- Not SignalDock's model: unauthenticated slug registration, bearer-only agent keys, a public directory, and server-held authority.

### (c) Risks and open questions

1. **Role-enum drift already exists upstream.** CLEO's `orch_level` has opposite meanings in different files, ADR-083 says `role=leaf` while the code uses `worker`, and SignalDock's spec and code disagree on classes. AgentMBX should pin its own list and map to the others, not import it.
2. **Agent granularity mismatch.** An Agent Auth "agent" is per session, while an AgentMBX agent is a mailbox. A cloud that mints per-session agent JWTs must not let a new session inherit a mailbox's grants (§10.2).
3. **Server authority creep.** Using agent-auth capability grants for relay access could quietly make the relay a policy authority. The relay's grants must be limited to transport (post/fetch mailbox), never mbx action classes.
4. **Correlation and privacy.** One host key shown to the relay and to every contact lets them correlate the host (Agent Auth §9.1). Consider per-audience host keys derived with HKDF for cross-owner use.
5. **Credential hygiene lesson.** SignalDock shipped unsalted bearer hashes, a non-CSPRNG claim code and keys committed to git. Those keys should be rotated; that is out of scope here. The AgentMBX cloud should never issue long-lived bearer secrets to agents.
6. **Legacy dependency.** CLEO's registry still defaults `api_base_url` to `api.signaldock.io`, and conduit's HTTP transport targets it. Is AgentMBX meant to replace conduit's remote transport? Owner decision.
7. **Shared or separate cloud.** Should one Better Auth instance (Nexus `api.cleocode.dev`) back both CLEO Nexus and the AgentMBX relay, or should agentmbx.com run its own? This touches BUSL and hosting.
8. **Project id without CLEO.** What should the id be for a repo with no `.cleo/project-id`? Options are a locally minted opaque id, or a git-root-plus-remote hash, which is guessable (§10.4).
9. **Rank vs function naming.** Is `role:` kept as function only, and does rank need to be visible cross-owner? The proposal says no; rank is same-owner only.
10. **Verification.** The external specs are drafts (Agent Auth v1.0-draft; A2A version to pin). The CLEO and SignalDock facts come from source reads at the stated HEADs, with no runtime checks. ADR-094 is cited in CLEO code but the file was not found.
