// Durable relay state (T165, docs/spec/relay-durability.md §2). The relay core talks to its state only through
// RelayStore, so a later backend can replace it without touching the protocol. The one implementation is node:sqlite
// on a persistent volume (owner decision 2026-10-02): WAL, synchronous=FULL, one writer process, and every successful
// response is sent only after its transaction commits. ":memory:" serves tests.
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";

export interface Enrolment { host: string; pubkey: string; owner_fp: string; at: string; account?: string | null; authorized_by?: string | null; revoked_at?: string | null }
export interface EncAd { host: string; host_pubkey: string; enc_pub: string; sig: string; at: string }
export type ItemKind = "envelope" | "receipt" | "expired";
export interface StoredItem { target_pubkey: string; seq: number; kind: ItemKind; item_id: string; sender_pubkey: string; sender_host: string; wire: string; wire_hash: string; bytes: number; accepted_at: string; expires_at: string | null }
export interface DedupHit { wire_hash: string; seq: number }
export interface Usage { items: number; bytes: number }

export interface RelayStore {
  transaction<T>(fn: () => T): T;
  meta(key: string): string | null;
  setMeta(key: string, value: string): void;
  /** Store generation: changes only on an explicit reset or restore (§5). */
  epoch(): string;
  getEnrolment(pubkey: string): Enrolment | null;
  enrolmentByName(host: string): Enrolment | null;
  enrolments(): Enrolment[];
  /** Insert or refresh an enrolment. A host name stays bound to its first key (F4) until that key is revoked. */
  putEnrolment(e: Enrolment): void;
  putEncAd(ad: EncAd): void;
  encAdByName(host: string): EncAd | null;
  dedup(sender_pubkey: string, item_id: string, target_pubkey: string): DedupHit | null;
  /** Allocate the next never-reused seq for the target and store the item and its dedup row. */
  insertItem(i: Omit<StoredItem, "seq">): number;
  pull(target_pubkey: string, after: number, limit: number): StoredItem[];
  lastSeq(target_pubkey: string): number;
  /** Delete items up to and including `through` and record it; returns how many were deleted. */
  ack(target_pubkey: string, through: number): number;
  ackedThrough(target_pubkey: string): number;
  targetUsage(target_pubkey: string): Usage;
  ownerUsage(owner_fp: string): Usage;
  close(): void;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS enrolments (
  host_pubkey TEXT PRIMARY KEY, host_name TEXT NOT NULL, owner_fp TEXT NOT NULL, account TEXT, authorized_by TEXT,
  enrolled_at TEXT NOT NULL, revoked_at TEXT);
CREATE UNIQUE INDEX IF NOT EXISTS enrolments_live_name ON enrolments(host_name) WHERE revoked_at IS NULL;
CREATE TABLE IF NOT EXISTS enc_ads (host_pubkey TEXT PRIMARY KEY, host_name TEXT NOT NULL, enc_pub TEXT NOT NULL, sig TEXT NOT NULL, at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS items (
  target_pubkey TEXT NOT NULL, seq INTEGER NOT NULL, kind TEXT NOT NULL, item_id TEXT NOT NULL, sender_pubkey TEXT NOT NULL,
  sender_host TEXT NOT NULL, wire TEXT NOT NULL, wire_hash TEXT NOT NULL, bytes INTEGER NOT NULL, accepted_at TEXT NOT NULL,
  expires_at TEXT, PRIMARY KEY (target_pubkey, seq));
CREATE INDEX IF NOT EXISTS items_expiry ON items(expires_at);
CREATE TABLE IF NOT EXISTS dedup (
  sender_pubkey TEXT NOT NULL, item_id TEXT NOT NULL, target_pubkey TEXT NOT NULL, wire_hash TEXT NOT NULL, seq INTEGER NOT NULL,
  accepted_at TEXT NOT NULL, PRIMARY KEY (sender_pubkey, item_id, target_pubkey));
CREATE INDEX IF NOT EXISTS dedup_age ON dedup(accepted_at);
CREATE TABLE IF NOT EXISTS seqs (target_pubkey TEXT PRIMARY KEY, next_seq INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS acked (target_pubkey TEXT PRIMARY KEY, acked_through INTEGER NOT NULL);
`;
const SCHEMA_VERSION = "1";

export class SqliteRelayStore implements RelayStore {
  readonly db: DatabaseSync;
  #depth = 0;
  constructor(path = ":memory:") {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;");
    this.db.exec(SCHEMA);
    if (!this.meta("epoch")) this.setMeta("epoch", randomUUID());
    if (!this.meta("schema_version")) this.setMeta("schema_version", SCHEMA_VERSION);
  }
  transaction<T>(fn: () => T): T {
    if (this.#depth) return fn(); // nested: part of the outer transaction
    this.db.exec("BEGIN IMMEDIATE");
    this.#depth++;
    try { const r = fn(); this.db.exec("COMMIT"); return r; }
    catch (e) { this.db.exec("ROLLBACK"); throw e; }
    finally { this.#depth--; }
  }
  meta(key: string): string | null { return (this.db.prepare("SELECT v FROM meta WHERE k=?").get(key) as { v: string } | undefined)?.v ?? null; }
  setMeta(key: string, value: string) { this.db.prepare("INSERT INTO meta (k,v) VALUES (?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v").run(key, value); }
  epoch(): string { return this.meta("epoch")!; }
  #enrol = (r: Record<string, unknown> | undefined): Enrolment | null => r ? { host: r.host_name as string, pubkey: r.host_pubkey as string, owner_fp: r.owner_fp as string,
    at: r.enrolled_at as string, account: (r.account as string | null) ?? null, authorized_by: (r.authorized_by as string | null) ?? null, revoked_at: (r.revoked_at as string | null) ?? null } : null;
  getEnrolment(pubkey: string) { return this.#enrol(this.db.prepare("SELECT * FROM enrolments WHERE host_pubkey=?").get(pubkey) as Record<string, unknown> | undefined); }
  enrolmentByName(host: string) { return this.#enrol(this.db.prepare("SELECT * FROM enrolments WHERE host_name=? AND revoked_at IS NULL").get(host) as Record<string, unknown> | undefined); }
  enrolments() { return (this.db.prepare("SELECT * FROM enrolments WHERE revoked_at IS NULL ORDER BY host_name").all() as Record<string, unknown>[]).map((r) => this.#enrol(r)!); }
  putEnrolment(e: Enrolment) {
    const owner = this.enrolmentByName(e.host);
    if (owner && owner.pubkey !== e.pubkey) throw Object.assign(new Error(`host name ${e.host} is enrolled with another key`), { code: "NAME_TAKEN" });
    this.db.prepare(`INSERT INTO enrolments (host_pubkey,host_name,owner_fp,account,authorized_by,enrolled_at,revoked_at) VALUES (?,?,?,?,?,?,NULL)
      ON CONFLICT(host_pubkey) DO UPDATE SET host_name=excluded.host_name, owner_fp=excluded.owner_fp, account=excluded.account,
        authorized_by=excluded.authorized_by, revoked_at=NULL`).run(e.pubkey, e.host, e.owner_fp, e.account ?? null, e.authorized_by ?? null, e.at);
  }
  putEncAd(ad: EncAd) {
    this.db.prepare(`INSERT INTO enc_ads (host_pubkey,host_name,enc_pub,sig,at) VALUES (?,?,?,?,?)
      ON CONFLICT(host_pubkey) DO UPDATE SET host_name=excluded.host_name, enc_pub=excluded.enc_pub, sig=excluded.sig, at=excluded.at`).run(ad.host_pubkey, ad.host, ad.enc_pub, ad.sig, ad.at);
  }
  encAdByName(host: string): EncAd | null {
    const e = this.enrolmentByName(host);
    if (!e) return null;
    const r = this.db.prepare("SELECT host_name host, host_pubkey, enc_pub, sig, at FROM enc_ads WHERE host_pubkey=?").get(e.pubkey) as EncAd | undefined;
    return r ? { ...r } : null;
  }
  dedup(sender: string, itemId: string, target: string): DedupHit | null {
    const r = this.db.prepare("SELECT wire_hash, seq FROM dedup WHERE sender_pubkey=? AND item_id=? AND target_pubkey=?").get(sender, itemId, target) as DedupHit | undefined;
    return r ? { ...r } : null;
  }
  insertItem(i: Omit<StoredItem, "seq">): number {
    return this.transaction(() => {
      const cur = (this.db.prepare("SELECT next_seq FROM seqs WHERE target_pubkey=?").get(i.target_pubkey) as { next_seq: number } | undefined)?.next_seq ?? 1;
      this.db.prepare("INSERT INTO seqs (target_pubkey,next_seq) VALUES (?,?) ON CONFLICT(target_pubkey) DO UPDATE SET next_seq=excluded.next_seq").run(i.target_pubkey, cur + 1);
      this.db.prepare(`INSERT INTO items (target_pubkey,seq,kind,item_id,sender_pubkey,sender_host,wire,wire_hash,bytes,accepted_at,expires_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(i.target_pubkey, cur, i.kind, i.item_id, i.sender_pubkey, i.sender_host, i.wire, i.wire_hash, i.bytes, i.accepted_at, i.expires_at);
      this.db.prepare("INSERT INTO dedup (sender_pubkey,item_id,target_pubkey,wire_hash,seq,accepted_at) VALUES (?,?,?,?,?,?)")
        .run(i.sender_pubkey, i.item_id, i.target_pubkey, i.wire_hash, cur, i.accepted_at);
      return cur;
    });
  }
  pull(target: string, after: number, limit: number): StoredItem[] {
    return (this.db.prepare("SELECT * FROM items WHERE target_pubkey=? AND seq>? ORDER BY seq LIMIT ?").all(target, after, limit) as unknown as StoredItem[]).map((r) => ({ ...r }));
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
  targetUsage(target: string): Usage {
    const r = this.db.prepare("SELECT COUNT(*) items, COALESCE(SUM(bytes),0) bytes FROM items WHERE target_pubkey=?").get(target) as { items: number; bytes: number };
    return { items: Number(r.items), bytes: Number(r.bytes) };
  }
  ownerUsage(owner: string): Usage {
    const r = this.db.prepare(`SELECT COUNT(*) items, COALESCE(SUM(i.bytes),0) bytes FROM items i JOIN enrolments e ON e.host_pubkey=i.target_pubkey
      WHERE e.owner_fp=? AND e.revoked_at IS NULL`).get(owner) as { items: number; bytes: number };
    return { items: Number(r.items), bytes: Number(r.bytes) };
  }
  close() { try { this.db.close(); } catch { /* already closed */ } }
}
