import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Icon } from './components/Icon.js'
import { useSpaceCapabilities } from './lib/use-space-capabilities.js'
import { spaceProfile } from './lib/space-capabilities.js'
import ConnectServerDialog from './components/ConnectServerDialog.js'
import Onboarding from './components/Onboarding.js'
import { SPACE_SWITCH_VIEW_KEY, testSpaceConnection } from './lib/spaces.js'
import { setMediaContext } from './lib/media.js'
import { listen } from '@tauri-apps/api/event'
import { openUrl } from '@tauri-apps/plugin-opener'
import { flushOrganizerSave, useStore } from './store/index.js'
import { useShallow } from 'zustand/react/shallow'
import Sidebar from './components/Sidebar.js'
import SkillsPage from './pages/SkillsPage.js'
import TeamsPage from './pages/TeamsPage.js'
import TeamSharedPage from './pages/TeamSharedPage.js'
import MarketplacePage from './pages/MarketplacePage.js'
import SettingsPage from './pages/SettingsPage.js'
import KeyVaultPage from './pages/KeyVaultPage.js'
import SkillDetailSheet from './components/SkillDetailSheet.js'
import CloudSkillPreview from './components/CloudSkillPreview.js'
import { cloudLibrarySkills } from './lib/cloud-library.js'
import { mergeApiSkill } from './lib/skills.js'
import { acceptLocalWorkerStatus, canApplyLocalAnalysisRefresh, isCurrentWorkerEvent, LOCAL_INFERENCE_PREFERENCE_EVENT, readLocalInferencePreference } from './lib/local-inference.js'
import { ORGANIZER_SYNC_DEBOUNCE_MS, ORGANIZER_SYNC_INTERVAL_MS, ORGANIZER_SYNC_RETRY_MS, organizerPendingCount, startCapabilityProbe } from './lib/organizer-sync.js'
import TeamDetailSheet from './components/TeamDetailSheet.js'
import AuthDialog from './components/AuthDialog.js'
import TeamInviteDialog, { OtherServerInviteDialog } from './components/TeamInviteDialog.js'
import LocalSkillPreviewPanel from './components/LocalSkillPreviewPanel.js'
import FeedbackDialog from './components/FeedbackDialog.js'
import AppUpdateDialog from './components/AppUpdateDialog.js'
import KeyConsentDialog from './components/KeyConsentDialog.js'
import KeyInstallGuide from './components/KeyInstallGuide.js'
import ToastContainer, { toast } from './components/Toast.js'
import {
  apiAcceptTeamInvite,
  apiGetNotifications,
  apiGetTeamInvite,
  apiGetTeams,
  apiGetSkill,
  apiHealth,
  prepareCatalogMedia,
  onApiUnauthorized,
  sameSpace,
  ApiError,
  type ApiAuthSession,
  type ApiTeamInvite,
} from './lib/api.js'
import { deleteLegacyAuth } from './lib/auth.js'
import { restoreNativeAuth, retryNativeAuthRestore, isRetryableRestoreError } from './lib/auth-restore.js'
import { readAuthSpace } from './store/index.js'
import { DONATION_PAGE_URL } from './lib/official-endpoints.js'
import { settledError, settledValue } from './lib/ui-helpers.js'
import {
  currentSpace,
  currentMediaSpace,
  type SpaceHandle,
  authState,
  clearNativeAuthSession,
  librarySyncRun,
  librarySyncStatus,
  readClipboardText,
  skillLibraryFingerprint,
  takePendingDeepLinks,
  localInferenceWorkerConfigure,
  localInferenceWorkerStatus,
  type LocalInferenceWorkerStatus,
} from './lib/tauri.js'
import { refreshAgentCapabilities } from './lib/agent-detection.js'
import { syncMarketplaceManagedPresence } from './lib/marketplace-presence.js'
import { resetSkillAvatarCache, syncSkillAvatars, refreshSkillAvatarSelections, AVATAR_SELECTIONS_CHANGED_EVENT } from './lib/skill-avatars.js'
import {
  LIBRARY_SYNC_CAPABILITY,
  LIBRARY_ENTRIES_CHANGED_EVENT,
  LIBRARY_SYNC_REQUEST_EVENT,
  LIBRARY_SYNC_SLOW_MS,
  requestLibrarySync,
  startLibrarySync,
  type LibrarySyncScheduler,
  type LibraryEntryList, type LibraryTransfer,
} from './lib/library-sync.js'
import { parseTeamInvite, isSameInviteServer, inviteSwitchTarget, teamInviteDeepLink, PENDING_INVITE_KEY, resumePendingTeamInvite, type ParsedTeamInvite } from './lib/team-invite.js'
import { parseMarketplaceDeepLink } from './lib/marketplace-deep-link.js'
import { createTeamSkillBaseUrlsCache, isTeamSkillServer, parseTeamSkillLink, TEAM_SKILL_UNAVAILABLE, type TeamSkillLink } from './lib/team-skill-link.js'
import { apiGetTeamSkillLink, apiGetTeamSkills } from './lib/api.js'
import { checkForAppUpdate } from './lib/app-updater.js'
import { applyThemePreference } from './lib/theme.js'
import { useTheme } from './lib/use-theme.js'
import './styles/app.css'
import { MigrationProvider } from './components/MigrationActivity.js'

export default function App() {
  return <MigrationProvider><AppContent /></MigrationProvider>
}

function AppContent() {
  const {
    view,
    skillTab,
    sheet,
    closeSheet,
    setTeams,
    setNotifications,
    authStatus,
    authSpace,
    currentUser,
    setAuthSession,
    setAuthGuest,
    clearAuthSession,
    authPrompt,
    promptForAuth,
    dismissAuthPrompt,
    setView,
    openSkillSheet,
    setActiveTeam,
    setLibrarySyncEnabled,
    setPendingMarketplaceIntent,
    skills,
  } = useStore(useShallow(state => ({
    view: state.view, skillTab: state.skillTab, sheet: state.sheet, closeSheet: state.closeSheet,
    setTeams: state.setTeams, setNotifications: state.setNotifications, authStatus: state.authStatus, authSpace: state.authSpace,
    currentUser: state.currentUser, setAuthSession: state.setAuthSession, setAuthGuest: state.setAuthGuest, clearAuthSession: state.clearAuthSession,
    authPrompt: state.authPrompt, promptForAuth: state.promptForAuth, dismissAuthPrompt: state.dismissAuthPrompt, setView: state.setView,
    openSkillSheet: state.openSkillSheet, setActiveTeam: state.setActiveTeam, setLibrarySyncEnabled: state.setLibrarySyncEnabled,
    setPendingMarketplaceIntent: state.setPendingMarketplaceIntent, skills: state.skills,
  })))
  const capabilities = useSpaceCapabilities()
  const activeSpace = useStore(state => state.activeSpace)
  const serverInfo = useStore(state => state.serverInfo)
  const spacePending = useStore(state => state.spacePending)
  const [selfhostAuth, setSelfhostAuth] = useState<{ target: string; report: Awaited<ReturnType<typeof testSpaceConnection>> | null; teamInvite?: boolean; migrationSource?: boolean } | null>(null)
  const spaceKey = JSON.stringify(activeSpace)
  const localWorkerQueue = useRef<Promise<void>>(Promise.resolve())
  // APP-owned subscription: navigating away from settings never stops the worker.
  useEffect(() => {
    let disposed = false
    let unlisten: (() => void) | undefined
    const receive = (payload: LocalInferenceWorkerStatus): void => {
      const state = useStore.getState()
      if (disposed || !acceptLocalWorkerStatus(payload, state.activeSpace, state.currentUser?.id)) return
      const captured = state.skills.find(skill => skill.serverId === payload.skillId || skill.id === payload.skillId)
      requestLibrarySync()
      window.dispatchEvent(new Event(LIBRARY_ENTRIES_CHANGED_EVENT))
      // Also update an open detail sheet when the Skills page is not mounted.
      void apiGetSkill(payload.skillId!, payload.space).then(skill => {
        const current = useStore.getState()
        if (disposed || !isCurrentWorkerEvent(payload, current.activeSpace, current.currentUser?.id)) return
        current.setSkills(current.skills.map(local => (local.serverId === skill.id || local.id === skill.id) && canApplyLocalAnalysisRefresh(local, captured, skill.updatedAt)
          ? mergeApiSkill(skill, local, undefined, payload.userId, true) : local))
      }).catch(() => {})
    }
    void listen<LocalInferenceWorkerStatus>('local-inference-worker', event => receive(event.payload)).then(stop => {
      if (disposed) stop(); else unlisten = stop
    }).catch(() => {})
    return () => { disposed = true; unlisten?.() }
  }, [])
  useEffect(() => {
    let disposed = false
    const configure = (): void => {
      if (!activeSpace || spacePending || capabilities.profile !== 'selfhost' || authStatus !== 'authenticated' || !currentUser) return
      localWorkerQueue.current = localWorkerQueue.current.catch(() => {}).then(async () => {
        if (disposed) return
        const preference = readLocalInferencePreference(activeSpace, currentUser.id)
        await localInferenceWorkerConfigure(activeSpace, preference.enabled && preference.autoAnalyze, preference.agent)
        const status = await localInferenceWorkerStatus(activeSpace)
        const current = useStore.getState()
        if (!disposed) acceptLocalWorkerStatus(status, current.activeSpace, current.currentUser?.id)
      }).catch(() => {})
    }
    configure()
    window.addEventListener(LOCAL_INFERENCE_PREFERENCE_EVENT, configure)
    return () => { disposed = true; window.removeEventListener(LOCAL_INFERENCE_PREFERENCE_EVENT, configure) }
  }, [activeSpace?.spaceId, activeSpace?.generation, spacePending, capabilities.profile, authStatus, currentUser?.id])
  useEffect(() => {
    const connect = (event: Event): void => {
      if (inviteSwitch.current !== 'idle') return
      setSelfhostAuth(current => current ?? (event as CustomEvent<{ target: string; report: Awaited<ReturnType<typeof testSpaceConnection>> | null }>).detail)
    }
    window.addEventListener('skillhub-connect-server', connect)
    return () => window.removeEventListener('skillhub-connect-server', connect)
  }, [])
  // Guests need the same instance image policy as signed-in views.
  useEffect(() => {
    setMediaContext(null)
    let cancelled = false
    const refresh = (): void => {
      if (spacePending || !activeSpace) return
      if (view === 'marketplace') { void prepareCatalogMedia().catch(() => {}); return }
      if (spaceProfile(activeSpace) === 'local') return
      void apiHealth().then(info => {
        if (!cancelled && sameSpace(activeSpace, useStore.getState().activeSpace)) useStore.setState({ serverInfo: info })
      }).catch(() => {})
    }
    refresh()
    window.addEventListener('focus', refresh)
    window.addEventListener('online', refresh)
    return () => {
      cancelled = true
      setMediaContext(null)
      window.removeEventListener('focus', refresh)
      window.removeEventListener('online', refresh)
    }
  }, [authSpace, activeSpace, spacePending, view])
  // Theme (#258): a forced light/dark goes on <html data-theme>; `system` removes it so the
  // prefers-color-scheme rules in design-tokens.css follow the OS live. useTheme also
  // subscribes to matchMedia so `resolved` stays current for code that needs it.
  const theme = useTheme()
  useLayoutEffect(() => {
    applyThemePreference(document.documentElement, theme.preference)
  }, [theme.preference])
  const localSkillWorkspace = view === 'skills' && skillTab === 'local'
  const skillWorkspaceAvailable = view === 'team-skills' || (view === 'skills' && (skillTab === 'skillhub' || skillTab === 'tags'))
  const workspaceSkillSheet = sheet?.kind === 'skill' && skillWorkspaceAvailable ? sheet : null
  const overlaySkillSheet = sheet?.kind === 'skill' && view !== 'skills' && view !== 'team-skills' ? sheet : null
  const overlaySheetOpen = Boolean(overlaySkillSheet || sheet?.kind === 'team')

  useEffect(() => {
    if (!currentUser) return
    const expectedUserId = currentUser.id
    let cancelled = false
    const subscriptions: Array<() => void> = []
    const subscribe = async (): Promise<void> => {
      const unlist = await listen<LibraryEntryList>('skillhub-library-list', ({ payload }) => {
        if (!sameSpace(payload.space, useStore.getState().authSpace)) return
        if (cancelled || payload.userId !== expectedUserId || useStore.getState().currentUser?.id !== expectedUserId) return
        const state = useStore.getState()
        state.setLibraryEntries(payload)
        if (useStore.getState().libraryEntries === state.libraryEntries) return
        const cloud = cloudLibrarySkills(state.skills, payload, expectedUserId, state.libraryTransfers)
        state.setSkills([...state.skills.filter(skill => skill.localPath), ...cloud.filter(skill => !skill.localPath)])
      })
      if (cancelled) unlist(); else subscriptions.push(unlist)
      const untransfer = await listen<LibraryTransfer>('skillhub-library-transfer', ({ payload }) => {
        if (!sameSpace(payload.space, useStore.getState().authSpace)) return
        if (cancelled || payload.userId !== expectedUserId || useStore.getState().currentUser?.id !== expectedUserId) return
        const state = useStore.getState()
        state.setLibraryTransfer(payload)
        state.setSkills(state.skills.map(skill => skill.cloudDownload && skill.libraryEntryId === payload.entryId
          ? { ...skill, cloudDownload: payload } : skill))
        if (payload.phase === 'ready') window.dispatchEvent(new Event('skillhub-local-changed'))
      })
      if (cancelled) untransfer(); else subscriptions.push(untransfer)
    }
    void subscribe().catch(() => undefined)
    return () => { cancelled = true; subscriptions.forEach(unlisten => unlisten()) }
  }, [currentUser?.id])
  const restored = useRef(false)
  const restoreInFlight = useRef(false)
  const restoreRequested = useRef(false)
  const [restoreRetry] = useState(() => retryNativeAuthRestore())
  const [restoreError, setRestoreError] = useState<string | null>(null)
  const initializedUserId = useRef<string | null>(null)
  const [pendingInvite, setPendingInvite] = useState<(ApiTeamInvite & { server: string; space: SpaceHandle }) | null>(null)
  const [pendingInviteBusy, setPendingInviteBusy] = useState(false)
  const [otherServerInvite, setOtherServerInvite] = useState<ParsedTeamInvite | null>(null)
  const [inviteConnecting, setInviteConnecting] = useState(false)
  const inviteSwitch = useRef<'idle' | 'connecting' | 'committed'>('idle')
  const acceptingInvites = useRef(new Set<string>())
  const [feedbackOpen, setFeedbackOpen] = useState(false)
  const inspectingInviteTokens = useRef(new Set<string>())
  const seenInviteTokens = useRef(new Set<string>())
  const lastClipboardText = useRef<string | null>(null)
  const marketplacePresenceSignature = skills
    .filter((skill) => Boolean(skill.localPath && skill.serverId))
    .flatMap((skill) => skill.serverId ? [skill.serverId] : [])
    .sort()
    .join('|')
  // A style switch can change settled local images without changing library inventory.
  // Keep its read-only polling alive when the settings panel closes; never ensure here.
  useEffect(() => {
    const space = readAuthSpace()
    if (authStatus !== 'authenticated' || !currentUser || !space) return
    let controller: AbortController | null = null
    let timer: number | undefined
    let failures = 0
    const current = (request: AbortController): boolean => !request.signal.aborted
      && useStore.getState().currentUser?.id === currentUser.id && sameSpace(useStore.getState().activeSpace, space)
    const refresh = async (request: AbortController): Promise<void> => {
      try {
        const pending = await refreshSkillAvatarSelections(currentUser.id, space, request.signal)
        if (!current(request)) return
        failures = 0
        if (pending && !request.signal.aborted) timer = window.setTimeout(() => void refresh(request), 15_000)
      } catch {
        if (current(request)) {
          failures += 1
          if (failures === 1) toast('头像状态暂未刷新，将自动重试', 'warn')
          timer = window.setTimeout(() => void refresh(request), Math.min(60_000, 15_000 * failures))
        }
      }
    }
    const changed = (): void => {
      controller?.abort(); window.clearTimeout(timer)
      failures = 0; controller = new AbortController(); void refresh(controller)
    }
    window.addEventListener(AVATAR_SELECTIONS_CHANGED_EVENT, changed)
    return () => { controller?.abort(); window.clearTimeout(timer); window.removeEventListener(AVATAR_SELECTIONS_CHANGED_EVENT, changed) }
  }, [authStatus, currentUser?.id, authSpace])

  const avatarInventory = skills.map(skill => skill.id + ':' + (skill.serverId ?? '')).sort().join('|')
  // Account library sync: runs only for a ready, signed-in Runtime Session on
  // a Server that offers it. Folder changes reach the Skills page through its
  // library watch; this effect only schedules passes. Nothing asks the user to
  // confirm a first sync: Skills that cannot be proven to be this account's
  // simply stay on this device (listed in the account panel).
  useEffect(() => {
    const space = readAuthSpace()
    if (!capabilities.library || authStatus !== 'authenticated' || !currentUser || !space) {
      setLibrarySyncEnabled(false)
      return
    }
    const expectedUserId = currentUser.id
    let cancelled = false
    let scheduler: LibrarySyncScheduler | null = null
    let slowTimer: number | undefined
    const { dispatchLibrarySync } = useStore.getState()
    const current = (): boolean => !cancelled && useStore.getState().currentUser?.id === expectedUserId && readAuthSpace() === space
    void apiHealth().then((health) => {
      if (cancelled) return
      const enabled = health.capabilities?.includes(LIBRARY_SYNC_CAPABILITY) ?? false
      setLibrarySyncEnabled(enabled)
      if (!enabled) return
      dispatchLibrarySync({ type: 'enabled' })
      scheduler = startLibrarySync({
        run: () => librarySyncRun(false),
        isVisible: () => document.visibilityState === 'visible',
        onStart: () => {
          if (!current()) return
          dispatchLibrarySync({ type: 'start' })
          window.clearTimeout(slowTimer)
          slowTimer = window.setTimeout(() => { if (current()) dispatchLibrarySync({ type: 'slow' }) }, LIBRARY_SYNC_SLOW_MS)
        },
        onResult: async ({ report, error, followUp }) => {
          window.clearTimeout(slowTimer)
          // Local reads only: blocked items, copies and kept-local Skills, plus
          // the fingerprint that SkillHub's own writes leave behind.
          const [status, baseline] = await Promise.all([
            librarySyncStatus().catch(() => null),
            skillLibraryFingerprint().catch(() => null),
          ])
          if (!current()) return
          const ownStatus = status?.userId === expectedUserId ? status : null
          dispatchLibrarySync({ type: 'result', report, error, followUp, offline: !navigator.onLine, status: ownStatus, baseline })
          const state = useStore.getState()
          state.setSkills(state.skills.map(skill => {
            if (!skill.cloudDownload) return skill
            const problem = report?.problems.find(item => item.entryId === skill.libraryEntryId)
            const message = error ?? problem?.message
            return message ? { ...skill, cloudDownload: { ...skill.cloudDownload, phase: 'error', error: message } } : skill
          }))
          if (report && report.copiesCreated > 0) {
            toast(`两台设备改了同一个 Skill，已把 ${report.copiesCreated} 份修改保存为名称带“副本”的 Skill，原有内容不会丢失`, 'warn')
          }
          if (report && report.trashed > 0) {
            toast(`${report.trashed} 个 Skill 已在账号中删除，已移入这台电脑的回收站`)
          }
        },
      })
    }).catch(() => { if (!cancelled) setLibrarySyncEnabled(false) })
    const trigger = (): void => { scheduler?.trigger() }
    window.addEventListener('focus', trigger)
    window.addEventListener('online', trigger)
    window.addEventListener(LIBRARY_SYNC_REQUEST_EVENT, trigger)
    return () => {
      cancelled = true
      scheduler?.stop()
      window.clearTimeout(slowTimer)
      dispatchLibrarySync({ type: 'disabled' })
      window.removeEventListener('focus', trigger)
      window.removeEventListener('online', trigger)
      window.removeEventListener(LIBRARY_SYNC_REQUEST_EVENT, trigger)
    }
  }, [authStatus, currentUser?.id, authSpace, capabilities.library, setLibrarySyncEnabled])

  useEffect(() => {
    const space = readAuthSpace()
    if (!capabilities.avatars || authStatus !== 'authenticated' || !currentUser || !space) return
    const controller = new AbortController()
    let running = false
    let lastStartedAt = 0
    let timer: number | undefined
    // One timer at the time the last pass asked for: 15 s only while a Server
    // task is running, the back-off end after failures, otherwise none.
    const sync = (): void => {
      if (running || controller.signal.aborted) return
      running = true
      lastStartedAt = Date.now()
      window.clearTimeout(timer)
      timer = undefined
      void syncSkillAvatars(currentUser.id, space, controller.signal)
        .then(({ wakeAt }) => {
          if (wakeAt !== null && !controller.signal.aborted) timer = window.setTimeout(sync, Math.max(1_000, wakeAt - Date.now()))
        })
        .catch(() => undefined)
        .finally(() => { running = false })
    }
    // Focus and network events arrive in bursts; one pass covers them.
    const wake = (): void => { if (Date.now() - lastStartedAt >= 5_000) sync() }
    sync()
    window.addEventListener('online', wake)
    window.addEventListener('focus', wake)
    return () => {
      controller.abort()
      window.clearTimeout(timer)
      window.removeEventListener('online', wake)
      window.removeEventListener('focus', wake)
    }
  }, [authStatus, currentUser?.id, authSpace, capabilities.avatars, avatarInventory])

  useEffect(() => {
    const timer = window.setTimeout(() => void checkForAppUpdate({ silent: true }), 2_500)
    return () => window.clearTimeout(timer)
  }, [])

  useEffect(() => {
    const suppressWebViewMenu = (event: MouseEvent): void => {
      const target = event.target as HTMLElement | null
      if (target?.closest('input, textarea, [contenteditable="true"]')) return
      event.preventDefault()
    }
    document.addEventListener('contextmenu', suppressWebViewMenu)
    return () => document.removeEventListener('contextmenu', suppressWebViewMenu)
  }, [])

  useEffect(() => {
    let active = true
    const refresh = (): void => {
      if (active) void refreshAgentCapabilities()
    }
    refresh()
    window.addEventListener('focus', refresh)
    return () => {
      active = false
      window.removeEventListener('focus', refresh)
    }
  }, [])

  const commitAuthenticatedSession = useCallback(async (session: ApiAuthSession): Promise<void> => {
    const state = await authState()
    if (state.userId !== session.user.id || state.pending || !sameSpace(state, session.space)) {
      throw new Error('账号状态已被新的操作取代')
    }
    deleteLegacyAuth()
    setAuthSession(session.user, session.space)
  }, [setAuthSession])

  useEffect(() => onApiUnauthorized(async (requestSpace, clearedSpace) => {
    if (!sameSpace(await currentSpace(), clearedSpace)) return
    const current = readAuthSpace()
    if (current && !sameSpace(current, requestSpace)) return
    clearAuthSession()
    promptForAuth({ reason: '登录状态已失效，请重新登录' })
  }), [clearAuthSession, promptForAuth])

  const restorePersistedSession = useCallback(async (automatic = false, allowRenew = true): Promise<void> => {
    if (!automatic) restoreRetry.cancel()
    if (restoreInFlight.current) { restoreRequested.current = true; return }
    const isCurrent = restoreRetry.checkpoint()
    restoreInFlight.current = true
    setRestoreError(null)
    let retrySpace: SpaceHandle | null = null
    let retryUserId: string | null = null
    try {
      const native = await authState()
      if (!isCurrent() || native.pending) return
      if (native.userId) retrySpace = { spaceId: native.spaceId, generation: native.generation }
      retryUserId = native.userId
      useStore.setState({ activeSpace: { spaceId: native.spaceId, generation: native.generation }, spacePending: false })
      const session = await restoreNativeAuth({ allowRenew })
      if (!sameSpace(await currentSpace(), session?.space ?? native) || !isCurrent()) return
      restoreRetry.cancel()
      if (session) setAuthSession(session.user, session.space)
      else setAuthGuest()
      if (sessionStorage.getItem(SPACE_SWITCH_VIEW_KEY) === 'settings') {
        sessionStorage.removeItem(SPACE_SWITCH_VIEW_KEY)
        setView('settings')
      }
    } catch (error: unknown) {
      if (!isCurrent()) return
      if (retrySpace && retryUserId && isRetryableRestoreError(error)) {
        restoreRetry.schedule(retrySpace, retryUserId, () => restorePersistedSession(true))
      }
      if (error instanceof ApiError && error.code === 'LOCAL_SESSION_UNREADABLE') {
        clearAuthSession()
        promptForAuth({ reason: error.message })
        return
      }
      if (useStore.getState().authStatus !== 'restoring') return
      const message = error instanceof Error ? error.message : String(error)
      setRestoreError(`暂时无法连接一探 SkillHub：${message === 'Request timed out' ? '连接服务超时' : message}`)
    } finally {
      restoreInFlight.current = false
      // Renewal can itself emit space-changed; the queued restore only revalidates.
      if (restoreRequested.current) { restoreRequested.current = false; void restorePersistedSession(false, false) }
    }
  }, [setAuthSession, setAuthGuest, clearAuthSession, promptForAuth, setView, restoreRetry])

  useEffect(() => {
    let disposed = false
    let unlisten: (() => void) | undefined
    const changed = (payload: { space: SpaceHandle; pending: boolean }): void => {
      void currentSpace().then(current => {
        if (disposed || !sameSpace(current, payload.space)) return
        const state = useStore.getState()
        if (sameSpace(state.activeSpace, payload.space) && state.spacePending === payload.pending) return
        restoreRetry.cancel()
        setMediaContext(null)
        resetSkillAvatarCache()
        setPendingInvite(null)
        setPendingInviteBusy(false)
        inspectingInviteTokens.current.clear()
        seenInviteTokens.current.clear()
        lastClipboardText.current = null
        initializedUserId.current = null
        setFeedbackOpen(false)
        state.resetSpace(payload.space, payload.pending)
        if (!payload.pending) void restorePersistedSession()
      }).catch(() => { useStore.getState().clearAuthSession() })
    }
    const refresh = (): void => { void authState().then(state => changed({ space: { spaceId: state.spaceId, generation: state.generation }, pending: state.pending })).catch(() => {}) }
    window.addEventListener('skillhub-space-refresh', refresh)
    void listen<{ space: SpaceHandle; pending: boolean }>('space-changed', ({ payload }) => changed(payload)).then(stop => { if (disposed) stop(); else unlisten = stop })
    return () => { disposed = true; unlisten?.(); window.removeEventListener('skillhub-space-refresh', refresh) }
  }, [restorePersistedSession, restoreRetry])

  useEffect(() => {
    if (!authPrompt || capabilities.profile !== 'selfhost' || selfhostAuth || inviteSwitch.current !== 'idle') return
    let cancelled = false
    void currentMediaSpace().then(async context => {
      const report = await testSpaceConnection(context.serverBase)
      if (!cancelled) { setSelfhostAuth({ target: context.serverBase, report, teamInvite: Boolean(sessionStorage.getItem(PENDING_INVITE_KEY)) }); dismissAuthPrompt() }
    }).catch(() => { if (!cancelled) { toast('无法读取服务器连接，请到设置页重新测试', 'error'); dismissAuthPrompt() } })
    return () => { cancelled = true }
  }, [authPrompt, capabilities.profile, selfhostAuth, dismissAuthPrompt])

  // Skill organizer (#323): one local file per account (or guest); reset on switch in the store.
  const loadOrganizer = useStore((state) => state.loadOrganizer)
  const organizerAccount = useStore((state) => state.organizerAccount)
  const isLoadingSkills = useStore((state) => state.isLoadingSkills)
  const libraryEntriesUserId = useStore((state) => state.libraryEntries?.userId ?? null)
  useEffect(() => {
    if (spacePending || authStatus === 'restoring') return
    void loadOrganizer()
  }, [authStatus, currentUser?.id, activeSpace, spacePending, loadOrganizer])
  useEffect(() => {
    if (!organizerAccount) return
    // Prune quick access only against a complete list: local Skills loaded and,
    // when signed in, the account library merged for this same account.
    const complete = !isLoadingSkills && skills.length > 0
      && (authStatus === 'guest' || (Boolean(currentUser) && libraryEntriesUserId === currentUser?.id))
    useStore.getState().reconcileOrganizer(skills, { prune: complete })
  }, [authStatus, currentUser?.id, isLoadingSkills, libraryEntriesUserId, organizerAccount, skills])
  useEffect(() => {
    const flush = (): void => { void flushOrganizerSave() }
    const flushWhenHidden = (): void => { if (document.visibilityState === 'hidden') flush() }
    document.addEventListener('visibilitychange', flushWhenHidden)
    window.addEventListener('beforeunload', flush)
    return () => { document.removeEventListener('visibilitychange', flushWhenHidden); window.removeEventListener('beforeunload', flush) }
  }, [])

  // Organizer Server sync (#326): on enable/account load, after local edits (debounced),
  // on focus/online and every few minutes. The store keeps it single-flight per account.
  // Capability probe with its own retry: a failed /health (offline, Server down) stays
  // `unknown` and is retried with backoff and on focus/online; only a successful answer
  // without the capability means `unsupported` (tags then stay on this device).
  useEffect(() => {
    const { setOrganizerSyncCapability } = useStore.getState()
    if (!capabilities.account || authStatus !== 'authenticated' || !currentUser) { setOrganizerSyncCapability('unknown'); return }
    const prober = startCapabilityProbe({
      health: apiHealth,
      report: (capability, probeFailed) => useStore.getState().setOrganizerSyncCapability(capability, probeFailed),
      setTimer: (run, delay) => window.setTimeout(run, delay),
      clearTimer: (timer) => window.clearTimeout(timer as number),
    })
    window.addEventListener('focus', prober.wake)
    window.addEventListener('online', prober.wake)
    return () => {
      prober.stop()
      window.removeEventListener('focus', prober.wake)
      window.removeEventListener('online', prober.wake)
    }
  }, [authStatus, currentUser?.id, authSpace, capabilities.account])
  const organizerSyncEnabled = useStore((state) => state.organizerSync.capability === 'supported')
  useEffect(() => {
    if (!organizerSyncEnabled || !organizerAccount || organizerAccount !== currentUser?.id) return
    let lastPass: Promise<unknown> | null = null
    let debounce: number | undefined
    let retry: number | undefined
    let failures = 0
    let conflictToastShown = false
    const later = (delay: number): void => { window.clearTimeout(debounce); debounce = window.setTimeout(run, delay) }
    function run(): void {
      const pass = useStore.getState().runOrganizerSync()
      // Joining a pass in flight must not repeat its toasts or schedules.
      if (pass === lastPass) return
      lastPass = pass
      window.clearTimeout(retry)
      void pass.then((outcome) => {
        if (!outcome || (!outcome.ok && outcome.aborted)) return
        const pending = outcome.ok && outcome.quickAccessConflict === 'pending'
        if (!outcome.ok || pending) {
          // Back off instead of waiting for focus or the 5-minute tick.
          retry = window.setTimeout(run, ORGANIZER_SYNC_RETRY_MS[Math.min(failures, ORGANIZER_SYNC_RETRY_MS.length - 1)])
          failures += 1
        } else {
          failures = 0
          // Edits made during the pass go up right after it.
          if (organizerPendingCount(useStore.getState().organizer) > 0) later(ORGANIZER_SYNC_DEBOUNCE_MS)
        }
        if (!outcome.ok) return
        if (outcome.quickAccessConflict === 'merged') { toast('快捷访问已在其他设备更新，已合并', 'warn'); conflictToastShown = false }
        if (pending && !conflictToastShown) { toast('快捷访问正在其他设备同时修改，本机修改已保留，稍后自动重试', 'warn'); conflictToastShown = true }
        if (outcome.quickAccessConflict === null) conflictToastShown = false
        if (outcome.rejected.length > 0) toast(`部分目录未能同步：${outcome.rejected[0]}`, 'warn')
      })
    }
    run()
    const interval = window.setInterval(run, ORGANIZER_SYNC_INTERVAL_MS)
    const unsubscribe = useStore.subscribe((state, previous) => {
      if (state.organizer === previous.organizer || state.organizerSync.running) return
      if (organizerPendingCount(state.organizer) === 0) return
      later(ORGANIZER_SYNC_DEBOUNCE_MS)
    })
    window.addEventListener('focus', run)
    window.addEventListener('online', run)
    return () => {
      window.clearInterval(interval)
      window.clearTimeout(debounce)
      window.clearTimeout(retry)
      unsubscribe()
      window.removeEventListener('focus', run)
      window.removeEventListener('online', run)
    }
  }, [currentUser?.id, organizerAccount, organizerSyncEnabled])

  // Restore a persisted JWT before rendering protected application data.
  // Transient network failures keep the token and retry within the same space;
  // only an authenticated 401 destroys the persisted session.
  useEffect(() => {
    if (restored.current) return
    restored.current = true
    void restorePersistedSession()
  }, [restorePersistedSession])

  useEffect(() => {
    const unsubscribe = useStore.subscribe((state, previous) => {
      if (state.authStatus !== previous.authStatus || state.currentUser?.id !== previous.currentUser?.id
        || (state.authSpace !== previous.authSpace && !sameSpace(state.authSpace, previous.authSpace))) restoreRetry.cancel()
    })
    return () => { unsubscribe(); restored.current = false; restoreRequested.current = false; restoreRetry.cancel() }
  }, [restoreRetry])

  // Initialize: load teams + notifications from server on startup
  useEffect(() => {
    if (!capabilities.teams || authStatus !== 'authenticated' || !currentUser) {
      initializedUserId.current = null
      return
    }
    const identity = JSON.stringify([authSpace, currentUser.id])
    if (initializedUserId.current === identity) return
    initializedUserId.current = identity

    const expectedUserId = currentUser.id
    void Promise.allSettled([apiGetTeams(), apiGetNotifications()]).then(([teamsResult, notificationsResult]) => {
      if (!sameSpace(authSpace, useStore.getState().authSpace) || useStore.getState().currentUser?.id !== expectedUserId) return

      const teams = settledValue(teamsResult)
      const notifications = settledValue(notificationsResult)
      if (teams) setTeams(teams)
      if (notifications) setNotifications(notifications)

      const teamsError = settledError(teamsResult)
      const notificationsError = settledError(notificationsResult)
      if (teamsError) toast(`团队数据暂不可用：${teamsError}`, 'error')
      if (notificationsError) toast(`通知数据暂不可用：${notificationsError}`, 'error')
    })
  }, [authStatus, currentUser?.id, authSpace, capabilities.teams, setTeams, setNotifications])

  useEffect(() => {
    if (!capabilities.teams || authStatus !== 'authenticated' || !currentUser) return
    const expectedUserId = currentUser.id
    const refresh = (): void => {
      void apiGetNotifications().then((items) => {
        if (sameSpace(authSpace, useStore.getState().authSpace) && useStore.getState().currentUser?.id === expectedUserId) setNotifications(items)
      }).catch(() => { /* Keep the last readable notices during transient network errors. */ })
    }
    const timer = window.setInterval(refresh, 30_000)
    window.addEventListener('focus', refresh)
    return () => { window.clearInterval(timer); window.removeEventListener('focus', refresh) }
  }, [authStatus, currentUser?.id, authSpace, capabilities.teams, setNotifications])

  useEffect(() => {
    if (capabilities.profile !== 'official' || !capabilities.marketplace || authStatus !== 'authenticated' || !currentUser) return
    const expectedUserId = currentUser.id
    let active = true
    const sync = (): void => {
      void syncMarketplaceManagedPresence().then(() => {
        if (active && useStore.getState().currentUser?.id === expectedUserId) {
          window.dispatchEvent(new Event('skillhub:refresh-marketplace'))
        }
      }).catch(() => {
        // Usage reconciliation is background-only and must never block local Skill management.
      })
    }
    sync()
    window.addEventListener('focus', sync)
    return () => {
      active = false
      window.removeEventListener('focus', sync)
    }
  }, [authStatus, currentUser?.id, authSpace, capabilities.profile, capabilities.marketplace, marketplacePresenceSignature])

  const acceptInviteToken = useCallback(async (token: string, inviteSpace?: SpaceHandle, server?: string): Promise<boolean> => {
    if (!capabilities.teams) return false
    const state = useStore.getState()
    if (state.spacePending || (inviteSpace && !sameSpace(inviteSpace, state.activeSpace))) return false
    if (state.authStatus !== 'authenticated' || !state.currentUser) {
      try {
        const context = await currentMediaSpace()
        if (!sameSpace(state.activeSpace, context.space) || !sameSpace(context.space, useStore.getState().activeSpace)) return false
        sessionStorage.setItem(PENDING_INVITE_KEY, teamInviteDeepLink(token, server ?? context.serverBase.replace(/\/+$/, '')))
        setPendingInvite(null)
        promptForAuth({ reason: '登录后即可接受团队邀请' })
      } catch { toast('无法保存待接受的邀请，请重新打开邀请链接', 'error') }
      return false
    }
    const expectedUserId = state.currentUser.id
    const expectedSpace = state.activeSpace
    if (!expectedSpace) return false
    const savedInvite = sessionStorage.getItem(PENDING_INVITE_KEY)
    const key = JSON.stringify([expectedSpace, token])
    if (acceptingInvites.current.has(key)) return false
    acceptingInvites.current.add(key)
    setPendingInviteBusy(true)
    try {
      const result = await apiAcceptTeamInvite(token, expectedSpace)
      // Remove the credential before refreshing ancillary UI or crossing another reload.
      if (savedInvite && (await parseTeamInvite(savedInvite))?.token === token
        && sessionStorage.getItem(PENDING_INVITE_KEY) === savedInvite) sessionStorage.removeItem(PENDING_INVITE_KEY)
      const [teamsResult, notificationsResult] = await Promise.allSettled([
        apiGetTeams(expectedSpace), apiGetNotifications(expectedSpace),
      ])
      if (!sameSpace(expectedSpace, useStore.getState().activeSpace) || useStore.getState().currentUser?.id !== expectedUserId) return true
      if (teamsResult.status === 'fulfilled') setTeams(teamsResult.value)
      if (notificationsResult.status === 'fulfilled') setNotifications(notificationsResult.value)
      setActiveTeam(result.team.id)
      setPendingInvite(null)
      toast(result.alreadyMember ? `你已经在「${result.team.name}」中` : `已加入「${result.team.name}」`)
      return true
    } catch (error: unknown) {
      if (error instanceof ApiError && (error.status === 404 || error.status === 410)
        && savedInvite && sessionStorage.getItem(PENDING_INVITE_KEY) === savedInvite) sessionStorage.removeItem(PENDING_INVITE_KEY)
      if (sameSpace(expectedSpace, useStore.getState().activeSpace)) toast(`无法加入团队：${error instanceof Error ? error.message : String(error)}`, 'error')
      return false
    } finally {
      if (sameSpace(expectedSpace, useStore.getState().activeSpace)) setPendingInviteBusy(false)
      acceptingInvites.current.delete(key)
    }
  }, [capabilities.teams, promptForAuth, setActiveTeam, setNotifications, setTeams])

  const matchesInviteSpace = useCallback(async (invite: ParsedTeamInvite): Promise<boolean> => {
    const space = useStore.getState().activeSpace
    const profile = spaceProfile(space)
    if (!space || useStore.getState().spacePending) return false
    if (profile !== 'selfhost') return isSameInviteServer(invite.server, profile)
    const context = await currentMediaSpace()
    return sameSpace(space, context.space) && sameSpace(space, useStore.getState().activeSpace)
      && isSameInviteServer(invite.server, profile, context.serverBase, context.previousOrigins)
  }, [])

  useEffect(() => {
    if (authStatus !== 'authenticated' || !currentUser || spacePending || !capabilities.teams || selfhostAuth) return
    if (!activeSpace) return
    const expectedSpace = activeSpace
    void resumePendingTeamInvite(sessionStorage, async invite => sameSpace(expectedSpace, useStore.getState().activeSpace)
      && await matchesInviteSpace(invite), token => acceptInviteToken(token, expectedSpace))
      .catch(() => toast('无法恢复团队邀请，请重新打开邀请链接', 'error'))
  }, [authStatus, currentUser, spacePending, capabilities.teams, activeSpace, selfhostAuth, matchesInviteSpace, acceptInviteToken])

  const continueOtherServerInvite = async (): Promise<void> => {
    if (!otherServerInvite || selfhostAuth || inviteConnecting || inviteSwitch.current === 'connecting') return
    const source = useStore.getState().activeSpace
    const invite = otherServerInvite
    setInviteConnecting(true)
    inviteSwitch.current = 'connecting'
    try {
      const target = inviteSwitchTarget(invite.server)
      const report = target === 'official' ? null : await testSpaceConnection(target)
      if (!sameSpace(source, useStore.getState().activeSpace) || useStore.getState().spacePending) {
        inviteSwitch.current = 'idle'
        return
      }
      sessionStorage.setItem(PENDING_INVITE_KEY, teamInviteDeepLink(invite.token, invite.server))
      setOtherServerInvite(null)
      setSelfhostAuth({ target, report, teamInvite: true })
    } catch {
      inviteSwitch.current = 'idle'
      toast('无法测试邀请服务器，请稍后重试', 'error')
    } finally { setInviteConnecting(false) }
  }

  const considerTeamInvite = useCallback(async (raw: string, explicit: boolean): Promise<void> => {
    if (selfhostAuth || inviteSwitch.current !== 'idle') return
    if (!explicit && sessionStorage.getItem(PENDING_INVITE_KEY)) return
    const expectedSpace = useStore.getState().activeSpace
    if (!expectedSpace) return
    const parsed = await parseTeamInvite(raw)
    if (!parsed) {
      if (explicit) toast('这个团队邀请无效或格式不正确', 'error')
      return
    }
    if (!sameSpace(expectedSpace, useStore.getState().activeSpace) || useStore.getState().spacePending) return
    if (explicit) sessionStorage.removeItem(PENDING_INVITE_KEY)
    const inviteKey = JSON.stringify([parsed.server, parsed.token])
    if ((!explicit && seenInviteTokens.current.has(inviteKey)) || inspectingInviteTokens.current.has(inviteKey)) return
    inspectingInviteTokens.current.add(inviteKey)
    try {
      if (!await matchesInviteSpace(parsed)) {
        if (!sameSpace(expectedSpace, useStore.getState().activeSpace)) return
        seenInviteTokens.current.add(inviteKey)
        setOtherServerInvite(parsed)
        return
      }
      if (!capabilities.teams) return
      const info = await apiGetTeamInvite(parsed.token, expectedSpace)
      if (!sameSpace(expectedSpace, useStore.getState().activeSpace)) return
      const state = useStore.getState()
      if (state.authStatus === 'authenticated' && state.currentUser) {
        const expectedUserId = state.currentUser.id
        const freshTeams = await apiGetTeams(expectedSpace)
        if (!sameSpace(expectedSpace, useStore.getState().activeSpace) || useStore.getState().currentUser?.id !== expectedUserId) return
        setTeams(freshTeams)
        if (freshTeams.some((team) => team.id === info.team.id)) {
          seenInviteTokens.current.add(inviteKey)
          return
        }
      }
      seenInviteTokens.current.add(inviteKey)
      setPendingInvite({ token: parsed.token, ...info, server: parsed.server, space: expectedSpace })
    } catch (error: unknown) {
      if (explicit && sameSpace(expectedSpace, useStore.getState().activeSpace)) toast(`无法打开团队邀请：${error instanceof Error ? error.message : String(error)}`, 'error')
    } finally {
      inspectingInviteTokens.current.delete(inviteKey)
    }
  }, [capabilities.teams, selfhostAuth, matchesInviteSpace, setTeams])

  const [pendingTeamSkillLink, setPendingTeamSkillLink] = useState<TeamSkillLink | null>(null)
  const teamSkillLinkRef = useRef<TeamSkillLink | null>(null)
  const teamSkillLoginRequested = useRef<TeamSkillLink | null>(null)
  const [teamSkillBaseUrls] = useState(createTeamSkillBaseUrlsCache)
  useEffect(() => { teamSkillBaseUrls.clear() }, [teamSkillBaseUrls, activeSpace?.spaceId, activeSpace?.generation, currentUser?.id, spacePending])
  const updatePendingTeamSkillLink = useCallback((link: TeamSkillLink | null): void => {
    teamSkillLinkRef.current = link
    setPendingTeamSkillLink(link)
  }, [])
  const cancelTeamSkillLogin = (): void => {
    updatePendingTeamSkillLink(null)
    teamSkillLoginRequested.current = null
    dismissAuthPrompt()
  }
  useEffect(() => {
    if (!pendingTeamSkillLink || !activeSpace || !serverInfo || spacePending || authStatus === 'restoring') return
    let cancelled = false
    const expectedSpace = activeSpace
    const expectedUser = currentUser?.id
    const stillCurrent = (): boolean => !cancelled && teamSkillLinkRef.current === pendingTeamSkillLink
      && sameSpace(expectedSpace, useStore.getState().activeSpace)
      && useStore.getState().currentUser?.id === expectedUser
    void (async (): Promise<void> => {
      try {
        if (!currentUser) {
          if (teamSkillLoginRequested.current !== pendingTeamSkillLink) {
            teamSkillLoginRequested.current = pendingTeamSkillLink
            promptForAuth({ reason: '登录后打开团队共享 Skill' })
          }
          return
        }
        const context = await currentMediaSpace()
        if (!stillCurrent()) return
        const baseUrls = await teamSkillBaseUrls.get(expectedSpace, currentUser.id,
          Boolean(serverInfo.capabilities?.includes('teams.skill-links.v1')))
        if (!stillCurrent()) return
        const matchesServer = sameSpace(expectedSpace, context.space)
          && await isTeamSkillServer(pendingTeamSkillLink.server, context.serverBase, baseUrls)
        if (!stillCurrent()) return
        if (!matchesServer) {
          toast(`这个链接来自另一个 SkillHub 服务器（${new URL(pendingTeamSkillLink.server).host}）`, 'error')
          updatePendingTeamSkillLink(null)
          return
        }
        if (serverInfo?.capabilities?.includes('teams.skill-links.v1')) {
          await apiGetTeamSkillLink(pendingTeamSkillLink.teamId, pendingTeamSkillLink.skillId, expectedSpace)
        } else {
          const candidates = await apiGetTeamSkills(pendingTeamSkillLink.teamId, expectedSpace)
          if (!candidates.some(skill => skill.id === pendingTeamSkillLink.skillId)) throw new Error(TEAM_SKILL_UNAVAILABLE)
        }
        if (!stillCurrent()) return
        useStore.getState().openTeamSkill(pendingTeamSkillLink.teamId, pendingTeamSkillLink.skillId)
        updatePendingTeamSkillLink(null)
      } catch {
        if (stillCurrent()) { toast(TEAM_SKILL_UNAVAILABLE, 'error'); updatePendingTeamSkillLink(null) }
      }
    })()
    return () => { cancelled = true }
  }, [pendingTeamSkillLink, activeSpace, spacePending, authStatus, currentUser, serverInfo, promptForAuth, updatePendingTeamSkillLink, teamSkillBaseUrls])

  const considerDeepLink = useCallback(async (raw: string): Promise<void> => {
    const teamSkillLink = await parseTeamSkillLink(raw)
    if (teamSkillLink) { updatePendingTeamSkillLink(teamSkillLink); return }
    const marketplaceIntent = parseMarketplaceDeepLink(raw)
    if (marketplaceIntent) {
      setPendingMarketplaceIntent(marketplaceIntent)
      setView('marketplace')
      return
    }
    await considerTeamInvite(raw, true)
  }, [considerTeamInvite, setPendingMarketplaceIntent, setView, updatePendingTeamSkillLink])

  useEffect(() => {
    if (!activeSpace || spacePending || (capabilities.profile !== 'local' && !serverInfo)) return
    let active = true
    let unlisten: (() => void) | null = null
    void listen<string[]>('skillhub-deep-link', (event) => {
      if (!active) return
      for (const link of event.payload) void considerDeepLink(link)
    }).then((dispose) => {
      if (active) unlisten = dispose
      else dispose()
    }).catch(() => undefined)
    void takePendingDeepLinks()
      .then((links) => { if (active) for (const link of links) void considerDeepLink(link) })
      .catch(() => undefined)
    return () => {
      active = false
      unlisten?.()
    }
  }, [activeSpace, spacePending, serverInfo, capabilities.profile, considerDeepLink])

  useEffect(() => {
    if (!activeSpace || spacePending) return
    let active = true
    let reading = false
    const inspectClipboard = async (): Promise<void> => {
      if (!active || reading || document.visibilityState !== 'visible') return
      reading = true
      try {
        const value = await readClipboardText()
        if (!active || value === null || value === lastClipboardText.current) return
        lastClipboardText.current = value
        if (value) await considerTeamInvite(value, false)
      } catch {
        // Clipboard access is a local convenience. It must never block the app.
      } finally {
        reading = false
      }
    }
    const onVisible = (): void => { if (document.visibilityState === 'visible') void inspectClipboard() }
    window.addEventListener('focus', inspectClipboard)
    document.addEventListener('visibilitychange', onVisible)
    const timer = window.setInterval(() => void inspectClipboard(), 1800)
    void inspectClipboard()
    return () => {
      active = false
      window.clearInterval(timer)
      window.removeEventListener('focus', inspectClipboard)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [activeSpace, spacePending, considerTeamInvite])

  // Authentication is an optional capability. A protected intent is resumed
  // only after a real session exists; closing the dialog leaves the current
  // local workflow untouched.
  useEffect(() => {
    if (authStatus !== 'authenticated' || !currentUser || !authPrompt) return
    const intent = authPrompt.intent
    dismissAuthPrompt()
    if (!intent) return
    if (intent.kind === 'view') setView(intent.view)
    else if (intent.kind === 'account') setView('settings')
    else if (intent.kind === 'share-skill') openSkillSheet(intent.skillId, 'profile', 'share')
    else if (intent.kind === 'join-team') void acceptInviteToken(intent.token)
  }, [acceptInviteToken, authPrompt, authStatus, currentUser, dismissAuthPrompt, openSkillSheet, setView])

  useEffect(() => {
    if ((view === 'team-skills' || view === 'teams') && authStatus !== 'authenticated') {
      setView('skills')
    }
  }, [authStatus, setView, view])

  // Close sheet on Escape
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || !sheet || workspaceSkillSheet || e.defaultPrevented) return
      // A nested modal owns the current interaction. Closing the whole sheet
      // would hide in-flight installs, uploads, or credential operations.
      if (document.querySelector('[role="dialog"][aria-modal="true"]')) return
      closeSheet()
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [sheet, closeSheet, workspaceSkillSheet])

  return (
    <div className="app-shell">
      <Onboarding />
      <a className="skip-link" href="#main-content" onClick={(event) => { event.preventDefault(); document.getElementById('main-content')?.focus() }}>跳到主要内容</a>
      <Sidebar onFeedback={() => setFeedbackOpen(true)} onDonate={() => {
        void openUrl(DONATION_PAGE_URL).catch(() => toast('无法打开捐款页，请稍后重试', 'error'))
      }} />
      <div className={`app-workspace${skillWorkspaceAvailable || localSkillWorkspace ? ' skill-browser-open' : ''}`}>
        <main className="app-main" id="main-content" tabIndex={-1}>
          {spacePending ? <div className="loading-block space-switch-loading" role="status"><span className="spin-icon" aria-hidden="true" /><p>正在切换空间…</p></div> : <>
          {view === 'skills'      && <SkillsPage key={`skills:${spaceKey}`} />}
          {view === 'team-skills' && capabilities.teams && <TeamSharedPage key={`team-skills:${spaceKey}`} />}
          {view === 'teams'       && capabilities.teams && <TeamsPage key={`teams:${spaceKey}`} />}
          {view === 'marketplace' && <MarketplacePage key={`marketplace:${spaceKey}`} />}
          {view === 'keys'        && <KeyVaultPage key={`keys:${spaceKey}`} />}
          {view === 'settings'    && <SettingsPage key={`settings:${spaceKey}`} />}
          </>}
        </main>

        {workspaceSkillSheet && (
          skills.find(skill => skill.id === workspaceSkillSheet.skillId)?.cloudDownload
          ? <CloudSkillPreview skill={skills.find(skill => skill.id === workspaceSkillSheet.skillId)!} />
          :
          <SkillDetailSheet
            mode="workspace"
            skillId={workspaceSkillSheet.skillId}
            tab={workspaceSkillSheet.tab}
            focus={workspaceSkillSheet.focus}
          />
        )}
        {localSkillWorkspace && <LocalSkillPreviewPanel />}
        {skillWorkspaceAvailable && !workspaceSkillSheet && <section className="skill-detail-placeholder" aria-label="Skill 详情"><Icon name="skills" size={32} /><p>选择一个 Skill 查看详情</p></section>}
      </div>

      <div
        className={`scrim${overlaySheetOpen ? ' on' : ''}`}
        onClick={closeSheet}
        aria-hidden="true"
      />

      {overlaySkillSheet && (
        <SkillDetailSheet skillId={overlaySkillSheet.skillId} tab={overlaySkillSheet.tab} focus={overlaySkillSheet.focus} />
      )}
      {sheet?.kind === 'team' && <TeamDetailSheet teamId={sheet.teamId} />}

      {authPrompt && capabilities.profile === 'official' && <AuthDialog
        reason={authPrompt.reason}
        restoring={authStatus === 'restoring'}
        restoreError={restoreError}
        onRetryRestore={() => void restorePersistedSession()}
        onUseAnotherAccount={async () => {
          setRestoreError(null)
          try {
            const cleared = await clearNativeAuthSession(await currentSpace())
            if (!cleared || !sameSpace(await currentSpace(), cleared)) return
            deleteLegacyAuth()
            clearAuthSession()
          } catch (error: unknown) {
            const message = error instanceof Error ? error.message : String(error)
            setRestoreError(`暂时无法安全切换账号：${message}`)
          }
        }}
        onAuthenticated={commitAuthenticatedSession}
        onClose={cancelTeamSkillLogin}
      />}

      {otherServerInvite && <OtherServerInviteDialog server={otherServerInvite.server} busy={inviteConnecting}
        onCancel={() => setOtherServerInvite(null)} onContinue={() => void continueOtherServerInvite()} />}
      {selfhostAuth && <ConnectServerDialog target={selfhostAuth.target} initialReport={selfhostAuth.report} teamInvite={selfhostAuth.teamInvite} migrationSource={selfhostAuth.migrationSource} lockAddress={inviteSwitch.current === 'connecting'} onConnected={() => {
        if (inviteSwitch.current === 'connecting') inviteSwitch.current = 'committed'
      }} onClose={() => {
        cancelTeamSkillLogin()
        if (inviteSwitch.current === 'connecting') sessionStorage.removeItem(PENDING_INVITE_KEY)
        inviteSwitch.current = 'idle'
        setSelfhostAuth(null)
        window.dispatchEvent(new Event('skillhub-connect-closed'))
      }} />}

      {capabilities.teams && pendingInvite && <TeamInviteDialog
        invite={pendingInvite}
        authenticated={authStatus === 'authenticated'}
        busy={pendingInviteBusy}
        onCancel={() => setPendingInvite(null)}
        onAccept={() => void acceptInviteToken(pendingInvite.token, pendingInvite.space, pendingInvite.server)}
      />}
      {feedbackOpen && <FeedbackDialog defaultContact={currentUser?.email} onClose={() => setFeedbackOpen(false)} />}
      <AppUpdateDialog />
      <KeyInstallGuide />
      {!spacePending && <KeyConsentDialog key={`consent:${spaceKey}`} />}

      <ToastContainer />
    </div>
  )
}
