# SignalDock salvage audit

Status: research for an owner decision (docs/IDENTITY.md §0, "SignalDock: under review"). Audited 2026-09-26 at `~/projects/signaldock` HEAD `1cc20ca`. The audit was read-only on the repo. Builds ran in scratch copies that left out every credential-bearing file.

## Recommendation (read this first)

**Salvage the product, not the server.** SignalDock should become AgentMBX Cloud as a *UI and experience* salvage plus a *small* Rust salvage. It should not be a "build up from the backend" salvage.

- **Frontend: ADAPT, high value.** The Next.js app builds cleanly (21 routes; `tsc` and `next build` pass). It has a coherent dark design system (24 UI primitives, tokenised `globals.css`), and about 60% of its screens map directly onto the owner dashboard and agentmbx.com. This is where most of the effort you remember went, and it survives the trust-model change almost intact, because a UI does not care who holds authority.
- **Rust backend: DROP as a codebase, HARVEST patterns.** About 70% of its 23k Rust LOC encodes the model the council rejected: server-held authority, bearer `sk_live_` keys, agent registration, conversations as server objects, plaintext message rows, payments, leaderboard, attachments. The relay needs about 2–3k LOC of different code: opaque signed envelopes in per-host mailboxes, enrolment by key, ack/expiry, quotas. Porting SignalDock would mean deleting most of it and re-shaping the rest. The worth-keeping parts come to under 1.5k LOC: the Axum/SSE skeleton, the delivery-jobs + dead-letter worker, the webhook HMAC adapter and the rate-limit middleware shape. They are easier to copy into a fresh crate than to carve out.
- **Rust relay vs TypeScript relay:** choose **Rust only if you also commit to a Rust verify library as the protocol's second implementation** (§2c). That library does not exist in SignalDock: it has no Ed25519, no JCS and no envelope code. If you don't want to maintain two languages, build the relay in TypeScript from AgentMBX's core and keep SignalDock's frontend either way. Both options are sketched in §3.
- **Do the security items in §4 first**, whatever you decide. They cover a live service with committed keys, and crates already published under MIT.

## 1. Inventory

### 1.1 Rust workspace (`Cargo.toml`: edition 2024, toolchain 1.94.0, MIT, v2026.5.0)

| Component | LOC (`.rs`/`.sql`) | Purpose | Notes |
|---|---|---|---|
| `backend/src` (`signaldock-api`) | 11,136 | Axum 0.8 server: 18 route modules (`routes/mod.rs:51-208`, about 80 endpoints), auth, admin, attachments + versioning, leaderboard, payments, SSE, LAFS envelope wrapping (`compat.rs`, `mvi.rs`), S3 (`s3.rs`) | `main.rs` (615) contains **29 inline `CREATE TABLE` statements** as a "safety net" (`main.rs:118-160`) |
| `backend/tests` | 1,045 | integration: delivery pipeline (12), MVI (7), delivery jobs (5), webhook (2), SSE (2) | in-process, SQLite |
| `backend/worker` | 45 | standalone delivery-worker binary | wraps `DeliveryWorker` |
| `crates/signaldock-core` | 1,332 | domain types (Agent, AgentCard, AgentClass ×13, PrivacyTier, Message, Conversation, Claim, Connection = "friendship"), optional WASM bindings (`wasm.rs`) | published on crates.io |
| `crates/signaldock-protocol` | 531 | re-exports + `AppError`; **depends on cleocode crates** `lafs-core`, `cleo-conduit-core`, `cant-core` pinned `=2026.5.105` | coupling to CLEO internals |
| `crates/signaldock-storage` | 6,729 | Diesel-async traits + adapters (SQLite + Postgres), 20 SQLite migrations, 11 Postgres migrations, 3 Diesel migration dirs, `build.rs` pragma codegen | **four schema sources**: SQLite SQL, Postgres SQL, Diesel migrations, `main.rs` inline. `sqlx` is declared (`backend/Cargo.toml:35`) but never imported |
| `crates/signaldock-transport` | 1,893 | `TransportAdapter` trait; SSE (DashMap + unbounded mpsc), webhook (HMAC-SHA256 + timestamp), WebSocket, HTTP/2, Redis pub/sub | cleanest crate |
| `crates/signaldock-sdk` | 2,049 | services: agent (keys, claim codes), message, conversation, delivery orchestrator (SSE → webhook → poll), delivery worker (backoff → `dead_letters`), in-memory mock store | generic over storage traits |
| `crates/signaldock-payments` | 297 | x402 (Base/Solana facilitators), Axum middleware | |
| **Rust total** | **≈23.3k** (`.rs` only, including tests) | 102 `#[test]`/`#[tokio::test]` functions | 0 `unsafe`, 0 TODO/FIXME, about 98 `unwrap/expect` |

**Auth runs as two stacks side by side:**
- hand-rolled `/auth/*` (bcrypt cost 12, custom JWT, TOTP 2FA; `routes/auth.rs`);
- `better-auth-rs` 0.9 (a *Rust port*, not the TypeScript Better Auth) nested at `/auth/v2` with Email/ApiKey(`sk_live_`)/Org/Admin/2FA plugins (`lib.rs:24-88`, `main.rs:592`). It depends on a personal fork, `better-auth-diesel-postgres` (git dep).

**Infra.**
- Railway: backend is a Dockerfile build with `--features postgres` and a `/health` check (`backend/Dockerfile`, `backend/railway.toml`); frontend is Railpack.
- CI: `.github/workflows/backend-ci.yml` runs fmt, migration-dupe, clippy `-D warnings`, test, docs and build.
- **CI is filtered to `backend/**` with working-dir `backend`.** The last run (green, 2026-05-23, run 26320709515) predates the moves of `crates/` and crates.io (PRs #8–#11). So **nothing after PR #7 was ever CI-built.** It does build locally today (§1.3).

**Published SDK.** All six crates are on crates.io at 2026.5.0 under **MIT** (downloads: core 220, protocol 170, storage 73, transport 72, sdk 21, payments 19). The GitHub repo is private. There is no separate CLI or TS SDK in this repo; the client is CLEO conduit's HTTP transport.

**Docs.**
- `backend/docs/dev/adr/` (6 ADRs + 2 audits);
- specs `agent-identity.md`, `message-delivery-guarantees.md` (it states **at-most-once** semantics, L9) and `webhook-signing.md`;
- `docs/SignalDock-Frontend-{Design,Plan}.md` (301 + 541 lines).

### 1.2 Frontend (`frontend/`, Next.js 14.2 app router, React 18, Tailwind 4, TanStack Query 5, d3-force; 19.0k LOC)

| Area | LOC | Contents |
|---|---|---|
| `app/` | 4,732 | public: `/`, `/features`, `/pricing`, `/docs`, `/api-docs`, `/login`, `/register`; app shell `(app)/`: `dashboard`, `agents`, `agents/[agentId]`, `conversations`, `conversations/[id]`, `search`, `discover`, `claim`, `orchestration`, `settings`, `settings/organizations`, `admin`, `admin/logs` |
| `components/ui` | 1,242 | 24 primitives: Avatar, Badge, Button, Card, CodeBlock, ConfirmDialog, CopyButton, EmptyState, GlassPanel, GlowDot, Input, Modal, MonoId, MultiSelect, … |
| `components/{agents,conversations,admin,settings,layout,dashboard,…}` | about 8.3k | AgentCard/Profile/Inbox/ConnectionKitPanel; ConversationView/MessageComposer/PinnedMessages; AppShell/Sidebar/TopBar/MobileTabBar/ConnectionStatusIndicator; StatCards/ActivityFeed; OrchestrationGraph (d3, **mock data**: `lib/mocks/orchestration.ts`) |
| `lib/` | 3,445 | `api/` (13 typed clients over the LAFS `{success,data,error}` envelope), 19 react-query hooks, SSE context (`eventsource-parser`), markdown pipeline (unified/remark/rehype) |
| design system | `app/globals.css` 261 | 39 CSS tokens, Material-3-style (`--color-surface-*`, `--color-primary` `#adc6ff`, secondary green, tertiary red). **Dark only, no light theme** |

**Checks run:** in a scratch copy with no `.env*` and `NEXT_PUBLIC_API_URL=http://localhost:4000`, `npm ci`, `tsc --noEmit` and `next build` all **pass**. The build produces 21 routes with about 87 kB of shared first-load JS. There are no frontend tests.

**Weaknesses:**
- the JWT is stored in `localStorage` (`lib/api/client.ts:26-34`);
- React 18 / Next 14 are one major behind.

### 1.3 Backend build and test run

No Rust toolchain is installed on this Mac. I installed rustup 1.94.0 into the scratchpad (`--no-modify-path`, nothing global) and ran the default features (SQLite) on a copy with no `.json`/`.env` files:
- **`cargo check --workspace --all-targets`: passes** in 37 s. There are 230 warnings: 219 are `missing_docs`; the rest are dead test helpers and one unused import.
- **`cargo test --workspace`: 82 passed, 0 failed, 21 ignored.** All 21 ignored tests are the backend end-to-end suites (`delivery_pipeline` 12, `delivery_jobs` 5, `sse_delivery` 2, `webhook_delivery` 2), each marked `#[ignore = "requires PostgreSQL"]`. So the delivery pipeline has **no end-to-end test that runs by default**; only unit tests and the mock store run.
- The `postgres` feature (the production build) was not built, because it needs `libpq` and the git-fork dependency.
- **Coupling:** a strict layering (core ← protocol ← storage/transport ← sdk ← backend), plus the external pin on cleocode crates.
- **Code style:** clean (0 `unsafe`, doc lints on, `thiserror` errors). The mess is at the schema level (four copies), and in the dual auth and dual ORM declarations.

## 2. Per-component disposition

| Component | Verdict | Reason | Effort |
|---|---|---|---|
| Frontend design system (`components/ui`, `globals.css`, layout shell) | **KEEP** | Independent of the trust model. Add a light theme and rebrand the tokens | small |
| Frontend marketing pages (`/`, features, pricing, docs, api-docs) | **ADAPT** → agentmbx.com | The structure and components carry over; the copy and the API docs must be rewritten for the protocol | medium |
| Frontend app screens | **ADAPT** (mapping in §2b) | The data layer is rewritten: Better Auth sessions (cookies), relay API, client-side verification | medium–large |
| `signaldock-transport` SSE + webhook adapters | **ADAPT** (copy into the relay crate) | The SSE registry and HMAC webhook are sound. They need Last-Event-ID replay, bounded channels and host-key auth | small |
| `signaldock-sdk` delivery worker + `delivery_jobs`/`dead_letters` | **ADAPT** (pattern) | Backoff → dead-letter matches IDENTITY §0.1. Missing: row leasing (`fetch_ready_jobs` has no `FOR UPDATE SKIP LOCKED`, `diesel_jobs.rs:65-78`, so the embedded worker and the standalone worker can double-deliver); at-least-once + ack instead of the spec's at-most-once | small–medium |
| Rate-limit middleware | **ADAPT** | The shape is fine. It must key on the *verified* host key, not the client-supplied `X-Agent-Id` (`rate_limit.rs:97-118`), and needs eviction and shared state for more than one instance | small |
| `signaldock-storage` (Diesel, 4 schema copies) | **DROP** | Its schema models agents, conversations and plaintext messages. The relay needs about 5 tables. Keep one migration tool and Postgres only | — |
| Auth (custom bcrypt/JWT + better-auth-rs) | **DROP** | IDENTITY §7 chooses Better Auth (TS) for accounts, passkey and device-code. The Rust port is 0.9 on a personal fork, and running two stacks side by side is a liability | — |
| Agent registry, AgentCard, AgentClass, PrivacyTier, capability/skill tables, claim codes | **DROP code, keep lessons** (§2d) | | — |
| `signaldock-protocol` (re-exports of lafs/cant/conduit-core) | **DROP** | Couples the relay to CLEO internals. The relay must depend only on the AgentMBX protocol | — |
| `signaldock-core` WASM bindings | **DROP** | A verify library compiled to WASM would replace it (§2c) | — |
| Payments (x402), leaderboard, friends/connections, attachments + versioning, WebSocket, HTTP/2, Redis | **DROP now** (see §2e) | Out of scope under SPEC non-goals | — |
| Railway configs, Dockerfile, CI workflow | **ADAPT** | Reusable templates. Fix the CI path filter | small |
| Delivery / webhook / identity specs | **KEEP as reference** | `webhook-signing.md` is directly reusable for the relay's webhook egress | — |

### 2a. Can the Rust backend become the untrusted relay?

**What the relay must do** (IDENTITY §0, §0.1, §7, §8 v0.5):
1. Enrol a host by its Ed25519 key (JWK + RFC 7638 thumbprint; short `host+jwt` for calls), tied to a Better Auth account.
2. Accept an owner/host-signed envelope and **verify only the transport-level signature**: the sender is an enrolled key, and the rate/quota fits. It must never evaluate policy or grants.
3. Store it opaquely in each recipient host's mailbox, with a retention bound.
4. Deliver it by SSE (with Last-Event-ID) or long-poll, and optionally by webhook.
5. Take ack by the recipient host, retry with backoff, and dead-letter after 72 h.
6. Enforce per-account and per-host quotas.
7. Serve a signed directory of opt-in contact cards, stored as signed blobs that it does not interpret.

**What SignalDock has for each:**

| Relay need | SignalDock today | Gap |
|---|---|---|
| host enrolment by key | `sk_live_` bearer keys hashed with SHA-256 (`agent_service.rs:42-55`); unauthenticated `POST /agents` issues a key (`agents.rs:29-69`) | rewrite: challenge-signature enrolment, `host+jwt` verification, no bearer secrets |
| opaque signed envelope store | `messages` row with `content`, `from_agent_id`, `to_agent_id`, `status`, `read_at` (`schema.rs:113-128`); server-side conversations and FTS5 search | rewrite. The relay must not parse bodies (and must not search them) |
| per-host mailbox + SSE | per-*agent* DashMap SSE registry, unbounded channels, single instance unless Redis (`sse.rs:1-40`); no Last-Event-ID replay outside Redis | adapt: key by host fingerprint, bounded channels, cursor replay from the DB |
| ack / retry / dead-letter | `delivery_jobs` + `dead_letters` + backoff worker (`delivery_worker.rs`, `diesel_jobs.rs`) | adapt: leasing, ack-driven completion, dedupe left to the receiver (per-sender high-water mark lives in the daemon, §0.1) |
| rate limits | in-memory per `X-Agent-Id` header | adapt: key by verified host |
| authority | the server decides: ownership via claim codes, admin reset-key, privacy tiers | **remove entirely.** Grants, policies and roles stay owner-signed and are checked by the receiving daemon |

**Verdict.** The relay is a different, much smaller program. Estimated reuse of SignalDock backend code is **≤10%** by LOC: SSE handler, worker loop, HMAC webhook, rate-limit shape, Axum wiring. A new relay crate is **medium effort** in either language. The "fast Rust" point applies to the relay only in part: its load is dominated by I/O and Postgres, and Node handles thousands of idle SSE connections well. Rust's real advantages are memory per connection and one static binary.

### 2b. Can the frontend become the AgentMBX web app and agentmbx.com?

| AgentMBX need | SignalDock screen | Fit |
|---|---|---|
| Public site | `/`, `/features`, `/pricing`, `/docs`, `/api-docs`, `MarketingNav/Footer` | direct (new copy) |
| Login / account | `/login`, `/register`, Settings → Profile/Security | direct UI; wire to Better Auth (passkey, email, 2FA) |
| **Devices** (enrolled hosts, device-code approve, revoke) | Settings → API Keys (`ApiKeysTab`), `/claim` (`ClaimCodeInput`) | strong: the key list becomes the device list, and claim becomes device-code approval |
| **Agents / cards** | `/agents`, `AgentCard`, `AgentProfile`, `AgentStatusBadge`, `AgentClassBadge`, `CantProfileViewer` | strong: the badges become `rank`/`fn` badges; add "attested vs declared" and safety numbers |
| Contacts / directory | `/discover` (`BrowseByCapability`, `FeaturedAgents`), `/search` | medium: becomes opt-in contact cards; drop "featured" |
| Policies view | none | new (read-only render of owner-signed records, verified in the browser) |
| Audit log | `/admin/logs`, `SystemLogs`, `AdminActivityLog` | strong (table, filters) |
| Owner inbox | `/conversations`, `ConversationView`, `MessageItem`, `MessageComposer`, `PinnedMessages` | strong UI. The data path must honour relay blindness: messages to `owner` are fetched and verified client-side (and decrypted, once `enc` exists) |
| Dashboard | `StatCards`, `ActivityFeed`, `AgentStatusPanel`, `QuickSend` | direct |
| CLEO wave view | `/orchestration` (d3 graph, mock data) | later: a real use for it via conduit topics |
| Admin (platform) | `/admin` users/agents/stats | keep for operators; strip the key-reset powers |

About **12 of 21 routes map directly or strongly**. The main architectural change: the browser holds no authority either. Anything showing "verified" must run the TS verify library (`src/envelope.ts`, `policy.ts`, `owner.ts`) **in the browser**. That is an argument for TypeScript sharing across daemon, web app and (maybe) relay. Upgrade to Next 15 / React 19, use Better Auth cookies instead of the `localStorage` JWT, and add a light theme.

### 2c. Rust verify library: does SignalDock have pieces?

**No protocol crypto exists.**
- A grep for `ed25519|jcs|8785|canonical` over all `.rs` files finds only doc comments.
- Crypto present: HMAC-SHA256 webhook signing (`transport/src/adapters/webhook.rs:69-90`), SHA-256 key hashing, bcrypt, and `llmtxt-core` signed URLs for attachments.
- The AgentMBX canonical form (`src/crypto.ts:4-14`) is "RFC 8785-style": sorted keys, `JSON.stringify` numbers.

A Rust port needs:
- `ed25519-dalek`;
- an RFC 8785 serializer (for example `serde_json_canonicalizer`), or a hand port that matches JS UTF-16 key ordering and ES number formatting;
- ports of the envelope, grant/policy/owner record and revocation verification.

**Effort: medium (about 1–1.5k LOC plus shared test vectors).** It is worth doing only as the spec's second implementation. It needs a `conformance/vectors/*.json` set generated from the TS reference, which both implementations must pass in CI. `signaldock-core`'s `cdylib`+WASM setup is a precedent for shipping the Rust verifier to the browser, but the TS library already runs there.

### 2d. Registry, card, capability and skill catalogs

- `AgentCard` (`core/src/agent.rs:269-298`) has agent_id, name, description, class, privacy_tier, endpoint, capabilities, skills, avatar, stats, status, is_claimed, last_seen. It is **server-asserted and unsigned**, and mixes identity with stats.
- `AgentClass` has 13 values and drifted from a 5-value spec (docs/research/IDENTITY-SOURCES.md L227). IDENTITY §4 already maps it to the trimmed `fn` axis (`code_dev → dev`, `research → researcher`, `personal_assistant → assistant`, `security`, `devops`, `testing → tester`, `documentation → docs`, `orchestrator → rank:orchestrator`).
- Capability/skill tables (`migrations/sqlite/0013_*.sql`) are a free catalog with junction tables.

**Verdict: DROP the code and keep the mapping table.**
- The card vocabulary is IDENTITY §4 (fixed `rank` × `fn`, `custom` + free-text skills). Card fields are host-signed and roles owner-attested.
- The UI components (class badge, capability browser) are reusable with the new enums.

### 2e. Payments, leaderboard, friends, attachments, WebSocket, Redis

| Feature | Verdict | Why |
|---|---|---|
| x402 payments (`signaldock-payments`, 297 LOC) | drop | SPEC non-goal. If metered relay billing arrives, it goes through Better Auth/Stripe on accounts, not per-message crypto payments |
| Leaderboard / activity feed (`routes/leaderboard.rs` 384) | drop | Rankings of other owners' agents conflict with the private-by-default directory (§7) |
| Friends / `connections` | drop | Replaced by owner-signed contact cards (IDENTITY §5) |
| Attachments + versioning + S3 (`attachments.rs` 799, `versions.rs` 924, `s3.rs` 307) | drop now; revisit | SPEC non-goal. If needed later: content-addressed blobs referenced by hash in `refs`, encrypted client-side |
| WebSocket / HTTP/2 adapters | drop | SSE + long-poll suffice; one transport per hop |
| Redis pub/sub | keep for later (pattern) | Only needed when the relay runs more than one instance; Postgres `LISTEN/NOTIFY` may suffice |

## 3. Proposal: "SignalDock becomes AgentMBX Cloud"

```
  host A (laptop)                      AgentMBX Cloud                         host B (desktop)
 ┌─────────────────┐   HTTPS+SSE   ┌──────────────────────────────┐   SSE/poll  ┌─────────────────┐
 │ agentmbx daemon │──POST env────▶│ relay (untrusted)            │────────────▶│ agentmbx daemon │
 │  verify lib     │◀─SSE/ack──────│  • host enrol by key (JWK)   │◀──ack───────│  verify lib     │
 │  store, policy  │  host+jwt     │  • per-host mailboxes (opaque│             │  store, policy  │
 └────────┬────────┘               │    signed blobs, TTL 72h)    │             └─────────────────┘
          │ LAN (paired, direct)   │  • jobs/dead-letter, quotas  │
          └───────────────────────▶│  • signed directory blobs    │
                                   └──────────┬───────────────────┘
                                              │ account id / quota only
                                   ┌──────────┴───────────────────┐    ┌───────────────────────────┐
                                   │ Better Auth (TS): accounts,  │◀──▶│ web app (ex-SignalDock UI) │
                                   │ passkey, device-code, orgs   │    │ agentmbx.com + dashboard;  │
                                   └──────────────────────────────┘    │ TS verify lib in browser   │
                                                                       └───────────────────────────┘
```

**Reused:**
- SignalDock frontend: design system, shell, most screens, marketing structure;
- from the backend, patterns and small copied modules: SSE handler, worker/dead-letter loop, HMAC webhook, rate-limit shape, Railway/Docker/CI templates;
- the specs as reference.

**Rewritten:**
- relay data model and API;
- enrolment/auth (Better Auth TS plus `host+jwt` verification in the relay);
- the frontend data layer;
- the verify library, if Rust.

**Order of work** (respects IDENTITY §8: nothing relay-side before the v0.4 prerequisites):
1. §4 security freeze (now).
2. Protocol spec v1 plus TS conformance vectors (v0.4).
3. Frontend rebrand into agentmbx.com, *static marketing only*, which can ship early.
4. Rust verify lib against the vectors, if the Rust relay is chosen.
5. Relay MVP: enrol, post, mailbox SSE/poll, ack, dead-letter, quotas.
6. Better Auth service plus the dashboard's Devices and Agents screens.
7. Owner inbox with client-side verification, then `enc`.
8. Decommission api.signaldock.io after conduit cutover.

**Risks:**
- **Two languages:** the protocol logic lives in TS (daemon, browser) *and* Rust (relay). Parity needs shared vectors in CI, or drift returns, which is the council's core finding.
- **Untrusted requirement creep:** any "convenience" server check (ownership, roles) re-creates SignalDock's authority model. Mitigation: the relay never imports policy code; it only needs "is this key enrolled + within quota".
- **Plaintext bodies:** the relay can read bodies until `enc` ships (SPEC L13). Say so on the site.
- **Licence:** the old crates are already public on crates.io under **MIT**, and that cannot be withdrawn. New relay code can be BUSL-1.1 like AgentMBX, but copied SignalDock files stay MIT-licensed. Keep attribution, or rewrite rather than copy.
- **Dependency rot:** CI has not built since 2026-05-23. The cleocode crate pins, the `better-auth-diesel-postgres` fork and Next 14 all need upgrades before anything ships.

**Alternative: relay in TypeScript from AgentMBX core.**
- One language, and the same `envelope`/`policy`/`crypto` module in the daemon, relay and browser, so parity is automatic.
- Better Auth is TypeScript-native (same process or same monorepo).
- The relay is small and I/O-bound. Node 24 + Postgres (or SQLite for single-node) is adequate.
- Loses Rust's footprint and the "second implementation proves the spec" benefit. You can still get that benefit later with a standalone Rust *verify* crate, without running a Rust service.

**On balance:** TS relay + SignalDock frontend is the lower-risk path to v0.5. Rust relay + Rust verify lib is the higher-rigour path, and is justified only if you will keep both in CI with shared vectors. In neither case is SignalDock's backend the base to build up from.

## 4. Security items before any reuse (listed, not fixed)

1. **Committed live keys.** `sk_live_` keys were added in `0b0e7c3` (2026-03-28, `clawmsgr-signaldock-frontend-code_dev.json`) and untracked only in `1cc20ca`. They are still in git history and on disk (also `agent-registry-report.json`, untracked). Rotate them on api.signaldock.io / api.clawmsgr.com, and purge history before the repo is ever made public. (No real-format key matches `git grep` at HEAD.)
2. **Unauthenticated agent registration.** `POST /agents` (`routes/mod.rs:73`, `agents.rs:29-69`) creates an agent and returns a working bearer key to anyone.
3. **Unsalted hashes of bearer keys.** SHA-256 without salt or pepper (`agent_service.rs:42-55`, `api_keys.rs:20-24`). The keys have 256-bit entropy, so this is not brute-forceable, but it is a DB-leak-equals-lookup design. The relay should issue no long-lived bearer secrets at all.
4. **Non-CSPRNG claim codes.** `generate_claim_code_str` seeds from `subsec_nanos()` and steps an LCG (`agent_service.rs:289-303`). The codes are predictable, and a claim transfers ownership. (API keys and TOTP secrets use `rand` ThreadRng, which is a CSPRNG.)
5. **Default JWT secret.** Falls back to `"signaldock-dev-secret"` if `JWT_SECRET` is unset (`main.rs:559`).
6. **`CorsLayer::permissive()`** on the whole API (`main.rs:593`), combined with bearer tokens in `localStorage` (`frontend/src/lib/api/client.ts:26`).
7. **Rate limiter keyed on client-supplied `X-Agent-Id` / `X-Forwarded-For`** (`rate_limit.rs:97-118`). It is bypassable, and anyone can exhaust a victim's bucket. It is also in-memory with no eviction shown.
8. **Admin reset-key endpoint** (`/admin/agents/{id}/reset-key`) is server authority over agent credentials, incompatible with the untrusted model.
9. **Double delivery.** Jobs are fetched without leasing while the API and the standalone worker both run (`diesel_jobs.rs:65-78`).
10. **Stale CI.** The path filter excludes `crates/**` and the root manifest, so the published crates were never CI-built. The end-to-end delivery tests need Postgres and are `#[ignore]`d.
