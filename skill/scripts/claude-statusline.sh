#!/bin/sh
# Optional MBX segment for a Claude statusLine command (T313). Pure sh: sed, date and one cat —
# no node startup on the render path (review round 3: node startup broke the 300 ms CLI budget
# under load). Reads the daemon-written HUD snapshot; appends to an existing status line, never
# overwrites it. Renders nothing when the daemon heartbeat is stale or the session is unbound.
set -f
json=$(cat 2>/dev/null) || exit 0
sid=$(printf '%s' "$json" | sed -n 's/.*"session_id"[[:space:]]*:[[:space:]]*"\([A-Za-z0-9_-]*\)".*/\1/p' | head -n 1)
case "$sid" in
  *[!A-Za-z0-9_-]*|'') exit 0 ;;
esac
hud="${MBX_HOME:-$HOME/.local/share/agentmbx}/hud"
alive=$(cat "$hud/.alive" 2>/dev/null) || exit 0
case "$alive" in
  *[!0-9]*|'') exit 0 ;;
esac
now=$(( $(date +%s) * 1000 )) # seconds is macOS-portable; the 10 s staleness budget absorbs the rounding
[ $(( now - alive )) -le 10000 ] || exit 0 # a future-dated alive (clock skew) is negative: passes
cat "$hud/claude-$sid.line" 2>/dev/null || exit 0
