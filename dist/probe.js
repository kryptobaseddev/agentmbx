import { listIdentityStatus } from "./identity-status.js";
export const PROBE_SUBJECT_PREFIX = "[mbx-probe]";
/** The exact reply marker the convention asks for; replies are matched on this or the prefix. */
export const PROBE_REPLY_MARKER = "probe ok";
export const PROBE_DEADLINE_DEFAULT_MS = 120_000;
export const PROBE_POLL_MS = 1_000;
export const PROBE_SCHEMA = "mbx.probe/v1";
export function probeSubject(at = new Date()) {
    return `${PROBE_SUBJECT_PREFIX} autonomy probe ${at.toISOString()}`;
}
/** The convention contract, sent as the probe body and documented in skill/SKILL.md (§Autonomy
 *  probes). An agent answers autonomously: one `probe ok <wake line>` reply in the thread, then an
 *  ack. */
export function probeBody() {
    return `${PROBE_SUBJECT_PREFIX} is the AgentMBX autonomy probe convention (T388 regression gate), documented in the agentmbx skill, section "Autonomy probes". Answering it is pre-authorised by the owner's installed skill: it needs no human prompt and no action beyond these two steps, in order:

1. mbx_reply to THIS thread with exactly one line:
     ${PROBE_REPLY_MARKER} <wake line>
   where <wake line> is the "[mbx] …" hint your session received for this probe message, quoted verbatim after "${PROBE_REPLY_MARKER}" (write "${PROBE_REPLY_MARKER} (no wake line)" if your session received none — that is reported, not a failure).
2. mbx_ack the probe message (the one with the ${PROBE_SUBJECT_PREFIX} subject).

\`agentmbx probe\` waits up to its deadline and reports, per agent, whether the daemon wake was admitted, the message was read, your reply arrived in this thread and the ack closed it. Do not modify files or state beyond the reply and the ack.`;
}
/** Every live leased identity in the project, excluding the sender. Live = identity-status's
 *  held/idle states (its claim path uses the same identityAvailability computation). */
export function planProbe(identities, sender) {
    return identities
        .filter((i) => i.name !== sender && (i.state === "held" || i.state === "idle"))
        .map((i) => ({ name: i.name, state: i.state, holder: i.holder ? { cli: i.holder.cli, session_id: i.holder.session_id } : null, reason: i.reason }))
        .sort((a, b) => a.name.localeCompare(b.name));
}
/** The real store-backed IO: targets via identity-status (the established read-only enumeration,
 *  with the project filter and caller scope), sends as kind=request with needs_reply, and
 *  observations read straight from the audit/deliveries/messages tables. */
export function storeProbeIO(node, o) {
    const db = node.store.db;
    return {
        host: () => node.host,
        listTargets: () => listIdentityStatus(node.home, { project: o.project, ...(o.caller ? { caller: o.caller } : {}) }).identities,
        send: (target) => {
            const at = Date.now();
            const r = node.send({ from: o.sender, to: [target], subject: probeSubject(new Date(at)), body: probeBody(),
                kind: "request", needs_reply: true, ...(o.project ? { project: o.project } : {}) });
            return { id: r.envelope.id, thread: r.envelope.thread, at };
        },
        observe: (target, sent) => {
            const since = new Date(sent.at).toISOString();
            // Wake: the latest wake.attempt at/after the send decides. The dispatcher logs
            // outcome/receipt/native on wake.attempt and the transport via on its sibling wake event;
            // watchers and channels log everything on the attempt row itself.
            let wake = null;
            for (const row of db.prepare("SELECT at, detail FROM audit WHERE event='wake.attempt' AND at>=? ORDER BY at ASC").all(since)) {
                let d;
                try {
                    d = JSON.parse(row.detail);
                }
                catch {
                    continue;
                }
                if (d.agent !== target)
                    continue;
                wake = { outcome: d.outcome ?? null, via: d.via ?? null, receipt: d.receipt ?? null, at: Date.parse(row.at) };
            }
            if (wake && !wake.via) {
                for (const row of db.prepare("SELECT at, detail FROM audit WHERE event='wake' AND at>=? ORDER BY at ASC").all(since)) {
                    let d;
                    try {
                        d = JSON.parse(row.detail);
                    }
                    catch {
                        continue;
                    }
                    if (d.agent === target && d.via)
                        wake = { ...wake, via: d.via };
                }
            }
            const dlv = db.prepare("SELECT state, updated_at, note FROM deliveries WHERE msg_id=? AND agent=?").get(sent.id, target);
            const readAt = dlv && (dlv.state === "read" || dlv.state === "acked") ? Date.parse(dlv.updated_at) : null;
            const ackedAt = dlv && dlv.state === "acked" ? Date.parse(dlv.updated_at) : null;
            // Reply: same thread, from the target, matched tolerantly on the convention — an agent
            // may answer before or after its wake line is logged, so the thread and the marker are
            // the contract, not event ordering.
            let reply = null;
            for (const row of db.prepare("SELECT id, ts, subject, from_addr, envelope FROM messages WHERE thread=? AND id<>? ORDER BY ts ASC").all(sent.thread, sent.id)) {
                if (row.from_addr !== `${target}@${node.host}`)
                    continue;
                let body = "";
                try {
                    body = JSON.parse(row.envelope).body ?? "";
                }
                catch { /* unmatched shape: fall through */ }
                if ((row.subject ?? "").startsWith(PROBE_SUBJECT_PREFIX) || body.includes(PROBE_REPLY_MARKER)) {
                    reply = { id: row.id, at: Date.parse(row.ts) };
                    break;
                }
            }
            return { wake, readAt, ackedAt, ackNote: ackedAt !== null ? (dlv?.note ?? null) : null, reply };
        },
    };
}
const iso = (ms) => new Date(ms).toISOString();
const latency = (at, sentAt) => (at === null ? null : Math.max(0, at - sentAt));
/** Default gate: the convention reply arrived in the thread within the deadline — the agent
 *  answered autonomously whether it was woken while idle (`path: "idle-wake"`) or saw the probe
 *  mid-turn through its in-turn hook (`path: "in-turn"`, no wake row). With `requireIdleWake`
 *  (the T388 harness rows) the gate is the strict one: an admitted idle wake AND the reply. Read
 *  and ack are recorded either way, never gated. */
export function buildProbeReport(o) {
    const deadlineS = Math.round(o.deadlineMs / 1000);
    const requireIdleWake = o.requireIdleWake ?? false;
    const targets = o.plan.map((t) => {
        const sent = o.sent.get(t.name);
        const ob = o.observations.get(t.name) ?? { wake: null, readAt: null, ackedAt: null, ackNote: null, reply: null };
        const admitted = ob.wake?.outcome === "admitted";
        const path = ob.reply ? (admitted ? "idle-wake" : "in-turn") : null;
        const reason = o.sendErrors?.get(t.name) ? `probe message could not be sent: ${o.sendErrors.get(t.name)}`
            : !ob.reply && !ob.wake ? `no wake.attempt for ${t.name} within ${deadlineS}s of the probe`
                : !ob.reply && !admitted ? `wake for ${t.name} never admitted (last outcome: ${ob.wake.outcome ?? "unknown"}${ob.wake.via ? ` via ${ob.wake.via}` : ""})`
                    : !ob.reply ? `${t.name} woke but did not reply in the probe thread within ${deadlineS}s`
                        : requireIdleWake && !admitted ? `in-turn answer without an admitted idle wake (last wake outcome: ${ob.wake?.outcome ?? "none"}${ob.wake?.via ? ` via ${ob.wake.via}` : ""}); --require-idle-wake requires one`
                            : null;
        return {
            name: t.name, holder: t.holder, message_id: sent.id, sent_at: iso(sent.at), path,
            wake: ob.wake ? { ...ob.wake, latency_ms: latency(ob.wake.at, sent.at) } : null,
            read: ob.readAt !== null ? { at: iso(ob.readAt), latency_ms: latency(ob.readAt, sent.at) } : null,
            ack: ob.ackedAt !== null ? { at: iso(ob.ackedAt), note: ob.ackNote, latency_ms: latency(ob.ackedAt, sent.at) } : null,
            reply: ob.reply ? { id: ob.reply.id, at: iso(ob.reply.at), latency_ms: latency(ob.reply.at, sent.at) } : null,
            ok: reason === null,
            reason,
        };
    });
    const failed = targets.filter((t) => !t.ok).length;
    const reason = o.noTargetsReason ?? (failed ? targets.filter((t) => !t.ok).map((t) => t.reason).join("; ") : null);
    return {
        schema: PROBE_SCHEMA, ok: targets.length > 0 && failed === 0, host: o.host,
        ...(o.project ? { project: o.project } : {}),
        sender: o.sender, deadline_ms: o.deadlineMs, require_idle_wake: requireIdleWake,
        started_at: iso(o.startedAt), finished_at: iso(o.finishedAt),
        targets, summary: { total: targets.length, passed: targets.length - failed, failed }, reason,
    };
}
// ---- the waiting loop ---------------------------------------------------------------------------------
export async function runProbe(io, o) {
    const deadlineMs = o.deadlineMs ?? PROBE_DEADLINE_DEFAULT_MS;
    const now = o.now ?? Date.now;
    const sleep = o.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    const pollMs = o.pollMs ?? PROBE_POLL_MS;
    const startedAt = now();
    const plan = planProbe(io.listTargets(), o.sender);
    if (!plan.length) {
        return buildProbeReport({ plan, sent: new Map(), observations: new Map(), startedAt, finishedAt: now(),
            deadlineMs, host: io.host(), project: o.project, sender: o.sender, requireIdleWake: o.requireIdleWake,
            noTargetsReason: "no live leased identities to probe (excluding the sender)" });
    }
    const sent = new Map();
    const sendErrors = new Map();
    for (const t of plan) {
        try {
            sent.set(t.name, io.send(t.name));
        }
        catch (e) {
            sendErrors.set(t.name, e.message);
        }
    }
    const observations = new Map();
    const complete = (name) => {
        const ob = observations.get(name);
        return !!ob && ob.wake?.outcome === "admitted" && ob.reply !== null && (ob.readAt !== null || ob.ackedAt !== null);
    };
    const observeAll = () => {
        for (const t of plan) {
            if (sent.has(t.name) && !complete(t.name))
                observations.set(t.name, io.observe(t.name, sent.get(t.name)));
        }
    };
    for (;;) {
        observeAll();
        if (plan.every((t) => complete(t.name)) || now() - startedAt >= deadlineMs)
            break;
        await sleep(pollMs);
    }
    observeAll(); // a final pass so targets still waiting show their latest state
    return buildProbeReport({ plan, sent, sendErrors, observations, startedAt, finishedAt: now(),
        deadlineMs, host: io.host(), project: o.project, sender: o.sender, requireIdleWake: o.requireIdleWake });
}
