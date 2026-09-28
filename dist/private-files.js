import { chmodSync, lstatSync } from "node:fs";
/** Enforce POSIX permissions on mailbox-owned paths, never on a symlink target. */
export function privatePath(path, mode, optional = false, warn = true) {
    if (process.platform === "win32")
        return; // POSIX mode bits do not establish a Windows ACL.
    let st;
    try {
        st = lstatSync(path);
    }
    catch (e) {
        if (optional && e.code === "ENOENT")
            return;
        throw e;
    }
    if (st.isSymbolicLink() || (mode === 0o700 ? !st.isDirectory() : !st.isFile()))
        throw new Error(`refusing non-${mode === 0o700 ? "directory" : "regular file"} mailbox path: ${path}`);
    const before = st.mode & 0o7777;
    if (before === mode)
        return;
    // Permission failures must stop startup, not silently leave sensitive files exposed.
    chmodSync(path, mode);
    if ((lstatSync(path).mode & 0o7777) !== mode)
        throw new Error(`could not enforce private permissions on ${path}`);
    if (warn)
        process.stderr.write(`[agentmbx] repaired permission drift: ${path} (${before.toString(8)} -> ${mode.toString(8)})\n`);
}
