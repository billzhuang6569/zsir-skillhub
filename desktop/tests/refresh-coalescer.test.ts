import test from 'node:test'
import assert from 'node:assert/strict'
import { createRefreshCoalescer } from '../src/lib/refresh-coalescer.ts'

type Deferred = { promise: Promise<void>; resolve: () => void; reject: (error: unknown) => void }
function deferred(): Deferred {
  let resolve!: () => void
  let reject!: (error: unknown) => void
  const promise = new Promise<void>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}
const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))

test('overlapping refresh asks collapse into one running read plus one follow-up', async () => {
  const runs: Array<{ silent: boolean; gate: Deferred }> = []
  const coalescer = createRefreshCoalescer(async (silent) => {
    const gate = deferred()
    runs.push({ silent, gate })
    await gate.promise
  })
  const first = coalescer.request(true)
  await tick()
  assert.equal(runs.length, 1)
  assert.equal(coalescer.running, true)
  // Five more asks while the first read is in flight (focus, library events,
  // fingerprint ticks): remembered as one pending run, not five.
  const waiters = [coalescer.request(true), coalescer.request(false), coalescer.request(true), coalescer.request(true), coalescer.request(true)]
  await tick()
  assert.equal(runs.length, 1)
  assert.equal(coalescer.queued, true)
  runs[0].gate.resolve()
  await tick(); await tick()
  assert.equal(runs.length, 2, 'exactly one follow-up run')
  assert.equal(runs[1].silent, false, 'a loud ask queued behind silent ones keeps its loading state')
  let settled = 0
  for (const waiter of [first, ...waiters]) void waiter.then(() => { settled += 1 })
  await tick()
  assert.equal(settled, 0, 'callers resolve only when their refresh actually happened')
  runs[1].gate.resolve()
  await Promise.all([first, ...waiters])
  assert.equal(coalescer.running, false)
  assert.equal(coalescer.queued, false)
  // Idle again: a new ask starts a new run immediately.
  void coalescer.request(true)
  await tick()
  assert.equal(runs.length, 3)
  runs[2].gate.resolve()
})

test('a failing run neither breaks the chain nor drops a queued follow-up; cancel drops it', async () => {
  const runs: Deferred[] = []
  const coalescer = createRefreshCoalescer(async () => { const gate = deferred(); runs.push(gate); await gate.promise })
  const first = coalescer.request()
  await tick()
  void coalescer.request(true)
  runs[0].reject(new Error('native read failed'))
  await tick(); await tick()
  assert.equal(runs.length, 2, 'the queued run still starts after a failure')
  runs[1].resolve()
  await first
  // Cancel: an ask queued during a run is dropped on unmount / account switch.
  const second = coalescer.request()
  await tick()
  void coalescer.request(true)
  assert.equal(coalescer.queued, true)
  coalescer.cancel()
  assert.equal(coalescer.queued, false)
  runs[2].resolve()
  await second
  assert.equal(runs.length, 3)
})
