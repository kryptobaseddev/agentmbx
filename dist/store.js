// SQLite store (node:sqlite, WAL). One per host; every mbx process on the host opens it.
import { DatabaseSync } from "node:sqlite";
import { chmodSync, mkdirSync } from "node:fs";
import { join } from "node:path";
const SCHEMA = `
PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY, ts TEXT NOT NULL, from_addr TEXT NOT NULL, thread TEXT NOT NULL, reply_to TEXT,
  kind TEXT NOT NULL, subject TEXT NOT NULL, body TEXT NOT NULL, envelope TEXT NOT NULL,
  origin TEXT NOT NULL,          -- 'local' or the paired host name it arrived from
  trust TEXT NOT NULL,           -- 'local' | 'verified' | 'legacy'
  authority TEXT,                -- JSON {caps, grant_id, session} when an owner grant verified, else NULL
  received_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS messages_thread ON messages(thread, ts);
CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(subject, body, content='messages', content_rowid='rowid');
CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
  INSERT INTO messages_fts(rowid, subject, body) VALUES (new.rowid, new.subject, new.body); END;
CREATE TABLE IF NOT EXISTS deliveries (   -- one row per (message, recipient agent on THIS host)
  msg_id TEXT NOT NULL REFERENCES messages(id), agent TEXT NOT NULL, state TEXT NOT NULL,
  updated_at TEXT NOT NULL, note TEXT, PRIMARY KEY (msg_id, agent));
CREATE INDEX IF NOT EXISTS deliveries_agent ON deliveries(agent, state);
CREATE TABLE IF NOT EXISTS outbox (       -- envelopes waiting to reach a paired host
  msg_id TEXT NOT NULL, host TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, next_at TEXT NOT NULL,
  last_error TEXT, created_at TEXT NOT NULL, PRIMARY KEY (msg_id, host));
CREATE TABLE IF NOT EXISTS agents (       -- agents known on this host and on paired hosts
  name TEXT NOT NULL, host TEXT NOT NULL, role TEXT, cli TEXT, description TEXT, last_seen TEXT,
  PRIMARY KEY (name, host));
CREATE TABLE IF NOT EXISTS sessions (     -- live CLI sessions bound to local agents (for wake-up)
  agent TEXT NOT NULL, cli TEXT NOT NULL, session_id TEXT NOT NULL, cwd TEXT, pid INTEGER,
  session_key TEXT, channel INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL, PRIMARY KEY (cli, session_id));
CREATE TABLE IF NOT EXISTS peers (
  host TEXT PRIMARY KEY, pubkey TEXT NOT NULL, owner_pubkey TEXT, addr TEXT NOT NULL,
  state TEXT NOT NULL,           -- 'pending' | 'approved'
  code TEXT, nonce_local TEXT, nonce_remote TEXT, created_at TEXT NOT NULL, approved_at TEXT);
CREATE TABLE IF NOT EXISTS grants (id TEXT PRIMARY KEY, sub TEXT NOT NULL, grant TEXT NOT NULL, exp TEXT NOT NULL, revoked INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS wakes (agent TEXT NOT NULL, thread TEXT, at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS audit (at TEXT NOT NULL, event TEXT NOT NULL, detail TEXT);
CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS policies (     -- owner-signed collaboration policies (src/policy.ts)
  id TEXT PRIMARY KEY, record TEXT NOT NULL, sig TEXT NOT NULL, owner_fp TEXT NOT NULL, iat TEXT NOT NULL, exp TEXT NOT NULL,
  revoked INTEGER NOT NULL DEFAULT 0, received_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS policy_revocations (id TEXT PRIMARY KEY, target TEXT NOT NULL, iat TEXT NOT NULL, record TEXT NOT NULL, sig TEXT NOT NULL, received_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS devices (id TEXT PRIMARY KEY, record TEXT NOT NULL, sig TEXT NOT NULL, received_at TEXT NOT NULL); -- owner-signed device records
CREATE TABLE IF NOT EXISTS principals (   -- humans by owner key. role: owner (this host takes policies from it) | member | guest | peer-owner
  fp TEXT PRIMARY KEY, pub TEXT NOT NULL, role TEXT NOT NULL, label TEXT, via TEXT NOT NULL, added_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS pair_tokens (  -- one-time pairing tokens (agentmbx pair); only scrypt(token) is stored
  id TEXT PRIMARY KEY, key TEXT NOT NULL, created_at TEXT NOT NULL, expires_at TEXT NOT NULL,
  failures INTEGER NOT NULL DEFAULT 0,
  state TEXT NOT NULL,           -- 'live' | 'used' | 'burned'
  used_by TEXT);
`;
export class Store {
    db;
    constructor(home) {
        mkdirSync(home, { recursive: true, mode: 0o700 });
        this.db = new DatabaseSync(join(home, "mbx.db"));
        this.db.exec(SCHEMA);
        // columns added after 0.2 (CREATE TABLE IF NOT EXISTS doesn't add them to existing databases)
        for (const ddl of ["ALTER TABLE sessions ADD COLUMN pid_start TEXT", "ALTER TABLE principals ADD COLUMN peer TEXT", "ALTER TABLE policy_revocations ADD COLUMN owner_fp TEXT"]) {
            try {
                this.db.exec(ddl);
            }
            catch { /* already there */ }
        }
        for (const f of ["mbx.db", "mbx.db-wal", "mbx.db-shm"]) {
            try {
                chmodSync(join(home, f), 0o600);
            }
            catch { /* not created yet */ }
        }
    }
    close() { this.db.close(); }
    tx(fn) {
        this.db.exec("BEGIN IMMEDIATE");
        try {
            const r = fn();
            this.db.exec("COMMIT");
            return r;
        }
        catch (e) {
            this.db.exec("ROLLBACK");
            throw e;
        }
    }
    audit(event, detail = null) {
        this.db.prepare("INSERT INTO audit VALUES (?,?,?)").run(new Date().toISOString(), event, detail == null ? null : JSON.stringify(detail));
    }
    get(k) { return this.db.prepare("SELECT v FROM kv WHERE k=?").get(k)?.v; }
    set(k, v) { this.db.prepare("INSERT INTO kv VALUES (?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v").run(k, v); }
    hasMessage(id) { return !!this.db.prepare("SELECT 1 FROM messages WHERE id=?").get(id); }
    /** Insert once (id dedupe). Returns false when the id was already stored. */
    insertMessage(e, origin, trust, authority) {
        const r = this.db.prepare(`INSERT OR IGNORE INTO messages (id,ts,from_addr,thread,reply_to,kind,subject,body,envelope,origin,trust,authority,received_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(e.id, e.ts, e.from, e.thread, e.reply_to, e.kind, e.subject, e.body, JSON.stringify(e), origin, trust, authority == null ? null : JSON.stringify(authority), new Date().toISOString());
        return r.changes > 0;
    }
    addDelivery(msgId, agent, state = "delivered") {
        this.db.prepare("INSERT OR IGNORE INTO deliveries VALUES (?,?,?,?,NULL)").run(msgId, agent, state, new Date().toISOString());
    }
    setDelivery(msgId, agent, state, note = null) {
        const order = ["queued", "delivered", "notified", "read", "acked"];
        const cur = this.db.prepare("SELECT state FROM deliveries WHERE msg_id=? AND agent=?").get(msgId, agent);
        if (!cur || order.indexOf(cur.state) >= order.indexOf(state))
            return false; // states only move forward
        this.db.prepare("UPDATE deliveries SET state=?, updated_at=?, note=COALESCE(?,note) WHERE msg_id=? AND agent=?")
            .run(state, new Date().toISOString(), note, msgId, agent);
        return true;
    }
}
