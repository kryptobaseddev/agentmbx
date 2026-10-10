// `agentmbx setup`: wire the mbx MCP server, hooks and skill into every coding-agent CLI found on this machine.
// Every function takes a `home` root so tests (and dry runs) never touch the real user's configs. Each change is a
// pure text transform (current file text -> desired text), which makes it idempotent, previewable, reversible, and
// lets `agentmbx doctor` reuse the same code to decide whether a CLI is wired.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  accessSync, constants, copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync,
  realpathSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { homedir, hostname } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { insertMember, member, parseJsonc, removeMember, replaceValue, valueOf, type JNode } from "./jsonc.ts";
import { parse as parseToml } from "smol-toml";
import { fingerprint } from "./crypto.ts";
import { claudePluginStep, execCli, type CliRunner } from "./claude-plugin.ts";
import { version } from "./version.ts";
import { opencodeSidebarPackageJson, opencodeSidebarServerSource, opencodeSidebarSource, OPENCODE_SIDEBAR_MARKER } from "./opencode-sidebar.ts";
import { authHelperPath, canPrompt, createKeychainOwner, ownerInfo } from "./owner.ts";

export const CLIS = ["claude", "codex", "opencode", "kimi", "hermes", "grok"] as const;
export type CliId = (typeof CLIS)[number];
export type Action = "added" | "updated" | "removed" | "unchanged" | "skipped" | "manual" | "error";

// T502: the explicit MCP startup timeout setup writes. Measured cold starts sit close to the harness
// defaults (OpenCode connects in ~2.2s against a 5000ms default; Claude's p99 is ~4.3s), so every
// harness whose config format has a real startup-timeout field gets at least this much, written
// explicitly. Claude's ~/.claude.json and Kimi's mcp.json have no such field and get none.
export const MCP_STARTUP_TIMEOUT_SEC = 30;

export interface SetupCtx {
  home: string;                              // root that holds .claude, .codex, .config/opencode, ...
  cmd: string[];                             // argv agents run for agentmbx (mcp / hook are appended)
  which: (bin: string) => string | null;     // PATH lookup (tests pass () => null)
  useClis: boolean;                          // may invoke `claude mcp add` / `opencode service restart` (real home only)
  /** T416: tests pass this so plugin install never spawns the real claude binary. */
  runCli?: CliRunner;
}
export interface Row { cli: string; item: string; path: string; action: Action; backup?: string; note?: string }

/** One reversible change to one file. `install`/`uninstall` map the current text (null = no file) to the desired text. */
export interface Edit {
  /** `consent` is a CLI's own approval store for hooks we wrote (Hermes shell-hooks-allowlist.json): not a wiring of ours, so the
   *  generic doctor rows ignore it and a CLI-specific check reports it. */
  cli: CliId; kind: "mcp" | "hooks" | "sidebar" | "statusline" | "consent"; item: string; path: string;
  install: (cur: string | null) => string | null;
  uninstall: (cur: string | null) => string | null;
  viaCli?: (ctx: SetupCtx, mode: "install" | "uninstall", cur: string | null) => boolean; // true = done by the CLI itself
  /** T342: a wiring state that is functional but not what install() would write right now (the
   *  pre-fast-path `hook post-tool` command once the skill script exists). Wired, and the next
   *  setup run upgrades it; doctor should not call it "not wired" in between. */
  isWired?: (cur: string | null) => boolean;
  /** T460: why install() leaves this file alone although it is not wired (a layout we cannot edit without risking the user's
   *  content). Setup reports it as a manual row and doctor as not wired; null = install() can proceed. */
  blocked?: (cur: string | null) => string | null;
  /** File mode for a file setup creates (an existing file keeps its own). */
  mode?: number;
}

/** The bundled skill as {relative path: content}: embedded in the single executable (SEA asset), else read from ../skill. */
export function skillFiles(): Record<string, string> {
  if (isSea()) {
    const sea = createRequire(__filename_or_url())("node:sea") as { getAsset(k: string, enc: string): string };
    return { "SKILL.md": sea.getAsset("SKILL.md", "utf8") };
  }
  const dir = fileURLToPath(new URL("../skill", import.meta.url));
  return Object.fromEntries(filesIn(dir).map((f) => [f, readFileSync(join(dir, f), "utf8")]));
}
const __filename_or_url = () => (typeof __filename !== "undefined" ? __filename : import.meta.url);
declare const __filename: string | undefined;

// ---- helpers ---------------------------------------------------------------------------------
const shq = (s: string) => /^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
export const shJoin = (argv: string[]) => argv.map(shq).join(" ");
export const hookCommand = (cmd: string[], event: string, cli: string) => `${shJoin(cmd)} hook ${event} --cli ${cli}`;

// ---- T526/T532/T533: recognize our own entries by meaning, not by exact bytes ----------------

/** Split a shell command's leading binary part into tokens, resolving '…' and "…" quoting.
 *  Null when quoting is unbalanced — not parseable confidently, so never "ours". */
export function shellTokens(s: string): string[] | null {
  const out: string[] = [];
  let cur = "", quote: "'" | '"' | null = null;
  const push = () => { if (cur) { out.push(cur); cur = ""; } };
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quote === "'") {
      if (c === "'") { if (s[i + 1] === "'") { cur += "'"; i++; } else quote = null; } else cur += c;
      continue;
    }
    if (quote === '"') { if (c === '"') quote = null; else cur += c; continue; }
    if (c === "'" || c === '"') { quote = c; continue; }
    if (/\s/.test(c)) { push(); continue; }
    cur += c;
  }
  if (quote) return null;
  push();
  return out;
}

/** T533: this install's entry script (realpath), or null when there is none on disk (the SEA
 *  single binary has no script; the [node, script] form can never be "current" there). */
export function installedEntry(): string | null {
  try { return realpathSync(fileURLToPath(new URL("../bin/agentmbx.js", import.meta.url))); } catch { return null; }
}

/** T533: an [anyNode, script] MCP/hook pair wired by ANOTHER shell's node still names this install
 *  when the script realpaths to the installed entry. Whether it stays "current" additionally
 *  depends on the node existing (see callers); the script alone decides what it names. */
export function namesInstalledEntry(script: string): boolean {
  const entry = installedEntry();
  if (!entry) return false;
  try { return realpathSync(script) === entry; } catch { return false; }
}

/** T526/T532/T533: does `bin` run agentmbx? One token ending in agentmbx (bare, mise/asdf shim,
 *  SEA binary); or two tokens — a node-like runtime plus the agentmbx entry script (T504's
 *  node + script form), in any path spelling. A command composed with anything else is someone
 *  else's and is left alone. */
export function runsAgentmbx(bin: string): boolean {
  const t = shellTokens(bin);
  if (!t) return false;
  if (t.length === 1) return /(^|\/)agentmbx(\.exe)?$/.test(t[0]);
  return t.length === 2 && /(^|\/)(node|nodejs|bun|deno)[\w.]*(\.exe)?$/.test(t[0]) && /(^|\/)agentmbx\.js$/.test(t[1]);
}

/** T533: a configured [node, script, "mcp"] entry wired by ANOTHER shell's node names this install
 *  (script realpaths to the installed entry) and its node binary still exists — wired-and-current
 *  from any node, so neither doctor nor setup rewrites it. A missing node or a script that
 *  resolves elsewhere stays "ours but stale" and is rewritten in place by the writers. */
export function mcpNodeScriptCurrent(entry: { command?: unknown; args?: unknown }): boolean {
  if (typeof entry.command !== "string" || !Array.isArray(entry.args)) return false;
  const [script, ...rest] = entry.args as unknown[];
  return rest.length === 1 && rest[0] === "mcp" && typeof script === "string" && existsSync(entry.command) && namesInstalledEntry(script);
}

/** T533: the hooks twin of mcpNodeScriptCurrent — one of OUR hook commands naming [another
 *  existing node, this install's entry] is current; setup leaves the bytes alone instead of
 *  rewriting them to this shell's node path. A missing node or a script that resolves elsewhere
 *  is rewritten (the stale-entry rules of each writer). */
export function hookNamesInstalledEntry(command: string, sub: string, cli: string): boolean {
  const tail = ` hook ${sub} --cli ${cli}`;
  if (!command.endsWith(tail)) return false;
  const t = shellTokens(command.slice(0, -tail.length));
  return !!t && t.length === 2 && existsSync(t[0]) && namesInstalledEntry(t[1]);
}

// T347: setup wires one status line per CLI — never overwrites a user's existing one. A foreign
// status line is left alone and reported (runSetup adds a manual row with the snippet); uninstall
// removes only what setup wrote. "Ours" is an EXACT match against a command setup itself writes
// (review blocker: the absolute script-path form or the shJoin(cmd) form — nothing else).
export const statuslineCommand = (home: string, cli: "claude" | "kimi" | "grok", cmd: string[]): string => {
  if (cli === "grok") return `${shJoin(cmd)} statusline grok`; // no bundled grok adapter: the direct form
  // The bundled pure-sh adapter when the skill ships it (SEA bundles SKILL.md only: the node adapter)
  const script = join(skillDest(home), "scripts", `${cli}-statusline.sh`);
  return existsSync(script) ? `sh ${shJoin([script])}` : `${shJoin(cmd)} statusline ${cli}`;
};
/** The command forms a CURRENT setup writes and recognizes as up to date (T368: doctor warns on
 *  an older recognized form — isOurStatusline also matches those so they upgrade, never read foreign). */
export const statuslineForms = (home: string, cli: "claude" | "kimi" | "grok", cmd: string[]): Set<string> => new Set([
  `sh ${shJoin([join(skillDest(home), "scripts", `${cli}-statusline.sh`)])}`,
  `${shJoin(cmd)} statusline ${cli}`,
]);
/** T536: a status line is current when setup would write it, or when it is any existing node
 *  plus this install's entry (the T533 matcher). A mise shim or bare `agentmbx` is ours but not
 *  current, so setup rewrites it and doctor warns — the two never disagree. */
export function statuslineCurrent(home: string, cli: "claude" | "kimi" | "grok", cmd: string[], command: string): boolean {
  if (statuslineForms(home, cli, cmd).has(command)) return true;
  const tail = ` statusline ${cli}`;
  if (!command.endsWith(tail)) return false;
  const tokens = shellTokens(command.slice(0, -tail.length));
  return !!tokens && tokens.length === 2 && existsSync(tokens[0]) && namesInstalledEntry(tokens[1]);
}
const isOurStatusline = (home: string, cli: "claude" | "kimi" | "grok", cmd: string[], command: string | undefined): boolean =>
  !!command && (statuslineForms(home, cli, cmd).has(command)
    // Re-review minor: also recognise the exact forms older setups wrote — the bare command and any
    // absolute agentmbx path — so those get upgraded and uninstalled rather than left as "foreign".
    || new RegExp(`^(?:agentmbx|\\S+/agentmbx) statusline ${cli}$`).test(command));
/** "absent" = nothing there, "ours" = an exact setup-written command, "foreign" = anything else.
 *  A malformed file is foreign, never a thrown runSetup (review major 2). */
export const statuslineState = (home: string, cli: "claude" | "kimi" | "grok", cmd: string[]): "absent" | "ours" | "foreign" => {
  try {
    if (cli === "claude") {
      const cur = read(join(home, ".claude/settings.json"));
      if (cur === null) return "absent";
      const command = (parseObj(cur).statusLine as { command?: string } | undefined)?.command;
      return command === undefined ? "absent" : isOurStatusline(home, cli, cmd, command) ? "ours" : "foreign";
    }
    if (cli === "grok") {
      const dir = (home === homedir() && process.env.GROK_HOME) || join(home, ".grok"); // re-review: honor GROK_HOME
      const cur = read(join(dir, "config.toml"));
      if (cur === null) return "absent";
      const st = grokStatus(cur);
      if (st.form !== "section") return st.form;
      return isOurStatusline(home, cli, cmd, grokCommandValue(st.body) ?? undefined) ? "ours" : "foreign";
    }
    const dir = (home === homedir() && process.env.KIMI_CODE_HOME) || join(home, ".kimi-code"); // review: honor KIMI_CODE_HOME
    const cur = read(join(dir, "tui.toml"));
    if (cur === null) return "absent";
    const st = kimiStatus(cur);
    if (st.form !== "section") return st.form;
    const command = kimiCommandValue(st.body);
    return command !== null && isOurStatusline(home, cli, cmd, command) ? "ours" : "foreign";
  } catch { return "foreign"; }
};

/** Where a tui.toml carries status_line config, and in what form. The section may be
 *  [status_line] with any spacing, a trailing comment or CRLF endings; any top-level status_line
 *  key in another form (inline table, dotted key) is FOREIGN — setup never appends a duplicate
 *  table (review major 3). */
type KimiStatus = { form: "absent" } | { form: "foreign" } | { form: "section"; body: string; commandLine: string | null };
const kimiStatus = (cur: string): KimiStatus => {
  // Parse guard (review E, applied to the Kimi edits too): invalid TOML, or a status_line key in
  // ANY non-section form (quoted key, inline table), is never edited.
  const parsed = tryParseToml(cur);
  if (parsed === null) return { form: "foreign" };
  if (tomlKeyExists(parsed, ["status_line"]) && !/(^|\r?\n)[ \t]*\[[ \t]*status_line[ \t]*\]/.test(cur)) return { form: "foreign" };
  // A top-level status_line key in non-section form: `status_line = {…}` or `status_line.items = …`
  if (/^[ \t]*status_line[ \t]*[=.]/m.test(cur)) return { form: "foreign" };
  const start = /(^|\n)[ \t]*\[[ \t]*status_line[ \t]*\][ \t]*(?:#[^\n]*)?\r?\n/.exec(cur);
  if (!start) return { form: "absent" };
  const headerAt = start.index + (start[0].startsWith("\n") ? 1 : 0);
  const rest = cur.slice(headerAt);
  const next = /\r?\n[ \t]*\[/.exec(rest);
  const body = next ? rest.slice(0, next.index) : rest; // ends with the section's own terminator, never the next separator
  const commandLine = /(?:^|\r?\n)([ \t]*command[ \t]*=[^\n]*\r?\n)/.exec(body)?.[1] ?? null; // capture excludes the leading \n, so a rewrite never eats it
  return { form: "section", body, commandLine };
};
/** A TOML basic-string value for `command = "…"`, unescaped (re-review: a path containing `"` must
 *  round-trip as ours, not read as foreign). T532: a line-ending backslash may fold the string onto
 *  the next line — the fold is unescaped before the value is used, so a folded entry still matches. */
const tomlStringValue = (body: string, key: string): string | null => {
  const m = new RegExp(`(?:^|\\r?\\n)[ \\t]*${key}[ \\t]*=[ \\t]*"((?:[^"\\\\]|\\\\[\\s\\S])*)"`).exec(body);
  if (!m) return null;
  try { return JSON.parse(`"${m[1].replace(/\\\r?\n[ \t]*/g, "")}"`) as string; } catch { return null; }
};
const kimiCommandValue = (body: string): string | null => tomlStringValue(body, "command");

/** The status line command actually configured for a CLI right now (re-review item 2: doctor
 *  checks the configured command, never the one setup would write). Read from the status line
 *  SECTION: grok's config.toml also holds [mcp_servers.mbx] with its own `command = `, and a whole-
 *  file scan would return that one; a status_line key in a non-section form has no command here. */
export const statuslineConfiguredCommand = (home: string, cli: "claude" | "kimi" | "grok"): string | null => {
  try {
    if (cli === "claude") return (parseObj(read(join(home, ".claude/settings.json"))).statusLine as { command?: string } | undefined)?.command ?? null;
    if (cli === "grok") {
      const dir = (home === homedir() && process.env.GROK_HOME) || join(home, ".grok");
      const cur = read(join(dir, "config.toml"));
      if (cur === null) return null;
      const st = grokStatus(cur);
      return st.form === "section" ? grokCommandValue(st.body) : null;
    }
    const dir = (home === homedir() && process.env.KIMI_CODE_HOME) || join(home, ".kimi-code");
    const cur = read(join(dir, "tui.toml"));
    if (cur === null) return null;
    const st = kimiStatus(cur);
    return st.form === "section" ? kimiCommandValue(st.body) : null;
  } catch { return null; }
};

function claudeStatusLine(home: string, cmd: string[]) {
  const want = () => statuslineCommand(home, "claude", cmd);
  return {
    install: (cur: string | null) => {
      const obj = parseObj(cur);
      const existing = obj.statusLine as Record<string, unknown> | undefined;
      if (existing && !isOurStatusline(home, "claude", cmd, existing.command as string | undefined)) return cur; // foreign: reported, never overwritten
      if (existing?.type === "command" && existing.command === want()) return cur;
      obj.statusLine = { ...existing, type: "command", command: want() }; // keep the user's other keys (padding etc.)
      return jsonOut(obj, cur);
    },
    uninstall: (cur: string | null) => {
      if (cur === null) return cur;
      const obj = parseObj(cur);
      const existing = obj.statusLine as Record<string, unknown> | undefined;
      if (!isOurStatusline(home, "claude", cmd, existing?.command as string | undefined)) return cur;
      // Re-review item 3: with our command removed, only non-command keys can remain — and a
      // statusLine without a command may be rejected by Claude. Remove the whole object.
      delete obj.statusLine;
      return jsonOut(obj, cur);
    },
  };
}

function kimiStatusLine(home: string, cmd: string[]) {
  const want = () => statuslineCommand(home, "kimi", cmd);
  const commandLineText = (w: string) => `command = ${JSON.stringify(w)}\n`; // JSON.stringify: a valid TOML basic string (review: escaping)
  const sectionText = (w: string) => `[status_line]\n${commandLineText(w)}`;
  return {
    install: (cur: string | null) => {
      const st = cur === null ? { form: "absent" as const } : kimiStatus(cur);
      if (st.form === "foreign") return cur; // reported by runSetup, never overwritten — and never appended (no duplicate table)
      const w = want();
      if (st.form === "section") {
        const command = kimiCommandValue(st.body);
        // Re-review major 1: a user's own section with items and NO command is foreign — adding our
        // command to THEIR section is their call, not setup's (manual row prints the snippet).
        if (command === null) return cur;
        if (!isOurStatusline(home, "kimi", cmd, command)) return cur; // a foreign command line: leave everything
        if (command === w) return cur;
        const eolOfFile = (cur ?? "").includes("\r\n") ? "\r\n" : "\n"; // minor: match the file's line ending
        // T366: rewrite ONLY our command line. Their other keys stay in the FILE, but Kimi renders
        // only the command — [status_line].command replaces the footer, items never compose with it.
        return guarded(cur, (cur ?? "").replace(st.commandLine!, () => `command = ${JSON.stringify(w)}${eolOfFile}`));
      }
      // Exactly one line ending between the prior content and our section — uninstall removes
      // exactly one too, so LF and CRLF files round-trip byte-exactly.
      const eol = (cur ?? "").includes("\r\n") ? "\r\n" : "\n";
      return guarded(cur, (cur ?? "") + (cur ? eol : "") + sectionText(w));
    },
    uninstall: (cur: string | null) => {
      if (cur === null) return cur;
      const st = kimiStatus(cur);
      if (st.form !== "section") return cur;
      const command = kimiCommandValue(st.body);
      if (command === null || !isOurStatusline(home, "kimi", cmd, command)) return cur; // foreign: never touched
      // remove ONLY our command line, byte-exact — no whitespace collapsing anywhere else (review minor 6)
      const lines = st.body.split("\n").filter((l) => !/^[ \t]*command[ \t]*=/.test(l));
      const meaningful = lines.filter((l) => l.trim() !== "" && !/^[ \t]*\[/.test(l));
      let next: string | null;
      if (meaningful.length) next = (cur ?? "").replace(st.body, () => lines.join("\n"));
      else {
        // the whole section goes; exactly one separator \n install added before it goes too
        const start = (cur ?? "").indexOf(st.body);
        const removalStart = start > 0 && (cur ?? "")[start - 1] === "\n" ? start - ((cur ?? "")[start - 2] === "\r" ? 2 : 1) : start;
        next = (cur ?? "").slice(0, removalStart) + (cur ?? "").slice(start + st.body.length);
      }
      if (next.trim() === "") next = null; // setup created the file: remove it entirely
      return guarded(cur, next); // re-review: uninstall is guarded too — never write invalid TOML
    },
  };
}
// T337: grok is a first-class CLI — its config.toml sections are found with the same robust rules
// as Kimi's (CRLF, trailing comments, inner spacing), "ours" is an exact match, edits keep the
// user's other keys, and uninstall removes exactly the inserted bytes (review items 2, 5, 6, 9, 10).

/** A TOML section (header plus body lines) up to the next section header at line start — tolerant
 *  of CRLF, a trailing comment, inner spacing, and quoted key parts (re-review: `[ui."status_line"]`). */
const tomlSectionAt = (cur: string, header: string): string | null => {
  const pattern = header.split(".").map((p) => `"?${p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"?`).join("[ \\t]*\\.[ \\t]*");
  const start = new RegExp(`(^|\\r?\\n)[ \\t]*\\[[ \\t]*${pattern}[ \\t]*\\][ \\t]*(?:#[^\\n]*)?\\r?\\n`).exec(cur);
  if (!start) return null;
  const headerAt = start.index + (start[0].startsWith("\n") || start[0].startsWith("\r") ? start[0].match(/^(\r?\n)/)![1].length : 0);
  const rest = cur.slice(headerAt);
  const next = /\r?\n[ \t]*\[/.exec(rest);
  // The body ends with the section's own line terminator, never the separator before the next
  // header — the separator belongs to whoever appended that section, and uninstall removes
  // exactly one of those per removed section (re-review regression fix).
  return next ? rest.slice(0, next.index) : rest;
};

/** smol-toml parse guard (re-review E): parse before editing — a key in a form we don't recognise
 *  stays manual — and never write invalid TOML back. Text edits stay, so comments survive. */
const tryParseToml = (cur: string): Record<string, unknown> | null => {
  try { return parseToml(cur) as Record<string, unknown>; } catch { return null; }
};
const tomlKeyExists = (obj: Record<string, unknown> | null, path: string[]): boolean => {
  let cur: unknown = obj;
  for (const key of path) {
    if (!cur || typeof cur !== "object" || !(key in (cur as Record<string, unknown>))) return false;
    cur = (cur as Record<string, unknown>)[key];
  }
  return true;
};
/** Refuse to write invalid TOML: the edit result must parse, or the file stays untouched. */
const guarded = (cur: string | null, next: string | null): string | null =>
  next !== cur && next !== null && tryParseToml(next) === null ? cur : next;

/** Where grok's config.toml carries [ui.status_line], and in what form. A `ui.status_line` dotted
 *  key, or a `status_line` key embedded in the `[ui]` section, is a form setup cannot edit —
 *  foreign, never appended (review high 2). */
type GrokStatus = { form: "absent" } | { form: "foreign" } | { form: "section"; body: string; commandLine: string | null };
const grokStatus = (cur: string): GrokStatus => {
  // Parse guard (review E): invalid TOML, or a status_line key in ANY form, is never edited.
  const parsed = tryParseToml(cur);
  if (parsed === null) return { form: "foreign" }; // invalid TOML: never write into it
  if (tomlKeyExists(parsed, ["status_line"])) return { form: "foreign" }; // a root status_line key
  if (tomlKeyExists(parsed, ["ui", "status_line"]) && !tomlSectionAt(cur, "ui.status_line")) return { form: "foreign" }; // a form we can't edit (quoted, inline)
  if (/^[ \t]*ui\.status_line[ \t]*[=.]/m.test(cur)) return { form: "foreign" }; // dotted key
  const ui = tomlSectionAt(cur, "ui");
  if (ui && /^[ \t]*status_line[ \t]*[=.]/m.test(ui)) return { form: "foreign" }; // embedded in [ui]
  const body = tomlSectionAt(cur, "ui.status_line");
  if (body === null) return { form: "absent" };
  const commandLine = /(?:^|\r?\n)([ \t]*command[ \t]*=[^\n]*\r?\n)/.exec(body)?.[1] ?? null; // capture excludes the leading newline, so a rewrite never eats it
  return { form: "section", body, commandLine };
};
const grokCommandValue = (body: string): string | null => tomlStringValue(body, "command");
const grokStatusCommand = (cmd: string[]) => `${shJoin(cmd)} statusline grok`;

function grokStatusLine(home: string, cmd: string[]) {
  const want = () => grokStatusCommand(cmd);
  const lineText = (key: string, w: string) => `${key} = ${JSON.stringify(w)}\n`; // valid TOML basic string (review: escaping)
  const sectionText = (w: string) => `[ui.status_line]\n${lineText("type", "command")}${lineText("command", w)}`;
  return {
    install: (cur: string | null) => {
      const st = cur === null ? { form: "absent" as const } : grokStatus(cur);
      if (st.form === "foreign") return cur; // reported, never overwritten — and never a duplicate table
      const w = want();
      if (st.form === "section") {
        const command = grokCommandValue(st.body);
        // Re-review medium B: a user section without exactly our command is foreign — a
        // `[ui.status_line] type = "builtin"` or no command at all is never edited, only reported.
        if (command === null || !isOurStatusline(home, "grok", cmd, command)) return cur;
        if (statuslineCurrent(home, "grok", cmd, command) && /(?:^|\r?\n)[ \t]*type[ \t]*=[ \t]*"command"/.test(st.body)) return cur;
        const eolOfFile = (cur ?? "").includes("\r\n") ? "\r\n" : "\n"; // minor: match the file's line ending
        return guarded(cur, (cur ?? "").replace(st.commandLine!, () => `command = ${JSON.stringify(w)}${eolOfFile}`)); // rewrite ONLY our line — type, refresh_interval, padding stay
      }
      // Exactly one line ending between the prior content and our section — uninstall removes
      // exactly one too, so LF and CRLF files round-trip byte-exactly.
      const eol = (cur ?? "").includes("\r\n") ? "\r\n" : "\n";
      return guarded(cur, (cur ?? "") + (cur ? eol : "") + sectionText(w));
    },
    uninstall: (cur: string | null) => {
      if (cur === null) return cur;
      const st = grokStatus(cur);
      if (st.form !== "section") return cur;
      const command = grokCommandValue(st.body);
      if (command === null || !isOurStatusline(home, "grok", cmd, command)) return cur; // foreign: never touched
      // remove ONLY our command line, byte-exact (review low 9)
      const lines = st.body.split("\n").filter((l) => !/^[ \t]*command[ \t]*=/.test(l));
      const meaningful = lines.filter((l) => l.trim() !== "" && !/^[ \t]*\[/.test(l) && !/^[ \t]*type[ \t]*=/.test(l));
      let next: string | null;
      if (meaningful.length) next = (cur ?? "").replace(st.body, () => lines.join("\n"));
      else {
        // the whole section goes; exactly one separator \n install added before it goes too
        const start = (cur ?? "").indexOf(st.body);
        const removalStart = start > 0 && (cur ?? "")[start - 1] === "\n" ? start - ((cur ?? "")[start - 2] === "\r" ? 2 : 1) : start;
        next = (cur ?? "").slice(0, removalStart) + (cur ?? "").slice(start + st.body.length);
      }
      if (next.trim() === "") next = null;
      return guarded(cur, next);
    },
  };
}

/** The [mcp_servers.mbx] section — grok's own schema (verified byte-for-byte against `grok mcp add`
 *  in an isolated GROK_HOME, review test 12). "Ours" is an exact command+args match (review med 5);
 *  the user's other keys in the section stay (review med 6). */
type GrokMcpState = { form: "absent" } | { form: "foreign" } | { form: "section"; body: string };
const grokMcpState = (cur: string): GrokMcpState => {
  // Parse guard (review E): invalid TOML, or an mbx key in ANY form we don't recognise, is never edited.
  const parsed = tryParseToml(cur);
  if (parsed === null) return { form: "foreign" };
  if (tomlKeyExists(parsed, ["mcp_servers", "mbx"]) && !tomlSectionAt(cur, "mcp_servers.mbx")) return { form: "foreign" };
  if (/^[ \t]*mcp_servers\.mbx[ \t]*[=.]/m.test(cur)) return { form: "foreign" }; // dotted key
  const parent = tomlSectionAt(cur, "mcp_servers");
  if (parent && /^[ \t]*mbx[ \t]*[=.]/m.test(parent)) return { form: "foreign" }; // embedded in [mcp_servers]
  const body = tomlSectionAt(cur, "mcp_servers.mbx");
  if (body === null) return { form: "absent" };
  return { form: "section", body };
};

function grokMcp(cmd: string[]) {
  const lineText = (key: string, w: string) => `${key} = ${JSON.stringify(w)}\n`;
  const argsText = `[${[...cmd.slice(1), "mcp"].map((a) => JSON.stringify(a)).join(", ")}]`;
  const wantCommand = cmd[0], wantArgs = argsText;
  // T502: grok's own schema has startup_timeout_sec (seconds); `grok mcp add` drops the field, so
  // setup writes and repairs it itself. It goes after `enabled`, the shape `grok mcp add` verifies.
  const timeoutLine = `startup_timeout_sec = ${MCP_STARTUP_TIMEOUT_SEC}\n`;
  const sectionText = () => `[mcp_servers.mbx]\n${lineText("command", wantCommand)}args = ${argsText}\nenabled = true\n${timeoutLine}`;
  const sectionArgs = (body: string): unknown => {
    const a = /^[ \t]*args[ \t]*=[ \t]*(\[[^\n]*\])/m.exec(body)?.[1];
    if (!a) return null;
    try { return JSON.parse(a); } catch { return null; }
  };
  // T533: grok keeps command and args in separate fields; [another node, this install's entry] in
  // those fields is ours. `current` additionally requires the node binary to exist.
  const entryNamesInstall = (body: string): boolean => {
    const args = sectionArgs(body);
    return Array.isArray(args) && typeof args[0] === "string" && (args as unknown[])[1] === "mcp" && namesInstalledEntry(args[0]);
  };
  const entryCurrent = (body: string): boolean => {
    const command = grokCommandValue(body);
    return command !== null && existsSync(command) && entryNamesInstall(body);
  };
  const ours = (body: string) => grokCommandValue(body) === wantCommand && body.includes(`args = ${wantArgs}`); // exact match (review med 5)
  // T532: ours in any older form too — a single-binary command (mise shim, bare, absolute) running
  // `agentmbx mcp`, or [any node, this install's entry] (T533). Uninstall removes those as well;
  // only another tool's mbx (agentmbx-fork, a foreign server) stays.
  const oursAnyForm = (body: string): boolean => {
    if (ours(body) || entryNamesInstall(body)) return true;
    const command = grokCommandValue(body);
    const args = sectionArgs(body);
    return command !== null && /(^|\/)agentmbx$/.test(command) && Array.isArray(args) && (args as unknown[]).length === 1 && args[0] === "mcp";
  };
  /** The section body with an adequate startup timeout: append ours when absent, raise a too-short one. */
  const withTimeout = (body: string): string => {
    const m = /(^|\r?\n)([ \t]*startup_timeout_sec[ \t]*=[ \t]*)(\d+)/.exec(body);
    if (!m) return body.endsWith("\n") ? body + timeoutLine : `${body}\n${timeoutLine}`;
    return Number(m[3]) >= MCP_STARTUP_TIMEOUT_SEC ? body : body.replace(m[0], `${m[1]}${m[2]}${MCP_STARTUP_TIMEOUT_SEC}`);
  };
  return {
    // T502 back-compat: a section an older setup wrote (no startup_timeout_sec) is still wired;
    // doctor warns about the missing timeout and the next setup run repairs the line.
    isWired: (cur: string | null) => {
      if (cur === null) return false;
      const st = grokMcpState(cur);
      return st.form === "section" && (ours(st.body) || entryCurrent(st.body));
    },
    install: (cur: string | null) => {
      const st = cur === null ? { form: "absent" as const } : grokMcpState(cur);
      if (st.form === "foreign") return cur;
      if (st.form === "section") {
        let body = st.body;
        if (!ours(body) && !entryCurrent(body)) {
          const command = grokCommandValue(body);
          // Ours in any older form (shim/bare single binary, or [node, this install's entry] with a
          // missing node — T533): replace in place. Anything else is another tool's mbx — never
          // overwritten (review med 5: agentmbx-fork is not ours).
          const oursOlder = command !== null && (/(^|\/)agentmbx$/.test(command) || entryNamesInstall(body));
          if (!oursOlder) return cur;
          // rewrite ONLY our command/args lines — the user's other keys in the section stay
          body = body
            .replace(/(^|\r?\n)[ \t]*command[ \t]*=[^\n]*(\r?\n)/, (_, p1: string, p2: string) => `${p1}command = ${JSON.stringify(wantCommand)}${p2}`)
            .replace(/(^|\r?\n)[ \t]*args[ \t]*=[^\n]*(\r?\n)/, (_, p1: string, p2: string) => `${p1}args = ${wantArgs}${p2}`);
        }
        const nextBody = withTimeout(body);
        if (nextBody === st.body) return cur;
        return guarded(cur, (cur ?? "").replace(st.body, () => nextBody));
      }
      const eol = (cur ?? "").includes("\r\n") ? "\r\n" : "\n";
      return guarded(cur, (cur ?? "") + (cur ? eol : "") + sectionText());
    },
    uninstall: (cur: string | null) => {
      if (cur === null) return cur;
      const st = grokMcpState(cur);
      if (st.form !== "section" || !oursAnyForm(st.body)) return cur;
      // the whole section goes; exactly one separator \n install added before it goes too
      const start = (cur ?? "").indexOf(st.body);
      const removalStart = start > 0 && (cur ?? "")[start - 1] === "\n" ? start - ((cur ?? "")[start - 2] === "\r" ? 2 : 1) : start;
      let next: string | null = (cur ?? "").slice(0, removalStart) + (cur ?? "").slice(start + st.body.length);
      if (next.trim() === "") next = null;
      return guarded(cur, next);
    },
  };
}

/** The command configured in `[mcp_servers.mbx]`, not the one setup would write. A missing file,
 *  a non-section form, or invalid TOML has no command to check. */
export function grokMcpConfiguredCommand(home: string): string | null {
  try {
    const dir = (home === homedir() && process.env.GROK_HOME) || join(home, ".grok");
    const cur = read(join(dir, "config.toml"));
    if (cur === null) return null;
    const st = grokMcpState(cur);
    return st.form === "section" ? grokCommandValue(st.body) : null;
  } catch { return null; }
}

// ---- T502/T504: what the harness configs currently hold --------------------------------------
const entryArgv = (e: unknown): string[] | null => {
  if (!e || typeof e !== "object") return null;
  const o = e as { command?: unknown; args?: unknown };
  if (typeof o.command !== "string") return null;
  return [o.command, ...(Array.isArray(o.args) ? o.args.filter((a): a is string => typeof a === "string") : [])];
};

/** The MCP command argv a CLI's config currently holds for mbx, without the trailing "mcp"
 *  subcommand: [node, script] for what T504's setup writes, [binary] for the older shim/direct
 *  forms (likewise [node, script] through codex/grok's command+args shape). Null when the config
 *  is absent, unparsable, or holds no mbx entry. */
export function mcpConfiguredCmd(home: string, cli: CliId): string[] | null {
  const raw = ((): string[] | null => {
    try {
      if (cli === "claude") return entryArgv((parseObj(read(join(home, ".claude.json"))).mcpServers as Record<string, unknown> | undefined)?.mbx);
      if (cli === "codex") {
        const cur = read(join(home, ".codex/config.toml"));
        if (cur === null) return null;
        const t = tryParseToml(cur);
        if (!t) return null;
        return entryArgv((t.mcp_servers as Record<string, unknown> | undefined)?.mbx);
      }
      if (cli === "opencode") {
        const cur = read(opencodeConfig(home));
        if (cur === null) return null;
        const { target } = opencodeMcpContainer(parseJsonc(cur));
        const e = target && member(target, "mbx")?.value;
        if (e?.kind !== "object") return null;
        const v = valueOf(cur, e) as { command?: unknown };
        return Array.isArray(v?.command) ? v.command.filter((a): a is string => typeof a === "string") : null;
      }
      if (cli === "kimi") {
        const dir = (home === homedir() && process.env.KIMI_CODE_HOME) || join(home, ".kimi-code");
        const cur = read(join(dir, "mcp.json"));
        if (cur === null) return null;
        let obj: unknown;
        try { obj = JSON.parse(cur); } catch { return null; }
        return entryArgv((obj as Record<string, unknown> | null)?.mcpServers ? (obj as Record<string, Record<string, unknown>>).mcpServers.mbx : null);
      }
      if (cli === "grok") {
        const dir = (home === homedir() && process.env.GROK_HOME) || join(home, ".grok");
        const cur = read(join(dir, "config.toml"));
        if (cur === null) return null;
        const st = grokMcpState(cur);
        if (st.form !== "section") return null;
        const command = grokCommandValue(st.body);
        if (command === null) return null;
        const a = /^[ \t]*args[ \t]*=[ \t]*(\[[^\n]*\])/m.exec(st.body)?.[1];
        let list: unknown = null;
        if (a) { try { list = JSON.parse(a); } catch { list = null; } } // the JSON flow form setup writes
        return [command, ...(Array.isArray(list) ? list.filter((x): x is string => typeof x === "string") : [])];
      }
      if (cli === "hermes") {
        const cur = read(hermesConfigPath(home));
        if (cur === null) return null;
        const e = hermesMcpParse(cur);
        return e && e.command !== null ? [e.command, ...(e.args ?? [])] : null;
      }
    } catch { return null; }
    return null;
  })();
  return raw && raw[raw.length - 1] === "mcp" ? raw.slice(0, -1) : raw;
}

/** The explicit MCP startup timeout (seconds) a CLI's config currently holds for mbx — T502's
 *  doctor check reads exactly this. Null when it is missing or unparseable; claude and kimi have
 *  no such field in their MCP config shape and always read null (they are never checked). */
export function mcpConfiguredTimeout(home: string, cli: CliId): number | null {
  try {
    if (cli === "codex") {
      const cur = read(join(home, ".codex/config.toml"));
      if (cur === null) return null;
      const t = tryParseToml(cur);
      if (!t) return null;
      const v = ((t.mcp_servers as Record<string, unknown> | undefined)?.mbx as { startup_timeout_sec?: unknown } | undefined)?.startup_timeout_sec;
      return typeof v === "number" ? v : null;
    }
    if (cli === "opencode") {
      const cur = read(opencodeConfig(home));
      if (cur === null) return null;
      const { target } = opencodeMcpContainer(parseJsonc(cur));
      const e = target && member(target, "mbx")?.value;
      if (e?.kind !== "object") return null;
      const v = valueOf(cur, e) as { timeout?: unknown };
      return typeof v?.timeout === "number" ? v.timeout / 1000 : null; // opencode's field is milliseconds
    }
    if (cli === "grok") {
      const dir = (home === homedir() && process.env.GROK_HOME) || join(home, ".grok");
      const cur = read(join(dir, "config.toml"));
      if (cur === null) return null;
      const st = grokMcpState(cur);
      if (st.form !== "section") return null;
      const m = /^[ \t]*startup_timeout_sec[ \t]*=[ \t]*(\d+)/m.exec(st.body);
      return m ? Number(m[1]) : null;
    }
    if (cli === "hermes") {
      const cur = read(hermesConfigPath(home));
      if (cur === null) return null;
      return hermesMcpParse(cur)?.connectTimeout ?? null;
    }
  } catch { return null; }
  return null;
}

/** Grok events the harness runs. PostToolUse is the one whose additionalContext is delivered.
 *  Stop continues a turn that is ending (T385, user-guide 10-hooks.md). PermissionRequest stays out. */
const GROK_HOOK_EVENTS = [["SessionStart", "session-start"], ["UserPromptSubmit", "prompt"], ["PostToolUse", "post-tool"], ["Stop", "stop"]] as const;
const grokHookSub = (event: string) => GROK_HOOK_EVENTS.find((e) => e[0] === event)?.[1] ?? null;

/** Ours is exactly `…/agentmbx hook <sub> --cli <cli>` (bare or quoted path). A composed command
 *  is someone else's hook and is left alone. */
function isOurGrokHookCommand(command: string, sub: string): boolean {
  const tail = ` hook ${sub} --cli grok`;
  if (!command.endsWith(tail)) return false;
  return runsAgentmbx(command.slice(0, -tail.length));
}

function inlineHookCommand(body: string): string | null {
  // T532: `\\[\s\S]` so a line-ending-backslash fold does not truncate the value; the fold unescapes to nothing.
  const m = /command[ \t]*=[ \t]*"((?:[^"\\]|\\[\s\S])*)"/.exec(body);
  if (!m) return null;
  try { return JSON.parse(`"${m[1].replace(/\\\r?\n[ \t]*/g, "")}"`) as string; } catch { return null; }
}

/** One `[[hooks.<Event>]]` table, including the newline that ends its last line. Contiguous
 *  tables meet exactly (end === next start), so a block uninstall removes only the bytes it added.
 *  T532: grok's own `grok hooks add` writes the hook as a nested `[[hooks.<Event>.hooks]]` table
 *  under the (often empty) event header — those nested headers continue the span; only a header
 *  that is not our nested table ends it. Without this the nested form's `command =` line sits
 *  outside the span, the entry is not recognised as ours, and setup appends a duplicate. */
function grokHookSpans(cur: string): { start: number; end: number; event: string; command: string | null; suspect: boolean }[] {
  const re = /[ \t]*\[\[[ \t]*hooks[ \t]*\.[ \t]*([A-Za-z]+)[ \t]*\]\][ \t]*(?:#[^\r\n]*)?\r?\n/g;
  const spans: { start: number; end: number; event: string; command: string | null; suspect: boolean }[] = [];
  for (const m of cur.matchAll(re)) {
    const start = m.index ?? 0, event = m[1];
    let after = start + m[0].length, end = cur.length;
    for (;;) {
      const next = /\r?\n[ \t]*\[/.exec(cur.slice(after));
      if (!next) break;
      const at = after + next.index + next[0].length - 1; // the '[' itself
      const head = /^(\[\[[^\]\r\n]*\]\]|\[[^\]\r\n]*\])/.exec(cur.slice(at))?.[1] ?? "";
      const nested = new RegExp(`^\\[\\[[ \\t]*hooks[ \\t]*\\.[ \\t]*${event}[ \\t]*\\.[ \\t]*hooks[ \\t]*\\]\\]$`).test(head);
      if (!nested) { end = at; break; }
      after = at + head.length;
    }
    const text = cur.slice(start, end);
    const command = inlineHookCommand(text);
    // T526 review rule: something that looks like ours but cannot be parsed confidently is
    // reported (a `manual` row), never duplicated and never rewritten.
    const suspect = command === null && /agentmbx|hook[ \t]+[a-z-]+[ \t]+--cli/.test(text);
    spans.push({ start, end, event, command, suspect });
  }
  return spans;
}

/** `[hooks]` / `[hooks.Name]` is one table. `[[hooks.Name]]` is an array of tables. smol-toml
 *  accepts both in one document; Grok's config must not. A file that already uses the table form
 *  is left untouched. */
function grokPlainHooksTable(cur: string): boolean {
  return /^[ \t]*\[hooks(?:\.[A-Za-z0-9_-]+)?\][ \t]*(?:#[^\r\n]*)?\r?$/m.test(cur);
}

function grokHooks(cmd: string[]) {
  const tableText = (event: string, command: string) =>
    `[[hooks.${event}]]\nhooks = [{ type = "command", command = ${JSON.stringify(command)}, timeout = 10 }]\n`;
  const oursIn = (cur: string, event: string, sub: string) => grokHookSpans(cur)
    .filter((s) => s.event === event && s.command !== null && isOurGrokHookCommand(s.command, sub));
  return {
    // T526 review rule: a hook entry that looks like ours but cannot be parsed confidently blocks
    // the edit — setup reports a `manual` row and touches nothing, never appends next to it.
    blocked: (cur: string | null) => {
      if (cur === null) return null;
      const suspect = grokHookSpans(cur).find((s) => s.suspect);
      return suspect ? `hooks.${suspect.event} mentions agentmbx but its command is not a plain TOML string; edit it by hand` : null;
    },
    install: (cur: string | null) => {
      if (cur !== null && (tryParseToml(cur) === null || grokPlainHooksTable(cur))) return cur;
      let next = cur ?? "";
      const missing: string[] = [];
      for (const [event, sub] of GROK_HOOK_EVENTS) {
        const want = hookCommand(cmd, sub, "grok");
        const ours = oursIn(next, event, sub);
        if (!ours.length) { missing.push(tableText(event, want)); continue; }
        if (ours[0].command !== want && ours[0].command !== null && !hookNamesInstalledEntry(ours[0].command, sub, "grok")) {
          // T532: `\\[\s\S]` so a line-ending-backslash-folded command is replaced whole — the
          // canonical single line in, the folded continuation bytes gone.
          const body = next.slice(ours[0].start, ours[0].end)
            .replace(/(command[ \t]*=[ \t]*)"(?:[^"\\]|\\[\s\S])*"/, `$1${JSON.stringify(want)}`);
          next = next.slice(0, ours[0].start) + body + next.slice(ours[0].end);
        }
        const extra = oursIn(next, event, sub).slice(1);
        for (const s of extra.reverse()) next = next.slice(0, s.start) + next.slice(s.end);
      }
      if (missing.length) {
        const block = missing.join("");
        next = next === "" ? block : next + (next.includes("\r\n") ? "\r\n" : "\n") + block;
      }
      return guarded(cur, next === "" ? null : next);
    },
    uninstall: (cur: string | null) => {
      if (cur === null || tryParseToml(cur) === null) return cur;
      const spans = grokHookSpans(cur).filter((s) => {
        const sub = grokHookSub(s.event);
        return !!sub && s.command !== null && isOurGrokHookCommand(s.command, sub);
      });
      if (!spans.length) return cur;
      const groups: { start: number; end: number }[] = [];
      for (const s of spans) {
        const g = groups.at(-1);
        if (g && g.end === s.start) g.end = s.end;
        else groups.push({ start: s.start, end: s.end });
      }
      let next = cur;
      for (const g of groups.reverse()) {
        // One separator newline per group — the same byte install added before an appended block.
        let start = g.start;
        if (start > 0 && next[start - 1] === "\n") start -= next[start - 2] === "\r" ? 2 : 1;
        next = next.slice(0, start) + next.slice(g.end);
      }
      if (next.trim() === "") next = "";
      return guarded(cur, next === "" ? null : next);
    },
  };
}

const isOurHook = (command: string, event: string, cli: string, cmd: string[]) =>
  (command.includes(` hook ${event} --cli ${cli}`) && (command.includes("agentmbx") || command.startsWith(shJoin(cmd))))
  // T342: the bundled sh fast path is ours too, so setup upgrades an old direct command to it (and back)
  || (event === "post-tool" && cli === "claude" && command.includes("claude-posttool.sh"));
/** T342: when the bundled skill ships the post-tool wrapper, PostToolUse runs it (zero node starts
 *  in steady state); otherwise the event keeps the direct `agentmbx hook` command (SEA bundles
 *  SKILL.md only). The wrapper alone decides nothing — it always falls through to the full hook
 *  on any doubt, so hook decisions stay identical. It gets the setup's own resolved command: a
 *  desktop-started Claude has a minimal PATH (review high — never rely on PATH agentmbx). */
const posttoolFastPath = (home: string, cmd: string[]) => (sub: string): string | null => {
  if (sub !== "post-tool") return null;
  const script = join(skillDest(home), "scripts", "claude-posttool.sh");
  return existsSync(script) ? `sh ${shJoin([script])} ${shJoin(cmd)}` : null;
};
const read = (p: string) => existsSync(p) ? readFileSync(p, "utf8") : null;
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

export function defaultWhich(bin: string): string | null {
  for (const dir of (process.env.PATH ?? "").split(delimiter).filter(Boolean)) {
    const p = join(dir, bin);
    try { accessSync(p, constants.X_OK); return p; } catch { /* next */ }
  }
  return null;
}

export function isSea(): boolean {
  try { return (createRequire(import.meta.url)("node:sea") as { isSea(): boolean }).isSea(); } catch { return false; }
}

/** The argv agents should run (T504): the SEA binary alone, else the absolute node binary running this
 *  process plus the absolute, symlink-resolved agentmbx entry script. The mise/asdf shim is deliberately
 *  not used: a mise upgrade or node pin rewrites or removes the shim and breaks every harness at once,
 *  while node + script stays valid as long as the install directory does. */
export function resolveCommand(home = homedir(), which = defaultWhich): string[] {
  if (isSea()) return [process.execPath];
  return [process.execPath, realpathSync(fileURLToPath(new URL("../bin/agentmbx.js", import.meta.url)))];
}

/** macOS: `scutil --get LocalHostName`; elsewhere the short hostname. Lowercased, a-z0-9-. */
export function defaultHostName(): string {
  let n = "";
  if (process.platform === "darwin") { try { n = execFileSync("scutil", ["--get", "LocalHostName"], { encoding: "utf8" }).trim(); } catch { /* fall back */ } }
  if (!n) n = hostname().split(".")[0];
  return n.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "host";
}

// ---- JSON (plain) helpers --------------------------------------------------------------------
const jsonIndent = (t: string | null) => (t && /^\{\s*\n([ \t]+)"/.exec(t)?.[1]) || "  ";
const jsonOut = (obj: unknown, cur: string | null) => JSON.stringify(obj, null, jsonIndent(cur)) + (cur === null || cur.endsWith("\n") ? "\n" : "");
const parseObj = (cur: string | null): Record<string, unknown> => {
  if (cur === null || !cur.trim()) return {};
  const v = JSON.parse(cur) as unknown;
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error("expected a JSON object");
  return v as Record<string, unknown>;
};

/** [CLI event, `agentmbx hook` subcommand]. PermissionRequest is YOLO (docs/POLICY.md §5): it answers only under an active policy. */
const HOOK_EVENTS: [string, string][] = [["SessionStart", "session-start"], ["UserPromptSubmit", "prompt"], ["PermissionRequest", "permission"]];
/** Claude and Codex also take a Stop hook that can keep the turn going ({"decision":"block"}) when mail arrived mid-turn. */
const STOP_EVENTS: [string, string][] = [...HOOK_EVENTS, ["Stop", "stop"]];

type HookGroup = { matcher?: string; hooks?: { type?: string; command?: string; timeout?: number }[] };

/** Hooks in the Claude/Codex shape: { hooks: { Event: [ { hooks: [ {type, command} ] } ] } }. Appends groups; never edits others.
 *  `commandFor` overrides the command for an event (T342: PostToolUse runs the bundled sh fast
 *  path when the skill script is installed; absent, the event keeps the direct `agentmbx hook`. */
function jsonHooks(events: [string, string][], cli: string, cmd: string[], commandFor?: (sub: string) => string | null) {
  const install = (cur: string | null) => {
    const obj = parseObj(cur); let changed = false;
    const hooks = (obj.hooks ??= {}) as Record<string, HookGroup[]>;
    for (const [ev, sub] of events) {
      const want = commandFor?.(sub) ?? hookCommand(cmd, sub, cli);
      const groups = (hooks[ev] ??= []);
      const ours = groups.flatMap((g) => (g.hooks ?? []).filter((h) => isOurHook(h.command ?? "", sub, cli, cmd)));
      if (!ours.length) { groups.push({ hooks: [{ type: "command", command: want, timeout: 10 }] }); changed = true; continue; }
      // T533: [another existing node, this install's entry] is current — never rewritten to this shell's node path.
      if (ours[0].command !== want && !hookNamesInstalledEntry(ours[0].command ?? "", sub, cli)) { ours[0].command = want; changed = true; }
      if (ours.length > 1) { // duplicates from earlier runs: keep the first
        for (const g of groups) g.hooks = (g.hooks ?? []).filter((h) => h === ours[0] || !isOurHook(h.command ?? "", sub, cli, cmd));
        hooks[ev] = groups.filter((g) => (g.hooks ?? []).length); changed = true;
      }
    }
    return changed ? jsonOut(obj, cur) : cur;
  };
  const uninstall = (cur: string | null) => {
    if (cur === null) return null;
    const obj = parseObj(cur); let changed = false;
    const hooks = obj.hooks as Record<string, HookGroup[]> | undefined;
    if (!hooks) return cur;
    for (const [ev, sub] of events) {
      const groups = hooks[ev]; if (!Array.isArray(groups)) continue;
      const kept: HookGroup[] = [];
      for (const g of groups) {
        const before = g.hooks ?? [];
        const after = before.filter((h) => !isOurHook(h.command ?? "", sub, cli, cmd));
        if (after.length !== before.length) { changed = true; if (after.length) kept.push({ ...g, hooks: after }); } else kept.push(g);
      }
      if (kept.length) hooks[ev] = kept; else if (changed) delete hooks[ev];
    }
    if (changed && !Object.keys(hooks).length) delete obj.hooks;
    return changed ? jsonOut(obj, cur) : cur;
  };
  return { install, uninstall };
}

/** { <key>: { mbx: <entry> } } in a plain JSON file (Claude's ~/.claude.json, Kimi's mcp.json). */
function jsonServer(key: string, entry: Record<string, unknown>, matches: (e: Record<string, unknown>) => boolean, deleteWhenEmpty = false) {
  return {
    install: (cur: string | null) => {
      const obj = parseObj(cur);
      const servers = (obj[key] ??= {}) as Record<string, Record<string, unknown>>;
      if (servers.mbx && matches(servers.mbx)) return cur;
      servers.mbx = entry;
      return jsonOut(obj, cur);
    },
    uninstall: (cur: string | null) => {
      if (cur === null) return null;
      const obj = parseObj(cur);
      const servers = obj[key] as Record<string, unknown> | undefined;
      if (!servers?.mbx) return cur;
      delete servers.mbx;
      if (deleteWhenEmpty && !Object.keys(servers).length && Object.keys(obj).length === 1) return null;
      return jsonOut(obj, cur);
    },
  };
}

// ---- TOML (text) helpers ---------------------------------------------------------------------
/** Line range [start, end) of `[header]` and its sub-tables `[header.*]`. */
function tomlTable(lines: string[], header: string): [number, number] | null {
  const start = lines.findIndex((l) => l.trim() === `[${header}]`);
  if (start < 0) return null;
  let end = start + 1;
  while (end < lines.length) {
    const t = lines[end].trim();
    if (t.startsWith("[") && !t.startsWith(`[${header}.`)) break;
    end++;
  }
  while (end > start + 1 && lines[end - 1].trim() === "") end--; // keep the blank separator outside
  return [start, end];
}
const appendBlock = (cur: string | null, block: string) => {
  const t = cur ?? "";
  return t === "" ? `${block}\n` : `${t.endsWith("\n") ? t : `${t}\n`}\n${block}\n`;
};
const removeBlock = (text: string, start: number, end: number) => {
  const lines = text.split("\n");
  let s = start, e = end;
  if (s > 0 && lines[s - 1].trim() === "") s--; // the blank line appendBlock added before it
  else if (e < lines.length && lines[e].trim() === "") e++;
  lines.splice(s, e - s);
  return lines.join("\n");
};

function codexServer(cmd: string[]) {
  const mcpArgs = [...cmd.slice(1), "mcp"];
  // T502: codex aborts an MCP whose startup exceeds startup_timeout_sec (seconds); write 30 explicitly.
  const block = [`[mcp_servers.mbx]`, `command = ${JSON.stringify(cmd[0])}`, `args = ${JSON.stringify(mcpArgs).replace(/","/g, `", "`)}`,
    `default_tools_approval_mode = "approve"`, `startup_timeout_sec = ${MCP_STARTUP_TIMEOUT_SEC}`];
  return {
    // T502 back-compat: an entry an older setup wrote (no startup_timeout_sec) is still wired; doctor
    // warns about the missing timeout and the next setup run repairs the line.
    isWired: (cur: string | null) => {
      if (cur === null) return false;
      const t = tryParseToml(cur);
      if (!t) return false;
      const e = (t.mcp_servers as Record<string, unknown> | undefined)?.mbx as { command?: unknown; args?: unknown } | undefined;
      return !!e && (e.command === cmd[0] && JSON.stringify(e.args ?? []) === JSON.stringify(mcpArgs) || mcpNodeScriptCurrent(e));
    },
    install: (cur: string | null) => {
      const lines = (cur ?? "").split("\n");
      const r = tomlTable(lines, "mcp_servers.mbx");
      if (!r) return appendBlock(cur, block.join("\n"));
      // T533: wired by another shell's node + this install's entry, node still there: leave the bytes alone.
      const t = tryParseToml(cur ?? "");
      const e = t ? (t.mcp_servers as Record<string, unknown> | undefined)?.mbx as { command?: unknown; args?: unknown } | undefined : undefined;
      if (e && mcpNodeScriptCurrent(e)) return cur;
      // main table body only (sub-tables such as [mcp_servers.mbx.env] are kept)
      let mainEnd = r[0] + 1;
      while (mainEnd < r[1] && !lines[mainEnd].trim().startsWith("[")) mainEnd++;
      let bodyEnd = mainEnd; while (bodyEnd > r[0] + 1 && lines[bodyEnd - 1].trim() === "") bodyEnd--;
      if (same(lines.slice(r[0], bodyEnd), block)) return cur;
      lines.splice(r[0], bodyEnd - r[0], ...block);
      return lines.join("\n");
    },
    uninstall: (cur: string | null) => {
      if (cur === null) return null;
      const r = tomlTable(cur.split("\n"), "mcp_servers.mbx");
      return r ? removeBlock(cur, r[0], r[1]) : cur;
    },
  };
}

const KIMI_BEGIN = "# >>> agentmbx (managed by agentmbx setup; remove with: agentmbx setup --uninstall) >>>";
const KIMI_END = "# <<< agentmbx <<<";
function kimiHooks(cmd: string[]) {
  const blockFor = (events: [string, string][]) => [KIMI_BEGIN,
    ...events.flatMap(([ev, sub]) =>
      ["[[hooks]]", `event = "${ev}"`, `command = ${JSON.stringify(hookCommand(cmd, sub, "kimi"))}`, "timeout = 10"]),
    KIMI_END];
  const present = (cur: string, ev: string, sub: string): boolean => {
    const hooks = tryParseToml(cur)?.hooks;
    return Array.isArray(hooks) && hooks.some(h => h && typeof h === "object" && h.event === ev
      && typeof h.command === "string" && isOurHookCommand(h.command, sub, "kimi", hookCommand(cmd, sub, "kimi")));
  };
  const find = (lines: string[]): [number, number] | null => {
    const s = lines.indexOf(KIMI_BEGIN), e = lines.indexOf(KIMI_END, s);
    return s >= 0 && e > s ? [s, e + 1] : null;
  };
  return {
    blocked: (cur: string | null) => cur !== null && tryParseToml(cur) === null ? "config.toml is not valid TOML" : null,
    isWired: (cur: string | null) => cur !== null && STOP_EVENTS.every(([ev, sub]) => present(cur, ev, sub)),
    install: (cur: string | null) => {
      if (cur !== null && tryParseToml(cur) === null) return cur;
      const lines = (cur ?? "").split("\n"); const r = find(lines);
      // Kimi can rewrite TOML and discard comments. Existing command/event pairs remain hooks
      // without markers; preserve their bytes and add only pairs that are actually missing.
      const outside = r ? [...lines.slice(0, r[0]), ...lines.slice(r[1])].join("\n") : cur ?? "";
      const missing = STOP_EVENTS.filter(([ev, sub]) => !present(outside, ev, sub));
      if (!r) return missing.length ? guarded(cur, appendBlock(cur, blockFor(missing).join("\n"))) : cur;
      const block = missing.length ? blockFor(missing) : [];
      if (same(lines.slice(r[0], r[1]), block)) return cur;
      lines.splice(r[0], r[1] - r[0], ...block);
      return guarded(cur, lines.join("\n"));
    },
    uninstall: (cur: string | null) => {
      if (cur === null) return null;
      const r = find(cur.split("\n"));
      if (!r) return cur;
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

export const opencodePluginPath = (home: string) => join(home, ".config/opencode/plugins/agentmbx.ts");
const OPENCODE_PLUGIN_MARKER = "// agentmbx-plugin v1 (T391) — managed by `agentmbx setup --only opencode`";

/** True when the file's first line starts with our marker: ours-current or ours-stale, never a user's edit. */
const isOpencodePluginOurs = (cur: string | null) => cur !== null && cur.split("\n", 1)[0].trim().startsWith(OPENCODE_PLUGIN_MARKER);

/** The exact plugin source setup writes. `cmd` is embedded as a JSON string[] and executed with
 *  node:child_process execFile (each element a literal argv entry — B3); AGENTMBX_DEV is stripped
 *  from the child env because the npm-installed launcher runs src/*.ts under it and Node refuses
 *  type-stripping under node_modules (an env leak into an OpenCode server process silently killed
 *  every hook call on 2026-10-06). */
export function opencodePluginSource(cmd: string[], ver: string): string {
  const bin = JSON.stringify(cmd);
  return `${OPENCODE_PLUGIN_MARKER} (agentmbx ${ver})
// Local edits make this file foreign: setup stops managing it and doctor reports it.
// Uninstall with: agentmbx setup --uninstall --only opencode
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Only text we produced ourselves is ever injected: a Stop {"decision":"block"} reason, or a
 *  run of [mbx]/probe-ok lines (a session-start note is several of our lines joined by newline).
 *  Anything else on hook stdout is ignored (B1b/B2). */
const hookReason = (out: string): string | null => {
  const lines = out.split("\\n");
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    if (!t) continue;
    try {
      const j = JSON.parse(t) as { decision?: unknown; reason?: unknown };
      if (j && j.decision === "block" && typeof j.reason === "string" && j.reason) return j.reason;
    } catch { /* not JSON */ }
    if (t.startsWith("[mbx]") || t.startsWith("probe ok")) {
      const run = [t]; // B2b: capture the whole consecutive run of ours, never a partial note
      for (let k = i + 1; k < lines.length; k++) {
        const u = lines[k].trim();
        if (!u.startsWith("[mbx]") && !u.startsWith("probe ok")) break;
        run.push(u);
      }
      return run.join("\\n");
    }
  }
  return null;
};

/** The spawn seam: tests replace globalThis.__mbxSpawn (read per call); production runs the real
 *  CLI. AGENTMBX_DEV is stripped from the child env: the npm-installed launcher runs src/*.ts
 *  under it and Node refuses type-stripping under node_modules (the 2026-10-06 env leak silently
 *  killed every hook). */
type Spawn = (bin: string[], args: string[], input: string, cb: (out: string) => void) => void;
const realSpawn: Spawn = (bin, args, input, cb) => {
  try {
    const env = { ...process.env };
    delete env.AGENTMBX_DEV;
    const child = execFile(bin[0], [...bin.slice(1), ...args], { encoding: "utf8", timeout: 20_000, env }, (e, out) => cb(e ? "" : String(out ?? "")));
    child.stdin?.end(input);
  } catch { cb(""); }
};
const spawnCli: Spawn = (bin, args, input, cb) => ((globalThis as { __mbxSpawn?: Spawn }).__mbxSpawn ?? realSpawn)(bin, args, input, cb);

/** T524: true only when THIS plugin is loaded by the shared OpenCode service process
 *  (\`opencode serve --service\`): its argv carries --service and not the private --stdio transport
 *  that every \`opencode --standalone\` TUI's own \`opencode serve --stdio --port 0\` uses. A synthetic
 *  POST with resume:true to the service for a session a standalone serve hosts makes the service
 *  start a SECOND agent loop on that session, so outside the service the plugin never calls it (and
 *  never spawns \`opencode service status\`). globalThis.__mbxArgv is the test seam. */
const inService = (): boolean => {
  const argv = (globalThis as { __mbxArgv?: string[] }).__mbxArgv ?? process.argv;
  return argv.some((a) => a === "--service" || a.startsWith("--service=")) && !argv.includes("--stdio");
};

/** Inject a note as a queued synthetic user message through the OpenCode service — the same
 *  receipt-verified path the daemon's wake uses (src/wake.ts wakeOpencode: POST
 *  {svc}/api/session/:id/synthetic {text, delivery:"queue", resume:true}). Service URL from
 *  MBX_OPENCODE_URL or \`opencode service status\` (wake.ts opencodeService); Basic auth from
 *  ~/.config/opencode/service.json. B1c: no SDK client prompt API is cited for 2.0.23, so the
 *  plugin speaks the endpoint the daemon already proves on every wake. */
const inject = async (sid: string, text: string): Promise<boolean> => {
  if (!inService()) return false; // T524: a standalone serve hosts this session — the note waits for the next prompt
  try {
    let status = process.env.MBX_OPENCODE_URL ?? "";
    if (!status) {
      status = await new Promise<string>((resolve) => spawnCli(["opencode"], ["service", "status"], "", (out) => resolve(out)));
    }
    const url = status.split(/\\s+/).find((w) => w.startsWith("http"))?.replace(/\\/$/, "");
    if (!url) return false;
    let auth = "";
    try {
      const cfg = JSON.parse(readFileSync(join(homedir(), ".config/opencode/service.json"), "utf8")) as { password?: string };
      if (cfg.password) auth = "Basic " + Buffer.from(\`opencode:\${cfg.password}\`).toString("base64");
    } catch { /* no service.json: a local service may run without a password */ }
    const res = await fetch(\`\${url}/api/session/\${encodeURIComponent(sid)}/synthetic\`, {
      method: "POST", headers: { "content-type": "application/json", ...(auth ? { authorization: auth } : {}) },
      body: JSON.stringify({ text, delivery: "queue", resume: true }), signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return false;
    const j = await res.json().catch(() => null) as { data?: { id?: unknown; sessionID?: unknown; type?: unknown; delivery?: unknown; payload?: { text?: unknown } } } | null;
    const r = j?.data;
    return !!r && typeof r.id === "string" && r.id.startsWith("msg_") && r.sessionID === sid && r.type === "synthetic" && r.delivery === "queue" && r.payload?.text === text;
  } catch { return false; }
};

/** One hook call: the JSON payload goes in on stdin; stdout is captured; a reason we recognize is
 *  injected into the session through the service's synthetic endpoint. A failure never surfaces. */
const call = async (bin: string[], event: string, payload: Record<string, unknown>): Promise<void> => {
  try {
    const out = await new Promise<string>((resolve) => spawnCli(bin, ["hook", event, "--cli", "opencode"], JSON.stringify(payload), resolve));
    const reason = hookReason(out);
    const sid = typeof payload.session_id === "string" ? payload.session_id : null;
    if (reason && sid) await inject(sid, reason);
  } catch { /* hook failures must never surface in the host TUI */ }
};

const runFor = (bin: string[], cwd: string | undefined) => (event: string, payload: Record<string, unknown>) => call(bin, event, { cwd, ...payload });

const sidOf = (v: unknown): string | undefined => {
  const o = v as { sessionID?: unknown; session_id?: unknown; id?: unknown; info?: unknown; session?: unknown; properties?: unknown } | undefined;
  const info = (o?.info ?? o?.session ?? o?.properties) as { id?: unknown; directory?: unknown } | undefined;
  return typeof o?.sessionID === "string" ? o.sessionID : typeof o?.session_id === "string" ? o.session_id
    : typeof o?.id === "string" && o.id.startsWith("ses_") ? o.id : typeof info?.id === "string" ? info.id : undefined;
};

/** OpenCode v1 generation: the loader calls this factory with { $, client, directory } and runs the
 *  returned hooks object (v1 names: session.created/session.idle/tool.execute.after). */
export const AgentMBXHooks = async ({ directory }: { $?: unknown; client?: unknown; directory?: string }) => {
  const run = runFor(${bin}, directory);
  return {
    event: async ({ event }: { event?: { type?: string; properties?: Record<string, unknown> } }) => {
      const sid = sidOf(event?.properties);
      if (!sid) return;
      if (event?.type === "session.created") return run("session-start", { session_id: sid, cwd: directory });
      if (event?.type === "session.idle") return run("stop", { session_id: sid });
    },
    "tool.execute.after": async (input: { sessionID?: unknown; session_id?: unknown }) => {
      const sid = sidOf(input);
      if (sid) return run("post-tool", { session_id: sid });
    },
  };
};

// OpenCode v2 validates a DEFAULT plugin object ({ id, ... effect/setup }) and dispatches through
// the CONTEXT API — the v1 returned-hooks object is never consumed (verified against the
// v2-native opencode-goal server: ctx.event.subscribe() as an async iterable, filtered by
// event.location.directory, and ctx.tool.hook("execute.after", fn)). v1's session.idle is v2's
// session.execution.succeeded; both map to the same stop contract, bounded by the stopseen marker.
export default {
  id: "agentmbx-hooks",
  server: AgentMBXHooks,
  async setup(ctx: {
    location?: { directory?: string };
    event?: { subscribe?: (o?: unknown) => AsyncIterable<{ type?: string; location?: { directory?: string }; data?: unknown }> };
    tool?: { hook?: (name: "execute.after", fn: (input: unknown) => unknown) => unknown };
  }) {
    const dir = ctx?.location?.directory;
    const run = runFor(${bin}, dir);
    const here = (ev: { location?: { directory?: string } }) => !ev.location?.directory || !dir || ev.location.directory === dir;
    const ctl = new AbortController();
    void (async () => {
      try {
        const stream = ctx?.event?.subscribe?.({ signal: ctl.signal });
        if (!stream) return;
        for await (const ev of stream) {
          const sid = sidOf(ev?.data);
          if (!sid || !here(ev)) continue;
          if (ev.type === "session.created") void run("session-start", { session_id: sid, cwd: dir });
          else if (ev.type === "session.idle" || ev.type === "session.execution.succeeded") void run("stop", { session_id: sid });
          else if (ev.type === "session.tool.called" && !ctx?.tool?.hook) void run("post-tool", { session_id: sid });
        }
      } catch { /* aborted or the stream ended: never surface in the host */ }
    })();
    try { ctx?.tool?.hook?.("execute.after", (input: unknown) => { const sid = sidOf(input); if (sid) void run("post-tool", { session_id: sid }); }); } catch { /* optional */ }
    return () => ctl.abort();
  },
};
`;
}

/** The managed version header (T486): every file we generate for OpenCode carries the agentmbx
 *  release it was written by — the ` (agentmbx <ver>)` suffix on a managed marker line, or the
 *  "version" field of a package.json we own. A file that differs from the current template only
 *  there is still ours and still functional: doctor calls it wired, and setup neither rewrites it
 *  nor restarts the OpenCode service for it (a running service only reads config at start, and a
 *  restart mid-session is exactly the disruption T486 removes). */
const MANAGED_VERSION_LINE = / \(agentmbx [^)\n]*\)$/;
const stripManagedVersion = (src: string) =>
  src.split("\n").map((l, i) => (i === 0 && l.startsWith("// agentmbx-") ? l.replace(MANAGED_VERSION_LINE, "") : l)).join("\n");

/** True when `cur` differs from the current template `content` only in the managed version header
 *  (first marker line's ` (agentmbx x.y.z)` suffix). Both must be OUR files with the same marker. */
export const headerOnlyDiff = (cur: string | null, content: string): boolean =>
  cur !== null && stripManagedVersion(cur) === stripManagedVersion(content) && cur !== content;

/** True when two package.json texts we generated differ only in the "version" field. */
export const versionOnlyPackageDiff = (cur: string | null, content: string): boolean => {
  if (cur === null || cur === content) return false;
  try {
    const a = JSON.parse(cur) as Record<string, unknown>, b = JSON.parse(content) as Record<string, unknown>;
    if (a.name !== b.name || !String(a.name ?? "").startsWith("agentmbx-")) return false;
    return JSON.stringify({ ...a, version: 0 }) === JSON.stringify({ ...b, version: 0 });
  } catch { return false; }
};

/** The OpenCode hooks edit: one whole file we own. Foreign content is left alone and reported.
 *  T486: a header-only (release-version) difference is ours and wired — install leaves the file
 *  byte-for-byte alone, so no backup row, no rewrite, and no OpenCode service restart. */
export function opencodeHooks(cmd: string[], ver: string) {
  const content = opencodePluginSource(cmd, ver);
  return {
    install: (cur: string | null) => {
      if (headerOnlyDiff(cur, content)) return cur;
      return (cur === null || isOpencodePluginOurs(cur)) && cur !== content ? content : cur;
    },
    uninstall: (cur: string | null) => (cur === null || isOpencodePluginOurs(cur)) ? null : cur,
    isWired: (cur: string | null) => cur === content || headerOnlyDiff(cur, content),
  };
}

// ---- OpenCode sidebar plugin (T411) ------------------------------------------------------------
// The T409 spike proved the packaged-plugin shape: a directory whose package.json declares
// "opencode" entrypoints is loaded in BOTH host runtimes, and only the tui entrypoint's context
// carries the slot tree. Setup installs the three generated files under
// ~/.config/opencode/plugins/agentmbx-sidebar/ and registers that directory in tui.json's
// "plugin" array — the list the TUI reads. The hooks plugin (agentmbx.ts) is a separate edit and
// stays byte-for-byte untouched by this one; so does every other entry in tui.json.

export const opencodeSidebarDir = (home: string) => join(home, ".config/opencode/plugins/agentmbx-sidebar");
export const opencodeTuiConfig = (home: string) => join(home, ".config/opencode/tui.json");

/** True when the file's first line starts with the sidebar marker: ours-current or ours-stale. */
const isOpencodeSidebarOurs = (cur: string | null) =>
  cur !== null && cur.split("\n", 1)[0].trim().startsWith(OPENCODE_SIDEBAR_MARKER);

/** A whole-file edit we own (tui.ts / server.ts): write when absent or ours-stale, never when
 *  foreign; header-only differences are left byte-for-byte alone (T486). */
function opencodeSidebarFile(content: string, versioned: boolean) {
  return {
    install: (cur: string | null) => {
      if (versioned && headerOnlyDiff(cur, content)) return cur;
      return (cur === null || isOpencodeSidebarOurs(cur)) && cur !== content ? content : cur;
    },
    uninstall: (cur: string | null) => (cur === null || isOpencodeSidebarOurs(cur)) ? null : cur,
    isWired: (cur: string | null) => cur === content || (versioned && headerOnlyDiff(cur, content)),
    blocked: (cur: string | null) => cur !== null && !isOpencodeSidebarOurs(cur) ? "file exists and is not ours (first line is not the agentmbx-sidebar marker)" : null,
  };
}

/** The package.json edit: same ownership rule through the package name, with the version field as
 *  its managed version header (T486). */
function opencodeSidebarPackage(content: string) {
  const isOurs = (cur: string | null) => {
    if (cur === null) return false;
    try { return (JSON.parse(cur) as { name?: unknown }).name === "agentmbx-sidebar"; } catch { return false; }
  };
  return {
    install: (cur: string | null) => {
      if (versionOnlyPackageDiff(cur, content)) return cur;
      return (cur === null || isOurs(cur)) && cur !== content ? content : cur;
    },
    uninstall: (cur: string | null) => (cur === null || isOurs(cur)) ? null : cur,
    isWired: (cur: string | null) => cur === content || versionOnlyPackageDiff(cur, content),
    blocked: (cur: string | null) => cur !== null && !isOurs(cur) ? "file exists and is not the agentmbx-sidebar package" : null,
  };
}

/** Insert `valueSrc` (a JSON string) as the last element of array `arr`, preserving the rest of
 *  the text byte-for-byte (the jsonc.ts helpers are object-shaped; arrays parse to members keyed
 *  by index string, so removal can reuse removeMember). */
const indentAt = (text: string, pos: number) => /^[ \t]*/.exec(text.slice(text.lastIndexOf("\n", pos - 1) + 1))![0];
function insertArrayItem(text: string, arr: JNode, valueSrc: string): string {
  if (!arr.members.length) return text.slice(0, arr.start + 1) + valueSrc + text.slice(arr.start + 1);
  // Splice right after the last element so a matching removeMember (which drops the comma after
  // the previous member when removing the last element) restores the original bytes exactly.
  const last = arr.members[arr.members.length - 1].value;
  const ind = indentAt(text, arr.members[0].value.start);
  return text.slice(0, last.end) + `,\n${ind}${valueSrc}` + text.slice(last.end);
}

/** The tui.json registration edit: adds ONLY our directory to the "plugin" array — the TUI's
 *  plugin list — leaving every other entry, key, comment and formatting byte-for-byte intact.
 *  Uninstall removes only our entry. */
export function opencodeTuiPlugins(entry: string) {
  const src = JSON.stringify(entry);
  const plugins = (text: string) => {
    const root = parseJsonc(text);
    if (root.kind !== "object") throw new Error("expected a JSON object");
    return member(root, "plugin")?.value;
  };
  return {
    install: (cur: string | null) => {
      const text = cur ?? `{\n  "plugin": [${src}]\n}\n`;
      const arr = plugins(text);
      let out: string;
      if (arr === undefined) out = insertMember(text, parseJsonc(text), "plugin", `[${src}]`);
      else if (arr.kind !== "array") return cur ?? text; // blocked() reports it; never guess
      else if (arr.members.some((m) => valueOf(text, m.value) === entry)) return cur ?? text;
      else out = insertArrayItem(text, arr, src);
      parseJsonc(out); // never write something we cannot read back
      return out;
    },
    uninstall: (cur: string | null) => {
      if (cur === null) return null;
      const arr = plugins(cur);
      if (arr?.kind !== "array") return cur;
      const idx = arr.members.findIndex((m) => valueOf(cur, m.value) === entry);
      if (idx < 0) return cur;
      const out = removeMember(cur, arr, String(idx));
      parseJsonc(out);
      // When the file is exactly what we would have created — our entry and nothing else — it
      // goes away entirely; anything else the user added (other entries, other keys, comments
      // outside our line) keeps the file.
      const root = parseJsonc(out);
      return root.kind === "object" && root.members.length === 1 && root.members[0].key === "plugin" && root.members[0].value.members.length === 0
        ? null : out;
    },
    isWired: (cur: string | null) => {
      if (cur === null) return false;
      const arr = plugins(cur);
      return arr?.kind === "array" && arr.members.some((m) => valueOf(cur, m.value) === entry);
    },
    blocked: (cur: string | null) => {
      if (cur === null) return null;
      try {
        const root = parseJsonc(cur);
        const p = root.kind === "object" ? member(root, "plugin") : undefined;
        if (root.kind !== "object") return "tui.json is not a JSON object";
        if (p && p.value.kind !== "array") return `"plugin" is not an array`;
        return null;
      } catch { return "tui.json does not parse as JSONC"; }
    },
  };
}

// ---- OpenCode (JSONC) ------------------------------------------------------------------------
/** The object that holds servers: mcp.servers (OpenCode 2), or mcp itself when it already holds servers directly (1.x). */
const opencodeMcpContainer = (root: JNode) => {
  const mcp = member(root, "mcp")?.value;
  if (!mcp || mcp.kind !== "object") return { mcp, target: undefined };
  const servers = member(mcp, "servers")?.value;
  if (servers?.kind === "object") return { mcp, target: servers };
  const v1 = mcp.members.some((m) => m.value.kind === "object" && member(m.value, "type"));
  return { mcp, target: v1 ? mcp : undefined };
};

function opencodeServer(cmd: string[]) {
  // T502: opencode's local-server "timeout" (ms) bounds fetching tools at startup — the measured
  // ~2.2s connect sits close to the 5000ms default, so write 30000 explicitly.
  const desired = { type: "local", command: [...cmd, "mcp"], timeout: MCP_STARTUP_TIMEOUT_SEC * 1000 };
  const src = `{ "type": "local", "command": [${desired.command.map((s) => JSON.stringify(s)).join(", ")}], "timeout": ${desired.timeout} }`;
  return {
    // T502 back-compat: an entry an older setup wrote (no timeout) is still wired; doctor warns and
    // the next setup run repairs the field.
    isWired: (cur: string | null) => {
      if (cur === null) return false;
      try {
        const { target } = opencodeMcpContainer(parseJsonc(cur));
        const e = target && member(target, "mbx")?.value;
        if (e?.kind !== "object") return false;
        const v = valueOf(cur, e) as { type?: unknown; command?: unknown };
        if (!v || typeof v !== "object") return false;
        if (v.type === "local" && JSON.stringify(v.command ?? null) === JSON.stringify(desired.command)) return true;
        // T533: [another node, this install's entry, "mcp"] under any spelling of the node path.
        return Array.isArray(v.command) && mcpNodeScriptCurrent({ command: v.command[0], args: v.command.slice(1) });
      } catch { return false; }
    },
    install: (cur: string | null) => {
      const text = cur ?? `{\n  "$schema": "https://opencode.ai/config.json"\n}\n`;
      const root = parseJsonc(text);
      if (root.kind !== "object") throw new Error("expected a JSON object");
      const { mcp, target } = opencodeMcpContainer(root);
      let out: string;
      if (!mcp) out = insertMember(text, root, "mcp", `{ "servers": { "mbx": ${src} } }`);
      else if (mcp.kind !== "object") throw new Error(`"mcp" is not an object`);
      else if (!target) out = insertMember(text, mcp, "servers", `{ "mbx": ${src} }`);
      else {
        const m = member(target, "mbx");
        if (m) {
          const v = valueOf(text, m.value) as { command?: unknown };
          // T533: wired by another shell's node + this install's entry: leave the bytes alone.
          if (same(v, desired) || (Array.isArray(v?.command) && mcpNodeScriptCurrent({ command: v.command[0], args: v.command.slice(1) }))) return cur;
        }
        out = m ? replaceValue(text, m, src) : insertMember(text, target, "mbx", src);
      }
      parseJsonc(out); // never write something we cannot read back
      return out;
    },
    uninstall: (cur: string | null) => {
      if (cur === null) return null;
      const root = parseJsonc(cur);
      const { target } = opencodeMcpContainer(root);
      if (!target || !member(target, "mbx")) return cur;
      const out = removeMember(cur, target, "mbx");
      parseJsonc(out);
      return out;
    },
  };
}

// ---- Hermes (YAML, minimal text edit) --------------------------------------------------------
const hermesIndentOf = (l: string) => /^ */.exec(l)![0].length;
const hermesTopLevel = (l: string) => /^[^\s#]/.test(l);
const hermesMcpLocate = (lines: string[]) => {
  const h = lines.findIndex((l) => /^mcp_servers:\s*(#.*)?$/.test(l) || /^mcp_servers:\s*(\{\s*\}|null|~)\s*$/.test(l));
  if (h < 0) return null;
  let end = h + 1; while (end < lines.length && !hermesTopLevel(lines[end])) end++;
  const firstChild = lines.slice(h + 1, end).find((l) => l.trim() && !l.trim().startsWith("#"));
  const ind = firstChild ? " ".repeat(hermesIndentOf(firstChild)) : "  ";
  const mbx = lines.findIndex((l, i) => i > h && i < end && l === `${ind}mbx:`);
  let mbxEnd = mbx + 1;
  if (mbx >= 0) while (mbxEnd < end && (!lines[mbxEnd].trim() || hermesIndentOf(lines[mbxEnd]) > ind.length)) mbxEnd++;
  while (mbx >= 0 && mbxEnd > mbx + 1 && !lines[mbxEnd - 1].trim()) mbxEnd--;
  return { h, end, ind, mbx, mbxEnd, hasChildren: !!firstChild };
};

/** The mcp_servers.mbx entry of a Hermes config text as written values (T502/T504 read what is
 *  configured; a missing block or unparseable lines read as nulls, never guesses). */
const hermesMcpParse = (cur: string): { command: string | null; args: string[] | null; connectTimeout: number | null } | null => {
  const lines = cur.split("\n");
  const r = hermesMcpLocate(lines);
  if (!r || r.mbx < 0) return null;
  let command: string | null = null, args: string[] | null = null, connectTimeout: number | null = null;
  for (let i = r.mbx + 1; i < r.mbxEnd; i++) {
    const t = linesTrim(lines[i]);
    const c = /^command:[ \t]*(.*)$/.exec(t);
    if (c) { command = yamlString(c[1]); continue; }
    const a = /^args:[ \t]*(\[.*\])[ \t]*(#.*)?$/.exec(t);
    if (a) { try { const v = JSON.parse(a[1]) as unknown; args = Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : null; } catch { args = null; } continue; }
    const ct = /^connect_timeout:[ \t]*(\d+)[ \t]*(#.*)?$/.exec(t);
    if (ct) connectTimeout = Number(ct[1]);
  }
  return { command, args, connectTimeout };
};
const linesTrim = (l: string) => l.replace(/\r$/, "").trimStart();

function hermesServer(cmd: string[]) {
  const mcpArgs = [...cmd.slice(1), "mcp"];
  // T502: hermes' per-server connect_timeout (seconds) is the initial-connection/startup knob
  // (default 60); write it explicitly so a tightened value is visible and doctor-checked.
  const body = (ind: string) => [`${ind}mbx:`, `${ind}  command: ${JSON.stringify(cmd[0])}`, `${ind}  args: ${JSON.stringify(mcpArgs).replace(/","/g, `", "`)}`, `${ind}  connect_timeout: 60`];
  return {
    // T502 back-compat: an entry an older setup wrote (no connect_timeout) is still wired; doctor
    // warns about the missing timeout and the next setup run repairs the line.
    isWired: (cur: string | null) => {
      if (cur === null) return false;
      const e = hermesMcpParse(cur);
      return !!e && (e.command === cmd[0] && JSON.stringify(e.args ?? []) === JSON.stringify(mcpArgs) || mcpNodeScriptCurrent({ command: e.command, args: e.args }));
    },
    install: (cur: string | null) => {
      if (cur === null) return null;
      const lines = cur.split("\n"); const r = hermesMcpLocate(lines);
      if (!r) return appendBlock(cur, ["mcp_servers:", ...body("  ")].join("\n"));
      // T533: wired by another shell's node + this install's entry, node still there: leave the bytes alone.
      if (r.mbx >= 0) {
        const e = hermesMcpParse(cur);
        if (e && mcpNodeScriptCurrent({ command: e.command, args: e.args })) return cur;
      }
      const want = body(r.ind);
      if (r.mbx >= 0) {
        if (same(lines.slice(r.mbx, r.mbxEnd), want)) return cur;
        lines.splice(r.mbx, r.mbxEnd - r.mbx, ...want);
      } else { lines[r.h] = "mcp_servers:"; lines.splice(r.h + 1, 0, ...want); }
      return lines.join("\n");
    },
    uninstall: (cur: string | null) => {
      if (cur === null) return null;
      const lines = cur.split("\n"); const r = hermesMcpLocate(lines);
      if (!r || r.mbx < 0) return cur;
      lines.splice(r.mbx, r.mbxEnd - r.mbx);
      const after = hermesMcpLocate(lines)!;
      if (!after.hasChildren) return removeBlock(lines.join("\n"), after.h, after.h + 1);
      return lines.join("\n");
    },
  };
}

// ---- Hermes hooks (T460) ---------------------------------------------------------------------
// Hermes shell hooks live in a top-level `hooks:` mapping of ~/.hermes/config.yaml: `<event>:` -> a list of {command, timeout}.
// There is no UserPromptSubmit event; pre_llm_call fires once per turn at the same place and injects {"context": "..."} into the
// user message. on_session_start is an observer whose output Hermes drops, so it only carries the real session id for the binding.
// The file is hand-edited YAML, so this is a minimal line edit like hermesServer: only lines of ours are added or removed and every
// other byte stays. A layout that cannot be edited with certainty (flow style, duplicate keys, tabs, anchors, mixed line endings)
// is refused and reported, never rewritten. Hermes runs a new (event, command) pair only after it was approved: see hermesApprovals.
// T526: Hermes itself rewrites this file and folds long scalars onto continuation lines — a folded `command:` is reconstructed
// semantically (and repaired to the canonical single line); a `command:` that visibly looks like ours but cannot be parsed is
// reported for a manual fix, never appended next to.
export const HERMES_HOOK_EVENTS = [["on_session_start", "session-start"], ["pre_llm_call", "prompt"]] as const;
const HERMES_MARK = "# managed by agentmbx setup";

/** Ours is `…/agentmbx hook <sub> --cli <cli>` (bare or quoted path), or exactly the command this setup would write. A command
 *  composed with anything else is someone else's hook and is left alone. The agentmbx part may be any form of ours — shim, bare,
 *  SEA binary, or the node + entry-script pair (T504) under any node path (T533) — see runsAgentmbx. */
function isOurHookCommand(command: string, sub: string, cli: string, exact?: string): boolean {
  if (exact !== undefined && command === exact) return true;
  const tail = ` hook ${sub} --cli ${cli}`;
  if (!command.endsWith(tail)) return false;
  return runsAgentmbx(command.slice(0, -tail.length));
}

/** The string a YAML scalar spells, for the forms a hand-written `command:` takes; null for anything else (block scalar, anchor, flow). */
function yamlString(raw: string): string | null {
  const t = raw.trim();
  if (t.startsWith("\"")) {
    const m = /^"((?:[^"\\]|\\.)*)"[ \t]*(?:#.*)?$/.exec(t);
    if (!m) return null;
    try { return JSON.parse(`"${m[1]}"`) as string; } catch { return null; }
  }
  if (t.startsWith("'")) { const m = /^'((?:[^']|'')*)'[ \t]*(?:#.*)?$/.exec(t); return m ? m[1].replace(/''/g, "'") : null; }
  if (t === "" || /^[|>&*!\[{#]/.test(t)) return null;
  return t.replace(/[ \t]+#.*$/, "");
}

// T526: Hermes rewrites ~/.hermes/config.yaml itself and folds long scalars onto indented continuation
// lines, so a `command:` value may span lines. A plain scalar consumes the item's following lines that
// are indented deeper than the key column (a sibling key like `timeout:` sits AT the key column and
// terminates the scalar); each segment gets yamlString's trailing-comment handling. A quoted scalar
// accepts its closing quote on a continuation line (double-quoted with JSON escapes, single-quoted with
// '' doubling), the folded break spelling one space. Block scalars (| >, with chomping/indent indicators)
// read their deeper-indented content lines (> folds to one space, | keeps line breaks). A plain segment
// ending in `\` is Hermes's line-continuation fold: the backslash drops out and the join takes no extra
// space. Anchors, aliases and flow stay null — the conservative posture yamlString already had — and are
// reported (never appended next to) when their visible text looks like one of ours: see hermesHooks.blocked.
function yamlCommandScalar(lines: string[], line: number, keyCol: number, stop: number, raw: string): { value: string | null; endLine: number } {
  const t = raw.trim();
  if (t.startsWith("\"") || t.startsWith("'")) {
    const quote = t[0];
    let body = "", endLine = line, src = t.slice(1);
    for (;;) {
      for (let i = 0; i < src.length; i++) {
        const c = src[i];
        if (quote === "\"" && c === "\\") { body += src.slice(i, i + 2); i++; continue; }
        if (quote === "'" && c === "'" && src[i + 1] === "'") { body += "''"; i++; continue; }
        if (c === quote) {
          if (quote === "\"") { try { return { value: JSON.parse(`"${body}"`) as string, endLine }; } catch { return { value: null, endLine: line }; } }
          return { value: body.replace(/''/g, "'"), endLine };
        }
        body += c;
      }
      endLine++;
      if (endLine >= stop || endLine >= lines.length) return { value: null, endLine: line };
      const l = lines[endLine].replace(/\r$/, "");
      if (yamlBlank(l) || yamlIndent(l) <= keyCol || l.trimStart().startsWith("#")) return { value: null, endLine: line };
      body += " "; // one folded line break is one space
      src = l.trim();
    }
  }
  const block = /^([|>])([+-]?)([1-9]?)[ \t]*(?:#.*)?$/.exec(t);
  if (block) {
    // Block scalar: content lines sit deeper than the key column; folded (>) joins with one
    // space, literal (|) with line breaks (trailing breaks chomped for the command comparison).
    const segs: string[] = [];
    let endLine = line;
    while (endLine + 1 < stop && endLine + 1 < lines.length) {
      const l = lines[endLine + 1].replace(/\r$/, "");
      if (yamlBlank(l) || yamlIndent(l) <= keyCol || l.trimStart().startsWith("#")) break;
      endLine++;
      segs.push(l.trim());
    }
    if (!segs.length) return { value: null, endLine: line };
    const value = (block[1] === ">" ? segs.join(" ") : segs.join("\n")).replace(/\n+$/, "");
    return { value: value === "" ? null : value, endLine };
  }
  if (t === "" || /^[>&*!\[{#]/.test(t)) return { value: null, endLine: line };
  const segs = [t.replace(/[ \t]+#.*$/, "").trim()];
  let endLine = line;
  while (endLine + 1 < stop && endLine + 1 < lines.length) {
    const l = lines[endLine + 1].replace(/\r$/, "");
    if (yamlBlank(l) || yamlIndent(l) <= keyCol || l.trimStart().startsWith("#")) break;
    endLine++;
    segs.push(l.trim().replace(/[ \t]+#.*$/, "").trim());
  }
  // Fold the segments: a plain break is one space; a segment ending in `\` is a line-continuation
  // marker (Hermes's fold) — the backslash drops out and the join takes no extra space.
  let value = "";
  for (const seg of segs.filter((s) => s !== "")) {
    if (seg.endsWith("\\")) value += seg.slice(0, -1);
    else value += (value && !value.endsWith(" ") ? " " : "") + seg;
  }
  return { value: value === "" ? null : value, endLine };
}

/** T526: the visible (unparsed) start of a `command:` value that cannot be reconstructed confidently
 *  but plausibly IS one of ours — `agentmbx` with ` hook ` in it, or ending at the agentmbx binary.
 *  Setup never appends next to a possible copy of its own entry: it refuses the file and reports. */
const looksLikeOursHook = (raw: string): boolean => {
  const v = raw.trim();
  return (/ hook /.test(v) && /agentmbx/.test(v)) || /agentmbx$/.test(v);
};

type HermesItem = { start: number; end: number; command: string | null; commandLine: number; commandEndLine: number; suspect?: boolean };
type HermesEvent = { key: number; last: number; itemInd: number; items: HermesItem[] };
type HermesLayout =
  | { kind: "absent" }
  | { kind: "unsafe"; reason: string }
  | { kind: "empty"; h: number; end: number; marked: boolean; was: string | null }
  | { kind: "block"; h: number; end: number; ind: number; last: number; marked: boolean; keys: Map<string, { key: number; rest: string; last: number }> };

const yamlBlank = (l: string) => /^\s*(#.*)?$/.test(l);
const yamlIndent = (l: string) => /^ */.exec(l)![0].length;

function hermesLayout(lines: string[]): HermesLayout {
  const heads = lines.flatMap((l, i) => /^["']?hooks["']?[ \t]*:/.test(l) ? [i] : []);
  if (!heads.length) return { kind: "absent" };
  if (heads.length > 1) return { kind: "unsafe", reason: "hooks: is defined more than once" };
  const h = heads[0];
  const plain = /^hooks:[ \t]*(#.*)?$/.exec(lines[h].replace(/\r$/, ""));
  const emptyForm = /^hooks: (\{\}|null|~)$/.exec(lines[h].replace(/\r$/, ""));
  if (!plain && !emptyForm) return { kind: "unsafe", reason: "hooks: is written inline or quoted, which setup does not edit" };
  let end = h + 1;
  while (end < lines.length && !/^[^\s#]/.test(lines[end])) end++;
  const marked = !!plain?.[1]?.startsWith(HERMES_MARK);
  const was = /; was: (\{\}|null|~)$/.exec(plain?.[1] ?? "")?.[1] ?? null;
  const body: number[] = [];
  for (let i = h + 1; i < end; i++) if (!yamlBlank(lines[i])) body.push(i);
  if (emptyForm && body.length) return { kind: "unsafe", reason: "hooks: has an inline value and indented lines" };
  if (!body.length) return { kind: "empty", h, end, marked: marked || !!emptyForm, was: emptyForm ? emptyForm[1] : was };
  if (body.some((i) => /^ *\t/.test(lines[i]))) return { kind: "unsafe", reason: "hooks: is indented with tabs" };
  const ind = yamlIndent(lines[body[0]]);
  const keyRe = new RegExp(`^ {${ind}}([A-Za-z_][A-Za-z0-9_-]*):(.*)$`);
  const keys = new Map<string, { key: number; rest: string; last: number }>();
  let current: { key: number; rest: string; last: number } | null = null;
  for (const i of body) {
    const l = lines[i].replace(/\r$/, "");
    if (yamlIndent(l) < ind) return { kind: "unsafe", reason: "hooks: has inconsistent indentation" };
    if (yamlIndent(l) === ind && !/^ *-(\s|$)/.test(l)) {
      const m = keyRe.exec(l);
      if (!m) return { kind: "unsafe", reason: `hooks: has a key that is not a plain event name (${l.trim().slice(0, 40)})` };
      if (keys.has(m[1])) return { kind: "unsafe", reason: `hooks.${m[1]} is defined more than once` };
      current = { key: i, rest: m[2], last: i };
      keys.set(m[1], current);
    } else if (!current) return { kind: "unsafe", reason: "hooks: starts with a list item" };
    else current.last = i;
  }
  return { kind: "block", h, end, ind, last: body[body.length - 1], marked, keys };
}

/** The list under one event key. `rest` of the key line must be empty (or a comment): an inline value is not edited. */
function hermesEvent(lines: string[], lay: Extract<HermesLayout, { kind: "block" }>, event: string): HermesEvent | null | { reason: string } {
  const k = lay.keys.get(event);
  if (!k) return null;
  if (!/^\s*(#.*)?$/.test(k.rest)) return { reason: `hooks.${event} is written inline, which setup does not edit` };
  const body: number[] = [];
  for (let i = k.key + 1; i <= k.last; i++) if (!yamlBlank(lines[i])) body.push(i);
  if (!body.length) return { key: k.key, last: k.last, itemInd: lay.ind + 2, items: [] };
  const itemInd = yamlIndent(lines[body[0]]);
  const starts: number[] = [];
  for (const i of body) {
    const l = lines[i].replace(/\r$/, ""), ci = yamlIndent(l);
    if (ci < itemInd) return { reason: `hooks.${event} has inconsistent indentation` };
    if (ci === itemInd) { if (!/^ *-(\s|$)/.test(l)) return { reason: `hooks.${event} is not a plain list` }; starts.push(i); }
  }
  const items: HermesItem[] = starts.map((start, n) => {
    const stop = n + 1 < starts.length ? starts[n + 1] : k.last + 1;
    const mine = body.filter((i) => i >= start && i < stop);
    const first = /^( *)-( *)(.*)$/.exec(lines[start].replace(/\r$/, ""))!;
    const keyCol = first[3] ? first[1].length + 1 + first[2].length : yamlIndent(lines[mine[1]] ?? "");
    let command: string | null = null, commandLine = -1, commandEndLine = -1, suspect = false;
    for (const i of mine) {
      const text = (i === start ? first[3] : lines[i].replace(/\r$/, "").slice(keyCol)), col = i === start ? keyCol : yamlIndent(lines[i]);
      const m = col === keyCol ? /^command:[ \t]*(.*)$/.exec(text) : null;
      if (!m) continue;
      commandLine = i;
      // T526: the value may be folded onto deeper-indented continuation lines (Hermes rewrites this
      // file); reconstruct the semantic scalar and remember the whole span a rewrite must replace.
      const rec = yamlCommandScalar(lines, i, keyCol, stop, m[1]);
      command = rec.value; commandEndLine = rec.endLine;
      if (command === null && looksLikeOursHook(m[1])) suspect = true;
      break;
    }
    return { start, end: mine[mine.length - 1] + 1, command, commandLine, commandEndLine, ...(suspect ? { suspect } : {}) };
  });
  return { key: k.key, last: k.last, itemInd, items };
}

/** Lines split on \n only: a CRLF file keeps its \r inside each line, so every line we do not touch is returned byte-for-byte and a
 *  file that already mixes endings (hermesServer appends with \n) is edited line by line instead of refused. New lines take the
 *  file's dominant ending. */
const hermesSplit = (cur: string) => ({ cr: cur.includes("\r\n") ? "\r" : "", lines: cur.split("\n") });
const endCr = (l: string) => (l.endsWith("\r") ? "\r" : "");

function hermesHooks(cmd: string[]) {
  const want = (sub: string) => hookCommand(cmd, sub, "hermes");
  const sp = (n: number) => " ".repeat(n);
  const item = (n: number, command: string) => [`${sp(n)}- command: ${JSON.stringify(command)}`, `${sp(n + 2)}timeout: 10`];
  const ours = (command: string | null, sub: string) => command !== null && isOurHookCommand(command, sub, "hermes", want(sub));
  const fresh = (ind: number) => HERMES_HOOK_EVENTS.flatMap(([ev, sub]) => [`${sp(ind)}${ev}:  ${HERMES_MARK}`, ...item(ind + 2, want(sub))]);
  const blocked = (cur: string | null): string | null => {
    if (cur === null) return null;
    const { lines } = hermesSplit(cur), lay = hermesLayout(lines);
    if (lay.kind === "unsafe") return lay.reason;
    if (lay.kind === "block") for (const [event] of HERMES_HOOK_EVENTS) {
      const e = hermesEvent(lines, lay, event);
      if (e && "reason" in e) return e.reason;
      // T526 amendment: a `command:` scalar that cannot be reconstructed confidently but visibly looks
      // like one of ours is never appended next to — the file is left untouched for a human fix.
      if (e && e.items.some((it) => it.suspect)) return `hooks.${event}: agentmbx hook entry could not be parsed; fix by hand`;
    }
    return null;
  };
  return {
    blocked,
    isWired: (cur: string | null) => {
      if (cur === null || blocked(cur) !== null) return false;
      const { lines } = hermesSplit(cur), lay = hermesLayout(lines);
      return lay.kind === "block" && HERMES_HOOK_EVENTS.every(([event, sub]) => {
        const e = hermesEvent(lines, lay, event);
        return e !== null && !("reason" in e) && e.items.some(it => ours(it.command, sub));
      });
    },
    install: (cur: string | null) => {
      if (cur === null || blocked(cur) !== null) return cur;
      const { cr, lines } = hermesSplit(cur), lay = hermesLayout(lines);
      const nl = (ls: string[]) => ls.map((l) => l + cr);
      if (lay.kind === "absent") {
        const block = nl(["hooks:  " + HERMES_MARK, ...fresh(2)]).join("\n");
        // a file that ends without a newline gets none at the end either: uninstall then returns it byte-for-byte
        return cur === "" ? block + "\n" : cur.endsWith("\n") ? `${cur}${cr}\n${block}\n` : `${cur}\n${cr}\n${block.slice(0, block.length - cr.length)}`;
      }
      if (lay.kind === "empty") {
        const head = lay.was ? `hooks:  ${HERMES_MARK}; was: ${lay.was}${endCr(lines[lay.h])}` : lines[lay.h];
        return [...lines.slice(0, lay.h), head, ...nl(fresh(2)), ...lines.slice(lay.h + 1)].join("\n");
      }
      let out = lines.slice();
      for (const [event, sub] of HERMES_HOOK_EVENTS) {
        const l = hermesLayout(out) as Extract<HermesLayout, { kind: "block" }>, e = hermesEvent(out, l, event) as HermesEvent | null;
        const wanted = want(sub);
        if (!e) { out.splice(l.last + 1, 0, ...nl([`${sp(l.ind)}${event}:  ${HERMES_MARK}`, ...item(l.ind + 2, wanted)])); continue; }
        const mine = e.items.filter((it) => ours(it.command, sub));
        if (!mine.length) { out.splice(e.items.length ? e.last + 1 : e.key + 1, 0, ...nl(item(e.items.length ? e.itemInd : l.ind + 2, wanted))); continue; }
        // a function replacer: a path containing $& or $' must not be read as a replacement pattern.
        // T526: a folded scalar is replaced across its whole line span — the canonical single line in,
        // the continuation lines gone — never leaving a truncated sibling of ours.
        // T533: [another existing node, this install's entry] is current — never rewritten to this shell's node path.
        if (mine[0].command !== wanted && !hookNamesInstalledEntry(mine[0].command!, sub, "hermes")) {
          const it = mine[0];
          const line = out[it.commandLine].replace(/(command:[ \t]*).*/, (_m, p1: string) => p1 + JSON.stringify(wanted));
          out.splice(it.commandLine, it.commandEndLine - it.commandLine + 1, line);
        }
        for (const extra of mine.slice(1).reverse()) out.splice(extra.start, extra.end - extra.start);
      }
      return out.join("\n");
    },
    uninstall: (cur: string | null) => {
      if (cur === null || blocked(cur) !== null) return cur;
      const { lines } = hermesSplit(cur);
      let out = lines.slice();
      for (const [event, sub] of HERMES_HOOK_EVENTS) {
        const l = hermesLayout(out);
        if (l.kind !== "block") break;
        const e = hermesEvent(out, l, event) as HermesEvent | null;
        const mine = e?.items.filter((it) => ours(it.command, sub)) ?? [];
        if (!e || !mine.length) continue;
        for (const it of [...mine].reverse()) out.splice(it.start, it.end - it.start);
        const after = hermesLayout(out);
        const left = after.kind === "block" ? hermesEvent(out, after, event) as HermesEvent | null : null;
        if (left && !left.items.length && out[left.key].replace(/\r$/, "").endsWith(HERMES_MARK)) out.splice(left.key, left.last - left.key + 1);
      }
      const l = hermesLayout(out);
      if (l.kind === "empty" && l.marked) {
        if (l.was) out[l.h] = `hooks: ${l.was}${endCr(out[l.h])}`;
        else return removeBlock(out.join("\n"), l.h, l.h + 1);
      }
      return out.join("\n");
    },
  };
}

/** Hermes asks for each unseen (event, command) pair before it runs a shell hook, and in the TUI (no tty) it silently skips an
 *  unapproved one. The owner chose that setup writes our pairs into ~/.hermes/shell-hooks-allowlist.json (the documented manual
 *  allowlist format): a guarded JSON edit that adds and removes only entries of ours and leaves every other entry byte-for-byte. */
export const hermesAllowlistPath = (home: string) => join(home, ".hermes/shell-hooks-allowlist.json");
export const hermesConfigPath = (home: string) => join(home, ".hermes/config.yaml");

function hermesApprovals(cmd: string[]) {
  const wanted = HERMES_HOOK_EVENTS.map(([event, sub]) => ({ event, command: hookCommand(cmd, sub, "hermes") }));
  const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
  const ours = (e: unknown) => isObj(e) && typeof e.event === "string" && typeof e.command === "string"
    && HERMES_HOOK_EVENTS.some(([ev, sub]) => ev === e.event && isOurHookCommand(e.command as string, sub, "hermes"));
  const parse = (cur: string | null): { obj: Record<string, unknown>; approvals: unknown[] } | string => {
    if (cur === null || !cur.trim()) return { obj: {}, approvals: [] };
    let v: unknown; try { v = JSON.parse(cur); } catch { return "shell-hooks-allowlist.json is not valid JSON"; }
    if (!isObj(v)) return "shell-hooks-allowlist.json is not a JSON object";
    if (v.approvals !== undefined && !Array.isArray(v.approvals)) return "shell-hooks-allowlist.json has an approvals value that is not a list";
    return { obj: v, approvals: (v.approvals as unknown[] | undefined) ?? [] };
  };
  const has = (approvals: unknown[], w: { event: string; command: string }) => approvals.some((e) => isObj(e) && e.event === w.event && e.command === w.command);
  return {
    blocked: (cur: string | null) => { const p = parse(cur); return typeof p === "string" ? p : null; },
    install: (cur: string | null) => {
      const p = parse(cur);
      if (typeof p === "string") return cur;
      // an approval of an older command of ours (the binary moved) can never match again: replace it, never accumulate
      const kept = p.approvals.filter((e) => !ours(e) || wanted.some((w) => has([e], w)));
      const add = wanted.filter((w) => !has(kept, w)).map((w) => ({ approved_at: new Date().toISOString(), command: w.command, event: w.event, script_mtime_at_approval: null }));
      if (!add.length && kept.length === p.approvals.length) return cur;
      return jsonOut({ ...p.obj, approvals: [...kept, ...add] }, cur);
    },
    uninstall: (cur: string | null) => {
      if (cur === null) return null;
      const p = parse(cur);
      if (typeof p === "string") return cur;
      const kept = p.approvals.filter((e) => !ours(e));
      if (kept.length === p.approvals.length) return cur;
      if (!kept.length && Object.keys(p.obj).every((k) => k === "approvals")) return null; // a file setup created holds nothing else
      return jsonOut({ ...p.obj, approvals: kept }, cur);
    },
  };
}

/** Are the hooks setup wrote approved to run? `auto` when hooks_auto_accept is on in config.yaml; HERMES_ACCEPT_HOOKS / --accept-hooks
 *  are per-process and cannot be seen from here. Read-only: doctor reports it, setup writes it. */
export function hermesConsent(ctx: SetupCtx): { state: "approved" | "auto" | "missing" | "unreadable"; missing: string[] } {
  const wanted = HERMES_HOOK_EVENTS.map(([event, sub]) => ({ event, command: hookCommand(ctx.cmd, sub, "hermes") }));
  if (/^hooks_auto_accept:[ \t]*true[ \t]*(#.*)?\r?$/m.test(read(hermesConfigPath(ctx.home)) ?? "")) return { state: "auto", missing: [] };
  const text = read(hermesAllowlistPath(ctx.home));
  if (text === null) return { state: "missing", missing: wanted.map((w) => w.event) };
  let approvals: unknown;
  try {
    const parsed = JSON.parse(text) as unknown;
    // the same shapes hermesApprovals refuses: setup cannot repair them, so doctor must not call them merely "missing"
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { state: "unreadable", missing: wanted.map((w) => w.event) };
    approvals = (parsed as { approvals?: unknown }).approvals ?? [];
  } catch { return { state: "unreadable", missing: wanted.map((w) => w.event) }; }
  if (!Array.isArray(approvals)) return { state: "unreadable", missing: wanted.map((w) => w.event) };
  const missing = wanted.filter((w) => !approvals.some((e: unknown) => !!e && typeof e === "object" && (e as { event?: unknown }).event === w.event && (e as { command?: unknown }).command === w.command)).map((w) => w.event);
  return { state: missing.length ? "missing" : "approved", missing };
}

// ---- the plan --------------------------------------------------------------------------------
export interface Detected { cli: CliId; found: boolean; why: string }

export function detect(ctx: SetupCtx): Detected[] {
  const h = ctx.home;
  const d = (cli: CliId, bin: string, dir: string): Detected => {
    const onPath = ctx.which(bin);
    return { cli, found: !!onPath || existsSync(join(h, dir)), why: onPath ? `${bin} on PATH` : existsSync(join(h, dir)) ? `~/${dir} exists` : "not found" };
  };
  const hermesCfg = existsSync(join(h, ".hermes/config.yaml"));
  return [d("claude", "claude", ".claude"), d("codex", "codex", ".codex"), d("opencode", "opencode", ".config/opencode"), d("kimi", "kimi", ".kimi-code"), d("grok", "grok", ".grok"),
    { cli: "hermes", found: hermesCfg, why: hermesCfg ? "~/.hermes/config.yaml exists" : ctx.which("hermes") || existsSync(join(h, ".hermes")) ? "no ~/.hermes/config.yaml yet" : "not found" }];
}

export const opencodeConfig = (home: string) => {
  const dir = join(home, ".config/opencode");
  return [join(dir, "opencode.jsonc"), join(dir, "opencode.json")].find((p) => existsSync(p)) ?? join(dir, "opencode.jsonc");
};

export function edits(ctx: SetupCtx, cli: CliId): Edit[] {
  const { home, cmd } = ctx;
  const mcpArgs = [...cmd.slice(1), "mcp"];
  switch (cli) {
    case "claude": {
      const entry = { type: "stdio", command: cmd[0], args: mcpArgs, env: {} };
      const srv = jsonServer("mcpServers", entry, (e) => (e.command === cmd[0] && same(e.args ?? [], mcpArgs)) || mcpNodeScriptCurrent(e));
      return [
        { cli, kind: "mcp", item: "MCP server mbx (user scope)", path: join(home, ".claude.json"), ...srv,
          viaCli: (c, mode, cur) => {
            if (!c.useClis || !c.which("claude")) return false;
            const has = !!cur && !!(parseObj(cur).mcpServers as Record<string, unknown> | undefined)?.mbx;
            try {
              if (has) execFileSync("claude", ["mcp", "remove", "--scope", "user", "mbx"], { stdio: "ignore" });
              if (mode === "install") execFileSync("claude", ["mcp", "add", "--scope", "user", "mbx", "--", ...cmd, "mcp"], { stdio: "ignore" });
              return true;
            } catch { return false; }
          } },
        { cli, kind: "hooks", item: "hooks SessionStart + SessionEnd + UserPromptSubmit + PostToolUse + PermissionRequest + Stop", path: join(home, ".claude/settings.json"),
          ...jsonHooks([...STOP_EVENTS, ["PostToolUse", "post-tool"], ["SessionEnd", "session-end"]], "claude", cmd, posttoolFastPath(home, cmd)),
          isWired: (cur) => {
            try {
              const hooks = (JSON.parse(cur ?? "null")?.hooks ?? {}) as Record<string, HookGroup[]>;
              const directPostTool = (hooks.PostToolUse ?? []).some((g) => (g.hooks ?? []).some((h) => (h.command ?? "").includes(" hook post-tool --cli claude")));
              if (!directPostTool) return false;
              // Review medium 4: an old-style wiring counts only if EVERY event is wired in the
              // old style too — a file holding just PostToolUse must not read as fully wired.
              const plain = jsonHooks([...STOP_EVENTS, ["PostToolUse", "post-tool"], ["SessionEnd", "session-end"]], "claude", cmd);
              return plain.install(cur) === cur;
            } catch { return false; }
          } },
        { cli, kind: "statusline", item: "statusLine (MBX segment)", path: join(home, ".claude/settings.json"), ...claudeStatusLine(home, cmd),
          isWired: (cur) => {
            // Either exact render command is ours and functional (script form when the skill ships
            // it, direct form otherwise); install() normalizes to the script form on the next run.
            try { return isOurStatusline(home, "claude", cmd, (JSON.parse(cur ?? "null")?.statusLine as { command?: string } | undefined)?.command); } catch { return false; }
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
      // T411: the sidebar package (T409's proven shape) is installed beside it under
      // plugins/agentmbx-sidebar/ and registered in tui.json — registration first, so a running
      // TUI never sees a registered-but-missing package mid-edit; uninstall drops the registration
      // before the files. The hooks plugin and every other tui.json entry are never touched.
      return [
        { cli, kind: "mcp", item: "mcp.servers.mbx", path: opencodeConfig(home), ...opencodeServer(cmd) },
        { cli, kind: "hooks", item: "plugin session.created + tool.execute.after + session.idle", path: opencodePluginPath(home), ...opencodeHooks(cmd, version()) },
        { cli, kind: "sidebar", item: "tui.json plugin registration", path: opencodeTuiConfig(home), ...opencodeTuiPlugins(opencodeSidebarDir(home)) },
        { cli, kind: "sidebar", item: "packaged plugin package.json", path: join(opencodeSidebarDir(home), "package.json"), ...opencodeSidebarPackage(opencodeSidebarPackageJson()) },
        { cli, kind: "sidebar", item: "packaged plugin server.ts", path: join(opencodeSidebarDir(home), "server.ts"), ...opencodeSidebarFile(opencodeSidebarServerSource(), false) },
        { cli, kind: "sidebar", item: "packaged plugin tui.ts", path: join(opencodeSidebarDir(home), "tui.ts"), ...opencodeSidebarFile(opencodeSidebarSource(version()), true) },
      ];
    case "kimi": {
      const kimi = (home === homedir() && process.env.KIMI_CODE_HOME) || join(home, ".kimi-code");
      const srv = jsonServer("mcpServers", { command: cmd[0], args: mcpArgs }, (e) => (e.command === cmd[0] && same(e.args ?? [], mcpArgs)) || mcpNodeScriptCurrent(e), true);
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
          isWired: (cur) => { try { const st = grokStatus(cur ?? ""); return st.form === "section" && isOurStatusline(home, "grok", cmd, grokCommandValue(st.body) ?? undefined); } catch { return false; } } },
        // T384: same file, same parse-guard and byte-exact uninstall as the MCP and status line edits.
        { cli, kind: "hooks", item: "hooks SessionStart + UserPromptSubmit + PostToolUse + Stop", path: config, ...grokHooks(cmd) },
      ];
    }
    case "hermes": {
      // T460: hooks live in the same config.yaml as the MCP server; the allowlist is Hermes's own consent store for them.
      const hh = hermesHooks(cmd), ap = hermesApprovals(cmd);
      return [
        { cli, kind: "mcp", item: "mcp_servers.mbx", path: join(home, ".hermes/config.yaml"), ...hermesServer(cmd) },
        { cli, kind: "hooks", item: "hooks on_session_start + pre_llm_call", path: hermesConfigPath(home), ...hh },
        { cli, kind: "consent", item: "shell-hooks-allowlist.json approvals", path: hermesAllowlistPath(home), mode: 0o600, ...ap },
      ];
    }
  }
}

/** Is this edit already in its installed state? (Used by doctor.) */
export function wired(e: Edit): boolean {
  const cur = read(e.path);
  try { return cur !== null && !e.blocked?.(cur) && (e.isWired?.(cur) || e.install(cur) === cur); } catch { return false; }
}

// ---- skill -----------------------------------------------------------------------------------
export const skillDest = (home: string) => join(home, ".agents/skills/agentmbx");

// T448: link the bundled skill into every installed CLI that reads a skills directory, when that
// directory already exists. The parent is never created. A symlink whose readlink is already
// skillDest is left unchanged, so a hand-made absolute link (Hermes) is reported "unchanged".
// A relative link does not match that string and is skipped, same as any other occupant.
//
// Hermes: ~/.hermes/skills/ — https://hermes-agent.nousresearch.com/docs/guides/work-with-skills
// OpenCode: ~/.config/opencode/skills/<name>/SKILL.md — https://opencode.ai/docs/skills/
// Kimi Code CLI (this repo's `kimi`): $KIMI_CODE_HOME/skills or ~/.kimi-code/skills, and it also
//   reads ~/.agents/skills/ — https://www.kimi.com/code/docs/en/kimi-code-cli/customization/skills.html
//   ~/.kimi/skills is Moonshot kimi-cli's brand directory and is mutually exclusive with
//   ~/.claude/skills and ~/.codex/skills
//   (https://github.com/moonshotai/kimi-cli/blob/main/docs/en/customization/skills.md). Not linked.
// Grok: ~/.grok/skills/ (user-guide 08-skills.md). Grok also scans ~/.agents/skills and
//   ~/.claude/skills, so a missing ~/.grok/skills is not created.
// KIMI_CODE_HOME and GROK_HOME match edits(): honored only when `home` is the real homedir.
const skillLinks = (home: string): { cli: CliId; path: string }[] => {
  const fromEnv = (envName: string, fallback: string) =>
    join((home === homedir() && process.env[envName]) || join(home, fallback), "skills");
  const candidates: { cli: CliId; dir: string }[] = [
    { cli: "claude", dir: join(home, ".claude/skills") },
    { cli: "codex", dir: join(home, ".codex/skills") },
    { cli: "hermes", dir: join(home, ".hermes/skills") },
    { cli: "opencode", dir: join(home, ".config/opencode/skills") },
    { cli: "kimi", dir: fromEnv("KIMI_CODE_HOME", ".kimi-code") },
    { cli: "grok", dir: fromEnv("GROK_HOME", ".grok") },
  ];
  return candidates.filter((c) => existsSync(c.dir)).map((c) => ({ cli: c.cli, path: join(c.dir, "agentmbx") }));
};

function filesIn(dir: string, rel = ""): string[] {
  return readdirSync(join(dir, rel), { withFileTypes: true }).flatMap((e) => e.isDirectory() ? filesIn(dir, join(rel, e.name)) : [join(rel, e.name)]);
}

// Self-healing skill (S1, owner decision 2026-10-02): the skill always matches the running AgentMBX without anyone
// managing it. A copy AgentMBX wrote carries a marker with the hash of what it wrote; an unchanged copy is refreshed on
// every session start and daemon start, a copy someone edited is left alone, and a copy installed with `npx skills`
// (an agentmbx entry in ~/.agents/.skill-lock.json) is that tool's to update. The skills CLI already lists our copy as a
// local skill; no lock entry is written, so `npx skills update` never replaces it with a different version from GitHub.
const SKILL_MARKER = ".agentmbx-skill.json";
export type SkillState = "current" | "outdated" | "modified" | "missing" | "skills-cli";
const skillHash = (files: Record<string, string>) => createHash("sha256").update(JSON.stringify(Object.keys(files).sort().map((f) => [f, files[f]]))).digest("hex");
const installedFiles = (dest: string, names: string[]) => Object.fromEntries(names.map((f) => [f, read(join(dest, f)) ?? ""]));
const skillsCliOwns = (home: string) => { try { return !!JSON.parse(read(join(home, ".agents/.skill-lock.json")) ?? "{}")?.skills?.agentmbx; } catch { return false; } };

export function skillState(home: string): { state: SkillState; detail: string } {
  const dest = skillDest(home), src = skillFiles(), names = Object.keys(src);
  if (!existsSync(join(dest, "SKILL.md"))) return { state: "missing", detail: "not installed" };
  const current = names.every((f) => read(join(dest, f)) === src[f]);
  if (skillsCliOwns(home)) return { state: "skills-cli", detail: current ? "installed with npx skills, current" : "installed with npx skills and older than this AgentMBX: npx skills update agentmbx" };
  if (current) return { state: "current", detail: `installed, current (${version()})` };
  let marker: { hash?: string; files?: unknown } | null = null;
  try { marker = JSON.parse(read(join(dest, SKILL_MARKER)) ?? "null"); } catch { /* unreadable marker: treat as edited */ marker = { hash: "" }; }
  // the hash covers exactly the files that copy was written with, so a newer bundle with more files still matches
  const written = Array.isArray(marker?.files) && marker!.files.every((f) => typeof f === "string") ? marker!.files as string[] : ["SKILL.md"];
  if (marker && marker.hash !== skillHash(installedFiles(dest, written))) return { state: "modified", detail: "installed, edited locally; left as is (agentmbx setup --only skill replaces it)" };
  // our unchanged copy, or one an older AgentMBX wrote before markers existed (its frontmatter names it)
  if (marker || /^name:\s*agentmbx\s*$/m.test(read(join(dest, "SKILL.md")) ?? "")) return { state: "outdated", detail: "installed, older than this AgentMBX (refreshed automatically at the next session or daemon start)" };
  return { state: "modified", detail: "installed, not written by AgentMBX; left as is (agentmbx setup --only skill replaces it)" };
}

/** Write the bundled skill and its marker. A pre-marker copy keeps a .bak of what it replaced. */
/** Write one file so a concurrent reader sees the old or the new content, never a partial one: a unique temp file in the
 *  same directory, then an atomic rename over the target. */
function writeAtomic(path: string, content: string) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${Date.now().toString(36)}.tmp`;
  try { writeFileSync(tmp, content); renameSync(tmp, path); }
  finally { if (existsSync(tmp)) rmSync(tmp, { force: true }); }
}

function writeSkill(home: string) {
  const dest = skillDest(home), src = skillFiles();
  if (!existsSync(join(dest, SKILL_MARKER)) && existsSync(join(dest, "SKILL.md"))) writeAtomic(join(dest, "SKILL.md.bak"), read(join(dest, "SKILL.md")) ?? "");
  // two sessions starting together may both refresh: each file is replaced atomically, and the marker is written last
  for (const [f, c] of Object.entries(src)) writeAtomic(join(dest, f), c);
  writeAtomic(join(dest, SKILL_MARKER), JSON.stringify({ version: version(), files: Object.keys(src).sort(), hash: skillHash(src), written_at: new Date().toISOString() }, null, 2) + "\n");
}

/** Refresh our own outdated copy; never install a removed skill, touch an edited one, or one `npx skills` manages. */
export function selfHealSkill(home: string, env: NodeJS.ProcessEnv = process.env): SkillState {
  // test and dev runs use throwaway mailbox homes but the real home folder: never rewrite the developer's own skill
  if (env.AGENTMBX_DEV === "1" && env.AGENTMBX_SKILL_SELFHEAL !== "1") return "current";
  try {
    const s = skillState(home).state;
    if (s !== "outdated") return s;
    writeSkill(home);
    return "current";
  } catch { return "outdated"; } // read-only home or a race with another session: the next start tries again
}

export function skillStatus(home: string): { installed: boolean; state: SkillState; detail: string; links: { cli: CliId; path: string; ok: boolean }[] } {
  const dest = skillDest(home);
  const st = skillState(home);
  return { installed: st.state === "current" || st.state === "skills-cli", ...st,
    links: skillLinks(home).map((l) => { let ok = false; try { ok = readlinkSync(l.path) === dest; } catch { /* missing */ } return { cli: l.cli, path: l.path, ok }; }) };
}

function skill(ctx: SetupCtx, mode: "install" | "uninstall", dryRun: boolean): Row[] {
  const rows: Row[] = []; const dest = skillDest(ctx.home);
  if (mode === "install") {
    const src = skillFiles();
    const diff = Object.keys(src).filter((f) => read(join(dest, f)) !== src[f]);
    if (!dryRun && (diff.length || !existsSync(join(dest, SKILL_MARKER)))) writeSkill(ctx.home); // also stamps the marker
    rows.push({ cli: "skill", item: "agentmbx skill", path: dest, action: !diff.length ? "unchanged" : existsSync(join(dest, "SKILL.md")) || dryRun && existsSync(dest) ? "updated" : "added" });
  }
  for (const link of skillLinks(ctx.home)) {
    let st: ReturnType<typeof lstatSync> | null = null; try { st = lstatSync(link.path); } catch { /* missing */ }
    const ours = !!st?.isSymbolicLink() && readlinkSync(link.path) === dest;
    if (mode === "install") {
      if (ours) rows.push({ cli: "skill", item: "symlink", path: link.path, action: "unchanged" });
      else if (st) rows.push({ cli: "skill", item: "symlink", path: link.path, action: "skipped", note: "something else already exists there" });
      else { if (!dryRun) symlinkSync(dest, link.path); rows.push({ cli: "skill", item: "symlink", path: link.path, action: "added" }); }
    } else if (ours) { if (!dryRun) unlinkSync(link.path); rows.push({ cli: "skill", item: "symlink", path: link.path, action: "removed" }); }
  }
  if (mode === "uninstall") {
    const ours = /^name:\s*agentmbx\s*$/m.test(read(join(dest, "SKILL.md")) ?? "");
    if (ours && !dryRun) rmSync(dest, { recursive: true, force: true });
    rows.push({ cli: "skill", item: "agentmbx skill", path: dest, action: ours ? "removed" : "unchanged" });
  }
  return rows;
}

// ---- run -------------------------------------------------------------------------------------
export interface RunOpts { mode: "install" | "uninstall"; only?: string[]; dryRun?: boolean; stamp?: string } // only: CLI ids and/or "skill"

export const timestamp = (d = new Date()) => d.toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);

export function runSetup(ctx: SetupCtx, o: RunOpts): Row[] {
  const rows: Row[] = [];
  const stamp = o.stamp ?? timestamp();
  // Review major 5: the skill ships the statusline/post-tool adapters the CLI edits reference —
  // install it FIRST so a single `agentmbx setup` reaches the final wiring state (no second run
  // to upgrade a node-adapter command to the bundled sh adapter).
  const skillRows = o.only && !o.only.includes("skill") ? null : skill(ctx, o.mode, !!o.dryRun);
  for (const d of detect(ctx)) {
    if (o.only && !o.only.includes(d.cli)) continue;
    if (!d.found) { rows.push({ cli: d.cli, item: "-", path: "-", action: "skipped", note: d.why }); continue; }
    const refused = new Set<string>(); // T460: a cli whose hooks edit was refused: its consent edit has nothing to approve
    for (const e of edits(ctx, d.cli)) {
      const row: Row = { cli: e.cli, item: e.item, path: e.path, action: "unchanged" };
      try {
        const cur = read(e.path);
        // T460: a layout we cannot edit without risking the user's content is reported, never rewritten (and never half-wired).
        const why = cur !== null ? e.blocked?.(cur) ?? null : null;
        if (why && (o.mode === "install" || (cur !== null && cur.includes(`--cli ${e.cli}`)))) {
          refused.add(`${e.cli}:${e.kind}`);
          const what = e.kind === "consent" ? "approve the agentmbx hooks yourself (hermes hooks list, or hooks_auto_accept: true)"
            : o.mode === "install" ? `add the agentmbx hooks by hand: ${(e.cli === "grok" ? GROK_HOOK_EVENTS : HERMES_HOOK_EVENTS).map(([ev, sub]) => `${ev} -> ${hookCommand(ctx.cmd, sub, e.cli)}`).join("; ")}`
            : "remove the agentmbx hooks by hand";
          rows.push({ ...row, action: "manual", note: `${why}; left untouched. ${what}` });
          continue;
        }
        if (o.mode === "install" && e.kind === "consent" && refused.has(`${e.cli}:hooks`)) { rows.push(row); continue; }
        const next = o.mode === "install" ? e.install(cur) : e.uninstall(cur);
        if (next === cur) { rows.push(row); continue; }
        row.action = o.mode === "uninstall" ? "removed" : cur !== null && e.uninstall(cur) !== cur ? "updated" : "added";
        if (!o.dryRun) {
          if (cur !== null) { row.backup = `${e.path}.bak-agentmbx-${stamp}`; if (!existsSync(row.backup)) writeFileSync(row.backup, cur, { mode: 0o600 }); }
          if (!e.viaCli?.(ctx, o.mode, cur)) {
            if (next === null) rmSync(e.path, { force: true });
            else { mkdirSync(dirname(e.path), { recursive: true }); writeFileSync(e.path, next, e.mode !== undefined ? { mode: e.mode } : undefined); }
          } else row.note = `via ${e.cli} CLI`;
        }
      } catch (err) { row.action = "error"; row.note = (err as Error).message; }
      rows.push(row);
    }
    if (d.cli === "codex" && o.mode === "install" && rows.some((r) => r.cli === "codex" && r.item.startsWith("hooks") && r.action !== "unchanged"))
      rows.push({ cli: "codex", item: "note", path: "-", action: "manual", note: "Codex may ask you to review/trust the new hooks on next start" });
    // T460: Hermes registers shell hooks when it builds a session's agent, so a session that is already running keeps what it had.
    if (d.cli === "hermes" && o.mode === "install" && rows.some((r) => r.cli === "hermes" && r.item.startsWith("hooks") && (r.action === "added" || r.action === "updated")))
      rows.push({ cli: "hermes", item: "note", path: "-", action: "manual", note: "Hermes reads hooks when a session starts: they apply to sessions started after this" });
    // T347: a user's own status line is never overwritten — report it and print the snippet instead.
    if (o.mode === "install" && (d.cli === "claude" || d.cli === "kimi" || d.cli === "grok") && statuslineState(ctx.home, d.cli, ctx.cmd) === "foreign")
      rows.push({ cli: d.cli, item: "statusLine", path: "-", action: "manual",
        note: `an existing status line was left alone; add the MBX segment yourself: ${d.cli === "claude"
          ? `"statusLine": { "type": "command", "command": ${JSON.stringify(statuslineCommand(ctx.home, "claude", ctx.cmd))} }`
          : d.cli === "grok"
          ? `[ui.status_line]\ntype = "command"\ncommand = ${JSON.stringify(statuslineCommand(ctx.home, "grok", ctx.cmd))}`
          : `[status_line]\ncommand = ${JSON.stringify(statuslineCommand(ctx.home, "kimi", ctx.cmd))}` }` });
  }
  if (skillRows) rows.push(...skillRows);
  // T416: the Claude mod is a marketplace plugin. The CLI runner is injected; foreign plugin bytes are restored from the pre-image.
  const claudeFound = detect(ctx).some((d) => d.cli === "claude" && d.found);
  if ((o.only === undefined || o.only.includes("claude")) && (ctx.runCli !== undefined || (ctx.useClis && claudeFound))) {
    const step = claudePluginStep(ctx.home, o.mode, o.dryRun === true, ctx.runCli ?? execCli);
    rows.push({ cli: "claude", item: "plugin agentmbx@agentmbx", path: step.path, action: step.action, note: step.note });
  }
  // A running OpenCode service only reads its config at start.
  const oc = rows.find((r) => r.cli === "opencode" && (r.action === "added" || r.action === "updated" || r.action === "removed"));
  if (oc && !o.dryRun && ctx.useClis && ctx.which("opencode")) {
    try {
      const status = execFileSync("opencode", ["service", "status"], { encoding: "utf8", timeout: 10_000 });
      if (/https?:\/\//.test(status)) { execFileSync("opencode", ["service", "restart"], { stdio: "ignore", timeout: 30_000 }); oc.note = "opencode service restarted"; }
    } catch { /* not running */ }
  }
  return rows;
}

export function formatRows(rows: Row[], home = homedir()): string {
  const tilde = (p: string) => p.startsWith(home) ? `~${p.slice(home.length)}` : p;
  const cells = rows.map((r) => [r.cli, r.action, r.item, tilde(r.path), [r.note, r.backup ? `backup ${tilde(r.backup)}` : ""].filter(Boolean).join("; ")]);
  const head = ["CLI", "RESULT", "WHAT", "FILE", "NOTES"];
  const w = head.map((h, i) => Math.max(h.length, ...cells.map((c) => c[i].length)));
  return [head, ...cells].map((c) => c.map((x, i) => i === c.length - 1 ? x : x.padEnd(w[i])).join("  ").trimEnd()).join("\n");
}

export const MANUAL_HINTS: Record<CliId, string> = {
  claude: "claude mcp add --scope user mbx -- agentmbx mcp",
  codex: "add [mcp_servers.mbx] command = \"agentmbx\", args = [\"mcp\"] to ~/.codex/config.toml",
  opencode: "add \"mbx\": {\"type\":\"local\",\"command\":[\"agentmbx\",\"mcp\"]} under mcp.servers in ~/.config/opencode/opencode.jsonc",
  kimi: "add {\"mcpServers\":{\"mbx\":{\"command\":\"agentmbx\",\"args\":[\"mcp\"]}}} to ~/.kimi-code/mcp.json",
  grok: "grok mcp add mbx --scope user -- agentmbx mcp",
  hermes: "add mcp_servers: { mbx: { command: agentmbx, args: [mcp] } } to ~/.hermes/config.yaml",
};

// ---- owner step ------------------------------------------------------------------------------
export interface OwnerStepOpts {
  mbxHome: string; cmd: string[]; dryRun?: boolean;
  helper?: string | null;                                   // Keychain helper (default: authHelperPath())
  create?: (home: string, helper: string) => Promise<{ publicKey: string; adopted: boolean }>;
  canPrompt?: (helper: string) => Promise<{ ok: boolean; reason: string }>;
  log?: (line: string) => void;
}

/**
 * The owner step of `agentmbx setup`. An agent may run it: with the macOS Keychain helper, creating the key only needs the
 * human to approve a Touch ID / password prompt. Without the helper (Linux, SSH, no AgentMBX.app) the passphrase must be
 * typed on a terminal, so it prints the exact command for the human instead. Never fails setup.
 */
export async function ownerStep(o: OwnerStepOpts): Promise<"present" | "created" | "manual" | "failed" | "dry-run"> {
  const log = o.log ?? ((l: string) => console.log(l));
  const info = ownerInfo(o.mbxHome);
  if (info) { log(`owner: key ${fingerprint(info.public_key)} (${info.backend === "keychain" ? "macOS Keychain, Touch ID" : "passphrase file"})`); return "present"; }
  const helper = o.helper === undefined ? authHelperPath() : o.helper;
  const cmd = `${shJoin(o.cmd)} owner init`;
  if (!helper) {
    log(`owner: no owner key yet. It is how you (not an agent) approve grants and policies. Run this yourself in a terminal;\n  it asks for a new passphrase (an agent can't type it for you):\n    ${cmd}`);
    return "manual";
  }
  if (o.dryRun) { log("owner: would create your owner key in the macOS Keychain (a Touch ID / password prompt appears)"); return "dry-run"; }
  // never wait on a prompt that can't appear (SSH, no GUI login): print the commands instead
  const can = await (o.canPrompt ?? canPrompt)(helper);
  if (!can.ok) {
    log(`owner: no owner key yet, and ${can.reason.replace(/[.;].*$/s, "")}.\n  At the Mac, run: ${cmd}    (Touch ID)\n  Or here, with a passphrase: ${cmd} --backend file`);
    return "manual";
  }
  log(`owner: creating your owner key in the macOS Keychain.\n  A Touch ID / password prompt will appear: approve it. (Not at the Mac? Cancel it and run later: ${cmd})`);
  try {
    const r = await (o.create ?? ((h: string, hp: string) => createKeychainOwner(h, hp, 120_000)))(o.mbxHome, helper);
    log(`owner: key ${fingerprint(r.publicKey)} ${r.adopted ? "(already in the Keychain; now used here)" : "created"} (macOS Keychain, Touch ID)`);
    return "created";
  } catch (e) {
    log(`owner: not created (${(e as Error).message}).\n  Run later: ${cmd}`);
    return "failed";
  }
}
