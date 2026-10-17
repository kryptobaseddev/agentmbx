// T699: one liveness answer on every surface. A released lease whose session still runs is idle (claimable,
// wakeable, seen on its next turn) — never "live" and never "offline". The same rows must produce the same
// token and the same reason in `agentmbx agents`, `mbx_agents` (the roster) and the send receipt.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MbxNode } from "../src/node.ts";
import { procStart } from "../src/proc.ts";
import { inspectLeaseProcess, type ProcessEvidence } from "../src/identity-leases.ts";
import { opencodeHostSeams } from "../src/opencode-provider.ts";
import { resetOpencodeWakeQueue, waitForOpencodeWake } from "../src/opencode-wake-queue.ts";
import { agentDirectoryStates } from "../src/liveness.ts";
import { buildRoster } from "../src/roster.ts";
import { mailboxLiveness, recipientReceipts } from "../src/receipts.ts";

const MIN = 60_000;
const SERVICE_PID = process.pid;
const POLLER_PID = process.ppid;
const DEAD_PID = 2 ** 22 + 4242;
const UNKNOWN_PID = 2 ** 22 + 9999;

interface Fixture {
  name: string;
  pid: number;
  start: string;
  session: string;
  released: number | null;
  row?: { pid: number; start: string };
}

const FIXTURES: Fixture[] = [
  // A verified holder: plainly live. The lease start is the lease layer's ps-utc form (holderStart), not procStart's lstart.
  { name: "held-agent", pid: SERVICE_PID, start: inspectLeaseProcess(SERVICE_PID).start ?? "self", session: "ses_t699_held", released: null },
  // T688: the MCP was evicted, the lease released, but the shared service still hosts the conversation.
  { name: "service-agent", pid: DEAD_PID, start: "gone", session: "ses_t699_service", released: Date.now() - 2 * 60 * MIN,
    row: { pid: SERVICE_PID, start: procStart(SERVICE_PID) ?? "self" } },
  // T659: the same, in a standalone serve whose plugin poll is registered in this process.
  { name: "poller-agent", pid: DEAD_PID, start: "gone", session: "ses_t699_poller", released: Date.now() - 2 * 60 * MIN,
    row: { pid: POLLER_PID, start: procStart(POLLER_PID) ?? "parent" } },
  // Released with no session left at all: genuinely offline.
  { name: "dead-agent", pid: DEAD_PID, start: "gone", session: "ses_t699_dead", released: Date.now() - 2 * 60 * MIN },
  // A holder whose process cannot be verified right now: unknown, never silently live or offline.
  { name: "unknown-agent", pid: UNKNOWN_PID, start: "unreadable", session: "ses_t699_unknown", released: null },
];

const EXPECTED: Record<string, "live" | "idle" | "offline" | "unknown"> = {
  "held-agent": "live",
  "service-agent": "idle",
  "poller-agent": "idle",
  "dead-agent": "offline",
  "unknown-agent": "unknown",
};

test("T699: agents, roster and receipt return the same liveness token and reason for held, released+service, released+poller, released+dead and unknown", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "mbx-t699-"));
  const node = new MbxNode(home, { host: "alpha" });
  const realArgs = opencodeHostSeams.args;
  t.after(() => {
    resetOpencodeWakeQueue();
    opencodeHostSeams.args = realArgs;
    node.close();
    rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  // One argv read for both live serves: the service hosts the service fixture, the standalone one polls.
  opencodeHostSeams.args = () => new Map<number, string[]>([
    [SERVICE_PID, ["/opt/opencode/bin/opencode", "serve", "--service"]],
    [POLLER_PID, ["/opt/opencode/bin/opencode", "serve", "--stdio", "--port", "0"]],
  ]);
  void waitForOpencodeWake("ses_t699_poller", POLLER_PID); // registers the plugin poll: T659's live evidence

  const now = Date.now();
  for (const f of FIXTURES) {
    node.registerAgent(f.name, { cli: "opencode" });
    node.store.db.prepare(`INSERT INTO identity_leases (name,token,holder_pid,holder_start,key_fp,cli,session_id,claimed_at,heartbeat_at,idle_ttl,released_at,release_reason)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(f.name, `tok-${f.name}`, f.pid, f.start, "aaaa-bbbb-cccc-dddd", "opencode", f.session, now, now, 30 * MIN, f.released, f.released === null ? null : "released");
    if (f.row) node.store.db.prepare(`INSERT INTO sessions (agent,cli,session_id,cwd,pid,session_key,channel,updated_at,pid_start)
      VALUES (?,?,?,?,?,?,?,?,?)`).run(f.name, "opencode", f.session, home, f.row.pid, "k", 0, new Date(now).toISOString(), f.row.start);
  }
  const inspect = (pid: number): ProcessEvidence => pid === UNKNOWN_PID ? { alive: null, start: null } : inspectLeaseProcess(pid);
  const opts = { now, inspect };

  const agents = agentDirectoryStates(node, opts);
  const roster = buildRoster(node, { ask: "*", all: true, now, inspect });
  for (const f of FIXTURES) {
    const a = agents.get(f.name), r = roster.agents.find((x) => x.name === f.name), m = mailboxLiveness(node, f.name, now, { inspect });
    assert.ok(a, `${f.name}: the agent list has a row`);
    assert.ok(r, `${f.name}: the roster has a row`);
    assert.equal(a.state, EXPECTED[f.name], `${f.name}: agent list state`);
    assert.equal(r.state, EXPECTED[f.name], `${f.name}: roster state`);
    assert.equal(m.state, EXPECTED[f.name], `${f.name}: receipt state`);
    assert.equal(a.reason, r.reason, `${f.name}: agent list and roster reasons agree`);
    assert.equal(m.reason, r.reason, `${f.name}: receipt and roster reasons agree`);
  }

  // The idle reasons name the evidence, and only the sessions that are actually there are wakeable.
  const service = mailboxLiveness(node, "service-agent", now, { inspect });
  assert.match(service.reason, /released \d{4}-.*opencode session ses_t699_service is still running \(pid \d+, shared service\), so it is idle/);
  assert.equal(service.wakeable, true);
  assert.equal(service.live, true);
  assert.equal(service.released, true);
  const poller = mailboxLiveness(node, "poller-agent", now, { inspect });
  assert.match(poller.reason, /standalone serve/);
  assert.equal(poller.wakeable, true);
  assert.equal(mailboxLiveness(node, "dead-agent", now, { inspect }).live, false);
  assert.equal(mailboxLiveness(node, "held-agent", now, { inspect }).live, true);
  assert.equal(mailboxLiveness(node, "unknown-agent", now, { inspect }).state, "unknown");

  // The receipt itself: an idle service target is not offline; mail waits for (or wakes) its next turn.
  node.registerAgent("sender", { cli: "cli" });
  const sent = node.send({ from: "sender", to: ["service-agent"], kind: "request", subject: "T699", body: "b", needs_reply: true });
  const receipt = recipientReceipts(node, sent.envelope.id, sent.targets, now).find((x) => x.address === "service-agent@alpha");
  assert.ok(receipt, "the receipt addresses the idle service target");
  assert.notEqual(receipt.state, "offline");
  assert.equal(receipt.state, "live-next-prompt", "no owner policy lets this sender wake it, so it waits for the next prompt");
  assert.match(receipt.detail, /still running \(pid \d+, shared service\), so it is idle/);

  const dead = node.send({ from: "sender", to: ["dead-agent"], kind: "request", subject: "T699", body: "b", needs_reply: true });
  const deadReceipt = recipientReceipts(node, dead.envelope.id, dead.targets, now).find((x) => x.address === "dead-agent@alpha");
  assert.equal(deadReceipt?.state, "offline");
});
