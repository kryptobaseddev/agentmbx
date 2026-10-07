// mbx.status/v2 (T404): the one status model every renderer consumes — the Claude mod (band/pane) and the
// OpenCode sidebar read it through the T407 loopback endpoint, the CLI emits it (T406), and the cloud repo
// imports THIS module at a pinned tag as the contract. The daemon computes it; adapters render and hold
// zero business logic. Versioned additively: v1 renderers (statusline adapters) keep working untouched.
//
// The shape matches plugins/claude/fixtures/v2-*.json on feat/t401-claude-mod — that is the consumer
// contract. Fields the daemon cannot source honestly yet are null (cloud.account until the T402 sync
// client links an account; devices[].last_presence until presence tracking lands), never invented.
export const STATUS_V2_SCHEMA = "mbx.status/v2" as const;

export type StatusV2ResolvedBy = "session_id" | "pid" | "none";

export interface StatusV2Identity {
  name: string | null;
  role: string | null;
  state: "bound" | "unbound" | "ambiguous";
  candidates?: string[];
}

/** The identity lease this (cli, session) holds, when it holds one. `verified` means process evidence
 * proves the recorded holder pid alive at its recorded birth time (identityLeaseStatus "live"). */
export interface StatusV2Lease {
  holder_cli: string;
  holder_session: string;
  verified: boolean;
}

export interface StatusV2Cloud {
  relay: { url: string | null; state: string; last_ack: string | null };
  key_ad_expiry: string | null;
  account: string | null;
}

export interface StatusV2Device {
  host: string;
  address: string;
  reachability: string;
  last_presence: string | null;
}

export interface StatusV2Project {
  directory: string;
  lead: string | null;
  members: string[];
}

export interface StatusV2 {
  schema: typeof STATUS_V2_SCHEMA;
  mbx_version: string;
  identity: StatusV2Identity;
  registration: { registered: boolean; lease: StatusV2Lease | null };
  inbox: { unread: number; needs_reply: number; from_owner: number; outbox_unsent: number };
  harness: { cli: string; session_id: string | null; wake_path: string; policy: string[] };
  cloud: StatusV2Cloud;
  devices: StatusV2Device[];
  project: StatusV2Project | null;
  resolved_by: StatusV2ResolvedBy;
}
