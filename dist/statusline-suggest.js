// T369: `agentmbx statusline suggest` — an LLM-assisted placement proposal for the MBX segment
// when a CLI already has (or could have) a status line. "LLM-assisted" means the output is a
// structured, agent-readable proposal (JSON + human text) the in-session agent can reason over
// and present; agentmbx itself makes no network LLM call.
//
// Read-only by construction: this module NEVER writes config unless applyStatuslineProposal is
// called (the --apply path), and that path only acts where setup's own verified text-edit helpers
// can — a user's own status line is never overwritten (T347): for that state the proposal is the
// manual path, exactly matching setup's behavior. The mbx segment itself always resolves the
// CALLING SESSION'S OWN identity at render time (T310/T366); the proposal states who this session
// resolves as now and never references another identity's mailbox (T308 AC2).
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { defaultHome, MbxNode } from "./node.js";
import { resolveStatusIdentity } from "./status-identity.js";
import { detect, edits, resolveCommand, shJoin, statuslineCommand, statuslineConfiguredCommand, statuslineForms, statuslineState, timestamp } from "./setup.js";
export const SUGGEST_SCHEMA = "mbx.statusline-suggest/v1";
export const SUGGEST_CLIS = ["claude", "kimi", "grok"];
const CONFIG_PATH = (ctx, cli) => edits(ctx, cli).find((e) => e.kind === "statusline").path;
const WRAPPER_PATH = (home, cli) => join(home, ".config/agentmbx/statusline", `${cli}-statusline-wrapper.sh`);
const shSingleQuote = (s) => `'${s.replace(/'/g, `'\\''`)}'`;
/** The wrapper proposal for a user's own status line command. `renderCommand` must be the render
 *  command setup installs right now (`statuslineCommand`) — the bundled pure-sh script form when
 *  the skill ships it — so a foreign-line wrapper keeps the one-`cat` render budget (T366)
 *  instead of a node cold start on every footer refresh. Claude (additive): the original command's
 *  first output line is preserved and the MBX segment appended. kimi/grok (replace-only): the MBX
 *  alert takes footer line 1 when the calling session has mail; otherwise the original command's
 *  output renders — the user's footer is preserved except when there is mail. The mbx half
 *  replays stdin (the CLI's status JSON) so the segment resolves the CALLING session only. */
export function wrapperScript(cli, userCommand, renderCommand) {
    const mbx = renderCommand;
    const user = shSingleQuote(userCommand);
    if (cli === "claude") {
        return `#!/bin/sh
# AgentMBX status line wrapper (proposed by \`agentmbx statusline suggest\`, T369) — Claude: ADDITIVE.
# Claude renders its built-in items plus this command's output. Your original command's first
# output line is preserved; the MBX segment for the CALLING SESSION is appended to it (the segment
# resolves that session's own binding at render time — never another identity's mailbox). Stdin
# (Claude's status JSON) is replayed to both commands.
set -f
json=$(cat)
user=$(printf '%s\\n' "$json" | sh -c ${user} | sed -n '1p')
mbx=$(printf '%s\\n' "$json" | ${mbx})
if [ -n "$user" ] && [ -n "$mbx" ]; then
  printf '%s %s\\n' "$user" "$mbx"
else
  printf '%s%s\\n' "$user" "$mbx"
fi
`;
    }
    return `#!/bin/sh
# AgentMBX status line wrapper (proposed by \`agentmbx statusline suggest\`, T369) — ${cli}: REPLACE-ONLY.
# ${cli === "kimi" ? "Kimi" : "Grok"} renders ONLY this command's output: while the CALLING SESSION
# has unread mail the MBX alert takes footer line 1; when nothing waits, your original command's
# output renders — your footer is preserved except when there is mail. (items and command never
# render together; the segment resolves the calling session's own binding, never another identity's
# mailbox.) Stdin (the CLI's status JSON) is replayed to both commands.
set -f
json=$(cat)
mbx=$(printf '%s\\n' "$json" | ${mbx})
if [ -n "$mbx" ]; then
  printf '%s\\n' "$mbx"
  exit 0
fi
printf '%s\\n' "$json" | sh -c ${user}
`;
}
/** Build the proposal. READ-ONLY: never writes anything (the apply path is separate, and only it
 *  writes, only with the caller's confirmation, and only via setup's own text-edit helpers). */
export function statuslineSuggest(o) {
    const { ctx, cli } = o;
    const configPath = CONFIG_PATH(ctx, cli);
    const state = statuslineState(ctx.home, cli, ctx.cmd);
    const configured = statuslineConfiguredCommand(ctx.home, cli);
    const contract = cli === "claude" ? "additive" : "replace-only";
    const resolved = o.node
        ? (o.sessionId
            ? resolveStatusIdentity(o.node, cli, { sessionId: o.sessionId })
            : resolveStatusIdentity(o.node, cli, { pid: o.callerPid ?? null }))
        : null;
    const session = resolved
        ? { identity: resolved.name, state: resolved.state, resolvedBy: resolved.resolved_by }
        : { identity: null, state: "unavailable", resolvedBy: null };
    const who = session.identity ? `this session currently resolves as ${session.identity}` : "this session has no bound identity yet";
    const renderCommand = statuslineCommand(ctx.home, cli, ctx.cmd);
    if (state === "ours") {
        const current = configured !== null && statuslineForms(ctx.home, cli, ctx.cmd).has(configured);
        const exact = configured === renderCommand;
        if (exact) {
            return {
                schema: SUGGEST_SCHEMA, cli, configPath, state, configuredCommand: configured, contract, session,
                action: "none",
                summary: `${cli}: the MBX status segment is already wired (${renderCommand}); ${who}. Nothing to propose.`,
                renderCommand, wrapper: null, steps: ["Nothing to do. `agentmbx doctor` verifies the wiring if it drifts."],
                apply: { supported: false, reason: "already wired with the current form" }, undo: null, replaceNote: null,
            };
        }
        // An older recognized form (or the direct form where setup now prefers the bundled script):
        // setup's own edit upgrades it — that is the one write --apply may perform.
        return {
            schema: SUGGEST_SCHEMA, cli, configPath, state, configuredCommand: configured, contract, session,
            action: "wire",
            summary: `${cli}: the MBX segment is wired with an older form (${configured}); setup can upgrade it to the current form (${renderCommand}). ${who}.`,
            renderCommand, wrapper: null,
            steps: [`Set the ${cli} status line command to ${JSON.stringify(renderCommand)} via setup's text edit (the rest of the file is preserved byte-for-byte).`],
            apply: { supported: true, reason: null }, undo: null, replaceNote: null,
        };
    }
    if (state === "absent") {
        return {
            schema: SUGGEST_SCHEMA, cli, configPath, state, configuredCommand: null, contract, session,
            action: "wire",
            summary: `${cli}: no status line is configured; propose wiring the MBX segment (${renderCommand}). ${who}.`,
            renderCommand, wrapper: null,
            steps: [
                cli === "claude"
                    ? `Add "statusLine": { "type": "command", "command": ${JSON.stringify(renderCommand)} } to ${configPath} (your other settings keys stay).`
                    : cli === "kimi"
                        ? `Append [status_line] with command = ${JSON.stringify(renderCommand)} to ${configPath}.`
                        : `Append [ui.status_line] with type = "command" and command = ${JSON.stringify(renderCommand)} to ${configPath}.`,
            ],
            apply: { supported: true, reason: null }, undo: null, replaceNote: null,
        };
    }
    // foreign: the user has their own status line. Setup never overwrites it (T347) — not even
    // suggest's --apply: the proposal IS the manual path, exactly like setup's manual rows.
    const wrapperPath = WRAPPER_PATH(ctx.home, cli);
    const wrapperCommand = `sh ${shJoin([wrapperPath])}`;
    const wrapper = { path: wrapperPath, content: wrapperScript(cli, configured, renderCommand) };
    const replaceNote = contract === "replace-only"
        ? `${cli === "kimi" ? "Kimi" : "Grok"} renders ONLY the command's output — your command is WRAPPED, not accompanied: while this session has unread mail the footer shows the MBX alert; when nothing waits, your command's output renders as it does today. Never "items plus command" — those do not render together.`
        : "Claude renders its built-in items plus the command's output — your command's first output line is preserved and the MBX segment is appended to it (true composition).";
    const steps = [
        `Write the wrapper script to ${wrapperPath} (content below; make it executable or invoke it via sh).`,
        cli === "claude"
            ? `In ${configPath}, point statusLine at the wrapper: "type": "command", "command": ${JSON.stringify(wrapperCommand)} — your other statusLine keys stay.`
            : cli === "kimi"
                ? `In ${configPath} [status_line], set command = ${JSON.stringify(wrapperCommand)} (your other keys stay in the file; note only the command renders).`
                : `In ${configPath} [ui.status_line], set command = ${JSON.stringify(wrapperCommand)} (your other keys stay in the file; note only the command renders).`,
        `To revert: restore the original command ${JSON.stringify(configured)}.`,
    ];
    return {
        schema: SUGGEST_SCHEMA, cli, configPath, state, configuredCommand: configured, contract, session,
        action: "manual",
        summary: `${cli}: a status line of your own is configured (${configured}); the proposal WRAPS it so the MBX alert shows when this session has mail. ${who}. Setup never overwrites your line — these steps are the manual path.`,
        renderCommand: wrapperCommand, wrapper, steps,
        apply: { supported: false, reason: "setup never overwrites a user's own status line (T347); the steps are the manual path, exactly like setup's manual rows" },
        undo: null, replaceNote,
    };
}
const writeAtomic = (path, content) => {
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.${process.pid}.${Date.now().toString(36)}.tmp`;
    try {
        writeFileSync(tmp, content);
        renameSync(tmp, path);
    }
    finally {
        if (existsSync(tmp))
            rmSync(tmp, { force: true });
    }
};
const throwUsage = (msg) => { throw Object.assign(new Error(msg), { code: "USAGE_ERROR" }); };
/** The --cli default: the single detected CLI among claude/kimi/grok; otherwise --cli is required. */
function defaultSuggestCli(ctx) {
    const found = detect(ctx).filter((d) => d.found && SUGGEST_CLIS.includes(d.cli)).map((d) => d.cli);
    if (found.length === 1)
        return found[0];
    return throwUsage(found.length === 0
        ? `statusline suggest needs --cli <${SUGGEST_CLIS.join("|")}>: none of those CLIs is set up here`
        : `statusline suggest needs --cli <${SUGGEST_CLIS.join("|")}> to choose — several are set up here: ${found.join(", ")}`);
}
/** CLI entry for `agentmbx statusline suggest [--cli claude|kimi|grok] [--session <id>] [--json]
 *  [--apply]`. Default: the human proposal followed by the JSON proposal; --json prints JSON
 *  only. Usage problems throw an error coded USAGE_ERROR (the cli wrapper exits 2 with a hint).
 *  The default CLI is the single detected one among claude/kimi/grok; with several (or none),
 *  --cli is required. Without --apply nothing is ever written. */
export function runStatuslineSuggest(o) {
    if (o.positionals.length)
        throwUsage(`statusline suggest takes options, not positional arguments (got ${o.positionals.join(" ")})`);
    if (o.session && !o.cliFlag)
        throwUsage("statusline suggest --session requires --cli (which CLI's session is it?)");
    const home = o.home ?? homedir();
    const ctx = { home, cmd: resolveCommand(home), which: () => null, useClis: false };
    const cli = o.cliFlag
        ? (!SUGGEST_CLIS.includes(o.cliFlag)
            ? throwUsage(`statusline suggest --cli: ${JSON.stringify(o.cliFlag)} has no composable status line (use ${SUGGEST_CLIS.join("|")})`)
            : o.cliFlag)
        : defaultSuggestCli(ctx);
    // Own-session resolution, only when the mailbox home is initialized — like the statusline
    // render path, an empty home gains no keys or store from a proposal.
    const mbxHome = o.mbxHome ?? defaultHome();
    let node = null;
    try {
        if (existsSync(join(mbxHome, "config.json")))
            node = new MbxNode(mbxHome);
    }
    catch {
        node = null;
    }
    try {
        const proposal = statuslineSuggest({ ctx, cli, node, sessionId: o.session ?? null, callerPid: o.callerPid ?? process.ppid });
        const result = o.apply ? applyStatuslineProposal(proposal, ctx) : null;
        if (result?.applied)
            proposal.undo = result.undo;
        const appliedBlock = result?.applied
            ? `\n\napplied: ${result.detail}\n  file: ${result.written.join(", ")}\nbefore (${proposal.configPath}):\n${(result.before ?? "(file absent)").split("\n").map((l) => `  - ${l}`).join("\n")}\nafter:\n${(result.after ?? "(file removed)").split("\n").map((l) => `  + ${l}`).join("\n")}\n${result.undo}`
            : result ? `\n\nnot applied: ${result.detail}` : "";
        const human = formatProposal(proposal) + appliedBlock;
        if (o.json)
            console.log(JSON.stringify({ ...proposal, applyResult: result }, null, 2));
        else {
            console.log(human);
            console.log("");
            console.log(JSON.stringify({ ...proposal, applyResult: result }, null, 2));
        }
        if (result && !result.applied && o.apply)
            process.stderr.write(`statusline suggest: not applied — ${result.detail}\n`);
    }
    finally {
        node?.close();
    }
}
/** The --apply path. Only `action: "wire"` writes, and the write goes through setup's own status
 *  line Edit (install transform) — never a hand-rolled config rewrite. A backup of the current
 *  file is made first (setup's runSetup convention), so the documented undo restores the exact
 *  bytes: `mv <backup> <config>`, or `rm <config>` when apply created the file. */
export function applyStatuslineProposal(p, ctx, stamp = timestamp()) {
    if (p.action !== "wire") {
        return { applied: false, written: [], backup: null, undo: null,
            detail: p.apply.reason ?? "this proposal is not applicable", before: null, after: null };
    }
    const edit = edits(ctx, p.cli).find((e) => e.kind === "statusline");
    const cur = existsSync(edit.path) ? readFileSync(edit.path, "utf8") : null;
    const next = edit.install(cur);
    if (next === cur)
        return { applied: false, written: [], backup: null, undo: null, detail: "setup's edit found nothing to change", before: cur, after: cur };
    let backup = null;
    if (cur !== null) {
        backup = `${edit.path}.bak-agentmbx-${stamp}`;
        if (!existsSync(backup))
            writeFileSync(backup, cur, { mode: 0o600 });
    }
    if (next === null)
        rmSync(edit.path, { force: true });
    else
        writeAtomic(edit.path, next);
    const undo = backup ? `undo: mv ${backup} ${edit.path}` : `undo: rm ${edit.path}   (apply created it)`;
    return { applied: true, written: [edit.path], backup, undo, detail: `wired ${p.cli} via setup's text edit`, before: cur, after: next };
}
/** The human-readable half of the proposal (the JSON half is the proposal itself). */
export function formatProposal(p) {
    const lines = [];
    lines.push(`mbx statusline proposal — ${p.cli} (${p.configPath})`);
    lines.push(`state: ${p.state}${p.configuredCommand ? ` — your command: ${JSON.stringify(p.configuredCommand)}` : ""}`);
    lines.push(`contract: ${p.contract}${p.contract === "additive" ? " (Claude renders built-in items plus the command output)" : " (the command REPLACES the footer — it never renders alongside other keys)"}`);
    lines.push(`session: ${p.session.identity ? `${p.session.identity} (${p.session.state})` : p.session.state} — the segment renders for the calling session's own binding only, never another identity's mailbox`);
    lines.push("");
    lines.push(p.summary);
    lines.push("");
    lines.push("steps:");
    for (const [i, s] of p.steps.entries())
        lines.push(`  ${i + 1}. ${s}`);
    if (p.wrapper) {
        lines.push("");
        lines.push(`${p.wrapper.path}:`);
        for (const l of p.wrapper.content.split("\n"))
            lines.push(`  | ${l}`);
        lines.push("");
        lines.push(`config change:`);
        lines.push(`  - ${p.state === "foreign" ? p.configuredCommand : "(no status line)"}`);
        lines.push(`  + ${p.renderCommand}`);
    }
    if (p.replaceNote)
        lines.push("", p.replaceNote);
    if (!p.apply.supported && p.action !== "none")
        lines.push("", `--apply: not available — ${p.apply.reason}`);
    return lines.join("\n");
}
