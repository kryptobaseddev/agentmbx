// `agentmbx doctor`: one checklist that says what works, what doesn't, and the one command that fixes it.
import { rotationLog } from "./key-rotation.ts";
import { accessSync, constants, existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { phantomMailboxes, returnDays } from "./stranded.ts";
import { delimiter, dirname, join } from "node:path";
import { fingerprint } from "./crypto.ts";
import { signHop } from "./http.ts";
import { relayState, ROLLBACK_REASON } from "./relay-v2.ts";
import { kimiHostedServer, kimiInstances } from "./kimi-web.ts";
import { opencodeService } from "./wake.ts";
import { opencodeHostClassifier, type OpencodeHost } from "./opencode-provider.ts";
import { kimiDesktop } from "./kimi-desktop.ts";
import { version } from "./version.ts";
import { GROK_NO_PUSH, MbxNode, RETRY_HOURS } from "./node.ts";
import { authHelperPath, keychainOwnerStatus, ownerInfo } from "./owner.ts";
import { claudePluginChecks } from "./claude-plugin.ts";
import { detect, edits, grokMcpConfiguredCommand, hermesAllowlistPath, hermesConsent, mcpConfiguredCmd, mcpConfiguredTimeout, skillDest, skillStatus, statuslineConfiguredCommand, statuslineForms, statuslineState, wired, type CliId, type SetupCtx } from "./setup.ts";
import { mailboxLiveness } from "./receipts.ts";
import { liveWatcher } from "./wake.ts";
import { findIdentityControl, listIdentityControls } from "./identity-control.ts";
import { pruneCandidates } from "./identity-cleanup.ts";
import { inspectLeaseProcess, type IdentityLease } from "./identity-leases.ts";
import { providerLabel, sameLiveProvider } from "./identity-takeover.ts";

export type Level = "ok" | "fail" | "warn" | "info";
export interface Check { level: Level; label: string; fix?: string }

export const CLAIM_CHURN_LIMIT = 5;
/** T481: one session id leased by an MCP under a different OpenCode serve than the published control endpoint. */
export function foreignSessionProvider(node: MbxNode): Check[] {
  const rows = node.store.db.prepare("SELECT * FROM identity_leases WHERE released_at IS NULL").all() as unknown as IdentityLease[];
  const out: Check[] = [];
  for (const row of rows) {
    let claimant;
    try { claimant = findIdentityControl(node.store, row.cli, row.session_id); }
    catch { continue; }
    const evidence = inspectLeaseProcess(row.holder_pid);
    if (!(evidence.alive === true && evidence.start === row.holder_start)) continue;
    if (sameLiveProvider(row.holder_pid, claimant)) continue;
    const last = new Date(row.heartbeat_at).toISOString();
    out.push({
      level: "warn",
      label: `${row.cli} session ${row.session_id} is leased by pid ${row.holder_pid} under provider ${providerLabel(row.holder_pid)} (last activity ${last}), while this session's control endpoint is pid ${claimant.mcp_pid} under provider ${providerLabel(claimant.mcp_pid)}`,
      fix: `agentmbx identity takeover --force ${row.name} --cli ${row.cli} --session ${row.session_id}`,
    });
  }
  return out;
}

/** Ten-minute claim/release storms indicate connector fights, not useful session work. */
export function identityClaimChurn(node: MbxNode, now = Date.now()): Check[] {
  const rows = node.store.db.prepare("SELECT detail FROM audit WHERE event='identity.claim' AND at>=? ORDER BY at")
    .all(new Date(now - 10 * 60_000).toISOString()) as { detail: string }[];
  const counts = new Map<string, number>();
  for (const row of rows) {
    try { const name = JSON.parse(row.detail).name; if (typeof name === "string") counts.set(name, (counts.get(name) ?? 0) + 1); }
    catch { /* malformed historical audit is not a claim */ }
  }
  return [...counts].filter(([, count]) => count > CLAIM_CHURN_LIMIT).map(([name, count]) => ({ level: "warn",
    label: `${name}: identity claim/release churn (${count} claims in 10 minutes; limit ${CLAIM_CHURN_LIMIT}); reconnecting or competing MCP connectors may be fighting the lease`,
    fix: "update AgentMBX and reconnect with the harness MCP controls; same-session connectors co-use the lease. Never kill MBX MCPs, hand-spawn agentmbx mcp, or force-takeover your own live session; use exact-session diagnostics and the mailbox CLI --as instead" }));
}

export const VERSION = (() => {
  try { return (JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string }).version; } catch { return "unknown"; }
})();

/** True when something answers HTTP on the daemon port (an unsigned request gets 401, which still proves it is up). */
export async function daemonAnswers(port: number, timeoutMs = 1500): Promise<boolean> {
  try { await fetch(`http://127.0.0.1:${port}/v1/agents`, { signal: AbortSignal.timeout(timeoutMs) }); return true; } catch { return false; }
}

export interface DaemonReadiness extends Check { state: "matching" | "unverified" | "unreachable" }

/** Diagnostic identity comparison, not authentication or proof of message receipt. No pairing side effects. */
export async function daemonReadiness(node: MbxNode, timeoutMs = 1500): Promise<DaemonReadiness> {
  const address = `127.0.0.1:${node.config.port}`;
  const unknown = (reason: string): DaemonReadiness => ({ state: "unverified", level: "warn", label: `daemon identity unverified on ${address}: ${reason}`,
    fix: "check the process listening on this port; an older AgentMBX daemon may need restarting after update" });
  let response: Response;
  try { response = await fetch(`http://${address}/v1/status`, { redirect: "manual", signal: AbortSignal.timeout(timeoutMs) }); }
  catch (error) {
    // Only a refused connection establishes an absent listener. Timeout/reset/abort is uncertain.
    const refused = (error as { cause?: { code?: string } }).cause?.code === "ECONNREFUSED";
    return { state: refused ? "unreachable" : "unverified", level: "fail", label: `daemon not answering on ${address}`,
      fix: refused ? `agentmbx daemon install   (log: ${join(node.home, "daemon.log")})` : "check the process listening on this port before installing or restarting the daemon" };
  }
  if (response.status !== 200) { await response.body?.cancel(); return unknown(`HTTP ${response.status} (unsupported status endpoint or another service)`); }
  try {
    const reader = response.body?.getReader();
    if (!reader) return unknown("empty response");
    let size = 0; const parts: Uint8Array[] = [];
    try {
      for (;;) {
        const { done, value } = await reader.read(); if (done) break;
        size += value.byteLength;
        if (size > 8192) return unknown("response exceeds 8192 bytes");
        parts.push(value);
      }
    } finally { await reader.cancel(); }
    const r = JSON.parse(Buffer.concat(parts).toString("utf8"));
    if (r?.service !== "agentmbx" || r.v !== 1 || typeof r.host !== "string" || typeof r.host_pubkey !== "string"
      || typeof r.version !== "string" || r.version.length > 64 || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(r.version)
      || typeof r.started_at !== "string" || !Number.isFinite(Date.parse(r.started_at)) || new Date(r.started_at).toISOString() !== r.started_at)
      return unknown("malformed AgentMBX status");
    if (r.host !== node.host || r.host_pubkey !== node.key.publicKey) return unknown("reported host or key differs from this mailbox");
    if (r.version !== version()) return { state: "unverified", level: "warn", label: `daemon reports expected host ${r.host} on ${address}, but version ${r.version} differs from CLI ${version()}`,
      fix: "restart the daemon after updating; existing MCP sessions may also need restarting" };
    return { state: "matching", level: "ok", label: `daemon reports expected host ${r.host} on ${address} (version ${r.version}, started ${r.started_at}); receipt not tested` };
  } catch { return unknown("malformed, interrupted, or timed-out status response"); }
}

/** Binding evidence is separate from configuration and never proves end-to-end delivery. */
export function sessionReadiness(node: MbxNode, cli: string): Check {
  const rows = node.store.db.prepare("SELECT pid,pid_start,updated_at,session_id,channel FROM sessions WHERE cli=?").all(cli) as
    { pid: number | null; pid_start: string | null; updated_at: string; session_id: string; channel: number }[];
  const live = rows.filter((s) => s.pid && node.sameSession(s.pid, s, { proof: true }));
  if (!rows.length) return { level: "info", label: `${cli}: no mailbox session bindings; receipt not tested` };
  if (!live.length) return { level: "warn", label: `${cli}: no verified live mailbox binding (${rows.length} stale or unverified); receipt not tested`,
    fix: "open a provider session and check its AgentMBX session-start hook" };
  const real = live.filter((s) => !s.session_id.startsWith("mcp-")).length;
  const channels = live.filter((s) => s.channel).length;
  const stale = rows.length - live.length;
  const onlyProvisional = !real && !channels;
  const hostedPids = cli === "kimi" ? new Set([...kimiInstances().map(instance => instance?.pid), kimiDesktop()?.pid]) : new Set<number | undefined>();
  const hostedProvisional = live.filter(s => s.session_id.startsWith("mcp-") && hostedPids.has(s.pid!)).length;
  if (hostedProvisional) return { level: "warn",
    label: `${cli}: ${hostedProvisional} hosted conversation(s) not linked to their mbx server yet; ${real} real session ID(s); receipt not tested`,
    fix: "each hosted conversation links itself on its next prompt (the [mbx] note asks it to call mbx_whoami with a bind ticket)" };

  return { level: onlyProvisional ? "warn" : "info",
    label: `${cli}: ${live.length} verified live mailbox binding(s), ${real} real session ID(s), ${channels} channel binding(s)`
      + (stale ? `, ${stale} stale or unverified` : "") + "; receipt not tested",
    ...(onlyProvisional ? { fix: "run the provider session-start hook to bind its real session ID" }
      : cli === "claude" && !channels ? { fix: "start Claude with 'agentmbx claude' (adds the mbx channel) so idle sessions wake on mail; others see mail on their next prompt" } : {}) };
}

/** A `kimi web` server reads its hooks once at start: one started before AgentMBX was set up runs none (no bind, no Stop). */
export function kimiServerHooks(home: string, kimiHome = process.env.KIMI_CODE_HOME || join(home, ".kimi-code")): Check[] {
  let wiredAt: number;
  try { const cfg = join(kimiHome, "config.toml"); if (!readFileSync(cfg, "utf8").includes("agentmbx hook")) return []; wiredAt = statSync(cfg).mtimeMs; } catch { return []; }
  return kimiInstances(kimiHome).filter(i => typeof i.pid === "number" && typeof i.started_at === "number" && i.started_at < wiredAt && kimiHostedServer(i.pid, kimiHome) !== null)
    .map(i => ({ level: "warn" as Level, label: `kimi web server pid ${i.pid} (port ${i.port}) started before its AgentMBX hooks were last written: its sessions get no mbx hooks`,
      fix: "restart that kimi web server (stop it, then run kimi web again)" }));
}

const STRANDED_MAX = 10;

/** Mailboxes with unhandled mail no live session will see (T211). Read-only; never claims, forwards or prunes.
 *  Phantom mailboxes (S2) get their own line and the `doctor --fix` hint. */
export function strandedMail(node: MbxNode): Check[] {
  const phantoms = new Map(phantomMailboxes(node).map((p) => [p.name, p]));
  const rows = node.store.db.prepare("SELECT agent name, COUNT(*) unread FROM deliveries WHERE state <> 'acked' GROUP BY agent HAVING unread > 0")
    .all() as { name: string; unread: number }[];
  const stranded = rows.filter((r) => r.name !== "owner").map((r) => ({ ...r, liveness: mailboxLiveness(node, r.name) }))
    .filter((r) => !r.liveness.live)
    .map((r) => ({ name: r.name, unread: r.unread, detail: r.liveness.detail }))
    .sort((a, b) => b.unread - a.unread || a.name.localeCompare(b.name));
  const days = returnDays(node);
  const out: Check[] = stranded.slice(0, STRANDED_MAX).map((s) => { const p = phantoms.get(s.name); return p
    ? { level: "warn" as Level, label: `${s.name}: phantom mailbox — ${s.unread} message(s) addressed to ${s.name}@${p.hosts.join(", ")}, which received them there; nobody holds ${s.name} here`,
      fix: "agentmbx doctor --fix   (marks these copies handled; nothing is deleted)" }
    : { level: "warn" as Level,
    label: `${s.name}: ${s.unread} unread message(s) stranded — ${s.detail}`,
    fix: `the owning agent resumes it with mbx_identity {"action":"claim","name":"${s.name}"}, or the owner forwards the mail: agentmbx identity forward ${s.name} <to>`
      + (days && !node.establishedLocalName(s.name) ? `; ${s.name} is not an agent here, so new mail to it goes back to its sender after ${days} days` : "") }; });
  if (stranded.length > STRANDED_MAX) out.push({ level: "warn" as Level, label: `… ${stranded.length - STRANDED_MAX} more mailbox(es) with stranded unread mail` });
  return out;
}

/** Live sessions waiting for the remembered identity another session currently holds (T211). Read-only. */
export function pendingIdentities(node: MbxNode): Check[] {
  const out: Check[] = [];
  for (const d of listIdentityControls(node.store)) {
    if (d.agent !== "") continue; // bound sessions hold their identity; only unbound ones can be waiting
    const remembered = node.store.get(`name:${d.cli}:${d.session_id}`);
    if (!remembered) continue;
    const lease = node.store.db.prepare("SELECT * FROM identity_leases WHERE name=?").get(remembered) as unknown as IdentityLease | undefined;
    if (!lease || lease.released_at !== null) continue; // free to claim: nothing waits
    if (lease.cli === d.cli && lease.session_id === d.session_id) continue;
    const holder = `${lease.cli} session ${lease.session_id.slice(0, 12)}`;
    const fresh = Date.now() - lease.heartbeat_at;
    out.push({ level: "warn" as Level,
      label: `${d.cli} session ${d.session_id.slice(0, 12)} is waiting for its remembered identity ${remembered}, held by ${holder} (heartbeat ${Math.max(0, Math.round(fresh / 1000))}s ago)`,
      fix: `the holder finishes and releases (mbx_identity action=release), or the owner replaces it: agentmbx identity takeover ${remembered} --force --cli <provider> --session <id>` });
  }
  return out;
}

/** One line on how much `agentmbx identity prune` would retire (T211). Read-only. */
export function pruneSummary(node: MbxNode): Check {
  const { retire } = pruneCandidates(node);
  return retire.length
    ? { level: "warn", label: `${retire.length} generated mailbox(es) with no holder, no unread mail and no recent traffic would be retired`, fix: "review the list: agentmbx identity prune   (a dry run), then apply it: agentmbx identity prune --apply" }
    : { level: "info", label: "no generated mailboxes eligible for prune" };
}

/** OpenCode's LocationActivity drops an idle service about every 60 minutes, and the plugin then releases and claims again.
 *  A claim within ~65 minutes of its release, with those pairs about 61 minutes apart, is that eviction. One restart is not.
 *  Only the last 24 hours of audit rows are read. */
const EVICT_FOLLOW_MS = 65 * 60 * 1000;
const EVICT_REPEAT_MIN_MS = 50 * 60 * 1000;
const EVICT_REPEAT_MAX_MS = 75 * 60 * 1000;
const EVICT_LOOKBACK_MS = 24 * 60 * 60 * 1000;

interface AuditReader { prepare(sql: string): { all(since: string): unknown[] } }
interface LeaseEvent { t: number; kind: "release" | "claim" }

/** Info when an OpenCode holder's audit shows the hourly release/claim signature. Silent otherwise. Not an install failure. */
export function opencodeEvictionCheck(db: AuditReader): Check | null {
  const since = new Date(Date.now() - EVICT_LOOKBACK_MS).toISOString();
  const rows = db.prepare(
    "SELECT at, event, detail FROM audit WHERE event IN ('identity.release', 'identity.claim') AND at > ? ORDER BY at",
  ).all(since);
  const byName = new Map<string, LeaseEvent[]>();
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const rec = row as { at?: unknown; event?: unknown; detail?: unknown };
    if (typeof rec.at !== "string" || (rec.event !== "identity.release" && rec.event !== "identity.claim")) continue;
    const t = Date.parse(rec.at);
    if (!Number.isFinite(t)) continue;
    let detail: unknown;
    try { detail = typeof rec.detail === "string" ? JSON.parse(rec.detail) : null; } catch { continue; }
    if (!detail || typeof detail !== "object") continue;
    const parsed = detail as { name?: unknown; holder?: { cli?: unknown } };
    if (parsed.holder?.cli !== "opencode" || typeof parsed.name !== "string" || parsed.name === "") continue;
    const list = byName.get(parsed.name) ?? [];
    list.push({ t, kind: rec.event === "identity.release" ? "release" : "claim" });
    byName.set(parsed.name, list);
  }
  for (const events of byName.values()) {
    if (!hourlyOpencodeEviction(events)) continue;
    return {
      level: "info",
      label: "opencode: identity.release then identity.claim about every 61 minutes is OpenCode evicting its idle service (LocationActivity timeToLive). That is known upstream behaviour, not a broken install. During the gap, mailbox tools fail closed until the service is touched again; waking the agent still works.",
      fix: "Any OpenCode command restarts the service. The durable fix is upstream: a configurable LocationActivity timeToLive, or an exemption for the MCP server.",
    };
  }
  return null;
}

function hourlyOpencodeEviction(events: LeaseEvent[]): boolean {
  const pairs: number[] = [];
  let pending: number | null = null;
  for (const event of events) {
    if (event.kind === "release") { pending = event.t; continue; }
    if (pending === null) continue;
    const follow = event.t - pending;
    if (follow > 0 && follow <= EVICT_FOLLOW_MS) pairs.push(pending);
    pending = null;
  }
  for (let i = 1; i < pairs.length; i++) {
    const between = pairs[i]! - pairs[i - 1]!;
    if (between >= EVICT_REPEAT_MIN_MS && between <= EVICT_REPEAT_MAX_MS) return true;
  }
  return false;
}

/** T368: static verification of one CLI's status line integration. Optional and never fails doctor.
 *  "ours" must be a CURRENT form — an older recognized form is a warn with the upgrade fix, as is
 *  ours pointing at a deleted bundled script. "foreign" is info, unless the foreign command embeds
 *  the agentmbx render command (wrapped, re-quoted, extra flags): that is a partial AgentMBX write,
 *  not a user's own line. Claude composes, so its wired command must be the composing adapter; kimi
 *  and grok are replace-only — `command` replaces the footer and never renders alongside the user's
 *  other keys. opencode has no custom status line feature at all (built-in segments only), so the
 *  honest result is an explicit skip note, not a check against an invented config path. */
/** T391/T524: the shared OpenCode service is the push-wake path only for sessions it hosts itself.
 *  Sessions hosted by a standalone serve (`opencode --standalone` → `opencode serve --stdio`) are
 *  never pushed through the service (it would start a duplicate agent loop): they get mail on their
 *  next prompt. Doctor counts both and proves the service answers when a service-hosted session is
 *  bound. A warn never fails doctor (the T435 rule). Unbound hosts stay silent. */
export async function opencodeServiceCheck(node: MbxNode, service: () => Promise<{ url: string; auth: string } | null> = opencodeService,
  host: (pid: number | null) => OpencodeHost = opencodeHostClassifier()): Promise<Check | null> {
  const bound = node.store.db.prepare("SELECT agent, pid FROM sessions WHERE cli='opencode' AND session_id NOT LIKE 'mcp-%'").all() as { agent: string; pid: number | null }[];
  if (!bound.length) return null;
  const hosted = bound.filter((b) => host(b.pid) === "service").length, standalone = bound.length - hosted;
  const rest = standalone ? `${standalone} binding(s) in a standalone OpenCode serve (or unknown host): no push wake yet, next-prompt delivery only` : "";
  if (!hosted) return { level: "info", label: `opencode: ${rest}` };
  const svc = await service().catch(() => null);
  if (svc) return { level: "ok", label: `opencode: service reachable (${svc.url}) — wake path for ${hosted} service-hosted mailbox binding(s)${rest ? `; ${rest}` : ""}` };
  return {
    level: "warn",
    label: `opencode: service not reachable, so ${hosted} service-hosted OpenCode binding(s) cannot be woken${rest ? `; ${rest}` : ""}`,
    fix: "run any opencode command (or `opencode service start`) so the service API comes up; config: ~/.config/opencode/service.json",
  };
}

/** T460: Hermes runs a shell hook only after its (event, command) pair was approved, and in the TUI (no tty) it silently skips an
 *  unapproved one: hooks that are wired but not approved look installed and do nothing. Reads the same state setup writes. A warn
 *  never fails doctor. Silent until the hooks are wired, because the generic hooks row already says so then. */
export function hermesHooksChecks(ctx: SetupCtx): Check[] {
  const hooks = edits(ctx, "hermes").find((e) => e.kind === "hooks");
  if (!hooks) return [];
  const cur = existsSync(hooks.path) ? readFileSync(hooks.path, "utf8") : null;
  const why = cur !== null ? hooks.blocked?.(cur) ?? null : null;
  if (why) return [{ level: "warn", label: `hermes: hooks cannot be wired automatically: ${why}`,
    fix: `add them to ${hooks.path.replace(ctx.home, "~")} by hand: on_session_start and pre_llm_call running \`${ctx.cmd.join(" ")} hook session-start|prompt --cli hermes\`` }];
  if (!wired(hooks)) return [];
  const c = hermesConsent(ctx);
  const where = hermesAllowlistPath(ctx.home).replace(ctx.home, "~");
  if (c.state === "approved") return [{ level: "ok", label: `hermes: hooks approved to run (${where})` }];
  if (c.state === "auto") return [{ level: "ok", label: "hermes: hooks approved to run (hooks_auto_accept: true)" }];
  if (c.state === "unreadable") return [{ level: "warn", label: `hermes: hooks are wired but ${where} cannot be read, so Hermes may skip them`,
    fix: "fix or remove that file, then: agentmbx setup --only hermes   (or approve them with `hermes hooks list`)" }];
  return [{ level: "warn", label: `hermes: hooks are wired but not approved (${c.missing.join(", ")}), so Hermes skips them`,
    fix: "agentmbx setup --only hermes   (writes the approvals), or set hooks_auto_accept: true in ~/.hermes/config.yaml" }];
}

/** The CLIs whose MCP config format has a real startup-timeout field (T502). Claude's ~/.claude.json
 *  and Kimi's mcp.json have none, so setup writes (and doctor checks) a timeout only for these. */
const TIMEOUT_CLIS: CliId[] = ["codex", "opencode", "hermes", "grok"];
/** T502: the minimum explicit startup timeout setup writes and doctor accepts (seconds). */
export const MCP_STARTUP_TIMEOUT_MIN_SEC = 30;

/** T502: a wired MCP entry should carry the explicit startup timeout setup writes (>= 30s; codex and
 *  grok startup_timeout_sec, opencode timeout in ms, hermes connect_timeout). A config an older setup
 *  wrote has none: a warning row, never a fail — the next `agentmbx setup` repairs the line. Silent
 *  until the entry is wired (the generic row already says not wired) and for CLIs with no such field. */
export function mcpTimeoutChecks(ctx: SetupCtx, cli: CliId): Check[] {
  if (!TIMEOUT_CLIS.includes(cli)) return [];
  const mcp = edits(ctx, cli).find((e) => e.kind === "mcp");
  if (!mcp || !wired(mcp)) return [];
  const fix = `agentmbx setup --only ${cli}`;
  const secs = mcpConfiguredTimeout(ctx.home, cli);
  if (secs === null) return [{ level: "warn", label: `${cli}: MCP startup timeout is not set`, fix }];
  if (secs < MCP_STARTUP_TIMEOUT_MIN_SEC) return [{ level: "warn", label: `${cli}: MCP startup timeout is ${secs}s (< ${MCP_STARTUP_TIMEOUT_MIN_SEC}s)`, fix }];
  return [];
}

/** The nearest package.json walking up from `dir` (null when none or it has no version string). T504
 *  version-checks a configured agentmbx script without executing anything. */
function packageVersionAt(dir: string): string | null {
  let cur = dir;
  for (;;) {
    const p = join(cur, "package.json");
    if (existsSync(p)) {
      try {
        const v = (JSON.parse(readFileSync(p, "utf8")) as { version?: unknown }).version;
        return typeof v === "string" ? v : null;
      } catch { return null; }
    }
    const parent = dirname(cur);
    if (parent === cur) return null;
    cur = parent;
  }
}

/** T504: what setup writes is [node, script, "mcp"]. Fail when the node binary or the script path no
 *  longer exists, or when the script's package version differs from this install (a stale path, or a
 *  second older install the harness would actually start). Bare-binary and shim forms (older setups,
 *  and the SEA single binary) are resolved by the harness on its own PATH or are not version-checkable
 *  here, so they stay silent — grok's single-path check (T384) already covers its missing-path case. */
export function mcpCommandChecks(ctx: SetupCtx, cli: CliId): Check[] {
  const mcp = edits(ctx, cli).find((e) => e.kind === "mcp");
  if (!mcp || !wired(mcp)) return [];
  const argv = mcpConfiguredCmd(ctx.home, cli);
  if (!argv?.length) return [];
  const target = argv[argv.length - 1] === "mcp" ? argv.slice(0, -1) : argv;
  if (target.length < 2) return [];
  const [node, script] = [target[0], target[1]];
  const fix = `agentmbx setup --only ${cli}`;
  if (!existsSync(node)) return [{ level: "fail", label: `${cli}: MCP command node binary does not exist (${node})`, fix }];
  if (!existsSync(script)) return [{ level: "fail", label: `${cli}: MCP command path does not exist (${script})`, fix }];
  const v = packageVersionAt(dirname(script));
  if (v !== null && v !== VERSION) return [{ level: "fail", label: `${cli}: MCP command resolves agentmbx ${v}, but this install is ${VERSION} (${script})`, fix }];
  return [];
}

export function statuslineChecks(ctx: SetupCtx, cli: string): Check[] {
  if (cli === "opencode")
    return [{ level: "info", label: "opencode: no custom status line feature (built-in segments only: anomalyco/opencode#30295); nothing to verify" }];
  if (cli !== "claude" && cli !== "kimi" && cli !== "grok") return [];
  const out: Check[] = [];
  const where = edits(ctx, cli).find((e) => e.kind === "statusline")?.path.replace(ctx.home, "~") ?? "-";
  const fix = `agentmbx setup --only ${cli}`;
  const state = statuslineState(ctx.home, cli, ctx.cmd);
  // Re-review item 2: check the CONFIGURED command, never the one setup would write — and parse
  // the quoted path form setup writes, so a home path with a space stays intact.
  const configured = statuslineConfiguredCommand(ctx.home, cli);
  const scriptPath = configured?.startsWith("sh ") ? firstShellWord(configured.slice(3)) : null;
  if (state === "ours") {
    if (scriptPath && !existsSync(scriptPath))
      out.push({ level: "warn", label: `${cli}: status line points at a missing script (${scriptPath})`, fix: "agentmbx setup --only skill" });
    else if (configured !== null && !statuslineForms(ctx.home, cli, ctx.cmd).has(configured))
      out.push({ level: "warn", label: `${cli}: status line uses an older AgentMBX form (${configured})`, fix });
    else out.push({ level: "ok", label: `${cli}: status line wired (${where})${cli === "claude"
      ? "; the command composes with Claude's built-in items" : " — the command replaces the footer; other keys do not render"}` });
  } else if (state === "foreign") {
    const embedded = !!configured && ((configured.includes("agentmbx") && configured.includes("statusline"))
      || configured.includes(join(skillDest(ctx.home), "scripts")));
    if (embedded) out.push({ level: "warn", label: `${cli}: status line is foreign but embeds the agentmbx render command (${configured}) — a partial AgentMBX write, not a user's own`,
      fix: `remove the agentmbx reference by hand, then: ${fix}` });
    else out.push({ level: "info", label: `${cli}: a user's status line is left alone (MBX segment not wired)` });
  }
  return out;
}

/** A POSIX single-quoted word. The fix is a command the owner can paste. */
function shQuote(text: string): string {
  return `'${text.replace(/'/g, `'\\''`)}'`;
}

/** True when `path` is an executable regular file. Symlinks follow. A directory or a dangling link is not. */
function executableFile(path: string): boolean {
  try {
    if (!statSync(path).isFile()) return false;
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function sameFile(a: string, b: string): boolean {
  try { return realpathSync(a) === realpathSync(b); } catch { return false; }
}

/**
 * T314: a legacy `mbx` that is not AgentMBX and sits in an earlier PATH directory than `agentmbx`.
 * The old NAS mailbox shim is that case. The same file reached through another name is not foreign.
 * A warn does not fail doctor. Null means there is nothing to flag.
 */
export function legacyMbxShim(pathEnv: string = process.env.PATH ?? ""): Check | null {
  const dirs = pathEnv.split(delimiter).filter((dir) => dir.length > 0);
  let mbxAt = -1;
  let agentAt = -1;
  for (let i = 0; i < dirs.length; i++) {
    if (mbxAt < 0 && executableFile(join(dirs[i], "mbx"))) mbxAt = i;
    if (agentAt < 0 && executableFile(join(dirs[i], "agentmbx"))) agentAt = i;
    if (mbxAt >= 0 && agentAt >= 0) break;
  }
  if (mbxAt < 0) return null;
  // Same directory, or agentmbx earlier: `mbx` is not ahead of `agentmbx`.
  if (agentAt >= 0 && mbxAt >= agentAt) return null;
  const mbx = join(dirs[mbxAt]!, "mbx");
  if (agentAt >= 0 && sameFile(mbx, join(dirs[agentAt]!, "agentmbx"))) return null;
  return {
    level: "warn",
    label: `legacy mbx shim is ahead of agentmbx on PATH (${mbx})`,
    fix: `mv ${shQuote(mbx)} ${shQuote(`${mbx}.legacy`)}`,
  };
}

export async function doctor(ctx: SetupCtx, mbxHome: string, opts: { peerTimeoutMs?: number } = {}): Promise<Check[]> {
  const out: Check[] = [];
  const add = (level: Level, label: string, fix?: string) => out.push({ level, label, fix });
  add("info", `agentmbx ${VERSION} (node ${process.versions.node})`);
  if (Number(process.versions.node.split(".")[0]) < 24) add("fail", `Node ${process.versions.node} is too old`, "install Node 24 or later");

  // T314: stay out of the grok block. OpenCode's own doctor function must not collide with this.
  const legacy = legacyMbxShim();
  if (legacy) out.push(legacy);

  const initialized = existsSync(join(mbxHome, "config.json"));
  let node: MbxNode | null = null;
  if (!initialized) add("fail", `host not initialized (${mbxHome})`, "agentmbx setup   (or: agentmbx init --host <name>)");
  else {
    node = new MbxNode(mbxHome);
    add("ok", `host ${node.host} initialized (key ${fingerprint(node.key.publicKey)})`);
    out.push(await daemonReadiness(node));
  }

  for (const d of detect(ctx)) {
    if (!d.found) { if (d.why !== "not found") add("info", `${d.cli}: ${d.why}`); continue; }
    const es = edits(ctx, d.cli);
    for (const kind of ["mcp", "hooks", "sidebar"] as const) {
      const e = es.filter((x) => x.kind === kind);
      if (!e.length) continue;
      const ok = e.every(wired);
      const what = kind === "mcp" ? "MCP server" : kind === "sidebar" ? "sidebar plugin" : "hooks";
      add(ok ? "ok" : "fail", `${d.cli}: ${what} ${ok ? "wired" : "not wired"} (${e.map((x) => x.path.replace(ctx.home, "~")).join(", ")})`, ok ? undefined : `agentmbx setup --only ${d.cli}`);
    }
    // The status line is optional and never fails doctor (review minor 7). T368: the checks are
    // static and per-CLI — ours must be a CURRENT form, foreign must be truly foreign.
    for (const c of statuslineChecks(ctx, d.cli)) out.push(c);
    if (d.cli === "claude") for (const c of claudePluginChecks(ctx.home, ctx)) out.push(c);
    // T391: the opencode service check is its own function (never a new top-level grok/opencode
    // collision — see the T435 note above) and runs only when an opencode mailbox is bound.
    if (d.cli === "opencode" && node) { const c = await opencodeServiceCheck(node); if (c) out.push(c); }
    if (d.cli === "opencode" && node) { const c = opencodeEvictionCheck(node.store.db); if (c) out.push(c); }
    // T460: its own function too (the T435 rule): a refused hooks layout and the not-approved state are Hermes facts.
    if (d.cli === "hermes") for (const c of hermesHooksChecks(ctx)) out.push(c);
    // T502/T504: the explicit MCP startup timeout and the resolved command path are checked for
    // every CLI (each function gates itself: silent until wired, and silent for CLIs whose config
    // has no timeout field at all).
    for (const c of mcpTimeoutChecks(ctx, d.cli)) out.push(c);
    for (const c of mcpCommandChecks(ctx, d.cli)) out.push(c);
    // T384: a command string that matches what setup would write is still "wired". Flag the path
    // itself when that file is gone, including a stale …/agentmbx that install would rewrite.
    if (d.cli === "grok") {
      // T385: this is a fact about the harness, not a broken install. Setup cannot add a push path.
      add("info", `grok: ${GROK_NO_PUSH}`);
      // T435: stay inside this block. OpenCode (T391) adds its own doctor function and must not
      // collide with a new top-level grok check. A warn does not fail doctor.
      if (node) {
        const held = node.store.db.prepare(
          "SELECT agent, session_id FROM sessions WHERE cli='grok' AND session_id NOT LIKE 'mcp-%'"
        ).all() as { agent: string; session_id: string }[];
        for (const s of held) if (!liveWatcher(node, s.agent))
          add("warn", `grok: ${s.agent} has no live mbx watcher`, `agentmbx watch --cli grok --session ${s.session_id}`);
      }
      const command = grokMcpConfiguredCommand(ctx.home);
      if (command && command.includes("/") && !existsSync(command))
        add("fail", `grok: MCP command path does not exist (${command})`, "agentmbx setup --only grok");
    }
  }

  if (node) {
    for (const d of detect(ctx).filter((d) => d.found)) out.push(sessionReadiness(node, d.cli));
    for (const c of kimiServerHooks(ctx.home)) out.push(c);
  }

  const sk = skillStatus(ctx.home);
  // S1: an outdated copy AgentMBX wrote is refreshed by the next session or daemon start, so it is info, not a warning
  add(sk.installed ? "ok" : sk.state === "outdated" ? "info" : "warn", `skill ${sk.detail} (~/.agents/skills/agentmbx)`,
    sk.installed || sk.state === "outdated" ? undefined : sk.state === "missing" ? "agentmbx setup --only skill (or: npx skills add kryptobaseddev/agentmbx -g)" : "agentmbx setup --only skill");
  for (const l of sk.links) if (!l.ok) add("warn", `${l.cli}: skill not linked at ${l.path.replace(ctx.home, "~")}`, "agentmbx setup --only skill");

  if (node) {
    const owner = ownerInfo(node.home);
    if (!owner) add("info", `no owner key on this host (optional: agentmbx owner init${authHelperPath() ? ", approve the Touch ID prompt" : ", in a terminal"})`);
    else if (owner.backend === "file") add("ok", `owner key ${fingerprint(owner.public_key)} (passphrase file ${owner.path})`);
    else {
      const st = await keychainOwnerStatus(node.home);
      add(st.ok ? "ok" : "fail", `owner key ${fingerprint(owner.public_key)} (macOS Keychain, Touch ID)${st.ok ? "" : `: ${st.detail}`}`,
        st.ok ? undefined : "reinstall AgentMBX.app (agentmbx daemon install); if the Keychain key is gone, move owner.json aside and run agentmbx owner init");
    }
    // T104: mail that relay depth kept from waking its mailbox
    for (const a of node.agents().filter((x) => x.host === node!.host)) {
      try {
        const sup = node.depthSuppressed(a.name);
        if (sup.length) add("warn", `${a.name}: ${sup.length} unread message(s) from ${[...new Set(sup.map((x) => x.from))].join(", ")} did not wake it (relay depth ${Math.max(...sup.map((x) => x.hop))} over the policy allowance)`,
          "the owner's next prompt in that session resets the depth; a collaborate policy allows 20, autonomous/yolo have no limit");
      } catch { /* unreadable mailbox: other checks report it */ }
    }
    // T211: mailboxes nobody is holding, sessions waiting on a remembered identity, prune weight
    for (const c of strandedMail(node)) out.push(c);
    for (const c of pendingIdentities(node)) out.push(c);
    for (const c of identityClaimChurn(node)) out.push(c);
    for (const c of foreignSessionProvider(node)) out.push(c);
    out.push(pruneSummary(node));
    const peers = node.peers();
    const approved = peers.filter((p) => p.state === "approved");
    if (!approved.length) add("info", "no paired hosts (optional: agentmbx pair <host>:7373)");
    await Promise.all(approved.map(async (p) => {
      try {
        const path = "/v1/agents";
        const res = await fetch(`http://${p.addr}${path}`, { headers: signHop(node!, "GET", path, ""), signal: AbortSignal.timeout(opts.peerTimeoutMs ?? 3000) });
        if (res.ok) add("ok", `peer ${p.host} (${p.addr}) reachable and accepts our signature`);
        else add("warn", `peer ${p.host} (${p.addr}) answered ${res.status}: ${(await res.text()).slice(0, 120)}`, `re-pair: agentmbx peers remove ${p.host} && agentmbx pair ${p.addr}`);
      } catch (e) {
        const seen = node!.store.get(`peer-lastseen:${p.host}`);
        add("warn", `peer ${p.host} (${p.addr}) unreachable: ${(e as Error).message}${seen && seen !== p.addr ? `; last seen at ${seen}` : ""}`,
          seen && seen !== p.addr ? `the daemon re-checks it every minute; to move it now: agentmbx peers addr ${p.host} ${seen}` : `check that its daemon runs and TCP ${p.addr.split(":").pop()} is open`);
      }
      // T201: how this peer's address was last healed, and how fresh its presence beacon is
      try {
        const heal = JSON.parse(node!.store.get(`peer-heal:${p.host}`) ?? "null") as { via: string; at: string; from: string; to: string } | null;
        const pres = node!.store.get(`peer-presence-at:${p.host}`);
        if (heal || pres) add("info", `peer ${p.host}: ${heal ? `address healed ${heal.from} -> ${heal.to} via ${heal.via} at ${heal.at}` : "address never healed"}; ${pres ? `last presence ${pres}` : "no presence beacon yet (peer runs an older AgentMBX)"}`);
      } catch { /* malformed kv: nothing to report */ }
    }));
    for (const p of peers.filter((x) => x.state === "pending")) add("warn", `pairing with ${p.host} pending (code ${p.code})`, `if ${p.host} shows the same code: agentmbx pair approve ${p.host} ${p.code}`);
    const relay = process.env.MBX_RELAY_URL ?? (node.config as { relay?: string }).relay ?? null;
    if (relay) {
      // G13, T168: the client keys its enrolment by host key (v1) or by host key, relay key and epoch (v2). Only the flag
      // for the pinned relay key and the current epoch counts: one from another key or epoch is stale and proves nothing.
      const db = node.store.db, hostPub = node.key.publicKey, get = (k: string) => node!.store.get(k);
      const pinned = get(`relay-key:${relay}`), epoch = get(`relay-epoch:${relay}`), src = get(`relay-key-src:${relay}`), expect = get(`relay-key-expect:${relay}`);
      const enrolled = get(`relay-enrolled:${relay}:${hostPub}`) ?? (pinned && epoch ? get(`relay-enrolled-v2:${relay}:${hostPub}:${pinned}:${epoch}`) : null);
      const keyNote = pinned ? `relay key ${fingerprint(pinned)} pinned ${src === "owner" ? "by the owner (relay set --key)" : src === "relay set" ? "at relay set" : "on first use"}`
        : expect ? `relay key not pinned yet: only ${expect} will be accepted` : "relay key not pinned yet (pinned on first contact)";
      add(enrolled ? "ok" : "warn", `relay configured: ${relay}${enrolled ? " (enrolled)" : " (not yet enrolled — the daemon enrols on its next pass)"}; ${keyNote}`,
        enrolled ? undefined : `check the relay is running: agentmbx relay serve --port …`);
      const n = (sql: string, ...a: string[]) => Number((db.prepare(sql).get(...a) as { c: number }).c);
      const mismatch = (() => { try { return JSON.parse(get(`relay-key-mismatch:${relay}`) ?? "null") as { how: string; pinned: string; served: string; at: string } | null; } catch { return null; } })();
      if (mismatch) add("fail", `relay ${relay} now serves a different key than the one ${mismatch.how === "expected" ? "relay set --key named" : "pinned"}: relay use is stopped (${mismatch.how} ${mismatch.pinned}, served ${mismatch.served}, since ${mismatch.at})`,
        `confirm with the relay operator that it rotated its key, then: agentmbx relay set ${relay} --key ${mismatch.served}`);
      // T168: what the daemon's last relay pass found. Every failure keeps mail queued; say so, with the reason.
      const st = relayState(node, relay), queued = n("SELECT COUNT(*) c FROM outbox");
      const held = queued ? `; ${queued} message(s) wait in the outbox (the LAN keeps trying; after ${RETRY_HOURS} h undelivered mail alerts its sender)` : "";
      if (st?.state === "enrol-failed") add(st.status === 401 || st.status === 403 ? "fail" : "warn", `relay ${relay} refused this host's enrolment since ${st.at} (${st.detail}): relay mail is paused${held}`,
        st.status === 403 ? "this host key is revoked or not authorized on that relay: ask its operator (the daemon retries every pass)" : "the daemon re-enrols every pass; check the relay is reachable and runs a current agentmbx");
      else if (st?.state === "clock-skew") add("fail", `relay ${relay} refuses this host's signed requests right after enrolling it (since ${st.at}): ${st.detail}; relay mail is paused${held}`,
        `set this host's clock right (turn on network time: macOS System Settings > General > Date & Time, Linux timedatectl set-ntp true); the daemon retries enrolment with backoff, next at ${st.next_at}`);
      else if (st?.state === "refused-after-enrol") add("fail", `relay ${relay} refuses this host's signed requests right after enrolling it (since ${st.at}): ${st.detail}; relay mail is paused${held}`,
        `check the relay's log and version with its operator; the daemon retries enrolment with backoff, next at ${st.next_at}`);
      else if (st?.state === "enc-ad-failed") add("warn", `relay ${relay} has not taken this host's encryption key ad since ${st.at} (${st.detail}): peers cannot seal relay mail for this host${held}`, "the daemon republishes every pass");
      else if (st?.state === "unreachable") add("warn", `relay ${relay}: ${st.detail} since ${st.at}${held}`, "the daemon retries every pass");
      else if (st?.state === "ok" && st.enc_ad_exp === null) add("warn", `relay ${relay} runs an agentmbx too old to store expiring encryption ads: peers on this version cannot seal relay mail for this host unless they learned its key on the LAN`, "upgrade the relay");
      else if (st?.state === "ok" && st.enc_ad_exp) add("info", `this host's encryption key ad at the relay is valid until ${st.enc_ad_exp} (republished daily)`);
      if (st?.state === "ok" && st.v1_stale) add("warn", `relay ${relay} still serves an old v1 encryption key for this host (${st.v1_stale}) and refuses v1 updates${st.v1_down ? ` (${st.v1_down})` : ""}: senders on 0.5.6 or older would seal relay mail for a key this host no longer holds (upgraded senders use the signed v2 ad)`,
        "ask the relay operator to drop this host's v1 enc-key ad or accept v1 updates again; upgrade older peers");
      for (const r of db.prepare("SELECT k, v FROM kv WHERE k LIKE 'relay-enc-rejected:%'").all() as { k: string; v: string }[]) {
        const host = r.k.slice("relay-enc-rejected:".length), waiting = n("SELECT COUNT(*) c FROM outbox WHERE host=?", host);
        let reason = "";
        try { reason = String((JSON.parse(r.v) as { reason?: string }).reason ?? ""); } catch { /* shown without a reason */ }
        if (waiting && reason.startsWith(ROLLBACK_REASON)) add("warn", `${waiting} message(s) for ${host} wait: the relay served an older encryption key ad for it than one already accepted, a possible replay of a retired key (${reason}); nothing is sealed for the older key`,
          `it clears when the relay serves ${host}'s current ad (republished daily) or ${host} is reachable on the LAN; if it persists, the relay is replaying old ads`);
        else if (waiting) add("warn", `${waiting} message(s) for ${host} wait: the relay offers no valid encryption key ad for it (${reason}), and nothing is sealed for an unverified key`,
          `${host} must run a current agentmbx with this relay configured, or reach this host on the LAN once (its key is then pinned)`);
      }
      const waiting = n("SELECT COUNT(*) c FROM relay_sent WHERE relay=? AND state='relay-accepted'", relay);
      if (waiting) add("info", `${waiting} message(s) accepted by the relay, waiting for the recipient host's delivery receipt`);
      const repush = n("SELECT COUNT(*) c FROM relay_sent WHERE relay=? AND state='repush'", relay);
      if (repush) add("info", `${repush} message(s) to push again after a relay restore (kept until the relay accepts them, a delivery receipt or their deadline)`);
      const expired = n("SELECT COUNT(*) c FROM relay_sent WHERE relay=? AND state='expired'", relay);
      if (expired) add("warn", `${expired} relay message(s) expired undelivered: the recipient host never collected them (their senders were alerted)`);
      const rejected = n("SELECT COUNT(*) c FROM relay_sent WHERE relay=? AND state='rejected'", relay);
      if (rejected) add("warn", `${rejected} message(s) waiting for a re-push after a relay restore were rejected by the recipient host over the LAN (their senders were alerted)`);
      const unconfirmed = n("SELECT COUNT(*) c FROM relay_sent WHERE relay=? AND state='unconfirmed'", relay);
      if (unconfirmed) add("warn", `${unconfirmed} relay delivery(ies) never confirmed by the recipient host (their senders were alerted)`);
      const rotFail = db.prepare("SELECT at, detail FROM audit WHERE event='relay.rotate_failed' ORDER BY at DESC LIMIT 1").get() as { at: string; detail: string } | undefined;
      const rotDone = Number(node.store.get(`relay-rotations:${relay}`) ?? 0);
      if (rotFail && rotDone < rotationLog(node.home).records.length) add("warn", `the relay has not taken this host's key rotation yet (last try ${rotFail.at}: ${rotFail.detail})`, "the daemon retries every pass; check the relay is reachable and runs a v2 relay");
      const quarantined = n("SELECT COUNT(*) c FROM relay_quarantine WHERE relay=?", relay);
      if (quarantined) add("warn", `${quarantined} relay item(s) this host could not accept are in quarantine`, "agentmbx relay quarantine");
    }
    node.close();
  }
  return out;
}

export const failed = (checks: Check[]) => checks.some((c) => c.level === "fail");

export function formatChecks(checks: Check[]): string {
  const mark: Record<Level, string> = { ok: "✔", fail: "✗", warn: "!", info: "·" };
  return checks.map((c) => `${mark[c.level]} ${c.label}${c.fix ? `\n    fix: ${c.fix}` : ""}`).join("\n");
}

/** The first word of a POSIX shell command line, unquoted: setup writes paths with shJoin (single quotes, `'\\''` for a
 *  quote); a hand-written command may use double quotes or a bare word. Null when the word is unterminated. */
export function firstShellWord(line: string): string | null {
  let out = "", i = 0;
  while (i < line.length && line[i] === " ") i++;
  if (i >= line.length) return null;
  while (i < line.length && line[i] !== " ") {
    const c = line[i];
    if (c === "'") { const end = line.indexOf("'", i + 1); if (end < 0) return null; out += line.slice(i + 1, end); i = end + 1; }
    else if (c === '"') { let j = i + 1; for (; j < line.length && line[j] !== '"'; j++) { if (line[j] === "\\" && j + 1 < line.length) j++; out += line[j]; } if (j >= line.length) return null; i = j + 1; }
    else if (c === "\\" && i + 1 < line.length) { out += line[i + 1]; i += 2; }
    else { out += c; i++; }
  }
  return out;
}
