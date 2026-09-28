// Recovery inventory reads old and current stores without initializing, migrating or expiring them.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { identityLeaseStatus, inspectLeaseProcess } from "./identity-leases.js";
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
    const rows = new Map(), leases = [], conflicts = new Set();
    let schema;
    const row = (name) => {
        let value = rows.get(name);
        if (!value) {
            value = { name, state: "legacy", reason: "ownership has not been established by a lease", unread: 0, messages: 0, last_activity: null, holder: null };
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
        for (const r of db.prepare("SELECT k FROM kv WHERE k LIKE 'identity-conflict:%'").all()) {
            const name = r.k.slice("identity-conflict:".length);
            conflicts.add(name);
            row(name);
        }
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
        const status = identityLeaseStatus(lease, now, evidence);
        item.state = status.state === "live" ? "held" : status.state === "expired" ? "available" : "unknown";
        item.reason = status.reason ?? (lease.released_at !== null ? "released" : status.state === "live" ? "current holder observed" : "holder process could not be verified");
        item.holder = { cli: lease.cli, session_id: lease.session_id, pid: lease.holder_pid };
    }
    for (const name of conflicts) {
        const item = row(name);
        item.state = "conflict";
        item.reason = "historical ownership requires explicit recovery";
    }
    return { host: config.host, schema_version: schema, observed_at: new Date(now).toISOString(), advisory: true,
        identities: [...rows.values()].sort((a, b) => a.name.localeCompare(b.name)) };
}
