// SQLite store (node:sqlite, WAL). One per host; every mbx process on the host opens it.
import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { privatePath } from "./private-files.js";
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
/**
 * Store layout version (PRAGMA user_version). Bump it with every schema change. A process that finds a newer version
 * (an old MCP server still running after an upgrade) refuses to write instead of failing with raw SQL errors.
 */
export const SCHEMA_VERSION = 1;
export class Store {
    db;
    constructor(home) {
        mkdirSync(home, { recursive: true, mode: 0o700 });
        const existed = existsSync(join(home, "mbx.db"));
        this.db = new DatabaseSync(join(home, "mbx.db"));
        try {
            // Read the compatibility marker before any schema, journal-mode or permission changes.
            this.assertCurrent();
            privatePath(home, 0o700);
            privatePath(join(home, "mbx.db"), 0o600, false, existed);
            this.db.exec(SCHEMA);
            // columns added after 0.2 (CREATE TABLE IF NOT EXISTS doesn't add them to existing databases)
            for (const ddl of ["ALTER TABLE sessions ADD COLUMN pid_start TEXT", "ALTER TABLE principals ADD COLUMN peer TEXT", "ALTER TABLE policy_revocations ADD COLUMN owner_fp TEXT"]) {
                try {
                    this.db.exec(ddl);
                }
                catch { /* already there */ }
            }
            if (this.schemaVersion() < SCHEMA_VERSION)
                this.db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
            for (const f of ["mbx.db-wal", "mbx.db-shm"])
                privatePath(join(home, f), 0o600, true);
        }
        catch (e) {
            this.db.close();
            throw e;
        }
    }
    close() { this.db.close(); }
    schemaVersion() { return this.db.prepare("PRAGMA user_version").get().user_version; }
    /** Throws a clear "restart" error when a newer agentmbx has upgraded the store since this process started. */
    assertCurrent(running) {
        const v = this.schemaVersion();
        if (v > SCHEMA_VERSION)
            throw Object.assign(new Error(`this mbx server${running ? ` (agentmbx ${running})` : ""} is older than the mailbox store (schema ${v} > ${SCHEMA_VERSION}); a newer agentmbx upgraded it. Update AgentMBX if necessary. Restart your CLI session to load the current mbx tools.`), { code: "STALE_SERVER" });
    }
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
        this.db.prepare("INSERT INTO audit (at,event,detail) VALUES (?,?,?)").run(new Date().toISOString(), event, detail == null ? null : JSON.stringify(detail));
    }
    get(k) { return this.db.prepare("SELECT v FROM kv WHERE k=?").get(k)?.v; }
    set(k, v) { this.db.prepare("INSERT INTO kv (k,v) VALUES (?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v").run(k, v); }
    hasMessage(id) { return !!this.db.prepare("SELECT 1 FROM messages WHERE id=?").get(id); }
    /** Insert once (id dedupe). Returns false when the id was already stored. */
    insertMessage(e, origin, trust, authority) {
        const r = this.db.prepare(`INSERT OR IGNORE INTO messages (id,ts,from_addr,thread,reply_to,kind,subject,body,envelope,origin,trust,authority,received_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(e.id, e.ts, e.from, e.thread, e.reply_to, e.kind, e.subject, e.body, JSON.stringify(e), origin, trust, authority == null ? null : JSON.stringify(authority), new Date().toISOString());
        return r.changes > 0;
    }
    addDelivery(msgId, agent, state = "delivered") {
        this.db.prepare("INSERT OR IGNORE INTO deliveries (msg_id,agent,state,updated_at,note) VALUES (?,?,?,?,NULL)").run(msgId, agent, state, new Date().toISOString());
    }
    setDelivery(msgId, agent, state, note = null) {
        const order = ["queued", "delivered", "notified", "read", "acked"];
        const rank = order.indexOf(state);
        if (rank <= 0)
            return false;
        const earlier = order.slice(0, rank);
        // Check and advance in one statement: another MCP/daemon process may ack while a wake is in flight.
        const result = this.db.prepare(`UPDATE deliveries SET state=?, updated_at=?, note=COALESCE(?,note)
      WHERE msg_id=? AND agent=? AND state IN (${earlier.map(() => "?").join(",")})`)
            .run(state, new Date().toISOString(), note, msgId, agent, ...earlier);
        return result.changes > 0;
    }
}
