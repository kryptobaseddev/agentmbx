# Testing

## Automated (`npm test`)
30 tests, runs in about ten seconds, and needs no network or model (the mDNS test uses loopback multicast and skips itself if that is blocked):

| File | What it covers |
|---|---|
| `test/envelope.test.ts` | canonical JSON, ULIDs, signatures and tamper detection, the body metadata parser, size limits |
| `test/trust.test.ts` | the council's four trust tests, plus forged, expired and revoked grants, spoofing, local delivery, the wake brake, and the owner-key file |
| `test/lan.test.ts` | two hosts over real HTTP: pairing code on both sides, approval, both directions, directory sync, an offline peer catching up, stale or forged hops rejected |
| `test/pair.test.ts` | token pairing both ways with messages flowing; wrong token (burned after 5), expired, reused, replayed hello, tampered transcript (owner key, host key, name, addr, rewritten hello), a fake token holder; SAS still works; mDNS TXT round-trip and a loopback advertise + browse |
| `test/mcp.test.ts` | the real MCP client over stdio: every tool, framing, idempotency, and the Claude channel push (without the message body) |

The four trust tests come from the council's review:
1. A grant used by a non-master session carries no authority.
2. An envelope retried after 11 minutes or 3 days is stored exactly once.
3. Swapping an owner key changes the pairing code.
4. A message outside its caps arrives with `authority: none`.

## Live wake-ups (`scripts/e2e/`)
These drive real CLIs against a throwaway `MBX_HOME` and scratch folder. They spend a few model calls and change no user config.
- `wake-codex.py`: creates a Codex thread, opens the real TUI on it in a pty, sends a request, and wakes it through `codex queue`. It then waits for a reply sent through the `mbx` tools. Codex needs `default_tools_approval_mode = "approve"` on the mbx server to send without a prompt.
- `wake-opencode.py`: creates a session on the running `opencode service` with a project-level `opencode.json` that adds the mbx server, then wakes it with `/synthetic`. It logs any permission request and approves only the ones about mbx.
- `wake-claude.py`: starts an interactive Claude Code with `--dangerously-load-development-channels server:mbx` and `--strict-mcp-config`, leaves it idle, and waits for the channel wake and the reply.

Run them on a machine that stays awake. A laptop on battery with the lid closed sleeps through them even with `caffeinate`.

## Cross-machine
1. Install on both machines and `agentmbx daemon install` on each.
2. `agentmbx pair` on one, then the printed `agentmbx join …` line on the other (or `pair --compare <other>.local:7373` and approve on both).
3. `agentmbx send --as a --to b@<other> --kind request --needs-reply …`, then `agentmbx inbox --as b` on the other machine.
