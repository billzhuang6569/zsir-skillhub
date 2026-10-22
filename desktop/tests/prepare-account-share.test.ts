import { fixtureSpace } from './helpers/space.ts'
import type { SpaceHandle } from '../src/lib/tauri.ts'
import { serverFixture } from './helpers/server-ipc.ts'
import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import test from 'node:test'
import type { LocalSkill } from '../src/store/index.ts'

// Resolve the existing Vite .js imports to source for Node's TS test runner.
const hooks = registerHooks({ resolve(specifier, context, nextResolve) {
  if (context.parentURL?.includes('/src/lib/') && /^\.\/(api|tauri|team-share-flow|env-readiness)\.js$/.test(specifier)) {
    return nextResolve(specifier.replace(/\.js$/, '.ts'), context)
  }
  return nextResolve(specifier, context)
} })
const { prepareAccountTeamShare, SharePreparationUnknown } = await import('../src/lib/prepare-account-share.ts')
const { ApiError } = await import('../src/lib/api.ts')

hooks.deregister()

const receiptId = '00000000-0000-4000-8000-000000000011'
const formalId = '00000000-0000-4000-8000-000000000021'
const gitHash = 'a'.repeat(40)
const packageSha256 = 'b'.repeat(64)

function localSkill(): LocalSkill {
  return {
    id: 'local', name: 'sample', displayName: 'Sample', localPath: '/fixture/sample',
    version: '0.1.1', latestVersion: '0.1.1', versionStatus: 'confirmed', versionReceiptId: receiptId,
    labels: [], sources: [], agents: {}, installed: false, isOwn: true, installCount: 0,
    acquisitionSource: 'local', compatibleAgents: [], sharedTo: {},
    libraryAccountId: 'account', libraryEntryId: 'entry', serverId: 'server', serverOwnerId: 'account',
    envDeps: [{ key: 'SAMPLE_KEY', description: 'sample dependency', required: true, configured: false, sharePolicy: 'none' }],
    versions: [{ version: '0.1.1', gitHash, isCurrent: true, date: '2026-10-06' }],
  }
}

async function withPreparationFixture(run: (fixture: {
  skill: LocalSkill
  requests: { method: string; body?: Record<string, unknown> }[]
  recorded: Record<string, unknown>[]
  share: () => Promise<void>
  shares: () => number
  sessionMatches: () => boolean
  switchAccount: () => void
  failPost: (failure: 'network' | number) => void
  failRecord: () => void
  changeReceiptDuringPackaging: () => void
}) => Promise<void>): Promise<void> {
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
  const originalFetch = serverFixture.fetch
  const originalToken = serverFixture.space
  const skill = localSkill()
  const requests: { method: string; body?: Record<string, unknown> }[] = []
  const recorded: Record<string, unknown>[] = []
  let matching = true
  let postFailure: 'network' | number | null = null
  let recordingFails = false
  let changeReceipt = false
  let localReads = 0
  let shares = 0
  Object.defineProperty(globalThis, 'window', { configurable: true, value: {
    __TAURI_INTERNALS__: { invoke: async (command: string, args: Record<string, unknown>): Promise<unknown> => {
      if (['current_space', 'server_request', 'cancel_server_request'].includes(command)) return serverFixture.invoke(command, args)
      if (command === 'get_local_skills') {
        localReads++
        return [{ ...skill, versionReceiptId: changeReceipt && localReads >= 3 ? 'changed-receipt' : skill.versionReceiptId }]
      }
      if (command === 'library_author_asset') return { serverId: 'server', serverOwnerId: 'account', currentVersion: '0.1.0', contentMatchesVersion: false }
      if (command === 'create_skill_package') return { base64: 'UEs=', sha256: packageSha256, size: 4 }
      if (command === 'read_skill_md') return '# Sample'
      if (command === 'record_skill_formal_version') {
        recorded.push(args)
        if (recordingFails) throw new Error('formal mapping failed')
        return undefined
      }
      throw new Error(`Unexpected native command: ${command}`)
    } },
  } })
  setSpace(fixtureSpace('fixture.jwt'))
  serverFixture.fetch = async (input, init): Promise<Response> => {
    assert.match(String(input), /\/skills\/server\/versions$/)
    const method = init?.method ?? 'GET'
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : undefined
    requests.push({ method, body })
    if (method === 'POST' && postFailure === 'network') throw new Error('lost POST response')
    if (method === 'POST' && typeof postFailure === 'number') return new Response(JSON.stringify({ error: 'version refused' }), { status: postFailure })
    const formal = { id: formalId, skillId: 'server', version: '0.1.1', packageSha256,
      gitHash, changelog: '共享已保存的本机版本', createdAt: '2026-10-06' }
    return new Response(JSON.stringify(method === 'GET' ? [formal] : formal), { status: 200 })
  }
  try {
    await run({ skill, requests, recorded, share: async () => {
      await prepareAccountTeamShare(skill, 'account', () => matching)
      shares++
    }, shares: () => shares, sessionMatches: () => matching,
    switchAccount: () => { matching = false }, failPost: failure => { postFailure = failure },
    failRecord: () => { recordingFails = true }, changeReceiptDuringPackaging: () => { changeReceipt = true } })
  } finally {
    serverFixture.fetch = originalFetch
    if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow)
    else Reflect.deleteProperty(globalThis, 'window')
    if (originalToken) setSpace(originalToken)
    else serverFixture.space = { spaceId: 'official', generation: 0 }
  }
}

test('shared saved receipt is materialized with its UUID and the returned formal UUID is recorded', async () => {
  await withPreparationFixture(async fixture => {
    await fixture.share()
    assert.equal(fixture.requests.length, 1)
    assert.equal(fixture.requests[0].body?.libraryVersionReceiptId, receiptId)
    assert.deepEqual(fixture.requests[0].body?.envDependencies, [{ key: 'SAMPLE_KEY', description: 'sample dependency', required: true }])
    assert.deepEqual(fixture.recorded, [{ skillId: 'local', versionId: formalId, gitHash }])
    assert.equal(fixture.shares(), 1)
  })
})

test('sharing without an accepted receipt omits the optional protocol field', async () => {
  await withPreparationFixture(async fixture => {
    fixture.skill.versionReceiptId = undefined
    await fixture.share()
    assert.equal('libraryVersionReceiptId' in (fixture.requests[0].body ?? {}), false)
    assert.equal(fixture.recorded[0].versionId, formalId)
  })
})

test('lost or 5xx publish responses with matching public readback remain unknown and never record or share', async () => {
  for (const failure of ['network', 503] as const) await withPreparationFixture(async fixture => {
    fixture.failPost(failure)
    await assert.rejects(fixture.share(), error => error instanceof SharePreparationUnknown)
    assert.deepEqual(fixture.requests.map(request => request.method), ['POST', 'GET'])
    assert.equal(fixture.requests[0].body?.libraryVersionReceiptId, receiptId)
    assert.deepEqual(fixture.recorded, [])
    assert.equal(fixture.shares(), 0)
  })
})

function setSpace(space: SpaceHandle): void { serverFixture.space = space }

test('a definite 4xx publish refusal is not recovered from matching public metadata', async () => {
  await withPreparationFixture(async fixture => {
    fixture.failPost(409)
    await assert.rejects(fixture.share(), error => error instanceof ApiError && error.status === 409)
    assert.deepEqual(fixture.requests.map(request => request.method), ['POST'])
    assert.deepEqual(fixture.recorded, [])
    assert.equal(fixture.shares(), 0)
  })
})

test('failed local formal mapping blocks sharing and is not mislabeled as an unknown POST', async () => {
  await withPreparationFixture(async fixture => {
    fixture.failRecord()
    await assert.rejects(fixture.share(), error => error instanceof Error && !(error instanceof SharePreparationUnknown) && error.message === 'formal mapping failed')
    assert.equal(fixture.requests.length, 1)
    assert.equal(fixture.recorded[0].versionId, formalId)
    assert.equal(fixture.shares(), 0)
  })
})

test('account switch after formal POST success blocks the native formal binding and sharing', async () => {
  await withPreparationFixture(async fixture => {
    const respond = serverFixture.fetch
    serverFixture.fetch = async (...args): Promise<Response> => {
      const response = await respond(...args)
      fixture.switchAccount()
      return response
    }
    await assert.rejects(fixture.share(), /账号已切换/)
    assert.equal(fixture.requests.length, 1)
    assert.deepEqual(fixture.recorded, [])
    assert.equal(fixture.shares(), 0)
  })
})

test('receipt replacement during packaging prevents materializing a stale reserved number', async () => {
  await withPreparationFixture(async fixture => {
    fixture.changeReceiptDuringPackaging()
    await assert.rejects(fixture.share(), /回执在打包期间发生变化/)
    assert.deepEqual(fixture.requests, [])
    assert.deepEqual(fixture.recorded, [])
    assert.equal(fixture.shares(), 0)
  })
})
