// T722: the CODEX_HOME a Codex thread lives in. Orca and other launchers run Codex with their own CODEX_HOME
// (Orca: ~/Library/Application Support/orca/codex-accounts/<id>/home), and a queue helper started with the daemon's
// default home answers "thread not found" for every such thread, so a pending notice could never be withdrawn.
import { existsSync, globSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
const THREAD = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
export const codexHomeKey = (thread) => `codex-home:${thread.toLowerCase()}`;
export const defaultCodexHome = () => process.env.CODEX_HOME || join(homedir(), ".codex");
const isHome = (home) => {
    if (typeof home !== "string" || !home || home.length > 1024 || /[\0\n\r]/.test(home) || !isAbsolute(home))
        return false;
    try {
        return statSync(home).isDirectory();
    }
    catch {
        return false;
    }
};
const holdsThread = (home, thread) => {
    try {
        return globSync(`sessions/*/*/*/rollout-*-${thread.toLowerCase()}.jsonl`, { cwd: home }).length > 0;
    }
    catch {
        return false;
    }
};
/** Called by the MCP server serving `thread`: its inherited CODEX_HOME is the thread's home. Writes only on change. */
export function recordCodexHome(store, thread, home = process.env.CODEX_HOME) {
    if (!THREAD.test(thread) || !isHome(home))
        return;
    if (store.get(codexHomeKey(thread)) !== home)
        store.set(codexHomeKey(thread), home);
}
/**
 * The home a helper must use for `thread`: the recorded one, else whichever known home holds its rollout (sessions
 * started before the record existed), else the default. Orca's account homes are the only extra place searched.
 */
export function codexHomeFor(store, thread) {
    const recorded = store.get(codexHomeKey(thread));
    if (isHome(recorded))
        return recorded;
    const fallback = defaultCodexHome();
    if (!THREAD.test(thread) || holdsThread(fallback, thread))
        return fallback;
    const orca = join(homedir(), "Library", "Application Support", "orca", "codex-accounts");
    if (!existsSync(orca))
        return fallback;
    const found = globSync("*/home", { cwd: orca }).map(h => join(orca, h)).filter(h => holdsThread(h, thread));
    return found.length === 1 ? found[0] : fallback;
}
