// Durable relay state (T165, docs/spec/relay-durability.md §2). The relay core talks to its state only through
// RelayStore, so a later backend can replace it without touching the protocol. The one implementation is node:sqlite
// on a persistent volume (owner decision 2026-10-02): WAL, synchronous=FULL, one writer process, and every successful
// response is sent only after its transaction commits. ":memory:" serves tests.
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS enrolments (
  host_pubkey TEXT PRIMARY KEY, host_name TEXT NOT NULL, owner_fp TEXT NOT NULL, account TEXT, authorized_by TEXT,
  enrolled_at TEXT NOT NULL, revoked_at TEXT);
CREATE INDEX IF NOT EXISTS enrolments_name ON enrolments(lower(host_name)) WHERE revoked_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS enrolments_account_name ON enrolments(account, host_name) WHERE revoked_at IS NULL AND account IS NOT NULL;
CREATE TABLE IF NOT EXISTS enc_ads (host_pubkey TEXT PRIMARY KEY, host_name TEXT NOT NULL, enc_pub TEXT NOT NULL, sig TEXT NOT NULL, at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS items (
  target_pubkey TEXT NOT NULL, seq INTEGER NOT NULL, kind TEXT NOT NULL, item_id TEXT NOT NULL, sender_pubkey TEXT NOT NULL,
  sender_host TEXT NOT NULL, wire BLOB NOT NULL, wire_hash TEXT NOT NULL, bytes INTEGER NOT NULL, accepted_at TEXT NOT NULL,
  expires_at TEXT, PRIMARY KEY (target_pubkey, seq));
CREATE INDEX IF NOT EXISTS items_expiry ON items(expires_at);
CREATE INDEX IF NOT EXISTS items_sender ON items(sender_pubkey, target_pubkey);
CREATE TABLE IF NOT EXISTS dedup (
  sender_pubkey TEXT NOT NULL, item_id TEXT NOT NULL, target_pubkey TEXT NOT NULL, wire_hash TEXT NOT NULL, seq INTEGER NOT NULL,
  accepted_at TEXT NOT NULL, PRIMARY KEY (sender_pubkey, item_id, target_pubkey));
CREATE INDEX IF NOT EXISTS dedup_age ON dedup(accepted_at);
CREATE TABLE IF NOT EXISTS seqs (target_pubkey TEXT PRIMARY KEY, next_seq INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS acked (target_pubkey TEXT PRIMARY KEY, acked_through INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS sender_lists (target_pubkey TEXT PRIMARY KEY, senders TEXT NOT NULL, iat TEXT NOT NULL, record TEXT NOT NULL, sig TEXT NOT NULL);
`;
/** 1: T165 draft (wire TEXT, globally unique names). 2: wire BLOB, names unique per account, sender index.
 *  (Sequence numbers have a time floor and sender allowlists are additive: no version change.) */
export const SCHEMA_VERSION = 2;
/** Upgrades from older schema versions, each in its own transaction. */
const MIGRATIONS = {
    2: `DROP INDEX IF EXISTS enrolments_live_name;
    CREATE TABLE items_v2 (
      target_pubkey TEXT NOT NULL, seq INTEGER NOT NULL, kind TEXT NOT NULL, item_id TEXT NOT NULL, sender_pubkey TEXT NOT NULL,
      sender_host TEXT NOT NULL, wire BLOB NOT NULL, wire_hash TEXT NOT NULL, bytes INTEGER NOT NULL, accepted_at TEXT NOT NULL,
      expires_at TEXT, PRIMARY KEY (target_pubkey, seq));
    INSERT INTO items_v2 (target_pubkey, seq, kind, item_id, sender_pubkey, sender_host, wire, wire_hash, bytes, accepted_at, expires_at)
      SELECT target_pubkey, seq, kind, item_id, sender_pubkey, sender_host, CAST(wire AS BLOB), wire_hash, bytes, accepted_at, expires_at FROM items;
    DROP TABLE items;
    ALTER TABLE items_v2 RENAME TO items;
    DROP INDEX IF EXISTS enrolments_name;`,
};
const coded = (code, message) => Object.assign(new Error(message), { code });
export class SqliteRelayStore {
    db;
    #now;
    #depth = 0;
    constructor(path = ":memory:", o = {}) {
        this.#now = o.now ?? Date.now;
        if (path !== ":memory:")
            mkdirSync(dirname(path), { recursive: true });
        this.db = new DatabaseSync(path);
        this.db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;");
        this.db.exec("CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);");
        const stored = Number(this.meta("schema_version") ?? 0);
        if (stored > SCHEMA_VERSION) {
            this.close();
            throw coded("SCHEMA", `relay store schema ${stored} is newer than this agentmbx (${SCHEMA_VERSION}): upgrade agentmbx, never downgrade a relay store`);
        }
        for (let v = stored + 1; stored > 0 && v <= SCHEMA_VERSION; v++)
            this.transaction(() => { this.db.exec(MIGRATIONS[v] ?? ""); this.setMeta("schema_version", String(v)); });
        this.db.exec(SCHEMA);
        if (!this.meta("epoch"))
            this.setMeta("epoch", randomUUID());
        this.setMeta("schema_version", String(SCHEMA_VERSION));
    }
    transaction(fn) {
        if (this.#depth)
            return fn(); // nested: part of the outer transaction
        this.db.exec("BEGIN IMMEDIATE");
        this.#depth++;
        try {
            const r = fn();
            this.db.exec("COMMIT");
            return r;
        }
        catch (e) {
            try {
                this.db.exec("ROLLBACK");
            }
            catch { /* keep the original error */ }
            throw e;
        }
        finally {
            this.#depth--;
        }
    }
    meta(key) { return this.db.prepare("SELECT v FROM meta WHERE k=?").get(key)?.v ?? null; }
    setMeta(key, value) { this.db.prepare("INSERT INTO meta (k,v) VALUES (?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v").run(key, value); }
    epoch() { return this.meta("epoch"); }
    rotateEpoch() { const e = randomUUID(); this.setMeta("epoch", e); return e; }
    #enrol = (r) => r ? { host: r.host_name, pubkey: r.host_pubkey, owner_fp: r.owner_fp,
        at: r.enrolled_at, account: r.account ?? null, authorized_by: r.authorized_by ?? null, revoked_at: r.revoked_at ?? null } : null;
    getEnrolment(pubkey) { return this.#enrol(this.db.prepare("SELECT * FROM enrolments WHERE host_pubkey=?").get(pubkey)); }
    enrolmentsByName(host) {
        return this.db.prepare("SELECT * FROM enrolments WHERE lower(host_name)=lower(?) AND revoked_at IS NULL ORDER BY enrolled_at DESC, rowid DESC").all(host).map((r) => this.#enrol(r));
    }
    enrolments() { return this.db.prepare("SELECT * FROM enrolments WHERE revoked_at IS NULL ORDER BY host_name").all().map((r) => this.#enrol(r)); }
    liveEnrolmentCount() { return Number(this.db.prepare("SELECT COUNT(*) n FROM enrolments WHERE revoked_at IS NULL").get().n); }
    putEnrolment(e) {
        const cur = this.getEnrolment(e.pubkey);
        if (cur?.revoked_at)
            throw coded("REVOKED", "this host key was revoked on this relay");
        if (e.account) {
            const taken = this.db.prepare("SELECT host_pubkey FROM enrolments WHERE account=? AND lower(host_name)=lower(?) AND revoked_at IS NULL AND host_pubkey<>?").get(e.account, e.host, e.pubkey);
            if (taken)
                throw coded("NAME_TAKEN", `host name ${e.host} is already enrolled in this account with another key`);
        }
        this.db.prepare(`INSERT INTO enrolments (host_pubkey,host_name,owner_fp,account,authorized_by,enrolled_at,revoked_at) VALUES (?,?,?,?,?,?,NULL)
      ON CONFLICT(host_pubkey) DO UPDATE SET host_name=excluded.host_name, owner_fp=excluded.owner_fp,
        account=COALESCE(excluded.account, enrolments.account),
        authorized_by=CASE WHEN excluded.account IS NULL AND enrolments.account IS NOT NULL THEN enrolments.authorized_by ELSE excluded.authorized_by END,
        enrolled_at=excluded.enrolled_at`).run(e.pubkey, e.host, e.owner_fp, e.account ?? null, e.authorized_by ?? null, e.at);
    }
    revokeEnrolment(pubkey, at) {
        this.db.prepare("UPDATE enrolments SET revoked_at=COALESCE(revoked_at, ?) WHERE host_pubkey=?").run(at, pubkey);
    }
    rebind(oldPub, next) {
        return this.transaction(() => {
            const cur = this.getEnrolment(next.pubkey);
            if (cur && (cur.revoked_at || this.targetUsage(next.pubkey).items > 0))
                throw coded("ROTATION_TARGET", "the new key must be fresh (unrevoked, with an empty queue)");
            this.revokeEnrolment(oldPub, next.at);
            this.putEnrolment(next);
            // queued items follow the host: re-sequenced in order under the new key (the receiver keeps its retired enc keys)
            const rows = this.db.prepare("SELECT * FROM items WHERE target_pubkey=? ORDER BY seq").all(oldPub);
            for (const r of rows) {
                this.insertItem({ ...r, target_pubkey: next.pubkey, wire: Buffer.from(r.wire) }); // also writes the dedup row under the new key
                this.db.prepare("DELETE FROM dedup WHERE sender_pubkey=? AND item_id=? AND target_pubkey=?").run(r.sender_pubkey, r.item_id, oldPub);
            }
            this.db.prepare("DELETE FROM items WHERE target_pubkey=?").run(oldPub);
            this.db.prepare("DELETE FROM enc_ads WHERE host_pubkey=?").run(oldPub);
            this.db.prepare("UPDATE sender_lists SET target_pubkey=? WHERE target_pubkey=?").run(next.pubkey, oldPub);
            for (const l of this.db.prepare("SELECT target_pubkey, senders FROM sender_lists WHERE instr(senders, ?) > 0").all(oldPub)) {
                const senders = JSON.parse(l.senders).map((k) => k === oldPub ? next.pubkey : k);
                this.db.prepare("UPDATE sender_lists SET senders=? WHERE target_pubkey=?").run(JSON.stringify([...new Set(senders)]), l.target_pubkey);
            }
            return rows.length;
        });
    }
    putEncAd(ad) {
        this.db.prepare(`INSERT INTO enc_ads (host_pubkey,host_name,enc_pub,sig,at) VALUES (?,?,?,?,?)
      ON CONFLICT(host_pubkey) DO UPDATE SET host_name=excluded.host_name, enc_pub=excluded.enc_pub, sig=excluded.sig, at=excluded.at`).run(ad.host_pubkey, ad.host, ad.enc_pub, ad.sig, ad.at);
    }
    encAd(pubkey) {
        const r = this.db.prepare(`SELECT a.host_name host, a.host_pubkey, a.enc_pub, a.sig, a.at FROM enc_ads a JOIN enrolments e ON e.host_pubkey=a.host_pubkey
      WHERE a.host_pubkey=? AND e.revoked_at IS NULL`).get(pubkey);
        return r ? { ...r } : null;
    }
    senderList(target) {
        const r = this.db.prepare("SELECT senders, iat FROM sender_lists WHERE target_pubkey=?").get(target);
        return r ? { senders: JSON.parse(r.senders), iat: r.iat } : null;
    }
    putSenderList(target, senders, iat, record, sig) {
        this.db.prepare(`INSERT INTO sender_lists (target_pubkey,senders,iat,record,sig) VALUES (?,?,?,?,?)
      ON CONFLICT(target_pubkey) DO UPDATE SET senders=excluded.senders, iat=excluded.iat, record=excluded.record, sig=excluded.sig`).run(target, JSON.stringify(senders), iat, record, sig);
    }
    dedup(sender, itemId, target) {
        const r = this.db.prepare("SELECT wire_hash, seq FROM dedup WHERE sender_pubkey=? AND item_id=? AND target_pubkey=?").get(sender, itemId, target);
        return r ? { ...r } : null;
    }
    insertItem(i) {
        return this.transaction(() => {
            const stored = this.db.prepare("SELECT next_seq FROM seqs WHERE target_pubkey=?").get(i.target_pubkey)?.next_seq ?? 1;
            const cur = Math.max(stored, Math.floor(this.#now()));
            this.db.prepare("INSERT INTO seqs (target_pubkey,next_seq) VALUES (?,?) ON CONFLICT(target_pubkey) DO UPDATE SET next_seq=excluded.next_seq").run(i.target_pubkey, cur + 1);
            this.db.prepare(`INSERT INTO items (target_pubkey,seq,kind,item_id,sender_pubkey,sender_host,wire,wire_hash,bytes,accepted_at,expires_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(i.target_pubkey, cur, i.kind, i.item_id, i.sender_pubkey, i.sender_host, i.wire, i.wire_hash, i.bytes, i.accepted_at, i.expires_at);
            this.db.prepare(`INSERT INTO dedup (sender_pubkey,item_id,target_pubkey,wire_hash,seq,accepted_at) VALUES (?,?,?,?,?,?)
        ON CONFLICT DO NOTHING`).run(i.sender_pubkey, i.item_id, i.target_pubkey, i.wire_hash, cur, i.accepted_at);
            return cur;
        });
    }
    pull(target, after, limit) {
        return this.db.prepare("SELECT * FROM items WHERE target_pubkey=? AND seq>? ORDER BY seq LIMIT ?").all(target, after, limit)
            .map((r) => ({ ...r, wire: Buffer.from(r.wire) }));
    }
    lastSeq(target) { return (this.db.prepare("SELECT next_seq FROM seqs WHERE target_pubkey=?").get(target)?.next_seq ?? 1) - 1; }
    ack(target, through) {
        return this.transaction(() => {
            const n = Number(this.db.prepare("DELETE FROM items WHERE target_pubkey=? AND seq<=?").run(target, through).changes);
            this.db.prepare("INSERT INTO acked (target_pubkey,acked_through) VALUES (?,?) ON CONFLICT(target_pubkey) DO UPDATE SET acked_through=MAX(acked_through,excluded.acked_through)").run(target, through);
            return n;
        });
    }
    ackedThrough(target) { return this.db.prepare("SELECT acked_through FROM acked WHERE target_pubkey=?").get(target)?.acked_through ?? 0; }
    #usage = (sql, ...args) => {
        const r = this.db.prepare(sql).get(...args);
        return { items: Number(r.items), bytes: Number(r.bytes) };
    };
    targetUsage(target) { return this.#usage("SELECT COUNT(*) items, COALESCE(SUM(bytes),0) bytes FROM items WHERE target_pubkey=?", target); }
    senderUsage(sender, target) { return this.#usage("SELECT COUNT(*) items, COALESCE(SUM(bytes),0) bytes FROM items WHERE sender_pubkey=? AND target_pubkey=?", sender, target); }
    accountUsage(account) {
        return this.#usage(`SELECT COUNT(*) items, COALESCE(SUM(i.bytes),0) bytes FROM items i JOIN enrolments e ON e.host_pubkey=i.target_pubkey
      WHERE e.account=? AND e.revoked_at IS NULL`, account);
    }
    close() { try {
        this.db.close();
    }
    catch { /* already closed */ } }
}
