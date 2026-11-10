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
    })
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    expect((await ui.find({ type: 'Button', key: `t:${closed.path}` }))).toBeDefined()
    expect((await ui.find({ type: 'Button', key: `r:${TRACKER.path}#B1` }))).toBeDefined()
    await ui.unmount()
  })
}
