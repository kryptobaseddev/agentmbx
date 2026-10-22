// Allowlisted mbx.status/v2 fields that may leave the machine (T423).
// Reviewed against the cloud threat model CT13: counts, enums, names the cloud
// already learns, and timestamps. Message subjects and bodies, filesystem paths,
// session ids, wake paths, relay URLs, keys and tokens are not copied.
// Contract 2 stays reserved for the T446 lead record. This object rides the
// contract-1 host report as an optional field.

const NAME_RE = /^[a-z0-9][a-z0-9-]{1,39}$/;
const ROLE_RE = /^[A-Za-z0-9][A-Za-z0-9 _-]{0,39}$/;
const HOST_RE = /^[a-z0-9][a-z0-9-]{1,39}$/;
const SEMVER_RE = /^\d{1,4}\.\d{1,4}\.\d{1,6}(?:-[0-9A-Za-z.-]{1,40})?$/;
const CLIS = new Set(["claude", "codex", "kimi", "opencode", "hermes", "grok", "agy", "cli", "unknown"]);
const LEVELS = new Set(["ask", "collaborate", "autonomous", "yolo"]);
const CLASSES = new Set(["read", "edit", "outward-reversible", "outward", "permissions"]);
const STATES = new Set(["live", "idle", "offline", "pending", "conflict", "free", "retired", "unknown"]);
const REACH = new Set(["reachable", "offline", "unknown"]);
const RESOLVED = new Set(["manual", "alias", "lease", "project_match", "ambiguous"]);

export interface StatusSync {
  schema: "mbx.status/v2";
  mbx_version: string;
  identities: Array<{
    name: string;
    role: string;
    state: "live" | "idle" | "offline" | "pending" | "conflict" | "free" | "retired" | "unknown";
    registered: boolean;
    lease: { holder_cli: string; verified: boolean } | null;
    unread: number;
    harness_cli: string;
    policy: { level: string; classes: string[] };
  }>;
  outbox_unsent: number;
  cloud: { relay_enrolled: boolean; last_ack: string | null; key_ad_expiry: string | null; account: string | null };
  devices: Array<{ host: string; reachability: "reachable" | "offline" | "unknown"; last_presence: string | null }>;
  projects: Array<{ lead: { name: string; cli: string } | null; members: string[] }>;
  resolved_by: "manual" | "alias" | "lease" | "project_match" | "ambiguous";
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function count(value: unknown): number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 1_000_000 ? value : 0;
}

function oneOf(value: unknown, allowed: Set<string>, fallback: string): string {
  return typeof value === "string" && allowed.has(value) ? value : fallback;
}

const STAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;

function stamp(value: unknown): string | null {
  return typeof value === "string" && STAMP_RE.test(value) && Number.isFinite(Date.parse(value)) ? value : null;
}

/** Copy only the allowlisted status fields. Returns undefined when the version or schema is not one the cloud can store. */
export function allowStatus(input: unknown): StatusSync | undefined {
  const src = record(input);
  if (!src || src.schema !== "mbx.status/v2") return undefined;
  const mbxVersion = text(src.mbx_version);
  if (!mbxVersion || !SEMVER_RE.test(mbxVersion)) return undefined;
  const identities = [];
  for (const row of Array.isArray(src.identities) ? src.identities : []) {
    const item = record(row);
    if (!item || identities.length >= 500) continue;
    const name = text(item.name);
    const role = text(item.role);
    if (!name || !NAME_RE.test(name) || !role || !ROLE_RE.test(role)) continue;
    const cli = text(item.harness_cli);
    const lease = record(item.lease);
    const holder = lease ? text(lease.holder_cli) : undefined;
    const policy = record(item.policy);
    const classes = Array.isArray(policy?.classes) ? policy.classes.filter((entry): entry is string => typeof entry === "string" && CLASSES.has(entry)).slice(0, 8) : [];
    identities.push({
      name,
      role,
      state: oneOf(item.state, STATES, "offline") as StatusSync["identities"][number]["state"],
      registered: item.registered === true,
      lease: holder ? { holder_cli: CLIS.has(holder) ? holder : "unknown", verified: lease?.verified === true } : null,
      unread: count(item.unread),
      harness_cli: cli && CLIS.has(cli) ? cli : "unknown",
      policy: { level: oneOf(policy?.level, LEVELS, "ask"), classes },
    });
  }
  const cloud = record(src.cloud);
  const devices = [];
  for (const row of Array.isArray(src.devices) ? src.devices : []) {
    const item = record(row);
    const host = item ? text(item.host) : undefined;
    if (!item || !host || !HOST_RE.test(host) || devices.length >= 64) continue;
    const presence = text(item.last_presence);
    devices.push({
      host,
      reachability: oneOf(item.reachability, REACH, "unknown") as StatusSync["devices"][number]["reachability"],
      last_presence: presence && Number.isFinite(Date.parse(presence)) ? new Date(Date.parse(presence)).toISOString() : null,
    });
  }
  const projects = [];
  for (const row of Array.isArray(src.projects) ? src.projects : []) {
    const item = record(row);
    if (!item || projects.length >= 64) continue;
    const lead = record(item.lead);
    const leadName = lead ? text(lead.name) : undefined;
    const leadCli = lead ? text(lead.cli) : undefined;
    const members = Array.isArray(item.members) ? item.members.filter((entry): entry is string => typeof entry === "string" && NAME_RE.test(entry)).slice(0, 50) : [];
    projects.push({
      lead: leadName && NAME_RE.test(leadName) ? { name: leadName, cli: leadCli && CLIS.has(leadCli) ? leadCli : "unknown" } : null,
      members,
    });
  }
  const resolved = text(src.resolved_by);
  return {
    schema: "mbx.status/v2",
    mbx_version: mbxVersion,
    identities,
    outbox_unsent: count(src.outbox_unsent),
    cloud: {
      relay_enrolled: cloud?.relay_enrolled === true,
      last_ack: stamp(cloud?.last_ack),
      key_ad_expiry: stamp(cloud?.key_ad_expiry),
      account: null,
    },
    devices,
    projects,
    resolved_by: (resolved && RESOLVED.has(resolved) ? resolved : "manual") as StatusSync["resolved_by"],
  };
}
