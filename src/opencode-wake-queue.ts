/** Per-session wake queue for a standalone OpenCode serve (T519).
 *  The plugin inside that serve long-polls one slot. The daemon offers one wake and waits for the
 *  native `msg_` id from `ctx.session.synthetic`. No slot means nothing was submitted: the shared
 *  service is not called, so it starts no turn and takes no snapshot. */

/** T642: `turnSince` is set when the plugin reported the wake landed behind a turn in progress (delivery "queue" waits for its end).
 *  T647: `busy` means the plugin declined the offer because its session is mid-turn: nothing was admitted. */
export type OpencodeWakePush = { ok: true; id: string; turnSince: string | null } | { ok: false; handedOff: boolean; busy?: true };

/** T647: the receipt a plugin posts instead of a `msg_` id when its session is mid-turn. A wake admitted then would sit in
 *  OpenCode's queue until the turn ends, by which time the agent has often handled that mail already (the post-tool notice
 *  shows it mid-turn), so the alert arrives stale. Declined, the mail stays delivered and the next pass decides again. */
export const OPENCODE_WAKE_BUSY = "busy";

interface Slot {
  pid: number;
  offered: boolean;
  settled: boolean;
  turnSince: string | null;
  busy: boolean;
  deliver: (text: string) => void;
  cancel: () => void;
  accept: (id: string) => void;
  dropReceipt: () => void;
  receipt: Promise<string>;
}

// T646: one slot per (session, serve). The same session can be loaded by a standalone tab and by the shared service at
// once; keyed by session alone, each poll cancelled the other's every ~200 ms and a wake for the tab found the service's slot.
const slots = new Map<string, Slot>();
const slotKey = (sessionID: string, pid: number) => `${sessionID}\0${pid}`;
const sessionOf = (key: string) => key.slice(0, key.lastIndexOf("\0"));

const finishReceipt = (slot: Slot, resolve: (id: string) => void, id: string): void => {
  if (slot.settled) return;
  slot.settled = true;
  resolve(id);
};

/** Drop every slot. Tests share one process, so a waiter must not survive into the next case. */
export function resetOpencodeWakeQueue(): void {
  for (const slot of slots.values()) {
    slot.cancel();
    slot.dropReceipt();
  }
  slots.clear();
}

/** Unoffered pollers. Doctor reads them through GET /v1/opencode-wake/waiters (T520). */
export function listOpencodeWakeWaiters(): { sessionID: string; pid: number }[] {
  return [...slots.entries()].filter(([, slot]) => !slot.offered).map(([key, slot]) => ({ sessionID: sessionOf(key), pid: slot.pid }));
}

export function opencodeWakeWaiting(sessionID: string, pid: number): boolean {
  const slot = slots.get(slotKey(sessionID, pid));
  return !!slot && !slot.offered;
}

/** Register the plugin poll for `sessionID` from the serve `pid`. A new poll from that serve replaces its own poll that has not
 *  been offered a wake; an offered slot is left alone and this call resolves null so it cannot steal the text. Another serve's
 *  poll for the same session is independent. */
export function waitForOpencodeWake(sessionID: string, pid: number, waitMs = 20_000): Promise<string | null> {
  const key = slotKey(sessionID, pid);
  const prev = slots.get(key);
  if (prev?.offered) return Promise.resolve(null);
  if (prev) {
    slots.delete(key);
    prev.cancel();
  }
  let resolveText!: (value: string | null) => void;
  const textP = new Promise<string | null>((resolve) => { resolveText = resolve; });
  let resolveReceipt!: (id: string) => void;
  const receipt = new Promise<string>((resolve) => { resolveReceipt = resolve; });
  const slot: Slot = {
    pid,
    offered: false,
    settled: false,
    turnSince: null,
    busy: false,
    deliver(text) {
      if (slot.offered) return;
      slot.offered = true;
      resolveText(text);
    },
    cancel() {
      if (!slot.offered) resolveText(null);
    },
    accept(id) { finishReceipt(slot, resolveReceipt, id); },
    dropReceipt() { finishReceipt(slot, resolveReceipt, ""); },
    receipt,
  };
  slots.set(key, slot);
  const timer = setTimeout(() => {
    if (slots.get(key) === slot && !slot.offered) {
      slots.delete(key);
      resolveText(null);
    }
  }, waitMs);
  timer.unref();
  return textP;
}

/** Hand `text` to the poller whose pid is this serve. The receipt has to be that poller's native
 *  `msg_` id. A missing receipt after the handoff is `handedOff`: the text already left, so the
 *  caller must not submit it through the shared service as well. */
export async function pushOpencodeWake(sessionID: string, pid: number, text: string, receiptMs = 5_000): Promise<OpencodeWakePush> {
  const key = slotKey(sessionID, pid), slot = slots.get(key);
  if (!slot || slot.offered || !text) return { ok: false, handedOff: false };
  slot.deliver(text);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const id = await Promise.race([
    slot.receipt,
    new Promise<string>((resolve) => { timer = setTimeout(() => resolve(""), receiptMs); timer.unref(); }),
  ]);
  if (timer) clearTimeout(timer);
  if (slots.get(key) === slot) slots.delete(key);
  slot.dropReceipt();
  if (slot.busy) return { ok: false, handedOff: false, busy: true }; // declined: the text was not admitted anywhere
  return id.startsWith("msg_") ? { ok: true, id, turnSince: slot.turnSince } : { ok: false, handedOff: true };
}

/** The plugin reports the id `ctx.session.synthetic` actually returned. Anything else is refused. `turnSince` (T642): the
 *  session was mid-turn when the wake was admitted, since that ISO time; null when idle or not reported (an older plugin). */
export function completeOpencodeWake(sessionID: string, id: string, turnSince: string | null = null): boolean {
  const slot = [...slots.entries()].find(([key, s]) => sessionOf(key) === sessionID && s.offered && !s.settled)?.[1];
  if (slot && id === OPENCODE_WAKE_BUSY) { slot.busy = true; slot.accept(id); return true; } // T647
  if (!slot || !id.startsWith("msg_")) return false;
  slot.turnSince = turnSince;
  slot.accept(id);
  return true;
}

/** The poller went away before a wake was offered. An offered wake is not cancelled: its receipt
 *  is still how the daemon learns whether the admission happened. */
export function cancelOpencodeWake(sessionID: string, pid: number): void {
  const key = slotKey(sessionID, pid), slot = slots.get(key);
  if (!slot || slot.offered) return;
  slots.delete(key);
  slot.cancel();
}
