import { execFileSync } from "node:child_process";
import { basename } from "node:path";
import { procTable } from "./proc.js";
/** Resolve runtime siblings to their OpenCode server, without crossing an agent's shell. */
export function opencodeProviderPid(pid, table = procTable(), command = (p) => {
    try {
        return execFileSync("ps", ["-o", "comm=", "-p", String(p)], { encoding: "utf8", timeout: 1000 }).trim();
    }
    catch {
        return "";
    }
}) {
    for (let current = pid, n = 0; current > 1 && n < 16; n++) {
        if (!table.has(current))
            return null;
        const executable = basename(command(current));
        if (executable === "opencode")
            return current;
        // Code Mode can introduce Node/Bun runtimes. Shells and arbitrary helpers are not harness proof.
        if (!/^(?:node|bun)(?:\.exe)?$/.test(executable))
            return null;
        current = table.get(current).ppid;
    }
    return null;
}
