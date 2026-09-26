#!/bin/sh
# Launch the SignalDock salvage team as Orca terminals in ~/projects/signaldock (owner-run).
# Codex: auto-review approvals + network for cargo. Kimi: --yolo ("ask when needed"). Claude lead: auto mode.
P="$HOME/projects/agentmbx/docs/research/signaldock/prompts"; W="path:$HOME/projects/signaldock"; AM="$HOME/projects/agentmbx"
CX="codex --approve-for-me -c sandbox_workspace_write.network_access=true --add-dir $AM"
orca terminal create --worktree "$W" --title "sd-lead (Claude)"    --command "claude --permission-mode auto --add-dir $AM -n sd-lead \"\$(cat $P/lead.txt)\""
orca terminal create --worktree "$W" --title "sd-backend (Codex)"  --command "$CX \"\$(cat $P/A.txt)\""
orca terminal create --worktree "$W" --title "sd-protocol (Codex)" --command "$CX \"\$(cat $P/C.txt)\""
orca terminal create --worktree "$W" --title "sd-frontend (Kimi)"  --command "kimi --yolo --add-dir $AM"
orca terminal create --worktree "$W" --title "sd-secops (Kimi)"    --command "kimi --yolo --add-dir $AM --add-dir $HOME/projects/cleocode"
echo "Kimi has no startup-prompt flag: paste prompts/B.txt into sd-frontend and prompts/D.txt into sd-secops."
