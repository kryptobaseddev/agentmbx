#!/bin/sh
# Claude PostToolUse hook, fast path (T342). The hook fires on EVERY tool call; steady state is
# "nothing new", and this wrapper decides that with two small file reads — zero node starts.
# The daemon bumps <cli>-<sid>.marker whenever the hook's decision could change (a delivery, a
# bind); the full `agentmbx hook post-tool` path records the marker value it processed in
# <cli>-<sid>.last. marker == last means the decision is provably identical: no output.
# Anything unexpected (no session id, no marker, no last, marker moved) falls through to the
# full node path, which alone emits hook output. The captured stdin JSON goes to a per-session
# scratch file so the fall-through can EXEC the full hook (preserving this process's pid, which
# the hook verifies against the provider binding); the daemon sweep deletes scratch files.
set -f
command -v agentmbx >/dev/null 2>&1 || exit 0
json=$(cat 2>/dev/null) || json=""
dir="${MBX_HOME:-$HOME/.local/share/agentmbx}/posttool"
sid=""
run_full() {
  scratch="$dir/claude-${sid:-anon-$PPID}.stdin"
  if printf '%s' "$json" > "$scratch" 2>/dev/null; then
    exec agentmbx hook post-tool --cli claude < "$scratch"
  fi
  printf '%s' "$json" | agentmbx hook post-tool --cli claude
  exit $?
}
pair=$(printf '%s' "$json" | grep -o '"session_id"[[:space:]]*:[[:space:]]*"[^"]*"' | head -n 1)
[ -n "$pair" ] || run_full
sid=$(printf '%s' "$pair" | sed 's/^"session_id"[[:space:]]*:[[:space:]]*"//; s/"$//')
case "$sid" in
  *[!A-Za-z0-9_-]*|'') sid=""; run_full ;;
esac
m=$(cat "$dir/claude-$sid.marker" 2>/dev/null) || run_full
l=$(cat "$dir/claude-$sid.last" 2>/dev/null) || run_full
[ -n "$m" ] && [ "$m" = "$l" ] && exit 0
run_full
