# Changelog

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
