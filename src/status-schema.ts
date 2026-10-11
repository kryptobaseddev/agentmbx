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

// ---- mbx.agents/v1 (T496): the live agent roster `mbx_agents` returns ----------------------------------------------
// One row per persona. `state` comes from verified holder process evidence on this host (the same function a claim
// uses), never from last_seen; a row from a paired host is `remote` and unverified. Rows carry no unread or message
// counts (T308 AC2: no surface shows another identity's counts). Additive changes keep the schema string; a removed
// or retyped field means a new version.
export const AGENTS_V1_SCHEMA = "mbx.agents/v1" as const;

/** live: a verified session holds it. idle: held by a shared-process conversation quiet for 10 min (claimable).
 *  unknown: a holder exists but its process could not be verified right now. offline: nothing holds it.
 *  remote: listed by a paired host; this host cannot verify it. */
export const AGENT_STATES = ["live", "idle", "unknown", "offline", "remote"] as const;
export type AgentState = typeof AGENT_STATES[number];

export interface AgentsV1Row {
  name: string;
  host: string;
  address: string;
  state: AgentState;
  reason: string;
  role: string | null;
  description: string | null;
  /** Chosen with a role. False for a name an older version generated; null for a row from a paired host. */
  registered: boolean | null;
  /** Retired by identity prune; null for a row from a paired host. */
  retired: boolean | null;
  /** The harness of the verified holder; null unless the persona is live or idle. */
  harness: string | null;
  /** The last CLI the directory recorded for this name (compatibility with the pre-roster `cli` column). */
  cli: string | null;
  /** Project folders this persona is bound to on this host. */
  projects: string[];
  /** Project folders this persona is the owner-designated lead of. A role label of `lead` is not this (T393). */
  lead_of: string[];
  /** This is the calling session's own persona. */
  self: boolean;
  /** Listed because its live or idle session works in the calling session's folder while it is NOT a member of that
   *  project. Visibility only: nothing is written to identity_projects (T538). False for members, for the caller, and when
   *  the session has no project. */
  seen_here: boolean;
  last_seen: string | null;
  /**
   * Normalized git origins from a signed directory (T546). Absent when this host has not verified the row.
   * Folder paths stay in `projects`.
   */
  project_keys?: string[];
}

export interface AgentsV1 {
  schema: typeof AGENTS_V1_SCHEMA;
  host: string;
  observed_at: string;
  scope: {
    /** The calling session's project folder, null for the home folder or `/`. */
    project: string | null;
    /** `project: "*"` was asked: personas of every project. */
    all_projects: boolean;
    /** `all: true` was asked: retired and generated names are listed too. */
    include_hidden: boolean;
    /** Rows in scope that the default view left out (retired or generated, and not live or idle). */
    hidden: number;
  };
  /** This session's project lead only, as before; other projects' leads are rows with `lead_of`. */
  lead: { address: string; exp: string } | null;
  agents: AgentsV1Row[];
}

const isRec = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const strOrNull = (v: unknown) => v === null || typeof v === "string";
const boolOrNull = (v: unknown) => v === null || typeof v === "boolean";
const strList = (v: unknown) => Array.isArray(v) && v.every((x) => typeof x === "string");

/** Check a value against mbx.agents/v1. Returns the problems found, empty when it conforms. Extra keys are allowed
 *  (additive versioning); a missing or retyped key is not. No dependencies, so any importer can run it. */
export function validateAgentsV1(x: unknown): string[] {
  const bad: string[] = [];
  if (!isRec(x)) return ["not an object"];
  if (x.schema !== AGENTS_V1_SCHEMA) bad.push(`schema is not ${AGENTS_V1_SCHEMA}`);
  if (typeof x.host !== "string" || !x.host) bad.push("host is not a non-empty string");
  if (typeof x.observed_at !== "string" || Number.isNaN(Date.parse(x.observed_at))) bad.push("observed_at is not a timestamp");
  const s = x.scope;
  if (!isRec(s)) bad.push("scope is not an object");
  else {
    if (!strOrNull(s.project) || s.project === undefined) bad.push("scope.project is not a string or null");
    if (typeof s.all_projects !== "boolean") bad.push("scope.all_projects is not a boolean");
    if (typeof s.include_hidden !== "boolean") bad.push("scope.include_hidden is not a boolean");
    if (!Number.isInteger(s.hidden) || (s.hidden as number) < 0) bad.push("scope.hidden is not a non-negative integer");
  }
  if (x.lead !== null && !(isRec(x.lead) && typeof x.lead.address === "string" && typeof x.lead.exp === "string")) bad.push("lead is not null or {address, exp}");
  if (!Array.isArray(x.agents)) { bad.push("agents is not an array"); return bad; }
  x.agents.forEach((r, i) => {
    const at = `agents[${i}]`;
    if (!isRec(r)) { bad.push(`${at} is not an object`); return; }
    for (const k of ["name", "host", "address", "reason"] as const) if (typeof r[k] !== "string" || !r[k]) bad.push(`${at}.${k} is not a non-empty string`);
    if (!(AGENT_STATES as readonly unknown[]).includes(r.state)) bad.push(`${at}.state is not one of ${AGENT_STATES.join("|")}`);
    for (const k of ["role", "description", "harness", "cli", "last_seen"] as const) if (!strOrNull(r[k]) || r[k] === undefined) bad.push(`${at}.${k} is not a string or null`);
    for (const k of ["registered", "retired"] as const) if (!boolOrNull(r[k]) || r[k] === undefined) bad.push(`${at}.${k} is not a boolean or null`);
    for (const k of ["projects", "lead_of"] as const) if (!strList(r[k])) bad.push(`${at}.${k} is not a list of strings`);
    if (typeof r.self !== "boolean") bad.push(`${at}.self is not a boolean`);
    if (typeof r.seen_here !== "boolean") bad.push(`${at}.seen_here is not a boolean`);
    if (r.project_keys !== undefined && !strList(r.project_keys)) bad.push(`${at}.project_keys is not a list of strings`);
    if (r.harness !== null && r.state !== "live" && r.state !== "idle") bad.push(`${at}.harness is set but the persona is not live or idle`);
  });
  return bad;
}
