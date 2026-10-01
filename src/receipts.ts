// Send-time recipient truth (T205): who a message actually reached, decided when it is sent, so a sender never mistakes
// "stored in a mailbox" for "an agent will see it". Liveness comes from the identity lease and its existing process
// evidence only; this module adds no process inspection of its own.
import { IdentityLeases, identityLeaseStatus, type IdentityLease } from "./identity-leases.ts";
import type { MbxNode, RouteTarget } from "./node.ts";
import { hasWakeAuthority } from "./wake.ts";
import { procTable } from "./proc.ts";
import { activityKey, parseActivity, SHARED_IDLE_MS } from "./identity-availability.ts";

/** A holder renews its lease every minute; three missed beats mean its session is suspended or gone. */
const STALE_HEARTBEAT_MS = 3 * 60_000;

export type RecipientState = "live-wake" | "live-next-prompt" | "offline" | "forwarded" | "remote";
export interface RecipientReceipt { to: string; address: string; state: RecipientState; detail: string }

const iso = (ms: number) => new Date(ms).toISOString();

/** Is a session holding `name` right now? Unknown process evidence with a fresh heartbeat counts as live (it is the
 *  lease's own rule for "unknown"); everything else says since when and who held it last. */
export function mailboxLiveness(node: MbxNode, name: string, now = Date.now()): { live: boolean; detail: string } {
  const row = node.store.db.prepare("SELECT * FROM identity_leases WHERE name=?").get(name) as unknown as IdentityLease | undefined;
  if (!row) return { live: false, detail: "no session has ever held this mailbox; it is read when an agent claims it" };
  let state: "live" | "unknown" | "expired" = "unknown", reason: string | null = null;
  try { ({ state, reason } = identityLeaseStatus(row, now, new IdentityLeases(node.store).processEvidence(row.holder_pid))); }
  catch {
    // Evidence can't be inspected inside a transaction: judge by the lease row, the process table snapshot taken before
    // it (a vanished holder is gone) and the heartbeat, which a live holder renews every minute (T204 review).
    const table = procTable();
    if (row.released_at !== null || now - row.heartbeat_at >= row.idle_ttl) { state = "expired"; reason = row.released_at !== null ? null : "idle"; }
    else if (table.size && !table.has(row.holder_pid)) { state = "expired"; reason = "dead"; }
    else if (now - row.heartbeat_at >= STALE_HEARTBEAT_MS) { state = "expired"; reason = `no heartbeat for ${Math.round((now - row.heartbeat_at) / 60_000)} min`; }
  }
  const holder = `${row.cli} session ${row.session_id.slice(0, 12)}`;
  if (state === "live" || state === "unknown") {
    const activity = parseActivity(node.store.get(activityKey(name)));
    const quiet = activity?.shared && now - activity.at >= SHARED_IDLE_MS
      ? `; its conversation has made no mbx call for ${Math.round((now - activity.at) / 60_000)} min and may have ended` : "";
    return { live: true, detail: state === "live" ? `held by ${holder}${quiet}`
      : `held by ${holder} (process unconfirmed, heartbeat ${Math.round((now - row.heartbeat_at) / 1000)} s ago)${quiet}` };
  }
  const since = row.released_at ?? row.heartbeat_at;
  const why = row.release_reason ?? reason ?? "released";
  return { live: false, detail: `no live session since ${iso(since)} (last holder ${holder}, ${why})` };
}

/** One receipt per resolved target of a stored message. */
export function recipientReceipts(node: MbxNode, msgId: string, targets: RouteTarget[], now = Date.now()): RecipientReceipt[] {
  const m = node.message(msgId);
  const out: RecipientReceipt[] = [];
  for (const t of targets) {
    if (t.host) {
      const p = node.peer(t.host);
      out.push({ to: t.to, address: `${t.name ?? "*"}@${t.host}`, state: "remote", detail: `queued for paired host ${t.host}${p ? ` at ${p.addr}` : ""}; its daemon decides wake and liveness` });
      continue;
    }
    const name = t.name!;
    const address = `${name}@${node.host}`;
    if (name === "owner") { out.push({ to: t.to, address, state: "live-next-prompt", detail: "the owner sees it in agentmbx inbox and as a desktop notification" }); continue; }
    const live = mailboxLiveness(node, name, now);
    let state: RecipientState, detail: string;
    if (!live.live) { state = "offline"; detail = live.detail; }
    else {
      const mode = node.deliveryMode(name);
      const why = !m ? "message not found" : !node.wantsWake(name, m) ? "this kind does not wake (status, or no needs_reply/mention)"
        : !mode.startsWith("push") ? "the session has no push path" : !hasWakeAuthority(node, name, m) ? "no owner policy lets this sender wake it" : null;
      state = why ? "live-next-prompt" : "live-wake";
      detail = why ? `${live.detail}; seen on its next prompt: ${why}` : `${live.detail}; woken now (${mode})`;
    }
    if (t.renamed_from) { detail = `${t.renamed_from} was renamed to ${name}; ${state}: ${detail}`; state = "forwarded"; }
    out.push({ to: t.to, address, state, detail });
  }
  return out;
}

/** Warning lines for recipients nobody will read soon. */
export const offlineWarnings = (rs: RecipientReceipt[]): string[] =>
  rs.filter((r) => r.state === "offline" || (r.state === "forwarded" && /offline: /.test(r.detail)))
    .map((r) => `${r.address} is offline: ${r.detail.replace(/^.*offline: /, "")}. The message waits in its mailbox; tell your user if it is urgent.`);

/** Levenshtein distance, capped (names are at most 40 characters). */
function distance(a: string, b: string): number {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++)
    d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[a.length][b.length];
}

/** Up to 3 existing local names close to `name` (prefix match or edit distance <= 2). */
export function suggestNames(node: MbxNode, name: string): string[] {
  const names = new Set<string>([
    ...node.agents().filter((a) => a.host === node.host).map((a) => a.name),
    ...(node.store.db.prepare("SELECT name FROM identity_leases").all() as { name: string }[]).map((r) => r.name),
  ]);
  return [...names].map((n) => ({ n, d: n.startsWith(name) || name.startsWith(n) ? 0 : distance(n, name) }))
    .filter((x) => x.d <= 2 && x.n !== name).sort((a, b) => a.d - b.d || a.n.localeCompare(b.n)).slice(0, 3).map((x) => x.n);
}

/** Refuse a send to a local name that never existed instead of silently creating a mailbox (T205). Checked before
 *  anything is stored; `name@otherhost` is the other host's business. */
export function assertKnownRecipients(node: MbxNode, to: string[]): void {
  const unknown = node.route(to).targets.filter((t) => t.unknown).map((t) => t.name!);
  if (!unknown.length) return;
  const lines = unknown.map((n) => { const s = suggestNames(node, n); return `"${n}" is not an agent on ${node.host}${s.length ? `; did you mean ${s.join(", ")}?` : ""}`; });
  throw Object.assign(new Error(`not sent: ${lines.join("; ")}. List agents with mbx_agents; a mailbox exists once an agent has held it.`), { code: "UNKNOWN_RECIPIENT" });
}
