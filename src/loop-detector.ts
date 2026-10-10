// Possible automated conversation loops are observations, never delivery or wake gates (T537).
import { sha256, ulid } from "./crypto.ts";
import { checkShape, oneLine, verifyEnvelope, type Envelope } from "./envelope.ts";
import type { MbxNode } from "./node.ts";
import { notifyDesktop } from "./wake.ts";

export interface LoopDetectorConfig { message_threshold: number; window_minutes: number }
export const LOOP_DEFAULTS: Readonly<LoopDetectorConfig> = { message_threshold: 50, window_minutes: 10 };
export interface ConversationLoop {
  thread: string; agents: [string, string]; count: number; directions: [number, number];
  first_received_at: string; last_received_at: string; window_minutes: number;
}
const ADDRESS = /^[a-z0-9][a-z0-9-]{1,39}@[a-z0-9][a-z0-9-]{1,39}$/;

/** Invalid settings are diagnosed, rather than silently disabling reports. */
export function configuredLoopDetector(config: unknown): LoopDetectorConfig {
  const value = (config as { loop_detector?: Partial<LoopDetectorConfig> } | null)?.loop_detector;
  if (value !== undefined && (!value || typeof value !== "object" || Array.isArray(value))) throw new Error("loop_detector must be an object");
  const settings = { ...LOOP_DEFAULTS, ...value };
  if (!Number.isSafeInteger(settings.message_threshold) || settings.message_threshold < 1
    || !Number.isFinite(settings.window_minutes) || settings.window_minutes <= 0
    || !Number.isFinite(settings.window_minutes * 60_000)) throw new Error("loop_detector needs a positive integer message_threshold and positive window_minutes");
  return settings;
}

/** Read-only, including signatures. Receipt time is local; sender clocks cannot create or hide a rapid exchange. */
export function detectConversationLoops(node: MbxNode, now = Date.now()): ConversationLoop[] {
  const settings = configuredLoopDetector(node.config);
  const since = new Date(now - settings.window_minutes * 60_000).toISOString(), until = new Date(now).toISOString();
  const rows = node.store.db.prepare(`SELECT id,thread,from_addr,origin,trust,envelope,received_at,
    (SELECT json_group_array(agent) FROM deliveries WHERE msg_id=messages.id) delivered_to FROM messages
    WHERE received_at > ? AND received_at <= ? ORDER BY received_at,id`).iterate(since, until) as unknown as Iterable<
    { id: string; thread: string; from_addr: string; origin: string; trust: string; envelope: string; received_at: string; delivered_to: string }>;
  const pairs = new Map<string, ConversationLoop>(), keys = new Map<string, string[]>();
  for (const row of rows) {
    try {
      const e = JSON.parse(row.envelope) as Envelope;
      if (checkShape(e) || e.id !== row.id || e.thread !== row.thread || e.from !== row.from_addr
        || e.meta.sender_verification !== "leased" || e.authority !== null || !ADDRESS.test(e.from)) continue;
      const host = e.from.split("@")[1];
      if (e.sig?.host !== host || !(row.origin === "local" && host === node.host || row.origin === host && row.trust === "verified")) continue;
      if (!keys.has(host)) keys.set(host, node.hostKeys(host));
      if (!keys.get(host)!.some(key => verifyEnvelope(e, key))) continue;
      // Receipts resolve local broadcasts/bare names. The sending host can also resolve
      // its own bare remote destinations, just as relay-context lookup does.
      const destinations = new Set(e.to.filter(to => ADDRESS.test(to)));
      for (const agent of JSON.parse(row.delivered_to) as string[]) destinations.add(`${agent}@${node.host}`);
      if (host === node.host) for (const address of node.recipientAddrs(e.to) ?? []) destinations.add(address);
      else for (const agent of e.meta.local_names ?? []) destinations.add(`${agent}@${host}`);
      // A broadcast can list the same mailbox more than once. Count its envelope once per pair.
      for (const to of destinations) {
        if (!ADDRESS.test(to) || to === e.from) continue;
        const agents = [e.from, to].sort() as [string, string], key = JSON.stringify([e.thread, agents]);
        let pair = pairs.get(key);
        if (!pair) {
          pair = { thread: e.thread, agents, count: 0, directions: [0, 0], first_received_at: row.received_at,
            last_received_at: row.received_at, window_minutes: settings.window_minutes };
          pairs.set(key, pair);
        }
        pair.count++; pair.directions[e.from === agents[0] ? 0 : 1]++; pair.last_received_at = row.received_at;
      }
    } catch { /* Invalid retained mail is not evidence of a verified automated exchange. */ }
  }
  return [...pairs.values()].filter(p => p.count > settings.message_threshold && p.directions.every(n => n > 0));
}

export function conversationLoopLabel(loop: ConversationLoop): string {
  return `possible automated loop: ${loop.agents.join(" ↔ ")} exchanged ${loop.count} messages in ${loop.window_minutes} min (thread ${oneLine(loop.thread).slice(0, 80)}); delivery and wakes continue`;
}

type NoticeState = { last_notified_at?: number; pending_until?: number; token?: string };
type Notifier = (loop: ConversationLoop) => Promise<{ ok: boolean }>;
/** Only the daemon calls this reporter. Notification state is unrelated to mailbox state or wake reservations. */
export async function reportConversationLoops(node: MbxNode, deps: { now?: number; notify?: Notifier } = {}): Promise<ConversationLoop[]> {
  const now = deps.now ?? Date.now(), reported: ConversationLoop[] = [];
  const notify: Notifier = deps.notify ?? (loop => notifyDesktop({ subtitle: "Possible agent conversation loop", body: conversationLoopLabel(loop),
    id: `agentmbx-loop-${sha256(JSON.stringify([loop.thread, loop.agents])).slice(0, 16)}`, openCmd: "agentmbx doctor" }));
  for (const loop of detectConversationLoops(node, now)) {
    const key = `conversation-loop:${sha256(JSON.stringify([loop.thread, loop.agents]))}`;
    const claim = node.store.tx(() => {
      let previous: NoticeState = {};
      try {
        const cached = JSON.parse(node.store.get(key) ?? "{}");
        if (cached && typeof cached === "object") previous = cached;
      } catch { /* replace invalid notification cache only */ }
      if ((previous.last_notified_at ?? -Infinity) + loop.window_minutes * 60_000 > now || (previous.pending_until ?? 0) > now) return null;
      const value = JSON.stringify({ ...previous, pending_until: now + 60_000, token: ulid() });
      node.store.set(key, value); return value;
    });
    if (!claim) continue;
    let ok = false;
    try { ok = (await notify(loop)).ok; } catch { /* retry at the next reporting tick; never affect agents */ }
    node.store.tx(() => {
      if (node.store.get(key) !== claim) return; // a newer reporter owns this observation
      if (ok) node.store.set(key, JSON.stringify({ last_notified_at: now }));
      else node.store.db.prepare("DELETE FROM kv WHERE k=? AND v=?").run(key, claim);
    });
    if (ok) reported.push(loop);
  }
  return reported;
}

/** Independent from daemon delivery/reconciliation; a slow notifier cannot overlap its own next tick. */
export function armConversationLoopReports(node: MbxNode): void {
  let busy = false;
  const tick = () => {
    if (busy) return;
    busy = true;
    void reportConversationLoops(node).catch(error => {
      process.stderr.write(`[agentmbx] loop reporting: ${oneLine(String(error)).slice(0, 300)}\n`);
    }).finally(() => { busy = false; });
  };
  setInterval(tick, 60_000).unref(); setTimeout(tick, 5_000).unref();
}
