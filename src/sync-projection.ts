// Allowlisted SyncBatch projection (T262, daemon-sync-protocol-v1 version 3).
// OpenAPI 1.0.0-draft.5 shapes. This daemon speaks contract 1, which has no
// HostReport.project_paths or HostReport.project_leads (additionalProperties is
// false). local_path is computed for an opted-in project and attached only when
// the caller says the spoken contract lists that field. A lead row is the project
// key, agent, host, expiry and record id — never the checkout path — and is
// attached only when the spoken contract lists project_leads (T393).

export const CONTRACT_VERSION = 1;
export const PROJECT_PATHS_SINCE = 2;
export const PROJECT_LEADS_SINCE = 2;
export const CAPS = { agents: 500, threads: 1000, receipts: 2000, policies: 200, approvals: 200, peers: 64, paths: 64, leads: 64 } as const;
export const PATH_FLAG_PREFIX = "sync.project_path:";

const NAME_RE = /^[a-z0-9][a-z0-9-]{1,39}$/;
const ROLE_RE = /^[A-Za-z0-9][A-Za-z0-9 _-]{0,39}$/;
const FP_RE = /^[0-9a-f]{4}(-[0-9a-f]{4}){3}$/;
const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const ADDR_RE = /^[a-z0-9][a-z0-9-]{1,39}@[a-z0-9][a-z0-9-]{1,39}$/;
export const PROJECT_KEY_RE = /^(github\.com|gitlab\.com|bitbucket\.org|codeberg\.org|git\.sr\.ht|dev\.azure\.com|ssh\.dev\.azure\.com|gitee\.com)(\/(?!\.{1,2}(?:\/|$))[!-.0-@[-~]{1,200})+$|^h:[0-9a-f]{32}$/;
const CLIS = new Set(["claude", "codex", "kimi", "opencode", "hermes", "cli", "unknown"]);
const KINDS = ["message", "request", "reply", "status", "decision", "alert", "task"] as const;
const STATES = ["queued", "handed-over", "delivered", "notified", "read", "acked", "forwarded", "returned"] as const;
const LEVELS = new Set(["ask", "collaborate", "autonomous", "yolo"]);
const CLASSES = new Set(["read", "edit", "outward", "permissions"]);
const TRUSTS = new Set(["local", "verified", "unverified"]);

export interface DoctorFinding { code: string; severity: "info" | "warn" | "error" }

export interface PathInput { project_key: string; absolute: string; home: string; username: string; windows: boolean }

/** Allowlisted lead row. The absolute project path and the owner signature stay on the host. */
export interface LeadInput { project_key: string; agent: string; host: string; exp: string; id: string }

export interface AgentInput {
  name: string;
  role: string | null;
  cli: string | null;
  state: "live" | "idle" | "offline" | "pending" | "conflict" | "free" | "retired" | "unknown";
  unread: number;
  missed: number;
  project_keys: string[];
  holder: { cli: string; since: string } | null;
  last_seen_at: string | null;
}

export interface ThreadInput {
  thread_id: string;
  subject_hash: string | null;
  project_keys: string[];
  participants: string[];
  kind_counts: Partial<Record<(typeof KINDS)[number], number>>;
  state_counts: Partial<Record<(typeof STATES)[number], number>>;
  trust: string[];
  max_relay_depth: number;
  started_at: string;
  updated_at: string;
}

export interface ReceiptInput {
  message_id: string;
  thread_id: string;
  kind: string;
  from: string;
  to: string;
  state: string;
  at: string;
  signed_by_host_fp: string | null;
}

export interface PolicyInput {
  policy_id: string;
  level: string;
  classes: string[];
  to: { agents: string[]; hosts: string[] };
  from: { agents: string[]; hosts: string[] };
  project_keys: string[];
  has_local_scope: boolean;
  issued_at: string;
  expires_at: string;
  owner_fp: string;
  source: "cli" | "touch_id" | "console";
  command_id: string | null;
  state: "active" | "expired" | "revoked" | "voided";
  provisional: boolean;
}

export interface HostInput {
  daemon_version: string;
  os: "macos" | "linux" | "windows" | "other";
  owner_fp: string | null;
  authority_owner: boolean;
  relay_enrolled: boolean;
  peers: { host_name: string; host_key_fp: string; last_seen_at: string | null }[];
  findings: DoctorFinding[];
}

export interface SyncSnapshot {
  now: string;
  seq: number;
  full: boolean;
  contract: number;
  contractAllowsProjectPaths: boolean;
  contractAllowsProjectLeads: boolean;
  host: HostInput;
  agents: AgentInput[];
  threads: ThreadInput[];
  receipts: ReceiptInput[];
  policies: PolicyInput[];
  approvals: { approval_id: string }[];
  paths: PathInput[];
  leads: LeadInput[];
  /** Receipt dedup keys already accepted. Those receipts are not appended again. */
  sentReceipts: string[];
}

export type SyncBatch = Record<string, unknown>;

export type Projection =
  | { ok: true; batch: SyncBatch; body: string; redacted: string[]; receiptKeys: string[]; snapshotHash: string }
  | { ok: false; code: "sync.cap" | "sync.withheld" };

export function receiptKey(r: { message_id: string; to: string; state: string; at: string }): string {
  return `${r.message_id}\n${r.to}\n${r.state}\n${r.at}`;
}

/** Home-relative path for an opted-in project. Home and the OS username are never fields. */
export function projectLocalPath(raw: string, home: string, username: string, windows: boolean): { local_path: string } | { omit: "sync.path_redacted" } {
  const path = slash(raw);
  const homeN = slash(home);
  if (startsWithHome(path, homeN, windows)) {
    const rest = path.slice(homeN.length).replace(/^\/+/, "");
    return acceptPath(rest, false, homeN);
  }
  if (username && segments(path).some((s) => sameUser(s, username, windows))) return { omit: "sync.path_redacted" };
  if (homeN && includesHome(path, homeN, windows)) return { omit: "sync.path_redacted" };
  return acceptPath(path, true, homeN);
}

function slash(p: string): string {
  let s = p;
  if (s.startsWith("\\\\?\\")) s = s.slice(4);
  s = s.replace(/\\/g, "/");
  if (s.length > 1) s = s.replace(/\/+$/, "");
  return s;
}

function startsWithHome(path: string, homeN: string, windows: boolean): boolean {
  if (!homeN) return false;
  if (windows) {
    const p = path.toLowerCase(), h = homeN.toLowerCase();
    return p === h || p.startsWith(`${h}/`);
  }
  return path === homeN || path.startsWith(`${homeN}/`);
}

function includesHome(path: string, homeN: string, windows: boolean): boolean {
  if (!homeN) return false;
  return windows ? path.toLowerCase().includes(homeN.toLowerCase()) : path.includes(homeN);
}

function sameUser(segment: string, username: string, windows: boolean): boolean {
  return windows ? segment.toLowerCase() === username.toLowerCase() : segment === username;
}

function segments(path: string): string[] {
  return path.split("/").filter((s) => s && s !== "." && !/^[A-Za-z]:$/.test(s));
}

function acceptPath(value: string, absolute: boolean, homeN: string): { local_path: string } | { omit: "sync.path_redacted" } {
  if (!value || value.length > 512) return { omit: "sync.path_redacted" };
  const drive = /^[A-Za-z]:\//.test(value);
  if (absolute) {
    if (!value.startsWith("/") && !drive) return { omit: "sync.path_redacted" };
  } else if (value.startsWith("/") || drive) return { omit: "sync.path_redacted" };
  const body = value.startsWith("/") ? value.slice(1) : value.replace(/^[A-Za-z]:\//, "");
  const parts = body.split("/");
  if (parts.some((s) => s === "" || s === "." || s === ".." || /[\u0000-\u001f\\]/.test(s))) return { omit: "sync.path_redacted" };
  if (homeN && includesHome(value, homeN, false)) return { omit: "sync.path_redacted" };
  return { local_path: value };
}

function keys(xs: string[], max: number): string[] {
  const out: string[] = [];
  for (const k of xs) {
    if (out.length >= max) break;
    if (PROJECT_KEY_RE.test(k) && !out.includes(k)) out.push(k);
  }
  return out;
}

function counts<T extends string>(keys: readonly T[], src: Partial<Record<T, number>>): Record<T, number> {
  const out = {} as Record<T, number>;
  for (const k of keys) out[k] = Math.max(0, Math.floor(src[k] ?? 0));
  return out;
}

function projectPaths(input: SyncSnapshot, findings: DoctorFinding[]): { project_key: string; local_path: string }[] | undefined {
  if (!input.contractAllowsProjectPaths) return undefined;
  const rows: { project_key: string; local_path: string }[] = [];
  const seen = new Set<string>();
  for (const p of input.paths) {
    if (!PROJECT_KEY_RE.test(p.project_key) || seen.has(p.project_key)) continue;
    seen.add(p.project_key);
    if (rows.length >= CAPS.paths) break;
    const got = projectLocalPath(p.absolute, p.home, p.username, p.windows);
    if ("omit" in got) {
      if (!findings.some((f) => f.code === "sync.path_redacted")) findings.push({ code: "sync.path_redacted", severity: "info" });
      continue;
    }
    rows.push({ project_key: p.project_key, local_path: got.local_path });
  }
  return rows;
}

function projectLeads(input: SyncSnapshot): LeadInput[] | undefined {
  if (!input.contractAllowsProjectLeads) return undefined;
  const rows: LeadInput[] = [];
  const seen = new Set<string>();
  for (const row of input.leads) {
    if (!PROJECT_KEY_RE.test(row.project_key) || seen.has(row.project_key)) continue;
    if (!NAME_RE.test(row.agent) || !NAME_RE.test(row.host) || !ULID_RE.test(row.id) || Number.isNaN(Date.parse(row.exp))) continue;
    seen.add(row.project_key);
    if (rows.length >= CAPS.leads) break;
    rows.push({ project_key: row.project_key, agent: row.agent, host: row.host, exp: row.exp, id: row.id });
  }
  return rows;
}

export function projectSync(input: SyncSnapshot): Projection {
  if (input.agents.length > CAPS.agents || input.threads.length > CAPS.threads || input.policies.length > CAPS.policies || input.approvals.length > CAPS.approvals) {
    return { ok: false, code: "sync.cap" };
  }
  const findings = input.host.findings.filter((f) => /^[a-z0-9_.-]{1,64}$/.test(f.code)).slice(0, 50);
  const project_paths = projectPaths(input, findings);
  const project_leads = projectLeads(input);
  const host: Record<string, unknown> = {
    daemon_version: input.host.daemon_version,
    os: input.host.os,
    owner_fp: input.host.owner_fp && FP_RE.test(input.host.owner_fp) ? input.host.owner_fp : null,
    authority: {
      owner_kind: input.host.authority_owner ? "owner_key" : null,
      mode: input.host.authority_owner ? "owner_key" : null,
      pinned_roots: [],
      endorsed_hosts: [],
      provisional_authenticators: [],
      provisional_revocations: [],
    },
    break_glass: null,
    provisional_actions: [],
    confirm_methods: [],
    relay: { enrolled: input.host.relay_enrolled, last_pull_at: null },
    peers: input.host.peers.filter((p) => NAME_RE.test(p.host_name) && FP_RE.test(p.host_key_fp)).slice(0, CAPS.peers).map((p) => ({
      host_name: p.host_name, host_key_fp: p.host_key_fp, last_seen_at: p.last_seen_at,
    })),
    doctor: { checked_at: input.now, findings: findings.slice(0, 50) },
  };
  if (project_paths) host.project_paths = project_paths;
  if (project_leads) host.project_leads = project_leads;

  const agents = input.agents.filter((a) => NAME_RE.test(a.name)).map((a) => ({
    name: a.name,
    role: a.role && ROLE_RE.test(a.role) ? a.role : null,
    cli: a.cli && CLIS.has(a.cli) ? a.cli : a.cli ? "unknown" : null,
    state: a.state,
    unread: Math.max(0, a.unread),
    missed: Math.max(0, a.missed),
    project_keys: keys(a.project_keys, 20),
    holder: a.holder && CLIS.has(a.holder.cli) ? { cli: a.holder.cli, since: a.holder.since } : a.holder ? { cli: "unknown", since: a.holder.since } : null,
    last_seen_at: a.last_seen_at,
    forwarding_to: null,
    issues: [],
  }));
  const threads = input.threads.filter((t) => ULID_RE.test(t.thread_id)).map((t) => ({
    thread_id: t.thread_id,
    subject_hash: t.subject_hash && /^k:[0-9a-f]{64}$/.test(t.subject_hash) ? t.subject_hash : null,
    project_keys: keys(t.project_keys, 10),
    participants: t.participants.filter((p) => ADDR_RE.test(p)).slice(0, 50),
    message_count: Object.values(t.kind_counts).reduce((n, v) => n + (v ?? 0), 0),
    kind_counts: counts(KINDS, t.kind_counts),
    state_counts: counts(STATES, t.state_counts),
    trust: t.trust.filter((x) => TRUSTS.has(x)),
    max_relay_depth: Math.max(0, t.max_relay_depth),
    flags: [],
    started_at: t.started_at,
    updated_at: t.updated_at,
  }));
  const sent = new Set(input.sentReceipts);
  const receiptRows = input.receipts.filter((r) => ULID_RE.test(r.message_id) && ULID_RE.test(r.thread_id) && ADDR_RE.test(r.from) && ADDR_RE.test(r.to)
    && (KINDS as readonly string[]).includes(r.kind) && (STATES as readonly string[]).includes(r.state) && !sent.has(receiptKey(r))).slice(0, CAPS.receipts);
  const receipts = receiptRows.map((r) => ({
    message_id: r.message_id, thread_id: r.thread_id, kind: r.kind, from: r.from, to: r.to, state: r.state, at: r.at,
    signed_by_host_fp: r.signed_by_host_fp && FP_RE.test(r.signed_by_host_fp) ? r.signed_by_host_fp : null,
  }));
  const policies = input.policies.filter((p) => /^[A-Za-z0-9_-]{1,64}$/.test(p.policy_id) && LEVELS.has(p.level) && FP_RE.test(p.owner_fp)).map((p) => ({
    policy_id: p.policy_id,
    level: p.level,
    classes: p.classes.filter((c) => CLASSES.has(c)),
    to: { agents: p.to.agents.filter((a) => a === "*" || NAME_RE.test(a)).slice(0, 50), hosts: p.to.hosts.filter((h) => h === "*" || h === "local" || NAME_RE.test(h)).slice(0, 50) },
    from: { agents: p.from.agents.filter((a) => a === "*" || NAME_RE.test(a)).slice(0, 50), hosts: p.from.hosts.filter((h) => h === "*" || h === "local" || NAME_RE.test(h)).slice(0, 50) },
    project_keys: keys(p.project_keys, 20),
    has_local_scope: p.has_local_scope,
    issued_at: p.issued_at,
    expires_at: p.expires_at,
    owner_fp: p.owner_fp,
    source: p.source,
    command_id: p.command_id && ULID_RE.test(p.command_id) ? p.command_id : null,
    state: p.state,
    provisional: p.provisional,
  }));

  const replace = { agents, threads, policies, approvals: input.approvals };
  const snapshotHash = JSON.stringify(replace);
  const batch: SyncBatch = { v: 1, contract: input.contract, seq: input.seq, full: input.full, sent_at: input.now, host };
  if (input.full) {
    batch.agents = { upsert: agents, remove: [] };
    batch.threads = { upsert: threads, remove: [] };
    batch.policies = { upsert: policies, remove: [] };
    batch.approvals = { upsert: input.approvals, remove: [] };
  }
  if (receipts.length) batch.receipts = { append: receipts };
  const body = JSON.stringify(batch);
  if (leaks(body, input.paths)) return { ok: false, code: "sync.withheld" };
  return { ok: true, batch, body, redacted: findings.filter((f) => f.code === "sync.path_redacted").map((f) => f.code), receiptKeys: receiptRows.map(receiptKey), snapshotHash };
}

/** A projected batch must not carry a body, a home directory, or a checkout outside local_path. */
function leaks(body: string, paths: PathInput[]): boolean {
  if (/"body"\s*:/.test(body) || /"subject"\s*:/.test(body) || /"session_id"\s*:/.test(body) || /"cwd"\s*:/.test(body)) return true;
  const outside = body.replace(/"local_path":"(?:\\.|[^"\\])*"/g, "");
  for (const p of paths) {
    const home = slash(p.home);
    const absolute = slash(p.absolute);
    if (home && body.includes(home)) return true;
    if (absolute && outside.includes(absolute)) return true;
  }
  return false;
}
