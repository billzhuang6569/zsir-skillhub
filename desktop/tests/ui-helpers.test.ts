import assert from 'node:assert/strict'
import test from 'node:test'
import {
  canManageSkillAsset,
  commentScopeTeamId,
  containedScrollTop,
  currentAccountServerId,
  detectedAgentOptions,
  isSkillSharedWithActiveTeam,
  nextRovingIndex,
  partitionTeams,
  reconcileLocalSkillRefresh,
  retargetSkillSheet,
  settledCollection,
  settledError,
  settledValue,
  teamErrorMessage,
  visibleAgentKeys,
} from '../src/lib/ui-helpers.ts'

import {
  mergeSkillVersionHistory, skillVersionExists, suggestNextSkillVersion, skillVersionInputError, skillVersionOrdinal,
  skillSnapshotSuggestedVersion, skillSnapshotAllocation, skillSnapshotInputError, skillVersionDisplay,
} from '../src/lib/versioning.ts'



test('roving controls wrap only on their declared arrow axis', () => {
  assert.equal(nextRovingIndex(0, 4, 'ArrowLeft', 'horizontal'), 3)
  assert.equal(nextRovingIndex(3, 4, 'ArrowRight', 'horizontal'), 0)
  assert.equal(nextRovingIndex(2, 4, 'ArrowUp', 'vertical'), 1)
  assert.equal(nextRovingIndex(2, 4, 'ArrowLeft', 'vertical'), null)
  assert.equal(nextRovingIndex(2, 4, 'Home', 'both'), 0)
  assert.equal(nextRovingIndex(2, 4, 'End', 'both'), 3)
  assert.equal(nextRovingIndex(0, 0, 'ArrowRight', 'horizontal'), null)
})

test('settled API results keep successful data when a sibling request fails', async () => {
  const [teamsResult, notificationsResult] = await Promise.allSettled([
    Promise.resolve([{ id: 'team-1' }]),
    Promise.reject(new Error('notifications unavailable')),
  ])
  assert.deepEqual(settledValue(teamsResult), [{ id: 'team-1' }])
  assert.equal(settledValue(notificationsResult), undefined)
  assert.equal(settledError(teamsResult), null)
  assert.equal(settledError(notificationsResult), 'notifications unavailable')
})

test('a failed team collection stays unavailable instead of becoming a real empty list', async () => {
  const [result] = await Promise.allSettled([
    Promise.reject(new Error('shared Skills unavailable')) as Promise<never[]>,
  ])
  assert.deepEqual(settledCollection(result), {
    items: [],
    available: false,
    error: 'shared Skills unavailable',
  })
})

test('common team API errors are presented as actionable Chinese messages', () => {
  assert.equal(teamErrorMessage(new Error('Already a team member')), '当前账号已经是这个团队的成员')
  assert.equal(teamErrorMessage(new Error('Active team member not found')), '该成员已经不在这个团队中')
  assert.equal(teamErrorMessage(new Error('network unavailable')), 'network unavailable')
})

test('created teams never appear in the joined list', () => {
  const teams = [
    { id: 'owned', role: 'owner' as const },
    { id: 'joined', role: 'member' as const },
  ]
  assert.deepEqual(partitionTeams(teams), {
    owned: [{ id: 'owned', role: 'owner' }],
    joined: [{ id: 'joined', role: 'member' }],
  })
})

test('focus scrolling stays inside the detail body', () => {
  assert.equal(containedScrollTop(240, 120, 420), 528)
  assert.equal(containedScrollTop(0, 300, 120), 0)
})

test('a downloaded remote Skill keeps the mounted sheet pointed at its new local id', () => {
  const sheet = { kind: 'skill', skillId: 'server:skill-001', tab: 'profile', focus: 'install' }
  assert.deepEqual(retargetSkillSheet(sheet, 'server:skill-001', 'release-verifier'), {
    kind: 'skill', skillId: 'release-verifier', tab: 'profile', focus: 'install',
  })
  assert.equal(retargetSkillSheet(sheet, 'server:other', 'other'), sheet)
})

test('filesystem refreshes keep server catalog counts and timestamps', () => {
  const refreshed = reconcileLocalSkillRefresh(
    { serverId: 'remote-1', sharedTo: { team: {} }, installCount: 27, createdAt: 'created', updatedAt: 'updated' },
    { serverId: 'remote-1', sharedTo: {}, installCount: 0 },
  )
  assert.equal(refreshed.installCount, 27)
  assert.equal(refreshed.createdAt, 'created')
  assert.equal(refreshed.updatedAt, 'updated')
  assert.deepEqual(refreshed.sharedTo, { team: {} })
})

test('an owned Skill shared to the active team is included in the team section', () => {
  assert.equal(isSkillSharedWithActiveTeam({ sharedTo: { 'team-1': {} } }, 'team-1'), true)
  assert.equal(isSkillSharedWithActiveTeam({ teamSharedFrom: 'team-1' }, 'team-1'), true)
  assert.equal(isSkillSharedWithActiveTeam({ sharedTo: { 'team-2': {} } }, 'team-1'), false)
})

test('discussion scope prefers the Skill source team, then an explicitly shared active team', () => {
  assert.equal(commentScopeTeamId({
    teamSharedFrom: 'source-team',
    sharedTo: { 'active-team': {} },
  }, 'active-team'), 'source-team')
  assert.equal(commentScopeTeamId({
    sharedTo: { 'active-team': {} },
  }, 'active-team'), 'active-team')
  assert.equal(commentScopeTeamId({
    sharedTo: { 'other-team': {} },
  }, 'active-team'), undefined)
  assert.equal(commentScopeTeamId({ sharedTo: {} }, null), undefined)
})

test('discussion never requests a server id detached from the current account', () => {
  assert.equal(currentAccountServerId({
    serverId: 'old-account-skill-id',
    accountSyncRequired: true,
  }, 'current-user'), undefined)
  assert.equal(currentAccountServerId({
    serverId: 'current-account-skill-id',
    serverOwnerId: 'current-user',
    isOwn: true,
    acquisitionSource: 'local',
  }, 'current-user'), 'current-account-skill-id')
  assert.equal(currentAccountServerId({
    serverId: 'old-team-skill-id',
    isOwn: false,
    acquisitionSource: 'team',
    serverAccessValidatedForUserId: 'old-user',
  }, 'current-user'), undefined)
  assert.equal(currentAccountServerId({
    serverId: 'current-team-skill-id',
    isOwn: false,
    acquisitionSource: 'team',
    serverAccessValidatedForUserId: 'current-user',
  }, 'current-user'), 'current-team-skill-id')
  assert.equal(currentAccountServerId({
    serverId: 'marketplace-skill-id',
    serverOwnerId: 'current-user',
    isOwn: false,
    acquisitionSource: 'marketplace',
    serverAccessValidatedForUserId: 'current-user',
  }, 'current-user'), undefined)
})

test('Skill detail only shows Agent tools detected on this machine', () => {
  const detected = [
    { key: 'codex', detected: true },
    { key: 'claude', detected: false },
    { key: 'opencode', detected: true },
  ]
  assert.deepEqual(visibleAgentKeys(detected, { codex: 'on', claude: 'off', opencode: null }), ['codex', 'opencode'])
  assert.deepEqual(detectedAgentOptions(detected).map((agent) => agent.key), ['codex', 'opencode'])
})

test('only the Skill owner gets version-write and sharing controls', () => {
  assert.equal(canManageSkillAsset({ isOwn: true }), true)
  assert.equal(canManageSkillAsset({ isOwn: false }), false)
})

test('new version suggestions advance and skip existing versions', () => {
  assert.equal(suggestNextSkillVersion(''), '0.1.0')
  for (const [current, next] of [['0.1.1', '0.1.2'], ['0.1.9', '0.2.0'], ['0.9.9', '1.0.0'], ['1.9.9', '2.0.0']]) {
    assert.equal(suggestNextSkillVersion(current), next)
  }
  assert.equal(suggestNextSkillVersion('0.1.0', ['0.1.1'], 100), '1.0.1')
  assert.equal(suggestNextSkillVersion('0.1.0', ['9.9.9']), null)
  assert.equal(skillVersionExists('0.1.1', ['0.1.1']), true)
  assert.equal(skillVersionExists('0.1.1', ['0.1.1 · arbitrary message']), false)
  for (const invalid of ['v0.1.0', '0.1.0-personal.3', '1.56.1', '01.1.0', '1.0', '0.1.1 ', '-1.0.0']) {
    assert.equal(skillVersionOrdinal(invalid), null)
    assert.match(skillVersionInputError(invalid, -1) ?? '', /三段/)
  }
  assert.equal(skillVersionInputError('0.0.0', -1), null)
  assert.equal(skillVersionInputError('9.9.9', 30), null)
  assert.equal(skillVersionInputError('1.0.0', 12), null)
  assert.match(skillVersionInputError('0.1.1', 12) ?? '', /历史/)
  assert.match(skillVersionInputError('0.2.0', 12, ['0.2.0']) ?? '', /保留/)
  assert.match(skillVersionInputError('9.9.9', 999) ?? '', /用尽/)
})

test('snapshot defaults remain automatic while an edited number is manual', () => {
  assert.equal(skillSnapshotAllocation('0.1.1', '0.1.1'), 'auto')
  assert.equal(skillSnapshotAllocation('0.2.0', '0.1.1'), 'manual')
  assert.equal(skillSnapshotAllocation('0.0.0', '0.1.1'), 'manual')
  assert.equal(skillSnapshotAllocation('0.1.1', null), 'manual')
  // Another device's save can advance the fresh state after the dialog opens.
  // The original default still asks native code to allocate automatically.
  assert.equal(skillSnapshotInputError('0.1.1', 12, skillSnapshotAllocation('0.1.1', '0.1.1')), null)
  assert.match(skillSnapshotInputError('0.1.1', 12, 'manual') ?? '', /历史/)
  assert.equal(skillSnapshotInputError('0.2.0', 12, 'manual'), null)
  assert.match(skillSnapshotInputError('v0.2.0', 12, 'auto') ?? '', /三段/)
})

test('pending save dialogs show the actual candidate while keeping default auto and edited manual retry behavior', () => {
  const suggestion = skillSnapshotSuggestedVersion({ nextVersion: '0.1.2', pendingLabel: '0.1.1' })
  assert.equal(suggestion, '0.1.1')
  assert.equal(skillSnapshotAllocation(suggestion, suggestion), 'auto')
  assert.equal(skillSnapshotInputError(suggestion, 12, 'auto', '0.1.1'), null)
  assert.equal(skillSnapshotAllocation('0.2.0', suggestion), 'manual')
  assert.equal(skillSnapshotInputError('0.2.0', 12, 'manual', '0.1.1'), null)
  assert.equal(skillSnapshotSuggestedVersion({ nextVersion: '0.1.2', pendingLabel: null }), '0.1.2')
  assert.equal(skillSnapshotSuggestedVersion({ nextVersion: null, pendingLabel: '9.9.9' }), '9.9.9')
  assert.equal(skillSnapshotSuggestedVersion({ nextVersion: null }), '')
})

test('version display keeps real saved labels and reports maintenance failures without inventing a number', () => {
  assert.deepEqual(skillVersionDisplay({ version: '0.2.3', localPath: '/managed/dirty' }), { label: '0.2.3', problem: null })
  assert.deepEqual(skillVersionDisplay({ version: 'v2.0.1', localPath: '/managed/system' }), { label: 'v2.0.1', problem: null })
  const reason = '历史含不安全的符号链接，请核对后再保存'
  assert.deepEqual(skillVersionDisplay({ version: '', localPath: '/managed/problem', versionProblem: reason }), { label: '版本待核对', problem: reason })
  assert.deepEqual(skillVersionDisplay({ version: '9.9.9', localPath: '/managed/exhausted', versionProblem: '版本范围已用尽' }), { label: '9.9.9', problem: '版本范围已用尽' })
  assert.match(skillVersionDisplay({ version: '', localPath: '/managed/missing' }).problem ?? '', /版本信息尚未确认/)
})

test('automatic pending retries can keep the last number without allocating beyond capacity', () => {
  assert.equal(skillSnapshotInputError('9.9.9', 999, 'auto', '9.9.9'), null)
  assert.match(skillSnapshotInputError('9.9.9', 999, 'auto') ?? '', /用尽/)
  assert.match(skillSnapshotInputError('9.9.9', 999, 'manual', '9.9.9') ?? '', /用尽/)
})

test('version history joins stable formal IDs, never matching labels or remote Git hashes', () => {
  const remote = [{ id: 'formal-a', skillId: 's', version: '0.1.0', gitHash: 'other-machine-hash', createdAt: '2026-10-06' }]
  const unrelated = mergeSkillVersionHistory([{ version: '0.1.0', date: 'today', gitHash: 'local-hash', formalVersionId: 'formal-b', versionStatus: 'pending' }], remote)
  assert.equal(unrelated.length, 2)
  assert.equal(unrelated[0].gitHash, undefined)
  assert.equal(unrelated[1].versionStatus, 'pending')
  const linked = mergeSkillVersionHistory([{ version: '0.2.0', date: 'today', gitHash: 'local-hash', formalVersionId: 'formal-a', formalLabel: '0.1.0', isCurrent: true }], remote)
  assert.equal(linked.length, 1)
  assert.equal(linked[0].version, '0.2.0')
  assert.equal(linked[0].formalLabel, '0.1.0')
  assert.equal(linked[0].remoteVersion?.id, 'formal-a')
  assert.equal(linked[0].isCurrent, true)
  const sameCommit = mergeSkillVersionHistory([
    { version: '0.1.0', date: 'today', gitHash: 'same-commit', receiptId: 'receipt-a', formalVersionId: 'formal-a' },
    { version: '0.2.0', date: 'today', gitHash: 'same-commit', receiptId: 'receipt-b', formalVersionId: 'formal-b', isCurrent: true },
  ], [])
  assert.equal(new Set(sameCommit.map(row => row.key)).size, 2)
  assert.deepEqual(sameCommit.map(row => [row.gitHash, row.receiptId, row.isCurrent]), [
    ['same-commit', 'receipt-a', false], ['same-commit', 'receipt-b', true],
  ])
})
