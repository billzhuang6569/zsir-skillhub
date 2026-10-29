export type TeamRole = 'owner' | 'member'
export type RovingOrientation = 'horizontal' | 'vertical' | 'both'

export function nextRovingIndex(
  currentIndex: number,
  itemCount: number,
  key: string,
  orientation: RovingOrientation,
): number | null {
  if (itemCount < 1) return null
  if (key === 'Home') return 0
  if (key === 'End') return itemCount - 1
  const previous = key === 'ArrowLeft' && orientation !== 'vertical'
    || key === 'ArrowUp' && orientation !== 'horizontal'
  const next = key === 'ArrowRight' && orientation !== 'vertical'
    || key === 'ArrowDown' && orientation !== 'horizontal'
  if (previous) return (currentIndex - 1 + itemCount) % itemCount
  if (next) return (currentIndex + 1) % itemCount
  return null
}

export function retargetSkillSheet<T extends { kind: string; skillId?: string } | null>(
  sheet: T,
  currentId: string,
  nextId: string
): T {
  if (sheet?.kind !== 'skill' || sheet.skillId !== currentId) return sheet
  return { ...sheet, skillId: nextId } as T
}

export function settledValue<T>(result: PromiseSettledResult<T>): T | undefined {
  return result.status === 'fulfilled' ? result.value : undefined
}

export function settledError(result: PromiseSettledResult<unknown>): string | null {
  if (result.status === 'fulfilled') return null
  return result.reason instanceof Error ? result.reason.message : String(result.reason)
}

export type SettledCollection<T> = {
  items: T[]
  available: boolean
  error: string | null
}

export function settledCollection<T>(result: PromiseSettledResult<T[]>): SettledCollection<T> {
  if (result.status === 'fulfilled') {
    return { items: result.value, available: true, error: null }
  }
  return {
    items: [],
    available: false,
    error: result.reason instanceof Error ? result.reason.message : String(result.reason),
  }
}

const TEAM_ERROR_MESSAGES: Record<string, string> = {
  'Active team not found': '团队不存在或已经解散',
  'Team has been dissolved': '团队已经解散',
  'Active team membership required': '当前账号不是这个团队的成员',
  'Active team membership not found': '当前账号已经不在这个团队中',
  'Active team member not found': '该成员已经不在这个团队中',
  'Already a team member': '当前账号已经是这个团队的成员',
  'Owner cannot leave — dissolve the team instead': '团队创建者不能直接退出，请使用解散团队',
  'Team owner cannot be removed': '不能移出团队创建者',
  'Request not pending': '这条加入申请已经被处理',
  'Request belongs to another team': '这条加入申请不属于当前团队',
  'Request already resolved': '这条加入申请已经被其他操作处理，请刷新',
}

export function teamErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return (TEAM_ERROR_MESSAGES[message] ?? message) || '团队操作失败，请稍后再试'
}

export function partitionTeams<T extends { role: TeamRole }>(teams: T[]): {
  owned: T[]
  joined: T[]
} {
  return {
    owned: teams.filter((team) => team.role === 'owner'),
    joined: teams.filter((team) => team.role === 'member'),
  }
}

export function containedScrollTop(
  currentScrollTop: number,
  containerTop: number,
  targetTop: number,
  inset = 12
): number {
  return Math.max(0, currentScrollTop + targetTop - containerTop - inset)
}

export function isSkillSharedWithActiveTeam(
  skill: { teamSharedFrom?: string; sharedTo?: Record<string, unknown> },
  activeTeamId: string | null
): boolean {
  if (!activeTeamId) return false
  return skill.teamSharedFrom === activeTeamId || Boolean(skill.sharedTo?.[activeTeamId])
}

export function canManageSkillAsset(skill: { isOwn: boolean; isSystem?: boolean }): boolean {
  return skill.isOwn && !skill.isSystem
}

export function commentScopeTeamId(
  skill: { teamSharedFrom?: string; sharedTo?: Record<string, unknown> },
  activeTeamId: string | null
): string | undefined {
  if (skill.teamSharedFrom) return skill.teamSharedFrom
  if (activeTeamId && skill.sharedTo?.[activeTeamId]) return activeTeamId
  return undefined
}

export function visibleAgentKeys(
  agents: { key: string; detected: boolean }[],
  skillAgents: Record<string, unknown>
): string[] {
  const detected = new Set(agents.filter((agent) => agent.detected).map((agent) => agent.key))
  return Object.keys(skillAgents).filter((key) => detected.has(key))
}

export function detectedAgentOptions<T extends { detected: boolean }>(agents: T[]): T[] {
  return agents.filter((agent) => agent.detected)
}

type ServerBoundSkill = {
  serverId?: string
  serverAccessValidatedForUserId?: string
  teamSharedFrom?: string
  sharedTo: Record<string, unknown>
}

export function detachStaleServerBinding<T extends ServerBoundSkill>(
  skill: T
): Omit<T, 'serverId' | 'serverAccessValidatedForUserId' | 'teamSharedFrom' | 'sharedTo'> & {
  serverId: undefined
  serverAccessValidatedForUserId: undefined
  teamSharedFrom: undefined
  sharedTo: Record<string, never>
  accountSyncRequired: true
} {
  const {
    serverId: _serverId,
    serverAccessValidatedForUserId: _serverAccessValidatedForUserId,
    teamSharedFrom: _teamSharedFrom,
    sharedTo: _sharedTo,
    ...localSkill
  } = skill
  return {
    ...localSkill,
    serverId: undefined,
    serverAccessValidatedForUserId: undefined,
    accountSyncRequired: true,
    teamSharedFrom: undefined,
    sharedTo: {},
  }
}

type RefreshableServerBinding = {
  catalogOrigin?: string
  serverAnalysisStatus?: 'unanalysed' | 'completed'
  enrichmentPending?: boolean
  avatarLocalId?: string
  avatarUrl?: string | null
  avatarStatus?: string
  avatarAccountUserId?: string
  serverId?: string
  serverAccessValidatedForUserId?: string
  serverOwnerId?: string
  isOwn?: boolean
  teamSharedFrom?: string
  sharedTo?: Record<string, unknown>
  accountSyncRequired?: boolean
  installCount?: number
  createdAt?: string
  updatedAt?: string
}

/**
 * Native refreshes faithfully return the sidecar, including server scope that
 * may belong to the previously authenticated account. The in-memory binding
 * has already been reconciled against the authenticated API, so local-only
 * operations may refresh filesystem state but must preserve that server scope.
 */
export function reconcileLocalSkillRefresh<T extends RefreshableServerBinding>(
  current: T,
  refreshed: T
): T {
  return {
    ...refreshed,
    // Native scans contain package metadata; the authenticated card remains
    // the display source while a new cloud response is in flight.
    ...(current.serverId ? Object.fromEntries(['displayName', 'description', 'sourceUrl', 'category', 'labels', 'trigger', 'fitScenarios', 'unfitScenarios', 'compatibleAgents', 'latestVersion', 'teamVersionId', 'teamChangelog', 'teamEnvDeps', 'teamUnshared', 'teamUpdateStatus', 'sharedAt', 'sharedBy', 'authorName', 'authorAvatarUrl']
      .filter(key => key in current).map(key => [key, (current as Record<string, unknown>)[key]])) : {}),
    avatarLocalId: refreshed.avatarLocalId ?? current.avatarLocalId,
    avatarUrl: current.avatarUrl,
    avatarStatus: current.avatarStatus,
    avatarAccountUserId: current.avatarAccountUserId,
    serverAnalysisStatus: current.serverAnalysisStatus,
    enrichmentPending: current.enrichmentPending,
    serverId: current.serverId,
    serverAccessValidatedForUserId: current.serverAccessValidatedForUserId,
    serverOwnerId: current.serverOwnerId,
    isOwn: refreshed.catalogOrigin || current.catalogOrigin ? false : current.isOwn,
    teamSharedFrom: current.teamSharedFrom,
    sharedTo: current.sharedTo,
    accountSyncRequired: current.accountSyncRequired,
    installCount: current.installCount,
    createdAt: current.createdAt,
    updatedAt: current.updatedAt,
  }
}

/** A detached binding is never safe for comments or other server requests. */
export function currentAccountServerId(
  skill: {
    catalogOrigin?: string
    serverId?: string
    serverOwnerId?: string
    isOwn?: boolean
    acquisitionSource?: 'local' | 'team' | 'marketplace'
    accountSyncRequired?: boolean
    serverAccessValidatedForUserId?: string
  },
  currentUserId: string,
): string | undefined {
  if (skill.catalogOrigin || !skill.serverId || skill.accountSyncRequired || skill.acquisitionSource === 'marketplace') {
    return undefined
  }
  if (skill.serverAccessValidatedForUserId === currentUserId) return skill.serverId
  if (skill.isOwn !== false && skill.serverOwnerId === currentUserId) return skill.serverId
  return undefined
}

type RemoteSkillIdentity = { id: string; name: string }
type RemoteBinding<T extends RemoteSkillIdentity> =
  | { kind: 'owned' | 'team'; skill: T }
  | { kind: 'stale' | 'none' }

export function resolveRemoteSkillBinding<T extends RemoteSkillIdentity>(
  local: { name: string; serverId?: string },
  ownedSkills: T[],
  teamSkills: T[]
): RemoteBinding<T> {
  if (!local.serverId) return { kind: 'none' }
  const owned = ownedSkills.find((skill) => skill.id === local.serverId)
  if (owned) return { kind: 'owned', skill: owned }
  const team = teamSkills.find((skill) => skill.id === local.serverId)
  return team ? { kind: 'team', skill: team } : { kind: 'stale' }
}
