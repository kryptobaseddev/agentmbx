// How a project mailbox is found from another host (T493, slice 3).
//
// The home host advertises its project mailboxes beside `agents` in the signed /v1/agents response, as `projects` with its own
// signature `projects_sig` over canonical({ v: 1, host, projects }). A reader rebuilds the `agents` signature from named fields
// only, so an older peer ignores the new keys and still verifies the directory. A paired sender caches the verified list per peer
// and rewrites a bare project name to `slot@home-host` before the envelope is signed (project-mailbox.ts), the same way a local
// one is rewritten.
//
// An advertisement carries the opaque slot, the bare name and a key-source label. The key itself travels only when it is a CLEO
// project id (never a folder path), and then the receiver recomputes the slot from it, so a peer cannot attach an arbitrary slot
// to a key. Every refusal below is visible: it is an audit row, a stored per-peer state, or an error naming the remedy.
import { canonical, signData, verifyData } from "./crypto.js";
import { NAME_RE } from "./envelope.js";
import { PROJECT_ID_RE } from "./project-key.js";
import { isSlotName, RESERVED_ALIASES, slotFor } from "./project-slot.js";
/** A bound on one host's list; a list over it is refused, not truncated, so a partial directory never looks complete. */
export const MAX_PEER_PROJECTS = 200;
const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };
const stateKey = (host) => `peer-projects:${host}`;
// ---- the home host: advertise ---------------------------------------------------------------------------------------
/** This host's own project mailboxes, in the form a peer may see. A folder-keyed project carries no key and no path. */
export function advertisedProjects(node) {
    const rows = node.store.db.prepare("SELECT key,slot,alias,source FROM project_mailboxes WHERE home_host=? ORDER BY slot").all(node.host);
    return rows.map((r) => r.source === "cleo" && PROJECT_ID_RE.test(r.key)
        ? { slot: r.slot, alias: r.alias, source: "cleo", key: r.key }
        : { slot: r.slot, alias: r.alias, source: "folder" });
}
/** The `projects` + `projects_sig` pair that goes beside `agents` in the signed directory. Always present, even when empty: it is how a peer knows this host supports project mailboxes. */
export function signedProjects(node) {
    const projects = advertisedProjects(node);
    return { projects, projects_sig: signData(node.key.privateKey, canonical({ v: 1, host: node.host, projects })) };
}
// ---- a paired sender: verify and cache ------------------------------------------------------------------------------
function parseRow(raw) {
    if (!raw || typeof raw !== "object")
        return "a project row is not an object";
    const r = raw;
    if (typeof r.slot !== "string" || !isSlotName(r.slot))
        return "a project row has no valid slot";
    if (r.source !== "cleo" && r.source !== "folder")
        return "a project row has an unknown key source";
    if (!(r.alias === null || (typeof r.alias === "string" && NAME_RE.test(r.alias) && !isSlotName(r.alias) && !RESERVED_ALIASES.has(r.alias))))
        return "a project row has an invalid bare name";
    let key = null;
    if (r.source === "cleo") {
        if (typeof r.key !== "string" || !PROJECT_ID_RE.test(r.key))
            return "a cleo project row has no valid project id";
        if (slotFor(r.key) !== r.slot)
            return "a project row's slot does not match its project id";
        key = r.key;
    }
    else if (r.key !== undefined)
        return "a folder-keyed project row carries a key";
    return { host: "", slot: r.slot, key, alias: r.alias, source: r.source };
}
/**
 * Apply one peer's directory response. `unsupported` when it has no `projects` field (an older runtime), `rejected` when the
 * list is unsigned wrongly or malformed (the previous verified list is kept), otherwise the cached list is replaced whole.
 * The peer key is the pinned one the agents signature is checked against.
 */
export function acceptPeerProjects(node, peer, body) {
    const now = new Date().toISOString();
    const record = (s) => {
        const prior = peerProjectsState(node.store, peer.host);
        node.store.set(stateKey(peer.host), JSON.stringify(s));
        if (prior?.state !== s.state || prior?.reason !== s.reason)
            node.store.audit(s.state === "ok" ? "directory.projects" : "directory.projects_" + s.state, { host: peer.host, ...(s.count !== undefined ? { count: s.count } : {}), ...(s.reason ? { reason: s.reason } : {}) });
        return s;
    };
    if (body.projects === undefined && body.projects_sig === undefined) {
        node.store.db.prepare("DELETE FROM peer_project_mailboxes WHERE host=?").run(peer.host);
        return record({ state: "unsupported", at: now, reason: "this peer does not publish project mailboxes (older agentmbx)" });
    }
    const reject = (reason) => record({ state: "rejected", at: now, reason });
    if (!Array.isArray(body.projects) || typeof body.projects_sig !== "string")
        return reject("projects and projects_sig must come together");
    let ok = false;
    try {
        ok = verifyData(peer.pubkey, canonical({ v: 1, host: peer.host, projects: body.projects }), body.projects_sig);
    }
    catch {
        ok = false;
    }
    if (!ok)
        return reject("projects signature does not verify against the pinned host key");
    if (body.projects.length > MAX_PEER_PROJECTS)
        return reject(`more than ${MAX_PEER_PROJECTS} project mailboxes`);
    const rows = [];
    for (const raw of body.projects) {
        const row = parseRow(raw);
        if (typeof row === "string")
            return reject(row);
        rows.push({ ...row, host: peer.host });
    }
    if (new Set(rows.map((r) => r.slot)).size !== rows.length || new Set(rows.filter((r) => r.alias).map((r) => r.alias)).size !== rows.filter((r) => r.alias).length)
        return reject("the same slot or bare name is listed twice");
    node.store.tx(() => {
        node.store.db.prepare("DELETE FROM peer_project_mailboxes WHERE host=?").run(peer.host);
        const ins = node.store.db.prepare("INSERT INTO peer_project_mailboxes (host,slot,key,alias,source,seen_at) VALUES (?,?,?,?,?,?)");
        for (const r of rows)
            ins.run(r.host, r.slot, r.key, r.alias, r.source, now);
    });
    return record({ state: "ok", at: now, count: rows.length });
}
export function peerProjectsState(store, host) {
    const raw = store.get(stateKey(host));
    if (raw === undefined)
        return null;
    try {
        return JSON.parse(raw);
    }
    catch {
        return null;
    }
}
const approvedHosts = (node) => node.peers().filter((p) => p.state === "approved").map((p) => p.host);
/** The cached projects of the paired hosts that are approved right now (a revoked peer's list stops counting at once). */
export function peerProjects(node, host) {
    const hosts = approvedHosts(node).filter((h) => host === undefined || h === host);
    if (!hosts.length)
        return [];
    return node.store.db.prepare(`SELECT host,slot,key,alias,source FROM peer_project_mailboxes WHERE host IN (${hosts.map(() => "?").join(",")}) ORDER BY host,slot`)
        .all(...hosts).map((r) => ({ ...r }));
}
export const peerProjectBySlot = (node, host, slot) => peerProjects(node, host).find((p) => p.slot === slot);
/** Every host that claims to be the home of a CLEO project: this one if it allocated it, and each approved peer that advertises it. More than one is a conflict. */
export function homesOfKey(node, key) {
    const homes = new Set();
    if (node.store.db.prepare("SELECT 1 FROM project_mailboxes WHERE key=? AND home_host=?").get(key, node.host))
        homes.add(node.host);
    for (const p of peerProjects(node))
        if (p.key === key)
            homes.add(p.host);
    return [...homes].sort();
}
/** Refuse to route to a project that two hosts both claim: no fan-out and no pick of a random clone. */
export function assertSingleHome(node, key, label) {
    if (key === null)
        return;
    const homes = homesOfKey(node, key);
    if (homes.length > 1)
        fail("PROJECT_HOME_CONFLICT", `the project mailbox ${label} is claimed by more than one host (${homes.join(", ")}); not sent. The owner must settle which host is its home before mail can be addressed to it.`);
}
const lacks = (node, host, what) => {
    const s = peerProjectsState(node.store, host);
    if (s?.state === "unsupported")
        return fail("PROJECT_PEER_UNSUPPORTED", `not sent: ${host} does not publish project mailboxes (older agentmbx), so ${what} cannot be addressed there. Update agentmbx on ${host}.`);
    if (s?.state === "rejected")
        return fail("PROJECT_DIRECTORY_REJECTED", `not sent: the project directory from ${host} was rejected (${s.reason}), so ${what} cannot be addressed there until it is republished.`);
    if (s?.state === "ok")
        return fail("PROJECT_NOT_ADVERTISED", `not sent: ${host} does not advertise ${what}. Its directory here may be out of date: wait for the next sync, or check the name with mbx_agents.`);
    return fail("PROJECT_DIRECTORY_UNKNOWN", `not sent: no project directory has been received from ${host} yet, so ${what} cannot be addressed there. Try again after the next directory refresh.`);
};
/**
 * Map one recipient token to the project mailbox it names on a paired host, or null when it is not a project mailbox (it then goes
 * on as an ordinary agent address). `raw` is the name part, `host` the explicit host if the sender gave one. A slot-shaped name at
 * another host must be one that host advertises; a bare name is considered only when no local mailbox of that name exists.
 * `ownKey` yields the sender's own CLEO project id, and is called only when two projects answer to one name: it then picks the sender's own.
 */
export function resolveRemoteProject(node, raw, host, ownKey) {
    if (host !== undefined) {
        if (host === node.host || !approvedHosts(node).includes(host))
            return null; // routing says whether the host is paired
        if (isSlotName(raw)) {
            const hit = peerProjectBySlot(node, host, raw);
            if (!hit)
                return lacks(node, host, `the project mailbox ${raw}`);
            assertSingleHome(node, hit.key, hit.alias ?? hit.slot);
            return { to: `${hit.slot}@${host}`, note: `${hit.alias ?? hit.slot}@${host} is a project mailbox: delivered once to the project, read by its lead` };
        }
        const hit = peerProjects(node, host).find((p) => p.alias === raw);
        if (!hit)
            return null;
        assertSingleHome(node, hit.key, raw);
        return { to: `${hit.slot}@${host}`, note: `${raw}@${host} is the project mailbox: delivered once to the project, read by its lead` };
    }
    if (node.establishedLocalName(raw))
        return null; // a local mailbox of that name comes first; the project is raw@<host>
    const hits = peerProjects(node).filter((p) => p.alias === raw);
    if (!hits.length)
        return null;
    for (const h of hits)
        assertSingleHome(node, h.key, raw); // two homes for one project is the deeper refusal: it comes before a name collision
    let pick = hits.length === 1 ? hits[0] : undefined;
    const mine = pick ? null : ownKey?.() ?? null;
    if (!pick && mine) {
        const own = hits.filter((p) => p.key === mine);
        if (own.length === 1)
            pick = own[0];
    }
    if (!pick)
        return fail("PROJECT_AMBIGUOUS", `not sent: ${raw} names more than one project mailbox (${hits.map((p) => `${raw}@${p.host}`).join(", ")}); address one of them as name@host.`);
    assertSingleHome(node, pick.key, raw);
    return { to: `${pick.slot}@${pick.host}`, note: `${raw} is the project mailbox on ${pick.host}: delivered once to the project, read by its lead there` };
}
