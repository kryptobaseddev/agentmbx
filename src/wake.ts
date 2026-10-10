// Wake adapters: how a new message reaches an agent whose session is idle. The text never contains the
// message body, only a pointer to the mbx_inbox tool, so content always arrives through the framed tool result.
import { execFile, execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { kimiHostedServer, type KimiServer } from "./kimi-web.ts";
import { desktopRpc, kimiDesktop, RpcError, type KimiDesktop } from "./kimi-desktop.ts";
import { GROK_NO_PUSH, MbxNode, trustLabel } from "./node.ts";
import { captureWakeIdentity } from "./wake-identity.ts";
import { policyBrief } from "./policy.ts";
import { ulid } from "./crypto.ts";
import { opencodeHostOf, type OpencodeHost } from "./opencode-provider.ts";
import { pushOpencodeWake } from "./opencode-wake-queue.ts";
import type { WakeOutcome, WakeReceipt } from "./wake-contract.ts";
import type { MessageRow } from "./store.ts";

const run = promisify(execFile);
/** `ok` is true only for an admitted wake or a shown notice. Provider adapters also report the typed `outcome` (T178,
 *  docs/spec/provider-wake-contract.md); the dispatcher decides from the outcome, never from error text. */
export type WakeResult = ({ ok: true; via: string } | { ok: false; via: string; error: string; retry?: boolean }) & { outcome?: WakeOutcome };
const attemptId = () => ulid();
const receipt = (strength: WakeReceipt["strength"], r: Partial<WakeReceipt> = {}): WakeReceipt =>
  ({ strength, nativeId: null, sessionId: null, nativeStatus: null, providerVersion: null, ...r });
/** Build the legacy result and the typed outcome together, so the two can never disagree. */
function outcome(via: string, o: DistributiveOmit<WakeOutcome, "attemptId" | "via">, error?: string): WakeResult {
  const full = { ...o, attemptId: attemptId(), via } as WakeOutcome;
  if (full.kind === "admitted") return { ok: true, via, outcome: full };
  return { ok: false, via, error: (error ?? full.detail ?? full.kind).slice(0, 300), ...(full.kind === "busy" ? { retry: true } : {}), outcome: full };
}
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
/** A request that failed before any byte reached the provider (refused, unresolvable) proved nothing was submitted. */
const neverSent = (e: unknown) => {
  const c = (e as { cause?: { code?: string; errors?: { code?: string }[] }; code?: string })?.cause ?? (e as { code?: string });
  return [c?.code, ...((c as { errors?: { code?: string }[] })?.errors ?? []).map((x) => x.code)].some((x) => /^(ECONNREFUSED|ENOTFOUND|EHOSTUNREACH|ENETUNREACH|EAI_AGAIN)$/.test(x ?? ""));
};
const timedOut = (e: unknown) => /TimeoutError|AbortError/.test((e as Error)?.name ?? "");
type Fetch = typeof fetch;
const isRetry = (r: WakeResult): boolean => !r.ok && r.retry === true;

/** A wake starts agent work, so a downgraded message cannot borrow the mailbox's broad policy. */
export const hasWakeAuthority = (node: MbxNode, agent: string, message: MessageRow): boolean =>
  node.policyFor(message, agent).level !== "ask" || node.authorityFor(message)?.ok === true;

/** kv key: when the owner last typed a prompt in a session holding `agent` (hook "prompt"; ends relay chains, T104). */
export const humanPromptKey = (agent: string) => `human-prompt:${agent}`;
/** Prompts AgentMBX itself submits (wakes, [mbx-watch] self-checks) are not the owner and never end a relay chain. */
/** T460: Hermes wraps a finished background process (our watcher) in its own `[IMPORTANT: Background process <id> completed …]`
 *  turn, so the wake hint sits inside the text instead of at its start. Only that wrapper around our own hint is machine-made. */
const HERMES_WATCH_WRAPPER = /^\s*\[IMPORTANT: (?:Background process \S+ |\d+ background processes )[\s\S]*?\[mbx(?:-watch)?\]/;
export const isHumanPrompt = (prompt: unknown): boolean => typeof prompt === "string" && !!prompt.trim() && !/^\s*\[mbx(-watch)?\]/.test(prompt)
  && !HERMES_WATCH_WRAPPER.test(prompt);

export function wakeText(agent: string, msgs: MessageRow[]): string {
  const senders = [...new Set(msgs.map((m) => `${m.from_addr} [${trustLabel(m).split(" · ")[0].split(" (")[0]}]`))].join(", ");
  const owner = msgs.some(m => (JSON.parse(m.envelope) as { authority?: unknown }).authority) ? " Includes an owner-authority claim; verify its current mbx_read header." : "";
  // A hint can be queued while the session is busy and shown after the mail was handled: name the ids so it is checkable (T195).
  const ids = msgs.slice(0, 5).map((m) => m.id).join(", ") + (msgs.length > 5 ? `, +${msgs.length - 5} more` : "");
  // One line (owner, 2026-10-02): the trust rules live in the MCP instructions, the session-start note and every
  // mbx_read header; repeating them in each wake only spent context. Content is never in a wake, only ids.
  // T442: the stale-hint note is conditional. An unconditional "Already handled: no action needed" was obeyed
  // literally and made agents skip unread mail.
  return `[mbx] ${msgs.length} new message(s) for ${agent} from ${senders} (ids ${ids}).${owner} mbx_inbox or mbx_read, reply, ack. If you already handled these ids, no action is needed.`;
}

export const which = (bin: string) => { try { return execFileSync("/usr/bin/which", [bin], { encoding: "utf8" }).trim() || null; } catch { return null; } };
const CODEX = () => process.env.MBX_CODEX_BIN || which("codex") || join(homedir(), ".local/bin/codex");
const OPENCODE = () => process.env.MBX_OPENCODE_BIN || which("opencode") || join(homedir(), ".opencode/bin/opencode");

/** Grok's interactive session cannot be handed a prompt from outside. Nothing is spawned or written.
 *  `unsupported` holds: retrying cannot grow a path the CLI does not have. */
export async function wakeGrok(_sessionId: string, _text: string, o: { recheck?: () => boolean } = {}): Promise<WakeResult> {
  const via = "grok none";
  if (o.recheck && !o.recheck()) return outcome(via, { kind: "not_submitted", reason: "fenced" }, "wake authority changed");
  return outcome(via, { kind: "not_submitted", reason: "unsupported", detail: GROK_NO_PUSH }, GROK_NO_PUSH);
}

export async function wakeCodex(threadId: string, text: string, o: { recheck?: () => boolean } = {}): Promise<WakeResult> {
  const via = "codex queue";
  if (o.recheck && !o.recheck()) return outcome(via, { kind: "not_submitted", reason: "fenced" }, "wake authority changed");
  try {
    await run(CODEX(), ["queue", "--thread", threadId, "--message", text], { timeout: 20_000 });
    return outcome(via, { kind: "admitted", receipt: receipt("exit-status", { sessionId: threadId }) });
  } catch (e) {
    const err = e as Error & { code?: number | string; killed?: boolean; signal?: string | null };
    const detail = err.message.slice(0, 300);
    if (err.code === "ENOENT" || err.code === "EACCES") return outcome(via, { kind: "not_submitted", reason: "unavailable", detail });
    // Killed by the timeout or a signal: the queue write may already have landed.
    if (err.killed || err.signal) return outcome(via, { kind: "unknown", reason: err.killed ? "timeout" : "killed", detail });
    return outcome(via, { kind: "failed", status: typeof err.code === "number" ? err.code : null, detail });
  }
}

export async function opencodeService(): Promise<{ url: string; auth: string } | null> {
  try {
    const url = process.env.MBX_OPENCODE_URL || (await run(OPENCODE(), ["service", "status"], { timeout: 10_000 })).stdout.trim().split(/\s+/).find((w) => w.startsWith("http"));
    const cfg = join(homedir(), ".config/opencode/service.json");
    const pw = existsSync(cfg) ? (JSON.parse(readFileSync(cfg, "utf8")) as { password?: string }).password : undefined;
    if (!url) return null;
    return { url: url.replace(/\/$/, ""), auth: pw ? `Basic ${Buffer.from(`opencode:${pw}`).toString("base64")}` : "" };
  } catch { return null; }
}

/** T524: why a session that the shared service does not host is never pushed through it. */
export const OPENCODE_STANDALONE_NO_PUSH = "session is hosted by a standalone OpenCode serve; the shared service would start a duplicate agent loop (next-prompt delivery only)";

/** Push a wake into an OpenCode session. A service-hosted binding (its provider pid is
 *  `opencode serve --service`) keeps the direct synthetic POST below. A standalone serve
 *  (`opencode --standalone` → `opencode serve --stdio`) has no shared push channel: the plugin
 *  in that serve polls a loopback queue and admits the text with `ctx.session.synthetic` (T519).
 *  No waiting plugin is not_submitted/no-target and this function does not call the service, so
 *  the service starts no turn and takes no snapshot (T524). An unknown host stays not_submitted. */
export async function wakeOpencode(sessionId: string, text: string, o: { recheck?: () => boolean; service?: typeof opencodeService; fetch?: Fetch;
  pid?: number | null; host?: (pid: number | null | undefined) => OpencodeHost } = {}): Promise<WakeResult> {
  const via = "opencode synthetic";
  const host = (o.host ?? opencodeHostOf)(o.pid);
  if (host === "standalone") {
    const pid = typeof o.pid === "number" && Number.isInteger(o.pid) && o.pid > 0 ? o.pid : 0;
    const pushed = pid > 0 ? await pushOpencodeWake(sessionId, pid, text) : { ok: false as const, handedOff: false };
    if (pushed.ok) return outcome(via, { kind: "admitted", receipt: receipt("native", { nativeId: pushed.id, sessionId, nativeStatus: "queued" }) });
    // The plugin already has the text. A missing msg_ id is not a reason to POST it to the service.
    if (pushed.handedOff) return outcome(via, { kind: "unknown", reason: "lost-response", detail: "standalone plugin took the wake and returned no msg_ receipt" });
    return outcome(via, { kind: "not_submitted", reason: "no-target", detail: OPENCODE_STANDALONE_NO_PUSH });
  }
  if (host !== "service") return outcome(via, { kind: "not_submitted", reason: "no-target", detail: "the OpenCode process hosting this session is unknown; not pushing through the shared service, which could start a duplicate agent loop" });
  const svc = await (o.service ?? opencodeService)();
  if (!svc) return outcome(via, { kind: "not_submitted", reason: "unavailable" }, "opencode service not running");
  if (o.recheck && !o.recheck()) return outcome(via, { kind: "not_submitted", reason: "fenced" }, "wake authority changed");
  let res: Response;
  try {
    res = await (o.fetch ?? fetch)(`${svc.url}/api/session/${encodeURIComponent(sessionId)}/synthetic`, {
      method: "POST", headers: { "content-type": "application/json", ...(svc.auth ? { authorization: svc.auth } : {}) },
      body: JSON.stringify({ text, delivery: "queue", resume: true }), redirect: "error", signal: AbortSignal.timeout(10_000) });
  } catch (e) {
    const detail = (e as Error).message;
    if (neverSent(e)) return outcome(via, { kind: "not_submitted", reason: "unavailable", detail });
    return outcome(via, { kind: "unknown", reason: timedOut(e) ? "timeout" : "lost-response", detail });
  }
  if (!res.ok) return outcome(via, { kind: "failed", status: res.status }, `${res.status} ${(await res.text().catch(() => "")).slice(0, 300)}`);
  const j = await res.json().catch(() => null) as { data?: { id?: unknown; sessionID?: unknown; type?: unknown; delivery?: unknown;
    payload?: { text?: unknown }; time?: { created?: unknown } } } | null;
  const r = j?.data;
  // The write was accepted: a receipt that does not match proves neither admission nor rejection (never resubmit blindly).
  if (!r || typeof r.id !== "string" || !r.id.startsWith("msg_")
    || r.sessionID !== sessionId || r.type !== "synthetic" || r.delivery !== "queue"
    || r.payload?.text !== text || typeof r.time?.created !== "number" || !Number.isFinite(r.time.created))
    return outcome(via, { kind: "unknown", reason: "mismatched-receipt" }, "invalid or mismatched synthetic admission receipt");
  // Durable admission is not evidence that the model ran or handled the mailbox message.
  return outcome(via, { kind: "admitted", receipt: receipt("native", { nativeId: r.id, sessionId, nativeStatus: "queued" }) });
}

// ---- kimi web -----------------------------------------------------------------------------------
/** One bound session row as the kimi adapter needs it. */
export interface KimiSessionRef { session_id: string; pid: number | null }

/** True when the newest hosted kimi session of this agent is mid-turn. Waking a busy session would spend the
 *  wake brake (WAKE_LIMITS) for nothing, so dispatchWakes skips the agent instead and retries on its next pass. */
async function kimiBusyNow(sessions: KimiSessionRef[], f: Fetch): Promise<boolean> {
  for (const s of sessions) {
    const srv = kimiHostedServer(s.pid);
    if (!srv) continue;
    try {
      const res = await f(`${srv.url}/api/v1/sessions/${encodeURIComponent(s.session_id)}/status`, { headers: { authorization: `Bearer ${srv.token}` }, redirect: "error", signal: AbortSignal.timeout(3_000) });
      const j = await res.json().catch(() => null) as { code?: number; data?: { busy?: boolean } } | null;
      return res.ok && j?.code === 0 && j.data?.busy === true;
    } catch { return false; }
  }
  return false;
}

/** The server's configured default model alias (GET /api/v1/config), used when the session has none bound. */
async function kimiDefaultModel(srv: KimiServer, f: Fetch): Promise<string | null> {
  try {
    const res = await f(`${srv.url}/api/v1/config`, { headers: { authorization: `Bearer ${srv.token}` }, redirect: "error", signal: AbortSignal.timeout(5_000) });
    const j = await res.json().catch(() => null) as { code?: number; data?: { default_model?: string } } | null;
    return res.ok && j?.code === 0 && typeof j.data?.default_model === "string" && j.data.default_model ? j.data.default_model : null;
  } catch { return null; }
}

/** Is this hosted session mid-turn right now? */
async function kimiSessionStatus(srv: KimiServer, sessionId: string, f: Fetch): Promise<{ busy: boolean; model?: string } | { error: string }> {
  const res = await f(`${srv.url}/api/v1/sessions/${encodeURIComponent(sessionId)}/status`, { headers: { authorization: `Bearer ${srv.token}` }, redirect: "error", signal: AbortSignal.timeout(5_000) });
  const j = await res.json().catch(() => null) as { code?: number; data?: { busy?: boolean; model?: string }; message?: string; msg?: string } | null;
  if (!res.ok || j?.code !== 0) return { error: `status ${res.status}: ${(j?.msg ?? j?.message ?? JSON.stringify(j)).slice(0, 200)}` };
  if (!j.data || Array.isArray(j.data) || typeof j.data.busy !== "boolean"
    || (j.data.model !== undefined && typeof j.data.model !== "string")) return { error: "invalid session status response" };
  return { busy: j.data.busy, ...(j.data.model !== undefined ? { model: j.data.model } : {}) };
}

/**
 * Wake a kimi web-hosted session by submitting the wake text as a user prompt through the server's REST API
 * (POST /api/v1/sessions/{id}/prompts, bearer server.token). A binding counts as hosted only when its pid is a live
 * `kimi web` server instance ($KIMI_CODE_HOME/server/instances); terminal TUI sessions have no instances row and
 * are never woken. A hosted session that is busy returns `retry: true` so the dispatcher leaves the mail queued
 * for its next pass instead of spending wake budget (its Stop hook also surfaces new mail mid-turn).
 */
export async function wakeKimi(s: KimiSessionRef, text: string, o: { server?: KimiServer | null; fetch?: Fetch; model?: string | null; recheck?: () => boolean } = {}): Promise<WakeResult> {
  const via = "kimi web";
  const srv = o.server === undefined ? kimiHostedServer(s.pid) : o.server;
  if (!srv) return outcome(via, { kind: "not_submitted", reason: "no-target" }, "not a kimi web-hosted session");
  const f = o.fetch ?? fetch, base = `${srv.url}/api/v1/sessions/${encodeURIComponent(s.session_id)}`;
  const headers = { authorization: `Bearer ${srv.token}`, "content-type": "application/json" };
  let model: string | null;
  try {
    const st = await kimiSessionStatus(srv, s.session_id, f);
    if ("error" in st) return outcome(via, { kind: "not_submitted", reason: "preflight" }, st.error);
    if (st.busy) return outcome(via, { kind: "busy" }, "session busy");
    // A freshly created hosted session has no model bound: submitting a prompt then fails with "Model not set"
    // (ErrorCodes.MODEL_NOT_CONFIGURED, from the profile's model getter). The prompts endpoint accepts an optional
    // model alias and binds it before the prompt runs, so send one only when the session has none (the server's
    // configured default), and an explicit o.model always wins.
    model = o.model !== undefined ? o.model : st.model ? null : await kimiDefaultModel(srv, f);
  } catch (e) { return outcome(via, { kind: "not_submitted", reason: "preflight" }, (e as Error).message); }
  const body: { content: { type: "text"; text: string }[]; model?: string } = { content: [{ type: "text", text }] };
  if (model) body.model = model;
  if (o.recheck && !o.recheck()) return outcome(via, { kind: "not_submitted", reason: "fenced" }, "wake authority changed");
  let res: Response;
  try { res = await f(`${base}/prompts`, { method: "POST", headers, body: JSON.stringify(body), redirect: "error", signal: AbortSignal.timeout(15_000) }); }
  catch (e) {
    const detail = (e as Error).message;
    if (neverSent(e)) return outcome(via, { kind: "not_submitted", reason: "unavailable", detail });
    return outcome(via, { kind: "unknown", reason: timedOut(e) ? "timeout" : "lost-response", detail });
  }
  const j = await res.json().catch(() => null) as { code?: number; data?: { prompt_id?: string; status?: string }; message?: string; msg?: string } | null;
  const why = `prompts ${res.status}: ${(j?.msg ?? j?.message ?? JSON.stringify(j)).slice(0, 200)}`;
  if (!res.ok || j?.code !== 0) return /model not set|model_not_configured/i.test(why)
    ? outcome(via, { kind: "blocked", gate: "model-unconfigured" }, why) : outcome(via, { kind: "failed", status: res.status }, why);
  if (!j.data || Array.isArray(j.data) || typeof j.data.prompt_id !== "string" || !j.data.prompt_id.trim()
    || !["running", "queued", "blocked"].includes(j.data.status ?? ""))
    return outcome(via, { kind: "unknown", reason: "malformed-receipt" }, "invalid prompt submission receipt");
  // Submission, not model execution or a mailbox read/reply/ack. A "blocked" prompt is admitted and waits on a person.
  return outcome(via, { kind: "admitted", receipt: receipt("native", { nativeId: j.data.prompt_id, sessionId: s.session_id, nativeStatus: j.data.status ?? null }) });
}

// ---- kimi desktop --------------------------------------------------------------------------------
type DesktopRpc = typeof desktopRpc;

/**
 * Wake a Kimi desktop conversation through the app's control socket (T033): conversations.list maps the bound kernel
 * session id to its conversation, conversations.getBusy skips a turn in progress, conversations.send starts the turn.
 * A session counts as desktop-hosted only when its recorded pid is the live daimon of runner.state.json.
 */
export async function wakeKimiDesktop(s: KimiSessionRef, text: string, o: { desktop?: KimiDesktop | null; rpc?: DesktopRpc; recheck?: () => boolean } = {}): Promise<WakeResult> {
  const via = "kimi desktop";
  const d = o.desktop === undefined ? kimiDesktop(s.pid) : o.desktop;
  if (!d) return outcome(via, { kind: "not_submitted", reason: "no-target" }, "not a Kimi desktop session");
  const rpc = o.rpc ?? desktopRpc;
  let conversationKey: string;
  try {
    const [list] = await rpc(d, [["conversations.list", {}]]) as [{ conversations?: { conversationKey?: unknown; kernelSessionId?: unknown }[] }];
    const hit = list?.conversations?.find(c => c.kernelSessionId === s.session_id && typeof c.conversationKey === "string");
    if (!hit) return outcome(via, { kind: "not_submitted", reason: "no-target" }, "no desktop conversation for this session");
    conversationKey = hit.conversationKey as string;
    const [busy] = await rpc(d, [["conversations.getBusy", { conversationKey }]]) as [{ busy?: unknown }];
    if (typeof busy?.busy !== "boolean") return outcome(via, { kind: "not_submitted", reason: "preflight" }, "invalid busy response");
    if (busy.busy) return outcome(via, { kind: "busy" }, "conversation busy");
  } catch (e) { return outcome(via, { kind: "not_submitted", reason: "preflight" }, (e as Error).message); }
  if (o.recheck && !o.recheck()) return outcome(via, { kind: "not_submitted", reason: "fenced" }, "wake authority changed");
  let sent = false, r: { accepted?: unknown; kernelSessionId?: unknown; turnId?: unknown } | undefined;
  try { [r] = await rpc(d, [["conversations.send", { conversationKey, text }]], { timeoutMs: 15_000, sent: () => { sent = true; } }) as [typeof r]; }
  catch (e) {
    const detail = (e as Error).message;
    if (e instanceof RpcError) return e.code === -32010 ? outcome(via, { kind: "busy" }, detail) : outcome(via, { kind: "failed", status: e.code }, detail);
    return sent ? outcome(via, { kind: "unknown", reason: /timed out/.test(detail) ? "timeout" : "lost-response", detail })
      : outcome(via, { kind: "not_submitted", reason: "unavailable", detail });
  }
  if (r?.accepted !== true || r.kernelSessionId !== s.session_id || typeof r.turnId !== "string" || !r.turnId)
    return outcome(via, { kind: "unknown", reason: "malformed-receipt" }, "invalid conversations.send receipt");
  return outcome(via, { kind: "admitted", receipt: receipt("native", { nativeId: r.turnId, sessionId: s.session_id, nativeStatus: "accepted" }) });
}

// ---- desktop notifications -------------------------------------------------------------------
export type DesktopNote = { title?: string; subtitle?: string; body: string; id?: string; openCmd?: string };
type Cmd = { via: string; file: string; args: string[]; timeout: number };

/** The branded notifier inside AgentMBX.app, if installed (MBX_NOTIFIER overrides, e.g. for tests). */
export function macNotifierPath(home = homedir(), env: NodeJS.ProcessEnv = process.env): string | null {
  const candidates = [env.MBX_NOTIFIER, join(home, "Applications/AgentMBX.app/Contents/MacOS/agentmbx-notify"),
    "/Applications/AgentMBX.app/Contents/MacOS/agentmbx-notify"].filter((p): p is string => !!p);
  return candidates.find((p) => existsSync(p)) ?? null;
}

const shq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
/** Shell command a click on a wake notification runs (in a new Terminal window): this agent's inbox. */
export function inboxCommand(agent: string, node = process.execPath, bin = process.argv[1]): string {
  return bin ? `${shq(node)} ${shq(bin)} inbox --as ${shq(agent)}` : `agentmbx inbox --as ${shq(agent)}`;
}

/** Ordered notification commands for this platform: the first that succeeds wins. Pure, so it is testable. */
export function desktopCommands(n: DesktopNote, o: { platform?: NodeJS.Platform; home?: string; env?: NodeJS.ProcessEnv } = {}): Cmd[] {
  const platform = o.platform ?? process.platform, title = n.title ?? "AgentMBX", body = n.body.slice(0, 400);
  if (platform === "darwin") {
    const out: Cmd[] = [];
    const notifier = macNotifierPath(o.home, o.env);
    if (notifier) out.push({ via: "desktop (AgentMBX.app)", file: notifier, timeout: 45_000, // first run may wait on the permission prompt
      args: ["--title", title, "--body", body, ...(n.subtitle ? ["--subtitle", n.subtitle] : []), ...(n.id ? ["--id", n.id] : []), ...(n.openCmd ? ["--open-cmd", n.openCmd] : [])] });
    const q = (s: string) => s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    out.push({ via: "desktop (osascript)", file: "/usr/bin/osascript", timeout: 5_000,
      args: ["-e", `display notification "${q(body.slice(0, 200))}" with title "${q(title)}"${n.subtitle ? ` subtitle "${q(n.subtitle)}"` : ""}`] });
    return out;
  }
  return [{ via: "desktop (notify-send)", file: "notify-send", timeout: 5_000,
    args: ["-a", "AgentMBX", "-i", "mail-message-new", n.subtitle ? `${title}: ${n.subtitle}` : title, body] }];
}

export async function notifyDesktop(n: DesktopNote): Promise<WakeResult> {
  if (process.env.MBX_NO_DESKTOP) return { ok: false, via: "desktop", error: "disabled" };
  let last: WakeResult = { ok: false, via: "desktop", error: "no notifier" };
  for (const c of desktopCommands(n)) {
    try { await run(c.file, c.args, { timeout: c.timeout }); return { ok: true, via: c.via }; }
    catch (e) {
      const err = e as Error & { code?: number | string; stderr?: string };
      // exit 3: the user turned AgentMBX notifications off. Respect that instead of falling back to osascript.
      if (err.code === 3) return { ok: false, via: c.via, error: "notifications for AgentMBX are turned off (System Settings > Notifications > AgentMBX)" };
      last = { ok: false, via: c.via, error: (err.stderr?.trim() || err.message).slice(0, 300) };
    }
  }
  return last;
}


// ---- wake reconciliation and pressure (T179) -------------------------------------------------------------
/** An `unknown` attempt is held this long before its mail may be woken once more (still within WAKE_LIMITS). */
export const UNKNOWN_HOLD_MS = 10 * 60_000;
const BUSY_BACKOFF_MAX_MS = 60_000;
const muteKey = (agent: string) => `wake-mute:${agent}`, busyKey = (agent: string) => `wake-busy:${agent}`, attemptKey = (agent: string) => `wake-attempt:${agent}`;

/** Owner control: no wake hints or desktop notices for `agent` until `until` (mail stays unread and searchable). */
export function muteWakes(node: MbxNode, agent: string, until: Date | null) {
  if (until) node.store.set(muteKey(agent), until.toISOString()); else node.store.db.prepare("DELETE FROM kv WHERE k=?").run(muteKey(agent));
  node.store.audit(until ? "wake.muted" : "wake.unmuted", { agent, ...(until ? { until: until.toISOString() } : {}) });
}
export const wakeMutedUntil = (node: MbxNode, agent: string, now = Date.now()): string | null => {
  const until = node.store.get(muteKey(agent));
  return until && Date.parse(until) > now ? until : null;
};

/**
 * Before a new pass: an attempt marker left behind means the daemon stopped between submitting and recording the
 * result. The hint may have been admitted, so its mail is held as `unknown` instead of being submitted again (WC-14).
 * Held `unknown` mail older than UNKNOWN_HOLD_MS becomes wakeable once more: the brake still bounds every retry.
 */
function reconcileWakes(node: MbxNode, now: number) {
  for (const { k, v } of node.store.db.prepare("SELECT k, v FROM kv WHERE k GLOB 'wake-attempt:*'").all() as { k: string; v: string }[]) {
    let a: { attemptId: string; agent: string; messageIds: string[] };
    try { a = JSON.parse(v); } catch { node.store.db.prepare("DELETE FROM kv WHERE k=?").run(k); continue; }
    node.store.tx(() => {
      for (const id of a.messageIds) node.store.db.prepare("UPDATE deliveries SET state='notified', note='unknown', updated_at=? WHERE msg_id=? AND agent=? AND state='delivered'")
        .run(new Date(now).toISOString(), id, a.agent);
      node.store.db.prepare("DELETE FROM kv WHERE k=?").run(k);
    });
    node.store.audit("wake.unknown", { agent: a.agent, attempt: a.attemptId, reason: "killed", count: a.messageIds.length });
  }
  node.store.db.prepare("UPDATE deliveries SET state='delivered', note=NULL WHERE state='notified' AND note='unknown' AND updated_at<?")
    .run(new Date(now - UNKNOWN_HOLD_MS).toISOString());
}

/** A live `agentmbx watch` process for this agent (T033): the session wakes itself when it exits, so the daemon defers. */
export const watcherKey = (agent: string) => `watcher:${agent}`;
export const WATCHER_FRESH_MS = 15_000;
export function liveWatcher(node: MbxNode, agent: string, now = Date.now()): boolean {
  const w = JSON.parse(node.store.get(watcherKey(agent)) ?? "null") as { pid: number; at: number; token?: string } | null;
  if (!w || now - w.at > WATCHER_FRESH_MS) return false;
  // A moved lease invalidates the old watcher (T343 review / T348 finding 3): a watcher started
  // under a previous token must not keep answering for the session that claimed the name after.
  if (w.token) {
    const row = node.store.db.prepare("SELECT token FROM identity_leases WHERE name=?").get(agent) as { token: string } | undefined;
    if (!row || row.token !== w.token) return false;
  }
  try { process.kill(w.pid, 0); return true; } catch { return false; }
}

const NOTICES_PER_MINUTE = 6;
/** Desktop notices only for agents this host knows, and at most NOTICES_PER_MINUTE across all of them. */
function noticeAllowed(node: MbxNode, agent: string, now: number): boolean {
  const known = node.store.db.prepare("SELECT 1 FROM agents WHERE name=? AND host=?").get(agent, node.host) || node.sessionsFor(agent).length;
  if (!known) return false;
  const recent = (JSON.parse(node.store.get("desktop-notices") ?? "[]") as number[]).filter((t) => now - t < 60_000);
  if (recent.length >= NOTICES_PER_MINUTE) return false;
  node.store.set("desktop-notices", JSON.stringify([...recent, now]));
  return true;
}

/** One pass of the wake dispatcher: every delivered-but-not-notified message is either woken, batched or skipped. */
export async function dispatchWakes(node: MbxNode, now = Date.now()): Promise<{ agent: string; result: WakeResult | { ok: false; via: "brake"; error: string } }[]> {
  reconcileWakes(node, now);
  const pending = node.store.db.prepare(`SELECT d.agent, m.* FROM deliveries d JOIN messages m ON m.id=d.msg_id WHERE d.state='delivered' ORDER BY m.ts`).all() as unknown as (MessageRow & { agent: string })[];
  const byAgent = new Map<string, (MessageRow & { agent: string })[]>();
  for (const r of pending) byAgent.set(r.agent, [...(byAgent.get(r.agent) ?? []), r]);
  const out: { agent: string; result: WakeResult | { ok: false; via: "brake"; error: string } }[] = [];
  for (const [agent, rows] of byAgent) {
    const held = node.sessionsFor(agent).flatMap(session => {
      const guard = captureWakeIdentity(node, session); return guard ? [guard] : [];
    });
    const sessions = held.filter(g => !g.session.session_id.startsWith("mcp-"));
    // Only the current leased channel may suppress daemon delivery.
    if (held.some(g => g.session.channel)) continue;
    if (liveWatcher(node, agent, now)) continue; // its own watcher reports the mail and marks it notified
    const wanted = rows.filter((r) => node.wantsWake(agent, r));
    const markAll = () => rows.forEach((r) => node.setDelivery(r.id, agent, "notified"));
    if (!wanted.length) { markAll(); continue; }
    if (wakeMutedUntil(node, agent, now)) continue; // muted: no hint and no notice; the mail stays delivered and unread
    const busy = JSON.parse(node.store.get(busyKey(agent)) ?? "null") as { n: number; next: number } | null;
    if (busy && busy.next > now) continue; // a busy session is asked again with backoff, not every pass
    // a hosted kimi session that is mid-turn is working already: leave the mail queued (its Stop hook also
    // surfaces new mail) and retry on the next pass, without spending any of the wake brake below
    const automatic = wanted.filter(r => hasWakeAuthority(node, agent, r));
    if (automatic.length && await kimiBusyNow(sessions.map(g => g.session), fetch)) {
      node.store.set(busyKey(agent), JSON.stringify({ n: (busy?.n ?? 0) + 1, next: now + Math.min(2_000 * 2 ** (busy?.n ?? 0), BUSY_BACKOFF_MAX_MS) }));
      node.store.audit("wake", { agent, via: "kimi web", ok: false, busy: true, count: wanted.length });
      out.push({ agent, result: { ok: false, via: "kimi web", error: "session busy (retrying next pass)" } });
      continue;
    }
    const reservation = node.reserveWake(agent, wanted[0].thread);
    const brake = reservation.brake;
    if (brake?.startsWith("batched")) continue; // try again next pass, messages accumulate into one wake
    if (brake) { markAll(); out.push({ agent, result: { ok: false, via: "brake", error: brake } }); node.store.audit("wake.brake", { agent, brake }); continue; }
    const text = wakeText(agent, automatic.length ? automatic : wanted) + policyBrief(node.store.db, agent, node.host);
    let result: WakeResult = { ok: false, via: "none", error: "no bound session" };
    let attempts = 0;
    let submitted: typeof held[number] | undefined, fenced = false;
    // Exact sessions only (owner decision 2026-09-30): a provisional mcp- binding is a process, not a wakeable
    // session, so it gets the notice fallback instead of a guessed sibling session in the same directory.
    for (const guard of automatic.length ? sessions : []) {
      const s = guard.session;
      const recheck = () => {
        try { return guard.run(() => automatic.every(r => {
          const delivery = node.store.db.prepare("SELECT state FROM deliveries WHERE msg_id=? AND agent=?").get(r.id, agent);
          return delivery?.state === "delivered" && (hasWakeAuthority(node, agent, r));
        })); } catch { return false; }
      };
      if (!recheck()) { fenced = true; break; }
      const marker = { attemptId: ulid(), agent, messageIds: automatic.map((r) => r.id), sessionId: s.session_id, at: new Date(now).toISOString() };
      node.store.set(attemptKey(agent), JSON.stringify(marker)); // durable before the native write (WC-14)
      if (s.cli === "codex") result = await wakeCodex(s.session_id, text, { recheck });
      else if (s.cli === "opencode") result = await wakeOpencode(s.session_id, text, { recheck, pid: s.pid });
      else if (s.cli === "kimi") result = kimiDesktop(s.pid) ? await wakeKimiDesktop(s, text, { recheck }) : await wakeKimi(s, text, { recheck });
      else if (s.cli === "grok") result = await wakeGrok(s.session_id, text, { recheck });
      else continue;
      attempts++;
      node.store.audit("wake.attempt", { agent, attempt: marker.attemptId, session: `${s.cli}:${s.session_id}`, outcome: result.outcome?.kind ?? null,
        ...(result.outcome && "reason" in result.outcome ? { reason: result.outcome.reason } : {}),
        ...(result.outcome?.kind === "admitted" ? { receipt: result.outcome.receipt.strength, native: result.outcome.receipt.nativeId,
          ...(result.outcome.receipt.nativeStatus ? { nativeStatus: result.outcome.receipt.nativeStatus } : {}) } : {}) });
      const o = result.outcome, kind = o?.kind;
      if (o?.kind === "not_submitted" && o.reason === "fenced") { fenced = true; break; }
      if (kind !== "not_submitted") submitted = guard;
      if (!recheck()) { fenced = true; break; }
      // admitted and busy settle this pass; unknown may already be admitted, so no second write anywhere (WC-08);
      // blocked needs a person. Only a definite not_submitted or failed moves on to the next session.
      if (kind === "admitted" || kind === "busy" || kind === "unknown" || kind === "blocked") break;
    }
    const clearAttempt = () => node.store.db.prepare("DELETE FROM kv WHERE k=?").run(attemptKey(agent));
    if (result.outcome?.kind !== "unknown") clearAttempt();
    if (isRetry(result)) node.store.set(busyKey(agent), JSON.stringify({ n: (busy?.n ?? 0) + 1, next: now + Math.min(2_000 * 2 ** (busy?.n ?? 0), BUSY_BACKOFF_MAX_MS) }));
    else if (busy) node.store.db.prepare("DELETE FROM kv WHERE k=?").run(busyKey(agent));
    if (fenced) {
      // refund only when nothing may have reached a provider in this pass
      if (!submitted) reservation.release?.();
      node.store.audit("wake.fenced", { agent, count: automatic.length });
      out.push({ agent, result: { ok: false, via: "lease", error: "wake authority changed; delivery retained for a later pass" } });
      continue;
    }
    if (isRetry(result)) { // hosted but busy again (race): mail stays delivered, next pass retries
      // A previous adapter failure could have submitted a wake before losing its response. Retain
      // that budget; only refund the known-unsent first attempt, by its own reservation identity.
      if (attempts === 1) reservation.release?.();
      node.store.audit("wake", { agent, via: result.via, ok: false, busy: true, count: wanted.length });
      out.push({ agent, result });
      continue;
    }
    if (result.outcome?.kind === "unknown") {
      // The hint may be queued already: never resubmit it blindly (T179 reconciles). The mail stays unread and readable.
      const finish = () => { rows.forEach(r => node.setDelivery(r.id, agent, "notified", "unknown")); clearAttempt(); };
      try { if (submitted) submitted.run(finish, false); else node.store.tx(finish); } catch { clearAttempt(); /* ownership changed: delivery retained */ }
      node.store.audit("wake.unknown", { agent, via: result.via, attempt: result.outcome.attemptId, reason: result.outcome.reason, count: wanted.length });
      out.push({ agent, result });
      continue;
    }
    let desktop = false;
    // A name with no registered agent or session gets no notice, and notices are rate limited across all names (T196, F6):
    // mail to made-up names cannot flood the desktop or stall the daemon. The mail is still re-woken once a session binds.
    if (!result.ok && !noticeAllowed(node, agent, now)) {
      node.store.tx(() => rows.forEach(r => node.setDelivery(r.id, agent, "notified", "desktop")));
      node.store.audit("wake.notice_skipped", { agent, count: wanted.length });
      out.push({ agent, result: { ok: false, via: "desktop", error: "notice skipped (unknown agent or notice rate limit)" } });
      continue;
    }
    if (!result.ok) result = await notifyDesktop({ subtitle: agent, body: text, openCmd: inboxCommand(agent) }).then((r) => { desktop = r.ok; return r.ok ? r : result; });
    // mail that only reached the desktop gets another wake when a wakeable session binds (node.bindSession)
    const finish = () => rows.forEach(r => node.setDelivery(r.id, agent, "notified", desktop || !result.ok ? "desktop" : null));
    try { if (submitted && result.ok && !desktop) submitted.run(finish, false); else node.store.tx(finish); }
    catch { out.push({ agent, result: { ok: false, via: "lease", error: "wake completed after ownership changed; delivery retained" } }); continue; }
    node.store.audit("wake", { agent, via: result.via, ok: result.ok, count: wanted.length });
    out.push({ agent, result });
  }
  return out;
}
