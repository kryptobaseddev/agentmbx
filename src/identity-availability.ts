// One answer to "can this identity be claimed now?", used by both mbx_identity list and the claim itself (T204, R4.3), so
// a name the list calls available is never refused by the claim for a reason the list didn't show.
import { globSync, lstatSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { identityLeaseStatus, type IdentityLease, type ProcessEvidence } from "./identity-leases.ts";
import { procStartEpochMs } from "./proc.ts";

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
  /**
   * T439: the live holder is this same provider session's MCP server under the caller's own provider process, so the caller
   * is a sibling MCP client of that session (OpenCode code mode, a transient Codex connection). It co-uses the holder's
   * lease: it acts as the identity under the holder's lease token without taking, renewing or releasing it.
   */
  coUse?: true;
}

const minutes = (ms: number) => `${Math.max(1, Math.round(ms / 60_000))} min`;
const CODEX_THREAD = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;

interface HarnessHomes { codexHome?: string; grokSessionsFile?: string }
interface HarnessStamp { at: number; source: string }

/** A stamp counts only when it is a real past moment from this holder's lease, never a future or pre-lease mtime. */
function usableStamp(at: number, now: number, claimedAt: number): number | null {
  return Number.isSafeInteger(at) && at >= 0 && at <= now && at > claimedAt ? at : null;
}

function fileMtime(path: string): number | null {
  try {
    const stat = lstatSync(path);
    return stat.isFile() ? Math.floor(stat.mtimeMs) : null;
  } catch { return null; }
}

function pidAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (e) { return (e as NodeJS.ErrnoException).code === "EPERM"; }
}

/** Exact-thread rollout mtime. Metadata only: the same one-file rule as CodexActivity, and the body is never opened. */
function codexRolloutActivity(sessionId: string, home: string, now: number, claimedAt: number): HarnessStamp | null {
  if (!CODEX_THREAD.test(sessionId)) return null;
  try {
    const found = globSync(`sessions/*/*/*/rollout-*-${sessionId.toLowerCase()}.jsonl`, { cwd: home });
    if (found.length !== 1) return null;
    const at = usableStamp(fileMtime(join(home, found[0])) ?? -1, now, claimedAt);
    return at === null ? null : { at, source: "codex rollout" };
  } catch { return null; }
}

/** A live row in Grok's active_sessions.json is a heartbeat at decision time. A dead or reused pid is not activity. */
function grokSessionActivity(sessionId: string, file: string, now: number, claimedAt: number): HarnessStamp | null {
  try {
    const rows = JSON.parse(readFileSync(file, "utf8")) as unknown;
    if (!Array.isArray(rows)) return null;
    const matches = rows.filter((r): r is { pid: number; opened_at?: unknown } =>
      !!r && typeof r === "object" && (r as { session_id?: unknown }).session_id === sessionId
      && Number.isSafeInteger((r as { pid?: unknown }).pid) && ((r as { pid: number }).pid) > 0);
    if (matches.length !== 1 || !pidAlive(matches[0].pid)) return null;
    const opened = typeof matches[0].opened_at === "string" ? Date.parse(matches[0].opened_at) : NaN;
    const startMs = procStartEpochMs(matches[0].pid);
    if (Number.isFinite(opened) && startMs !== null && opened < startMs) return null;
    const at = usableStamp(now, now, claimedAt);
    return at === null ? null : { at, source: "grok session" };
  } catch { return null; }
}

function harnessActivity(lease: IdentityLease, now: number, homes?: HarnessHomes): HarnessStamp | null {
  if (lease.cli === "codex") return codexRolloutActivity(lease.session_id, homes?.codexHome ?? (process.env.CODEX_HOME || join(homedir(), ".codex")), now, lease.claimed_at);
  if (lease.cli === "grok") {
    const file = homes?.grokSessionsFile ?? (process.env.MBX_GROK_SESSIONS_FILE
      || join(process.env.GROK_HOME || join(homedir(), ".grok"), "active_sessions.json"));
    return grokSessionActivity(lease.session_id, file, now, lease.claimed_at);
  }
  return null;
}

/** The provider a holder recorded at claim (`mcp-provider:<mcpPid>`). Start is the lease-layer birth time, not a proc-table field. */
export interface RecordedProvider { pid: number; start: string; harness?: true }
export const providerRecordKey = (mcpPid: number): string => `mcp-provider:${mcpPid}`;

/** A kv value is a provider record only when both fields are present and bounded. Anything else is "no record". */
export function parseProviderRecord(raw: string | null | undefined): RecordedProvider | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as { providerPid?: unknown; providerStart?: unknown; harness?: unknown };
    const pid = parsed.providerPid, start = parsed.providerStart;
    if (typeof pid !== "number" || !Number.isSafeInteger(pid) || pid <= 0) return null;
    if (typeof start !== "string" || start.length === 0 || start.length > 300) return null;
    return { pid, start, ...(parsed.harness === true ? { harness: true as const } : {}) };
  } catch { return null; }
}

/**
 * valid: the recorded pid is still that process (live, same birth, present in the table).
 * dead: the pid is gone. reused: the pid is live but it is a different process. unknown: the evidence cannot decide.
 */
export type RecordedProviderVerdict = "valid" | "reused" | "dead" | "unknown";
export function recordedProviderVerdict(table: Map<number, { ppid: number }>, recorded: RecordedProvider, evidence: ProcessEvidence): RecordedProviderVerdict {
  // Death is decided before the table: a dead pid is absent from it, and must not fall through to a live ancestor (T317).
  if (evidence.alive === false) return "dead";
  if (evidence.alive !== true || evidence.start === null) return "unknown";
  if (evidence.start !== recorded.start) return "reused";
  if (!table.has(recorded.pid)) return "unknown";
  return "valid";
}

/**
 * The provider process a lease holder serves under. A valid or dead recorded provider wins over the ancestry walk: a
 * reparented server must not look like it moved to launchd, and a reused pid must not be trusted. With no usable record,
 * the answer is the holder's parent, or `callerProvider` when that process is anywhere in the holder's ancestry (a
 * reloaded server is the child of the server it replaced). Null when the holder is not in `table`.
 */
export function holderProviderPid(table: Map<number, { ppid: number }>, holderPid: number, callerProvider?: number,
  recorded?: RecordedProvider | null, evidence?: ProcessEvidence | null): number | null {
  if (recorded && evidence) {
    const verdict = recordedProviderVerdict(table, recorded, evidence);
    if (verdict === "valid" || verdict === "dead") return recorded.pid;
  }
  const parent = table.get(holderPid)?.ppid;
  if (!parent) return null;
  for (let p: number | undefined = parent, n = 0; p && p > 1 && n < 16; p = table.get(p)?.ppid, n++) if (p === callerProvider) return p;
  return parent;
}

/**
 * The same provider answer for list and claim. A dead record reports that pid with `holderProviderAlive: false` so the
 * caller does not walk up to a live ancestor. A reused or missing record uses the ancestry walk, and a live ancestor is
 * then alive.
 */
export function holderProviderView(table: Map<number, { ppid: number }>, holderPid: number, callerProvider: number | undefined,
  recorded: RecordedProvider | null, evidence: ProcessEvidence | null, canonicalHarness = false): { holderProviderPid: number | null; holderProviderAlive: boolean | null } {
  const verdict = recorded && evidence ? recordedProviderVerdict(table, recorded, evidence) : null;
  // A proven harness caller may normalize an older connector's runtime provider record.
  if (canonicalHarness && verdict === "valid" && recorded && callerProvider !== undefined) {
    for (let p = recorded.pid, n = 0; p > 1 && n < 16; n++) {
      if (p === callerProvider) return { holderProviderPid: callerProvider, holderProviderAlive: true };
      const parent = table.get(p)?.ppid;
      if (!parent) break;
      p = parent;
    }
  }
  const useRecord = verdict === "valid" || verdict === "dead";
  const holderProvider = holderProviderPid(table, holderPid, callerProvider, useRecord ? recorded : null, useRecord ? evidence : null);
  const holderProviderAlive = verdict === "valid" ? true : verdict === "dead" ? false : holderProvider != null ? true : null;
  return { holderProviderPid: holderProvider, holderProviderAlive };
}

export function identityAvailability(o: { lease?: IdentityLease; evidence: ProcessEvidence; activity: LeaseActivity | null; conflict?: boolean;
  now: number;
  /**
   * `providerPid`: the caller's provider process. `holderProviderPid`: the provider the live holder serves under.
   * `holderProviderAlive`: false only when that provider was confirmed dead. A pid mismatch without that proof is not takeover (T440).
   */
  caller?: { cli: string; sessionId: string; providerPid?: number; holderProviderPid?: number | null; holderProviderAlive?: boolean | null };
  /** Isolated Codex home or Grok session file. Omitted, the real harness locations are read. */
  homes?: HarnessHomes;
}): Availability {
  if (o.conflict) return { claimable: false, state: "conflict", reason: "historical ownership requires explicit owner recovery" };
  const lease = o.lease;
  if (!lease) return { claimable: true, state: "free", reason: "no session has held it under a lease" };
  const status = identityLeaseStatus(lease, o.now, o.evidence);
  if (status.state === "expired") return { claimable: true, state: "offline", reason: lease.released_at !== null ? lease.release_reason ?? "released" : status.reason ?? "expired" };
  const holder = `${lease.cli} session ${lease.session_id}`;
  if (status.state === "unknown") return { claimable: false, state: "unknown", reason: `held by ${holder}, whose process could not be verified right now; retry shortly` };
  const harness = harnessActivity(lease, o.now, o.homes);
  const mbxAt = o.activity?.at ?? null;
  const effectiveAt = Math.max(mbxAt ?? 0, harness?.at ?? 0);
  if (o.caller && lease.cli === o.caller.cli && lease.session_id === o.caller.sessionId && !o.caller.sessionId.startsWith("mcp-")) {
    // T383: a provider may start a second, short-lived MCP server for a session whose own server is still live and serving
    // (Codex did). T439: a server under the caller's own provider co-uses the lease. T440: a different parent is takeover
    // only when the holder's provider is confirmed dead — a shell-launched server must not evict a live one. Unknown
    // parentage never evicts a live holder and never co-uses it.
    const { providerPid, holderProviderPid: holderProvider, holderProviderAlive } = o.caller;
    // T608: the same conversation's other server, quiet for the stale threshold (D039), is stuck, not serving: this
    // session takes its own identity back without the owner. A holder still in use keeps it, so two live servers do not
    // trade the lease.
    const sessionQuiet = o.now - Math.max(o.activity?.at ?? lease.claimed_at, harness?.at ?? 0);
    if (holderProvider !== providerPid && sessionQuiet >= SHARED_IDLE_MS)
      return { claimable: true, state: "idle", reason: `held by an idle MCP server of this same ${lease.cli} session (pid ${lease.holder_pid}, no mbx activity for ${minutes(sessionQuiet)})`, takeover: "same-session" };
    if (providerPid !== undefined && holderProvider != null && holderProvider !== providerPid) {
      if (holderProviderAlive === false)
        return { claimable: true, state: "live", reason: `held by an older process of this same ${lease.cli} session`, takeover: "same-session" };
      if (holderProviderAlive === true)
        return { claimable: false, state: "live", reason: `held by the live MCP server of this same ${lease.cli} session (pid ${lease.holder_pid}); its provider process is still running. It becomes claimable from this session after ${minutes(SHARED_IDLE_MS)} without mbx activity` };
    }
    if (providerPid !== undefined && holderProvider === providerPid)
      return { claimable: false, state: "live", coUse: true, reason: `held by the live MCP server of this same ${lease.cli} session (pid ${lease.holder_pid}, same provider process); `
        + "a sibling server of this session co-uses it: it acts as that identity under the holder's lease, without taking or releasing it" };
    return { claimable: false, state: "live", reason: `held by a live process of this same ${lease.cli} session (pid ${lease.holder_pid}) whose provider process could not be verified; retry shortly` };
  }
  const quiet = mbxAt !== null ? o.now - mbxAt : null;
  const effectiveQuiet = mbxAt !== null || harness ? o.now - effectiveAt : null;
  if (o.activity?.shared && quiet !== null && quiet >= SHARED_IDLE_MS && (effectiveQuiet ?? quiet) >= SHARED_IDLE_MS)
    return { claimable: true, state: "idle", reason: `held by ${holder} in a shared ${lease.cli} process with no mbx activity for ${minutes(quiet)} (that conversation has probably ended)`, takeover: "idle-conversation" };
  const showHarness = harness !== null && (mbxAt === null || harness.at >= mbxAt);
  const suffix = showHarness ? `, last activity ${minutes(o.now - harness.at)} ago (${harness.source})` : quiet !== null ? `, last mbx activity ${minutes(quiet)} ago` : "";
  return { claimable: false, state: "live", reason: `held by live ${holder}${suffix}` };
}
