// Background service install: a launchd agent on macOS, a systemd --user unit on Linux.
// On macOS the daemon is started through AgentMBX.app/Contents/MacOS/agentmbx-daemon (which exec()s Node) and the
// plist names the app in AssociatedBundleIdentifiers, so Login Items / the "Background Items Added" alert can show
// AgentMBX instead of "node". Without the app bundle the plist falls back to running Node directly.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
export const APP_BUNDLE_ID = "com.agentmbx.app";
export const APP_NAME = "AgentMBX.app";
export const serviceLabel = (env = process.env) => env.MBX_SERVICE_LABEL || "com.agentmbx.daemon";
/** Installed app location (per user, no admin rights needed). */
export const installedAppPath = (home = homedir()) => join(home, "Applications", APP_NAME);
/** Where a freshly built or packaged AgentMBX.app can be found, in order of preference. */
export function appSourceCandidates(pkgRoot = packageRoot(), env = process.env) {
    return [env.MBX_APP_BUNDLE, join(pkgRoot, "build", APP_NAME), join(pkgRoot, "macos", APP_NAME)].filter((p) => !!p);
}
export function packageRoot() { return resolve(dirname(fileURLToPath(import.meta.url)), ".."); }
const isApp = (p) => existsSync(join(p, "Contents/MacOS/agentmbx-notify")) && existsSync(join(p, "Contents/MacOS/agentmbx-daemon"));
export function findAppSource(pkgRoot = packageRoot(), env = process.env) {
    return appSourceCandidates(pkgRoot, env).find(isApp) ?? null;
}
/**
 * Copy the app bundle into ~/Applications (ditto keeps the code signature intact) and register it with
 * LaunchServices. Returns the installed path, or null when no bundle is available.
 */
export function installAppBundle(opts = {}) {
    const dst = installedAppPath(opts.home);
    const src = findAppSource(opts.pkgRoot, opts.env);
    if (src && resolve(src) !== resolve(dst)) {
        mkdirSync(dirname(dst), { recursive: true });
        rmSync(dst, { recursive: true, force: true });
        (opts.copy ?? ((s, d) => execFileSync("/usr/bin/ditto", [s, d])))(src, dst);
        try {
            execFileSync("/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister", ["-f", dst], { stdio: "ignore" });
        }
        catch { /* registration also happens lazily */ }
    }
    return isApp(dst) ? dst : null;
}
const xml = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
export function launchdPlist(o) {
    const args = [...(o.app ? [join(o.app, "Contents/MacOS/agentmbx-daemon")] : []), o.nodeBin, o.bin, "daemon"];
    const log = join(o.mbxHome, "daemon.log");
    return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${xml(o.label)}</string>
  <key>ProgramArguments</key><array>${args.map((a) => `<string>${xml(a)}</string>`).join("")}</array>
${o.app ? `  <key>AssociatedBundleIdentifiers</key><array><string>${APP_BUNDLE_ID}</string></array>\n` : ""}\
  <key>EnvironmentVariables</key><dict><key>MBX_HOME</key><string>${xml(o.mbxHome)}</string><key>PATH</key><string>${xml(o.path)}</string></dict>
  <key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${xml(log)}</string><key>StandardErrorPath</key><string>${xml(log)}</string>
</dict></plist>
`;
}
export function systemdUnit(o) {
    return `[Unit]\nDescription=AgentMBX daemon\n\n[Service]\nEnvironment=MBX_HOME=${o.mbxHome}\nExecStart=${o.nodeBin} ${o.bin} daemon\nRestart=always\n\n[Install]\nWantedBy=default.target\n`;
}
/** A stable node path (mise/asdf/volta shims survive Node upgrades) over the versioned execPath. */
export function stableNode(home = homedir()) {
    const shims = [join(home, ".local/share/mise/shims/node"), join(home, ".asdf/shims/node"), join(home, ".volta/bin/node")];
    return shims.find((p) => existsSync(p)) ?? process.execPath;
}
export function installService(mbxHome) {
    const bin = realpathSync(process.argv[1]);
    const nodeBin = stableNode();
    const home = homedir();
    if (process.platform === "darwin") {
        const label = serviceLabel();
        const app = installAppBundle();
        const plist = join(home, "Library/LaunchAgents", `${label}.plist`);
        mkdirSync(dirname(plist), { recursive: true });
        const path = [join(home, ".local/bin"), join(home, ".local/share/mise/shims"), join(home, ".opencode/bin"), "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"].join(":");
        writeFileSync(plist, launchdPlist({ label, nodeBin, bin, mbxHome, path, app }));
        const target = `gui/${process.getuid()}`;
        try {
            execFileSync("launchctl", ["bootout", `${target}/${label}`], { stdio: "ignore" });
        }
        catch { /* not loaded */ }
        execFileSync("launchctl", ["bootstrap", target, plist]);
        console.log(`installed ${plist}; log: ${join(mbxHome, "daemon.log")}`);
        console.log(app ? `app: ${app} (branded notifications; Login Items shows AgentMBX)`
            : "app: AgentMBX.app not found, so notifications use osascript. Build it with scripts/build-macos-app.sh and re-run 'agentmbx daemon install'.");
        return;
    }
    const unit = join(home, ".config/systemd/user/agentmbx.service");
    mkdirSync(dirname(unit), { recursive: true });
    writeFileSync(unit, systemdUnit({ nodeBin, bin, mbxHome }));
    execFileSync("systemctl", ["--user", "daemon-reload"]);
    execFileSync("systemctl", ["--user", "enable", "--now", "agentmbx.service"]);
    console.log(`installed ${unit}`);
}
export function uninstallService() {
    if (process.platform === "darwin") {
        const label = serviceLabel();
        try {
            execFileSync("launchctl", ["bootout", `gui/${process.getuid()}/${label}`], { stdio: "ignore" });
        }
        catch { /* not loaded */ }
        // removing the plist also drops the entry from System Settings > Login Items
        rmSync(join(homedir(), "Library/LaunchAgents", `${label}.plist`), { force: true });
        console.log(`stopped and removed ${label}`);
        return;
    }
    execFileSync("systemctl", ["--user", "disable", "--now", "agentmbx.service"]);
    console.log("stopped");
}
