#!/usr/bin/env bash
# Optional MBX segment for a Claude statusLine command. Reads Claude's JSON on stdin.
# Append this output to an existing HUD; setup never overwrites the user's status line.
set -f
command -v jq >/dev/null 2>&1 || exit 0
command -v sqlite3 >/dev/null 2>&1 || exit 0
sid=$(jq -r '.session_id // empty' 2>/dev/null) || exit 0
case "$sid" in ''|*[!a-zA-Z0-9_-]*) exit 0 ;; esac
db="${MBX_HOME:-$HOME/.local/share/agentmbx}/mbx.db"
[ -f "$db" ] || exit 0
# Exact provider binding: no directory-based guess and no host-wide outgoing count.
out=$(sqlite3 -readonly -separator ' ' -cmd '.timeout 50' "$db" "
  WITH identity(agent) AS (SELECT agent FROM sessions WHERE cli='claude' AND session_id='$sid')
  SELECT agent,
    (SELECT count(*) FROM deliveries WHERE agent=identity.agent AND state<>'acked'),
    (SELECT count(DISTINCT o.msg_id) FROM outbox o JOIN messages m ON m.id=o.msg_id
       WHERE substr(m.from_addr,1,instr(m.from_addr,'@')-1)=identity.agent)
  FROM identity;" 2>/dev/null) || exit 0
set -- $out
[ "$#" = 3 ] || exit 0
case "$2$3" in *[!0-9]*) exit 0 ;; esac
if [ "$2" -gt 0 ]; then printf 'MBX %s: %s new' "$1" "$2"
else printf 'MBX %s: no mail' "$1"; fi
[ "$3" -eq 0 ] || printf ' · %s unsent' "$3"
printf '\n'
exit 0
