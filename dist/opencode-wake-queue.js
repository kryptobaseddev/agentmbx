/** Per-session wake queue for a standalone OpenCode serve (T519).
 *  The plugin inside that serve long-polls one slot. The daemon offers one wake and waits for the
 *  native `msg_` id from `ctx.session.synthetic`. No slot means nothing was submitted: the shared
 *  service is not called, so it starts no turn and takes no snapshot. */
// T646: one slot per (session, serve). The same session can be loaded by a standalone tab and by the shared service at
// once; keyed by session alone, each poll cancelled the other's every ~200 ms and a wake for the tab found the service's slot.
const slots = new Map();
const slotKey = (sessionID, pid) => `${sessionID}\0${pid}`;
const sessionOf = (key) => key.slice(0, key.lastIndexOf("\0"));
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
/** Unoffered pollers. Doctor reads them through GET /v1/opencode-wake/waiters (T520). */
export function listOpencodeWakeWaiters() {
    return [...slots.entries()].filter(([, slot]) => !slot.offered).map(([key, slot]) => ({ sessionID: sessionOf(key), pid: slot.pid }));
}
export function opencodeWakeWaiting(sessionID, pid) {
    const slot = slots.get(slotKey(sessionID, pid));
    return !!slot && !slot.offered;
}
/** Register the plugin poll for `sessionID` from the serve `pid`. A new poll from that serve replaces its own poll that has not
 *  been offered a wake; an offered slot is left alone and this call resolves null so it cannot steal the text. Another serve's
 *  poll for the same session is independent. */
export function waitForOpencodeWake(sessionID, pid, waitMs = 20_000) {
    const key = slotKey(sessionID, pid);
    const prev = slots.get(key);
    if (prev?.offered)
        return Promise.resolve(null);
    if (prev) {
        slots.delete(key);
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
        turnSince: null,
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
export async function pushOpencodeWake(sessionID, pid, text, receiptMs = 5_000) {
    const key = slotKey(sessionID, pid), slot = slots.get(key);
    if (!slot || slot.offered || !text)
        return { ok: false, handedOff: false };
    slot.deliver(text);
    let timer;
    const id = await Promise.race([
        slot.receipt,
        new Promise((resolve) => { timer = setTimeout(() => resolve(""), receiptMs); timer.unref(); }),
    ]);
    if (timer)
        clearTimeout(timer);
    if (slots.get(key) === slot)
        slots.delete(key);
    slot.dropReceipt();
    return id.startsWith("msg_") ? { ok: true, id, turnSince: slot.turnSince } : { ok: false, handedOff: true };
}
/** The plugin reports the id `ctx.session.synthetic` actually returned. Anything else is refused. `turnSince` (T642): the
 *  session was mid-turn when the wake was admitted, since that ISO time; null when idle or not reported (an older plugin). */
export function completeOpencodeWake(sessionID, id, turnSince = null) {
    const slot = [...slots.entries()].find(([key, s]) => sessionOf(key) === sessionID && s.offered && !s.settled)?.[1];
    if (!slot || !id.startsWith("msg_"))
        return false;
    slot.turnSince = turnSince;
    slot.accept(id);
    return true;
}
/** The poller went away before a wake was offered. An offered wake is not cancelled: its receipt
 *  is still how the daemon learns whether the admission happened. */
export function cancelOpencodeWake(sessionID, pid) {
    const key = slotKey(sessionID, pid), slot = slots.get(key);
    if (!slot || slot.offered)
        return;
    slots.delete(key);
    slot.cancel();
}
