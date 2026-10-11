// T409 spike: the OpenCode 2 sidebar plugin renders mbx.status/v2 read-only. These tests
// live-evaluate the generated module under plain Node (the same B4 pattern as opencode-hooks.test.ts):
// formatStatusV2 against the Claude mod's v2 fixtures, statusUrl against the T407 contract, and
// setup() against a stub ctx with a stubbed fetch — asserting the plugin fetches the v2 endpoint
// and never derives anything itself.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { opencodeSidebarSource, opencodeSidebarServerSource, opencodeSidebarPackageJson, OPENCODE_SIDEBAR_MARKER } from "../src/opencode-sidebar.ts";
import { version } from "../src/version.ts";

// The consumer contract, copied from plugins/claude/fixtures/v2-*.json on feat/t401-claude-mod.
const FIXTURE_BOUND = {
  schema: "mbx.status/v2", mbx_version: "0.5.13",
  identity: { name: "agentmbx-claude", role: "claude", state: "bound" },
  registration: { registered: true, lease: { holder_cli: "claude", holder_session: "sess-mine", verified: true } },
  inbox: { unread: 2, needs_reply: 1, from_owner: 0, outbox_unsent: 3 },
  harness: { cli: "claude", session_id: "sess-mine", wake_path: "channel", policy: ["autonomous"] },
  cloud: { relay: { url: null, state: "unset", last_ack: null }, key_ad_expiry: null, account: null },
  devices: [],
  project: { directory: "/work/proj", lead: "agentmbx-lead", members: ["agentmbx-claude"] },
  resolved_by: "session_id",
};
const FIXTURE_UNBOUND = {
  schema: "mbx.status/v2", mbx_version: "0.5.13",
  identity: { name: null, role: null, state: "unbound" },
  registration: { registered: false, lease: null },
  inbox: { unread: 9, needs_reply: 9, from_owner: 2, outbox_unsent: 4 },
  harness: { cli: "claude", session_id: "sess-mine", wake_path: "none", policy: [] },
  cloud: { relay: { url: null, state: "unset", last_ack: null }, key_ad_expiry: null, account: null },
  devices: [],
  project: null,
  resolved_by: "none",
};

/** Importable copy of the generated plugin under test (Node 24 strips the erasable types). */
async function loadPlugin(): Promise<{
  mod: {
    formatStatusV2: (snap: unknown) => string;
    statusUrl: (port: string, cli: string, sessionID: string) => string;
    statusSections: (snap: unknown, project?: string, now?: number) => { title: string; lines: string[] }[];
    default: { id?: string; setup?: (ctx: unknown) => unknown };
  };
  dir: string;
}> {
  const dir = mkdtempSync(join(tmpdir(), "mbx-sidebar-eval-"));
  const file = join(dir, "agentmbx-sidebar.ts");
  writeFileSync(file, opencodeSidebarSource(version()));
  try {
    const mod = (await import(file)) as Awaited<ReturnType<typeof loadPlugin>>["mod"];
    return { mod, dir };
  } catch (e) { rmSync(dir, { recursive: true, force: true }); throw e; }
}

test("generated source carries the marker, targets sidebar.content, and reads the v2 endpoint read-only", () => {
  const src = opencodeSidebarSource(version());
  assert.ok(src.startsWith(OPENCODE_SIDEBAR_MARKER), "ours marker on line 1");
  assert.ok(src.includes('append: "sidebar.content"'), "claims the sidebar.content slot");
  assert.ok(src.includes("mbx.status/v2"), "asks the endpoint for mbx.status/v2");
  assert.ok(src.includes("/v1/status?cli="), "the T407 loopback endpoint");
  assert.ok(!src.includes("resolveStatusIdentity") && !src.includes("SELECT "), "renders only — zero status derivation of its own");
});

test("formatStatusV2 renders the bound fixture line-for-line", async () => {
  const { mod, dir } = await loadPlugin();
  try {
    assert.equal(mod.formatStatusV2(FIXTURE_BOUND), "mbx agentmbx-claude(claude) 2↑ 1↺");
    assert.equal(mod.formatStatusV2(FIXTURE_UNBOUND), "mbx unbound — claim or register a persona", "unbound suppresses any stale counts");
    assert.equal(mod.formatStatusV2(null), "mbx disconnected — check agentmbx doctor", "a dead daemon has an actionable state");
    const leaseUnverified = { ...FIXTURE_BOUND, registration: { registered: true, lease: { holder_cli: "claude", holder_session: "s", verified: false } } };
    assert.equal(mod.formatStatusV2(leaseUnverified), "mbx agentmbx-claude(claude) 2↑ 1↺ lease-unverified");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("statusUrl is the T407 contract: loopback, cli+session, v2 schema", async () => {
  const { mod, dir } = await loadPlugin();
  try {
    assert.equal(
      mod.statusUrl("7373", "opencode", "ses_abc"),
      "http://127.0.0.1:7373/v1/status?cli=opencode&session=ses_abc&schema=mbx.status%2Fv2&include=inbox",
    );
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("the packaged layout is what reaches the TUI runtime (opencode entrypoints in package.json)", () => {
  const pkg = JSON.parse(opencodeSidebarPackageJson());
  assert.equal(pkg.opencode.tui, "./tui.ts");
  assert.equal(pkg.opencode.server, "./server.ts");
  assert.match(opencodeSidebarServerSource(), /^\/\/ agentmbx-sidebar v1/, "server entrypoint carries the marker");
  assert.ok(opencodeSidebarServerSource().includes("setup: () => {}"), "server entrypoint is an explicit no-op");
});

test("setup no-ops on a context without the slot tree (defense, whatever runtime loaded us)", async () => {
  const { mod, dir } = await loadPlugin();
  try {
    const serverCtx = { event: { subscribe: () => { throw new Error("not reached"); } }, storage: { get: () => null, set: () => {}, remove: () => {}, scan: () => [] } };
    const cleanup = (await mod.default.setup?.(serverCtx)) as (() => void) | undefined;
    assert.equal(cleanup, undefined, "server runtime: nothing to set up, no slot claims");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("setup claims the slot, fetches v2 for the slot's session, and renders the fetched snapshot", async () => {
  const { mod, dir } = await loadPlugin();
  try {
    const fetched: string[] = [];
    const responses: unknown[] = [{ ...FIXTURE_BOUND, harness: { ...FIXTURE_BOUND.harness, cli: "opencode", session_id: "ses_t1" } }];
    (globalThis as { __mbxFetch?: unknown }).__mbxFetch = (async (url: unknown) => {
      fetched.push(String(url));
      return { ok: true, json: async () => responses.shift() ?? null };
    }) as unknown as typeof fetch;
    (globalThis as { __mbxJsx?: unknown }).__mbxJsx = (type: string, props: { children?: unknown }) => ({ type, children: props.children });
    const claims: { placement: string; render: (input: { sessionID: string }) => unknown }[] = [];
    const store = { snapshot: null as unknown, fetchedAt: 0, sessionID: null as string | null };
    const ctx = {
      storage: { memory: (_k: string, o: { initial: typeof store }) => [store, (mut: (d: typeof store) => void) => mut(store)] },
      ui: { slot: (claim: { append: string; render: (input: { sessionID: string }) => unknown }) => { claims.push({ placement: claim.append, render: claim.render }); } },
    };
    assert.equal(mod.default.id, "agentmbx-sidebar");
    const cleanup = (await mod.default.setup?.(ctx)) as () => void;
    assert.equal(claims.length, 1);
    assert.equal(claims[0]!.placement, "sidebar.content");
    const el = claims[0]!.render({ sessionID: "ses_t1" }) as { type: string; children: string };
    await new Promise((r) => setImmediate(r)); // let the fetch resolve
    const el2 = claims[0]!.render({ sessionID: "ses_t1" }) as { type: string; children: { type: string; children: string }[] };
    assert.equal(fetched.length, 1, "one fetch for the new session");
    assert.equal(fetched[0], mod.statusUrl("7373", "opencode", "ses_t1"));
    assert.equal(el2.type, "box");
    assert.equal(el2.children[1].children, "mbx agentmbx-claude(claude) 2↑ 1↺", "renders exactly what the daemon sent");
    cleanup?.();
    delete (globalThis as { __mbxFetch?: unknown }).__mbxFetch;
    delete (globalThis as { __mbxJsx?: unknown }).__mbxJsx;
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("T410: full sections render every v2 field and hide private content for unsafe states", async () => {
  const { mod, dir } = await loadPlugin();
  try {
    const snap = { ...FIXTURE_BOUND,
      cloud: { relay: { url: "https://relay.example", state: "connected", last_ack: "2026-10-10T12:00:00Z" }, key_ad_expiry: "2026-11-10T12:00:00Z", account: "account-one" },
      devices: [{ host: "paired-host", address: "127.0.0.1:7373", reachability: "unknown", last_presence: null }],
      inbox: { ...FIXTURE_BOUND.inbox, recent: [{ id: "id1", sender: "lead@macbook", subject: "OWN SUBJECT", kind: "request", ts: "2026-10-10T12:00:00Z", needs_reply: true }] } };
    const sections = mod.statusSections(snap, "opencode-goal-dev", Date.parse("2026-10-10T12:02:00Z"));
    assert.deepEqual(sections.map(s => s.title), ["Identity & session", "Inbox", "Cloud & devices", "Project"]);
    const text = JSON.stringify(sections);
    for (const field of ["agentmbx-claude", "verified", "channel", "autonomous", "OWN SUBJECT", "lead@macbook", "request", "2m ago", "reply needed", "https://relay.example", "account-one", "paired-host", "/work/proj", "agentmbx-lead"]) assert.ok(text.includes(field), field);
    for (const state of ["unbound", "ambiguous"]) {
      const unsafe = { ...snap, identity: { ...snap.identity, state } };
      assert.doesNotMatch(JSON.stringify(mod.statusSections(unsafe, "opencode-goal-dev")), /OWN SUBJECT|lead@macbook|2 unread/);
      assert.doesNotMatch(mod.formatStatusV2(unsafe), /↑|↺|owner:/);
    }
    assert.match(JSON.stringify(mod.statusSections(FIXTURE_UNBOUND, "opencode-goal-dev")), /mbx_identity list.*register opencode-goal-dev/);
    assert.match(JSON.stringify(mod.statusSections(null)), /agentmbx doctor/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

type Element = { type: string; props: Record<string, unknown> };
const textOf = (value: unknown): string => {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(textOf).join("\n");
  return value && typeof value === "object" && "props" in value ? textOf((value as Element).props.children) : "";
};
const boundFor = (sid: string, id = "1", subject = "OWN MAIL") => ({ ...FIXTURE_BOUND,
  harness: { ...FIXTURE_BOUND.harness, cli: "opencode", session_id: sid },
  inbox: { ...FIXTURE_BOUND.inbox, recent: [{ id, subject, sender: "lead@macbook", kind: "task", ts: "2026-10-10T12:00:0" + id + "Z", needs_reply: true }] } });

async function uiFixture(t: { after: (fn: () => void) => void }, responses: unknown[]) {
  const { mod, dir } = await loadPlugin();
  const seams = globalThis as { __mbxFetch?: unknown; __mbxJsx?: unknown };
  const oldFetch = seams.__mbxFetch, oldJsx = seams.__mbxJsx;
  const state = { snapshot: null as unknown, fetchedAt: 0, sessionID: null as string | null, expanded: false, loading: false };
  const slots: { append: string; render: (i: { sessionID: string; name?: string }) => unknown }[] = [];
  const commands: { id: string; bind?: string; slash?: { name: string }; run: () => unknown }[] = [];
  const toasts: unknown[] = [], opened: string[] = [];
  let current = "ses_alpha";
  seams.__mbxFetch = async () => ({ ok: true, json: async () => responses.shift() ?? null });
  seams.__mbxJsx = (type: string, props: Record<string, unknown>) => ({ type, props });
  const cleanup = await mod.default.setup?.({ location: { directory: "/work/opencode-goal" },
    storage: { memory: () => [state, (f: (s: typeof state) => void) => f(state)] },
    keymap: { layer: (f: () => { commands: typeof commands }) => commands.push(...f().commands) },
    ui: { slot: (s: typeof slots[number]) => { slots.push(s); }, router: { current: () => ({ type: "session", sessionID: current }) },
      panel: { open: (name: string) => opened.push(name), close: () => opened.push("closed") }, toast: { show: (m: unknown) => toasts.push(m) } } }) as () => void;
  t.after(() => { cleanup(); seams.__mbxFetch = oldFetch; seams.__mbxJsx = oldJsx; rmSync(dir, { recursive: true, force: true }); });
  return { state, slots, commands, toasts, opened, setSession: (sid: string) => { current = sid; },
    sidebar: (sid = current) => slots.find(s => s.append === "sidebar.content")!.render({ sessionID: sid }) as Element,
    dashboard: () => slots.find(s => s.append === "session.panel")!.render({ sessionID: current, name: "agentmbx.status" }) as Element,
    status: () => commands.find(c => c.id === "agentmbx.status")!.run() };
}

test("T410: compact default, click-to-expand and /mbx native dashboard", async t => {
  const ui = await uiFixture(t, [boundFor("ses_alpha"), boundFor("ses_alpha")]);
  const first = ui.sidebar();
  await new Promise(r => setImmediate(r));
  assert.equal(ui.state.expanded, false);
  assert.doesNotMatch(textOf(first), /Cloud & devices|OWN MAIL|Members:/, "collapsed view does not consume space with full details");
  const header = (first.props.children as Element[])[0];
  (header.props.onMouseDown as () => void)();
  assert.match(textOf(first), /Cloud & devices|Identity & session/);
  assert.match(textOf(first), /OWN MAIL/, "expanded Inbox contains this session's recent subjects");
  await ui.status();
  assert.deepEqual(ui.opened, ["agentmbx.status"]);
  assert.equal(ui.commands.find(c => c.id === "agentmbx.status")!.slash?.name, "mbx");
  assert.match(textOf(ui.dashboard()), /OWN MAIL/);
  const close = ui.commands.find(c => c.id === "agentmbx.status.close")!;
  assert.equal(close.bind, "escape");
  close.run();
  assert.equal(ui.opened.at(-1), "closed", "dashboard has a keyboard exit without affecting the agent turn");
  ui.commands.find(c => c.id === "agentmbx.toggle")!.run();
  assert.equal(ui.state.expanded, false, "keyboard/palette alternative to mouse disclosure");
});

test("T410: new-mail toast is deduplicated and offline clears cached identity data", async t => {
  const ui = await uiFixture(t, [boundFor("ses_alpha", "1"), boundFor("ses_alpha", "2", "NEW MAIL"), boundFor("ses_alpha", "2", "NEW MAIL"), null]);
  const tree = ui.sidebar();
  await new Promise(r => setImmediate(r));
  assert.equal(ui.toasts.length, 0, "initial backlog is not announced as new mail");
  await ui.status(); await ui.status();
  assert.equal(ui.toasts.length, 1);
  assert.match(JSON.stringify(ui.toasts), /NEW MAIL/);
  await ui.status();
  assert.match(textOf(tree), /disconnected/);
  assert.doesNotMatch(textOf(tree), /agentmbx-claude|↑|NEW MAIL/);
  assert.doesNotMatch(textOf(ui.dashboard()), /NEW MAIL|agentmbx-claude/);
});

test("T410: switching sessions drops old data immediately and rejects a late response", async t => {
  const ui = await uiFixture(t, [boundFor("ses_alpha")]);
  ui.sidebar(); await new Promise(r => setImmediate(r));
  let resolve: (value: unknown) => void = () => {};
  (globalThis as { __mbxFetch?: unknown }).__mbxFetch = () => new Promise(r => { resolve = r; });
  const pending = ui.status();
  ui.setSession("ses_beta");
  const beta = ui.sidebar();
  assert.match(textOf(beta), /Loading this session/);
  assert.doesNotMatch(textOf(beta), /OWN MAIL|agentmbx-claude|↑/);
  resolve({ ok: true, json: async () => boundFor("ses_alpha", "2", "LATE ALPHA MAIL") });
  await pending;
  assert.equal(ui.state.snapshot, null, "the old response never populates beta's panel");
  (globalThis as { __mbxFetch?: unknown }).__mbxFetch = async () => ({ ok: true, json: async () => ({ ...FIXTURE_UNBOUND, harness: { cli: "opencode", session_id: "ses_beta" } }) });
  await ui.status();
  assert.match(textOf(beta), /opencode-goal-dev/);
  assert.doesNotMatch(textOf(beta), /LATE ALPHA MAIL|↑|↺/);
});
