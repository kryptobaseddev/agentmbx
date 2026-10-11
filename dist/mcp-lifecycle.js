// Process lifetime is independent of mailbox retirement: a reload proxy still owns the client transport.
import { mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { inspectLeaseProcesses, processGone } from "./identity-leases.js";
import { procSeams, recordedStartMatches } from "./proc.js";
const pid = z.number().int().min(2).max(2 ** 31 - 1);
const birth = z.string().min(1).max(300).nullable();
const recordSchema = z.object({
    v: z.literal(1), pid, start: birth,
    client: z.object({ pid, start: birth }).strict().nullable(),
    role: z.enum(["server", "proxy", "generation"]),
}).strict();
const unknown = { alive: null, start: null };
const recordPath = (home, processPid) => join(home, "mcp-lifecycle", `${processPid}.json`);
const clientSchema = recordSchema.shape.client.unwrap();
const generationPath = (home, originalPid) => join(home, "mcp-generation", String(originalPid));
function readGeneration(home, originalPid) {
    try {
        const path = generationPath(home, originalPid);
        if (statSync(path).size > 4096)
            return null;
        const parsed = clientSchema.safeParse(JSON.parse(readFileSync(path, "utf8")));
        return parsed.success ? parsed.data : null;
    }
    catch {
        return null;
    }
}
/** The original proxy follows the newest generation, including its birth rather than PID alone. */
export function recordMcpGeneration(home, originalPid, next) {
    const path = generationPath(home, pid.parse(originalPid));
    try {
        mkdirSync(join(home, "mcp-generation"), { recursive: true, mode: 0o700 });
        writeFileSync(`${path}.tmp`, JSON.stringify(clientSchema.parse(next)), { mode: 0o600 });
        renameSync(`${path}.tmp`, path);
    }
    catch { /* A missing generation record is unknown; client/pipe/signal shutdown remains independent. */ }
}
function readRecord(home, processPid) {
    try {
        const path = recordPath(home, processPid);
        if (statSync(path).size > 4096)
            return null;
        const parsed = recordSchema.safeParse(JSON.parse(readFileSync(path, "utf8")));
        return parsed.success && parsed.data.pid === processPid ? parsed.data : null;
    }
    catch {
        return null;
    }
}
/** No process inspection or filesystem work until the first poll; initialize stays independent of mailbox readiness. */
export function startMcpLifecycle(home) {
    const reexec = !!process.env.MBX_MCP_REEXEC;
    const inheritedPid = Number(process.env.MBX_MCP_PROVIDER_PID);
    const inherited = clientSchema.safeParse({ pid: inheritedPid, start: process.env.MBX_MCP_PROVIDER_START || null });
    let client = inherited.success
        ? inherited.data
        : !reexec && process.ppid > 1 ? { pid: process.ppid, start: null } : null;
    let role = reexec ? "generation" : "server";
    let start = null, stopped = false, saved = "";
    let seenGeneration = null;
    let cleanup;
    const path = recordPath(home, process.pid);
    const save = () => {
        const body = JSON.stringify({ v: 1, pid: process.pid, start, client, role });
        if (body === saved)
            return;
        try {
            mkdirSync(join(home, "mcp-lifecycle"), { recursive: true, mode: 0o700 });
            writeFileSync(`${path}.tmp`, body, { mode: 0o600 });
            renameSync(`${path}.tmp`, path);
            saved = body;
        }
        catch { /* Diagnostic records are advisory; failure cannot keep a disconnected MCP alive. */ }
    };
    const dispose = () => {
        clearInterval(poll);
        process.stdin.off("end", eof);
        process.stdin.off("close", eof);
        process.stdin.off("error", inputError);
        process.stdout.off("error", outputError);
        process.off("SIGTERM", term);
        process.off("SIGHUP", hup);
        process.off("exit", dispose);
        try {
            unlinkSync(path);
        }
        catch { /* Already removed or never written. */ }
        try {
            unlinkSync(`${path}.tmp`);
        }
        catch { /* No pending write. */ }
        if (role === "proxy")
            try {
                unlinkSync(generationPath(home, process.pid));
            }
            catch { /* Already gone. */ }
    };
    const shutdown = (code = 0) => {
        if (stopped)
            return;
        stopped = true;
        try {
            cleanup?.();
        }
        catch (error) {
            try {
                process.stderr.write(`[mbx] lifecycle cleanup failed: ${error.message}\n`);
            }
            catch { /* Closed output. */ }
        }
        finally {
            dispose();
            process.exit(code);
        }
    };
    const eof = () => shutdown();
    const inputError = () => shutdown(1);
    const outputError = (error) => shutdown(error.code === "EPIPE" ? 0 : 1);
    const term = () => shutdown(143), hup = () => shutdown(129);
    process.stdin.once("end", eof);
    process.stdin.once("close", eof);
    process.stdin.on("error", inputError);
    process.stdout.on("error", outputError);
    process.once("SIGTERM", term);
    process.once("SIGHUP", hup);
    process.once("exit", dispose);
    // Referenced through proxy retirement; inherited stdin alone may be unreferenced by the provider.
    const poll = setInterval(() => {
        const originalPid = Number(process.env.MBX_MCP_ORIGINAL_PID) || process.pid;
        const generation = readGeneration(home, role === "proxy" ? process.pid : originalPid);
        const evidence = inspectLeaseProcesses([process.pid, ...(client ? [client.pid] : []), ...(role === "proxy" && generation ? [generation.pid] : [])]);
        start ??= evidence.get(process.pid)?.start ?? null;
        if (client) {
            const current = evidence.get(client.pid) ?? unknown;
            if (processGone(client.start, current)) {
                shutdown();
                return;
            }
            if (current.alive === true)
                client.start ??= current.start;
        }
        if (role === "proxy" && generation) {
            const first = generation.pid !== seenGeneration;
            seenGeneration = generation.pid;
            // A new birthless link gets one poll for cached negative process evidence to expire.
            if ((generation.start !== null || !first) && processGone(generation.start, evidence.get(generation.pid) ?? unknown)) {
                shutdown();
                return;
            }
        }
        if (role === "generation" && generation?.pid === process.pid && !generation.start && start)
            recordMcpGeneration(home, originalPid, { pid: process.pid, start });
        save();
    }, 2_000);
    return {
        home,
        /** Capture detectHost's actual provider, never an intermediate reload parent or PID 1. */
        watchClient(next) { client = clientSchema.parse(next); },
        /** The caller must bound synchronous database cleanup (busy_timeout=0); timers cannot interrupt a SQLite wait. */
        onShutdown(fn) { cleanup = fn; },
        retireToProxy() { role = "proxy"; },
        shutdown,
        dispose,
    };
}
/** Read-only: PID 1, missing records and unavailable evidence never prove an orphan. RSS from ps is KiB. */
export function mcpOrphanCensus(home, inspect = inspectLeaseProcesses) {
    const out = { total: 0, orphans: 0, orphanRssBytes: 0, unknown: 0, unknownMemory: 0, unavailable: false };
    let listing;
    try {
        listing = procSeams.ps(["-A", "-o", "pid=,rss=,args="], {
            timeout: 1000, stdio: ["ignore", "pipe", "ignore"], env: { ...process.env, LC_ALL: "C", LANG: "C" },
        });
    }
    catch {
        return { ...out, unavailable: true };
    }
    if (!listing.trim())
        return { ...out, unavailable: true };
    const processes = new Map();
    let readableRows = 0;
    for (const line of listing.split("\n")) {
        const match = /^\s*(\d+)\s+(\S+)\s+(.+)$/.exec(line);
        if (!match)
            continue;
        readableRows++;
        // shortcut: standard Node/SEA entrypoints only; extend argv inspection when custom launchers are supported.
        if (!/^(?:(?:\S*\/)?node(?:\s+--\S*)*\s+)?(?:\S*\/)?agentmbx(?:\.js)?\s+mcp(?:\s|$)/.test(match[3]))
            continue;
        const processPid = Number(match[1]), rss = Number(match[2]);
        if (!Number.isSafeInteger(processPid) || processPid <= 1)
            continue;
        processes.set(processPid, { rss: Number.isSafeInteger(rss * 1024) && rss >= 0 ? rss * 1024 : null, record: readRecord(home, processPid) });
    }
    if (!readableRows)
        return { ...out, unavailable: true };
    out.total = processes.size;
    const evidence = inspect([...processes.keys(), ...[...processes.values()].flatMap(p => p.record?.client ? [p.record.client.pid] : [])]);
    for (const [processPid, item] of processes) {
        const self = evidence.get(processPid) ?? unknown;
        // Do not attribute a reused PID to a stale lifecycle record, or count a process that already exited.
        if (self.alive === false) {
            out.total--;
            continue;
        }
        if (!item.record?.start || self.alive !== true || !self.start || !recordedStartMatches(item.record.start, self.start) || !item.record.client) {
            out.unknown++;
            continue;
        }
        const current = evidence.get(item.record.client.pid) ?? unknown;
        if (processGone(item.record.client.start, current)) {
            out.orphans++;
            if (item.rss === null)
                out.unknownMemory++;
            else
                out.orphanRssBytes += item.rss;
        }
        else if (current.alive !== true || !current.start || !item.record.client.start)
            out.unknown++;
    }
    return out;
}
export function mcpOrphanCheck(home, inspect = inspectLeaseProcesses) {
    const c = mcpOrphanCensus(home, inspect);
    if (c.unavailable)
        return { level: "warn", label: "MCP orphan census unavailable (process inventory unreadable); nothing killed" };
    return {
        level: c.orphans || c.unknown ? "warn" : "ok",
        label: `orphan MCP processes: ${c.orphans} (${(c.orphanRssBytes / 1024 ** 2).toFixed(1)} MiB RSS${c.unknownMemory ? ` + ${c.unknownMemory} unknown memory reading(s)` : ""}); ${c.unknown} unknown of ${c.total}; nothing killed`,
        ...(c.orphans || c.unknown ? { fix: "reconnect affected harness MCP connections; legacy or unreadable lifecycle records remain unknown" } : {}),
    };
}
