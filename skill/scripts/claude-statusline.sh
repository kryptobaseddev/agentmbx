#!/bin/sh
# Optional MBX segment for a Claude statusLine command (T313). Pure sh: sed, date and one cat —
# no node startup on the render path (review round 3: node startup broke the 300 ms CLI budget
# under load). Reads the daemon-written HUD snapshot; appends to an existing status line, never
# overwrites it. Renders nothing when the daemon heartbeat is stale or the session is unbound.
set -f
json=$(cat 2>/dev/null) || exit 0
# Round 4: the FIRST session_id wins. A left-greedy match lets a nested key override the
# conversation's own id ({"session_id":"mine","agent":{"session_id":"victim"}} renders victim); a
# charset-validating match falls through to the nested key when the top-level id is invalid.
pair=$(printf '%s' "$json" | grep -o '"session_id"[[:space:]]*:[[:space:]]*"[^"]*"' | head -n 1)
[ -n "$pair" ] || exit 0
sid=$(printf '%s' "$pair" | sed 's/^"session_id"[[:space:]]*:[[:space:]]*"//; s/"$//')
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
