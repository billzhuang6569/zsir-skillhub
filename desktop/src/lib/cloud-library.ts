import type { LocalSkill } from '../store/index.js'
import type { LibraryEntryList, LibraryTransfer } from './library-sync.js'
import { validateSourceUrl } from './source-url.ts'

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
    const transfer = transfers[entry.entryId]
    return {
      id: `library:${entry.entryId}`, name: entry.name, displayName: entry.displayName,
      description: remote ? remote.description : entry.profile?.description, category: remote ? remote.category : entry.profile?.category,
      sourceUrl: entrySourceUrl(entry.profile?.sourceUrl),
      labels: remote ? remote.labels : entry.profile?.labels ?? [], compatibleAgents: entry.profile?.compatibleAgents ?? [],
      trigger: remote?.trigger, fitScenarios: remote?.fitScenarios,
      avatarUrl: previous?.avatarUrl, avatarStatus: previous?.avatarStatus,
      serverAnalysisStatus: previous?.serverAnalysisStatus,
      avatarAccountUserId: previous?.avatarAccountUserId,
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
  return [...result, ...own.filter(skill => !list.entries.some(entry => entry.entryId === skill.libraryEntryId))]
}

export function managedOutsideAccount(skills: readonly LocalSkill[], userId: string | null): LocalSkill[] {
  return userId ? skills.filter(skill => skill.localPath && !skill.isSystem
    && !(skill.libraryAccountId === userId && skill.libraryEntryId)
    && !(!skill.libraryAccountId && skill.addedByAccountId === userId)) : []
}
