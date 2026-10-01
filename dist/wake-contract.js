// Provider wake contract (T177, proposed D005; spec docs/spec/provider-wake-contract.md). Types plus one pure helper.
// Not wired into wake.ts yet (T178). Core keeps authority, lease/generation, mute, brakes and status-only suppression;
// an adapter only submits a no-body hint to one exact native session and parses what the provider answered.
// No outcome here means the model ran, read, replied, acked or completed a task.
/** Settled: no further automatic submission for this message set follows from this outcome. */
export const isTerminal = (o) => o.kind === "admitted" || o.kind === "blocked";
/** Retry semantics per outcome. `canLookup` is the adapter's idempotencyLookup capability. */
export function retryAdvice(o, canLookup = false) {
    switch (o.kind) {
        case "admitted": return { next: "none", resubmit: false, refund: false, keepDelivered: false };
        case "not_submitted": return { next: o.reason === "unsupported" ? "hold" : "next-pass", resubmit: o.reason !== "unsupported", refund: true, keepDelivered: true };
        case "busy": return { next: "next-pass", resubmit: true, refund: true, keepDelivered: true };
        case "blocked": return { next: "hold", resubmit: false, refund: true, keepDelivered: true };
        case "unknown": return { next: canLookup ? "reconcile" : "hold", resubmit: false, refund: false, keepDelivered: false };
        case "failed": return { next: "backoff", resubmit: true, refund: false, keepDelivered: true };
    }
}
const none = { testedVersions: [], versionProbe: "none", busyInspection: false, idempotencyLookup: false, channelDelivery: false, noticeOnly: false };
/** What each current path provides at this revision (spec "Current provider mapping"); data only, not yet consumed. */
export const CURRENT_CAPABILITIES = {
    codex: { ...none, provider: "codex", exactSession: "native", admissionReceipt: "exit-status" },
    opencode: { ...none, provider: "opencode", exactSession: "native", admissionReceipt: "native" },
    kimi: { ...none, provider: "kimi", exactSession: "native", busyInspection: true, admissionReceipt: "native" },
    claude: { ...none, provider: "claude", exactSession: "native", admissionReceipt: "transport", channelDelivery: true },
    hermes: { ...none, provider: "hermes", exactSession: "none", admissionReceipt: "none" },
    desktop: { ...none, provider: "desktop", exactSession: "none", admissionReceipt: "none", noticeOnly: true },
};
