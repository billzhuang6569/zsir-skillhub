import type { LocalSkill } from '../store/index.js'
import type { LibraryEntryList, LibraryTransfer } from './library-sync.js'
import { validateSourceUrl } from './source-url.ts'
import { reconcileSkillList } from './stable-list.ts'

/** Refresh cloud enrichment while the page is visible; React owns the account-scoped lifetime. */
export function startCloudSkillRefresh(enabled: boolean, refresh: () => void, isVisible: () => boolean,
  readProgress: () => string = () => ''): { stop: () => void; resume: () => void } {
  let previous = readProgress()
  let unchanged = 0
  let disposed = false
  let timer: ReturnType<typeof setInterval> | null = null
  const tick = (): void => {
    if (!isVisible()) return
    const progress = readProgress()
    unchanged = progress === previous ? unchanged + 1 : 0
    previous = progress
    refresh()
    if (unchanged >= 20 && timer !== null) { clearInterval(timer); timer = null }
  }
  const resume = (): void => {
    if (!enabled || disposed || timer !== null) return
    previous = readProgress(); unchanged = 0
    timer = setInterval(tick, 30_000)
  }
  resume()
  return { resume, stop: (): void => { disposed = true; if (timer !== null) clearInterval(timer); timer = null } }
}

export function hasPendingCloudEnrichment(skills: readonly LocalSkill[]): boolean {
  return skills.some(skill => Boolean(skill.serverId)
    && skill.enrichmentPending === true)
}

export function cloudEnrichmentProgress(skills: readonly LocalSkill[]): string {
  return JSON.stringify(skills.filter(skill => skill.serverId).map(skill => [skill.serverId, skill.enrichmentPending,
    skill.serverAnalysisStatus, skill.avatarStatus, skill.avatarUrl]).sort((a, b) => String(a[0]).localeCompare(String(b[0]))))
}

/** The entry's 「来源」 for a not-yet-downloaded row; an invalid value is dropped. */
function entrySourceUrl(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const checked = validateSourceUrl(value)
  return checked.ok && checked.value ? checked.value : undefined
}

/** Entry identity, never folder/name identity, reconciles the cloud list with real files. */
export function cloudLibrarySkills(
  skills: readonly LocalSkill[], list: LibraryEntryList | null, userId: string | null,
  transfers: Readonly<Record<string, LibraryTransfer>> = {},
): LocalSkill[] {
  if (!userId) return skills.filter(skill => Boolean(skill.localPath) && !skill.isSystem)
  const own = skills.filter(skill => skill.localPath && !skill.isSystem && (
    (skill.libraryAccountId === userId && Boolean(skill.libraryEntryId))
    || (!skill.libraryAccountId && skill.addedByAccountId === userId)))
  if (list?.userId !== userId) return own
  const result = list.entries.filter(entry => !entry.deleted).map(entry => {
    const local = own.find(skill => skill.libraryEntryId === entry.entryId)
    if (local) return local
    const remote = skills.find(skill => entry.serverSkillId && skill.serverId === entry.serverSkillId && skill.serverAccessValidatedForUserId === userId)
    const previous = remote ?? skills.find(skill => skill.id === `library:${entry.entryId}` && skill.libraryAccountId === userId)
    const sameRevision = previous?.cloudDownload?.revision === entry.revision
    const transfer = transfers[entry.entryId]
    return {
      id: `library:${entry.entryId}`, name: entry.name, displayName: remote?.displayName ?? (sameRevision ? previous?.displayName : undefined) ?? entry.profile?.displayName ?? entry.displayName,
      description: remote ? remote.description : entry.profile?.description ?? previous?.description, category: remote ? remote.category : entry.profile?.category ?? previous?.category,
      sourceUrl: entry.profile?.sourceUrl === undefined ? previous?.sourceUrl : entrySourceUrl(entry.profile.sourceUrl),
      labels: remote ? remote.labels : entry.profile?.labels ?? previous?.labels ?? [], compatibleAgents: entry.profile?.compatibleAgents ?? previous?.compatibleAgents ?? [],
      trigger: remote?.trigger ?? previous?.trigger, fitScenarios: remote?.fitScenarios ?? previous?.fitScenarios,
      avatarUrl: previous?.avatarUrl, avatarStatus: previous?.avatarStatus,
      serverAnalysisStatus: previous?.serverAnalysisStatus,
      enrichmentPending: previous?.enrichmentPending,
      avatarAccountUserId: previous?.avatarAccountUserId,
      createdAt: remote?.createdAt ?? previous?.createdAt,
      marketplacePublishedAt: remote?.marketplacePublishedAt ?? previous?.marketplacePublishedAt,
      version: entry.version?.label ?? '', latestVersion: '', installCount: 0, sources: [], agents: {}, installed: false,
      versionStatus: entry.version ? 'confirmed' : entry.versionPolicy === 1 ? 'unversioned' : undefined,
      versionReceiptId: entry.version?.receiptId,
      formalVersionId: entry.version?.formalVersionId ?? undefined,
      formalLabel: entry.version?.formalLabel ?? undefined,
      isOwn: false, acquisitionSource: entry.sourceKind ?? 'local', envDeps: [], sharedTo: {}, versions: [],
      localPath: '', serverId: entry.serverSkillId ?? undefined,
      libraryAccountId: userId, libraryEntryId: entry.entryId,
      cloudDownload: transfer?.userId === userId && transfer.revision === entry.revision
        ? transfer : { userId, entryId: entry.entryId, revision: entry.revision, received: 0, total: null, phase: 'downloading' as const, error: null },
    } satisfies LocalSkill
  })
  // An import may already be bound locally while its Server list refresh is in flight.
  return reconcileSkillList(skills, [...result, ...own.filter(skill => !list.entries.some(entry => entry.entryId === skill.libraryEntryId))])
}

export function managedOutsideAccount(skills: readonly LocalSkill[], userId: string | null): LocalSkill[] {
  return userId ? skills.filter(skill => skill.localPath && !skill.isSystem
    && !(skill.libraryAccountId === userId && skill.libraryEntryId)
    && !(!skill.libraryAccountId && skill.addedByAccountId === userId)) : []
}
