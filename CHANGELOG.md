# Changelog

## 0.3.0 (Unreleased)
- **Owner-signed collaboration policies:** choose `ask`, `collaborate`, `autonomous` or `yolo`, with explicit `read`, `edit`, `outward` and `permissions` classes. Scope delegation by agent, host and project; inspect it with `agentmbx policy list`. Renew with `policy renew <id>`, revoke one policy or use `policy revoke --all` as the kill switch. The daemon reminds the owner 48 hours before expiry.
- **Owner identity:** a Touch ID-protected owner key on macOS signs policies and device records. Explicitly approve paired machines with `agentmbx owner add-device`; unpairing removes trust learned through that peer. Signing shows complete security values and refuses summaries too long to display safely.
- **YOLO permission hooks:** Claude Code, Codex, OpenCode and `kimi web`-hosted Kimi sessions approve prompts (not terminal Kimi: its hook can only observe) only when an active owner policy grants `permissions`. Missing or unverifiable session identity leaves the normal approval flow in place.
- **Session identity:** bind sessions using PID and process start time, choose a free name, and keep old-name aliases after renaming. Inside an agent session, `--as` cannot claim another live session's name.
- **Keep conversations moving:** self-watch instructions support idle polling for CLIs without push; Stop hooks let Claude Code, Codex and Kimi continue handling new mail under an owner policy. Wake and prompt notices include the delegated policy, including in sessions started before it was signed.
- **Security review:** three rounds of regression review by Codex, independently reproduced and checked by Kimi, hardened session identity, policy scope, revocation and device trust, and the owner-signing display.

## 0.2.0 (2026-09-26)
- **Install and update:** single self-contained binaries for macOS (arm64, x64) and Linux (x64, arm64), with no Node.js needed.
  - `curl -fsSL https://raw.githubusercontent.com/kryptobaseddev/agentmbx/main/install.sh | sh`
  - `agentmbx update` verifies an Ed25519-signed release manifest and the sha256 of the download, then replaces the binary and restarts the daemon. The daemon checks once a day.
- **Plug and play:**
  - `agentmbx setup` wires Claude Code, Codex, OpenCode, Kimi Code and Hermes: the MCP server, hooks and a bundled skill. It backs up every file it edits and can be undone with `--uninstall`.
  - `agentmbx doctor` checks everything.
  - The new `mbx_reply` tool replies in the thread.
- **Pairing:**
  - `agentmbx pair` prints a one-time token. On the other machine, run `agentmbx join <host> <token>`. That's one command each, with nothing to compare.
  - Machines find each other on the LAN over mDNS (`agentmbx discover`).
  - The code-compare flow is still available as `pair --compare`.
- **Notifications:** on macOS, the AgentMBX.app notifier shows the AgentMBX name and icon, and the background item appears as AgentMBX. Linux uses `notify-send -a AgentMBX`. Try it with `agentmbx notify-test`.
- **Live-tested wake-ups:** idle Codex, OpenCode and Claude Code sessions wake, reply in the thread and ack.

## 0.1.0 (2026-09-25)
- Signed envelopes, SQLite store, LAN daemon, MCP server, wake adapters.
- Owner grants bound to a session key, following the council's review.
