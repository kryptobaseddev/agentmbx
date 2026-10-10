/** Per-session wake queue for a standalone OpenCode serve (T519).
 *  The plugin inside that serve long-polls one slot. The daemon offers one wake and waits for the
 *  native `msg_` id from `ctx.session.synthetic`. No slot means nothing was submitted: the shared
 *  service is not called, so it starts no turn and takes no snapshot. */
const slots = new Map();
const finishReceipt = (slot, resolve, id) => {
    if (slot.settled)
        return;
    slot.settled = true;
    resolve(id);
};
/** Drop every slot. Tests share one process, so a waiter must not survive into the next case. */
export function resetOpencodeWakeQueue() {
    for (const slot of slots.values()) {
        slot.cancel();
        slot.dropReceipt();
    }
    slots.clear();
}
/** Unoffered pollers. The live check uses this to see which serve is waiting. */
export function listOpencodeWakeWaiters() {
    return [...slots.entries()].filter(([, slot]) => !slot.offered).map(([sessionID, slot]) => ({ sessionID, pid: slot.pid }));
}
export function opencodeWakeWaiting(sessionID, pid) {
    const slot = slots.get(sessionID);
    return !!slot && !slot.offered && slot.pid === pid;
}
/** Register the plugin poll for `sessionID`. A new poll replaces one that has not been offered a
 *  wake; an offered slot is left alone and this call resolves null so it cannot steal the text. */
export function waitForOpencodeWake(sessionID, pid, waitMs = 20_000) {
    const prev = slots.get(sessionID);
    if (prev?.offered)
        return Promise.resolve(null);
    if (prev) {
        slots.delete(sessionID);
        prev.cancel();
    }
    let resolveText;
    const textP = new Promise((resolve) => { resolveText = resolve; });
    let resolveReceipt;
    const receipt = new Promise((resolve) => { resolveReceipt = resolve; });
    const slot = {
        pid,
        offered: false,
        settled: false,
        deliver(text) {
            if (slot.offered)
                return;
            slot.offered = true;
            resolveText(text);
        },
        cancel() {
            if (!slot.offered)
                resolveText(null);
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
export async function pushOpencodeWake(sessionID, pid, text, receiptMs = 5_000) {
    const slot = slots.get(sessionID);
    if (!slot || slot.offered || slot.pid !== pid || !text)
        return { ok: false, handedOff: false };
    slot.deliver(text);
    let timer;
    const id = await Promise.race([
        slot.receipt,
        new Promise((resolve) => { timer = setTimeout(() => resolve(""), receiptMs); timer.unref(); }),
    ]);
    if (timer)
        clearTimeout(timer);
    if (slots.get(sessionID) === slot)
        slots.delete(sessionID);
    slot.dropReceipt();
    return id.startsWith("msg_") ? { ok: true, id } : { ok: false, handedOff: true };
}
/** The plugin reports the id `ctx.session.synthetic` actually returned. Anything else is refused. */
export function completeOpencodeWake(sessionID, id) {
    const slot = slots.get(sessionID);
    if (!slot || !slot.offered || slot.settled || !id.startsWith("msg_"))
        return false;
    slot.accept(id);
    return true;
}
/** The poller went away before a wake was offered. An offered wake is not cancelled: its receipt
 *  is still how the daemon learns whether the admission happened. */
export function cancelOpencodeWake(sessionID, pid) {
    const slot = slots.get(sessionID);
    if (!slot || slot.offered || slot.pid !== pid)
        return;
    slots.delete(sessionID);
    slot.cancel();
}
