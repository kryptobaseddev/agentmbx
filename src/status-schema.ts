// mbx.status/v2 — the single status contract (saga T396, task T404).
//
// ONE model, computed ONCE by the daemon (T405 wires src/hud.ts to emit it), rendered by N thin
// adapters: statusline adapters (v1-compatible lines), the OpenCode 2 sidebar plugin (T399), the
// Claude Mod (T401) and the MBX cloud console (T402 imports this module at its pinned tag).
//
// Hard rules encoded here (lead, 2026-10-05):
//  - T308-AC2: a field scoped to a session can NEVER surface another identity's data; unresolved
//    means unbound/unknown, never a guess (no shared-directory fallback).
//  - v1 back-compat: every v1 field maps forward unchanged; v1 .line renderers keep working.
//  - T313: renderers do ONE file read per render; no SQL in any render path — only the daemon
//    computes, adapters import these types and render.
//  - T366: alert-only surfaces render empty when there is nothing to show.
//  - T393: the project section carries the owner-signed project-lead record.
export const STATUS_SCHEMA = "mbx.status/v2" as const;

/** How the daemon resolved the identity for this snapshot. */
export type StatusResolvedBy = "session_id" | "pid" | "none";

export interface StatusIdentity {
  name: string | null;
  role: string | null;
  state: "bound" | "unbound" | "ambiguous";
  /** Candidate names only when state is ambiguous; never populated for a bound identity. */
  candidates?: string[];
}

/** Registration state (v2): whether this identity is registered and who holds its lease. */
export interface StatusRegistration {
  registered: boolean;
  lease: {
    holder_cli: string | null;
    holder_session: string | null;
    /** True when the daemon proved the holder process alive this pass. */
    verified: boolean;
  } | null;
}

/** Inbox counters (v1 semantics, unchanged). */
export interface StatusInbox {
  unread: number;
  needs_reply: number;
  from_owner: number;
  outbox_unsent: number;
}

/** Cloud connection state (v2): relay enrollment and transport health. */
export interface StatusCloud {
  relay: {
    url: string | null;
    /** Configured/enrolled/reachable/down, from the daemon's own transport state. */
    state: "enrolled" | "configured" | "unreachable" | "unset";
    /** Last successful relay acknowledgement, ISO timestamp; null when never. */
    last_ack: string | null;
  };
  /** This host's published encryption key-ad expiry, ISO timestamp; null when not enrolled. */
  key_ad_expiry: string | null;
  /** Account link state once the cloud client (T224) ships; null until then. */
  account: { linked: boolean } | null;
}

/** One paired host (v2). Reachability is the daemon's evidence, not a ping from a renderer. */
export interface StatusDevice {
  host: string;
  address: string | null;
  state: "reachable" | "unreachable" | "never_seen";
  last_presence: string | null;
}

/** The project-lead record (T393): owner-signed, per project. */
export interface StatusProjectLead {
  agent: string;
  /** Owner-signed ledger revision identifier when present. */
  revision: string | null;
}

/** One agent working in this session's project (v2), for project connection health. */
export interface StatusProjectAgent {
  name: string;
  cli: string;
  liveness: "live" | "idle" | "gone";
  unread: number;
}

export interface StatusProject {
  directory: string;
  lead: StatusProjectLead | null;
  agents: StatusProjectAgent[];
}

/** Harness session context (v2): what the daemon bound this snapshot's consumer to. */
export interface StatusHarness {
  cli: string;
  session_id: string;
  /** The wake path the daemon would use for this binding. */
  wake_path: string | null;
  policy: string[];
}

/** The complete mbx.status/v2 snapshot. v1 fields keep their names and semantics. */
export interface StatusV2 {
  schema: typeof STATUS_SCHEMA;
  mbx_version: string;
  update_available: string | null;
  identity: StatusIdentity;
  registration: StatusRegistration;
  inbox: StatusInbox;
  cloud: StatusCloud;
  devices: StatusDevice[];
  project: StatusProject;
  harness: StatusHarness;
  resolved_by: StatusResolvedBy;
}
