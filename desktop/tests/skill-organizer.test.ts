import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  addQuickAccess, allTags, deleteTag, emptyOrganizerState, isInQuickAccess, moveQuickAccess, normalizeOrganizerState,
  normalizeTagName, organizerAccountKey, pruneQuickAccess, rekeyOrganizer, removeQuickAccess, renameTag, setSkillTags,
  setTagCollapsed, skillOrganizerKey, tagCoverage, tagKey, tagsForSkill, toggleTagOnSkills,
  type OrganizerResult, type OrganizerState,
} from '../src/lib/skill-organizer.ts'

const USER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

function ok(result: OrganizerResult): OrganizerState {
  assert.equal(result.ok, true, result.ok ? '' : result.error)
  return (result as { ok: true; state: OrganizerState }).state
}

function error(result: OrganizerResult): string {
  assert.equal(result.ok, false)
  return (result as { ok: false; error: string }).error
}

test('tag names follow the Server rules: NFC, trim, collapsed spaces, 1–32 units, no invisible characters', () => {
  assert.deepEqual(normalizeTagName('  写作   工具 '), { ok: true, name: '写作 工具' })
  assert.deepEqual(normalizeTagName('Café'), { ok: true, name: 'Café' })
  assert.equal(normalizeTagName('   ').ok, false)
  assert.equal(normalizeTagName('x'.repeat(32)).ok, true)
  assert.equal(normalizeTagName('x'.repeat(33)).ok, false)
  assert.equal(normalizeTagName(String.fromCodePoint(0x1f600).repeat(32)).ok, true)
  assert.equal(normalizeTagName(`a${String.fromCharCode(0x200b)}b`).ok, false)
  assert.equal(normalizeTagName(`a${String.fromCharCode(0x202e)}b`).ok, false)
  assert.equal(tagKey(' Daily  Report '), 'daily report')
})

test('skill keys use the library entry only when bound to the signed-in account', () => {
  assert.equal(skillOrganizerKey({ id: 's1', libraryEntryId: 'e1', libraryAccountId: USER }, USER), 'entry:e1')
  assert.equal(skillOrganizerKey({ id: 's1', libraryEntryId: 'e1', libraryAccountId: 'other' }, USER), 'local:s1')
  assert.equal(skillOrganizerKey({ id: 's1', libraryEntryId: 'e1', libraryAccountId: USER }, null), 'local:s1')
  assert.equal(skillOrganizerKey({ id: 's1' }, USER), 'local:s1')
  assert.equal(organizerAccountKey(null), 'guest')
  assert.equal(organizerAccountKey(USER), USER)
})

test('setSkillTags dedupes case-insensitively, reuses the account spelling and marks the Skill dirty', () => {
  let state = ok(setSkillTags(emptyOrganizerState(), 'entry:a', ['Daily', 'daily', ' 写作 ']))
  assert.deepEqual(tagsForSkill(state, 'entry:a'), ['Daily', '写作'])
  state = ok(setSkillTags(state, 'local:b', ['DAILY']))
  assert.deepEqual(tagsForSkill(state, 'local:b'), ['Daily'])
  assert.deepEqual(state.sync.dirtyTagKeys, ['entry:a', 'local:b'])
  assert.match(error(setSkillTags(state, 'entry:a', ['1', '2', '3', '4', '5', '6', '7', '8', '9'])), /最多 8 个/)
  assert.match(error(setSkillTags(state, 'entry:a', [''])), /请输入/)
  // Clearing removes the key entirely.
  state = ok(setSkillTags(state, 'entry:a', []))
  assert.equal('entry:a' in state.tags, false)
  // An unchanged set returns the same object (no save, no dirty mark).
  assert.equal(ok(setSkillTags(state, 'local:b', ['Daily'])), state)
})

test('the account is limited to 200 distinct tags', () => {
  let state = emptyOrganizerState()
  for (let index = 0; index < 25; index += 1) {
    state = ok(setSkillTags(state, `local:${index}`, Array.from({ length: 8 }, (_, tag) => `t${index * 8 + tag}`)))
  }
  assert.equal(allTags(state).length, 200)
  assert.match(error(toggleTagOnSkills(state, ['local:new'], 'one more', true)), /最多 200 个/)
  // Reusing an existing tag is still fine at the limit.
  assert.deepEqual(tagsForSkill(ok(toggleTagOnSkills(state, ['local:new'], 'T0', true)), 'local:new'), ['t0'])
})

test('batch toggle adds to every selected Skill, removes from all, and reports coverage for indeterminate state', () => {
  let state = ok(setSkillTags(emptyOrganizerState(), 'entry:a', ['工具']))
  const keys = ['entry:a', 'entry:b', 'local:c']
  assert.equal(tagCoverage(state, keys).get('工具'), 1)
  state = ok(toggleTagOnSkills(state, keys, '工具', true))
  assert.deepEqual(keys.map(key => tagsForSkill(state, key)), [['工具'], ['工具'], ['工具']])
  assert.equal(tagCoverage(state, keys).get('工具'), 3)
  state = ok(toggleTagOnSkills(state, keys, '工具', false))
  assert.deepEqual(state.tags, {})
  // All-or-nothing when one selected Skill is full.
  let full = ok(setSkillTags(emptyOrganizerState(), 'entry:a', ['1', '2', '3', '4', '5', '6', '7', '8']))
  full = ok(setSkillTags(full, 'entry:b', []))
  assert.match(error(toggleTagOnSkills(full, ['entry:a', 'entry:b'], 'new', true)), /已在 8 个目录中/)
})

test('allTags counts Skills per tag, optionally only live ones, sorted by name', () => {
  let state = ok(setSkillTags(emptyOrganizerState(), 'entry:a', ['b-tag', 'A-tag']))
  state = ok(setSkillTags(state, 'entry:b', ['a-TAG']))
  assert.deepEqual(allTags(state), [{ key: 'a-tag', name: 'A-tag', count: 2 }, { key: 'b-tag', name: 'b-tag', count: 1 }])
  assert.deepEqual(allTags(state, new Set(['entry:b'])), [{ key: 'a-tag', name: 'A-tag', count: 1 }])
})

test('renameTag renames everywhere, merges into an existing tag and follows into quick access', () => {
  let state = ok(setSkillTags(emptyOrganizerState(), 'entry:a', ['写作', '日报']))
  state = ok(setSkillTags(state, 'entry:b', ['日报']))
  state = ok(addQuickAccess(state, { kind: 'tag', ref: '写作' }))
  state = setTagCollapsed(state, '写作', true)
  state = { ...state, sync: { ...state.sync, dirtyTagKeys: [], quickAccessDirty: false } }
  const renamed = ok(renameTag(state, '写作', '文案'))
  assert.deepEqual(tagsForSkill(renamed, 'entry:a'), ['文案', '日报'])
  assert.deepEqual(renamed.quickAccess.items, [{ kind: 'tag', ref: '文案' }])
  assert.deepEqual(renamed.collapsedTags, ['文案'])
  assert.deepEqual(renamed.sync.dirtyTagKeys, ['entry:a'])
  assert.equal(renamed.sync.quickAccessDirty, true)
  const merged = ok(renameTag(state, '写作', '日报'))
  assert.deepEqual(tagsForSkill(merged, 'entry:a'), ['日报'])
  assert.deepEqual(merged.quickAccess.items, [{ kind: 'tag', ref: '日报' }])
  const recased = ok(renameTag(state, '日报', 'DAILY'))
  const cased = ok(renameTag(recased, 'daily', 'Daily'))
  assert.deepEqual([tagsForSkill(cased, 'entry:a'), tagsForSkill(cased, 'entry:b')], [['写作', 'Daily'], ['Daily']])
  assert.match(error(renameTag(state, '不存在', 'x')), /不存在/)
})

test('deleteTag keeps the Skills, drops the tag, its quick-access item and collapse state', () => {
  let state = ok(setSkillTags(emptyOrganizerState(), 'entry:a', ['写作', '日报']))
  state = ok(addQuickAccess(state, { kind: 'tag', ref: '写作' }))
  state = ok(addQuickAccess(state, { kind: 'skill', ref: 'entry:a' }))
  state = setTagCollapsed(state, '写作', true)
  const next = deleteTag(state, '写作')
  assert.deepEqual(tagsForSkill(next, 'entry:a'), ['日报'])
  assert.deepEqual(next.quickAccess.items, [{ kind: 'skill', ref: 'entry:a' }])
  assert.deepEqual(next.collapsedTags, [])
  // Emptying a tag through the popover removes its quick-access item too (auto-remove, never gray out).
  const emptied = ok(toggleTagOnSkills(state, ['entry:a'], '日报', false))
  assert.equal(isInQuickAccess(emptied, { kind: 'tag', ref: '写作' }), true)
  assert.equal(isInQuickAccess(ok(toggleTagOnSkills(state, ['entry:a'], '写作', false)), { kind: 'tag', ref: '写作' }), false)
})

test('quick access adds once, removes, moves and caps at 100 items, marking itself dirty', () => {
  let state = ok(setSkillTags(emptyOrganizerState(), 'entry:a', ['写作']))
  state = ok(addQuickAccess(state, { kind: 'tag', ref: '写作' }))
  assert.equal(ok(addQuickAccess(state, { kind: 'tag', ref: '写作 ' })), state)
  assert.match(error(addQuickAccess(state, { kind: 'tag', ref: '没有' })), /不存在/)
  state = ok(addQuickAccess(state, { kind: 'skill', ref: 'entry:a' }))
  state = ok(addQuickAccess(state, { kind: 'skill', ref: 'local:b' }))
  assert.equal(state.sync.quickAccessDirty, true)
  state = moveQuickAccess(state, 2, 0)
  assert.deepEqual(state.quickAccess.items.map(item => item.ref), ['local:b', '写作', 'entry:a'])
  assert.equal(moveQuickAccess(state, 9, 0), state)
  state = removeQuickAccess(state, { kind: 'skill', ref: 'local:b' })
  assert.deepEqual(state.quickAccess.items.map(item => item.ref), ['写作', 'entry:a'])
  let many = emptyOrganizerState()
  for (let index = 0; index < 100; index += 1) many = ok(addQuickAccess(many, { kind: 'skill', ref: `local:${index}` }))
  assert.match(error(addQuickAccess(many, { kind: 'skill', ref: 'local:x' })), /最多 100 项/)
})

test('pruneQuickAccess auto-removes missing Skills and emptied tags and syncs the removal (#326)', () => {
  let state = ok(setSkillTags(emptyOrganizerState(), 'entry:a', ['写作']))
  state = ok(setSkillTags(state, 'entry:gone', ['旧标签']))
  for (const item of [{ kind: 'tag', ref: '写作' }, { kind: 'tag', ref: '旧标签' }, { kind: 'skill', ref: 'entry:a' }, { kind: 'skill', ref: 'entry:gone' }] as const) {
    state = ok(addQuickAccess(state, item))
  }
  state = { ...state, sync: { ...state.sync, quickAccessDirty: false } }
  const pruned = pruneQuickAccess(state, new Set(['entry:a']))
  assert.deepEqual(pruned.quickAccess.items, [{ kind: 'tag', ref: '写作' }, { kind: 'skill', ref: 'entry:a' }])
  assert.equal(pruned.sync.quickAccessDirty, true)
  // Tags of missing Skills are kept (the Skill may come back from the trash).
  assert.deepEqual(tagsForSkill(pruned, 'entry:gone'), ['旧标签'])
  assert.equal(pruneQuickAccess(pruned, new Set(['entry:a'])), pruned)
})

test('rekeyOrganizer moves local tags and quick access to the library entry once the Skill joins the account', () => {
  let state = ok(setSkillTags(emptyOrganizerState(), 'local:s1', ['写作', '日报']))
  state = ok(setSkillTags(state, 'entry:e1', ['日报', '工具']))
  state = ok(addQuickAccess(state, { kind: 'skill', ref: 'local:s1' }))
  const skills = [{ id: 's1', libraryEntryId: 'e1', libraryAccountId: USER }, { id: 's2' }]
  const moved = rekeyOrganizer(state, skills, USER)
  assert.equal('local:s1' in moved.tags, false)
  assert.deepEqual(tagsForSkill(moved, 'entry:e1'), ['日报', '工具', '写作'])
  assert.deepEqual(moved.quickAccess.items, [{ kind: 'skill', ref: 'entry:e1' }])
  assert.equal(moved.sync.dirtyTagKeys.includes('local:s1'), false)
  assert.equal(moved.sync.dirtyTagKeys.includes('entry:e1'), true)
  assert.equal(rekeyOrganizer(moved, skills, USER), moved)
  // Another account's binding never moves keys.
  assert.equal(rekeyOrganizer(state, skills, 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'), state)
})

test('normalizeOrganizerState repairs untrusted input', () => {
  const state = normalizeOrganizerState({
    version: 1,
    tags: { 'entry:a': ['x', 'X', 7, ' ', 'y'], 'entry:b': 'nope' },
    quickAccess: { revision: -1, items: [{ kind: 'skill', ref: 'entry:a' }, { kind: 'bad', ref: 'x' }, null] },
    collapsedTags: ['x', 'x'],
    sync: { dirtyTagKeys: ['entry:a'], quickAccessDirty: true, lastSyncedAt: 5 },
  })
  assert.deepEqual(state.tags, { 'entry:a': ['x', 'y'] })
  assert.deepEqual(state.quickAccess, { revision: 0, items: [{ kind: 'skill', ref: 'entry:a' }] })
  assert.deepEqual(state.collapsedTags, ['x'])
  assert.deepEqual(state.sync, { dirtyTagKeys: ['entry:a'], quickAccessDirty: true, lastSyncedAt: null, pendingOps: [], quickAccessBase: null, tagBase: {} })
  assert.deepEqual(normalizeOrganizerState(null), emptyOrganizerState())
})

test('the native organizer commands are registered and wrapped', () => {
  const lib = readFileSync(resolve(desktopRoot, 'src-tauri/src/lib.rs'), 'utf8')
  const tauri = readFileSync(resolve(desktopRoot, 'src/lib/tauri.ts'), 'utf8')
  assert.match(lib, /library_organizer::organizer_load,\n\s*library_organizer::organizer_save,/)
  assert.match(tauri, /invoke<unknown>\('organizer_load', \{ accountKey, space \}\)/)
  assert.match(tauri, /invoke\('organizer_save', \{ accountKey, state, space \}\)/)
})

test('groupSkillsByTag lists a Skill in each of its groups and keeps untagged Skills apart', async () => {
  const { groupSkillsByTag } = await import('../src/lib/skill-organizer.ts')
  let state = ok(setSkillTags(emptyOrganizerState(), 'local:a', ['写作', '日报']))
  state = ok(setSkillTags(state, 'local:b', ['日报']))
  state = ok(setSkillTags(state, 'local:gone', ['孤儿']))
  const skills = [{ id: 'a' }, { id: 'b' }, { id: 'c' }]
  const all = groupSkillsByTag(state, skills, skills, null, false)
  assert.deepEqual(all.groups.map(group => [group.name, group.skills.map(skill => skill.id)]), [['日报', ['a', 'b']], ['写作', ['a']]])
  assert.deepEqual(all.untagged.map(skill => skill.id), ['c'])
  const filtered = groupSkillsByTag(state, skills, [skills[1]!], null, true)
  assert.deepEqual(filtered.groups.map(group => group.name), ['日报'])
  assert.deepEqual(groupSkillsByTag(state, skills, [skills[1]!], null, false).groups.map(group => group.skills.length), [1, 0])
})
