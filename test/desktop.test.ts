// Service definitions and desktop-notification routing, with temp dirs only (no launchctl, no Swift build).
import { test } from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { APP_BUNDLE_ID, appSourceCandidates, findAppSource, installAppBundle, installedAppPath, launchdPlist, serviceLabel, systemdUnit } from "../src/service.ts";
import { desktopCommands, inboxCommand, macNotifierPath } from "../src/wake.ts";

const tmp = () => mkdtempSync(join(tmpdir(), "mbx-desktop-"));
/** A fake AgentMBX.app with the two executables the code looks for. */
function fakeApp(at: string) {
  mkdirSync(join(at, "Contents/MacOS"), { recursive: true });
  for (const f of ["agentmbx-notify", "agentmbx-daemon"]) writeFileSync(join(at, "Contents/MacOS", f), "#!/bin/sh\n", { mode: 0o755 });
  return at;
}
const base = { label: "com.agentmbx.test", nodeBin: "/opt/node", bin: "/pkg/bin/agentmbx.js", mbxHome: "/home/u/.local/share/agentmbx", path: "/usr/bin:/bin" };

test("launchd plist without the app runs node directly and has no AssociatedBundleIdentifiers", () => {
  const p = launchdPlist({ ...base, app: null });
  assert.match(p, /<key>ProgramArguments<\/key><array><string>\/opt\/node<\/string><string>\/pkg\/bin\/agentmbx.js<\/string><string>daemon<\/string><\/array>/);
  assert.doesNotMatch(p, /AssociatedBundleIdentifiers/);
  assert.match(p, /<key>Label<\/key><string>com.agentmbx.test<\/string>/);
});

test("launchd plist with the app starts through the in-bundle launcher and names the bundle", () => {
  const p = launchdPlist({ ...base, app: "/Users/u/Applications/AgentMBX.app" });
  assert.match(p, new RegExp(`<key>AssociatedBundleIdentifiers</key><array><string>${APP_BUNDLE_ID}</string></array>`));
  assert.match(p, /<array><string>\/Users\/u\/Applications\/AgentMBX.app\/Contents\/MacOS\/agentmbx-daemon<\/string><string>\/opt\/node<\/string><string>\/pkg\/bin\/agentmbx.js<\/string><string>daemon<\/string><\/array>/);
  assert.match(p, /<key>MBX_HOME<\/key><string>\/home\/u\/.local\/share\/agentmbx<\/string>/);
});

test("launchd plist escapes XML in paths", () => {
  const p = launchdPlist({ ...base, bin: "/a&b/<x>.js" });
  assert.match(p, /\/a&amp;b\/&lt;x&gt;.js/);
});

test("systemd unit and label override", () => {
  assert.match(systemdUnit(base), /ExecStart=\/opt\/node \/pkg\/bin\/agentmbx.js daemon/);
  assert.equal(serviceLabel({}), "com.agentmbx.daemon");
  assert.equal(serviceLabel({ MBX_SERVICE_LABEL: "com.agentmbx.test" }), "com.agentmbx.test");
});

test("app bundle discovery and install into ~/Applications", () => {
  const pkg = tmp(), home = tmp();
  assert.equal(findAppSource(pkg, {}), null);
  assert.equal(installAppBundle({ home, pkgRoot: pkg, env: {}, copy: () => assert.fail("nothing to copy") }), null);
  fakeApp(join(pkg, "build/AgentMBX.app"));
  assert.deepEqual(appSourceCandidates(pkg, { MBX_APP_BUNDLE: "/x/AgentMBX.app" })[0], "/x/AgentMBX.app");
  assert.equal(findAppSource(pkg, {}), join(pkg, "build/AgentMBX.app"));
  const copied: string[] = [];
  const got = installAppBundle({ home, pkgRoot: pkg, env: {}, copy: (s, d) => { copied.push(s); cpSync(s, d, { recursive: true }); } });
  assert.equal(got, installedAppPath(home));
  assert.deepEqual(copied, [join(pkg, "build/AgentMBX.app")]);
  // already installed and no source: keeps using the installed copy
  assert.equal(installAppBundle({ home, pkgRoot: tmp(), env: {}, copy: () => assert.fail("no copy") }), installedAppPath(home));
  // a stably signed installed app is never replaced by an ad-hoc local build (the Keychain trusts its signature)
  const installed = installedAppPath(home);
  const signed = (app: string) => app === installed;
  assert.equal(installAppBundle({ home, pkgRoot: pkg, env: {}, signed, copy: () => assert.fail("must keep the signed app") }), installed);
  // …unless the source is explicitly chosen
  const picks: string[] = [];
  installAppBundle({ home, pkgRoot: pkg, env: { MBX_APP_BUNDLE: join(pkg, "build/AgentMBX.app") }, signed, copy: (s2, d) => { picks.push(s2); cpSync(s2, d, { recursive: true }); } });
  assert.equal(picks.length, 1);
});

test("notifier selection: AgentMBX.app first, osascript fallback, notify-send on Linux", () => {
  const home = tmp();
  const note = { subtitle: "planner", body: "2 new messages", openCmd: "agentmbx inbox --as 'planner'" };
  // no app: only osascript
  let cmds = desktopCommands(note, { platform: "darwin", home, env: {} });
  assert.deepEqual(cmds.map((c) => c.file), ["/usr/bin/osascript"]);
  assert.match(cmds[0].args[1], /with title "AgentMBX" subtitle "planner"/);
  // app installed in ~/Applications
  fakeApp(join(home, "Applications/AgentMBX.app"));
  const notifier = join(home, "Applications/AgentMBX.app/Contents/MacOS/agentmbx-notify");
  assert.equal(macNotifierPath(home, {}), notifier);
  cmds = desktopCommands(note, { platform: "darwin", home, env: {} });
  assert.deepEqual(cmds.map((c) => c.file), [notifier, "/usr/bin/osascript"]);
  assert.deepEqual(cmds[0].args, ["--title", "AgentMBX", "--body", "2 new messages", "--subtitle", "planner", "--open-cmd", "agentmbx inbox --as 'planner'"]);
  // explicit override wins
  const other = fakeApp(join(tmp(), "AgentMBX.app"));
  assert.equal(macNotifierPath(home, { MBX_NOTIFIER: join(other, "Contents/MacOS/agentmbx-notify") }), join(other, "Contents/MacOS/agentmbx-notify"));
  // Linux
  cmds = desktopCommands(note, { platform: "linux", home, env: {} });
  assert.deepEqual(cmds, [{ via: "desktop (notify-send)", file: "notify-send", timeout: 5_000, args: ["-a", "AgentMBX", "-i", "mail-message-new", "AgentMBX: planner", "2 new messages"] }]);
});

test("inbox command quotes every part for the shell", () => {
  assert.equal(inboxCommand("planner", "/opt/my node", "/pkg/it's.js"), `'/opt/my node' '/pkg/it'\\''s.js' inbox --as 'planner'`);
});
