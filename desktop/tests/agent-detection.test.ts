import assert from 'node:assert/strict'
import test from 'node:test'
import { runLatestAgentDetection } from '../src/lib/agent-detection-state.ts'
import type { AgentInfo } from '../src/lib/tauri.ts'

function agent(key: string): AgentInfo {
  return { key, name: key, dir: `~/.${key}/skills`, detected: true, detectionSource: 'cli', skillsStatus: 'ready' }
}

function deferred<Value>() {
  let resolve!: (value: Value) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<Value>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

test('Agent detection preserves successful empty results and retains data on failures', async () => {
  let capabilities = [agent('claude')]
  let status: 'checking' | 'success' | 'error' = 'success'
  const run = (detect: () => Promise<AgentInfo[]>) => runLatestAgentDetection(
    detect,
    (value) => { capabilities = value },
    (value) => { status = value },
  )

  const empty = await run(async () => [])
  assert.deepEqual(empty, { status: 'success', value: [] })
  assert.deepEqual(capabilities, [])
  assert.equal(status, 'success')

  const known = [agent('codex')]
  capabilities = known
  const failed = await run(async () => { throw new Error('offline') })
  assert.equal(failed.status, 'error')
  assert.strictEqual(capabilities, known)
  assert.equal(status, 'error')

  capabilities = []
  await run(async () => { throw new Error('first detection failed') })
  assert.deepEqual(capabilities, [])
  assert.equal(status, 'error')
})

test('only the newest Agent detection request can commit success or failure', async () => {
  let capabilities = [agent('codex')]
  let status: 'checking' | 'success' | 'error' = 'success'
  const run = (detect: () => Promise<AgentInfo[]>) => runLatestAgentDetection(
    detect,
    (value) => { capabilities = value },
    (value) => { status = value },
  )
  const slowFailure = deferred<AgentInfo[]>()
  const fastSuccess = deferred<AgentInfo[]>()
  const olderFailure = run(() => slowFailure.promise)
  const newerSuccess = run(() => fastSuccess.promise)
  fastSuccess.resolve([agent('claude')])
  assert.equal((await newerSuccess).status, 'success')
  slowFailure.reject(new Error('late failure'))
  assert.deepEqual(await olderFailure, { status: 'stale' })
  assert.deepEqual(capabilities.map(({ key }) => key), ['claude'])
  assert.equal(status, 'success')

  const slowSuccess = deferred<AgentInfo[]>()
  const olderSuccess = run(() => slowSuccess.promise)
  const latestFailure = await run(async () => { throw new Error('latest failure') })
  assert.equal(latestFailure.status, 'error')
  slowSuccess.resolve([agent('codex')])
  assert.deepEqual(await olderSuccess, { status: 'stale' })
  assert.deepEqual(capabilities.map(({ key }) => key), ['claude'])
  assert.equal(status, 'error')
})
