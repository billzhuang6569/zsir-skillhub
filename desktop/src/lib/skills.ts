import type { ApiMarketplaceItem, ApiSkill } from './api.js'
import type { LocalSkill } from '../store/index.js'
import { emptyAgentStates } from './agents.ts'
import { detachStaleServerBinding } from './ui-helpers.ts'
import { normalizeStoreBadges } from './store-home.ts'
import { OFFICIAL_ENDPOINTS } from './official-endpoints.ts'
import { teamUpdateAccountMatches, teamUpdateState } from './team-update-state.ts'

export type TeamSkillSource = {
  teamId: string
  // null means the team is joined, but its Skill request failed. Missing data
  // must never be interpreted as a revoked binding.
  skills: ApiSkill[] | null
}

export type SkillMergeContext = {
  selfhost?: boolean
  accountUserId?: string
  activeTeamId: string | null
  membershipsValidated: boolean
  teamSources: TeamSkillSource[]
}

/**
 * Marketplace provenance is public package metadata, never an authorization
 * grant. Cached sidecar ownership and team scope must fail closed whenever an
 * account/session boundary is crossed; protected owned/team API responses can
 * add those rights back during reconciliation.
 */
export function downgradeMarketplaceAuthorization(skill: LocalSkill): LocalSkill {
  if (skill.acquisitionSource !== 'marketplace') return skill
  return {
    ...skill,
    isOwn: false,
    serverAccessValidatedForUserId: undefined,
    teamSharedFrom: undefined,
    sharedTo: {},
  }
}

export function skillForAvatarAccount(skill: LocalSkill, userId?: string): LocalSkill {
  const result = downgradeMarketplaceAuthorization(skill)
  return result.avatarAccountUserId === userId ? result : {
    ...result, avatarUrl: null, avatarStatus: 'none', avatarSource: undefined, avatarAccountUserId: undefined,
  }
}

export function mayGenerateSkillAvatar(skill: LocalSkill, userId: string): boolean {
  if (skill.isOrphan || skill.id.startsWith('market:')) return false
  if (skill.catalogOrigin) return false
  if (skill.serverId) return skill.isOwn && skill.serverOwnerId === userId
    && skill.serverAccessValidatedForUserId === userId
  return Boolean(skill.localPath && (skill.isOwn || skill.isSystem) && !skill.teamSharedFrom
    && skill.acquisitionSource === 'local')
}

/**
 * Local commands address the managed folder id, which is intentionally
 * different from the Agent-facing name for downloaded/team assets.
 */
export function findLocalSkillByManagedId(
  skills: LocalSkill[],
  managedSkillId: string,
): LocalSkill | undefined {
  return skills.find((skill) => skill.id === managedSkillId)
}

const PORTABLE_SKILL_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
const SERVER_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

/**
 * A managed folder id is local storage identity, not the Agent-facing Skill
 * name. Appending an immutable server-id suffix lets two team assets with the
 * same name coexist without changing the name projected to each Agent.
 */
export function remoteManagedSkillId(name: string, serverId: string, spaceId = 'official'): string {
  if (!PORTABLE_SKILL_ID.test(name)) throw new Error('服务端 Skill 名称不符合本机安全规则')
  if (!SERVER_UUID.test(serverId)) throw new Error('服务端 Skill 标识无效')
  if (!/^[a-zA-Z0-9-]{1,80}$/.test(spaceId)) throw new Error('空间标识无效')
  const selfhostHash = /^selfhost-([0-9a-f]{64})$/.exec(spaceId)?.[1]
  const spaceSuffix = spaceId === 'official' ? '' : selfhostHash ? `-s${selfhostHash.slice(0, 12)}` : `-${spaceId}`
  const suffix = serverId.replace(/-/g, '').slice(0, 12).toLowerCase() + spaceSuffix
  const maxNameLength = 128 - suffix.length - 2
  const base = name.slice(0, maxNameLength).replace(/[._-]+$/u, '')
  if (!base) throw new Error('服务端 Skill 名称无法生成本机标识')
  return `${base}--${suffix}`
}

/**
 * A downloaded package supplies the new local filesystem identity, while the
 * remote card remains authoritative for ownership, sharing and catalog
 * metadata. Keeping those layers separate prevents an owner-shared Skill from
 * disappearing from the active team immediately after its first download.
 */
export function hydrateDownloadedSkill(remote: LocalSkill, imported: LocalSkill): LocalSkill {
  const acquisitionSource = imported.acquisitionSource ?? remote.acquisitionSource
  return {
    ...remote,
    ...imported,
    id: imported.id,
    displayName: remote.displayName,
    serverAnalysisStatus: remote.serverAnalysisStatus,
    enrichmentPending: remote.enrichmentPending,
    description: remote.description,
    // The listing / shared version is authoritative; a remote without the
    // field (older Server) keeps what the installed package recorded.
    sourceUrl: remote.sourceUrl !== undefined ? remote.sourceUrl : imported.sourceUrl,
    avatarUrl: remote.avatarUrl,
    avatarStatus: remote.avatarStatus,
    avatarAccountUserId: remote.avatarAccountUserId,
    category: remote.category,
    labels: remote.labels,
    latestVersion: remote.latestVersion,
    installCount: remote.installCount,
    isOwn: imported.catalogOrigin ? false : remote.isOwn,
    acquisitionSource,
    acquisitionPackageSha256: imported.acquisitionPackageSha256,
    sources: acquisitionSource === 'marketplace' ? ['Skill 商店'] : imported.sources,
    teamSharedFrom: remote.teamSharedFrom,
    envDeps: remote.envDeps,
    sharedTo: { ...remote.sharedTo },
    trigger: remote.trigger,
    fitScenarios: remote.fitScenarios,
    unfitScenarios: remote.unfitScenarios,
    compatibleAgents: remote.compatibleAgents,
    createdAt: remote.createdAt,
    updatedAt: remote.updatedAt,
    serverId: remote.serverId ?? imported.serverId,
    serverOwnerId: remote.serverOwnerId ?? imported.serverOwnerId,
  }
}

function mergeEnvDependencies(apiSkill: ApiSkill, local?: LocalSkill): LocalSkill['envDeps'] {
  const remote = Array.isArray(apiSkill.envDependencies) ? apiSkill.envDependencies : []
  const localByKey = new Map((local?.envDeps ?? []).map((dependency) => [dependency.key, dependency]))
  const merged = remote.map((dependency) => ({
    key: dependency.key,
    description: dependency.description,
    required: dependency.required,
    configured: localByKey.get(dependency.key)?.configured ?? false,
    sharePolicy: localByKey.get(dependency.key)?.sharePolicy ?? 'none' as const,
    sharedTeams: localByKey.get(dependency.key)?.sharedTeams ?? [],
  }))
  const remoteKeys = new Set(remote.map((dependency) => dependency.key))
  return [...merged, ...(local?.envDeps ?? []).filter((dependency) => !remoteKeys.has(dependency.key))]
}

export function mergeApiSkill(
  apiSkill: ApiSkill,
  local?: LocalSkill,
  teamId?: string,
  accountUserId?: string,
  selfhost = false,
): LocalSkill {
  const unanalysed = selfhost && apiSkill.analysisStatus === 'unanalysed'
  return {
    id: local?.id ?? `server:${apiSkill.id}`,
    name: apiSkill.name,
    displayName: apiSkill.displayName,
    serverAnalysisStatus: apiSkill.analysisStatus,
    enrichmentPending: apiSkill.enrichmentPending,
    description: apiSkill.description,
    // Older Servers omit the field: keep the local sidecar's value then.
    sourceUrl: apiSkill.sourceUrl !== undefined ? apiSkill.sourceUrl : local?.sourceUrl,
    avatarLocalId: local?.avatarLocalId,
    avatarUrl: apiSkill.avatarUrl ?? null,
    avatarStatus: apiSkill.avatarStatus ?? 'none',
    avatarAccountUserId: accountUserId,
    category: apiSkill.category,
    labels: Array.isArray(apiSkill.labels) ? apiSkill.labels : [],
    version: local?.version ?? apiSkill.currentVersion,
    versionStatus: local?.versionStatus,
    versionProblem: local?.versionProblem,
    versionReceiptId: local?.versionReceiptId,
    formalVersionId: local?.formalVersionId,
    formalLabel: local?.formalLabel,
    latestVersion: apiSkill.currentVersion,
    sourceVersionId: local?.sourceVersionId,
    acquiredByUserId: local?.acquiredByUserId,
    teamVersionId: teamId ? apiSkill.teamVersionId : undefined,
    teamUnshared: false,
    teamChangelog: apiSkill.changelog,
    teamEnvDeps: teamId ? mergeEnvDependencies(apiSkill) : undefined,
    teamUpdateStatus: teamId && local?.localPath ? teamUpdateState({
      accountMatches: teamUpdateAccountMatches({
        accountUserId, acquiredByUserId: local.acquiredByUserId, libraryAccountId: local.libraryAccountId,
      }),
      available: true, localModified: Boolean(local.sourceLocalModified),
      sameVersion: apiSkill.teamVersionId && local.sourceVersionId
        ? apiSkill.teamVersionId === local.sourceVersionId
        : apiSkill.currentVersion === (local.acquisitionVersion ?? local.version),
    }) : undefined,
    installCount: apiSkill.installCount,
    sources: local?.sources ?? (teamId ? ['团队共享'] : ['服务端资产库']),
    agents: local?.agents ?? emptyAgentStates(),
    installed: local?.installed ?? false,
    // Ownership is authorization from the endpoint currently reconciling this
    // asset. Acquisition provenance in the sidecar never grants author rights.
    isOwn: !local?.catalogOrigin && !teamId,
    catalogOrigin: local?.catalogOrigin,
    acquisitionVersion: local?.acquisitionVersion,
    acquisitionSource: local?.acquisitionSource ?? (teamId ? 'team' : 'local'),
    serverAccessValidatedForUserId: accountUserId,
    // An owned response must clear an obsolete team-source marker. A team
    // response always carries the exact team that granted access.
    teamSharedFrom: teamId,
    envDeps: teamId && local?.localPath ? local.envDeps : mergeEnvDependencies(apiSkill, local),
    sharedTo: apiSkill.teamShares?.reduce<Record<string, { version: string; envShared: boolean }>>((result, share) => {
      result[share.teamId] = { version: share.version?.version ?? apiSkill.currentVersion, envShared: false }
      return result
    }, {}) ?? local?.sharedTo ?? {},
    versions: local?.versions ?? [],
    trigger: unanalysed ? apiSkill.triggerScenarios?.join('、') : apiSkill.triggerScenarios?.join('、') || local?.trigger,
    fitScenarios: apiSkill.triggerScenarios ?? (unanalysed ? [] : local?.fitScenarios) ?? [],
    unfitScenarios: unanalysed ? [] : local?.unfitScenarios ?? [],
    compatibleAgents: apiSkill.compatibleAgents ?? local?.compatibleAgents ?? [],
    isOrphan: false,
    hasWorkingCopy: local?.hasWorkingCopy ?? false,
    sourceModifiedFiles: local?.sourceModifiedFiles,
    sourceLocalModified: local?.sourceLocalModified,
    sourcePackageReady: local?.sourcePackageReady,
    copiedFromSource: local?.copiedFromSource,
    workingCopyChanges: local?.workingCopyChanges ?? 0,
    workingCopyHash: local?.workingCopyHash,
    createdAt: apiSkill.createdAt,
    updatedAt: apiSkill.updatedAt,
    visibility: apiSkill.visibility === 'public' || apiSkill.visibility === 'team'
      ? apiSkill.visibility
      : 'private',
    marketplaceStatus: apiSkill.marketplaceStatus === 'submitted'
      || apiSkill.marketplaceStatus === 'under_review'
      || apiSkill.marketplaceStatus === 'approved'
      || apiSkill.marketplaceStatus === 'rejected'
      || apiSkill.marketplaceStatus === 'withdrawn'
      ? apiSkill.marketplaceStatus
      : 'none',
    localPath: local?.localPath ?? '',
    serverId: apiSkill.id,
    serverOwnerId: apiSkill.authorId,
    authorName: apiSkill.author?.displayName ?? local?.authorName,
    authorAvatarUrl: apiSkill.author ? apiSkill.author.avatarUrl ?? null : local?.authorAvatarUrl,
    // Only a team response says who shared it; owned responses clear it.
    sharedBy: teamId ? apiSkill.sharedBy ?? null : undefined,
    sharedAt: teamId ? apiSkill.sharedAt ?? null : undefined,
    // The folder's account-library binding is local sidecar state (which
    // account's synced library holds it), independent of the author/team
    // rights above; dropping it would offer a device-only delete for a
    // synced Skill (#91). It never grants rights on the remote asset.
    libraryAccountId: local?.libraryAccountId,
    libraryEntryId: local?.libraryEntryId,
    addedByAccountId: local?.addedByAccountId,
  }
}

/**
 * Public Marketplace metadata is a separate catalog source. It may hydrate a
 * real local asset by immutable server id, but a remote listing keeps a unique
 * `market:` id so it never collides with Team Shared or My Skills state.
 */
export function mergeMarketplaceSkill(
  item: ApiMarketplaceItem,
  local: LocalSkill | undefined,
  _currentUserId?: string,
): LocalSkill {
  const apiSkill: ApiSkill = {
    id: item.id,
    name: item.name,
    displayName: item.displayName,
    description: item.description ?? undefined,
    sourceUrl: item.sourceUrl,
    avatarUrl: item.avatarUrl,
    avatarStatus: item.avatarStatus,
    category: item.category ?? undefined,
    labels: item.labels,
    triggerScenarios: item.triggerScenarios,
    compatibleAgents: item.compatibleAgents,
    envDependencies: item.envDependencies,
    currentVersion: item.currentVersion,
    installCount: item.installCount ?? item.downloadCount,
    authorId: item.author.id,
    visibility: 'public',
    marketplaceStatus: 'approved',
    createdAt: item.version.createdAt,
    updatedAt: item.publishedAt,
  }
  const approvedPackageSha256 = item.version.packageSha256?.toLowerCase()
  const runtimeLocal = local?.serverId === item.id && local.localPath ? local : undefined
  const merged = mergeApiSkill(apiSkill, runtimeLocal)
  return {
    ...merged,
    // Catalog identity must never collapse into the local managed-folder id.
    // The detail sheet uses this distinction to keep the public source while
    // filesystem commands are routed through marketplaceLocalId.
    id: `market:${item.id}`,
    catalogOrigin: OFFICIAL_ENDPOINTS.catalogOrigin.replace(/\/+$/, ''),
    marketplaceLocalId: runtimeLocal?.id,
    marketplaceLocalVersion: runtimeLocal?.acquisitionVersion ?? runtimeLocal?.version,
    marketplaceReplacementLocalId: undefined,
    marketplacePackageSha256: approvedPackageSha256,
    installCount: item.installCount ?? item.downloadCount,
    // Absent when the Server does not report it, so the detail strip hides the cell instead of showing 0.
    marketplaceUserCount: item.managedUserCount ?? item.userCount,
    marketplaceDownloadCount: typeof item.downloadCount === 'number' ? item.downloadCount : undefined,
    marketplaceBadges: normalizeStoreBadges(item.badges, { featured: item.featured, original: item.original }),
    marketplaceFeatured: item.featured === true,
    marketplaceOriginal: item.original === true,
    marketplaceFirstPublishedAt: item.firstPublishedAt ?? undefined,
    marketplaceEditorialLabels: item.editorialLabels ?? [],
    sources: ['Skill 商店'],
    acquisitionSource: 'marketplace',
    serverAccessValidatedForUserId: undefined,
    // Public catalog identity must not grant author controls. The protected
    // owned Skills response is the only source that may restore isOwn=true.
    isOwn: false,
    teamSharedFrom: undefined,
    sharedTo: {},
    version: item.version.version,
    latestVersion: item.version.version,
    versions: [{
      version: item.version.version,
      changelog: item.version.changelog ?? undefined,
      date: item.version.createdAt,
      isCurrent: true,
    }],
    visibility: 'public',
    marketplaceStatus: 'approved',
    marketplacePublishedAt: item.publishedAt,
    marketplaceVersionId: item.version.id,
    marketplaceSkillMd: item.skillMd,
    authorName: item.author.displayName,
    authorAvatarUrl: item.author.avatarUrl,
    serverId: item.id,
    serverOwnerId: item.author.id,
  }
}

export type ReplacedSkillSources = {
  skills: LocalSkill[]
  marketplaceSkills: LocalSkill[]
  nextSkillId: string
}

/**
 * Reconciles a local managed asset and its public catalog projection without
 * allowing either identity to overwrite the other.
 */
export function replaceSkillAcrossSources(
  skills: readonly LocalSkill[],
  marketplaceSkills: readonly LocalSkill[],
  currentId: string,
  updated: LocalSkill,
): ReplacedSkillSources {
  const catalog = marketplaceSkills.find((item) => (
    item.id === currentId
    || item.id === updated.id
    || item.marketplaceLocalId === updated.id
    || Boolean(updated.serverId && item.serverId === updated.serverId && item.catalogOrigin === updated.catalogOrigin)
  ))
  const catalogOperation = currentId.startsWith('market:')
    || updated.id.startsWith('market:')
    || catalog?.id === currentId
  const localId = updated.marketplaceLocalId
    ?? (!updated.id.startsWith('market:') && updated.localPath ? updated.id : catalog?.marketplaceLocalId)
  const existingLocalIndex = skills.findIndex((item) => (
    (localId ? item.id === localId : false)
    || (!catalogOperation && item.id === currentId)
    || (!catalogOperation && item.id === updated.id)
    || Boolean(updated.serverId && item.serverId === updated.serverId && item.catalogOrigin === updated.catalogOrigin)
  ))
  const existingLocal = existingLocalIndex >= 0 ? skills[existingLocalIndex] : undefined
  const shouldWriteLocal = !catalogOperation || Boolean(localId && updated.localPath)
  const localUpdate: LocalSkill | null = shouldWriteLocal
    ? {
        ...(existingLocal ?? updated),
        ...updated,
        id: localId ?? updated.id,
        marketplaceLocalId: undefined,
        marketplaceReplacementLocalId: undefined,
        marketplacePackageSha256: undefined,
        // Catalog provenance can never grant instance author ownership.
        isOwn: updated.catalogOrigin ? false : catalogOperation ? updated.isOwn : existingLocal?.isOwn ?? updated.isOwn,
        acquisitionSource: catalogOperation && updated.acquisitionSource === 'marketplace'
          ? 'marketplace'
          : existingLocal?.acquisitionSource ?? updated.acquisitionSource,
        acquisitionPackageSha256: updated.acquisitionPackageSha256
          ?? existingLocal?.acquisitionPackageSha256,
        teamSharedFrom: catalogOperation
          ? existingLocal?.teamSharedFrom
            ?? (updated.acquisitionSource === 'marketplace' ? undefined : updated.teamSharedFrom)
          : updated.teamSharedFrom,
        // Direct local operations such as Team share/unshare carry the new
        // authoritative server state. Catalog reconciliation still preserves
        // the local Team scope because public Marketplace data cannot grant or
        // revoke a private Team share.
        sharedTo: catalogOperation
          ? existingLocal?.sharedTo ?? updated.sharedTo
          : updated.sharedTo,
      }
    : null

  const nextSkills = localUpdate
    ? existingLocalIndex >= 0
      ? skills.map((item, index) => index === existingLocalIndex ? localUpdate : item)
      : localUpdate.localPath || !catalogOperation ? [...skills, localUpdate] : [...skills]
    : [...skills]

  const nextMarketplaceSkills = marketplaceSkills.map((item) => {
    const matches = item.id === currentId
      || item.id === updated.id
      || item.marketplaceLocalId === updated.id
      || Boolean(updated.serverId && item.serverId === updated.serverId && item.catalogOrigin === updated.catalogOrigin)
    if (!matches) return item
    const runtime = localUpdate ?? updated
    return {
      ...item,
      marketplaceLocalId: localUpdate?.id ?? item.marketplaceLocalId,
      marketplaceReplacementLocalId: undefined,
      marketplaceLocalVersion: runtime.acquisitionVersion ?? runtime.version,
      localPath: runtime.localPath,
      agents: runtime.agents,
      installed: runtime.installed,
      envDeps: runtime.envDeps,
      versions: runtime.versions.length > 0 ? runtime.versions : item.versions,
      hasWorkingCopy: runtime.hasWorkingCopy,
      sourceModifiedFiles: runtime.sourceModifiedFiles,
      sourceLocalModified: runtime.sourceLocalModified,
      sourcePackageReady: runtime.sourcePackageReady,
      copiedFromSource: runtime.copiedFromSource,
      versionProblem: runtime.versionProblem,
      workingCopyChanges: runtime.workingCopyChanges,
      workingCopyHash: runtime.workingCopyHash,
      accountSyncRequired: runtime.accountSyncRequired,
      acquisitionPackageSha256: runtime.acquisitionPackageSha256,
      installCount: catalogOperation ? Math.max(item.installCount, updated.installCount) : item.installCount,
    }
  })
  return {
    skills: nextSkills,
    marketplaceSkills: nextMarketplaceSkills,
    nextSkillId: catalogOperation && catalog ? catalog.id : localUpdate?.id ?? updated.id,
  }
}

function findTeamBinding(
  serverId: string,
  localTeamId: string | undefined,
  context: SkillMergeContext,
): { skill: ApiSkill; teamId: string } | null {
  const matching = context.teamSources.flatMap((source) => {
    const skill = source.skills?.find((candidate) => candidate.id === serverId)
    return skill ? [{ skill, teamId: source.teamId }] : []
  })
  // The same server Skill may be shared through several teams. The selected
  // team owns the current discussion and credential scope; a historical
  // sidecar source is only the fallback when that team does not expose it.
  if (!context.activeTeamId && localTeamId) return matching.find(binding => binding.teamId === localTeamId) ?? null
  return matching.find((binding) => binding.teamId === context.activeTeamId)
    ?? matching.find((binding) => binding.teamId === localTeamId)
    ?? matching[0]
    ?? null
}

export function mergeSkillSources(
  localSkills: LocalSkill[],
  ownedSkills: ApiSkill[] | null,
  context: SkillMergeContext,
): LocalSkill[] {
  const result = localSkills.map((local) => {
    if (!local.serverId) return local
    if (local.catalogOrigin) return downgradeMarketplaceAuthorization({ ...local, isOwn: false })

    const owned = ownedSkills?.find((skill) => skill.id === local.serverId)
    if (owned) return mergeApiSkill(owned, local, undefined, context.accountUserId, context.selfhost)

    const teamBinding = findTeamBinding(local.serverId, local.teamSharedFrom, context)
    if (teamBinding) {
      return mergeApiSkill(teamBinding.skill, local, teamBinding.teamId, context.accountUserId, context.selfhost)
    }

    // Only detach after every authenticated source has answered successfully.
    // A timeout from one inactive team is not evidence that access was revoked.
    const fullyValidated = ownedSkills !== null
      && context.membershipsValidated
      && context.teamSources.every((source) => source.skills !== null)
    // Marketplace acquisition is a public catalog binding, not an owner/team
    // authorization claim. Preserve its immutable listing id, but never reuse
    // cached sidecar rights when no protected response granted them. This also
    // fails closed while a protected request is temporarily unavailable.
    if (local.acquisitionSource === 'marketplace') {
      return downgradeMarketplaceAuthorization(local)
    }
    // My Skills deliberately does not load every Team catalog. That missing
    // Team context must not preserve a personal binding once the authenticated
    // owned-Skills endpoint has already proved that the asset is not owned by
    // this account. Team acquisitions remain untouched until their membership
    // sources have also been validated.
    if (ownedSkills !== null && local.isOwn && !local.teamSharedFrom) {
      return detachStaleServerBinding(local)
    }
    if (fullyValidated && local.acquisitionSource === 'team') return { ...local, teamUnshared: true, teamUpdateStatus: 'access_revoked', latestVersion: local.acquisitionVersion ?? local.version }
    if (fullyValidated) return detachStaleServerBinding(local)
    return local
  })

  // Remote identity is the server id, never a display/folder name. Different
  // assets may legitimately share the same name.
  const serverIds = new Set(result.flatMap((skill) => skill.serverId && !skill.catalogOrigin ? [skill.serverId] : []))
  for (const skill of ownedSkills ?? []) {
    if (!serverIds.has(skill.id)) {
      result.push(mergeApiSkill(skill, undefined, undefined, context.accountUserId, context.selfhost))
      serverIds.add(skill.id)
    }
  }

  // Inactive teams participate in binding validation only. Their uninstalled
  // remote assets are not added to the currently selected team view.
  const activeTeamSkills = context.teamSources.find((source) => source.teamId === context.activeTeamId)?.skills ?? []
  for (const skill of activeTeamSkills) {
    if (!serverIds.has(skill.id)) {
      result.push(mergeApiSkill(
        skill,
        undefined,
        context.activeTeamId ?? undefined,
        context.accountUserId,
        context.selfhost,
      ))
      serverIds.add(skill.id)
    }
  }
  return result
}
