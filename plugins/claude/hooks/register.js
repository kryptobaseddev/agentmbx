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
 * Status: `$.http.fetch` against the local daemon, keyed by cli and session, asking for
 * `mbx.status/v2` — the same snapshot the OpenCode sidebar reads. A daemon older than v0.5.17
 * answers v1; `renderStatus` still tolerates a v1 body, so the band degrades rather than breaks.
 * Documented init has no timeout; a throw, a non-OK response, or a body that is not an
 * mbx.status/v1 or v2 snapshot renders "mbx: unavailable".
 *
 * Surfaces (T415): the AbovePrompt band shows one compact line with a `●` unread marker;
 * `/mbx-status` opens a pane (on wide terminals) and always prints the full v2 sections, which
 * is also the fallback where mods cannot draw (headless `claude -p`, a narrow terminal, or a
 * render the engine refuses). A 5 s `$.clock.every` timer keeps `$.ui.status` under the prompt
 * current — the persistent unread indicator — and asks for a redraw.
 * https://code.claude.com/docs/en/plugins/mods/api
 */

const DAEMON_ORIGIN = "http://127.0.0.1:7373";
const CACHE_MS = 2000;
const PANE_ID = "mbx-status";
const INDICATOR_MS = 5_000;

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
 * Fixed daemon origin. The session id is only a query value. v2 is requested: the band reads the
 * same mbx.status/v2 snapshot as the OpenCode sidebar (T414 AC1); renderStatus still tolerates a
 * v1 body from a daemon older than v0.5.17.
 * @param {string} sessionId
 * @returns {string}
 */
export function statusRequestUrl(sessionId) {
  const url = new URL("/v1/status", DAEMON_ORIGIN);
  url.searchParams.set("cli", "claude");
  url.searchParams.set("session", sessionId);
  url.searchParams.set("schema", "mbx.status/v2");
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
  if (!identity || identity.state === "unbound" || (identity.state !== "bound" && identity.state !== "ambiguous")) return "unbound";
  if (identity.state === "ambiguous") return "ambiguous";
  if (typeof identity.name !== "string" || !identity.name.trim()) return "unbound";
  const role = typeof identity.role === "string" && identity.role ? ` (${identity.role})` : "";
  const source = row.inbox && typeof row.inbox === "object"
    ? /** @type {Record<string, unknown>} */ (row.inbox)
    : row;
  const lines = [
    `mbx ${identity.name.trim()}${role}`,
    `unread ${count(source.unread)}`,
    `needs_reply ${count(source.needs_reply)}`,
    `from_owner ${count(source.from_owner)}`,
    `outbox_unsent ${count(source.outbox_unsent)}`,
  ];
  const policy = policyText(row);
  if (policy) lines.push(`policy ${policy}`);
  return lines.join("\n");
}

/**
 * v1 carries policy at the top. v2 carries it on harness. Never pick a name from either.
 * @param {Record<string, unknown>} row
 * @returns {string}
 */
function policyText(row) {
  const direct = joinPolicy(row.policy);
  if (direct) return direct;
  const harness = row.harness && typeof row.harness === "object"
    ? /** @type {Record<string, unknown>} */ (row.harness)
    : null;
  return harness ? joinPolicy(harness.policy) : "";
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function joinPolicy(value) {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (!Array.isArray(value)) return "";
  return value.filter((item) => typeof item === "string" && item.trim()).join(", ");
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function count(value) {
  return typeof value === "number" && Number.isFinite(value) ? String(value) : "0";
}

/**
 * The one-line under-prompt indicator (`$.ui.status`). Null when there is
 * nothing worth pinning: unbound, unavailable, or zero unread everywhere.
 * Pure: renders one fetched snapshot, derives nothing.
 * @param {unknown} snapshot
 * @returns {string | null}
 */
export function statusLineText(snapshot) {
  const sections = renderSections(snapshot);
  if (!sections) return null;
  const row = /** @type {Record<string, unknown>} */ (snapshot);
  const inbox = row.inbox && typeof row.inbox === "object"
    ? /** @type {Record<string, unknown>} */ (row.inbox)
    : row;
  const unread = typeof inbox.unread === "number" ? inbox.unread : 0;
  const needsReply = typeof inbox.needs_reply === "number" ? inbox.needs_reply : 0;
  const fromOwner = typeof inbox.from_owner === "number" ? inbox.from_owner : 0;
  if (!unread && !needsReply && !fromOwner) return null;
  const seg = [`${unread}↑`];
  if (needsReply) seg.push(`${needsReply}↺`);
  if (fromOwner) seg.push(`owner:${fromOwner}`);
  return `mbx: ${seg.join(" ")}`;
}

/**
 * The compact band line, with the unread marker T415 AC2 asks for: a `●`
 * prefix while the fetched snapshot has unread mail. Pure.
 * @param {string | null} sessionId
 * @param {unknown} snapshot
 * @returns {string}
 */
export function bandText(sessionId, snapshot) {
  const text = renderStatus(sessionId, snapshot);
  if (text.startsWith("mbx ") && statusLineText(snapshot)) return `● ${text}`;
  return text;
}

/**
 * One line per v2 section: identity, registration + lease, inbox, harness,
 * cloud, devices, project (T415 AC1). The renderer is pure and derives
 * nothing — every value is read from the one fetched snapshot. Returns null
 * for a v1 body (the pane is a v2 surface; v1 falls back to the compact
 * render) and for anything that is not a status snapshot.
 * @param {unknown} snapshot
 * @returns {string[] | null}
 */
export function renderSections(snapshot) {
  if (!snapshot || typeof snapshot !== "object") return null;
  const row = /** @type {Record<string, unknown>} */ (snapshot);
  if (row.schema !== "mbx.status/v2") return null;
  const identity = row.identity && typeof row.identity === "object"
    ? /** @type {Record<string, unknown>} */ (row.identity)
    : null;
  const state = identity?.state;
  if (!identity || state === "unbound") return ["mbx unbound"];
  if (state === "ambiguous") {
    const candidates = Array.isArray(identity.candidates) ? identity.candidates.length : 0;
    return [`mbx ambiguous (${candidates} candidates)`];
  }
  if (state !== "bound" || typeof identity.name !== "string" || !identity.name.trim()) return ["mbx unbound"];
  const role = typeof identity.role === "string" && identity.role ? `(${identity.role})` : "";
  const lines = [`identity ${identity.name.trim()}${role}`];

  const registration = row.registration && typeof row.registration === "object"
    ? /** @type {Record<string, unknown>} */ (row.registration)
    : null;
  const lease = registration?.lease && typeof registration.lease === "object"
    ? /** @type {Record<string, unknown>} */ (registration.lease)
    : null;
  lines.push(lease
    ? `registration ${registration?.registered === true ? "registered" : "unregistered"} · lease ${String(lease.holder_cli)}/${String(lease.holder_session)}${lease.verified === true ? " verified" : " unverified"}`
    : `registration ${registration?.registered === true ? "registered" : "not registered"} · no lease`);

  const inbox = row.inbox && typeof row.inbox === "object"
    ? /** @type {Record<string, unknown>} */ (row.inbox)
    : {};
  lines.push(`inbox ${count(inbox.unread)} unread · ${count(inbox.needs_reply)} needs reply · ${count(inbox.from_owner)} from owner · ${count(inbox.outbox_unsent)} unsent`);

  const harness = row.harness && typeof row.harness === "object"
    ? /** @type {Record<string, unknown>} */ (row.harness)
    : null;
  if (harness) {
    const policy = joinPolicy(harness.policy);
    const wake = typeof harness.wake_path === "string" ? harness.wake_path : "none";
    lines.push(`harness ${String(harness.cli)} ${String(harness.session_id ?? "—")} · wake ${wake}${policy ? ` · policy ${policy}` : ""}`);
  }

  const cloud = row.cloud && typeof row.cloud === "object"
    ? /** @type {Record<string, unknown>} */ (row.cloud)
    : null;
  if (cloud) {
    const relay = cloud.relay && typeof cloud.relay === "object"
      ? /** @type {Record<string, unknown>} */ (cloud.relay)
      : null;
    const relayText = relay?.url
      ? `relay ${String(relay.state)} (${String(relay.url)})`
      : `relay ${String(relay?.state ?? "unset")}`;
    const keyAd = typeof cloud.key_ad_expiry === "string" ? ` · key ad until ${cloud.key_ad_expiry.slice(0, 10)}` : "";
    const account = typeof cloud.account === "string" ? ` · account ${cloud.account}` : "";
    lines.push(`cloud ${relayText}${keyAd}${account}`);
  }

  if (Array.isArray(row.devices)) {
    if (row.devices.length === 0) lines.push("devices none paired");
    for (const device of row.devices.slice(0, 8)) {
      if (device && typeof device === "object") {
        const d = /** @type {Record<string, unknown>} */ (device);
        const last = typeof d.last_presence === "string" ? ` · seen ${d.last_presence.slice(0, 16).replace("T", " ")}` : "";
        lines.push(`device ${String(d.host)} at ${String(d.address)} (${String(d.reachability)})${last}`);
      }
    }
  }

  const project = row.project && typeof row.project === "object"
    ? /** @type {Record<string, unknown>} */ (row.project)
    : null;
  if (project) {
    const members = Array.isArray(project.members) ? project.members.filter((m) => typeof m === "string").join(", ") : "";
    lines.push(`project ${String(project.directory)} · lead ${String(project.lead ?? "—")} · members ${members}`);
  } else {
    lines.push("project none");
  }
  return lines;
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
    lastSnapshot = snapshot;
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

/** The last snapshot the band or command fetched, for the pane to render. */
let lastSnapshot = null;

/**
 * Production read. `$` stays on this top-level function so `claude plugin validate`
 * sees `$.env.get`, `$.clock.now`, and `$.http.fetch`.
 * @param {{ env: { get: (name: string) => Promise<unknown> }, clock: { now: () => Promise<number> }, http: { fetch: (url: string) => Promise<{ ok?: boolean, text?: unknown }> } }} $
 * @returns {Promise<{ band: string, sections: string[], snapshot: unknown }>}
 */
export async function loadStatus($) {
  const env = {
    CLAUDE_CODE_SESSION_ID: envString(await $.env.get("CLAUDE_CODE_SESSION_ID")),
    CLAUDE_SESSION_ID: envString(await $.env.get("CLAUDE_SESSION_ID")),
  };
  const sessionId = resolveSessionId(env);
  const now = await $.clock.now();
  const band = await statusText(env, {
    now: typeof now === "number" ? now : 0,
    fetchImpl: (url) => $.http.fetch(url),
  });
  // statusText answered from the same read path; re-read the snapshot it parsed for the pane.
  const snapshot = lastSnapshot;
  const sections = renderSections(snapshot) ?? [band];
  return { band, sections, snapshot };
}

/** Test-only reset so one case cannot reuse another's snapshot. */
export function resetStatusState() {
  resetStatusCache();
  lastSnapshot = null;
}

/**
 * Claude Code mod entry. Draws the AbovePrompt band, answers /mbx-status, and
 * renders the full v2 sections in a pane the command opens.
 * @param {(event: string, matcherOrHook: unknown, hook?: unknown) => unknown} on
 */
export function register(on) {
  on("session.start", async ($, e, next) => {
    await $.command.register({
      name: "mbx-status",
      description: "Show this session's AgentMBX status",
    });
    // The persistent unread indicator (T415 AC2): poll the same endpoint the band uses and
    // keep one line under the prompt current; the invalidate keeps band and pane fresh. The
    // callback closes over `$` (documented for timers); a failed poll leaves the old line.
    $.clock.every(INDICATOR_MS, async () => {
      try {
        const { snapshot } = await loadStatus($);
        lastSnapshot = snapshot;
        const line = statusLineText(snapshot);
        if (line) $.ui.status(line);
        $.ui.invalidate("ui.render");
      } catch { /* next tick */ }
    });
    return next(e);
  });

  on("command.run", { command: "mbx-status" }, async ($) => {
    try {
      const { sections } = await loadStatus($);
      // The pane is the visual surface; the printed sections are the same content, so a session
      // where mods cannot draw (headless, narrow terminal) still gets the full answer (AC3).
      try {
        const placed = await $.ui.open({ id: PANE_ID, title: "MBX", closeOnEscape: true });
        if (placed && placed.isPlaced === false) {
          $.ui.toast(`mbx: pane waiting for a wider terminal (${placed.reason ?? "narrow"}); the sections print below`);
        }
      } catch { /* pane unavailable: the printed sections below are the fallback */ }
      return { text: sections.join("\n") };
    } catch {
      return { text: "mbx: unavailable" };
    }
  });

  on("ui.render", { component: "AbovePrompt" }, async ($, e, next) => {
    try {
      if (e?.props?.hasSurvey) return next(e);
      const { Text } = $.ui.resolve(e);
      const env = {
        CLAUDE_CODE_SESSION_ID: envString(await $.env.get("CLAUDE_CODE_SESSION_ID")),
        CLAUDE_SESSION_ID: envString(await $.env.get("CLAUDE_SESSION_ID")),
      };
      const now = await $.clock.now();
      await statusText(env, {
        now: typeof now === "number" ? now : 0,
        fetchImpl: (url) => $.http.fetch(url),
      });
      return Text({ children: [bandText(resolveSessionId(env), lastSnapshot)] });
    } catch {
      return next(e);
    }
  });

  on("ui.render", { component: "Pane" }, async ($, e, next) => {
    try {
      if (e.requestId !== PANE_ID) return next(e);
      const { Box, Text } = $.ui.resolve(e);
      const sections = renderSections(lastSnapshot) ?? ["mbx: unavailable"];
      return Box({
        flexDirection: "column",
        children: sections.map((line, i) => Text({ key: `s${i}`, children: [line] })),
      });
    } catch {
      return next(e);
    }
  });
}
