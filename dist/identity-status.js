// Recovery inventory reads old and current stores without initializing, migrating or expiring them.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { inspectLeaseProcess } from "./identity-leases.js";
import { activityKey, identityAvailability, parseActivity } from "./identity-availability.js";
import { SCHEMA_VERSION } from "./store.js";
export function listIdentityStatus(home, options = {}) {
    const path = join(home, "mbx.db"), now = options.now ?? Date.now();
    if (!Number.isSafeInteger(now) || now < 0 || now > 8.64e15)
        throw new Error("invalid identity observation time");
    if (!existsSync(path))
        throw Object.assign(new Error("mailbox is not initialized; run agentmbx setup"), { code: "NOT_FOUND" });
    const config = JSON.parse(readFileSync(join(home, "config.json"), "utf8"));
    if (typeof config.host !== "string" || !config.host)
        throw new Error("mailbox host configuration is invalid");
    const db = new DatabaseSync(path, { readOnly: true });
    const rows = new Map(), leases = [], conflicts = new Set(), activityByName = new Map();
    const inProject = new Set(), retired = new Set();
    let schema;
    const row = (name) => {
        let value = rows.get(name);
        if (!value) {
            value = { name, state: "legacy", claimable: true, reason: "ownership has not been established by a lease", role: null, description: null, registered: false,
                projects: [], unread: 0, messages: 0, last_activity: null, holder: null };
            rows.set(name, value);
        }
        return value;
    };
    const activity = (item, value) => {
        const time = typeof value === "number" ? value : typeof value === "string" ? Date.parse(value) : NaN;
        if (Number.isFinite(time) && Math.abs(time) <= 8.64e15 && (!item.last_activity || time > Date.parse(item.last_activity)))
            item.last_activity = new Date(time).toISOString();
    };
    try {
        db.exec("PRAGMA busy_timeout=5000; PRAGMA query_only=ON; BEGIN");
        schema = db.prepare("PRAGMA user_version").get().user_version;
        if (schema > SCHEMA_VERSION)
            throw Object.assign(new Error(`mailbox schema ${schema} is newer than this runtime; update AgentMBX`), { code: "STALE_SERVER" });
        for (const r of db.prepare("SELECT name,last_seen FROM agents WHERE host=?").all(config.host))
            activity(row(r.name), r.last_seen);
        for (const r of db.prepare("SELECT agent,COUNT(*) total,SUM(state<>'acked') unread,MAX(updated_at) activity FROM deliveries GROUP BY agent").all()) {
            const item = row(r.agent);
            item.messages = Number(r.total);
            item.unread = Number(r.unread);
            activity(item, r.activity);
        }
        for (const r of db.prepare("SELECT agent,MAX(updated_at) activity FROM sessions GROUP BY agent").all())
            activity(row(r.agent), r.activity);
        for (const r of db.prepare("SELECT k FROM kv WHERE k LIKE 'retired:%'").all()) {
            const name = r.k.slice("retired:".length);
            retired.add(name);
            if (options.includeRetired) {
                const item = row(name);
                item.reason = "retired by identity prune; claiming it brings it back";
            }
        }
        for (const r of db.prepare("SELECT k FROM kv WHERE k LIKE 'identity-conflict:%'").all()) {
            const name = r.k.slice("identity-conflict:".length);
            conflicts.add(name);
            row(name);
        }
        for (const r of db.prepare("SELECT k,v FROM kv WHERE k LIKE 'lease-activity:%'").all()) {
            const a = parseActivity(r.v);
            if (a)
                activityByName.set(r.k.slice(activityKey("").length), a);
        }
        for (const r of db.prepare("SELECT name,role FROM agents WHERE host=? AND role IS NOT NULL").all(config.host))
            row(r.name).role = r.role;
        const has = (table) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table);
        if (has("identities"))
            for (const r of db.prepare("SELECT name,role,description FROM identities").all()) {
                const item = row(r.name);
                item.registered = true;
                item.role = r.role;
                item.description = r.description ?? item.description;
            }
        if (has("identity_projects"))
            for (const r of db.prepare("SELECT name,project FROM identity_projects ORDER BY last_seen DESC").all()) {
                row(r.name).projects.push(r.project);
                if (options.project && r.project === options.project)
                    inProject.add(r.name);
            }
        if (options.project)
            for (const r of db.prepare("SELECT DISTINCT agent FROM sessions WHERE cwd=?").all(options.project))
                inProject.add(r.agent);
        if (schema >= 2)
            leases.push(...db.prepare("SELECT * FROM identity_leases").all());
        db.exec("COMMIT");
    }
    finally {
        db.close();
    }
    // Process discovery happens after releasing the read transaction. Listing is advisory;
    // a claim must recheck the current generation under its own write lock.
    const inspect = options.inspect ?? inspectLeaseProcess;
    for (const lease of leases) {
        const item = row(lease.name);
        activity(item, lease.heartbeat_at);
        activity(item, lease.released_at);
        let evidence = { alive: null, start: null };
        if (lease.released_at === null && now - lease.heartbeat_at < lease.idle_ttl) {
            try {
                evidence = inspect(lease.holder_pid);
            }
            catch { /* failed inspection is unknown */ }
        }
        // The caller's own lease (its MCP server is the holder process) is simply held by it: not "an older process of this
        // same session", and not something it should claim again (T316).
        // A shared transport (Codex, OpenCode) serves many conversations from one process, so the process alone is not the
        // caller: the lease must also name this conversation's session.
        const own = options.caller?.pid !== undefined && lease.released_at === null && lease.holder_pid === options.caller.pid
            && lease.cli === options.caller.cli && lease.session_id === options.caller.sessionId && evidence.alive !== false;
        const a = own ? { state: "live", claimable: false, reason: "held by this session" }
            : identityAvailability({ lease, evidence, activity: activityByName.get(lease.name) ?? null, conflict: conflicts.has(lease.name), now, caller: options.caller });
        item.state = a.state === "live" ? (a.claimable ? "idle" : "held") : a.state === "idle" ? "idle" : a.state === "unknown" ? "unknown" : a.state === "conflict" ? "conflict" : "available";
        item.claimable = a.claimable;
        item.reason = a.reason;
        item.holder = { cli: lease.cli, session_id: lease.session_id, pid: lease.holder_pid };
    }
    for (const name of conflicts) {
        const item = row(name);
        item.state = "conflict";
        item.claimable = false;
        item.reason = "historical ownership requires explicit recovery";
    }
    // Retired mailboxes (identity prune, T209) leave listings unless asked for; their history is still in the store.
    const all = [...rows.values()].filter(i => options.includeRetired || !retired.has(i.name) || i.state === "held").sort((a, b) => a.name.localeCompare(b.name));
    return { host: config.host, schema_version: schema, observed_at: new Date(now).toISOString(), advisory: true,
        ...(options.project ? { project: options.project } : {}),
        identities: options.project ? all.filter(i => inProject.has(i.name)) : all };
}
