import { fixtureSpace } from './helpers/space.ts'
import type { SpaceHandle } from '../src/lib/tauri.ts'
import { serverFixture } from './helpers/server-ipc.ts'
/**
 * Custom avatars × the background avatar pass (#214 review): a pass whose list read
 * started before an upload / restore must not overwrite the user's change, and a
 * cloud-only Skill learns its display source from the list in every new session,
 * without an ensure. The real `syncSkillAvatars`, `uploadCustomSkillAvatar` and
 * `restoreGeneratedSkillAvatar` run against a mocked native bridge and HTTP.
 */
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { registerHooks } from 'node:module'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import type { LocalSkill } from '../src/store/index.ts'

const hooks = registerHooks({ resolve(specifier, context, nextResolve) {
  if (context.parentURL?.includes('/desktop/src/') && specifier.startsWith('.') && specifier.endsWith('.js')) {
    const candidate = new URL(specifier.replace(/\.js$/, '.ts'), context.parentURL)
    if (existsSync(fileURLToPath(candidate))) return nextResolve(candidate.href, context)
  }
  return nextResolve(specifier, context)
} })
const avatars = await import('../src/lib/skill-avatars.ts')
const { useStore } = await import('../src/store/index.ts')
const { cacheSkillAvatar } = await import('../src/lib/tauri.ts')

hooks.deregister()

const GENERATED = 'https://picem-media.whatonearth.work/public/app/ast/generated.jpg'
const CUSTOM = 'https://picem-media.whatonearth.work/public/app/ast/custom.webp'
const image = { mimeType: 'image/webp' as const, dataBase64: 'UklGRg==' }
const local = {
  id: 'managed', name: 'sample', displayName: 'Sample', description: 'Sample skill', localPath: '/fixture/sample',
  version: '0.1.0', latestVersion: '0.1.0', labels: [], sources: [], agents: {}, installed: false, isOwn: true,
  installCount: 0, acquisitionSource: 'local', compatibleAgents: [], sharedTo: {}, envDeps: [], versions: [],
  avatarLocalId: 'device-id', avatarAccountUserId: 'owner', libraryAccountId: 'owner', libraryEntryId: 'entry-id',
} as unknown as LocalSkill
const cloudOnly = {
  ...local, id: 'cloud-managed', localPath: '', avatarLocalId: undefined, libraryAccountId: undefined, libraryEntryId: undefined,
  serverId: 'cloud-1', serverOwnerId: 'owner', serverAccessValidatedForUserId: 'owner', avatarAccountUserId: undefined,
} as unknown as LocalSkill
const listItem = (fields: Record<string, unknown>) => ({ localSkillId: 'entry-id', skillId: null, aliases: ['device-id'], ...fields })
const json = (body: unknown): Response => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })

type Gate = { open: (items: unknown[]) => void }
type Counters = { gets: number; ensures: number; cached: Array<{ avatarUrl: unknown; avatarStatus: unknown }> }
let spaceSeq = 0
async function withBridge(skills: LocalSkill[], respond: { list: () => Promise<unknown[]>; custom?: () => unknown; restore?: () => unknown },
  run: (counters: Counters, space: SpaceHandle) => Promise<void>): Promise<void> {
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
  const originalFetch = serverFixture.fetch
  const counters: Counters = { gets: 0, ensures: 0, cached: [] }
  Object.defineProperty(globalThis, 'window', { configurable: true, value: {
    __TAURI_INTERNALS__: { invoke: async (command: string, args: Record<string, unknown>): Promise<unknown> => {
      if (['current_space', 'server_request', 'cancel_server_request'].includes(command)) return serverFixture.invoke(command, args)
      if (command === 'read_avatar_parking') return null
      if (command === 'write_avatar_parking') return undefined
      if (command === 'cache_skill_avatar') { counters.cached.push({ avatarUrl: args.avatarUrl, avatarStatus: args.avatarStatus }); return undefined }
      if (command === 'ensure_skill_avatar_identity') return 'device-id'
      throw new Error(`Unexpected native command: ${command}`)
    } },
  } })
  serverFixture.fetch = (async (input: unknown, init?: RequestInit): Promise<Response> => {
    const url = String(input)
    const method = init?.method ?? 'GET'
    if (method === 'GET' && /\/skill-avatars\/local$/.test(url)) { counters.gets += 1; return json({ items: await respond.list() }) }
    if (method === 'POST' && /\/skill-avatars\/local\/custom$/.test(url)) return json(respond.custom?.())
    if (method === 'DELETE' && /\/custom$/.test(url)) return json(respond.restore?.())
    counters.ensures += 1
    throw new Error(`Unexpected request ${method} ${url}`)
  }) as typeof fetch
  const space = fixtureSpace(`fixture.jwt.custom-sync.${++spaceSeq}`)
  setSpace(space)
  useStore.setState({ currentUser: { id: 'owner', email: 'owner@example.invalid', displayName: 'Owner' } as never, skills: skills.map(skill => ({ ...skill })), avatarParkingProblem: null })
  try { await run(counters, space) } finally {
    serverFixture.fetch = originalFetch
    if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow)
    else delete (globalThis as { window?: unknown }).window
  }
}
function gate(): Gate & { list: () => Promise<unknown[]> } {
  let release: (items: unknown[]) => void = () => undefined
  let promise = new Promise<unknown[]>((done) => { release = done })
  return { list: () => promise, open: (items) => { release(items); promise = Promise.resolve(items) } }
}
const pass = (space: SpaceHandle) => avatars.syncSkillAvatars('owner', space, new AbortController().signal)
const flush = (): Promise<void> => new Promise((done) => setImmediate(done))
const stored = (id: string): LocalSkill => useStore.getState().skills.find(skill => skill.id === id)!

test('style cache writes carry the captured space even when the native current space has changed', async () => {
  const captured = { spaceId: 'source', generation: 1 }
  const next = { spaceId: 'destination', generation: 2 }
  const calls: Array<{ command: string; args: Record<string, unknown> }> = []
  Object.defineProperty(globalThis, 'window', { configurable: true, value: {
    __TAURI_INTERNALS__: { invoke: async (command: string, args: Record<string, unknown>): Promise<unknown> => {
      calls.push({ command, args })
      return command === 'current_space' ? next : undefined
    } },
  } })
  await cacheSkillAvatar('same-skill', 'same-user', GENERATED, 'ready', captured)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].command, 'cache_skill_avatar')
  assert.deepEqual(calls[0].args.space, captured)
})

test('style refresh replaces settled local and cloud selections without ensuring missing avatars', async () => {
  const next = `${GENERATED}?style=new`
  let items = [listItem({ avatarUrl: GENERATED, avatarStatus: 'ready', avatarSource: 'generated' }),
    { localSkillId: null, skillId: 'cloud-1', avatarUrl: GENERATED, avatarStatus: 'ready', avatarSource: 'generated' }]
  await withBridge([{ ...local, avatarUrl: GENERATED, avatarStatus: 'ready' }, { ...cloudOnly, avatarUrl: GENERATED, avatarStatus: 'ready' },
    { ...local, id: 'missing', avatarLocalId: 'missing', libraryEntryId: 'missing', avatarStatus: 'none' }], { list: async () => items }, async (counters, space) => {
    items = [listItem({ avatarUrl: next, avatarStatus: 'pending', avatarSource: 'generated' }),
      { localSkillId: null, skillId: 'cloud-1', avatarUrl: next, avatarStatus: 'ready', avatarSource: 'generated' }]
    assert.equal(await avatars.refreshSkillAvatarSelections('owner', space, new AbortController().signal), true)
    assert.equal(stored('managed').avatarUrl, next); assert.equal(stored('cloud-managed').avatarUrl, next)
    assert.equal(stored('missing').avatarStatus, 'none')
    assert.equal(counters.ensures, 0); assert.equal(counters.cached.length, 1)
    items = [listItem({ avatarUrl: next, avatarStatus: 'ready', avatarSource: 'generated' })]
    assert.equal(await avatars.refreshSkillAvatarSelections('owner', space, new AbortController().signal), false)
    assert.equal(counters.ensures, 0)
  })
})

test('style refresh drops a late selection after account change or a newer custom upload', async () => {
  for (const action of ['account', 'custom'] as const) {
    const list = gate()
    await withBridge([{ ...local, avatarUrl: GENERATED, avatarStatus: 'ready' }], {
      list: list.list, custom: () => listItem({ avatarUrl: CUSTOM, avatarStatus: 'ready', avatarSource: 'custom' }),
    }, async (counters, space) => {
      const running = avatars.refreshSkillAvatarSelections('owner', space, new AbortController().signal)
      await flush()
      if (action === 'account') useStore.setState({ currentUser: { id: 'other' } as never })
      else await avatars.uploadCustomSkillAvatar(stored('managed'), image, 'owner', space, () => true)
      list.open([listItem({ avatarUrl: 'https://fixture.invalid/late.png', avatarStatus: 'ready' })])
      await running
      assert.equal(stored('managed').avatarUrl, action === 'account' ? GENERATED : CUSTOM)
      assert.equal(counters.ensures, 0)
    })
  }
})

test('an upload that lands while a pass is reading is not overwritten by the stale generated snapshot', async () => {
  const list = gate()
  let serverState: Record<string, unknown> = { avatarUrl: GENERATED, avatarStatus: 'ready', avatarSource: 'generated' }
  // Generation was still running when the pass started; its read returns the finished generated image.
  await withBridge([{ ...local, avatarUrl: null, avatarStatus: 'pending', avatarSource: 'generated' }], {
    list: () => list.list(),
    custom: () => { serverState = { avatarUrl: CUSTOM, avatarStatus: 'ready', avatarSource: 'custom' }; return listItem(serverState) },
  }, async (counters, space) => {
    const running = pass(space)
    await flush()
    assert.equal(counters.gets, 1, 'the pass is waiting on its list read')
    const outcome = await avatars.uploadCustomSkillAvatar(stored('managed'), image, 'owner', space, () => true)
    assert.equal(outcome.status, 'applied')
    list.open([listItem({ avatarUrl: GENERATED, avatarStatus: 'ready', avatarSource: 'generated' })]) // the old snapshot
    await running
    assert.equal(stored('managed').avatarUrl, CUSTOM)
    assert.equal(stored('managed').avatarSource, 'custom')
    assert.deepEqual(counters.cached.at(-1), { avatarUrl: CUSTOM, avatarStatus: 'ready' }, 'the account cache keeps the custom image')
    // The skipped Skill was not marked settled: the next pass reads it again and agrees with the Server.
    list.open([listItem(serverState)])
    await pass(space)
    assert.equal(counters.gets, 2)
    assert.equal(stored('managed').avatarSource, 'custom')
    await pass(space)
    assert.equal(counters.gets, 2, 'settled after a fresh read')
    assert.equal(counters.ensures, 0)
  })
})

test('a personal source copy skips automatic paid generation but may upload its own image', async () => {
  await withBridge([{ ...local, copiedFromSource: true }], {
    list: async () => [],
    custom: () => listItem({ avatarUrl: CUSTOM, avatarStatus: 'ready', avatarSource: 'custom' }),
  }, async (counters, space) => {
    await pass(space)
    assert.equal(counters.ensures, 0)
    assert.equal(avatars.canChangeSkillAvatar(stored('managed'), 'owner'), true)
    const result = await avatars.uploadCustomSkillAvatar(stored('managed'), image, 'owner', space, () => true)
    assert.equal(result.status, 'applied')
    assert.equal(counters.ensures, 0)
  })
})

test('a legacy personal skill without the explicit copy marker still generates an avatar', async () => {
  await withBridge([{ ...local, copiedFromSource: false }], { list: async () => [] }, async (counters, space) => {
    await pass(space)
    assert.equal(counters.ensures, 1)
  })
})

test('a restore that lands while a pass is reading is not overwritten by the stale custom snapshot', async () => {
  const list = gate()
  // Signed in again: the cached custom image is not yet bound to this account, so the pass would write it back.
  await withBridge([{ ...local, avatarUrl: CUSTOM, avatarStatus: 'ready', avatarSource: 'custom', avatarAccountUserId: undefined }], {
    list: () => list.list(),
    restore: () => listItem({ avatarUrl: null, avatarStatus: 'pending', avatarSource: 'generated' }),
  }, async (counters, space) => {
    const running = pass(space)
    await flush()
    const outcome = await avatars.restoreGeneratedSkillAvatar(stored('managed'), 'owner', space, () => true)
    assert.equal(outcome.status, 'applied')
    list.open([listItem({ avatarUrl: CUSTOM, avatarStatus: 'ready', avatarSource: 'custom' })])
    await running
    assert.equal(stored('managed').avatarStatus, 'pending')
    assert.equal(stored('managed').avatarSource, 'generated')
    assert.equal(stored('managed').avatarUrl, null)
    assert.deepEqual(counters.cached.at(-1), { avatarUrl: null, avatarStatus: 'pending' })
    assert.equal(counters.ensures, 0)
  })
})

test('a cloud-only Skill reads its custom source in every new session and on another device, without ensure', async () => {
  const items = [{ localSkillId: null, skillId: 'cloud-1', aliases: [], avatarUrl: CUSTOM, avatarStatus: 'ready', avatarSource: 'custom' }]
  for (const device of ['this device after re-login', 'another device']) {
    await withBridge([{ ...cloudOnly, avatarUrl: CUSTOM, avatarStatus: 'ready', avatarSource: undefined }], { list: async () => items }, async (counters, space) => {
      assert.equal(stored('cloud-managed').avatarSource, undefined, device)
      await pass(space)
      assert.equal(counters.gets, 1, device)
      assert.equal(counters.ensures, 0, `${device}: never probes with ensure`)
      const skill = stored('cloud-managed')
      assert.equal(skill.avatarSource, 'custom', device)
      // The detail status row shows 「自定义头像 · 恢复自动生成」 exactly in this state.
      assert.equal(skill.avatarStatus === 'ready' && skill.avatarSource === 'custom' && avatars.canChangeSkillAvatar(skill, 'owner'), true, device)
    })
  }
})

function setSpace(space: SpaceHandle): void { useStore.setState({ authSpace: space }); serverFixture.space = space }
