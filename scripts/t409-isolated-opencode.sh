#!/bin/bash
# T409 isolated OpenCode runner — REVIEWED artifact. agentmbx-opencode runs this after review;
# Kimi must not launch OpenCode (2026-10-07 incident: a pattern kill killed the owner's sessions).
# Isolation: HOME + XDG dirs under one scratch root; every started PID recorded; cleanup kills
# only recorded PIDs; no pkill, killall or pattern kill anywhere in this file.
set -euo pipefail

ROOT="${T409_ROOT:-/tmp/t409-home}"
OC_BIN="${OC_BIN:-$HOME/.opencode/bin/opencode}"
# The agentmbx build that serves the T407 v2 endpoint (#157): built from the worktree, dist/ path
# passed in. The scratch daemon's MBX_HOME lives entirely under the root.
AGENTMBX_BIN="${AGENTMBX_BIN:?set AGENTMBX_BIN to a bin/agentmbx.js whose dist serves /v1/status schema=mbx.status/v2}"
REAL_HOME="$HOME"   # captured before isolation so the audit can spot escapes into it
PIDFILE="$ROOT/pids"
mkdir -p "$ROOT"/{home,data,state,cache,run,config,project,mbx-home}

export HOME="$ROOT/home"
export XDG_DATA_HOME="$ROOT/data"
export XDG_STATE_HOME="$ROOT/state"
export XDG_CACHE_HOME="$ROOT/cache"
export XDG_RUNTIME_DIR="$ROOT/run"
export OPENCODE_CONFIG_DIR="$ROOT/config"
MBX_PORT_T409="${MBX_PORT_T409:-47373}"

: > "$PIDFILE"
record() { printf '%s %s\n' "$1" "$2" >> "$PIDFILE"; }

cleanup() {
  [ -f "$PIDFILE" ] || { echo "refusing to clean: $PIDFILE missing" >&2; return 1; }
  sort -rn "$PIDFILE" | while read -r pid purpose; do
    kill "$pid" 2>/dev/null && echo "killed $pid ($purpose)"
  done
  rm -f "$PIDFILE"
}

# Seed the scratch agentmbx daemon's config on a non-default port, start it, record its PID.
start_daemon() {
  mkdir -p "$ROOT/mbx-home"
  printf '{\n  "host": "t409scratch",\n  "port": %s,\n  "bind": "127.0.0.1"\n}\n' "$MBX_PORT_T409" > "$ROOT/mbx-home/config.json"
  MBX_HOME="$ROOT/mbx-home" "$AGENTMBX_BIN" daemon &
  record $! "agentmbx scratch daemon (MBX_HOME=$ROOT/mbx-home port=$MBX_PORT_T409)"
  sleep 2
}

# Gate 1 (escape audit): launch opencode TUI with the plugin env, sample open files, verify no
# path outside $ROOT (including ~/Library and ~/.local/share/opencode) is touched.
if [ "${1:-}" = "audit" ]; then
  start_daemon
  export MBX_PORT="$MBX_PORT_T409"
  cd "$ROOT/project"
  "$OC_BIN" --standalone &
  tui=$!; record "$tui" "opencode --standalone (audit)"
  sleep 2
  child=$(pgrep -P "$tui" | head -1 || true)
  [ -n "$child" ] && record "$child" "opencode serve child"
  sleep 8
  # The exec'd binary itself always shows as a txt entry (the kernel must read the file to run
  # it) — that is not an escape. Everything else under the real HOME would be.
  oc_real=$(readlink -f "$OC_BIN" 2>/dev/null || echo "$OC_BIN")
  leaked=$(lsof -p "$tui" ${child:+-p "$child"} 2>/dev/null \
    | grep -E "/Users/|/home/" | grep -v "$ROOT" | grep -vF "$oc_real" || true)
  if [ -n "$leaked" ]; then
    echo "ESCAPE AUDIT FAILED — open paths outside $ROOT:" >&2
    echo "$leaked" >&2
    cleanup; exit 1
  fi
  echo "escape audit clean: no open paths outside $ROOT"
  cleanup
  exit 0
fi

echo "modes: $0 audit   (nothing else is approved yet)" >&2
exit 2
