#!/bin/sh
# Optional MBX segment for a Claude statusLine command (T313). Pure sh: sed, date and one cat —
# no node startup on the render path (review round 3: node startup broke the 300 ms CLI budget
# under load). Reads the daemon-written HUD snapshot; appends to an existing status line, never
# overwrites it. Renders nothing when the daemon heartbeat is stale or the session is unbound.
set -f
json=$(cat 2>/dev/null) || exit 0
# Only the TOP-LEVEL "session_id" counts, and only when its value is a string. A small awk scanner
# tracks strings, escapes and nesting depth, so a nested key never supplies the id, whether it
# comes before or after the top-level one, and a null, number or object id renders nothing.
sid=$(printf '%s' "$json" | LC_ALL=C awk '
BEGIN { RS = "\001" }
{
  n = length($0); d = 0; ins = 0; esc = 0; tok = ""; key = ""; expectkey = 0; want = 0
  for (i = 1; i <= n; i++) {
    c = substr($0, i, 1)
    if (ins) {
      if (esc) { esc = 0; tok = tok c; continue }
      if (c == "\\") { esc = 1; tok = tok c; continue }
      if (c != "\"") { tok = tok c; continue }
      ins = 0
      if (d == 1 && want) { print tok; exit }
      if (d == 1 && expectkey) { key = tok; expectkey = 0 }
      continue
    }
    if (want && c != "\"" && c !~ /[ \t\r\n]/) exit
    if (c == "\"") { ins = 1; tok = ""; continue }
    if (c == "{" || c == "[") { d++; if (d == 1 && c == "{") expectkey = 1; continue }
    if (c == "}" || c == "]") { d--; continue }
    if (d == 1 && c == ",") { expectkey = 1; key = ""; continue }
    if (d == 1 && c == ":" && key == "session_id") want = 1
  }
}')
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
