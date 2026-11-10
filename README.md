# checkpoints (Claude Code mod)

Shows every checkpoint tracker of the current project (`*/YYYY-MM-DD-HHMM-checkpoints-*.md`)
in a pane opened with `/checkpoints` and, optionally, in the status line, merged with the live
lines of the tracker's committed, read-only `progress-check` script (only from
`scripts/checkpoints/` of that project, and only when identical to HEAD). The convention for
trackers and scripts ships with the mod as the skill `skills/checkpoint-tracker/SKILL.md`.

A project without a tracker sees nothing: no cache folder, no status line.

## Install

One clone on the machine, registered as a marketplace folder, user scope. Every project then
reads the mod from that one folder.

```
git clone <repository url> ~/work/AI/claude-mods/checkpoints
claude plugin marketplace add ~/work/AI/claude-mods/checkpoints
claude plugin install checkpoints --marketplace ~/work/AI/claude-mods/checkpoints
```

Or, from the prompt of a terminal session, straight from a repository:

```
/plugin install checkpoints --marketplace <owner>/<repo>
```

## Update

```
git -C ~/work/AI/claude-mods/checkpoints pull --ff-only
```

then `/reload-plugins` in sessions that are already open; new sessions load the new code.
Read the incoming diff before the pull: this code runs in every project.

## Pane

- `/checkpoints` opens it (half the terminal's width when docked - the engine caps a dock at
  45% - or 24 rows inline) and refreshes; `/checkpoints <slug>` pins one tracker to this
  session; `/checkpoints off` unpins.
- "Waiting on you" block on top: every OPERATOR row of every open tracker in one list. Rows
  that can be decided now come first; a row whose "depends on" cell names a checkpoint that is
  not DONE/OK yet is listed under "later" with `(after <ids>)` and is dimmed in its track too.
  Dependencies are the checkpoint IDs in the "depends on" column (`B4 + approval`, `A4 + D4`,
  `C1-C3`); free text names none, and a table without that column has none.
- DONE/OK rows are folded: a track shows its open rows plus one `+ N done: <ids>` line (a
  fully done track shows only its heading). `Done: show` / `Done: fold` button or `d` toggles.
- Refresh button / `r`; `w` toggles wrapped notes and one line per row; `q` closes. Hotkeys
  work while the pane holds the focus.
- With a pin: the pinned tracker in full, the others as one title line each; the
  `Others: full` / `Others: titles` button or `p` toggles, a click on a title opens or folds
  that tracker.
- Refresh: at session start, every 15 minutes, on `/checkpoints` and on Refresh.
- Finished trackers go away on their own: a tracker that is closed, or whose counted rows are
  all DONE/OK with no script error, stays for two days after its last change (the newest
  `| YYYY-MM-DD HH:MM |` progress-log row, or the file's mtime if the log is empty), then is
  left out. `/checkpoints <slug>` pins it and brings it back.

## Status line (optional)

Each refresh writes one line to `<project>/.claude/checkpoints-cache/status-<session id>.txt`
(0600). `statusline/checkpoints-line.sh` prints it while it is under an hour old; call it from
your own status line script (needs `jq`):

```
input=$(cat)
# ... print your first line ...
ck=$(printf '%s' "$input" | sh ~/work/AI/claude-mods/checkpoints/statusline/checkpoints-line.sh)
[ -n "$ck" ] && printf '%s\n' "$ck"
```

Unpinned: every open tracker as `name done/total` plus only its RUNNING/FAILED/BLOCKED rows
and `you: <ids decidable now> (+N later)`; pinned: that tracker with its per-track figures and
the others as `+N open`. Example:

```
ckpt 21:04 UTC | db-upgrade 9/11 you: B1 B2 (+1 later) | web-4 3/8 A3 RUNNING
```

A tracker is named by the slug after `checkpoints-` in its file name; a header line
`- short-name: <name>` overrides that.

## Progress-check scripts

- A script runs only when its path is under `scripts/checkpoints/` of the project, has no
  `..`, is tracked by git and is identical to HEAD.
- Scripts are shared across sessions: at most one run per 14 min per tracker, under an `mkdir`
  lock in `.claude/checkpoints-cache/`; other sessions reuse the output.
- The mod writes `.claude/checkpoints-cache/.gitignore` (`*`) itself, so the cache stays out of
  git in every project.

## Check after an edit

```
claude plugin validate ~/work/AI/claude-mods/checkpoints
tsc -p ~/work/AI/claude-mods/checkpoints
```

`tsc` needs the types the engine lays in `.claude-plugin/types/` once it has loaded the mod.

## Security note

- Progress-check scripts run unattended, every 15 minutes, with the user's own credentials
  (ssh keys included). The "tracked by git and identical to HEAD" gate is the only guardrail:
  never weaken it, keep the scripts read-only, and review any such script that arrives by a
  merge or a pull before it lands on the checked-out branch.
- Installed at the user scope the mod loads in every project. It reads only tracker files and
  `scripts/checkpoints/` of the project the session runs in.
- The cache holds script output and status lines only (they may name hosts): 0700/0600,
  ignored by its own `.gitignore`; never commit or share it.
- An update of this repository changes the code in every project at once: read the diff before
  pulling.
