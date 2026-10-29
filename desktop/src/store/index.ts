import type { SpaceHandle } from '../lib/tauri.js'
import { create } from 'zustand'
import { reconcileSkillList, sameListData, shareList, sameSkillIdentity } from '../lib/stable-list.js'
import { type AuthUser } from '../lib/auth.js'
import { ORGANIZER_SYNC_REQUEST_TIMEOUT_MS, syncOrganizerOnce, type OrganizerSyncApi, type OrganizerSyncOutcome } from '../lib/organizer-sync.js'
import type { ApiHealth, MarketplaceBadge, MarketplaceRole, MarketplaceSubmissionStatus } from '../lib/api.js'
import { retargetSkillSheet } from '../lib/ui-helpers.js'
import { resolveTeamPreference } from '../lib/skill-library.js'
import { downgradeMarketplaceAuthorization, hydrateDownloadedSkill, reconcileTeamAccess, replaceSkillAcrossSources, skillForAvatarAccount } from '../lib/skills.js'
import type { AgentInfo, KeyConsentRequest, LastRunRecord } from '../lib/tauri.js'
import { EMPTY_KEY_VAULT_STATE, EMPTY_TEAM_KEY_VAULT_STATE, type KeyVaultState, type TeamKeyVaultState } from '../lib/keys.js'
import type { MarketplaceDeepLink } from '../lib/marketplace-deep-link.js'
import type { SkillSortPreference } from '../lib/skill-library.js'
import type { SkillTitlePreference } from '../lib/skill-title.js'
import { parseThemePreference, THEME_PREFERENCE_KEY, type ThemePreference } from '../lib/theme.js'
import { clampSidebarWidth, parseSidebarWidth, SIDEBAR_WIDTH_KEY } from '../lib/sidebar-width.js'
import { parseHiddenCardAgents } from '../lib/agents.js'
import {
  INITIAL_LIBRARY_SYNC_STATE, reduceLibrarySync, type LibrarySyncEvent, type LibrarySyncState,
  type LibraryEntryList, type LibraryTransfer,
} from '../lib/library-sync.js'
import {
  finishTeamShareJob,
  startTeamShareJob,
  type TeamShareJob,
} from '../lib/team-share-flow.js'
import {
  finishAiAnalysisJobEntry,
  startAiAnalysisJobEntry,
  type AiAnalysisJob,
} from '../lib/ai-analysis-job.js'
import {
  emptyOrganizerState, normalizeOrganizerState, organizerAccountKey, pruneQuickAccess, setTagCollapsed, tagKey, rekeyOrganizer, skillOrganizerKey,
  type OrganizerResult, type OrganizerState,
} from '../lib/skill-organizer.js'
import { organizerLoad, organizerSave, readOrganizerSpace } from '../lib/tauri.js'

// ---- Types ----
export type View = 'skills' | 'team-skills' | 'teams' | 'marketplace' | 'keys' | 'settings'
export type SkillTab = 'skillhub' | 'tags' | 'local'
/** A request to reveal one group on the 标签 page (#324); `nonce` makes repeats distinct. */
export type TagGroupFocus = { key: string; nonce: number }
export type AcquisitionSource = 'local' | 'team' | 'marketplace'
export type SheetKind = 'skill' | 'team' | 'market'
export type SkillDetailTab = 'profile' | 'details' | 'environment' | 'versions'
export type SkillDetailFocus = 'env' | 'share' | 'discuss' | 'install' | 'delete' | `install:${string}` | `comment:${string}` | `share:${string}`

/** One-shot hint for the 钥匙 page: open a tab (and later a key) when it mounts (#289). */
export type KeysPageIntent = { tab: 'personal' | 'team'; key?: string }

export type PendingCommentNavigation = {
  teamId: string
  serverSkillId: string
  commentId?: string
  teamVersionId?: string
  accountUserId?: string
  space?: SpaceHandle
}

export type AppUpdateState = {
  phase: 'idle' | 'checking' | 'latest' | 'available' | 'downloading' | 'ready' | 'error'
  version?: string
  notes?: string
  downloadedBytes?: number
  totalBytes?: number
  error?: string
}

export type AgentDetectionStatus = 'idle' | 'checking' | 'success' | 'error'

export type Team = {
  id: string
  name: string
  description?: string | null
  color: string
  avatarUrl?: string | null
  role: 'owner' | 'member'
  memberCount: number
  sharedCount: number
  /** Team keys (#293/#295); absent on older Servers. */
  credentialCount?: number
}

export type EnvDep = {
  key: string
  description?: string
  required: boolean
  configured: boolean
  sharePolicy: 'none' | 'private' | 'team'
  sharedTeams?: string[]
  origin?: 'declared' | 'detected' | 'manual' | 'runtime_request'
  confidence?: 'declared' | 'high' | 'medium' | 'low'
  /** https link from the SKILL.md declaration (#251); display only. */
  obtain?: string
  /** True until the author confirms a runtime-requested key. */
  pending?: boolean
}

export type SkillVersionStatus = 'local' | 'pending' | 'confirmed' | 'unversioned'

export type SkillVersion = {
  version: string
  changelog?: string
  gitHash?: string
  date: string
  isCurrent?: boolean
  originalLabel?: string
  receiptId?: string
  formalVersionId?: string
  formalLabel?: string
  versionStatus?: SkillVersionStatus
}

export type LocalSkill = {
  /** Server analysis state; independent from the local import/analysis job status. */
  serverAnalysisStatus?: 'unanalysed' | 'completed'
  enrichmentPending?: boolean
  id: string
  name: string          // raw folder name
  displayName: string
  description?: string
  /** Original http/https 「来源」 URL (#330); independent of `sources` / `acquisitionSource`. Absent or null hides it. */
  sourceUrl?: string | null
  category?: string
  avatarLocalId?: string
  avatarUrl?: string | null
  avatarStatus?: string
  /** `custom` while the owner's uploaded image is shown (#214); known after an upload or an avatar pass, never persisted. */
  avatarSource?: 'generated' | 'custom'
  avatarAccountUserId?: string
  labels: string[]
  version: string
  latestVersion: string
  sourceVersionId?: string
  teamVersionId?: string
  teamUpdateStatus?: string
  teamUnshared?: boolean
  acquiredByUserId?: string
  teamEnvDeps?: LocalSkill['envDeps']
  teamChangelog?: string | null
  versionStatus?: SkillVersionStatus
  versionProblem?: string | null
  versionReceiptId?: string
  formalVersionId?: string
  formalLabel?: string
  installCount: number
  /** Normalised store badges in fixed order (see normalizeStoreBadges). */
  marketplaceBadges?: MarketplaceBadge[]
  marketplaceFeatured?: boolean
  marketplaceOriginal?: boolean
  marketplaceFirstPublishedAt?: string
  marketplaceEditorialLabels?: string[]
  sources: string[]     // e.g. ['本机创建', '一探究竟团队']
  agents: Record<string, 'on' | 'off' | 'broken' | null> // codex | claude
  installed: boolean
  isOwn: boolean
  /** Bundled SkillHub protocol asset. Visible, but never user-manageable. */
  isSystem?: boolean
  systemVersion?: string
  integrityStatus?: 'healthy' | 'repairRequired'
  acquisitionSource: AcquisitionSource
  sourceModifiedFiles?: number | null
  sourceLocalModified?: boolean
  sourcePackageReady?: boolean
  copiedFromSource?: boolean
  /** Account that most recently proved access through an authenticated API response. */
  serverAccessValidatedForUserId?: string
  /** SHA-256 of the exact remote package that created the current managed folder. */
  acquisitionPackageSha256?: string
  /** Transient recovery handle for rolling back a Marketplace replacement. */
  marketplaceReplacementRecoveryId?: string
  /** 商店 / 团队安装后只读复查：检测到但包内未声明的变量名。 */
  undeclaredEnvSuggestions?: string[]
  teamSharedFrom?: string   // team id
  envDeps: EnvDep[]
  sharedTo: Record<string, { version: string; envShared: boolean }>
  versions: SkillVersion[]
  trigger?: string
  fitScenarios?: string[]
  unfitScenarios?: string[]
  compatibleAgents: string[]
  isOrphan?: boolean
  accountSyncRequired?: boolean
  hasWorkingCopy?: boolean
  workingCopyChanges?: number
  workingCopyHash?: string
  createdAt?: string
  updatedAt?: string
  visibility?: 'private' | 'team' | 'public'
  marketplaceStatus?: MarketplaceSubmissionStatus | 'none'
  marketplacePublishedAt?: string
  marketplaceVersionId?: string
  marketplaceSkillMd?: string
  marketplaceReviewNote?: string
  /** Real managed-folder id when this value represents a Marketplace catalog entry. */
  marketplaceLocalVersion?: string
  marketplaceLocalId?: string
  /** Existing managed asset that must be recoverably replaced by the approved package. */
  marketplaceReplacementLocalId?: string
  /** SHA-256 pinned by the active Marketplace Listing shown on this card. */
  marketplacePackageSha256?: string
  /** Existing install click created by a public web deep-link handoff. */
  marketplaceInstallIntentId?: string
  /** Signed-in accounts with a fresh managed copy of this Marketplace listing. */
  marketplaceUserCount?: number
  /** ZIP downloads of the public listing (Server downloadCount). */
  marketplaceDownloadCount?: number
  authorName?: string
  authorAvatarUrl?: string | null
  /** Team scope (#295): the member who shared it to the team, and when. */
  sharedBy?: { id: string; displayName: string; avatarUrl?: string | null } | null
  sharedAt?: string | null
  localPath: string
  serverId?: string
  serverOwnerId?: string
  catalogOrigin?: string
  acquisitionVersion?: string
  /** Account whose synced library this folder belongs to (cloud sync). */
  libraryAccountId?: string | null
  /** Library entry this folder is bound to within that account. */
  libraryEntryId?: string | null
  addedByAccountId?: string | null
  /** A list-only account entry; no local-file actions are available until it lands. */
  cloudDownload?: LibraryTransfer
}

export type LocalSkillPreview = {
  id: string
  name: string
  displayName: string
  description?: string
  category?: string
  labels: string[]
  version: string
  sources: { agentKey: string; agentName: string; entryName: string; group?: string }[]
  localPath: string
  alreadyManaged: boolean
  managedSkillId?: string
  joinLocalId?: string
}

export type SkillHubUser = AuthUser & { marketplaceRole?: MarketplaceRole }

export function resolveSkillFromSources(
  skillId: string,
  skills: readonly LocalSkill[],
  marketplaceSkills: readonly LocalSkill[],
): LocalSkill | undefined {
  return skills.find((skill) => skill.id === skillId)
    ?? marketplaceSkills.find((skill) => skill.id === skillId)
}

export type Notification = {
  id: string
  type: string
  payload: Record<string, unknown>
  read: boolean
  createdAt: string
}

export type AuthIntent =
  | { kind: 'view'; view: 'team-skills' | 'teams' }
  | { kind: 'account' }
  | { kind: 'share-skill'; skillId: string }
  | { kind: 'join-team'; token: string }

export type AuthPrompt = {
  reason: string
  intent?: AuthIntent
}

// ---- Sheet state ----
type SheetState =
  | { kind: 'skill'; skillId: string; tab: SkillDetailTab; focus?: SkillDetailFocus }
  | { kind: 'team'; teamId: string }
  | null

function reconcileListSheet(sheet: SheetState, previous: LocalSkill[], next: LocalSkill[]): SheetState {
  if (sheet?.kind !== 'skill') return sheet
  const selected = previous.find(skill => skill.id === sheet.skillId)
  const landed = selected && next.find(skill => sameSkillIdentity(skill, selected))
  return selected && landed ? retargetSkillSheet(sheet, selected.id, landed.id) : sheet
}

function reconcileListSelections(selections: Record<string, SheetState>, previous: LocalSkill[], next: LocalSkill[]): Record<string, SheetState> {
  const result = Object.fromEntries(Object.entries(selections).map(([key, sheet]) => [key, reconcileListSheet(sheet, previous, next)]))
  return sameListData(result, selections) ? selections : result
}

// ---- Modal state ----
type ModalState =
  | { kind: 'install'; skillId: string }
  | { kind: 'update'; skillId: string }
  | { kind: 'agents'; skillId: string }
  | { kind: 'env'; skillId: string; envKey: string }
  | { kind: 'share'; skillId: string; teamId?: string }
  | { kind: 'import' }
  | { kind: 'confirm'; title: string; desc: string; ok: string; danger?: boolean; onConfirm: () => void }
  | null

const TEAM_PREFERENCE_PREFIX = 'yitan-skillhub.team-preference.v1.'
const NO_TEAM_PREFERENCE = 'none'
function teamPreferenceKey(userId: string, space?: SpaceHandle | null): string {
  return `${TEAM_PREFERENCE_PREFIX}${space && space.spaceId !== 'official' ? `${space.spaceId}:` : ''}${userId}`
}
/** Row ids (`cloudSelectionId`) of the background 「从账号删除」 batch (#360). */
export type AccountDeletes = { pending: Record<string, true>; leaving: Record<string, true> }
const EMPTY_ACCOUNT_DELETES: AccountDeletes = { pending: {}, leaving: {} }

const SKILL_TITLE_PREFERENCE_KEY = 'yitan-skillhub.skill-title-preference.v1'
const SKILL_SORT_PREFERENCE_KEY = 'yitan-skillhub.skill-sort-preference.v1'

type UiStorage = Pick<Storage, 'getItem' | 'setItem'>

function uiStorage(): UiStorage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage
  } catch {
    return null
  }
}

export function readPreference(key: string): string | null {
  try {
    return uiStorage()?.getItem(key) ?? null
  } catch {
    return null
  }
}

export function writePreference(key: string, value: string): void {
  try {
    uiStorage()?.setItem(key, value)
  } catch {
    // UI preferences must never prevent the authenticated session from working.
  }
}

export function readSkillSortPreference(): SkillSortPreference {
  const value = readPreference(SKILL_SORT_PREFERENCE_KEY)
  return value === 'time' || value === 'time-asc' || value === 'name-desc' ? value : 'name'
}

function readSkillTitlePreference(): SkillTitlePreference {
  return readPreference(SKILL_TITLE_PREFERENCE_KEY) === 'ai-title' ? 'ai-title' : 'skill-name'
}

const HIDDEN_CARD_AGENTS_KEY = 'yitan-skillhub.hidden-card-agents.v1'

function readThemePreference(): ThemePreference {
  return parseThemePreference(readPreference(THEME_PREFERENCE_KEY))
}

// ---- Skill organizer persistence (#323) ----
// Each pending write carries the account key it was made for, so a write that
// is flushed after an account switch still lands in the right account's file.
type OrganizerPersistence = {
  load: (accountKey: string) => Promise<OrganizerState>
  save: (accountKey: string, state: OrganizerState, space: SpaceHandle | null) => Promise<void>
}
let organizerPersistence: OrganizerPersistence = {
  load: async (accountKey) => normalizeOrganizerState(await organizerLoad(accountKey)),
  save: organizerSave,
}
let pendingOrganizerSave: { accountKey: string; state: OrganizerState; space: SpaceHandle | null } | null = null
let organizerSaveTimer: ReturnType<typeof setTimeout> | null = null
let organizerSaveInFlight: Promise<void> = Promise.resolve()
let organizerLoadInFlight: string | null = null
let organizerEpoch = 0
const ORGANIZER_SAVE_DELAY_MS = 250

/** Tests replace the native commands with in-memory ones. */
export function setOrganizerPersistence(persistence: OrganizerPersistence): void {
  organizerPersistence = persistence
}

/** Write the pending organizer change now (account switch, app hide, tests). */
export async function flushOrganizerSave(strict = false): Promise<void> {
  if (organizerSaveTimer) { clearTimeout(organizerSaveTimer); organizerSaveTimer = null }
  const pending = pendingOrganizerSave
  pendingOrganizerSave = null
  if (pending) {
    organizerSaveInFlight = organizerSaveInFlight.catch(() => {}).then(async () => {
      await organizerPersistence.save(pending.accountKey, pending.state, pending.space)
    })
  }
  try {
    await organizerSaveInFlight
  } catch (error) {
    const state = useStore.getState()
    if (pending && state.organizerAccount === pending.accountKey) {
      if (!pendingOrganizerSave) pendingOrganizerSave = pending
      useStore.setState({ organizerProblem: `目录保存失败：${error instanceof Error ? error.message : String(error)}` })
    }
    if (strict) throw error
  }
}

function scheduleOrganizerSave(accountKey: string, state: OrganizerState): void {
  // A different account's pending write is flushed first, never merged.
  if (pendingOrganizerSave && pendingOrganizerSave.accountKey !== accountKey) void flushOrganizerSave()
  pendingOrganizerSave = { accountKey, state, space: readOrganizerSpace() }
  if (organizerSaveTimer) clearTimeout(organizerSaveTimer)
  organizerSaveTimer = setTimeout(() => { void flushOrganizerSave() }, ORGANIZER_SAVE_DELAY_MS)
}

/** Strict reset on account change: another account's tags must never show. */
function organizerResetFor(previousUserId: string | null | undefined, nextUserId: string | null | undefined, force = false): Partial<SkillHubStore> {
  if (!force && organizerAccountKey(previousUserId) === organizerAccountKey(nextUserId)) return {}
  organizerEpoch++
  void flushOrganizerSave()
  // A pass for the previous account stops writing at once (its commits are refused too).
  organizerSyncFlight?.controller.abort()
  return { organizer: emptyOrganizerState(), organizerAccount: null, organizerProblem: null, organizerSync: { ...INITIAL_ORGANIZER_SYNC_STATUS } }
}

// ---- Organizer Server sync (#326) ----
/** `unknown` until a /health answer; a failed probe stays `unknown` and is retried. */
export type OrganizerSyncCapability = 'unknown' | 'supported' | 'unsupported'
export type OrganizerSyncStatus = {
  /** Whether the Server offers `skills.library-organizer.v1`; only `supported` syncs. */
  capability: OrganizerSyncCapability
  /** The last capability probe failed (offline / Server unreachable); retried with backoff. */
  probeFailed: boolean
  running: boolean
  error: string | null
}
const INITIAL_ORGANIZER_SYNC_STATUS: OrganizerSyncStatus = { capability: 'unknown', probeFailed: false, running: false, error: null }
type OrganizerSyncApiFactory = (scope: { space: SpaceHandle; signal: AbortSignal; timeoutMs: number }) => OrganizerSyncApi | Promise<OrganizerSyncApi>
let organizerSyncFlight: { accountKey: string; controller: AbortController; promise: Promise<OrganizerSyncOutcome | null> } | null = null

const defaultOrganizerSyncApi: OrganizerSyncApiFactory = async (scope) => {
  // Loaded lazily: the store stays importable where the HTTP client is not.
  const api = await import('../lib/api.js')
  return {
    getTags: () => api.apiGetLibraryTags(scope),
    patchTags: (entryId, delta) => api.apiPatchLibraryTags(entryId, delta, scope),
    renameTag: (from, to) => api.apiRenameLibraryTag(from, to, scope),
    deleteTag: (name) => api.apiDeleteLibraryTag(name, scope),
    getQuickAccess: () => api.apiGetQuickAccess(scope),
    putQuickAccess: (baseRevision, items) => api.apiPutQuickAccess(baseRevision, items, scope),
  }
}
let organizerSyncApi: OrganizerSyncApiFactory = defaultOrganizerSyncApi

/** Tests replace the HTTP client with an in-memory Server. */
export function setOrganizerSyncApi(factory: OrganizerSyncApiFactory | null): void {
  organizerSyncApi = factory ?? defaultOrganizerSyncApi
}

// ---- Store ----
export type SkillHubStore = {
  activeSpace: SpaceHandle | null
  spacePending: boolean
  serverInfo: ApiHealth | null
  resetSpace: (space: SpaceHandle, pending: boolean) => void
  // Account
  authStatus: 'restoring' | 'guest' | 'authenticated'
  currentUser: SkillHubUser | null
  authSpace: SpaceHandle | null
  setAuthSession: (user: SkillHubUser, space: SpaceHandle) => void
  updateCurrentUser: (user: SkillHubUser) => void
  setAuthGuest: () => void
  clearAuthSession: () => void
  authPrompt: AuthPrompt | null
  promptForAuth: (prompt: AuthPrompt) => void
  dismissAuthPrompt: () => void

  // Navigation
  view: View
  skillTab: SkillTab
  activeTeamId: string | null
  setView: (v: View) => void
  setSkillTab: (t: SkillTab) => void
  setActiveTeam: (id: string | null) => void
  hideTeamShares: () => void

  // Data
  teams: Team[]
  skills: LocalSkill[]
  marketplaceSkills: LocalSkill[]
  notifications: Notification[]
  agentCapabilities: AgentInfo[]
  agentDetectionStatus: AgentDetectionStatus
  /** The Server offers account library sync (`skills.library-sync.v1`). */
  librarySyncEnabled: boolean
  libraryEntries: LibraryEntryList | null
  libraryTransfers: Record<string, LibraryTransfer>
  setLibraryEntries: (list: LibraryEntryList) => void
  setLibraryTransfer: (transfer: LibraryTransfer) => void
  /** Title indicator state of the current account's sync passes. */
  librarySync: LibrarySyncState
  teamShareJobs: Record<string, TeamShareJob>
  /** Background 「从账号删除」 rows (#360): processing, then leaving (animation) until settled. */
  accountDeletes: AccountDeletes
  /** Running 「AI 分析」 jobs of the current account, keyed by `${accountUserId}:${serverId}` (#181). */
  aiAnalysisJobs: Record<string, AiAnalysisJob>
  localSkillPreview: LocalSkillPreview | null
  localImportRequestId: string | null
  pendingMarketplaceIntent: MarketplaceDeepLink | null
  pendingCommentNavigation: PendingCommentNavigation | null
  searchQuery: string
  categoryFilter: string
  statusFilter: string
  skillTitlePreference: SkillTitlePreference
  /** 我的 Skills ordering (#361), kept on this computer. */
  skillSortPreference: SkillSortPreference
  /** APP colour theme (#258); `system` follows the OS. Device-wide, not per account. */
  themePreference: ThemePreference
  /** Preferred sidebar width in CSS px (#182), 220–320; rendering clamps it to the window. Device-wide. */
  sidebarWidth: number
  /** Set when the persisted avatar parking could not be read; new avatar requests stay paused. */
  avatarParkingProblem: string | null
  hiddenCardAgents: string[]
  setSkills: (s: LocalSkill[]) => void
  teamSkills: Record<string, LocalSkill[]>
  teamListErrors: Record<string, string | null>
  listSelections: Record<string, SheetState>
  skillsListError: string | null
  setSkillsListError: (error: string | null) => void
  setTeamSkills: (teamId: string, skills: LocalSkill[] | undefined, error: string | null) => void
  setMarketplaceSkills: (s: LocalSkill[]) => void
  replaceSkill: (currentId: string, updated: LocalSkill, localFilesChanged?: boolean) => void
  setTeams: (t: Team[]) => void
  setNotifications: (n: Notification[]) => void
  setAgentCapabilities: (agents: AgentInfo[]) => void
  setAgentDetectionStatus: (status: AgentDetectionStatus) => void
  setLibrarySyncEnabled: (enabled: boolean) => void
  dispatchLibrarySync: (event: LibrarySyncEvent) => void
  setTeamShareJob: (skillId: string, job: TeamShareJob) => void
  markAccountDeletePending: (ids: readonly string[]) => void
  markAccountDeleteLeaving: (id: string) => void
  /** Clears the row's delete state; `removed` also drops it from `skills`. */
  settleAccountDelete: (id: string, removed: boolean) => void
  clearTeamShareJob: (skillId: string, jobId: string) => void
  startAiAnalysisJob: (job: AiAnalysisJob) => void
  finishAiAnalysisJob: (key: string, jobId: string) => void
  setLocalSkillPreview: (skill: LocalSkillPreview | null) => void
  requestLocalSkillImport: (skillId: string) => void
  clearLocalSkillImportRequest: () => void
  setPendingMarketplaceIntent: (intent: MarketplaceDeepLink | null) => void
  setPendingCommentNavigation: (navigation: PendingCommentNavigation | null) => void
  openTeamSkill: (teamId: string, serverSkillId: string) => void
  setSearchQuery: (q: string) => void
  setCategoryFilter: (c: string) => void
  setStatusFilter: (s: string) => void
  setSkillTitlePreference: (preference: SkillTitlePreference) => void
  setSkillSortPreference: (preference: SkillSortPreference) => void
  setThemePreference: (preference: ThemePreference) => void
  setSidebarWidth: (width: number) => void
  setCardAgentVisible: (agentKey: string, visible: boolean) => void

  // App update
  appUpdate: AppUpdateState
  setAppUpdate: (state: AppUpdateState) => void

  // Sheet
  sheet: SheetState
  openSkillSheet: (skillId: string, tab?: SkillDetailTab, focus?: SkillDetailFocus) => void
  openTeamSheet: (teamId: string) => void
  closeSheet: () => void
  setSheetTab: (tab: SkillDetailTab) => void

  // Modal
  modal: ModalState
  openModal: (m: ModalState) => void
  closeModal: () => void

  // Loading states
  isLoadingSkills: boolean
  setLoadingSkills: (v: boolean) => void

  // Personal key vault (#253): names and metadata only, never values.
  keyVault: KeyVaultState
  setKeyVault: (state: KeyVaultState) => void
  keyConsentRequests: KeyConsentRequest[]
  setKeyConsentRequests: (requests: KeyConsentRequest[]) => void
  // Failed `skillhub run` outcomes by local Skill id (#292).
  lastRunFailures: Record<string, LastRunRecord>
  setLastRunFailures: (records: LastRunRecord[]) => void

  // Team key vault of the selected team (#254): metadata only, never values.
  teamKeyVault: TeamKeyVaultState
  setTeamKeyVault: (state: TeamKeyVaultState) => void

  // 「共享给团队」 in the Skill 钥匙 section opens the 钥匙 page on 团队 (#289; #294 adds the dialog).
  keysPageIntent: KeysPageIntent | null
  setKeysPageIntent: (intent: KeysPageIntent | null) => void

  // Skill organizer (#323): private tags and quick access of the current account (or guest).
  organizer: OrganizerState
  /** Account key (`guest` or user UUID) whose file `organizer` holds; null until loaded. */
  organizerAccount: string | null
  organizerProblem: string | null
  /** Load the current account's organizer; no-op while auth is restoring or already loaded. */
  loadOrganizer: () => Promise<void>
  /** Apply a pure organizer change and save it; returns an error message or null. */
  mutateOrganizer: (mutate: (state: OrganizerState) => OrganizerResult | OrganizerState) => string | null
  /**
   * After Skills load: move `local:` keys of Skills that joined the account to
   * `entry:` and, when `prune` (the list is complete), drop stale quick-access items.
   */
  reconcileOrganizer: (skills: readonly LocalSkill[], options: { prune: boolean }) => void
  /** Pending 「open 标签 page at group X」 request, consumed by the 标签 page. */
  tagGroupFocus: TagGroupFocus | null
  /**
   * Open 「我的 Skills · 标签」 at the group of `tagName` (#324; the sidebar quick
   * access of #325 calls it): switches view and segment, expands the group
   * (persisted) and asks the page to scroll it into view and focus its header.
   */
  openTagGroup: (tagName: string) => void
  /** Called by the 标签 page once it revealed the group of this request. */
  clearTagGroupFocus: (nonce: number) => void
  /** Pending 「show this Skill in 我的 Skills」 request (#325); the page clears its own filters first. */
  skillReveal: { skillId: string; nonce: number } | null
  /**
   * Open a Skill's detail on 我的 Skills · SkillHub 云端 (sidebar quick access, #325):
   * clears search and category so the Skill is visible; the page clears its Agent and
   * 共享范围 filters, then calls `clearSkillReveal`.
   */
  revealSkill: (skillId: string) => void
  clearSkillReveal: (nonce: number) => void
  /** Server sync of the organizer (#326); status is not persisted, `organizer.sync` is. */
  organizerSync: OrganizerSyncStatus
  /** Probe result: a capability, or `unknown` with `probeFailed` when /health could not be read. */
  setOrganizerSyncCapability: (capability: OrganizerSyncCapability, probeFailed?: boolean) => void
  /**
   * One sync pass for the signed-in account. Single-flight per account: a call
   * during a pass returns that pass. Resolves null when sync is off or nothing ran.
   */
  runOrganizerSync: () => Promise<OrganizerSyncOutcome | null>
}

export const useStore = create<SkillHubStore>((set, get) => ({
  activeSpace: null,
  spacePending: false,
  serverInfo: null,
  resetSpace: (space, pending) => {
    get().clearAuthSession()
    set({ activeSpace: space, spacePending: pending, serverInfo: null, skills: [], marketplaceSkills: [],
      notifications: [], teams: [], pendingMarketplaceIntent: null,
      librarySyncEnabled: false, librarySync: INITIAL_LIBRARY_SYNC_STATE })
  },
  // Account
  authStatus: 'restoring',
  authSpace: null,
  currentUser: null,
  setAuthSession: (currentUser, space) => {
    set((state) => {
      const sameSession = state.currentUser?.id === currentUser.id && state.authSpace?.spaceId === space.spaceId && state.authSpace.generation === space.generation
      return ({
      ...organizerResetFor(state.currentUser?.id, currentUser.id, !sameSession),
      authStatus: 'authenticated',
      authSpace: space,
      activeSpace: space,
      currentUser,
      teams: sameSession ? state.teams : [],
      teamSkills: sameSession ? state.teamSkills : {},
      teamListErrors: sameSession ? state.teamListErrors : {},
      listSelections: sameSession ? state.listSelections : {},
      skillsListError: sameSession ? state.skillsListError : null,
      pendingCommentNavigation: sameSession ? state.pendingCommentNavigation : null,
      libraryEntries: sameSession ? state.libraryEntries : null,
      libraryTransfers: sameSession ? state.libraryTransfers : {},
      // Native sidecars survive logout and may still contain the previous
      // account's ownership bit. Session changes therefore fail closed until
      // the protected owned Skills endpoint authoritatively restores rights.
      skills: sameSession ? shareList(state.skills, state.skills.map(skill => skillForAvatarAccount(skill, currentUser.id)), skill => skill.id) : [],
      marketplaceSkills: state.marketplaceSkills.map(downgradeMarketplaceAuthorization),
      teamShareJobs: sameSession ? state.teamShareJobs : {},
      accountDeletes: sameSession ? state.accountDeletes : EMPTY_ACCOUNT_DELETES,
      keyVault: sameSession ? state.keyVault : EMPTY_KEY_VAULT_STATE,
      keyConsentRequests: sameSession ? state.keyConsentRequests : [],
      lastRunFailures: sameSession ? state.lastRunFailures : {},
      teamKeyVault: sameSession ? state.teamKeyVault : EMPTY_TEAM_KEY_VAULT_STATE,
      aiAnalysisJobs: sameSession ? state.aiAnalysisJobs : {},
      notifications: sameSession ? state.notifications : [],
      sheet: sameSession ? state.sheet : null,
      activeTeamId: sameSession
        ? resolveTeamPreference(readPreference(teamPreferenceKey(currentUser.id, space)), state.teams)
        : null,
    }) })
  },
  updateCurrentUser: (currentUser) => set((state) => ({
    currentUser: state.currentUser ? { ...state.currentUser, ...currentUser } : currentUser,
  })),
  setAuthGuest: () => set((state) => ({
    ...organizerResetFor(state.currentUser?.id, null, true),
    authStatus: 'guest',
    authSpace: null,
    currentUser: null,
    teamSkills: {},
    teamListErrors: {},
    listSelections: {},
    skillsListError: null,
    pendingCommentNavigation: null,
    libraryEntries: null,
    libraryTransfers: {},
    skills: state.skills.map(skill => skillForAvatarAccount(skill)),
    marketplaceSkills: state.marketplaceSkills.map(downgradeMarketplaceAuthorization),
    teamShareJobs: {},
    accountDeletes: EMPTY_ACCOUNT_DELETES,
    keyVault: EMPTY_KEY_VAULT_STATE,
    keyConsentRequests: [],
    lastRunFailures: {},
    teamKeyVault: EMPTY_TEAM_KEY_VAULT_STATE,
    aiAnalysisJobs: {},
  })),
  authPrompt: null,
  promptForAuth: (authPrompt) => set({ authPrompt }),
  dismissAuthPrompt: () => set({ authPrompt: null }),
  clearAuthSession: () => {
    set((state) => ({
      ...organizerResetFor(state.currentUser?.id, null, true),
      authStatus: 'guest',
    authSpace: null,
      currentUser: null,
      teamSkills: {},
      teamListErrors: {},
      listSelections: {},
      skillsListError: null,
      libraryEntries: null,
      libraryTransfers: {},
      teams: [],
      // Local assets remain usable without an account. Server identity in the
      // sidecar is dormant until a future authenticated refresh validates it.
      skills: state.skills
        .filter((skill) => Boolean(skill.localPath))
        .map(skill => skillForAvatarAccount(skill)),
      marketplaceSkills: state.marketplaceSkills.map(downgradeMarketplaceAuthorization),
      notifications: [],
      teamShareJobs: {},
      accountDeletes: EMPTY_ACCOUNT_DELETES,
      keyVault: EMPTY_KEY_VAULT_STATE,
      keyConsentRequests: [],
      lastRunFailures: {},
      teamKeyVault: EMPTY_TEAM_KEY_VAULT_STATE,
      aiAnalysisJobs: {},
      activeTeamId: null,
      localSkillPreview: null,
      localImportRequestId: null,
      pendingCommentNavigation: null,
      sheet: null,
      modal: null,
      isLoadingSkills: false,
      view: state.view === 'team-skills' || state.view === 'teams' ? 'skills' : state.view,
    }))
  },

  // Navigation
  view: 'skills',
  skillTab: 'skillhub',
  activeTeamId: null,
  setView: (view) => set(state => ({ view,
    sheet: view === 'skills' || view === 'team-skills'
      ? state.listSelections[view === 'team-skills' ? `team:${state.activeTeamId}` : view] ?? null : null })),
  setSkillTab: (skillTab) => set({ skillTab }),
  setActiveTeam: (activeTeamId) => set((state) => {
    if (state.currentUser && activeTeamId) writePreference(teamPreferenceKey(state.currentUser.id, state.authSpace), activeTeamId)
    return { activeTeamId, ...(state.view === 'team-skills' ? { sheet: state.listSelections[`team:${activeTeamId}`] ?? null } : {}) }
  }),
  hideTeamShares: () => set((state) => {
    if (state.currentUser) writePreference(teamPreferenceKey(state.currentUser.id, state.authSpace), NO_TEAM_PREFERENCE)
    return { activeTeamId: null }
  }),

  // Data
  teams: [],
  skills: [],
  teamSkills: {},
  teamListErrors: {},
  listSelections: {},
  skillsListError: null,
  setSkillsListError: (skillsListError) => set({ skillsListError }),
  marketplaceSkills: [],
  notifications: [],
  agentCapabilities: [],
  agentDetectionStatus: 'idle',
  librarySyncEnabled: false,
  libraryEntries: null,
  libraryTransfers: {},
  librarySync: INITIAL_LIBRARY_SYNC_STATE,
  teamShareJobs: {},
  accountDeletes: EMPTY_ACCOUNT_DELETES,
  aiAnalysisJobs: {},
  localSkillPreview: null,
  localImportRequestId: null,
  pendingMarketplaceIntent: null,
  pendingCommentNavigation: null,
  searchQuery: '',
  categoryFilter: '全部',
  statusFilter: '全部',
  skillTitlePreference: readSkillTitlePreference(),
  skillSortPreference: readSkillSortPreference(),
  themePreference: readThemePreference(),
  sidebarWidth: parseSidebarWidth(readPreference(SIDEBAR_WIDTH_KEY)),
  avatarParkingProblem: null,
  hiddenCardAgents: parseHiddenCardAgents(readPreference(HIDDEN_CARD_AGENTS_KEY)),
  setSkills: (skills) => set(state => {
    const next = reconcileSkillList(state.skills, skills)
    return next === state.skills ? state : { skills: next,
      listSelections: reconcileListSelections(state.listSelections, state.skills, next),
      sheet: reconcileListSheet(state.sheet, state.skills, next) }
  }),
  setTeamSkills: (teamId, skills, error) => set(state => {
    if (skills === undefined) return { teamListErrors: { ...state.teamListErrors, [teamId]: error } }
    const previous = state.teamSkills[teamId] ?? []
    const next = reconcileSkillList(previous, skills)
    const teamSkills = next === state.teamSkills[teamId] ? state.teamSkills : { ...state.teamSkills, [teamId]: next }
    return { teamSkills,
      listSelections: reconcileListSelections(state.listSelections, previous, next),
      sheet: state.view === 'team-skills' && state.activeTeamId === teamId ? reconcileListSheet(state.sheet, previous, next) : state.sheet,
      teamListErrors: state.teamListErrors[teamId] === error ? state.teamListErrors : { ...state.teamListErrors, [teamId]: error } }
  }),
  setMarketplaceSkills: (marketplaceSkills) => set({ marketplaceSkills }),
  replaceSkill: (currentId, updated, localFilesChanged = false) => {
    set((state) => {
      const replacement = replaceSkillAcrossSources(state.skills, state.marketplaceSkills, currentId, updated)
      return {
        skills: reconcileSkillList(state.skills, replacement.skills),
        marketplaceSkills: shareList(state.marketplaceSkills, replacement.marketplaceSkills, skill => skill.id),
        listSelections: Object.fromEntries(Object.entries(state.listSelections).map(([key, sheet]) => [key, retargetSkillSheet(sheet, currentId, replacement.nextSkillId)])),
        teamSkills: Object.fromEntries(Object.entries(state.teamSkills).map(([teamId, skills]) => [teamId,
          reconcileSkillList(skills, skills.map(skill => skill.id === currentId || Boolean(updated.serverId && skill.serverId === updated.serverId)
            ? { ...hydrateDownloadedSkill(skill, updated), envDeps: updated.envDeps } : skill))])),
        sheet: retargetSkillSheet(state.sheet, currentId, replacement.nextSkillId),
      }
    })
    if (localFilesChanged && typeof window !== 'undefined') window.dispatchEvent(new Event('skillhub-local-changed'))
  },
  setTeams: (teams) => set((state) => {
    if (!state.currentUser) return { teams, activeTeamId: null }
    const key = teamPreferenceKey(state.currentUser.id, state.authSpace)
    const storedPreference = readPreference(key)
    const activeTeamId = resolveTeamPreference(storedPreference, teams)
    if (storedPreference !== NO_TEAM_PREFERENCE && storedPreference !== activeTeamId && activeTeamId) {
      writePreference(key, activeTeamId)
    }
    const next = shareList(state.teams, teams, team => team.id)
    const teamSkills = Object.fromEntries(Object.entries(state.teamSkills).filter(([id]) => teams.some(team => team.id === id)))
    const removedTeamIds = [...new Set(state.skills.flatMap(skill => skill.teamSharedFrom
      && !teams.some(team => team.id === skill.teamSharedFrom) ? [skill.teamSharedFrom] : []))]
    return { teams: next, activeTeamId, teamSkills: sameListData(teamSkills, state.teamSkills) ? state.teamSkills : teamSkills,
      skills: reconcileTeamAccess(state.skills, { ...teamSkills, ...Object.fromEntries(removedTeamIds.map(id => [id, []])) }, removedTeamIds, state.currentUser?.id) }
  }),
  setNotifications: (notifications) => set({ notifications }),
  setAgentCapabilities: (agentCapabilities) => set({ agentCapabilities }),
  setAgentDetectionStatus: (agentDetectionStatus) => set({ agentDetectionStatus }),
  setLibrarySyncEnabled: (librarySyncEnabled) => set({ librarySyncEnabled }),
  setLibraryEntries: (libraryEntries) => set(state => state.currentUser?.id === libraryEntries.userId
    && (!libraryEntries.space || (libraryEntries.space.spaceId === state.authSpace?.spaceId && libraryEntries.space.generation === state.authSpace?.generation))
    && !sameListData(state.libraryEntries, libraryEntries) ? { libraryEntries } : state),
  setLibraryTransfer: (transfer) => set(state => state.currentUser?.id === transfer.userId
    ? { libraryTransfers: { ...state.libraryTransfers, [transfer.entryId]: transfer } } : {}),
  dispatchLibrarySync: (event) => set((state) => {
    const librarySync = reduceLibrarySync(state.librarySync, event)
    return librarySync === state.librarySync ? state : { librarySync }
  }),
  markAccountDeletePending: (ids) => set((state) => ({
    accountDeletes: { ...state.accountDeletes, pending: { ...state.accountDeletes.pending, ...Object.fromEntries(ids.map((id) => [id, true as const])) } },
  })),
  markAccountDeleteLeaving: (id) => set((state) => ({
    accountDeletes: { ...state.accountDeletes, leaving: { ...state.accountDeletes.leaving, [id]: true } },
  })),
  settleAccountDelete: (id, removed) => set((state) => {
    const { [id]: _pending, ...pending } = state.accountDeletes.pending
    const { [id]: _leaving, ...leaving } = state.accountDeletes.leaving
    return {
      accountDeletes: { pending, leaving },
      ...(removed ? { skills: state.skills.filter((skill) => (skill.libraryEntryId ? `library:${skill.libraryEntryId}` : skill.id) !== id) } : {}),
    }
  }),
  setTeamShareJob: (skillId, job) => set((state) => ({
    teamShareJobs: startTeamShareJob(state.teamShareJobs, skillId, job),
  })),
  clearTeamShareJob: (skillId, jobId) => set((state) => {
    const teamShareJobs = finishTeamShareJob(state.teamShareJobs, skillId, jobId)
    return teamShareJobs === state.teamShareJobs ? {} : { teamShareJobs }
  }),
  startAiAnalysisJob: (job) => set((state) => {
    // Jobs belong to the account that is signed in now; never start one for another.
    if (state.currentUser?.id !== job.accountUserId) return {}
    const aiAnalysisJobs = startAiAnalysisJobEntry(state.aiAnalysisJobs, job)
    return aiAnalysisJobs === state.aiAnalysisJobs ? {} : { aiAnalysisJobs }
  }),
  finishAiAnalysisJob: (key, jobId) => set((state) => {
    const aiAnalysisJobs = finishAiAnalysisJobEntry(state.aiAnalysisJobs, key, jobId)
    return aiAnalysisJobs === state.aiAnalysisJobs ? {} : { aiAnalysisJobs }
  }),
  setLocalSkillPreview: (localSkillPreview) => set({ localSkillPreview }),
  setPendingMarketplaceIntent: (pendingMarketplaceIntent) => set({ pendingMarketplaceIntent }),
  setPendingCommentNavigation: (navigation) => set(state => ({ pendingCommentNavigation: navigation ? {
    ...navigation, accountUserId: navigation.accountUserId ?? state.currentUser?.id, space: navigation.space ?? state.activeSpace ?? undefined,
    teamVersionId: navigation.teamVersionId ?? state.teamSkills[navigation.teamId]?.find(skill => skill.serverId === navigation.serverSkillId)?.teamVersionId,
  } : null })),
  openTeamSkill: (teamId, serverSkillId) => set(state => ({ view: 'team-skills', activeTeamId: teamId, sheet: null,
    pendingCommentNavigation: { teamId, serverSkillId, accountUserId: state.currentUser?.id, space: state.activeSpace ?? undefined,
      teamVersionId: state.teamSkills[teamId]?.find(skill => skill.serverId === serverSkillId)?.teamVersionId } })),
  requestLocalSkillImport: (localImportRequestId) => set({ localImportRequestId }),
  clearLocalSkillImportRequest: () => set({ localImportRequestId: null }),
  setSearchQuery: (searchQuery) => set({ searchQuery }),
  setCategoryFilter: (categoryFilter) => set({ categoryFilter }),
  setStatusFilter: (statusFilter) => set({ statusFilter }),
  setSkillTitlePreference: (skillTitlePreference) => {
    writePreference(SKILL_TITLE_PREFERENCE_KEY, skillTitlePreference)
    set({ skillTitlePreference })
  },
  setSkillSortPreference: (skillSortPreference) => {
    writePreference(SKILL_SORT_PREFERENCE_KEY, skillSortPreference)
    set({ skillSortPreference })
  },
  setThemePreference: (preference) => {
    const themePreference = parseThemePreference(preference)
    writePreference(THEME_PREFERENCE_KEY, themePreference)
    set({ themePreference })
  },
  setSidebarWidth: (width) => {
    const sidebarWidth = clampSidebarWidth(width)
    writePreference(SIDEBAR_WIDTH_KEY, String(sidebarWidth))
    set({ sidebarWidth })
  },
  setCardAgentVisible: (agentKey, visible) => set((state) => {
    const hidden = new Set(state.hiddenCardAgents)
    if (visible) hidden.delete(agentKey)
    else hidden.add(agentKey)
    const hiddenCardAgents = Array.from(hidden)
    writePreference(HIDDEN_CARD_AGENTS_KEY, JSON.stringify(hiddenCardAgents))
    return { hiddenCardAgents }
  }),

  // App update
  appUpdate: { phase: 'idle' },
  setAppUpdate: (appUpdate) => set({ appUpdate }),

  // Sheet
  sheet: null,
  openSkillSheet: (skillId, tab = 'profile', focus) =>
    set(state => {
      const sheet: SheetState = { kind: 'skill', skillId, tab, focus }
      const key = state.view === 'team-skills' ? `team:${state.activeTeamId}` : state.view
      return { sheet, ...(state.view === 'skills' || state.view === 'team-skills'
        ? { listSelections: { ...state.listSelections, [key]: { ...sheet, focus: undefined } } } : {}) }
    }),
  openTeamSheet: (teamId) => set({ sheet: { kind: 'team', teamId } }),
  closeSheet: () => set(state => {
    const listSelections = { ...state.listSelections }
    delete listSelections[state.view === 'team-skills' ? `team:${state.activeTeamId}` : state.view]
    return { sheet: null, listSelections }
  }),
  setSheetTab: (tab) =>
    set((s) => {
      if (s.sheet?.kind !== 'skill') return {}
      const sheet: SheetState = { ...s.sheet, tab, focus: undefined }
      const key = s.view === 'team-skills' ? `team:${s.activeTeamId}` : s.view
      return { sheet, ...(s.listSelections[key] ? { listSelections: { ...s.listSelections, [key]: sheet } } : {}) }
    }),

  // Modal
  modal: null,
  openModal: (modal) => set({ modal }),
  closeModal: () => set({ modal: null }),

  // Loading
  isLoadingSkills: false,
  setLoadingSkills: (isLoadingSkills) => set({ isLoadingSkills }),

  // Personal key vault
  keyVault: EMPTY_KEY_VAULT_STATE,
  setKeyVault: (keyVault) => set({ keyVault }),
  keyConsentRequests: [],
  setKeyConsentRequests: (keyConsentRequests) => set({ keyConsentRequests }),
  lastRunFailures: {},
  setLastRunFailures: (records) => set((state) => {
    const next: Record<string, LastRunRecord> = Object.fromEntries(records
      .filter((record) => record.outcome === 'failed')
      .map((record) => [record.skillId, record]))
    // Polling returns the same records most of the time: keep the reference.
    return JSON.stringify(next) === JSON.stringify(state.lastRunFailures) ? {} : { lastRunFailures: next }
  }),

  // Team key vault
  teamKeyVault: EMPTY_TEAM_KEY_VAULT_STATE,
  setTeamKeyVault: (teamKeyVault) => set({ teamKeyVault }),
  keysPageIntent: null,
  setKeysPageIntent: (keysPageIntent) => set({ keysPageIntent }),

  // Skill organizer
  organizer: emptyOrganizerState(),
  organizerAccount: null,
  organizerProblem: null,
  loadOrganizer: async () => {
    const { authStatus, currentUser, organizerAccount } = get()
    if (authStatus === 'restoring') return
    const accountKey = organizerAccountKey(currentUser?.id)
    const epoch = organizerEpoch
    const loadKey = `${epoch}:${accountKey}`
    if (organizerAccount === accountKey || organizerLoadInFlight === loadKey) return
    organizerLoadInFlight = loadKey
    try {
      await flushOrganizerSave()
      const loaded = await organizerPersistence.load(accountKey)
      const now = get()
      if (epoch !== organizerEpoch || now.authStatus === 'restoring' || organizerAccountKey(now.currentUser?.id) !== accountKey) return
      set({ organizer: loaded, organizerAccount: accountKey, organizerProblem: null })
    } catch (error) {
      const now = get()
      if (epoch === organizerEpoch && organizerAccountKey(now.currentUser?.id) === accountKey) {
        set({ organizerProblem: `无法读取目录：${error instanceof Error ? error.message : String(error)}` })
      }
    } finally {
      if (organizerLoadInFlight === loadKey) organizerLoadInFlight = null
    }
  },
  mutateOrganizer: (mutate) => {
    const state = get()
    const accountKey = state.organizerAccount
    if (!accountKey || accountKey !== organizerAccountKey(state.currentUser?.id)) {
      return state.organizerProblem ?? '目录数据尚未加载，请稍后再试'
    }
    const result = mutate(state.organizer)
    let next: OrganizerState
    if ('ok' in result) {
      if (!result.ok) return result.error
      next = result.state
    } else next = result
    if (next === state.organizer) return null
    set({ organizer: next, organizerProblem: null })
    scheduleOrganizerSave(accountKey, next)
    return null
  },
  tagGroupFocus: null,
  openTagGroup: (tagName) => {
    const key = tagKey(tagName)
    if (!key) return
    get().mutateOrganizer(state => setTagCollapsed(state, tagName, false))
    set((state) => ({
      view: 'skills',
      skillTab: 'tags',
      // Keep the open Skill detail when already on 我的 Skills; leaving another view closes sheets like setView.
      sheet: state.view === 'skills' ? state.sheet : null,
      tagGroupFocus: { key, nonce: (state.tagGroupFocus?.nonce ?? 0) + 1 },
    }))
  },
  clearTagGroupFocus: (nonce) => set(state => state.tagGroupFocus?.nonce === nonce ? { tagGroupFocus: null } : {}),
  skillReveal: null,
  revealSkill: (skillId) => set((state) => ({
    view: 'skills',
    skillTab: 'skillhub',
    searchQuery: '',
    categoryFilter: '全部',
    sheet: { kind: 'skill', skillId, tab: state.sheet?.kind === 'skill' ? state.sheet.tab : 'profile' },
    skillReveal: { skillId, nonce: (state.skillReveal?.nonce ?? 0) + 1 },
  })),
  clearSkillReveal: (nonce) => set(state => state.skillReveal?.nonce === nonce ? { skillReveal: null } : {}),
  organizerSync: { ...INITIAL_ORGANIZER_SYNC_STATUS },
  setOrganizerSyncCapability: (capability, probeFailed = false) => set(state => state.organizerSync.capability === capability && state.organizerSync.probeFailed === probeFailed
    ? {}
    : { organizerSync: { ...state.organizerSync, capability, probeFailed, error: capability === 'supported' ? state.organizerSync.error : null } }),
  runOrganizerSync: () => {
    const start = get()
    const userId = start.currentUser?.id
    if (start.organizerSync.capability !== 'supported' || !start.authSpace || !userId || start.organizerAccount !== userId) return Promise.resolve(null)
    if (organizerSyncFlight?.accountKey === userId && !organizerSyncFlight.controller.signal.aborted) return organizerSyncFlight.promise
    const controller = new AbortController()
    const accountKey = userId
    const space = start.authSpace
    const read = (): OrganizerState | null => {
      const state = get()
      return !controller.signal.aborted && state.authSpace === space && state.currentUser?.id === accountKey && state.organizerAccount === accountKey ? state.organizer : null
    }
    const promise = (async (): Promise<OrganizerSyncOutcome | null> => {
      set(state => ({ organizerSync: { ...state.organizerSync, running: true } }))
      let api: OrganizerSyncApi
      try {
        api = await organizerSyncApi({ space, signal: controller.signal, timeoutMs: ORGANIZER_SYNC_REQUEST_TIMEOUT_MS })
      } catch (error) {
        if (read()) set(state => ({ organizerSync: { ...state.organizerSync, running: false, error: error instanceof Error ? error.message : String(error) } }))
        return null
      }
      const outcome = await syncOrganizerOnce({
        api,
        read,
        commit: (update) => {
          const latest = read()
          if (!latest) return false
          const next = update(latest)
          if (next !== latest) {
            set({ organizer: next })
            scheduleOrganizerSave(accountKey, next)
          }
          return true
        },
      })
      if (read()) {
        set(state => ({ organizerSync: { ...state.organizerSync, running: false, error: outcome.ok ? null : outcome.aborted ? state.organizerSync.error : outcome.error } }))
      }
      return outcome
    })().finally(() => {
      if (organizerSyncFlight?.controller === controller) organizerSyncFlight = null
    })
    organizerSyncFlight = { accountKey, controller, promise }
    return promise
  },
  reconcileOrganizer: (skills, { prune }) => {
    const state = get()
    const accountKey = state.organizerAccount
    if (!accountKey || accountKey !== organizerAccountKey(state.currentUser?.id)) return
    const userId = state.currentUser?.id ?? null
    let next = rekeyOrganizer(state.organizer, skills, userId)
    if (prune) next = pruneQuickAccess(next, new Set(skills.map(skill => skillOrganizerKey(skill, userId))))
    if (next === state.organizer) return
    set({ organizer: next })
    scheduleOrganizerSave(accountKey, next)
  },
}))

/** Credential-free handle captured by long-running account operations. */
export function readAuthSpace(): SpaceHandle | null { return useStore.getState().authSpace }
