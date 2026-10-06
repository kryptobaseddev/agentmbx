// T460: the Hermes side of `agentmbx hook`. Hermes shell hooks (config.yaml `hooks:`) run a command with one JSON object on
// stdin and read one JSON object from stdout, and they have no UserPromptSubmit event: `pre_llm_call` fires once per turn at the
// same place and injects `{"context": "..."}` into that turn's user message. Everything Hermes-specific lives here so cli.ts only
// maps the wire shape onto the contract every other CLI already uses (`input.prompt`, `input.session_id`, `input.cwd`).

/** The text of one turn's user message: a string, or the joined text parts of a multimodal turn. Never anything else. */
export function hermesUserMessage(v: unknown): string | undefined {
  if (typeof v === "string") return v;
  if (!Array.isArray(v)) return undefined;
  const text = v.flatMap((p) => (p && typeof p === "object" && (p as { type?: unknown }).type === "text" && typeof (p as { text?: unknown }).text === "string")
    ? [(p as { text: string }).text] : []);
  return text.length ? text.join("\n") : undefined;
}

export interface HermesHookInput {
  /** The stdin object in the shape cli.ts reads (`prompt`, `session_id`, `cwd`). */
  input: Record<string, unknown>;
  /** The call is not this process's conversation (see hermesIsSideAgent): never bind it, count it or nag for it. */
  skip: boolean;
}

/** Session ids of Hermes's own detached agents: `/background` (`bg_…`), `/btw` (`btw_…`) and the preview agent (`preview_…`) run with
 *  platform "tui" or "cli" and a fresh id of that shape (tui_gateway/methods_prompt.py _side_agent_args, hermes_cli/cli_commands_mixin.py
 *  `bg_…`). They share the process, so without this a side task would take the conversation's binding for as long as it runs. */
export const HERMES_SIDE_AGENT_ID = /^(?:bg|btw|preview)_/;

/** Only a TUI or CLI conversation is one that `agentmbx hook` may bind: one conversation per process, whose id /new, /resume and
 *  context compression replace. Everything else that fires the same hooks in the same process is left alone: delegated subagents
 *  (`subagent`), cron, curator and gateway platforms (telegram, discord, api_server, …: many sessions per process) and the
 *  desktop chat panel. An absent `platform` (an older Hermes) is read as the main conversation. A `parent_session_id` is NOT a signal:
 *  compression gives the main conversation a new id with a parent. */
export function hermesIsSideAgent(sessionId: unknown, platform: unknown): boolean {
  if (platform !== undefined && platform !== "tui" && platform !== "cli") return true;
  return typeof sessionId === "string" && HERMES_SIDE_AGENT_ID.test(sessionId.trim());
}

/** Map Hermes's `{hook_event_name, session_id, cwd, extra:{user_message, platform, ...}}` onto `{session_id, cwd, prompt}`. */
export function hermesHookInput(raw: Record<string, unknown>): HermesHookInput {
  const extra = raw.extra && typeof raw.extra === "object" && !Array.isArray(raw.extra) ? raw.extra as Record<string, unknown> : {};
  const prompt = hermesUserMessage(extra.user_message);
  return {
    input: { ...raw, ...(prompt !== undefined ? { prompt } : {}) },
    skip: hermesIsSideAgent(raw.session_id, extra.platform),
  };
}

/** What Hermes reads back from a hook on stdout: `{"context": "<text>"}` on pre_llm_call. Its other events ignore stdout, so
 *  nothing is printed for them (on_session_start is an observer). */
export const hermesHookOutput = (event: string, context: string): string | null =>
  event === "UserPromptSubmit" ? JSON.stringify({ context }) : null;

/** The watcher note is a few hundred characters that Hermes appends to the user message of every turn it is returned on, and it
 *  persists with the turn. So the full instruction goes out once per session, then a one-line reminder at most this often. */
export const HERMES_NAG_MS = 10 * 60_000;
