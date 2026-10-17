import { closeSync, fstatSync, globSync, lstatSync, openSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { activityKey, parseActivity } from "./identity-availability.js";
const THREAD = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
/** Exact-thread rollout activity for the existing MCP heartbeat; never starts a process. */
export class CodexActivity {
    home;
    paths = new Map();
    turns = new Map();
    constructor(home = process.env.CODEX_HOME || join(homedir(), ".codex")) { this.home = home; }
    openTurn(thread, path, stat) {
        let fd;
        try {
            fd = openSync(path, "r");
            const observed = fstatSync(fd), prior = this.turns.get(thread);
            if (!observed.isFile() || observed.dev !== stat.dev || observed.ino !== stat.ino
                || observed.size !== stat.size || observed.mtimeMs !== stat.mtimeMs)
                throw new Error("rollout changed");
            if (prior && (prior.dev !== stat.dev || prior.ino !== stat.ino || stat.size < prior.size
                || stat.mtimeMs < prior.mtimeMs || (stat.size === prior.size && stat.mtimeMs !== prior.mtimeMs))) {
                this.turns.delete(thread);
                return false; // A replaced or rewritten rollout is not continuity evidence for the cached turn.
            }
            if (prior && prior.size === stat.size && prior.mtimeMs === stat.mtimeMs)
                return prior.open;
            const turns = new Set();
            // shortcut: changed rollouts are rescanned; use incremental reads if heartbeat parsing becomes costly.
            for (const line of readFileSync(fd, "utf8").split("\n")) {
                if (!line.trim())
                    continue;
                const row = JSON.parse(line);
                if (row?.type !== "event_msg")
                    continue;
                const payload = row.payload;
                if (payload?.turn_id !== undefined && (typeof payload.turn_id !== "string" || !payload.turn_id))
                    throw new Error("invalid turn id");
                const id = payload?.turn_id ?? "";
                if (payload?.type === "task_started")
                    turns.add(id);
                else if (["task_complete", "turn_complete", "turn_completed", "turn_end", "turn_aborted"].includes(payload?.type)) {
                    if (id)
                        turns.delete(id);
                    else if (turns.size === 1)
                        turns.clear();
                }
            }
            const after = fstatSync(fd);
            if (after.size !== stat.size || after.mtimeMs !== stat.mtimeMs)
                throw new Error("rollout changed");
            const open = turns.size > 0;
            this.turns.set(thread, { dev: stat.dev, ino: stat.ino, size: stat.size, mtimeMs: stat.mtimeMs, open });
            return open;
        }
        catch {
            this.turns.delete(thread);
            return false;
        }
        finally {
            if (fd !== undefined)
                closeSync(fd);
        }
    }
    record(store, leases, holder) {
        if (!THREAD.test(holder.session_id))
            return false;
        const thread = holder.session_id.toLowerCase();
        try {
            let path = this.paths.get(thread);
            if (!path) {
                const found = globSync(`sessions/*/*/*/rollout-*-${thread}.jsonl`, { cwd: this.home });
                if (found.length !== 1)
                    return false;
                path = join(this.home, found[0]);
                this.paths.set(thread, path);
            }
            const stat = lstatSync(path), modified = Math.floor(stat.mtimeMs), now = Date.now();
            if (!stat.isFile() || !Number.isSafeInteger(modified) || modified < 0 || modified > now)
                return false;
            // An unmatched start conservatively protects a silent turn until its end is recorded.
            const at = this.openTurn(thread, path, stat) ? now : modified;
            return leases.withHeld(holder.name, holder.token, () => {
                const lease = store.db.prepare("SELECT * FROM identity_leases WHERE name=?").get(holder.name);
                if (lease.cli !== "codex" || lease.session_id !== holder.session_id
                    || lease.holder_pid !== holder.holder_pid || lease.holder_start !== holder.holder_start)
                    return false;
                const activity = parseActivity(store.get(activityKey(holder.name)));
                if (at <= Math.max(lease.claimed_at, activity?.at ?? 0))
                    return false;
                store.set(activityKey(holder.name), JSON.stringify({ at, shared: activity?.shared ?? holder.shared }));
                return true;
            });
        }
        catch {
            this.paths.delete(thread);
            this.turns.delete(thread);
            return false; // Advisory evidence: missing files, lost leases and unknown process evidence write no activity.
        }
    }
}
