import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const BIN = join(import.meta.dirname, "../bin/agentmbx.js");
const sdk = new URL("../node_modules/@modelcontextprotocol/sdk/dist/esm/server/mcp.js", import.meta.url).href;
const message = "T556 injected startup connection failure";

for (const dev of [true, false]) for (const connected of [false, true])
  test(`${dev ? "source" : "dist"} launcher exits after ${connected ? "partially connected" : "early"} MCP startup failure`, async t => {
    const root = mkdtempSync(join(tmpdir(), "mbx-startup-error-")), home = join(root, "mail"), preload = join(root, "fail-connect.mjs");
    writeFileSync(preload, `import { McpServer } from ${JSON.stringify(sdk)};
      const connect = McpServer.prototype.connect;
      McpServer.prototype.connect = async function(transport) {
        ${connected ? "await connect.call(this, transport);" : ""}
        throw new Error(${JSON.stringify(message)});
      };`);
    const env: NodeJS.ProcessEnv = { ...process.env, AGENTMBX_DEV: dev ? "1" : "", MBX_HOME: home,
      MBX_AGENT: "startup-error", MBX_CLI: "codex", MBX_NO_DESKTOP: "1", MBX_SESSION_SOCKET: "0", MBX_DEBUG: "" };
    for (const key of Object.keys(env)) if (/^(?:CLAUDE_|CODEX_|CLEO_|ORCA_|MBX_MCP_|MBX_CHANNEL|NODE_OPTIONS)/.test(key)) delete env[key];
    const child = spawn(process.execPath, ["--import", preload, BIN, "mcp"], { env });
    let stderr = "";
    child.stderr.on("data", data => { stderr += data; });
    child.stdout.resume();
    child.stdin.on("error", () => {});
    const exited = new Promise<void>((resolve, reject) => {
      child.once("error", reject); child.once("close", () => resolve());
    });
    t.after(async () => {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await exited;
      rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    });
    const readyDeadline = Date.now() + 15_000;
    while (!stderr.includes(message) && child.exitCode === null && child.signalCode === null && Date.now() < readyDeadline)
      await new Promise(resolve => setTimeout(resolve, 25));
    assert.match(stderr, new RegExp(message), "the actual CLI catch must receive the injected failure");
    // Keep the provider pipe open: EOF must not hide a startup lifetime leak.
    let timeout!: ReturnType<typeof setTimeout>;
    await Promise.race([exited, new Promise<void>(resolve => { timeout = setTimeout(resolve, 5000); })]);
    clearTimeout(timeout);
    t.diagnostic(JSON.stringify({ pid: child.pid, code: child.exitCode, signal: child.signalCode, stderr }));
    assert.equal(child.exitCode, 1, "failed startup must exit within 5s of its diagnostic");
    assert.equal(child.signalCode, null, "exit must be natural, without fixture cleanup");
    assert.throws(() => process.kill(child.pid!, 0), { code: "ESRCH" }, "no launcher process remains");
    assert.equal(stderr.split("\n").filter(line => line.includes(message)).length, 1, "the CLI reports the original error once");
    const lines = readFileSync(join(home, "mcp-errors.log"), "utf8").trimEnd().split("\n");
    assert.equal(lines.length, 1, "startup logging records the original error once");
    assert.match(lines[0], /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z /);
    assert.deepEqual(JSON.parse(lines[0].slice(25)), { pid: child.pid, cli: "codex", error: message });
  });
