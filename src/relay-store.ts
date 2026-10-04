// Durable relay state (T165, docs/spec/relay-durability.md §2). The relay core talks to its state only through
// RelayStore, so a later backend can replace it without touching the protocol. The one implementation is node:sqlite
// on a persistent volume (owner decision 2026-10-02): WAL, synchronous=FULL, one writer process, and every successful
// response is sent only after its transaction commits. ":memory:" serves tests.
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";

/** A host key the relay knows. Names are labels, not identities: hosts are found by key, and a name is unique only
 *  within a proven account (several owners may each have a `macbook`). `account` is set only by an authority that
 *  proved it (JWKS tokens, §8); `owner_fp` is the host's own unproven claim and decides nothing. */
export interface Enrolment { host: string; pubkey: string; owner_fp: string; at: string; account?: string | null; authorized_by?: string | null; revoked_at?: string | null }
export interface EncAd { host: string; host_pubkey: string; enc_pub: string; sig: string; at: string }
export type ItemKind = "envelope" | "receipt" | "expired";
/** `wire` is the exact bytes the sender submitted; `wire_hash` is lowercase hex SHA-256 of those bytes. */
export interface StoredItem { target_pubkey: string; seq: number; kind: ItemKind; item_id: string; sender_pubkey: string; sender_host: string; wire: Buffer; wire_hash: string; bytes: number; accepted_at: string; expires_at: string | null }
/** `accepted_at` is when the relay first accepted the item: a retry's accept carries it, so the sender's deadline stays exact. */
export interface DedupHit { wire_hash: string; seq: number; accepted_at: string }
export interface Usage { items: number; bytes: number }
/** One operational receipt in the relay log (`agentmbx relay log`): backup, restore, rotate-epoch, startup rotation, sweep. */
export interface OpRecord { id: number; at: string; op: string; receipt: Record<string, unknown> }
/** The relay log keeps this many receipts. */
export const OPS_KEEP = 1000;

export interface RelayStore {
  transaction<T>(fn: () => T): T;
  meta(key: string): string | null;
  setMeta(key: string, value: string): void;
  /** Store generation: changes only on an explicit reset or restore (§5). */
  epoch(): string;
  /** A new epoch: every receiver's checkpoint becomes void and senders re-push (`agentmbx relay rotate-epoch`, restores). */
  rotateEpoch(): string;
  getEnrolment(pubkey: string): Enrolment | null;
  /** Live enrolments carrying this name (case-insensitive), newest first (names are not unique across owners). */
  enrolmentsByName(host: string): Enrolment[];
  /** The sender keys a target accepts (its signed allowlist), or null when it published none. */
  senderList(target_pubkey: string): { senders: string[]; iat: string } | null;
  putSenderList(target_pubkey: string, senders: string[], iat: string, record: string, sig: string): void;
  enrolments(): Enrolment[];
  liveEnrolmentCount(): number;
  /** Insert or refresh a live enrolment. A revoked key stays revoked (REVOKED); a name is unique only within an account (NAME_TAKEN). */
  putEnrolment(e: Enrolment): void;
  revokeEnrolment(pubkey: string, at: string): void;
  /** T030 rotation: the new key (not revoked) takes the old key's name, account, queued items (re-sequenced in order after
   *  its own) and sender allowlist; other targets' allowlists swap the old key for the new; the old key is revoked. */
  rebind(oldPub: string, next: Enrolment): number;
  putEncAd(ad: EncAd): void;
  encAd(pubkey: string): EncAd | null;
  dedup(sender_pubkey: string, item_id: string, target_pubkey: string): DedupHit | null;
  /** Allocate the next never-reused seq for the target and store the item and its dedup row. */
  insertItem(i: Omit<StoredItem, "seq">): number;
  pull(target_pubkey: string, after: number, limit: number): StoredItem[];
  lastSeq(target_pubkey: string): number;
  /** Delete items up to and including `through` and record it; returns how many were deleted. */
  ack(target_pubkey: string, through: number): number;
  ackedThrough(target_pubkey: string): number;
  /** Items whose retention ended (`expires_at <= at`), oldest first (the sweep, §6). */
  expiredItems(at: string, limit: number): StoredItem[];
  deleteItem(target_pubkey: string, seq: number): void;
  /** Dedup rows accepted before `before` whose item is gone (acked or expired): the dedup horizon (§7). A row whose item
   *  is still queued is never pruned. Returns how many went. */
  pruneDedup(before: string): number;
  /** Append an operational receipt to the relay log, keeping the last OPS_KEEP. */
  logOp(op: string, receipt: Record<string, unknown>, at?: string): void;
  /** The newest receipts first. */
  ops(limit: number): OpRecord[];
  targetUsage(target_pubkey: string): Usage;
  senderUsage(sender_pubkey: string, target_pubkey: string): Usage;
  accountUsage(account: string): Usage;
  close(): void;
}

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
CREATE TABLE IF NOT EXISTS ops (id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, op TEXT NOT NULL, receipt TEXT NOT NULL);
`;
/** 1: T165 draft (wire TEXT, globally unique names). 2: wire BLOB, names unique per account, sender index.
 *  (Sequence numbers have a time floor; sender allowlists and the relay log are additive: no version change.) */
export const SCHEMA_VERSION = 2;

/** Upgrades from older schema versions, each in its own transaction. */
const MIGRATIONS: Record<number, string> = {
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

const coded = (code: string, message: string) => Object.assign(new Error(message), { code });

export interface SqliteRelayStoreOptions {
  /** The sequence floor's clock. A new seq is max(next_seq, now()) in ms, so a store restored from an older copy keeps
   *  allocating above anything handed out before the restore and receivers never miss items (spec §5). Tests pass
   *  () => 0 for small sequential numbers. */
  now?: () => number;
}

export class SqliteRelayStore implements RelayStore {
  readonly db: DatabaseSync;
  readonly #now: () => number;
  #depth = 0;
  constructor(path = ":memory:", o: SqliteRelayStoreOptions = {}) {
    this.#now = o.now ?? Date.now;
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;");
    this.db.exec("CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);");
    const stored = Number(this.meta("schema_version") ?? 0);
    if (stored > SCHEMA_VERSION) {
      this.close();
      throw coded("SCHEMA", `relay store schema ${stored} is newer than this agentmbx (${SCHEMA_VERSION}): upgrade agentmbx, never downgrade a relay store`);
    }
    for (let v = stored + 1; stored > 0 && v <= SCHEMA_VERSION; v++) this.transaction(() => { this.db.exec(MIGRATIONS[v] ?? ""); this.setMeta("schema_version", String(v)); });
    this.db.exec(SCHEMA);
    if (!this.meta("epoch")) this.setMeta("epoch", randomUUID());
    // Expiry is enforced from T167 on, for v2 items only. Items queued before (v1 or v2: the store cannot tell) never had
    // it and keep not having it: their senders may be v1, which can never learn of an expiry. Once, recorded in meta.
    if (!this.meta("expiry_from")) this.transaction(() => {
      this.db.prepare("UPDATE items SET expires_at=NULL WHERE kind<>'expired'").run();
      this.setMeta("expiry_from", new Date().toISOString());
    });
    this.setMeta("schema_version", String(SCHEMA_VERSION));
  }
  transaction<T>(fn: () => T): T {
    if (this.#depth) return fn(); // nested: part of the outer transaction
    this.db.exec("BEGIN IMMEDIATE");
    this.#depth++;
    try { const r = fn(); this.db.exec("COMMIT"); return r; }
    catch (e) { try { this.db.exec("ROLLBACK"); } catch { /* keep the original error */ } throw e; }
    finally { this.#depth--; }
  }
  meta(key: string): string | null { return (this.db.prepare("SELECT v FROM meta WHERE k=?").get(key) as { v: string } | undefined)?.v ?? null; }
  setMeta(key: string, value: string) { this.db.prepare("INSERT INTO meta (k,v) VALUES (?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v").run(key, value); }
  epoch(): string { return this.meta("epoch")!; }
  rotateEpoch(): string { const e = randomUUID(); this.setMeta("epoch", e); return e; }
  #enrol = (r: Record<string, unknown> | undefined): Enrolment | null => r ? { host: r.host_name as string, pubkey: r.host_pubkey as string, owner_fp: r.owner_fp as string,
    at: r.enrolled_at as string, account: (r.account as string | null) ?? null, authorized_by: (r.authorized_by as string | null) ?? null, revoked_at: (r.revoked_at as string | null) ?? null } : null;
  getEnrolment(pubkey: string) { return this.#enrol(this.db.prepare("SELECT * FROM enrolments WHERE host_pubkey=?").get(pubkey) as Record<string, unknown> | undefined); }
  enrolmentsByName(host: string) {
    return (this.db.prepare("SELECT * FROM enrolments WHERE lower(host_name)=lower(?) AND revoked_at IS NULL ORDER BY enrolled_at DESC, rowid DESC").all(host) as Record<string, unknown>[]).map((r) => this.#enrol(r)!);
  }
  enrolments() { return (this.db.prepare("SELECT * FROM enrolments WHERE revoked_at IS NULL ORDER BY host_name").all() as Record<string, unknown>[]).map((r) => this.#enrol(r)!); }
  liveEnrolmentCount() { return Number((this.db.prepare("SELECT COUNT(*) n FROM enrolments WHERE revoked_at IS NULL").get() as { n: number }).n); }
  putEnrolment(e: Enrolment) {
    const cur = this.getEnrolment(e.pubkey);
    if (cur?.revoked_at) throw coded("REVOKED", "this host key was revoked on this relay");
    if (e.account) {
      const taken = this.db.prepare("SELECT host_pubkey FROM enrolments WHERE account=? AND lower(host_name)=lower(?) AND revoked_at IS NULL AND host_pubkey<>?").get(e.account, e.host, e.pubkey);
      if (taken) throw coded("NAME_TAKEN", `host name ${e.host} is already enrolled in this account with another key`);
    }
    this.db.prepare(`INSERT INTO enrolments (host_pubkey,host_name,owner_fp,account,authorized_by,enrolled_at,revoked_at) VALUES (?,?,?,?,?,?,NULL)
      ON CONFLICT(host_pubkey) DO UPDATE SET host_name=excluded.host_name, owner_fp=excluded.owner_fp,
        account=COALESCE(excluded.account, enrolments.account),
        authorized_by=CASE WHEN excluded.account IS NULL AND enrolments.account IS NOT NULL THEN enrolments.authorized_by ELSE excluded.authorized_by END,
        enrolled_at=excluded.enrolled_at`).run(e.pubkey, e.host, e.owner_fp, e.account ?? null, e.authorized_by ?? null, e.at);
  }
  revokeEnrolment(pubkey: string, at: string) {
    this.db.prepare("UPDATE enrolments SET revoked_at=COALESCE(revoked_at, ?) WHERE host_pubkey=?").run(at, pubkey);
  }
  rebind(oldPub: string, next: Enrolment): number {
    return this.transaction(() => {
      const cur = this.getEnrolment(next.pubkey);
      if (cur?.revoked_at) throw coded("ROTATION_TARGET", "the new key was revoked here");
      this.revokeEnrolment(oldPub, next.at);
      this.putEnrolment(next);
      // queued items follow the host: re-sequenced in order under the new key, after anything already queued for it (both
      // keys signed the rotation; the receiver keeps its retired enc keys)
      const rows = this.db.prepare("SELECT * FROM items WHERE target_pubkey=? ORDER BY seq").all(oldPub) as unknown as StoredItem[];
      for (const r of rows) {
        this.insertItem({ ...r, target_pubkey: next.pubkey, wire: Buffer.from(r.wire) }); // also writes the dedup row under the new key
        this.db.prepare("DELETE FROM dedup WHERE sender_pubkey=? AND item_id=? AND target_pubkey=?").run(r.sender_pubkey, r.item_id, oldPub);
      }
      this.db.prepare("DELETE FROM items WHERE target_pubkey=?").run(oldPub);
      this.db.prepare("DELETE FROM enc_ads WHERE host_pubkey=?").run(oldPub);
      this.db.prepare("UPDATE sender_lists SET target_pubkey=? WHERE target_pubkey=?").run(next.pubkey, oldPub);
      for (const l of this.db.prepare("SELECT target_pubkey, senders FROM sender_lists WHERE instr(senders, ?) > 0").all(oldPub) as { target_pubkey: string; senders: string }[]) {
        const senders = (JSON.parse(l.senders) as string[]).map((k) => k === oldPub ? next.pubkey : k);
        this.db.prepare("UPDATE sender_lists SET senders=? WHERE target_pubkey=?").run(JSON.stringify([...new Set(senders)]), l.target_pubkey);
      }
      return rows.length;
    });
  }
  putEncAd(ad: EncAd) {
    this.db.prepare(`INSERT INTO enc_ads (host_pubkey,host_name,enc_pub,sig,at) VALUES (?,?,?,?,?)
      ON CONFLICT(host_pubkey) DO UPDATE SET host_name=excluded.host_name, enc_pub=excluded.enc_pub, sig=excluded.sig, at=excluded.at`).run(ad.host_pubkey, ad.host, ad.enc_pub, ad.sig, ad.at);
  }
  encAd(pubkey: string): EncAd | null {
    const r = this.db.prepare(`SELECT a.host_name host, a.host_pubkey, a.enc_pub, a.sig, a.at FROM enc_ads a JOIN enrolments e ON e.host_pubkey=a.host_pubkey
      WHERE a.host_pubkey=? AND e.revoked_at IS NULL`).get(pubkey) as EncAd | undefined;
    return r ? { ...r } : null;
  }
  senderList(target: string) {
    const r = this.db.prepare("SELECT senders, iat FROM sender_lists WHERE target_pubkey=?").get(target) as { senders: string; iat: string } | undefined;
    return r ? { senders: JSON.parse(r.senders) as string[], iat: r.iat } : null;
  }
  putSenderList(target: string, senders: string[], iat: string, record: string, sig: string) {
    this.db.prepare(`INSERT INTO sender_lists (target_pubkey,senders,iat,record,sig) VALUES (?,?,?,?,?)
      ON CONFLICT(target_pubkey) DO UPDATE SET senders=excluded.senders, iat=excluded.iat, record=excluded.record, sig=excluded.sig`).run(target, JSON.stringify(senders), iat, record, sig);
  }
  dedup(sender: string, itemId: string, target: string): DedupHit | null {
    const r = this.db.prepare("SELECT wire_hash, seq, accepted_at FROM dedup WHERE sender_pubkey=? AND item_id=? AND target_pubkey=?").get(sender, itemId, target) as DedupHit | undefined;
    return r ? { ...r } : null;
  }
  insertItem(i: Omit<StoredItem, "seq">): number {
    return this.transaction(() => {
      const stored = (this.db.prepare("SELECT next_seq FROM seqs WHERE target_pubkey=?").get(i.target_pubkey) as { next_seq: number } | undefined)?.next_seq ?? 1;
      const cur = Math.max(stored, Math.floor(this.#now()));
      this.db.prepare("INSERT INTO seqs (target_pubkey,next_seq) VALUES (?,?) ON CONFLICT(target_pubkey) DO UPDATE SET next_seq=excluded.next_seq").run(i.target_pubkey, cur + 1);
      this.db.prepare(`INSERT INTO items (target_pubkey,seq,kind,item_id,sender_pubkey,sender_host,wire,wire_hash,bytes,accepted_at,expires_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(i.target_pubkey, cur, i.kind, i.item_id, i.sender_pubkey, i.sender_host, i.wire, i.wire_hash, i.bytes, i.accepted_at, i.expires_at);
      this.db.prepare(`INSERT INTO dedup (sender_pubkey,item_id,target_pubkey,wire_hash,seq,accepted_at) VALUES (?,?,?,?,?,?)
        ON CONFLICT DO NOTHING`).run(i.sender_pubkey, i.item_id, i.target_pubkey, i.wire_hash, cur, i.accepted_at);
      return cur;
    });
  }
  pull(target: string, after: number, limit: number): StoredItem[] {
    return (this.db.prepare("SELECT * FROM items WHERE target_pubkey=? AND seq>? ORDER BY seq LIMIT ?").all(target, after, limit) as unknown as StoredItem[])
      .map((r) => ({ ...r, wire: Buffer.from(r.wire) }));
  }
  lastSeq(target: string): number { return ((this.db.prepare("SELECT next_seq FROM seqs WHERE target_pubkey=?").get(target) as { next_seq: number } | undefined)?.next_seq ?? 1) - 1; }
  ack(target: string, through: number): number {
    return this.transaction(() => {
      const n = Number(this.db.prepare("DELETE FROM items WHERE target_pubkey=? AND seq<=?").run(target, through).changes);
      this.db.prepare("INSERT INTO acked (target_pubkey,acked_through) VALUES (?,?) ON CONFLICT(target_pubkey) DO UPDATE SET acked_through=MAX(acked_through,excluded.acked_through)").run(target, through);
      return n;
    });
  }
  ackedThrough(target: string): number { return (this.db.prepare("SELECT acked_through FROM acked WHERE target_pubkey=?").get(target) as { acked_through: number } | undefined)?.acked_through ?? 0; }
  expiredItems(at: string, limit: number): StoredItem[] {
    return (this.db.prepare("SELECT * FROM items WHERE expires_at IS NOT NULL AND expires_at <= ? ORDER BY expires_at, target_pubkey, seq LIMIT ?").all(at, limit) as unknown as StoredItem[])
      .map((r) => ({ ...r, wire: Buffer.from(r.wire) }));
  }
  deleteItem(target: string, seq: number) { this.db.prepare("DELETE FROM items WHERE target_pubkey=? AND seq=?").run(target, seq); }
  pruneDedup(before: string): number {
    return Number(this.db.prepare(`DELETE FROM dedup WHERE accepted_at < ?
      AND NOT EXISTS (SELECT 1 FROM items i WHERE i.target_pubkey=dedup.target_pubkey AND i.seq=dedup.seq)`).run(before).changes);
  }
  logOp(op: string, receipt: Record<string, unknown>, at = new Date().toISOString()) {
    this.transaction(() => {
      this.db.prepare("INSERT INTO ops (at, op, receipt) VALUES (?,?,?)").run(at, op, JSON.stringify(receipt));
      this.db.prepare("DELETE FROM ops WHERE id <= (SELECT MAX(id) FROM ops) - ?").run(OPS_KEEP);
    });
  }
  ops(limit: number): OpRecord[] {
    return (this.db.prepare("SELECT id, at, op, receipt FROM ops ORDER BY id DESC LIMIT ?").all(limit) as { id: number; at: string; op: string; receipt: string }[])
      .map((r) => ({ id: Number(r.id), at: r.at, op: r.op, receipt: JSON.parse(r.receipt) as Record<string, unknown> }));
  }
  #usage = (sql: string, ...args: string[]): Usage => {
    const r = this.db.prepare(sql).get(...args) as { items: number; bytes: number };
    return { items: Number(r.items), bytes: Number(r.bytes) };
  };
  targetUsage(target: string) { return this.#usage("SELECT COUNT(*) items, COALESCE(SUM(bytes),0) bytes FROM items WHERE target_pubkey=?", target); }
  senderUsage(sender: string, target: string) { return this.#usage("SELECT COUNT(*) items, COALESCE(SUM(bytes),0) bytes FROM items WHERE sender_pubkey=? AND target_pubkey=?", sender, target); }
  accountUsage(account: string) {
    return this.#usage(`SELECT COUNT(*) items, COALESCE(SUM(i.bytes),0) bytes FROM items i JOIN enrolments e ON e.host_pubkey=i.target_pubkey
      WHERE e.account=? AND e.revoked_at IS NULL`, account);
  }
  close() { try { this.db.close(); } catch { /* already closed */ } }
}
