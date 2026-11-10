export type Row = {
  id: string
  state: string
  title: string
  note: string
  source: 'live' | 'tracker'
  // Checkpoint IDs named in the row's "depends on" cell; [] when the table has no such column.
  deps: string[]
  // Epoch ms of the newest progress-log row that names this row's ID; 0 = never named.
  sinceMs: number
}

export type LogEntry = {
  atMs: number
  text: string
}

export type Group = {
  key: string
  title: string
}

export type Tracker = {
  path: string
  name: string
  title: string
  isClosed: boolean
  script: string
  groups: Group[]
  rows: Row[]
  error: string
  // Where the live rows came from: 'run now', 'cached N min', or '' (no script ran).
  liveAt: string
  // Epoch ms of the tracker's last change: the newest progress-log time, else the file's mtime.
  lastChangeMs: number
  // The newest progress-log rows, newest first.
  log: LogEntry[]
}

export type Snapshot = {
  trackers: Tracker[]
  // Names of finished trackers past their grace period, left out of `trackers`.
  retired: string[]
  checkedAt: string
  isRunning: boolean
  error: string
}

declare module 'claude-code' {
  interface PluginState {
    'checkpoints': {
      snapshot: Shaped<Snapshot>
      isWrapped: boolean
      pinned: string
      // With a pin: show the other trackers as one title line each (true) or in full (false).
      onlyPinned: boolean
      // Tracker paths whose title was clicked: each inverts its default view (brief <-> full).
      toggled: string[]
      // Without a pin: one title line per tracker (true) or every tracker in full (false).
      overview: boolean
      // DONE/OK rows listed in full (true) or folded into one line per track (false).
      showDone: boolean
    }
  }
}
