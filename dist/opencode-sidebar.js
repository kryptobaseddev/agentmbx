// T409 spike: the OpenCode 2 sidebar plugin source. OpenCode 2.0.x loads TUI plugins with a
// packaged-plugin shape: a directory whose package.json declares separate "opencode" entrypoints
// for the server runtime ({"server": ...}) and the TUI runtime ({"tui": ...}); a LOOSE file in
// plugins/ gets only the server context, which has no ui/storage.store (proven empirically on
// 2.0.24, see docs/research/t409-opencode-sidebar-spike.md). The sidebar renders one mbx.status/v2
// snapshot in the sidebar.content slot. It is READ-ONLY: it fetches the daemon's loopback status
// endpoint and renders what arrives — zero schema re-derivation, zero mailbox logic (that is the
// T404 contract: one producer, N renderers). This spike ships the source generators and their
// tests; `agentmbx setup` wiring is deliberately out of scope (src/setup.ts is Codex's), as is
// full-sidebar polish (T410).
import { version } from "./version.js";
export const OPENCODE_SIDEBAR_MARKER = "// agentmbx-sidebar v1 (T409 spike)";
/** package.json for the packaged-plugin layout (the only shape that reaches the TUI runtime). */
export function opencodeSidebarPackageJson() {
    return `${JSON.stringify({
        name: "agentmbx-sidebar",
        version: version(),
        opencode: { server: "./server.ts", tui: "./tui.ts" },
    }, null, 2)}\n`;
}
/** The server entrypoint: nothing to do server-side. Kept explicit so the host's server runtime
 *  loads the package cleanly instead of guessing an entrypoint. */
export function opencodeSidebarServerSource() {
    return `${OPENCODE_SIDEBAR_MARKER} — server entrypoint (no-op; the TUI entrypoint renders)
export default { id: "agentmbx-sidebar", setup: () => {} };
`;
}
/** The self-contained TUI plugin module OpenCode loads. Plain TypeScript with no static imports of
 *  host-provided packages: the TUI runtime resolves @opentui/solid for packaged plugins, but the
 *  factory is still loaded dynamically with a graceful null fallback (renders nothing rather than
 *  failing the host) so the module also evaluates under plain Node for tests. */
export function opencodeSidebarSource(ver) {
    return `${OPENCODE_SIDEBAR_MARKER} (agentmbx ${ver})
// Renders mbx.status/v2 in the OpenCode sidebar. Read-only: fetches the daemon loopback status
// endpoint and renders; it never derives status itself. Uninstall: delete this file.

/** Pure render: one v2 snapshot -> one display line. Free of any UI import so tests exercise
 *  exactly what the TUI shows. Field-for-field with src/status-schema.ts; unknown shapes degrade
 *  to a bare marker instead of throwing inside the host. */
export const formatStatusV2 = (snap: unknown): string => {
  if (!snap || typeof snap !== "object") return "mbx ?";
  const s = snap as {
    identity?: { state?: string; name?: string | null; role?: string | null; candidates?: string[] };
    inbox?: { unread?: number; needs_reply?: number; from_owner?: number };
    registration?: { lease?: { verified?: boolean } | null };
  };
  const id = s.identity ?? {};
  const tag = id.state === "bound" ? (id.name ?? "?") + (id.role ? \`(\${id.role})\` : "")
    : id.state === "ambiguous" ? \`ambiguous (\${(id.candidates ?? []).length} candidates)\`
    : "unbound";
  const inbox = s.inbox ?? {};
  const seg = [\`mbx \${tag}\`];
  if (inbox.unread) seg.push(\`\${inbox.unread}↑\`);
  if (inbox.needs_reply) seg.push(\`\${inbox.needs_reply}↺\`);
  if (inbox.from_owner) seg.push(\`owner:\${inbox.from_owner}\`);
  if (s.registration?.lease && s.registration.lease.verified === false) seg.push("lease-unverified");
  return seg.join(" ");
};

/** The one read path: the T407 loopback endpoint answering mbx.status/v2 (src/http.ts). */
export const statusUrl = (port: string, cli: string, sessionID: string): string =>
  \`http://127.0.0.1:\${port}/v1/status?cli=\${encodeURIComponent(cli)}&session=\${encodeURIComponent(sessionID)}&schema=\${encodeURIComponent("mbx.status/v2")}\`;

/** Fetch seam: tests replace globalThis.__mbxFetch (read per call); production runs globalThis.fetch. */
const fetchJson = async (url: string): Promise<unknown> => {
  const f = ((globalThis as { __mbxFetch?: typeof fetch }).__mbxFetch ?? globalThis.fetch) as typeof fetch;
  try {
    const res = await f(url, { signal: AbortSignal.timeout(3_000) });
    return res && res.ok ? await res.json() : null;
  } catch { return null; }
};

export default {
  id: "agentmbx-sidebar",
  setup(ctx: any) {
    // Defensive: this module is the TUI entrypoint (the packaged layout's "opencode.tui"), whose
    // context carries ui + storage.store/memory. If it is ever loaded by a context without the
    // slot tree, set up nothing rather than fail the host.
    if (!ctx?.ui || typeof ctx.ui.slot !== "function") return;
    const port = process.env.MBX_PORT ?? "7373";
    const cli = process.env.MBX_STATUS_CLI ?? "opencode";
    // Refresh policy (spike cost model): at most one loopback GET per REFRESH_MS while a session
    // is bound and the claim is live; each answer costs the daemon one v2 snapshot computation —
    // the same queries a statusline file read serves (src/hud.ts). Nothing polls while the
    // sidebar is away: the interval only compares timestamps.
    const REFRESH_MS = 5_000;
    const [state, setState] = ctx.storage.memory("agentmbx-status", {
      initial: { snapshot: null as unknown, fetchedAt: 0, sessionID: null as string | null },
    });
    // The Solid JSX factory, loaded without a static import so this module also evaluates under
    // plain Node (tests) and on hosts that cannot resolve the TUI runtime (render nothing).
    let jsx: ((type: string, props: Record<string, unknown>) => unknown) | null = null;
    const jsxSeam = (globalThis as { __mbxJsx?: unknown }).__mbxJsx;
    if (typeof jsxSeam === "function") jsx = jsxSeam as typeof jsx;
    else void import("@opentui/solid/jsx-runtime").then((m) => { jsx = m.jsx as typeof jsx; }).catch(() => {});
    const refresh = async (sessionID: string) => {
      const snap = await fetchJson(statusUrl(port, cli, sessionID));
      setState((d: { snapshot: unknown; fetchedAt: number }) => { d.snapshot = snap; d.fetchedAt = Date.now(); });
    };
    let lastFetch = 0;
    const timer = setInterval(() => {
      const now = Date.now();
      if (state.sessionID && now - state.fetchedAt >= REFRESH_MS && now - lastFetch >= REFRESH_MS) {
        lastFetch = now;
        void refresh(state.sessionID);
      }
    }, 1_000);
    ctx.ui.slot({
      append: "sidebar.content",
      render: (input: { sessionID: string }) => {
        if (state.sessionID !== input.sessionID) {
          setState((d: { sessionID: string | null }) => { d.sessionID = input.sessionID; });
          void refresh(input.sessionID);
        }
        const line = formatStatusV2(state.snapshot);
        return jsx ? jsx("text", { children: line }) : null;
      },
    });
    return () => clearInterval(timer);
  },
};
`;
}
