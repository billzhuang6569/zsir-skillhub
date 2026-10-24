import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { teamKeyChanges, teamUpdateAccountMatches, teamUpdateState, type TeamUpdateInput } from '../src/lib/team-update-state.ts'
import { latestFormalForPackage } from '../src/lib/versioning.ts'
test('GUI and CLI team update contract', () => {
  const cases = JSON.parse(readFileSync(new URL('./fixtures/team-update-states.json', import.meta.url), 'utf8')) as (TeamUpdateInput & { status: string })[]
  for (const row of cases) assert.equal(teamUpdateState(row), row.status)
})

test('team update account matching honors library ownership before acquisition provenance', () => {
  assert.equal(teamUpdateAccountMatches({ accountUserId: 'member', libraryAccountId: 'member' }), true)
  assert.equal(teamUpdateAccountMatches({ accountUserId: 'member', acquiredByUserId: 'member' }), true)
  assert.equal(teamUpdateAccountMatches({ accountUserId: 'member', libraryAccountId: 'other', acquiredByUserId: 'member' }), false)
  assert.equal(teamUpdateAccountMatches({ accountUserId: 'member', libraryAccountId: 'other', acquiredByUserId: 'other' }), false)
})

test('team confirmation distinguishes added, removed and changed key requirements', () => {
  assert.deepEqual(teamKeyChanges(
    [{ key: 'KEEP', required: true }, { key: 'CHANGE', required: false }, { key: 'REMOVE', required: true }],
    [{ key: 'KEEP', required: true, description: '' }, { key: 'CHANGE', required: true }, { key: 'ADD', required: false }],
  ), { added: ['ADD'], removed: ['REMOVE'], changed: ['CHANGE'] })
})

test('push reuses only the latest formal version with the same package', () => {
  const versions = [{ id: 'old', version: '0.1.0', packageSha256: 'old-sha' }, { id: 'latest', version: '0.1.2', packageSha256: 'same-sha' }]
  assert.equal(latestFormalForPackage(versions, 'same-sha')?.id, 'latest')
  assert.equal(latestFormalForPackage([...versions].reverse(), 'same-sha')?.version, '0.1.2')
  assert.equal(latestFormalForPackage(versions, 'old-sha'), null)
  assert.equal(latestFormalForPackage([], 'same-sha'), null)
})

test('push binds the displayed team version and refreshes a stale confirmation', () => {
  const push = readFileSync(new URL('../src/components/TeamSkillPushButton.tsx', import.meta.url), 'utf8')
  assert.match(push, /apiPushTeamVersion\(skill.serverId, team.id, published.current, info.versionId, activeSpace\)/)
  assert.match(push, /useEffect\(\(\) => \{\s*if \(open\) return/)
  assert.match(push, /if \(!published.current\) published.current = \(await apiCreateSkillVersion/)
  assert.match(push, /reason.code === 'TEAM_VERSION_CHANGED'[\s\S]*await prepare\(true\)[\s\S]*团队版本已被更新，请重新确认/)
  const update = readFileSync(new URL('../src/components/TeamSkillUpdateButton.tsx', import.meta.url), 'utf8')
  assert.match(update, /if \(!skill.serverId \|\| !skill.serverOwnerId \|\| !skill.teamSharedFrom\) \{\s*setError\('这个 Skill 缺少团队来源信息，请重新获取'\)/)
  const startup = readFileSync(new URL('../src-tauri/src/lib.rs', import.meta.url), 'utf8')
  assert.match(startup, /if commands::source_edits::cleanup_team_previews\(\).is_err\(\)/)
  assert.doesNotMatch(startup, /cleanup_team_previews\(\)\.map_err/)
})
