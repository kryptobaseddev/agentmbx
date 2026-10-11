// Process lifetime is independent of mailbox retirement: a reload proxy still owns the client transport.
import { linkSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { z } from "zod";
import { inspectLeaseProcess, inspectLeaseProcesses, processGone } from "./identity-leases.js";
import { procSeams, recordedStartMatches, stdioEndpoint } from "./proc.js";
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
/** Publish the complete owner atomically; never infer a connection from its provider PID or session id. */
export function claimMcpConnection(home) {
    const endpoint = stdioEndpoint();
    if (!endpoint || process.pid <= 1)
        return { state: "unknown" };
    const start = inspectLeaseProcess(process.pid).start;
    if (!start)
        return { state: "unknown" };
    const dir = join(home, "mcp-connections"), path = join(dir, createHash("sha256").update(endpoint).digest("hex"));
    const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`, body = JSON.stringify({ pid: process.pid, start });
    const read = () => {
        try {
            if (statSync(path).size > 4096)
                return null;
            const r = clientSchema.safeParse(JSON.parse(readFileSync(path, "utf8")));
            return r.success ? r.data : null;
        }
        catch {
            return null;
        }
    };
    const held = () => ({ state: "held", release() {
            const owner = read();
            if (owner?.pid === process.pid && owner.start === start)
                try {
                    unlinkSync(path);
                }
                catch { /* Already released. */ }
        } });
    let guard;
    let temporary = false;
    try {
        mkdirSync(dir, { recursive: true, mode: 0o700 });
        writeFileSync(tmp, body, { mode: 0o600, flag: "wx" });
        temporary = true;
        try {
            linkSync(tmp, path);
            return held();
        }
        catch (error) {
            if (error.code !== "EEXIST")
                throw error;
        }
        const owner = read();
        if (!owner?.start)
            return { state: "unknown" };
        const live = inspectLeaseProcess(owner.pid);
        if (live.alive === true && live.start && owner.start === live.start)
            return owner.pid === process.pid ? held() : { state: "duplicate", pid: owner.pid };
        if (!processGone(owner.start, live))
            return { state: "unknown" };
        // Only stale recovery needs a short OS lock. Normal startup performs no SQLite work before initialize.
        guard = new DatabaseSync(`${path}.reap`);
        guard.exec("PRAGMA busy_timeout=0; BEGIN EXCLUSIVE");
        const current = read();
        if (!current || current.pid !== owner.pid || current.start !== owner.start)
            return { state: "retry" };
        if (!processGone(current.start, inspectLeaseProcess(current.pid)))
            return { state: "unknown" };
        unlinkSync(path);
        try {
            linkSync(tmp, path);
            return held();
        }
        catch (error) {
            if (error.code === "EEXIST")
                return { state: "retry" };
            throw error;
        }
    }
    catch (error) {
        return /locked|busy/i.test(error.message) ? { state: "retry" } : { state: "unknown" };
    }
    finally {
        guard?.close();
        if (temporary)
            try {
                unlinkSync(tmp);
            }
            catch { /* No pending publication. */ }
    }
}
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
    let releaseConnection = () => { };
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
        releaseConnection();
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
        claimConnection() { const result = claimMcpConnection(home); if (result.state === "held")
            releaseConnection = result.release; return result; },
        releaseConnection() { releaseConnection(); releaseConnection = () => { }; },
        /** Capture detectHost's actual provider, never an intermediate reload parent or PID 1. */
        watchClient(next) { client = clientSchema.parse(next); },
        /** The caller must bound synchronous database cleanup (busy_timeout=0); timers cannot interrupt a SQLite wait. */
        onShutdown(fn) { cleanup = fn; },
        retireToProxy() { role = "proxy"; },
        shutdown,
        dispose,
    };
}
/** Read-only inventory: legacy/watch processes without a recorded client retain unknown liveness. */
export function mbxProcessInventory(home, inspect = inspectLeaseProcesses) {
    let listing;
    try {
        listing = procSeams.ps(["-A", "-o", "pid=,ppid=,rss=,args="], {
            timeout: 1000, stdio: ["ignore", "pipe", "ignore"], env: { ...process.env, LC_ALL: "C", LANG: "C" },
        });
    }
    catch {
        return { processes: [], unavailable: true };
    }
    if (!listing.trim())
        return { processes: [], unavailable: true };
    const processes = new Map();
    let readableRows = 0;
    for (const line of listing.split("\n")) {
        const match = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.+)$/.exec(line);
        if (!match)
            continue;
        readableRows++;
        // shortcut: standard Node/SEA entrypoints only; extend argv inspection when custom launchers are supported.
        const command = /^(?:(?:\S*\/)?node(?:\s+--\S*)*\s+)?(?:\S*\/)?agentmbx(?:\.js)?\s+(mcp|watch)(?:\s|$)/.exec(match[4]);
        if (!command)
            continue;
        const processPid = Number(match[1]), ppid = Number(match[2]), rss = Number(match[3]);
        if (!Number.isSafeInteger(processPid) || processPid <= 0 || !Number.isSafeInteger(ppid) || ppid < 0)
            continue;
        processes.set(processPid, { kind: command[1], ppid,
            rss: Number.isSafeInteger(rss * 1024) && rss >= 0 ? rss * 1024 : null, record: readRecord(home, processPid) });
    }
    if (!readableRows)
        return { processes: [], unavailable: true };
    const evidence = inspect([...processes.keys(), ...[...processes.values()].flatMap(p => p.record?.client ? [p.record.client.pid] : [])]);
    return { unavailable: false, processes: [...processes].map(([processPid, item]) => {
            const self = evidence.get(processPid) ?? unknown;
            let client = "unknown", clientPid = null;
            if (item.record?.start && self.alive === true && self.start && recordedStartMatches(item.record.start, self.start) && item.record.client) {
                clientPid = item.record.client.pid;
                const current = evidence.get(clientPid) ?? unknown;
                if (processGone(item.record.client.start, current))
                    client = current.alive === false ? "dead" : "reused";
                else if (current.alive === true && current.start && item.record.client.start)
                    client = "live";
            }
            return { kind: item.kind, pid: processPid, ppid: item.ppid, start: self.start, alive: self.alive, clientPid, client, rssBytes: item.rss };
        }) };
}
/** Read-only: PID 1, missing records and unavailable evidence never prove an orphan. RSS from ps is KiB. */
export function mcpOrphanCensus(home, inspect = inspectLeaseProcesses) {
    const inventory = mbxProcessInventory(home, inspect);
    const out = { total: 0, orphans: 0, orphanRssBytes: 0, unknown: 0, unknownMemory: 0, unavailable: inventory.unavailable };
    for (const item of inventory.processes) {
        if (item.kind !== "mcp" || item.alive === false)
            continue;
        out.total++;
        if (item.client === "dead" || item.client === "reused") {
            out.orphans++;
            if (item.rssBytes === null)
                out.unknownMemory++;
            else
                out.orphanRssBytes += item.rssBytes;
        }
        else if (item.client === "unknown")
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
