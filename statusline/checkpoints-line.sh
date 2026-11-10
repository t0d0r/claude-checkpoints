#!/bin/sh
# Prints the checkpoints summary of the current Claude Code session, or nothing.
# Reads the status line JSON on stdin (the same JSON Claude Code hands to a status line
# command). Call it from your own status line script and print its output as an extra line:
#
#   input=$(cat)
#   ... your first line ...
#   ck=$(printf '%s' "$input" | sh /path/to/checkpoints/statusline/checkpoints-line.sh)
#   [ -n "$ck" ] && printf '%s\n' "$ck"
#
# Read-only and fail-safe: never errors out, prints nothing when jq is missing, when the
# project has no tracker, or when the line is over an hour old (a dead session's file).

command -v jq >/dev/null 2>&1 || exit 0
input=$(cat 2>/dev/null)
proj=$(printf '%s' "$input" | jq -r '.workspace.project_dir // .workspace.current_dir // .cwd // ""' 2>/dev/null)
sid=$(printf '%s' "$input" | jq -r '.session_id // ""' 2>/dev/null)
case $sid in ''|*[!A-Za-z0-9._-]*) exit 0 ;; esac
[ -n "$proj" ] || exit 0
ckf="$proj/.claude/checkpoints-cache/status-$sid.txt"
[ -f "$ckf" ] || exit 0
[ -n "$(find "$ckf" -mmin -60 2>/dev/null)" ] || exit 0
# One line, escape sequences stripped: the file is data, never terminal control.
head -n 1 "$ckf" 2>/dev/null | tr -d '\033'
exit 0
