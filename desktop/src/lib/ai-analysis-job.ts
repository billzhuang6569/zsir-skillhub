import type { SpaceHandle } from './tauri.js'
/**
 * Background 「AI 分析」 jobs (#181). A click starts the job immediately; the
 * job lives in the store, not in the detail sheet, so it keeps running when the
 * user switches Skills or pages. Every job is bound to the account and space
 * that started it, to one stable author Skill (its server id) and to its own
 * job id; late results never reach another account, a deleted entry or a
 * profile the user edited in the meantime.
 *
 * Runtime dependencies are injected so the lifecycle can be tested with
 * controllable promises; the APP wires the real API, native bridge and store.
 */
import type { LocalSkill } from '../store/index.js'

export type AiAnalysisJob = {
  id: string
  /** `${accountUserId}:${serverId}` — one running analysis per account Skill. */
  key: string
  serverId: string
  accountUserId: string
  skillName: string
  startedAt: number
}

export type SkillProfileSnapshot = {
  displayName: string
  description: string
  category: string
  labels: string[]
  fitScenarios: string[]
}

/** The stored server profile the analysis expects to replace. */
export type ServerProfileSnapshot = {
  displayName: string
  description: string | null
  category: string | null
  labels: string[]
  triggerScenarios: string[]
}

export type AiAnalysisResult = {
  skill: {
    displayName: string
    description?: string | null
    category?: string | null
    labels: string[]
    triggerScenarios: string[]
  }
  analysis: { status: 'completed' | 'fallback' | 'recovered' | 'unanalysed' }
}

export type AiAnalysisNoticeKind = 'default' | 'warn' | 'error'

export type AiAnalysisEnvironment = {
  currentUserId: () => string | null
  readSpace: () => SpaceHandle | null
  /** The current list entry of this account's author Skill, if it still exists. */
  findSkill: (serverId: string, accountUserId: string) => LocalSkill | undefined
  /** Registers the job; false when the same account Skill already has one. */
  beginJob: (job: AiAnalysisJob) => boolean
  endJob: (key: string, jobId: string) => void
  readLocalSkillMd: (skill: LocalSkill) => Promise<string>
  fetchSource: (serverId: string, space: SpaceHandle) => Promise<string>
  fetchServerProfile: (serverId: string, space: SpaceHandle) => Promise<ServerProfileSnapshot>
  analyze: (serverId: string, skillMd: string, expectedProfile: ServerProfileSnapshot, space: SpaceHandle) => Promise<AiAnalysisResult>
  /** Writes only the profile fields to the managed folder. */
  writeLocalProfile: (skill: LocalSkill, profile: SkillProfileSnapshot, space: SpaceHandle) => Promise<void>
  replaceSkill: (currentId: string, updated: LocalSkill) => void
  notify: (message: string, kind: AiAnalysisNoticeKind) => void
  /** Existing account read-back pass; never re-runs AI. */
  requestReadback: () => void
  isOnline: () => boolean
  newJobId: () => string
  now: () => number
}

export type AiAnalysisOutcome =
  | 'duplicate'
  | 'unavailable'
  | 'applied'
  | 'fallback'
  | 'conflict'
  | 'discarded'
  | 'missing'
  | 'partial'
  | 'failed'

export function aiAnalysisJobKey(accountUserId: string, serverId: string): string {
  return `${accountUserId}:${serverId}`
}

export function startAiAnalysisJobEntry(
  jobs: Readonly<Record<string, AiAnalysisJob>>,
  job: AiAnalysisJob,
): Record<string, AiAnalysisJob> {
  if (jobs[job.key]) return jobs as Record<string, AiAnalysisJob>
  return { ...jobs, [job.key]: job }
}

export function finishAiAnalysisJobEntry(
  jobs: Readonly<Record<string, AiAnalysisJob>>,
  key: string,
  jobId: string,
): Record<string, AiAnalysisJob> {
  if (jobs[key]?.id !== jobId) return jobs as Record<string, AiAnalysisJob>
  const next = { ...jobs }
  delete next[key]
  return next
}

export function skillProfileSnapshot(skill: Pick<LocalSkill, 'displayName' | 'description' | 'category' | 'labels' | 'fitScenarios'>): SkillProfileSnapshot {
  return {
    displayName: skill.displayName,
    description: skill.description ?? '',
    category: skill.category ?? '',
    labels: [...skill.labels],
    fitScenarios: [...(skill.fitScenarios ?? [])],
  }
}

function sameList(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((item, index) => item === right[index])
}

export function sameSkillProfile(left: SkillProfileSnapshot, right: SkillProfileSnapshot): boolean {
  return left.displayName === right.displayName
    && left.description === right.description
    && left.category === right.category
    && sameList(left.labels, right.labels)
    && sameList(left.fitScenarios, right.fitScenarios)
}

/** Only the fields an analysis produces; everything else stays as the current entry has it. */
export function withAnalyzedProfile(skill: LocalSkill, profile: SkillProfileSnapshot): LocalSkill {
  return {
    ...skill,
    serverAnalysisStatus: 'completed',
    displayName: profile.displayName,
    description: profile.description,
    category: profile.category,
    labels: profile.labels,
    trigger: profile.fitScenarios.join('、'),
    fitScenarios: profile.fitScenarios,
  }
}

type TransportFailure = { kind?: unknown; status?: unknown; retryAfterSeconds?: unknown; message?: unknown }

function transportFailure(error: unknown): TransportFailure {
  return typeof error === 'object' && error !== null ? error as TransportFailure : {}
}

function errorText(error: unknown): string {
  if (error instanceof Error && error.message) return error.message
  return typeof error === 'string' && error ? error : '未知错误'
}

export type AiAnalysisFailure = {
  message: string
  kind: AiAnalysisNoticeKind
  /** The server may or may not have stored a result; read it back instead of re-running AI. */
  readback: boolean
  outcome: 'conflict' | 'failed'
}

export function describeAiAnalysisFailure(skillName: string, error: unknown, online: boolean): AiAnalysisFailure {
  const failure = transportFailure(error)
  const label = `「${skillName}」`
  if (failure.kind === 'http') {
    switch (failure.status) {
      case 401: return { message: `${label}AI 分析失败：登录已失效，请重新登录后再试`, kind: 'error', readback: false, outcome: 'failed' }
      case 403: return { message: `${label}AI 分析失败：只有作者本人可以分析这个 Skill`, kind: 'error', readback: false, outcome: 'failed' }
      case 404: return { message: `${label}AI 分析失败：云端已找不到这个 Skill`, kind: 'error', readback: true, outcome: 'failed' }
      case 409: return { message: `${label}资料已被修改，请重新分析`, kind: 'warn', readback: true, outcome: 'conflict' }
      case 429: {
        const seconds = typeof failure.retryAfterSeconds === 'number' && failure.retryAfterSeconds > 0 ? failure.retryAfterSeconds : null
        return { message: `${label}AI 分析请求过于频繁，请${seconds ? ` ${seconds} 秒后` : '稍后'}再试`, kind: 'warn', readback: false, outcome: 'failed' }
      }
      default: return { message: `${label}AI 分析失败：${errorText(error)}`, kind: 'error', readback: false, outcome: 'failed' }
    }
  }
  if (failure.kind === 'timeout') {
    return { message: `${label}AI 分析超时，云端结果未确认，已安排同步核对`, kind: 'warn', readback: true, outcome: 'failed' }
  }
  if (failure.kind === 'network') {
    return online
      ? { message: `${label}AI 分析连接中断，云端结果未确认，已安排同步核对`, kind: 'warn', readback: true, outcome: 'failed' }
      : { message: `${label}AI 分析失败：当前离线，请联网后再试`, kind: 'error', readback: false, outcome: 'failed' }
  }
  return { message: `${label}AI 分析失败：${errorText(error)}`, kind: 'error', readback: false, outcome: 'failed' }
}

function isUnauthorized(error: unknown): boolean {
  const failure = transportFailure(error)
  return failure.kind === 'http' && failure.status === 401
}

/**
 * Starts one analysis for an author Skill and resolves when it settled. The
 * caller does not need to stay mounted: all writes go through `env`.
 */
export async function runSkillAiAnalysis(
  env: AiAnalysisEnvironment,
  input: { skill: LocalSkill; serverId: string },
): Promise<AiAnalysisOutcome> {
  const accountUserId = env.currentUserId()
  const space = env.readSpace()
  const skillName = input.skill.displayName || input.skill.name
  if (!accountUserId || !space) {
    env.notify(`「${skillName}」AI 分析需要登录，请重新登录后再试`, 'error')
    return 'unavailable'
  }
  const job: AiAnalysisJob = {
    id: env.newJobId(),
    key: aiAnalysisJobKey(accountUserId, input.serverId),
    serverId: input.serverId,
    accountUserId,
    skillName,
    startedAt: env.now(),
  }
  if (!env.beginJob(job)) return 'duplicate'
  const sessionMatches = (): boolean => env.currentUserId() === accountUserId && env.readSpace() === space
  const startSkill = env.findSkill(input.serverId, accountUserId) ?? input.skill
  const startProfile = skillProfileSnapshot(startSkill)
  try {
    const [skillMd, expectedProfile] = await Promise.all([
      startSkill.localPath ? env.readLocalSkillMd(startSkill) : env.fetchSource(input.serverId, space),
      env.fetchServerProfile(input.serverId, space),
    ])
    if (!sessionMatches()) return 'discarded'
    const result = await env.analyze(input.serverId, skillMd, expectedProfile, space)
    if (!sessionMatches()) return 'discarded'
    if (result.analysis.status !== 'completed') {
      env.notify(`「${skillName}」AI 服务本次未返回有效资料，已保留现有内容，可以稍后重试`, 'warn')
      return 'fallback'
    }
    const analyzed: SkillProfileSnapshot = {
      displayName: result.skill.displayName,
      description: result.skill.description ?? '',
      category: result.skill.category ?? '',
      labels: [...result.skill.labels],
      fitScenarios: [...result.skill.triggerScenarios],
    }
    const current = env.findSkill(input.serverId, accountUserId)
    if (!current) {
      // Removed from this list meanwhile: never resurrect it locally.
      env.notify(`「${skillName}」已不在列表中，AI 分析结果只保存在云端`, 'warn')
      return 'missing'
    }
    if (!sameSkillProfile(skillProfileSnapshot(current), startProfile)) {
      env.notify(`「${skillName}」资料已被修改，请重新分析`, 'warn')
      env.requestReadback()
      return 'conflict'
    }
    if (current.localPath) {
      try {
        await env.writeLocalProfile(current, analyzed, space)
      } catch (error: unknown) {
        if (!sessionMatches()) return 'discarded'
        env.notify(`「${skillName}」云端已更新，本机未同步：${errorText(error)}；正在重新读取`, 'warn')
        env.requestReadback()
        return 'partial'
      }
      if (!sessionMatches()) return 'discarded'
    }
    const latest = env.findSkill(input.serverId, accountUserId)
    if (!latest) return 'missing'
    env.replaceSkill(latest.id, withAnalyzedProfile(latest, analyzed))
    env.notify(`「${analyzed.displayName || skillName}」AI 分析完成，资料已更新`, 'default')
    return 'applied'
  } catch (error: unknown) {
    // A 401 for this very request may already have cleared the session; that
    // user is told why. Any other session change drops the result silently.
    const loggedOutByThisRequest = isUnauthorized(error) && env.readSpace() === null
    if (!sessionMatches() && !loggedOutByThisRequest) return 'discarded'
    const failure = describeAiAnalysisFailure(skillName, error, env.isOnline())
    env.notify(failure.message, failure.kind)
    if (failure.readback && sessionMatches()) env.requestReadback()
    return failure.outcome
  } finally {
    env.endJob(job.key, job.id)
  }
}
