// The project mailbox (T493, ADR-037): mail to the bare project name is stored once, owned by the project, not by any persona.
// This module holds the registry, the bare-name rewrite and the reader lookup. Who may READ a slot is a separate question
// (the lease-fenced check in node.ts); nothing here grants access.
import { basename } from "node:path";
import { NAME_RE } from "./envelope.js";
import { leadFor } from "./lead-record.js";
import { resolveProject } from "./project-key.js";
import { isSlotName, slotFor } from "./project-slot.js";
export { isSlotName, slotFor } from "./project-slot.js";
/** Names a project must never claim as its bare name: they already mean something to send(). */
const RESERVED_ALIASES = new Set(["owner", "lead"]);
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
export function rewriteProjectAliases(node, to) {
    const rows = node.store.db.prepare("SELECT alias,slot FROM project_mailboxes WHERE alias IS NOT NULL").all();
    if (!rows.length)
        return { to, notes: [] };
    const bySlot = new Map(rows.map((r) => [r.alias, r.slot]));
    const out = [], notes = [];
    for (const t of to) {
        const at = t.indexOf("@");
        const raw = at === -1 ? t : t.slice(0, at), host = at === -1 ? undefined : t.slice(at + 1);
        const slot = !t.includes(":") && t !== "*" && (host === undefined || host === node.host) ? bySlot.get(raw) : undefined;
        if (slot === undefined) {
            if (!out.includes(t))
                out.push(t);
            continue;
        }
        if (!out.includes(slot))
            out.push(slot);
        const held = node.store.db.prepare("SELECT 1 FROM identity_leases WHERE name=? AND released_at IS NULL").get(raw);
        notes.push(`${raw} is the project mailbox${held ? ` (a live mailbox of the same name exists; it does not receive this)` : ""}: delivered once to the project, read by its lead`);
    }
    return { to: out, notes };
}
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
/** How a person should read a slot: the bare name when it has one, otherwise the key's source. */
export const projectLabel = (m) => m.alias ?? m.slot;
