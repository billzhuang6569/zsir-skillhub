import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { reconcileSkillList, sameListData, sameSkillIdentity } from '../src/lib/stable-list.ts'
import { cloudLibrarySkills } from '../src/lib/cloud-library.ts'
import { reconcileTeamAccess } from '../src/lib/skills.ts'
import { reconcileLocalSkillRefresh } from '../src/lib/ui-helpers.ts'
import type { LocalSkill, Team } from '../src/store/index.ts'
import type { LibraryEntryList } from '../src/lib/library-sync.ts'

const hooks = registerHooks({ resolve(specifier, context, nextResolve) {
  if (context.parentURL?.includes('/desktop/src/') && specifier.startsWith('.') && specifier.endsWith('.js')) {
    const candidate = new URL(specifier.replace(/\.js$/, '.ts'), context.parentURL)
    if (existsSync(fileURLToPath(candidate))) return nextResolve(candidate.href, context)
  }
  return nextResolve(specifier, context)
} })
const { useStore } = await import('../src/store/index.ts')
hooks.deregister()

const space = { spaceId: 'official', generation: 1 }
const login = (id = 'A', generation = 1): void => {
  useStore.getState().clearAuthSession()
  useStore.getState().setAuthSession({ id, displayName: id, email: `${id}@example.test` }, { ...space, generation })
}
const skill = (fields: Partial<LocalSkill> = {}): LocalSkill => ({
  id: 'server:s', serverId: 's', name: 'same-name', displayName: '展示名', description: '说明', labels: ['分类'],
  avatarUrl: 'https://example.test/avatar.jpg', version: '1', latestVersion: '1', installCount: 0, sources: [], agents: {},
  installed: false, isOwn: false, acquisitionSource: 'team', envDeps: [], sharedTo: {}, versions: [], localPath: '',
  serverAccessValidatedForUserId: 'A', teamSharedFrom: 't1', ...fields,
})
const team = (id: string): Team => ({ id, name: id, color: '#fff', role: 'member', memberCount: 1, sharedCount: 1 })
const selectedId = (): string | null => {
  const sheet = useStore.getState().sheet
  return sheet?.kind === 'skill' ? sheet.skillId : null
}
const list: LibraryEntryList = { space, userId: 'A', entries: [{ entryId: 'e', name: 'same-name', displayName: '展示名', revision: 1, deleted: false, localSkillId: null, serverSkillId: 's' }] }

test('equal DTOs share arrays/rows while keys, permissions, sync and display changes propagate', () => {
  const previous = [skill()]
  assert.equal(reconcileSkillList(previous, structuredClone(previous)), previous)
  for (const fields of [
    { isOwn: true }, { teamUnshared: true }, { teamVersionId: 'v2' }, { serverAccessValidatedForUserId: undefined },
    { envDeps: [{ key: 'KEY', required: true, configured: true, sharePolicy: 'none' as const, sharedTeams: [] }] },
    { description: '新说明' }, { avatarUrl: null }, { installCount: 2 },
  ]) assert.notEqual(reconcileSkillList(previous, [skill(fields)]), previous)
  assert.equal(sameListData({ a: undefined, b: ['x'] }, { b: ['x'] }), true)
  assert.equal(sameListData([undefined], []), false)
})

test('undated rows retain session order across rename, response order and placeholder landing', () => {
  const previous = [skill({ id: 'library:e', libraryEntryId: 'e' }), skill({ id: 'server:b', serverId: 'b' })]
  const landed = skill({ id: 'folder', libraryEntryId: 'e', localPath: '/folder', displayName: '改名' })
  assert.equal(sameSkillIdentity(previous[0], landed), true)
  const next = reconcileSkillList(previous, [skill({ id: 'server:c', serverId: 'c' }), previous[1], landed, skill({ id: 'server:a', serverId: 'a' })])
  assert.deepEqual(next.map(row => row.id), ['folder', 'server:b', 'server:a', 'server:c'])
  assert.equal(next[1], previous[1])
  const aliases = [skill({ id: 'first', serverId: 'shared' }), skill({ id: 'second', libraryEntryId: 'entry', serverId: 'other' }), skill({ id: 'third', serverId: 'third' })]
  const aliased = skill({ id: 'second', libraryEntryId: 'entry', serverId: 'shared' })
  assert.deepEqual(reconcileSkillList(aliases, [aliases[2], aliased]).map(row => row.id), ['second', 'third'])
})

test('display fallback retains metadata without copying old permissions, and tombstones never resurrect', () => {
  const known = skill({ id: 'library:e', libraryEntryId: 'e', libraryAccountId: 'A', category: '分类' })
  const rows = cloudLibrarySkills([known], list, 'A')
  assert.equal(rows[0].description, known.description)
  assert.equal(rows[0].avatarUrl, known.avatarUrl)
  assert.equal(rows[0].category, known.category)
  assert.equal(rows[0].serverAccessValidatedForUserId, undefined)
  assert.equal(rows[0].teamSharedFrom, undefined)
  assert.equal(rows[0].isOwn, false)
  assert.deepEqual(cloudLibrarySkills([known], { ...list, entries: [{ ...list.entries[0], deleted: true }] }, 'A'), [])
  assert.deepEqual(cloudLibrarySkills([known], list, 'B'), [])
})

test('the cloud projection preserves row order/references and enrichment between inventory phases', () => {
  const inventory = { ...list, entries: [...list.entries, { ...list.entries[0], entryId: 'f', serverSkillId: 'other' }] }
  const first = cloudLibrarySkills([], inventory, 'A')
  first[0] = { ...first[0], displayName: '分析后的中文名', description: '分析说明', category: '分类', avatarUrl: 'https://example.test/avatar.jpg' }
  const next = cloudLibrarySkills(first, { ...inventory, entries: [...inventory.entries].reverse() }, 'A')
  assert.equal(next, first)
  assert.equal(next[0].displayName, '分析后的中文名')
})

test('one download updates local state in both teams without replacing their version/display context', () => {
  login()
  const state = useStore.getState()
  state.setTeams([team('t1'), team('t2')])
  state.setTeamSkills('t1', [skill({ teamVersionId: 'v1', latestVersion: '1', sharedAt: '2026-01-01' })], null)
  state.setTeamSkills('t2', [skill({ teamSharedFrom: 't2', teamVersionId: 'v2', latestVersion: '2', description: '第二个团队的版本', sharedAt: '2026-02-01' })], null)
  state.replaceSkill('server:s', skill({ id: 'folder', localPath: '/folder', sourceVersionId: 'v1', acquiredByUserId: 'A', teamVersionId: 'v1', latestVersion: '1' }))
  const second = useStore.getState().teamSkills.t2[0]
  assert.equal(second.localPath, '/folder')
  assert.equal(second.teamVersionId, 'v2')
  assert.equal(second.latestVersion, '2')
  assert.equal(second.description, '第二个团队的版本')
  assert.equal(second.sharedAt, '2026-02-01')
  assert.equal(second.teamUpdateStatus, 'update_available')
})

test('store isolates team slices, retains identical references, maps selection and remembers each view', () => {
  login()
  const state = useStore.getState()
  state.setTeams([team('t1'), team('t2')])
  state.setSkills([skill({ id: 'library:e', libraryEntryId: 'e', teamSharedFrom: undefined })])
  const mine = useStore.getState().skills
  state.openSkillSheet('library:e')
  state.setView('team-skills')
  state.setTeamSkills('t1', [skill()], null)
  assert.equal(useStore.getState().skills, mine)
  state.openSkillSheet('server:s')
  const before = useStore.getState().teamSkills.t1
  state.setTeamSkills('t1', [skill()], null)
  assert.equal(useStore.getState().teamSkills.t1, before)
  state.setTeamSkills('t1', [skill({ id: 'folder', localPath: '/folder' })], null)
  assert.equal(selectedId(), 'folder')
  state.openSkillSheet('folder')
  state.setView('skills')
  assert.deepEqual(useStore.getState().sheet, { kind: 'skill', skillId: 'library:e', tab: 'profile', focus: undefined })
  state.setView('team-skills')
  assert.equal(selectedId(), 'folder')
  state.setLibraryEntries(list)
  const inventory = useStore.getState().libraryEntries
  state.setLibraryEntries(structuredClone(list))
  assert.equal(useStore.getState().libraryEntries, inventory)
  const teams = useStore.getState().teams
  state.setTeams([team('t1'), team('t2')])
  assert.equal(useStore.getState().teams, teams)
})

test('team revocation keeps another valid grant, clears the last grant and cannot be restored by a native scan', () => {
  const local = skill({ id: 'folder', localPath: '/folder' })
  const other = skill({ teamSharedFrom: 't2' })
  const kept = reconcileTeamAccess([local], { t1: [], t2: [other] }, ['t1', 't2'], 'A')
  assert.equal(kept[0].teamSharedFrom, 't2')
  const revoked = reconcileTeamAccess(kept, { t1: [], t2: [] }, ['t1', 't2'], 'A')
  assert.equal(revoked[0].teamUnshared, true)
  assert.equal(revoked[0].serverAccessValidatedForUserId, undefined)
  const scanned = reconcileLocalSkillRefresh(revoked[0], local)
  assert.equal(scanned.teamUnshared, true)
  assert.equal(scanned.serverAccessValidatedForUserId, undefined)
  assert.equal(reconcileTeamAccess(revoked, { t1: [local] }, ['t1'], 'A'), revoked)
  const owner = skill({ isOwn: true, serverOwnerId: 'A' })
  assert.equal(reconcileTeamAccess([owner], {}, [], 'A')[0].isOwn, true)
})

test('account/space changes drop slices, navigation and old inventory callbacks', () => {
  login()
  const state = useStore.getState()
  state.setTeams([team('t1')])
  state.setTeamSkills('t1', [skill({ teamVersionId: 'v1' })], '未能刷新')
  state.openTeamSkill('t1', 's')
  assert.deepEqual(useStore.getState().pendingCommentNavigation, {
    teamId: 't1', serverSkillId: 's', accountUserId: 'A', space, teamVersionId: 'v1',
  })
  login('B')
  state.setLibraryEntries(list)
  assert.deepEqual(useStore.getState().teamSkills, {})
  assert.equal(useStore.getState().pendingCommentNavigation, null)
  assert.equal(useStore.getState().libraryEntries, null)
  login('A', 2)
  state.setLibraryEntries(list)
  assert.equal(useStore.getState().libraryEntries, null)
  assert.deepEqual(useStore.getState().listSelections, {})
})

test('a placeholder that lands while its page is unmounted restores the same remembered selection', () => {
  login()
  const state = useStore.getState()
  state.setView('skills')
  state.setSkills([skill({ id: 'library:e', libraryEntryId: 'e' })])
  state.openSkillSheet('library:e', 'environment', 'env')
  state.setView('settings')
  state.setSkills([skill({ id: 'folder', libraryEntryId: 'e', localPath: '/folder' })])
  state.setView('skills')
  assert.deepEqual(useStore.getState().sheet, { kind: 'skill', skillId: 'folder', tab: 'environment', focus: undefined })
})

test('only list views remember details, explicit close clears selection, and focus is never replayed', () => {
  login()
  const state = useStore.getState()
  for (const view of ['skills', 'team-skills', 'marketplace', 'keys', 'settings'] as const) {
    state.setView(view)
    state.openSkillSheet('s', 'profile', 'install')
    const key = view === 'team-skills' ? `team:${useStore.getState().activeTeamId}` : view
    assert.deepEqual(useStore.getState().sheet, { kind: 'skill', skillId: 's', tab: 'profile', focus: 'install' })
    assert.deepEqual(useStore.getState().listSelections[key], view === 'skills' || view === 'team-skills'
      ? { kind: 'skill', skillId: 's', tab: 'profile', focus: undefined } : undefined)
    state.setSheetTab('environment')
    state.setView('teams')
    state.setView(view)
    assert.equal(selectedId(), view === 'skills' || view === 'team-skills' ? 's' : null)
    if (useStore.getState().sheet?.kind === 'skill') {
      assert.deepEqual(useStore.getState().sheet, { kind: 'skill', skillId: 's', tab: 'environment', focus: undefined })
    }
    state.openSkillSheet('s', 'profile', 'delete')
    state.closeSheet()
    assert.equal(Object.hasOwn(useStore.getState().listSelections, key), false)
    state.setView('teams')
    state.setView(view)
    assert.equal(selectedId(), null)
  }
})

test('an uncached team network failure records an error without revoking installed Skills', () => {
  login()
  const state = useStore.getState()
  state.setTeams([team('t1'), team('t2')])
  state.setSkills([skill({ id: 'folder', localPath: '/folder' })])
  const previous = useStore.getState().skills
  state.setTeamSkills('t1', undefined, '网络错误')
  state.setTeamSkills('t2', [], null)
  assert.equal(Object.hasOwn(useStore.getState().teamSkills, 't1'), false)
  assert.equal(useStore.getState().teamListErrors.t1, '网络错误')
  state.setSkills(reconcileTeamAccess(previous, useStore.getState().teamSkills, ['t2'], 'A'))
  assert.equal(useStore.getState().skills, previous)
  assert.equal(previous[0].teamUnshared, undefined)
  assert.equal(previous[0].teamUpdateStatus, undefined)
  assert.equal(previous[0].serverAccessValidatedForUserId, 'A')
  // Even a previously cached empty response is not fresh revocation evidence.
  state.setTeamSkills('t1', [], '网络错误')
  assert.equal(reconcileTeamAccess(previous, useStore.getState().teamSkills, ['t2'], 'A'), previous)
  state.setTeams([team('t2')])
  assert.equal(useStore.getState().skills[0].teamUnshared, true)
})

test('replaceSkill only emits an inventory refresh for explicit local file changes', () => {
  login()
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
  const target = new EventTarget()
  let events = 0
  target.addEventListener('skillhub-local-changed', () => { events += 1 })
  Object.defineProperty(globalThis, 'window', { configurable: true, value: target })
  try {
    useStore.getState().replaceSkill('server:s', skill({ description: 'AI 分析资料' }))
    assert.equal(events, 0)
    useStore.getState().replaceSkill('server:s', skill({ id: 'folder', localPath: '/folder' }), true)
    assert.equal(events, 1)
  } finally {
    if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow)
    else Reflect.deleteProperty(globalThis, 'window')
  }
})

test('renewing the same identity keeps unchanged lists, while a direct account switch drops navigation and cached rights', () => {
  login()
  const state = useStore.getState()
  state.setSkills([skill({ avatarAccountUserId: 'A' })])
  const previous = useStore.getState().skills
  state.setAuthSession({ id: 'A', displayName: 'New name', email: 'A@example.test' }, { ...space })
  assert.equal(useStore.getState().skills, previous)
  state.openTeamSkill('t1', 's')
  state.setAuthSession({ id: 'B', displayName: 'B', email: 'B@example.test' }, { ...space })
  assert.equal(useStore.getState().pendingCommentNavigation, null)
  assert.deepEqual(useStore.getState().skills, [])
  assert.deepEqual(useStore.getState().teamSkills, {})
})
