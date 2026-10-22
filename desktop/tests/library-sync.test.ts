import assert from 'node:assert/strict'
import test from 'node:test'
import {
  startLibrarySync,
  type LibrarySyncReport,
} from '../src/lib/library-sync.ts'

const emptyReport: LibrarySyncReport = {
  uploaded: 0,
  downloaded: 0,
  profilesUpdated: 0,
  copiesCreated: 0,
  trashed: 0,
  bound: 0,
  keptLocal: 0,
  problems: [],
}

type Harness = {
  runs: number
  results: { report?: LibrarySyncReport; error?: string }[]
  delays: number[]
  pending: (() => void) | null
  visible: boolean
  release: (() => void) | null
  failNext: boolean
}

function harness(options: { hold?: boolean } = {}) {
  const state: Harness = { runs: 0, results: [], delays: [], pending: null, visible: true, release: null, failNext: false }
  const scheduler = startLibrarySync({
    run: async () => {
      state.runs += 1
      if (options.hold) await new Promise<void>((resolve) => { state.release = resolve })
      if (state.failNext) {
        state.failNext = false
        throw new Error('offline')
      }
      return emptyReport
    },
    onResult: (result) => { state.results.push(result) },
    isVisible: () => state.visible,
    setTimer: (callback, ms) => {
      state.pending = callback
      state.delays.push(ms)
      return 0 as unknown as ReturnType<typeof setTimeout>
    },
    clearTimer: () => { state.pending = null },
  })
  const settle = async (): Promise<void> => { await new Promise((resolve) => setImmediate(resolve)) }
  return { state, scheduler, settle }
}

test('Library sync runs at start, then every 30 s while visible and 5 min while hidden', async () => {
  const { state, scheduler, settle } = harness()
  await settle()
  assert.equal(state.runs, 1)
  assert.deepEqual(state.delays, [30_000])
  state.visible = false
  state.pending?.()
  await settle()
  assert.equal(state.runs, 2)
  assert.equal(state.delays.at(-1), 300_000)
  scheduler.stop()
})

test('Library sync never overlaps passes and queues one follow-up', async () => {
  const { state, scheduler, settle } = harness({ hold: true })
  await settle()
  assert.equal(state.runs, 1)
  scheduler.trigger()
  scheduler.trigger()
  await settle()
  assert.equal(state.runs, 1, 'a trigger during a pass waits')
  state.release?.()
  await settle()
  assert.equal(state.runs, 2, 'exactly one queued follow-up pass')
  state.release?.()
  await settle()
  assert.equal(state.runs, 2)
  scheduler.stop()
})

test('Library sync reports failures and keeps scheduling', async () => {
  const { state, scheduler, settle } = harness()
  await settle()
  state.failNext = true
  scheduler.trigger()
  await settle()
  assert.equal(state.results.at(-1)?.error, 'offline')
  assert.ok(state.pending, 'next pass is scheduled after a failure')
  scheduler.stop()
  state.pending = null
  scheduler.trigger()
  await settle()
  assert.equal(state.runs, 2, 'stopped scheduler ignores triggers')
})

