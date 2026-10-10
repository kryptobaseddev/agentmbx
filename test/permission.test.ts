// YOLO permission hook (T051): allow only under an active policy, fail closed otherwise; setup wiring on a fake HOME.
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { generateKeyPair, fingerprint, canonical, signData } from "../src/crypto.ts";
import { IdentityLeases, inspectLeaseProcess } from "../src/identity-leases.ts";
import { MbxNode } from "../src/node.ts";
import { approveKimi, decidePermission, kimiServer, opencodePermissionPass, type Lookup } from "../src/permission.ts";
import { runSetup, type SetupCtx } from "../src/setup.ts";
import { acceptSigned, hasClass, makePolicy, makeRevocation } from "../src/policy.ts";
import { taintKey, writeSessionTaint } from "../src/session-taint.ts";

// Git fixtures must not inherit the owner's helpers or harness-injected config.
process.env.GIT_CONFIG_GLOBAL = "/dev/null";
process.env.GIT_CONFIG_NOSYSTEM = "1";
delete process.env.GIT_CONFIG_COUNT;
delete process.env.GIT_CONFIG_PARAMETERS;

const tmp = (p: string) => mkdtempSync(join(tmpdir(), p));
const node = () => new MbxNode(tmp("mbx-perm-"), { host: "testhost", bind: "127.0.0.1", port: 0 });
const yes: Lookup = () => ({ ok: true, policy_id: "pol_1", exp: "2099-01-01T00:00:00Z" });
const no: Lookup = () => ({ ok: false });
const audits = (n: MbxNode) => (n.store.db.prepare("SELECT event, detail FROM audit WHERE event='yolo_allow'").all() as { detail: string }[]).map((r) => JSON.parse(r.detail));
const req = (extra: Record<string, unknown> = {}) => ({ session_id: "s1", cwd: "/work/api-dev", hook_event_name: "PermissionRequest", tool_name: "Bash", tool_input: { command: "ls" }, ...extra });
/** A session bound to THIS process (pid + start time), as the MCP server of a running CLI would record it. */
const bound = (n: MbxNode, agent: string, cli: string, sessionId = "s1", cwd = "/work/api-dev") => {
  const key = generateKeyPair();
  new IdentityLeases(n.store).claim(agent, { pid: process.pid, start: inspectLeaseProcess(process.pid).start!, keyFp: fingerprint(key.publicKey), cli, sessionId });
  n.bindSession({ agent, cli, session_id: sessionId, cwd, pid: process.pid, session_key: key.publicKey });
};
const ALLOW = { hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "allow" } } };

function narrowFixture(t: TestContext, cli: string, extra: Partial<Parameters<typeof makePolicy>[0]> = {}) {
  const n = node(), cwd = n.home, owner = generateKeyPair(), peer = generateKeyPair();
  t.after(() => { n.close(); rmSync(cwd, { recursive: true, force: true }); });
  n.addApprovedPeer({ host: "ownerhost", pubkey: peer.publicKey, owner_pubkey: owner.publicKey, addr: "127.0.0.1:1" }, "test");
  n.adoptOwner("ownerhost");
  const policy = makePolicy({ level: "collaborate", classes: ["outward-reversible"], agents: ["api-dev"], hosts: [n.host], projects: [cwd], ownerPub: owner.publicKey, ...extra });
  assert.equal(acceptSigned(n.store.db, { rec: policy, sig: signData(owner.privateKey, canonical(policy)) }, n.host), null);
  bound(n, "api-dev", cli, "s1", cwd);
  const git = (...args: string[]) => execFileSync("git", args, { cwd, stdio: "ignore" });
  git("init", "-b", "trunk");
  git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--allow-empty", "-m", "fixture");
  git("branch", "feature"); git("clone", "--bare", cwd, join(cwd, "remote.git")); git("remote", "add", "origin", join(cwd, "remote.git"));
  const lookup: Lookup = (agent, ctx) => hasClass(n.store.db, agent, n.host, ctx?.class ?? "permissions", { cwd: ctx?.cwd });
  const input = (command: string) => req({ cwd, tool_name: cli === "kimi" ? "Shell" : "Bash", tool_input: { command }, id: "approval_narrow" });
  return { n, cwd, policy, owner, lookup, input };
}

const taint = (n: MbxNode, cli: string, session = "s1") => writeSessionTaint(n.store, {
  v: 1, cli, session_id: session, root: Date.now(), from: "outside", id: "message_test", how: "declared", relay_depth: [],
});

for (const cli of ["claude", "codex", "kimi"]) test(`T539 AC1/AC4: ${cli} signed narrow authority approves only the two operations`, async t => {
  const { n, cwd, lookup, input } = narrowFixture(t, cli);
  assert.equal(hasClass(n.store.db, "api-dev", n.host, "permissions", { cwd }).ok, false);
  for (const command of ["git push origin feature", "gh pr create --draft --head feature --title 'fix' --body 'body'"]) {
    const d = await decidePermission(input(command), cli, lookup, { node: n, pid: process.pid });
    assert.equal(d.allow, true, command); assert.equal(d.class, "outward-reversible");
    if (cli === "kimi") {
      assert.equal(d.output, ""); let posts = 0;
      const fake = (async (_url: unknown, init?: RequestInit) => {
        if (init?.method === "POST") { posts++; assert.deepEqual(JSON.parse(init.body as string), { decision: "approved" }); return Response.json({ code: 0 }); }
        return Response.json({ code: 0, data: { items: [{ approval_id: "approval_narrow" }] } });
      }) as typeof fetch;
      assert.equal(await approveKimi(n, d, { server: { url: "http://test.invalid", token: "test" }, fetch: fake,
        recheck: () => lookup(d.agent!, { cwd: d.cwd, class: d.class }).ok }), true);
      assert.equal(posts, 1);
    } else assert.deepEqual(JSON.parse(d.output), ALLOW);
  }
});

for (const cli of ["claude", "codex"]) test(`T539 AC1/AC3: ${cli} permission CLI awaits the scoped decision and emits its provider contract`, t => {
  const { n, input } = narrowFixture(t, cli);
  const run = (command: string, dev: string) => spawnSync(process.execPath, [join(import.meta.dirname, "../bin/agentmbx.js"), "hook", "permission", "--cli", cli], {
    input: JSON.stringify(input(command)), encoding: "utf8", timeout: 15_000,
    env: { ...process.env, AGENTMBX_DEV: dev, MBX_HOME: n.home, MBX_NO_DESKTOP: "1", MBX_NO_UPDATE_CHECK: "1" },
  });
  for (const dev of ["1", ""]) for (const command of ["git push origin feature", "gh pr create --draft --head feature"]) {
    const result = run(command, dev);
    assert.equal(result.status, 0, result.stderr); assert.deepEqual(JSON.parse(result.stdout), ALLOW);
  }
  for (const dev of ["1", ""]) for (const command of ["git push origin feature:trunk", "git push --force origin feature", "gh pr create --head feature"]) {
    const result = run(command, dev);
    assert.equal(result.status, 0, result.stderr); assert.equal(result.stdout, "");
  }
  taint(n, cli);
  for (const dev of ["1", ""]) {
    const result = run("git push origin feature", dev);
    assert.equal(result.status, 0, result.stderr); assert.equal(result.stdout, "");
  }
  assert.equal(audits(n).length, 4);
});

test("T539 AC2: narrow authority does not approve default, force, deletion or other actions", async t => {
  const { n, lookup, input } = narrowFixture(t, "claude");
  for (const command of ["git push origin feature:trunk", "git push origin HEAD:refs/heads/trunk", "git push --force origin feature", "git push origin :feature",
    "gh pr create --head feature", "gh pr create --draft=false --head feature", "gh pr merge", "gh release create v1", "rm -rf .", "git push origin feature && gh pr merge"]) {
    const d = await decidePermission(input(command), "claude", lookup, { node: n, pid: process.pid });
    assert.equal(d.allow, false, command); assert.equal(d.output, "");
  }
  for (const changed of [{ tool_name: "Other" }, { tool_input: { command: "git push origin feature", env: {} } },
    { tool_input: { command: "git push origin feature", cwd: "/other" } }, { session_id: "other-thread" }, { cwd: tmpdir() }]) {
    assert.equal((await decidePermission({ ...input("git push origin feature"), ...changed }, "claude", lookup, { node: n, pid: process.pid })).allow, false);
  }
  assert.deepEqual(audits(n), []);
});

test("T539 AC1: signature, sender/project scope, expiry and revocation stay authoritative", async t => {
  for (const extra of [{ classes: ["read"] }, { fromAgents: ["only-one-sender"] }, { projects: [join(tmpdir(), "unrelated-project")] },
    { now: new Date(Date.now() - 60_000), ttlMs: 1 }]) {
    const { n, lookup, input } = narrowFixture(t, "codex", extra as Partial<Parameters<typeof makePolicy>[0]>);
    assert.equal((await decidePermission(input("git push origin feature"), "codex", lookup, { node: n, pid: process.pid })).allow, false);
  }
  const { n, lookup, input, policy, owner } = narrowFixture(t, "codex");
  const revocation = makeRevocation(policy.id, owner.publicKey);
  assert.equal(acceptSigned(n.store.db, { rec: revocation, sig: signData(owner.privateKey, canonical(revocation)) }, n.host), null);
  assert.equal((await decidePermission(input("git push origin feature"), "codex", lookup, { node: n, pid: process.pid })).allow, false);
  const broader = narrowFixture(t, "codex", { level: "autonomous", classes: ["outward"] });
  assert.equal((await decidePermission(broader.input("git push origin feature"), "codex", broader.lookup, { node: broader.n, pid: process.pid })).allow, true);
  broader.n.store.db.prepare("UPDATE policies SET sig='tampered'").run();
  assert.equal((await decidePermission(broader.input("git push origin feature"), "codex", broader.lookup, { node: broader.n, pid: process.pid })).allow, false);
});

for (const cli of ["claude", "codex", "kimi"]) test(`T539 AC3: ${cli} taint blocks narrow approval and explicit YOLO`, async t => {
  const { n, lookup, input } = narrowFixture(t, cli);
  taint(n, cli);
  for (const policyLookup of [lookup, yes]) for (const command of ["git push origin feature", "gh pr create --draft --head feature"]) {
    const d = await decidePermission(input(command), cli, policyLookup, { node: n, pid: process.pid });
    assert.equal(d.allow, false); assert.equal(d.output, "");
  }
  n.store.set(taintKey(cli, "s1"), "{malformed");
  assert.equal((await decidePermission(input("git push origin feature"), cli, yes, { node: n, pid: process.pid })).allow, false);
});

test("T539 AC3: authority and taint are rechecked after asynchronous preflight outside SQLite", async t => {
  for (const mutation of ["taint", "revoke", "rebind"]) {
    const { n, lookup, input, policy, owner } = narrowFixture(t, "codex");
    const d = await decidePermission(input("git push origin feature"), "codex", lookup, { node: n, pid: process.pid, preflight: async () => {
      assert.equal(n.store.db.isTransaction, false);
      await Promise.resolve();
      if (mutation === "taint") taint(n, "codex");
      if (mutation === "revoke") {
        const rec = makeRevocation(policy.id, owner.publicKey);
        assert.equal(acceptSigned(n.store.db, { rec, sig: signData(owner.privateKey, canonical(rec)) }, n.host), null);
      }
      if (mutation === "rebind") n.store.db.prepare("UPDATE sessions SET session_key=? WHERE session_id='s1'").run(generateKeyPair().publicKey);
      return true;
    } });
    assert.equal(d.allow, false, mutation); assert.deepEqual(audits(n), []);
  }
});

test("T539 AC3/AC4: Kimi polling cannot approve after taint arrives", async t => {
  const { n, input } = narrowFixture(t, "kimi");
  const d = await decidePermission(input("git push origin feature"), "kimi", yes, { node: n, pid: process.pid });
  let posts = 0;
  const fake = (async (_url: unknown, init?: RequestInit) => {
    assert.equal(n.store.db.isTransaction, false);
    if (init?.method === "POST") { posts++; return Response.json({ code: 0 }); }
    taint(n, "kimi"); return Response.json({ code: 0, data: { items: [{ approval_id: "approval_narrow" }] } });
  }) as typeof fetch;
  assert.equal(await approveKimi(n, d, { server: { url: "http://test.invalid", token: "test" }, fetch: fake, recheck: () => true }), false);
  assert.equal(posts, 0);
});

test("T539 AC3/AC4: OpenCode retains YOLO only and checks taint after fetching", async t => {
  const n = node(); t.after(() => { n.close(); rmSync(n.home, { recursive: true, force: true }); });
  bound(n, "api-dev", "opencode", "ses_test");
  let posts = 0, calls = 0;
  const fake = (async (_url: unknown, init?: RequestInit) => {
    calls++; assert.equal(n.store.db.isTransaction, false);
    if (init?.method === "POST") { posts++; return new Response(null, { status: 204 }); }
    taint(n, "opencode", "ses_test"); return Response.json({ data: [{ id: "per_test", sessionID: "ses_test", action: "Bash" }] });
  }) as typeof fetch;
  const narrow: Lookup = (_agent, ctx) => ({ ok: ctx?.class === "outward-reversible" });
  assert.equal(await opencodePermissionPass(n, narrow, async () => ({ url: "http://test.invalid", auth: "" }), fake, () => "service"), 0);
  assert.equal(calls, 0, "action-only requests cannot borrow narrow approval");
  assert.equal(await opencodePermissionPass(n, yes, async () => ({ url: "http://test.invalid", auth: "" }), fake, () => "service"), 0);
  assert.equal(posts, 0);
});

test("claude and codex: allow under an active policy, with the documented JSON and an audit line", async () => {
  for (const cli of ["claude", "codex"]) {
    const n = node(); const seen: string[] = [];
    bound(n, "api-dev", cli);
    const d = await decidePermission(req(), cli, (a) => { seen.push(a); return yes(a); }, { node: n, pid: process.pid });
    assert.equal(d.allow, true);
    assert.deepEqual(JSON.parse(d.output), ALLOW);
    assert.deepEqual([...new Set(seen)], ["api-dev"]);
    assert.deepEqual(audits(n), [{ agent: "api-dev", cli, tool: "Bash", policy_id: "pol_1" }]);
  }
});

test("no policy, malformed input, interactive tools, other CLIs, a throwing lookup: no decision and no audit", async () => {
  const n = node();
  const cases: [unknown, string, Lookup][] = [
    [req(), "claude", no], [null, "claude", yes], ["{", "claude", yes], [[], "claude", yes], [{}, "claude", yes],
    [req({ tool_name: 7 }), "claude", yes], [req({ tool_name: "AskUserQuestion" }), "claude", yes], [req({ tool_name: "ExitPlanMode" }), "claude", yes],
    [req({ hook_event_name: "PreToolUse" }), "claude", yes], [req(), "hermes", yes], [req(), "grok", yes], [req(), "unknown", yes],
    [req(), "claude", () => { throw new Error("db locked"); }],
    [req(), "claude", (() => undefined) as unknown as Lookup],
  ];
  for (const [input, cli, lookup] of cases) {
    const d = await decidePermission(input, cli, lookup, { node: n, pid: process.pid });
    assert.equal(d.allow, false, JSON.stringify(input)); assert.equal(d.output, "");
  }
  assert.deepEqual(audits(n), []);
});

test("the agent comes from a binding of this very process (session, else MCP); never a guess", async () => {
  const n = node();
  const seen: string[] = [];
  const ask = (input: unknown, cli: string, pid?: number) => decidePermission(input, cli, (a) => { seen.push(a); return yes(a); }, { node: n, pid });
  // no binding at all, or no pid: no decision, and the policy isn't even consulted (no folder-name guess)
  assert.equal((await ask(req(), "claude", process.pid)).allow, false);
  assert.equal((await ask(req(), "claude")).allow, false);
  // a session row recorded for another process (pid 4242) is not this session
  n.bindSession({ agent: "elsewhere", cli: "claude", session_id: "s1", cwd: "/work/api-dev", pid: 4242 });
  assert.equal((await ask(req(), "claude", process.pid)).allow, false);
  bound(n, "renamed", "claude");
  await ask(req(), "claude", process.pid);
  bound(n, "via-mcp", "codex");
  assert.equal((await ask(req({ session_id: "unbound" }), "codex", process.pid)).allow, false);
  await ask(req(), "codex", process.pid);
  assert.deepEqual([...new Set(seen)], ["renamed", "via-mcp"]);
});

test("kimi: the hook prints nothing; the approval goes through the kimi web API and only then is audited", async () => {
  const n = node();
  const kimiReq = req({ id: "approval_abc", tool_name: "Shell" });
  bound(n, "api-dev", "kimi");
  assert.equal((await decidePermission(kimiReq, "kimi", no, { node: n, pid: process.pid })).kimi, undefined);
  const d = await decidePermission(kimiReq, "kimi", yes, { node: n, pid: process.pid });
  assert.equal(d.output, ""); assert.deepEqual(d.kimi, { session_id: "s1", approval_id: "approval_abc" });
  assert.deepEqual(audits(n), []);

  const calls: { url: string; method: string; body?: string; auth?: string }[] = []; let polls = 0;
  const fake = (async (url: string, init: RequestInit = {}) => {
    calls.push({ url, method: init.method ?? "GET", body: init.body as string, auth: (init.headers as Record<string, string>).authorization });
    if ((init.method ?? "GET") === "GET") return Response.json({ code: 0, msg: "", request_id: "r", data: { items: ++polls < 2 ? [] : [{ approval_id: "approval_abc" }] } });
    return Response.json({ code: 0, msg: "", request_id: "r", data: { resolved: true, resolved_at: "now" } });
  }) as typeof fetch;
  assert.equal(await approveKimi(n, d, { server: { url: "http://127.0.0.1:9", token: "tok" }, fetch: fake }), true);
  const post = calls.find((c) => c.method === "POST")!;
  assert.equal(post.url, "http://127.0.0.1:9/api/v1/sessions/s1/approvals/approval_abc");
  assert.deepEqual(JSON.parse(post.body!), { decision: "approved" });
  assert.equal(post.auth, "Bearer tok");
  assert.deepEqual(audits(n), [{ agent: "api-dev", cli: "kimi", tool: "Shell", policy_id: "pol_1", via: "kimi web" }]);

  // a session the server doesn't host (plain TUI): error answer, nothing approved
  const notHosted = (async () => Response.json({ code: 40401, msg: "session not found", data: null, request_id: "r" }, { status: 404 })) as unknown as typeof fetch;
  assert.equal(await approveKimi(n, d, { server: { url: "http://x", token: "t" }, fetch: notHosted }), false);
  // never listed: give up at the deadline
  const never = (async () => Response.json({ code: 0, data: { items: [] } })) as unknown as typeof fetch;
  assert.equal(await approveKimi(n, d, { server: { url: "http://x", token: "t" }, fetch: never, waitMs: 300 }), false);
  assert.equal(await approveKimi(n, d, { server: null }), false);
  // revoked while waiting for the approval to show up: the re-check stops it
  assert.equal(await approveKimi(n, d, { server: { url: "http://127.0.0.1:9", token: "tok" }, fetch: fake, recheck: () => false }), false);
  assert.equal(audits(n).length, 1);
});

test("kimiServer finds a live instance and its token", () => {
  const home = tmp("kimi-home-");
  assert.equal(kimiServer(home), null);
  mkdirSync(join(home, "server/instances"), { recursive: true });
  writeFileSync(join(home, "server.token"), "secret\n");
  writeFileSync(join(home, "server/instances/a.json"), JSON.stringify({ server_id: "a", pid: 999999, host: "127.0.0.1", port: 5000 }));
  assert.equal(kimiServer(home, () => false), null);
  assert.deepEqual(kimiServer(home, () => true), { url: "http://127.0.0.1:5000", token: "secret" });
});

test("opencode daemon pass: replies once for covered agents only, and makes no request without a policy", async () => {
  const n = node();
  // bindings proven to be live OpenCode processes (pid + start time), as the MCP server records them
  bound(n, "yolo", "opencode", "ses_A");
  bound(n, "careful", "opencode", "ses_B");
  const calls: { url: string; method: string; body?: string }[] = [];
  const fake = (async (url: string, init: RequestInit = {}) => {
    calls.push({ url, method: init.method ?? "GET", body: init.body as string });
    if ((init.method ?? "GET") === "GET") return Response.json({ data: [{ id: "per_1", sessionID: "ses_A", action: "bash", resources: ["ls"] }] });
    return new Response(null, { status: 204 });
  }) as typeof fetch;
  let svcCalls = 0;
  const svc = async () => { svcCalls++; return { url: "http://oc", auth: "Basic x" }; };
  assert.equal(await opencodePermissionPass(n, no, svc, fake, () => "service"), 0);
  assert.equal(svcCalls, 0); assert.equal(calls.length, 0);
  assert.equal(await opencodePermissionPass(n, (a) => (a === "yolo" ? yes(a) : no(a)), svc, fake, () => "service"), 1);
  assert.deepEqual(calls.map((c) => `${c.method} ${c.url}`), ["GET http://oc/api/session/ses_A/permission", "POST http://oc/api/session/ses_A/permission/per_1/reply"]);
  assert.deepEqual(JSON.parse(calls[1].body!), { decision: "once" });
  assert.deepEqual(audits(n), [{ agent: "yolo", cli: "opencode", tool: "bash", policy_id: "pol_1" }]);
});

test("opencode daemon pass: legacy MCP-only bindings cannot use folder-based approval", async () => {
  const n = node();
  n.bindSession({ agent: "web", cli: "opencode", session_id: "mcp-123", cwd: "/work/web", pid: process.pid, session_key: "k" });
  n.bindSession({ agent: "other", cli: "opencode", session_id: "ses_other", cwd: "/work/web" });
  const posts: string[] = []; let listUrl = "";
  const fake = (async (url: string, init: RequestInit = {}) => {
    if ((init.method ?? "GET") === "GET") {
      listUrl = url;
      return Response.json({ location: { directory: "/work/web" }, data: [
        { id: "per_mine", sessionID: "ses_unbound", action: "edit", resources: [] },
        { id: "per_theirs", sessionID: "ses_other", action: "bash", resources: [] }] });
    }
    posts.push(url); return new Response(null, { status: 204 });
  }) as typeof fetch;
  assert.equal(await opencodePermissionPass(n, (a) => (a === "web" ? yes(a) : no(a)), async () => ({ url: "http://oc", auth: "" }), fake, () => "service"), 0);
  assert.equal(listUrl, "");
  assert.deepEqual(posts, []);
});

// ---- setup wiring --------------------------------------------------------------------------------
const ORCA = "/bin/sh \"$HOME/.orca/agent-hooks/hook.sh\"";
function fakeHome() {
  const home = tmp("mbx-perm-setup-");
  const files: Record<string, string> = {
    ".claude/settings.json": JSON.stringify({ hooks: { PermissionRequest: [{ matcher: "Bash", hooks: [{ type: "command", command: ORCA }] }] } }, null, 2) + "\n",
    ".codex/hooks.json": JSON.stringify({ hooks: { PermissionRequest: [{ hooks: [{ type: "command", command: ORCA }] }] } }, null, 2) + "\n",
    ".kimi-code/config.toml": `default_model = "fake"\n[[hooks]]\nevent = "PermissionRequest"\ncommand = "true"\n`,
  };
  for (const [rel, body] of Object.entries(files)) { mkdirSync(dirname(join(home, rel)), { recursive: true }); writeFileSync(join(home, rel), body); }
  return { home, files };
}
const ctx = (home: string): SetupCtx => ({ home, cmd: ["/opt/bin/agentmbx"], which: () => null, useClis: false });
const only = ["claude", "codex", "kimi"];

test("setup wires the permission hook for claude, codex and kimi, idempotently, and uninstall restores the files", () => {
  const { home, files } = fakeHome();
  const rows = runSetup(ctx(home), { mode: "install", only, stamp: "P1" });
  assert.ok(!rows.some((r) => r.action === "error"), JSON.stringify(rows));
  const want = "/opt/bin/agentmbx hook permission --cli";
  for (const [rel, cli] of [[".claude/settings.json", "claude"], [".codex/hooks.json", "codex"]]) {
    const groups = JSON.parse(readFileSync(join(home, rel), "utf8")).hooks.PermissionRequest as { matcher?: string; hooks: { command: string; timeout?: number }[] }[];
    assert.equal(groups.length, 2, rel);
    assert.equal(groups[0].hooks[0].command, ORCA, `${rel}: other tool's group untouched`);
    assert.deepEqual(groups[1], { hooks: [{ type: "command", command: `${want} ${cli}`, timeout: 10 }] });
  }
  const kimi = readFileSync(join(home, ".kimi-code/config.toml"), "utf8");
  assert.match(kimi, /event = "PermissionRequest"\ncommand = "\/opt\/bin\/agentmbx hook permission --cli kimi"/);
  assert.ok(kimi.startsWith(files[".kimi-code/config.toml"]));

  const again = runSetup(ctx(home), { mode: "install", only, stamp: "P2" });
  assert.deepEqual(again.filter((r) => r.action !== "unchanged" && r.action !== "skipped"), []);

  runSetup(ctx(home), { mode: "uninstall", only, stamp: "P3" });
  for (const [rel, body] of Object.entries(files)) assert.equal(readFileSync(join(home, rel), "utf8"), body, rel);
});
