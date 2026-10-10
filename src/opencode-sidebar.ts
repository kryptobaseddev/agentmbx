// The OpenCode 2 sidebar plugin source. OpenCode 2.0.x loads TUI plugins with a packaged-plugin
// shape: a directory whose package.json declares separate "opencode" entrypoints for the server
// runtime ({"server": ...}) and the TUI runtime ({"tui": ...}); a LOOSE file in plugins/ gets only
// the server context, which has no ui/storage.store (proven empirically on 2.0.24, see
// docs/research/t409-opencode-sidebar-spike.md). The sidebar renders one mbx.status/v2 snapshot in
// the sidebar.content slot. It is READ-ONLY: it fetches the daemon's loopback status endpoint and
// renders what arrives — zero schema re-derivation, zero mailbox logic (that is the T404 contract:
// one producer, N renderers). `agentmbx setup --only opencode` (T411) installs the generated
// package under ~/.config/opencode/plugins/agentmbx-sidebar/ and registers it in tui.json;
// full-sidebar polish is T410.
import { version } from "./version.ts";

/** Line 1 of every file we manage in the sidebar package. The ` (agentmbx <ver>)` suffix on the
 *  entrypoint sources and package.json's "version" are the MANAGED VERSION HEADER (T486): a file
 *  that differs from the current template only there is still ours and still wired. */
export const OPENCODE_SIDEBAR_MARKER = "// agentmbx-sidebar v1 — managed by `agentmbx setup --only opencode`";

/** package.json for the packaged-plugin layout (the only shape that reaches the TUI runtime). */
export function opencodeSidebarPackageJson(): string {
  return `${JSON.stringify({
    name: "agentmbx-sidebar",
    version: version(),
    opencode: { server: "./server.ts", tui: "./tui.ts" },
  }, null, 2)}\n`;
}

/** The server entrypoint: nothing to do server-side. Kept explicit so the host's server runtime
 *  loads the package cleanly instead of guessing an entrypoint. */
export function opencodeSidebarServerSource(): string {
  return `${OPENCODE_SIDEBAR_MARKER} — server entrypoint (no-op; the TUI entrypoint renders)
export default { id: "agentmbx-sidebar", setup: () => {} };
`;
}

/** The self-contained TUI plugin module OpenCode loads. Plain TypeScript with no static imports of
 *  host-provided packages: the TUI runtime resolves @opentui/solid for packaged plugins, but the
 *  factory is still loaded dynamically with a graceful null fallback (renders nothing rather than
 *  failing the host) so the module also evaluates under plain Node for tests. */
export function opencodeSidebarSource(ver: string): string {
  return `${OPENCODE_SIDEBAR_MARKER} (agentmbx ${ver})\n` + String.raw`
// Renders mbx.status/v2 in the OpenCode sidebar. Read-only: fetches the daemon loopback status
// endpoint and renders; it never derives status itself. Local edits make this file foreign:
// setup stops managing it and doctor reports it. Uninstall with: agentmbx setup --uninstall --only opencode

/** Pure render: one v2 snapshot -> one display line. Free of any UI import so tests exercise
 *  exactly what the TUI shows. Field-for-field with src/status-schema.ts; unknown shapes degrade
 *  to a bare marker instead of throwing inside the host. */
type Snapshot = {
  schema?: string;
  identity?: { state?: string; name?: string | null; role?: string | null };
  registration?: { registered?: boolean; lease?: { verified?: boolean; holder_cli?: string; holder_session?: string } | null };
  inbox?: { unread?: number; needs_reply?: number; from_owner?: number; outbox_unsent?: number; recent?: { id: string; sender: string; subject: string; kind: string; ts: string; needs_reply: boolean }[] };
  harness?: { cli?: string; session_id?: string | null; wake_path?: string; policy?: string[] };
  cloud?: { relay?: { url?: string | null; state?: string; last_ack?: string | null }; key_ad_expiry?: string | null; account?: string | null };
  devices?: { host: string; address: string; reachability: string; last_presence: string | null }[];
  project?: { directory: string; lead: string | null; members: string[] } | null;
};
const snapshot = (value: unknown): Snapshot | null => value && typeof value === "object" && (value as Snapshot).schema === "mbx.status/v2" ? value as Snapshot : null;
const clean = (value: unknown, max = 80): string => String(value ?? "unknown").replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").slice(0, max);
const bound = (s: Snapshot | null): boolean => s?.identity?.state === "bound" && !!s.identity.name;
export const formatStatusV2 = (value: unknown): string => {
  const s = snapshot(value);
  if (!s) return "mbx disconnected — check agentmbx doctor";
  const id = s.identity ?? {};
  if (!bound(s)) return id.state === "ambiguous" ? "mbx ambiguous — check mbx_whoami" : "mbx unbound — claim or register a persona";
  const tag = clean(id.name) + (id.role ? "(" + clean(id.role) + ")" : "");
  const inbox = s.inbox ?? {};
  const seg = ["mbx " + tag];
  if (inbox.unread) seg.push(inbox.unread + "↑");
  if (inbox.needs_reply) seg.push(inbox.needs_reply + "↺");
  if (inbox.from_owner) seg.push("owner:" + inbox.from_owner);
  if (s.registration?.lease && s.registration.lease.verified === false) seg.push("lease-unverified");
  return seg.join(" ");
};

export const statusSections = (value: unknown, project = "project-dev", now = Date.now()): { title: string; lines: string[] }[] => {
  const s = snapshot(value);
  if (!s) return [{ title: "Disconnected", lines: ["Status daemon unavailable.", "Check agentmbx doctor; no cached mailbox data shown."] }];
  if (!bound(s)) return [{ title: s.identity?.state === "ambiguous" ? "Ambiguous binding" : "No persona", lines: s.identity?.state === "ambiguous"
    ? ["Check mbx_whoami and ask the owner to resolve the binding.", "Mailbox data is hidden."]
    : ["Ask this agent: mbx_identity list, then claim your persona", "or register " + clean(project) + ". No identity is chosen automatically."] }];
  const lease = s.registration?.lease;
  const age = (ts: string) => { const ms = now - Date.parse(ts); return Number.isFinite(ms) ? (ms < 60000 ? "now" : Math.floor(ms / 60000) + "m ago") : "age unknown"; };
  return [
    { title: "Identity & session", lines: [clean(s.identity?.name) + " · " + clean(s.identity?.role), "Registered: " + (s.registration?.registered ? "yes" : "no"), "Lease: " + (lease ? lease.verified ? "verified" : "unverified" : "not held"), "Holder: " + clean(lease?.holder_cli) + " / " + clean(lease?.holder_session), "Wake: " + clean(s.harness?.wake_path), "Policy: " + clean(s.harness?.policy?.join(", ") || "none")] },
    { title: "Inbox", lines: [String(s.inbox?.unread ?? 0) + " unread · " + String(s.inbox?.needs_reply ?? 0) + " needs reply", String(s.inbox?.from_owner ?? 0) + " from owner · " + String(s.inbox?.outbox_unsent ?? 0) + " pending sends", ...(s.inbox?.recent === undefined ? ["Message preview unavailable on this daemon."] : s.inbox.recent.length ? s.inbox.recent.slice(0, 3).flatMap(m => [clean(m.sender) + " · " + clean(m.kind) + " · " + age(m.ts) + (m.needs_reply ? " · reply needed" : ""), clean(m.subject, 160)]) : ["No pending messages."])] },
    { title: "Cloud & devices", lines: ["Relay: " + clean(s.cloud?.relay?.state), clean(s.cloud?.relay?.url ?? "No relay configured"), "Last acknowledgement: " + clean(s.cloud?.relay?.last_ack), "Key ad expires: " + clean(s.cloud?.key_ad_expiry), "Account: " + clean(s.cloud?.account), ...(s.devices?.length ? s.devices.map(d => clean(d.host) + " · " + clean(d.reachability) + " · " + clean(d.address) + " · presence " + clean(d.last_presence)) : ["No paired devices."])] },
    { title: "Project", lines: s.project ? [clean(s.project.directory, 160), "Lead: " + clean(s.project.lead ?? "none"), "Members: " + clean(s.project.members.join(", ") || "none", 400)] : ["No project binding."] },
  ];
};

/** The one read path: the T407 loopback endpoint answering mbx.status/v2 (src/http.ts). */
export const statusUrl = (port: string, cli: string, sessionID: string): string =>
  "http://127.0.0.1:" + port + "/v1/status?cli=" + encodeURIComponent(cli) + "&session=" + encodeURIComponent(sessionID) + "&schema=" + encodeURIComponent("mbx.status/v2") + "&include=inbox";

/** Fetch seam: tests replace globalThis.__mbxFetch (read per call); production runs globalThis.fetch. */
const fetchJson = async (url: string): Promise<unknown> => {
  const f = ((globalThis as { __mbxFetch?: typeof fetch }).__mbxFetch ?? globalThis.fetch) as typeof fetch;
  try {
    const res = await f(url, { signal: AbortSignal.timeout(3_000) });
    return res && res.ok ? await res.json() : null;
  } catch { return null; }
};

type State = { snapshot: unknown; fetchedAt: number; sessionID: string | null; expanded: boolean; loading: boolean };
type Host = {
  location?: { directory?: string };
  ui?: {
    slot?: (claim: { append: string; render: (input: { sessionID: string; name?: string }) => unknown }) => (() => void) | void;
    panel?: { open: (name: string) => unknown; close?: () => unknown };
    router?: { current: () => { type: string; sessionID?: string } };
    toast?: { show: (input: { title: string; message: string; variant: string; duration: number }) => unknown };
    dialog?: { alert: (input: { title: string; message: string }) => unknown };
  };
  keymap?: { layer: (factory: () => { mode: string; commands: { id: string; title: string; palette: boolean; bind?: string; slash?: { name: string }; run: () => unknown }[] }) => unknown };
  storage?: { memory: (key: string, options: { initial: State }) => [State, (mutate: (state: State) => void) => void] };
};
export default {
  id: "agentmbx-sidebar",
  async setup(ctx: Host) {
    // Defensive: this module is the TUI entrypoint (the packaged layout's "opencode.tui"), whose
    // context carries ui + storage.store/memory. If it is ever loaded by a context without the
    // slot tree, set up nothing rather than fail the host.
    if (!ctx?.ui || typeof ctx.ui.slot !== "function" || !ctx.storage?.memory) return;
    const port = process.env.MBX_PORT ?? "7373";
    const cli = process.env.MBX_STATUS_CLI ?? "opencode";
    // Refresh policy (spike cost model): at most one loopback GET per REFRESH_MS while a session
    // is bound and the claim is live; each answer costs the daemon one v2 snapshot computation —
    // the same queries a statusline file read serves (src/hud.ts). Nothing polls while the
    // sidebar is away: the interval only compares timestamps.
    const REFRESH_MS = 5_000;
    const [state, setState] = ctx.storage.memory("agentmbx-status", {
      initial: { snapshot: null, fetchedAt: 0, sessionID: null, expanded: false, loading: false },
    });
    // Reloads keep the disclosure preference, never an old mailbox snapshot.
    setState(d => { d.snapshot = null; d.fetchedAt = 0; d.sessionID = null; d.loading = false; d.expanded = d.expanded === true; });
    // The Solid JSX factory, loaded without a static import so this module also evaluates under
    // plain Node (tests) and on hosts that cannot resolve the TUI runtime (render nothing).
    let jsx: ((type: string, props: Record<string, unknown>) => unknown);
    const jsxSeam = (globalThis as { __mbxJsx?: unknown }).__mbxJsx;
    if (typeof jsxSeam === "function") jsx = jsxSeam as typeof jsx;
    else try { const m = await import("@opentui/solid/jsx-runtime"); jsx = m.jsx as typeof jsx; } catch { return; }
    const directory = ctx.location?.directory ?? "project";
    const suggestion = (directory.split(/[\\/]/).filter(Boolean).pop() ?? "project").toLowerCase().replace(/[^a-z0-9-]/g, "-") + "-dev";
    const fullText = () => statusSections(state.snapshot, suggestion).map(g => g.title + "\n" + g.lines.join("\n")).join("\n\n");
    const open = () => ctx.ui?.panel ? ctx.ui.panel.open("agentmbx.status") : ctx.ui?.dialog?.alert({ title: "AgentMBX · this session", message: fullText() });
    const disposers: (() => void)[] = [];
    let sequence = 0, inFlight = false, stopped = false, newest: string | null = null;
    const refresh = async (sessionID: string) => {
      if (inFlight || stopped) return;
      const ticket = ++sequence; inFlight = true;
      const snap = await fetchJson(statusUrl(port, cli, sessionID));
      inFlight = false;
      if (stopped || ticket !== sequence || sessionID !== state.sessionID) return;
      const data = snapshot(snap);
      const valid = data?.harness?.session_id === sessionID && data.harness.cli === cli ? data : null;
      if (snapshot(state.snapshot)?.identity?.name !== valid?.identity?.name) newest = null;
      const latest = bound(valid) ? (valid?.inbox?.recent ?? []).map(m => m.ts + "|" + m.id).sort().pop() ?? "" : null;
      if (bound(valid) && newest !== null && latest !== null && latest > newest) ctx.ui?.toast?.show({ title: "AgentMBX · new mail", message: clean(valid?.inbox?.recent?.[0]?.subject ?? "New message"), variant: "info", duration: 5000 });
      newest = latest;
      setState(d => { d.snapshot = valid; d.fetchedAt = Date.now(); d.loading = false; });
    };
    const activate = (sessionID: string) => {
      if (state.sessionID === sessionID) return;
      sequence++; newest = null;
      setState(d => { d.sessionID = sessionID; d.snapshot = null; d.fetchedAt = 0; d.loading = true; });
      if (!inFlight) void refresh(sessionID);
    };
    let lastFetch = 0;
    const timer = setInterval(() => {
      const now = Date.now();
      const route = ctx.ui?.router?.current();
      if (route && route.type !== "session") return;
      if (route?.sessionID) activate(route.sessionID);
      if (state.sessionID && now - state.fetchedAt >= REFRESH_MS && now - lastFetch >= REFRESH_MS) {
        lastFetch = now;
        void refresh(state.sessionID);
      }
    }, 1_000);
    ctx.keymap?.layer(() => ({ mode: "global", commands: [
      { id: "agentmbx.status", title: "AgentMBX: open status dashboard", palette: true, slash: { name: "mbx" }, run: async () => { const sid = ctx.ui?.router?.current().sessionID; if (!sid) return ctx.ui?.toast?.show({ title: "AgentMBX", message: "Open a session to view its status.", variant: "info", duration: 5000 }); activate(sid); await refresh(sid); return open(); } },
      { id: "agentmbx.toggle", title: "AgentMBX: expand or collapse sidebar", palette: true, run: () => setState(d => { d.expanded = !d.expanded; }) },
    ] }));
    const sidebar = ctx.ui.slot({
      append: "sidebar.content",
      render: (input: { sessionID: string }) => {
        activate(input.sessionID);
        return jsx("box", { flexDirection: "column", children: [
          jsx("text", { get children() { return (state.expanded ? "▾ " : "▸ ") + "AgentMBX"; }, onMouseDown: () => setState(d => { d.expanded = !d.expanded; }) }),
          jsx("text", { get children() { return state.loading ? "Loading this session…" : formatStatusV2(state.snapshot); }, onMouseDown: open }),
          jsx("text", { get children() { const s = snapshot(state.snapshot); return bound(s) ? "Relay: " + clean(s?.cloud?.relay?.state, 18) + " · /mbx" : ""; }, onMouseDown: open }),
          jsx("text", { get children() { return !state.loading && snapshot(state.snapshot)?.identity?.state === "unbound" ? "Ask agent: mbx_identity list; claim your persona or register " + suggestion : ""; } }),
          jsx("box", { flexDirection: "column", get children() { return state.expanded ? statusSections(state.snapshot, suggestion).map(g => jsx("box", { flexDirection: "column", children: [jsx("text", { children: g.title + " · " + clean(g.lines[0], 60) + " ›", onMouseDown: open }), ...(g.title === "Inbox" ? (snapshot(state.snapshot)?.inbox?.recent ?? []).slice(0, 3).map(m => jsx("text", { children: "  " + clean(m.subject, 48), onMouseDown: open })) : [])] })) : []; } }),
        ] });
      },
    });
    if (typeof sidebar === "function") disposers.push(sidebar);
    if (ctx.ui.panel) {
      const panel = ctx.ui.slot({ append: "session.panel", render: input => {
        if (input.name !== "agentmbx.status") return null;
        activate(input.sessionID);
        const close = () => ctx.ui?.panel?.close?.();
        ctx.keymap?.layer(() => ({ mode: "global", commands: [{ id: "agentmbx.status.close", title: "Close AgentMBX dashboard", palette: false, bind: "escape", run: close }] }));
        return jsx("box", { flexDirection: "column", flexGrow: 1, children: [
          jsx("text", { children: "AgentMBX · close dashboard [Esc]", onMouseDown: close }),
          jsx("scrollbox", { flexGrow: 1, children: jsx("text", { get children() { return state.loading ? "Loading this session…" : fullText(); } }) }),
        ] });
      } });
      if (typeof panel === "function") disposers.push(panel);
    }
    return () => { stopped = true; sequence++; clearInterval(timer); for (const stop of disposers) stop(); };
  },
};
`;
}
