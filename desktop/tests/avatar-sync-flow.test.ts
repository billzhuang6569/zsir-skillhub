import { fixtureSpace } from './helpers/space.ts'
import type { SpaceHandle } from '../src/lib/tauri.ts'
import { serverFixture } from './helpers/server-ipc.ts'
/**
 * Flow-level regressions for the avatar pass (#149): the real
 * `syncSkillAvatars` / `recheckSkillAvatarIdentity` run against a mocked
 * native bridge (`__TAURI_INTERNALS__.invoke`) and mocked HTTP. Each case
 * counts the ensure POSTs and list GETs the pass actually sends.
 */
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { registerHooks } from 'node:module'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import type { LocalSkill } from '../src/store/index.ts'

// Resolve the Vite-style `.js` specifiers inside src/ to their `.ts` sources.
const hooks = registerHooks({ resolve(specifier, context, nextResolve) {
  if (context.parentURL?.includes('/desktop/src/') && specifier.startsWith('.') && specifier.endsWith('.js')) {
    const candidate = new URL(specifier.replace(/\.js$/, '.ts'), context.parentURL)
    if (existsSync(fileURLToPath(candidate))) return nextResolve(candidate.href, context)
  }
  return nextResolve(specifier, context)
} })
const { syncSkillAvatars, recheckSkillAvatarIdentity } = await import('../src/lib/skill-avatars.ts')
const { useStore } = await import('../src/store/index.ts')

const { avatarParkSignature } = await import('../src/lib/avatar-identity.ts')
hooks.deregister()

const skill = {
  id: 'managed', name: 'sample', displayName: 'Sample', description: 'Sample skill', localPath: '/fixture/sample',
  version: '0.1.0', latestVersion: '0.1.0', labels: [], sources: [], agents: {}, installed: false, isOwn: true,
  installCount: 0, acquisitionSource: 'local', compatibleAgents: [], sharedTo: {}, envDeps: [], versions: [],
  avatarLocalId: 'device-id', avatarStatus: 'pending', avatarAccountUserId: 'owner',
  libraryAccountId: 'owner', libraryEntryId: 'entry-id',
} as unknown as LocalSkill
const PARKED_SIGNATURE = avatarParkSignature('owner', { stableId: 'entry-id', aliasLocalIds: ['device-id'] }, undefined)
const parkedFile = JSON.stringify({ [PARKED_SIGNATURE]: { parkedAt: 1, stableId: 'entry-id', aliasLocalIds: ['device-id'], serverId: null } })

type Fixture = {
  parking: () => Promise<string | null>
  list: () => Promise<unknown[]>
  onList?: () => void
}
type Counters = { posts: number; gets: number; writes: string[] }

let spaceSeq = 0
async function withFixture(fixture: Fixture, run: (counters: Counters, space: SpaceHandle) => Promise<void>): Promise<void> {
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
  const originalFetch = serverFixture.fetch
  const counters: Counters = { posts: 0, gets: 0, writes: [] }
  Object.defineProperty(globalThis, 'window', { configurable: true, value: {
    __TAURI_INTERNALS__: { invoke: async (command: string, args: Record<string, unknown>): Promise<unknown> => {
      if (['current_space', 'server_request', 'cancel_server_request'].includes(command)) return serverFixture.invoke(command, args)
      if (command === 'read_avatar_parking') return fixture.parking()
      if (command === 'write_avatar_parking') { counters.writes.push(String(args.json)); return undefined }
      if (command === 'cache_skill_avatar') return undefined
      if (command === 'ensure_skill_avatar_identity') return 'device-id'
      throw new Error(`Unexpected native command: ${command}`)
    } },
  } })
  serverFixture.fetch = (async (input: unknown, init?: RequestInit): Promise<Response> => {
    const url = String(input)
    assert.match(url, /\/skill-avatars\/local$/)
    if ((init?.method ?? 'GET') === 'POST') {
      counters.posts += 1
      return new Response(JSON.stringify({ localSkillId: 'entry-id', skillId: null, aliases: ['device-id'], avatarUrl: null, avatarStatus: 'pending' }), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    counters.gets += 1
    fixture.onList?.()
    const items = await fixture.list()
    return new Response(JSON.stringify({ items }), { status: 200, headers: { 'content-type': 'application/json' } })
  }) as typeof fetch
  const space = fixtureSpace(`fixture.jwt.${++spaceSeq}`)
  setSpace(space)
  useStore.setState({ currentUser: { id: 'owner', email: 'owner@example.invalid', displayName: 'Owner' } as never, skills: [{ ...skill }], avatarParkingProblem: null })
  try { await run(counters, space) } finally {
    serverFixture.fetch = originalFetch
    if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow)
    else delete (globalThis as { window?: unknown }).window
  }
}
const pass = (space: SpaceHandle) => syncSkillAvatars('owner', space, new AbortController().signal)
const status = (): string | undefined => useStore.getState().skills[0]?.avatarStatus

test('control: with no parking file a pending Skill is registered with its stable identity and alias', async () => {
  await withFixture({ parking: async () => null, list: async () => [] }, async (counters, space) => {
    await pass(space)
    assert.equal(counters.gets, 1)
    assert.equal(counters.posts, 1)
    assert.equal(useStore.getState().avatarParkingProblem, null)
  })
})

test('a parking read that fails or is corrupt keeps the whole session from ensuring, never rewrites the file, and says so', async () => {
  for (const parking of [
    async (): Promise<string | null> => { throw new Error('头像停放记录不是安全的普通文件') },
    async (): Promise<string | null> => '{not json',
    async (): Promise<string | null> => JSON.stringify({ [PARKED_SIGNATURE]: { stableId: 42 } }),
    async (): Promise<string | null> => JSON.stringify([]),
  ]) {
    await withFixture({ parking, list: async () => [] }, async (counters, space) => {
      await pass(space)
      await pass(space) // focus / re-render
      assert.equal(counters.posts, 0, 'no ensure while parking is unreadable')
      assert.deepEqual(counters.writes, [], 'a damaged record is never overwritten')
      assert.match(useStore.getState().avatarParkingProblem ?? '', /无法读取/)
    })
  }
})

test('only a parked Skill: a new session runs exactly one read-only check, zero ensure, and focus does not repeat it', async () => {
  // The Server lists the canonical task but without our alias: not proven.
  await withFixture({ parking: async () => parkedFile, list: async () => [{ localSkillId: 'entry-id', skillId: null, avatarUrl: null, avatarStatus: 'pending', aliases: [] }] }, async (counters, space) => {
    await pass(space)
    assert.equal(counters.gets, 1, 'one read-only check after sign-in')
    assert.equal(counters.posts, 0)
    assert.equal(status(), 'conflict')
    await pass(space)
    await pass(space)
    assert.equal(counters.gets, 1, 'focus / re-render do not re-check')
    assert.equal(counters.posts, 0)
    // Re-login (new space = new session): one more check, still no ensure.
    const relogin = fixtureSpace(`${space}.relogin`)
    setSpace(relogin)
    await syncSkillAvatars('owner', relogin, new AbortController().signal)
    assert.equal(counters.gets, 2)
    assert.equal(counters.posts, 0)
    assert.equal(status(), 'conflict')
  })
})

test('a failed read-back keeps the Skill parked; an older Server without aliases keeps it parked', async () => {
  await withFixture({ parking: async () => parkedFile, list: async () => { throw new Error('offline') } }, async (counters, space) => {
    await pass(space)
    assert.equal(counters.posts, 0)
    assert.equal(status(), 'conflict')
  })
  await withFixture({ parking: async () => parkedFile, list: async () => [{ localSkillId: 'entry-id', skillId: null, avatarUrl: null, avatarStatus: 'pending' }] }, async (counters, space) => {
    await pass(space)
    assert.equal(counters.posts, 0)
    assert.equal(status(), 'conflict')
  })
})

test('an explicit canonical + alias read-back releases parking without ensuring in that pass', async () => {
  await withFixture({ parking: async () => parkedFile, list: async () => [{ localSkillId: 'entry-id', skillId: null, avatarUrl: null, avatarStatus: 'pending', aliases: ['device-id'] }] }, async (counters, space) => {
    await pass(space)
    assert.equal(counters.gets, 1)
    assert.equal(counters.posts, 0, 'released Skills wait for the next pass')
    assert.notEqual(status(), 'conflict')
    assert.deepEqual(counters.writes.map((json) => JSON.parse(json)), [{}])
  })
})

test('a manual recheck whose answer arrives after an account switch publishes nothing', async () => {
  let proven = false
  let switchDuringRead = false
  await withFixture({
    parking: async () => parkedFile,
    // First the session check sees no alias (stays parked); the manual recheck
    // would see a releasing answer, but the account switches mid-read.
    list: async () => [{ localSkillId: 'entry-id', skillId: null, avatarUrl: null, avatarStatus: 'pending', aliases: proven ? ['device-id'] : [] }],
    onList: () => { if (switchDuringRead) useStore.setState({ currentUser: { id: 'other', email: 'other@example.invalid', displayName: 'Other' } as never }) },
  }, async (counters, space) => {
    await pass(space)
    assert.equal(status(), 'conflict')
    const writesBefore = counters.writes.length
    proven = true
    switchDuringRead = true
    const outcome = await recheckSkillAvatarIdentity(useStore.getState().skills[0]!, 'owner', space)
    assert.equal(outcome, 'stale')
    assert.equal(counters.gets, 2, 'the recheck did read')
    assert.equal(status(), 'conflict', 'the read-back is not applied after the switch')
    assert.equal(counters.writes.length, writesBefore, 'nothing persisted for the old account')
    assert.equal(counters.posts, 0)
    // Same account, no switch: the same answer releases it.
    useStore.setState({ currentUser: { id: 'owner', email: 'owner@example.invalid', displayName: 'Owner' } as never })
    switchDuringRead = false
    assert.equal(await recheckSkillAvatarIdentity(useStore.getState().skills[0]!, 'owner', space), 'released')
    assert.notEqual(status(), 'conflict')
    assert.equal(counters.posts, 0, 'recheck is read-only')
  })
})

function setSpace(space: SpaceHandle): void { useStore.setState({ authSpace: space }); serverFixture.space = space }

test('legacy ready task recovered to canonical identity releases current parking and displays the original image without ensure', async () => {
  const cloudSignature = avatarParkSignature('owner', { stableId: 'entry-id', aliasLocalIds: ['device-id'] }, 'cloud')
  const parking = JSON.stringify({ ...JSON.parse(parkedFile), [cloudSignature]: {
    parkedAt: 2, stableId: 'entry-id', aliasLocalIds: ['device-id'], serverId: 'cloud',
  } })
  let recovered = false
  const originalUrl = 'https://example.invalid/original.webp'
  await withFixture({ parking: async () => parking, list: async () => [{
    localSkillId: recovered ? 'entry-id' : 'device-id', skillId: recovered ? 'cloud' : null,
    aliases: recovered ? ['device-id'] : [], avatarStatus: 'ready', avatarUrl: originalUrl,
  }] }, async (counters, space) => {
    useStore.setState({ skills: [{ ...skill, serverId: 'cloud', serverOwnerId: 'owner', serverAccessValidatedForUserId: 'owner' }] })
    await pass(space)
    assert.equal(status(), 'conflict')
    recovered = true
    assert.equal(await recheckSkillAvatarIdentity(useStore.getState().skills[0]!, 'owner', space), 'released')
    await pass(space)
    assert.equal(status(), 'ready')
    assert.equal(useStore.getState().skills[0]?.avatarUrl, originalUrl)
    assert.equal(counters.posts, 0)
    const persisted = JSON.parse(counters.writes.at(-1)!)
    assert.equal(persisted[cloudSignature], undefined)
    // A historical signature is not evidence for a different cloud binding.
    assert.ok(persisted[PARKED_SIGNATURE])
  })
})
