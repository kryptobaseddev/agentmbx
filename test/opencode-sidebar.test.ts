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
    assert.equal(mod.formatStatusV2(FIXTURE_UNBOUND), "mbx unbound 9↑ 9↺ owner:2", "unbound keeps its explicit state and the mod's counts render as-is");
    assert.equal(mod.formatStatusV2(null), "mbx ?", "a dead daemon degrades to a bare marker, never a throw inside the host");
    const leaseUnverified = { ...FIXTURE_BOUND, registration: { registered: true, lease: { holder_cli: "claude", holder_session: "s", verified: false } } };
    assert.equal(mod.formatStatusV2(leaseUnverified), "mbx agentmbx-claude(claude) 2↑ 1↺ lease-unverified");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("statusUrl is the T407 contract: loopback, cli+session, v2 schema", async () => {
  const { mod, dir } = await loadPlugin();
  try {
    assert.equal(
      mod.statusUrl("7373", "opencode", "ses_abc"),
      "http://127.0.0.1:7373/v1/status?cli=opencode&session=ses_abc&schema=mbx.status%2Fv2",
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
    const responses: unknown[] = [FIXTURE_BOUND];
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
    const el2 = claims[0]!.render({ sessionID: "ses_t1" }) as { type: string; children: string };
    assert.equal(fetched.length, 1, "one fetch for the new session");
    assert.equal(fetched[0], mod.statusUrl("7373", "opencode", "ses_t1"));
    assert.equal(el2.type, "text");
    assert.equal(el2.children, "mbx agentmbx-claude(claude) 2↑ 1↺", "renders exactly what the daemon sent");
    cleanup?.();
    delete (globalThis as { __mbxFetch?: unknown }).__mbxFetch;
    delete (globalThis as { __mbxJsx?: unknown }).__mbxJsx;
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
