// The project mailbox (T493, ADR-037): mail to the bare project name is stored once, owned by the project, not by any persona.
// This module holds the registry, the bare-name rewrite and the reader lookup. Who may READ a slot is a separate question
// (the lease-fenced check in node.ts); nothing here grants access.
import { basename } from "node:path";
import { NAME_RE } from "./envelope.js";
import { leadFor } from "./lead-record.js";
import { resolveProject } from "./project-key.js";
import { assertSingleHome, resolveRemoteProject } from "./project-directory.js";
import { isSlotName, RESERVED_ALIASES, slotFor } from "./project-slot.js";
export { isSlotName, slotFor } from "./project-slot.js";
const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };
export const projectMailboxByKey = (store, key) => store.db.prepare("SELECT key,slot,alias,home_host,source,folder,created_at FROM project_mailboxes WHERE key=?").get(key);
export const projectMailboxBySlot = (store, slot) => isSlotName(slot) ? store.db.prepare("SELECT key,slot,alias,home_host,source,folder,created_at FROM project_mailboxes WHERE slot=?").get(slot) : undefined;
export const projectMailboxByAlias = (store, alias) => store.db.prepare("SELECT key,slot,alias,home_host,source,folder,created_at FROM project_mailboxes WHERE alias=?").get(alias);
/** True for an allocated slot. The syntactic shape alone (`isSlotName`) is what guards use; this is the registry's word. */
export const isAllocatedSlot = (store, name) => !!projectMailboxBySlot(store, name);
/**
 * Names register and claim must refuse (T492 calls this): any slot-shaped name, and the bare name of an allocated project mailbox.
 * Existing mailboxes of that name stay readable; this only decides whether a NEW claim or registration may take it.
 */
export function reservedByProjectMailbox(store, name) {
    return isSlotName(name) || !!projectMailboxByAlias(store, name);
}
/** The bare name a folder's project would answer to: its project root's basename, lowercased to a mailbox name. */
export function aliasFor(folder, root) {
    const base = basename(root ?? folder).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40).replace(/-+$/, "");
    return NAME_RE.test(base) && !RESERVED_ALIASES.has(base) ? base : null;
}
/**
 * Create the project mailbox for the project `folder` belongs to, once. Idempotent: a second call (or a call from another
 * checkout of the same CLEO project) returns the existing row and never moves its home host or alias. Collisions fail visibly.
 */
export function allocateProjectMailbox(node, folder, now = new Date()) {
    const id = resolveProject(folder);
    const db = node.store.db;
    const existing = projectMailboxByKey(node.store, id.key);
    if (existing)
        return { mailbox: existing, created: false, warnings: [] };
    const slot = slotFor(id.key);
    const taken = (sql) => !!db.prepare(sql).get(slot);
    if (projectMailboxBySlot(node.store, slot) || taken("SELECT 1 FROM agents WHERE name=?") || taken("SELECT 1 FROM identities WHERE name=?")
        || taken("SELECT 1 FROM identity_leases WHERE name=?") || taken("SELECT 1 FROM deliveries WHERE agent=? LIMIT 1") || node.store.get(`alias:${slot}`) !== undefined)
        fail("PROJECT_SLOT_TAKEN", `the project mailbox name ${slot} is already in use on ${node.host}; refusing to allocate over it`);
    const warnings = [];
    let alias = aliasFor(folder, id.cleoRoot);
    if (alias === null)
        warnings.push(`the folder name of ${id.cleoRoot ?? folder} is not a usable mailbox name; the project mailbox is addressable as ${slot}@${node.host} only`);
    else if (projectMailboxByAlias(node.store, alias)) {
        warnings.push(`${alias} already names another project's mailbox on ${node.host}; this project mailbox is addressable as ${slot}@${node.host} only`);
        alias = null;
    }
    const row = { key: id.key, slot, alias, home_host: node.host, source: id.cleoId ? "cleo" : "folder", folder: id.cleoRoot ?? folder, created_at: now.toISOString() };
    node.store.tx(() => {
        db.prepare("INSERT INTO project_mailboxes (key,slot,alias,home_host,source,folder,created_at) VALUES (?,?,?,?,?,?,?)")
            .run(row.key, row.slot, row.alias, row.home_host, row.source, row.folder, row.created_at);
        node.store.audit("project_mailbox.allocated", { key: row.key, slot: row.slot, alias: row.alias, home_host: row.home_host, source: row.source });
    });
    if (alias !== null && (node.establishedLocalName(alias) || node.knownLocalName(alias)))
        warnings.push(`a mailbox named ${alias} already exists here; new mail to ${alias} now goes to the project mailbox, and its old mail stays where it is until it is migrated (T494)`);
    return { mailbox: row, created: true, warnings };
}
/**
 * Replace a bare project name (or name@this-host) with the project's slot BEFORE the envelope is signed, so the signed bytes name the
 * destination that is actually used, and ahead of ordinary alias resolution: a legacy `agentmbx -> agentmbx-lead` alias must not
 * divert project mail into a personal inbox. Anything that is not an allocated alias passes through untouched; a prebuilt,
 * already-signed envelope is never passed here. Two spellings of one project collapse to one recipient.
 */
export function rewriteProjectAliases(node, to, project) {
    const rows = node.store.db.prepare("SELECT alias,slot,key,source FROM project_mailboxes WHERE alias IS NOT NULL").all();
    const anyPeer = !!node.store.db.prepare("SELECT 1 FROM peer_project_mailboxes LIMIT 1").get();
    const remoteSlots = to.some((t) => { const at = t.indexOf("@"); return at > 0 && isSlotName(t.slice(0, at)) && t.slice(at + 1) !== node.host; });
    if (!rows.length && !anyPeer && !remoteSlots)
        return { to, notes: [] };
    const bySlot = new Map(rows.map((r) => [r.alias, r]));
    const out = [], notes = [];
    let ownKey;
    const own = () => ownKey === undefined ? (ownKey = project ? resolveProject(project).cleoId : null) : ownKey; // only read when two projects answer to one name
    for (const t of to) {
        const at = t.indexOf("@");
        const raw = at === -1 ? t : t.slice(0, at), host = at === -1 ? undefined : t.slice(at + 1);
        const plain = !t.includes(":") && t !== "*" && t !== "owner";
        const local = plain && (host === undefined || host === node.host) ? bySlot.get(raw) : undefined;
        if (local !== undefined) {
            if (local.source === "cleo")
                assertSingleHome(node, local.key, raw); // two hosts that both allocated this project: no guess
            if (!out.includes(local.slot))
                out.push(local.slot);
            const held = node.store.db.prepare("SELECT 1 FROM identity_leases WHERE name=? AND released_at IS NULL").get(raw);
            notes.push(`${raw} is the project mailbox${held ? ` (a live mailbox of the same name exists; it does not receive this)` : ""}: delivered once to the project, read by its lead`);
            continue;
        }
        // T493 S3: a project mailbox that lives on a paired host. Its slot comes from that host's signed directory, never from the sender.
        const remote = plain && (host === undefined || host !== node.host) && (anyPeer || (host !== undefined && isSlotName(raw)))
            ? resolveRemoteProject(node, raw, host, own) : null;
        const dest = remote?.to ?? t;
        if (remote)
            notes.push(remote.note);
        if (!out.includes(dest))
            out.push(dest);
    }
    return { to: out, notes };
}
/**
 * The project keys a mailbox name belongs to. A project mailbox slot belongs to its own project. A persona belongs to the projects
 * in its identity_projects bindings (T515: the explicit membership, never a cwd or a folder name): the CLEO id stored with the
 * binding, else the folder, which is then the key (resolveProject, T543). Empty for a name bound to nothing.
 */
export function projectKeysOf(store, name) {
    const box = projectMailboxBySlot(store, name);
    if (box)
        return [box.key];
    const rows = store.db.prepare("SELECT project,project_key FROM identity_projects WHERE name=?").all(name);
    return [...new Set(rows.map((r) => r.project_key ?? r.project))].sort();
}
/**
 * The agent that leads the project mailbox `slot` on this host right now, or null: no such mailbox, no lead, a lead designated for
 * another host, an expired or a revoked record. The wake dispatcher keys project mail to this agent (T557); it is the same lookup
 * `projectReader` and `projectsLedBy` end in, so who is woken and who may read can never disagree.
 */
export const leadAgentOf = (node, slot, now = new Date()) => projectReader(node, slot, now)?.lead?.agent ?? null;
/**
 * The project mailbox for `slot` and the lead who may read it right now: the owner-signed, unrevoked, unexpired lead record for
 * the project's key, designated on THIS host (a lead elsewhere cannot read the home mailbox, T552). Null for a name that is not
 * an allocated slot. Re-verified on every call; a role label, a folder or a lead record alone is not read access to anything.
 */
export function projectReader(node, slot, now = new Date()) {
    const mailbox = projectMailboxBySlot(node.store, slot);
    if (!mailbox)
        return null;
    const lead = leadFor(node, mailbox.folder ?? mailbox.key, mailbox.key, now);
    return { mailbox, lead: lead && lead.host === node.host ? lead : null };
}
/**
 * The project mailboxes whose current lead on this host is `agent`: owner-signed, unrevoked, unexpired, designated here. Database
 * reads only (it runs inside the caller's lease operation). A role label, a folder or an old lead record is not in this list.
 */
export const projectsLedBy = (node, agent, now = new Date()) => leadingReaders(node, agent, now).map((r) => r.mailbox);
/**
 * `projectsLedBy` with the lead record that makes `agent` the lead of each project, for an action that must name the record it acted
 * on (T495). The one lookup behind reading, waking and moving project mail, so the three can never disagree about who leads.
 */
export function leadingReaders(node, agent, now = new Date()) {
    const rows = node.store.db.prepare("SELECT key,slot,alias,home_host,source,folder,created_at FROM project_mailboxes WHERE home_host=?").all(node.host);
    const out = [];
    for (const row of rows) {
        const lead = leadFor(node, row.folder ?? row.key, row.key, now);
        if (lead && lead.host === node.host && lead.agent === agent)
            out.push({ mailbox: { ...row }, lead });
    }
    return out;
}
/** A project mailbox named by its bare name, its slot or its key. */
export function resolveProjectMailbox(store, ref) {
    return projectMailboxByAlias(store, ref) ?? projectMailboxBySlot(store, ref) ?? projectMailboxByKey(store, ref);
}
/** How a person should read a slot: the bare name when it has one, otherwise the key's source. */
export const projectLabel = (m) => m.alias ?? m.slot;
