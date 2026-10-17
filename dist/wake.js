// Wake adapters: how a new message reaches an agent whose session is idle. The text never contains the
// message body, only a pointer to the mbx_inbox tool, so content always arrives through the framed tool result.
import { execFile, execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { kimiHostedServer } from "./kimi-web.js";
import { desktopRpc, kimiDesktop, RpcError } from "./kimi-desktop.js";
import { GROK_NO_PUSH, MbxNode, trustLabel, WAKE_LIMITS } from "./node.js";
import { captureWakeIdentity } from "./wake-identity.js";
import { policyBrief } from "./policy.js";
import { ulid } from "./crypto.js";
import { opencodeHostOf } from "./opencode-provider.js";
import { listOpencodeWakeWaiters, opencodeIdleAt, pushOpencodeWake } from "./opencode-wake-queue.js";
import { pollerWakeTargets } from "./opencode-poller.js";
import { leadAgentOf, projectLabel, projectMailboxBySlot } from "./project-mailbox.js";
import { isSlotName } from "./project-slot.js";
import { markSkewNoted, wakeSkewNote } from "./connector-skew.js";
import { codexFailureClass, enqueueCodexQueue, reconcileCodexQueue } from "./codex-queue.js";
import { identityGeneration } from "./identity-control.js";
const run = promisify(execFile);
const attemptId = () => ulid();
const receipt = (strength, r = {}) => ({ strength, nativeId: null, sessionId: null, nativeStatus: null, providerVersion: null, ...r });
/** Build the legacy result and the typed outcome together, so the two can never disagree. */
function outcome(via, o, error) {
    const full = { ...o, attemptId: attemptId(), via };
    if (full.kind === "admitted")
        return { ok: true, via, outcome: full };
    return { ok: false, via, error: (error ?? full.detail ?? full.kind).slice(0, 300), ...(full.kind === "busy" ? { retry: true } : {}), outcome: full };
}
/** A request that failed before any byte reached the provider (refused, unresolvable) proved nothing was submitted. */
const neverSent = (e) => {
    const c = e?.cause ?? e;
    return [c?.code, ...(c?.errors ?? []).map((x) => x.code)].some((x) => /^(ECONNREFUSED|ENOTFOUND|EHOSTUNREACH|ENETUNREACH|EAI_AGAIN)$/.test(x ?? ""));
};
const timedOut = (e) => /TimeoutError|AbortError/.test(e?.name ?? "");
const isRetry = (r) => !r.ok && r.retry === true;
/** A wake starts agent work, so a downgraded message cannot borrow the mailbox's broad policy. */
export const hasWakeAuthority = (node, agent, message) => node.policyFor(message, agent).level !== "ask" || node.authorityFor(message)?.ok === true;
/** kv key: when the owner last typed a prompt in a session holding `agent` (hook "prompt"; ends relay chains, T104). */
export const humanPromptKey = (agent) => `human-prompt:${agent}`;
/** Prompts AgentMBX itself submits (wakes, [mbx-watch] self-checks) are not the owner and never end a relay chain. */
/** T460: Hermes wraps a finished background process (our watcher) in its own `[IMPORTANT: Background process <id> completed …]`
 *  turn, so the wake hint sits inside the text instead of at its start. Only that wrapper around our own hint is machine-made. */
const HERMES_WATCH_WRAPPER = /^\s*\[IMPORTANT: (?:Background process \S+ |\d+ background processes )[\s\S]*?\[mbx(?:-watch)?\]/;
export const isHumanPrompt = (prompt) => typeof prompt === "string" && !!prompt.trim() && !/^\s*\[mbx(-watch)?\]/.test(prompt)
    && !HERMES_WATCH_WRAPPER.test(prompt);
export function wakeText(agent, msgs, project) {
    const senders = [...new Set(msgs.map((m) => `${m.from_addr} [${trustLabel(m).split(" · ")[0].split(" (")[0]}]`))].join(", ");
    const owner = msgs.some(m => JSON.parse(m.envelope).authority) ? " Includes an owner-authority claim; verify its current mbx_read header." : "";
    // A hint can be queued while the session is busy and shown after the mail was handled: name the ids so it is checkable (T195).
    const ids = msgs.slice(0, 5).map((m) => m.id).join(", ") + (msgs.length > 5 ? `, +${msgs.length - 5} more` : "");
    // One line (owner, 2026-10-02): the trust rules live in the MCP instructions, the session-start note and every
    // mbx_read header; repeating them in each wake only spent context. Content is never in a wake, only ids.
    // T442: the stale-hint note is conditional. An unconditional "Already handled: no action needed" was obeyed
    // literally and made agents skip unread mail.
    const where = project ? ` in the project mailbox ${project}` : ""; // T493: mail to the project, read by its lead
    return `[mbx] ${msgs.length} new message(s) for ${agent}${where} from ${senders} (ids ${ids}).${owner} mbx_inbox or mbx_read, reply, ack. If you already handled these ids, no action is needed.`;
}
/** The hint for one wake: the usual sentence for the agent's personal mail, plus one per project mailbox it leads. Ids only, never content. */
export function wakeTextFor(node, agent, rows) {
    const own = rows.filter((r) => !isSlotName(r.agent));
    const bySlot = new Map();
    for (const r of rows)
        if (isSlotName(r.agent))
            bySlot.set(r.agent, [...(bySlot.get(r.agent) ?? []), r]);
    return [...(own.length ? [wakeText(agent, own)] : []), ...[...bySlot].map(([slot, msgs]) => {
            const box = projectMailboxBySlot(node.store, slot);
            return wakeText(agent, msgs, box ? projectLabel(box) : "(project)");
        })].join(" ");
}
export const which = (bin) => { try {
    return execFileSync("/usr/bin/which", [bin], { encoding: "utf8" }).trim() || null;
}
catch {
    return null;
} };
const CODEX = () => process.env.MBX_CODEX_BIN || which("codex") || join(homedir(), ".local/bin/codex");
const OPENCODE = () => process.env.MBX_OPENCODE_BIN || which("opencode") || join(homedir(), ".opencode/bin/opencode");
/** Grok's interactive session cannot be handed a prompt from outside. Nothing is spawned or written.
 *  `unsupported` holds: retrying cannot grow a path the CLI does not have. */
export async function wakeGrok(_sessionId, _text, o = {}) {
    const via = "grok none";
    if (o.recheck && !o.recheck())
        return outcome(via, { kind: "not_submitted", reason: "fenced" }, "wake authority changed");
    return outcome(via, { kind: "not_submitted", reason: "unsupported", detail: GROK_NO_PUSH }, GROK_NO_PUSH);
}
export async function wakeCodex(threadId, text, o = {}) {
    const via = "codex queue";
    if (o.recheck && !o.recheck())
        return outcome(via, { kind: "not_submitted", reason: "fenced" }, "wake authority changed");
    if (!o.queue)
        return outcome(via, { kind: "not_submitted", reason: "no-target" }, "Codex queue requires a captured identity lease");
    try {
        const id = await enqueueCodexQueue(CODEX(), threadId, text, o.queue, o.recheck ?? (() => true));
        return outcome(via, { kind: "admitted", receipt: receipt("native", { sessionId: threadId, nativeId: id, nativeStatus: "queued" }) });
    }
    catch (e) {
        const err = e;
        const detail = err.message.slice(0, 300), diagnostic = { exitCode: err.exitCode ?? null, stderrClass: err.stderrClass ?? codexFailureClass(detail), ...(err.rpcCode === undefined ? {} : { rpcCode: err.rpcCode }) };
        const result = err.code === "CODEX_QUEUE_PENDING" ? outcome(via, { kind: "busy" }, detail)
            : err.code === "CODEX_QUEUE_FENCED" ? outcome(via, { kind: "not_submitted", reason: "fenced" }, detail)
                : err.code === "ENOENT" || err.code === "EACCES" ? outcome(via, { kind: "not_submitted", reason: "unavailable", detail })
                    : err.code === "ETIMEDOUT" || err.signal || err.code === "CODEX_QUEUE_PROTOCOL" || err.code === "CODEX_QUEUE_CLOSED" || err.code === "CODEX_QUEUE_STATE"
                        ? outcome(via, { kind: "unknown", reason: err.code === "ETIMEDOUT" ? "timeout" : "lost-response", detail })
                        : outcome(via, { kind: "failed", status: err.exitCode ?? err.rpcCode ?? null, detail });
        return { ...result, failure: diagnostic };
    }
}
const keepCodexNotice = (node, p) => {
    const lease = node.store.db.prepare("SELECT * FROM identity_leases WHERE name=?").get(p.agent);
    if (!lease || lease.released_at !== null || lease.cli !== "codex" || lease.session_id !== p.thread
        || identityGeneration(String(lease.token)) !== p.generation || lease.holder_pid !== p.holder.pid || lease.holder_start !== p.holder.start)
        return false;
    return p.deliveries.every(pair => {
        const row = node.store.db.prepare("SELECT state FROM deliveries WHERE msg_id=? AND agent=?").get(pair.id, pair.agent), message = node.message(pair.id);
        return (row?.state === "delivered" || row?.state === "notified") && !!message && hasWakeAuthority(node, p.agent, message)
            && (!isSlotName(pair.agent) || leadAgentOf(node, pair.agent) === p.agent);
    });
};
export async function opencodeService() {
    try {
        const url = process.env.MBX_OPENCODE_URL || (await run(OPENCODE(), ["service", "status"], { timeout: 10_000 })).stdout.trim().split(/\s+/).find((w) => w.startsWith("http"));
        const cfg = join(homedir(), ".config/opencode/service.json");
        const pw = existsSync(cfg) ? JSON.parse(readFileSync(cfg, "utf8")).password : undefined;
        if (!url)
            return null;
        return { url: url.replace(/\/$/, ""), auth: pw ? `Basic ${Buffer.from(`opencode:${pw}`).toString("base64")}` : "" };
    }
    catch {
        return null;
    }
}
/** T642: an OpenCode wake admitted while the session's turn was running. Delivery "queue" holds it until the turn ends. */
export const OPENCODE_QUEUED_BEHIND_TURN = "queued-behind-turn";
/** T647: the standalone plugin declined the wake because its session is mid-turn; the mail stays delivered for a later pass. */
export const OPENCODE_MIDTURN_BUSY = "session is mid-turn; the wake waits for the turn to end (mail handled meanwhile is not re-alerted)";
const behindTurnKey = (agent) => `wake-behind-turn:${agent}`;
const BEHIND_TURN_CAP = 100;
/** Remember which of `agent`'s messages were woken into a running turn, newest last (bounded). */
export function noteQueuedBehindTurn(store, agent, messageIds, at) {
    let map = {};
    try {
        map = JSON.parse(store.get(behindTurnKey(agent)) ?? "{}");
    }
    catch {
        map = {};
    }
    for (const id of messageIds) {
        delete map[id];
        map[id] = at;
    }
    const ids = Object.keys(map);
    for (const id of ids.slice(0, Math.max(0, ids.length - BEHIND_TURN_CAP)))
        delete map[id];
    store.set(behindTurnKey(agent), JSON.stringify(map));
}
/** When this message's wake was admitted behind `agent`'s running turn, else null. */
export function queuedBehindTurnAt(store, agent, messageId) {
    try {
        return JSON.parse(store.get(behindTurnKey(agent)) ?? "{}")[messageId] ?? null;
    }
    catch {
        return null;
    }
}
// ---- T667: a watcher-exit hint dropped mid-turn --------------------------------------------------
/** T667: the watcher printed a wake hint naming these deliveries. Observation is unconfirmed: the harness
 *  drops a background-task completion that lands mid-turn. If nothing ever surfaces the mail, the daemon
 *  requeues it once (requeueWatchReported); the Stop hook reconciles the marker for mail a turn surfaced. */
export const watchReportedKey = (mailbox) => `watch-reported:${mailbox}`;
const WATCH_REPORTED_CAP = 100;
export function noteWatchReported(store, mailbox, ids, at = new Date().toISOString()) {
    let map = {};
    try {
        map = JSON.parse(store.get(watchReportedKey(mailbox)) ?? "{}");
    }
    catch {
        map = {};
    }
    for (const id of ids) {
        delete map[id];
        map[id] = at;
    }
    const keys = Object.keys(map);
    for (const id of keys.slice(0, Math.max(0, keys.length - WATCH_REPORTED_CAP)))
        delete map[id];
    store.set(watchReportedKey(mailbox), JSON.stringify(map));
}
/** Drop marker ids a turn surfaced (the Stop continuation takes them) or that are no longer unread. */
export function reconcileWatchReported(node, agent, surfacedIds) {
    const key = watchReportedKey(agent), drop = new Set(surfacedIds);
    let map = {};
    try {
        map = JSON.parse(node.store.get(key) ?? "{}");
    }
    catch {
        return;
    }
    const state = node.store.db.prepare("SELECT state FROM deliveries WHERE msg_id=? AND agent=?");
    let changed = false;
    for (const id of Object.keys(map)) {
        const row = state.get(id, agent);
        if (drop.has(id) || !row || row.state === "read" || row.state === "acked" || row.state === "delivered") {
            delete map[id];
            changed = true;
        }
    }
    if (!changed)
        return;
    if (Object.keys(map).length)
        node.store.set(key, JSON.stringify(map));
    else
        node.store.db.prepare("DELETE FROM kv WHERE k=?").run(key);
}
/** One re-drive per message: a watcher-reported delivery nothing surfaced goes back to 'delivered' once,
 *  so the normal dispatch checks (brake, mute, liveWatcher, wantsWake) drive it again instead of leaving it
 *  stranded as 'notified' after the dropped exit. Gated so the usual surfaces never double-fire: a live
 *  watcher re-reports delivered mail itself, a mute forbids hints and notices, and the wake brake paces the
 *  requeue past the batching window the watcher's own exit spent. Exactly once: the id leaves the marker
 *  with the requeue, so a handled (read/acked) message is never woken again. */
export function requeueWatchReported(node, now = Date.now()) {
    const since = new Date(now - WAKE_LIMITS.perAgentSeconds * 1000).toISOString();
    for (const { k, v } of node.store.db.prepare("SELECT k, v FROM kv WHERE k GLOB 'watch-reported:*'").all()) {
        const mailbox = k.slice(watchReportedKey("").length);
        let map = {};
        try {
            map = JSON.parse(v);
        }
        catch {
            node.store.db.prepare("DELETE FROM kv WHERE k=?").run(k);
            continue;
        }
        if (liveWatcher(node, mailbox, now))
            continue; // the watcher chain re-reports delivered mail itself
        if (wakeMutedUntil(node, mailbox, now))
            continue; // no hint and no notice until the mute ends; stays marked
        if (node.store.db.prepare("SELECT count(*) n FROM wakes WHERE agent=? AND at>?").get(mailbox, since).n)
            continue; // the brake paces the requeue
        const delivery = node.store.db.prepare("SELECT state, note FROM deliveries WHERE msg_id=? AND agent=?");
        const requeued = [];
        node.store.tx(() => {
            for (const id of Object.keys(map)) {
                const d = delivery.get(id, mailbox);
                if (!d || d.state === "read" || d.state === "acked" || d.state === "delivered") {
                    delete map[id];
                    continue;
                }
                if (d.state === "notified" && d.note === null) {
                    node.store.db.prepare("UPDATE deliveries SET state='delivered', note=NULL, updated_at=? WHERE msg_id=? AND agent=?").run(new Date(now).toISOString(), id, mailbox);
                    requeued.push(id);
                    delete map[id];
                }
            }
            if (Object.keys(map).length)
                node.store.set(k, JSON.stringify(map));
            else
                node.store.db.prepare("DELETE FROM kv WHERE k=?").run(k);
        });
        if (requeued.length)
            node.store.audit("wake.reenqueue", { agent: mailbox, ids: requeued.join(","), count: requeued.length });
    }
}
/** T524: why a session that the shared service does not host is never pushed through it. */
/** T646: the same session is also loaded in a standalone serve whose plugin could not take the wake right now. */
export const OPENCODE_DUAL_HOST_NO_PUSH = "session is loaded by a standalone OpenCode serve as well as the shared service; not posting to the service, which would start a duplicate agent loop";
export const OPENCODE_STANDALONE_NO_PUSH = "session is hosted by a standalone OpenCode serve; the shared service would start a duplicate agent loop (next-prompt delivery only)";
/** Push a wake into an OpenCode session. A service-hosted binding (its provider pid is
 *  `opencode serve --service`) keeps the direct synthetic POST below. A standalone serve
 *  (`opencode --standalone` → `opencode serve --stdio`) has no shared push channel: the plugin
 *  in that serve polls a loopback queue and admits the text with `ctx.session.synthetic` (T519).
 *  No waiting plugin is not_submitted/no-target and this function does not call the service, so
 *  the service starts no turn and takes no snapshot (T524). An unknown host stays not_submitted. */
export async function wakeOpencode(sessionId, text, o = {}) {
    const via = "opencode synthetic";
    const host = (o.host ?? opencodeHostOf)(o.pid);
    if (host === "standalone") {
        const pid = typeof o.pid === "number" && Number.isInteger(o.pid) && o.pid > 0 ? o.pid : 0;
        const pushed = pid > 0 ? await pushOpencodeWake(sessionId, pid, text) : { ok: false, handedOff: false };
        // T647: the plugin declined because its session is mid-turn. Nothing was admitted: busy keeps the mail delivered and retries.
        if (!pushed.ok && pushed.busy)
            return outcome(via, { kind: "busy" }, OPENCODE_MIDTURN_BUSY);
        // T642: admitted behind a turn in progress waits for that turn to end; the sender's receipt says so.
        if (pushed.ok)
            return outcome(via, { kind: "admitted", receipt: receipt("native", { nativeId: pushed.id, sessionId,
                    nativeStatus: pushed.turnSince ? OPENCODE_QUEUED_BEHIND_TURN : "queued" }) });
        // The plugin already has the text. A missing msg_ id is not a reason to POST it to the service.
        if (pushed.handedOff)
            return outcome(via, { kind: "unknown", reason: "lost-response", detail: "standalone plugin took the wake and returned no msg_ receipt" });
        return outcome(via, { kind: "not_submitted", reason: "no-target", detail: OPENCODE_STANDALONE_NO_PUSH });
    }
    if (host !== "service")
        return outcome(via, { kind: "not_submitted", reason: "no-target", detail: "the OpenCode process hosting this session is unknown; not pushing through the shared service, which could start a duplicate agent loop" });
    // T646: the binding says service, but a standalone serve's plugin is polling for this same session, so a tab has it loaded too.
    // A resume:true POST would start a second agent loop in the service (and its restart later resumes that loop on its own). Hand the
    // wake to the tab's plugin instead; if it can't take it now, nothing is posted to the service.
    const standalone = (o.waiters ?? listOpencodeWakeWaiters)().filter(w => w.sessionID === sessionId && (o.host ?? opencodeHostOf)(w.pid) === "standalone");
    if (standalone.length) {
        for (const w of standalone) {
            if (o.recheck && !o.recheck())
                return outcome(via, { kind: "not_submitted", reason: "fenced" }, "wake authority changed");
            const pushed = await pushOpencodeWake(sessionId, w.pid, text);
            if (!pushed.ok && pushed.busy)
                return outcome(via, { kind: "busy" }, OPENCODE_MIDTURN_BUSY); // T647
            if (pushed.ok)
                return outcome(via, { kind: "admitted", receipt: receipt("native", { nativeId: pushed.id, sessionId,
                        nativeStatus: pushed.turnSince ? OPENCODE_QUEUED_BEHIND_TURN : "queued" }) });
            if (pushed.handedOff)
                return outcome(via, { kind: "unknown", reason: "lost-response", detail: "standalone plugin took the wake and returned no msg_ receipt" });
        }
        return outcome(via, { kind: "not_submitted", reason: "no-target", detail: OPENCODE_DUAL_HOST_NO_PUSH });
    }
    const svc = await (o.service ?? opencodeService)();
    if (!svc)
        return outcome(via, { kind: "not_submitted", reason: "unavailable" }, "opencode service not running");
    if (o.recheck && !o.recheck())
        return outcome(via, { kind: "not_submitted", reason: "fenced" }, "wake authority changed");
    let res;
    try {
        res = await (o.fetch ?? fetch)(`${svc.url}/api/session/${encodeURIComponent(sessionId)}/synthetic`, {
            method: "POST", headers: { "content-type": "application/json", ...(svc.auth ? { authorization: svc.auth } : {}) },
            body: JSON.stringify({ text, delivery: "queue", resume: true }), redirect: "error", signal: AbortSignal.timeout(10_000)
        });
    }
    catch (e) {
        const detail = e.message;
        if (neverSent(e))
            return outcome(via, { kind: "not_submitted", reason: "unavailable", detail });
        return outcome(via, { kind: "unknown", reason: timedOut(e) ? "timeout" : "lost-response", detail });
    }
    if (!res.ok)
        return outcome(via, { kind: "failed", status: res.status }, `${res.status} ${(await res.text().catch(() => "")).slice(0, 300)}`);
    const j = await res.json().catch(() => null);
    const r = j?.data;
    // The write was accepted: a receipt that does not match proves neither admission nor rejection (never resubmit blindly).
    if (!r || typeof r.id !== "string" || !r.id.startsWith("msg_")
        || r.sessionID !== sessionId || r.type !== "synthetic" || r.delivery !== "queue"
        || r.payload?.text !== text || typeof r.time?.created !== "number" || !Number.isFinite(r.time.created))
        return outcome(via, { kind: "unknown", reason: "mismatched-receipt" }, "invalid or mismatched synthetic admission receipt");
    // Durable admission is not evidence that the model ran or handled the mailbox message.
    return outcome(via, { kind: "admitted", receipt: receipt("native", { nativeId: r.id, sessionId, nativeStatus: "queued" }) });
}
/** True when the newest hosted kimi session of this agent is mid-turn. Waking a busy session would spend the
 *  wake brake (WAKE_LIMITS) for nothing, so dispatchWakes skips the agent instead and retries on its next pass. */
async function kimiBusyNow(sessions, f) {
    for (const s of sessions) {
        const srv = kimiHostedServer(s.pid);
        if (!srv)
            continue;
        try {
            const res = await f(`${srv.url}/api/v1/sessions/${encodeURIComponent(s.session_id)}/status`, { headers: { authorization: `Bearer ${srv.token}` }, redirect: "error", signal: AbortSignal.timeout(3_000) });
            const j = await res.json().catch(() => null);
            return res.ok && j?.code === 0 && j.data?.busy === true;
        }
        catch {
            return false;
        }
    }
    return false;
}
/** The server's configured default model alias (GET /api/v1/config), used when the session has none bound. */
async function kimiDefaultModel(srv, f) {
    try {
        const res = await f(`${srv.url}/api/v1/config`, { headers: { authorization: `Bearer ${srv.token}` }, redirect: "error", signal: AbortSignal.timeout(5_000) });
        const j = await res.json().catch(() => null);
        return res.ok && j?.code === 0 && typeof j.data?.default_model === "string" && j.data.default_model ? j.data.default_model : null;
    }
    catch {
        return null;
    }
}
/** Is this hosted session mid-turn right now? */
async function kimiSessionStatus(srv, sessionId, f) {
    const res = await f(`${srv.url}/api/v1/sessions/${encodeURIComponent(sessionId)}/status`, { headers: { authorization: `Bearer ${srv.token}` }, redirect: "error", signal: AbortSignal.timeout(5_000) });
    const j = await res.json().catch(() => null);
    if (!res.ok || j?.code !== 0)
        return { error: `status ${res.status}: ${(j?.msg ?? j?.message ?? JSON.stringify(j)).slice(0, 200)}` };
    if (!j.data || Array.isArray(j.data) || typeof j.data.busy !== "boolean"
        || (j.data.model !== undefined && typeof j.data.model !== "string"))
        return { error: "invalid session status response" };
    return { busy: j.data.busy, ...(j.data.model !== undefined ? { model: j.data.model } : {}) };
}
/**
 * Wake a kimi web-hosted session by submitting the wake text as a user prompt through the server's REST API
 * (POST /api/v1/sessions/{id}/prompts, bearer server.token). A binding counts as hosted only when its pid is a live
 * `kimi web` server instance ($KIMI_CODE_HOME/server/instances); terminal TUI sessions have no instances row and
 * are never woken. A hosted session that is busy returns `retry: true` so the dispatcher leaves the mail queued
 * for its next pass instead of spending wake budget (its Stop hook also surfaces new mail mid-turn).
 */
export async function wakeKimi(s, text, o = {}) {
    const via = "kimi web";
    const srv = o.server === undefined ? kimiHostedServer(s.pid) : o.server;
    if (!srv)
        return outcome(via, { kind: "not_submitted", reason: "no-target" }, "not a kimi web-hosted session");
    const f = o.fetch ?? fetch, base = `${srv.url}/api/v1/sessions/${encodeURIComponent(s.session_id)}`;
    const headers = { authorization: `Bearer ${srv.token}`, "content-type": "application/json" };
    let model;
    try {
        const st = await kimiSessionStatus(srv, s.session_id, f);
        if ("error" in st)
            return outcome(via, { kind: "not_submitted", reason: "preflight" }, st.error);
        if (st.busy)
            return outcome(via, { kind: "busy" }, "session busy");
        // A freshly created hosted session has no model bound: submitting a prompt then fails with "Model not set"
        // (ErrorCodes.MODEL_NOT_CONFIGURED, from the profile's model getter). The prompts endpoint accepts an optional
        // model alias and binds it before the prompt runs, so send one only when the session has none (the server's
        // configured default), and an explicit o.model always wins.
        model = o.model !== undefined ? o.model : st.model ? null : await kimiDefaultModel(srv, f);
    }
    catch (e) {
        return outcome(via, { kind: "not_submitted", reason: "preflight" }, e.message);
    }
    const body = { content: [{ type: "text", text }] };
    if (model)
        body.model = model;
    if (o.recheck && !o.recheck())
        return outcome(via, { kind: "not_submitted", reason: "fenced" }, "wake authority changed");
    let res;
    try {
        res = await f(`${base}/prompts`, { method: "POST", headers, body: JSON.stringify(body), redirect: "error", signal: AbortSignal.timeout(15_000) });
    }
    catch (e) {
        const detail = e.message;
        if (neverSent(e))
            return outcome(via, { kind: "not_submitted", reason: "unavailable", detail });
        return outcome(via, { kind: "unknown", reason: timedOut(e) ? "timeout" : "lost-response", detail });
    }
    const j = await res.json().catch(() => null);
    const why = `prompts ${res.status}: ${(j?.msg ?? j?.message ?? JSON.stringify(j)).slice(0, 200)}`;
    if (!res.ok || j?.code !== 0)
        return /model not set|model_not_configured/i.test(why)
            ? outcome(via, { kind: "blocked", gate: "model-unconfigured" }, why) : outcome(via, { kind: "failed", status: res.status }, why);
    if (!j.data || Array.isArray(j.data) || typeof j.data.prompt_id !== "string" || !j.data.prompt_id.trim()
        || !["running", "queued", "blocked"].includes(j.data.status ?? ""))
        return outcome(via, { kind: "unknown", reason: "malformed-receipt" }, "invalid prompt submission receipt");
    // Submission, not model execution or a mailbox read/reply/ack. A "blocked" prompt is admitted and waits on a person.
    return outcome(via, { kind: "admitted", receipt: receipt("native", { nativeId: j.data.prompt_id, sessionId: s.session_id, nativeStatus: j.data.status ?? null }) });
}
/**
 * Wake a Kimi desktop conversation through the app's control socket (T033): conversations.list maps the bound kernel
 * session id to its conversation, conversations.getBusy skips a turn in progress, conversations.send starts the turn.
 * A session counts as desktop-hosted only when its recorded pid is the live daimon of runner.state.json.
 */
export async function wakeKimiDesktop(s, text, o = {}) {
    const via = "kimi desktop";
    const d = o.desktop === undefined ? kimiDesktop(s.pid) : o.desktop;
    if (!d)
        return outcome(via, { kind: "not_submitted", reason: "no-target" }, "not a Kimi desktop session");
    const rpc = o.rpc ?? desktopRpc;
    let conversationKey;
    try {
        const [list] = await rpc(d, [["conversations.list", {}]]);
        const hit = list?.conversations?.find(c => c.kernelSessionId === s.session_id && typeof c.conversationKey === "string");
        if (!hit)
            return outcome(via, { kind: "not_submitted", reason: "no-target" }, "no desktop conversation for this session");
        conversationKey = hit.conversationKey;
        const [busy] = await rpc(d, [["conversations.getBusy", { conversationKey }]]);
        if (typeof busy?.busy !== "boolean")
            return outcome(via, { kind: "not_submitted", reason: "preflight" }, "invalid busy response");
        if (busy.busy)
            return outcome(via, { kind: "busy" }, "conversation busy");
    }
    catch (e) {
        return outcome(via, { kind: "not_submitted", reason: "preflight" }, e.message);
    }
    if (o.recheck && !o.recheck())
        return outcome(via, { kind: "not_submitted", reason: "fenced" }, "wake authority changed");
    let sent = false, r;
    try {
        [r] = await rpc(d, [["conversations.send", { conversationKey, text }]], { timeoutMs: 15_000, sent: () => { sent = true; } });
    }
    catch (e) {
        const detail = e.message;
        if (e instanceof RpcError)
            return e.code === -32010 ? outcome(via, { kind: "busy" }, detail) : outcome(via, { kind: "failed", status: e.code }, detail);
        return sent ? outcome(via, { kind: "unknown", reason: /timed out/.test(detail) ? "timeout" : "lost-response", detail })
            : outcome(via, { kind: "not_submitted", reason: "unavailable", detail });
    }
    if (r?.accepted !== true || r.kernelSessionId !== s.session_id || typeof r.turnId !== "string" || !r.turnId)
        return outcome(via, { kind: "unknown", reason: "malformed-receipt" }, "invalid conversations.send receipt");
    return outcome(via, { kind: "admitted", receipt: receipt("native", { nativeId: r.turnId, sessionId: s.session_id, nativeStatus: "accepted" }) });
}
/** The branded notifier inside AgentMBX.app, if installed (MBX_NOTIFIER overrides, e.g. for tests). */
export function macNotifierPath(home = homedir(), env = process.env) {
    const candidates = [env.MBX_NOTIFIER, join(home, "Applications/AgentMBX.app/Contents/MacOS/agentmbx-notify"),
        "/Applications/AgentMBX.app/Contents/MacOS/agentmbx-notify"].filter((p) => !!p);
    return candidates.find((p) => existsSync(p)) ?? null;
}
const shq = (s) => `'${s.replace(/'/g, `'\\''`)}'`;
/** Shell command a click on a wake notification runs (in a new Terminal window): this agent's inbox. */
export function inboxCommand(agent, node = process.execPath, bin = process.argv[1]) {
    return bin ? `${shq(node)} ${shq(bin)} inbox --as ${shq(agent)}` : `agentmbx inbox --as ${shq(agent)}`;
}
/** Ordered notification commands for this platform: the first that succeeds wins. Pure, so it is testable. */
export function desktopCommands(n, o = {}) {
    const platform = o.platform ?? process.platform, title = n.title ?? "AgentMBX", body = n.body.slice(0, 400);
    if (platform === "darwin") {
        const out = [];
        const notifier = macNotifierPath(o.home, o.env);
        if (notifier)
            out.push({ via: "desktop (AgentMBX.app)", file: notifier, timeout: 45_000, // first run may wait on the permission prompt
                args: ["--title", title, "--body", body, ...(n.subtitle ? ["--subtitle", n.subtitle] : []), ...(n.id ? ["--id", n.id] : []), ...(n.openCmd ? ["--open-cmd", n.openCmd] : [])] });
        const q = (s) => s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
        out.push({ via: "desktop (osascript)", file: "/usr/bin/osascript", timeout: 5_000,
            args: ["-e", `display notification "${q(body.slice(0, 200))}" with title "${q(title)}"${n.subtitle ? ` subtitle "${q(n.subtitle)}"` : ""}`] });
        return out;
    }
    return [{ via: "desktop (notify-send)", file: "notify-send", timeout: 5_000,
            args: ["-a", "AgentMBX", "-i", "mail-message-new", n.subtitle ? `${title}: ${n.subtitle}` : title, body] }];
}
export async function notifyDesktop(n) {
    if (process.env.MBX_NO_DESKTOP)
        return { ok: false, via: "desktop", error: "disabled" };
    let last = { ok: false, via: "desktop", error: "no notifier" };
    for (const c of desktopCommands(n)) {
        try {
            await run(c.file, c.args, { timeout: c.timeout });
            return { ok: true, via: c.via };
        }
        catch (e) {
            const err = e;
            // exit 3: the user turned AgentMBX notifications off. Respect that instead of falling back to osascript.
            if (err.code === 3)
                return { ok: false, via: c.via, error: "notifications for AgentMBX are turned off (System Settings > Notifications > AgentMBX)" };
            last = { ok: false, via: c.via, error: (err.stderr?.trim() || err.message).slice(0, 300) };
        }
    }
    return last;
}
// ---- wake reconciliation and pressure (T179) -------------------------------------------------------------
/** An `unknown` attempt is held this long before its mail may be woken once more (still within WAKE_LIMITS). */
export const UNKNOWN_HOLD_MS = 10 * 60_000;
const BUSY_BACKOFF_MAX_MS = 60_000;
const muteKey = (agent) => `wake-mute:${agent}`, busyKey = (agent) => `wake-busy:${agent}`, attemptKey = (agent) => `wake-attempt:${agent}`;
/** Owner control: no wake hints or desktop notices for `agent` until `until` (mail stays unread and searchable). */
export function muteWakes(node, agent, until) {
    if (until)
        node.store.set(muteKey(agent), until.toISOString());
    else
        node.store.db.prepare("DELETE FROM kv WHERE k=?").run(muteKey(agent));
    node.store.audit(until ? "wake.muted" : "wake.unmuted", { agent, ...(until ? { until: until.toISOString() } : {}) });
}
export const wakeMutedUntil = (node, agent, now = Date.now()) => {
    const until = node.store.get(muteKey(agent));
    return until && Date.parse(until) > now ? until : null;
};
/**
 * Before a new pass: an attempt marker left behind means the daemon stopped between submitting and recording the
 * result. The hint may have been admitted, so its mail is held as `unknown` instead of being submitted again (WC-14).
 * Held `unknown` mail older than UNKNOWN_HOLD_MS becomes wakeable once more: the brake still bounds every retry.
 */
function reconcileWakes(node, now) {
    for (const { k, v } of node.store.db.prepare("SELECT k, v FROM kv WHERE k GLOB 'wake-attempt:*'").all()) {
        let a;
        try {
            a = JSON.parse(v);
        }
        catch {
            node.store.db.prepare("DELETE FROM kv WHERE k=?").run(k);
            continue;
        }
        // T557: an attempt may cover project-mailbox rows, so the marker names each (message, mailbox) pair; a marker an older daemon wrote has only the ids.
        const pairs = (a.deliveries ?? a.messageIds.map((id) => ({ id, agent: a.agent }))).filter((p) => typeof p?.id === "string" && typeof p?.agent === "string");
        node.store.tx(() => {
            for (const p of pairs)
                node.store.db.prepare("UPDATE deliveries SET state='notified', note='unknown', updated_at=? WHERE msg_id=? AND agent=? AND state='delivered'")
                    .run(new Date(now).toISOString(), p.id, p.agent);
            node.store.db.prepare("DELETE FROM kv WHERE k=?").run(k);
        });
        node.store.audit("wake.unknown", { agent: a.agent, attempt: a.attemptId, reason: "killed", count: pairs.length });
    }
    // One statement for both restores (an optional mailbox filter), so mail held as unknown goes back to delivered:
    const restore = node.store.db.prepare("UPDATE deliveries SET state='delivered', note=NULL WHERE state='notified' AND note='unknown' AND updated_at<=? AND (? IS NULL OR agent=?)");
    restore.run(new Date(now - UNKNOWN_HOLD_MS).toISOString(), null, null); // everywhere, once its hold has passed
    // T681: an OpenCode session that reported its turn ended (T675 "idle") is past any wake a lost receipt may have hidden. Mail
    // held as unknown from before that report is wakeable again now, not after UNKNOWN_HOLD_MS: T675 skips the stop note for that
    // turn end, so otherwise nothing surfaces it. The next pass applies every usual check and only finds mail still unread.
    for (const s of node.store.db.prepare("SELECT DISTINCT agent, session_id FROM sessions WHERE cli='opencode'").all()) {
        const idle = opencodeIdleAt(s.session_id);
        if (idle !== undefined)
            restore.run(new Date(idle).toISOString(), s.agent, s.agent);
    }
}
/** A live `agentmbx watch` process for this agent (T033): the session wakes itself when it exits, so the daemon defers. */
export const watcherKey = (agent) => `watcher:${agent}`;
export const WATCHER_FRESH_MS = 15_000;
export function liveWatcher(node, agent, now = Date.now()) {
    const w = JSON.parse(node.store.get(watcherKey(agent)) ?? "null");
    if (!w || now - w.at > WATCHER_FRESH_MS)
        return false;
    // A moved lease invalidates the old watcher (T343 review / T348 finding 3): a watcher started
    // under a previous token must not keep answering for the session that claimed the name after.
    if (w.token) {
        const row = node.store.db.prepare("SELECT token FROM identity_leases WHERE name=?").get(agent);
        if (!row || row.token !== w.token)
            return false;
    }
    try {
        process.kill(w.pid, 0);
        return true;
    }
    catch {
        return false;
    }
}
const NOTICES_PER_MINUTE = 6;
/** Desktop notices only for agents this host knows, and at most NOTICES_PER_MINUTE across all of them. */
function noticeAllowed(node, agent, now) {
    const known = node.store.db.prepare("SELECT 1 FROM agents WHERE name=? AND host=?").get(agent, node.host) || node.sessionsFor(agent).length;
    if (!known)
        return false;
    const recent = JSON.parse(node.store.get("desktop-notices") ?? "[]").filter((t) => now - t < 60_000);
    if (recent.length >= NOTICES_PER_MINUTE)
        return false;
    node.store.set("desktop-notices", JSON.stringify([...recent, now]));
    return true;
}
/** One pass of the wake dispatcher: every delivered-but-not-notified message is either woken, batched or skipped. */
export async function dispatchWakes(node, now = Date.now()) {
    const codexBlocked = await reconcileCodexQueue(node.store, CODEX(), p => keepCodexNotice(node, p));
    reconcileWakes(node, now);
    requeueWatchReported(node, now); // T667: a watcher-exit hint dropped mid-turn leaves mail 'notified'; requeue it once
    // T557: a project mailbox slot has no session of its own. Its mail is woken for the project's CURRENT lead on this host (the subject: whose
    // session, policy, mute and batching window apply) while every delivery operation stays on the slot (the row's own mailbox, r.agent).
    // A slot with no such lead (unallocated, none designated, designated elsewhere, expired, revoked) is left alone: it stays delivered.
    const pending = node.store.db.prepare(`SELECT d.agent, m.* FROM deliveries d JOIN messages m ON m.id=d.msg_id WHERE d.state='delivered' ORDER BY m.ts`).all();
    const byAgent = new Map(), leaders = new Map();
    for (const r of pending) {
        if (isSlotName(r.agent) && !leaders.has(r.agent))
            leaders.set(r.agent, leadAgentOf(node, r.agent, new Date(now)));
        const subject = isSlotName(r.agent) ? leaders.get(r.agent) : r.agent;
        if (subject !== null)
            byAgent.set(subject, [...(byAgent.get(subject) ?? []), r]);
    }
    const out = [];
    for (const [agent, rows] of byAgent) {
        const bound = node.sessionsFor(agent);
        const held = bound.flatMap(session => {
            const guard = captureWakeIdentity(node, session);
            return guard ? [guard] : [];
        });
        // A live exact session of a live lease whose authority was not captured: retry it, never strand its mail (T646).
        const lease = node.store.db.prepare("SELECT cli FROM identity_leases WHERE name=? AND released_at IS NULL").get(agent);
        // T659: an idle OpenCode session's MCP is evicted about hourly, which releases its lease; with no lease there is no
        // captureWakeIdentity, but the serve's plugin is still polling. Only when no lease-based holder exists.
        const pollers = held.length ? [] : pollerWakeTargets(node, agent, bound);
        const unverified = bound.filter(s => !s.session_id.startsWith("mcp-") && !held.some(g => g.session === s)
            && s.cli === lease?.cli && !!s.pid && node.sameSession(s.pid, s));
        if (!unverified.length || pollers.length)
            node.store.db.prepare("DELETE FROM kv WHERE k=?").run(`wake-capture-failed:${agent}`);
        const sessions = [...held, ...pollers].filter(g => !g.session.session_id.startsWith("mcp-"));
        // Only the current leased channel may suppress daemon delivery.
        if (held.some(g => g.session.channel))
            continue;
        if (liveWatcher(node, agent, now))
            continue; // its own watcher reports the mail and marks it notified
        const wanted = rows.filter((r) => node.wantsWake(agent, r));
        const markAll = () => rows.forEach((r) => node.setDelivery(r.id, r.agent, "notified"));
        if (!wanted.length) {
            markAll();
            continue;
        }
        if (wakeMutedUntil(node, agent, now))
            continue; // muted: no hint and no notice; the mail stays delivered and unread
        const busy = JSON.parse(node.store.get(busyKey(agent)) ?? "null");
        // T675: an OpenCode session whose turn ended after the last busy answer is asked on this pass, not after the backoff. The idle
        // report admits nothing itself; this pass applies every usual check. A record without `at` (older daemon) keeps its backoff.
        const idleSinceBusy = busy?.at !== undefined
            && sessions.some((g) => g.session.cli === "opencode" && (opencodeIdleAt(g.session.session_id) ?? 0) > busy.at);
        if (busy && busy.next > now && !idleSinceBusy)
            continue; // a busy session is asked again with backoff, not every pass
        // a hosted kimi session that is mid-turn is working already: leave the mail queued (its Stop hook also
        // surfaces new mail) and retry on the next pass, without spending any of the wake brake below
        // T557: project mail alone, and no verified session to wake: nothing to attempt. It waits, delivered, with no budget spent and no notice; the next pass
        // after the lead binds a wakeable session picks it up, and an urgent message with no live lead is the owner's through stranded.ts.
        const ownRows = rows.filter((r) => !isSlotName(r.agent));
        if (!ownRows.length && !sessions.length)
            continue;
        const automatic = wanted.filter(r => hasWakeAuthority(node, agent, r));
        if (automatic.length && await kimiBusyNow(sessions.map(g => g.session), fetch)) {
            node.store.set(busyKey(agent), JSON.stringify({ n: (busy?.n ?? 0) + 1, next: now + Math.min(2_000 * 2 ** (busy?.n ?? 0), BUSY_BACKOFF_MAX_MS), at: now }));
            node.store.audit("wake", { agent, via: "kimi web", ok: false, busy: true, count: wanted.length });
            out.push({ agent, result: { ok: false, via: "kimi web", error: "session busy (retrying next pass)" } });
            continue;
        }
        const reservation = node.reserveWake(agent, wanted[0].thread);
        const brake = reservation.brake;
        if (brake?.startsWith("batched"))
            continue; // try again next pass, messages accumulate into one wake
        if (brake) {
            markAll();
            out.push({ agent, result: { ok: false, via: "brake", error: brake } });
            node.store.audit("wake.brake", { agent, brake });
            continue;
        }
        const text = wakeTextFor(node, agent, automatic.length ? automatic : wanted) + policyBrief(node.store.db, agent, node.host);
        let result = { ok: false, via: "none", error: "no bound session" };
        let attempts = 0;
        let submitted, fenced = false;
        // Exact sessions only (owner decision 2026-09-30): a provisional mcp- binding is a process, not a wakeable
        // session, so it gets the notice fallback instead of a guessed sibling session in the same directory.
        for (const guard of automatic.length ? sessions : []) {
            const s = guard.session;
            if (s.cli === "codex" && (codexBlocked.has(agent) || codexBlocked.has("*"))) {
                result = outcome("codex queue", { kind: "busy" }, "previous Codex notice withdrawal is unresolved");
                break;
            }
            const recheck = () => {
                try {
                    return guard.run(() => automatic.every(r => {
                        const delivery = node.store.db.prepare("SELECT state FROM deliveries WHERE msg_id=? AND agent=?").get(r.id, r.agent);
                        // T557: a project row also needs the lead's read scope now, inside the lead's own lease: the predicate that gates reading it.
                        return delivery?.state === "delivered" && (hasWakeAuthority(node, agent, r)) && (!isSlotName(r.agent) || node.readableSlots(agent).includes(r.agent));
                    }));
                }
                catch {
                    return false;
                }
            };
            if (!recheck()) {
                fenced = true;
                break;
            }
            const marker = { attemptId: ulid(), agent, messageIds: automatic.map((r) => r.id), deliveries: automatic.map((r) => ({ id: r.id, agent: r.agent })), sessionId: s.session_id, at: new Date(now).toISOString() };
            node.store.set(attemptKey(agent), JSON.stringify(marker)); // durable before the native write (WC-14)
            if (s.cli === "codex")
                result = await wakeCodex(s.session_id, text, { recheck,
                    queue: { store: node.store, agent, deliveries: marker.deliveries, run: guard.run, keep: p => keepCodexNotice(node, p) } });
            else if (s.cli === "opencode") {
                // T661: a session whose live connector is behind the installed build learns how it switches, once, on a real wake.
                const skew = wakeSkewNote(node, s);
                result = await wakeOpencode(s.session_id, skew ? `${text}\n${skew.text}` : text, { recheck, pid: s.pid });
                if (skew && result.outcome?.kind === "admitted")
                    markSkewNoted(node, skew, result.outcome.receipt.nativeId ?? null);
            }
            else if (s.cli === "kimi")
                result = kimiDesktop(s.pid) ? await wakeKimiDesktop(s, text, { recheck }) : await wakeKimi(s, text, { recheck });
            else if (s.cli === "grok")
                result = await wakeGrok(s.session_id, text, { recheck });
            else
                continue;
            attempts++;
            node.store.audit("wake.attempt", { agent, attempt: marker.attemptId, session: `${s.cli}:${s.session_id}`, outcome: result.outcome?.kind ?? null,
                ...(result.failure ? { failure: result.failure } : {}),
                ...(result.outcome && "reason" in result.outcome ? { reason: result.outcome.reason } : {}),
                ...(result.outcome?.kind === "admitted" ? { receipt: result.outcome.receipt.strength, native: result.outcome.receipt.nativeId,
                    ...(result.outcome.receipt.nativeStatus ? { nativeStatus: result.outcome.receipt.nativeStatus } : {}) } : {}) });
            if (result.outcome?.kind === "admitted" && result.outcome.receipt.nativeStatus === OPENCODE_QUEUED_BEHIND_TURN)
                noteQueuedBehindTurn(node.store, agent, marker.messageIds, marker.at);
            const o = result.outcome, kind = o?.kind;
            if (o?.kind === "not_submitted" && o.reason === "fenced") {
                fenced = true;
                break;
            }
            if (kind !== "not_submitted")
                submitted = guard;
            if (!recheck()) {
                fenced = true;
                break;
            }
            // admitted and busy settle this pass; unknown may already be admitted, so no second write anywhere (WC-08);
            // blocked needs a person. Only a definite not_submitted or failed moves on to the next session.
            if (kind === "admitted" || kind === "busy" || kind === "unknown" || kind === "blocked")
                break;
        }
        const clearAttempt = () => node.store.db.prepare("DELETE FROM kv WHERE k=?").run(attemptKey(agent));
        if (result.outcome?.kind !== "unknown")
            clearAttempt();
        if (isRetry(result))
            node.store.set(busyKey(agent), JSON.stringify({ n: (busy?.n ?? 0) + 1, next: now + Math.min(2_000 * 2 ** (busy?.n ?? 0), BUSY_BACKOFF_MAX_MS), at: now }));
        else if (busy)
            node.store.db.prepare("DELETE FROM kv WHERE k=?").run(busyKey(agent));
        if (fenced) {
            // refund only when nothing may have reached a provider in this pass
            if (!submitted)
                reservation.release?.();
            node.store.audit("wake.fenced", { agent, count: automatic.length });
            out.push({ agent, result: { ok: false, via: "lease", error: "wake authority changed; delivery retained for a later pass" } });
            continue;
        }
        if (isRetry(result)) { // hosted but busy again (race): mail stays delivered, next pass retries
            // A previous adapter failure could have submitted a wake before losing its response. Retain
            // that budget; only refund the known-unsent first attempt, by its own reservation identity.
            if (attempts === 1)
                reservation.release?.();
            node.store.audit("wake", { agent, via: result.via, ok: false, busy: true, count: wanted.length });
            out.push({ agent, result });
            continue;
        }
        if (result.outcome?.kind === "unknown") {
            // The hint may be queued already: never resubmit it blindly (T179 reconciles). The mail stays unread and readable.
            const finish = () => { rows.forEach(r => node.setDelivery(r.id, r.agent, "notified", "unknown")); clearAttempt(); };
            try {
                if (submitted)
                    submitted.run(finish, false);
                else
                    node.store.tx(finish);
            }
            catch {
                clearAttempt(); /* ownership changed: delivery retained */
            }
            node.store.audit("wake.unknown", { agent, via: result.via, attempt: result.outcome.attemptId, reason: result.outcome.reason, count: wanted.length });
            out.push({ agent, result });
            continue;
        }
        // T557: the dispatcher never turns project mail into a desktop notice (stranded.ts owns that escalation), so a wake that did not happen leaves it
        // delivered for the next pass. Only when no native write was attempted is the batching budget refunded.
        const ownWanted = wanted.filter((r) => !isSlotName(r.agent));
        if (!result.ok && !ownWanted.length) {
            if (!attempts)
                reservation.release?.();
            continue;
        }
        let desktop = false;
        // A name with no registered agent or session gets no notice, and notices are rate limited across all names (T196, F6):
        // mail to made-up names cannot flood the desktop or stall the daemon. The mail is still re-woken once a session binds.
        if (!result.ok && !noticeAllowed(node, agent, now)) {
            // T646: an exact session exists but its wake authority could not be captured this pass. With no notice either,
            // marking the mail notified would strand it until some later rebind; leave it delivered for the next pass.
            if (!attempts && unverified.length) {
                reservation.release?.();
                const sessionsSeen = unverified.map(s => `${s.cli}:${s.session_id}`), seenKey = `wake-capture-failed:${agent}`;
                if (node.store.get(seenKey) !== JSON.stringify(sessionsSeen)) {
                    node.store.set(seenKey, JSON.stringify(sessionsSeen));
                    node.store.audit("wake.capture_failed", { agent, sessions: sessionsSeen, count: wanted.length });
                }
                out.push({ agent, result: { ok: false, via: "lease", error: "wake identity not verified and notice skipped; delivery retained for a later pass" } });
                continue;
            }
            node.store.tx(() => ownRows.forEach(r => node.setDelivery(r.id, r.agent, "notified", "desktop")));
            node.store.audit("wake.notice_skipped", { agent, count: wanted.length });
            out.push({ agent, result: { ok: false, via: "desktop", error: "notice skipped (unknown agent or notice rate limit)" } });
            continue;
        }
        if (!result.ok)
            result = await notifyDesktop({ subtitle: agent, body: wakeTextFor(node, agent, ownWanted) + policyBrief(node.store.db, agent, node.host), openCmd: inboxCommand(agent) }).then((r) => { desktop = r.ok; return r.ok ? r : result; });
        // mail that only reached the desktop gets another wake when a wakeable session binds (node.bindSession)
        const finish = () => (desktop || !result.ok ? ownRows : rows).forEach(r => node.setDelivery(r.id, r.agent, "notified", desktop || !result.ok ? "desktop" : null));
        try {
            if (submitted && result.ok && !desktop)
                submitted.run(finish, false);
            else
                node.store.tx(finish);
        }
        catch {
            out.push({ agent, result: { ok: false, via: "lease", error: "wake completed after ownership changed; delivery retained" } });
            continue;
        }
        node.store.audit("wake", { agent, via: result.via, ok: result.ok, count: wanted.length });
        out.push({ agent, result });
    }
    return out;
}
