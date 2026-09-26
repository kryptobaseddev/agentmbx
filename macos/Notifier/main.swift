// agentmbx-notify: the main executable of AgentMBX.app. It posts one branded notification through
// UNUserNotificationCenter and exits, so notifications show "AgentMBX" and its icon instead of Script Editor.
//
//   agentmbx-notify --title T --body B [--subtitle S] [--id ID] [--open-cmd "<shell command>"]
//   agentmbx-notify --status             (print authorization state and alert style)
//   agentmbx-notify                      (no arguments: ask for permission if needed, handle a click, quit)
//
// Click handling: the --open-cmd travels inside the notification's userInfo. If the user clicks the
// notification while this process is still alive, the delegate below runs it; otherwise macOS relaunches
// AgentMBX.app (no arguments) and delivers the click to the same delegate, which runs the command from
// userInfo and quits. The command runs in a new Terminal window (a temporary .command file), so
// `agentmbx inbox --as <agent>` output stays visible.
//
// Exit codes: 0 posted, 1 error, 2 bad arguments, 3 notifications turned off for AgentMBX.
import AppKit
import UserNotifications

setvbuf(stdout, nil, _IONBF, 0)

struct Options {
  var title = "AgentMBX", body = "", subtitle: String?, id: String?, openCmd: String?
  var post = false, status = false
}

func parse(_ argv: [String]) -> Options? {
  var o = Options(), i = 0
  while i < argv.count {
    let k = argv[i]
    // LaunchServices may add -psn_… or -NS… arguments on relaunch; ignore anything we don't know
    if k == "--status" { o.status = true; i += 1; continue }
    guard ["--title", "--body", "--subtitle", "--id", "--open-cmd"].contains(k) else { i += 1; continue }
    guard i + 1 < argv.count else { return nil }
    let v = argv[i + 1]
    switch k {
    case "--title": o.title = v; o.post = true
    case "--body": o.body = v; o.post = true
    case "--subtitle": o.subtitle = v
    case "--id": o.id = v
    default: o.openCmd = v
    }
    i += 2
  }
  return o
}

/** Run a shell command in a new Terminal window via a throwaway .command file. */
func runInTerminal(_ cmd: String) {
  let dir = FileManager.default.temporaryDirectory.appendingPathComponent("agentmbx", isDirectory: true)
  try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
  let file = dir.appendingPathComponent("open-\(UUID().uuidString).command")
  let script = "#!/bin/zsh -l\nrm -f \"$0\"\n\(cmd)\necho\nexec \"${SHELL:-/bin/zsh}\" -l\n"
  do {
    try script.write(to: file, atomically: true, encoding: .utf8)
    try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: file.path)
    let p = Process()
    p.executableURL = URL(fileURLWithPath: "/usr/bin/open")
    p.arguments = ["-a", "Terminal", file.path]
    try p.run(); p.waitUntilExit()
  } catch { FileHandle.standardError.write("agentmbx-notify: could not open Terminal: \(error)\n".data(using: .utf8)!) }
}

final class Delegate: NSObject, NSApplicationDelegate, UNUserNotificationCenterDelegate {
  let opts: Options
  var handledClick = false
  init(_ o: Options) { opts = o }

  func applicationWillFinishLaunching(_ n: Notification) {
    // must be set before launch finishes, or a click that relaunched us is not delivered
    UNUserNotificationCenter.current().delegate = self
  }

  func applicationDidFinishLaunching(_ n: Notification) {
    if opts.status { printStatus(); return }
    authorize { granted in
      guard granted else {
        FileHandle.standardError.write("agentmbx-notify: notifications for AgentMBX are turned off (System Settings > Notifications > AgentMBX)\n".data(using: .utf8)!)
        self.quit(3); return
      }
      if self.opts.post { self.post() }
      else {
        // launched by a click (or by hand): give macOS a moment to deliver the response, then quit
        DispatchQueue.main.asyncAfter(deadline: .now() + 5) { if !self.handledClick { self.quit(0) } }
      }
    }
  }

  /** `--status`: print the authorization state and alert style without asking for anything. */
  func printStatus() {
    UNUserNotificationCenter.current().getNotificationSettings { s in
      let auth = [UNAuthorizationStatus.notDetermined: "not-determined", .denied: "denied", .authorized: "authorized",
                  .provisional: "provisional"][s.authorizationStatus] ?? "unknown"
      let style = [UNAlertStyle.none: "none", .banner: "banner", .alert: "alert"][s.alertStyle] ?? "unknown"
      print("authorization=\(auth) alertStyle=\(style) sound=\(s.soundSetting == .enabled)")
      DispatchQueue.main.async { self.quit(0) }
    }
  }

  func authorize(_ done: @escaping (Bool) -> Void) {
    let c = UNUserNotificationCenter.current()
    c.getNotificationSettings { s in
      switch s.authorizationStatus {
      case .authorized, .provisional: DispatchQueue.main.async { done(true) }
      case .denied: DispatchQueue.main.async { done(false) }
      default:
        // first run: macOS shows the "AgentMBX would like to send you notifications" prompt
        c.requestAuthorization(options: [.alert, .sound]) { ok, err in
          if let err { FileHandle.standardError.write("agentmbx-notify: authorization: \(err.localizedDescription)\n".data(using: .utf8)!) }
          DispatchQueue.main.async { done(ok) }
        }
      }
    }
  }

  func post() {
    let content = UNMutableNotificationContent()
    content.title = opts.title
    content.body = opts.body
    if let s = opts.subtitle { content.subtitle = s; content.threadIdentifier = s }
    content.sound = .default
    if let cmd = opts.openCmd { content.userInfo = ["openCmd": cmd] }
    let id = opts.id ?? UUID().uuidString
    let c = UNUserNotificationCenter.current()
    c.add(UNNotificationRequest(identifier: id, content: content, trigger: nil)) { err in
      if let err {
        FileHandle.standardError.write("agentmbx-notify: \(err.localizedDescription)\n".data(using: .utf8)!)
        DispatchQueue.main.async { self.quit(1) }
        return
      }
      // wait until Notification Center lists it (or give up after ~2 s), then exit
      self.waitDelivered(id, tries: 20)
    }
  }

  func waitDelivered(_ id: String, tries: Int) {
    UNUserNotificationCenter.current().getDeliveredNotifications { list in
      DispatchQueue.main.async {
        if list.contains(where: { $0.request.identifier == id }) { print("delivered \(id)"); self.quit(0) }
        else if tries <= 0 { print("posted \(id) (not listed as delivered; check Focus / notification style)"); self.quit(0) }
        else { DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) { self.waitDelivered(id, tries: tries - 1) } }
      }
    }
  }

  // show banners even if AgentMBX happens to be frontmost
  func userNotificationCenter(_ c: UNUserNotificationCenter, willPresent n: UNNotification,
                              withCompletionHandler done: @escaping (UNNotificationPresentationOptions) -> Void) {
    done([.banner, .list, .sound])
  }

  func userNotificationCenter(_ c: UNUserNotificationCenter, didReceive r: UNNotificationResponse,
                              withCompletionHandler done: @escaping () -> Void) {
    handledClick = true
    if r.actionIdentifier == UNNotificationDefaultActionIdentifier,
       let cmd = r.notification.request.content.userInfo["openCmd"] as? String, !cmd.isEmpty {
      runInTerminal(cmd)
    }
    done()
    quit(0)
  }

  func quit(_ code: Int32) { exit(code) }
}

guard let opts = parse(Array(CommandLine.arguments.dropFirst())) else {
  FileHandle.standardError.write("usage: agentmbx-notify --title T --body B [--subtitle S] [--id ID] [--open-cmd CMD]\n".data(using: .utf8)!)
  exit(2)
}
let app = NSApplication.shared
app.setActivationPolicy(.accessory)
let delegate = Delegate(opts)
app.delegate = delegate
// hard stop so a stuck permission prompt never leaves the process around forever
DispatchQueue.main.asyncAfter(deadline: .now() + 120) { exit(1) }
app.run()
