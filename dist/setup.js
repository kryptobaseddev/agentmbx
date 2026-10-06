// `agentmbx setup`: wire the mbx MCP server, hooks and skill into every coding-agent CLI found on this machine.
// Every function takes a `home` root so tests (and dry runs) never touch the real user's configs. Each change is a
// pure text transform (current file text -> desired text), which makes it idempotent, previewable, reversible, and
// lets `agentmbx doctor` reuse the same code to decide whether a CLI is wired.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { accessSync, constants, copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, realpathSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync, } from "node:fs";
import { createRequire } from "node:module";
import { homedir, hostname } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { insertMember, member, parseJsonc, removeMember, replaceValue, valueOf } from "./jsonc.js";
import { parse as parseToml } from "smol-toml";
import { fingerprint } from "./crypto.js";
import { version } from "./version.js";
import { authHelperPath, canPrompt, createKeychainOwner, ownerInfo } from "./owner.js";
export const CLIS = ["claude", "codex", "opencode", "kimi", "hermes", "grok"];
/** The bundled skill as {relative path: content}: embedded in the single executable (SEA asset), else read from ../skill. */
export function skillFiles() {
    if (isSea()) {
        const sea = createRequire(__filename_or_url())("node:sea");
        return { "SKILL.md": sea.getAsset("SKILL.md", "utf8") };
    }
    const dir = fileURLToPath(new URL("../skill", import.meta.url));
    return Object.fromEntries(filesIn(dir).map((f) => [f, readFileSync(join(dir, f), "utf8")]));
}
const __filename_or_url = () => (typeof __filename !== "undefined" ? __filename : import.meta.url);
// ---- helpers ---------------------------------------------------------------------------------
const shq = (s) => /^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
export const shJoin = (argv) => argv.map(shq).join(" ");
export const hookCommand = (cmd, event, cli) => `${shJoin(cmd)} hook ${event} --cli ${cli}`;
// T347: setup wires one status line per CLI — never overwrites a user's existing one. A foreign
// status line is left alone and reported (runSetup adds a manual row with the snippet); uninstall
// removes only what setup wrote. "Ours" is an EXACT match against a command setup itself writes
// (review blocker: the absolute script-path form or the shJoin(cmd) form — nothing else).
export const statuslineCommand = (home, cli, cmd) => {
    if (cli === "grok")
        return `${shJoin(cmd)} statusline grok`; // no bundled grok adapter: the direct form
    // The bundled pure-sh adapter when the skill ships it (SEA bundles SKILL.md only: the node adapter)
    const script = join(skillDest(home), "scripts", `${cli}-statusline.sh`);
    return existsSync(script) ? `sh ${shJoin([script])}` : `${shJoin(cmd)} statusline ${cli}`;
};
/** The command forms a CURRENT setup writes and recognizes as up to date (T368: doctor warns on
 *  an older recognized form — isOurStatusline also matches those so they upgrade, never read foreign). */
export const statuslineForms = (home, cli, cmd) => new Set([
    `sh ${shJoin([join(skillDest(home), "scripts", `${cli}-statusline.sh`)])}`,
    `${shJoin(cmd)} statusline ${cli}`,
]);
const isOurStatusline = (home, cli, cmd, command) => !!command && (statuslineForms(home, cli, cmd).has(command)
    // Re-review minor: also recognise the exact forms older setups wrote — the bare command and any
    // absolute agentmbx path — so those get upgraded and uninstalled rather than left as "foreign".
    || new RegExp(`^(?:agentmbx|\\S+/agentmbx) statusline ${cli}$`).test(command));
/** "absent" = nothing there, "ours" = an exact setup-written command, "foreign" = anything else.
 *  A malformed file is foreign, never a thrown runSetup (review major 2). */
export const statuslineState = (home, cli, cmd) => {
    try {
        if (cli === "claude") {
            const cur = read(join(home, ".claude/settings.json"));
            if (cur === null)
                return "absent";
            const command = parseObj(cur).statusLine?.command;
            return command === undefined ? "absent" : isOurStatusline(home, cli, cmd, command) ? "ours" : "foreign";
        }
        if (cli === "grok") {
            const dir = (home === homedir() && process.env.GROK_HOME) || join(home, ".grok"); // re-review: honor GROK_HOME
            const cur = read(join(dir, "config.toml"));
            if (cur === null)
                return "absent";
            const st = grokStatus(cur);
            if (st.form !== "section")
                return st.form;
            return isOurStatusline(home, cli, cmd, grokCommandValue(st.body) ?? undefined) ? "ours" : "foreign";
        }
        const dir = (home === homedir() && process.env.KIMI_CODE_HOME) || join(home, ".kimi-code"); // review: honor KIMI_CODE_HOME
        const cur = read(join(dir, "tui.toml"));
        if (cur === null)
            return "absent";
        const st = kimiStatus(cur);
        if (st.form !== "section")
            return st.form;
        const command = kimiCommandValue(st.body);
        return command !== null && isOurStatusline(home, cli, cmd, command) ? "ours" : "foreign";
    }
    catch {
        return "foreign";
    }
};
const kimiStatus = (cur) => {
    // Parse guard (review E, applied to the Kimi edits too): invalid TOML, or a status_line key in
    // ANY non-section form (quoted key, inline table), is never edited.
    const parsed = tryParseToml(cur);
    if (parsed === null)
        return { form: "foreign" };
    if (tomlKeyExists(parsed, ["status_line"]) && !/(^|\r?\n)[ \t]*\[[ \t]*status_line[ \t]*\]/.test(cur))
        return { form: "foreign" };
    // A top-level status_line key in non-section form: `status_line = {…}` or `status_line.items = …`
    if (/^[ \t]*status_line[ \t]*[=.]/m.test(cur))
        return { form: "foreign" };
    const start = /(^|\n)[ \t]*\[[ \t]*status_line[ \t]*\][ \t]*(?:#[^\n]*)?\r?\n/.exec(cur);
    if (!start)
        return { form: "absent" };
    const headerAt = start.index + (start[0].startsWith("\n") ? 1 : 0);
    const rest = cur.slice(headerAt);
    const next = /\r?\n[ \t]*\[/.exec(rest);
    const body = next ? rest.slice(0, next.index) : rest; // ends with the section's own terminator, never the next separator
    const commandLine = /(?:^|\r?\n)([ \t]*command[ \t]*=[^\n]*\r?\n)/.exec(body)?.[1] ?? null; // capture excludes the leading \n, so a rewrite never eats it
    return { form: "section", body, commandLine };
};
/** A TOML basic-string value for `command = "…"`, unescaped (re-review: a path containing `"` must
 *  round-trip as ours, not read as foreign). */
const tomlStringValue = (body, key) => {
    const m = new RegExp(`(?:^|\\r?\\n)[ \\t]*${key}[ \\t]*=[ \\t]*"((?:[^"\\\\]|\\\\.)*)"`).exec(body);
    if (!m)
        return null;
    try {
        return JSON.parse(`"${m[1]}"`);
    }
    catch {
        return null;
    }
};
const kimiCommandValue = (body) => tomlStringValue(body, "command");
/** The status line command actually configured for a CLI right now (re-review item 2: doctor
 *  checks the configured command, never the one setup would write). Read from the status line
 *  SECTION: grok's config.toml also holds [mcp_servers.mbx] with its own `command = `, and a whole-
 *  file scan would return that one; a status_line key in a non-section form has no command here. */
export const statuslineConfiguredCommand = (home, cli) => {
    try {
        if (cli === "claude")
            return parseObj(read(join(home, ".claude/settings.json"))).statusLine?.command ?? null;
        if (cli === "grok") {
            const dir = (home === homedir() && process.env.GROK_HOME) || join(home, ".grok");
            const cur = read(join(dir, "config.toml"));
            if (cur === null)
                return null;
            const st = grokStatus(cur);
            return st.form === "section" ? grokCommandValue(st.body) : null;
        }
        const dir = (home === homedir() && process.env.KIMI_CODE_HOME) || join(home, ".kimi-code");
        const cur = read(join(dir, "tui.toml"));
        if (cur === null)
            return null;
        const st = kimiStatus(cur);
        return st.form === "section" ? kimiCommandValue(st.body) : null;
    }
    catch {
        return null;
    }
};
function claudeStatusLine(home, cmd) {
    const want = () => statuslineCommand(home, "claude", cmd);
    return {
        install: (cur) => {
            const obj = parseObj(cur);
            const existing = obj.statusLine;
            if (existing && !isOurStatusline(home, "claude", cmd, existing.command))
                return cur; // foreign: reported, never overwritten
            if (existing?.type === "command" && existing.command === want())
                return cur;
            obj.statusLine = { ...existing, type: "command", command: want() }; // keep the user's other keys (padding etc.)
            return jsonOut(obj, cur);
        },
        uninstall: (cur) => {
            if (cur === null)
                return cur;
            const obj = parseObj(cur);
            const existing = obj.statusLine;
            if (!isOurStatusline(home, "claude", cmd, existing?.command))
                return cur;
            // Re-review item 3: with our command removed, only non-command keys can remain — and a
            // statusLine without a command may be rejected by Claude. Remove the whole object.
            delete obj.statusLine;
            return jsonOut(obj, cur);
        },
    };
}
function kimiStatusLine(home, cmd) {
    const want = () => statuslineCommand(home, "kimi", cmd);
    const commandLineText = (w) => `command = ${JSON.stringify(w)}\n`; // JSON.stringify: a valid TOML basic string (review: escaping)
    const sectionText = (w) => `[status_line]\n${commandLineText(w)}`;
    return {
        install: (cur) => {
            const st = cur === null ? { form: "absent" } : kimiStatus(cur);
            if (st.form === "foreign")
                return cur; // reported by runSetup, never overwritten — and never appended (no duplicate table)
            const w = want();
            if (st.form === "section") {
                const command = kimiCommandValue(st.body);
                // Re-review major 1: a user's own section with items and NO command is foreign — adding our
                // command to THEIR section is their call, not setup's (manual row prints the snippet).
                if (command === null)
                    return cur;
                if (!isOurStatusline(home, "kimi", cmd, command))
                    return cur; // a foreign command line: leave everything
                if (command === w)
                    return cur;
                const eolOfFile = (cur ?? "").includes("\r\n") ? "\r\n" : "\n"; // minor: match the file's line ending
                // T366: rewrite ONLY our command line. Their other keys stay in the FILE, but Kimi renders
                // only the command — [status_line].command replaces the footer, items never compose with it.
                return guarded(cur, (cur ?? "").replace(st.commandLine, () => `command = ${JSON.stringify(w)}${eolOfFile}`));
            }
            // Exactly one line ending between the prior content and our section — uninstall removes
            // exactly one too, so LF and CRLF files round-trip byte-exactly.
            const eol = (cur ?? "").includes("\r\n") ? "\r\n" : "\n";
            return guarded(cur, (cur ?? "") + (cur ? eol : "") + sectionText(w));
        },
        uninstall: (cur) => {
            if (cur === null)
                return cur;
            const st = kimiStatus(cur);
            if (st.form !== "section")
                return cur;
            const command = kimiCommandValue(st.body);
            if (command === null || !isOurStatusline(home, "kimi", cmd, command))
                return cur; // foreign: never touched
            // remove ONLY our command line, byte-exact — no whitespace collapsing anywhere else (review minor 6)
            const lines = st.body.split("\n").filter((l) => !/^[ \t]*command[ \t]*=/.test(l));
            const meaningful = lines.filter((l) => l.trim() !== "" && !/^[ \t]*\[/.test(l));
            let next;
            if (meaningful.length)
                next = (cur ?? "").replace(st.body, () => lines.join("\n"));
            else {
                // the whole section goes; exactly one separator \n install added before it goes too
                const start = (cur ?? "").indexOf(st.body);
                const removalStart = start > 0 && (cur ?? "")[start - 1] === "\n" ? start - ((cur ?? "")[start - 2] === "\r" ? 2 : 1) : start;
                next = (cur ?? "").slice(0, removalStart) + (cur ?? "").slice(start + st.body.length);
            }
            if (next.trim() === "")
                next = null; // setup created the file: remove it entirely
            return guarded(cur, next); // re-review: uninstall is guarded too — never write invalid TOML
        },
    };
}
// T337: grok is a first-class CLI — its config.toml sections are found with the same robust rules
// as Kimi's (CRLF, trailing comments, inner spacing), "ours" is an exact match, edits keep the
// user's other keys, and uninstall removes exactly the inserted bytes (review items 2, 5, 6, 9, 10).
/** A TOML section (header plus body lines) up to the next section header at line start — tolerant
 *  of CRLF, a trailing comment, inner spacing, and quoted key parts (re-review: `[ui."status_line"]`). */
const tomlSectionAt = (cur, header) => {
    const pattern = header.split(".").map((p) => `"?${p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"?`).join("[ \\t]*\\.[ \\t]*");
    const start = new RegExp(`(^|\\r?\\n)[ \\t]*\\[[ \\t]*${pattern}[ \\t]*\\][ \\t]*(?:#[^\\n]*)?\\r?\\n`).exec(cur);
    if (!start)
        return null;
    const headerAt = start.index + (start[0].startsWith("\n") || start[0].startsWith("\r") ? start[0].match(/^(\r?\n)/)[1].length : 0);
    const rest = cur.slice(headerAt);
    const next = /\r?\n[ \t]*\[/.exec(rest);
    // The body ends with the section's own line terminator, never the separator before the next
    // header — the separator belongs to whoever appended that section, and uninstall removes
    // exactly one of those per removed section (re-review regression fix).
    return next ? rest.slice(0, next.index) : rest;
};
/** smol-toml parse guard (re-review E): parse before editing — a key in a form we don't recognise
 *  stays manual — and never write invalid TOML back. Text edits stay, so comments survive. */
const tryParseToml = (cur) => {
    try {
        return parseToml(cur);
    }
    catch {
        return null;
    }
};
const tomlKeyExists = (obj, path) => {
    let cur = obj;
    for (const key of path) {
        if (!cur || typeof cur !== "object" || !(key in cur))
            return false;
        cur = cur[key];
    }
    return true;
};
/** Refuse to write invalid TOML: the edit result must parse, or the file stays untouched. */
const guarded = (cur, next) => next !== cur && next !== null && tryParseToml(next) === null ? cur : next;
const grokStatus = (cur) => {
    // Parse guard (review E): invalid TOML, or a status_line key in ANY form, is never edited.
    const parsed = tryParseToml(cur);
    if (parsed === null)
        return { form: "foreign" }; // invalid TOML: never write into it
    if (tomlKeyExists(parsed, ["status_line"]))
        return { form: "foreign" }; // a root status_line key
    if (tomlKeyExists(parsed, ["ui", "status_line"]) && !tomlSectionAt(cur, "ui.status_line"))
        return { form: "foreign" }; // a form we can't edit (quoted, inline)
    if (/^[ \t]*ui\.status_line[ \t]*[=.]/m.test(cur))
        return { form: "foreign" }; // dotted key
    const ui = tomlSectionAt(cur, "ui");
    if (ui && /^[ \t]*status_line[ \t]*[=.]/m.test(ui))
        return { form: "foreign" }; // embedded in [ui]
    const body = tomlSectionAt(cur, "ui.status_line");
    if (body === null)
        return { form: "absent" };
    const commandLine = /(?:^|\r?\n)[ \t]*command[ \t]*=[^\n]*\r?\n/.exec(body)?.[0] ?? null;
    return { form: "section", body, commandLine };
};
const grokCommandValue = (body) => tomlStringValue(body, "command");
const grokStatusCommand = (cmd) => `${shJoin(cmd)} statusline grok`;
function grokStatusLine(home, cmd) {
    const want = () => grokStatusCommand(cmd);
    const lineText = (key, w) => `${key} = ${JSON.stringify(w)}\n`; // valid TOML basic string (review: escaping)
    const sectionText = (w) => `[ui.status_line]\n${lineText("type", "command")}${lineText("command", w)}`;
    return {
        install: (cur) => {
            const st = cur === null ? { form: "absent" } : grokStatus(cur);
            if (st.form === "foreign")
                return cur; // reported, never overwritten — and never a duplicate table
            const w = want();
            if (st.form === "section") {
                const command = grokCommandValue(st.body);
                // Re-review medium B: a user section without exactly our command is foreign — a
                // `[ui.status_line] type = "builtin"` or no command at all is never edited, only reported.
                if (command === null || !isOurStatusline(home, "grok", cmd, command))
                    return cur;
                if (command === w && /(?:^|\r?\n)[ \t]*type[ \t]*=[ \t]*"command"/.test(st.body))
                    return cur;
                const eolOfFile = (cur ?? "").includes("\r\n") ? "\r\n" : "\n"; // minor: match the file's line ending
                return guarded(cur, (cur ?? "").replace(st.commandLine, () => `command = ${JSON.stringify(w)}${eolOfFile}`)); // rewrite ONLY our line — type, refresh_interval, padding stay
            }
            // Exactly one line ending between the prior content and our section — uninstall removes
            // exactly one too, so LF and CRLF files round-trip byte-exactly.
            const eol = (cur ?? "").includes("\r\n") ? "\r\n" : "\n";
            return guarded(cur, (cur ?? "") + (cur ? eol : "") + sectionText(w));
        },
        uninstall: (cur) => {
            if (cur === null)
                return cur;
            const st = grokStatus(cur);
            if (st.form !== "section")
                return cur;
            const command = grokCommandValue(st.body);
            if (command === null || !isOurStatusline(home, "grok", cmd, command))
                return cur; // foreign: never touched
            // remove ONLY our command line, byte-exact (review low 9)
            const lines = st.body.split("\n").filter((l) => !/^[ \t]*command[ \t]*=/.test(l));
            const meaningful = lines.filter((l) => l.trim() !== "" && !/^[ \t]*\[/.test(l) && !/^[ \t]*type[ \t]*=/.test(l));
            let next;
            if (meaningful.length)
                next = (cur ?? "").replace(st.body, () => lines.join("\n"));
            else {
                // the whole section goes; exactly one separator \n install added before it goes too
                const start = (cur ?? "").indexOf(st.body);
                const removalStart = start > 0 && (cur ?? "")[start - 1] === "\n" ? start - ((cur ?? "")[start - 2] === "\r" ? 2 : 1) : start;
                next = (cur ?? "").slice(0, removalStart) + (cur ?? "").slice(start + st.body.length);
            }
            if (next.trim() === "")
                next = null;
            return guarded(cur, next);
        },
    };
}
const grokMcpState = (cur) => {
    // Parse guard (review E): invalid TOML, or an mbx key in ANY form we don't recognise, is never edited.
    const parsed = tryParseToml(cur);
    if (parsed === null)
        return { form: "foreign" };
    if (tomlKeyExists(parsed, ["mcp_servers", "mbx"]) && !tomlSectionAt(cur, "mcp_servers.mbx"))
        return { form: "foreign" };
    if (/^[ \t]*mcp_servers\.mbx[ \t]*[=.]/m.test(cur))
        return { form: "foreign" }; // dotted key
    const parent = tomlSectionAt(cur, "mcp_servers");
    if (parent && /^[ \t]*mbx[ \t]*[=.]/m.test(parent))
        return { form: "foreign" }; // embedded in [mcp_servers]
    const body = tomlSectionAt(cur, "mcp_servers.mbx");
    if (body === null)
        return { form: "absent" };
    return { form: "section", body };
};
function grokMcp(cmd) {
    const lineText = (key, w) => `${key} = ${JSON.stringify(w)}\n`;
    const argsText = `[${[...cmd.slice(1), "mcp"].map((a) => JSON.stringify(a)).join(", ")}]`;
    const wantCommand = cmd[0], wantArgs = argsText;
    const sectionText = () => `[mcp_servers.mbx]\n${lineText("command", wantCommand)}args = ${argsText}\nenabled = true\n`;
    const ours = (body) => grokCommandValue(body) === wantCommand && body.includes(`args = ${wantArgs}`); // exact match (review med 5)
    return {
        install: (cur) => {
            const st = cur === null ? { form: "absent" } : grokMcpState(cur);
            if (st.form === "foreign")
                return cur;
            if (st.form === "section") {
                if (!ours(st.body)) {
                    const command = grokCommandValue(st.body);
                    // normalize only a stale path of the SAME binary (…/agentmbx); anything else is another
                    // tool's mbx — never overwritten (review med 5: agentmbx-fork is not ours)
                    if (command !== null && !/(^|\/)agentmbx$/.test(command))
                        return cur;
                    // rewrite ONLY our command/args lines — the user's other keys in the section stay
                    return guarded(cur, (cur ?? "").replace(st.body, () => st.body
                        .replace(/(^|\r?\n)[ \t]*command[ \t]*=[^\n]*(\r?\n)/, (_, p1, p2) => `${p1}command = ${JSON.stringify(wantCommand)}${p2}`)
                        .replace(/(^|\r?\n)[ \t]*args[ \t]*=[^\n]*(\r?\n)/, (_, p1, p2) => `${p1}args = ${wantArgs}${p2}`)));
                }
                return cur;
            }
            const eol = (cur ?? "").includes("\r\n") ? "\r\n" : "\n";
            return guarded(cur, (cur ?? "") + (cur ? eol : "") + sectionText());
        },
        uninstall: (cur) => {
            if (cur === null)
                return cur;
            const st = grokMcpState(cur);
            if (st.form !== "section" || !ours(st.body))
                return cur;
            // the whole section goes; exactly one separator \n install added before it goes too
            const start = (cur ?? "").indexOf(st.body);
            const removalStart = start > 0 && (cur ?? "")[start - 1] === "\n" ? start - ((cur ?? "")[start - 2] === "\r" ? 2 : 1) : start;
            let next = (cur ?? "").slice(0, removalStart) + (cur ?? "").slice(start + st.body.length);
            if (next.trim() === "")
                next = null;
            return guarded(cur, next);
        },
    };
}
/** The command configured in `[mcp_servers.mbx]`, not the one setup would write. A missing file,
 *  a non-section form, or invalid TOML has no command to check. */
export function grokMcpConfiguredCommand(home) {
    try {
        const dir = (home === homedir() && process.env.GROK_HOME) || join(home, ".grok");
        const cur = read(join(dir, "config.toml"));
        if (cur === null)
            return null;
        const st = grokMcpState(cur);
        return st.form === "section" ? grokCommandValue(st.body) : null;
    }
    catch {
        return null;
    }
}
/** Grok events the harness runs. PostToolUse is the one whose additionalContext is delivered.
 *  Stop continues a turn that is ending (T385, user-guide 10-hooks.md). PermissionRequest stays out. */
const GROK_HOOK_EVENTS = [["SessionStart", "session-start"], ["UserPromptSubmit", "prompt"], ["PostToolUse", "post-tool"], ["Stop", "stop"]];
const grokHookSub = (event) => GROK_HOOK_EVENTS.find((e) => e[0] === event)?.[1] ?? null;
/** Ours is exactly `…/agentmbx hook <sub> --cli grok` (bare or quoted path). A composed command
 *  is someone else's hook and is left alone. */
function isOurGrokHookCommand(command, sub) {
    const tail = ` hook ${sub} --cli grok`;
    if (!command.endsWith(tail))
        return false;
    let bin = command.slice(0, -tail.length);
    if (bin.startsWith("'") && bin.endsWith("'"))
        bin = bin.slice(1, -1).replace(/'\\''/g, "'");
    else if (/\s/.test(bin))
        return false;
    return /(^|\/)agentmbx$/.test(bin);
}
function inlineHookCommand(body) {
    const m = /command[ \t]*=[ \t]*"((?:[^"\\]|\\.)*)"/.exec(body);
    if (!m)
        return null;
    try {
        return JSON.parse(`"${m[1]}"`);
    }
    catch {
        return null;
    }
}
/** One `[[hooks.<Event>]]` table, including the newline that ends its last line. Contiguous
 *  tables meet exactly (end === next start), so a block uninstall removes only the bytes it added. */
function grokHookSpans(cur) {
    const re = /[ \t]*\[\[[ \t]*hooks[ \t]*\.[ \t]*([A-Za-z]+)[ \t]*\]\][ \t]*(?:#[^\r\n]*)?\r?\n/g;
    const spans = [];
    for (const m of cur.matchAll(re)) {
        const start = m.index ?? 0;
        const after = start + m[0].length;
        const next = /\r?\n[ \t]*\[/.exec(cur.slice(after));
        const end = next ? after + next.index + (/^\r?\n/.exec(next[0])?.[0].length ?? 1) : cur.length;
        spans.push({ start, end, event: m[1], command: inlineHookCommand(cur.slice(start, end)) });
    }
    return spans;
}
/** `[hooks]` / `[hooks.Name]` is one table. `[[hooks.Name]]` is an array of tables. smol-toml
 *  accepts both in one document; Grok's config must not. A file that already uses the table form
 *  is left untouched. */
function grokPlainHooksTable(cur) {
    return /^[ \t]*\[hooks(?:\.[A-Za-z0-9_-]+)?\][ \t]*(?:#[^\r\n]*)?\r?$/m.test(cur);
}
function grokHooks(cmd) {
    const tableText = (event, command) => `[[hooks.${event}]]\nhooks = [{ type = "command", command = ${JSON.stringify(command)}, timeout = 10 }]\n`;
    const oursIn = (cur, event, sub) => grokHookSpans(cur)
        .filter((s) => s.event === event && s.command !== null && isOurGrokHookCommand(s.command, sub));
    return {
        install: (cur) => {
            if (cur !== null && (tryParseToml(cur) === null || grokPlainHooksTable(cur)))
                return cur;
            let next = cur ?? "";
            const missing = [];
            for (const [event, sub] of GROK_HOOK_EVENTS) {
                const want = hookCommand(cmd, sub, "grok");
                const ours = oursIn(next, event, sub);
                if (!ours.length) {
                    missing.push(tableText(event, want));
                    continue;
                }
                if (ours[0].command !== want) {
                    const body = next.slice(ours[0].start, ours[0].end)
                        .replace(/(command[ \t]*=[ \t]*)"(?:[^"\\]|\\.)*"/, `$1${JSON.stringify(want)}`);
                    next = next.slice(0, ours[0].start) + body + next.slice(ours[0].end);
                }
                const extra = oursIn(next, event, sub).slice(1);
                for (const s of extra.reverse())
                    next = next.slice(0, s.start) + next.slice(s.end);
            }
            if (missing.length) {
                const block = missing.join("");
                next = next === "" ? block : next + (next.includes("\r\n") ? "\r\n" : "\n") + block;
            }
            return guarded(cur, next === "" ? null : next);
        },
        uninstall: (cur) => {
            if (cur === null || tryParseToml(cur) === null)
                return cur;
            const spans = grokHookSpans(cur).filter((s) => {
                const sub = grokHookSub(s.event);
                return !!sub && s.command !== null && isOurGrokHookCommand(s.command, sub);
            });
            if (!spans.length)
                return cur;
            const groups = [];
            for (const s of spans) {
                const g = groups.at(-1);
                if (g && g.end === s.start)
                    g.end = s.end;
                else
                    groups.push({ start: s.start, end: s.end });
            }
            let next = cur;
            for (const g of groups.reverse()) {
                // One separator newline per group — the same byte install added before an appended block.
                let start = g.start;
                if (start > 0 && next[start - 1] === "\n")
                    start -= next[start - 2] === "\r" ? 2 : 1;
                next = next.slice(0, start) + next.slice(g.end);
            }
            if (next.trim() === "")
                next = "";
            return guarded(cur, next === "" ? null : next);
        },
    };
}
const isOurHook = (command, event, cli, cmd) => (command.includes(` hook ${event} --cli ${cli}`) && (command.includes("agentmbx") || command.startsWith(shJoin(cmd))))
    // T342: the bundled sh fast path is ours too, so setup upgrades an old direct command to it (and back)
    || (event === "post-tool" && cli === "claude" && command.includes("claude-posttool.sh"));
/** T342: when the bundled skill ships the post-tool wrapper, PostToolUse runs it (zero node starts
 *  in steady state); otherwise the event keeps the direct `agentmbx hook` command (SEA bundles
 *  SKILL.md only). The wrapper alone decides nothing — it always falls through to the full hook
 *  on any doubt, so hook decisions stay identical. It gets the setup's own resolved command: a
 *  desktop-started Claude has a minimal PATH (review high — never rely on PATH agentmbx). */
const posttoolFastPath = (home, cmd) => (sub) => {
    if (sub !== "post-tool")
        return null;
    const script = join(skillDest(home), "scripts", "claude-posttool.sh");
    return existsSync(script) ? `sh ${shJoin([script])} ${shJoin(cmd)}` : null;
};
const read = (p) => existsSync(p) ? readFileSync(p, "utf8") : null;
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
export function defaultWhich(bin) {
    for (const dir of (process.env.PATH ?? "").split(delimiter).filter(Boolean)) {
        const p = join(dir, bin);
        try {
            accessSync(p, constants.X_OK);
            return p;
        }
        catch { /* next */ }
    }
    return null;
}
export function isSea() {
    try {
        return createRequire(import.meta.url)("node:sea").isSea();
    }
    catch {
        return false;
    }
}
/** The argv agents should run: the SEA binary, else a stable agentmbx on PATH (mise/asdf shim first), else node + script. */
export function resolveCommand(home = homedir(), which = defaultWhich) {
    if (isSea())
        return [process.execPath];
    const shims = [join(home, ".local/share/mise/shims/agentmbx"), join(home, ".asdf/shims/agentmbx")];
    const shim = shims.find((p) => existsSync(p));
    if (shim)
        return [shim];
    const onPath = which("agentmbx");
    if (onPath)
        return [onPath];
    const nodeShims = [join(home, ".local/share/mise/shims/node"), join(home, ".asdf/shims/node"), join(home, ".volta/bin/node")];
    return [nodeShims.find((p) => existsSync(p)) ?? process.execPath, realpathSync(fileURLToPath(new URL("../bin/agentmbx.js", import.meta.url)))];
}
/** macOS: `scutil --get LocalHostName`; elsewhere the short hostname. Lowercased, a-z0-9-. */
export function defaultHostName() {
    let n = "";
    if (process.platform === "darwin") {
        try {
            n = execFileSync("scutil", ["--get", "LocalHostName"], { encoding: "utf8" }).trim();
        }
        catch { /* fall back */ }
    }
    if (!n)
        n = hostname().split(".")[0];
    return n.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "host";
}
// ---- JSON (plain) helpers --------------------------------------------------------------------
const jsonIndent = (t) => (t && /^\{\s*\n([ \t]+)"/.exec(t)?.[1]) || "  ";
const jsonOut = (obj, cur) => JSON.stringify(obj, null, jsonIndent(cur)) + (cur === null || cur.endsWith("\n") ? "\n" : "");
const parseObj = (cur) => {
    if (cur === null || !cur.trim())
        return {};
    const v = JSON.parse(cur);
    if (!v || typeof v !== "object" || Array.isArray(v))
        throw new Error("expected a JSON object");
    return v;
};
/** [CLI event, `agentmbx hook` subcommand]. PermissionRequest is YOLO (docs/POLICY.md §5): it answers only under an active policy. */
const HOOK_EVENTS = [["SessionStart", "session-start"], ["UserPromptSubmit", "prompt"], ["PermissionRequest", "permission"]];
/** Claude and Codex also take a Stop hook that can keep the turn going ({"decision":"block"}) when mail arrived mid-turn. */
const STOP_EVENTS = [...HOOK_EVENTS, ["Stop", "stop"]];
/** Hooks in the Claude/Codex shape: { hooks: { Event: [ { hooks: [ {type, command} ] } ] } }. Appends groups; never edits others.
 *  `commandFor` overrides the command for an event (T342: PostToolUse runs the bundled sh fast
 *  path when the skill script is installed; absent, the event keeps the direct `agentmbx hook`. */
function jsonHooks(events, cli, cmd, commandFor) {
    const install = (cur) => {
        const obj = parseObj(cur);
        let changed = false;
        const hooks = (obj.hooks ??= {});
        for (const [ev, sub] of events) {
            const want = commandFor?.(sub) ?? hookCommand(cmd, sub, cli);
            const groups = (hooks[ev] ??= []);
            const ours = groups.flatMap((g) => (g.hooks ?? []).filter((h) => isOurHook(h.command ?? "", sub, cli, cmd)));
            if (!ours.length) {
                groups.push({ hooks: [{ type: "command", command: want, timeout: 10 }] });
                changed = true;
                continue;
            }
            if (ours[0].command !== want) {
                ours[0].command = want;
                changed = true;
            }
            if (ours.length > 1) { // duplicates from earlier runs: keep the first
                for (const g of groups)
                    g.hooks = (g.hooks ?? []).filter((h) => h === ours[0] || !isOurHook(h.command ?? "", sub, cli, cmd));
                hooks[ev] = groups.filter((g) => (g.hooks ?? []).length);
                changed = true;
            }
        }
        return changed ? jsonOut(obj, cur) : cur;
    };
    const uninstall = (cur) => {
        if (cur === null)
            return null;
        const obj = parseObj(cur);
        let changed = false;
        const hooks = obj.hooks;
        if (!hooks)
            return cur;
        for (const [ev, sub] of events) {
            const groups = hooks[ev];
            if (!Array.isArray(groups))
                continue;
            const kept = [];
            for (const g of groups) {
                const before = g.hooks ?? [];
                const after = before.filter((h) => !isOurHook(h.command ?? "", sub, cli, cmd));
                if (after.length !== before.length) {
                    changed = true;
                    if (after.length)
                        kept.push({ ...g, hooks: after });
                }
                else
                    kept.push(g);
            }
            if (kept.length)
                hooks[ev] = kept;
            else if (changed)
                delete hooks[ev];
        }
        if (changed && !Object.keys(hooks).length)
            delete obj.hooks;
        return changed ? jsonOut(obj, cur) : cur;
    };
    return { install, uninstall };
}
/** { <key>: { mbx: <entry> } } in a plain JSON file (Claude's ~/.claude.json, Kimi's mcp.json). */
function jsonServer(key, entry, matches, deleteWhenEmpty = false) {
    return {
        install: (cur) => {
            const obj = parseObj(cur);
            const servers = (obj[key] ??= {});
            if (servers.mbx && matches(servers.mbx))
                return cur;
            servers.mbx = entry;
            return jsonOut(obj, cur);
        },
        uninstall: (cur) => {
            if (cur === null)
                return null;
            const obj = parseObj(cur);
            const servers = obj[key];
            if (!servers?.mbx)
                return cur;
            delete servers.mbx;
            if (deleteWhenEmpty && !Object.keys(servers).length && Object.keys(obj).length === 1)
                return null;
            return jsonOut(obj, cur);
        },
    };
}
// ---- TOML (text) helpers ---------------------------------------------------------------------
/** Line range [start, end) of `[header]` and its sub-tables `[header.*]`. */
function tomlTable(lines, header) {
    const start = lines.findIndex((l) => l.trim() === `[${header}]`);
    if (start < 0)
        return null;
    let end = start + 1;
    while (end < lines.length) {
        const t = lines[end].trim();
        if (t.startsWith("[") && !t.startsWith(`[${header}.`))
            break;
        end++;
    }
    while (end > start + 1 && lines[end - 1].trim() === "")
        end--; // keep the blank separator outside
    return [start, end];
}
const appendBlock = (cur, block) => {
    const t = cur ?? "";
    return t === "" ? `${block}\n` : `${t.endsWith("\n") ? t : `${t}\n`}\n${block}\n`;
};
const removeBlock = (text, start, end) => {
    const lines = text.split("\n");
    let s = start, e = end;
    if (s > 0 && lines[s - 1].trim() === "")
        s--; // the blank line appendBlock added before it
    else if (e < lines.length && lines[e].trim() === "")
        e++;
    lines.splice(s, e - s);
    return lines.join("\n");
};
function codexServer(cmd) {
    const block = [`[mcp_servers.mbx]`, `command = ${JSON.stringify(cmd[0])}`, `args = ${JSON.stringify([...cmd.slice(1), "mcp"]).replace(/","/g, `", "`)}`,
        `default_tools_approval_mode = "approve"`];
    return {
        install: (cur) => {
            const lines = (cur ?? "").split("\n");
            const r = tomlTable(lines, "mcp_servers.mbx");
            if (!r)
                return appendBlock(cur, block.join("\n"));
            // main table body only (sub-tables such as [mcp_servers.mbx.env] are kept)
            let mainEnd = r[0] + 1;
            while (mainEnd < r[1] && !lines[mainEnd].trim().startsWith("["))
                mainEnd++;
            let bodyEnd = mainEnd;
            while (bodyEnd > r[0] + 1 && lines[bodyEnd - 1].trim() === "")
                bodyEnd--;
            if (same(lines.slice(r[0], bodyEnd), block))
                return cur;
            lines.splice(r[0], bodyEnd - r[0], ...block);
            return lines.join("\n");
        },
        uninstall: (cur) => {
            if (cur === null)
                return null;
            const r = tomlTable(cur.split("\n"), "mcp_servers.mbx");
            return r ? removeBlock(cur, r[0], r[1]) : cur;
        },
    };
}
const KIMI_BEGIN = "# >>> agentmbx (managed by agentmbx setup; remove with: agentmbx setup --uninstall) >>>";
const KIMI_END = "# <<< agentmbx <<<";
function kimiHooks(cmd) {
    const block = [KIMI_BEGIN,
        ...STOP_EVENTS.flatMap(([ev, sub]) => ["[[hooks]]", `event = "${ev}"`, `command = ${JSON.stringify(hookCommand(cmd, sub, "kimi"))}`, "timeout = 10"]),
        KIMI_END];
    const find = (lines) => {
        const s = lines.indexOf(KIMI_BEGIN), e = lines.indexOf(KIMI_END, s);
        return s >= 0 && e > s ? [s, e + 1] : null;
    };
    return {
        install: (cur) => {
            const lines = (cur ?? "").split("\n");
            const r = find(lines);
            if (!r)
                return appendBlock(cur, block.join("\n"));
            if (same(lines.slice(r[0], r[1]), block))
                return cur;
            lines.splice(r[0], r[1] - r[0], ...block);
            return lines.join("\n");
        },
        uninstall: (cur) => {
            if (cur === null)
                return null;
            const r = find(cur.split("\n"));
            if (!r)
                return cur;
            const out = removeBlock(cur, r[0], r[1]);
            return out.trim() === "" ? null : out;
        },
    };
}
// ---- OpenCode hooks plugin (T391) -------------------------------------------------------------
// OpenCode has no settings-file hooks: its first-party mechanism is a plugin module that the TUI
// auto-loads from ~/.config/opencode/plugins/. The plugin below translates OpenCode events onto the
// same `agentmbx hook <event> --cli opencode` contract every other CLI uses:
//   session.created -> session-start (bind + inbox note)   tool.execute.after -> post-tool
//   session.idle    -> stop (Stop continuation)
// Ours-detection is a first-line marker; a file without it is foreign and is never touched (T347
// bar: byte-exact install, byte-exact uninstall, local edits reported instead of overwritten).
export const opencodePluginPath = (home) => join(home, ".config/opencode/plugins/agentmbx.ts");
const OPENCODE_PLUGIN_MARKER = "// agentmbx-plugin v1 (T391) — managed by `agentmbx setup --only opencode`";
/** True when the file's first line starts with our marker: ours-current or ours-stale, never a user's edit. */
const isOpencodePluginOurs = (cur) => cur !== null && cur.split("\n", 1)[0].trim().startsWith(OPENCODE_PLUGIN_MARKER);
/** The exact plugin source setup writes. `cmd` is embedded as a JSON string[] so Bun's `$` spreads
 *  it with each element escaped (an interpolated string would arrive as ONE argument — B3). */
export function opencodePluginSource(cmd, ver) {
    const bin = JSON.stringify(cmd);
    return `${OPENCODE_PLUGIN_MARKER} (agentmbx ${ver})
// Local edits make this file foreign: setup stops managing it and doctor reports it.
// Uninstall with: agentmbx setup --uninstall --only opencode
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

type Shell = (parts: TemplateStringsArray, ...args: unknown[]) => { quiet(): { text(): Promise<string> } };

/** Only text we produced ourselves is ever injected: a Stop {"decision":"block"} reason, or an
 *  [mbx] note. Anything else on hook stdout is ignored (B1b/B2). */
const hookReason = (out: string): string | null => {
  for (const line of out.split("\\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      const j = JSON.parse(t) as { decision?: unknown; reason?: unknown };
      if (j && j.decision === "block" && typeof j.reason === "string" && j.reason) return j.reason;
    } catch { /* not JSON */ }
    if (t.startsWith("[mbx]") || t.startsWith("probe ok")) return t;
  }
  return null;
};

/** One hook call: JSON payload in via a temp-file redirect; stdout is captured; a reason we
 *  recognize is injected into the session through the plugin client. A failure never surfaces. */
const call = async ($: Shell, client: unknown, bin: string[], event: string, payload: Record<string, unknown>): Promise<void> => {
  let dir: string | null = null;
  try {
    dir = mkdtempSync(join(tmpdir(), "agentmbx-hook-"));
    const f = join(dir, "payload.json");
    writeFileSync(f, JSON.stringify(payload));
    const out = await $\`\${bin} hook \${event} --cli opencode < \${f}\`.quiet().text();
    const reason = hookReason(out);
    const sid = typeof payload.session_id === "string" ? payload.session_id : null;
    if (reason && sid) {
      const c = client as { session?: { promptAsync?: (i: object) => Promise<unknown>; prompt?: (i: object) => Promise<unknown> } };
      try { await c.session?.promptAsync?.({ sessionID: sid, text: reason }); return; } catch { /* older client */ }
      try { await c.session?.prompt?.({ sessionID: sid, text: reason }); } catch { /* never break the session */ }
    }
  } catch { /* hook failures must never surface in the host TUI */ }
  finally { if (dir) { try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } } }
};

export const AgentMBXHooks = async ({ $, client, directory }: { $: Shell; client?: unknown; directory?: string }) => {
  const run = (event: string, payload: Record<string, unknown>) => call($, client, ${bin}, event, { cwd: directory, ...payload });
  return {
    event: async ({ event }: { event?: { type?: string; properties?: Record<string, unknown> } }) => {
      const p = event?.properties ?? {};
      const info = (p.info ?? p.session) as { id?: unknown; directory?: unknown } | undefined;
      const sid = typeof info?.id === "string" ? info.id : typeof p.sessionID === "string" ? p.sessionID : undefined;
      if (!sid) return;
      if (event?.type === "session.created") return run("session-start", { session_id: sid, cwd: typeof info?.directory === "string" ? info.directory : directory });
      if (event?.type === "session.idle") return run("stop", { session_id: sid });
    },
    "tool.execute.after": async (input: { sessionID?: unknown; session_id?: unknown }) => {
      const sid = typeof input?.sessionID === "string" ? input.sessionID : typeof input?.session_id === "string" ? input.session_id : undefined;
      if (sid) return run("post-tool", { session_id: sid });
    },
  };
};

// OpenCode v2's loader validates a DEFAULT plugin object ({ id, ... effect/setup }); v1 ran named
// factories. Export both so the same file loads on either generation: without this the module
// fails with PluginModule.LoadError (SchemaError Missing key ["default"]) and no hook ever runs.
export default {
  id: "agentmbx-hooks",
  server: AgentMBXHooks,
  setup: AgentMBXHooks,
};
`;
}
/** The OpenCode hooks edit: one whole file we own. Foreign content is left alone and reported. */
export function opencodeHooks(cmd, ver) {
    const content = opencodePluginSource(cmd, ver);
    return {
        install: (cur) => (cur === null || isOpencodePluginOurs(cur)) && cur !== content ? content : cur,
        uninstall: (cur) => (cur === null || isOpencodePluginOurs(cur)) ? null : cur,
        isWired: (cur) => cur === content,
    };
}
// ---- OpenCode (JSONC) ------------------------------------------------------------------------
function opencodeServer(cmd) {
    const desired = { type: "local", command: [...cmd, "mcp"] };
    const src = `{ "type": "local", "command": [${desired.command.map((s) => JSON.stringify(s)).join(", ")}] }`;
    /** The object that holds servers: mcp.servers (OpenCode 2), or mcp itself when it already holds servers directly (1.x). */
    const container = (root) => {
        const mcp = member(root, "mcp")?.value;
        if (!mcp || mcp.kind !== "object")
            return { mcp, target: undefined };
        const servers = member(mcp, "servers")?.value;
        if (servers?.kind === "object")
            return { mcp, target: servers };
        const v1 = mcp.members.some((m) => m.value.kind === "object" && member(m.value, "type"));
        return { mcp, target: v1 ? mcp : undefined };
    };
    return {
        install: (cur) => {
            const text = cur ?? `{\n  "$schema": "https://opencode.ai/config.json"\n}\n`;
            const root = parseJsonc(text);
            if (root.kind !== "object")
                throw new Error("expected a JSON object");
            const { mcp, target } = container(root);
            let out;
            if (!mcp)
                out = insertMember(text, root, "mcp", `{ "servers": { "mbx": ${src} } }`);
            else if (mcp.kind !== "object")
                throw new Error(`"mcp" is not an object`);
            else if (!target)
                out = insertMember(text, mcp, "servers", `{ "mbx": ${src} }`);
            else {
                const m = member(target, "mbx");
                if (m && same(valueOf(text, m.value), desired))
                    return cur;
                out = m ? replaceValue(text, m, src) : insertMember(text, target, "mbx", src);
            }
            parseJsonc(out); // never write something we cannot read back
            return out;
        },
        uninstall: (cur) => {
            if (cur === null)
                return null;
            const root = parseJsonc(cur);
            const { target } = container(root);
            if (!target || !member(target, "mbx"))
                return cur;
            const out = removeMember(cur, target, "mbx");
            parseJsonc(out);
            return out;
        },
    };
}
// ---- Hermes (YAML, minimal text edit) --------------------------------------------------------
function hermesServer(cmd) {
    const body = (ind) => [`${ind}mbx:`, `${ind}  command: ${JSON.stringify(cmd[0])}`, `${ind}  args: ${JSON.stringify([...cmd.slice(1), "mcp"]).replace(/","/g, `", "`)}`];
    const indentOf = (l) => /^ */.exec(l)[0].length;
    const topLevel = (l) => /^[^\s#]/.test(l);
    const locate = (lines) => {
        const h = lines.findIndex((l) => /^mcp_servers:\s*(#.*)?$/.test(l) || /^mcp_servers:\s*(\{\s*\}|null|~)\s*$/.test(l));
        if (h < 0)
            return null;
        let end = h + 1;
        while (end < lines.length && !topLevel(lines[end]))
            end++;
        const firstChild = lines.slice(h + 1, end).find((l) => l.trim() && !l.trim().startsWith("#"));
        const ind = firstChild ? " ".repeat(indentOf(firstChild)) : "  ";
        const mbx = lines.findIndex((l, i) => i > h && i < end && l === `${ind}mbx:`);
        let mbxEnd = mbx + 1;
        if (mbx >= 0)
            while (mbxEnd < end && (!lines[mbxEnd].trim() || indentOf(lines[mbxEnd]) > ind.length))
                mbxEnd++;
        while (mbx >= 0 && mbxEnd > mbx + 1 && !lines[mbxEnd - 1].trim())
            mbxEnd--;
        return { h, end, ind, mbx, mbxEnd, hasChildren: !!firstChild };
    };
    return {
        install: (cur) => {
            if (cur === null)
                return null;
            const lines = cur.split("\n");
            const r = locate(lines);
            if (!r)
                return appendBlock(cur, ["mcp_servers:", ...body("  ")].join("\n"));
            const want = body(r.ind);
            if (r.mbx >= 0) {
                if (same(lines.slice(r.mbx, r.mbxEnd), want))
                    return cur;
                lines.splice(r.mbx, r.mbxEnd - r.mbx, ...want);
            }
            else {
                lines[r.h] = "mcp_servers:";
                lines.splice(r.h + 1, 0, ...want);
            }
            return lines.join("\n");
        },
        uninstall: (cur) => {
            if (cur === null)
                return null;
            const lines = cur.split("\n");
            const r = locate(lines);
            if (!r || r.mbx < 0)
                return cur;
            lines.splice(r.mbx, r.mbxEnd - r.mbx);
            const after = locate(lines);
            if (!after.hasChildren)
                return removeBlock(lines.join("\n"), after.h, after.h + 1);
            return lines.join("\n");
        },
    };
}
export function detect(ctx) {
    const h = ctx.home;
    const d = (cli, bin, dir) => {
        const onPath = ctx.which(bin);
        return { cli, found: !!onPath || existsSync(join(h, dir)), why: onPath ? `${bin} on PATH` : existsSync(join(h, dir)) ? `~/${dir} exists` : "not found" };
    };
    const hermesCfg = existsSync(join(h, ".hermes/config.yaml"));
    return [d("claude", "claude", ".claude"), d("codex", "codex", ".codex"), d("opencode", "opencode", ".config/opencode"), d("kimi", "kimi", ".kimi-code"), d("grok", "grok", ".grok"),
        { cli: "hermes", found: hermesCfg, why: hermesCfg ? "~/.hermes/config.yaml exists" : ctx.which("hermes") || existsSync(join(h, ".hermes")) ? "no ~/.hermes/config.yaml yet" : "not found" }];
}
export const opencodeConfig = (home) => {
    const dir = join(home, ".config/opencode");
    return [join(dir, "opencode.jsonc"), join(dir, "opencode.json")].find((p) => existsSync(p)) ?? join(dir, "opencode.jsonc");
};
export function edits(ctx, cli) {
    const { home, cmd } = ctx;
    const mcpArgs = [...cmd.slice(1), "mcp"];
    switch (cli) {
        case "claude": {
            const entry = { type: "stdio", command: cmd[0], args: mcpArgs, env: {} };
            const srv = jsonServer("mcpServers", entry, (e) => e.command === cmd[0] && same(e.args ?? [], mcpArgs));
            return [
                { cli, kind: "mcp", item: "MCP server mbx (user scope)", path: join(home, ".claude.json"), ...srv,
                    viaCli: (c, mode, cur) => {
                        if (!c.useClis || !c.which("claude"))
                            return false;
                        const has = !!cur && !!parseObj(cur).mcpServers?.mbx;
                        try {
                            if (has)
                                execFileSync("claude", ["mcp", "remove", "--scope", "user", "mbx"], { stdio: "ignore" });
                            if (mode === "install")
                                execFileSync("claude", ["mcp", "add", "--scope", "user", "mbx", "--", ...cmd, "mcp"], { stdio: "ignore" });
                            return true;
                        }
                        catch {
                            return false;
                        }
                    } },
                { cli, kind: "hooks", item: "hooks SessionStart + SessionEnd + UserPromptSubmit + PostToolUse + PermissionRequest + Stop", path: join(home, ".claude/settings.json"),
                    ...jsonHooks([...STOP_EVENTS, ["PostToolUse", "post-tool"], ["SessionEnd", "session-end"]], "claude", cmd, posttoolFastPath(home, cmd)),
                    isWired: (cur) => {
                        try {
                            const hooks = (JSON.parse(cur ?? "null")?.hooks ?? {});
                            const directPostTool = (hooks.PostToolUse ?? []).some((g) => (g.hooks ?? []).some((h) => (h.command ?? "").includes(" hook post-tool --cli claude")));
                            if (!directPostTool)
                                return false;
                            // Review medium 4: an old-style wiring counts only if EVERY event is wired in the
                            // old style too — a file holding just PostToolUse must not read as fully wired.
                            const plain = jsonHooks([...STOP_EVENTS, ["PostToolUse", "post-tool"], ["SessionEnd", "session-end"]], "claude", cmd);
                            return plain.install(cur) === cur;
                        }
                        catch {
                            return false;
                        }
                    } },
                { cli, kind: "statusline", item: "statusLine (MBX segment)", path: join(home, ".claude/settings.json"), ...claudeStatusLine(home, cmd),
                    isWired: (cur) => {
                        // Either exact render command is ours and functional (script form when the skill ships
                        // it, direct form otherwise); install() normalizes to the script form on the next run.
                        try {
                            return isOurStatusline(home, "claude", cmd, JSON.parse(cur ?? "null")?.statusLine?.command);
                        }
                        catch {
                            return false;
                        }
                    } },
            ];
        }
        case "codex":
            return [
                { cli, kind: "mcp", item: "[mcp_servers.mbx]", path: join(home, ".codex/config.toml"), ...codexServer(cmd) },
                { cli, kind: "hooks", item: "hooks SessionStart + UserPromptSubmit + PermissionRequest + Stop", path: join(home, ".codex/hooks.json"),
                    ...jsonHooks(STOP_EVENTS, "codex", cmd) },
            ];
        case "opencode":
            // T391: OpenCode has no settings-file hooks — the first-party mechanism is the plugin module
            // auto-loaded from ~/.config/opencode/plugins/, translating OpenCode events onto the shared
            // `agentmbx hook ... --cli opencode` contract (session-start / post-tool / stop continuation).
            return [
                { cli, kind: "mcp", item: "mcp.servers.mbx", path: opencodeConfig(home), ...opencodeServer(cmd) },
                { cli, kind: "hooks", item: "plugin session.created + tool.execute.after + session.idle", path: opencodePluginPath(home), ...opencodeHooks(cmd, version()) },
            ];
        case "kimi": {
            const kimi = (home === homedir() && process.env.KIMI_CODE_HOME) || join(home, ".kimi-code");
            const srv = jsonServer("mcpServers", { command: cmd[0], args: mcpArgs }, (e) => e.command === cmd[0] && same(e.args ?? [], mcpArgs), true);
            return [
                { cli, kind: "mcp", item: "mcpServers.mbx", path: join(kimi, "mcp.json"), ...srv },
                { cli, kind: "hooks", item: "[[hooks]] SessionStart + UserPromptSubmit + PermissionRequest + Stop", path: join(kimi, "config.toml"), ...kimiHooks(cmd) },
                { cli, kind: "statusline", item: "[status_line] (MBX segment)", path: join(kimi, "tui.toml"), ...kimiStatusLine(home, cmd) },
            ];
        }
        case "grok": {
            // T337: setup edits grok's config.toml with the verified text edit ALWAYS (re-review high A:
            // `grok mcp add/remove` rewrites the whole file and drops the user's comments, env and
            // startup_timeout_sec — the CLI's own writer is not byte-preserving). GROK_HOME is honored.
            const dir = (home === homedir() && process.env.GROK_HOME) || join(home, ".grok");
            const config = join(dir, "config.toml");
            return [
                { cli, kind: "mcp", item: "[mcp_servers.mbx] (user scope)", path: config, ...grokMcp(cmd) },
                { cli, kind: "statusline", item: "[ui.status_line] (MBX segment)", path: config, ...grokStatusLine(home, cmd),
                    isWired: (cur) => { try {
                        const st = grokStatus(cur ?? "");
                        return st.form === "section" && isOurStatusline(home, "grok", cmd, grokCommandValue(st.body) ?? undefined);
                    }
                    catch {
                        return false;
                    } } },
                // T384: same file, same parse-guard and byte-exact uninstall as the MCP and status line edits.
                { cli, kind: "hooks", item: "hooks SessionStart + UserPromptSubmit + PostToolUse + Stop", path: config, ...grokHooks(cmd) },
            ];
        }
        case "hermes":
            return [{ cli, kind: "mcp", item: "mcp_servers.mbx", path: join(home, ".hermes/config.yaml"), ...hermesServer(cmd) }];
    }
}
/** Is this edit already in its installed state? (Used by doctor.) */
export function wired(e) {
    const cur = read(e.path);
    try {
        return cur !== null && (e.isWired?.(cur) || e.install(cur) === cur);
    }
    catch {
        return false;
    }
}
// ---- skill -----------------------------------------------------------------------------------
export const skillDest = (home) => join(home, ".agents/skills/agentmbx");
const skillLinks = (home) => [join(home, ".claude/skills"), join(home, ".codex/skills")].filter((d) => existsSync(d)).map((d) => join(d, "agentmbx"));
function filesIn(dir, rel = "") {
    return readdirSync(join(dir, rel), { withFileTypes: true }).flatMap((e) => e.isDirectory() ? filesIn(dir, join(rel, e.name)) : [join(rel, e.name)]);
}
// Self-healing skill (S1, owner decision 2026-10-02): the skill always matches the running AgentMBX without anyone
// managing it. A copy AgentMBX wrote carries a marker with the hash of what it wrote; an unchanged copy is refreshed on
// every session start and daemon start, a copy someone edited is left alone, and a copy installed with `npx skills`
// (an agentmbx entry in ~/.agents/.skill-lock.json) is that tool's to update. The skills CLI already lists our copy as a
// local skill; no lock entry is written, so `npx skills update` never replaces it with a different version from GitHub.
const SKILL_MARKER = ".agentmbx-skill.json";
const skillHash = (files) => createHash("sha256").update(JSON.stringify(Object.keys(files).sort().map((f) => [f, files[f]]))).digest("hex");
const installedFiles = (dest, names) => Object.fromEntries(names.map((f) => [f, read(join(dest, f)) ?? ""]));
const skillsCliOwns = (home) => { try {
    return !!JSON.parse(read(join(home, ".agents/.skill-lock.json")) ?? "{}")?.skills?.agentmbx;
}
catch {
    return false;
} };
export function skillState(home) {
    const dest = skillDest(home), src = skillFiles(), names = Object.keys(src);
    if (!existsSync(join(dest, "SKILL.md")))
        return { state: "missing", detail: "not installed" };
    const current = names.every((f) => read(join(dest, f)) === src[f]);
    if (skillsCliOwns(home))
        return { state: "skills-cli", detail: current ? "installed with npx skills, current" : "installed with npx skills and older than this AgentMBX: npx skills update agentmbx" };
    if (current)
        return { state: "current", detail: `installed, current (${version()})` };
    let marker = null;
    try {
        marker = JSON.parse(read(join(dest, SKILL_MARKER)) ?? "null");
    }
    catch { /* unreadable marker: treat as edited */
        marker = { hash: "" };
    }
    // the hash covers exactly the files that copy was written with, so a newer bundle with more files still matches
    const written = Array.isArray(marker?.files) && marker.files.every((f) => typeof f === "string") ? marker.files : ["SKILL.md"];
    if (marker && marker.hash !== skillHash(installedFiles(dest, written)))
        return { state: "modified", detail: "installed, edited locally; left as is (agentmbx setup --only skill replaces it)" };
    // our unchanged copy, or one an older AgentMBX wrote before markers existed (its frontmatter names it)
    if (marker || /^name:\s*agentmbx\s*$/m.test(read(join(dest, "SKILL.md")) ?? ""))
        return { state: "outdated", detail: "installed, older than this AgentMBX (refreshed automatically at the next session or daemon start)" };
    return { state: "modified", detail: "installed, not written by AgentMBX; left as is (agentmbx setup --only skill replaces it)" };
}
/** Write the bundled skill and its marker. A pre-marker copy keeps a .bak of what it replaced. */
/** Write one file so a concurrent reader sees the old or the new content, never a partial one: a unique temp file in the
 *  same directory, then an atomic rename over the target. */
function writeAtomic(path, content) {
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
}
function writeSkill(home) {
    const dest = skillDest(home), src = skillFiles();
    if (!existsSync(join(dest, SKILL_MARKER)) && existsSync(join(dest, "SKILL.md")))
        writeAtomic(join(dest, "SKILL.md.bak"), read(join(dest, "SKILL.md")) ?? "");
    // two sessions starting together may both refresh: each file is replaced atomically, and the marker is written last
    for (const [f, c] of Object.entries(src))
        writeAtomic(join(dest, f), c);
    writeAtomic(join(dest, SKILL_MARKER), JSON.stringify({ version: version(), files: Object.keys(src).sort(), hash: skillHash(src), written_at: new Date().toISOString() }, null, 2) + "\n");
}
/** Refresh our own outdated copy; never install a removed skill, touch an edited one, or one `npx skills` manages. */
export function selfHealSkill(home, env = process.env) {
    // test and dev runs use throwaway mailbox homes but the real home folder: never rewrite the developer's own skill
    if (env.AGENTMBX_DEV === "1" && env.AGENTMBX_SKILL_SELFHEAL !== "1")
        return "current";
    try {
        const s = skillState(home).state;
        if (s !== "outdated")
            return s;
        writeSkill(home);
        return "current";
    }
    catch {
        return "outdated";
    } // read-only home or a race with another session: the next start tries again
}
export function skillStatus(home) {
    const dest = skillDest(home);
    const st = skillState(home);
    return { installed: st.state === "current" || st.state === "skills-cli", ...st,
        links: skillLinks(home).map((p) => { let ok = false; try {
            ok = readlinkSync(p) === dest;
        }
        catch { /* missing */ } return { path: p, ok }; }) };
}
function skill(ctx, mode, dryRun) {
    const rows = [];
    const dest = skillDest(ctx.home);
    if (mode === "install") {
        const src = skillFiles();
        const diff = Object.keys(src).filter((f) => read(join(dest, f)) !== src[f]);
        if (!dryRun && (diff.length || !existsSync(join(dest, SKILL_MARKER))))
            writeSkill(ctx.home); // also stamps the marker
        rows.push({ cli: "skill", item: "agentmbx skill", path: dest, action: !diff.length ? "unchanged" : existsSync(join(dest, "SKILL.md")) || dryRun && existsSync(dest) ? "updated" : "added" });
    }
    for (const link of skillLinks(ctx.home)) {
        let st = null;
        try {
            st = lstatSync(link);
        }
        catch { /* missing */ }
        const ours = !!st?.isSymbolicLink() && readlinkSync(link) === dest;
        if (mode === "install") {
            if (ours)
                rows.push({ cli: "skill", item: "symlink", path: link, action: "unchanged" });
            else if (st)
                rows.push({ cli: "skill", item: "symlink", path: link, action: "skipped", note: "something else already exists there" });
            else {
                if (!dryRun)
                    symlinkSync(dest, link);
                rows.push({ cli: "skill", item: "symlink", path: link, action: "added" });
            }
        }
        else if (ours) {
            if (!dryRun)
                unlinkSync(link);
            rows.push({ cli: "skill", item: "symlink", path: link, action: "removed" });
        }
    }
    if (mode === "uninstall") {
        const ours = /^name:\s*agentmbx\s*$/m.test(read(join(dest, "SKILL.md")) ?? "");
        if (ours && !dryRun)
            rmSync(dest, { recursive: true, force: true });
        rows.push({ cli: "skill", item: "agentmbx skill", path: dest, action: ours ? "removed" : "unchanged" });
    }
    return rows;
}
export const timestamp = (d = new Date()) => d.toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
export function runSetup(ctx, o) {
    const rows = [];
    const stamp = o.stamp ?? timestamp();
    // Review major 5: the skill ships the statusline/post-tool adapters the CLI edits reference —
    // install it FIRST so a single `agentmbx setup` reaches the final wiring state (no second run
    // to upgrade a node-adapter command to the bundled sh adapter).
    const skillRows = o.only && !o.only.includes("skill") ? null : skill(ctx, o.mode, !!o.dryRun);
    for (const d of detect(ctx)) {
        if (o.only && !o.only.includes(d.cli))
            continue;
        if (!d.found) {
            rows.push({ cli: d.cli, item: "-", path: "-", action: "skipped", note: d.why });
            continue;
        }
        for (const e of edits(ctx, d.cli)) {
            const row = { cli: e.cli, item: e.item, path: e.path, action: "unchanged" };
            try {
                const cur = read(e.path);
                const next = o.mode === "install" ? e.install(cur) : e.uninstall(cur);
                if (next === cur) {
                    rows.push(row);
                    continue;
                }
                row.action = o.mode === "uninstall" ? "removed" : cur !== null && e.uninstall(cur) !== cur ? "updated" : "added";
                if (!o.dryRun) {
                    if (cur !== null) {
                        row.backup = `${e.path}.bak-agentmbx-${stamp}`;
                        if (!existsSync(row.backup))
                            writeFileSync(row.backup, cur, { mode: 0o600 });
                    }
                    if (!e.viaCli?.(ctx, o.mode, cur)) {
                        if (next === null)
                            rmSync(e.path, { force: true });
                        else {
                            mkdirSync(dirname(e.path), { recursive: true });
                            writeFileSync(e.path, next);
                        }
                    }
                    else
                        row.note = `via ${e.cli} CLI`;
                }
            }
            catch (err) {
                row.action = "error";
                row.note = err.message;
            }
            rows.push(row);
        }
        if (d.cli === "codex" && o.mode === "install" && rows.some((r) => r.cli === "codex" && r.item.startsWith("hooks") && r.action !== "unchanged"))
            rows.push({ cli: "codex", item: "note", path: "-", action: "manual", note: "Codex may ask you to review/trust the new hooks on next start" });
        // T347: a user's own status line is never overwritten — report it and print the snippet instead.
        if (o.mode === "install" && (d.cli === "claude" || d.cli === "kimi" || d.cli === "grok") && statuslineState(ctx.home, d.cli, ctx.cmd) === "foreign")
            rows.push({ cli: d.cli, item: "statusLine", path: "-", action: "manual",
                note: `an existing status line was left alone; add the MBX segment yourself: ${d.cli === "claude"
                    ? `"statusLine": { "type": "command", "command": ${JSON.stringify(statuslineCommand(ctx.home, "claude", ctx.cmd))} }`
                    : d.cli === "grok"
                        ? `[ui.status_line]\ntype = "command"\ncommand = ${JSON.stringify(statuslineCommand(ctx.home, "grok", ctx.cmd))}`
                        : `[status_line]\ncommand = ${JSON.stringify(statuslineCommand(ctx.home, "kimi", ctx.cmd))}`}` });
    }
    if (skillRows)
        rows.push(...skillRows);
    // A running OpenCode service only reads its config at start.
    const oc = rows.find((r) => r.cli === "opencode" && (r.action === "added" || r.action === "updated" || r.action === "removed"));
    if (oc && !o.dryRun && ctx.useClis && ctx.which("opencode")) {
        try {
            const status = execFileSync("opencode", ["service", "status"], { encoding: "utf8", timeout: 10_000 });
            if (/https?:\/\//.test(status)) {
                execFileSync("opencode", ["service", "restart"], { stdio: "ignore", timeout: 30_000 });
                oc.note = "opencode service restarted";
            }
        }
        catch { /* not running */ }
    }
    return rows;
}
export function formatRows(rows, home = homedir()) {
    const tilde = (p) => p.startsWith(home) ? `~${p.slice(home.length)}` : p;
    const cells = rows.map((r) => [r.cli, r.action, r.item, tilde(r.path), [r.note, r.backup ? `backup ${tilde(r.backup)}` : ""].filter(Boolean).join("; ")]);
    const head = ["CLI", "RESULT", "WHAT", "FILE", "NOTES"];
    const w = head.map((h, i) => Math.max(h.length, ...cells.map((c) => c[i].length)));
    return [head, ...cells].map((c) => c.map((x, i) => i === c.length - 1 ? x : x.padEnd(w[i])).join("  ").trimEnd()).join("\n");
}
export const MANUAL_HINTS = {
    claude: "claude mcp add --scope user mbx -- agentmbx mcp",
    codex: "add [mcp_servers.mbx] command = \"agentmbx\", args = [\"mcp\"] to ~/.codex/config.toml",
    opencode: "add \"mbx\": {\"type\":\"local\",\"command\":[\"agentmbx\",\"mcp\"]} under mcp.servers in ~/.config/opencode/opencode.jsonc",
    kimi: "add {\"mcpServers\":{\"mbx\":{\"command\":\"agentmbx\",\"args\":[\"mcp\"]}}} to ~/.kimi-code/mcp.json",
    grok: "grok mcp add mbx --scope user -- agentmbx mcp",
    hermes: "add mcp_servers: { mbx: { command: agentmbx, args: [mcp] } } to ~/.hermes/config.yaml",
};
/**
 * The owner step of `agentmbx setup`. An agent may run it: with the macOS Keychain helper, creating the key only needs the
 * human to approve a Touch ID / password prompt. Without the helper (Linux, SSH, no AgentMBX.app) the passphrase must be
 * typed on a terminal, so it prints the exact command for the human instead. Never fails setup.
 */
export async function ownerStep(o) {
    const log = o.log ?? ((l) => console.log(l));
    const info = ownerInfo(o.mbxHome);
    if (info) {
        log(`owner: key ${fingerprint(info.public_key)} (${info.backend === "keychain" ? "macOS Keychain, Touch ID" : "passphrase file"})`);
        return "present";
    }
    const helper = o.helper === undefined ? authHelperPath() : o.helper;
    const cmd = `${shJoin(o.cmd)} owner init`;
    if (!helper) {
        log(`owner: no owner key yet. It is how you (not an agent) approve grants and policies. Run this yourself in a terminal;\n  it asks for a new passphrase (an agent can't type it for you):\n    ${cmd}`);
        return "manual";
    }
    if (o.dryRun) {
        log("owner: would create your owner key in the macOS Keychain (a Touch ID / password prompt appears)");
        return "dry-run";
    }
    // never wait on a prompt that can't appear (SSH, no GUI login): print the commands instead
    const can = await (o.canPrompt ?? canPrompt)(helper);
    if (!can.ok) {
        log(`owner: no owner key yet, and ${can.reason.replace(/[.;].*$/s, "")}.\n  At the Mac, run: ${cmd}    (Touch ID)\n  Or here, with a passphrase: ${cmd} --backend file`);
        return "manual";
    }
    log(`owner: creating your owner key in the macOS Keychain.\n  A Touch ID / password prompt will appear: approve it. (Not at the Mac? Cancel it and run later: ${cmd})`);
    try {
        const r = await (o.create ?? ((h, hp) => createKeychainOwner(h, hp, 120_000)))(o.mbxHome, helper);
        log(`owner: key ${fingerprint(r.publicKey)} ${r.adopted ? "(already in the Keychain; now used here)" : "created"} (macOS Keychain, Touch ID)`);
        return "created";
    }
    catch (e) {
        log(`owner: not created (${e.message}).\n  Run later: ${cmd}`);
        return "failed";
    }
}
