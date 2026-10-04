// Relay operations (T167, docs/spec/relay-durability.md §5): one writer per store, an online backup, an atomic restore
// that rotates the epoch and never brings back authority the live store had already taken away, and the relay log of
// receipts (`agentmbx relay log`). Every operation answers with a receipt an operator can inspect, and a restore keeps
// the store it replaced as a rollback copy whose restore command is in the receipt.
import { createHash } from "node:crypto";
import { chmodSync, closeSync, copyFileSync, createReadStream, existsSync, fsyncSync, mkdirSync, openSync, renameSync, rmSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { backup as sqliteBackup, DatabaseSync } from "node:sqlite";
import { fingerprint } from "./crypto.js";
import { OPS_KEEP, SCHEMA_VERSION, SqliteRelayStore } from "./relay-store.js";
export const STORE_DB = "relay.db";
export const LOCK_FILE = "relay.lock";
/** A heartbeat younger than this means a relay may be running (it writes one every 30 s). */
const LIVE_HEARTBEAT_MS = 90_000;
const ALL_PAGES = 2_147_483_647; // one backup step: one consistent snapshot, even while the relay writes
const coded = (code, message) => Object.assign(new Error(message), { code });
const iso = (ms) => new Date(ms).toISOString();
/** SHA-256 of a file, streamed (a store can outgrow what one read may hold). */
export async function sha256File(path) {
    const h = createHash("sha256");
    for await (const chunk of createReadStream(path))
        h.update(chunk);
    return h.digest("hex");
}
/** Backups, rollback copies and the store hold every queued item and the relay's metadata: owner-only, like relay.key. */
const PRIVATE_FILE = 0o600, PRIVATE_DIR = 0o700;
const privateDir = (dir) => mkdirSync(dir, { recursive: true, mode: PRIVATE_DIR });
function fsyncPath(path) {
    try {
        const fd = openSync(path, "r");
        try {
            fsyncSync(fd);
        }
        finally {
            closeSync(fd);
        }
    }
    catch { /* not every platform fsyncs a directory */ }
}
const removeDb = (path) => { for (const p of [path, `${path}-wal`, `${path}-shm`, `${path}-journal`])
    rmSync(p, { force: true }); };
/**
 * One writer per store (§2). `relay serve` and `relay restore` hold an exclusive SQLite lock on relay.lock for as long
 * as they run. It is an operating-system file lock, so it goes when its holder dies, even by SIGKILL, and it is seen
 * from other processes and from other connections in this one. Null: somebody holds it.
 */
export function lockStore(dir) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const db = new DatabaseSync(join(dir, LOCK_FILE));
    try {
        db.exec("PRAGMA busy_timeout=0; PRAGMA locking_mode=EXCLUSIVE; CREATE TABLE IF NOT EXISTS holder (pid INTEGER NOT NULL, at TEXT NOT NULL)");
        db.exec("BEGIN EXCLUSIVE");
        db.exec("DELETE FROM holder");
        db.prepare("INSERT INTO holder (pid, at) VALUES (?, ?)").run(process.pid, new Date().toISOString());
        db.exec("COMMIT");
    }
    catch (e) {
        try {
            db.exec("ROLLBACK");
        }
        catch { /* nothing open */ }
        db.close();
        if (/locked|busy/i.test(e.message))
            return null;
        throw e;
    }
    let held = true;
    return { release: () => { if (held) {
            held = false;
            try {
                db.close();
            }
            catch { /* already closed */ }
        } } };
}
/** Wait up to `ms` for the lock (a redeploy may overlap the old process for a moment). */
export async function waitForLock(dir, ms, every = 1_000) {
    for (const end = Date.now() + ms;;) {
        const lock = lockStore(dir);
        if (lock || Date.now() >= end)
            return lock;
        await new Promise((r) => setTimeout(r, every));
    }
}
/** Read the facts of a store file (tolerant of older schemas). */
function facts(db) {
    const meta = (k) => { try {
        return db.prepare("SELECT v FROM meta WHERE k=?").get(k)?.v ?? null;
    }
    catch {
        return null;
    } };
    const n = (sql) => { try {
        return Number(db.prepare(sql).get().n);
    }
    catch {
        return 0;
    } };
    const beat = Number(meta("heartbeat") ?? NaN), pub = meta("relay_pubkey");
    return { epoch: meta("epoch"), relay_pubkey: pub, relay_fingerprint: pub ? fingerprint(pub) : null, schema_version: Number(meta("schema_version") ?? 0),
        heartbeat: Number.isFinite(beat) && Math.abs(beat) <= 8.64e15 ? iso(beat) : null,
        counts: { enrolments: n("SELECT COUNT(*) n FROM enrolments WHERE revoked_at IS NULL"), revoked: n("SELECT COUNT(*) n FROM enrolments WHERE revoked_at IS NOT NULL"),
            items: n("SELECT COUNT(*) n FROM items"), bytes: n("SELECT COALESCE(SUM(bytes),0) n FROM items"), dedup: n("SELECT COUNT(*) n FROM dedup"),
            targets: n("SELECT COUNT(DISTINCT target_pubkey) n FROM items") } };
}
/** Make a copied store self-contained (rollback journal, any WAL folded in) and check it. Returns its facts. */
function sealCopy(path) {
    const db = new DatabaseSync(path);
    try {
        db.exec("PRAGMA journal_mode=DELETE");
        const ok = db.prepare("PRAGMA integrity_check").get().integrity_check;
        if (ok !== "ok")
            throw coded("CORRUPT", `${path} fails its integrity check: ${ok}`);
        return facts(db);
    }
    finally {
        db.close();
    }
}
/** An online copy of an open database into `dest` via the SQLite backup API, written beside it and renamed into place. */
async function onlineCopy(db, dest) {
    privateDir(dirname(dest));
    const tmp = `${dest}.partial-${process.pid}`;
    removeDb(tmp);
    try {
        await sqliteBackup(db, tmp, { rate: ALL_PAGES });
        const f = sealCopy(tmp);
        chmodSync(tmp, PRIVATE_FILE); // before it has its final name: never readable by others, not even briefly
        fsyncPath(tmp);
        renameSync(tmp, dest);
        fsyncPath(dirname(dest));
        return f;
    }
    finally {
        removeDb(tmp);
    }
}
function appendOp(db, op, receipt, at) {
    db.exec("CREATE TABLE IF NOT EXISTS ops (id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, op TEXT NOT NULL, receipt TEXT NOT NULL)");
    db.prepare("INSERT INTO ops (at, op, receipt) VALUES (?,?,?)").run(at, op, JSON.stringify(receipt));
    db.prepare("DELETE FROM ops WHERE id <= (SELECT MAX(id) FROM ops) - ?").run(OPS_KEEP);
}
/**
 * `agentmbx relay backup <file>`: the SQLite online backup API in one step, so the copy is one consistent snapshot and
 * safe while the relay runs. The copy is written beside the target, checked, and renamed into place (never a partial
 * file under the final name); an existing file is never overwritten. The receipt goes to the relay log too.
 * Backups hold sealed bodies and the metadata in the threat model, never a private key.
 */
export async function backupStore(dir, file, o = {}) {
    const src = join(dir, STORE_DB), dest = resolve(file);
    if (!existsSync(src))
        throw coded("NO_STORE", `no relay store at ${src}`);
    if (existsSync(dest))
        throw coded("EXISTS", `${dest} already exists: a backup never overwrites a file`);
    const db = new DatabaseSync(src);
    try {
        db.exec("PRAGMA busy_timeout=5000");
        const f = await onlineCopy(db, dest);
        const at = iso((o.now ?? Date.now)());
        const receipt = { v: 1, type: "relay-backup", at, store: src, file: dest, bytes: statSync(dest).size, sha256: await sha256File(dest),
            epoch: f.epoch, relay_fingerprint: f.relay_fingerprint, schema_version: f.schema_version, heartbeat: f.heartbeat, counts: f.counts,
            restore: `agentmbx relay restore ${dest} --store-dir ${resolve(dir)}` };
        appendOp(db, "backup", receipt, at);
        return receipt;
    }
    finally {
        db.close();
    }
}
/** The paths a store was restored from: `restored_paths`, plus the single `restored` record of the first T167 build. */
function pathsOf(meta) {
    const out = {};
    try {
        Object.assign(out, JSON.parse(meta("restored_paths") ?? "{}"));
    }
    catch { /* unreadable: none */ }
    try {
        const r = JSON.parse(meta("restored") ?? "null");
        if (r?.file && !out[r.file])
            out[r.file] = r.at ?? "";
    }
    catch { /* none */ }
    return out;
}
function readAuthority(db) {
    const all = (sql) => db.prepare(sql).all();
    const meta = (k) => db.prepare("SELECT v FROM meta WHERE k=?").get(k)?.v ?? null;
    let ops = [];
    try {
        ops = all("SELECT at, op, receipt FROM ops ORDER BY id");
    }
    catch { /* a store older than the relay log */ }
    return { epoch: meta("epoch"), relay_pubkey: meta("relay_pubkey"),
        revoked: all("SELECT host_pubkey, host_name, owner_fp, account, authorized_by, enrolled_at, revoked_at FROM enrolments WHERE revoked_at IS NOT NULL"),
        senderLists: all("SELECT target_pubkey, senders, iat, record, sig FROM sender_lists"), encAds: all("SELECT host_pubkey, host_name, enc_pub, sig, at FROM enc_ads"),
        seqs: all("SELECT target_pubkey, next_seq FROM seqs").map((r) => ({ target_pubkey: r.target_pubkey, next_seq: Number(r.next_seq) })), ops,
        restoredPaths: pathsOf(meta) };
}
/**
 * `agentmbx relay restore <file>`: replace the store with a backup, atomically, while no relay runs on it.
 *
 * 1. Refuses while a relay holds the store lock (and, for a store without one, while a heartbeat is fresh).
 * 2. Copies the backup (never touching the file given) and checks it: integrity, a relay store, a schema this binary
 *    can open, and the same relay key as the store it replaces.
 * 3. Copies the current store into rollback/ with the online backup API and reads the authority it holds.
 * 4. On the copy: keeps every revocation (a key revoked or rotated away after the backup stays revoked), the newer
 *    signed sender allowlists and enc-key ads, each target's sequence floor, and the relay log; rotates the epoch;
 *    writes a fresh heartbeat; logs the receipt.
 * 5. Renames the copy over relay.db: the old store or the new one, never a mix. A failure before that leaves the live
 *    store untouched.
 *
 * Enrolments made after the backup are not carried: those hosts get 401 and re-enrol on their next pass (§8).
 */
export async function restoreStore(dir, file, o = {}) {
    const src = resolve(file), live = resolve(join(dir, STORE_DB));
    if (!existsSync(src))
        throw coded("NO_BACKUP", `no backup at ${src}`);
    if (src === live)
        throw coded("SAME_FILE", "that is the live store itself; restore a backup file");
    const hadLock = existsSync(join(dir, LOCK_FILE));
    const lock = o.lock ?? lockStore(dir);
    if (!lock)
        throw coded("RELAY_RUNNING", `a relay is running on ${resolve(dir)} (it holds ${LOCK_FILE}): stop it first; a restore never replaces a store under a running relay`);
    const now = (o.now ?? Date.now)(), at = iso(now), stamp = at.replace(/[:.]/g, "-");
    const tmp = join(dir, `relay.db.restore-${stamp}`), rollbackDir = join(dir, "rollback"), rollback = join(rollbackDir, `relay-${stamp}.db`);
    let swapped = false;
    try {
        // 1. a relay that predates the lock may still be running: its heartbeat says so
        if (!hadLock && !o.lock && existsSync(live) && !o.force) {
            let beat = NaN;
            try {
                const db = new DatabaseSync(live);
                try {
                    beat = Number(db.prepare("SELECT v FROM meta WHERE k='heartbeat'").get()?.v ?? NaN);
                }
                finally {
                    db.close();
                }
            }
            catch { /* unreadable: handled below */ }
            if (Number.isFinite(beat) && now - beat < LIVE_HEARTBEAT_MS)
                throw coded("RELAY_RUNNING", `a relay wrote a heartbeat ${Math.round((now - beat) / 1000)} s ago and this store has no ${LOCK_FILE} (an older relay may be running): stop it and retry after ${LIVE_HEARTBEAT_MS / 1000} s, or pass --force if it is stopped`);
        }
        // 2. the backup, copied and checked
        removeDb(tmp);
        copyFileSync(src, tmp);
        chmodSync(tmp, PRIVATE_FILE);
        if (existsSync(`${src}-wal`))
            copyFileSync(`${src}-wal`, `${tmp}-wal`); // a raw volume copy: fold its WAL in
        const b = sealCopy(tmp);
        if (!b.epoch || !b.relay_pubkey)
            throw coded("NOT_A_STORE", `${src} is not a relay store (no epoch or relay key)`);
        if (b.schema_version > SCHEMA_VERSION)
            throw coded("SCHEMA", `${src} has relay store schema ${b.schema_version}, newer than this agentmbx (${SCHEMA_VERSION}): upgrade agentmbx first`);
        // 3. the store it replaces: a rollback copy and the authority it holds
        let current = null, replaced = null, otherKey = null;
        if (existsSync(live)) {
            try {
                const db = new DatabaseSync(live);
                try {
                    db.exec("PRAGMA busy_timeout=5000");
                    const ok = db.prepare("PRAGMA quick_check").get().quick_check;
                    if (ok !== "ok")
                        throw new Error(`integrity: ${ok}`);
                    current = readAuthority(db);
                    if (current.relay_pubkey && current.relay_pubkey !== b.relay_pubkey)
                        otherKey = current.relay_pubkey;
                    else {
                        const f = await onlineCopy(db, rollback);
                        replaced = { epoch: f.epoch, rollback, sha256: await sha256File(rollback), bytes: statSync(rollback).size, readable: true };
                    }
                }
                finally {
                    db.close();
                }
            }
            catch (e) {
                if (!o.force)
                    throw coded("CURRENT_UNREADABLE", `the current store cannot be read (${e.message}): its revocations cannot be carried forward. Pass --force to restore without them; the current files are then kept in ${rollbackDir}`);
                current = null;
                privateDir(rollbackDir);
                for (const ext of ["", "-wal", "-shm"])
                    if (existsSync(live + ext)) {
                        copyFileSync(live + ext, rollback + ext);
                        chmodSync(rollback + ext, PRIVATE_FILE);
                    }
                replaced = { epoch: null, rollback, sha256: await sha256File(rollback), bytes: statSync(rollback).size, readable: false };
            }
            if (otherKey)
                throw coded("OTHER_RELAY", `this backup belongs to another relay key (${b.relay_fingerprint}; the store is ${fingerprint(otherKey)}): clients pinned this store's key`);
        }
        // 4. carry forward what only restricts, or what its owner signed, and rotate the epoch
        const store = new SqliteRelayStore(tmp); // migrates an older schema (a migration keeps the epoch)
        let receipt;
        try {
            const db = store.db;
            const carried = store.transaction(() => {
                const c = { revocations: 0, sender_lists: 0, enc_ads: 0, seq_floors: 0 };
                if (!current)
                    return c;
                for (const r of current.revoked) {
                    const was = db.prepare("SELECT revoked_at FROM enrolments WHERE host_pubkey=?").get(r.host_pubkey);
                    if (was?.revoked_at)
                        continue;
                    db.prepare(`INSERT INTO enrolments (host_pubkey,host_name,owner_fp,account,authorized_by,enrolled_at,revoked_at) VALUES (?,?,?,?,?,?,?)
            ON CONFLICT(host_pubkey) DO UPDATE SET revoked_at=excluded.revoked_at`).run(r.host_pubkey, r.host_name, r.owner_fp ?? "", r.account ?? null, r.authorized_by ?? null, r.enrolled_at, r.revoked_at);
                    c.revocations++;
                }
                for (const l of current.senderLists) {
                    const mine = store.senderList(l.target_pubkey);
                    if (mine && Date.parse(mine.iat) >= Date.parse(l.iat))
                        continue;
                    db.prepare(`INSERT INTO sender_lists (target_pubkey,senders,iat,record,sig) VALUES (?,?,?,?,?) ON CONFLICT(target_pubkey) DO UPDATE SET
            senders=excluded.senders, iat=excluded.iat, record=excluded.record, sig=excluded.sig`).run(l.target_pubkey, l.senders, l.iat, l.record, l.sig);
                    c.sender_lists++;
                }
                for (const a of current.encAds) {
                    const mine = db.prepare("SELECT at FROM enc_ads WHERE host_pubkey=?").get(a.host_pubkey);
                    if (mine && mine.at >= a.at)
                        continue;
                    store.putEncAd({ host: a.host_name, host_pubkey: a.host_pubkey, enc_pub: a.enc_pub, sig: a.sig, at: a.at });
                    c.enc_ads++;
                }
                for (const q of current.seqs) {
                    const mine = Number(db.prepare("SELECT next_seq FROM seqs WHERE target_pubkey=?").get(q.target_pubkey)?.next_seq ?? 0);
                    if (mine >= q.next_seq)
                        continue;
                    db.prepare("INSERT INTO seqs (target_pubkey,next_seq) VALUES (?,?) ON CONFLICT(target_pubkey) DO UPDATE SET next_seq=excluded.next_seq").run(q.target_pubkey, q.next_seq);
                    c.seq_floors++;
                }
                if (current.ops.length) { // the operator's history continues; the backup's own log is older
                    db.exec("DELETE FROM ops");
                    for (const r of current.ops.slice(-OPS_KEEP))
                        db.prepare("INSERT INTO ops (at, op, receipt) VALUES (?,?,?)").run(r.at, r.op, r.receipt);
                }
                return c;
            });
            const from = store.epoch(), to = store.rotateEpoch();
            store.setMeta("heartbeat", String(now)); // the restore is the event; serve must not rotate again for the backup's age
            // every path this store lineage was restored from, so MBX_RELAY_RESTORE_FROM never restores one twice
            store.setMeta("restored_paths", JSON.stringify({ ...pathsOf((k) => store.meta(k)), ...current?.restoredPaths, [src]: at }));
            receipt = { v: 1, type: "relay-restore", at, store: live,
                backup: { file: src, sha256: await sha256File(src), bytes: statSync(src).size, epoch: b.epoch, schema_version: b.schema_version, heartbeat: b.heartbeat },
                replaced, epoch: { from, to }, carried, counts: facts(db).counts,
                rollback: replaced ? `agentmbx relay restore ${rollback} --store-dir ${resolve(dir)}${replaced.readable ? "" : " --force"}` : null,
                next: "start the relay: clients see the new epoch, senders re-push every message the relay accepted and the recipient has not confirmed, receivers re-pull from 0, and dedup on both ends absorbs the repeats" };
            store.setMeta("restored", JSON.stringify({ at, file: src, sha256: receipt.backup.sha256, from, to }));
            store.logOp("restore", receipt, at);
        }
        finally {
            store.close();
        }
        if (existsSync(`${tmp}-wal`) && statSync(`${tmp}-wal`).size > 0)
            throw coded("WAL", `the restored copy did not close cleanly (${tmp}-wal remains); the live store was not touched`);
        sealCopy(tmp);
        chmodSync(tmp, PRIVATE_FILE);
        // 5. the swap: the old store's WAL must never meet the new file
        for (const ext of ["-wal", "-shm", "-journal"]) {
            if (!existsSync(live + ext))
                continue;
            if (statSync(live + ext).size > 0 && ext === "-wal") {
                privateDir(rollbackDir);
                renameSync(live + ext, `${rollback}${ext}-leftover`);
            }
            else
                rmSync(live + ext, { force: true });
        }
        fsyncPath(tmp);
        renameSync(tmp, live);
        fsyncPath(dir);
        swapped = true;
        return receipt;
    }
    finally {
        if (!swapped)
            removeDb(tmp);
        if (!o.lock)
            lock.release();
    }
}
/** `agentmbx relay rotate-epoch`: a new epoch (after a restore made outside agentmbx), with a receipt in the relay log. */
export function rotateEpochOp(dir, o = {}) {
    const store = new SqliteRelayStore(join(dir, STORE_DB));
    try {
        const at = iso((o.now ?? Date.now)()), from = store.epoch(), to = store.rotateEpoch();
        const receipt = { v: 1, type: "relay-epoch-rotated", at, store: resolve(join(dir, STORE_DB)), from, to, by: "operator" };
        store.logOp("epoch-rotated", receipt, at);
        return receipt;
    }
    finally {
        store.close();
    }
}
/** The relay log, newest first (read without migrating or writing anything; safe while the relay runs). */
export function readOps(dir, limit = 50) {
    const path = join(dir, STORE_DB);
    if (!existsSync(path))
        throw coded("NO_STORE", `no relay store at ${path}`);
    const db = new DatabaseSync(path);
    try {
        db.exec("PRAGMA busy_timeout=5000");
        try {
            return db.prepare("SELECT id, at, op, receipt FROM ops ORDER BY id DESC LIMIT ?").all(limit)
                .map((r) => ({ id: Number(r.id), at: r.at, op: r.op, receipt: JSON.parse(r.receipt) }));
        }
        catch {
            return [];
        } // a store older than the relay log
    }
    finally {
        db.close();
    }
}
/**
 * When this store (or the store it was restored over) was restored from `file`, or null. MBX_RELAY_RESTORE_FROM is
 * consumed by its path: a path restored once is never restored again, whatever the file there holds now and whatever
 * restores happened since (the record is carried across restores). Restore another backup from a new path.
 */
export function restoredFrom(dir, file) {
    const path = join(dir, STORE_DB);
    if (!existsSync(path))
        return null;
    const db = new DatabaseSync(path);
    try {
        const meta = (k) => { try {
            return db.prepare("SELECT v FROM meta WHERE k=?").get(k)?.v ?? null;
        }
        catch {
            return null;
        } };
        const paths = pathsOf(meta), key = resolve(file);
        return key in paths ? paths[key] || "an unknown time" : null;
    }
    finally {
        db.close();
    }
}
