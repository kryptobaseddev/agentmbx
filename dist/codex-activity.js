import { globSync, lstatSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { activityKey, parseActivity } from "./identity-availability.js";
const THREAD = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
/** Metadata-only activity for the existing MCP heartbeat; never opens a rollout or starts a process. */
export class CodexActivity {
    home;
    paths = new Map();
    constructor(home = process.env.CODEX_HOME || join(homedir(), ".codex")) { this.home = home; }
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
            const stat = lstatSync(path), at = Math.floor(stat.mtimeMs);
            if (!stat.isFile() || !Number.isSafeInteger(at) || at < 0 || at > Date.now())
                return false;
            // shortcut: rollout writes show activity, but a silent turn remains invisible; use native thread status when available.
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
            return false; // Advisory evidence: missing files, lost leases and unknown process evidence write no activity.
        }
    }
}
