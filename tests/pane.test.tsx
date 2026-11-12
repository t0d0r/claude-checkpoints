import { expect, test } from 'claude-code/testing'

// The pane as the engine mounts it; the engine validates the tree the render hook returns,
// so a tree it refuses fails here instead of leaving an empty pane.
const PANE = {
  plugin: 'checkpoints',
  component: 'Pane',
  requestId: 'checkpoints',
  props: {
    title: 'checkpoints',
    isFocused: false,
    bodyColumns: 80,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 24 },
    view: {},
  },
} as const

const row = (id: string, state: string, deps: string[] = []) => ({
  id, state, title: `checkpoint ${id}`, note: 'a note', source: 'tracker', deps, sinceMs: 0, line: 12,
})

const TRACKER = {
  path: 'docs/2026-01-15-0930-checkpoints-demo.md',
  name: 'demo',
  title: 'Demo',
  isClosed: false,
  script: '',
  groups: [{ key: 'A', title: 'A - First' }, { key: 'B', title: 'B - Second' }],
  rows: [row('A1', 'DONE'), row('A2', 'OPERATOR'), row('B1', 'BLOCKED'), row('B2', 'OPERATOR', ['B1'])],
  error: '',
  liveAt: '',
  lastChangeMs: 0,
  log: [{ atMs: 1768469400000, text: 'A1 DONE' }],
}

const SNAPSHOT_VALUE = { trackers: [TRACKER], retired: ['old-one'], cwd: '/proj', checkedAt: '10:00 UTC', isRunning: false, error: '' }

// The snapshot atom names a shape: the stored value carries the tag.
const SNAPSHOT = { shape: 'snapshot-7', value: SNAPSHOT_VALUE }

// Seeds $.state: the snapshot plus whatever the case sets; any other key reads as unset.
const seed = (on: any, values: Record<string, unknown>) =>
  on('state.get', (_: unknown, e: any, next: any) => {
    const key = e?.key ?? e?.ref?.key
    return key in values ? { value: { value: values[key], version: 1 } } : next(e)
  })

for (const style of ['modern', 'ascii'] as const) {
  test(`overview draws the tracker title (${style})`, async ($, on) => {
    seed(on, { snapshot: SNAPSHOT, style })
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    expect((await ui.find({ type: 'Text', text: /demo/ }))?.text).toBeDefined()
    await ui.unmount()
  })

  test(`an opened tracker draws its rows, one of them opened (${style})`, async ($, on) => {
    seed(on, {
      snapshot: SNAPSHOT,
      style,
      toggled: [TRACKER.path],
      expanded: [`${TRACKER.path}#A2`],
    })
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    expect((await ui.find({ type: 'Button', key: `r:${TRACKER.path}#B1` }))).toBeDefined()
    // The opened row's link to the tracker file and line.
    expect((await ui.find({ type: 'Link' }))).toBeDefined()
    // The waiting block, unfolded: one row decidable now, one behind B1.
    expect((await ui.find({ type: 'Button', key: `y:${TRACKER.path}#A2` }))).toBeDefined()
    expect((await ui.find({ type: 'Button', key: `y:${TRACKER.path}#B2` }))).toBeDefined()
    await ui.unmount()
  })

  for (const filter of ['all', 'you', 'hot']) {
    test(`filter ${filter} with done rows and wrap draws (${style})`, async ($, on) => {
      seed(on, { snapshot: SNAPSHOT, style, toggled: [TRACKER.path], filter, showDone: true, isWrapped: true })
      const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
      expect((await ui.find({ type: 'Button', key: 'filter' }))).toBeDefined()
      await ui.unmount()
    })
  }

  test(`a pinned tracker and a closed one draw (${style})`, async ($, on) => {
    const closed = { ...TRACKER, path: 'docs/2026-01-10-0900-checkpoints-old.md', name: 'old', isClosed: true }
    seed(on, {
      snapshot: { shape: 'snapshot-7', value: { ...SNAPSHOT_VALUE, trackers: [TRACKER, closed] } },
      style,
      pinned: TRACKER.path,
      toggled: [TRACKER.path],
    })
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    expect((await ui.find({ type: 'Button', key: `t:${closed.path}` }))).toBeDefined()
    expect((await ui.find({ type: 'Button', key: `r:${TRACKER.path}#B1` }))).toBeDefined()
    await ui.unmount()
  })

  // The starting view: every tracker a title line, the pinned one too; done rows are listed
  // once a tracker is opened.
  test(`the pane starts as an overview, the pinned tracker a title line as well (${style})`, async ($, on) => {
    seed(on, { snapshot: SNAPSHOT, style, pinned: TRACKER.path })
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    expect((await ui.find({ type: 'Button', key: `t:${TRACKER.path}` }))).toBeDefined()
    expect((await ui.find({ type: 'Button', key: `r:${TRACKER.path}#B1` }))).toBeUndefined()
    // The waiting block is folded while every tracker is a title line.
    expect((await ui.find({ type: 'Button', key: `y:${TRACKER.path}#A2` }))).toBeUndefined()
    await ui.unmount()
  })

  test(`done rows are listed by default in an opened tracker (${style})`, async ($, on) => {
    seed(on, { snapshot: SNAPSHOT, style, toggled: [TRACKER.path] })
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    expect((await ui.find({ type: 'Button', key: `r:${TRACKER.path}#A1` }))).toBeDefined()
    await ui.unmount()
  })
  // The waiting block keeps the state its heading was pressed into, whatever the trackers do:
  // folding the last open tracker changes the block's default, not the user's choice.
  for (const [label, toggled] of [['open', [TRACKER.path]], ['folded', []]] as const) {
    test(`a folded waiting block stays folded with the tracker ${label} (${style})`, async ($, on) => {
      seed(on, { snapshot: SNAPSHOT, style, toggled, folded: ['you:folded'] })
      const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
      expect((await ui.find({ type: 'Button', key: 'h:you' }))).toBeDefined()
      expect((await ui.find({ type: 'Button', key: `y:${TRACKER.path}#A2` }))).toBeUndefined()
      await ui.unmount()
    })
  }

  test(`an opened waiting block stays open when every tracker is a title (${style})`, async ($, on) => {
    seed(on, { snapshot: SNAPSHOT, style, folded: ['you:open'] })
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    expect((await ui.find({ type: 'Button', key: `y:${TRACKER.path}#A2` }))).toBeDefined()
    await ui.unmount()
  })

  // Done rows are hidden by default and named in one line, also in a track that is complete.
  for (const showDone of [false, true]) {
    test(`done rows ${showDone ? 'show on request' : 'fold into a summary line'} (${style})`, async ($, on) => {
      const done = { ...TRACKER, rows: [row('A1', 'DONE'), row('A2', 'DONE'), row('A3', 'PENDING'), row('B1', 'BLOCKED')] }
      const snap = { shape: 'snapshot-7', value: { ...SNAPSHOT_VALUE, trackers: [done] } }
      seed(on, { snapshot: snap, style, toggled: [TRACKER.path], showDone })
      const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
      const a1 = await ui.find({ type: 'Button', key: `r:${TRACKER.path}#A1` })
      const summary = await ui.find({ type: 'Text', text: /2 done: A1 A2/ })
      if (showDone) {
        expect(a1).toBeDefined()
        expect(summary).toBeUndefined()
      } else {
        expect(a1).toBeUndefined()
        expect(summary).toBeDefined()
      }
      await ui.unmount()
    })
  }
  // A row filter hides rows, never silently a track: the tracks it empties are named in a line.
  test(`a track without matching rows is named under a filter (${style})`, async ($, on) => {
    const t = { ...TRACKER, groups: [...TRACKER.groups, { key: 'C', title: 'C - Third' }], rows: [...TRACKER.rows, row('C1', 'DONE')] }
    seed(on, { snapshot: { shape: 'snapshot-7', value: { ...SNAPSHOT_VALUE, trackers: [t] } }, style, toggled: [TRACKER.path], filter: 'you' })
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    expect((await ui.find({ type: 'Text', text: /Rows you leaves out: C 1\/1/ }))).toBeDefined()
    expect((await ui.find({ type: 'Button', key: `r:${TRACKER.path}#C1` }))).toBeUndefined()
    await ui.unmount()
  })
}
