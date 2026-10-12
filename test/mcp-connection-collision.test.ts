// T564: macOS stdio sockets report dev -1 and an inode that live, separate connections can share. The T488 duplicate-reader
// exclusion must not make such a connection's MCP exit; only the same kernel sockets (lsof addresses) are a duplicate.
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { _resetConnectionConfirmationsForTests, claimMcpConnection, connectionSeams } from "../src/mcp-lifecycle.ts";
import { inspectLeaseProcess } from "../src/identity-leases.ts";

const ENDPOINT = "darwin:-1:12045323:49152|-1:12045324:49152";
const keyPath = (home: string, endpoint: string) => join(home, "mcp-connections", createHash("sha256").update(endpoint).digest("hex"));

function world(t: TestContext, endpoint = ENDPOINT) {
  const home = mkdtempSync(join(tmpdir(), "mbx-t564-")), children: ReturnType<typeof spawn>[] = [];
  const saved = { endpoint: connectionSeams.endpoint, addresses: connectionSeams.addresses };
  t.after(() => {
    Object.assign(connectionSeams, saved);
    _resetConnectionConfirmationsForTests();
    for (const c of children) c.kill("SIGKILL");
    rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  _resetConnectionConfirmationsForTests();
  connectionSeams.endpoint = () => endpoint;
  const calls: number[][] = [];
  let table: Map<number, string> | null = null;
  connectionSeams.addresses = pids => { calls.push(pids); return table; };
  /** A live process that owns `endpoint`'s key, as another MCP server would. */
  const owner = (key = endpoint) => {
    const child = spawn("sleep", ["600"], { stdio: "ignore" }); children.push(child);
    const start = inspectLeaseProcess(child.pid!).start!;
    mkdirSync(join(home, "mcp-connections"), { recursive: true });
    writeFileSync(keyPath(home, key), JSON.stringify({ pid: child.pid, start }));
    return child.pid!;
  };
  return { home, calls, owner, addresses: (m: Record<number, string> | null) => { table = m && new Map(Object.entries(m).map(([k, v]) => [Number(k), v])); } };
}
const ownerOf = (path: string) => JSON.parse(readFileSync(path, "utf8")).pid as number;

test("T564 a different connection whose fstat key collides is held on its own address key, not refused", t => {
  const w = world(t), a = w.owner();
  w.addresses({ [process.pid]: "0xbbb,0xccc", [a]: "0xaaa,0xddd" });
  const claim = claimMcpConnection(w.home);
  assert.equal(claim.state, "held", JSON.stringify(claim));
  assert.deepEqual(w.calls, [[process.pid, a]], "one lsof for the two processes");
  assert.equal(ownerOf(keyPath(w.home, ENDPOINT)), a, "the colliding owner keeps its key");
  const own = keyPath(w.home, `${ENDPOINT}|lsof:0xbbb,0xccc`);
  assert.equal(ownerOf(own), process.pid);
  if (claim.state === "held") claim.release();
  assert.equal(existsSync(own), false, "release removes only this process's key");
  assert.equal(ownerOf(keyPath(w.home, ENDPOINT)), a);
});

test("T564 the same kernel sockets are still a duplicate reader (T488)", t => {
  const w = world(t), a = w.owner();
  w.addresses({ [process.pid]: "0xaaa,0xddd", [a]: "0xaaa,0xddd" });
  assert.deepEqual(claimMcpConnection(w.home), { state: "duplicate", pid: a });
  assert.deepEqual(claimMcpConnection(w.home), { state: "duplicate", pid: a });
  assert.equal(w.calls.length, 1, "a live owner's addresses are read once, then reused by the handover retry loop");
});

test("T564 unreadable lsof evidence keeps serving instead of refusing a possibly legitimate client", t => {
  const w = world(t), a = w.owner();
  w.addresses(null);
  assert.deepEqual(claimMcpConnection(w.home), { state: "unknown" });
  w.addresses({ [process.pid]: "0xaaa,0xddd" });
  _resetConnectionConfirmationsForTests();
  assert.deepEqual(claimMcpConnection(w.home), { state: "unknown" }, "the owner's addresses are missing");
  assert.equal(ownerOf(keyPath(w.home, ENDPOINT)), a);
});

test("T564 a true duplicate of a connection on its address key is refused there", t => {
  const w = world(t), a = w.owner(), b = w.owner(`${ENDPOINT}|lsof:0xbbb,0xccc`);
  w.addresses({ [process.pid]: "0xbbb,0xccc", [a]: "0xaaa,0xddd" });
  assert.deepEqual(claimMcpConnection(w.home), { state: "duplicate", pid: b });
});

test("T564 Linux and uncontended keys never run lsof", t => {
  const LINUX = "linux:8:4242:49152|8:4243:49152", linux = world(t, LINUX), a = linux.owner();
  linux.addresses({ [process.pid]: "0xbbb,0xccc", [a]: "0xaaa,0xddd" });
  assert.deepEqual(claimMcpConnection(linux.home), { state: "duplicate", pid: a }, "Linux socket inodes are unique: unchanged");
  assert.equal(linux.calls.length, 0);
  rmSync(join(linux.home, "mcp-connections"), { recursive: true, force: true });
  connectionSeams.endpoint = () => ENDPOINT;
  const claim = claimMcpConnection(linux.home);
  assert.equal(claim.state, "held");
  assert.equal(linux.calls.length, 0, "no collision, no lsof");
  if (claim.state === "held") claim.release();
});

test("T564 lsof parsing yields both stdio addresses per process", { skip: process.platform !== "darwin" }, () => {
  const read = connectionSeams.addresses([process.pid]);
  // node --test children run with piped stdio, so both fds have kernel addresses.
  assert.match(read?.get(process.pid) ?? "", /^0x[0-9a-f]+,0x[0-9a-f]+$/i);
  assert.equal(connectionSeams.addresses([process.pid, 2147483646]), null, "a missing process is unreadable, not a match");
});

// Opt-in: the real claim path under concurrency. Before T564, ~15% of 20-connection rounds on macOS refused a live, distinct
// connection as a duplicate. MBX_COLLISION_STRESS=1 [MBX_COLLISION_ROUNDS=40].
test("T564 stress: concurrent distinct connections are never refused as duplicates", { skip: process.env.MBX_COLLISION_STRESS !== "1", timeout: 600_000 }, async t => {
  const lifecycle = pathToFileURL(resolve("src/mcp-lifecycle.ts")).href, proc = pathToFileURL(resolve("src/proc.ts")).href;
  const worker = `import {claimMcpConnection} from ${JSON.stringify(lifecycle)}; import {stdioEndpoint} from ${JSON.stringify(proc)};
    const c = claimMcpConnection(process.env.T564_HOME); process.stderr.write(JSON.stringify({pid:process.pid,state:c.state,key:stdioEndpoint()})+"\\n");
    process.stdin.resume(); process.stdin.on("end",()=>process.exit(0));`;
  const provider = `require("node:child_process").spawn(process.execPath,["--input-type=module","-e",${JSON.stringify(worker)}],{stdio:"inherit",env:process.env}).on("exit",c=>process.exit(c??0))`;
  const rounds = Number(process.env.MBX_COLLISION_ROUNDS || 40), width = 20;
  let total = 0, collisions = 0, refused = 0, unknown = 0;
  for (let r = 0; r < rounds; r++) {
    const home = mkdtempSync(join(tmpdir(), "mbx-t564-stress-"));
    const ps = Array.from({ length: width }, () => spawn(process.execPath, ["-e", provider], { stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, T564_HOME: home, AGENTMBX_DEV: "1" } }));
    const outs = await Promise.all(ps.map(p => new Promise<{ state: string; key: string }>(done => {
      let err = ""; p.stderr!.on("data", d => { err += d; if (err.includes("\n")) done(JSON.parse(err.split("\n")[0])); });
    })));
    await Promise.all(ps.map(p => new Promise(done => { p.on("exit", done); p.stdin!.end(); })));
    rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    const keys = new Set<string>();
    for (const o of outs) { total++; if (keys.has(o.key)) collisions++; keys.add(o.key); if (o.state === "duplicate") refused++; if (o.state === "unknown") unknown++; }
  }
  t.diagnostic(`T564 stress: ${total} connections, ${collisions} fstat-key collisions, ${refused} refused as duplicate, ${unknown} unknown`);
  assert.equal(refused, 0);
});
