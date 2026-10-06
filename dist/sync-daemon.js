// Host sync tick (T262). armDaemonSync is the one call the daemon case in src/cli.ts
// will make after PR #118 merges (#118 also edits that file). With no link record,
// syncOnce returns before fetch and before loadSyncSnapshot runs.
import { homedir, userInfo } from "node:os";
import { missedCount } from "./catchup.js";
import { fingerprint } from "./crypto.js";
import { storedPolicies } from "./policy.js";
import { projectKey } from "./registry.js";
import { relayFor } from "./relay-client.js";
import { syncOnce } from "./sync-client.js";
import { PATH_FLAG_PREFIX, PROJECT_KEY_RE } from "./sync-projection.js";
import { version } from "./version.js";
export const SYNC_INTERVAL_MS = 15_000;
const LIVE_MS = 60_000;
const KINDS = new Set(["message", "request", "reply", "status", "decision", "alert", "task"]);
const DELIVERY_STATES = new Set(["queued", "handed-over", "delivered", "notified", "read", "acked", "forwarded", "returned"]);
const NAME_RE = /^[a-z0-9][a-z0-9-]{1,39}$/;
const ADDR_RE = /^[a-z0-9][a-z0-9-]{1,39}@[a-z0-9][a-z0-9-]{1,39}$/;
/** Columns are listed on purpose: body, subject, envelope, description, note, session_id, pid, and token are never read. */
export function loadSyncSnapshot(node, ctx, projectKeyOf = projectKey) {
    const db = node.store.db;
    const hostName = node.host;
    const identities = db.prepare("SELECT name, role FROM identities").all();
    const localAgents = db.prepare("SELECT name, role, cli, last_seen FROM agents WHERE host=?").all(hostName);
    const leases = db.prepare("SELECT name, cli, claimed_at, heartbeat_at, released_at FROM identity_leases").all();
    const projects = db.prepare("SELECT name, project, last_seen FROM identity_projects ORDER BY last_seen ASC").all();
    const unreadRows = db.prepare("SELECT agent, COUNT(*) AS n FROM deliveries WHERE state <> 'acked' GROUP BY agent").all();
    const messages = db.prepare("SELECT id, thread, kind, from_addr, trust, ts, origin, json_extract(envelope, '$.meta.hop') AS hop FROM messages").all();
    const deliveries = db.prepare("SELECT msg_id, agent, state, updated_at FROM deliveries").all();
    const byName = new Map();
    for (const row of localAgents)
        byName.set(row.name, row);
    const leaseByName = new Map(leases.map((row) => [row.name, row]));
    const unread = new Map(unreadRows.map((row) => [row.agent, Number(row.n) || 0]));
    const keysByAgent = new Map();
    const newestPath = new Map();
    for (const row of projects) {
        let key;
        try {
            key = projectKeyOf(row.project);
        }
        catch {
            key = undefined;
        }
        if (!key)
            continue;
        const mine = keysByAgent.get(row.name) ?? [];
        if (!mine.includes(key)) {
            mine.push(key);
            keysByAgent.set(row.name, mine);
        }
        const prev = newestPath.get(key);
        if (!prev || row.last_seen >= prev.at)
            newestPath.set(key, { absolute: row.project, at: row.last_seen });
    }
    const names = new Set([...identities.map((row) => row.name), ...localAgents.map((row) => row.name)]);
    const roleOf = new Map(identities.map((row) => [row.name, row.role]));
    const nowMs = Date.now();
    const agents = [];
    for (const name of names) {
        const row = byName.get(name);
        const lease = leaseByName.get(name);
        const held = lease && lease.released_at == null ? { cli: lease.cli, since: new Date(lease.claimed_at).toISOString() } : null;
        const live = lease != null && lease.released_at == null && nowMs - lease.heartbeat_at < LIVE_MS;
        agents.push({
            name,
            role: roleOf.get(name) ?? row?.role ?? null,
            cli: row?.cli ?? null,
            state: lease?.released_at != null ? "offline" : live ? "live" : lease ? "idle" : "unknown",
            unread: unread.get(name) ?? 0,
            missed: missedFor(node.store, name),
            project_keys: keysByAgent.get(name) ?? [],
            holder: held,
            last_seen_at: row?.last_seen ?? null,
        });
    }
    const msgById = new Map(messages.map((row) => [row.id, row]));
    const threads = new Map();
    for (const row of messages) {
        let thread = threads.get(row.thread);
        if (!thread) {
            thread = { thread_id: row.thread, subject_hash: null, project_keys: [], participants: [], kind_counts: {}, state_counts: {}, trust: [], max_relay_depth: 0, started_at: row.ts, updated_at: row.ts };
            threads.set(row.thread, thread);
        }
        if (KINDS.has(row.kind))
            thread.kind_counts[row.kind] = (thread.kind_counts[row.kind] ?? 0) + 1;
        const trust = row.trust === "legacy" ? "unverified" : row.trust;
        if ((trust === "local" || trust === "verified" || trust === "unverified") && !thread.trust.includes(trust))
            thread.trust.push(trust);
        if (ADDR_RE.test(row.from_addr) && !thread.participants.includes(row.from_addr))
            thread.participants.push(row.from_addr);
        if (row.ts < thread.started_at)
            thread.started_at = row.ts;
        if (row.ts > thread.updated_at)
            thread.updated_at = row.ts;
        const hop = hopOf(row.hop);
        if (hop > thread.max_relay_depth)
            thread.max_relay_depth = hop;
    }
    for (const row of deliveries) {
        const msg = msgById.get(row.msg_id);
        const thread = msg ? threads.get(msg.thread) : undefined;
        if (!thread || !DELIVERY_STATES.has(row.state))
            continue;
        thread.state_counts[row.state] = (thread.state_counts[row.state] ?? 0) + 1;
        const addr = NAME_RE.test(row.agent) && NAME_RE.test(hostName) ? `${row.agent}@${hostName}` : "";
        if (addr && !thread.participants.includes(addr))
            thread.participants.push(addr);
    }
    const hostFp = fingerprint(node.key.publicKey);
    const receipts = deliveries.map((row) => {
        const msg = msgById.get(row.msg_id);
        return {
            message_id: row.msg_id,
            thread_id: msg?.thread ?? "",
            kind: msg?.kind ?? "",
            from: msg?.from_addr ?? "",
            to: NAME_RE.test(row.agent) && NAME_RE.test(hostName) ? `${row.agent}@${hostName}` : row.agent,
            state: row.state,
            at: row.updated_at,
            signed_by_host_fp: hostFp,
        };
    });
    let home = "";
    let username = "";
    try {
        home = homedir();
        username = userInfo().username;
    }
    catch { /* path redaction then omits rather than inventing a home */ }
    const windows = process.platform === "win32";
    const paths = [];
    if (ctx.contractAllowsProjectPaths) {
        for (const [project_key, row] of newestPath) {
            if (node.store.get(`${PATH_FLAG_PREFIX}${project_key}`) !== "1")
                continue;
            paths.push({ project_key, absolute: row.absolute, home, username, windows });
        }
    }
    return {
        host: {
            daemon_version: version(),
            os: osOf(process.platform),
            owner_fp: node.ownerPub ? fingerprint(node.ownerPub) : null,
            authority_owner: node.ownerPub != null,
            relay_enrolled: relayEnrolled(node),
            peers: node.peers().filter((peer) => peer.state === "approved").flatMap((peer) => {
                const host_key_fp = peerFp(peer.pubkey);
                return host_key_fp ? [{ host_name: peer.host, host_key_fp, last_seen_at: null }] : [];
            }),
            findings: [],
        },
        agents,
        threads: [...threads.values()],
        receipts,
        policies: policyInputs(node, nowMs),
        approvals: [],
        paths,
    };
}
export async function syncTick(node, deps = {}) {
    const projectKeyOf = deps.projectKeyOf ?? projectKey;
    return syncOnce({
        kv: node.store,
        fetch: deps.fetch ?? fetch,
        now: deps.now ?? Date.now(),
        audit: (event, detail) => {
            try {
                node.store.audit(event, detail);
            }
            catch { /* the batch already moved; a busy audit is not a retry */ }
            deps.audit?.(event, detail);
        },
        source: (ctx) => loadSyncSnapshot(node, ctx, projectKeyOf),
    });
}
/** One unref'd 15s tick, plus a short first delay. The cli daemon case calls this once. */
export function armDaemonSync(node, deps) {
    let busy = false;
    const run = () => {
        if (busy)
            return;
        busy = true;
        void syncTick(node, deps).catch((error) => {
            const message = error instanceof Error ? error.message : "";
            if (message && !message.includes("/") && !message.includes("\\"))
                process.stderr.write(`[mbx] sync ${message}\n`);
        }).finally(() => { busy = false; });
    };
    setInterval(run, SYNC_INTERVAL_MS).unref();
    setTimeout(run, 5_000).unref();
}
function policyInputs(node, nowMs) {
    const { valid } = storedPolicies(node.store.db);
    return valid.map((row) => {
        const scope = policyScope(row.rec.projects);
        const exp = Date.parse(row.rec.exp);
        const state = row.revoked ? "revoked" : Number.isFinite(exp) && exp <= nowMs ? "expired" : "active";
        return {
            policy_id: row.rec.id,
            level: row.rec.level,
            classes: row.rec.classes,
            to: row.rec.to,
            from: row.rec.from,
            project_keys: scope.project_keys,
            has_local_scope: scope.has_local_scope,
            issued_at: row.rec.iat,
            expires_at: row.rec.exp,
            owner_fp: row.rec.owner_fp,
            source: "cli",
            command_id: null,
            state,
            provisional: false,
        };
    });
}
/** A forge or h: key is eligible for the wire. Any other slash path stays local. */
export function policyScope(projects) {
    const project_keys = [];
    let has_local_scope = false;
    for (const project of projects ?? []) {
        if (PROJECT_KEY_RE.test(project)) {
            if (!project_keys.includes(project))
                project_keys.push(project);
            continue;
        }
        if (project.includes("/") || project.includes("\\"))
            has_local_scope = true;
    }
    return { project_keys, has_local_scope };
}
function relayEnrolled(node) {
    if (relayFor(node))
        return true;
    return node.store.db.prepare("SELECT 1 AS n FROM kv WHERE k LIKE 'relay-enrolled:%' LIMIT 1").get() != null;
}
function missedFor(store, name) {
    try {
        const n = missedCount(store, name).missed;
        return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
    }
    catch {
        return 0;
    }
}
function osOf(platform) {
    if (platform === "darwin")
        return "macos";
    if (platform === "linux")
        return "linux";
    if (platform === "win32")
        return "windows";
    return "other";
}
function hopOf(value) {
    const n = typeof value === "number" ? value : typeof value === "bigint" ? Number(value) : typeof value === "string" ? Number(value) : 0;
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}
function peerFp(publicKey) {
    try {
        const fp = fingerprint(publicKey);
        return /^[0-9a-f]{4}(-[0-9a-f]{4}){3}$/.test(fp) ? fp : null;
    }
    catch {
        return null;
    }
}
