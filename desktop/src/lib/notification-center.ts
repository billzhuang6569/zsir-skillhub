import type { KeyConsentRequest, LastRunRecord, VaultKey } from './tauri.js'
import { consentKeysText } from './keys.ts'
import { agentDisplayName } from './agents.ts'

/**
 * 通知中心 (#295 board 3): server notifications plus local, actionable items
 * (failed `skillhub run` records and pending key consent requests) in one
 * list. Everything here is pure so the popover only renders.
 */

export type ServerNotification = {
  id: string
  type: string
  payload: Record<string, unknown>
  read: boolean
  createdAt: string
}

/** Only the last 30 days are shown; the Server returns the newest 50. */
export const NOTIFICATION_WINDOW_DAYS = 30
const DAY_MS = 86_400_000

export const NOTIFICATION_TITLES: Record<string, string> = {
  team_created: '团队已创建',
  join_request: '团队加入申请',
  team_member_joined: '新成员加入团队',
  admin_broadcast: 'SkillHub 来信',
  join_approved: '加入团队已批准',
  join_rejected: '加入团队未批准',
  team_dissolved: '团队已解散',
  team_member_removed: '已被移出团队',
  team_member_left: '团队成员已退出',
  skill_update: 'Skill 更新',
  marketplace_approved: 'Skill 商店审核通过',
  marketplace_rejected: 'Skill 商店审核未通过',
  marketplace_withdrawn: 'Skill 已被商店下架',
  comment_mention: '有人在讨论中 @ 你',
  team_key_scope_added: '团队钥匙有新的使用者',
}

export function payloadText(payload: Record<string, unknown>, key: string): string | null {
  const value = payload[key]
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

/** Plain description of a server notification (types without a dedicated layout). */
export function notificationDescription(payload: Record<string, unknown>): string {
  const teamName = payloadText(payload, 'teamName')
  const applicantName = payloadText(payload, 'applicantName')
  const memberName = payloadText(payload, 'displayName')
  const message = payloadText(payload, 'message')
  const skillName = payloadText(payload, 'skillName')
  const version = payloadText(payload, 'version')
  const reviewNote = payloadText(payload, 'reviewNote')
  const actorName = payloadText(payload, 'actorName')
  if (actorName && skillName) return `${actorName} 在 ${skillName} @你`
  if (message) return message
  if (memberName && teamName) return `${memberName} 通过邀请加入了「${teamName}」`
  if (applicantName && teamName) return `${applicantName} · ${teamName}`
  if (skillName) {
    const skillSummary = version ? `${skillName} · ${version}` : skillName
    return reviewNote ? `${skillSummary} · ${reviewNote}` : skillSummary
  }
  return teamName ?? '账号与团队状态已更新'
}

/** Text, a monospace key name, or a person rendered as a UserChip. */
export type RichSegment = string | { code: string } | { user: { name: string; me: boolean } }

export type NotificationCategory = 'team' | 'store' | 'system'
export type NotificationFilter = 'all' | 'action' | 'team' | 'store'
export type NotificationTone = 'danger' | 'warning' | 'brand' | 'success' | 'muted'
export type NotificationIcon = 'warn' | 'key-round' | 'user-plus' | 'users-round' | 'msg' | 'refresh' | 'market' | 'bell'

export type NotificationEntry = {
  /** `server:<id>`, `run:<skillId>` or `consent:<skillId>:<requestedAt>`. */
  id: string
  origin: 'server' | 'run-failure' | 'consent'
  type: string
  category: NotificationCategory
  /** Shown under 「需要处理」 and carries inline buttons. */
  actionable: boolean
  unread: boolean
  /** Unix milliseconds. */
  at: number
  icon: NotificationIcon
  tone: NotificationTone
  title: RichSegment[]
  description: RichSegment[]
  notification?: ServerNotification
  runFailure?: LastRunRecord
  consent?: KeyConsentRequest
}

function timestamp(value: string): number {
  const at = Date.parse(value)
  return Number.isNaN(at) ? 0 : at
}

/** Server items older than 30 days are hidden (items with an unreadable date stay visible). */
export function withinNotificationWindow(createdAt: string, now: number = Date.now()): boolean {
  const at = Date.parse(createdAt)
  return Number.isNaN(at) || now - at <= NOTIFICATION_WINDOW_DAYS * DAY_MS
}

export function recentNotifications<T extends { createdAt: string }>(items: readonly T[], now: number = Date.now()): T[] {
  return items.filter((item) => withinNotificationWindow(item.createdAt, now))
}

function twoDigits(value: number): string {
  return String(value).padStart(2, '0')
}

function dayDistance(at: number, now: number): number {
  const today = new Date(now)
  today.setHours(0, 0, 0, 0)
  const day = new Date(at)
  day.setHours(0, 0, 0, 0)
  return Math.round((today.getTime() - day.getTime()) / DAY_MS)
}

/** 「今天 10:42」/「昨天」/「10月12日」 (other years add 「YYYY年」). */
export function notificationTimeLabel(at: number, now: number = Date.now()): string {
  if (!Number.isFinite(at) || at <= 0) return '时间未知'
  const time = new Date(at)
  const days = dayDistance(at, now)
  if (days <= 0) return `今天 ${twoDigits(time.getHours())}:${twoDigits(time.getMinutes())}`
  if (days === 1) return '昨天'
  const date = `${time.getMonth() + 1}月${time.getDate()}日`
  return time.getFullYear() === new Date(now).getFullYear() ? date : `${time.getFullYear()}年${date}`
}

/** 「10:42」 today, 「昨天 10:42」 / 「10月12日 10:42」 otherwise. */
function runClock(at: number, now: number): string {
  const time = new Date(at)
  const clock = `${twoDigits(time.getHours())}:${twoDigits(time.getMinutes())}`
  const days = dayDistance(at, now)
  if (days <= 0) return clock
  if (days === 1) return `昨天 ${clock}`
  return `${time.getMonth() + 1}月${time.getDate()}日 ${clock}`
}

const KEY_REASONS: ReadonlySet<LastRunRecord['reasonCode']> = new Set(['missing_key', 'needs_choice', 'needs_consent'])

/** Key failures open the Skill on 钥匙 (「去填写」); the rest open 概览. */
export function runFailureAction(record: Pick<LastRunRecord, 'reasonCode'>): 'fill-keys' | 'view-skill' {
  return KEY_REASONS.has(record.reasonCode) ? 'fill-keys' : 'view-skill'
}

export function runFailureEntry(record: LastRunRecord, skillName: string, now: number = Date.now(), vaultKeys: readonly VaultKey[] = []): NotificationEntry {
  // #306: a labelled variant identity (`FAL_KEY__V1`) reads 「FAL_KEY · 公司」.
  const keys = consentKeysText({ keys: record.keys }, vaultKeys)
  const agent = record.agent ? agentDisplayName(record.agent) : 'Agent'
  const stopped = `${agent} 在 ${runClock(record.at, now)} 调用时停止了。`
  const fallback = record.message?.trim() || '运行没有完成。'
  let description: RichSegment[]
  switch (record.reasonCode) {
    case 'missing_key': description = keys ? ['缺少钥匙 ', { code: keys }, `。${stopped}`] : [fallback]; break
    case 'needs_choice': description = keys ? ['需要选择用哪把钥匙 ', { code: keys }, `。${stopped}`] : [fallback]; break
    case 'needs_consent': description = keys ? ['等待你授权钥匙 ', { code: keys }, `。${stopped}`] : [fallback]; break
    case 'exit_code': description = [record.exitCode === null ? fallback : `程序退出码 ${record.exitCode}。${stopped}`]; break
    case 'spawn_failed': description = [`程序没有启动。${stopped}`]; break
    default: description = [fallback]
  }
  return {
    id: `run:${record.skillId}`,
    origin: 'run-failure',
    type: 'run_failure',
    category: 'system',
    actionable: true,
    unread: true,
    at: record.at,
    icon: 'warn',
    tone: 'danger',
    title: [`${skillName} 运行失败`],
    description,
    runFailure: record,
  }
}

/** `vaultKeys` turns a variant identity (`FAL_KEY__V1`) into 「FAL_KEY · 公司」 (#306). */
export function consentEntry(request: KeyConsentRequest, vaultKeys: readonly VaultKey[] = []): NotificationEntry {
  return {
    id: `consent:${request.skillId}:${request.requestedAt}`,
    origin: 'consent',
    type: 'key_consent',
    category: 'system',
    actionable: true,
    unread: true,
    at: request.requestedAt,
    icon: 'key-round',
    tone: 'warning',
    title: [`${request.skillName} 想使用你的 `, { code: consentKeysText(request, vaultKeys) }],
    description: ['这个 Skill 来自商店，第一次用到你的钥匙。'],
    consent: request,
  }
}

const TEAM_TYPES: ReadonlySet<string> = new Set([
  'join_request', 'join_approved', 'join_rejected', 'team_member_joined', 'team_member_left',
  'team_member_removed', 'team_created', 'team_dissolved', 'team_key_scope_added', 'comment_mention', 'skill_update',
])

export function notificationCategory(type: string): NotificationCategory {
  if (TEAM_TYPES.has(type)) return 'team'
  if (type.startsWith('marketplace_')) return 'store'
  return 'system'
}

function notificationIcon(type: string): { icon: NotificationIcon; tone: NotificationTone } {
  if (type === 'join_request' || type === 'join_approved' || type === 'join_rejected') return { icon: 'user-plus', tone: 'brand' }
  if (type === 'team_key_scope_added') return { icon: 'key-round', tone: 'success' }
  if (type === 'comment_mention') return { icon: 'msg', tone: 'muted' }
  if (type === 'skill_update') return { icon: 'refresh', tone: 'brand' }
  if (type.startsWith('team_')) return { icon: 'users-round', tone: 'brand' }
  if (type.startsWith('marketplace_')) return { icon: 'market', tone: type === 'marketplace_approved' ? 'success' : 'warning' }
  return { icon: 'bell', tone: 'brand' }
}

export function serverEntry(notification: ServerNotification, currentUserId: string | null = null): NotificationEntry {
  const { payload, type } = notification
  const teamName = payloadText(payload, 'teamName')
  const skillName = payloadText(payload, 'skillName')
  let title: RichSegment[] = [NOTIFICATION_TITLES[type] ?? '系统通知']
  let description: RichSegment[] = [notificationDescription(payload)]
  if (type === 'join_request') {
    const applicant = payloadText(payload, 'applicantName') ?? '有人'
    const applicantId = payloadText(payload, 'applicantId')
    title = [{ user: { name: applicant, me: Boolean(currentUserId && applicantId === currentUserId) } }, teamName ? ` 申请加入「${teamName}」` : ' 申请加入团队']
    description = [payloadText(payload, 'applicantEmail') ?? '通过后对方即可使用团队共享的 Skill。']
  } else if (type === 'team_key_scope_added') {
    description = [payloadText(payload, 'message') ?? (skillName && teamName ? `${skillName} 已共享到「${teamName}」，会用到团队钥匙。` : '团队钥匙的使用范围有变化。')]
  } else if (type === 'comment_mention') {
    const actor = payloadText(payload, 'actorName') ?? '有人'
    const actorId = payloadText(payload, 'actorId')
    title = [{ user: { name: actor, me: Boolean(currentUserId && actorId === currentUserId) } }, ' 在讨论中 @ 你']
    const excerpt = payloadText(payload, 'excerpt')
    const where = skillName ?? teamName ?? '团队讨论'
    description = [excerpt ? `${where} · 「${excerpt}」` : teamName && skillName ? `${skillName} · ${teamName}` : where]
  }
  return {
    id: `server:${notification.id}`,
    origin: 'server',
    type,
    category: notificationCategory(type),
    actionable: type === 'join_request' && !notification.read,
    unread: !notification.read,
    at: timestamp(notification.createdAt),
    ...notificationIcon(type),
    title,
    description,
    notification,
  }
}

export type NotificationSources = {
  notifications: readonly ServerNotification[]
  runFailures: readonly LastRunRecord[]
  consentRequests: readonly KeyConsentRequest[]
  skillName: (skillId: string) => string
  currentUserId?: string | null
  now?: number
  /** Personal vault rows, to label variant identities in consent requests (#306). */
  vaultKeys?: readonly VaultKey[]
}

/** Every entry the popover can show, newest first; server items limited to 30 days. */
export function buildNotificationEntries(sources: NotificationSources): NotificationEntry[] {
  const now = sources.now ?? Date.now()
  const local = [
    ...sources.runFailures.filter((record) => record.outcome === 'failed').map((record) => runFailureEntry(record, sources.skillName(record.skillId), now, sources.vaultKeys ?? [])),
    ...sources.consentRequests.map((request) => consentEntry(request, sources.vaultKeys ?? [])),
  ]
  const server = recentNotifications(sources.notifications, now).map((item) => serverEntry(item, sources.currentUserId ?? null))
  return [...local, ...server].sort((left, right) => right.at - left.at)
}

export function filterNotificationEntries(entries: readonly NotificationEntry[], filter: NotificationFilter): NotificationEntry[] {
  if (filter === 'all') return [...entries]
  if (filter === 'action') return entries.filter((entry) => entry.actionable)
  return entries.filter((entry) => entry.category === filter)
}

/**
 * Filter tab badge (#319): how many items the tab lists, so "全部" never reads 0
 * above a full list. Unread is shown separately; an empty tab shows no count.
 */
export function notificationTabCount(entries: readonly NotificationEntry[], filter: NotificationFilter): number | undefined {
  const count = filterNotificationEntries(entries, filter).length
  return count > 0 ? count : undefined
}

/** Unread server items plus every local item (they disappear once handled). */
export function unreadNotificationCount(entries: readonly NotificationEntry[]): number {
  return entries.filter((entry) => entry.unread).length
}

export function actionableNotificationCount(entries: readonly NotificationEntry[]): number {
  return entries.filter((entry) => entry.actionable).length
}

/** Bell badge text: capped at 99+. */
export function notificationBadgeText(count: number): string {
  return count > 99 ? '99+' : String(count)
}

export function bellAriaLabel(count: number): string {
  return count > 0 ? `通知，${count} 条未读` : '通知'
}

/** Plain-text rendering of rich segments (tests, aria labels). */
export function richText(segments: readonly RichSegment[]): string {
  return segments.map((segment) => typeof segment === 'string'
    ? segment
    : 'code' in segment ? segment.code : segment.user.me ? '你' : segment.user.name).join('')
}
