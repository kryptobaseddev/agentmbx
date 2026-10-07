// CLI ownership comes from the provider's exact current MCP lease, never from --as alone.
import { canonical } from "./crypto.ts";
import { findIdentityControl, identityControlKey, identityGeneration, inspectIdentityControlCaller, listIdentityControls, publishIdentityControl, type IdentityControlDescriptor } from "./identity-control.ts";
import { IdentityLeases, inspectLeaseProcess, UNKNOWN_RETRY_DELAYS_MS, type IdentityLease } from "./identity-leases.ts";
import { claudeSessionId, sleepSync } from "./proc.ts";
import { kimiInstances } from "./kimi-web.ts";
import type { MbxNode } from "./node.ts";

const refused = (message: string) => Object.assign(new Error(message), { code: "IDENTITY_LEASE_REQUIRED" });
/** Evidence that could not be read: neither a holder nor a refusal, so the caller retries it (T340). */
const unknownEvidence = (message: string) => Object.assign(new Error(message), { code: "IDENTITY_STATUS_UNKNOWN" });
const rowFor = (node: MbxNode, name: string) => node.store.db.prepare("SELECT * FROM identity_leases WHERE name=?").get(name) as unknown as IdentityLease | undefined;
const matches = (d: IdentityControlDescriptor, row: IdentityLease | undefined): row is IdentityLease => !!row && row.released_at === null
  && identityGeneration(row.token) === d.generation && row.key_fp === d.control_key && row.cli === d.cli
  && row.session_id === d.lease_session_id && row.holder_pid === d.mcp_pid && row.holder_start === d.mcp_start;

export interface CliIdentitySelection { as?: string; cli?: string; session?: string; readOnly?: boolean }

/** Proof collection happens outside SQLite; authorization and operation share the lease transaction. */
export function withCliIdentity<T>(node: MbxNode, selection: CliIdentitySelection, operation: (agent: string, descriptor: IdentityControlDescriptor) => T): T {
  if (operation.constructor.name === "AsyncFunction") throw refused("mailbox operations must be synchronous");
  if (!!selection.cli !== !!selection.session) throw refused("select both --cli and --session, or neither");
  const descriptors = selection.cli && selection.session ? [findIdentityControl(node.store, selection.cli, selection.session)] : listIdentityControls(node.store);
  return withIdentity(node, selection, descriptors, operation);
}

/** CLIs whose one provider process holds one conversation at a time: /clear, /new and /resume replace the session id
 *  of the same process and the same MCP holder (T460: Hermes TUI/CLI). A multi-session host is not one of them. */
export const REBINDING_CLIS: readonly string[] = ["claude", "hermes"];

/** A live OpenCode control under this serve whose lease still matches. A dead pid or a stale generation is not live. */
function opencodeHolderLive(node: MbxNode, descriptor: IdentityControlDescriptor): boolean {
  const evidence = inspectLeaseProcess(descriptor.mcp_pid);
  return descriptor.parent_pid === process.ppid && evidence.alive === true && matches(descriptor, rowFor(node, descriptor.agent));
}

/** The exact ses_ row, when it still belongs to a live MCP child of this serve. */
function liveOpencode(node: MbxNode, session: string): IdentityControlDescriptor | null {
  if (node.store.get(identityControlKey("opencode", session)) === undefined) return null;
  const current = findIdentityControl(node.store, "opencode", session);
  return opencodeHolderLive(node, current) ? current : null;
}

/**
 * Publish this ses_ id onto the one live MCP that already holds the agent named by `name:opencode:<sid>`.
 * Missing name, no live holder, or two holders: return null. Never pick "the one control under this parent".
 */
function restoreOpencode(node: MbxNode, session: string): IdentityControlDescriptor | null {
  const named = node.store.get(`name:opencode:${session}`);
  if (!named) return null;
  const holders = new Map<string, IdentityControlDescriptor>();
  for (const descriptor of listIdentityControls(node.store)) {
    if (descriptor.cli !== "opencode" || descriptor.agent !== named || descriptor.session_id === session) continue;
    if (!opencodeHolderLive(node, descriptor)) continue;
    const kept = holders.get(descriptor.control_key);
    if (!kept || descriptor.session_id === descriptor.lease_session_id) holders.set(descriptor.control_key, descriptor);
  }
  if (holders.size !== 1) return null;
  const holder = [...holders.values()][0];
  if (!holder) return null;
  if (node.store.get(identityControlKey("opencode", session)) !== undefined) {
    const current = findIdentityControl(node.store, "opencode", session);
    if (opencodeHolderLive(node, current) && current.agent !== named) return null;
  }
  const alias: IdentityControlDescriptor = { ...holder, session_id: session };
  publishIdentityControl(node.store, alias);
  return alias;
}

/** Hook bootstrap requires one holder; only Claude and Hermes may change real session IDs within that holder. */
export function withHookIdentity<T>(node: MbxNode, cli: string, session: string | undefined,
  operation: (agent: string, descriptor: IdentityControlDescriptor, bootstrap: boolean) => T, allowBootstrap = false): T {
  if (operation.constructor.name === "AsyncFunction") throw refused("hook operations must be synchronous");
  if (!session || session.length > 300 || session !== session.trim() || /[\u0000-\u001f\u007f-\u009f]/u.test(session) || session.startsWith("mcp-"))
    throw refused("hook requires a valid non-provisional session id");
  const all = listIdentityControls(node.store).filter(d => d.cli === cli && d.parent_pid === process.ppid);
  let descriptors: IdentityControlDescriptor[], bootstrap = false;
  const rebinds = REBINDING_CLIS.includes(cli);
  const rebindClaude = allowBootstrap && rebinds && !node.store.db.prepare("SELECT 1 FROM sessions WHERE cli=? AND session_id=?").get(cli, session);
  if (cli === "opencode") {
    // The parent set is ambiguous on a shared serve. Restore only the named agent's one live holder.
    const live = liveOpencode(node, session) ?? restoreOpencode(node, session);
    if (!live) throw refused("hook session has no exact current MCP binding");
    descriptors = [live];
  } else if (node.store.get(identityControlKey(cli, session)) !== undefined && !rebindClaude) descriptors = [findIdentityControl(node.store, cli, session)];
  else {
    // Hosted providers must first publish an exact session binding. Never bootstrap by directory.
    // Claude's /clear, /resume and compaction replace the session id of the same process, whose MCP holder carries the
    // id it started with: the provider's own session file naming exactly this session is the proof of that rotation.
    const rotated = cli === "claude" && claudeSessionId(process.ppid) === session;
    // Hermes: every alias of the one holder differs only in session_id (the canonical check below), so a real id left by an
    // earlier conversation of this process is replaced, never mistaken for a second holder.
    if (!allowBootstrap || ![...REBINDING_CLIS, "kimi"].includes(cli) || (cli === "kimi" && kimiInstances().some(instance => instance.pid === process.ppid)) || new Set(all.map(d => d.control_key)).size !== 1
      || all.some(d => (!d.lease_session_id.startsWith("mcp-") && !rotated) || (!rebinds && !d.session_id.startsWith("mcp-"))
        || !matches(d, rowFor(node, d.agent)) || canonical({ ...d, session_id: "" }) !== canonical({ ...all[0], session_id: "" })))
      throw refused("hook session has no exact current MCP binding");
    descriptors = all; bootstrap = true;
  }
  if (descriptors.some(d => d.parent_pid !== process.ppid)) throw refused("hook does not belong to this provider process");
  return withIdentity(node, { cli, session }, descriptors, (agent, descriptor) => {
    if (bootstrap && canonical(listIdentityControls(node.store).filter(d => d.cli === cli && d.parent_pid === process.ppid)) !== canonical(all))
      throw refused("hook bootstrap bindings changed before the operation");
    return operation(agent, descriptor, bootstrap);
  });
}

function withIdentity<T>(node: MbxNode, selection: CliIdentitySelection, descriptors: IdentityControlDescriptor[],
  operation: (agent: string, descriptor: IdentityControlDescriptor) => T): T {
  if (operation.constructor.name === "AsyncFunction") throw refused("mailbox operations must be synchronous");
  const leases = new IdentityLeases(node.store);
  const authorize = (): { descriptor: IdentityControlDescriptor; token: string; start: string } => {
    // Inspected on every attempt: a ps timeout leaves this process's birth time unknown, and a retry can read it (T340).
    const requester = inspectLeaseProcess(process.pid);
    if (requester.alive === false) throw refused("cannot verify the calling process");
    if (requester.alive !== true || !requester.start) throw unknownEvidence("cannot verify the calling process: its process evidence is unavailable; retry after inspection recovers");
    const candidates = new Map<string, { descriptor: IdentityControlDescriptor; token: string }>();
    let unknown = 0;
    for (const descriptor of descriptors) {
      const row = rowFor(node, descriptor.agent);
      if (!matches(descriptor, row)) continue;
      const proof = inspectIdentityControlCaller(descriptor, process.pid, requester.start);
      if (proof.state === "valid") candidates.set(descriptor.control_key, { descriptor, token: row.token });
      else if (proof.state === "unknown") unknown++;
    }
    // --as must not pick a different hosted session merely because it shares a provider parent.
    if (candidates.size > 1) throw refused("ambiguous provider sessions: specify --cli and --session");
    // Unknown evidence is not "no lease" (T340): it may be this caller's holder, or a second one that makes a lone
    // candidate ambiguous. Retry it; only definite refusals report at once.
    if (unknown) throw unknownEvidence("caller process evidence is unknown; retry after inspection recovers");
    if (!candidates.size) throw Object.assign(refused("no current identity lease belongs to this caller. Run mailbox commands inside the provider session that holds the lease (your agent session, through its mbx tools); inspect holders with `agentmbx identity list`. The owner can replace a live holder with `agentmbx identity takeover <name> --force --cli <provider> --session <id>`"),
      { code: "IDENTITY_NO_CALLER_LEASE" });
    const { descriptor, token } = [...candidates.values()][0];
    // OpenCode shells share the serve. A lone control is still not this session unless --session named it.
    if (!selection.session && descriptor.cli === "opencode") throw refused("opencode serves many sessions: specify --cli and --session");
    const [name, host, extra] = selection.as?.split("@") ?? [descriptor.agent];
    if (name !== descriptor.agent || (host !== undefined && host !== node.host) || extra !== undefined)
      throw refused(`this session holds ${descriptor.agent}@${node.host}, not the requested identity`);
    return { descriptor, token, start: requester.start };
  };
  // Unknown or stale caller evidence is retried with backoff; slow evidence collection must not
  // fail an otherwise-valid session (T206). A definite refusal is thrown at once, with no backoff (T340).
  for (let attempt = 0; ; attempt++) {
    if (attempt) sleepSync(UNKNOWN_RETRY_DELAYS_MS[attempt - 1]);
    try {
      const { descriptor, token, start } = authorize();
      return leases.prepare([descriptor.agent], [descriptor.mcp_pid], () => {
        const guarded = () => {
          // Re-collect the caller proof immediately before the operation: the freshness window then
          // measures from evidence-taken to operation-run, excluding collection time.
          const proof = inspectIdentityControlCaller(descriptor, process.pid, start);
          if (proof.state === "invalid") throw refused("the calling process no longer matches this session's identity holder");
          if (!proof.valid || performance.now() - proof.at > 5000) throw refused("caller process evidence became stale; retry after inspection");
          if (canonical(findIdentityControl(node.store, descriptor.cli, descriptor.session_id)) !== canonical(descriptor)
            || !matches(descriptor, rowFor(node, descriptor.agent))) throw refused("identity binding changed before the operation");
          return operation(descriptor.agent, descriptor);
        };
        return selection.readOnly ? leases.withHeldRead(descriptor.agent, token, guarded) : leases.withHeld(descriptor.agent, token, guarded);
      });
    } catch (e) {
      const retryable = (e as NodeJS.ErrnoException).code === "IDENTITY_STATUS_UNKNOWN"
        || /caller process evidence became stale/.test((e as Error).message);
      if (!retryable || attempt >= UNKNOWN_RETRY_DELAYS_MS.length) throw e;
    }
  }
}
