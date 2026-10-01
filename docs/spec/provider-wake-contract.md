# Provider wake capability contract

## Goal

T177 specifies proposed decision D005: provider wake adapters report narrow exact-session outcomes, and the shared mailbox core keeps owner authority, lease/generation checks, mute, brakes and status-only suppression. MUST/MUST NOT/SHOULD/MAY follow RFC 2119. Requirements are implementation targets for T178 (adapter refactor onto this contract) and T179 (persistent attempts and reconciliation); nothing here is claimed shipped except where the current-behavior tables say so. Source references are at `a2dcdd6`. Types live in `src/wake-contract.ts` (not yet wired into `src/wake.ts`); this revision changes no runtime behavior.

A wake is a no-body hint that asks an idle session to check its mailbox. Admission of that hint is never model execution, mailbox read, reply, ACK or task completion. Desktop notices are human notices, not session wakes.

## Terms

- **Attempt**: one submission of one hint for a fixed message-ID set to one exact session under one captured lease generation (`WakeAttempt`).
- **Exact session**: the provider-native session/thread id on the held binding (`sessions.session_id`), verified by `captureWakeIdentity` (`src/wake-identity.ts:13-42`). An *inferred* target is resolved by other means (directory, newest session) and is not exact.
- **Generation**: `identityGeneration(lease token)` (`src/identity-control.ts:30`) captured with the binding; a changed generation fences the attempt.
- **Receipt strength**: `native` (provider id correlated to session and payload), `exit-status` (CLI exit 0 only), `transport` (write to the session's own stdio), `none`.

## Requirements

### Core responsibilities (non-delegable)

1. Core MUST decide, before any adapter call and without adapter input: wake wanted (`wantsWake`, `src/node.ts:665-669`), status-only suppression, current wake authority (`hasWakeAuthority`, `src/wake.ts:20-21`), mute, brakes and budget reservation (`reserveWake`, `src/node.ts:677-693`), and exact-session identity capture (`captureWakeIdentity`).
2. Core MUST supply the adapter a `SubmitGuard.recheck` bound to the captured generation and the message set's `delivered` state and authority (current form: `src/wake.ts:239-244`). Core MUST recheck after the adapter returns and before recording any delivery state (current: `src/wake.ts:252`, `src/wake.ts:297`). A failed post-submission recheck MUST NOT mark mail notified under the old generation.
3. Adapters MUST NOT evaluate or widen policy, lease, mute, brakes or owner authority, MUST NOT choose a different session than the attempt target, MUST NOT approve native permission prompts, and MUST NOT receive lease tokens, control keys, owner keys or message bodies. The permission profile of the woken session is unchanged by a wake; YOLO approval stays in `src/permission.ts` under its own owner-policy check.
4. Core MUST build the hint (`wakeText` + `policyBrief`, `src/wake.ts:23-29`, `src/wake.ts:233`). The hint MUST NOT contain message bodies or subjects' content beyond counts, senders and trust labels.
5. Core MUST persist attempt identity, outcome and sanitized receipt before treating the attempt as settled (T179). Core MUST map outcomes to delivery state and budget only through `retryAdvice` semantics below; string matching on adapter errors (current `src/wake.ts:280`) MUST be removed.
6. After an `unknown` outcome, core MUST NOT submit the same message set to any other session in the same pass. (Current loop continues to the next session on any non-ok, non-retry result: `src/wake.ts:237-254`.)

### Adapter responsibilities

1. An adapter MUST declare `WakeCapabilities` and MUST only perform native submission, optional busy inspection, optional idempotency lookup and receipt parsing.
2. An adapter MUST call `guard.recheck()` after all asynchronous preflight (service discovery, busy/status, model lookup) and immediately before the native write; if false it MUST return `not_submitted/fenced` without writing (current: `src/wake.ts:54`, `src/wake.ts:143`).
3. An adapter MUST validate every receipt field it relies on and MUST NOT follow redirects (current: `src/wake.ts:57`, `src/wake.ts:62-65`, `src/wake.ts:144-149`).
4. An adapter MUST classify by what it can prove: a write that may have reached the provider without a correlated receipt is `unknown`, never `failed` and never `not_submitted`.
5. Receipts MUST be sanitized: ids and state words only; no auth headers, tokens, service passwords or payload echoes.

### Capability declaration

| Capability | Values | Meaning |
|---|---|---|
| `exactSession` | `native` / `inferred` / `none` | Addresses the bound id; resolves a target another way; cannot target a session. |
| `busyInspection` | boolean | Can report busy without submitting. |
| `admissionReceipt` | `native` / `exit-status` / `transport` / `none` | Strongest evidence an `admitted` outcome carries. |
| `idempotencyLookup` | boolean | Can answer whether a past attempt was admitted, by attempt/idempotency key. |
| `channelDelivery` | boolean | Delivery runs in the session's own MCP process, not the daemon. |
| `noticeOnly` | boolean | Human notice only; never a session wake. |
| `testedVersions`, `versionProbe` | list; `none`/`cli`/`service` | Provider versions the declaration was verified against, and how the running version is learned. |

1. Capabilities MUST be declared per provider and SHOULD be keyed by provider version range. An unverified or unknown provider version MUST use the conservative declaration: no busy inspection, no idempotency lookup, and receipt strength no higher than proven by the running response shape.
2. A missing capability MUST be reported as absent and handled by the honest fallback in the mapping table; it MUST NOT be simulated (for example, a CLI exit 0 MUST NOT be reported as a `native` receipt).
3. An `inferred` target MUST be recorded as such in the attempt and receipt and MUST NOT be reported as exact-session admission.

### Outcomes and retry semantics

| Outcome | Adapter proves | Terminal | Next | Resubmit | Refund budget | Delivery |
|---|---|---|---|---|---|---|
| `not_submitted` | Nothing reached the provider (no target, service down, preflight/status error, fenced before write). | no | next pass (`unsupported`: hold) | yes (not for `unsupported`) | yes | stays `delivered` |
| `admitted` | Provider accepted the hint for the exact session, with receipt of declared strength. | yes | none | no | no | `notified` |
| `busy` | Exact session is mid-turn; nothing submitted. | no | next pass, no backoff spend | yes | yes | stays `delivered` |
| `blocked` | A gate the adapter must not bypass stopped submission (native approval, notifications off, auth, model unconfigured, disabled). | yes | hold, surface diagnostic | no | yes | stays `delivered` |
| `unknown` | The write may have reached the provider; no correlated receipt (timeout after send, lost response, malformed or mismatched receipt on success status, killed process). | no | reconcile via lookup if capable, else hold | no | no | not re-woken until reconciled |
| `failed` | Provider answered with a definite rejection; nothing admitted. | no | bounded backoff | yes | no | stays `delivered` |

`isTerminal` and `retryAdvice` in `src/wake-contract.ts` encode this table. Core-only skips (`WakeSkip`: status-only, not-wanted, no-authority, muted, braked, batched, fenced, no-capable-target) are not adapter outcomes and MUST be recorded separately.

1. `admitted` MUST mean queued or started at most. Kimi `status: "blocked"` on an accepted prompt (`src/wake.ts:148`) is `admitted` with `nativeStatus: "blocked"`; it is not the `blocked` outcome and not progress.
2. `unknown` MUST NOT be retried as a fresh prompt. With `idempotencyLookup`, core MUST call `lookup` for the same attempt and act on its answer; without it, core MUST hold the attempt for operator action or a new binding and report it. A desktop notice MAY still be shown.
3. `busy` and `not_submitted` MUST NOT spend wake budget: the reservation for that attempt MUST be released by its own identity (current release primitive: `src/node.ts:686-691`). Budget of any earlier attempt in the pass with a non-refundable outcome MUST be retained (current intent: `src/wake.ts:286-288`).
4. `failed` retries MUST be bounded by the existing brakes (`WAKE_LIMITS`, `src/node.ts:26`) plus a backoff; they MUST NOT loop within a pass.
5. `blocked` MUST NOT be retried automatically; it MUST produce a truthful diagnostic naming the gate.

### Receipt correlation

1. Every attempt MUST carry `attemptId`, `idempotencyKey`, agent, ordered message IDs, target `{cli, sessionId, support}`, captured generation and creation time.
2. An `admitted` receipt MUST record strength, native id (or null), echoed session id (or null), native status and provider version (or null). With `native` strength the echoed session MUST equal the target and the echoed payload MUST equal the hint (current OpenCode check: `src/wake.ts:62-64`); any mismatch after a success status is `unknown/mismatched-receipt`.
3. Receipts MUST be stored separately from delivery, read and ACK state. A receipt MUST NOT advance `read` or `acked` (`src/store.ts:10`) and MUST NOT grant policy.
4. Reconciliation MUST use the same `attemptId`/`idempotencyKey`; a new attempt identity MUST NOT be minted to retry an `unknown`.

### Busy and deferral

1. Busy inspection MUST be read-only and MUST run on the exact target. A busy result MUST keep mail `delivered` and release the reservation (current dispatcher probe `src/wake.ts:88-99`, `src/wake.ts:224-228`; adapter check `src/wake.ts:133-135`).
2. A failed busy probe MUST NOT be reported as idle-and-admitted; the adapter's pre-submit status check remains fail-closed (current `src/wake.ts:134`). The dispatcher-level probe is fail-open (`src/wake.ts:96`) and MUST remain an optimization only.
3. A provider-side stop/continue hook MAY surface mail mid-turn (`src/cli.ts:816-830`); it is budgeted by `allowContinue` (`src/node.ts:312-319`) and is not a wake outcome.

### Status-only suppression and fallback

1. Core MUST NOT wake for messages of kind `status`, regardless of mentions or `needs_reply`. Current `wantsWake` wakes any kind when `needs_reply` or a mention is present (`src/node.ts:667-668`); T178 MUST close this. Non-wake mail stays in the inbox and is marked `notified` without a hint (current `src/wake.ts:218-220`).
2. When no bound session has a capable adapter, or the message lacks wake authority, core MUST fall back honestly: desktop notice where available, next-prompt surfacing by hooks (`src/cli.ts:813`), and the self-watch instruction for no-push sessions (`src/mcp.ts:150-167`). A fallback MUST NOT be reported as an admitted wake. Mail reaching only the desktop MUST stay re-wakeable when a capable session binds (current `src/wake.ts:295-296`, `src/node.ts:195-196`).
3. Mute (planned; no mute control exists at `a2dcdd6`) MUST be a core gate evaluated with brakes; muted mail MUST remain searchable, replayable and unread, and MUST NOT produce hints or desktop notices.

## Current provider mapping

| Provider | Path | exactSession | busyInspection | admissionReceipt | idempotencyLookup | channel | Honest fallback today |
|---|---|---|---|---|---|---|---|
| Codex | `codex queue --thread <id>` (`src/wake.ts:35-38`) | native | none | exit-status | none | no | Desktop notice; next-prompt hook; Stop-hook continue. |
| OpenCode | `POST /api/session/<id>/synthetic` (`src/wake.ts:50-69`) | native; `inferred` for the `mcp-` directory fallback (`src/wake.ts:259-278`, `src/wake.ts:71-80`) | none | native (`msg_` id, session, payload, created) | none | no | Desktop notice. |
| Kimi web | `POST /api/v1/sessions/<id>/prompts` (`src/wake.ts:127-153`), hosted only (`src/kimi-web.ts:51-59`) | native | status endpoint (`src/wake.ts:111-118`) | native (`prompt_id`, status; session not echoed) | none | no | Terminal TUI sessions: no push (`src/mcp.ts:167`); self-watch; Stop hook exit 2. |
| Kimi desktop (T033) | daimon control socket, JSON-RPC `conversations.send` (`src/wake.ts` wakeKimiDesktop, `src/kimi-desktop.ts`) | native: `conversations.list` maps the bound kernel session id to its conversation | `conversations.getBusy`; error -32010 → `busy` | native (`turnId`, `accepted`, session echoed) | none | no | Session linked by bind ticket (`src/bind-ticket.ts`); unlinked: desktop notice. |
| Kimi terminal (T033) | none from outside: the session's own background `agentmbx watch` exits on mail and Kimi starts a turn from the task completion | native (caller's lease) | n/a | transport (the watcher printed the hint) | mute, brake | no | `[mbx-watch]` cron with `MBX_SELF_WATCH=<minutes>`; Stop hook exit 2. |
| Claude socket (T202) | NDJSON push to `CLAUDE_CODE_MESSAGING_SOCKET` from the session's own MCP process (`src/mcp.ts` socketPush) | native (own process) | none | transport | mute, brake | no | The no-channel push: a plainly started `claude` wakes with no flag. |
| Claude channel | `notifications/claude/channel` from the session's MCP process (`src/mcp.ts:784-810`) | native (own process) | none | transport (JSON-RPC notification has no response) | none | yes | Without channel: no push; prompt/post-tool hooks (`src/cli.ts:813`); self-watch. |
| Desktop | AgentMBX.app notifier, osascript, notify-send (`src/wake.ts:173-202`) | none | n/a | none | none | no | Is the fallback; exit 3 means notifications off (`src/wake.ts:197`) → `blocked/notifications-off`. |
| Hermes | MCP only (`src/mcp.ts:195`, `src/setup.ts:292-293`) | none | none | none | none | no | No push; self-watch instruction; desktop notice. |

No path is version-pinned: `testedVersions` is empty for all, and `KimiInstance.host_version` (`src/kimi-web.ts:12`) is read but unused. `CURRENT_CAPABILITIES` in `src/wake-contract.ts` records this table as data.

### Outcome mapping of current results (T178 target)

| Current result | Contract outcome |
|---|---|
| OpenCode service missing (`src/wake.ts:52`); Kimi not hosted (`src/wake.ts:129`); Kimi status error (`src/wake.ts:134`) | `not_submitted` (`unavailable` / `no-target` / `preflight`) |
| `wake authority changed` before write (`src/wake.ts:54`, `src/wake.ts:143`); `captureWakeIdentity` null | `not_submitted/fenced` |
| Kimi `session busy` retry (`src/wake.ts:135`) | `busy` |
| OpenCode valid receipt (`src/wake.ts:67`); Kimi `running`/`queued`/`blocked` receipt (`src/wake.ts:151`) | `admitted` (native) |
| Codex exit 0 (`src/wake.ts:36`) | `admitted` (exit-status) |
| Codex non-zero exit with provider error output | `failed` |
| Codex timeout/kill (20 s, `src/wake.ts:36`); OpenCode/Kimi fetch abort or network error after the write started (`src/wake.ts:57`, `src/wake.ts:144`) | `unknown` (`timeout` / `killed` / `lost-response`) |
| OpenCode 2xx with invalid or mismatched receipt (`src/wake.ts:65`); Kimi code 0 with invalid receipt (`src/wake.ts:149`) | `unknown` (`malformed-receipt` / `mismatched-receipt`) |
| OpenCode non-2xx (`src/wake.ts:58`); Kimi non-zero code on prompts (`src/wake.ts:146`) | `failed` (Kimi `MODEL_NOT_CONFIGURED`: `blocked/model-unconfigured`) |
| Desktop exit 3 (`src/wake.ts:197`); `MBX_NO_DESKTOP` (`src/wake.ts:190`) | notice `blocked/notifications-off`, `blocked/disabled` |

### Divergences found at this revision (as of a2dcdd6; items 1–6 closed by T178/T179, shipped in v0.5.1)

1. Any adapter error collapses to `{ok:false}` and falls through to the next session and then desktop (`src/wake.ts:253`, `src/wake.ts:294`); ambiguous timeouts and malformed receipts are indistinguishable from definite rejections.
2. The OpenCode `mcp-` directory fallback wakes the newest session in a directory (`src/wake.ts:72-80`), not the exact bound session, and reports the same `ok` as an exact wake.
3. Status messages with a mention or `needs_reply` wake (`src/node.ts:667-668`).
4. Refund after fencing depends on matching the error string `"wake authority changed"` (`src/wake.ts:280`).
5. The Claude channel path uses `takeWake` (non-refundable, `src/node.ts:672-674`) and a lease `withHeld` check rather than `captureWakeIdentity`; a failed notification leaves its budget spent (`src/mcp.ts:794-808`).
6. Kimi prompt `status: "blocked"` is reported as the same success as `running` (`src/wake.ts:148-151`).

### Live receipts and open receipt gaps (v0.5.1, T091/T180)

Real idle sessions were woken on 2026-10-01 against the release candidate (evidence in `.cleo/cache/evidence/`):

| Provider (version) | Path | Admission receipt | Model ran, read, replied, acked | Evidence |
|---|---|---|---|---|
| Claude Code (MacBook and Fedora) | session socket | transport | yes, both directions, ~1.5 s | t151-physical-lan.txt |
| Codex CLI 0.159.2 | `codex queue` | exit-status | yes | t180-codex-wake.txt |
| OpenCode 2.0.20 | synthetic (service) | native `msg_` id | yes | t180-opencode-wake.txt |
| Kimi Code 2.1.1 terminal | `agentmbx watch` exit | transport | yes | t033-kimi-terminal-watcher.txt |
| Kimi desktop 3.2.12 | control `conversations.send` | native turnId | yes | t033-kimi-desktop-wake.txt |
| Kimi web 2.1.1 | prompts API | native prompt id | yes | t033-kimi-web-wake.txt |
| any, fail-closed | desktop notice when the sender is over the relay allowance | none | n/a (Codex probe 1) | t180-codex-wake.txt |

Open gaps, each reproducible:
- Hermes has no wake adapter (deferred, T189): mail waits for its next prompt or a desktop notice.
- Codex admission is exit-status only: `codex queue` returns no native id, so a queued-but-lost hint cannot be told apart from a delivered one.
- A `kimi web` server started before `agentmbx setup` runs no hooks, so its conversations never get a bind ticket and are not woken (doctor flags it; restart the server).
- Kimi web conversations in manual approval mode stop on every mbx tool call until approved (observed in the web test).
- The Claude channel path (`agentmbx claude`) was not re-proven live in this release; the socket push replaced it as the default.

## Testable requirements

Each item names the implementing task. Fixtures MUST use synthetic native endpoints or stub CLIs (as in `test/wake-dispatch.test.ts`, `test/opencode-response-contract.test.ts`, `test/kimi-response-contract.test.ts`); live receipts remain T091.

| ID | Requirement | Task |
|---|---|---|
| WC-01 | Every adapter returns exactly one `WakeOutcome` kind; no adapter returns core skips. | T178 |
| WC-02 | Lease generation change between capture and write: zero native writes, `not_submitted/fenced`, reservation refunded, mail `delivered`. | T178 |
| WC-03 | Generation change after write: no delivery state change under the old generation; receipt retained. | T178 |
| WC-04 | Adapters receive no lease token, control key, owner key or message body (assert on the attempt object and on native request bodies). | T178 |
| WC-05 | Adapters never call policy, lease, mute or brake functions (module import boundary check, as `src/wake-check.ts` does for Kimi). | T178 |
| WC-06 | Kind `status` never wakes, with or without mention/`needs_reply`; the mail stays unread and searchable. | T178 |
| WC-07 | Mismatched session/payload in a success response → `unknown/mismatched-receipt`, not `admitted`, not `failed`. | T178 |
| WC-08 | Timeout or connection reset after the write → `unknown`; no second native write in the pass, to that or any other session. | T178 |
| WC-09 | Busy → no write, reservation refunded, mail `delivered`, next pass retries; busy race after status check is classified by the provider's answer. | T178 |
| WC-10 | Codex exit 0 records `exit-status` strength; OpenCode/Kimi record `native`; Claude channel records `transport`. | T178 |
| WC-11 | No directory or newest-session inference: only the exact leased session is woken (owner decision 2026-09-30); the OpenCode directory fallback is removed. | T178 |
| WC-12 | No capable target: desktop notice or no-push fallback, never `admitted`; mail re-wakeable on capable bind. | T178 |
| WC-13 | Kimi `blocked` prompt status → `admitted` with `nativeStatus: "blocked"`. | T178 |
| WC-14 | Attempt identity, outcome and receipt persist; crash after admission and before delivery update reconciles to one admitted attempt, not a second write. | T179 |
| WC-15 | `unknown` without lookup holds and reports; with lookup, reconciles the same `attemptId`. | T179 |
| WC-16 | `failed` retries back off within `WAKE_LIMITS`; no notification loop. | T179 |
| WC-17 | Mute gate suppresses hints and desktop notices while mail stays unread, searchable and replayable. | T179 |
| WC-18 | Receipt, admission and notices never advance `read`/`acked` or widen policy. | T178/T179 |

## Decisions

Owner decisions, 2026-09-30:

- A `status` message never wakes, with or without a mention or `needs_reply` (WC-06). Senders learn this from the skill's kind table, the `mbx_send` kind description and a send-result warning when a status message carries a mention or `needs_reply`.
- Wakes target the exact session that currently holds the mailbox lease. The OpenCode directory fallback is removed (WC-11). An `mcp-` process binding without a real session id gets the notice fallback, and its mail is woken again once the exact session binds.

Implementation defaults (T178), pending review: `failed` does not refund the wake budget. An `unknown` is held with delivery note `unknown`, with no second native write and no desktop notice, until T179 reconciliation. A Kimi `blocked` prompt is `admitted` with `nativeStatus: "blocked"`. Mute scope and signing remain open for T179.

## Non-goals

No framework rewrite, no new provider integrations, no change to message storage, ACK, policy classes or permission approval, and no claim that admission, notice or channel push proves model execution.
