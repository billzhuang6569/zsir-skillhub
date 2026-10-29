import type { LocalSkill } from '../store/index.js'

export function sourceUpdateBlockReason(skill: Pick<LocalSkill, 'sourceLocalModified' | 'sourceModifiedFiles' | 'hasWorkingCopy'>, checking: boolean): string | null {
  if (checking) return '正在核验取得时的内容…'
  if (skill.sourceLocalModified || (skill.sourceModifiedFiles ?? 0) > 0 || skill.hasWorkingCopy) return '有本机修改，请先另存为自己的 Skill 或放弃修改，再更新。'
  return null
}

export function sourceModificationLabel(skill: Pick<LocalSkill, 'acquisitionSource' | 'catalogOrigin' | 'sourceModifiedFiles'>): string | null {
  if (!skill.sourceModifiedFiles) return null
  if (skill.acquisitionSource === 'team') return '团队共享后修改'
  if (skill.acquisitionSource === 'marketplace' || skill.catalogOrigin) return '商店获取后修改'
  return null
}
import { agentDisplayName, orderedAgentEntries } from './agents.ts'
import type { LastRunRecord } from './tauri.js'
import { KEY_COPY, needsValueLabel } from './skill-keys.ts'
import { skillVersionOrdinal } from './versioning.ts'

export type TeamPreferenceTeam = { id: string }

export function resolveTeamPreference(
  storedPreference: string | null,
  teams: TeamPreferenceTeam[],
): string | null {
  if (storedPreference === 'none') return null
  if (storedPreference && teams.some((team) => team.id === storedPreference)) return storedPreference
  return teams[0]?.id ?? null
}

export type SkillHubSections = {
  installed: LocalSkill[]
  uninstalled: LocalSkill[]
}

export function locallyManagedSkillNames(skills: LocalSkill[]): Set<string> {
  return new Set(skills.filter((skill) => skill.localPath.trim().length > 0).map((skill) => skill.name))
}

export function unmanagedLocalSkills<T extends { localPath: string; managedSkillId?: string; joinLocalId?: string }>(skills: T[], managedPaths: Set<string>): T[] {
  return skills.filter(skill => Boolean(skill.joinLocalId) || (!skill.managedSkillId && !managedPaths.has(skill.localPath)))
}

export function isGenericLocalSkill(skill: { sources: { agentKey: string }[]; joinLocalId?: string }): boolean {
  return Boolean(skill.joinLocalId) || skill.sources.length === 0 || skill.sources.some(source => source.agentKey === 'agent-skills')
}

export function matchesAgentInstallation(skill: Pick<LocalSkill, 'agents'>, agentKey: string): boolean {
  return skill.agents[agentKey] === 'on' || skill.agents[agentKey] === 'broken'
}

export function reconcileAgentFilter(
  selectedKey: string,
  detectionSucceeded: boolean,
  detectedKeys: ReadonlySet<string>,
): string {
  return detectionSucceeded && selectedKey && !detectedKeys.has(selectedKey) ? '' : selectedKey
}

const skillNameCollator = new Intl.Collator('en', { sensitivity: 'base', numeric: true })

export function orderSkillsByName<T extends { id: string; name: string }>(skills: readonly T[], direction: 'asc' | 'desc' = 'asc'): T[] {
  return [...skills].sort((left, right) =>
    (direction === 'asc' ? 1 : -1) * skillNameCollator.compare(left.name, right.name) || left.id.localeCompare(right.id, 'en'))
}

/** Legacy values retain their default direction; reverse directions share the same storage key. */
export type SkillSortPreference = 'name' | 'time' | 'name-desc' | 'time-asc'

/**
 * Content/share timestamps only. Stable sort preserves session order on ties
 * and for old Servers without a content timestamp.
 */
export function orderSkillsByTime<T extends { id: string; name: string; createdAt?: string; updatedAt?: string; sharedAt?: string | null; marketplacePublishedAt?: string }>(skills: readonly T[], direction: 'asc' | 'desc' = 'desc'): T[] {
  const stamp = (skill: T): number => {
    const raw = skill.sharedAt ?? skill.marketplacePublishedAt ?? skill.createdAt
    const time = raw ? Date.parse(raw) : Number.NaN
    return Number.isFinite(time) ? time : Number.NEGATIVE_INFINITY
  }
  return [...skills].sort((left, right) => {
    const a = stamp(left)
    const b = stamp(right)
    if (a === b) return 0
    if (a === Number.NEGATIVE_INFINITY) return 1
    if (b === Number.NEGATIVE_INFINITY) return -1
    return (direction === 'desc' ? 1 : -1) * (b > a ? 1 : -1)
  })
}

export function orderSkills<T extends { id: string; name: string; createdAt?: string; updatedAt?: string }>(skills: readonly T[], preference: SkillSortPreference): T[] {
  return preference === 'time' || preference === 'time-asc'
    ? orderSkillsByTime(skills, preference === 'time' ? 'desc' : 'asc')
    : orderSkillsByName(skills, preference === 'name' ? 'asc' : 'desc')
}

export function isSystemManagerSkill(skill: Pick<LocalSkill, 'id' | 'name' | 'isSystem'>): boolean {
  return Boolean(skill.isSystem) || skill.id === 'yitan-skillhub-manager' || skill.name === 'yitan-skillhub-manager'
}

export function isTeamSharedSkill(
  skill: LocalSkill,
  accountUserId: string | null,
  teamIds: ReadonlySet<string>,
): boolean {
  if (!accountUserId || !skill.serverId || !skill.localPath || skill.accountSyncRequired || isSystemManagerSkill(skill)) return false
  if (skill.serverAccessValidatedForUserId && skill.serverAccessValidatedForUserId !== accountUserId) return false
  return Boolean(skill.teamSharedFrom && teamIds.has(skill.teamSharedFrom))
    || Object.keys(skill.sharedTo).some((teamId) => teamIds.has(teamId))
}

export function selectedVisibleLocalSkills<T extends { id: string; name: string }>(
  visibleSkills: T[],
  selectedIds: ReadonlySet<string>,
  managedNames: ReadonlySet<string>,
): T[] {
  return visibleSkills.filter((skill) => selectedIds.has(skill.id) && !managedNames.has(skill.name))
}

type EnvReadinessRow = {
  required: boolean
  valid: boolean
  state?: 'ready' | 'needs_value' | 'needs_choice'
}

/**
 * Splits required, not-ready keys into "fill in a value" and "pick one of
 * several sources". Rows from an older native layer without `state` count as
 * needing a value.
 */
export type EnvKeySummary = { needsValue: number; needsChoice: number }

export const NO_ENV_KEY_ISSUES: EnvKeySummary = { needsValue: 0, needsChoice: 0 }

export function summarizeRequiredEnvRows(
  rows: EnvReadinessRow[],
): EnvKeySummary {
  let needsValue = 0
  let needsChoice = 0
  for (const row of rows) {
    if (!row.required || row.valid) continue
    if (row.state === 'needs_choice') needsChoice += 1
    else needsValue += 1
  }
  return { needsValue, needsChoice }
}

export const RUNTIME_REQUEST_ENV_ORIGIN = 'runtime_request'

export function isRuntimeRequestedEnvDependency(dependency: { origin?: string }): boolean {
  return dependency.origin === RUNTIME_REQUEST_ENV_ORIGIN
}

export type TeamSkillAvailability = 'all' | 'uninstalled' | 'updates'
export type TeamSkillSort = 'latest' | 'downloads'

type TeamSharedSkill = {
  displayName: string
  installCount: number
  installed: boolean
  updatedAt?: string
  createdAt?: string
  sharedAt?: string | null
  version?: string
  latestVersion?: string
  localPath?: string
}

function versionParts(value: string): number[] | null {
  const match = /^v?(\d+(?:\.\d+)*)$/.exec(value.trim())
  return match?.[1] ? match[1].split('.').map(Number) : null
}

/** True when `candidate` is a strictly newer dotted version than `current` (#295 「有更新」). */
export function isNewerSkillVersion(candidate: string | null | undefined, current: string | null | undefined): boolean {
  if (!candidate || !current || candidate === current) return false
  const ordinalCandidate = skillVersionOrdinal(candidate)
  const ordinalCurrent = skillVersionOrdinal(current)
  if (ordinalCandidate !== null && ordinalCurrent !== null) return ordinalCandidate > ordinalCurrent
  const left = versionParts(candidate)
  const right = versionParts(current)
  if (!left || !right) return false
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0)
    if (difference !== 0) return difference > 0
  }
  return false
}

/** A team Skill on this machine whose shared version is newer than the local copy. */
export function teamSkillHasUpdate(skill: Pick<TeamSharedSkill, 'version' | 'latestVersion' | 'localPath'> & { teamUpdateStatus?: string; teamUnshared?: boolean }): boolean {
  if (!skill.localPath || skill.teamUnshared) return false
  if (skill.teamUpdateStatus) return ['update_available', 'local_modified'].includes(skill.teamUpdateStatus)
  return isNewerSkillVersion(skill.latestVersion, skill.version)
}

function matchesTeamAvailability(skill: TeamSharedSkill, availability: TeamSkillAvailability): boolean {
  if (availability === 'uninstalled') return !skill.installed && !skill.localPath
  if (availability === 'updates') return teamSkillHasUpdate(skill)
  return true
}

/** Apply the team catalog's installation filter and deterministic sort order. */
export function orderTeamSharedSkills<T extends TeamSharedSkill>(
  skills: readonly T[],
  availability: TeamSkillAvailability,
  sort: TeamSkillSort,
): T[] {
  return skills
    .filter((skill) => matchesTeamAvailability(skill, availability))
    .sort((left, right) => {
      const primary = sort === 'downloads'
        ? right.installCount - left.installCount
        : (Date.parse(right.sharedAt ?? right.createdAt ?? '') || 0) - (Date.parse(left.sharedAt ?? left.createdAt ?? '') || 0)
      return primary || (sort === 'downloads' ? left.displayName.localeCompare(right.displayName, 'zh-CN') : 0)
    })
}

/**
 * The page-level "installed" concept means the Skill is already a personal
 * SkillHub asset or has a real managed folder on this Mac. Agent projections
 * are shown independently on each card and do not move a personal asset into
 * the team discovery list.
 */
export function splitSkillHubSections(
  skills: LocalSkill[],
  activeTeamId: string | null,
): SkillHubSections {
  const installed = skills.filter((skill) => !skill.teamSharedFrom || Boolean(skill.localPath))
  const uninstalled = activeTeamId
    ? skills.filter((skill) => skill.teamSharedFrom === activeTeamId && !skill.localPath)
    : []
  return { installed, uninstalled }
}

export type SettledTaskResult<T> =
  | { status: 'fulfilled'; value: T }
  | { status: 'rejected'; reason: unknown }

/** Run every task, retain input order and never exceed the requested limit. */
export async function mapSettledWithConcurrency<Input, Output>(
  items: Input[],
  concurrency: number,
  worker: (item: Input, index: number) => Promise<Output>,
): Promise<SettledTaskResult<Output>[]> {
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new Error('并发数必须是大于 0 的整数')
  }
  const results = new Array<SettledTaskResult<Output>>(items.length)
  let nextIndex = 0

  const run = async (): Promise<void> => {
    while (nextIndex < items.length) {
      const index = nextIndex
      nextIndex += 1
      try {
        results[index] = { status: 'fulfilled', value: await worker(items[index] as Input, index) }
      } catch (reason: unknown) {
        results[index] = { status: 'rejected', reason }
      }
    }
  }

  const runnerCount = Math.min(concurrency, items.length)
  await Promise.all(Array.from({ length: runnerCount }, () => run()))
  return results
}

/** The one issue a 我的 Skills row shows, most urgent first (#261 keeps today's wording). */
export type SkillRowIssue = {
  label: string
  tone: 'danger' | 'warning' | 'info'
  icon: 'warn' | 'key-round' | 'list' | 'hist' | 'refresh'
  /** Key badges open the Skill on its 「需要的钥匙」 section; `overview` opens 概览. */
  target?: 'env' | 'overview'
  /** Hover text when it says more than the label (#292 上次运行失败). */
  title?: string
}

const KEY_RUN_FAILURES: ReadonlySet<LastRunRecord['reasonCode']> = new Set(['missing_key', 'needs_choice', 'needs_consent'])

function twoDigits(value: number): string {
  return String(value).padStart(2, '0')
}

/** 「今天 10:42」/「昨天 10:42」/「10月12日 10:42」 in local time. */
export function formatRunTime(at: number, now: number = Date.now()): string {
  const time = new Date(at)
  const clock = `${twoDigits(time.getHours())}:${twoDigits(time.getMinutes())}`
  const today = new Date(now)
  today.setHours(0, 0, 0, 0)
  const day = new Date(at)
  day.setHours(0, 0, 0, 0)
  const days = Math.round((today.getTime() - day.getTime()) / 86_400_000)
  if (days === 0) return `今天 ${clock}`
  if (days === 1) return `昨天 ${clock}`
  const date = `${time.getMonth() + 1}月${time.getDate()}日`
  return time.getFullYear() === new Date(now).getFullYear() ? `${date} ${clock}` : `${time.getFullYear()}年${date} ${clock}`
}

/** Two-line hover text of the 「上次运行失败」 badge; names keys, never values. */
export function lastRunFailureTooltip(record: LastRunRecord, agentName?: string, now: number = Date.now()): string {
  const head = ['上次运行失败', formatRunTime(record.at, now), agentName].filter(Boolean).join(' · ')
  const keys = record.keys.join('、')
  const fallback = record.message || '运行没有完成'
  let detail: string
  switch (record.reasonCode) {
    case 'missing_key': detail = keys ? `缺少钥匙 ${keys}，Skill 没有拿到它就停止了。` : fallback; break
    case 'needs_choice': detail = keys ? `需要选择用哪把钥匙：${keys}` : fallback; break
    case 'needs_consent': detail = keys ? `等待你授权钥匙 ${keys}` : fallback; break
    case 'exit_code': detail = record.exitCode === null ? fallback : `程序退出码 ${record.exitCode}`; break
    case 'spawn_failed': detail = '程序没有启动'; break
    default: detail = fallback
  }
  return `${head}\n${detail}`
}

/** 🔴 「上次运行失败」: key failures open 钥匙, everything else 概览. */
export function lastRunIssue(record: LastRunRecord, now: number = Date.now()): SkillRowIssue {
  return {
    label: '上次运行失败',
    tone: 'danger',
    icon: 'warn',
    target: KEY_RUN_FAILURES.has(record.reasonCode) ? 'env' : 'overview',
    title: lastRunFailureTooltip(record, record.agent ? agentDisplayName(record.agent) : undefined, now),
  }
}

export function sameEnvKeySummary(left: EnvKeySummary | undefined, right: EnvKeySummary | undefined): boolean {
  return left?.needsValue === right?.needsValue && left?.needsChoice === right?.needsChoice
}

/** List badge: only 🟡 「需要填写 N 把钥匙」 or 🟠 「需要选择」; ready and consent rows stay quiet. */
export function envKeyIssue(summary: EnvKeySummary | undefined): SkillRowIssue | null {
  if (!summary) return null
  if (summary.needsValue > 0) return { label: needsValueLabel(summary.needsValue), tone: 'warning', icon: 'key-round', target: 'env' }
  if (summary.needsChoice > 0) return { label: KEY_COPY.choose, tone: 'warning', icon: 'list', target: 'env' }
  return null
}

export function issueForSkill(
  skill: Pick<LocalSkill, 'agents' | 'isOrphan' | 'hasWorkingCopy' | 'accountSyncRequired'>,
  envKeys: EnvKeySummary | undefined,
  envPolicyFailed: boolean,
  authenticated: boolean,
  versionProblem: string | null,
  lastRunFailure?: LastRunRecord | null,
): SkillRowIssue | null {
  const brokenAgents = orderedAgentEntries(skill.agents)
    .filter(([, status]) => status === 'broken').length
  if (skill.isOrphan) return { label: '资料暂不可用', tone: 'danger', icon: 'warn' }
  if (brokenAgents > 0) return { label: '安装有问题', tone: 'danger', icon: 'warn' }
  if (lastRunFailure?.outcome === 'failed') return lastRunIssue(lastRunFailure)
  // Design-system API-key Tag: warning tone with the key-round icon.
  const keyIssue = envKeyIssue(envKeys)
  if (keyIssue) return keyIssue
  if (envPolicyFailed) return { label: '钥匙检查未完成', tone: 'warning', icon: 'warn', target: 'env' }
  // The row no longer swaps its description for the problem: it lives in the icon tooltip.
  if (versionProblem) return { label: '版本需要处理', tone: 'danger', icon: 'warn', title: `版本需要处理\n${versionProblem}` }
  if (skill.hasWorkingCopy) return { label: '已修改', tone: 'info', icon: 'hist' }
  if (authenticated && skill.accountSyncRequired) return { label: '重新连接账号', tone: 'info', icon: 'refresh' }
  return null
}

/**
 * Row warnings are 14px icon buttons next to the name (#289 board 1): danger red,
 * warning amber, info brand. The label lives in the tooltip and `aria-label`.
 */
export function skillIssueTagClass(issue: Pick<SkillRowIssue, 'tone'>): string {
  return `skill-issue-icon skill-issue-icon-${issue.tone}`
}

/** 「已修改」 stays a small pill on the name line; every other issue becomes the icon. */
export function isRowIssueIcon(issue: Pick<SkillRowIssue, 'icon' | 'label'> | null | undefined): boolean {
  return Boolean(issue) && issue?.icon !== 'hist'
}

/** Splits a two-line issue tooltip (`head\ndetail`) into the `.ui-tip-title` / `.ui-tip-body` parts. */
export function issueTooltipParts(issue: Pick<SkillRowIssue, 'label' | 'title'>): { title: string; body: string | null } {
  const text = issue.title?.trim()
  if (!text) return { title: issue.label, body: null }
  const [head, ...rest] = text.split('\n')
  const body = rest.join('\n').trim()
  return { title: head?.trim() || issue.label, body: body || null }
}

/** Required keys that still need a value (header 钥匙 tab count); uses only `skill.envDeps`. */
export function envDepsNeedingAttention(envDeps: ReadonlyArray<{ required: boolean; configured: boolean }>): number {
  return envDeps.filter((dep) => dep.required && !dep.configured).length
}

/** 「今天」/「昨天」/「N 天前」/「M月D日」 (other years add 「YYYY年」); null for missing or invalid input. */
export function formatUpdatedRelative(value: string | null | undefined, now: number = Date.now()): string | null {
  if (!value) return null
  const at = new Date(value)
  if (Number.isNaN(at.getTime())) return null
  const today = new Date(now)
  today.setHours(0, 0, 0, 0)
  const day = new Date(at)
  day.setHours(0, 0, 0, 0)
  const days = Math.round((today.getTime() - day.getTime()) / 86_400_000)
  if (days <= 0) return '今天'
  if (days === 1) return '昨天'
  if (days < 7) return `${days} 天前`
  const date = `${at.getMonth() + 1}月${at.getDate()}日`
  return at.getFullYear() === new Date(now).getFullYear() ? date : `${at.getFullYear()}年${date}`
}

export type SkillOriginLine = {
  /** 从商店安装 / 团队「X」共享 / 本机创建 / 从本机导入 */
  source: string
  /** Omitted when unknown. `label` is 上传者 for store listings (the uploader is not always the author). */
  author: { name: string; me: boolean; label: '作者' | '上传者' | '共享者'; avatarUrl?: string | null } | null
  /** Relative 「更新于」 text, or null when no time is known. */
  updated: string | null
}

type OriginSkill = Pick<LocalSkill, 'catalogOrigin' | 'acquisitionSource' | 'teamSharedFrom' | 'sources' | 'authorName' | 'serverOwnerId' | 'updatedAt' | 'createdAt' | 'marketplacePublishedAt' | 'localPath'> & Partial<Pick<LocalSkill, 'sharedBy'>>

/**
 * Header line under the description for every Skill (#289 board 1):
 * `来源 · 作者 <UserChip> · 更新于 <time>`, derived only from fields the sheet already has.
 */
export function skillOriginLine(
  skill: OriginSkill,
  context: { currentUserId: string | null; teamName?: string | null; storeListing?: boolean },
  now: number = Date.now(),
): SkillOriginLine {
  const store = Boolean(context.storeListing) || skill.acquisitionSource === 'marketplace'
  const team = !store && (skill.acquisitionSource === 'team' || Boolean(skill.teamSharedFrom))
  const source = store
    ? (skill.localPath ? '从商店安装' : 'Skill 商店')
    : team
      ? (context.teamName ? `团队「${context.teamName}」共享` : '团队共享')
      : skill.sources.includes('本机创建') ? '本机创建' : '从本机导入'
  const updated = formatUpdatedRelative(skill.updatedAt ?? (store ? skill.marketplacePublishedAt : undefined) ?? skill.createdAt, now)
  // Team Skills name the member who shared it (#295 board 9).
  const sharer = team ? skill.sharedBy : null
  if (sharer?.displayName.trim()) {
    const sharerMe = Boolean(context.currentUserId && sharer.id === context.currentUserId)
    return { source, author: { name: sharer.displayName.trim(), me: sharerMe, label: '共享者', avatarUrl: sharer.avatarUrl ?? null }, updated }
  }
  const me = Boolean(!skill.catalogOrigin && context.currentUserId && skill.serverOwnerId && skill.serverOwnerId === context.currentUserId)
  const name = skill.authorName?.trim() ?? ''
  const label = store ? '上传者' : '作者'
  const author = me ? { name, me: true, label } as const : name ? { name, me: false, label } as const : null
  return { source, author, updated }
}

const AGENT_STATE_TEXT: Record<'on' | 'off' | 'broken', string> = { on: '已安装', off: '未安装', broken: '安装有问题' }

/**
 * Plain-text 「复制诊断信息」 for the header problem popover: identity, local path,
 * version, each Agent's state and the last run record. Never includes key values.
 */
export function skillDiagnosticsText(
  skill: Pick<LocalSkill, 'id' | 'name' | 'displayName' | 'localPath' | 'version' | 'versionStatus' | 'agents' | 'isOrphan'>,
  lastRun?: LastRunRecord | null,
  now: number = Date.now(),
): string {
  const lines = [
    `Skill：${skill.name}${skill.displayName && skill.displayName !== skill.name ? `（${skill.displayName}）` : ''}`,
    `ID：${skill.id}`,
    `本机路径：${skill.localPath || '无'}`,
    `版本：${skill.version || '无'}${skill.versionStatus ? `（${skill.versionStatus}）` : ''}`,
  ]
  if (skill.isOrphan) lines.push('资料：暂不可用')
  const agents = orderedAgentEntries(skill.agents).filter(([, status]) => status !== null)
  lines.push(agents.length > 0 ? 'Agent：' : 'Agent：无')
  for (const [agent, status] of agents) lines.push(`  - ${agentDisplayName(agent)}：${AGENT_STATE_TEXT[status ?? 'off']}`)
  if (lastRun) lines.push(`上次运行：${lastRunFailureTooltip(lastRun, lastRun.agent ? agentDisplayName(lastRun.agent) : undefined, now).replace('\n', ' · ')}`)
  return lines.join('\n')
}
