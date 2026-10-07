// T481: one OpenCode session id, two serve processes. Force takeover recovers the other serve and still refuses the same one.
import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { canonical, generateKeyPair, signData } from "../src/crypto.ts";
import { foreignSessionProvider } from "../src/doctor.ts";
import { publishIdentityControl, type IdentityControlDescriptor } from "../src/identity-control.ts";
import { IdentityLeases, inspectLeaseProcess } from "../src/identity-leases.ts";
import { applyIdentityTakeover, buildIdentityTakeover, refuseSelfTakeover } from "../src/identity-takeover.ts";
import { MbxNode } from "../src/node.ts";
import { opencodeProviderPid } from "../src/opencode-provider.ts";

interface Serve {
  pid: number;
  nodes: number[];
  child: ChildProcess;
  dir: string;
}

function readLines(child: ChildProcess, count: number): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const out = child.stdout;
    if (!out) return reject(new Error("serve has no stdout"));
    let buf = "";
    const lines: string[] = [];
    const onData = (chunk: Buffer) => {
      buf += chunk.toString("utf8");
      let nl = buf.indexOf("\n");
      while (nl >= 0 && lines.length < count) {
        lines.push(buf.slice(0, nl).trim());
        buf = buf.slice(nl + 1);
        nl = buf.indexOf("\n");
      }
      if (lines.length < count) return;
      out.off("data", onData);
      resolve(lines);
    };
    out.on("data", onData);
    child.once("exit", () => reject(new Error(`serve exited before it named its nodes: ${buf}`)));
  });
}

const SERVE_C = `#include <stdio.h>
#include <stdlib.h>
#include <unistd.h>
int main(int argc, char **argv) {
  int n = argc > 1 ? atoi(argv[1]) : 1;
  for (int i = 0; i < n; i++) {
    pid_t pid = fork();
    if (pid < 0) return 1;
    if (pid == 0) {
      execlp("node", "node", "-e", "setTimeout(() => {}, 120000)", (char *)0);
      _exit(1);
    }
    printf("%d\\n", (int)pid);
    fflush(stdout);
  }
  for (;;) pause();
}
`;

async function serve(root: string, nodes: number): Promise<Serve> {
  const dir = mkdtempSync(join(root, "serve-"));
  const source = join(dir, "serve.c");
  const bin = join(dir, "opencode");
  writeFileSync(source, SERVE_C);
  const built = spawnSync("cc", ["-o", bin, source], { encoding: "utf8" });
  assert.equal(built.status, 0, built.stderr);
  const child = spawn(bin, [String(nodes)], { stdio: ["ignore", "pipe", "pipe"] });
  const pids = (await readLines(child, nodes)).map(Number);
  assert.ok(child.pid);
  return { pid: child.pid, nodes: pids, child, dir };
}

function stop(row: Serve): void {
  for (const pid of [row.pid, ...row.nodes]) { try { process.kill(pid, "SIGTERM"); } catch { /* already gone */ } }
  rmSync(row.dir, { recursive: true, force: true });
}

function descriptor(session: string, mcp: number, parent: number, key: string): IdentityControlDescriptor {
  const mcpStart = inspectLeaseProcess(mcp).start;
  const parentStart = inspectLeaseProcess(parent).start;
  assert.ok(mcpStart && parentStart);
  return {
    v: 1, cli: "opencode", session_id: session, lease_session_id: session, generation: null, agent: "",
    control_key: key, mcp_pid: mcp, mcp_start: mcpStart, parent_pid: parent, parent_start: parentStart,
  };
}

test("T481 force takeover recovers another OpenCode serve and still refuses the same one", async () => {
  const root = mkdtempSync(join(tmpdir(), "mbx-t481-"));
  const home = join(root, "home");
  const owner = generateKeyPair();
  const node = new MbxNode(home);
  writeFileSync(join(home, "owner.json"), JSON.stringify({ v: 1, backend: "keychain", public_key: owner.publicKey }), { mode: 0o600 });
  const held = await serve(root, 2);
  const other = await serve(root, 1);
  try {
    assert.equal(opencodeProviderPid(held.nodes[0]), held.pid);
    assert.equal(opencodeProviderPid(held.nodes[1]), held.pid);
    assert.equal(opencodeProviderPid(other.nodes[0]), other.pid);
    assert.notEqual(held.pid, other.pid);
    const session = "ses_t481split";
    const holder = inspectLeaseProcess(held.nodes[0]);
    assert.ok(holder.start);
    const leases = new IdentityLeases(node.store);
    leases.claim("split-reader", { pid: held.nodes[0], start: holder.start, keyFp: "aaaa-bbbb-cccc-dddd", cli: "opencode", sessionId: session });
    node.store.db.prepare("UPDATE identity_leases SET heartbeat_at=? WHERE name=?").run(Date.now() - 10 * 60 * 1000, "split-reader");
    const same = descriptor(session, held.nodes[1], held.pid, "bbbb-cccc-dddd-eeee");
    const row = node.store.db.prepare("SELECT * FROM identity_leases WHERE name=?").get("split-reader") as unknown as Parameters<typeof refuseSelfTakeover>[0];
    assert.throws(() => refuseSelfTakeover(row, same), /your own live session MCP/);
    const mine = descriptor(session, other.nodes[0], other.pid, "cccc-dddd-eeee-ffff");
    const built = buildIdentityTakeover(node, mine, "split-reader");
    assert.equal(built.previous.pid, held.nodes[0]);
    assert.equal(built.claimant_session, session);
    publishIdentityControl(node.store, mine);
    const found = foreignSessionProvider(node);
    assert.equal(found.length, 1);
    assert.match(found[0]!.label, new RegExp(`opencode session ${session} is leased by pid ${held.nodes[0]} under provider ${held.pid}`));
    assert.match(found[0]!.label, /last activity \d{4}-\d{2}-\d{2}T/);
    assert.match(found[0]!.label, new RegExp(`control endpoint is pid ${other.nodes[0]} under provider ${other.pid}`));
    assert.equal(found[0]!.fix, `agentmbx identity takeover --force split-reader --cli opencode --session ${session}`);
    leases.prepare(["split-reader"], [mine.mcp_pid, held.nodes[0]], () => applyIdentityTakeover(node, leases, { payload: built, sig: signData(owner.privateKey, canonical(built)) }, mine, () => {
      leases.claim("split-reader", { pid: mine.mcp_pid, start: mine.mcp_start, keyFp: mine.control_key, cli: "opencode", sessionId: session });
    }));
    const after = node.store.db.prepare("SELECT holder_pid, session_id FROM identity_leases WHERE name=?").get("split-reader") as { holder_pid: number; session_id: string };
    assert.equal(after.holder_pid, other.nodes[0]);
    assert.equal(after.session_id, session);
    assert.equal(foreignSessionProvider(node).length, 0);
  } finally {
    node.close();
    stop(held);
    stop(other);
    rmSync(root, { recursive: true, force: true });
  }
});
