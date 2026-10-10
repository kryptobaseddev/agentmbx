/** Per-session wake queue for a standalone OpenCode serve (T519).
 *  The plugin inside that serve long-polls one slot. The daemon offers one wake and waits for the
 *  native `msg_` id from `ctx.session.synthetic`. No slot means nothing was submitted: the shared
 *  service is not called, so it starts no turn and takes no snapshot. */

export type OpencodeWakePush = { ok: true; id: string } | { ok: false; handedOff: boolean };

interface Slot {
  pid: number;
  offered: boolean;
  settled: boolean;
  deliver: (text: string) => void;
  cancel: () => void;
  accept: (id: string) => void;
  dropReceipt: () => void;
  receipt: Promise<string>;
}

const slots = new Map<string, Slot>();

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

/** Unoffered pollers. The live check uses this to see which serve is waiting. */
export function listOpencodeWakeWaiters(): { sessionID: string; pid: number }[] {
  return [...slots.entries()].filter(([, slot]) => !slot.offered).map(([sessionID, slot]) => ({ sessionID, pid: slot.pid }));
}

export function opencodeWakeWaiting(sessionID: string, pid: number): boolean {
  const slot = slots.get(sessionID);
  return !!slot && !slot.offered && slot.pid === pid;
}

/** Register the plugin poll for `sessionID`. A new poll replaces one that has not been offered a
 *  wake; an offered slot is left alone and this call resolves null so it cannot steal the text. */
export function waitForOpencodeWake(sessionID: string, pid: number, waitMs = 20_000): Promise<string | null> {
  const prev = slots.get(sessionID);
  if (prev?.offered) return Promise.resolve(null);
  if (prev) {
    slots.delete(sessionID);
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
  slots.set(sessionID, slot);
  const timer = setTimeout(() => {
    if (slots.get(sessionID) === slot && !slot.offered) {
      slots.delete(sessionID);
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
  const slot = slots.get(sessionID);
  if (!slot || slot.offered || slot.pid !== pid || !text) return { ok: false, handedOff: false };
  slot.deliver(text);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const id = await Promise.race([
    slot.receipt,
    new Promise<string>((resolve) => { timer = setTimeout(() => resolve(""), receiptMs); timer.unref(); }),
  ]);
  if (timer) clearTimeout(timer);
  if (slots.get(sessionID) === slot) slots.delete(sessionID);
  slot.dropReceipt();
  return id.startsWith("msg_") ? { ok: true, id } : { ok: false, handedOff: true };
}

/** The plugin reports the id `ctx.session.synthetic` actually returned. Anything else is refused. */
export function completeOpencodeWake(sessionID: string, id: string): boolean {
  const slot = slots.get(sessionID);
  if (!slot || !slot.offered || slot.settled || !id.startsWith("msg_")) return false;
  slot.accept(id);
  return true;
}

/** The poller went away before a wake was offered. An offered wake is not cancelled: its receipt
 *  is still how the daemon learns whether the admission happened. */
export function cancelOpencodeWake(sessionID: string, pid: number): void {
  const slot = slots.get(sessionID);
  if (!slot || slot.offered || slot.pid !== pid) return;
  slots.delete(sessionID);
  slot.cancel();
}
