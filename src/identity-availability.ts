// One answer to "can this identity be claimed now?", used by both mbx_identity list and the claim itself (T204, R4.3), so
// a name the list calls available is never refused by the claim for a reason the list didn't show.
import { identityLeaseStatus, type IdentityLease, type ProcessEvidence } from "./identity-leases.ts";

/**
 * A conversation of a shared provider process (Codex or OpenCode transport, hosted Kimi) that made no mbx call and fired
 * no hook for this long can be taken over by an explicit claim: closing such a conversation does not end its process, so
 * its lease never expires on its own. A dedicated session process (Claude, terminal Kimi) is never taken over this way.
 */
export const SHARED_IDLE_MS = 10 * 60_000;
export const activityKey = (name: string) => `lease-activity:${name}`;
export interface LeaseActivity { at: number; shared: boolean }

export function parseActivity(raw: string | null | undefined): LeaseActivity | null {
  if (!raw) return null;
  try {
    const a = JSON.parse(raw);
    return Number.isSafeInteger(a?.at) && typeof a?.shared === "boolean" ? { at: a.at, shared: a.shared } : null;
  } catch { return null; }
}

export type AvailabilityState = "free" | "offline" | "live" | "idle" | "unknown" | "conflict";
export interface Availability {
  claimable: boolean;
  state: AvailabilityState;
  reason: string;
  /** How a claim takes a still-held lease: from an idle shared-process conversation, or from an older process of the same session. */
  takeover?: "idle-conversation" | "same-session";
}

const minutes = (ms: number) => `${Math.max(1, Math.round(ms / 60_000))} min`;

export function identityAvailability(o: { lease?: IdentityLease; evidence: ProcessEvidence; activity: LeaseActivity | null; conflict?: boolean;
  now: number; caller?: { cli: string; sessionId: string } }): Availability {
  if (o.conflict) return { claimable: false, state: "conflict", reason: "historical ownership requires explicit owner recovery" };
  const lease = o.lease;
  if (!lease) return { claimable: true, state: "free", reason: "no session has held it under a lease" };
  const status = identityLeaseStatus(lease, o.now, o.evidence);
  if (status.state === "expired") return { claimable: true, state: "offline", reason: lease.released_at !== null ? lease.release_reason ?? "released" : status.reason ?? "expired" };
  const holder = `${lease.cli} session ${lease.session_id}`;
  if (status.state === "unknown") return { claimable: false, state: "unknown", reason: `held by ${holder}, whose process could not be verified right now; retry shortly` };
  if (o.caller && lease.cli === o.caller.cli && lease.session_id === o.caller.sessionId && !o.caller.sessionId.startsWith("mcp-"))
    return { claimable: true, state: "live", reason: `held by an older process of this same ${lease.cli} session`, takeover: "same-session" };
  const quiet = o.activity ? o.now - o.activity.at : null;
  if (o.activity?.shared && quiet !== null && quiet >= SHARED_IDLE_MS)
    return { claimable: true, state: "idle", reason: `held by ${holder} in a shared ${lease.cli} process with no mbx activity for ${minutes(quiet)} (that conversation has probably ended)`, takeover: "idle-conversation" };
  return { claimable: false, state: "live", reason: `held by live ${holder}${quiet !== null ? `, last mbx activity ${minutes(quiet)} ago` : ""}` };
}
