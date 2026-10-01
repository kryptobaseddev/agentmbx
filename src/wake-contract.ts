// Provider wake contract (T177, proposed D005; spec docs/spec/provider-wake-contract.md). Types plus one pure helper.
// Not wired into wake.ts yet (T178). Core keeps authority, lease/generation, mute, brakes and status-only suppression;
// an adapter only submits a no-body hint to one exact native session and parses what the provider answered.
// No outcome here means the model ran, read, replied, acked or completed a task.

export type WakeProvider = "codex" | "opencode" | "kimi" | "claude" | "hermes" | "desktop";

/** How an adapter reaches a session: `native` addresses the exact bound session id; `inferred` resolves one (e.g. by
 *  directory) and MUST be declared, never presented as exact; `none` cannot target a session at all. */
export type TargetSupport = "native" | "inferred" | "none";
/** Strength of admission evidence: correlated native id+session+payload, CLI exit status, stdio transport write, none. */
export type ReceiptStrength = "native" | "exit-status" | "transport" | "none";

export interface WakeCapabilities {
  readonly provider: WakeProvider;
  /** Provider versions this declaration was verified against; empty means unverified (conservative defaults apply). */
  readonly testedVersions: readonly string[];
  /** How the adapter learns the running provider version, if at all. */
  readonly versionProbe: "none" | "cli" | "service";
  readonly exactSession: TargetSupport;
  /** Can report "busy" before submitting, without submitting. */
  readonly busyInspection: boolean;
  readonly admissionReceipt: ReceiptStrength;
  /** Can answer "was this attempt admitted?" by attempt/idempotency key after a lost response. */
  readonly idempotencyLookup: boolean;
  /** Delivery runs inside the session's own MCP process (Claude channel), not through the daemon. */
  readonly channelDelivery: boolean;
  /** Only a human-facing notice (desktop); never a session wake. */
  readonly noticeOnly: boolean;
}

/** One submission of one wake hint for a fixed message set to one exact session under one lease generation. */
export interface WakeAttempt {
  readonly attemptId: string;
  /** Stable across reconciliation of this attempt; providers with idempotencyLookup receive it. */
  readonly idempotencyKey: string;
  readonly agent: string;
  readonly messageIds: readonly string[];
  readonly target: { readonly cli: string; readonly sessionId: string; readonly support: TargetSupport };
  /** Opaque lease generation (identityGeneration of the held token), captured before submission. */
  readonly generation: string;
  /** No-body pointer text (wakeText + policyBrief); MUST NOT contain message bodies. */
  readonly hint: string;
  readonly createdAt: string;
}

/** Sanitized native evidence: ids and states only, never tokens, auth headers or payload bodies. */
export interface WakeReceipt {
  readonly strength: ReceiptStrength;
  readonly nativeId: string | null;
  /** Session id the provider echoed; null when the provider echoes none. */
  readonly sessionId: string | null;
  /** Provider's own state word (e.g. kimi "running" | "queued" | "blocked"); informational only. */
  readonly nativeStatus: string | null;
  readonly providerVersion: string | null;
}

interface Base { readonly attemptId: string; readonly via: string; readonly detail?: string }

/** Adapter-reported outcome. Retry semantics live in retryAdvice; see the spec's outcome table. */
export type WakeOutcome =
  /** Proven that nothing reached the provider (preflight failed, no target, service down, fenced before send). */
  | Base & { readonly kind: "not_submitted"; readonly reason: "no-target" | "unavailable" | "fenced" | "unsupported" | "preflight" }
  /** Provider accepted the hint for the exact session. Queued/started at most; not execution, read or ACK. */
  | Base & { readonly kind: "admitted"; readonly receipt: WakeReceipt }
  /** Exact session is mid-turn; nothing submitted. */
  | Base & { readonly kind: "busy" }
  /** A gate the adapter must not bypass stopped submission; nothing admitted. Needs a person, not a retry loop. */
  | Base & { readonly kind: "blocked"; readonly gate: "native-approval" | "notifications-off" | "auth" | "model-unconfigured" | "disabled" }
  /** Submission may have reached the provider but no correlated receipt proves either way. Never blindly resubmitted. */
  | Base & { readonly kind: "unknown"; readonly reason: "timeout" | "lost-response" | "malformed-receipt" | "mismatched-receipt" | "killed" }
  /** Provider answered with a definite rejection; nothing admitted. */
  | Base & { readonly kind: "failed"; readonly status: number | null };

export type WakeOutcomeKind = WakeOutcome["kind"];

/** Core-only decisions made before any adapter call; adapters never produce these. */
export type WakeSkip = "status-only" | "not-wanted" | "no-authority" | "muted" | "braked" | "batched" | "fenced" | "no-capable-target";

/** Supplied by core. The adapter calls recheck() immediately before its native write and returns not_submitted/fenced
 *  when false; core rechecks again after the adapter returns. The adapter cannot answer authority itself. */
export interface SubmitGuard { readonly recheck: () => boolean; readonly signal: AbortSignal }

export interface WakeAdapter {
  readonly capabilities: WakeCapabilities;
  submit(attempt: WakeAttempt, guard: SubmitGuard): Promise<WakeOutcome>;
  /** Present only when capabilities.idempotencyLookup; answers admitted | not_submitted | unknown for a past attempt. */
  lookup?(attempt: WakeAttempt, signal: AbortSignal): Promise<WakeOutcome>;
}

export interface RetryAdvice {
  /** none: settled; next-pass: retry on the next dispatcher pass; backoff: bounded delayed retry; reconcile: lookup
   *  the same attempt first; hold: keep mail, surface diagnostics, wait for a person or a new binding. */
  readonly next: "none" | "next-pass" | "backoff" | "reconcile" | "hold";
  /** A fresh submission of the same hint is allowed on the next try. */
  readonly resubmit: boolean;
  /** The reserved wake budget may be released: nothing was admitted by this attempt. */
  readonly refund: boolean;
  /** The delivery row stays `delivered` (not marked notified by this attempt). */
  readonly keepDelivered: boolean;
}

/** Settled: no further automatic submission for this message set follows from this outcome. */
export const isTerminal = (o: WakeOutcome): boolean => o.kind === "admitted" || o.kind === "blocked";

/** Retry semantics per outcome. `canLookup` is the adapter's idempotencyLookup capability. */
export function retryAdvice(o: WakeOutcome, canLookup = false): RetryAdvice {
  switch (o.kind) {
    case "admitted": return { next: "none", resubmit: false, refund: false, keepDelivered: false };
    case "not_submitted": return { next: o.reason === "unsupported" ? "hold" : "next-pass", resubmit: o.reason !== "unsupported", refund: true, keepDelivered: true };
    case "busy": return { next: "next-pass", resubmit: true, refund: true, keepDelivered: true };
    case "blocked": return { next: "hold", resubmit: false, refund: true, keepDelivered: true };
    case "unknown": return { next: canLookup ? "reconcile" : "hold", resubmit: false, refund: false, keepDelivered: false };
    case "failed": return { next: "backoff", resubmit: true, refund: false, keepDelivered: true };
  }
}

const none = { testedVersions: [], versionProbe: "none", busyInspection: false, idempotencyLookup: false, channelDelivery: false, noticeOnly: false } as const;
/** What each current path provides at this revision (spec "Current provider mapping"); data only, not yet consumed. */
export const CURRENT_CAPABILITIES: Readonly<Record<WakeProvider, WakeCapabilities>> = {
  codex: { ...none, provider: "codex", exactSession: "native", admissionReceipt: "exit-status" },
  opencode: { ...none, provider: "opencode", exactSession: "native", admissionReceipt: "native" },
  kimi: { ...none, provider: "kimi", exactSession: "native", busyInspection: true, admissionReceipt: "native" },
  claude: { ...none, provider: "claude", exactSession: "native", admissionReceipt: "transport", channelDelivery: true },
  hermes: { ...none, provider: "hermes", exactSession: "none", admissionReceipt: "none" },
  desktop: { ...none, provider: "desktop", exactSession: "none", admissionReceipt: "none", noticeOnly: true },
};
