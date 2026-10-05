// Recovery inventory reads old and current stores without initializing, migrating or expiring them.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { inspectLeaseProcess, type IdentityLease, type ProcessEvidence } from "./identity-leases.ts";
import { activityKey, holderProviderPid, identityAvailability, parseActivity, type LeaseActivity } from "./identity-availability.ts";
import { procTable } from "./proc.ts";
import { SCHEMA_VERSION } from "./store.ts";

export interface IdentityStatus {
  name: string;
  /** held: a live session holds it; idle: held by a quiet conversation of a shared provider process (claimable);
   *  available: claimable; unknown: the holder could not be verified; legacy: never leased; conflict: owner recovery. */
  state: "held" | "idle" | "available" | "unknown" | "legacy" | "conflict";
  /** Computed by the same function a claim uses (identity-availability.ts). */
  claimable: boolean;
  reason: string;
  role: string | null;
  description: string | null;
  /** Chosen with a role (register, launch config, rename): false for names an older version generated. */
  registered: boolean;
  projects: string[];
  unread: number;
  messages: number;
  last_activity: string | null;
  holder: { cli: string; session_id: string; pid: number } | null;
}

export function listIdentityStatus(home: string, options: { now?: number; inspect?: (pid: number) => ProcessEvidence;
  project?: string; caller?: { cli: string; sessionId: string; pid?: number; providerPid?: number }; includeRetired?: boolean;
  processTable?: () => Map<number, { ppid: number }> } = {}) {
  const path = join(home, "mbx.db"), now = options.now ?? Date.now();
  if (!Number.isSafeInteger(now) || now < 0 || now > 8.64e15) throw new Error("invalid identity observation time");
  if (!existsSync(path)) throw Object.assign(new Error("mailbox is not initialized; run agentmbx setup"), { code: "NOT_FOUND" });
  const config = JSON.parse(readFileSync(join(home, "config.json"), "utf8"));
  if (typeof config.host !== "string" || !config.host) throw new Error("mailbox host configuration is invalid");
  const db = new DatabaseSync(path, { readOnly: true });
  const rows = new Map<string, IdentityStatus>(), leases: IdentityLease[] = [], conflicts = new Set<string>(), activityByName = new Map<string, LeaseActivity>();
  const inProject = new Set<string>(), retired = new Set<string>();
  let schema: number;
  const row = (name: string) => {
    let value = rows.get(name);
    if (!value) { value = { name, state: "legacy", claimable: true, reason: "ownership has not been established by a lease", role: null, description: null, registered: false,
      projects: [], unread: 0, messages: 0, last_activity: null, holder: null }; rows.set(name, value); }
    return value;
  };
  const activity = (item: IdentityStatus, value: unknown) => {
    const time = typeof value === "number" ? value : typeof value === "string" ? Date.parse(value) : NaN;
    if (Number.isFinite(time) && Math.abs(time) <= 8.64e15 && (!item.last_activity || time > Date.parse(item.last_activity))) item.last_activity = new Date(time).toISOString();
  };
  try {
    db.exec("PRAGMA busy_timeout=5000; PRAGMA query_only=ON; BEGIN");
    schema = db.prepare("PRAGMA user_version").get()!.user_version as number;
    if (schema > SCHEMA_VERSION) throw Object.assign(new Error(`mailbox schema ${schema} is newer than this runtime; update AgentMBX`), { code: "STALE_SERVER" });
    for (const r of db.prepare("SELECT name,last_seen FROM agents WHERE host=?").all(config.host)) activity(row(r.name as string), r.last_seen);
    for (const r of db.prepare("SELECT agent,COUNT(*) total,SUM(state<>'acked') unread,MAX(updated_at) activity FROM deliveries GROUP BY agent").all()) {
      const item = row(r.agent as string); item.messages = Number(r.total); item.unread = Number(r.unread); activity(item, r.activity);
    }
    for (const r of db.prepare("SELECT agent,MAX(updated_at) activity FROM sessions GROUP BY agent").all()) activity(row(r.agent as string), r.activity);
    for (const r of db.prepare("SELECT k FROM kv WHERE k LIKE 'retired:%'").all()) {
      const name = (r.k as string).slice("retired:".length); retired.add(name);
      if (options.includeRetired) { const item = row(name); item.reason = "retired by identity prune; claiming it brings it back"; }
    }
    for (const r of db.prepare("SELECT k FROM kv WHERE k LIKE 'identity-conflict:%'").all()) { const name = (r.k as string).slice("identity-conflict:".length); conflicts.add(name); row(name); }
    for (const r of db.prepare("SELECT k,v FROM kv WHERE k LIKE 'lease-activity:%'").all()) {
      const a = parseActivity(r.v as string); if (a) activityByName.set((r.k as string).slice(activityKey("").length), a);
    }
    for (const r of db.prepare("SELECT name,role FROM agents WHERE host=? AND role IS NOT NULL").all(config.host)) row(r.name as string).role = r.role as string;
    const has = (table: string) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table);
    if (has("identities")) for (const r of db.prepare("SELECT name,role,description FROM identities").all()) {
      const item = row(r.name as string); item.registered = true; item.role = r.role as string; item.description = (r.description as string | null) ?? item.description;
    }
    if (has("identity_projects")) for (const r of db.prepare("SELECT name,project FROM identity_projects ORDER BY last_seen DESC").all()) {
      row(r.name as string).projects.push(r.project as string);
      if (options.project && r.project === options.project) inProject.add(r.name as string);
    }
    if (options.project) for (const r of db.prepare("SELECT DISTINCT agent FROM sessions WHERE cwd=?").all(options.project)) inProject.add(r.agent as string);
    if (schema >= 2) leases.push(...db.prepare("SELECT * FROM identity_leases").all() as unknown as IdentityLease[]);
    db.exec("COMMIT");
  } finally { db.close(); }
  // Process discovery happens after releasing the read transaction. Listing is advisory;
  // a claim must recheck the current generation under its own write lock.
  const inspect = options.inspect ?? inspectLeaseProcess;
  // The provider process a same-session holder serves under (T383), read only for a lease of the caller's own session.
  const sameSessionProvider = (lease: IdentityLease, caller: { cli: string; sessionId: string; providerPid?: number }) =>
    lease.cli === caller.cli && lease.session_id === caller.sessionId
      ? { holderProviderPid: holderProviderPid((options.processTable ?? procTable)(), lease.holder_pid, caller.providerPid) } : {};
  for (const lease of leases) {
    const item = row(lease.name); activity(item, lease.heartbeat_at); activity(item, lease.released_at);
    let evidence: ProcessEvidence = { alive: null, start: null };
    if (lease.released_at === null && now - lease.heartbeat_at < lease.idle_ttl) {
      try { evidence = inspect(lease.holder_pid); } catch { /* failed inspection is unknown */ }
    }
    // The caller's own lease (its MCP server is the holder process) is simply held by it: not "an older process of this
    // same session", and not something it should claim again (T316).
    // A shared transport (Codex, OpenCode) serves many conversations from one process, so the process alone is not the
    // caller: the lease must also name this conversation's session.
    const own = options.caller?.pid !== undefined && lease.released_at === null && lease.holder_pid === options.caller.pid
      && lease.cli === options.caller.cli && lease.session_id === options.caller.sessionId && evidence.alive !== false;
    const a = own ? { state: "live" as const, claimable: false, reason: "held by this session" }
      : identityAvailability({ lease, evidence, activity: activityByName.get(lease.name) ?? null, conflict: conflicts.has(lease.name), now,
        caller: options.caller && { ...options.caller, ...sameSessionProvider(lease, options.caller) } });
    item.state = a.state === "live" ? (a.claimable ? "idle" : "held") : a.state === "idle" ? "idle" : a.state === "unknown" ? "unknown" : a.state === "conflict" ? "conflict" : "available";
    item.claimable = a.claimable;
    item.reason = a.reason;
    item.holder = { cli: lease.cli, session_id: lease.session_id, pid: lease.holder_pid };
  }
  for (const name of conflicts) { const item = row(name); item.state = "conflict"; item.claimable = false; item.reason = "historical ownership requires explicit recovery"; }
  // Retired mailboxes (identity prune, T209) leave listings unless asked for; their history is still in the store.
  const all = [...rows.values()].filter(i => options.includeRetired || !retired.has(i.name) || i.state === "held").sort((a, b) => a.name.localeCompare(b.name));
  return { host: config.host as string, schema_version: schema, observed_at: new Date(now).toISOString(), advisory: true,
    ...(options.project ? { project: options.project } : {}),
    identities: options.project ? all.filter(i => inProject.has(i.name)) : all };
}
