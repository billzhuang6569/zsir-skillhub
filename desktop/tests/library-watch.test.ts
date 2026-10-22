import assert from 'node:assert/strict'
import test from 'node:test'
import { startLibraryWatch } from '../src/lib/library-watch.ts'

type Harness = {
  fingerprints: string[]
  visible: boolean
  reloads: number
  pending: (() => void) | null
  reads: number
}

function harness(fingerprints: string[]): { state: Harness; stop: () => void; step: () => Promise<void> } {
  const state: Harness = { fingerprints, visible: true, reloads: 0, pending: null, reads: 0 }
  const stop = startLibraryWatch({
    readFingerprint: async () => {
      state.reads += 1
      return state.fingerprints.shift() ?? 'unchanged'
    },
    onChange: async () => { state.reloads += 1 },
    isVisible: () => state.visible,
    setTimer: (callback) => {
      state.pending = callback
      return 0 as unknown as ReturnType<typeof setTimeout>
    },
    clearTimer: () => { state.pending = null },
  })
  const step = async (): Promise<void> => {
    const callback = state.pending
    state.pending = null
    callback?.()
    await new Promise((resolve) => setImmediate(resolve))
  }
  return { state, stop, step }
}

test('Library watch reloads once per change and adopts the post-reload baseline', async () => {
  const { state, stop, step } = harness(['a', 'a', 'b', 'c', 'c'])
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(state.reloads, 0, 'first read only sets the baseline')
  await step()
  assert.equal(state.reloads, 0, 'unchanged fingerprint does not reload')
  await step()
  assert.equal(state.reloads, 1, 'a change reloads')
  // After the reload the baseline is re-read ("c"), so SkillHub's own writes
  // during the reload do not cause a second reload.
  await step()
  assert.equal(state.reloads, 1)
  stop()
})

test('Library watch stays idle while the window is hidden and stops cleanly', async () => {
  const { state, stop, step } = harness(['a', 'b'])
  await new Promise((resolve) => setImmediate(resolve))
  state.visible = false
  const readsWhileHidden = state.reads
  await step()
  await step()
  assert.equal(state.reads, readsWhileHidden)
  assert.equal(state.reloads, 0)
  stop()
  assert.equal(state.pending, null)
})
