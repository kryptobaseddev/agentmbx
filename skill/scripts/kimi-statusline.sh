#!/bin/sh
# MBX segment for Kimi Code's [status_line] command (T313/T347). Pure sh: awk, date and one cat —
# no node startup on the render path (Kimi's cap is 300 ms, throttled to once per second; the node
# adapter measured 0.21–0.34 s, i.e. one node start per second per session — review major 5).
# Reads the daemon-written HUD snapshot. Additive by contract (owner 2026-10-04): when there is
# no segment to render (unbound, daemon down, stale heartbeat) it EXITS NONZERO so Kimi falls back
# to its built-in layout instead of showing a blank footer — our line is never a substitute for it.
set -f
json=$(cat 2>/dev/null) || exit 1
# Only the TOP-LEVEL "session_id" counts, and only when its value is a string (same scanner as the
# statusline adapter: a nested key never selects another session's snapshot).
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
  *[!A-Za-z0-9_-]*|'') exit 1 ;;
esac
hud="${MBX_HOME:-$HOME/.local/share/agentmbx}/hud"
alive=$(cat "$hud/.alive" 2>/dev/null) || exit 1
case "$alive" in
  *[!0-9]*|'') exit 1 ;;
esac
now=$(( $(date +%s) * 1000 )) # seconds is macOS-portable; the 10 s staleness budget absorbs the rounding
[ $(( now - alive )) -le 10000 ] || exit 1
cat "$hud/kimi-$sid.line" 2>/dev/null || exit 1
