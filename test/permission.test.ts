// YOLO permission hook (T051): allow only under an active policy, fail closed otherwise; setup wiring on a fake HOME.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { generateKeyPair, fingerprint } from "../src/crypto.ts";
import { IdentityLeases, inspectLeaseProcess } from "../src/identity-leases.ts";
import { MbxNode } from "../src/node.ts";
import { approveKimi, decidePermission, kimiServer, opencodePermissionPass, type Lookup } from "../src/permission.ts";
import { runSetup, type SetupCtx } from "../src/setup.ts";

const tmp = (p: string) => mkdtempSync(join(tmpdir(), p));
const node = () => new MbxNode(tmp("mbx-perm-"), { host: "testhost", bind: "127.0.0.1", port: 0 });
const yes: Lookup = () => ({ ok: true, policy_id: "pol_1", exp: "2099-01-01T00:00:00Z" });
const no: Lookup = () => ({ ok: false });
const audits = (n: MbxNode) => (n.store.db.prepare("SELECT event, detail FROM audit WHERE event='yolo_allow'").all() as { detail: string }[]).map((r) => JSON.parse(r.detail));
const req = (extra: Record<string, unknown> = {}) => ({ session_id: "s1", cwd: "/work/api-dev", hook_event_name: "PermissionRequest", tool_name: "Bash", tool_input: { command: "ls" }, ...extra });
/** A session bound to THIS process (pid + start time), as the MCP server of a running CLI would record it. */
const bound = (n: MbxNode, agent: string, cli: string, sessionId = "s1") => {
  const key = generateKeyPair();
  new IdentityLeases(n.store).claim(agent, { pid: process.pid, start: inspectLeaseProcess(process.pid).start!, keyFp: fingerprint(key.publicKey), cli, sessionId });
  n.bindSession({ agent, cli, session_id: sessionId, cwd: "/work/api-dev", pid: process.pid, session_key: key.publicKey });
};
const ALLOW = { hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "allow" } } };

test("claude and codex: allow under an active policy, with the documented JSON and an audit line", () => {
  for (const cli of ["claude", "codex"]) {
    const n = node(); const seen: string[] = [];
    bound(n, "api-dev", cli);
    const d = decidePermission(req(), cli, (a) => { seen.push(a); return yes(a); }, { node: n, pid: process.pid });
    assert.equal(d.allow, true);
    assert.deepEqual(JSON.parse(d.output), ALLOW);
    assert.deepEqual(seen, ["api-dev"]);
    assert.deepEqual(audits(n), [{ agent: "api-dev", cli, tool: "Bash", policy_id: "pol_1" }]);
  }
});

test("no policy, malformed input, interactive tools, other CLIs, a throwing lookup: no decision and no audit", () => {
  const n = node();
  const cases: [unknown, string, Lookup][] = [
    [req(), "claude", no], [null, "claude", yes], ["{", "claude", yes], [[], "claude", yes], [{}, "claude", yes],
    [req({ tool_name: 7 }), "claude", yes], [req({ tool_name: "AskUserQuestion" }), "claude", yes], [req({ tool_name: "ExitPlanMode" }), "claude", yes],
    [req({ hook_event_name: "PreToolUse" }), "claude", yes], [req(), "hermes", yes], [req(), "unknown", yes],
    [req(), "claude", () => { throw new Error("db locked"); }],
    [req(), "claude", (() => undefined) as unknown as Lookup],
  ];
  for (const [input, cli, lookup] of cases) {
    const d = decidePermission(input, cli, lookup, { node: n, pid: process.pid });
    assert.equal(d.allow, false, JSON.stringify(input)); assert.equal(d.output, "");
  }
  assert.deepEqual(audits(n), []);
});

test("the agent comes from a binding of this very process (session, else MCP); never a guess", () => {
  const n = node();
  const seen: string[] = [];
  const ask = (input: unknown, cli: string, pid?: number) => decidePermission(input, cli, (a) => { seen.push(a); return yes(a); }, { node: n, pid });
  // no binding at all, or no pid: no decision, and the policy isn't even consulted (no folder-name guess)
  assert.equal(ask(req(), "claude", process.pid).allow, false);
  assert.equal(ask(req(), "claude").allow, false);
  // a session row recorded for another process (pid 4242) is not this session
  n.bindSession({ agent: "elsewhere", cli: "claude", session_id: "s1", cwd: "/work/api-dev", pid: 4242 });
  assert.equal(ask(req(), "claude", process.pid).allow, false);
  bound(n, "renamed", "claude");
  ask(req(), "claude", process.pid);
  bound(n, "via-mcp", "codex");
  assert.equal(ask(req({ session_id: "unbound" }), "codex", process.pid).allow, false);
  ask(req(), "codex", process.pid);
  assert.deepEqual(seen, ["renamed", "via-mcp"]);
});

test("kimi: the hook prints nothing; the approval goes through the kimi web API and only then is audited", async () => {
  const n = node();
  const kimiReq = req({ id: "approval_abc", tool_name: "Shell" });
  bound(n, "api-dev", "kimi");
  assert.equal(decidePermission(kimiReq, "kimi", no, { node: n, pid: process.pid }).kimi, undefined);
  const d = decidePermission(kimiReq, "kimi", yes, { node: n, pid: process.pid });
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
  assert.equal(await opencodePermissionPass(n, no, svc, fake), 0);
  assert.equal(svcCalls, 0); assert.equal(calls.length, 0);
  assert.equal(await opencodePermissionPass(n, (a) => (a === "yolo" ? yes(a) : no(a)), svc, fake), 1);
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
  assert.equal(await opencodePermissionPass(n, (a) => (a === "web" ? yes(a) : no(a)), async () => ({ url: "http://oc", auth: "" }), fake), 0);
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
