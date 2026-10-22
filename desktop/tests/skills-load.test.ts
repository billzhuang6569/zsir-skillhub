import test from 'node:test'
import assert from 'node:assert/strict'
import { runSkillsLoad } from '../src/lib/skills-load.ts'

type Deferred<T> = { promise: Promise<T>; resolve: (value: T) => void; reject: (error: unknown) => void }
function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}
const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))

function sinks(current = () => true) {
  const log: string[] = []
  return {
    log,
    sinks: {
      isCurrent: current,
      messageOf: (error: unknown) => error instanceof Error ? error.message : String(error),
      publishLocal: (local: string[] | null, unmanaged: string[] | null) => { log.push(`local:${JSON.stringify(local)}/${JSON.stringify(unmanaged)}`) },
      publishOwned: (owned: string[]) => { log.push(`owned:${JSON.stringify(owned)}`) },
      publishOwnedFailure: (error: unknown) => { log.push(`owned-failed:${error instanceof Error ? error.message : String(error)}`) },
      publishError: (message: string | null) => { log.push(`error:${message}`) },
    },
  }
}

test('the native phase resolves while the Server is still pending; the cloud phase continues on its own', async () => {
  const owned = deferred<string[]>()
  const { log, sinks: s } = sinks()
  const result = await runSkillsLoad({ local: async () => ['a'], unmanaged: async () => ['u'], owned: () => owned.promise }, s)
  // Resolved without the cloud answer: the caller (and the coalescer) is free to start the next native read.
  assert.deepEqual(log, ['local:["a"]/["u"]', 'error:null'])
  assert.deepEqual({ ...result, cloud: result.cloud !== null }, { localFailed: false, unmanagedFailed: false, published: true, cloud: true })
  owned.resolve(['a-owned'])
  assert.deepEqual(await result.cloud, { ownedFailed: false })
  assert.deepEqual(log.slice(2), ['owned:["a-owned"]'])
})

test('a failing cloud request keeps the local publish and reports a partial error; signed out skips the cloud phase', async () => {
  const { log, sinks: s } = sinks()
  const result = await runSkillsLoad({ local: async () => ['a'], unmanaged: async () => ['u'], owned: async () => { throw new Error('Load failed') } }, s)
  assert.deepEqual(await result.cloud, { ownedFailed: true })
  assert.deepEqual(log, ['local:["a"]/["u"]', 'error:null', 'owned-failed:Load failed', 'error:部分数据暂不可用：Load failed'])
  const guest = sinks()
  const signedOut = await runSkillsLoad({ local: async () => ['a'], unmanaged: async () => ['u'], owned: null }, guest.sinks)
  assert.equal(signedOut.cloud, null)
  assert.deepEqual(guest.log, ['local:["a"]/["u"]', 'error:null'])
})

test('source failures are kept apart: one native source failing never empties the other', async () => {
  const { log, sinks: s } = sinks()
  await runSkillsLoad({ local: async () => { throw new Error('disk') }, unmanaged: async () => ['u'], owned: null }, s)
  assert.deepEqual(log, ['local:null/["u"]', 'error:部分数据暂不可用：disk'])
  const both = sinks()
  await runSkillsLoad({ local: async () => { throw new Error('disk') }, unmanaged: async () => { throw new Error('scan') }, owned: null }, both.sinks)
  assert.deepEqual(both.log, ['local:null/null', 'error:无法读取本机 Skill：disk；scan'])
})

test('a second native refresh starts and publishes while the first cloud answer is still pending; the stale answer is dropped', async () => {
  // One shared in-flight owned request (as the page de-duplicates per account).
  const owned = deferred<string[]>()
  let generation = 0
  const run = (local: string[], mine: number) => {
    const { log, sinks: s } = sinks(() => generation === mine)
    const started = runSkillsLoad({ local: async () => local, unmanaged: async () => ['u'], owned: () => owned.promise }, s)
    return { log, started }
  }
  generation = 1
  const first = run(['v1'], 1)
  const firstResult = await first.started
  assert.deepEqual(first.log, ['local:["v1"]/["u"]', 'error:null'])
  // Local change while the cloud is slow: the next native read runs now.
  generation = 2
  const second = run(['v2'], 2)
  const secondResult = await second.started
  assert.deepEqual(second.log, ['local:["v2"]/["u"]', 'error:null'], 'second native publish not blocked by the first cloud wait')
  owned.resolve(['owned'])
  await Promise.all([firstResult.cloud, secondResult.cloud])
  assert.deepEqual(first.log.slice(2), [], 'the stale run never publishes the cloud answer over the newer local list')
  assert.deepEqual(second.log.slice(2), ['owned:["owned"]'])
})

test('results that arrive after an account switch are dropped', async () => {
  let current = true
  const owned = deferred<string[]>()
  const { log, sinks: s } = sinks(() => current)
  const result = await runSkillsLoad({ local: async () => ['a'], unmanaged: async () => ['u'], owned: () => owned.promise }, s)
  assert.equal(log.length, 2)
  current = false
  owned.resolve(['stale'])
  await result.cloud
  assert.equal(log.length, 2, 'the stale cloud answer is not published')
  const never = sinks(() => false)
  const skipped = await runSkillsLoad({ local: async () => ['a'], unmanaged: async () => ['u'], owned: null }, never.sinks)
  assert.deepEqual(never.log, [])
  assert.equal(skipped.published, false)
})
