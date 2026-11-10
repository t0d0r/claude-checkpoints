---
name: checkpoint-tracker
description: Create or update a checkpoint tracker for a multi-step task (a plan with approval gates, several systems, work that spans sessions) so its progress shows in the `/checkpoints` pane and the status line of every Claude Code session in the project. Use when asked to "make checkpoints", "track the progress of this work", "add a tracker", "show progress in the panel/status line", or when a plan has more than a handful of approval-gated steps. Covers the tracker file convention (name, header keys, track headings, row tables, dependencies, states) and the optional read-only progress-check script the pane runs (committed, unmodified, one `ID STATE evidence` line per checkpoint). The tracker and script are docs and read-only code; the changes they track keep their own approval gates.
---

# Checkpoint trackers and the `/checkpoints` pane

One file per piece of multi-step work lists its checkpoints with a state each. The
`checkpoints` mod finds every tracker of the project, merges in what its progress-check script
measures live, and shows them in the `/checkpoints` pane and (optionally) in the status line.
What the pane and the status line look like, and how to install the mod, is in the mod's
`README.md`.

## The tracker file

- **Name**: `<folder>/YYYY-MM-DD-HHMM-checkpoints-<slug>.md`, e.g.
  `docs/2026-01-15-0930-checkpoints-db-upgrade.md`. The mod discovers files by that pattern
  with `git ls-files --cached --others --exclude-standard`, so a new, not yet committed tracker
  shows too (its script does not run until committed - below).
- **Title**: the first `# ` line.
- **Header keys** (bullets in the first 40 lines, exactly these spellings):
  - `- progress-check: \`scripts/checkpoints/<slug>.sh\`` - optional live script (only that
    folder runs, see below).
  - `- tracker-status: active` or `closed` - `closed` drops the tracker from the status line,
    shows it as one collapsed line in the pane, and does not run its script. Two days after
    its last progress-log time a finished tracker (closed, or every row DONE) disappears from
    the pane and the status line on its own; pinning it with `/checkpoints <slug>` shows it.
  - `- short-name: <name>` - optional display name (letters, digits, `.`, `_`, `-`); without
    it the tracker is named by its slug.
- **Tracks**: `## Track <LETTER(S)> - <title>` headings; the pane groups rows under them.
- **Rows**: markdown table rows whose first cell is an ID - one to three capitals followed by a
  number (`A1`, `B12`, `C3a`) or by `-<word>` (`A-r`) - and some later cell starting with a
  state. An optional second cell holding only a plan-step number (`| B1 | 2 | ... |`) is
  skipped for the title. Column layout is otherwise free; the first state cell wins, the rest
  of that cell is shown as the note:
  ```
  | ID | checkpoint | depends on | state | evidence |
  |---|---|---|---|---|
  | A4 | apply the change on the canary | A3 + approval | DONE 2026-01-15 10:28 UTC | change record ... |
  ```
- **Dependencies**: a column headed `depends on` is read for checkpoint IDs (`A3 + approval`,
  `A4 + D4`, `C1-C3`). An `OPERATOR` row that names a checkpoint which is not DONE/OK yet is
  shown as "later (after <ids>)" instead of "waiting on you now", in the pane and as
  `(+N later)` in the status line. Name the real prerequisite IDs there; free text counts as
  no dependency.
- **States**: `DONE`, `RUNNING`, `PENDING`, `OPERATOR` (waiting for the operator's decision -
  listed as "waiting on you"), `BLOCKED`, `FAILED`; the script may also print `OK`, `FAIL`,
  `INFO`, `UNKNOWN`. Colors: DONE/OK green, RUNNING/UNKNOWN yellow, OPERATOR highlighted,
  FAILED/FAIL/BLOCKED red, INFO blue, PENDING grey.
- **Progress log**: a `## Progress log` table (`| time (UTC) | change |`), one row per state
  change, newest time decides when a finished tracker retires.

Good practice: a row's evidence names the command or record that proves it, never "see
session"; a state changes in the same commit as the change it records; DONE means the effect
was validated, not that a command exited 0; long lists stay in the documents the rows point to.

## The progress-check script (optional)

- Path: `scripts/checkpoints/<slug>.sh` in the project, the same slug as the tracker.
- READ-ONLY. It runs unattended every 15 minutes in every open session of the project, with
  the user's own credentials.
- Prints one line per checkpoint it can measure: `ID STATE evidence` (space separated, the
  evidence free text). IDs it prints that the tracker lacks are shown as `info` rows
  (`A0 INFO 14/14 hosts reached`). Anything else it prints is ignored.
- A live state replaces the tracker's state for that ID. So a checkpoint the script cannot
  judge (an operator sign-off, a manual step) must not be printed as PENDING/OPERATOR once the
  tracker says DONE - print DONE or leave the ID out.
- Finishes within 180 s (the mod's timeout). For remote checks: non-interactive connections
  with a short connect timeout, one session per host, no retries; anything long does not
  belong here.
- No secrets in its output.

**The mod runs a script only if** its path is under `scripts/checkpoints/`, has no `..`,
matches `[A-Za-z0-9._/-]+\.sh`, is tracked by git and is identical to `HEAD`
(`git ls-files --error-unmatch` and `git diff --quiet HEAD`). Otherwise the pane shows
"not under scripts/checkpoints/" / "progress-check not committed" / "differs from HEAD, not
run" and only the tracker's own states. So: commit the script before expecting live rows, and
an uncommitted edit stops it until committed.

Many sessions, one checkout: a tracker's script runs at most once per 14 minutes across all
sessions. The first session takes an `mkdir` lock in `.claude/checkpoints-cache/`, runs the
script and writes its output there; the others wait for and reuse that output. Refresh (`r`)
and a bare `/checkpoints` skip the freshness test but still wait on the lock. A lock older
than 5 minutes is treated as left by a dead session and removed.

## Steps

1. Pick the folder and the slug; create the tracker from the shape above with every
   checkpoint as a row, dependencies and approval gates in the `depends on` column.
2. If parts can be measured, write `scripts/checkpoints/<slug>.sh` (read-only), run it once by
   hand and check its lines.
3. Put `- progress-check: ...` and `- tracker-status: active` in the tracker header.
4. Commit tracker and script (named files only).
5. In the session: `/checkpoints` (or wait for the status line); the pane's Refresh re-reads.
6. When the work ends: `- tracker-status: closed`, final progress-log row, commit.

## Security note

- The scripts run with the user's credentials against real systems; the git gate above is the
  guardrail - never weaken it to run an uncommitted script.
- "Committed" is not the same as "reviewed": commits also arrive by merges and pulls. Once such
  a commit lands on the checked-out branch, any tracker's `progress-check` script in it runs
  every 15 minutes in every open session. Before merging, review any new or changed `*.sh`
  that a `*-checkpoints-*.md` header names
  (`git diff <old>..<new> -- '*-checkpoints-*.md' '*.sh'`).
- Trackers are committed documents: no credentials in them.
- The cache (`.claude/checkpoints-cache/`) holds script output only, never a command. It may
  name hosts and states, so it is 0700/0600 and ignored by its own `.gitignore`; never commit
  or share it.
- Known limit: two sessions that find the same lock stale at the same instant can both run the
  script once; the cost is one extra read-only run.
