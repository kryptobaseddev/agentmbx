// `agentmbx setup`: wire the mbx MCP server, hooks and skill into every coding-agent CLI found on this machine.
// Every function takes a `home` root so tests (and dry runs) never touch the real user's configs. Each change is a
// pure text transform (current file text -> desired text), which makes it idempotent, previewable, reversible, and
// lets `agentmbx doctor` reuse the same code to decide whether a CLI is wired.
import { execFileSync } from "node:child_process";
import { accessSync, constants, copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync, } from "node:fs";
import { createRequire } from "node:module";
import { homedir, hostname } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { insertMember, member, parseJsonc, removeMember, replaceValue, valueOf } from "./jsonc.js";
import { fingerprint } from "./crypto.js";
import { authHelperPath, canPrompt, createKeychainOwner, ownerInfo } from "./owner.js";
export const CLIS = ["claude", "codex", "opencode", "kimi", "hermes"];
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
const isOurHook = (command, event, cli, cmd) => command.includes(` hook ${event} --cli ${cli}`) && (command.includes("agentmbx") || command.startsWith(shJoin(cmd)));
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
/** Hooks in the Claude/Codex shape: { hooks: { Event: [ { hooks: [ {type, command} ] } ] } }. Appends groups; never edits others. */
function jsonHooks(events, cli, cmd) {
    const install = (cur) => {
        const obj = parseObj(cur);
        let changed = false;
        const hooks = (obj.hooks ??= {});
        for (const [ev, sub] of events) {
            const want = hookCommand(cmd, sub, cli);
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
        ...HOOK_EVENTS.flatMap(([ev, sub]) => ["[[hooks]]", `event = "${ev}"`, `command = ${JSON.stringify(hookCommand(cmd, sub, "kimi"))}`, "timeout = 10"]),
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
    return [d("claude", "claude", ".claude"), d("codex", "codex", ".codex"), d("opencode", "opencode", ".config/opencode"), d("kimi", "kimi", ".kimi-code"),
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
                { cli, kind: "hooks", item: "hooks SessionStart + UserPromptSubmit + PermissionRequest + Stop", path: join(home, ".claude/settings.json"),
                    ...jsonHooks(STOP_EVENTS, "claude", cmd) },
            ];
        }
        case "codex":
            return [
                { cli, kind: "mcp", item: "[mcp_servers.mbx]", path: join(home, ".codex/config.toml"), ...codexServer(cmd) },
                { cli, kind: "hooks", item: "hooks SessionStart + UserPromptSubmit + PermissionRequest + Stop", path: join(home, ".codex/hooks.json"),
                    ...jsonHooks(STOP_EVENTS, "codex", cmd) },
            ];
        case "opencode":
            return [{ cli, kind: "mcp", item: "mcp.servers.mbx", path: opencodeConfig(home), ...opencodeServer(cmd) }];
        case "kimi": {
            const kimi = (home === homedir() && process.env.KIMI_CODE_HOME) || join(home, ".kimi-code");
            const srv = jsonServer("mcpServers", { command: cmd[0], args: mcpArgs }, (e) => e.command === cmd[0] && same(e.args ?? [], mcpArgs), true);
            return [
                { cli, kind: "mcp", item: "mcpServers.mbx", path: join(kimi, "mcp.json"), ...srv },
                { cli, kind: "hooks", item: "[[hooks]] SessionStart + UserPromptSubmit + PermissionRequest", path: join(kimi, "config.toml"), ...kimiHooks(cmd) },
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
        return cur !== null && e.install(cur) === cur;
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
export function skillStatus(home) {
    const dest = skillDest(home);
    const src = skillFiles();
    const installed = Object.entries(src).every(([f, c]) => read(join(dest, f)) === c);
    return { installed, links: skillLinks(home).map((p) => { let ok = false; try {
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
        if (diff.length && !dryRun)
            for (const f of diff) {
                mkdirSync(dirname(join(dest, f)), { recursive: true });
                writeFileSync(join(dest, f), src[f]);
            }
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
    }
    if (!o.only || o.only.includes("skill"))
        rows.push(...skill(ctx, o.mode, !!o.dryRun));
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
