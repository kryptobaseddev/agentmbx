// T725: the Antigravity (agy) side of `agentmbx hook`. Antigravity lifecycle hooks (~/.gemini/config/hooks.json)
// pass camelCase protojson on stdin (`conversationId`, `workspacePaths`, `terminationReason`) and read JSON on
// stdout: `{"injectSteps":[{"ephemeralMessage":"..."}]}` on SessionStart / PreInvocation / PostInvocation, and
// `{"decision":"continue","reason":"..."}` on Stop. All Antigravity-specific wire translation lives here so cli.ts
// stays on the shared hook contract (`session_id`, `cwd`, `emit`, `stop`).

/** Map Antigravity's `{conversationId, workspacePaths, terminationReason, ...}` onto `{session_id, cwd, ...}`. */
export function agyHookInput(raw: Record<string, unknown>): Record<string, unknown> {
  const cid = typeof raw.conversationId === "string" && raw.conversationId.trim() ? raw.conversationId.trim() : undefined;
  const ws = Array.isArray(raw.workspacePaths)
    ? raw.workspacePaths.find((p): p is string => typeof p === "string" && p.trim().length > 0)?.trim()
    : undefined;
  return {
    ...raw,
    ...(cid !== undefined && raw.session_id === undefined ? { session_id: cid } : {}),
    ...(ws !== undefined && raw.cwd === undefined ? { cwd: ws } : {}),
  };
}

/**
 * Antigravity Stop fires on normal turn completion (`NO_TOOL_CALL`) as well as error, cancellation and budget
 * limits (`ERROR`, `USER_CANCELED`, `MAX_INVOCATIONS`, `MAX_FORCED_INVOCATIONS`, `MAX_TOKEN_BUDGET_EXCEEDED`,
 * `TERMINAL_STEP_TYPE`, `TERMINAL_CUSTOM_HOOK`, `INJECTED_RESPONSE`). Only an explicit `NO_TOOL_CALL` may continue
 * the turn: protojson omits an enum default, so a missing reason may be UNSPECIFIED.
 */
export function agyStopEligible(input: Record<string, unknown>): boolean {
  return input.terminationReason === "NO_TOOL_CALL";
}

/**
 * What Antigravity reads back from a hook on stdout:
 * - `SessionStart`, `UserPromptSubmit` (`PreInvocation`), `PostToolUse` (`PostInvocation`):
 *   `{"injectSteps":[{"ephemeralMessage":"<context>"}]}`
 * - `Stop`: `{"decision":"continue","reason":"<context>"}`
 */
export function agyHookOutput(event: string, context: string): string | null {
  if (!context) return null;
  if (event === "Stop") return JSON.stringify({ decision: "continue", reason: context });
  if (event === "SessionStart" || event === "UserPromptSubmit" || event === "PostToolUse") {
    return JSON.stringify({ injectSteps: [{ ephemeralMessage: context }] });
  }
  return null;
}

/** Antigravity turns a finished background `run_command` task into the next turn via a high-priority `<SYSTEM_MESSAGE>`. */
export const AGY_WATCHER_INSTRUCTION = `[mbx] This session can't be woken from outside, so it wakes itself: unless a background task running "agentmbx watch" is already live, start one now with your run_command tool: CommandLine "agentmbx watch", WaitMsBeforeAsync 500, IsDaemon false, toolSummary "Start agentmbx watcher". It prints nothing and costs nothing until mail that wants you arrives, then exits with a no-body hint; its completion wakes your next turn. When it completes, handle the mail (mbx_inbox, mbx_read, act within the policy, mbx_reply, mbx_ack) and start it again the same way. Do this without comment.`;

/** The repeat of the Antigravity watcher instruction when no watcher is running and the full text was already given. */
export const AGY_WATCHER_REMINDER = `[mbx] No mbx watcher is running, so mail cannot wake this session. Start it: run_command CommandLine "agentmbx watch", WaitMsBeforeAsync 500, IsDaemon false.`;

export const AGY_NAG_MS = 10 * 60_000;
