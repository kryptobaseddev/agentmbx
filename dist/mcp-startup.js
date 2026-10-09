// Advisory startup state for separate-process hooks. This never binds a session or grants mailbox access.
import { randomUUID } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { procTable } from "./proc.js";
const directory = (home) => join(home, "mcp-starting");
const MAX_AGE_MS = 30_000;
/** Publish before initialize without opening SQLite or inspecting processes; remove on readiness, error or EOF. */
export function markMcpStarting(home) {
    const path = join(directory(home), `${process.pid}.json`), generation = randomUUID();
    const clear = () => {
        process.off("exit", clear);
        try {
            if (JSON.parse(readFileSync(path, "utf8")).generation === generation)
                unlinkSync(path);
        }
        catch { /* advisory */ }
    };
    try {
        mkdirSync(directory(home), { recursive: true, mode: 0o700 });
        writeFileSync(path, JSON.stringify({ pid: process.pid, parent: process.ppid, cli: process.env.MBX_CLI ?? null,
            createdAt: Date.now(), generation }), { mode: 0o600 });
        process.once("exit", clear);
    }
    catch { /* a failed advisory write must not hold up initialize */ }
    return clear;
}
/** Only a live child of this hook's provider can delay its unbound guidance. Old/crashed markers expire. */
export function mcpStarting(home, cli, providerPid) {
    let files;
    try {
        files = readdirSync(directory(home));
    }
    catch {
        return false;
    }
    if (!files.length)
        return false;
    const processes = procTable(), now = Date.now();
    for (const file of files) {
        try {
            if (!/^\d+\.json$/.test(file))
                continue;
            const marker = JSON.parse(readFileSync(join(directory(home), file), "utf8"));
            if (!Number.isSafeInteger(marker.pid) || marker.pid <= 0 || file !== `${marker.pid}.json`
                || (marker.cli !== null && marker.cli !== cli) || typeof marker.createdAt !== "number"
                || marker.createdAt > now || now - marker.createdAt > MAX_AGE_MS)
                continue;
            // A PID-only advisory never substitutes for the exact lease resolver. Limit even a stale/reused-PID hint
            // to this provider's live process tree and the short hook retry window.
            if (processes.get(marker.pid)?.ppid !== marker.parent)
                continue;
            for (let pid = marker.parent, depth = 0; pid > 1 && depth < 16; pid = processes.get(pid)?.ppid ?? 0, depth++) {
                if (pid === providerPid)
                    return true;
            }
        }
        catch { /* malformed, concurrently removed or crashed marker */ }
    }
    return false;
}
