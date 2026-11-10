import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Group, Row, Snapshot, Tracker } from '../types'

// Generic checkpoint pane for the project a session runs in. Convention
// (skills/checkpoint-tracker/SKILL.md in this plugin):
// a tracker is any git-known file named YYYY-MM-DD-HHMM-checkpoints-<slug>.md; its header may
// name a read-only script with "- progress-check: `scripts/checkpoints/<slug>.sh`", which runs
// only from that folder and only when it is committed and unmodified; "- tracker-status: closed"
// hides it from the status line.
//
// Many sessions, one repo: `/checkpoints <slug>` pins one tracker to THIS session (plugin state
// is held per session) so its status line shows that tracker in full and the rest as a count.
// The status line is not a pinned notice (the engine frames those with a full-width rule and a
// warning sign): the summary is written to .claude/checkpoints-cache/status-<session id>.txt and
// statusline/checkpoints-line.sh (called from the user's own status line script) prints it.
// Script output is shared through .claude/checkpoints-cache/ (gitignored, 0700): a script runs
// at most once per CACHE_TTL_MS across all sessions, under an mkdir lock, so N sessions do not
// open N parallel ssh sessions to the same hosts. Only output is cached, never a command; the
// committed-and-unmodified gate runs before every use, and the cache entry is bound to the
// script's HEAD blob id.

const PANE = 'checkpoints'
const TITLE = 'checkpoints'
const EVERY_MS = 15 * 60 * 1000
const SCRIPT_TIMEOUT_MS = 180000
// A session's own 15-minute timer finds the cache just expired and runs the script itself.
const CACHE_TTL_MS = EVERY_MS - 60 * 1000
// A lock older than this belongs to a session that died mid-run.
const LOCK_STALE_MS = SCRIPT_TIMEOUT_MS + 2 * 60 * 1000
const LOCK_POLL_MS = 5000
const CACHE_DIR = '.claude/checkpoints-cache'
// Per-session status line for statusline/checkpoints-line.sh; files no session refreshed for a
// day go.
const STATUS_PREFIX = 'status-'
const STATUS_MAX_AGE_MIN = 1440
const TRACKER_NAME = /(^|\/)\d{4}-\d{2}-\d{2}-\d{4}-checkpoints-[^/]+\.md$/
// Only scripts in the one reviewed folder run with the operator's keys.
const SCRIPT_DIR = 'scripts/checkpoints/'
const SAFE_SCRIPT = /^(?!\/)(?!.*(^|\/)\.\.(\/|$))[A-Za-z0-9._/-]+\.sh$/
const STATES = /^(DONE|RUNNING|PENDING|OPERATOR|BLOCKED|FAILED|FAIL|OK|INFO|UNKNOWN)\b/
const ROW_ID = /^[A-Z]{1,3}(\d+[a-z]?|-[a-z]+)$/
// A finished tracker (closed, or every counted row DONE/OK with no script error) stays in the
// pane and the status line for this long after its last change, then is left out. Pinning it
// (/checkpoints <slug>) shows it again. The last change is the newest progress-log time
// (`| YYYY-MM-DD HH:MM | ... |`, UTC), or the file's mtime when the log has no row.
const FINISHED_GRACE_MS = 2 * 24 * 60 * 60 * 1000
const LOG_TIME = /^\| (\d{4}-\d{2}-\d{2} \d{2}:\d{2}) \|/

const snapshot = atom(
  { plugin: 'checkpoints', key: 'snapshot' } as const,
  { trackers: [], checkedAt: '', isRunning: false, error: '' },
  { shape: 'snapshot-5' },
)

// Long notes: wrapped (scroll the pane with the wheel or scroll keys) or one line each.
const isWrapped = atom({ plugin: 'checkpoints', key: 'isWrapped' } as const, true)

// The tracker path this session follows; '' = none (status line shows every open tracker).
const pinned = atom({ plugin: 'checkpoints', key: 'pinned' } as const, '')

// With a pin: true = the pane shows only the pinned tracker in full and every other one as a
// single title line with its summary; false = every tracker in full. No effect without a pin.
const onlyPinned = atom({ plugin: 'checkpoints', key: 'onlyPinned' } as const, true)

// Tracker paths whose title was clicked: each inverts its default (brief <-> full) for this
// session. Cleared when the "Others" button flips the default.
const toggledPaths = atom({ plugin: 'checkpoints', key: 'toggled' } as const, [] as string[])

// DONE/OK rows: folded into one line per track (false, the default) or listed in full (true).
const showDone = atom({ plugin: 'checkpoints', key: 'showDone' } as const, false)

type CacheEntry = { blob: string; at: number; exitCode: number; stdout: string; stderr: string }

function groupOf(id: string): string {
  return id.match(/^[A-Z]+/)?.[0] ?? ''
}

// A tracker's display name: the slug after "checkpoints-" in its file name, unless its header
// carries "- short-name: <name>" (parseTracker), which wins.
function shortName(path: string): string {
  return path.match(/-checkpoints-(.+)\.md$/)?.[1] ?? path
}

// Checkpoint IDs named in a "depends on" cell: "B4 + approval" -> B4, "A4 + D4" -> A4 D4,
// "C1-C3" -> C1 C2 C3. Free text ("operator decision", "TODO.md High ...") names none. IDs
// that are not rows of the tracker are dropped later, in blockers().
function parseDeps(cell: string): string[] {
  const ids: string[] = []
  const rest = cell.replace(/\b([A-Z]{1,3})(\d+)-(?:\1)?(\d+)\b/g, (all, g: string, a: string, b: string) => {
    const lo = Number(a)
    const hi = Number(b)
    if (hi < lo || hi - lo > 50) return all
    for (let n = lo; n <= hi; n++) ids.push(`${g}${n}`)
    return ' '
  })
  for (const m of rest.matchAll(/\b[A-Z]{1,3}\d+[a-z]?\b/g)) ids.push(m[0])
  return [...new Set(ids)]
}

function isDoneState(state: string): boolean {
  return state === 'DONE' || state === 'OK'
}

// The rows a checkpoint still waits for: its named dependencies that exist in the tracker and
// are not DONE/OK. Empty = nothing in the tracker stands before it.
function blockers(t: Tracker, r: Row): string[] {
  return (r.deps ?? []).filter(d => d !== r.id && t.rows.some(x => x.id === d && !isDoneState(x.state)))
}

// What waits on the operator in one tracker, split by whether it can be decided now (no open
// dependency) or only later (a prerequisite row is still open; `after` names them).
type Waiting = { row: Row; after: string[] }

function waitingOn(t: Tracker): { now: Waiting[]; later: Waiting[] } {
  const all = t.rows.filter(r => r.state === 'OPERATOR').map(row => ({ row, after: blockers(t, row) }))
  return { now: all.filter(w => w.after.length === 0), later: all.filter(w => w.after.length > 0) }
}

function parseTracker(path: string, text: string): Tracker {
  const lines = text.split('\n')
  const head = lines.slice(0, 40).join('\n')
  const title = (lines.find(l => l.startsWith('# ')) ?? path).replace(/^# /, '')
  const script = head.match(/^- progress-check:\s*`([^`]+)`/m)?.[1] ?? ''
  const isClosed = /^- tracker-status:\s*closed\b/m.test(head)
  const name = head.match(/^- short-name:\s*([A-Za-z0-9._-]+)\s*$/m)?.[1] ?? shortName(path)
  const groups: Group[] = []
  const rows: Row[] = []
  let lastChangeMs = 0
  // Column of "depends on" in the table being read; -1 = that table has none.
  let depCol = -1
  for (const line of lines) {
    const lt = line.match(LOG_TIME)
    if (lt) lastChangeMs = Math.max(lastChangeMs, Date.parse(`${(lt[1] ?? '').replace(' ', 'T')}:00Z`) || 0)
    const g = line.match(/^## Track ([A-Z]+) - (.+)$/)
    if (g) {
      groups.push({ key: g[1] ?? '', title: `${g[1] ?? ''} - ${g[2] ?? ''}` })
      continue
    }
    if (!line.startsWith('| ')) continue
    const cells = line.split('|').slice(1, -1).map(c => c.trim())
    const id = cells[0] ?? ''
    if (id === 'ID') {
      depCol = cells.findIndex(c => /^depends on\b/i.test(c))
      continue
    }
    if (!ROW_ID.test(id)) continue
    const at = cells.findIndex((c, i) => i > 0 && STATES.test(c))
    if (at < 0) continue
    const cell = cells[at] ?? ''
    const label = (/^\d+[a-z]?$/.test(cells[1] ?? '') ? cells[2] : cells[1]) ?? ''
    const state = cell.match(STATES)?.[1] ?? cell
    rows.push({
      id,
      state,
      title: label.replace(/`/g, ''),
      note: cell.slice(state.length).trim(),
      source: 'tracker',
      deps: depCol > 0 && depCol !== at ? parseDeps(cells[depCol] ?? '') : [],
    })
  }
  return { path, name, title, isClosed, script, groups, rows, error: '', liveAt: '', lastChangeMs }
}

// Nothing left to do: closed, or every counted row DONE/OK and the script raised no error.
function isFinished(t: Tracker): boolean {
  if (t.isClosed) return true
  const o = overall(t)
  return t.error === '' && o.total > 0 && o.done === o.total
}

// Finished and past the grace period since its last change.
function isRetired(t: Tracker, now: number): boolean {
  return isFinished(t) && now - t.lastChangeMs > FINISHED_GRACE_MS
}

function parseLive(text: string): Row[] {
  const rows: Row[] = []
  for (const line of text.split('\n')) {
    const m = line.match(/^([A-Z]{1,3}(?:\d+[a-z]?|-[a-z]+))\s+(\S+)\s+(.*)$/)
    if (m) rows.push({ id: m[1] ?? '', state: m[2] ?? '', title: '', note: m[3] ?? '', source: 'live', deps: [] })
  }
  return rows
}

// Tracks keep the order of their headings in the tracker (a plan's phases are rarely
// alphabetical); a group without a heading sorts after them, alphabetically.
function merge(tracker: Row[], live: Row[], groupKeys: string[] = []): Row[] {
  const byId = new Map<string, Row>(tracker.map(r => [r.id, r]))
  for (const l of live) {
    const t = byId.get(l.id)
    byId.set(l.id, t ? { ...t, state: l.state, note: l.note, source: 'live' } : { ...l, title: 'info' })
  }
  const order = (id: string) => {
    const g = groupOf(id)
    const n = id.slice(g.length)
    const num = /^\d+/.test(n) ? Number(n.match(/^\d+/)?.[0]) : 999
    const at = groupKeys.indexOf(g)
    return [at < 0 ? groupKeys.length : at, g, num] as const
  }
  return [...byId.values()].sort((a, b) => {
    const [ia, ga, na] = order(a.id)
    const [ib, gb, nb] = order(b.id)
    if (ia !== ib) return ia - ib
    return ga === gb ? na - nb : ga < gb ? -1 : 1
  })
}

function color(state: string): string {
  switch (state) {
    case 'DONE':
    case 'OK':
      return 'success'
    case 'RUNNING':
    case 'UNKNOWN':
      return 'warning'
    case 'OPERATOR':
      return 'permission'
    case 'FAILED':
    case 'FAIL':
    case 'BLOCKED':
      return 'error'
    case 'INFO':
      return 'suggestion'
    default:
      return 'inactive'
  }
}

// Per-track progress: done/total (INFO rows do not count), plus whether the track holds a
// failed/blocked row or one waiting on the operator - that decides its colour.
type TrackStat = { key: string; done: number; total: number; red: boolean; you: boolean }

function trackStats(t: Tracker): TrackStat[] {
  const keys = [...new Set(t.rows.map(r => groupOf(r.id)))]
  return keys.flatMap(g => {
    const mine = t.rows.filter(r => groupOf(r.id) === g && r.state !== 'INFO')
    if (mine.length === 0) return []
    return [{
      key: g,
      done: mine.filter(r => isDoneState(r.state)).length,
      total: mine.length,
      red: mine.some(r => ['FAILED', 'FAIL', 'BLOCKED'].includes(r.state)),
      you: mine.some(r => r.state === 'OPERATOR'),
    }]
  })
}

// Colour of a progress figure: red beats "waiting on you" beats complete beats started.
function statColor(s: { done: number; total: number; red: boolean; you: boolean }): string {
  if (s.red) return 'error'
  if (s.you) return 'permission'
  if (s.total > 0 && s.done === s.total) return 'success'
  if (s.done > 0) return 'warning'
  return 'inactive'
}

function overall(t: Tracker): TrackStat {
  const parts = trackStats(t)
  return {
    key: '',
    done: parts.reduce((n, p) => n + p.done, 0),
    total: parts.reduce((n, p) => n + p.total, 0),
    red: parts.some(p => p.red),
    you: parts.some(p => p.you),
  }
}

// A ten-cell bar, plain ASCII: [#####.....]
function bar(s: { done: number; total: number }): string {
  const n = s.total > 0 ? Math.round((10 * s.done) / s.total) : 0
  return `[${'#'.repeat(n)}${'.'.repeat(10 - n)}]`
}

// The tail of a summary after the counts: hot rows, what waits on the operator, script error.
function summaryTail(t: Tracker): string {
  const hot = t.rows
    .filter(r => ['RUNNING', 'FAILED', 'FAIL', 'BLOCKED', 'UNKNOWN'].includes(r.state))
    .map(r => `${r.id} ${r.state}`)
  // Only what can be decided now is named; rows behind an open prerequisite are a count.
  const { now, later } = waitingOn(t)
  const you = now.length > 0
    ? `waiting on you: ${now.map(w => w.row.id).join(' ')}${later.length > 0 ? ` (+${later.length} later)` : ''}`
    : later.length > 0 ? `waiting on you later: ${later.length}` : ''
  return [
    ...(hot.length > 0 ? [hot.join(', ')] : []),
    ...(you !== '' ? [you] : []),
    ...(t.error !== '' ? ['script error'] : []),
  ].join(' | ')
}

function trackerSummary(t: Tracker): string {
  const o = overall(t)
  const parts = trackStats(t).map(p => `${p.key} ${p.done}/${p.total}`)
  const tail = summaryTail(t)
  return [`${t.name} ${o.done}/${o.total} ${parts.join(' ')}`, ...(tail !== '' ? [tail] : [])].join(' | ')
}

// One tracker in the fewest words for a status bar: overall count, then only what is hot or
// waits on the operator ("cve-rollout 3/64 M3 FAILED, you: D4 D5"); the per-track figures stay in
// the pane and in the pinned form.
function compactSummary(t: Tracker): string {
  const o = overall(t)
  const tail = summaryTail(t).replace(' | waiting on you', ', you').replace(/^waiting on you/, 'you')
  return [`${t.name} ${o.done}/${o.total}`, ...(tail !== '' ? [tail] : [])].join(' ')
}

// The status bar line: with a pin, that tracker in full and the others as a count; without
// one, every open tracker compactly. Trackers are separated by " | ".
function statusLine(trackers: Tracker[], stamp: string, pin: string): string {
  const active = trackers.filter(t => !t.isClosed)
  const mine = trackers.find(t => t.path === pin)
  if (mine !== undefined) {
    const others = active.filter(t => t !== mine).length
    return [
      `ckpt ${stamp}`,
      mine.isClosed ? `${mine.name} closed` : trackerSummary(mine),
      ...(others > 0 ? [`+${others} open`] : []),
    ].join(' | ')
  }
  if (active.length === 0) return `ckpt ${stamp} | no open tracker`
  return [`ckpt ${stamp}`, ...active.map(compactSummary)].join(' | ')
}

// The cache dir, 0700, with its own .gitignore ("*"): script output and status lines may name
// hosts, so they stay out of git in every project, whether or not its .gitignore knows the dir.
async function ensureCacheDir($: EngineInterface, cwd: string): Promise<string> {
  const dir = `${cwd}/${CACHE_DIR}`
  await $.process.run(['mkdir', '-p', '-m', '700', dir], { cwd, timeoutMs: 5000 })
  if (!(await $.fs.exists(`${dir}/.gitignore`))) await $.fs.write(`${dir}/.gitignore`, '*\n')
  return dir
}

// Hands the status line to statusline/checkpoints-line.sh through a per-session file in the cache dir
// (gitignored, 0700). Written beside and renamed, so the bar never reads a half line. Never
// throws: a status line is not worth failing a refresh over. Files of sessions that ended are
// swept once they are STATUS_MAX_AGE_MIN old; the bar itself ignores a file older than an hour.
async function writeStatus($: EngineInterface, cwd: string, text: string): Promise<void> {
  try {
    const sid = (await $.session.id()).replace(/[^A-Za-z0-9._-]/g, '_')
    const file = `${cwd}/${CACHE_DIR}/${STATUS_PREFIX}${sid}.txt`
    // A project without trackers gets no cache dir and no status line.
    if (text === '') {
      await $.process.run(['rm', '-f', file], { cwd, timeoutMs: 5000 })
      return
    }
    const dir = await ensureCacheDir($, cwd)
    await $.fs.write(`${file}.tmp`, `${text}\n`)
    await $.process.run(['chmod', '600', `${file}.tmp`], { cwd, timeoutMs: 5000 })
    await $.process.run(['mv', '-f', `${file}.tmp`, file], { cwd, timeoutMs: 5000 })
    await $.process.run(
      ['find', dir, '-maxdepth', '1', '-name', `${STATUS_PREFIX}*.txt`, '-mmin', `+${STATUS_MAX_AGE_MIN}`, '-delete'],
      { cwd, timeoutMs: 5000 },
    )
  } catch {
    // no status line this round; the next refresh writes one
  }
}

// Tracker paths of the project; none outside a git work tree (the mod loads in every project).
async function discover($: EngineInterface, cwd: string): Promise<string[]> {
  const inside = await git($, cwd, ['rev-parse', '--is-inside-work-tree'])
  if (inside.exitCode !== 0 || inside.stdout.trim() !== 'true') return []
  const r = await git($, cwd, ['ls-files', '--cached', '--others', '--exclude-standard', '--', '*-checkpoints-*.md'])
  if (r.exitCode !== 0) throw new Error(`git ls-files exit ${r.exitCode}`)
  return [...new Set(r.stdout.split('\n').filter(p => TRACKER_NAME.test(p)))].sort()
}

// `<slug>` matches the part after "checkpoints-", the short name, or the path, in that order.
function matchTracker(paths: string[], arg: string): string[] {
  const slug = (p: string) => p.match(/checkpoints-([^/]+)\.md$/)?.[1] ?? ''
  const tests = [
    (p: string) => p === arg,
    (p: string) => slug(p) === arg,
    (p: string) => shortName(p) === arg,
    (p: string) => p.includes(arg),
  ]
  for (const test of tests) {
    const hit = paths.filter(test)
    if (hit.length > 0) return hit
  }
  return []
}

async function git($: EngineInterface, cwd: string, args: string[]) {
  return $.process.run(['git', ...args], { cwd, timeoutMs: 20000 })
}

// The script must be repo-relative, tracked by git and identical to HEAD: only reviewed,
// committed code runs with the operator's ssh keys.
async function checkScript($: EngineInterface, cwd: string, script: string): Promise<string> {
  if (!SAFE_SCRIPT.test(script)) return `progress-check path not allowed: ${script}`
  if (!script.startsWith(SCRIPT_DIR)) return `progress-check not under ${SCRIPT_DIR}, not run: ${script}`
  const tracked = await git($, cwd, ['ls-files', '--error-unmatch', '--', script])
  if (tracked.exitCode !== 0) return `progress-check not committed: ${script}`
  const clean = await git($, cwd, ['diff', '--quiet', 'HEAD', '--', script])
  if (clean.exitCode !== 0) return `progress-check differs from HEAD, not run: ${script}`
  return ''
}

function cacheKey(path: string): string {
  return path.replace(/[^A-Za-z0-9._-]/g, '_')
}

async function readCache($: EngineInterface, file: string): Promise<CacheEntry | undefined> {
  try {
    const c = JSON.parse(await $.fs.read(file)) as CacheEntry
    return typeof c.blob === 'string' && typeof c.at === 'number' ? c : undefined
  } catch {
    return undefined
  }
}

// Runs the (already gated) script at most once per CACHE_TTL_MS across every session of this
// checkout. force skips the freshness test, never the lock.
async function runShared(
  $: EngineInterface,
  cwd: string,
  path: string,
  script: string,
  force: boolean,
): Promise<CacheEntry & { cached: boolean }> {
  const dir = `${cwd}/${CACHE_DIR}`
  const file = `${dir}/${cacheKey(path)}.json`
  const lock = `${dir}/${cacheKey(path)}.lock`
  const blobRun = await git($, cwd, ['rev-parse', `HEAD:${script}`])
  const blob = blobRun.stdout.trim()
  if (blobRun.exitCode !== 0 || blob === '') throw new Error(`rev-parse HEAD:${script} failed`)
  const isFresh = (c: CacheEntry | undefined, since: number) =>
    c !== undefined && c.blob === blob && c.at >= since

  const now = await $.clock.now()
  const before = await readCache($, file)
  if (!force && isFresh(before, now - CACHE_TTL_MS)) return { ...before!, cached: true }

  await ensureCacheDir($, cwd)
  let isOwner = (await $.process.run(['mkdir', lock], { cwd, timeoutMs: 5000 })).exitCode === 0
  if (!isOwner) {
    const st = await $.fs.stat(lock).catch(() => undefined)
    if (st === undefined || now - st.mtimeMs > LOCK_STALE_MS) {
      await $.process.run(['rmdir', lock], { cwd, timeoutMs: 5000 })
      isOwner = (await $.process.run(['mkdir', lock], { cwd, timeoutMs: 5000 })).exitCode === 0
    }
  }
  if (!isOwner) {
    // Another session is running this script: wait for its result instead of a second run.
    const deadline = now + SCRIPT_TIMEOUT_MS + 30 * 1000
    while ((await $.clock.now()) < deadline) {
      await $.clock.sleep(LOCK_POLL_MS)
      const c = await readCache($, file)
      if (isFresh(c, now)) return { ...c!, cached: true }
      if (!(await $.fs.exists(lock))) break
    }
    const c = await readCache($, file)
    if (isFresh(c, now - CACHE_TTL_MS)) return { ...c!, cached: true }
    throw new Error('another session holds the script lock; no fresh result yet')
  }
  try {
    const r = await $.process.run(['bash', script], { cwd, timeoutMs: SCRIPT_TIMEOUT_MS })
    const entry: CacheEntry = {
      blob,
      at: await $.clock.now(),
      exitCode: r.exitCode,
      stdout: r.stdout,
      stderr: r.stderr.slice(0, 2000),
    }
    // Write beside, then rename: a reader never sees a half-written file.
    await $.fs.write(`${file}.tmp`, JSON.stringify(entry))
    await $.process.run(['chmod', '600', `${file}.tmp`], { cwd, timeoutMs: 5000 })
    await $.process.run(['mv', '-f', `${file}.tmp`, file], { cwd, timeoutMs: 5000 })
    return { ...entry, cached: false }
  } finally {
    await $.process.run(['rmdir', lock], { cwd, timeoutMs: 5000 })
  }
}

async function loadTracker($: EngineInterface, cwd: string, path: string, force: boolean): Promise<Tracker> {
  let t: Tracker
  try {
    t = parseTracker(path, await $.fs.read(`${cwd}/${path}`))
  } catch (err) {
    return { path, name: shortName(path), title: path, isClosed: false, script: '', groups: [], rows: [], error: `read: ${String(err)}`, liveAt: '', lastChangeMs: 0 }
  }
  if (t.lastChangeMs === 0) {
    const st = await $.fs.stat(`${cwd}/${path}`).catch(() => undefined)
    t = { ...t, lastChangeMs: st?.mtimeMs ?? 0 }
  }
  if (t.script === '' || t.isClosed) return t
  const problem = await checkScript($, cwd, t.script)
  if (problem !== '') return { ...t, error: problem }
  try {
    const r = await runShared($, cwd, path, t.script, force)
    const rows = merge(t.rows, parseLive(r.stdout), t.groups.map(g => g.key))
    const error = r.exitCode !== 0 ? `script exit ${r.exitCode}: ${r.stderr.slice(0, 120)}` : ''
    const age = Math.round(((await $.clock.now()) - r.at) / 60000)
    return { ...t, rows, error, liveAt: r.cached ? `cached ${age} min` : 'run now' }
  } catch (err) {
    return { ...t, error: `script: ${String(err)}` }
  }
}

async function refresh($: EngineInterface, force = false): Promise<void> {
  const now = await read($, snapshot)
  if (now.isRunning) return
  await update($, snapshot, s => ({ ...s, isRunning: true }))
  const cwd = await $.session.cwd()
  let error = ''
  let paths: string[] = []
  try {
    paths = await discover($, cwd)
  } catch (err) {
    error = `discover: ${String(err)}`
  }
  const pin = await read($, pinned)
  const clock = await $.clock.now()
  const trackers: Tracker[] = []
  for (const p of paths) {
    const t = await loadTracker($, cwd, p, force)
    // Finished trackers leave after the grace period; the pinned one is always kept.
    if (t.path === pin || !isRetired(t, clock)) trackers.push(t)
  }
  const before = new Map(now.trackers.flatMap(t => t.rows.map(r => [`${t.path}#${r.id}`, r.state] as const)))
  const changed = trackers.flatMap(t =>
    t.rows
      .filter(r => before.has(`${t.path}#${r.id}`) && before.get(`${t.path}#${r.id}`) !== r.state)
      .map(r => `${t.name} ${r.id} ${before.get(`${t.path}#${r.id}`)} -> ${r.state}`),
  )
  const stamp = new Date().toISOString().slice(11, 16) + ' UTC'
  await update($, snapshot, () => ({ trackers, checkedAt: stamp, isRunning: false, error }))
  const line = error
    ? `ckpt ${stamp} | error: ${error.slice(0, 60)}`
    : paths.length === 0 ? '' : statusLine(trackers, stamp, pin)
  await writeStatus($, cwd, line)
  if (changed.length > 0) void $.ui.toast(changed.join(', '))
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'checkpoints',
      description: 'Open the checkpoint pane and refresh it; /checkpoints <slug> pins a tracker to this session, /checkpoints off unpins',
    })
    void refresh($)
    $.clock.every(EVERY_MS, () => void refresh($))
    return next(e)
  })

  on('command.run', { command: 'checkpoints' }, async ($, e) => {
    const arg = (e.args ?? '').trim()
    let pinText = ''
    if (arg === 'off' || arg === '-') {
      await update($, pinned, () => '')
      pinText = 'Unpinned; the status line shows every open tracker. '
    } else if (arg !== '') {
      const paths = await discover($, await $.session.cwd()).catch(() => [] as string[])
      const hit = matchTracker(paths, arg)
      if (hit.length !== 1) {
        const list = (hit.length > 1 ? hit : paths).map(p => `  ${p}`).join('\n')
        return {
          text: hit.length > 1
            ? `"${arg}" matches ${hit.length} trackers, be more specific:\n${list}`
            : `No tracker matches "${arg}". Trackers:\n${list || '  (none)'}`,
        }
      }
      await update($, pinned, () => hit[0] ?? '')
      pinText = `Pinned to this session: ${hit[0]}. `
    }
    // Half the terminal; the dock caps a pane at 45% of the columns.
    const width = e.presentation?.columns ?? 160
    await $.ui.open({ id: PANE, title: TITLE, columns: Math.max(24, Math.floor(width / 2)), rows: 24 })
    // An explicit open reruns scripts (shared lock still applies); a pin change only needs the cache.
    void refresh($, arg === '')
    return { text: `${pinText}Checkpoint pane opened; refresh started (scripts shared across sessions, cached up to ${Math.round(CACHE_TTL_MS / 60000)} min).` }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const s = await read($, snapshot)
    const wrapped = await read($, isWrapped)
    const wrap = wrapped ? 'wrap' : 'truncate-end'
    const pin = await read($, pinned)
    const only = await read($, onlyPinned)
    const hasPin = pin !== '' && s.trackers.some(t => t.path === pin)
    const ordered = [...s.trackers].sort((a, b) => (a.path === pin ? -1 : b.path === pin ? 1 : 0))
    // A tracker drawn as one line: closed ones always; with a pin and "only pinned" on, the others too.
    const toggled = await read($, toggledPaths)
    const withDone = await read($, showDone)
    // Everything that waits on the operator, across the open trackers, decidable rows first.
    const open = ordered.filter(t => !t.isClosed)
    const youNow = open.flatMap(t => waitingOn(t).now.map(w => ({ t, ...w })))
    const youLater = open.flatMap(t => waitingOn(t).later.map(w => ({ t, ...w })))
    const nameWidth = Math.max(0, ...[...youNow, ...youLater].map(w => w.t.name.length))
    // A click on a title inverts that tracker's default for this session (list `toggled`).
    const isBrief = (t: Tracker) =>
      (t.isClosed || (hasPin && only && t.path !== pin)) !== toggled.includes(t.path)
    const flip = (path: string) =>
      void update($, toggledPaths, v => (v.includes(path) ? v.filter(p => p !== path) : [...v, path]))
    // The marker before a title: "*" on the pinned tracker (press = unpin), dim "pin" on the
    // others (press = pin that one). A pin change rewrites the status line and clears the
    // per-tracker toggles, since the defaults change with the pin.
    const setPin = async (path: string) => {
      const next = path === pin ? '' : path
      await update($, pinned, () => next)
      await update($, toggledPaths, () => [])
      await writeStatus($, await $.session.cwd(), statusLine(s.trackers, s.checkedAt, next))
    }
    const pinButton = (t: Tracker) => (
      <Button key={`p:${t.path}`} plain dimColor={t.path !== pin} onPress={() => void setPin(t.path)}>
        {t.path === pin ? '* ' : 'pin '}
      </Button>
    )
    // Overall count + bar, then one coloured figure per track: " 17/24 [#######...] A 10/11 B 3/9"
    const progress = (t: Tracker) => {
      const o = overall(t)
      return [
        <Text color={statColor(o)}>{` ${o.done}/${o.total} ${bar(o)}`}</Text>,
        ...trackStats(t).map(p => <Text color={statColor(p)}>{` ${p.key} ${p.done}/${p.total}`}</Text>),
      ]
    }
    return (
      <Box flexDirection="column">
        <Text dimColor wrap="truncate-end">focus me with ctrl+x tab, then r / w / d / q / p or Enter on a title</Text>
        <Box flexDirection="row">
          <Text dimColor wrap="truncate-end">
            {s.isRunning
              ? 'checking...'
              : s.checkedAt
                ? `checked ${s.checkedAt}, every 15 min`
                : 'not checked yet'}{' '}
          </Text>
          <Button key="refresh" label="Refresh" hotkey="r" onPress={() => void refresh($, true)} />
          <Text> </Text>
          <Button
            key="wrap"
            label={wrapped ? 'One line' : 'Wrap'}
            hotkey="w"
            onPress={() => void update($, isWrapped, v => !v)}
          />
          <Text> </Text>
          <Button
            key="done"
            label={withDone ? 'Done: fold' : 'Done: show'}
            hotkey="d"
            onPress={() => void update($, showDone, v => !v)}
          />
          <Text> </Text>
          <Button key="close" label="Close" hotkey="q" role="dismiss" onPress={() => void $.ui.close({ id: PANE })} />
          {hasPin && <Text> </Text>}
          {hasPin && (
            <Button
              key="only"
              label={only ? 'Others: full' : 'Others: titles'}
              hotkey="p"
              onPress={() => {
                void update($, onlyPinned, v => !v)
                void update($, toggledPaths, () => [])
              }}
            />
          )}
        </Box>
        {s.error !== '' && <Text color="error" wrap="truncate-end">{s.error}</Text>}
        {s.trackers.length === 0 && !s.isRunning && (
          <Text dimColor>no *-checkpoints-*.md tracker found</Text>
        )}
        {(youNow.length > 0 || youLater.length > 0) && (
          <Box key="you" flexDirection="column" marginTop={1}>
            <Text bold color="permission">{`Waiting on you now (${youNow.length})`}</Text>
            {youNow.map(w => (
              <Text wrap={wrap}>
                <Text dimColor>{`${w.t.name.padEnd(nameWidth)} `}</Text>
                <Text color="permission">{w.row.id.padEnd(4)}</Text>
                {w.row.title}
              </Text>
            ))}
            {youLater.length > 0 && (
              <Text dimColor>{`later (${youLater.length}) - a prerequisite is still open`}</Text>
            )}
            {youLater.map(w => (
              <Text dimColor wrap={wrap}>
                {`${w.t.name.padEnd(nameWidth)} ${w.row.id.padEnd(4)}${w.row.title} (after ${w.after.join(' ')})`}
              </Text>
            ))}
          </Box>
        )}
        {ordered.map(t => isBrief(t) ? (
          <Box key={`b:${t.path}`} flexDirection="row">
            {pinButton(t)}
            <Button key={`t:${t.path}`} plain onPress={() => flip(t.path)}>
              {t.isClosed ? `${t.name} (closed)` : t.name}
              {!t.isClosed && progress(t)}
              <Text dimColor>{summaryTail(t) !== '' ? ` | ${summaryTail(t)}` : ''}</Text>
            </Button>
          </Box>
        ) : (
          <Box key={`f:${t.path}`} flexDirection="column" marginTop={1}>
            <Box flexDirection="row">
              {pinButton(t)}
              <Button key={`t:${t.path}`} plain onPress={() => flip(t.path)}>
                {`${t.name}${t.path === pin ? ' (pinned)' : ''}${t.isClosed ? ' (closed)' : ''}`}
                {progress(t)}
              </Button>
            </Box>
            <Text dimColor wrap="truncate-end">
              {t.path}
              {t.liveAt !== '' ? ` - script ${t.liveAt}` : ''}
            </Text>
            {t.error !== '' && <Text color="error" wrap={wrap}>{t.error}</Text>}
            {
              [...new Set(t.rows.map(r => groupOf(r.id)))].map(g => (
                <Box flexDirection="column" marginTop={1}>
                  <Text bold>
                    {t.groups.find(x => x.key === g)?.title ?? g}
                    {trackStats(t).filter(p => p.key === g).map(p => (
                      <Text color={statColor(p)}>{`  ${p.done}/${p.total}`}</Text>
                    ))}
                  </Text>
                  {t.rows
                    .filter(r => groupOf(r.id) === g && (withDone || !isDoneState(r.state)))
                    .map(r => {
                      // OPERATOR behind an open prerequisite: dimmed, with what it waits for.
                      const after = r.state === 'OPERATOR' ? blockers(t, r) : []
                      return (
                        <Text wrap={wrap}>
                          <Text color={after.length > 0 ? 'inactive' : color(r.state)}>{r.state.padEnd(9)}</Text>
                          {r.id.padEnd(4)}
                          {r.title}
                          {after.length > 0 && <Text dimColor>{` (after ${after.join(' ')})`}</Text>}
                          <Text dimColor>{r.note ? ` - ${r.note}` : ''}</Text>
                        </Text>
                      )
                    })}
                  {!withDone && (() => {
                    // Folded DONE/OK rows of a track that still has open ones: count and IDs.
                    const rows = t.rows.filter(r => groupOf(r.id) === g)
                    const done = rows.filter(r => isDoneState(r.state))
                    if (done.length === 0 || done.length === rows.length) return null
                    return (
                      <Text dimColor wrap="truncate-end">
                        {`+ ${done.length} done: ${done.map(r => r.id).join(' ')}`}
                      </Text>
                    )
                  })()}
                </Box>
              ))}
          </Box>
        ))}
      </Box>
    )
  })
}
