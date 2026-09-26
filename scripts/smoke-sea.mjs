#!/usr/bin/env node
// Smoke-test a built single executable: node scripts/smoke-sea.mjs build/agentmbx-<platform>-<arch>
// Runs version, init, send, inbox (exercises node:sqlite inside the SEA) and an MCP initialize + tools/list +
// mbx_whoami over stdio, all against a throwaway MBX_HOME. Exits non-zero on the first failure.
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const bin = resolve(process.argv[2] ?? `build/agentmbx-${process.platform}-${process.arch}`);
const home = mkdtempSync(join(tmpdir(), "agentmbx-smoke-"));
const env = { ...process.env, MBX_HOME: home, MBX_NO_DESKTOP: "1", MBX_NO_UPDATE_CHECK: "1" };
const run = (...args) => execFileSync(bin, args, { env, encoding: "utf8" }).trim();
const check = (cond, what) => { if (!cond) throw new Error(`smoke failed: ${what}`); console.log(`ok  ${what}`); };

try {
  const v = run("version");
  check(/^agentmbx \d+\.\d+\.\d+\S* \(sea,/.test(v), `version reports a SEA build: ${v}`);
  check(run("init", "--host", "smoke").includes("host: smoke"), "init");
  const id = run("send", "--as", "alice", "--to", "bob", "--subject", "smoke test", "-m", "hi");
  check(/^[0-9A-Z]{26}$/.test(id), `send -> ${id}`);
  check(run("inbox", "--as", "bob").includes("smoke test"), "inbox (node:sqlite inside SEA)");

  const child = spawn(bin, ["mcp"], { env: { ...env, MBX_AGENT: "smoker", MBX_CLI: "claude" }, stdio: ["pipe", "pipe", "inherit"] });
  let buf = ""; const waiting = new Map();
  child.stdout.on("data", (d) => {
    buf += d; let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      const msg = JSON.parse(line); waiting.get(msg.id)?.(msg); waiting.delete(msg.id);
    }
  });
  let next = 1;
  const rpc = (method, params) => new Promise((res, rej) => {
    const id = next++; const t = setTimeout(() => rej(new Error(`MCP ${method} timed out`)), 15_000);
    waiting.set(id, (m) => { clearTimeout(t); m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result); });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
  const init = await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "smoke", version: "1" } });
  check(init.serverInfo?.name === "mbx", `MCP initialize (server ${init.serverInfo?.name} ${init.serverInfo?.version})`);
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
  const tools = (await rpc("tools/list", {})).tools.map((t) => t.name);
  check(tools.includes("mbx_send") && tools.includes("mbx_whoami"), `MCP tools/list (${tools.length} tools)`);
  const who = await rpc("tools/call", { name: "mbx_whoami", arguments: {} });
  check(who.structuredContent?.address === "smoker@smoke", `MCP mbx_whoami -> ${who.structuredContent?.address}`);
  child.kill();
  console.log("SEA smoke test passed");
} finally { rmSync(home, { recursive: true, force: true }); }
