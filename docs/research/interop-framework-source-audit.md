# Interoperability and framework source audit

## Question
Which A2A and AutoGen components improve AgentMBX without weakening signed identity, pretending transport acknowledgement proves task completion, or making CLEO task state a second mailbox database?

Research support for T118; no product implementation or completion of T118 is claimed. Source inspection occurred 2026-09-30. No third-party code was copied.

## Sources
- A2A pinned revision [1ae57a673f729f743b35f2677f3adc302438695a](https://github.com/a2aproject/A2A/tree/1ae57a673f729f743b35f2677f3adc302438695a).
- AutoGen pinned revision [027ecf0a379bcc1d09956d46d12d44a3ad9cee14](https://github.com/microsoft/autogen/tree/027ecf0a379bcc1d09956d46d12d44a3ad9cee14).
- AgentMBX inspected revision 324a2864b85ff6abfb3c5a8ba51af3bffcfc05b3: src/store.ts, src/identity-status.ts, src/identity-control.ts, src/identity-leases.ts, test/conduit-transport.test.ts.
- CLEO checkout revision 440a16368447592747c4fd15ae85211923f2096d: packages/contracts/src/{conduit,transport,agent-registry}.ts. Local checkout evidence, not a claim of released compatibility.

## Findings

### Source findings and reuse
| Component | Exact evidence | Decision |
| --- | --- | --- |
| A2A task states | [a2a.proto L187-L217](https://github.com/a2aproject/A2A/blob/1ae57a673f729f743b35f2677f3adc302438695a/specification/a2a.proto#L187-L217) distinguishes submitted, working, completed, failed, canceled, input-required, rejected, auth-required | Adapt names only at an optional task gateway. A delivered/read/acked mailbox message MUST NOT become completed work. |
| Capability cards | [a2a.proto L362-L455](https://github.com/a2aproject/A2A/blob/1ae57a673f729f743b35f2677f3adc302438695a/specification/a2a.proto#L362-L455) includes supported interfaces with protocol versions, skills, media modes and security requirements | Adapt discovery projection. Card descriptions are untrusted data; capabilities are descriptive, not grants. |
| Subscription and cancellation | [a2a.proto L64-L81](https://github.com/a2aproject/A2A/blob/1ae57a673f729f743b35f2677f3adc302438695a/specification/a2a.proto#L64-L81) exposes CancelTask and SubscribeToTask | Defer execution gateway. Subscription is not a durable replay guarantee. Cancellation requests require authenticated authorization and explicit accepted/rejected/unknown result. |
| Card signatures | [a2a.proto L457-L465](https://github.com/a2aproject/A2A/blob/1ae57a673f729f743b35f2677f3adc302438695a/specification/a2a.proto#L457-L465) defines JWS representation | Keep MBX native signed envelope. Do not relabel native signatures as JWS; use explicit translation and tested canonicalization later. |
| AutoGen subscription routing | [_type_subscription.py L10-L65](https://github.com/microsoft/autogen/blob/027ecf0a379bcc1d09956d46d12d44a3ad9cee14/python/packages/autogen-core/src/autogen_core/_type_subscription.py#L10-L65) maps topic source to agent key | Adapt explicit project namespace + subscription matching. Do not instantiate executors or authorize subscribers from incoming topic text. |
| Runtime envelopes and state | [_single_threaded_agent_runtime.py L257-L269](https://github.com/microsoft/autogen/blob/027ecf0a379bcc1d09956d46d12d44a3ad9cee14/python/packages/autogen-core/src/autogen_core/_single_threaded_agent_runtime.py#L257-L269), [L431-L464](https://github.com/microsoft/autogen/blob/027ecf0a379bcc1d09956d46d12d44a3ad9cee14/python/packages/autogen-core/src/autogen_core/_single_threaded_agent_runtime.py#L431-L464) | Keep event correlation/typed dispatch patterns; defer dependency. Queue is in memory, and save_state snapshots agent state, not durable mail/cursors. |
| Cancellation token | [_cancellation_token.py L8-L55](https://github.com/microsoft/autogen/blob/027ecf0a379bcc1d09956d46d12d44a3ad9cee14/python/packages/autogen-core/src/autogen_core/_cancellation_token.py#L8-L55) links futures/callbacks | Adapt cooperative cancellation for subscriptions/waits. Canceling a wait MUST NOT delete mail, acknowledge messages, release identity, or imply task cancellation. |
| Maintenance status | [README L14-L23](https://github.com/microsoft/autogen/blob/027ecf0a379bcc1d09956d46d12d44a3ad9cee14/README.md#L14-L23) | Verified maintenance mode. Borrow stable patterns; do not add the framework solely for mailbox messaging. |

### License matrix
This is source attribution/provenance, not legal approval of arbitrary reuse. A2A [LICENSE](https://github.com/a2aproject/A2A/blob/1ae57a673f729f743b35f2677f3adc302438695a/LICENSE) is Apache-2.0; any copied code/schema must preserve applicable license/notices and document modifications. AutoGen [LICENSE-CODE](https://github.com/microsoft/autogen/blob/027ecf0a379bcc1d09956d46d12d44a3ad9cee14/LICENSE-CODE) is MIT for code; [LICENSE](https://github.com/microsoft/autogen/blob/027ecf0a379bcc1d09956d46d12d44a3ad9cee14/LICENSE) is CC-BY-4.0 for documentation. Do not apply MIT assumptions to documentation. This proposal uses independently implemented ideas and linked references, with no vendored code. Any later copied component MUST record revision, paths, notices, license and modification history.

## T118 diagnostic contract
The following is a proposed bounded read-only contract, not an implemented API:

```ts
type DiagnosticSnapshot = {
  schema_version: 1;
  observed_at: string;
  advisory: true;
  scope: { mailbox: string; cli?: string; session_id?: string };
  builds: {
    installed: { version: string|null; fingerprint: string|null };
    daemon: { version: string|null; fingerprint: string|null; observed_at: string|null };
    connector: { version: string|null; fingerprint: string|null; observed_at: string|null };
  };
  ownership: {
    state: "held"|"available"|"unknown"|"legacy"|"conflict";
    holder: { cli: string; session_id: string; pid: number; process_birth: string|null }|null;
    generation: string|null; // opaque public generation ID, never the lease token
    process: "verified"|"dead"|"pid-reused"|"unknown";
    reason: string;
  };
  messages: Array<{
    id: string; recipient: string;
    transport: "queued"|"delivered"|"notified"|"read"|"acked"|"unknown";
    attempts: number|null; next_retry_at: string|null; last_error_code: string|null;
    task_status: "not-reported"; // no completion inferred
  }>;
  recovery: Array<{
    receipt_id: string; action: "release"|"claim"|"takeover";
    status: "pending"|"completed"|"failed"|"unknown"; completed_at: string|null;
    error_code: string|null;
  }>;
  page: { limit: number; truncated: boolean; next_cursor: string|null };
};
```

MUST bound messages/recovery to a caller-selected limit (default 20, max 100); resolve the exact mailbox and provider/session before querying; reject malformed selectors rather than fall back to global results. MUST expose observed timestamps and unknown values instead of inventing running versions. MUST NOT read private key files, print key material, owner grants, lease/control tokens, message bodies, arbitrary provider command arguments, or unredacted remote error strings. Unknown process evidence MUST retain ownership and offer explicit owner recovery; no automatic takeover.

Existing deliveries form a monotonic ladder queued/delivered/notified/read/acked (src/store.ts L10, L228-L236); notification is an adapter wake attempt success, not agent processing. Transport state MUST remain separate from task state. Outbox attempts/next_at/last_error already exist (L29-L30); expose sanitized error classification and per-host retry data without modifying retry behavior. Snapshot output SHOULD identify whether a recovery receipt result was observed, not suggest blind retries of uncertain writes (identity-control.ts L98-L123). Error codes: INVALID_SCOPE, SCOPE_NOT_FOUND, STALE_SCHEMA, UNKNOWN_PROCESS, RECEIPT_NOT_FOUND; errors MUST carry bounded actionable guidance without changing leases.

Tests MUST prove two provider sessions cannot see each other's scoped diagnostics; observed installed/running mismatch survives serialization; PID reuse and unavailable process evidence stay distinct; malformed errors/secrets are redacted; notification/read/ack never reports task completion; pagination limits apply before output and do not mutate state.

## Discovery-only adapter and CLEO boundary
Phase 1 SHOULD export an owner-approved subset of native signed-card metadata into a version-pinned discovery representation: name, bounded description, explicitly advertised skills/media types, provenance fingerprint, expiry and supported protocol metadata. AgentMBX currently has LAN host discovery and role/name metadata, not a complete public A2A task server. Therefore an adapter MUST NOT advertise an A2A execution interface until that endpoint actually implements and validates that protocol. A local card-preview command and fixture validator are useful first increments; an external discovery endpoint is a separately authorized network surface.

Imported cards MUST be size/schema/expiry bounded, trust-labeled and unable to create owner authority, subscribe identities, fetch arbitrary URLs or execute tools. Endpoint probing MUST be opt-in with SSRF/redirect/address constraints; stale cards must not silently authorize a new key.

CLEO remains the task/evidence authority. Conduit already distinguishes acceptedAt from nullable deliveredAt (packages/contracts/src/conduit.ts L125-L160), while Transport.ack describes processed messages marked delivered (transport.ts L66-L67). MBX's experimental adapter explicitly lists conflation and unsupported authenticated principals (test/conduit-transport.test.ts L194-L207). Production integration MUST specify immutable authenticated peer identity separately from mutable mailbox name; map MBX ACK as acknowledgement only and add explicit CLEO-authorized task-event projection. A message with payload.taskId MUST NOT mutate CLEO task state. Task events MUST carry project ID, task ID, source revision/event ID and authority provenance; conflicting/duplicate events require deterministic idempotent handling.

## Atomic follow-up proposals
These are proposals for orchestrator filing/deduplication, not newly created tasks:
1. Diagnostic snapshot implementation (T118): depend on the finalized T118 schema; AC: exact-session bounded output, version mismatch, secret redaction, unknown liveness and receipt observation tests pass.
2. Signed-card projection fixtures: depend on existing native-card task and T118 diagnostics; AC: pinned schema validated, unsupported execution capabilities omitted/rejected, invalid/expired/untrusted imports cannot grant permissions.
3. CLEO transport semantic alignment: depend on immutable authenticated principal cutover and durable cursor task T117; AC: accepted/delivered/acked/task-completed are independent, reconnect resumes arrival cursor, duplicate event handling is idempotent.
4. Optional A2A task gateway investigation: depend on card fixtures and semantic alignment; AC: cancellation authorization, unknown outcome recovery, terminal task states and artifact handling specified/tested before publishing executable interfaces.
5. Project-topic subscription isolation: coordinate existing topic task; AC: two-project cross-delivery rejection, bounded subscriptions and cancellation that never ACKs or releases mailbox.

## Coverage and limits
Audited official source files and local contracts; no interoperability server or competitor runtime benchmark was executed. Full CLEO task-handler and card implementation coverage is incomplete; source cards in this AgentMBX checkout were not found. Existing planning must be reconciled rather than replaced. T118 diagnostics remain a separate core deliverable.

### Existing integration dependencies and exact mappings
Reconcile proposals with T063/T065/T066/T068/T071 before filing implementation tasks; their current acceptance scope must be fetched by the orchestrator. No new overlapping task was filed in this audit.

CLEO pinned source: [conduit.ts accepted/delivered L125-L160](https://github.com/kryptobaseddev/cleo/blob/440a16368447592747c4fd15ae85211923f2096d/packages/contracts/src/conduit.ts#L125-L160), [transport.ts poll/ack L63-L67](https://github.com/kryptobaseddev/cleo/blob/440a16368447592747c4fd15ae85211923f2096d/packages/contracts/src/transport.ts#L63-L67). Repository origin verified as kryptobaseddev/cleo; local source is the verified evidence, and hosted availability of the revision was not separately checked.

| MBX observation | CLEO/A2A mapping |
| --- | --- |
| send accepted locally | acceptedAt; deliveredAt remains null until actual destination delivery |
| destination stored delivery | transport delivery only; no work result |
| notified | wake adapter evidence only; no processed claim |
| read | mailbox observation only; no processed claim |
| acked | mailbox recipient acknowledgement only; existing MBX behavior unchanged |
| processed/completed | requires independently authorized task evidence; cannot infer from any mailbox state |

[MBX experimental adapter L194-L207](https://github.com/kryptobaseddev/agentmbx/blob/324a2864b85ff6abfb3c5a8ba51af3bffcfc05b3/test/conduit-transport.test.ts#L194-L207) explicitly labels its unauthenticated mailbox principal and ack translation invented. Immutable authenticated principal cutover and semantic conformance are prerequisites to production integration, not guarantees currently shipped.
