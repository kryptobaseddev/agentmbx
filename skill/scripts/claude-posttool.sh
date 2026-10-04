#!/bin/sh
# Claude PostToolUse hook, fast path (T342). The hook fires on EVERY tool call; steady state is
# "nothing new", and this wrapper decides that with two small file reads — zero node starts.
# The daemon bumps <cli>-<sid>.marker whenever the hook's decision could change (a delivery, a
# bind); the full `agentmbx hook post-tool` path records the marker value it processed in
# <cli>-<sid>.last. marker == last means the decision is provably identical: no output.
# Anything unexpected (no session id, no marker, no last, marker moved) falls through to the
# full node path, which alone emits hook output.
#
# setup wires this as: sh claude-posttool.sh <cmd…> — the hook's own resolved command, so a
# desktop-started Claude with a minimal PATH never relies on `agentmbx` being on PATH (review
# high). Invoked with no arguments it falls back to `agentmbx` from PATH.
set -f
[ "$#" -ge 1 ] || set -- agentmbx
json=$(cat 2>/dev/null) || json=""
dir="${MBX_HOME:-$HOME/.local/share/agentmbx}/posttool"
sid=""
run_full() {
  # "$@" inside a function are the FUNCTION's arguments — call sites pass the script's own
  # resolved command through. The heredoc body holds ONLY the variable name: it expands exactly
  # once and the expanded JSON is never re-scanned, so tool output cannot be command-substituted.
  # A heredoc feeds stdin without a pipeline, so exec preserves this pid — the identity check
  # pins it (review medium 3; the previous scratch file kept tool output on disk all session).
  exec "$@" hook post-tool --cli claude <<AGENTMBX_JSON_END
$json
AGENTMBX_JSON_END
}
# Only the TOP-LEVEL "session_id" counts, and only when its value is a string — the same scanner
# as the statusline adapter (review low: a nested key must never select another session's marker).
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
  *[!A-Za-z0-9_-]*|'') sid=""; run_full "$@" ;;
esac
m=$(cat "$dir/claude-$sid.marker" 2>/dev/null) || run_full "$@"
l=$(cat "$dir/claude-$sid.last" 2>/dev/null) || run_full "$@"
[ -n "$m" ] && [ "$m" = "$l" ] && exit 0
run_full "$@"
