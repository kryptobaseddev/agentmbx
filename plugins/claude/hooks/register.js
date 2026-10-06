/**
 * Claude Code 2.1.291 mod. The hooks sandbox imports nothing but relative
 * files and "claude-code", and it has no Node built-ins.
 *
 * Session id: `session.start` is only `{ cwd }`. The binary sets
 * `CLAUDE_CODE_SESSION_ID` on the process and on child env, and substitutes
 * `${CLAUDE_SESSION_ID}`. Those two names are read with `$.env.get` (a string
 * literal, which `claude plugin validate` can see). If both are missing or
 * blank, the band says "unbound" and does not call status.
 *
 * Status: `$.http.fetch` against the local daemon, keyed by cli and session.
 * Documented init has no timeout; a throw, a non-OK response, or a body that
 * is not an mbx.status/v1 or v2 snapshot renders "mbx: unavailable".
 * https://code.claude.com/docs/en/plugins/mods/api
 */

const DAEMON_ORIGIN = "http://127.0.0.1:7373";
const CACHE_MS = 2000;

/**
 * @param {Record<string, string | undefined>} env
 * @returns {string | null}
 */
export function resolveSessionId(env) {
  const code = env.CLAUDE_CODE_SESSION_ID;
  if (typeof code === "string" && code.trim()) return code.trim();
  const alias = env.CLAUDE_SESSION_ID;
  if (typeof alias === "string" && alias.trim()) return alias.trim();
  return null;
}

/**
 * Fixed daemon origin. The session id is only a query value.
 * @param {string} sessionId
 * @returns {string}
 */
export function statusRequestUrl(sessionId) {
  const url = new URL("/v1/status", DAEMON_ORIGIN);
  url.searchParams.set("cli", "claude");
  url.searchParams.set("session", sessionId);
  if (url.origin !== DAEMON_ORIGIN || url.pathname !== "/v1/status") {
    throw new Error("status url left the local daemon");
  }
  return url.toString();
}

/**
 * Render one snapshot. This function does not fetch or derive counts.
 * A missing session id is "unbound". Anything that is not a v1 or v2
 * snapshot is "mbx: unavailable".
 * @param {string | null} sessionId
 * @param {unknown} snapshot
 * @returns {string}
 */
export function renderStatus(sessionId, snapshot) {
  if (!sessionId) return "unbound";
  if (!snapshot || typeof snapshot !== "object") return "mbx: unavailable";
  const row = /** @type {Record<string, unknown>} */ (snapshot);
  if (row.schema !== "mbx.status/v1" && row.schema !== "mbx.status/v2") return "mbx: unavailable";
  const identity = row.identity && typeof row.identity === "object"
    ? /** @type {Record<string, unknown>} */ (row.identity)
    : null;
  const who = identity && identity.bound === true && typeof identity.name === "string"
    ? `${identity.name}${typeof identity.host === "string" ? "@" + identity.host : ""}${typeof identity.role === "string" ? " (" + identity.role + ")" : ""}`
    : "unbound";
  const lines = [
    `mbx ${who}`,
    `unread ${count(row.unread)}`,
    `needs_reply ${count(row.needs_reply)}`,
    `from_owner ${count(row.from_owner)}`,
    `outbox_unsent ${count(row.outbox_unsent)}`,
  ];
  if (typeof row.policy === "string" && row.policy) lines.push(`policy ${row.policy}`);
  return lines.join("\n");
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function count(value) {
  return typeof value === "number" && Number.isFinite(value) ? String(value) : "0";
}

/**
 * @param {{ ok?: boolean, text?: unknown }} response
 * @param {string} sessionId
 * @returns {{ text: string, snapshot: unknown, raw: string | null }}
 */
function fromResponse(response, sessionId) {
  if (!response || response.ok !== true || typeof response.text !== "string") {
    return { text: "mbx: unavailable", snapshot: null, raw: null };
  }
  try {
    const snapshot = JSON.parse(response.text);
    const text = renderStatus(sessionId, snapshot);
    if (text === "mbx: unavailable") return { text, snapshot: null, raw: null };
    return { text, snapshot, raw: response.text };
  } catch {
    return { text: "mbx: unavailable", snapshot: null, raw: null };
  }
}

/**
 * @param {{ sessionId: string | null, fetchImpl?: (url: string) => Promise<{ ok?: boolean, text?: unknown }> }} opts
 * @returns {Promise<{ text: string, snapshot: unknown, raw: string | null }>}
 */
export async function readStatus(opts) {
  const sessionId = opts.sessionId;
  if (!sessionId) return { text: "unbound", snapshot: null, raw: null };
  if (!opts.fetchImpl) return { text: "mbx: unavailable", snapshot: null, raw: null };
  try {
    const response = await opts.fetchImpl(statusRequestUrl(sessionId));
    return fromResponse(response, sessionId);
  } catch {
    return { text: "mbx: unavailable", snapshot: null, raw: null };
  }
}

/** @type {{ sessionId: string, at: number, raw: string } | null} */
let cache = null;

/**
 * @param {Record<string, string | undefined>} env
 * @param {{ fetchImpl?: (url: string) => Promise<{ ok?: boolean, text?: unknown }>, now?: number }} [deps]
 * @returns {Promise<string>}
 */
export async function statusText(env, deps = {}) {
  const sessionId = resolveSessionId(env);
  if (!sessionId) return "unbound";
  const now = deps.now ?? 0;
  if (cache && cache.sessionId === sessionId && now - cache.at < CACHE_MS) {
    try {
      return renderStatus(sessionId, JSON.parse(cache.raw));
    } catch {
      cache = null;
    }
  }
  const result = await readStatus({ sessionId, fetchImpl: deps.fetchImpl });
  if (result.raw) cache = { sessionId, at: now, raw: result.raw };
  return result.text;
}

/** Test-only reset so one case cannot reuse another's snapshot. */
export function resetStatusCache() {
  cache = null;
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function envString(value) {
  return typeof value === "string" ? value : "";
}

/**
 * Production read. `$` stays on this top-level function so `claude plugin validate`
 * sees `$.env.get`, `$.clock.now`, and `$.http.fetch`.
 * @param {{ env: { get: (name: string) => Promise<unknown> }, clock: { now: () => Promise<number> }, http: { fetch: (url: string) => Promise<{ ok?: boolean, text?: unknown }> } }} $
 * @returns {Promise<string>}
 */
export async function loadBand($) {
  const env = {
    CLAUDE_CODE_SESSION_ID: envString(await $.env.get("CLAUDE_CODE_SESSION_ID")),
    CLAUDE_SESSION_ID: envString(await $.env.get("CLAUDE_SESSION_ID")),
  };
  const now = await $.clock.now();
  return statusText(env, {
    now: typeof now === "number" ? now : 0,
    fetchImpl: (url) => $.http.fetch(url),
  });
}

/**
 * Claude Code mod entry. Draws the AbovePrompt band and answers /mbx-status.
 * @param {(event: string, matcherOrHook: unknown, hook?: unknown) => unknown} on
 */
export function register(on) {
  on("session.start", async ($, e, next) => {
    await $.command.register({
      name: "mbx-status",
      description: "Show this session's AgentMBX status",
    });
    return next(e);
  });

  on("command.run", { command: "mbx-status" }, async ($) => {
    try {
      return { text: await loadBand($) };
    } catch {
      return { text: "mbx: unavailable" };
    }
  });

  on("ui.render", { component: "AbovePrompt" }, async ($, e, next) => {
    try {
      if (e?.props?.hasSurvey) return next(e);
      const { Text } = $.ui.resolve(e);
      const text = await loadBand($);
      return Text({ children: [text] });
    } catch {
      return next(e);
    }
  });
}
