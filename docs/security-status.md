# Security audit and remediation status

This is a reconciliation of existing reviews, task receipts and source history, checked on **2026-10-14**. It is not a new penetration test or a claim that the product has no remaining vulnerabilities. Historical audits keep their original findings and revision references; this document records later fixes, decisions and gaps separately.

## Release baseline

The published install baseline at review time is **npm `agentmbx@latest = 0.5.30`**, registry `gitHead 0d26b5bf`. [npm](https://www.npmjs.com/package/agentmbx) is authoritative for the current install; versions below are dated evidence, not an instruction to pin an old release. The extracted npm package reports 0.5.30. Public main `1eda360` contains the later T614 Codex restart correction `97718a7` and the 0.5.31 bump, which were **merged but unpublished on npm** at this snapshot.

The public fix commits cited below were verified as ancestors of the published npm gitHead. Cloud evidence is separate: cloud main `25c19b28` contains PR 2 /`6f0e836` and PR 12/`d852876`. A cloud merge or accepted contract does not prove a deployed authority path or a production security review.

Status terms: **patched/shipped** means released implementation evidence; **partial/open** retains unfinished criteria; **accepted risk** records the stated boundary or design acceptance rather than a fix; **planned** is design work without runtime evidence; **unknown** means the reviewed records do not establish the result.

## Reviews and their successors

| Existing review or record | What was reviewed | Current disposition |
|---|---|---|
| September 26 policy reviews, T048/T058 | Session/process birth proof, policy containment, revocation/device trust and owner-signing display | Regression fixes `1f5736b`, `4e8f111`, `ade1d7d`, `a68228c` are in npm 0.5.30. Historical advisories were revision-scoped, not current blanket prohibitions. |
| [T032 threat model](THREAT-MODEL.md), v0.5.1 | Whole-product STRIDE review; F1–F18 and local residual risks | Finding-by-finding reconciliation below. T196/T200 and durable relay work supersede several follow-ups; T198/T199 remain open. |
| [Agent-card adversarial review](AGENT-CARD.md), T059 at `28a2314` | Directory authenticity, immutable identity, replay, disclosure, contact exchange and verification prerequisites | Design history retained. T059 merged into T068; T065/T066/T068/T069/T070 remain pending. A signed directory response alone does not implement signed current-sequence cards. |
| [Independent mailbox-foundation review](research/mailbox-foundation-independent-review.md), T116 | Seven contract clarifications: atomic visibility, snapshots/cursors, authority checks, restore epochs, console access, discovery and task semantics | Replay/capture implementation has successors; local console T152–T155, topics T174–T176, immutable-principal/conduit and gateway gates remain open. Conditional design consensus is not acceptance of every future slice. |
| [September 26 conduit council](COUNCIL-VERDICT-2026-09-26.md) | Protocol kernel, per-session attribution, untrusted relay, signed discovery, immutable identity and SignalDock retirement conditions | Body sealing/durable relay shipped. Per-session attribution/immutable cards and production conduit conformance remain pending. D010 later changed retirement policy; T078/T351 closeout is unproven. |
| Cloud ADR 0005, T238 / [cloud PR 2](https://github.com/kryptobaseddev/agentmbx-cloud/pull/2) | CT1–CT18 threat table and R-C1–R-C11 owner-accepted design residuals | Accepted design, with implementation owned by the named tasks. T273 independent passkey-path review and T299 API/console/relay launch review remain pending. |
| Cloud console draft 5 security follow-ups, T336 / [cloud PR 12](https://github.com/kryptobaseddev/agentmbx-cloud/pull/12) | Five below-High contract findings | Patched in merged contracts/vectors at `d852876`; not a deployed-path pentest. Original review report was not present as a tracked audit document in this bounded inventory. |
| October 9 project-mailbox/autonomy council, canonical `council-lead-root-inbox-autonomy-20261009` | Dead lead routing, project isolation, grant attenuation, liveness and taint | Project mailbox and T498/T499/T551 changes shipped. T537 intentionally removed policy depth/action caps. T539 provider permission-hook qualification and T552 remote project reads remain pending. |
| T574 local/cloud source triage | 111 local plus 110 cloud backlog decisions; source baselines and unmet obligations retained | Metadata reconciliation, not a fresh security audit or deployment proof. T197/T198/T199, T273/T299 and legacy closeout remain explicit. Canonical cloud application receipt: `t574-cloud-application`. |
| T579/T580 trust design, D044 | Content provenance, labelled untrusted summaries, short session-wide clearance, isolated action contexts and fresh v2 lead grants | Owner choices accepted; seven ordered implementation tasks T628/T629/T630/T631/T632/T627/T626 are pending. No real harness isolation or new provenance/grant protection is claimed shipped. |

The source audits for [replay/topics](research/replay-topics-source-audit.md), [local console](research/local-console-source-audit.md), [interop](research/interop-framework-source-audit.md), and [native session catch-up](research/native-session-catchup-audit.md) remain pinned research inputs. Their proposed features are not release claims. Current product status is in the [roadmap](plan/native-feature-roadmap.md).

## T032 findings: all 18 accounted for

| Finding | Current status | Successor evidence / remaining work |
|---|---|---|
| F1: relay substitutes recipient body key | Patched/shipped | `f47ec53` verifies the pinned peer signature; T168 adds signed expiring ads, relay pinning and recovery (PR 93, 0.5.7). |
| F2: grind matching code-compare pairing codes | Patched/shipped | Commit-reveal pairing `45d3f2d`; regression cases in `test/pair.test.ts`. Token pairing is a separate ceremony. |
| F3: free-text or misleading remote sender address | Patched/shipped | `25f7d9b` requires exactly one agent at the paired sender host. |
| F4: relay host-name squatting | Partial; original criterion superseded | T165 uses key-addressed hosts and names scoped to proven accounts; equal names across owners are intentional. T197 remains pending because its old global-name-uniqueness AC conflicts with this design and needs sourced rescoping/closeout. |
| F5: unauthenticated host HTTP responses | Partial/open, T199 | Directory and body-key payload signatures are checked against the pin. Unsigned directory fallback remains; LAN envelope acceptance and policy-result response authentication are unfinished. A valid signed policy payload does not authenticate the response wrapper or prevent suppression. |
| F6: recipient-name notification/wake flood | Patched/shipped, T196 | `7441b59`: unknown-name notice suppression, recipient validation and bounded desktop notices. Historical R8's “F6 remains open” wording predates this fix. |
| F7: visible metadata, including body-derived tags/mentions | Open owner decision, T198 | Body encryption does not seal metadata. Choice between a compatible sealed-metadata design and explicit accepted exposure remains unrecorded in the reviewed successor evidence. D001 local storage is a different decision. |
| F8: subject/body imitate trusted frame/header | Patched/shipped, T196 | `7441b59`: control-character rules, one-line headers and random render boundaries. Framing does not make an LLM injection-proof. |
| F9: rotation after old-key compromise | Documented accepted limitation | Rotation authenticates from the old pin; human removal/re-pairing is needed after compromise. No automatic compromise recovery is claimed. |
| F10: pending code-compare pairs never expire | Patched/shipped in 0.5.28, T200 | `aaadd62` / source commit `594b39d`: approval rejects/deletes after 10 minutes; daemon sweep cleans pending rows. Later gated completion supersedes the earlier T574 pending note. |
| F11: signed-hop replay within clock skew | Documented accepted residual | Timestamp window and idempotent envelope/record handling remain; response-bound replay protection belongs with T199. |
| F12: unbounded reference-relay challenge/dedup maps | Implemented successor; task closeout open | T165 persistent store/bounds and T167 retention/tombstones replace the old memory maps. T197 is still pending; no blanket closure of its conflicting criteria. |
| F13: status/mDNS disclose host/version/fingerprint | Documented accepted residual | Discovery metadata is visible and grants no authority. |
| F14: identity-passphrase environment exposure | Documented accepted residual | Same-user/environment/history exposure remains; terminal prompting is the default. |
| F15: retention leaves free-page/WAL remnants | Documented accepted residual | Deletion/retention is not secure erasure or at-rest encryption. |
| F16: Claude development channel trusts configured server name | Documented accepted residual | Provider/server installation remains a trust boundary; AgentMBX does not authenticate a hostile replacement configured as `mbx`. |
| F17: non-mail prompt resets relay context | Historical residual; policy model changed | T104 provenance distinction remains. T537 intentionally removed collaborate/autonomous depth and per-thread action caps; those old caps must not be claimed as current protection. External-content taint remains. |
| F18: docs said direct LAN may send plaintext bodies | Corrected/shipped | T028 seals LAN bodies; `1b7f006` corrected the spec. Metadata and local-at-rest exposure remain separate. |

T028–T031 body sealing, receive limits/fuzzing, rotation and identity backup/retention are also done with released implementation receipts. They mitigate particular threats; they do not resolve T198, T199, compromised same-user access or every hosted launch criterion.

## Current residual boundaries

The historical local risk list R1–R10 remains readable in the threat model. Later evidence changes how some entries should be read:

- **Local storage / same user (D001, R1/R4).** Plaintext bodies, envelope/FTS/WAL/backups and same-user store/key access remain. Leases isolate cooperating sessions, not a hostile process with the same OS account. D001 is a scoped recorded implementation decision; it is not a claim of durable body encryption.
- **Relay metadata/availability (R2), discovery (R3), rotation flooding/compromise (R5/F9), stolen identity bundles (R6).** These remain documented limits. Durable relay acceptance fixes restart-loss behavior, not a malicious relay's ability to suppress traffic.
- **Prompt injection (R7).** Messages are data and permissions come from verified signed records. No frame guarantees model immunity. T537's owner-directed removal of policy depth/action caps supersedes the old R7 description; loop detection reports rather than blocks those policy-driven chains.
- **Lead visibility and grants (R9/R10).** Owner-signed project-lead access and fresh signed grants are real shipped surfaces. T551 adds delegated read/edit policy lines without widening old outward-reversible-only blobs. Lead liveness/taint is bounded to evidence known to the local store; web content read outside AgentMBX is not automatically observed. Remote lead taint, provisional-session association and same-user tampering are not magically solved by the grant signature.
- **Wake pressure (R8).** T196 fixes cross-name desktop flooding. Existing batching, mute and busy/unknown handling are distinct from the removed policy action/depth caps.

T047's same-user documentation exists but its separate recorded-token-decision criterion remains pending. T065/T066/T068 attribution, immutable IDs and verified-card sequence/expiry are also pending; host authentication must not be described as per-agent identity isolation.

## Cloud reviews: accepted design is not deployment proof

Cloud ADR 0005 was imported unchanged from `agentmbx-cloud@25c19b28:docs/adr/0005-cloud-threat-model.md` into canonical `cloud-threat-model-reviewed-20261014`, SHA256 `ca717ad2d05839c039583a334c1d7c9e93e5438c6dd590f62da142d067163ddb`. T238 records owner acceptance on 2026-10-02. The source header and residual table accept all 11 entries; its closing open-question paragraph still says some are pending. That historical inconsistency is retained, with the explicit accepted table and later T238 receipt identified here; it is not new owner acceptance.

| Risk | Recorded design residual | Current interpretation |
|---|---|---|
| R-C1 | Console can sign a different no-confirmation command than displayed | Accepted design exposure; device confirmations/notices/audit need actual-path review. |
| R-C2 | Console+API compromise during key enrollment/root pinning | Accepted; independent displays/deployments are mitigations to verify, not proof of immunity. |
| R-C3 | Cloud suppresses commands/receipts/revocations or lies about read model | Accepted availability/honesty boundary; daemons remain authority source. |
| R-C4 | Operator/TLS terminators see metadata and forge project names | Accepted exposure; allowlist/retention controls do not make it ciphertext. |
| R-C5 | Phished enrollment consumes quota/pollutes read model | Accepted; notices/labels/revoke are the proposed bound. |
| R-C6 | Synced passkey security depends on sync account | Accepted under recorded D12; expiry/revocation do not remove sync-provider risk. |
| R-C7 | Stolen API token works within its short lifetime | Accepted limited credential window; host-key relay binding is a separate control. |
| R-C8 | Email recovery is the weak account-access factor | Accepted under D10; account recovery must not confer owner authority. |
| R-C9 | Single-operator separation is procedural | Accepted operational risk; CI/approval/audit requirements still need production evidence. |
| R-C10 | Active break-glass lifts content-policy downgrades | Accepted under D11; authentication/target binding remain required, and end/clear behavior must be verified. |
| R-C11 | High-risk passkey operations depend on console integrity | Accepted under D11; typed step-up does not fix malicious display/code. |

T336's five contract corrections are merged and checked: lower-bound override `iat`; provisional lost-phone resurrection visibility; provisional YOLO policies voided when their window ends (contract semantics); override-hash pins instead of equal-`iat` reuse; and the forgotten-window lifted-add vector. This proves that contract slice, not every CT1–CT18 mitigation in deployed services.

**Still open:** T273 independent authority-path review; T299 launch-wide authn/authz/CSRF/XSS/SSRF/injection/rate-limit/secrets review; T169 production restore/rollback/monitoring proof; T172 physical WAN qualification; T173 readiness; T078/T351 old-service/credential/redirect closeout. D010 and later HOLD conditions are decisions, not proof that any service or exposed historical credential was retired. No secret files or values were opened for this reconciliation.

## Evidence and coverage limits

Reviewed 10 source groups above, all 18 T032 findings, all 11 cloud design residuals and all 5 T336 follow-up criteria. Current task records and recorded successors were fetched through CLEO; public source checks confirmed body sealing, unsigned fallback/accept results and pending-pair expiry. Released public evidence was checked against npm gitHead, rather than the misleading later GitHub tag.

No new broad pentest, runtime exploit attempt, physical-host test, production configuration review or deployed-control verification ran. The source symbol graph remains unindexed; direct source/commit inspection has bounded coverage. No product implementation task was completed, risk waived or owner authority changed by this report. [Reporting policy](../SECURITY.md) applies to newly discovered vulnerabilities.
