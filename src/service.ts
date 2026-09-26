import { createRequire } from "node:module";
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
export function appSourceCandidates(pkgRoot = packageRoot(), env = process.env): string[] {
  return [env.MBX_APP_BUNDLE, join(pkgRoot, "build", APP_NAME), join(pkgRoot, "macos", APP_NAME)].filter((p): p is string => !!p);
}

export function packageRoot(): string { return resolve(dirname(fileURLToPath(import.meta.url)), ".."); }

const isApp = (p: string) => existsSync(join(p, "Contents/MacOS/agentmbx-notify")) && existsSync(join(p, "Contents/MacOS/agentmbx-daemon"));

export function findAppSource(pkgRoot = packageRoot(), env = process.env): string | null {
  return appSourceCandidates(pkgRoot, env).find(isApp) ?? null;
}

/**
 * Copy the app bundle into ~/Applications (ditto keeps the code signature intact) and register it with
 * LaunchServices. Returns the installed path, or null when no bundle is available.
 */
export function installAppBundle(opts: { home?: string; pkgRoot?: string; env?: NodeJS.ProcessEnv; copy?: (src: string, dst: string) => void } = {}): string | null {
  const dst = installedAppPath(opts.home);
  const src = findAppSource(opts.pkgRoot, opts.env);
  if (src && resolve(src) !== resolve(dst)) {
    mkdirSync(dirname(dst), { recursive: true });
    rmSync(dst, { recursive: true, force: true });
    (opts.copy ?? ((s, d) => execFileSync("/usr/bin/ditto", [s, d])))(src, dst);
    try {
      execFileSync("/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister", ["-f", dst], { stdio: "ignore" });
    } catch { /* registration also happens lazily */ }
  }
  return isApp(dst) ? dst : null;
}

const xml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export type LaunchdOpts = { label: string; nodeBin: string; bin: string; mbxHome: string; path: string; app?: string | null };

export function launchdPlist(o: LaunchdOpts): string {
  const args = [...(o.app ? [join(o.app, "Contents/MacOS/agentmbx-daemon")] : []), o.nodeBin, ...(o.bin ? [o.bin] : []), "daemon"];
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

export function systemdUnit(o: { nodeBin: string; bin: string; mbxHome: string }): string {
  return `[Unit]\nDescription=AgentMBX daemon\n\n[Service]\nEnvironment=MBX_HOME=${o.mbxHome}\nExecStart=${[o.nodeBin, o.bin, "daemon"].filter(Boolean).join(" ")}\nRestart=always\n\n[Install]\nWantedBy=default.target\n`;
}

/** A stable node path (mise/asdf/volta shims survive Node upgrades) over the versioned execPath. */
export function stableNode(home = homedir()): string {
  const shims = [join(home, ".local/share/mise/shims/node"), join(home, ".asdf/shims/node"), join(home, ".volta/bin/node")];
  return shims.find((p) => existsSync(p)) ?? process.execPath;
}

export function installService(mbxHome: string): void {
  // a HOME that isn't the account's real home (tests, sandboxes) must never replace the real background job
  const realHome = (() => { try { return execFileSync("/usr/bin/id", ["-P"], { encoding: "utf8" }).split(":")[8] || null; } catch { return null; } })();
  if (process.platform === "darwin" && realHome && resolve(homedir()) !== resolve(realHome) && !process.env.MBX_SERVICE_LABEL)
    throw new Error(`HOME (${homedir()}) is not this account's home (${realHome}); set MBX_SERVICE_LABEL to install a separate test job`);
  // standalone (SEA) binary: the service runs the binary itself; npm/dev: a stable node + the script
  let sea = false; try { sea = (createRequire(import.meta.url)("node:sea") as { isSea(): boolean }).isSea(); } catch { /* older node */ }
  const bin = sea ? "" : realpathSync(process.argv[1]);
  const nodeBin = sea ? realpathSync(process.execPath) : stableNode();
  const home = homedir();
  if (process.platform === "darwin") {
    const label = serviceLabel();
    const app = installAppBundle();
    const plist = join(home, "Library/LaunchAgents", `${label}.plist`);
    mkdirSync(dirname(plist), { recursive: true });
    const path = [join(home, ".local/bin"), join(home, ".local/share/mise/shims"), join(home, ".opencode/bin"), "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"].join(":");
    writeFileSync(plist, launchdPlist({ label, nodeBin, bin, mbxHome, path, app }));
    const target = `gui/${process.getuid!()}`;
    try { execFileSync("launchctl", ["bootout", `${target}/${label}`], { stdio: "ignore" }); } catch { /* not loaded */ }
    // bootout returns before the old job is gone; bootstrapping too early fails with "5: Input/output error"
    const loaded = () => { try { execFileSync("launchctl", ["print", `${target}/${label}`], { stdio: "ignore" }); return true; } catch { return false; } };
    const sleep = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
    for (let i = 0; i < 50 && loaded(); i++) sleep(100);
    for (let attempt = 1; ; attempt++) {
      try { execFileSync("launchctl", ["bootstrap", target, plist], { stdio: ["ignore", "ignore", "pipe"] }); break; }
      catch (e) { if (attempt >= 5 || loaded()) { if (loaded()) break; throw e; } sleep(500 * attempt); }
    }
    console.log(`installed ${plist}; log: ${join(mbxHome, "daemon.log")}`);
    console.log(app ? `app: ${app} (branded notifications; Login Items shows AgentMBX)`
      : "app: AgentMBX.app not found, so notifications use osascript. Build it with scripts/build-macos-app.sh and re-run 'agentmbx daemon install'.");
    return;
  }
  const unit = join(home, ".config/systemd/user/agentmbx.service");
  mkdirSync(dirname(unit), { recursive: true });
  writeFileSync(unit, systemdUnit({ nodeBin, bin, mbxHome }));
  execFileSync("systemctl", ["--user", "daemon-reload"]); execFileSync("systemctl", ["--user", "enable", "--now", "agentmbx.service"]);
  console.log(`installed ${unit}`);
}

export function uninstallService(): void {
  if (process.platform === "darwin") {
    const label = serviceLabel();
    try { execFileSync("launchctl", ["bootout", `gui/${process.getuid!()}/${label}`], { stdio: "ignore" }); } catch { /* not loaded */ }
    // removing the plist also drops the entry from System Settings > Login Items
    rmSync(join(homedir(), "Library/LaunchAgents", `${label}.plist`), { force: true });
    console.log(`stopped and removed ${label}`);
    return;
  }
  execFileSync("systemctl", ["--user", "disable", "--now", "agentmbx.service"]); console.log("stopped");
}
