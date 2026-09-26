// agentmbx-auth: keeps the AgentMBX owner key (Ed25519) in the login Keychain and signs with it only after the human
// approves a Touch ID / password prompt. The prompt text is written HERE, from the exact bytes being signed, never from
// argv or the environment, so an agent can start a request but cannot make it say something other than what it does.
//
//   agentmbx-auth pubkey            print the owner public key (base64, raw 32 bytes); exit 3 if there is none. No prompt.
//   agentmbx-auth init              prompt, create the key in the login Keychain, print the public key; exit 4 if one exists
//   agentmbx-auth sign <file>       read canonical JSON from <file>, prompt with a summary of it, print the base64 signature
//   agentmbx-auth summary <file>    print the prompt text `sign` would show (no prompt, no Keychain access)
//   agentmbx-auth delete            prompt, then delete the key (owner reset)
//   agentmbx-auth check             exit 0 if a Touch ID / password prompt can be shown in this session, 9 if not (SSH)
//   agentmbx-auth selftest <file>   sign <file> with a throwaway in-memory key; prints {"pub","sig"} (tests; never the owner key)
//
// The Keychain item (generic password, service "com.agentmbx.owner", account "owner") is created by this binary, so its
// access list trusts only this binary: any other process that asks for it gets a Keychain dialog. The public key is kept
// in the item's attributes, which can be read without unlocking the secret, so `pubkey` never prompts.
//
// Exit codes: 0 ok, 1 error, 2 usage, 3 no owner key, 4 owner key exists, 5 payload refused, 6 approval cancelled or
// failed (or Keychain access denied), 7 Keychain error, 8 payload names a different owner key, 9 no prompt possible in this
// session (SSH, no GUI).
import CryptoKit
import Foundation
import LocalAuthentication
import Security

let service = "com.agentmbx.owner"
let account = "owner"

enum Code: Int32 { case ok = 0, error = 1, usage = 2, noKey = 3, exists = 4, refused = 5, cancelled = 6, keychain = 7, wrongKey = 8, noGUI = 9 }

func die(_ msg: String, _ code: Code) -> Never {
  FileHandle.standardError.write("agentmbx-auth: \(msg)\n".data(using: .utf8)!)
  exit(code.rawValue)
}

// ---- canonical JSON ---------------------------------------------------------------------------------------------
// The same rules as src/crypto.ts canonical(): sorted keys (UTF-16 code unit order, like JS sort), no whitespace,
// JSON.stringify string escaping. `sign` refuses input that is not already in this form, so the object summarized
// is exactly the object signed (no duplicate keys, no alternative encodings).
struct Refusal: Error { let reason: String }

func quote(_ s: String) -> String {
  var out = "\""
  for u in s.unicodeScalars {
    switch u {
    case "\"": out += "\\\""
    case "\\": out += "\\\\"
    case "\u{08}": out += "\\b"
    case "\u{0C}": out += "\\f"
    case "\n": out += "\\n"
    case "\r": out += "\\r"
    case "\t": out += "\\t"
    default:
      if u.value < 0x20 { out += String(format: "\\u%04x", u.value) } else { out.unicodeScalars.append(u) }
    }
  }
  return out + "\""
}

func utf16Less(_ a: String, _ b: String) -> Bool { Array(a.utf16).lexicographicallyPrecedes(Array(b.utf16)) }

func canonical(_ v: Any) throws -> String {
  if v is NSNull { return "null" }
  if let n = v as? NSNumber {
    if CFGetTypeID(n) == CFBooleanGetTypeID() { return n.boolValue ? "true" : "false" }
    let d = n.doubleValue
    guard d.isFinite, d == d.rounded(), abs(d) < 9_007_199_254_740_992 else { throw Refusal(reason: "non-integer number") }
    return String(Int64(d))
  }
  if let s = v as? String { return quote(s) }
  if let a = v as? [Any] { return "[" + (try a.map(canonical)).joined(separator: ",") + "]" }
  if let o = v as? [String: Any] {
    return "{" + (try o.keys.sorted(by: utf16Less).map { "\(quote($0)):\(try canonical(o[$0]!))" }).joined(separator: ",") + "}"
  }
  throw Refusal(reason: "unsupported JSON value")
}

func loadPayload(_ path: String) -> (Data, [String: Any]) {
  guard let data = FileManager.default.contents(atPath: path) else { die("cannot read \(path)", .error) }
  guard let obj = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else { die("refused: not a JSON object", .refused) }
  do {
    guard try canonical(obj).data(using: .utf8) == data else { die("refused: the payload is not canonical JSON", .refused) }
  } catch let r as Refusal { die("refused: \(r.reason)", .refused) } catch { die("refused: \(error)", .refused) }
  return (data, obj)
}

// ---- prompt text ------------------------------------------------------------------------------------------------
/** One display-safe line: control characters, line breaks and bidi overrides become spaces, long values are cut. */
func clean(_ s: String, _ max: Int = 80) -> String {
  var out = ""
  for u in s.unicodeScalars {
    let bidi = (0x202A...0x202E).contains(u.value) || (0x2066...0x2069).contains(u.value) || u.value == 0x200E || u.value == 0x200F
    out.unicodeScalars.append(u.value < 0x20 || u.value == 0x7F || bidi || (0x2028...0x2029).contains(u.value) ? " " : u)
  }
  out = out.split(separator: " ", omittingEmptySubsequences: true).joined(separator: " ")
  return out.count > max ? String(out.prefix(max - 1)) + "…" : out
}

func str(_ v: Any?) -> String? { (v as? String).map { clean($0) } }
/** Security-bearing values (names, hosts, paths) are never shortened: the human must see exactly what is granted. */
func strs(_ v: Any?) -> [String] {
  if let s = v as? String { return [clean(s, 400)] }
  return (v as? [Any] ?? []).compactMap { $0 as? String }.map { clean($0, 400) }
}
/** Every entry, never "and N more"; a wildcard anywhere means ALL and is shown first. */
func list(_ v: Any?, _ empty: String = "(none)") -> String {
  let xs = strs(v)
  if xs.isEmpty { return empty }
  if xs.contains("*") { return "ALL (*)" + (xs.count > 1 ? " [also named: \(xs.filter { $0 != "*" }.joined(separator: ", "))]" : "") }
  return xs.joined(separator: ", ")
}
/** Text too long to read in one confirmation is refused, never cut: split the request instead. */
let maxPromptText = 900
func summarize(_ o: [String: Any]) throws -> String {
  let text = try summarizeRaw(o)
  if text.count > maxPromptText { throw Refusal(reason: "too much to show in one approval (\(text.count) characters); split it into smaller requests") }
  return text
}

func parseDate(_ s: String?) -> Date? {
  guard let s else { return nil }
  let f = ISO8601DateFormatter()
  f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
  if let d = f.date(from: s) { return d }
  f.formatOptions = [.withInternetDateTime]
  return f.date(from: s)
}

func duration(_ o: [String: Any]) throws -> String {
  guard let iat = parseDate(o["iat"] as? String), let exp = parseDate(o["exp"] as? String) else { throw Refusal(reason: "missing iat/exp") }
  let s = exp.timeIntervalSince(iat)
  guard s > 0 else { throw Refusal(reason: "expires before it starts") }
  let plural = { (n: Int, unit: String) in "\(n) \(unit)\(n == 1 ? "" : "s")" }
  if s < 2 * 3600 { return plural(Int((s / 60).rounded()), "minute") }
  if s < 48 * 3600 { return plural(Int((s / 3600).rounded()), "hour") }
  return plural(Int((s / 86400).rounded()), "day")
}

func fingerprint(_ raw: Data) -> String {
  let hex = SHA256.hash(data: raw).map { String(format: "%02x", $0) }.joined().prefix(16)
  return stride(from: 0, to: 16, by: 4).map { i in String(hex.dropFirst(i).prefix(4)) }.joined(separator: "-")
}
func fingerprint(b64: String?) -> String {
  guard let b64, let raw = Data(base64Encoded: b64), raw.count == 32 else { return "?" }
  return fingerprint(raw)
}

/** The owner key fingerprint a payload claims to be signed by (nil when it names none). */
func claimedOwner(_ o: [String: Any]) -> String? {
  if let fp = o["owner_fp"] as? String { return fp }
  if o["v"] as? Int == 2, let iss = o["iss"] as? String { return iss }
  if let a = o["authority"] as? [String: Any], let fp = a["owner_fp"] as? String { return fp }
  return nil
}

/** What the human is asked to approve. Throws Refusal for anything this helper does not understand. */
func summarizeRaw(_ o: [String: Any]) throws -> String {
  let type = o["type"] as? String
  if type == "policy" {
    let level = (o["level"] as? String ?? "custom").uppercased()
    let to = o["to"] as? [String: Any] ?? [:], from = o["from"] as? [String: Any] ?? [:]
    var fromText = list(from["hosts"], "any host")
    if let principals = from["principals"], !strs(principals).isEmpty { fromText += " (people: \(list(principals)))" }
    let fromAgents = strs(from["agents"])
    if !fromAgents.isEmpty && fromAgents != ["*"] { fromText = "\(list(from["agents"])) on \(fromText)" }
    var text = "Allow \(clean(level, 20)) (\(list(o["classes"], "no classes"))) for \(list(to["agents"])) on \(list(to["hosts"])) from \(fromText) for \(try duration(o))"
    if !strs(o["projects"]).isEmpty { text += " in \(list(o["projects"]))" }
    let yolo = level == "YOLO" || strs(o["classes"]).contains("permissions")
    if yolo {
      text = "!!! YOLO MODE !!! Agents will approve their own permission prompts and may push, deploy, delete and spend without asking you.\n" + text
    }
    return text
  }
  if type == "revocation" {
    if o["all"] as? Bool == true || o["revokes"] as? String == "all" { return "Revoke ALL policies (kill switch)" }
    var ids: [String] = []
    for k in ["revokes", "ids", "policy_ids", "policy_id", "policy", "grant_ids", "grant_id", "grant", "target"] { ids += strs(o[k]) }
    guard !ids.isEmpty else { throw Refusal(reason: "revocation names nothing to revoke") }
    let what = o["kind"] as? String == "grant" || o.keys.contains { $0.hasPrefix("grant") } ? "grant" : "policy"
    return "Revoke \(what) \(list(ids))"
  }
  if type == "device" {
    guard let host = str(o["host"]) else { throw Refusal(reason: "device record without host") }
    return "Approve device \(host) (host key \(fingerprint(b64: o["host_pub"] as? String))) as one of your machines"
  }
  if type == "member" {
    guard let role = str(o["role"]) else { throw Refusal(reason: "member record without role") }
    let label = str(o["label"]) ?? str(o["name"]) ?? "someone"
    let key = o["owner_pub"] as? String ?? o["pub"] as? String ?? o["principal_pub"] as? String
    return "Add \(role) \(label) (owner key \(fingerprint(b64: key))) to your AgentMBX"
  }
  if type != nil { throw Refusal(reason: "unknown record type \(clean(type!, 40))") }
  // owner grant (src/envelope.ts Grant without sig)
  if o["v"] as? Int == 2, let sub = o["sub"] as? String, sub.hasPrefix("session:"), let agent = str(o["agent"]), let host = str(o["host"]) {
    return "Grant OWNER authority (\(list(o["caps"], "no caps"))) to \(agent)@\(host), session \(fingerprint(b64: String(sub.dropFirst(8)))), for \(try duration(o))"
  }
  // owner-signed message envelope (src/envelope.ts ownerPayload)
  if o["v"] as? Int == 3, let a = o["authority"] as? [String: Any], a["owner_fp"] is String, o["subject"] is String {
    let kind = o["kind"] as? String ?? "message"
    return "Send as owner to \(list(o["to"])): \(clean(o["subject"] as! String, 120))\(kind == "message" ? "" : " (\(clean(kind, 20)))")"
  }
  throw Refusal(reason: "unrecognized payload")
}

// ---- LocalAuthentication ----------------------------------------------------------------------------------------
final class Outcome: @unchecked Sendable { var ok = false; var error: Error? }

/** Can a prompt appear in front of a person right now? Over SSH (or with no login window session) the caller's security
 *  session has no graphic access, and a prompt would either fail or pop up on an unattended console, so fail fast. */
func requirePromptable() -> LAContext {
  var sid = SecuritySessionId(), attrs = SessionAttributeBits()
  if SessionGetInfo(callerSecuritySession, &sid, &attrs) == errSessionSuccess, !attrs.contains(.sessionHasGraphicAccess) {
    die("no GUI session here (SSH or a background session), so the Touch ID / password prompt can't be shown. Run this at the Mac, or use the passphrase backend (agentmbx owner init --backend file)", .noGUI)
  }
  let ctx = LAContext()
  var err: NSError?
  // .deviceOwnerAuthentication = Touch ID when available, else the account password (Mac minis, VMs)
  guard ctx.canEvaluatePolicy(.deviceOwnerAuthentication, error: &err) else {
    die("no Touch ID or password authentication available: \(err?.localizedDescription ?? "unknown")", .noGUI)
  }
  return ctx
}

func approve(_ reason: String) {
  let ctx = requirePromptable()
  let sem = DispatchSemaphore(value: 0), out = Outcome()
  ctx.evaluatePolicy(.deviceOwnerAuthentication, localizedReason: reason) { ok, e in out.ok = ok; out.error = e; sem.signal() }
  sem.wait()
  guard out.ok else { die("not approved (\(out.error?.localizedDescription ?? "cancelled"))", .cancelled) }
}

// ---- Keychain ---------------------------------------------------------------------------------------------------
func baseQuery() -> [String: Any] {
  [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: account]
}

func keychainError(_ st: OSStatus) -> String { (SecCopyErrorMessageString(st, nil) as String?) ?? "OSStatus \(st)" }

/** A Keychain failure. Denying the Keychain's "allow access" dialog is the human saying no, so it exits like a cancel. */
func keychainDie(_ st: OSStatus) -> Never {
  if st == errSecUserCanceled || st == errSecAuthFailed {
    die("Keychain access was denied (\(keychainError(st))). After updating an ad-hoc signed AgentMBX.app, choose Always Allow for agentmbx-auth", .cancelled)
  }
  if st == errSecInteractionNotAllowed { die("the login Keychain is locked and can't be unlocked from this session (SSH?)", .noGUI) }
  die("Keychain: \(keychainError(st))", .keychain)
}

/** The owner public key from the item's attributes (no secret access, no prompt). */
func storedPublicKey() -> Data? {
  var q = baseQuery()
  q[kSecReturnAttributes as String] = true
  q[kSecMatchLimit as String] = kSecMatchLimitOne
  var out: CFTypeRef?
  let st = SecItemCopyMatching(q as CFDictionary, &out)
  if st == errSecItemNotFound { return nil }
  guard st == errSecSuccess, let attrs = out as? [String: Any] else { keychainDie(st) }
  guard let pub = attrs[kSecAttrGeneric as String] as? Data, pub.count == 32 else { die("Keychain item \(service) has no public key attribute", .keychain) }
  return pub
}

func privateKey() -> Curve25519.Signing.PrivateKey {
  var q = baseQuery()
  q[kSecReturnData as String] = true
  q[kSecMatchLimit as String] = kSecMatchLimitOne
  var out: CFTypeRef?
  let st = SecItemCopyMatching(q as CFDictionary, &out)
  if st == errSecItemNotFound { die("no owner key in the Keychain", .noKey) }
  guard st == errSecSuccess, let raw = out as? Data else { keychainDie(st) }
  guard let key = try? Curve25519.Signing.PrivateKey(rawRepresentation: raw) else { die("Keychain item \(service) is not an Ed25519 key", .keychain) }
  return key
}

// ---- commands ---------------------------------------------------------------------------------------------------
let argv = Array(CommandLine.arguments.dropFirst())
let cmd = argv.first ?? ""
func fileArg() -> String {
  guard argv.count == 2 else { die("usage: agentmbx-auth \(cmd) <file>", .usage) }
  return argv[1]
}

switch cmd {
case "pubkey":
  guard argv.count == 1 else { die("usage: agentmbx-auth pubkey", .usage) }
  guard let pub = storedPublicKey() else { die("no owner key in the Keychain", .noKey) }
  print(pub.base64EncodedString())

case "init":
  guard argv.count == 1 else { die("usage: agentmbx-auth init", .usage) }
  if storedPublicKey() != nil { die("an owner key already exists in the Keychain (agentmbx-auth pubkey shows it)", .exists) }
  approve("create your AgentMBX owner key")
  let key = Curve25519.Signing.PrivateKey()
  let pub = key.publicKey.rawRepresentation
  var add = baseQuery()
  add[kSecValueData as String] = key.rawRepresentation
  add[kSecAttrGeneric as String] = pub
  add[kSecAttrLabel as String] = "AgentMBX owner key"
  add[kSecAttrDescription as String] = "AgentMBX owner key"
  add[kSecAttrComment as String] = "AgentMBX owner public key \(pub.base64EncodedString()) (fingerprint \(fingerprint(pub))). Only agentmbx-auth should read this item."
  let st = SecItemAdd(add as CFDictionary, nil)
  if st == errSecDuplicateItem { die("an owner key already exists in the Keychain", .exists) }
  guard st == errSecSuccess else { keychainDie(st) }
  print(pub.base64EncodedString())

case "check":
  // can a prompt be shown in this session? No prompt, no Keychain access. Exit 0, or 9 with the reason.
  guard argv.count == 1 else { die("usage: agentmbx-auth check", .usage) }
  _ = requirePromptable()
  print("ok")

case "summary":
  let (_, obj) = loadPayload(fileArg())
  do { print(try summarize(obj)) } catch let r as Refusal { die("refused: \(r.reason)", .refused) }

case "sign":
  let (data, obj) = loadPayload(fileArg())
  let text: String
  do { text = try summarize(obj) } catch let r as Refusal { die("refused: \(r.reason)", .refused) } catch { die("refused: \(error)", .refused) }
  guard let pub = storedPublicKey() else { die("no owner key in the Keychain", .noKey) }
  if let claimed = claimedOwner(obj), claimed != fingerprint(pub) {
    die("refused: the payload names owner key \(clean(claimed, 40)), but this Keychain holds \(fingerprint(pub))", .wrongKey)
  }
  approve(text)
  let key = privateKey()
  guard key.publicKey.rawRepresentation == pub else { die("Keychain item \(service) is inconsistent (public key mismatch)", .keychain) }
  guard let sig = try? key.signature(for: data) else { die("signing failed", .error) }
  print(sig.base64EncodedString())

case "delete":
  guard argv.count == 1 else { die("usage: agentmbx-auth delete", .usage) }
  guard let pub = storedPublicKey() else { die("no owner key in the Keychain", .noKey) }
  approve("DELETE your AgentMBX owner key \(fingerprint(pub)). Policies and grants it signed stop being renewable")
  let st = SecItemDelete(baseQuery() as CFDictionary)
  guard st == errSecSuccess else { keychainDie(st) }
  print("deleted owner key \(fingerprint(pub))")

case "selftest":
  guard let data = FileManager.default.contents(atPath: fileArg()) else { die("cannot read \(argv[1])", .error) }
  let key = Curve25519.Signing.PrivateKey()
  guard let sig = try? key.signature(for: data) else { die("signing failed", .error) }
  print("{\"pub\":\"\(key.publicKey.rawRepresentation.base64EncodedString())\",\"sig\":\"\(sig.base64EncodedString())\"}")

default:
  die("usage: agentmbx-auth pubkey | init | sign <file> | summary <file> | check | delete", .usage)
}
