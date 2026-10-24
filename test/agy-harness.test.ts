// T725: First-class Antigravity (agy) harness support tests.
// Covers setup/doctor wiring, foreign bundle preservation, hook mapping, statusline, and subagent co-use.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { edits, runSetup, wired, statuslineState, statuslineConfiguredCommand, agyMcpConfigPath, agyHooksConfigPath, agySettingsPath, detect, type SetupCtx } from "../src/setup.ts";
import { doctor, statuslineChecks } from "../src/doctor.ts";
import { agyHookInput, agyHookOutput, agyStopEligible, AGY_WATCHER_INSTRUCTION, AGY_WATCHER_REMINDER } from "../src/agy-hook.ts";
import { selfWatchInstruction } from "../src/mcp.ts";
import { identityAvailability } from "../src/identity-availability.ts";
import { MbxNode, AGY_NO_PUSH } from "../src/node.ts";
import { IdentityLeases } from "../src/identity-leases.ts";

const tmp = () => mkdtempSync(join(tmpdir(), "mbx-agy-test-"));

test("agyHookInput correctly maps conversationId and workspacePaths onto shared contract", () => {
  const mapped = agyHookInput({
    conversationId: "8f14bc5a-ccf7-4285-9fb1-847ee6d4fce2",
    workspacePaths: ["/Users/example/project", "/Users/example/other"],
    customField: 123,
  });
  assert.equal(mapped.session_id, "8f14bc5a-ccf7-4285-9fb1-847ee6d4fce2");
  assert.equal(mapped.cwd, "/Users/example/project");
  assert.equal(mapped.conversationId, "8f14bc5a-ccf7-4285-9fb1-847ee6d4fce2");
  assert.equal(mapped.customField, 123);

  // Does not override explicit session_id or cwd if already present
  const preserved = agyHookInput({
    session_id: "custom-session",
    cwd: "/custom/cwd",
    conversationId: "8f14bc5a-ccf7-4285-9fb1-847ee6d4fce2",
    workspacePaths: ["/Users/example/project"],
  });
  assert.equal(preserved.session_id, "custom-session");
  assert.equal(preserved.cwd, "/custom/cwd");
});

test("agyStopEligible allows only an explicit NO_TOOL_CALL, rejecting a missing reason, cancellation and error stops", () => {
  assert.equal(agyStopEligible({}), false, "protojson omits an enum default: a missing reason may be UNSPECIFIED");
  assert.equal(agyStopEligible({ terminationReason: undefined }), false);
  assert.equal(agyStopEligible({ terminationReason: "NO_TOOL_CALL" }), true);

  assert.equal(agyStopEligible({ terminationReason: "ERROR" }), false);
  assert.equal(agyStopEligible({ terminationReason: "USER_CANCELED" }), false);
  assert.equal(agyStopEligible({ terminationReason: "MAX_INVOCATIONS" }), false);
  assert.equal(agyStopEligible({ terminationReason: "MAX_TOKEN_BUDGET_EXCEEDED" }), false);
  assert.equal(agyStopEligible({ terminationReason: "TERMINAL_CUSTOM_HOOK" }), false);
});

test("agyHookOutput emits protocol-compliant protojson envelopes for Antigravity", () => {
  assert.equal(agyHookOutput("SessionStart", ""), null);
  assert.equal(
    agyHookOutput("SessionStart", "[mbx] You are test@host"),
    JSON.stringify({ injectSteps: [{ ephemeralMessage: "[mbx] You are test@host" }] }),
  );
  assert.equal(
    agyHookOutput("UserPromptSubmit", "[mbx] 1 unread"),
    JSON.stringify({ injectSteps: [{ ephemeralMessage: "[mbx] 1 unread" }] }),
  );
  assert.equal(
    agyHookOutput("PostToolUse", "[mbx] 2 unread"),
    JSON.stringify({ injectSteps: [{ ephemeralMessage: "[mbx] 2 unread" }] }),
  );
  assert.equal(
    agyHookOutput("Stop", "[mbx] mail arrived"),
    JSON.stringify({ decision: "continue", reason: "[mbx] mail arrived" }),
  );
});

test("selfWatchInstruction gives Antigravity the run_command watcher instruction", () => {
  const w = selfWatchInstruction({ delegated: false, cli: "agy", env: {} });
  assert.equal(w, AGY_WATCHER_INSTRUCTION);
  assert.match(w!, /run_command/);
  assert.match(w!, /WaitMsBeforeAsync 500/);
  assert.match(w!, /IsDaemon false/);
  assert.match(w!, /agentmbx watch/);

  // Explicit off disables it
  assert.match(selfWatchInstruction({ delegated: false, cli: "agy", env: { MBX_SELF_WATCH: "0" } })!, /self-checks are turned off/);
});

test("Antigravity setup installs MCP, hooks and statusline, preserving foreign configs byte-identically", () => {
  const home = tmp();
  try {
    const geminiConfig = join(home, ".gemini/config");
    const geminiAgy = join(home, ".gemini/antigravity-cli");
    mkdirSync(geminiConfig, { recursive: true });
    mkdirSync(geminiAgy, { recursive: true });

    // Pre-populate foreign configurations
    const foreignMcp = { mcpServers: { other: { command: "other-server", args: ["serve"] } } };
    writeFileSync(agyMcpConfigPath(home), JSON.stringify(foreignMcp, null, 2));

    const foreignHooks = {
      "orca-status": {
        PreInvocation: [{ type: "command", command: "/bin/sh -c 'echo orca'", timeout: 10 }],
        Stop: [{ type: "command", command: "/bin/sh -c 'echo orca stop'", timeout: 10 }],
      },
    };
    const foreignHooksRaw = JSON.stringify(foreignHooks, null, 2);
    writeFileSync(agyHooksConfigPath(home), foreignHooksRaw);

    const foreignSettings = {
      colorScheme: "tokyo night",
      model: "Gemini 3.8 Flash (High)",
    };
    writeFileSync(agySettingsPath(home), JSON.stringify(foreignSettings, null, 2));

    const ctx: SetupCtx = {
      home,
      cmd: ["/usr/local/bin/agentmbx"],
      which: (bin: string) => (bin === "agy" ? "/usr/local/bin/agy" : null),
      useClis: false,
    };

    // Verify detection
    const detected = detect(ctx);
    const agyDetected = detected.find(d => d.cli === "agy");
    assert.ok(agyDetected);
    assert.equal(agyDetected.found, true);

    // Run setup install
    const installRows = runSetup(ctx, { mode: "install", only: ["agy"] });
    assert.ok(installRows.some(r => r.cli === "agy" && r.item === "mcpServers.mbx" && r.action === "added"));
    assert.ok(installRows.some(r => r.cli === "agy" && r.item === "lifecycle hooks" && r.action === "added"));
    assert.ok(installRows.some(r => r.cli === "agy" && r.item.includes("statusLine") && r.action === "added"));

    // Verify MCP config preserves "other"
    const installedMcp = JSON.parse(readFileSync(agyMcpConfigPath(home), "utf8"));
    assert.deepEqual(installedMcp.mcpServers.other, foreignMcp.mcpServers.other);
    assert.equal(installedMcp.mcpServers.mbx.command, "/usr/local/bin/agentmbx");
    assert.deepEqual(installedMcp.mcpServers.mbx.args, ["mcp"]);

    // Verify hooks config preserves "orca-status"
    const installedHooks = JSON.parse(readFileSync(agyHooksConfigPath(home), "utf8"));
    assert.deepEqual(installedHooks["orca-status"], foreignHooks["orca-status"]);
    assert.ok(installedHooks.agentmbx);
    assert.equal(installedHooks.agentmbx.SessionStart[0].command, "/usr/local/bin/agentmbx hook session-start --cli agy");
    assert.equal(installedHooks.agentmbx.PreInvocation[0].command, "/usr/local/bin/agentmbx hook prompt --cli agy");
    assert.equal(installedHooks.agentmbx.PostToolUse[0].hooks[0].command, "/usr/local/bin/agentmbx hook post-tool --cli agy");
    assert.equal(installedHooks.agentmbx.Stop[0].command, "/usr/local/bin/agentmbx hook stop --cli agy");

    // Verify settings preserves colorScheme and adds statusLine with stack_with_default
    const installedSettings = JSON.parse(readFileSync(agySettingsPath(home), "utf8"));
    assert.equal(installedSettings.colorScheme, "tokyo night");
    assert.equal(installedSettings.model, "Gemini 3.8 Flash (High)");
    assert.equal(installedSettings.statusLine.type, "command");
    assert.equal(installedSettings.statusLine.stack_with_default, true);
    assert.match(installedSettings.statusLine.command, /statusline agy/);

    // Verify wired check passes
    const agyEdits = edits(ctx, "agy");
    for (const e of agyEdits) {
      assert.equal(wired(e), true, `edit ${e.item} should be wired`);
    }

    // Verify doctor checks pass
    const doctorChecks = statuslineChecks(ctx, "agy");
    assert.ok(doctorChecks.some(c => c.level === "ok" && c.label.includes("status line wired")));

    // Run setup uninstall
    const uninstallRows = runSetup(ctx, { mode: "uninstall", only: ["agy"] });
    assert.ok(uninstallRows.some(r => r.cli === "agy" && r.item === "mcpServers.mbx" && r.action === "removed"));
    assert.ok(uninstallRows.some(r => r.cli === "agy" && r.item === "lifecycle hooks" && r.action === "removed"));
    assert.ok(uninstallRows.some(r => r.cli === "agy" && r.item.includes("statusLine") && r.action === "removed"));

    // Verify foreign keys survive uninstall
    const uninstalledMcp = JSON.parse(readFileSync(agyMcpConfigPath(home), "utf8"));
    assert.deepEqual(uninstalledMcp.mcpServers.other, foreignMcp.mcpServers.other);
    assert.equal(uninstalledMcp.mcpServers.mbx, undefined);

    const uninstalledHooks = JSON.parse(readFileSync(agyHooksConfigPath(home), "utf8"));
    assert.deepEqual(uninstalledHooks["orca-status"], foreignHooks["orca-status"]);
    assert.equal(uninstalledHooks.agentmbx, undefined);

    const uninstalledSettings = JSON.parse(readFileSync(agySettingsPath(home), "utf8"));
    assert.equal(uninstalledSettings.colorScheme, "tokyo night");
    assert.equal(uninstalledSettings.statusLine, undefined);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("Antigravity foreign statusline is preserved and not overwritten", () => {
  const home = tmp();
  try {
    const geminiAgy = join(home, ".gemini/antigravity-cli");
    mkdirSync(geminiAgy, { recursive: true });

    const foreign = {
      statusLine: {
        type: "command",
        command: "custom-user-script.sh",
      },
    };
    writeFileSync(agySettingsPath(home), JSON.stringify(foreign, null, 2));

    const ctx: SetupCtx = {
      home,
      cmd: ["/usr/local/bin/agentmbx"],
      which: () => "/usr/local/bin/agy",
      useClis: false,
    };

    assert.equal(statuslineState(home, "agy", ctx.cmd), "foreign");
    assert.equal(statuslineConfiguredCommand(home, "agy"), "custom-user-script.sh");

    const rows = runSetup(ctx, { mode: "install", only: ["agy"] });
    assert.ok(rows.some(r => r.cli === "agy" && r.action === "manual" && r.item === "statusLine"));

    // File should not have been overwritten
    const content = JSON.parse(readFileSync(agySettingsPath(home), "utf8"));
    assert.equal(content.statusLine.command, "custom-user-script.sh");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("subagent co-use: subagent with matching rootSessionId under same provider co-uses the root lease", () => {
  const rootSession = "8f14bc5a-ccf7-4285-9fb1-847ee6d4fce2";
  const subagentSession = "13792cf1-8c5a-49cc-9f5e-9f798c0654a9";
  const foreignSession = "99999999-9999-9999-9999-999999999999";

  const lease = {
    name: "agy-lead",
    cli: "agy",
    session_id: rootSession,
    holder_pid: 12345,
    holder_start: "2026-10-21 12:00:00",
    released_at: null,
    token: "tok-1",
    heartbeat_at: Date.now(),
    idle_ttl: 60_000,
  } as any;

  // 1. Subagent under same provider with rootSessionId set -> coUse: true
  const subagentAvail = identityAvailability({
    lease,
    evidence: { alive: true, start: "2026-10-21 12:00:00" },
    activity: null,
    now: Date.now(),
    caller: {
      cli: "agy",
      sessionId: subagentSession,
      rootSessionId: rootSession,
      providerPid: 10000,
      holderProviderPid: 10000,
      holderProviderAlive: true,
    },
  });
  assert.equal(subagentAvail.coUse, true);
  assert.equal(subagentAvail.claimable, false);
  assert.match(subagentAvail.reason, /subagent conversation co-uses it/);

  // 2. Unrelated conversation under different provider -> claimable: false, not coUse
  const foreignAvail = identityAvailability({
    lease,
    evidence: { alive: true, start: "2026-10-21 12:00:00" },
    activity: null,
    now: Date.now(),
    caller: {
      cli: "agy",
      sessionId: foreignSession,
      providerPid: 20000,
      holderProviderPid: 10000,
      holderProviderAlive: true,
    },
  });
  assert.equal(foreignAvail.coUse, undefined);
  assert.equal(foreignAvail.claimable, false);
  assert.match(foreignAvail.reason, /held by live agy session/);
});

test("agy-statusline.sh renders HUD line when alive and session matches", () => {
  const home = tmp();
  try {
    const script = fileURLToPath(new URL("../skill/scripts/agy-statusline.sh", import.meta.url));
    const hud = join(home, "hud");
    mkdirSync(hud, { recursive: true });

    const sid = "8f14bc5a-ccf7-4285-9fb1-847ee6d4fce2";
    writeFileSync(join(hud, ".alive"), String(Date.now()));
    writeFileSync(join(hud, `agy-${sid}.line`), "mbx test-agent 3↑\n");

    const out = execFileSync("sh", [script], {
      input: JSON.stringify({ session_id: sid, model: "gemini" }),
      env: { ...process.env, MBX_HOME: home },
      encoding: "utf8",
    });
    assert.equal(out.trim(), "mbx test-agent 3↑");

    // Stale .alive renders nothing
    writeFileSync(join(hud, ".alive"), String(Date.now() - 20_000));
    const staleOut = execFileSync("sh", [script], {
      input: JSON.stringify({ session_id: sid }),
      env: { ...process.env, MBX_HOME: home },
      encoding: "utf8",
    });
    assert.equal(staleOut.trim(), "");

    // Different session renders nothing
    writeFileSync(join(hud, ".alive"), String(Date.now()));
    const diffOut = execFileSync("sh", [script], {
      input: JSON.stringify({ session_id: "other-session" }),
      env: { ...process.env, MBX_HOME: home },
      encoding: "utf8",
    });
    assert.equal(diffOut.trim(), "");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
