// The name of a project mailbox's delivery slot (T493). A leaf module: no store, node or registry imports, so the places that
// enumerate mailbox names out of `deliveries` can import it without a cycle.
//
// A project mailbox keeps its deliveries in the same table as every identity's mail (receipt triggers, replay visibility and
// retention then work unchanged), under a reserved, syntactically recognisable name instead of an identity's. Nothing may
// register, claim or lease such a name, and every query that lists "mailboxes" from `deliveries` must leave it out.
import { createHash } from "node:crypto";
export const SLOT_PREFIX = "pm-";
/** pm- plus the first 32 hex characters of sha256(project key): 35 characters, inside NAME_RE and the receipt address bounds. */
export const SLOT_RE = /^pm-[0-9a-f]{32}$/;
/** The same shape as a SQLite GLOB, so a query can exclude slots without reading the registry (a read-only opener may not have the table). */
export const SLOT_GLOB = `${SLOT_PREFIX}${"[0-9a-f]".repeat(32)}`;
/** Names a project must never claim as its bare name: they already mean something to send(). Shared by allocation and by what a peer may advertise. */
export const RESERVED_ALIASES = new Set(["owner", "lead"]);
export const isSlotName = (name) => SLOT_RE.test(name);
export function slotFor(key) {
    return SLOT_PREFIX + createHash("sha256").update(key).digest("hex").slice(0, 32);
}
/** `col NOT GLOB '<slot shape>'`: the guard every deliveries enumerator carries. Fail-closed for any slot-shaped name. */
export const notSlot = (col) => `${col} NOT GLOB '${SLOT_GLOB}'`;
