import assert from 'node:assert/strict'
import test from 'node:test'
import {
  envKeyIssue, isRuntimeRequestedEnvDependency, issueForSkill, sameEnvKeySummary, isSystemManagerSkill, isTeamSharedSkill, locallyManagedSkillNames, mapSettledWithConcurrency, matchesAgentInstallation, orderSkillsByName, orderSkillsByTime, orderSkills, orderTeamSharedSkills, reconcileAgentFilter, resolveTeamPreference, summarizeRequiredEnvRows,
  selectedVisibleLocalSkills, splitSkillHubSections,
} from '../src/lib/skill-library.ts'
import type { LocalSkill, Team } from '../src/store/index.ts'
import { envDepsNeedingAttention, formatUpdatedRelative, isNewerSkillVersion, isRowIssueIcon, skillDiagnosticsText, skillOriginLine, teamSkillHasUpdate } from '../src/lib/skill-library.ts'

function skill(overrides: Partial<LocalSkill>): LocalSkill {
  return {
    id: 'skill-1',
    name: 'skill-1',
    displayName: 'Skill 1',
    labels: [],
    version: 'v1.0',
    latestVersion: 'v1.0',
    installCount: 0,
    sources: [],
    agents: {},
    installed: false,
    isOwn: true,
    acquisitionSource: 'local',
    envDeps: [],
    sharedTo: {},
    versions: [],
    compatibleAgents: [],
    localPath: '',
    ...overrides,
  }
}

const teams: Team[] = [
  { id: 'team-1', name: '一队', color: '#3574f0', role: 'member', memberCount: 2, sharedCount: 3 },
  { id: 'team-2', name: '二队', color: '#0ea968', role: 'owner', memberCount: 1, sharedCount: 1 },
]

test('required environment rows separate needing a value from needing a choice', () => {
  const rows = [
    // Personal value or the only available team: ready, never counted.
    { required: true, valid: true, state: 'ready' as const },
    // Several teams offer a value: the user picks once.
    { required: true, valid: false, state: 'needs_choice' as const },
    // Nothing available: the user fills a value in.
    { required: true, valid: false, state: 'needs_value' as const },
    // Older native layer without `state`.
    { required: true, valid: false },
    // Optional keys never count.
    { required: false, valid: true, state: 'needs_choice' as const },
  ]
  assert.deepEqual(summarizeRequiredEnvRows(rows), { needsValue: 2, needsChoice: 1 })
})

test('list key badge: only 需要填写 N 把钥匙 (warning + key-round) or 需要选择, both opening the key section', () => {
  assert.deepEqual(envKeyIssue({ needsValue: 2, needsChoice: 1 }), { label: '需要填写 2 把钥匙', tone: 'warning', icon: 'key-round', target: 'env' })
  assert.deepEqual(envKeyIssue({ needsValue: 0, needsChoice: 3 }), { label: '需要选择', tone: 'warning', icon: 'list', target: 'env' })
  // Ready (and consent-pending, which the policy reports as valid) rows raise no badge.
  assert.equal(envKeyIssue({ needsValue: 0, needsChoice: 0 }), null)
  assert.equal(envKeyIssue(undefined), null)
  assert.equal(sameEnvKeySummary({ needsValue: 1, needsChoice: 0 }, { needsValue: 1, needsChoice: 0 }), true)
  assert.equal(sameEnvKeySummary({ needsValue: 1, needsChoice: 0 }, { needsValue: 0, needsChoice: 1 }), false)
  const skill = { agents: {}, isOrphan: false, hasWorkingCopy: false, accountSyncRequired: false }
  assert.equal(issueForSkill(skill, summarizeRequiredEnvRows([{ required: true, valid: true, state: 'ready' }]), false, true, null), null)
  assert.equal(issueForSkill(skill, undefined, true, true, null)?.label, '钥匙检查未完成')
  for (const old of ['缺少', '项配置']) assert.ok(!envKeyIssue({ needsValue: 1, needsChoice: 0 })!.label.includes(old))
})

test('runtime-requested environment dependencies are recognised by origin', () => {
  assert.equal(isRuntimeRequestedEnvDependency({ origin: 'runtime_request' }), true)
  assert.equal(isRuntimeRequestedEnvDependency({}), false)
  assert.equal(isRuntimeRequestedEnvDependency({ origin: 'declared' }), false)
})

test('team preference defaults to the first team and keeps explicit none or a valid recent team', () => {
  assert.equal(resolveTeamPreference(null, teams), 'team-1')
  assert.equal(resolveTeamPreference('none', teams), null)
  assert.equal(resolveTeamPreference('team-2', teams), 'team-2')
  assert.equal(resolveTeamPreference('deleted-team', teams), 'team-1')
  assert.equal(resolveTeamPreference(null, []), null)
})

test('Agent filter includes healthy and broken projections only', () => {
  assert.equal(matchesAgentInstallation(skill({ agents: { claude: 'on' } }), 'claude'), true)
  assert.equal(matchesAgentInstallation(skill({ agents: { claude: 'broken' } }), 'claude'), true)
  assert.equal(matchesAgentInstallation(skill({ agents: { claude: 'off' } }), 'claude'), false)
  assert.equal(matchesAgentInstallation(skill({ agents: { claude: null } }), 'claude'), false)
  assert.equal(matchesAgentInstallation(skill({ agents: {} }), 'claude'), false)
})

test('Agent filter resets only after successful detection confirms removal', () => {
  const detected = new Set(['claude'])
  assert.equal(reconcileAgentFilter('codex', false, new Set()), 'codex')
  assert.equal(reconcileAgentFilter('claude', true, detected), 'claude')
  assert.equal(reconcileAgentFilter('codex', true, detected), '')
})

test('only selected-team remote shares appear as uninstalled', () => {
  const personalRemote = skill({ id: 'personal', name: 'personal', isOwn: true })
  const downloadedTeam = skill({ id: 'downloaded', name: 'downloaded', isOwn: false, teamSharedFrom: 'team-2', localPath: '/managed/downloaded' })
  const selectedRemote = skill({ id: 'selected', name: 'selected', isOwn: false, teamSharedFrom: 'team-2' })
  const inactiveRemote = skill({ id: 'inactive', name: 'inactive', isOwn: false, teamSharedFrom: 'team-1' })

  const selected = splitSkillHubSections([personalRemote, downloadedTeam, selectedRemote, inactiveRemote], 'team-2')
  assert.deepEqual(selected.installed.map((item) => item.id), ['personal', 'downloaded'])
  assert.deepEqual(selected.uninstalled.map((item) => item.id), ['selected'])

  const hidden = splitSkillHubSections([personalRemote, downloadedTeam, selectedRemote], null)
  assert.deepEqual(hidden.installed.map((item) => item.id), ['personal', 'downloaded'])
  assert.deepEqual(hidden.uninstalled, [])
})

test('remote metadata with the same name does not hide a real unmanaged local Skill', () => {
  const remoteOnly = skill({ id: 'remote', name: 'shared-name', localPath: '' })
  const managed = skill({ id: 'managed', name: 'managed-name', localPath: '/managed/managed-name' })
  assert.deepEqual([...locallyManagedSkillNames([remoteOnly, managed])], ['managed-name'])
})

test('My Skills sorts actual Skill names alphabetically without changing source order', () => {
  const source = [
    { id: 'ten', name: 'skill-10' },
    { id: 'bill', name: 'Bill-toolbox' },
    { id: 'two', name: 'skill-2' },
    { id: 'alpha', name: 'alpha' },
  ]
  assert.deepEqual(orderSkillsByName(source).map((item) => item.id), ['alpha', 'bill', 'two', 'ten'])
  // 按时间 (#361): newest first by updatedAt then createdAt; undated Skills keep name order at the end.
  const dated = [
    { id: 'old', name: 'old', createdAt: '2026-01-01T00:00:00Z' },
    { id: 'edited', name: 'edited', createdAt: '2026-01-02T00:00:00Z', updatedAt: '2026-03-01T00:00:00Z' },
    { id: 'undated-b', name: 'zeta' },
    { id: 'new', name: 'new', createdAt: '2026-02-01T00:00:00Z' },
    { id: 'undated-a', name: 'alpha' },
    { id: 'bad', name: 'bad', createdAt: 'not a date' },
  ]
  assert.deepEqual(orderSkillsByTime(dated).map((item) => item.id), ['edited', 'new', 'old', 'undated-a', 'bad', 'undated-b'])
  assert.deepEqual(orderSkills(dated, 'name').map((item) => item.id), orderSkillsByName(dated).map((item) => item.id))
  assert.deepEqual(source.map((item) => item.id), ['ten', 'bill', 'two', 'alpha'])
})

test('system Manager stays managed but is hidden from personal list identity', () => {
  assert.equal(isSystemManagerSkill(skill({ id: 'yitan-skillhub-manager' })), true)
  assert.equal(isSystemManagerSkill(skill({ id: 'other', name: 'yitan-skillhub-manager' })), true)
  assert.equal(isSystemManagerSkill(skill({ id: 'ordinary', isSystem: true })), true)
  assert.equal(isSystemManagerSkill(skill({ id: 'ordinary' })), false)
})

test('team sharing only marks a current-account, active-team managed Skill', () => {
  const memberTeams = new Set(['team-1'])
  const owned = skill({ localPath: '/managed/owned', serverId: 'server-1', sharedTo: { 'team-1': { version: 'v1.0', envShared: false } }, serverAccessValidatedForUserId: 'user-1' })
  const teamInstalled = skill({ localPath: '/managed/team', serverId: 'server-2', teamSharedFrom: 'team-1' })
  assert.equal(isTeamSharedSkill(owned, 'user-1', memberTeams), true)
  assert.equal(isTeamSharedSkill(teamInstalled, 'user-1', memberTeams), true)
  assert.equal(isTeamSharedSkill(owned, 'user-2', memberTeams), false)
  assert.equal(isTeamSharedSkill(owned, 'user-1', new Set(['team-2'])), false)
  assert.equal(isTeamSharedSkill(skill({ ...owned, accountSyncRequired: true }), 'user-1', memberTeams), false)
  assert.equal(isTeamSharedSkill(skill({ ...owned, isSystem: true }), 'user-1', memberTeams), false)
  assert.equal(isTeamSharedSkill(skill({ ...owned, localPath: '' }), 'user-1', memberTeams), false)
})

test('team catalog filters uninstalled Skills and sorts by latest or downloads', () => {
  const olderPopular = skill({ id: 'popular', displayName: '热门', installed: true, installCount: 31, updatedAt: '2026-08-01T00:00:00.000Z' })
  const newest = skill({ id: 'newest', displayName: '最新', installed: false, installCount: 4, updatedAt: '2026-08-03T00:00:00.000Z' })
  const olderUninstalled = skill({ id: 'older', displayName: '较早', installed: false, installCount: 9, updatedAt: '2026-08-02T00:00:00.000Z' })

  assert.deepEqual(
    orderTeamSharedSkills([olderPopular, olderUninstalled, newest], 'all', 'latest').map((item) => item.id),
    ['newest', 'older', 'popular'],
  )
  assert.deepEqual(
    orderTeamSharedSkills([newest, olderPopular, olderUninstalled], 'all', 'downloads').map((item) => item.id),
    ['popular', 'older', 'newest'],
  )
  assert.deepEqual(
    orderTeamSharedSkills([olderPopular, olderUninstalled, newest], 'uninstalled', 'latest').map((item) => item.id),
    ['newest', 'older'],
  )
})

test('batch selection excludes selected local Skills hidden by the current filter', () => {
  const visible = [
    { id: 'visible', name: 'visible-skill' },
    { id: 'managed', name: 'managed-skill' },
  ]
  const selected = new Set(['visible', 'hidden', 'managed'])
  assert.deepEqual(
    selectedVisibleLocalSkills(visible, selected, new Set(['managed-skill'])),
    [{ id: 'visible', name: 'visible-skill' }],
  )
})

test('batch work retains order, failures and a hard concurrency limit', async () => {
  let active = 0
  let peak = 0
  const results = await mapSettledWithConcurrency([0, 1, 2, 3, 4], 2, async (value) => {
    active += 1
    peak = Math.max(peak, active)
    await new Promise<void>((resolve) => setImmediate(resolve))
    active -= 1
    if (value === 2) throw new Error('broken package')
    return `done-${value}`
  })

  assert.equal(peak, 2)
  assert.deepEqual(results.map((result) => result.status), ['fulfilled', 'fulfilled', 'rejected', 'fulfilled', 'fulfilled'])
  assert.equal(results[0]?.status === 'fulfilled' ? results[0].value : null, 'done-0')
  assert.match(results[2]?.status === 'rejected' ? String(results[2].reason) : '', /broken package/)
})

const NOW_289 = new Date(2026, 9, 14, 15, 0).getTime()

test('更新于 is relative: 今天 / 昨天 / N 天前 / M月D日, other years add the year, invalid is null', () => {
  assert.equal(formatUpdatedRelative(new Date(2026, 9, 14, 9, 0).toISOString(), NOW_289), '今天')
  assert.equal(formatUpdatedRelative(new Date(2026, 9, 13, 23, 0).toISOString(), NOW_289), '昨天')
  assert.equal(formatUpdatedRelative(new Date(2026, 9, 10, 8, 0).toISOString(), NOW_289), '4 天前')
  assert.equal(formatUpdatedRelative(new Date(2026, 8, 2, 8, 0).toISOString(), NOW_289), '9月2日')
  assert.equal(formatUpdatedRelative(new Date(2025, 11, 31, 8, 0).toISOString(), NOW_289), '2025年12月31日')
  assert.equal(formatUpdatedRelative(undefined, NOW_289), null)
  assert.equal(formatUpdatedRelative('not a date', NOW_289), null)
})

test('origin line: source from acquisition fields, author chip only when known, 你 for the current account', () => {
  const updatedAt = new Date(2026, 9, 13, 10, 0).toISOString()
  const store = skillOriginLine(skill({ acquisitionSource: 'marketplace', localPath: '/x', authorName: 'Bill', serverOwnerId: 'u-bill', updatedAt }), { currentUserId: 'u-me' }, NOW_289)
  assert.deepEqual(store, { source: '从商店安装', author: { name: 'Bill', me: false, label: '上传者' }, updated: '昨天' })
  const listing = skillOriginLine(skill({ acquisitionSource: 'marketplace', authorName: 'Bill', marketplacePublishedAt: updatedAt }), { currentUserId: null, storeListing: true }, NOW_289)
  assert.equal(listing.source, 'Skill 商店')
  assert.equal(listing.updated, '昨天')
  const team = skillOriginLine(skill({ acquisitionSource: 'team', teamSharedFrom: 'team-1' }), { currentUserId: 'u-me', teamName: '一队' }, NOW_289)
  assert.deepEqual(team, { source: '团队「一队」共享', author: null, updated: null })
  assert.equal(skillOriginLine(skill({ teamSharedFrom: 'gone' }), { currentUserId: null }, NOW_289).source, '团队共享')
  const mine = skillOriginLine(skill({ serverOwnerId: 'u-me', sources: ['本机创建'] }), { currentUserId: 'u-me' }, NOW_289)
  assert.deepEqual(mine.author, { name: '', me: true, label: '作者' })
  assert.equal(mine.source, '本机创建')
  assert.equal(skillOriginLine(skill({ sources: ['本机'] }), { currentUserId: null }, NOW_289).source, '从本机导入')
})

test('row warning icons cover every issue except 已修改; key tab count uses required unconfigured envDeps', () => {
  assert.equal(isRowIssueIcon({ label: '已修改', icon: 'hist' }), false)
  assert.equal(isRowIssueIcon({ label: '安装有问题', icon: 'warn' }), true)
  assert.equal(isRowIssueIcon(null), false)
  assert.equal(envDepsNeedingAttention([
    { required: true, configured: false }, { required: true, configured: true }, { required: false, configured: false },
  ]), 1)
  const version = issueForSkill({ agents: {}, isOrphan: false, hasWorkingCopy: false, accountSyncRequired: false }, undefined, false, true, '本机版本与记录不一致')
  assert.equal(version?.title, '版本需要处理\n本机版本与记录不一致')
})

test('诊断信息 is plain text: identity, path, version, each Agent state and the last run; no key values', () => {
  const text = skillDiagnosticsText(skill({ id: 'demo', name: 'demo', displayName: '演示', localPath: '/Users/a/demo', version: '1.2.0', versionStatus: 'confirmed', agents: { claude: 'broken', codex: 'on' } }), {
    version: 1, skillId: 'demo', at: new Date(2026, 9, 14, 10, 42).getTime(), outcome: 'failed', reasonCode: 'missing_key', keys: ['API_TOKEN'], exitCode: null, agent: 'claude', message: '',
  }, NOW_289)
  assert.equal(text, [
    'Skill：demo（演示）', 'ID：demo', '本机路径：/Users/a/demo', '版本：1.2.0（confirmed）', 'Agent：',
    '  - Claude Code：安装有问题', '  - ChatGPT：已安装',
    '上次运行：上次运行失败 · 今天 10:42 · Claude Code · 缺少钥匙 API_TOKEN，Skill 没有拿到它就停止了。',
  ].join('\n'))
  assert.match(skillDiagnosticsText(skill({ isOrphan: true })), /资料：暂不可用\nAgent：无$/)
})

test('team origin line names the member who shared it as 共享者 (#295 board 9)', () => {
  const shared = skillOriginLine(skill({ acquisitionSource: 'team', teamSharedFrom: 'team-1', authorName: 'Author', sharedBy: { id: 'u-li', displayName: '李雷', avatarUrl: null } }), { currentUserId: 'u-me', teamName: '一探内容组' }, NOW_289)
  assert.deepEqual(shared, { source: '团队「一探内容组」共享', author: { name: '李雷', me: false, label: '共享者', avatarUrl: null }, updated: null })
  const mine = skillOriginLine(skill({ acquisitionSource: 'team', teamSharedFrom: 'team-1', sharedBy: { id: 'u-me', displayName: '小庄Sir' } }), { currentUserId: 'u-me', teamName: '一队' }, NOW_289)
  assert.equal(mine.author?.me, true)
  // Without sharedBy the author stays the fallback.
  const fallback = skillOriginLine(skill({ acquisitionSource: 'team', teamSharedFrom: 'team-1', authorName: 'Author' }), { currentUserId: null, teamName: '一队' }, NOW_289)
  assert.deepEqual(fallback.author, { name: 'Author', me: false, label: '作者' })
})

test('有更新 compares dotted versions; 可获取 / 有更新 filter the team catalog (#295)', () => {
  assert.equal(isNewerSkillVersion('0.3.1', '0.3.0'), true)
  assert.equal(isNewerSkillVersion('0.3.10', '0.3.9'), true)
  assert.equal(isNewerSkillVersion('v1.2', 'v1.10'), false)
  assert.equal(isNewerSkillVersion('0.3.0', '0.3.0'), false)
  assert.equal(isNewerSkillVersion('beta', '0.1.0'), false)
  assert.equal(isNewerSkillVersion(undefined, '0.1.0'), false)
  assert.equal(teamSkillHasUpdate({ version: '0.1.0', latestVersion: '0.2.0', localPath: '/x' }), true)
  assert.equal(teamSkillHasUpdate({ version: '0.1.0', latestVersion: '0.2.0', localPath: '' }), false)
  const base = { installCount: 0, installed: false, updatedAt: '2026-10-01T00:00:00Z' }
  const items = [
    { ...base, displayName: 'a', localPath: '/a', version: '0.1.0', latestVersion: '0.2.0' },
    { ...base, displayName: 'b', localPath: '/b', version: '0.2.0', latestVersion: '0.2.0' },
    { ...base, displayName: 'c', localPath: '', version: '0.2.0', latestVersion: '0.2.0' },
  ]
  assert.deepEqual(orderTeamSharedSkills(items, 'updates', 'latest').map((item) => item.displayName), ['a'])
  assert.deepEqual(orderTeamSharedSkills(items, 'uninstalled', 'latest').map((item) => item.displayName), ['c'])
})
