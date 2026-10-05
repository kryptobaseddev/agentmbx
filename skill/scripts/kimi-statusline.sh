#!/bin/sh
# MBX alert segment for Kimi Code's [status_line] command (T313/T366). Pure sh: awk, date and one
# cat — no node startup on the render path (Kimi's cap is 300 ms, throttled to once per second; the
# node adapter measured 0.21–0.34 s, i.e. one node start per second per session — review major 5).
# Kimi's custom command REPLACES the footer — the built-in items render only when the command
# prints nothing — so this adapter is alert-only: it cats the daemon-written PER-SESSION line for
# the session whose id Kimi pipes on stdin, and every "nothing to show" path (no/invalid session
# id, missing or stale heartbeat, missing line file, zero unread — the daemon writes an EMPTY
# per-session line then) prints NOTHING and exits 0, so Kimi renders its built-in footer items.
# A session never sees another session's line: the render is one cat of its own kimi-<sid>.line.
set -f
json=$(cat 2>/dev/null) || exit 0
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
  *[!A-Za-z0-9_-]*|'') exit 0 ;;
esac
hud="${MBX_HOME:-$HOME/.local/share/agentmbx}/hud"
alive=$(cat "$hud/.alive" 2>/dev/null) || exit 0
case "$alive" in
  *[!0-9]*|'') exit 0 ;;
esac
now=$(( $(date +%s) * 1000 )) # seconds is macOS-portable; the 10 s staleness budget absorbs the rounding
[ $(( now - alive )) -le 10000 ] || exit 0 # a future-dated alive (clock skew) is negative: passes
cat "$hud/kimi-$sid.line" 2>/dev/null || exit 0 # unbound / pruned: nothing to show, not an error
