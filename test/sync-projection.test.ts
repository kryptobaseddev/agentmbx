// T262: the SyncBatch projection sends only allowlisted fields.
import { test } from "node:test";
import assert from "node:assert/strict";
import { CAPS, projectLocalPath, projectSync, type AgentInput, type HostInput, type LeadInput, type PathInput, type PolicyInput, type ReceiptInput, type SyncSnapshot, type ThreadInput } from "../src/sync-projection.ts";
import { ulid } from "../src/crypto.ts";

const USER = "zzadaqq";
const HOME = `/Users/${USER}`;
const KEY = "github.com/example/widget";
const HASH = `k:${"ab".repeat(32)}`;

function host(): HostInput {
  return { daemon_version: "0.5.10", os: "macos", owner_fp: null, authority_owner: false, relay_enrolled: false, peers: [], findings: [] };
}
function snap(over: Partial<SyncSnapshot> = {}): SyncSnapshot {
  return {
    now: "2026-10-05T00:00:00.000Z", seq: 1, full: true, contract: 1, contractAllowsProjectPaths: false, contractAllowsProjectLeads: false,
    host: host(), agents: [], threads: [], receipts: [], policies: [], approvals: [], paths: [], leads: [], sentReceipts: [], ...over,
  };
}
function pathOf(absolute: string, over: Partial<PathInput> = {}): PathInput {
  return { project_key: KEY, absolute, home: HOME, username: USER, windows: false, ...over };
}
function agent(over: Partial<AgentInput> = {}): AgentInput {
  return { name: "worker", role: "builder", cli: "claude", state: "live", unread: 1, missed: 0, project_keys: [KEY], holder: { cli: "claude", since: "2026-10-05T00:00:00.000Z" }, last_seen_at: "2026-10-05T00:00:00.000Z", ...over };
}
function thread(over: Partial<ThreadInput> = {}): ThreadInput {
  const id = ulid(1_700_000_000_000);
  return { thread_id: id, subject_hash: "plain subject " + USER, project_keys: [], participants: ["lead@fedora"], kind_counts: { task: 1 }, state_counts: { notified: 1 }, trust: ["local"], max_relay_depth: 1, started_at: "2026-10-05T00:00:00.000Z", updated_at: "2026-10-05T00:00:00.000Z", ...over };
}
function receipt(over: Partial<ReceiptInput> = {}): ReceiptInput {
  const id = ulid();
  return { message_id: id, thread_id: id, kind: "task", from: "lead@fedora", to: "worker@alpha", state: "notified", at: "2026-10-05T00:00:00.000Z", signed_by_host_fp: "abcd-ef01-2345-6789", ...over };
}

test("a body, a subject, an absolute path, and the username are absent when paths are off", () => {
  const absolute = `${HOME}/projects/${USER}/repo`;
  const got = projectSync(snap({
    agents: [agent({ cli: "grok", holder: { cli: "grok", since: "2026-10-05T00:00:00.000Z" }, project_keys: [absolute, KEY] })],
    threads: [thread()],
    paths: [pathOf(absolute)],
    host: { ...host(), daemon_version: "0.5.10", peers: [{ host_name: "fedora", host_key_fp: "abcd-ef01-2345-6789", last_seen_at: null }] },
  }));
  assert.equal(got.ok, true);
  if (!got.ok) return;
  const body = got.body;
  assert.equal(body.includes(absolute), false);
  assert.equal(body.includes(HOME), false);
  assert.equal(body.includes(USER), false);
  assert.equal(body.includes("plain subject"), false);
  assert.equal(body.includes("\"body\""), false);
  assert.equal(body.includes("\"subject\""), false);
  assert.equal(body.includes("project_paths"), false);
  assert.equal(body.includes("local_path"), false);
  assert.equal(body.includes("needs_reply"), false);
  assert.equal(body.includes("\"grok\""), false);
  const batch = got.batch;
  const agents = (batch.agents as { upsert: { cli: string; holder: { cli: string }; project_keys: string[] }[] }).upsert;
  assert.equal(agents[0].cli, "unknown");
  assert.equal(agents[0].holder.cli, "unknown");
  assert.deepEqual(agents[0].project_keys, [KEY]);
  const threads = (batch.threads as { upsert: { flags: string[]; subject_hash: null }[] }).upsert;
  assert.deepEqual(threads[0].flags, []);
  assert.equal(threads[0].subject_hash, null);
  assert.deepEqual(got.redacted, []);
  const relay = (batch.host as { relay: { enrolled: boolean; last_pull_at: null } }).relay;
  assert.equal(relay.last_pull_at, null);
});

test("an opted-in path is sent only when the contract lists project_paths, and a later username segment stays", () => {
  const absolute = `${HOME}/work/${USER}/repo`;
  const withheld = projectSync(snap({ contractAllowsProjectPaths: false, paths: [pathOf(absolute)] }));
  assert.equal(withheld.ok, true);
  if (withheld.ok) assert.equal(withheld.body.includes("project_paths"), false);

  const sent = projectSync(snap({ contract: 2, contractAllowsProjectPaths: true, paths: [pathOf(absolute)] }));
  assert.equal(sent.ok, true);
  if (!sent.ok) return;
  const paths = (sent.batch.host as { project_paths: { project_key: string; local_path: string }[] }).project_paths;
  assert.deepEqual(paths, [{ project_key: KEY, local_path: `work/${USER}/repo` }]);
  assert.equal(sent.body.includes(HOME), false);
  assert.equal(sent.body.includes(absolute), false);
  assert.deepEqual(sent.redacted, []);
});

test("a lead row is sent only when the contract lists project_leads, and the checkout path stays off the wire", () => {
  const absolute = `${HOME}/work/${USER}/repo`;
  const id = ulid(1_700_000_000_000);
  const row: LeadInput = { project_key: KEY, agent: "agentmbx-lead", host: "alpha", exp: "2026-11-05T00:00:00.000Z", id };
  const leaked: LeadInput = { ...row, project_key: absolute, id: ulid(1_700_000_000_001) };
  const withheld = projectSync(snap({ leads: [row, leaked], paths: [pathOf(absolute)] }));
  assert.equal(withheld.ok, true);
  if (!withheld.ok) return;
  assert.equal(withheld.body.includes("project_leads"), false);
  assert.equal(withheld.body.includes(absolute), false);
  assert.equal("project_leads" in (withheld.batch.host as object), false);

  const sent = projectSync(snap({ contract: 2, contractAllowsProjectLeads: true, leads: [row, leaked, row] }));
  assert.equal(sent.ok, true);
  if (!sent.ok) return;
  assert.deepEqual((sent.batch.host as { project_leads: LeadInput[] }).project_leads, [row]);
  assert.equal(sent.body.includes(absolute), false);
  assert.equal(sent.body.includes(HOME), false);
  const empty = projectSync(snap({ contract: 2, contractAllowsProjectLeads: true }));
  assert.equal(empty.ok, true);
  if (!empty.ok) return;
  assert.deepEqual((empty.batch.host as { project_leads: LeadInput[] }).project_leads, []);
  assert.equal(sent.snapshotHash, empty.snapshotHash, "lead rows are not part of the snapshot hash");
  assert.notEqual(sent.body, empty.body);
});

test("a path outside home is omitted when it names the user, and the batch still sends", () => {
  const got = projectSync(snap({ contract: 2, contractAllowsProjectPaths: true, paths: [pathOf(`/opt/${USER}/repo`)] }));
  assert.equal(got.ok, true);
  if (!got.ok) return;
  assert.deepEqual((got.batch.host as { project_paths: unknown[] }).project_paths, []);
  assert.equal(got.body.includes(USER), false);
  assert.deepEqual(got.redacted, ["sync.path_redacted"]);
  const findings = (got.batch.host as { doctor: { findings: { code: string; severity: string }[] } }).doctor.findings;
  assert.deepEqual(findings, [{ code: "sync.path_redacted", severity: "info" }]);
});

test("projectLocalPath normalizes without resolving anything", () => {
  assert.deepEqual(projectLocalPath(`${HOME}/projects/agentmbx/`, HOME, USER, false), { local_path: "projects/agentmbx" });
  assert.deepEqual(projectLocalPath(`${HOME}/projects/link`, HOME, USER, false), { local_path: "projects/link" });
  assert.deepEqual(projectLocalPath(HOME, HOME, USER, false), { omit: "sync.path_redacted" });
  assert.deepEqual(projectLocalPath(`/opt/data/repo`, HOME, USER, false), { local_path: "/opt/data/repo" });
  assert.deepEqual(projectLocalPath(`C:/opt/data/repo`, `C:/Users/${USER}`, USER, true), { local_path: "C:/opt/data/repo" });
  assert.deepEqual(projectLocalPath(`/opt/${USER}/repo`, HOME, USER, false), { omit: "sync.path_redacted" });
  assert.deepEqual(projectLocalPath(`${"a".repeat(513)}`, HOME, USER, false), { omit: "sync.path_redacted" });
  const winHome = `C:/Users/${USER}`;
  assert.deepEqual(projectLocalPath(`\\\\?\\C:\\Users\\${USER}\\projects\\agentmbx\\`, winHome, USER, true), { local_path: "projects/agentmbx" });
  assert.deepEqual(projectLocalPath(`C:/Users/${USER.toUpperCase()}/projects/agentmbx`, winHome, USER, true), { local_path: "projects/agentmbx" });
});

test("a keyed subject hash is kept and an unkeyed one becomes null", () => {
  const got = projectSync(snap({ threads: [thread({ subject_hash: HASH })] }));
  assert.equal(got.ok, true);
  if (!got.ok) return;
  assert.equal((got.batch.threads as { upsert: { subject_hash: string }[] }).upsert[0].subject_hash, HASH);
});

test("over cap fails closed and receipts page instead of splitting", () => {
  for (const [key, n] of [["agents", CAPS.agents + 1], ["threads", CAPS.threads + 1], ["policies", CAPS.policies + 1], ["approvals", CAPS.approvals + 1]] as const) {
    const got = projectSync(snap({ [key]: Array.from({ length: n }, () => ({})) }));
    assert.equal(got.ok, false, key);
    if (!got.ok) assert.equal(got.code, "sync.cap");
  }
  const receipts = Array.from({ length: CAPS.receipts + 1 }, (_, i) => receipt({ message_id: ulid(1_700_000_000_000 + i), thread_id: ulid(1_700_000_000_000 + i) }));
  const page = projectSync(snap({ receipts }));
  assert.equal(page.ok, true);
  if (!page.ok) return;
  assert.equal((page.batch.receipts as { append: unknown[] }).append.length, CAPS.receipts);
  const rest = projectSync(snap({ receipts, sentReceipts: page.receiptKeys }));
  assert.equal(rest.ok, true);
  if (rest.ok) assert.equal((rest.batch.receipts as { append: unknown[] }).append.length, 1);
});

test("an already-acked receipt is not appended and a delta omits the replace sets", () => {
  const row = receipt();
  const again = projectSync(snap({ receipts: [row], sentReceipts: [`${row.message_id}\n${row.to}\n${row.state}\n${row.at}`] }));
  assert.equal(again.ok, true);
  if (again.ok) assert.equal(again.batch.receipts, undefined);
  const delta = projectSync(snap({ full: false, agents: [agent()] }));
  assert.equal(delta.ok, true);
  if (!delta.ok) return;
  assert.equal(delta.batch.agents, undefined);
  assert.equal(delta.batch.full, false);
  assert.ok(delta.batch.host);
});

test("a projected batch that still contains an absolute path is withheld", () => {
  const absolute = `${HOME}/projects/repo`;
  const got = projectSync(snap({ host: { ...host(), daemon_version: absolute }, paths: [pathOf(absolute)] }));
  assert.deepEqual(got, { ok: false, code: "sync.withheld" });
});

test("a policy keeps project keys and drops nothing the loader already removed", () => {
  const policy: PolicyInput = {
    policy_id: "01ARZ3NDEKTSV4RRFFQ69G5FAV", level: "collaborate", classes: ["read", "edit"],
    to: { agents: ["worker"], hosts: ["alpha"] }, from: { agents: ["*"], hosts: ["local"] },
    project_keys: [KEY, `${HOME}/secret`], has_local_scope: true, issued_at: "2026-10-05T00:00:00.000Z", expires_at: "2026-10-12T00:00:00.000Z",
    owner_fp: "abcd-ef01-2345-6789", source: "cli", command_id: null, state: "active", provisional: false,
  };
  const got = projectSync(snap({ policies: [policy] }));
  assert.equal(got.ok, true);
  if (!got.ok) return;
  const rows = (got.batch.policies as { upsert: { project_keys: string[]; has_local_scope: boolean }[] }).upsert;
  assert.deepEqual(rows[0].project_keys, [KEY]);
  assert.equal(rows[0].has_local_scope, true);
  assert.equal(got.body.includes(HOME), false);
});
