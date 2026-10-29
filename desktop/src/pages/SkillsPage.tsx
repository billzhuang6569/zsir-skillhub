import type { SpaceHandle } from '../lib/tauri.js'
import { useSpaceCapabilities } from '../lib/use-space-capabilities.js'
import { spaceCapabilities } from '../lib/space-capabilities.js'
import { userMessage } from '../lib/user-message.js'
import { refreshAgentCapabilities } from '../lib/agent-detection.js'
import {
  useCallback, useEffect, useId, useMemo, useRef, useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
} from 'react'
import { open } from '@tauri-apps/plugin-dialog'
import { useStore } from '../store/index.js'
import { useShallow } from 'zustand/react/shallow'
import SkillLibraryList from '../components/SkillLibraryList.js'
import SkillTagGroups from '../components/SkillTagGroups.js'
import { allTags, skillOrganizerKey } from '../lib/skill-organizer.js'
import SkillBatchDialog from '../components/SkillBatchDialog.js'
import FocusTrapDialog from '../components/FocusTrapDialog.js'
import UnmanagedSkillCard from '../components/UnmanagedSkillCard.js'
import { emptyStateActions } from '../lib/onboarding.js'
import AgentBrandIcon from '../components/AgentBrandIcon.js'
import { cloudEnrichmentProgress, cloudLibrarySkills, hasPendingCloudEnrichment, managedOutsideAccount, startCloudSkillRefresh } from '../lib/cloud-library.js'
import { startLibraryWatch } from '../lib/library-watch.js'
import { createRefreshCoalescer } from '../lib/refresh-coalescer.js'
import type { ApiSkill } from '../lib/api.js'
import { runSkillsLoad } from '../lib/skills-load.js'
import { reconcileLocalSkillRefresh } from '../lib/ui-helpers.js'
import { Icon } from '../components/Icon.js'
import { SegmentedControl } from '../components/SegmentedControl.js'
import { EmptyState, LoadError, SkeletonBlock } from '../components/StateViews.js'
import { CLEAR_FILTERS_LABEL, EMPTY_COPY, LOADING_COPY, loadFailedMessage } from '../lib/state-copy.js'
import { BlankDragSpacer, blankDragRegion } from '../components/WindowDragRegion.js'
import { PageHeading } from '../components/PageHeading.js'
import { avatarIdentityFor } from '../lib/avatar-identity.js'
import {
  createSkillPackage,
  detectEnvVarSuggestions,
  isImportedEnvSuggestion,
  getSkillEnvSourcePolicy,
  getLocalSkills,
  getInstalledAgents,
  getUnmanagedAgentSkills,
  importSkill,
  preflightImportSkill,
  readSkillMd,
  skillLibraryFingerprint,
  syncEnvDependencies,
  updateSkillProfile,
  ensureSkillAvatarIdentity,
  libraryListEntries, librarySyncStatus,
  listLastRunFailures,
} from '../lib/tauri.js'
import { ApiError, apiGetMySkills, apiImportSkill, apiGetTeams, apiGetTeamSkills, sameSpace } from '../lib/api.js'
import { mergeSkillSources } from '../lib/skills.js'
import {
  isTeamSharedSkill, sameEnvKeySummary, summarizeRequiredEnvRows, type EnvKeySummary, locallyManagedSkillNames, unmanagedLocalSkills, isGenericLocalSkill, mapSettledWithConcurrency, matchesAgentInstallation, orderSkills, orderSkillsByName, reconcileAgentFilter, type SkillSortPreference,
  selectedVisibleLocalSkills,
} from '../lib/skill-library.js'
import { nextRovingIndex } from '../lib/ui-helpers.js'
import { readAuthSpace } from '../store/index.js'
import { LIBRARY_ENTRIES_CHANGED_EVENT, type KeptLocalSkill } from '../lib/library-sync.js'
import {
  ENV_READINESS_CHANGED_EVENT, ENV_READINESS_CONCURRENCY, envReadinessSignature, needsEnvReadinessCheck,
  type EnvReadinessChange,
} from '../lib/env-readiness.js'
import { toast } from '../components/Toast.js'
import type { AgentDetectionStatus, LocalSkill } from '../store/index.js'
import type { AgentInfo, ImportSkillPreflight, UnmanagedSkill } from '../lib/tauri.js'

type ImportStep = 'select' | 'confirm'

type ImportedAsset = {
  displayName: string
  analysisStatus: 'completed' | 'fallback' | 'recovered' | 'local'
  syncError?: string
}

type ImportCandidate = {
  path: string
  skillId: string | null
  displayName: string
  localSelectionId?: string
}

type PreparedImport = ImportCandidate & { plan: ImportSkillPreflight }

type LassoBox = { left: number; top: number; width: number; height: number }
/** `count` is absent when the read failed. */
type EnvReadinessResult = { signature: string; keys?: EnvKeySummary }

function sameRecord<Value>(
  left: Record<string, Value>,
  right: Record<string, Value>,
  same: (a: Value | undefined, b: Value | undefined) => boolean = (a, b) => a === b,
): boolean {
  const keys = Object.keys(left)
  return keys.length === Object.keys(right).length && keys.every((key) => same(left[key], right[key]))
}
/** How often the Skills page re-reads `skillhub run` failure records (#292). */
const LAST_RUN_POLL_MS = 30_000
type ManagedScope = 'all' | 'team'

async function importRealSkill(
  path: string,
  selectedSkillId: string | null,
  accountUserId: string | null,
  accountSpace: SpaceHandle | null,
  plan: ImportSkillPreflight,
  onLocalReady?: () => Promise<void>,
): Promise<ImportedAsset> {
  let local = await importSkill(path, selectedSkillId, {
    replaceConflicts: plan.hasConflicts,
    planDigest: plan.planDigest,
  })
  await onLocalReady?.()
  try {
    // Same rule as `skillhub skill import apply`: declared / high / medium are kept, low is a hint only.
    const suggestions = await detectEnvVarSuggestions(local.id)
    const keys = [...new Set([
      ...local.envDeps.map((dependency) => dependency.key),
      ...suggestions.filter(isImportedEnvSuggestion).map((suggestion) => suggestion.key),
    ])]
    local = await syncEnvDependencies(local.id, keys, suggestions)
  } catch (error: unknown) {
    return {
      displayName: local.displayName,
      analysisStatus: 'local',
      syncError: `Skill 配置检查稍后可重试：${messageOf(error)}`,
    }
  }
  const state = useStore.getState()
  if (!accountUserId || !accountSpace || !spaceCapabilities(state.activeSpace, state.serverInfo, state.spacePending).ai) {
    return { displayName: local.displayName, analysisStatus: 'local' }
  }
  const sessionStillMatches = (): boolean => (
    useStore.getState().currentUser?.id === accountUserId
    && readAuthSpace() === accountSpace
  )
  if (!sessionStillMatches()) {
    return { displayName: local.displayName, analysisStatus: 'local', syncError: '登录账号已切换，未上传 AI 标签' }
  }
  try {
    const [skillMd, skillPackage, deviceAvatarId] = await Promise.all([
      readSkillMd(local.id),
      createSkillPackage(local.id),
      ensureSkillAvatarIdentity(local.id),
    ])
    // Stable account identity + device alias from the first registration (#149).
    const avatarIdentity = avatarIdentityFor(local, accountUserId, deviceAvatarId)
    if (!sessionStillMatches()) {
      return { displayName: local.displayName, analysisStatus: 'local', syncError: '登录账号已切换，未上传 AI 标签' }
    }
    const currentCapabilities = useStore.getState().agentCapabilities
    const platformAgents = currentCapabilities.length > 0
      ? currentCapabilities
      : await getInstalledAgents()
    const result = await apiImportSkill({
      name: local.name,
      localSkillId: avatarIdentity?.stableId ?? deviceAvatarId,
      aliasLocalIds: avatarIdentity?.aliasLocalIds,
      skillMd,
      compatibleAgents: platformAgents.map((agent) => agent.key),
      envDependencies: local.envDeps.map(({ key, description, required }) => ({ key, description, required })),
      currentVersion: local.version,
      aiAnalysisConsent: true,
      packageBase64: skillPackage.base64,
      packageSha256: skillPackage.sha256,
    }, accountSpace)
    if (!sessionStillMatches()) {
      return { displayName: local.displayName, analysisStatus: 'local', syncError: '登录账号已切换，AI 标签可在原账号中重新同步' }
    }
    await updateSkillProfile(local.id, {
      serverId: result.skill.id,
      serverOwnerId: result.skill.authorId,
      displayName: result.skill.displayName,
      description: result.skill.description,
      category: result.skill.category,
      labels: result.skill.labels,
      triggerScenarios: result.skill.triggerScenarios,
      compatibleAgents: result.skill.compatibleAgents,
      version: result.skill.currentVersion,
    }, accountSpace)
    return { displayName: result.skill.displayName, analysisStatus: result.analysis.status === 'unanalysed' ? 'local' : result.analysis.status }
  } catch (error: unknown) {
    return {
      displayName: local.displayName,
      analysisStatus: 'local',
      syncError: `AI 标签可在详情中重试：${messageOf(error)}`,
    }
  }
}

function messageOf(error: unknown): string {
  return userMessage(error)
}

export default function SkillsPage() {
  const capabilities = useSpaceCapabilities()
  const {
    skills, setSkills, skillTab, setSkillTab, setView,
    searchQuery, setSearchQuery, categoryFilter, setCategoryFilter, currentUser, authStatus, teams,
    isLoadingSkills, setLoadingSkills, sheet, openSkillSheet, closeSheet,
    localSkillPreview, setLocalSkillPreview, localImportRequestId, clearLocalSkillImportRequest,
    agentCapabilities, agentDetectionStatus,
  } = useStore(useShallow(state => ({
    skills: state.skills, setSkills: state.setSkills, skillTab: state.skillTab, setSkillTab: state.setSkillTab, setView: state.setView,
    searchQuery: state.searchQuery, setSearchQuery: state.setSearchQuery, categoryFilter: state.categoryFilter, setCategoryFilter: state.setCategoryFilter,
    currentUser: state.currentUser, authStatus: state.authStatus, teams: state.teams, isLoadingSkills: state.isLoadingSkills,
    setLoadingSkills: state.setLoadingSkills, sheet: state.sheet, openSkillSheet: state.openSkillSheet, closeSheet: state.closeSheet,
    localSkillPreview: state.localSkillPreview, setLocalSkillPreview: state.setLocalSkillPreview, localImportRequestId: state.localImportRequestId,
    clearLocalSkillImportRequest: state.clearLocalSkillImportRequest, agentCapabilities: state.agentCapabilities, agentDetectionStatus: state.agentDetectionStatus,
  })))
  const activeSpace = useStore(state => state.activeSpace)
  const [agentLocalSkills, setUnmanagedSkills] = useState<UnmanagedSkill[]>([])
  const [keptLocalState, setKeptLocal] = useState<{ userId: string; items: KeptLocalSkill[] } | null>(null)
  const keptLocal = keptLocalState?.userId === currentUser?.id ? keptLocalState?.items ?? [] : []
  const loadError = useStore(state => state.skillsListError)
  const setLoadError = useStore(state => state.setSkillsListError)
  // The cloud phase of a load has its own indicator: local tabs never wait for it.
  const [cloudLoading, setCloudLoading] = useState(false)
  const skillSortPreference = useStore((state) => state.skillSortPreference)
  const setSkillSortPreference = useStore((state) => state.setSkillSortPreference)
  const loadGenerationRef = useRef(0)
  // One in-flight owned-Skills request per account: a native refresh started
  // while the previous cloud answer is still pending reuses it instead of
  // issuing another request; its own generation decides whether to publish it.
  const teamSourcesRef = useRef<{ userId: string; space: SpaceHandle | null; expires: number; request: Promise<{ teamId: string; skills: ApiSkill[] | null }[]> } | null>(null)
  const ownedInFlightRef = useRef<{ userId: string; space: SpaceHandle | null; request: Promise<ApiSkill[]> } | null>(null)
  const [showImport, setShowImport] = useState(false)
  const [importStep, setImportStep] = useState<ImportStep>('select')
  const [importError, setImportError] = useState<string | null>(null)
  const [batchQueue, setBatchQueue] = useState<UnmanagedSkill[]>([])
  const [preparedImports, setPreparedImports] = useState<PreparedImport[]>([])
  const [preflightLoading, setPreflightLoading] = useState(false)
  const preflightGenerationRef = useRef(0)
  const [selectedLocalIds, setSelectedLocalIds] = useState<Set<string>>(() => new Set())
  const [managedScope, setManagedScope] = useState<ManagedScope>('all')
  const [cloudBatch, setCloudBatch] = useState<{ skills: LocalSkill[]; action: 'share' | 'delete' } | null>(null)
  const [agentFilter, setAgentFilter] = useState('')
  const [lassoBox, setLassoBox] = useState<LassoBox | null>(null)
  const [envKeysBySkill, setEnvKeysBySkill] = useState<Record<string, EnvKeySummary>>({})
  const [envPolicyErrorBySkill, setEnvPolicyErrorBySkill] = useState<Record<string, true>>({})
  const envPolicyGenerationRef = useRef(0)
  const localSelectionRef = useRef<HTMLDivElement>(null)
  const localOptionRefs = useRef(new Map<string, HTMLDivElement>())
  const [focusedLocalId, setFocusedLocalId] = useState<string | null>(null)
  const lastSelectedLocalIdRef = useRef<string | null>(null)
  const lassoSessionRef = useRef<{
    pointerId: number
    startClientX: number
    startClientY: number
    baseSelection: Set<string>
    additive: boolean
    moved: boolean
  } | null>(null)

  const detectedAgents = useMemo(() => agentCapabilities.filter((agent) => agent.detected), [agentCapabilities])
  const retryAgentDetection = useCallback(async (): Promise<void> => {
    await refreshAgentCapabilities()
  }, [])

  useEffect(() => {
    setAgentFilter((selectedKey) => reconcileAgentFilter(
      selectedKey,
      agentDetectionStatus === 'success',
      new Set(detectedAgents.map((agent) => agent.key)),
    ))
  }, [agentDetectionStatus, detectedAgents])

  useEffect(() => {
    setAgentFilter('')
  }, [currentUser?.id])

  // One native read at a time for this account: overlapping asks (mount,
  // focus, library events, directory fingerprint) collapse into at most one
  // follow-up; see `createRefreshCoalescer`. Recreated when the account or
  // the load function changes, so a queued run never publishes for the old one.
  const runLoad = useCallback(async (silent: boolean): Promise<void> => {
    const expectedUserId = currentUser?.id ?? null
    const expectedSpace = useStore.getState().activeSpace
    const generation = ++loadGenerationRef.current
    const current = (): boolean => (useStore.getState().activeSpace === expectedSpace || sameSpace(useStore.getState().activeSpace, expectedSpace)) && generation === loadGenerationRef.current
      && (useStore.getState().currentUser?.id ?? null) === expectedUserId
    if (!silent && useStore.getState().skills.length === 0) setLoadingSkills(true)
    let teamRefreshFailed = false
    const ownedRequest = expectedUserId ? async (): Promise<ApiSkill[]> => {
      let catalog = teamSourcesRef.current
      if (!catalog || catalog.userId !== expectedUserId || !sameSpace(catalog.space, expectedSpace) || catalog.expires < Date.now() || !silent) {
        catalog = { userId: expectedUserId, space: expectedSpace, expires: Date.now() + 30_000,
          request: apiGetTeams(expectedSpace ?? undefined).then(teams => Promise.all(teams.map(async team => ({
            teamId: team.id, skills: await apiGetTeamSkills(team.id, expectedSpace ?? undefined).catch((error: unknown) =>
              error instanceof ApiError && [403, 404].includes(error.status ?? 0) ? [] : null),
          })))) }
        teamSourcesRef.current = catalog
      }
      let request = ownedInFlightRef.current?.userId === expectedUserId && sameSpace(ownedInFlightRef.current.space, expectedSpace) ? ownedInFlightRef.current.request : null
      if (!request) {
        request = apiGetMySkills(expectedSpace ?? undefined).finally(() => {
          if (ownedInFlightRef.current?.request === request) ownedInFlightRef.current = null
        })
        ownedInFlightRef.current = { userId: expectedUserId, space: expectedSpace, request }
      }
      const [owned, sources] = await Promise.all([request, catalog.request.catch(() => null)])
      teamRefreshFailed = !sources || sources.some(source => source.skills === null)
      if (teamRefreshFailed && teamSourcesRef.current === catalog) teamSourcesRef.current = null
      if (sources) { mergeContext.teamSources = sources; mergeContext.membershipsValidated = true }
      return owned
    } : null
    const mergeContext = { accountUserId: currentUser?.id, selfhost: capabilities.profile === 'selfhost', activeTeamId: null, membershipsValidated: false, teamSources: [] as { teamId: string; skills: ApiSkill[] | null }[] }
    const publishMerged = (merged: LocalSkill[]): void => {
      const state = useStore.getState()
      setSkills([...merged.filter(skill => skill.localPath),
        ...cloudLibrarySkills([...merged, ...state.skills.filter(skill => skill.cloudDownload)], state.libraryEntries, expectedUserId, state.libraryTransfers).filter(skill => !skill.localPath)])
    }
    const readInventory = Boolean(expectedUserId && (!silent || useStore.getState().skillsListError || useStore.getState().libraryEntries?.userId !== expectedUserId))
    let inventoryDone = !readInventory
    let inventoryError: string | null = null
    let sourcesDone = false
    let sourcesError: string | null = null
    const report = (): void => {
      if (!current()) return
      if (inventoryError || sourcesError || teamRefreshFailed) setLoadError('未能刷新 Skill 数据，请重试')
      else if (inventoryDone && sourcesDone) setLoadError(null)
    }
    try {
      // Start the lightweight inventory independently: do not wait for files or AI data.
      if (readInventory) void libraryListEntries().then(list => {
        if (!current()) return
        const state = useStore.getState()
        state.setLibraryEntries(list)
        state.setSkills([...state.skills.filter(skill => skill.localPath),
          ...cloudLibrarySkills(state.skills, list, expectedUserId, state.libraryTransfers).filter(skill => !skill.localPath)])
        inventoryDone = true
        report()
      }).catch(reason => {
        inventoryError = messageOf(reason)
        inventoryDone = true
        report()
      })
      let localSkills: LocalSkill[] | null = null
      if (ownedRequest) setCloudLoading(true)
      const load = await runSkillsLoad(
        {
          local: getLocalSkills,
          unmanaged: getUnmanagedAgentSkills,
          owned: ownedRequest,
        },
        {
          isCurrent: current,
          messageOf,
          publishLocal: (local, unmanaged) => {
            // Native results are shown at once. A Skill the page already holds
            // keeps the ownership/authorization it proved earlier in this
            // session until the cloud answer below replaces or revokes it;
            // nothing new is marked validated here.
            if (local !== null) {
              const previous = new Map(useStore.getState().skills.filter(skill => skill.localPath).map(skill => [skill.id, skill]))
              localSkills = mergeSkillSources(local, null, mergeContext).map(skill => {
                const known = previous.get(skill.id)
                return known && known.serverId === skill.serverId && (known.serverAccessValidatedForUserId === expectedUserId || known.accountSyncRequired || known.teamUnshared)
                  ? reconcileLocalSkillRefresh(known, skill)
                  : skill
              })
              publishMerged(localSkills)
            }
            if (unmanaged !== null) {
              setUnmanagedSkills(unmanaged.filter((skill) => skill.name !== 'yitan-skillhub-manager'))
            } else if (local !== null) {
              setUnmanagedSkills([])
            }
            if (expectedUserId) void librarySyncStatus().then(status => {
              if (current() && status.userId === expectedUserId) setKeptLocal({ userId: status.userId, items: status.keptLocal })
            }).catch(() => undefined)
            // Native results are on screen: the list placeholder goes away now,
            // whatever the cloud request is doing.
            if (!silent) setLoadingSkills(false)
          },
          publishOwned: (owned) => {
            // Fresh authorization from the authenticated endpoint: merge it in.
            publishMerged(mergeSkillSources(localSkills ?? useStore.getState().skills.filter(skill => skill.localPath), owned, mergeContext))
          },
          publishOwnedFailure: () => {
            // Keep the reconciled local/display snapshot; failure is not a grant or revocation.
          },
          publishError: message => { sourcesError = message; sourcesDone = true; report() },
        },
      )
      // The native phase is done; the cloud phase continues on its own so the
      // next native refresh (file change, install, window return) can start.
      if (load.cloud) void load.cloud.finally(() => { if (current()) setCloudLoading(false) })
      else if (current()) setCloudLoading(false)
    } catch (reason: unknown) {
      if (current()) {
        setLoadError(loadFailedMessage('Skill 数据', messageOf(reason)))
      }
    } finally {
      if (current() && !silent) setLoadingSkills(false)
    }
  }, [currentUser?.id, activeSpace?.spaceId, activeSpace?.generation, capabilities.profile, setLoadingSkills, setSkills])
  const loadCoalescer = useMemo(() => createRefreshCoalescer(runLoad, 5_000,
    JSON.stringify(['skills', activeSpace?.spaceId, activeSpace?.generation, currentUser?.id])), [runLoad])
  const loadSkills = useCallback((silent = false): Promise<void> => loadCoalescer.request(silent), [loadCoalescer])

  useEffect(() => {
    void loadSkills(useStore.getState().skills.length > 0)
    const refresh = (event: Event): void => {
      const detail: unknown = event instanceof CustomEvent ? event.detail : null
      if (!(detail && typeof detail === 'object' && 'reason' in detail && detail.reason === 'navigation')) {
        loadGenerationRef.current += 1; teamSourcesRef.current = null; ownedInFlightRef.current = null; loadCoalescer.invalidate()
      }
      void loadSkills(true)
    }
    const refreshTeam = refresh
    window.addEventListener('skillhub-local-changed', refresh)
    window.addEventListener(LIBRARY_ENTRIES_CHANGED_EVENT, refresh)
    window.addEventListener('skillhub:refresh-team-shares', refreshTeam)
    return () => { loadGenerationRef.current += 1; loadCoalescer.cancel(); window.removeEventListener('skillhub-local-changed', refresh); window.removeEventListener(LIBRARY_ENTRIES_CHANGED_EVENT, refresh); window.removeEventListener('skillhub:refresh-team-shares', refreshTeam) }
  }, [loadSkills, loadCoalescer])

  const rawManagedSkills = useMemo(
    () => skills.filter((skill) => Boolean(skill.localPath)),
    [skills],
  )
  const libraryEntries = useStore(state => state.libraryEntries)
  const libraryTransfers = useStore(state => state.libraryTransfers)
  const managedSkills = useMemo(() => cloudLibrarySkills(skills, libraryEntries, currentUser?.id ?? null, libraryTransfers), [skills, libraryEntries, currentUser?.id, libraryTransfers])
  const managedNames = useMemo(() => locallyManagedSkillNames(rawManagedSkills), [rawManagedSkills])
  const unmanagedSkills = useMemo(() => {
    const managedLocal = managedOutsideAccount(rawManagedSkills, currentUser?.id ?? null).map(skill => ({
      id: `managed:${skill.id}`, managedSkillId: skill.id, name: skill.name, displayName: skill.displayName,
      description: skill.description, category: skill.category, labels: skill.labels, version: skill.version,
      localPath: skill.localPath, sources: [{ agentKey: 'skillhub', agentName: 'SkillHub', entryName: skill.id }],
      joinLocalId: !skill.libraryAccountId ? keptLocal.find(item => item.skillId === skill.id)?.localId : undefined,
    }))
    return unmanagedLocalSkills([...managedLocal, ...agentLocalSkills], new Set(rawManagedSkills.map(skill => skill.localPath)))
  }, [rawManagedSkills, currentUser?.id, keptLocal, agentLocalSkills])
  const [localAgentFilter, setLocalAgentFilter] = useState('')
  const hasGenericSkills = unmanagedSkills.some(isGenericLocalSkill)
  useEffect(() => {
    if (localAgentFilter === 'generic' ? !hasGenericSkills : localAgentFilter && !detectedAgents.some(agent => agent.key === localAgentFilter)) setLocalAgentFilter('')
  }, [detectedAgents, hasGenericSkills, localAgentFilter])
  const personalManagedSkillCount = managedSkills.length
  const teamIds = useMemo(() => new Set(teams.map((team) => team.id)), [teams])

  // Environment readiness: each read may call the Server, so results are
  // cached per account by input signature and only stale Skills are read
  // again. Avatar or list refreshes that leave the inputs alone cost nothing.
  const envAccountUserId = currentUser?.id ?? null
  const envCandidates = useMemo(() => managedSkills.filter(needsEnvReadinessCheck), [managedSkills])
  const envCandidatesSignature = useMemo(
    () => envCandidates.map(envReadinessSignature).sort().join('\n'),
    [envCandidates],
  )
  const envCandidatesRef = useRef(envCandidates)
  envCandidatesRef.current = envCandidates
  const envResultsRef = useRef(new Map<string, EnvReadinessResult>())
  const envInFlightRef = useRef(new Map<string, object>())
  const envCacheAccountRef = useRef<string | null>(null)
  const [envInvalidation, setEnvInvalidation] = useState(0)

  const publishEnvResults = useCallback((accountUserId: string | null): void => {
    if ((useStore.getState().currentUser?.id ?? null) !== accountUserId) return
    const missing: Record<string, EnvKeySummary> = {}
    const errors: Record<string, true> = {}
    for (const skill of envCandidatesRef.current) {
      const result = envResultsRef.current.get(skill.id)
      if (!result || result.signature !== envReadinessSignature(skill)) continue
      if (result.keys === undefined) errors[skill.id] = true
      else missing[skill.id] = result.keys
    }
    setEnvKeysBySkill((previous) => sameRecord(previous, missing, sameEnvKeySummary) ? previous : missing)
    setEnvPolicyErrorBySkill((previous) => sameRecord(previous, errors) ? previous : errors)
  }, [])

  useEffect(() => {
    const invalidate = (event: Event): void => {
      const change = (event as CustomEvent<EnvReadinessChange | undefined>).detail ?? {}
      const all = !change.skillId && !change.serverId
      for (const skill of envCandidatesRef.current) {
        if (all || skill.id === change.skillId || (change.serverId !== undefined && skill.serverId === change.serverId)) {
          envResultsRef.current.delete(skill.id)
          envInFlightRef.current.delete(skill.id)
        }
      }
      if (all) envResultsRef.current.clear()
      setEnvInvalidation((value) => value + 1)
    }
    // Returning to the window retries only reads that failed, never the whole list.
    const retryFailed = (): void => {
      let retried = false
      for (const [skillId, result] of envResultsRef.current) {
        if (result.keys === undefined) { envResultsRef.current.delete(skillId); retried = true }
      }
      if (retried) setEnvInvalidation((value) => value + 1)
    }
    window.addEventListener(ENV_READINESS_CHANGED_EVENT, invalidate)
    window.addEventListener('focus', retryFailed)
    return () => {
      window.removeEventListener(ENV_READINESS_CHANGED_EVENT, invalidate)
      window.removeEventListener('focus', retryFailed)
    }
  }, [])

  useEffect(() => {
    const generation = ++envPolicyGenerationRef.current
    const accountUserId = envAccountUserId
    if (envCacheAccountRef.current !== accountUserId) {
      envResultsRef.current.clear()
      envInFlightRef.current.clear()
      envCacheAccountRef.current = accountUserId
    }
    const candidates = envCandidatesRef.current
    if (authStatus === 'restoring' || candidates.length === 0) {
      setEnvKeysBySkill({})
      setEnvPolicyErrorBySkill({})
      return
    }
    publishEnvResults(accountUserId)
    const stale = candidates.filter((skill) => {
      const signature = envReadinessSignature(skill)
      return envResultsRef.current.get(skill.id)?.signature !== signature
        && !envInFlightRef.current.has(skill.id)
    })
    if (stale.length === 0) return
    const space = accountUserId ? readAuthSpace() : null
    const current = (): boolean => (useStore.getState().currentUser?.id ?? null) === accountUserId && readAuthSpace() === space
    void mapSettledWithConcurrency(stale, ENV_READINESS_CONCURRENCY, async (skill) => {
      // A newer pass owns the queue; requests already sent still finish below.
      if (generation !== envPolicyGenerationRef.current || !current()) return
      const signature = envReadinessSignature(skill)
      const request = {}
      envInFlightRef.current.set(skill.id, request)
      let result: EnvReadinessResult
      try {
        result = { signature, keys: summarizeRequiredEnvRows(await getSkillEnvSourcePolicy(skill.id, accountUserId, capabilities.teamKeys)) }
      } catch {
        result = { signature }
      }
      // Dropped when the account changed or an edit invalidated this read.
      if (envInFlightRef.current.get(skill.id) !== request) return
      envInFlightRef.current.delete(skill.id)
      if (!current()) return
      envResultsRef.current.set(skill.id, result)
      publishEnvResults(accountUserId)
    })
  }, [authStatus, envAccountUserId, capabilities.teamKeys, envCandidatesSignature, envInvalidation, publishEnvResults])

  // Last-run failures (#292): `skillhub run` happens outside the APP, so the
  // records are read with the library, on readiness edits, on focus and
  // every LAST_RUN_POLL_MS while this page is visible.
  const setLastRunFailures = useStore(state => state.setLastRunFailures)
  const lastRunSkillIds = useMemo(() => skills.map(skill => skill.id).sort().join('\n'), [skills])
  useEffect(() => {
    if (authStatus === 'restoring') return
    let active = true
    const accountUserId = envAccountUserId
    const refresh = (): void => {
      if (document.visibilityState === 'hidden') return
      void listLastRunFailures(accountUserId).then((records) => {
        if (active && (useStore.getState().currentUser?.id ?? null) === accountUserId) setLastRunFailures(records)
      }).catch(() => { /* Mid-switch or unreadable records: try again on the next tick. */ })
    }
    refresh()
    const timer = window.setInterval(refresh, LAST_RUN_POLL_MS)
    window.addEventListener('focus', refresh)
    window.addEventListener(ENV_READINESS_CHANGED_EVENT, refresh)
    document.addEventListener('visibilitychange', refresh)
    return () => {
      active = false
      window.clearInterval(timer)
      window.removeEventListener('focus', refresh)
      window.removeEventListener(ENV_READINESS_CHANGED_EVENT, refresh)
      document.removeEventListener('visibilitychange', refresh)
    }
  }, [authStatus, envAccountUserId, setLastRunFailures, lastRunSkillIds])

  const enrichmentPending = hasPendingCloudEnrichment(skills)
  useEffect(() => {
    const polling = startCloudSkillRefresh(Boolean(currentUser) && authStatus === 'authenticated' && enrichmentPending,
      () => { void loadSkills(true) }, () => document.visibilityState === 'visible',
      () => cloudEnrichmentProgress(useStore.getState().skills))
    const refreshOnReturn = (): void => { polling.resume(); void loadSkills(true) }
    window.addEventListener('focus', refreshOnReturn)
    window.addEventListener('pointerdown', polling.resume)
    window.addEventListener('keydown', polling.resume)
    return () => {
      window.removeEventListener('focus', refreshOnReturn)
      window.removeEventListener('pointerdown', polling.resume)
      window.removeEventListener('keydown', polling.resume)
      polling.stop()
    }
  }, [loadSkills, currentUser?.id, authStatus, enrichmentPending])

  // Picks up Skills that Agents or the terminal add, edit or remove while
  // SkillHub stays visible, without waiting for the window to regain focus.
  useEffect(() => startLibraryWatch({
    readFingerprint: skillLibraryFingerprint,
    onChange: async () => {
      // Lets the title indicator show "待同步" for edits made outside SkillHub.
      void skillLibraryFingerprint()
        .then((fingerprint) => useStore.getState().dispatchLibrarySync({ type: 'local-change', fingerprint }))
        .catch(() => undefined)
      await loadSkills(true)
    },
    isVisible: () => document.visibilityState === 'visible',
  }), [loadSkills])

  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && !event.defaultPrevented) {
        setSelectedLocalIds(new Set())
        setLassoBox(null)
        lastSelectedLocalIdRef.current = null
      }
    }
    document.addEventListener('keydown', closeOnEscape)
    return () => {
      document.removeEventListener('keydown', closeOnEscape)
    }
  }, [])

  const categories = useMemo(() => {
    const values = skillTab === 'local'
      ? new Set(unmanagedSkills.flatMap((skill) => skill.sources.map((source) => source.agentName)))
      : new Set(managedSkills.flatMap((skill) => (
          skill.labels.length > 0
            ? skill.labels.map((label) => label.trim()).filter(Boolean)
            : skill.category?.trim() ? [skill.category.trim()] : []
        )))
    return ['全部', ...Array.from(values).sort((left, right) => left.localeCompare(right, 'zh-CN'))]
  }, [skillTab, managedSkills, unmanagedSkills])

  useEffect(() => {
    if (!categories.includes(categoryFilter)) setCategoryFilter('全部')
  }, [categories, categoryFilter, setCategoryFilter])

  const filtered = useMemo(() => {
    const query = searchQuery.trim().toLowerCase()
    return orderSkills(managedSkills.filter((skill) =>
      (!query || skill.displayName.toLowerCase().includes(query) || skill.name.toLowerCase().includes(query)) &&
      (categoryFilter === '全部' || skill.labels.includes(categoryFilter) || (skill.labels.length === 0 && skill.category === categoryFilter)) &&
      (!agentFilter || matchesAgentInstallation(skill, agentFilter)) &&
      (managedScope === 'all' || isTeamSharedSkill(skill, currentUser?.id ?? null, teamIds))
    ), skillSortPreference)
  }, [agentFilter, categoryFilter, currentUser?.id, managedScope, managedSkills, searchQuery, skillSortPreference, teamIds])

  const managedFiltering = Boolean(searchQuery.trim()) || categoryFilter !== '全部' || Boolean(agentFilter) || managedScope !== 'all'
  const tagCount = useStore((state) => allTags(state.organizer, new Set(managedSkills.map(skill => skillOrganizerKey(skill, state.currentUser?.id ?? null)))).length)

  const clearManagedFilters = useCallback((): void => {
    setAgentFilter('')
    setManagedScope('all')
    setSearchQuery('')
    setCategoryFilter('全部')
  }, [setCategoryFilter, setSearchQuery])

  // Sidebar quick access (#325) reveals a Skill: drop the page's own filters so it stays visible.
  const skillReveal = useStore((state) => state.skillReveal)
  const clearSkillReveal = useStore((state) => state.clearSkillReveal)
  useEffect(() => {
    if (!skillReveal) return
    setAgentFilter('')
    setManagedScope('all')
    clearSkillReveal(skillReveal.nonce)
  }, [clearSkillReveal, skillReveal])

  useEffect(() => {
    // Wait until a pending reveal has cleared the filters, or the revealed Skill would be replaced.
    if (skillReveal) return
    if (skillTab === 'local') {
      if (sheet?.kind === 'skill') closeSheet()
      return
    }
    if (isLoadingSkills || cloudLoading) return
    if (filtered.length === 0) {
      if (sheet?.kind === 'skill') closeSheet()
      return
    }
    if (sheet?.kind === 'team') return
    if (sheet?.kind !== 'skill' || !filtered.some((skill) => skill.id === sheet.skillId)) {
      const firstSkill = filtered[0]
      if (firstSkill) openSkillSheet(firstSkill.id)
    }
  }, [closeSheet, filtered, openSkillSheet, sheet, skillReveal, skillTab, isLoadingSkills, cloudLoading])
  const filteredUnmanaged = useMemo(() => {
    const query = searchQuery.trim().toLowerCase()
    // 本地 Skills carry no timestamps, so 排序 (#361) applies to the account list only.
    return orderSkillsByName(unmanagedSkills.filter((skill) =>
      (!query || skill.displayName.toLowerCase().includes(query) || skill.name.toLowerCase().includes(query)) &&
      (!localAgentFilter || (localAgentFilter === 'generic' ? isGenericLocalSkill(skill) : skill.sources.some(source => source.agentKey === localAgentFilter)))
    ))
  }, [localAgentFilter, searchQuery, unmanagedSkills])
  const visibleLocalIds = useMemo(
    () => filteredUnmanaged.map((skill) => skill.id),
    [filteredUnmanaged],
  )
  const selectableLocalIds = useMemo(
    () => filteredUnmanaged.filter((skill) => !managedNames.has(skill.name)).map((skill) => skill.id),
    [filteredUnmanaged, managedNames],
  )
  const selectedLocalSkills = useMemo(
    () => selectedVisibleLocalSkills(filteredUnmanaged, selectedLocalIds, managedNames),
    [filteredUnmanaged, managedNames, selectedLocalIds],
  )

  useEffect(() => {
    setFocusedLocalId((current) => current && visibleLocalIds.includes(current)
      ? current
      : visibleLocalIds[0] ?? null)
  }, [visibleLocalIds])

  useEffect(() => {
    if (skillTab !== 'local') return
    const selected = filteredUnmanaged.find((skill) => skill.id === localSkillPreview?.id)
      ?? filteredUnmanaged[0]
      ?? null
    if (!selected) {
      if (localSkillPreview) setLocalSkillPreview(null)
      return
    }
    const alreadyManaged = managedNames.has(selected.name)
    if (localSkillPreview?.id === selected.id && localSkillPreview.alreadyManaged === alreadyManaged && localSkillPreview.joinLocalId === selected.joinLocalId) return
    setLocalSkillPreview({ ...selected, alreadyManaged })
  }, [filteredUnmanaged, localSkillPreview, managedNames, setLocalSkillPreview, skillTab])

  useEffect(() => {
    const available = new Set(unmanagedSkills.filter((skill) => !managedNames.has(skill.name)).map((skill) => skill.id))
    setSelectedLocalIds((current) => {
      const next = new Set(Array.from(current).filter((id) => available.has(id)))
      return next.size === current.size ? current : next
    })
  }, [managedNames, unmanagedSkills])

  const toggleLocalSkillSelection = (
    skill: UnmanagedSkill,
    event: ReactMouseEvent<HTMLElement> | ReactKeyboardEvent<HTMLElement>,
  ): void => {
    if (managedNames.has(skill.name)) return
    setFocusedLocalId(skill.id)
    const additive = event.metaKey || event.ctrlKey
    setSelectedLocalIds((current) => {
      if (event.shiftKey && lastSelectedLocalIdRef.current) {
        const anchorIndex = selectableLocalIds.indexOf(lastSelectedLocalIdRef.current)
        const targetIndex = selectableLocalIds.indexOf(skill.id)
        if (anchorIndex >= 0 && targetIndex >= 0) {
          const range = selectableLocalIds.slice(
            Math.min(anchorIndex, targetIndex),
            Math.max(anchorIndex, targetIndex) + 1,
          )
          return new Set(additive ? [...current, ...range] : range)
        }
      }
      const next = new Set(current)
      if (next.has(skill.id)) next.delete(skill.id)
      else next.add(skill.id)
      return next
    })
    lastSelectedLocalIdRef.current = skill.id
  }

  const onLocalOptionKeyDown = (
    event: ReactKeyboardEvent<HTMLDivElement>,
    skill: UnmanagedSkill,
    index: number,
  ): void => {
    if (event.target !== event.currentTarget) return
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'a') {
      event.preventDefault()
      setSelectedLocalIds(new Set(selectableLocalIds))
      return
    }
    const nextIndex = nextRovingIndex(index, visibleLocalIds.length, event.key, 'vertical')
    if (nextIndex !== null) {
      event.preventDefault()
      const nextId = visibleLocalIds[nextIndex]
      if (!nextId) return
      setFocusedLocalId(nextId)
      localOptionRefs.current.get(nextId)?.focus()
      return
    }
    if (event.key === 'Enter') {
      event.preventDefault()
      setLocalSkillPreview({ ...skill, alreadyManaged: managedNames.has(skill.name) })
      return
    }
    if (event.key === ' ' && !managedNames.has(skill.name)) {
      event.preventDefault()
      toggleLocalSkillSelection(skill, event)
    }
  }

  const onSelectionPointerDown = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (event.button !== 0) return
    const target = event.target as HTMLElement
    if (target.closest('.unmanaged-select-item, button, input, a')) return
    const surface = localSelectionRef.current
    if (!surface) return
    const additive = event.metaKey || event.ctrlKey
    lassoSessionRef.current = {
      pointerId: event.pointerId,
      startClientX: event.clientX,
      startClientY: event.clientY,
      baseSelection: additive ? new Set(selectedLocalIds) : new Set(),
      additive,
      moved: false,
    }
    surface.setPointerCapture(event.pointerId)
  }

  const onSelectionPointerMove = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const session = lassoSessionRef.current
    const surface = localSelectionRef.current
    if (!session || !surface || session.pointerId !== event.pointerId) return
    const distance = Math.hypot(event.clientX - session.startClientX, event.clientY - session.startClientY)
    if (!session.moved && distance < 4) return
    event.preventDefault()
    session.moved = true
    const surfaceRect = surface.getBoundingClientRect()
    const clientLeft = Math.min(session.startClientX, event.clientX)
    const clientTop = Math.min(session.startClientY, event.clientY)
    const clientRight = Math.max(session.startClientX, event.clientX)
    const clientBottom = Math.max(session.startClientY, event.clientY)
    setLassoBox({
      left: clientLeft - surfaceRect.left + surface.scrollLeft,
      top: clientTop - surfaceRect.top + surface.scrollTop,
      width: clientRight - clientLeft,
      height: clientBottom - clientTop,
    })
    const hits = Array.from(surface.querySelectorAll<HTMLElement>('.unmanaged-select-item[data-selectable="true"]'))
      .filter((element) => {
        const rect = element.getBoundingClientRect()
        return rect.left <= clientRight && rect.right >= clientLeft && rect.top <= clientBottom && rect.bottom >= clientTop
      })
      .flatMap((element) => element.dataset.skillId ? [element.dataset.skillId] : [])
    setSelectedLocalIds(new Set([...session.baseSelection, ...hits]))
  }

  const finishSelectionPointer = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const session = lassoSessionRef.current
    const surface = localSelectionRef.current
    if (!session || session.pointerId !== event.pointerId) return
    if (!session.moved && !session.additive) {
      setSelectedLocalIds(new Set())
      lastSelectedLocalIdRef.current = null
    }
    if (surface?.hasPointerCapture(event.pointerId)) surface.releasePointerCapture(event.pointerId)
    lassoSessionRef.current = null
    setLassoBox(null)
  }

  const startImport = (): void => {
    preflightGenerationRef.current += 1
    setShowImport(true)
    setImportStep('select')
    setImportError(null)
    setBatchQueue([])
    setPreparedImports([])
    setPreflightLoading(false)
  }

  const closeImport = (): void => {
    preflightGenerationRef.current += 1
    setShowImport(false)
    setPreflightLoading(false)
  }

  const prepareImports = async (candidates: ImportCandidate[]): Promise<void> => {
    const generation = ++preflightGenerationRef.current
    setShowImport(true)
    setImportStep('confirm')
    setPreparedImports([])
    setPreflightLoading(true)
    setImportError(null)
    const settled = await mapSettledWithConcurrency(candidates, 2, async (candidate) => ({
      ...candidate,
      plan: await preflightImportSkill(candidate.path, candidate.skillId),
    }))
    if (generation !== preflightGenerationRef.current) return
    const failed = settled.find((result): result is PromiseRejectedResult => result.status === 'rejected')
    if (failed) {
      setImportError(`无法检查所选 Skill：${messageOf(failed.reason)}`)
      setPreflightLoading(false)
      return
    }
    setPreparedImports(settled.flatMap((result) => result.status === 'fulfilled' ? [result.value] : []))
    setPreflightLoading(false)
  }

  const startImportForSkill = (skill: UnmanagedSkill): void => {
    setBatchQueue([])
    void prepareImports([{
      path: skill.localPath,
      skillId: skill.name,
      displayName: skill.displayName,
      localSelectionId: skill.id,
    }])
  }

  useEffect(() => {
    if (!localImportRequestId) return
    const requested = unmanagedSkills.find((skill) => skill.id === localImportRequestId)
    clearLocalSkillImportRequest()
    if (requested && !managedNames.has(requested.name)) startImportForSkill(requested)
  }, [clearLocalSkillImportRequest, localImportRequestId, managedNames, unmanagedSkills])

  const startBatchImport = (): void => {
    if (selectedLocalSkills.length === 0) return
    setBatchQueue(selectedLocalSkills)
    void prepareImports(selectedLocalSkills.map((skill) => ({
      path: skill.localPath,
      skillId: skill.name,
      displayName: skill.displayName,
      localSelectionId: skill.id,
    })))
  }

  const chooseFolder = async (): Promise<void> => {
    try {
      const selected = await open({ directory: true, multiple: false, title: '选择 Skill 所在的文件夹' })
      if (typeof selected === 'string') {
        setBatchQueue([])
        void prepareImports([{ path: selected, skillId: null, displayName: '所选 Skill' }])
      }
    } catch (error: unknown) {
      setImportError(`无法打开文件选择器：${messageOf(error)}`)
    }
  }

  const chooseZip = async (): Promise<void> => {
    try {
      const selected = await open({
        directory: false,
        multiple: false,
        title: '选择 Skill 压缩包（.zip）',
        filters: [{ name: 'Skill ZIP', extensions: ['zip'] }],
      })
      if (typeof selected === 'string') {
        setBatchQueue([])
        void prepareImports([{ path: selected, skillId: null, displayName: '所选 Skill' }])
      }
    } catch (error: unknown) {
      setImportError(`无法打开文件选择器：${messageOf(error)}`)
    }
  }

  const executeImport = (): void => {
    if (preparedImports.length === 0 || preflightLoading) return
    const queuedImports = [...preparedImports]
    const accountUserId = currentUser?.id ?? null
    const accountSpace = currentUser ? readAuthSpace() : null
    closeImport()
    toast(queuedImports.length > 1 ? `已开始导入 ${queuedImports.length} 个 Skill` : '已开始导入，可继续使用 SkillHub')
    void (async (): Promise<void> => {
    if (queuedImports.length > 1) {
      const settled = await mapSettledWithConcurrency(queuedImports, 2, async (job) => (
        importRealSkill(job.path, job.skillId, accountUserId, accountSpace, job.plan)
      ))
      const failedIds = new Set(settled.flatMap((result, index) => (
        result.status === 'rejected' && queuedImports[index]?.localSelectionId
          ? [queuedImports[index].localSelectionId]
          : []
      )))
      const pendingSync = settled.filter((result) => result.status === 'fulfilled' && result.value.syncError).length
      setSelectedLocalIds(failedIds)
      await loadSkills()
      const succeeded = settled.length - failedIds.size
      if (failedIds.size === 0 && pendingSync === 0) toast(`${succeeded} 个 Skill 已加入 SkillHub`)
      else if (failedIds.size === 0) toast(`${succeeded} 个 Skill 已加入，${pendingSync} 个可稍后生成 AI 标签`, 'warn')
      else if (succeeded > 0) toast(`${succeeded} 个导入成功，${failedIds.size} 个需要处理`, 'error')
      else toast(`导入失败：${settled.find((result) => result.status === 'rejected')?.reason ? messageOf(settled.find((result) => result.status === 'rejected')?.reason) : '请稍后重试'}`, 'error')
      return
    }
    try {
      const job = queuedImports[0]
      if (!job) return
      const result = await importRealSkill(
        job.path,
        job.skillId,
        accountUserId,
        accountSpace,
        job.plan,
        () => loadSkills(true),
      )
      await loadSkills()
      toast(
        result.syncError
          ? `「${result.displayName}」已加入 SkillHub；${result.syncError}`
          : `「${result.displayName}」已加入 SkillHub`,
        result.syncError ? 'warn' : 'default',
      )
    } catch (error: unknown) {
      await loadSkills()
      toast(`导入失败：${messageOf(error)}`, 'error')
    }
    })()
  }

  const conflictingAgents = Array.from(new Set(preparedImports.flatMap((job) => (
    job.plan.sources.filter((source) => !source.matchesSelected).map((source) => source.agentName)
  ))))
  const hasImportConflicts = preparedImports.some((job) => job.plan.hasConflicts)

  // Refreshing shows only on the icon (rotation, or a dimmed static icon with
  // reduced motion): no status text, so the button never changes size (#317).
  // It stays clickable and focused: loadSkills coalesces overlapping clicks, and a
  // stalled cloud phase must not block rescanning local Skills.
  const skillsRefreshing = isLoadingSkills || cloudLoading

  const importTitle = importStep === 'select'
    ? '你的 Skill 在哪里？'
    : '确认导入'

  return (
    <>
      <PageHeading
        title="我的 Skills"
        subtitle="在左侧选择 Skill，在右侧持续查看和管理"
        className="skills-title-row"
        actions={<>
          <SegmentedControl
            className="skills-source-tabs"
            aria-label="Skill 来源"
            value={skillTab}
            onChange={setSkillTab}
            options={[
              { value: 'skillhub', label: capabilities.library ? 'SkillHub 云端' : '已托管', icon: capabilities.library ? 'cloud' : 'skills', count: personalManagedSkillCount },
              { value: 'tags', label: '目录', icon: 'tag', count: tagCount },
              { value: 'local', label: '本地', icon: 'laptop', count: unmanagedSkills.length },
            ]}
          />
          <BlankDragSpacer />
          <button
            type="button"
            className={`ico-btn header-refresh${skillsRefreshing ? ' refreshing' : ''}`}
            onClick={() => void loadSkills()}
            aria-busy={skillsRefreshing}
            title={skillsRefreshing ? '正在刷新…' : '刷新'}
            aria-label={skillsRefreshing ? '正在刷新…' : '刷新'}
          ><Icon name="refresh" size={15} /></button>
          <button className="btn btn-primary" onClick={startImport}><Icon name="plus" size={14} />导入 Skill</button>
          <button className="btn btn-ghost marketplace-shortcut" aria-label="Skill 商店" title="Skill 商店" onClick={() => setView('marketplace')}><Icon name="market" size={16} /><span className="marketplace-shortcut-label">Skill 商店</span></button>
        </>}
      >
        <div className="toolbar skills-filter-row" {...blankDragRegion()}>
          <label className="search-bar"><Icon name="search" size={14} /><input placeholder="告诉 SkillHub 你想找什么" value={searchQuery} onChange={(event) => setSearchQuery(event.target.value)} /></label>
          {skillTab === 'local' ? <div className="local-agent-filters" aria-label="Agent 工具">
            {detectedAgents.map(agent => <button type="button" key={agent.key} aria-label={agent.name} title={agent.name} aria-pressed={localAgentFilter === agent.key} onClick={() => setLocalAgentFilter(current => current === agent.key ? '' : agent.key)}><AgentBrandIcon agent={agent} size={20} /></button>)}
            {hasGenericSkills && <button type="button" aria-label="通用" title="通用" aria-pressed={localAgentFilter === 'generic'} onClick={() => setLocalAgentFilter(current => current === 'generic' ? '' : 'generic')}><Icon name="skills" size={20} /></button>}
          </div> : <div className="category-scroll" aria-label="Skill 分类">
            {categories.map((category) => (
              <button key={category} className={`filter-btn${categoryFilter === category ? ' active' : ''}`} onClick={() => setCategoryFilter(category)}>{category}</button>
            ))}
          </div>}
          {skillTab === 'local' && selectedLocalSkills.length > 0 && (
            <div className="local-selection-toolbar" aria-live="polite">
              <span>已选 {selectedLocalSkills.length} 个</span>
              <button className="btn btn-primary btn-sm" onClick={startBatchImport}><Icon name="plus" size={13} />加入 SkillHub</button>
              <button className="btn btn-ghost btn-sm" onClick={() => { setSelectedLocalIds(new Set()); lastSelectedLocalIdRef.current = null }}>取消选择</button>
            </div>
          )}
        </div>
      </PageHeading>

      <div className="page-body skills-page-body" id={`skill-source-panel-${skillTab}`} role="tabpanel" aria-label={skillTab === 'local' ? '本地 Skill' : skillTab === 'tags' ? '按目录分组的 Skill' : 'SkillHub 云端 Skill'}>
        {loadError && <LoadError message={loadError} onRetry={() => void loadSkills()} />}
        {isLoadingSkills && !(skillTab !== 'local' && managedSkills.length > 0) ? (
          <SkeletonBlock layout="rows" label={LOADING_COPY.skills} />
        ) : skillTab === 'local' ? (
          filteredUnmanaged.length === 0
            ? <EmptyLocalSkills query={searchQuery} />
            : (
              <div
                ref={localSelectionRef}
                id="local-skills-surface"
                className="local-skill-surface list"
                role="listbox"
                aria-label="本地 Skill"
                aria-describedby="local-skills-selection-help"
                onPointerDown={onSelectionPointerDown}
                onPointerMove={onSelectionPointerMove}
                onPointerUp={finishSelectionPointer}
                onPointerCancel={finishSelectionPointer}
              >
                <span id="local-skills-selection-help" className="sr-only">点击 Skill 可在右侧预览；使用复选框选择一个或多个 Skill 加入 SkillHub，按住 Shift 可连续选择。</span>
                <div className="local-skills-list local-skills-layout">
                  {filteredUnmanaged.map((skill) => {
                    const alreadyManaged = managedNames.has(skill.name)
                    const selected = selectedLocalIds.has(skill.id)
                    const previewed = localSkillPreview?.id === skill.id
                    const visibleIndex = visibleLocalIds.indexOf(skill.id)
                    return (
                      <div
                        ref={(element) => { if (element) localOptionRefs.current.set(skill.id, element); else localOptionRefs.current.delete(skill.id) }}
                        key={skill.id}
                        className={`unmanaged-select-item${selected ? ' selected' : ''}${previewed ? ' previewed' : ''}${alreadyManaged ? ' ineligible' : ''}`}
                        data-skill-id={skill.id}
                        data-selectable={!alreadyManaged}
                        role="option"
                        aria-selected={previewed}
                        tabIndex={focusedLocalId === skill.id ? 0 : -1}
                        onFocus={(event) => { if (event.target === event.currentTarget) setFocusedLocalId(skill.id) }}
                        onClick={() => setLocalSkillPreview({ ...skill, alreadyManaged })}
                        onKeyDown={(event) => onLocalOptionKeyDown(event, skill, visibleIndex)}
                      >
                        {!alreadyManaged && <button
                          type="button"
                          className="local-selection-indicator"
                          role="checkbox"
                          aria-checked={selected}
                          aria-label={`${selected ? '取消选择' : '选择'} ${skill.displayName}`}
                          onClick={(event) => { event.stopPropagation(); toggleLocalSkillSelection(skill, event) }}
                        ><Icon name="check" size={11} /></button>}
                        <UnmanagedSkillCard
                          skill={skill}
                          alreadyManaged={alreadyManaged}
                          previewed={previewed}
                        />
                      </div>
                    )
                  })}
                </div>
                {lassoBox && <span className="local-lasso" style={lassoBox} aria-hidden="true" />}
              </div>
            )
        ) : <>
          {managedSkills.length === 0
            ? loadError ? null : cloudLoading && !libraryEntries ? <SkeletonBlock layout="rows" label={LOADING_COPY.skills} /> : <EmptyManagedSkills onImport={startImport} />
            : <SkillSection selectionResetKey={JSON.stringify([searchQuery, categoryFilter, managedScope, agentFilter])} layout={skillTab === 'tags' ? 'tags' : 'list'} allSkills={managedSkills} filtering={managedFiltering} onBatch={(skills, action) => setCloudBatch(current => current ?? { skills, action })} skills={filtered} sortPreference={skillSortPreference} onSortChange={setSkillSortPreference} managedScope={managedScope} onScopeChange={setManagedScope} agents={detectedAgents} agentFilter={agentFilter} onAgentFilterChange={setAgentFilter} agentDetectionStatus={agentDetectionStatus} onRetryAgentDetection={() => void retryAgentDetection()} onClearFilters={clearManagedFilters} envKeysBySkill={envKeysBySkill} envPolicyErrorBySkill={envPolicyErrorBySkill} />}
        </>}
      </div>

      {cloudBatch && <SkillBatchDialog skills={cloudBatch.skills} action={cloudBatch.action} onClose={() => setCloudBatch(null)} />}
      {showImport && (
        <FocusTrapDialog className="modal-layer" label="导入 Skill" onEscape={closeImport}>
          <div className="modal-card">
            <div className="modal-head">
              <div><span className="eyebrow">导入 Skill · {importStep === 'select' ? '1/2' : '2/2'}</span><h2>{importTitle}</h2></div>
              <button className="ico-btn" onClick={closeImport} aria-label="关闭导入"><Icon name="x" size={16} /></button>
            </div>
            {importStep === 'select' && (
              <>
                <p className="modal-copy">一个 Skill 通常是一个文件夹，里面有一份 <span className="mono">SKILL.md</span> 说明文件。别人发给你的也可能是一个压缩包。</p>
                {importError && <div className="banner banner-error"><Icon name="warn" size={14} />{importError}</div>}
                <div className="import-source-options">
                  <button className="import-source-card" onClick={() => void chooseFolder()}><span><Icon name="folder" size={20} /></span><b>从文件夹导入</b><small>Skill 已经在电脑上，选中它所在的文件夹</small></button>
                  <button className="import-source-card" onClick={() => void chooseZip()}><span><Icon name="box" size={20} /></span><b>从压缩包导入</b><small>别人发给你的 .zip 文件，不用先解压</small></button>
                </div>
              </>
            )}
            {importStep === 'confirm' && (
              <>
                {batchQueue.length > 0 ? (
                  <div className="batch-confirm-box">
                    <b>已选择 {batchQueue.length} 个本地 Skill</b>
                    <div>{batchQueue.map((skill) => <span key={skill.id}>{skill.displayName}</span>)}</div>
                  </div>
                ) : (
                  <div className="selection-box compact"><b>已选择</b><span>{preparedImports[0]?.plan.skillId ?? '所选 Skill'}</span></div>
                )}
                <div className="import-ai-note"><span><Icon name="spark" size={16} /></span><div><b>{capabilities.ai && currentUser ? 'AI 会分析您的 Skill，给到您适合的标签。' : 'SkillHub 会先把您的 Skill 加入本机管理。'}</b>{capabilities.ai && !currentUser && <small>登录后可使用 AI 生成适合的标签。</small>}</div></div>
                {preflightLoading && <div className="import-preflight-status"><span className="spin-icon" />正在检查本机 Skill…</div>}
                {hasImportConflicts && (
                  <div className="banner banner-warn import-conflict-note">
                    <Icon name="warn" size={15} />
                    <div>
                      <b>发现同名但内容不同的 Skill</b>
                      <span>{conflictingAgents.length > 0 ? `${conflictingAgents.join('、')} 中的其他版本` : '其他 Agent 中的版本'}会移入回收站，并以您当前选择的版本为准。之后可随时恢复。</span>
                    </div>
                  </div>
                )}
                {importError && <div className="banner banner-error import-error"><Icon name="warn" size={14} />{importError}</div>}
                <div className="modal-actions">
                  <button className="btn btn-ghost" onClick={() => {
                    if (batchQueue.length > 0 || hasImportConflicts) closeImport()
                    else {
                      preflightGenerationRef.current += 1
                      setPreparedImports([])
                      setPreflightLoading(false)
                      setImportStep('select')
                    }
                  }}>{hasImportConflicts ? '保留现状' : batchQueue.length > 0 ? '取消' : '重新选择'}</button>
                  <button className="btn btn-primary" disabled={preflightLoading || preparedImports.length === 0} onClick={executeImport}>{preflightLoading ? '正在检查…' : hasImportConflicts ? '使用当前版本' : batchQueue.length > 0 ? `导入 ${batchQueue.length} 个 Skill` : '导入'}</button>
                </div>
              </>
            )}
          </div>
        </FocusTrapDialog>
      )}
    </>
  )
}

function SkillSection({ layout, allSkills, filtering, skills, sortPreference, onSortChange, managedScope, onScopeChange, agents, agentFilter, onAgentFilterChange, agentDetectionStatus, onRetryAgentDetection, onClearFilters, selectionResetKey, onBatch, envKeysBySkill, envPolicyErrorBySkill }: { layout: 'list' | 'tags'; allSkills: LocalSkill[]; filtering: boolean; skills: LocalSkill[]; sortPreference: SkillSortPreference; onSortChange: (preference: SkillSortPreference) => void; managedScope: ManagedScope; onScopeChange: (scope: ManagedScope) => void; agents: AgentInfo[]; agentFilter: string; onAgentFilterChange: (key: string) => void; agentDetectionStatus: AgentDetectionStatus; onRetryAgentDetection: () => void; onClearFilters: () => void; selectionResetKey: string; onBatch: (skills: LocalSkill[], action: 'share' | 'delete') => void; envKeysBySkill: Record<string, EnvKeySummary>; envPolicyErrorBySkill: Record<string, true> }) {
  return <><div className="skills-filter-bar">
    <SkillSortControl value={sortPreference} onChange={onSortChange} />
    <div className="skills-filter-controls">
    <AgentFilterControl agents={agents} selectedKey={agentFilter} onSelect={onAgentFilterChange} />
    <ScopeFilterControl scope={managedScope} onSelect={onScopeChange} />
  </div></div>
    {agentDetectionStatus === 'error' && <div className="agent-filter-status" role="status"><span>{agents.length > 0 ? 'Agent 检测失败，已保留本次会话最近一次成功结果。' : 'Agent 检测失败，当前仅显示默认筛选。'}</span><button type="button" className="link-button" onClick={onRetryAgentDetection}>重试检测</button></div>}
    {agentDetectionStatus === 'checking' && <div className="agent-filter-status" role="status">正在检测本机 Agent…</div>}
    {skills.length > 0 || (layout === 'tags' && !filtering)
      ? layout === 'tags'
        // 标签 (#324): the same filters, grouped by the account's private tags.
        ? <SkillTagGroups allSkills={allSkills} skills={skills} filtering={filtering} selectionResetKey={selectionResetKey} onBatch={onBatch} envKeysBySkill={envKeysBySkill} envPolicyErrorBySkill={envPolicyErrorBySkill} />
        : <SkillLibraryList skills={skills} selectionResetKey={selectionResetKey} onBatch={onBatch} envKeysBySkill={envKeysBySkill} envPolicyErrorBySkill={envPolicyErrorBySkill} />
      : <EmptyState copy={managedScope === 'team' && !agentFilter ? EMPTY_COPY.skillsTeamScope : EMPTY_COPY.skillsNoMatch}><button type="button" className="btn btn-ghost btn-sm" onClick={onClearFilters}>{CLEAR_FILTERS_LABEL}</button></EmptyState>}
  </>
}

/**
 * Popover shared by the Agent and 共享范围 filters (#318). Open state lives in
 * React instead of a native `<details>` so WKWebView/WebView2 cannot drop or
 * re-toggle it; outside pointer, focus leave and Escape close it.
 */
function useFilterMenu(): { open: boolean; toggle: () => void; close: () => void; menuId: string; rootRef: RefObject<HTMLDivElement>; triggerRef: RefObject<HTMLButtonElement> } {
  const [open, setOpen] = useState(false)
  const menuId = useId()
  const rootRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    if (!open) return
    const closeOnOutside = (event: Event): void => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false)
    }
    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      event.stopPropagation()
      setOpen(false)
      triggerRef.current?.focus()
    }
    document.addEventListener('pointerdown', closeOnOutside)
    document.addEventListener('focusin', closeOnOutside)
    // Capture phase: Escape closes only this menu, never the list selection's own Escape handler.
    document.addEventListener('keydown', closeOnEscape, true)
    return () => {
      document.removeEventListener('pointerdown', closeOnOutside)
      document.removeEventListener('focusin', closeOnOutside)
      document.removeEventListener('keydown', closeOnEscape, true)
    }
  }, [open])
  const close = (): void => {
    setOpen(false)
    triggerRef.current?.focus()
  }
  return { open, toggle: () => setOpen((current) => !current), close, menuId, rootRef, triggerRef }
}

const SCOPE_OPTIONS: ReadonlyArray<{ value: ManagedScope; label: string }> = [
  { value: 'all', label: '所有' },
  { value: 'team', label: '团队共享' },
]

function ScopeFilterControl({ scope, onSelect }: { scope: ManagedScope; onSelect: (scope: ManagedScope) => void }) {
  const capabilities = useSpaceCapabilities()
  const { open, toggle, close, menuId, rootRef, triggerRef } = useFilterMenu()
  if (!capabilities.teams) return null
  const current = SCOPE_OPTIONS.find((option) => option.value === scope) ?? SCOPE_OPTIONS[0]
  return <div className={`agent-filter skills-filter-dropdown scope-filter${open ? ' open' : ''}`} ref={rootRef}>
    <button type="button" className="agent-filter-trigger" ref={triggerRef} aria-expanded={open} aria-controls={menuId} aria-label={`共享范围：${current?.label ?? '所有'}`} title={`共享范围：${current?.label ?? '所有'}`} data-active={scope !== 'all' || undefined} onClick={toggle}>
      <span className="agent-filter-default-icon"><Icon name="team" size={15} /></span>
      <span className="agent-filter-trigger-label">{scope === 'all' ? '共享范围' : current?.label}</span><Icon name="chev" size={13} />
    </button>
    {open && <div id={menuId} className="agent-filter-menu" role="group" aria-label="按共享范围筛选">
      {SCOPE_OPTIONS.map((option) => <button type="button" key={option.value} aria-pressed={scope === option.value} onClick={() => { onSelect(option.value); close() }}><span className="agent-filter-default-icon"><Icon name={option.value === 'team' ? 'team' : 'box'} size={15} /></span><span>{option.label}</span>{scope === option.value && <Icon name="check" size={14} />}</button>)}
    </div>}
  </div>
}

function AgentFilterControl({ agents, selectedKey, onSelect }: { agents: AgentInfo[]; selectedKey: string; onSelect: (key: string) => void }) {
  const { open, toggle, close, menuId, rootRef, triggerRef } = useFilterMenu()
  const selectedAgent = agents.find((agent) => agent.key === selectedKey)
  const select = (key: string): void => {
    onSelect(key)
    close()
  }
  return <div className={`agent-filter skills-filter-dropdown${open ? ' open' : ''}`} ref={rootRef}>
    <button type="button" className="agent-filter-trigger" ref={triggerRef} aria-expanded={open} aria-controls={menuId} aria-label={`Agent 筛选：${selectedAgent?.name ?? '所有 Agent'}`} title={`Agent 筛选：${selectedAgent?.name ?? '所有 Agent'}`} data-active={Boolean(selectedKey) || undefined} onClick={toggle}>
      {selectedAgent ? <AgentBrandIcon agent={selectedAgent} size={18} /> : <span className="agent-filter-default-icon"><Icon name="spark" size={15} /></span>}
      <span className="agent-filter-trigger-label">{selectedAgent?.name ?? 'Agent'}</span><Icon name="chev" size={13} />
    </button>
    {open && <div id={menuId} className="agent-filter-menu" role="group" aria-label="按已安装 Agent 筛选">
      <button type="button" aria-pressed={!selectedKey} onClick={() => select('')}><span className="agent-filter-default-icon"><Icon name="spark" size={15} /></span><span>所有 Agent</span>{!selectedKey && <Icon name="check" size={14} />}</button>
      {agents.map((agent) => <button type="button" key={agent.key} aria-pressed={selectedKey === agent.key} onClick={() => select(agent.key)}><AgentBrandIcon agent={agent} size={18} /><span>{agent.name}</span>{selectedKey === agent.key && <Icon name="check" size={14} />}</button>)}
    </div>}
  </div>
}

const SORT_OPTIONS: { value: SkillSortPreference; reverse: SkillSortPreference; label: string; icon: 'clock' | 'type'; defaultText: string; reverseText: string; defaultArrow: string; reverseArrow: string }[] = [
  { value: 'time', reverse: 'time-asc', label: '按时间', icon: 'clock', defaultText: '最新在前', reverseText: '最早在前', defaultArrow: '↓', reverseArrow: '↑' },
  { value: 'name', reverse: 'name-desc', label: '按名称', icon: 'type', defaultText: 'A→Z', reverseText: 'Z→A', defaultArrow: '↑', reverseArrow: '↓' },
]

/** 排序 (#361): the choice persists on this computer. */
function SkillSortControl({ value, onChange }: { value: SkillSortPreference; onChange: (preference: SkillSortPreference) => void }) {
  return <div className="skills-sort-control" role="group" aria-label="排序">
    {SORT_OPTIONS.map((option) => {
      const selected = value === option.value || value === option.reverse
      const reversed = value === option.reverse
      const description = selected
        ? `${option.label}：${reversed ? option.reverseText : option.defaultText}，再次点击切换为${reversed ? option.defaultText : option.reverseText}`
        : `${option.label}：点击切换为${option.defaultText}`
      return <button key={option.value} type="button" className="skills-sort-button" aria-pressed={selected} aria-label={description} title={description} onClick={() => onChange(selected && !reversed ? option.reverse : option.value)}><Icon name={option.icon} size={15} /><span>{option.label}</span>{selected && <span aria-hidden="true">{reversed ? option.reverseArrow : option.defaultArrow}</span>}</button>
    })}
  </div>
}

function EmptyManagedSkills({ onImport }: { onImport: () => void }) {
  return <EmptyState copy={EMPTY_COPY.skillsLibrary} icon="box">{emptyStateActions({ teams: false }, 'skills').map(action => <button key={action} className={`btn ${action === 'import' ? 'btn-primary' : 'btn-ghost'}`} onClick={() => action === 'import' ? onImport() : useStore.getState().setView('marketplace')}>{action === 'import' ? '导入已有 Skill' : '去商店看看'}</button>)}</EmptyState>
}

function EmptyLocalSkills({ query }: { query: string }) {
  return <EmptyState copy={query ? EMPTY_COPY.localNoMatch : EMPTY_COPY.localNone} icon={query ? 'search' : 'check'} />
}
