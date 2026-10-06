import { execFile as execFileCb } from "node:child_process";

/** How long a successful snapshot may be reused. A failure is never cached. */
const CACHE_MS = 2000;
/** Fail closed if the status command does not return. */
const TIMEOUT_MS = 2000;

/**
 * Claude Code 2.1.291 puts the current session id in `CLAUDE_CODE_SESSION_ID`
 * (`process.env.CLAUDE_CODE_SESSION_ID = K()` and child env
 * `CLAUDE_CODE_SESSION_ID: e.sessionId`). `${CLAUDE_SESSION_ID}` is the same
 * value in its templates. The mod event `session.start` is only `{ cwd }`,
 * so the id is not on that event.
 * @param {NodeJS.ProcessEnv} env
 * @returns {string | null}
 */
export function resolveSessionId(env = process.env) {
  for (const key of ["CLAUDE_CODE_SESSION_ID", "CLAUDE_SESSION_ID"]) {
    const value = env[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

/**
 * Render a status snapshot. This function does not derive counts.
 * A missing session id is "unbound". Anything else that is not a v1 or v2
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
 * @param {{ sessionId: string | null, execFileImpl?: typeof execFileCb, bin?: string, timeoutMs?: number }} opts
 * @returns {Promise<{ text: string, snapshot: unknown }>}
 */
export function readStatus(opts) {
  const sessionId = opts.sessionId;
  if (!sessionId) return Promise.resolve({ text: "unbound", snapshot: null });
  const execFileImpl = opts.execFileImpl ?? execFileCb;
  const bin = opts.bin ?? "agentmbx";
  const timeoutMs = opts.timeoutMs ?? TIMEOUT_MS;
  return new Promise((resolve) => {
    let settled = false;
    const finish = (text, snapshot = null) => {
      if (settled) return;
      settled = true;
      resolve({ text, snapshot });
    };
    try {
      const child = execFileImpl(
        bin,
        ["status", "--cli", "claude", "--session", sessionId, "--json", "--schema", "mbx.status/v1"],
        { timeout: timeoutMs },
        (err, stdout) => {
          if (err) return finish("mbx: unavailable");
          try {
            const snapshot = JSON.parse(String(stdout));
            finish(renderStatus(sessionId, snapshot), snapshot);
          } catch {
            finish("mbx: unavailable");
          }
        },
      );
      if (child && typeof child.on === "function") {
        child.on("error", () => finish("mbx: unavailable"));
      }
    } catch {
      finish("mbx: unavailable");
    }
  });
}

/** @type {{ sessionId: string, at: number, text: string } | null} */
let cache = null;

/**
 * @param {NodeJS.ProcessEnv} env
 * @param {{ execFileImpl?: typeof execFileCb, bin?: string, now?: number }} [deps]
 * @returns {Promise<string>}
 */
export async function statusText(env, deps = {}) {
  const sessionId = resolveSessionId(env);
  if (!sessionId) return "unbound";
  const now = deps.now ?? Date.now();
  if (cache && cache.sessionId === sessionId && now - cache.at < CACHE_MS) return cache.text;
  const result = await readStatus({ sessionId, execFileImpl: deps.execFileImpl, bin: deps.bin });
  if (result.text !== "mbx: unavailable") cache = { sessionId, at: now, text: result.text };
  return result.text;
}

/** Test-only reset so one case cannot reuse another's snapshot. */
export function resetStatusCache() {
  cache = null;
}

/**
 * Claude Code mod entry. Draws the AbovePrompt band and answers /mbx-status.
 * Both paths render the status command's JSON and nothing else.
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

  on("command.run", { command: "mbx-status" }, async () => {
    try {
      return { text: await statusText(process.env) };
    } catch {
      return { text: "mbx: unavailable" };
    }
  });

  on("ui.render", { component: "AbovePrompt" }, async ($, e, next) => {
    try {
      if (e?.props?.hasSurvey) return next(e);
      const { Text } = $.ui.resolve(e);
      const text = await statusText(process.env);
      return Text({ children: [text] });
    } catch {
      return next(e);
    }
  });
}
