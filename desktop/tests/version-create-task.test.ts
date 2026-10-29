import assert from 'node:assert/strict'
import test from 'node:test'
import { VersionCreateTasks, versionTaskBlocks, versionTaskKey, type VersionTaskEnvironment, type VersionTaskInput, type VersionTask } from '../src/lib/version-create-task.ts'
import type { ApiSkillVersion } from '../src/lib/api.ts'
import type { FrozenVersionPackage } from '../src/lib/tauri.ts'

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (error: unknown) => void } {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((ok, fail) => { resolve = ok; reject = fail })
  return { promise, resolve, reject }
}
const tick = (): Promise<void> => new Promise(done => setImmediate(done))
const input: VersionTaskInput = { managedSkillId: 'local', accountId: 'a', space: { spaceId: 'official', generation: 1 }, version: '0.1.1', changelog: 'A', allocation: 'auto', serverId: 'server' }
const frozen = { package: { base64: 'zip-A', sha256: 'sha-A' }, skillMd: '# A', envDependencies: [{ key: 'A_KEY', required: true }] } as FrozenVersionPackage
const remote = { id: 'remote-version', version: '0.1.1' } as ApiSkillVersion
function harness(overrides: Partial<VersionTaskEnvironment> = {}) {
  let identity = { ...input }
  const requests: NonNullable<VersionTask['request']>[] = []
  const records: { task: VersionTask; token: string }[] = []
  const releases: string[] = []
  const notices: string[] = []
  let packages = 0
  let refreshes = 0
  const env: VersionTaskEnvironment = {
    matches: candidate => versionTaskKey(candidate) === versionTaskKey(identity),
    freeze: async () => 'frozen-A',
    package: async () => { packages++; return frozen },
    publish: async (_task, request) => { requests.push(request); return remote },
    record: async (task, token) => { records.push({ task, token }) },
    refresh: async () => { refreshes++ },
    release: async token => { releases.push(token) },
    status: error => typeof error === 'number' ? error : null,
    message: error => String(error),
    notify: message => { notices.push(message) },
    ...overrides,
  }
  const tasks = new VersionCreateTasks(env)
  return { tasks, env, requests, records, releases, notices, packages: () => packages, refreshes: () => refreshes,
    get: () => tasks.get(versionTaskKey(input)), switch: (changes: Partial<VersionTaskInput>) => { identity = { ...identity, ...changes }; tasks.cancelStale() } }
}

test('acceptance resolves before slow upload; task survives unsubscribe and blocks duplicates', async () => {
  const upload = deferred<ApiSkillVersion>()
  const h = harness({ publish: () => upload.promise })
  const unsubscribe = h.tasks.subscribe(() => {})
  await h.tasks.start(input)
  await tick()
  assert.equal(h.get()?.phase, 'publishing')
  unsubscribe()
  await assert.rejects(h.tasks.start(input), /已有版本任务/)
  upload.resolve(remote)
  await tick()
  assert.equal(h.get()?.phase, 'succeeded')
  assert.equal(h.records[0].token, 'frozen-A')
  assert.equal(h.refreshes(), 1)
  assert.deepEqual(h.releases, ['frozen-A'])
})

test('network and 5xx retry identical request object and snapshot without repackaging', async () => {
  const requests: NonNullable<VersionTask['request']>[] = []
  const h = harness({ publish: async (_task, request) => { requests.push(request); if (requests.length === 1) throw new Error('network'); if (requests.length === 2) throw 503; return remote } })
  await h.tasks.start(input)
  await tick()
  assert.equal(h.get()?.phase, 'failed')
  await assert.rejects(h.tasks.start({ ...input, changelog: 'B' }))
  h.tasks.retry(versionTaskKey(input))
  await tick()
  h.tasks.retry(versionTaskKey(input))
  await tick()
  assert.equal(h.packages(), 1)
  assert.equal(requests.length, 3)
  assert.strictEqual(requests[0], requests[1])
  assert.strictEqual(requests[1], requests[2])
  assert.equal(requests[2].skillMd, '# A')
  assert.deepEqual(requests[2].envDependencies, frozen.envDependencies)
  assert.equal(h.get()?.phase, 'succeeded')
})

for (const status of [400, 401, 409]) test(`explicit ${status} releases request and permits corrected submission`, async () => {
  const h = harness({ publish: async () => { throw status } })
  await h.tasks.start(input)
  await tick()
  assert.equal(h.get()?.phase, 'rejected')
  assert.equal(versionTaskBlocks(h.get()), false)
  assert.equal(h.get()?.request, undefined)
  h.env.publish = async () => remote
  await h.tasks.start({ ...input, version: '0.1.2' })
  await tick()
  assert.equal(h.get()?.phase, 'succeeded')
})

test('freeze failure stays caller-visible and does not enqueue background work', async () => {
  const h = harness({ freeze: async () => { throw new Error('freeze failed') } })
  await assert.rejects(h.tasks.start(input), /freeze failed/)
  assert.equal(h.packages(), 0)
  assert.equal(versionTaskBlocks(h.get()), false)
  assert.equal(h.get()?.error, undefined)
  assert.deepEqual(h.notices, [])
})

test('deterministic packaging failure releases snapshot and allows corrected content', async () => {
  const h = harness({ package: async () => { throw new Error('invalid declaration') } })
  await h.tasks.start(input)
  await tick()
  assert.equal(h.get()?.phase, 'rejected')
  assert.deepEqual(h.releases, ['frozen-A'])
  h.env.package = async () => frozen
  await h.tasks.start(input)
  await tick()
  assert.equal(h.get()?.phase, 'succeeded')
})

for (const changes of [{ accountId: 'b' }, { space: { spaceId: 'selfhost', generation: 2 } }, { space: { spaceId: 'official', generation: 2 } }]) test(`identity switch ${JSON.stringify(changes)} discards late upload callback`, async () => {
  const upload = deferred<ApiSkillVersion>()
  const h = harness({ publish: () => upload.promise })
  await h.tasks.start(input)
  await tick()
  h.switch(changes)
  upload.resolve(remote)
  await tick()
  assert.equal(h.get()?.phase, 'cancelled')
  assert.equal(h.records.length, 0)
  assert.equal(h.refreshes(), 0)
  assert.equal(h.notices.length, 0)
})

test('switch while freezing releases late snapshot without accepting task', async () => {
  const freeze = deferred<string>()
  const h = harness({ freeze: () => freeze.promise })
  const starting = h.tasks.start(input)
  h.switch({ accountId: 'b' })
  freeze.resolve('late-token')
  await assert.rejects(starting, /账号或空间已切换/)
  assert.deepEqual(h.releases, ['late-token'])
  assert.equal(h.packages(), 0)
})

test('known remote success retries only local record; can defer to history repair', async () => {
  const h = harness({ record: async () => { throw new Error('B differs from A') } })
  await h.tasks.start(input)
  await tick()
  assert.equal(h.get()?.result?.id, remote.id)
  h.tasks.retry(versionTaskKey(input))
  await tick()
  assert.equal(h.requests.length, 1)
  assert.equal(h.packages(), 1)
  h.tasks.deferRecord(versionTaskKey(input))
  assert.equal(versionTaskBlocks(h.get()), false)
  assert.equal(h.get()?.result?.id, remote.id)
})

test('local save and remote repair use frozen token and never package or publish', async () => {
  for (const repair of [undefined, remote]) {
    const record = deferred<void>()
    const h = harness({ record: async (task, token) => { assert.equal(token, 'frozen-A'); assert.equal(task.result, repair); await record.promise } })
    await h.tasks.start({ ...input, serverId: undefined, repair })
    assert.equal(h.get()?.phase, 'recording')
    assert.equal(h.requests.length, 0)
    assert.equal(h.packages(), 0)
    record.resolve()
    await tick()
    assert.equal(h.get()?.phase, 'succeeded')
  }
})

test('late local record completion after switch cannot refresh the new identity', async () => {
  const record = deferred<void>()
  const h = harness({ record: () => record.promise })
  await h.tasks.start({ ...input, serverId: undefined })
  h.switch({ accountId: 'b' })
  record.resolve()
  await tick()
  assert.equal(h.get()?.phase, 'cancelled')
  assert.equal(h.refreshes(), 0)
})

test('unknown publish result requires explicit abandonment to release snapshot and unblock', async () => {
  const h = harness({ publish: async () => { throw 503 } })
  await h.tasks.start(input)
  await tick()
  h.tasks.deferRecord(versionTaskKey(input))
  assert.equal(h.get()?.phase, 'failed')
  assert.equal(h.get()?.token, 'frozen-A')
  await assert.rejects(h.tasks.start({ ...input, version: '0.1.2' }))
  h.tasks.abandonUnknown(versionTaskKey(input))
  assert.equal(versionTaskBlocks(h.get()), false)
  assert.equal(h.get()?.token, undefined)
  assert.equal(h.get()?.request, undefined)
  assert.equal(h.get()?.error, undefined)
  assert.deepEqual(h.releases, ['frozen-A'])
  assert.match(h.notices.at(-1)!, /远端结果仍未知，未回滚.*版本历史核对/)
  h.env.publish = async () => remote
  await h.tasks.start({ ...input, version: '0.1.2' })
  await tick()
  assert.equal(h.get()?.phase, 'succeeded')
})

test('abandonment cannot release an in-flight publish or known remote result', async () => {
  const upload = deferred<ApiSkillVersion>()
  const h = harness({ publish: () => upload.promise, record: async () => { throw new Error('record failed') } })
  await h.tasks.start(input)
  await tick()
  h.tasks.abandonUnknown(versionTaskKey(input))
  assert.equal(h.get()?.phase, 'publishing')
  assert.deepEqual(h.releases, [])
  upload.resolve(remote)
  await tick()
  h.tasks.abandonUnknown(versionTaskKey(input))
  assert.equal(h.get()?.phase, 'failed')
  assert.equal(h.get()?.result, remote)
  assert.deepEqual(h.releases, [])
})

test('refresh failure retries refresh only, keeping already recorded snapshot', async () => {
  const h = harness({ refresh: async () => { throw new Error('readback failed') } })
  await h.tasks.start(input)
  await tick()
  assert.equal(h.get()?.recorded, true)
  h.env.refresh = async () => {}
  h.tasks.retry(versionTaskKey(input))
  await tick()
  assert.equal(h.get()?.phase, 'succeeded')
  assert.equal(h.records.length, 1)
  assert.equal(h.requests.length, 1)
})

test('local allocation failure can end the frozen attempt and recheck a newer number', async () => {
  const h = harness({ record: async () => { throw new Error('high water changed') } })
  await h.tasks.start({ ...input, serverId: undefined })
  await tick()
  assert.equal(h.get()?.phase, 'failed')
  h.tasks.deferRecord(versionTaskKey(input))
  assert.equal(versionTaskBlocks(h.get()), false)
  h.env.record = async () => {}
  await h.tasks.start({ ...input, version: '0.1.2', serverId: undefined })
  await tick()
  assert.equal(h.get()?.phase, 'succeeded')
  assert.equal(h.get()?.version, '0.1.2')
})
