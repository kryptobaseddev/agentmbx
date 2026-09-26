// agentmbx-daemon: a signed executable inside AgentMBX.app that the launchd agent starts.
// It only exec()s its arguments (`agentmbx-daemon <node> <agentmbx.js> daemon`), so the running process is
// still Node. Its purpose is attribution: macOS Background Task Management names a legacy launch agent after
// the code in ProgramArguments[0], so pointing that at a binary inside AgentMBX.app (plus the plist's
// AssociatedBundleIdentifiers) lets Login Items show AgentMBX instead of "node".
import Foundation

let args = Array(CommandLine.arguments.dropFirst())
guard let prog = args.first else {
  FileHandle.standardError.write("usage: agentmbx-daemon <program> [args…]\n".data(using: .utf8)!)
  exit(2)
}
var cargs: [UnsafeMutablePointer<CChar>?] = args.map { strdup($0) }
cargs.append(nil)
execv(prog, cargs)
FileHandle.standardError.write("agentmbx-daemon: exec \(prog): \(String(cString: strerror(errno)))\n".data(using: .utf8)!)
exit(127)
