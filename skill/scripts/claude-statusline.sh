#!/usr/bin/env bash
# Optional MBX segment for a Claude statusLine command (T313). The adapter reads Claude's JSON on
# stdin and renders from the daemon-written HUD snapshot — one cat of a small JSON file, no sqlite3,
# no store access. Append this output to an existing HUD; setup never overwrites the user's line.
set -f
command -v agentmbx >/dev/null 2>&1 || exit 0
exec agentmbx statusline claude
