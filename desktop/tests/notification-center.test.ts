import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  actionableNotificationCount, bellAriaLabel, buildNotificationEntries, consentEntry, filterNotificationEntries,
  notificationBadgeText, notificationTabCount, notificationTimeLabel, recentNotifications, richText, runFailureAction, runFailureEntry,
  serverEntry, unreadNotificationCount, withinNotificationWindow, type ServerNotification,
} from '../src/lib/notification-center.ts'
import { activitySentence, activitySentenceText, appendActivityPage, type TeamActivityItem } from '../src/lib/team-activity.ts'
import type { LastRunRecord } from '../src/lib/tauri.ts'

const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const read = (path: string): string => readFileSync(resolve(desktopRoot, path), 'utf8')

const NOW = new Date(2026, 9, 14, 12, 0).getTime()
const at = (days: number, hours = 10, minutes = 42): number => {
  const date = new Date(NOW)
  date.setDate(date.getDate() - days)
  date.setHours(hours, minutes, 0, 0)
  return date.getTime()
}

function notice(id: string, type: string, payload: Record<string, unknown>, read = false, createdAt = new Date(at(0)).toISOString()): ServerNotification {
  return { id, type, payload, read, createdAt }
}

function run(overrides: Partial<LastRunRecord> = {}): LastRunRecord {
  return {
    version: 1, skillId: 'zsir-imagegen', at: at(0), outcome: 'failed', reasonCode: 'missing_key',
    keys: ['REPLICATE_API_TOKEN'], exitCode: null, agent: 'claude', message: null, ...overrides,
  }
}

test('server notices older than 30 days are hidden; unreadable dates stay', () => {
  assert.equal(withinNotificationWindow(new Date(at(29)).toISOString(), NOW), true)
  assert.equal(withinNotificationWindow(new Date(at(31)).toISOString(), NOW), false)
  assert.equal(withinNotificationWindow('not a date', NOW), true)
  const items = [notice('a', 'admin_broadcast', {}, false, new Date(at(1)).toISOString()), notice('b', 'admin_broadcast', {}, false, new Date(at(40)).toISOString())]
  assert.deepEqual(recentNotifications(items, NOW).map((item) => item.id), ['a'])
})

test('time label: 今天 HH:MM / 昨天 / M月D日 / YYYY年M月D日', () => {
  assert.equal(notificationTimeLabel(at(0), NOW), '今天 10:42')
  assert.equal(notificationTimeLabel(at(1), NOW), '昨天')
  assert.equal(notificationTimeLabel(new Date(2026, 9, 2, 8, 0).getTime(), NOW), '10月2日')
  assert.equal(notificationTimeLabel(new Date(2025, 11, 31, 8, 0).getTime(), NOW), '2025年12月31日')
  assert.equal(notificationTimeLabel(Number.NaN, NOW), '时间未知')
})

test('run failure: 「<skill> 运行失败」, 缺少钥匙 <code>, Agent and time; key reasons go to 去填写', () => {
  const entry = runFailureEntry(run(), 'zsir-imagegen', NOW)
  assert.equal(richText(entry.title), 'zsir-imagegen 运行失败')
  assert.deepEqual(entry.description, ['缺少钥匙 ', { code: 'REPLICATE_API_TOKEN' }, '。Claude Code 在 10:42 调用时停止了。'])
  assert.equal(entry.actionable, true)
  assert.equal(entry.tone, 'danger')
  assert.equal(runFailureAction(run()), 'fill-keys')
  assert.equal(runFailureAction(run({ reasonCode: 'exit_code' })), 'view-skill')
  assert.equal(richText(runFailureEntry(run({ reasonCode: 'exit_code', exitCode: 2, at: at(1, 9, 5) }), 's', NOW).description), '程序退出码 2。Claude Code 在 昨天 09:05 调用时停止了。')
  assert.equal(richText(runFailureEntry(run({ reasonCode: 'needs_choice', agent: null }), 's', NOW).description), '需要选择用哪把钥匙 REPLICATE_API_TOKEN。Agent 在 10:42 调用时停止了。')
  assert.equal(richText(runFailureEntry(run({ reasonCode: 'other', message: '超时' }), 's', NOW).description), '超时')
})

test('consent request: 「<skill> 想使用你的 <code>KEY</code>」 with the store copy', () => {
  const entry = consentEntry({ skillId: 'baoyu', skillName: 'baoyu-infographic', keys: ['FAL_KEY'], requestedAt: at(0) })
  assert.deepEqual(entry.title, ['baoyu-infographic 想使用你的 ', { code: 'FAL_KEY' }])
  assert.equal(richText(entry.description), '这个 Skill 来自商店，第一次用到你的钥匙。')
  assert.equal(entry.actionable, true)
  assert.equal(entry.id, `consent:baoyu:${at(0)}`)
})

test('server items: join request (UserChip applicant, actionable while unread), key scope, mention, others', () => {
  const join = serverEntry(notice('n1', 'join_request', { teamId: 't', teamName: '一探内容组', requestId: 'r', applicantId: 'u-w', applicantName: '王小明' }))
  assert.deepEqual(join.title, [{ user: { name: '王小明', me: false } }, ' 申请加入「一探内容组」'])
  assert.equal(join.actionable, true)
  assert.equal(join.category, 'team')
  assert.equal(serverEntry(notice('n1', 'join_request', { applicantName: '王小明' }, true)).actionable, false)

  const scope = serverEntry(notice('n2', 'team_key_scope_added', { message: 'seedance-prompt 已共享到「一探内容组」，会用到你放的 FAL_KEY。' }))
  assert.equal(richText(scope.title), '团队钥匙有新的使用者')
  assert.equal(richText(scope.description), 'seedance-prompt 已共享到「一探内容组」，会用到你放的 FAL_KEY。')
  assert.equal(scope.icon, 'key-round')

  const mention = serverEntry(notice('n3', 'comment_mention', { actorId: 'u-li', actorName: '李雷', skillName: 'davinci-edit-master', teamName: '一队', excerpt: '这个版本的转场参数能共享一下吗' }), 'u-me')
  assert.deepEqual(mention.title, [{ user: { name: '李雷', me: false } }, ' 在讨论中 @ 你'])
  assert.equal(richText(mention.description), 'davinci-edit-master · 「这个版本的转场参数能共享一下吗」')
  assert.equal(richText(serverEntry(notice('n4', 'comment_mention', { actorName: '李雷', skillName: 'x', teamName: '一队' })).description), 'x · 一队')

  const approved = serverEntry(notice('n5', 'marketplace_approved', { skillName: 'hot-topics', version: '0.2.2' }, true))
  assert.equal(richText(approved.title), 'Skill 商店审核通过')
  assert.equal(richText(approved.description), 'hot-topics · 0.2.2')
  assert.equal(approved.category, 'store')
  assert.equal(approved.unread, false)
  assert.equal(serverEntry(notice('n6', 'admin_broadcast', { message: '你好' })).category, 'system')
  assert.equal(richText(serverEntry(notice('n7', 'unknown_type', {})).title), '系统通知')
})

test('team publication and unshare notifications retain their exact team navigation target', () => {
  for (const type of ['skill_update', 'skill_unshared']) {
    const entry = serverEntry(notice('team-change', type, { skillId: 'skill-a', teamId: 'team-b', skillName: 'Demo', version: '0.1.2' }))
    assert.equal(entry.category, 'team')
    assert.deepEqual(entry.notification?.payload, { skillId: 'skill-a', teamId: 'team-b', skillName: 'Demo', version: '0.1.2' })
    if (type === 'skill_unshared') assert.equal(richText(entry.title), '团队已停止共享 · 本机副本保留')
  }
  const center = read('src/components/NotificationCenter.tsx')
  const branch = center.slice(center.indexOf("if (notification.type === 'skill_update'"), center.indexOf("if (notification.type !== 'comment_mention'"))
  assert.match(branch, /openTeamSkill\(teamId, skillId\)/)
  assert.match(branch, /if \(teamId && skillId\)/)
  assert.match(branch, /markRead\(notification.id\)/)
})

test('entries: local items first by time, counts, filters and the 99+ badge', () => {
  const entries = buildNotificationEntries({
    notifications: [
      notice('j', 'join_request', { applicantName: '王小明', teamName: '一队' }, false, new Date(at(0, 9)).toISOString()),
      notice('m', 'marketplace_rejected', { skillName: 'x' }, true, new Date(at(2)).toISOString()),
      notice('old', 'team_created', { teamName: '旧' }, false, new Date(at(45)).toISOString()),
    ],
    runFailures: [run(), run({ skillId: 'ok-skill', outcome: 'ok' })],
    consentRequests: [{ skillId: 'baoyu', skillName: 'baoyu-infographic', keys: ['FAL_KEY'], requestedAt: at(0, 10, 30) }],
    skillName: (id) => id === 'zsir-imagegen' ? 'zsir-imagegen' : id,
    now: NOW,
  })
  assert.deepEqual(entries.map((entry) => entry.id), ['run:zsir-imagegen', `consent:baoyu:${at(0, 10, 30)}`, 'server:j', 'server:m'])
  assert.equal(unreadNotificationCount(entries), 3)
  assert.equal(actionableNotificationCount(entries), 3)
  assert.deepEqual(filterNotificationEntries(entries, 'team').map((entry) => entry.id), ['server:j'])
  assert.deepEqual(filterNotificationEntries(entries, 'store').map((entry) => entry.id), ['server:m'])
  assert.equal(filterNotificationEntries(entries, 'action').length, 3)
  assert.equal(notificationTabCount(entries, 'all'), 4)
  assert.equal(notificationTabCount(entries, 'action'), 3)
  assert.equal(notificationTabCount(entries, 'team'), 1)
  assert.equal(notificationTabCount(entries, 'store'), 1)
  assert.equal(notificationTabCount([], 'all'), undefined)
  assert.equal(notificationBadgeText(7), '7')
  assert.equal(notificationBadgeText(120), '99+')
  assert.equal(bellAriaLabel(4), '通知，4 条未读')
  assert.equal(bellAriaLabel(0), '通知')
})

test('notification popover: tab badges count listed items, unread stays separate, fixed height (#319)', () => {
  const center = read('src/components/NotificationCenter.tsx')
  for (const filter of ['all', 'action', 'team', 'store']) {
    assert.match(center, new RegExp(`value: '${filter}'[^}]*count: notificationTabCount\\(entries, '${filter}'\\)`))
  }
  assert.doesNotMatch(center, /count: unread/)
  assert.match(center, /\{unread > 0 && <span className="notification-unread">\{unread\} 条未读<\/span>\}/)
  const app = read('src/styles/app.css')
  assert.match(app, /\.notification-popover\{[^}]*;height:min\(560px,calc\(100vh - 32px\)\)/)
  assert.doesNotMatch(app, /\.notification-popover\{[^}]*max-height/)
  const sidebar = read('src/components/Sidebar.css')
  assert.match(sidebar, /\.notification-head \{ flex: none;/)
  assert.match(sidebar, /\.notification-filter \{ flex: none;/)
  assert.match(sidebar, /\.notification-list \{ flex: 1; min-height: 0; overflow-y: auto;/)
  assert.match(sidebar, /\.notification-empty \{ box-sizing: border-box; min-height: 100%;/)
})

function activity(type: string, payload: Record<string, unknown>, actor: TeamActivityItem['actor'] = { id: 'u-li', displayName: '李雷' }): TeamActivityItem {
  return { id: `${type}-1`, type, actor, payload, createdAt: '2026-10-14T02:00:00.000Z' }
}

test('activity sentences: actor UserChip + Chinese verb + Skill / key / person', () => {
  assert.equal(activitySentenceText(activity('skill_shared', { skillId: 's', skillName: 'seedance-prompt' })), '李雷 共享了 seedance-prompt')
  assert.equal(activitySentenceText(activity('skill_unshared', { skillName: 'seedance-prompt' })), '李雷 停止共享 seedance-prompt')
  assert.equal(activitySentenceText(activity('skill_version_published', { skillName: 'seedance-prompt', version: '0.3.1' })), '李雷 发布了 seedance-prompt 0.3.1')
  assert.equal(activitySentenceText(activity('member_joined', { userId: 'u-w', displayName: '王小明', via: 'invite' }, { id: 'u-w', displayName: '王小明' })), '王小明 加入了团队')
  assert.equal(activitySentenceText(activity('member_left', { userId: 'u-h', displayName: '韩梅梅' }, { id: 'u-h', displayName: '韩梅梅' })), '韩梅梅 离开了团队')
  assert.equal(activitySentenceText(activity('member_removed', { userId: 'u-c', displayName: '陈晨' }, { id: 'u-me', displayName: '小庄Sir' }), 'u-me'), '你 移出了 陈晨')
  assert.equal(activitySentenceText(activity('key_put', { envKey: 'FAL_KEY', holderId: 'u-me' }, { id: 'u-me', displayName: '小庄Sir' })), '小庄Sir 放了钥匙 FAL_KEY')
  assert.equal(activitySentenceText(activity('key_rotated', { envKey: 'FAL_KEY' })), '李雷 更换了钥匙 FAL_KEY')
  assert.equal(activitySentenceText(activity('key_revoked', { envKey: 'FAL_KEY' })), '李雷 撤销了钥匙 FAL_KEY')
  assert.equal(activitySentenceText(activity('something_new', {}, null)), '成员 更新了团队')
  const parts = activitySentence(activity('key_put', { envKey: 'FAL_KEY' }), 'u-li')
  assert.deepEqual(parts, [{ kind: 'user', name: '李雷', me: true, avatarUrl: undefined }, { kind: 'text', text: '放了钥匙' }, { kind: 'key', text: 'FAL_KEY' }])
  const first = [activity('key_put', {}), activity('key_revoked', {})]
  assert.deepEqual(appendActivityPage(first, [activity('key_put', {}), activity('skill_shared', {})]).map((item) => item.id), ['key_put-1', 'key_revoked-1', 'skill_shared-1'])
})

test('My Team detail: tabs, ⋯ menu, request bar, keys tab and activity feed are wired (#295 board 8)', () => {
  const sheet = read('src/components/TeamDetailSheet.tsx')
  assert.match(sheet, /\{ key: 'members', label: '成员', icon: 'users-round'/)
  assert.match(sheet, /\{ key: 'skills', label: '共享 Skill', icon: 'shared-skills'/)
  assert.match(sheet, /\{ key: 'keys', label: '钥匙', icon: 'key-round'/)
  assert.match(sheet, /\{ key: 'activity', label: '动态', icon: 'activity' \}/)
  assert.match(sheet, /role="tablist" aria-label="团队详情"/)
  assert.match(sheet, /const moreLabel = isOwner \? '更多：编辑资料、解散团队' : '更多：退出团队'/)
  assert.match(sheet, /escapeDisabled=\{moreOpen\}/)
  assert.match(sheet, /<UserChip name=\{applicantName\}[^>]*\/> 申请加入团队/)
  assert.match(sheet, /listTeamKeys\(teamId, accountUserId\)/)
  assert.match(sheet, /setKeysPageIntent\(\{ tab: 'team' \}\)\n\s*setView\('keys'\)/)
  assert.match(sheet, />在钥匙页管理<\/button>/)
  assert.match(sheet, /<TeamActivityFeed teamId=\{teamId\} \/>/)
  const feed = read('src/components/TeamActivityFeed.tsx')
  assert.match(feed, /apiGetTeamActivity\(teamId, \{ limit: TEAM_ACTIVITY_PAGE_SIZE, before: nextBefore \}\)/)
  assert.match(feed, /'加载更多'/)
  assert.match(feed, /还没有动态/)
  const page = read('src/pages/TeamsPage.tsx')
  assert.match(page, /aria-label=\{`\$\{pending\} 个待处理申请`\}/)
  assert.match(page, / · 创建者 <UserChip name=\{owner\.displayName\}/)
  assert.match(page, /apiGetJoinRequests\(team\.id\)/)
})
