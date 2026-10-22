import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createKeyVaultLoader } from '../src/lib/key-vault-loader.ts'

const settle = async (): Promise<void> => { for (let i = 0; i < 10; i++) await Promise.resolve() }

test('concurrent reloads reuse the exact promise, then allow another round', async () => {
  let calls = 0
  let finish!: () => void
  const loader = createKeyVaultLoader(() => { calls++; return new Promise(resolve => { finish = resolve }) })
  const first = loader.reload()
  assert.equal(loader.reload(), first)
  await settle()
  assert.equal(calls, 1)
  finish()
  await first
  const next = loader.reload()
  assert.notEqual(next, first)
  await settle()
  assert.equal(calls, 2)
  finish()
  await next
})

test('a failed round releases the in-flight promise for retry', async () => {
  let calls = 0
  const loader = createKeyVaultLoader(async () => { if (++calls === 1) throw new Error('read failed') })
  await assert.rejects(loader.reload(), /read failed/)
  await loader.reload()
  assert.equal(calls, 2)
})

test('events debounce for 150 ms after the last event and cleanup cancels them', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let calls = 0
  const loader = createKeyVaultLoader(async () => { calls++ })
  loader.schedule()
  t.mock.timers.tick(100)
  loader.schedule()
  t.mock.timers.tick(149)
  await settle()
  assert.equal(calls, 0)
  t.mock.timers.tick(1)
  await settle()
  assert.equal(calls, 1)
  loader.schedule()
  loader.cancel()
  t.mock.timers.tick(150)
  await settle()
  assert.equal(calls, 1)
})

test('events during a read coalesce into one fresh read without overlapping', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let calls = 0
  let finish!: () => void
  const loader = createKeyVaultLoader(() => { calls++; return new Promise(resolve => { finish = resolve }) })
  const first = loader.reload()
  await settle()
  loader.schedule()
  t.mock.timers.tick(150)
  await settle()
  loader.schedule()
  t.mock.timers.tick(150)
  await settle()
  assert.equal(calls, 1)
  finish()
  await first
  await settle()
  assert.equal(calls, 2)
  const pending = loader.reload()
  finish()
  await pending
})

test('cleanup cancels a refresh waiting on an old account; a new loader is independent', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let oldCalls = 0
  let finish!: () => void
  const old = createKeyVaultLoader(() => { oldCalls++; return new Promise(resolve => { finish = resolve }) })
  const first = old.reload()
  await settle()
  old.schedule()
  t.mock.timers.tick(150)
  await settle()
  old.cancel()
  let newCalls = 0
  await createKeyVaultLoader(async () => { newCalls++ }).reload()
  assert.equal(newCalls, 1)
  finish()
  await first
  await settle()
  assert.equal(oldCalls, 1)
})
