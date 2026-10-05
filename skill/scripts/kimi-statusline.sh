#!/bin/sh
# MBX alert segment for Kimi Code's [status_line] command (T366). Kimi's custom command REPLACES
# the footer — the built-in items render only when the command prints nothing — so this adapter is
# alert-only and reads NO stdin: the daemon pre-renders one fixed-path line every tick and this
# script cats it (no composition logic, no JSON parsing). Nothing to show (zero unread, no bound
# kimi session, daemon heartbeat older than ~10 s) renders EMPTY stdout and exits 0, so Kimi keeps
# its built-in footer items — never a blank line, never error text, never a stale alert.
set -f
hud="${MBX_HOME:-$HOME/.local/share/agentmbx}/hud"
alive=$(cat "$hud/.alive" 2>/dev/null) || exit 0
case "$alive" in
  *[!0-9]*|'') exit 0 ;;
esac
now=$(( $(date +%s) * 1000 )) # seconds is macOS-portable; the 10 s staleness budget absorbs the rounding
[ $(( now - alive )) -le 10000 ] || exit 0 # a future-dated alive (clock skew) is negative: passes
cat "$hud/kimi.line" 2>/dev/null || exit 0 # missing line file: nothing to show, not an error
