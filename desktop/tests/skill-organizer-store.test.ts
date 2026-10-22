import { fixtureSpace } from './helpers/space.ts'
/** Organizer slice of the store (#323): per-account load, strict reset, keyed saves. */
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { registerHooks } from 'node:module'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import type { OrganizerState } from '../src/lib/skill-organizer.ts'

const hooks = registerHooks({ resolve(specifier, context, nextResolve) {
  if (context.parentURL?.includes('/desktop/src/') && specifier.startsWith('.') && specifier.endsWith('.js')) {
    const candidate = new URL(specifier.replace(/\.js$/, '.ts'), context.parentURL)
    if (existsSync(fileURLToPath(candidate))) return nextResolve(candidate.href, context)
  }
  return nextResolve(specifier, context)
} })
const { flushOrganizerSave, setOrganizerPersistence, useStore } = await import('../src/store/index.ts')
const { emptyOrganizerState, setSkillTags, tagsForSkill } = await import('../src/lib/skill-organizer.ts')
hooks.deregister()

const USER_A = { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', username: 'a', displayName: 'A' }
const USER_B = { id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', username: 'b', displayName: 'B' }

function memoryPersistence() {
  const files = new Map<string, OrganizerState>()
  const saves: string[] = []
  setOrganizerPersistence({
    load: async (accountKey) => structuredClone(files.get(accountKey) ?? emptyOrganizerState()),
    save: async (accountKey, state) => { saves.push(accountKey); files.set(accountKey, structuredClone(state)) },
  })
  return { files, saves }
}

function tag(name: string, skillKey = 'local:s1'): string | null {
  return useStore.getState().mutateOrganizer(state => setSkillTags(state, skillKey, [name]))
}

test('organizer loads per account, resets strictly on switch and never shows another account’s tags', async () => {
  const { files } = memoryPersistence()
  const store = useStore.getState()
  store.setAuthGuest()
  await useStore.getState().loadOrganizer()
  assert.equal(useStore.getState().organizerAccount, 'guest')
  assert.equal(tag('游客标签'), null)

  // Signing in resets synchronously before the account's own file is read.
  useStore.getState().setAuthSession(USER_A as never, fixtureSpace('token-a'))
  assert.equal(useStore.getState().organizerAccount, null)
  assert.deepEqual(useStore.getState().organizer.tags, {})
  assert.match(tag('too early') ?? '', /尚未加载/)
  await flushOrganizerSave()
  assert.deepEqual(tagsForSkill(files.get('guest')!, 'local:s1'), ['游客标签'])

  await useStore.getState().loadOrganizer()
  assert.equal(useStore.getState().organizerAccount, USER_A.id)
  assert.equal(tag('A 的标签'), null)
  await flushOrganizerSave()

  useStore.getState().setAuthSession(USER_B as never, fixtureSpace('token-b'))
  await useStore.getState().loadOrganizer()
  assert.deepEqual(useStore.getState().organizer.tags, {})

  useStore.getState().setAuthSession(USER_A as never, fixtureSpace('token-a2'))
  await useStore.getState().loadOrganizer()
  assert.deepEqual(tagsForSkill(useStore.getState().organizer, 'local:s1'), ['A 的标签'])
  assert.deepEqual(tagsForSkill(files.get(USER_A.id)!, 'local:s1'), ['A 的标签'])
  assert.equal(files.has(USER_B.id), false)
})

test('a pending save made before a switch lands in the account it was made for', async () => {
  const { files } = memoryPersistence()
  useStore.getState().setAuthSession(USER_A as never, fixtureSpace('token-a'))
  await useStore.getState().loadOrganizer()
  assert.equal(tag('switch-race'), null)
  // No explicit flush: the account switch flushes the pending write to A.
  useStore.getState().setAuthSession(USER_B as never, fixtureSpace('token-b'))
  await flushOrganizerSave()
  assert.deepEqual(tagsForSkill(files.get(USER_A.id)!, 'local:s1'), ['switch-race'])
  assert.equal(files.get(USER_B.id), undefined)
})

test('a slow load for a previous account is discarded', async () => {
  let release: () => void = () => {}
  setOrganizerPersistence({
    load: (accountKey) => new Promise((resolve) => {
      const state = accountKey === USER_A.id ? setSkillTags(emptyOrganizerState(), 'local:s1', ['A only']) : { ok: true as const, state: emptyOrganizerState() }
      release = () => resolve(state.ok ? state.state : emptyOrganizerState())
    }),
    save: async () => {},
  })
  useStore.getState().clearAuthSession()
  useStore.getState().setAuthSession(USER_A as never, fixtureSpace('token-a'))
  const loading = useStore.getState().loadOrganizer()
  await new Promise(resolve => setTimeout(resolve, 0))
  useStore.getState().setAuthSession(USER_B as never, fixtureSpace('token-b'))
  release()
  await loading
  assert.equal(useStore.getState().organizerAccount, null)
  assert.deepEqual(useStore.getState().organizer.tags, {})
})

test('same UUID in another space resets the organizer and discards the old load', async () => {
  let release: (value: OrganizerState) => void = () => {}
  setOrganizerPersistence({
    load: () => new Promise(resolve => { release = resolve }),
    save: async () => {},
  })
  useStore.getState().setAuthSession(USER_A as never, { spaceId: 'selfhost-a', generation: 100 })
  const loading = useStore.getState().loadOrganizer()
  await new Promise(resolve => setTimeout(resolve, 0))
  useStore.getState().setAuthSession(USER_A as never, { spaceId: 'selfhost-b', generation: 102 })
  const old = setSkillTags(emptyOrganizerState(), 'local:s1', ['space A only'])
  assert.equal(old.ok, true)
  release(old.ok ? old.state : emptyOrganizerState())
  await loading
  assert.equal(useStore.getState().organizerAccount, null)
  assert.deepEqual(useStore.getState().organizer.tags, {})
  assert.deepEqual(useStore.getState().authSpace, { spaceId: 'selfhost-b', generation: 102 })
})

test('strict switch flush rejects a failed save and permits an explicit retry', async () => {
  let fail = true
  let saved = false
  setOrganizerPersistence({
    load: async () => emptyOrganizerState(),
    save: async () => {
      if (fail) throw new Error('disk unavailable')
      saved = true
    },
  })
  useStore.getState().setAuthSession(USER_A as never, { spaceId: 'selfhost-a', generation: 104 })
  await useStore.getState().loadOrganizer()
  assert.equal(tag('pending source change'), null)
  await assert.rejects(flushOrganizerSave(true), /disk unavailable/)
  fail = false
  await flushOrganizerSave(true)
  assert.equal(saved, true)
})

test('reconcile rekeys a Skill that joined the account and prunes only when asked', async () => {
  memoryPersistence()
  useStore.getState().clearAuthSession()
  useStore.getState().setAuthSession(USER_A as never, fixtureSpace('token-a'))
  await useStore.getState().loadOrganizer()
  assert.equal(tag('迁移', 'local:s9'), null)
  useStore.getState().mutateOrganizer(state => ({ ...state, quickAccess: { revision: 0, items: [{ kind: 'skill', ref: 'local:gone' }] } }))
  const skills = [{ id: 's9', libraryEntryId: 'e9', libraryAccountId: USER_A.id }] as never
  useStore.getState().reconcileOrganizer(skills, { prune: false })
  assert.deepEqual(tagsForSkill(useStore.getState().organizer, 'entry:e9'), ['迁移'])
  assert.equal(useStore.getState().organizer.quickAccess.items.length, 1)
  useStore.getState().reconcileOrganizer(skills, { prune: true })
  assert.equal(useStore.getState().organizer.quickAccess.items.length, 0)
  await flushOrganizerSave()
})

test('tag popover ignores IME Enter/Escape and owns focus inside overlay sheets (#323 review)', async () => {
  const { readFileSync } = await import('node:fs')
  const popover = readFileSync(new URL('../src/components/SkillTagPopover.tsx', import.meta.url), 'utf8')
  assert.match(popover, /return event\.nativeEvent\.isComposing \|\| event\.keyCode === 229/)
  assert.match(popover, /if \(isImeKey\(event\)\) return\n\s*if \(event\.key === 'Escape'\)/)
  assert.match(popover, /event\.key === 'Enter' && !isImeKey\(event\)/)
  assert.match(popover, /aria-modal="false"\n[^\n]*\n\s*data-nested-popover/)
  const trap = readFileSync(new URL('../src/components/FocusTrapDialog.tsx', import.meta.url), 'utf8')
  assert.match(trap, /if \(!isTopmostDialog\(dialog\) \|\| inNestedPopover\(event\.target\)\) return/)
  assert.match(trap, /!dialog\.contains\(event\.target as Node\) && !inNestedPopover\(event\.target\)\) focusFirst\(\)/)
})

test('openTagGroup switches to 我的 Skills · 标签, expands the group and leaves a focus request', async () => {
  const { files } = memoryPersistence()
  useStore.getState().clearAuthSession()
  useStore.getState().setAuthSession(USER_A as never, fixtureSpace('token-a'))
  await useStore.getState().loadOrganizer()
  assert.equal(tag('写作'), null)
  useStore.getState().mutateOrganizer(state => ({ ...state, collapsedTags: ['写作'] }))
  useStore.getState().setView('keys')
  useStore.getState().openTagGroup(' 写作 ')
  const state = useStore.getState()
  assert.equal(state.view, 'skills')
  assert.equal(state.skillTab, 'tags')
  assert.deepEqual(state.organizer.collapsedTags, [])
  assert.equal(state.tagGroupFocus?.key, '写作')
  const nonce = state.tagGroupFocus!.nonce
  useStore.getState().openTagGroup('写作')
  assert.equal(useStore.getState().tagGroupFocus?.nonce, nonce + 1)
  useStore.getState().clearTagGroupFocus(nonce)
  assert.notEqual(useStore.getState().tagGroupFocus, null)
  useStore.getState().clearTagGroupFocus(nonce + 1)
  assert.equal(useStore.getState().tagGroupFocus, null)
  await flushOrganizerSave()
  assert.deepEqual(files.get(USER_A.id)?.collapsedTags, [])
})

test('tag groups keep one selection owner and dialogs leave IME Escape alone (#324 review)', async () => {
  const { readFileSync } = await import('node:fs')
  const groups = readFileSync(new URL('../src/components/SkillTagGroups.tsx', import.meta.url), 'utf8')
  assert.match(groups, /onPointerDownCapture=\{\(\) => setActiveGroup\(groupId\)\} onFocusCapture=\{\(\) => setActiveGroup\(groupId\)\}/)
  assert.match(groups, /selectionResetKey=\{`\$\{selectionResetKey\}:\$\{groupId\}:\$\{activeGroup === groupId \? '' : activeGroup \?\? ''\}`\}/)
  assert.match(groups, /useMemo\(\n\s*\(\) => groupSkillsByTag\(/)
  const trap = readFileSync(new URL('../src/components/FocusTrapDialog.tsx', import.meta.url), 'utf8')
  assert.match(trap, /event\.key === 'Escape' && !event\.isComposing && event\.keyCode !== 229/)
})

test('revealSkill opens the Skill on 我的 Skills · 云端 with search and category cleared', () => {
  useStore.getState().setSearchQuery('zzz')
  useStore.getState().setCategoryFilter('写作')
  useStore.getState().setView('keys')
  useStore.getState().revealSkill('s42')
  const state = useStore.getState()
  assert.equal(state.view, 'skills')
  assert.equal(state.skillTab, 'skillhub')
  assert.equal(state.searchQuery, '')
  assert.equal(state.categoryFilter, '全部')
  assert.deepEqual(state.sheet, { kind: 'skill', skillId: 's42', tab: 'profile' })
  const nonce = state.skillReveal!.nonce
  useStore.getState().clearSkillReveal(nonce)
  assert.equal(useStore.getState().skillReveal, null)
})

test('organizer sync: off without the capability, single-flight per account, aborted by an account switch', async () => {
  const { setOrganizerSyncApi } = await import('../src/store/index.ts')
  memoryPersistence()
  const calls: string[] = []
  let release: () => void = () => {}
  const gate = (): Promise<void> => new Promise(resolve => { release = resolve })
  setOrganizerSyncApi(() => ({
    getTags: async () => { calls.push('GET tags'); await gate(); return { tags: [{ entryId: 'e1', names: ['服务端'] }] } },
    patchTags: async (entryId, delta) => { calls.push(`PATCH ${entryId}`); return { entryId, names: delta.add } },
    renameTag: async () => ({}),
    deleteTag: async () => ({}),
    getQuickAccess: async () => { calls.push('GET quick'); return { revision: 2, items: [] } },
    putQuickAccess: async (revision, items) => ({ revision: revision + 1, items }),
  }))
  useStore.getState().clearAuthSession()
  useStore.getState().setAuthSession(USER_A as never, fixtureSpace('token-a'))
  await useStore.getState().loadOrganizer()

  // Capability absent: stays local, no request, no error.
  assert.equal(await useStore.getState().runOrganizerSync(), null)
  assert.deepEqual(calls, [])

  useStore.getState().setOrganizerSyncCapability('supported')
  const first = useStore.getState().runOrganizerSync()
  assert.equal(useStore.getState().runOrganizerSync(), first)
  await new Promise(resolve => setTimeout(resolve, 0))
  release()
  const outcome = await first
  assert.equal(outcome?.ok, true)
  assert.deepEqual(useStore.getState().organizer.tags, { 'entry:e1': ['服务端'] })
  assert.equal(useStore.getState().organizer.quickAccess.revision, 2)
  assert.equal(useStore.getState().organizerSync.running, false)

  // Switch accounts while a pass waits on the Server: B never sees A's tags.
  calls.length = 0
  const pass = useStore.getState().runOrganizerSync()
  await new Promise(resolve => setTimeout(resolve, 0))
  useStore.getState().setAuthSession(USER_B as never, fixtureSpace('token-b'))
  await useStore.getState().loadOrganizer()
  release()
  assert.deepEqual(await pass, { ok: false, aborted: true })
  assert.deepEqual(useStore.getState().organizer.tags, {})
  assert.equal(useStore.getState().organizerSync.capability, 'unknown')
  setOrganizerSyncApi(null)
  await flushOrganizerSave()
})

test('P2-2: pending tags upload once a previously failed probe reports the capability', async () => {
  const { setOrganizerSyncApi } = await import('../src/store/index.ts')
  memoryPersistence()
  const patched: string[] = []
  setOrganizerSyncApi(() => ({
    getTags: async () => ({ tags: patched.length ? [{ entryId: 'e1', names: ['离线'] }] : [] }),
    patchTags: async (entryId, delta) => { patched.push(`${entryId}+${delta.add.join(',')}`); return { entryId, names: delta.add } },
    renameTag: async () => ({}),
    deleteTag: async () => ({}),
    getQuickAccess: async () => ({ revision: 0, items: [] }),
    putQuickAccess: async (revision, items) => ({ revision: revision + 1, items }),
  }))
  useStore.getState().clearAuthSession()
  useStore.getState().setAuthSession(USER_A as never, fixtureSpace('token-a'))
  await useStore.getState().loadOrganizer()
  assert.equal(tag('离线', 'entry:e1'), null)
  useStore.getState().setOrganizerSyncCapability('unknown', true)
  assert.equal(await useStore.getState().runOrganizerSync(), null)
  useStore.getState().setOrganizerSyncCapability('supported')
  assert.equal((await useStore.getState().runOrganizerSync())?.ok, true)
  assert.deepEqual(patched, ['e1+离线'])
  assert.deepEqual(useStore.getState().organizer.sync.dirtyTagKeys, [])
  setOrganizerSyncApi(null)
  await flushOrganizerSave()
})
