// `kimi web` server discovery, shared by the YOLO approvals path (permission.ts) and the wake adapter (wake.ts).
// A local server records itself in $KIMI_CODE_HOME/server/instances/*.json and writes its bearer token to
// $KIMI_CODE_HOME/server.token. A bound kimi session is *hosted* when the pid on its session row is one of those
// server pids: hosted sessions run their hooks with the server as the parent process, so the hook-recorded pid is
// the server's. A terminal TUI session has no instances row at all and must never be treated as hosted.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { setKimiHostedCheck } from "./wake-check.js";
import { kimiDesktop } from "./kimi-desktop.js";
export const kimiCodeHome = () => process.env.KIMI_CODE_HOME || join(homedir(), ".kimi-code");
const alive = (pid) => { try {
    process.kill(pid, 0);
    return true;
}
catch {
    return false;
} };
export function kimiInstances(kimiHome = kimiCodeHome()) {
    const dir = join(kimiHome, "server/instances");
    if (!existsSync(dir))
        return [];
    const out = [];
    for (const f of readdirSync(dir).filter((f) => f.endsWith(".json"))) {
        try {
            out.push(JSON.parse(readFileSync(join(dir, f), "utf8")));
        }
        catch { /* skip a malformed row */ }
    }
    return out;
}
function kimiToken(kimiHome) {
    try {
        const tokenFile = join(kimiHome, "server.token");
        return existsSync(tokenFile) ? readFileSync(tokenFile, "utf8").trim() : null;
    }
    catch {
        return null;
    }
}
function instanceServer(instance, token) {
    return typeof instance.pid === "number" && typeof instance.port === "number"
        ? { url: `http://${instance.host || "127.0.0.1"}:${instance.port}`, token } : null;
}
/** The first live local Kimi server (kimi web / kimi rc / desktop), with its bearer token. */
export function kimiServer(kimiHome = kimiCodeHome(), isAlive = alive) {
    const token = kimiToken(kimiHome);
    if (token === null)
        return null;
    for (const instance of kimiInstances(kimiHome)) {
        if (typeof instance.pid === "number" && isAlive(instance.pid))
            return instanceServer(instance, token);
    }
    return null;
}
/** The server hosting sessions of the process `pid` (an instances row with this very pid, still alive) — hosted sessions only. */
export function kimiHostedServer(pid, kimiHome = kimiCodeHome(), isAlive = alive) {
    if (!pid)
        return null;
    const token = kimiToken(kimiHome);
    if (token === null)
        return null;
    for (const instance of kimiInstances(kimiHome)) {
        if (instance.pid === pid && isAlive(pid))
            return instanceServer(instance, token);
    }
    return null;
}
/** Is `pid` a Kimi process hosting several conversations (a `kimi web` server or the desktop daimon)? Their sessions are
 *  woken through the host's API, and their conversations link to their mbx servers by bind ticket (bind-ticket.ts). */
export const kimiMultiHost = (pid) => !!pid && (kimiHostedServer(pid) !== null || kimiDesktop(pid) !== null);
// Register the real hosted check for node core (T067): node.ts asks wake-check, never this adapter.
setKimiHostedCheck(kimiMultiHost);
