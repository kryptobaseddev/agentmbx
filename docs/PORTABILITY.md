# Portability: does each step work for any user?

AgentMBX must work the same on anyone's machine, with no fixes that only work on the developer's Mac. This file goes through every step of the path from install to autonomous collaboration. For each step it records:
- what the step depends on;
- what has been verified, and where;
- what's still open, with its CLEO task.

Update it whenever a step changes.

Legend: ✅ verified, 🟡 works with a documented limit, ❌ gap (tracked).

## 1. Install

| Step | macOS | Linux | Notes |
|---|---|---|---|
| `curl …/install.sh \| sh` gives a single binary, sha256-checked | ✅ darwin-arm64/x64 | ✅ linux-x64/arm64 (built in CI) | No Node needed. Windows isn't supported. |
| AgentMBX.app (notifier, launcher, `agentmbx-auth`) | ✅ built in CI, installed to `~/Applications` | n/a | Built universal (arm64 + x86_64). |
| App signing | 🟡 ad-hoc by default | n/a | With ad-hoc signing, the Keychain asks once ("Always Allow") after each update. Fix: set the `MBX_CODESIGN_P12` release secret (a stable self-signed identity), **owner action, T056**. |
| Daemon service | ✅ launchd (with bootout/bootstrap retry) | ✅ systemd `--user` | A HOME that isn't the account's real home refuses to replace the real job. |
| `agentmbx update` | ✅ signed manifest plus sha256 | ✅ | |
| Dev installs (`npm link`, mise shims) | ✅ | ✅ | setup writes the resolved absolute path, and prefers a shim. |

## 2. Wiring agent CLIs (`agentmbx setup`)

| CLI | MCP | Hooks | Wake an idle session | Keep going on mail mid-turn | YOLO approvals |
|---|---|---|---|---|---|
| Claude Code | ✅ | ✅ SessionStart, UserPromptSubmit, PermissionRequest, Stop | ✅ push: the session's own mbx server posts the hint through `CLAUDE_CODE_MESSAGING_SOCKET` (no flag needed, T202); `agentmbx claude` adds the research-preview channel | ✅ Stop `{decision:block}` | ✅ `PermissionRequest` |
| Codex | ✅ | ✅ same four (Codex asks to trust new hooks once) | ✅ `codex queue` (needs a codex that has `queue`) | ✅ same Stop schema (verified in 0.157.1) | ✅ `PermissionRequest` (0.157.1) |
| OpenCode | ✅ | none | ✅ service API (`opencode service` must run) | n/a | ✅ daemon answers via the service API |
| Kimi Code (terminal) | ✅ (MCP server instructions don't reach the model: guidance ships in the skill and hook notes) | ✅ SessionStart, UserPromptSubmit, PermissionRequest, Stop | ✅ a background `agentmbx watch` task the session keeps running exits with the no-body hint and starts the next turn (T033); `[mbx-watch]` cron self-check remains the `MBX_SELF_WATCH` fallback | ✅ Stop hook, exit 2 + reason on stderr (verified by kimi) | ❌ unsupported: Kimi's PermissionRequest hook is observation-only. Use `kimi --yolo` yourself |
| Kimi (`kimi web` / desktop / `kimi rc`) | ✅ | ✅ (hooks run per hosted session) | ✅ desktop: control-socket `conversations.send` after a busy check; `kimi web` / `kimi rc`: prompts API, waits while busy, sends the default model when the session has none; each conversation links itself with its bind ticket first (T033, verified live) | ✅ Stop hook | ✅ approvals API |
| Hermes | ✅ | none | ❌ cron now, plugin planned | ❌ | ❌ |
| Anything else with MCP | ✅ (manual config) | none | desktop notification | none | none |

Rules that keep this portable:
- Setup only appends its own hook groups and never edits other tools' groups (Orca and others).
- Every file setup edits is backed up first.
- `--uninstall` removes exactly what setup added.

## 3. Owner identity

| Step | macOS | Linux / SSH |
|---|---|---|
| Owner key | ✅ Keychain via `agentmbx-auth`; every signature needs Touch ID or the account password. An agent can run `owner init`, and the human approves. | 🟡 passphrase file, unlocked on `/dev/tty` (proves someone knows the passphrase, not that a human is present) |
| Macs without Touch ID | ✅ account-password prompt | n/a |
| No GUI session (SSH) | ✅ the helper exits right away, and setup prints the command instead of waiting | ✅ |
| Second machine | ✅ pair, then on the owner machine `agentmbx owner add-device <host>` (one Touch ID tap): a signed device record | ✅ same (passphrase on the owner machine) |
| Accounts, members, cloud | spec only (docs/POLICY.md §7, T053, T007) | |

## 4. Policy and collaboration

| Step | Status |
|---|---|
| `setup` asks how much agents may do; `--policy <level>` answers up front; each choice is signed with one Touch ID tap or passphrase | ✅ |
| Policy reaches paired machines (push now, pull every minute) | ✅ tested over real HTTP, cross-machine test pending (T020/T021) |
| Kill switch `policy revoke --all` | ✅ also beats a stale policy that arrives later |
| Policy expiry | 🟡 each policy expires (collaborate 30 days from setup, yolo 8 h). `policy renew`. No reminder before expiry yet (T057) |
| Agents act under the policy | ⏳ needs the first owner-signed policy on this Mac, then a live check with codex, kimi and claude (T048) |

## 5. Known limits that are by design

- Agents on the same machine share the OS user boundary. A policy limits what agents *choose* to do; it can't sandbox them.
- A CLI that has no hook or API for something (a Kimi terminal session's permission prompts, for example) keeps its own behaviour. AgentMBX documents the CLI's own flag instead of patching the CLI.
