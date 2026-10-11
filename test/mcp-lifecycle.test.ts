// T317: repeated in-place reloads must not leave a chain of nested MCP processes.
// Exec replacement keeps the PID and client pipe. Unsupported runtimes retain the bounded legacy proxy.
import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, cpSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { MbxNode } from "../src/node.ts";
import { inspectLeaseProcess } from "../src/identity-leases.ts";
import { psEvidenceTable } from "../src/proc.ts";
import { execFileSync } from "node:child_process";

const RELOADS = 3;

const countLiveMcpProcesses = (install: string) => {
  const lines = String(execFileSync("/bin/ps", ["-eo", "pid,args"])).split("\n");
  return lines.filter(l => l.includes(join(install, "bin/agentmbx.js")) && l.includes(" mcp")).length;
};

for (const forceLegacy of [false, true]) test(`after ${RELOADS} reloads ${forceLegacy ? "unsupported exec retains only proxy and server" : "exec leaves one MCP"}`, async t => {
  const execSupported = !forceLegacy && typeof process.execve === "function";
  const root = mkdtempSync(join(tmpdir(), "mbx-lifecycle-")), install = join(root, "install"), home = join(root, "mail");
  mkdirSync(install);
  for (const path of ["bin", "dist", "package.json"]) cpSync(resolve(path), join(install, path), { recursive: true });
  // Model a build-change trigger: the running mcp.js is missing a tool and will be replaced.
  const mcpPath = join(install, "dist/mcp.js"), currentMcp = readFileSync(mcpPath, "utf8");
  const start = currentMcp.indexOf('server.registerTool("mbx_replay",');
  const end = currentMcp.indexOf('server.registerTool("mbx_ack",', start);
  assert.ok(start >= 0 && end > start, "fixture must remove exactly the replay registration");
  writeFileSync(mcpPath, currentMcp.slice(0, start) + currentMcp.slice(end));
  symlinkSync(resolve("node_modules"), join(install, "node_modules"), "dir");

  const node = new MbxNode(home, { host: "alpha" }), client = new Client({ name: "lifecycle-test", version: "1" });
  t.after(async () => { await client.close().catch(() => {}); node.close(); rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });

  const env: NodeJS.ProcessEnv = { ...process.env, MBX_HOME: home, MBX_AGENT: "lifecycle-reader", MBX_CLI: "claude", MBX_NO_DESKTOP: "1" };
  delete env.AGENTMBX_DEV;
  delete env.MBX_MCP_REEXEC;
  delete env.MBX_MCP_REEXEC_BUILD;
  delete env.MBX_MCP_DETACHED;
  delete env.MBX_MCP_PROVIDER_PID;
  if (forceLegacy) {
    const preload = join(root, "unsupported-exec.mjs"); writeFileSync(preload, "process.execve = undefined;");
    env.NODE_OPTIONS = `${env.NODE_OPTIONS ?? ""} --import=${preload}`;
  }

  const transport = new StdioClientTransport({ command: process.execPath, args: [join(install, "bin/agentmbx.js"), "mcp"], env: env as Record<string, string>, stderr: "pipe" });
  const stderrLines: string[] = [];
  (transport as unknown as { stderr: { on: (ev: string, cb: (d: unknown) => void) => void } }).stderr.on("data", d => stderrLines.push(String(d)));
  await client.connect(transport);
  assert.notEqual((await client.callTool({ name: "mbx_whoami", arguments: { name: "lifecycle-reader", role: "builder" } })).isError, true);

  const holderPids: number[] = [], holderTokens: string[] = [];
  const pushHolderPid = () => {
    const row = node.store.db.prepare("SELECT holder_pid,token FROM identity_leases WHERE name=?").get("lifecycle-reader") as { holder_pid: number; token: string } | undefined;
    assert.ok(row, "lease row must exist");
    if (holderTokens.length) assert.notEqual(row.token, holderTokens[holderTokens.length - 1], "reload must acquire a fresh lease token");
    holderPids.push(row.holder_pid); holderTokens.push(row.token);
  };
  pushHolderPid();

  for (let generation = 1; generation <= RELOADS; generation++) {
    // Restore the missing tool so the replacement can serve it; append a no-op to cli.js so the
    // code fingerprint changes and a handover is triggered.
    if (generation === 1) writeFileSync(mcpPath, currentMcp);
    appendFileSync(join(install, "dist/cli.js"), `\n// deployed build ${generation}\n`);
    assert.notEqual((await client.callTool({ name: "mbx_whoami", arguments: {} })).isError, true, "trigger call must finish");

    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const row = node.store.db.prepare("SELECT holder_pid, token, released_at FROM identity_leases WHERE name=?").get("lifecycle-reader") as { holder_pid: number; token: string; released_at: string | null } | undefined;
      if (row && row.token !== holderTokens[holderTokens.length - 1] && row.released_at === null) break;
      await new Promise(r => setTimeout(r, 25));
    }
    pushHolderPid();

    // The original proxy (generation 1) stays on its transport; every re-exec generation in between
    // must have exited once it spawned its replacement. No N+1 chain. ps evidence is cached for up to 1 s,
    // so refresh it explicitly and retry briefly while the exited generation is reaped by its parent.
    const waitForDead = (pid: number, label: string) => {
      const deadline = Date.now() + 2_000;
      while (Date.now() < deadline) {
        psEvidenceTable(0);
        const evidence = inspectLeaseProcess(pid);
        if (evidence.alive !== true) return;
      }
      assert.fail(`${label} pid ${pid} must not still be alive (stderr: ${stderrLines.join(" | ")})`);
    };
    for (let i = 1; !execSupported && i < holderPids.length - 1; i++) {
      waitForDead(holderPids[i], `re-exec generation ${i + 1}`);
    }

    // The current generation is the only live lease-holding MCP process. ps evidence is cached for up to
    // 1 s, so refresh it explicitly and retry briefly while the new generation is fully started.
    const current = holderPids[holderPids.length - 1];
    let evidence = inspectLeaseProcess(current);
    for (let i = 0; i < 20 && evidence.alive !== true; i++) {
      await new Promise(r => setTimeout(r, 100));
      psEvidenceTable(0);
      evidence = inspectLeaseProcess(current);
    }
    if (evidence.alive !== true) {
      assert.fail(`current generation ${holderPids.length} pid ${current} must be alive (evidence=${JSON.stringify(evidence)}; stderr: ${stderrLines.join(" | ")})`);
    }

    const live = countLiveMcpProcesses(install);
    if (execSupported) {
      assert.equal(current, holderPids[0], "exec preserves the original provider-launched PID");
      assert.equal(live, 1, `expected one MCP after reload ${generation}; stderr: ${stderrLines.join(" | ")}`);
    } else assert.ok(live <= 2, "unsupported exec retains only the original proxy plus current server");
  }

  // Sanity: the final server can still serve.
  assert.notEqual((await client.callTool({ name: "mbx_inbox", arguments: {} })).isError, true);
  if (forceLegacy) assert.match(stderrLines.join(""), /exec replacement unavailable; using legacy spawn handover/);
});

// T449: after reloads, closing the provider transport must stop the original proxy too. The T317 keep-alive
// waited on stdin.once("end"), but stdin is paused during handover and never emits "end", leaking the proxy.
test("closing stdin stops every MCP process after 2 reloads", async t => {
  const root = mkdtempSync(join(tmpdir(), "mbx-lifecycle-eof-")), install = join(root, "install"), home = join(root, "mail");
  mkdirSync(install);
  for (const path of ["bin", "dist", "package.json"]) cpSync(resolve(path), join(install, path), { recursive: true });
  const mcpPath = join(install, "dist/mcp.js"), currentMcp = readFileSync(mcpPath, "utf8");
  const start = currentMcp.indexOf('server.registerTool("mbx_replay",');
  const end = currentMcp.indexOf('server.registerTool("mbx_ack",', start);
  assert.ok(start >= 0 && end > start, "fixture must remove exactly the replay registration");
  writeFileSync(mcpPath, currentMcp.slice(0, start) + currentMcp.slice(end));
  symlinkSync(resolve("node_modules"), join(install, "node_modules"), "dir");

  const node = new MbxNode(home, { host: "alpha" }), client = new Client({ name: "lifecycle-eof", version: "1" });
  t.after(async () => { await client.close().catch(() => {}); node.close(); rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });

  const env: NodeJS.ProcessEnv = { ...process.env, MBX_HOME: home, MBX_AGENT: "eof-reader", MBX_CLI: "claude", MBX_NO_DESKTOP: "1" };
  delete env.AGENTMBX_DEV; delete env.MBX_MCP_REEXEC; delete env.MBX_MCP_REEXEC_BUILD; delete env.MBX_MCP_DETACHED; delete env.MBX_MCP_PROVIDER_PID;

  const transport = new StdioClientTransport({ command: process.execPath, args: [join(install, "bin/agentmbx.js"), "mcp"], env: env as Record<string, string>, stderr: "pipe" });
  const stderrLines: string[] = [];
  (transport as unknown as { stderr: { on: (ev: string, cb: (d: unknown) => void) => void } }).stderr.on("data", d => stderrLines.push(String(d)));
  await client.connect(transport);
  assert.notEqual((await client.callTool({ name: "mbx_whoami", arguments: { name: "eof-reader", role: "builder" } })).isError, true);

  const holderPids: number[] = [], holderTokens: string[] = [];
  const pushHolderPid = () => {
    const row = node.store.db.prepare("SELECT holder_pid,token FROM identity_leases WHERE name=?").get("eof-reader") as { holder_pid: number; token: string } | undefined;
    assert.ok(row, "lease row must exist");
    if (holderTokens.length) assert.notEqual(row.token, holderTokens[holderTokens.length - 1], "reload must acquire a fresh lease token");
    holderPids.push(row.holder_pid); holderTokens.push(row.token);
  };
  pushHolderPid();

  for (let generation = 1; generation <= 2; generation++) {
    if (generation === 1) writeFileSync(mcpPath, currentMcp);
    appendFileSync(join(install, "dist/cli.js"), `\n// deployed build ${generation}\n`);
    assert.notEqual((await client.callTool({ name: "mbx_whoami", arguments: {} })).isError, true, "trigger call must finish");
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const row = node.store.db.prepare("SELECT holder_pid, token, released_at FROM identity_leases WHERE name=?").get("eof-reader") as { holder_pid: number; token: string; released_at: string | null } | undefined;
      if (row && row.token !== holderTokens[holderTokens.length - 1] && row.released_at === null) break;
      await new Promise(r => setTimeout(r, 25));
    }
    pushHolderPid();
  }

  // Close the provider transport: stdin EOF for the whole process tree.
  await client.close();

  // Every MCP process for this session must exit within the deadline: the original proxy watches the
  // generation record and exits when the current generation dies on EOF.
  const deadline = Date.now() + 15_000;
  let live = countLiveMcpProcesses(install);
  while (live > 0 && Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 250));
    live = countLiveMcpProcesses(install);
  }
  assert.equal(live, 0, `expected zero live MCP processes after stdin close, found ${live} (pids=${holderPids.join(",")}; stderr: ${stderrLines.join(" | ")})`);
});

// T449: when the current generation crashes, the original proxy must exit so the provider sees the transport
// close instead of hanging on a dead session.
test("a crashed current generation closes the provider transport", async t => {
  const root = mkdtempSync(join(tmpdir(), "mbx-lifecycle-crash-")), install = join(root, "install"), home = join(root, "mail");
  mkdirSync(install);
  for (const path of ["bin", "dist", "package.json"]) cpSync(resolve(path), join(install, path), { recursive: true });
  const mcpPath = join(install, "dist/mcp.js"), currentMcp = readFileSync(mcpPath, "utf8");
  const start = currentMcp.indexOf('server.registerTool("mbx_replay",');
  const end = currentMcp.indexOf('server.registerTool("mbx_ack",', start);
  assert.ok(start >= 0 && end > start, "fixture must remove exactly the replay registration");
  writeFileSync(mcpPath, currentMcp.slice(0, start) + currentMcp.slice(end));
  symlinkSync(resolve("node_modules"), join(install, "node_modules"), "dir");

  const node = new MbxNode(home, { host: "alpha" }), client = new Client({ name: "lifecycle-crash", version: "1" });
  t.after(async () => { await client.close().catch(() => {}); node.close(); rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });

  const env: NodeJS.ProcessEnv = { ...process.env, MBX_HOME: home, MBX_AGENT: "crash-reader", MBX_CLI: "claude", MBX_NO_DESKTOP: "1" };
  delete env.AGENTMBX_DEV; delete env.MBX_MCP_REEXEC; delete env.MBX_MCP_REEXEC_BUILD; delete env.MBX_MCP_DETACHED; delete env.MBX_MCP_PROVIDER_PID;

  const transport = new StdioClientTransport({ command: process.execPath, args: [join(install, "bin/agentmbx.js"), "mcp"], env: env as Record<string, string>, stderr: "pipe" });
  const stderrLines: string[] = [];
  (transport as unknown as { stderr: { on: (ev: string, cb: (d: unknown) => void) => void } }).stderr.on("data", d => stderrLines.push(String(d)));
  await client.connect(transport);
  assert.notEqual((await client.callTool({ name: "mbx_whoami", arguments: { name: "crash-reader", role: "builder" } })).isError, true);

  const holderPids: number[] = [], holderTokens: string[] = [];
  const pushHolderPid = () => {
    const row = node.store.db.prepare("SELECT holder_pid,token FROM identity_leases WHERE name=?").get("crash-reader") as { holder_pid: number; token: string } | undefined;
    assert.ok(row, "lease row must exist");
    if (holderTokens.length) assert.notEqual(row.token, holderTokens[holderTokens.length - 1], "reload must acquire a fresh lease token");
    holderPids.push(row.holder_pid); holderTokens.push(row.token);
  };
  pushHolderPid();

  // One reload.
  writeFileSync(mcpPath, currentMcp);
  appendFileSync(join(install, "dist/cli.js"), `\n// deployed build 1\n`);
  assert.notEqual((await client.callTool({ name: "mbx_whoami", arguments: {} })).isError, true, "trigger call must finish");
  const reloadDeadline = Date.now() + 10_000;
  while (Date.now() < reloadDeadline) {
    const row = node.store.db.prepare("SELECT holder_pid, token, released_at FROM identity_leases WHERE name=?").get("crash-reader") as { holder_pid: number; token: string; released_at: string | null } | undefined;
    if (row && row.token !== holderTokens[holderTokens.length - 1] && row.released_at === null) break;
    await new Promise(r => setTimeout(r, 25));
  }
  pushHolderPid();

  // Crash the current generation (SIGKILL, never the graceful path).
  const current = holderPids[holderPids.length - 1];
  process.kill(current, "SIGKILL");

  // The original proxy must exit and the transport must close. The client sees the close.
  const closePromise = new Promise<void>(resolve => {
    (transport as unknown as { onclose?: () => void }).onclose = () => resolve();
    setTimeout(resolve, 15_000);
  });
  await closePromise;

  // No MCP processes remain for this session.
  const deadline = Date.now() + 10_000;
  let live = countLiveMcpProcesses(install);
  while (live > 0 && Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 250));
    live = countLiveMcpProcesses(install);
  }
  assert.equal(live, 0, `expected zero live MCP processes after current-generation crash, found ${live} (pids=${holderPids.join(",")}; stderr: ${stderrLines.join(" | ")})`);
});
