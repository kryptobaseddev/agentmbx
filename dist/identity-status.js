// Recovery inventory reads old and current stores without initializing, migrating or expiring them.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { inspectLeaseProcess } from "./identity-leases.js";
import { activityKey, holderProviderView, identityAvailability, parseActivity, parseProviderRecord } from "./identity-availability.js";
import { procTable, recordedStartMatches } from "./proc.js";
import { notSlot } from "./project-slot.js";
import { resolveProject } from "./project-key.js";
import { repoAssociation, repoIdentity, storedRepoAssociations } from "./repo-association.js";
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
    const providerByHolder = new Map();
    // T656: server process start by pid, and the server pids each (cli, real session) binding names — read in the tx below.
    const serverStartByPid = new Map();
    const sessionServer = new Map();
    const inProject = new Set(), retired = new Set();
    let schema;
    const row = (name) => {
        let value = rows.get(name);
        if (!value) {
            value = { name, state: "legacy", claimable: true, reason: "ownership has not been established by a lease", role: null, description: null, registered: false, retired: false,
                projects: [], repo: null, unread: 0, messages: 0, last_activity: null, holder: null };
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
        for (const r of db.prepare(`SELECT agent,COUNT(*) total,SUM(state<>'acked') unread,MAX(updated_at) activity FROM deliveries WHERE ${notSlot("agent")} GROUP BY agent`).all()) {
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
        // Read before the connection closes: sameSessionProvider runs after this transaction (T440).
        for (const r of db.prepare("SELECT k,v FROM kv WHERE k LIKE 'mcp-provider:%'").all()) {
            const suffix = r.k.slice("mcp-provider:".length);
            const mcpPid = Number(suffix);
            const recorded = parseProviderRecord(r.v);
            if (Number.isSafeInteger(mcpPid) && mcpPid > 0 && recorded)
                providerByHolder.set(mcpPid, recorded);
        }
        // T656: read before the connection closes. A provisional mcp-<pid> caller (the MCP server's own in-memory id)
        // still names its identity when the lease row already carries the hook-bound real session: the binding's server
        // record (mcp-process:<key>) must name the lease holder for that exact (cli, session) row.
        for (const r of db.prepare("SELECT cli,session_id,session_key FROM sessions WHERE session_key IS NOT NULL AND session_id NOT GLOB 'mcp-*'").all()) {
            const kvRow = db.prepare("SELECT v FROM kv WHERE k=?").get(`mcp-process:${r.session_key}`);
            let owner = null;
            try {
                owner = kvRow ? JSON.parse(kvRow.v) : null;
            }
            catch {
                owner = null;
            }
            if (!owner || !Number.isSafeInteger(owner.pid) || typeof owner.start !== "string")
                continue;
            serverStartByPid.set(owner.pid, owner.start);
            const pair = `${r.cli}|${r.session_id}`;
            const set = sessionServer.get(pair) ?? new Set();
            set.add(owner.pid);
            sessionServer.set(pair, set);
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
        if (has("identity_projects")) {
            // T330: a project is the folder, every checkout of its CLEO project (T543), and every worktree or clone of its git
            // repository (the stored association, else the folder read now). Membership itself stays explicit (T538).
            const repos = storedRepoAssociations(db);
            const repoOf = (folder) => repos.get(folder) ?? repoAssociation(folder);
            const keyed = db.prepare("PRAGMA table_info(identity_projects)").all().some((c) => c.name === "project_key");
            const caller = options.project ? resolveProject(options.project) : null;
            const callerRepo = options.project ? repoIdentity(repoOf(options.project)) : null;
            for (const r of db.prepare(`SELECT name,project${keyed ? ",project_key" : ""} FROM identity_projects ORDER BY last_seen DESC`).all()) {
                const item = row(r.name), folder = r.project;
                if (!item.projects.length) {
                    const a = repoOf(folder);
                    item.repo = a.git_root ? { git_root: a.git_root, repo_root: a.repo_root, remote_url: a.remote_url, default_branch: a.default_branch } : null;
                }
                item.projects.push(folder);
                if (options.project && (folder === options.project || (caller?.cleoId && r.project_key === caller.cleoId)
                    || (callerRepo !== null && repoIdentity(repoOf(folder)) === callerRepo)))
                    inProject.add(r.name);
            }
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
    // The provider process a same-session holder serves under (T383), read only for a lease of the caller's own session.
    // T656: a provisional mcp-<pid> caller still matches when the lease carries the hook-bound real session whose
    // binding names this holder (lease session adopted at the kimi hook bind).
    const namesCallerSession = (lease, caller) => {
        if (lease.session_id === caller.sessionId)
            return true;
        if (!caller.sessionId.startsWith("mcp-"))
            return false;
        const serverStart = serverStartByPid.get(lease.holder_pid);
        // The kv start is procStart format, the lease start is ps-utc: compare epoch-wise (T337 pattern).
        return serverStart !== undefined && lease.holder_start !== null && recordedStartMatches(lease.holder_start, serverStart)
            && (sessionServer.get(`${lease.cli}|${lease.session_id}`)?.has(lease.holder_pid) ?? false);
    };
    const sameSessionProvider = (lease, caller) => {
        if (lease.cli !== caller.cli || !namesCallerSession(lease, caller))
            return {};
        const recorded = providerByHolder.get(lease.holder_pid) ?? null;
        let evidence = null;
        if (recorded) {
            try {
                evidence = inspect(recorded.pid);
            }
            catch {
                evidence = { alive: null, start: null };
            }
        }
        return holderProviderView((options.processTable ?? procTable)(), lease.holder_pid, caller.providerPid, recorded, evidence, caller.canonicalHarness);
    };
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
            && lease.cli === options.caller.cli && namesCallerSession(lease, options.caller) && evidence.alive !== false;
        const a = own ? { state: "live", claimable: false, reason: "held by this session" }
            : identityAvailability({ lease, evidence, activity: activityByName.get(lease.name) ?? null, conflict: conflicts.has(lease.name), now,
                caller: options.caller && { ...options.caller, ...sameSessionProvider(lease, options.caller) } });
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
    for (const item of rows.values())
        item.retired = retired.has(item.name);
    // Retired mailboxes (identity prune, T209) leave listings unless asked for; their history is still in the store.
    const all = [...rows.values()].filter(i => options.includeRetired || !retired.has(i.name) || i.state === "held").sort((a, b) => a.name.localeCompare(b.name));
    return { host: config.host, schema_version: schema, observed_at: new Date(now).toISOString(), advisory: true,
        ...(options.project ? { project: options.project } : {}),
        identities: options.project ? all.filter(i => inProject.has(i.name)) : all };
}
/** Unbound session-start text (T328). Claimable rows for this directory only: name, role, last activity, unread. */
export function formatUnboundStart(home, project) {
    const head = "This session has no mailbox identity yet.";
    const stay = "The session stays unbound until you claim or register. Never invent a random name.";
    const base = project?.split(/[/\\]/).filter(Boolean).at(-1);
    const suggest = base ? `${base}-<role>` : "<project>-<role>";
    const claim = `Claim one with mbx_identity {"action":"claim","name":"<name>"}`;
    const register = `or register a new one with mbx_identity {"action":"register","name":"${suggest}","role":"<role>"}`;
    const actions = `${claim} ${register}. ${stay}`;
    if (!project)
        return `${head} No mailboxes for this directory. ${actions}`;
    let identities = [];
    try {
        identities = listIdentityStatus(home, { project }).identities;
    }
    catch {
        return `${head} Mailboxes for this directory could not be listed. ${actions}`;
    }
    const claimable = identities.filter(i => i.claimable);
    if (!identities.length)
        return `${head} No mailboxes for this directory. ${actions}`;
    if (!claimable.length)
        return `${head} No claimable mailboxes for this directory. ${actions}`;
    const shown = claimable.slice(0, 10);
    const lines = shown.map(i => `${i.name} role=${i.role ?? "unregistered"} last=${i.last_activity ?? "none"} unread=${i.unread}`);
    const more = claimable.length > shown.length ? `\n+${claimable.length - shown.length} more: mbx_identity list` : "";
    return `${head}\n${lines.join("\n")}${more}\n${actions}`;
}
