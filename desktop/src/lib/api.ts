/** Fixed-route client; Rust alone owns login credentials. */

import type { AuthUser } from './auth.ts'
import { OFFICIAL_ENDPOINTS } from './official-endpoints.ts'
import { notifyEnvReadinessChanged } from './env-readiness.ts'
import { currentSpace, serverRequest, cancelServerRequest, clearNativeAuthSession, type SpaceHandle } from './tauri.ts'
import { resolveServerRoute } from './server-routes.ts'
import { currentMediaSpace } from './tauri.ts'
import { restoreMediaContext, setMediaContext } from './media.ts'
import { cachedCatalog, catalogOfflineAt, CATALOG_INSTALL_OFFLINE } from './catalog-cache.ts'

export function normalizeTrustedServerOrigin(value: unknown): string {
  if (typeof value !== 'string') throw new Error('SkillHub server origin is missing')
  const candidate = value.trim()
  const parsed = new URL(candidate)
  if (
    parsed.protocol !== 'https:'
    || !parsed.hostname
    || parsed.username
    || parsed.password
    || parsed.search
    || parsed.hash
  ) {
    throw new Error('SkillHub server origin must be a trusted HTTPS origin without credentials, query, or fragment')
  }
  return candidate.replace(/\/+$/, '')
}

export const SERVER_ORIGIN = normalizeTrustedServerOrigin(OFFICIAL_ENDPOINTS.serverOrigin)

type FetchOptions = {
  method?: string
  body?: unknown
  preserveSessionOn401?: boolean
  timeoutMs?: number
  space?: SpaceHandle
  signal?: AbortSignal
}
type UnauthorizedListener = (space: SpaceHandle, clearedSpace: SpaceHandle) => void | Promise<void>

const unauthorizedListeners = new Set<UnauthorizedListener>()

export function onApiUnauthorized(listener: UnauthorizedListener): () => void {
  unauthorizedListeners.add(listener)
  return () => unauthorizedListeners.delete(listener)
}

export function sameSpace(left: SpaceHandle | null | undefined, right: SpaceHandle | null | undefined): boolean {
  return Boolean(left && right && left.spaceId === right.spaceId && left.generation === right.generation)
}

export async function notifyApiUnauthorized(space: SpaceHandle): Promise<void> {
  const clearedSpace = await clearNativeAuthSession(space)
  if (!clearedSpace || !sameSpace(await currentSpace(), clearedSpace)) return
  await Promise.allSettled([...unauthorizedListeners].map(listener => listener(space, clearedSpace)))
}

export type ApiErrorKind = 'http' | 'timeout' | 'aborted' | 'network'

/**
 * Keeps the transport facts callers need to back off correctly. `message`
 * stays the server text (or the native fetch text) so existing display and
 * translation paths read it unchanged.
 */
export class ApiError extends Error {
  readonly kind: ApiErrorKind
  readonly status: number | null
  readonly code: string | null
  readonly reason: string | null
  readonly path: string | null
  readonly retryAfterSeconds: number | null

  constructor(kind: ApiErrorKind, message: string, details: { status?: number; code?: string | null; reason?: string | null; path?: string | null; retryAfterSeconds?: number | null } = {}) {
    super(message)
    this.name = 'ApiError'
    this.kind = kind
    this.status = details.status ?? null
    this.code = details.code ?? null
    this.reason = details.reason ?? null
    this.path = details.path ?? null
    this.retryAfterSeconds = details.retryAfterSeconds ?? null
  }
}

/** Retry-After as delta-seconds or an HTTP date; null when absent or unusable. */
export function parseRetryAfter(value: string | null, now = Date.now()): number | null {
  if (!value) return null
  const trimmed = value.trim()
  if (/^\d+$/.test(trimmed)) return Number(trimmed)
  const date = Date.parse(trimmed)
  return Number.isNaN(date) ? null : Math.max(0, Math.ceil((date - now) / 1000))
}

async function responseError(response: Response): Promise<ApiError> {
  const payload = await response.json().catch(() => null) as { message?: unknown; error?: unknown; code?: unknown; reason?: unknown; path?: unknown } | null
  const text = typeof payload?.message === 'string' ? payload.message
    : typeof payload?.error === 'string' ? payload.error
      : `${response.status} ${response.statusText}`
  return new ApiError('http', text, {
    status: response.status,
    code: typeof payload?.code === 'string' ? payload.code : null,
    reason: typeof payload?.reason === 'string' ? payload.reason : null,
    path: typeof payload?.path === 'string' ? payload.path : null,
    retryAfterSeconds: parseRetryAfter(response.headers.get('Retry-After')),
  })
}

async function apiResponse(path: string, options: FetchOptions = {}): Promise<Response> {
  const catalogRequest = resolveServerRoute(path, options.method ?? 'GET').route.startsWith('marketplace.')
  const preserveSession = catalogRequest || options.preserveSessionOn401
  const timeoutMs = options.timeoutMs && options.timeoutMs > 0 ? options.timeoutMs : 0
  const requestId = crypto.randomUUID()
  const controller = new AbortController()
  let space: SpaceHandle | undefined
  let timedOut = false
  const abort = (): void => controller.abort()
  if (options.signal?.aborted) abort()
  else options.signal?.addEventListener('abort', abort, { once: true })
  const timeout = timeoutMs
    ? setTimeout(() => { timedOut = true; controller.abort() }, timeoutMs)
    : null
  const abortedError = (): ApiError => timedOut
    ? new ApiError('timeout', 'Request timed out') : new ApiError('aborted', 'Request aborted')
  let rejectAbort: () => void = () => {}
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectAbort = (): void => {
      if (space) void cancelServerRequest(space, requestId).catch(() => {})
      reject(abortedError())
    }
    controller.signal.addEventListener('abort', rejectAbort, { once: true })
  })
  const send = async (): Promise<Response> => {
    if (controller.signal.aborted) throw abortedError()
    const route = resolveServerRoute(path, options.method ?? 'GET')
    const capturedSpace = options.space ?? await currentSpace()
    space = { spaceId: capturedSpace.spaceId, generation: capturedSpace.generation }
    if (controller.signal.aborted) throw abortedError()
    const response = await serverRequest({
      ...route, requestId, space, timeoutMs,
      body: options.body === undefined ? undefined : { kind: 'json', value: options.body },
    })
    const current = await currentSpace()
    if (controller.signal.aborted || !sameSpace(current, response.space ?? space)) {
      throw new ApiError('aborted', 'Request aborted')
    }
    const body = response.body.kind === 'empty' ? null
      : response.body.kind === 'json' ? JSON.stringify(response.body.value)
        : new Uint8Array(response.body.value)
    return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers })
  }
  let response: Response
  try {
    response = await Promise.race([send(), aborted])
  } catch (error: unknown) {
    if (controller.signal.aborted) throw abortedError()
    if (error instanceof ApiError) throw error
    const message = error instanceof Error ? error.message : String(error)
    if (message === 'SkillHub 请求超时，请重试') throw new ApiError('timeout', 'Request timed out')
    if (['SkillHub 请求已取消', 'SkillHub 空间或账号已切换，本次请求结果已丢弃', 'SkillHub APP 正在同步账号，请稍后重试'].includes(message)) {
      throw new ApiError('aborted', 'Request aborted')
    }
    if (message === '请先在 SkillHub APP 登录') {
      if (space && !preserveSession) await notifyApiUnauthorized(space)
      throw new ApiError('http', message, { status: 401 })
    }
    throw new ApiError('network', message)
  } finally {
    if (timeout !== null) clearTimeout(timeout)
    options.signal?.removeEventListener('abort', abort)
    controller.signal.removeEventListener('abort', rejectAbort)
  }
  if (response.status === 401 && space && !preserveSession) await notifyApiUnauthorized(space)
  return response
}

async function apiFetch<T>(path: string, options: FetchOptions = {}): Promise<T> {
  const response = await apiResponse(`/api${path}`, options)
  if (!response.ok) throw await responseError(response)
  if (response.status === 204) return undefined as T
  return response.json() as Promise<T>
}

export type ApiTeam = {
  id: string
  name: string
  description?: string | null
  color: string
  avatarUrl?: string | null
  role: 'owner' | 'member'
  memberCount: number
  sharedCount: number
  /** Team keys (#293); absent on older Servers. */
  credentialCount?: number
  dissolvedAt?: string | null
}

export type MarketplaceRole = 'user' | 'admin'
export type ApiUser = {
  id: string
  displayName: string
  avatarUrl?: string | null
  email?: string
  marketplaceRole?: MarketplaceRole
}
export type ApiAuthUser = AuthUser & { marketplaceRole?: MarketplaceRole }
export type ApiTeamMember = { teamId: string; userId: string; role: 'owner' | 'member'; joinedAt: string; user: ApiUser }
export type ApiJoinRequest = { id: string; teamId: string; applicantId: string; status: string; createdAt: string; applicant: ApiUser }
export type ApiTeamDetail = {
  id: string
  name: string
  description?: string | null
  color: string
  avatarUrl?: string | null
  ownerId: string
  createdAt: string
  updatedAt?: string
  dissolvedAt?: string | null
  owner: ApiUser
  members: ApiTeamMember[]
  _count: { skillShares: number }
  credentialCount?: number
}

/** One 团队动态 row (#293): names and ids only, never key values. */
export type ApiTeamActivity = {
  id: string
  type: string
  actor: { id: string; displayName: string; avatarUrl?: string | null } | null
  payload: Record<string, unknown>
  createdAt: string
}
export type ApiTeamActivityPage = { items: ApiTeamActivity[]; nextBefore: string | null }

export type ApiTeamInvite = {
  token: string
  deepLink?: string
  landingPageUrl?: string
  expiresAt: string
  team: Pick<ApiTeam, 'id' | 'name' | 'color' | 'avatarUrl'>
}

export type ApiTeamInviteAcceptance = {
  joined: boolean
  alreadyMember: boolean
  team: Pick<ApiTeam, 'id' | 'name' | 'color' | 'avatarUrl'>
}

export type ApiSkill = {
  analysisStatus?: 'unanalysed' | 'completed'
  id: string
  name: string
  displayName: string
  avatarUrl?: string | null
  avatarStatus?: string
  description?: string
  /** 「来源」 (#329). Absent from older Servers; null when unset. In PATCH, omitted keeps and null clears. */
  sourceUrl?: string | null
  category?: string
  labels: string[]
  triggerScenarios: string[]
  compatibleAgents: string[]
  envDependencies?: { key: string; description?: string; required: boolean; obtain?: string }[]
  currentVersion: string
  installCount: number
  authorId: string
  visibility: string
  marketplaceStatus: string
  createdAt: string
  updatedAt: string
  author?: ApiUser
  teamShares?: { teamId: string }[]
  /** Team scope only (#293): who shared it to the requested team, and when. */
  sharedBy?: { id: string; displayName: string; avatarUrl?: string | null } | null
  sharedAt?: string | null
}

export type MarketplaceSubmissionStatus =
  | 'submitted'
  | 'under_review'
  | 'approved'
  | 'rejected'
  | 'withdrawn'

export type ApiMarketplaceVersion = {
  id: string
  version: string
  changelog?: string | null
  packageSha256?: string | null
  packageSize?: number | null
  createdAt: string
}

export type ApiMarketplaceItem = {
  id: string
  listingId?: string
  name: string
  displayName: string
  avatarUrl?: string | null
  avatarStatus?: string
  description?: string | null
  /** The approved listing version's 「来源」 (#329); absent from older Servers. */
  sourceUrl?: string | null
  category?: string | null
  labels: string[]
  triggerScenarios: string[]
  compatibleAgents: string[]
  envDependencies: { key: string; description?: string; required: boolean; obtain?: string }[]
  currentVersion: string
  author: ApiUser
  version: ApiMarketplaceVersion
  downloadCount: number
  installCount?: number
  userCount?: number
  /** Signed-in accounts that currently manage this listing; falls back to `userCount`. */
  managedUserCount?: number
  /** Store badges in server order (精选 / 原创 / 热门 / 新上架); 热门 and 新上架 are server-computed only. */
  badges?: Array<MarketplaceBadge>
  featured?: boolean
  original?: boolean
  editorialLabels?: string[]
  publishedAt: string
  /** First listing time; a new version does not move it. */
  firstPublishedAt?: string | null
  skillMd?: string
}

export type MarketplaceBadge = 'featured' | 'original' | 'hot' | 'new'

/** Server-side growth for one listing on the trending board; growthPercent is null without a previous period. */
export type ApiMarketplaceTrend = {
  recentInstalls: number
  previousInstalls: number
  growthPercent: number | null
}

export type ApiMarketplaceTrendingItem = ApiMarketplaceItem & { trend?: ApiMarketplaceTrend | null }

export type ApiMarketplaceTrending = {
  range: 'day' | 'week'
  items: ApiMarketplaceTrendingItem[]
}

export type ApiMarketplaceStats = {
  totalSkills: number
  newThisWeek: number
  installsToday: number
  activeAuthors: number
  /** Oldest first. */
  dailyInstalls: number[]
  /** Oldest first; the last entry is the current week. */
  weeklyNewSkills: number[]
  generatedAt?: string
}

export type ApiMarketplaceCatalog = {
  items: ApiMarketplaceItem[]
  /** Full catalog facet, independent of the current page. */
  categories?: string[]
  total: number
  page: number
  pageSize: number
}

export type ApiMarketplaceCategory = {
  id: string
  slug: string
  name: string
  description?: string | null
  sortOrder: number
}

export type ApiMarketplaceTopic = {
  id: string
  slug: string
  title: string
  description?: string | null
  introContent?: string | null
  coverImageUrl?: string | null
  featured: boolean
  sortOrder: number
  publishedAt?: string | null
  updatedAt?: string | null
  /**
   * Article body (#211), only on `GET /marketplace/topics/:slug`; the Server synthesizes it
   * for legacy topics. Absent from the home list and from old Servers (→ the old layout).
   */
  contentMarkdown?: string | null
  /** Public Skills only, in first-occurrence order of the body. */
  items: ApiMarketplaceItem[]
}

export type ApiMarketplaceHome = {
  total: number
  categories: ApiMarketplaceCategory[]
  topics: ApiMarketplaceTopic[]
  popularKind: 'hot' | 'latest' | 'recommended'
  popular: ApiMarketplaceItem[]
  latest: ApiMarketplaceItem[]
}

export type MarketplaceCommentVisibility = 'public' | 'team'
export type ApiMarketplaceComment = {
  id: string
  listingSkillId: string
  userId: string
  visibility: MarketplaceCommentVisibility
  teamId: string | null
  parentId?: string | null
  content: string
  createdAt: string
  updatedAt?: string
  user: ApiUser
  replies: ApiMarketplaceComment[]
}

export type ApiMarketplaceInstallIntent = {
  id: string
  listingSkillId: string
  status: 'clicked' | 'completed' | 'failed' | 'cancelled'
  createdAt: string
}

export type ApiMarketplaceListing = {
  submissionId: string
  versionId: string
  version: string
  downloadCount: number
  publishedAt: string
  withdrawnAt?: string | null
}

export type ApiMarketplaceSubmission = {
  id: string
  skillId: string
  version: ApiMarketplaceVersion
  status: MarketplaceSubmissionStatus
  submitterNote?: string | null
  reviewNote?: string | null
  submittedAt: string
  reviewStartedAt?: string | null
  reviewedAt?: string | null
  withdrawnAt?: string | null
}

export type ApiMarketplaceMineItem = {
  skillId: string
  skill: { id: string; name: string; displayName: string; currentVersion: string }
  listing: ApiMarketplaceListing | null
  latestSubmission: ApiMarketplaceSubmission | null
}

export type MarketplaceState = Pick<ApiMarketplaceMineItem, 'listing' | 'latestSubmission'>

export type ApiMarketplaceAdminSubmission = ApiMarketplaceSubmission & {
  skill: {
    id: string
    name: string
    displayName: string
    description?: string | null
    category?: string | null
    labels?: string[]
    compatibleAgents?: string[]
    currentVersion: string
  }
  author: ApiUser
  submittedBy?: ApiUser
  snapshot: {
    name: string
    displayName: string
    description?: string | null
    category?: string | null
    labels: string[]
    triggerScenarios: string[]
    compatibleAgents: string[]
    envDependencies: { key: string; description?: string; required: boolean; obtain?: string }[]
    skillMd: string
  }
}

export type ApiMarketplaceAdminQueue = {
  items: ApiMarketplaceAdminSubmission[]
  total: number
  page: number
  pageSize: number
  totalPages: number
}

export type ApiMarketplacePackageInspectionFile = {
  path: string
  kind: 'directory' | 'text' | 'binary'
  size: number
  content: string | null
}

export type ApiMarketplacePackageInspection = {
  submissionId: string
  versionId: string
  version: string
  packageSha256: string
  packageSize: number
  totalUncompressedBytes: number
  readableTextBytes: number
  files: ApiMarketplacePackageInspectionFile[]
}

export type ApiDeletedSkill = ApiSkill & { deletedAt: string }

export type ApiSkillVersion = {
  id: string
  skillId: string
  version: string
  changelog?: string | null
  gitHash?: string | null
  packageSha256?: string | null
  packageSize?: number | null
  createdAt: string
  aliases?: string[]
  versionMappingDigest?: string | null
}

export type ApiImportResult = {
  skill: ApiSkill
  analysis: { status: 'completed' | 'fallback' | 'recovered' | 'unanalysed'; provider: string | null; redactedSecrets: number }
  recovered?: boolean
  idempotent?: boolean
}

export type ApiComment = {
  id: string
  skillId: string
  teamId: string | null
  userId: string
  parentId?: string | null
  content: string
  createdAt: string
  updatedAt?: string
  user: ApiUser
  mentions: ApiUser[]
  replies: ApiComment[]
}

export type ApiCommentMentionCandidate = ApiUser & {
  teams: Array<{ id: string; name: string }>
  canMention: boolean
  reason: string | null
}

export type ApiNotification = {
  id: string
  type: string
  payload: Record<string, unknown>
  read: boolean
  createdAt: string
}

export type FeedbackType = 'bug' | 'usage' | 'feature' | 'other'
export type FeedbackStatus = 'pending' | 'reviewing' | 'resolved'
export type FeedbackAttachmentInput = {
  fileName: string
  mimeType: 'image/jpeg' | 'image/png' | 'image/webp'
  dataBase64: string
}
export type FeedbackAttachment = {
  id: string
  fileName: string
  mimeType: FeedbackAttachmentInput['mimeType']
  size: number
}
export type ApiFeedback = {
  id: string
  userId: string | null
  type: FeedbackType
  content: string
  contact: string | null
  attachments: FeedbackAttachment[]
  status: FeedbackStatus
  createdAt: string
  updatedAt: string
  user?: { id: string; displayName: string; email: string } | null
}

export type ApiAuthSession = {
  space: SpaceHandle
  user: ApiAuthUser
}

export const apiRegister = (data: { email: string; password: string; displayName: string }): Promise<ApiAuthSession> =>
  apiFetch('/auth/register', { method: 'POST', body: data, preserveSessionOn401: true })
export const apiLogin = (data: { email: string; password: string }): Promise<Pick<ApiAuthSession, 'user'>> =>
  apiFetch('/auth/login', { method: 'POST', body: data, preserveSessionOn401: true })
export const apiGetMe = (options: { timeoutMs?: number; space?: SpaceHandle } = {}): Promise<{ user: ApiAuthUser; tokenIssuedAt?: string; tokenExpiresAt?: string }> =>
  apiFetch('/auth/me', options)
export const apiRenewSession = (space: SpaceHandle): Promise<ApiAuthSession> =>
  apiFetch('/auth/renew', { method: 'POST', space, timeoutMs: 10_000 })
export const apiLogout = (options: { timeoutMs?: number } = {}): Promise<void> =>
  apiFetch('/auth/logout', { method: 'POST', timeoutMs: options.timeoutMs ?? 10_000 })
export const apiLogoutAll = (): Promise<void> =>
  apiFetch('/auth/logout-all', { method: 'POST', timeoutMs: 10_000 })
export const apiUpdateProfile = (data: { displayName?: string; avatarUrl?: string | null }): Promise<{ user: ApiAuthUser }> =>
  apiFetch('/auth/profile', { method: 'PATCH', body: data })
export const apiChangePassword = (data: { currentPassword: string; newPassword: string }): Promise<ApiAuthSession> =>
  apiFetch('/auth/change-password', { method: 'POST', body: data, preserveSessionOn401: true })
export const apiSubmitFeedback = (data: { type: FeedbackType; content: string; contact?: string; attachments?: FeedbackAttachmentInput[]; clientOperationId: string }): Promise<Pick<ApiFeedback, 'id' | 'status' | 'createdAt'>> =>
  apiFetch('/feedback', { method: 'POST', body: data })
export const apiGetFeedback = (status?: FeedbackStatus): Promise<ApiFeedback[]> =>
  apiFetch(`/feedback${status ? `?status=${encodeURIComponent(status)}` : ''}`)
export const apiUpdateFeedbackStatus = (id: string, status: FeedbackStatus): Promise<ApiFeedback> =>
  apiFetch(`/feedback/${encodeURIComponent(id)}`, { method: 'PATCH', body: { status } })

export type ApiHealth = {
  status: string; timestamp?: string; version?: string; capabilities?: string[]
  profile?: 'official' | 'selfhost'
  auth?: { password: boolean; yitanOidc: boolean; registration: 'open' | 'invite' | 'closed' }
  features?: { ai: boolean; avatars: boolean; marketplace: boolean; localAiLeases?: boolean }
  media?: { allowedImageHosts: string[] }
}

/** Candidate requests never use the active-session 401 handler or expose credentials. */
export async function apiCandidate<T>(space: SpaceHandle, path: '/setup/status' | '/setup/admin' | '/auth/login' | '/auth/register' | '/auth/me', body?: unknown): Promise<T> {
  const source = await currentSpace()
  const response = await serverRequest({
    ...resolveServerRoute(`/api${path}`, body === undefined ? 'GET' : 'POST'),
    requestId: crypto.randomUUID(), space, timeoutMs: 20_000,
    body: body === undefined ? undefined : { kind: 'json', value: body },
  })
  if (!sameSpace(source, await currentSpace()) || (response.space && !sameSpace(response.space, space))) {
    throw new ApiError('aborted', '空间已切换')
  }
  const result = new Response(response.body.kind === 'json' ? JSON.stringify(response.body.value)
    : response.body.kind === 'bytes' ? new Uint8Array(response.body.value) : null,
    { status: response.status, statusText: response.statusText, headers: response.headers })
  if (!result.ok) throw await responseError(result)
  return result.json() as Promise<T>
}
export const apiSetupStatus = (space: SpaceHandle): Promise<{ initialized: boolean }> =>
  apiFetch('/setup/status', { space, preserveSessionOn401: true })
export const apiSetupAdmin = (body: { code: string; email: string; displayName: string; password: string }, space: SpaceHandle): Promise<ApiAuthSession> =>
  apiFetch('/setup/admin', { method: 'POST', body, space, preserveSessionOn401: true })
export async function apiHealth(): Promise<ApiHealth> {
  const { space, serverBase, mediaKey, previousOrigins } = await currentMediaSpace()
  if (!sameSpace(space, await currentSpace())) throw new ApiError('aborted', '空间已切换')
  restoreMediaContext(mediaKey, serverBase, previousOrigins)
  const response = await apiResponse('/health', { preserveSessionOn401: true, space })
  if (!response.ok) throw await responseError(response)
  const health = await response.json() as ApiHealth
  if (sameSpace(space, await currentSpace())) {
    const hosts = health.media?.allowedImageHosts
    setMediaContext({ spaceId: mediaKey, serverBase, previousOrigins,
      allowedImageHosts: Array.isArray(hosts) ? hosts.filter((host): host is string => typeof host === 'string') : [] })
  }
  return health
}

/** Only invoked while the user has explicitly opened the official store. */
export async function prepareCatalogMedia(): Promise<void> {
  const { space, serverBase, mediaKey, allowedImageHosts } = await currentMediaSpace(true)
  if (!sameSpace(space, await currentSpace())) return
  setMediaContext({ spaceId: mediaKey, serverBase, allowedImageHosts: allowedImageHosts ?? [] })
}

// ---- Private Skill tags and quick access (#322 Server, #326 Desktop sync) ----
export type ApiLibraryTagSet = { entryId: string; names: string[] }
export type ApiQuickAccessItem = { kind: 'tag' | 'skill'; ref: string }
export type ApiQuickAccess = { revision: number; items: ApiQuickAccessItem[] }
/** Bound to the space of the account that started a sync, and aborted when that account leaves. */
export type ApiCallScope = { space: SpaceHandle; signal?: AbortSignal; timeoutMs?: number }

export const apiGetLibraryTags = (scope: ApiCallScope): Promise<{ tags: ApiLibraryTagSet[] }> =>
  apiFetch('/library/tags', scope)
export const apiPutLibraryTags = (entryId: string, names: string[], scope: ApiCallScope): Promise<ApiLibraryTagSet> =>
  apiFetch(`/library/tags/${encodeURIComponent(entryId)}`, { ...scope, method: 'PUT', body: { names } })
/** Atomic delta (#326): remove by name key, then add, against the stored tags. */
export const apiPatchLibraryTags = (entryId: string, delta: { add: string[]; remove: string[] }, scope: ApiCallScope): Promise<ApiLibraryTagSet> =>
  apiFetch(`/library/tags/${encodeURIComponent(entryId)}`, { ...scope, method: 'PATCH', body: delta })
export const apiRenameLibraryTag = (from: string, to: string, scope: ApiCallScope): Promise<{ tags: ApiLibraryTagSet[]; quickAccess: ApiQuickAccess }> =>
  apiFetch('/library/tags/rename', { ...scope, method: 'POST', body: { from, to } })
export const apiDeleteLibraryTag = (name: string, scope: ApiCallScope): Promise<{ tags: ApiLibraryTagSet[]; quickAccess: ApiQuickAccess }> =>
  apiFetch('/library/tags/delete', { ...scope, method: 'POST', body: { name } })
export const apiGetQuickAccess = (scope: ApiCallScope): Promise<ApiQuickAccess> =>
  apiFetch('/library/quick-access', scope)
export const apiPutQuickAccess = (baseRevision: number, items: ApiQuickAccessItem[], scope: ApiCallScope): Promise<ApiQuickAccess> =>
  apiFetch('/library/quick-access', { ...scope, method: 'PUT', body: { baseRevision, items } })

export const apiGetTeams = (space?: SpaceHandle): Promise<ApiTeam[]> => apiFetch('/teams', { space })
export const apiCreateTeam = (data: { name: string; description?: string; color?: string }): Promise<ApiTeam> =>
  apiFetch('/teams', { method: 'POST', body: data })
export const apiGetTeam = (teamId: string): Promise<ApiTeamDetail> => apiFetch(`/teams/${encodeURIComponent(teamId)}`)
export const apiUpdateTeam = (teamId: string, data: { name?: string; description?: string; color?: string; avatarUrl?: string | null }): Promise<ApiTeamDetail> =>
  apiFetch(`/teams/${encodeURIComponent(teamId)}`, { method: 'PATCH', body: data })
export const apiGetTeamNotifications = (teamId: string): Promise<ApiNotification[]> =>
  apiFetch(`/teams/${encodeURIComponent(teamId)}/notifications`)
export const apiGetTeamActivity = (teamId: string, options: { limit?: number; before?: string | null } = {}): Promise<ApiTeamActivityPage> => {
  const query = new URLSearchParams({ limit: String(options.limit ?? 50) })
  if (options.before) query.set('before', options.before)
  return apiFetch(`/teams/${encodeURIComponent(teamId)}/activity?${query.toString()}`)
}
export const apiRequestJoinTeam = (teamId: string): Promise<ApiJoinRequest> => apiFetch(`/teams/${encodeURIComponent(teamId)}/requests`, { method: 'POST' })
export const apiGetJoinRequests = (teamId: string): Promise<ApiJoinRequest[]> => apiFetch(`/teams/${encodeURIComponent(teamId)}/requests`)
export const apiApproveJoinRequest = (teamId: string, requestId: string, space?: SpaceHandle): Promise<void> => apiFetch(`/teams/${encodeURIComponent(teamId)}/requests/${encodeURIComponent(requestId)}/approve`, { method: 'POST', space })
export const apiRejectJoinRequest = (teamId: string, requestId: string, space?: SpaceHandle): Promise<void> => apiFetch(`/teams/${encodeURIComponent(teamId)}/requests/${encodeURIComponent(requestId)}/reject`, { method: 'POST', space })
export const apiLeaveTeam = (teamId: string): Promise<void> => apiFetch(`/teams/${encodeURIComponent(teamId)}/leave`, { method: 'POST' })
export const apiDissolveTeam = (teamId: string): Promise<void> => apiFetch(`/teams/${encodeURIComponent(teamId)}`, { method: 'DELETE' })
export const apiGetTeamMembers = (teamId: string): Promise<ApiTeamMember[]> => apiFetch(`/teams/${encodeURIComponent(teamId)}/members`)
export const apiKickMember = (teamId: string, userId: string): Promise<void> => apiFetch(`/teams/${encodeURIComponent(teamId)}/members/${encodeURIComponent(userId)}`, { method: 'DELETE' })
export const apiCreateTeamInvite = (teamId: string): Promise<ApiTeamInvite> =>
  apiFetch('/team-invites', { method: 'POST', body: { teamId } })
export const apiGetTeamInvite = (token: string, space?: SpaceHandle): Promise<Omit<ApiTeamInvite, 'token'>> =>
  apiFetch(`/team-invites/${encodeURIComponent(token)}`, { space, preserveSessionOn401: true })
export const apiAcceptTeamInvite = (token: string, space?: SpaceHandle): Promise<ApiTeamInviteAcceptance> =>
  apiFetch(`/team-invites/${encodeURIComponent(token)}/accept`, { space, method: 'POST' })

export type MarketplaceCatalogQuery = {
  featured?: boolean
  query?: string
  category?: string
  label?: string
  agent?: string
  /** none = no env dependency, required = any env dependency. Older servers reject or ignore it. */
  apiKey?: 'none' | 'required'
  /** `rising` is rejected (400) by servers older than #193. */
  sort?: 'latest' | 'downloads' | 'popular' | 'users' | 'rising'
  page?: number
  pageSize?: number
}

function marketplaceCatalogPath(query: MarketplaceCatalogQuery): string {
  const params = new URLSearchParams()
  if (query.featured !== undefined) params.set('featured', String(query.featured))
  if (query.query?.trim()) params.set('query', query.query.trim())
  if (query.category?.trim()) params.set('category', query.category.trim())
  if (query.label?.trim()) params.set('label', query.label.trim())
  if (query.agent?.trim()) params.set('agent', query.agent.trim())
  if (query.apiKey) params.set('apiKey', query.apiKey)
  if (query.sort) params.set('sort', query.sort)
  if (query.page) params.set('page', String(query.page))
  if (query.pageSize) params.set('pageSize', String(query.pageSize))
  const encoded = params.toString()
  return `/marketplace${encoded ? `?${encoded}` : ''}`
}

export const apiGetMarketplace = (query: MarketplaceCatalogQuery = {}): Promise<ApiMarketplaceCatalog> =>
  cachedCatalog(marketplaceCatalogPath(query), () => apiFetch(marketplaceCatalogPath(query)))

export const apiGetMarketplaceHome = (limit = 8): Promise<ApiMarketplaceHome> =>
  cachedCatalog(`/marketplace/home?limit=${limit}`, () => apiFetch(`/marketplace/home?limit=${encodeURIComponent(String(limit))}`))

/** Store dashboard figures. Older servers answer 404; callers hide the panel on any failure. */
export const apiGetMarketplaceStats = (): Promise<ApiMarketplaceStats> =>
  cachedCatalog('/marketplace/stats', () => apiFetch('/marketplace/stats'))

/** Rising listings. Older servers answer 404; callers fall back to the popular ranking. */
export const apiGetMarketplaceTrending = (range: 'day' | 'week', limit: number): Promise<ApiMarketplaceTrending> =>
  cachedCatalog(`/marketplace/trending?range=${range}&limit=${limit}`, () => apiFetch(`/marketplace/trending?${new URLSearchParams({ range, limit: String(limit) }).toString()}`))

export const apiGetMarketplaceCategories = (): Promise<{ items: ApiMarketplaceCategory[] }> =>
  cachedCatalog('/marketplace/categories', () => apiFetch('/marketplace/categories'))

export const apiGetMarketplaceTopic = (slug: string): Promise<ApiMarketplaceTopic> =>
  cachedCatalog(`/marketplace/topics/${encodeURIComponent(slug)}`, () => apiFetch(`/marketplace/topics/${encodeURIComponent(slug)}`))

function marketplaceClientId(): string {
  const key = 'yitan-skillhub.marketplace-client.v1'
  const existing = localStorage.getItem(key)
  if (existing) return existing
  const created = crypto.randomUUID()
  localStorage.setItem(key, created)
  return created
}

export const apiCreateMarketplaceInstallIntent = async (
  skillId: string,
  idempotencyKey: string,
  source: 'app' | 'web' = 'app',
  operationKind: 'join' | 'agent' = 'agent',
): Promise<ApiMarketplaceInstallIntent | undefined> => {
  const space = await currentSpace()
  if (space.spaceId !== 'official') return undefined
  return apiFetch(
  `/marketplace/${encodeURIComponent(skillId)}/install-intents`,
  {
    method: 'POST',
    space,
    body: {
      idempotencyKey,
      clientId: marketplaceClientId(),
      source, operationKind,
      platform: navigator.userAgent.includes('Windows') ? 'windows' : 'macos',
    },
    preserveSessionOn401: true,
  },
  )
}

export const apiFinishMarketplaceInstallIntent = async (
  intentId: string,
  status: 'completed' | 'failed' | 'cancelled',
): Promise<ApiMarketplaceInstallIntent | undefined> => {
  const space = await currentSpace()
  if (space.spaceId !== 'official') return undefined
  return apiFetch(
  `/marketplace/install-intents/${encodeURIComponent(intentId)}`,
  { method: 'PATCH', body: { status }, preserveSessionOn401: true, space },
  )
}

export const apiGetMarketplaceComments = (
  skillId: string,
  visibility: MarketplaceCommentVisibility,
  teamId?: string,
): Promise<{ items: ApiMarketplaceComment[] }> => apiFetch(
  visibility === 'public'
    ? `/marketplace/${encodeURIComponent(skillId)}/comments`
    : `/marketplace/${encodeURIComponent(skillId)}/team-comments?teamId=${encodeURIComponent(teamId ?? '')}`,
  visibility === 'public' ? { preserveSessionOn401: true } : {},
)

export const apiPostMarketplaceComment = (
  skillId: string,
  data: { visibility: MarketplaceCommentVisibility; teamId?: string; parentId?: string; content: string },
): Promise<ApiMarketplaceComment> => apiFetch(
  `/marketplace/${encodeURIComponent(skillId)}/comments`,
  { method: 'POST', body: data },
)

export const apiDeleteMarketplaceComment = (commentId: string): Promise<void> =>
  apiFetch(`/marketplace/comments/${encodeURIComponent(commentId)}`, { method: 'DELETE' })

export const apiSyncMarketplacePresence = async (
  deviceId: string,
  activeListingIds: string[],
): Promise<{ activeListingIds: string[]; syncedAt: string }> => {
  const space = await currentSpace()
  if (space.spaceId !== 'official') return { activeListingIds: [], syncedAt: '' }
  return apiFetch(
  '/marketplace/presence/sync',
  { method: 'POST', body: { deviceId, activeListingIds }, space },
  )
}

export const apiGetMarketplaceSkill = (skillId: string): Promise<ApiMarketplaceItem> =>
  cachedCatalog(`/marketplace/${encodeURIComponent(skillId)}`, () => apiFetch(`/marketplace/${encodeURIComponent(skillId)}`))

export const apiGetMarketplaceMine = (): Promise<{ items: ApiMarketplaceMineItem[] }> =>
  apiFetch('/marketplace/mine')

export async function apiGetMarketplaceState(skillId: string): Promise<MarketplaceState> {
  const mine = await apiGetMarketplaceMine()
  const item = mine.items.find((candidate) => candidate.skillId === skillId)
  return {
    listing: item?.listing ?? null,
    latestSubmission: item?.latestSubmission ?? null,
  }
}

export const apiSubmitMarketplaceSkill = (
  skillId: string,
  data: { versionId: string; note?: string },
): Promise<ApiMarketplaceSubmission> => apiFetch(
  `/marketplace/skills/${encodeURIComponent(skillId)}/submissions`,
  { method: 'POST', body: data },
)

export const apiWithdrawMarketplaceSubmission = (
  submissionId: string,
): Promise<ApiMarketplaceSubmission> => apiFetch(
  `/marketplace/submissions/${encodeURIComponent(submissionId)}/withdraw`,
  { method: 'POST' },
)

export const apiUnpublishMarketplaceSkill = (skillId: string): Promise<void> =>
  apiFetch(`/marketplace/skills/${encodeURIComponent(skillId)}`, { method: 'DELETE' })

export const apiGetMarketplaceAdminSubmissions = (
  status: MarketplaceSubmissionStatus,
  page = 1,
  pageSize = 25,
): Promise<ApiMarketplaceAdminQueue> => {
  const params = new URLSearchParams({
    status,
    page: String(page),
    pageSize: String(pageSize),
  })
  return apiFetch(`/marketplace/admin/submissions?${params.toString()}`)
}

export const apiGetMarketplaceAdminSubmission = (
  submissionId: string,
): Promise<ApiMarketplaceAdminSubmission> => apiFetch(
  `/marketplace/admin/submissions/${encodeURIComponent(submissionId)}`,
)

export const apiGetMarketplacePackageInspection = (
  submissionId: string,
): Promise<ApiMarketplacePackageInspection> => apiFetch(
  `/marketplace/admin/submissions/${encodeURIComponent(submissionId)}/package-inspection`,
)

export const apiStartMarketplaceReview = (
  submissionId: string,
): Promise<ApiMarketplaceSubmission> => apiFetch(
  `/marketplace/admin/submissions/${encodeURIComponent(submissionId)}/start`,
  { method: 'POST' },
)

export const apiApproveMarketplaceSubmission = (
  submissionId: string,
  data: { note?: string } = {},
): Promise<ApiMarketplaceSubmission> => apiFetch(
  `/marketplace/admin/submissions/${encodeURIComponent(submissionId)}/approve`,
  { method: 'POST', body: data },
)

export const apiRejectMarketplaceSubmission = (
  submissionId: string,
  data: { reason: string },
): Promise<ApiMarketplaceSubmission> => apiFetch(
  `/marketplace/admin/submissions/${encodeURIComponent(submissionId)}/reject`,
  { method: 'POST', body: data },
)

export const apiGetMySkills = (space?: SpaceHandle): Promise<ApiSkill[]> => apiFetch('/skills', { space })

export type InstanceSource = 'env' | 'setting' | 'none'
export type InstanceFalSettings = { configured: boolean; source: InstanceSource; masked?: string; lastTest?: { ok: boolean; at: string } }
export type AvatarStyle = {
  styleId: string; styleVersion: number; status: 'published' | 'test'
  name: { zh: string; en: string }; description: { zh: string; en: string }
  preview: { url: string | null; license: string; attribution: string }
}
export type AvatarStyleSelection = { accountStyleId: string | null; instanceStyleId: string; styleId: string; styleVersion: number; scope: 'instance' | 'account'; canManage: boolean }
export type AvatarStylePreview = {
  scope: 'instance' | 'account'; currentStyleId: string; targetStyleId: string; targetStyleVersion: number
  total: number; reusable: number; needsGeneration: number; customSkipped: number; inFlight: number
  estimatedCostUsd: number | null; perImageUsd: number | null; quota: { limit: number; used: number; remaining: number }; coverable: number
}
export type AvatarStyleApply = { styleId: string; mode: 'newOnly' | 'applyExisting'; includeCustom: boolean }
export type AvatarStyleResult = { styleId: string; styleVersion: number; reused: number; queued: number; skippedCustom: number; deferredByQuota: number; cancelledUnsubmitted: number }
export const apiInstanceFal = (space: SpaceHandle): Promise<InstanceFalSettings> => apiFetch('/instance/settings/fal', { space })
export const apiInstanceFalTest = (apiKey: string, space: SpaceHandle): Promise<{ ok: true; latencyMs: number; draftToken: string }> =>
  apiFetch('/instance/settings/fal/test', { method: 'POST', body: { apiKey }, space })
export const apiInstanceFalSave = (body: { apiKey: string; draftToken: string }, space: SpaceHandle): Promise<InstanceFalSettings> =>
  apiFetch('/instance/settings/fal', { method: 'PUT', body, space })
export const apiInstanceFalDelete = (space: SpaceHandle): Promise<void> => apiFetch('/instance/settings/fal', { method: 'DELETE', space })
export const apiAvatarStyles = (space: SpaceHandle): Promise<AvatarStyle[]> => apiFetch('/avatar-styles', { space })
export const apiAvatarStyle = (space: SpaceHandle): Promise<AvatarStyleSelection> => apiFetch('/skill-avatars/style', { space })
export const apiAvatarStylePreview = (styleId: string, space: SpaceHandle): Promise<AvatarStylePreview> =>
  apiFetch('/skill-avatars/style/preview', { method: 'POST', body: { styleId }, space })
export const apiAvatarStyleApply = (body: AvatarStyleApply, space: SpaceHandle): Promise<AvatarStyleResult> =>
  apiFetch('/skill-avatars/style/apply', { method: 'POST', body, space })
export type AiProtocol = 'openai' | 'anthropic' | 'openai-responses'
export type InstanceAiPolicy = { limits: { instanceDaily: number; perUserDaily: number }; allowedPrivateHosts: string[] }
export type InstanceAiSettings = InstanceAiPolicy & {
  source: InstanceSource; protocol: AiProtocol | null; baseUrl: string | null; model: string | null; keyLast4: string | null
  lastTest: { ok: boolean; at: string; latencyMs: number } | null
}
export type InstanceAiDraft = { protocol: AiProtocol; baseUrl: string; model: string; apiKey?: string }
export type AnalysisPreview = { total: number; eligible: number; coverable: number; remaining: { instance: number; user: number } }
export type AnalysisBatch = { batchId: string; queued: number; skipped: number; completed: number; failed: number; state: 'queued' | 'running' | 'completed' | 'cancelled' }
export type InstanceMember = { id: string; displayName: string; email: string; role: 'admin' | 'member'; createdAt: string }
export type InstanceRegistration = { source: InstanceSource; mode: 'open' | 'invite' | 'closed'; inviteCodeMask: string | null }
export type InstanceAddress = { baseUrl: string; https: boolean; certificate: string | null }
export type InstanceDirectory = { bytes: number; entries: number; complete: boolean }
export type InstanceOverview = {
  memberCount: number; registration: InstanceRegistration; addresses: { primary: InstanceAddress; additional: InstanceAddress[] }
  storage: { provider: string; media: InstanceDirectory; cards: InstanceDirectory; measuredAt: string }
  aiUsage: { used: number; limit: number }; minClientVersion: string | null; version: { server: string; buildId: string }
}
export const apiInstanceAiStatus = (space: SpaceHandle): Promise<{ configured: boolean; source: InstanceSource }> =>
  apiFetch('/instance/ai/status', { space })
export const apiInstanceAi = (space: SpaceHandle): Promise<InstanceAiSettings> => apiFetch('/instance/settings/ai', { space })
export const apiInstanceAiModels = (body: Omit<InstanceAiDraft, 'model'>, space: SpaceHandle): Promise<{ models: string[] }> =>
  apiFetch('/instance/settings/ai/models', { method: 'POST', body, space })
export const apiInstanceAiTest = (body: InstanceAiDraft, space: SpaceHandle): Promise<{ ok: true; latencyMs: number; draftToken: string }> =>
  apiFetch('/instance/settings/ai/test', { method: 'POST', body, space })
export const apiInstanceAiSave = (body: InstanceAiDraft & { draftToken: string }, space: SpaceHandle): Promise<InstanceAiSettings> =>
  apiFetch('/instance/settings/ai', { method: 'PUT', body, space })
export const apiInstanceAiDelete = (space: SpaceHandle): Promise<void> => apiFetch('/instance/settings/ai', { method: 'DELETE', space })
export const apiInstanceAiPolicy = (body: InstanceAiPolicy, space: SpaceHandle): Promise<InstanceAiSettings> =>
  apiFetch('/instance/settings/ai/policy', { method: 'PUT', body, space })
export const apiAnalysisPreview = (skillIds: string[], space: SpaceHandle): Promise<AnalysisPreview> =>
  apiFetch('/skills/analysis/batches/preview', { method: 'POST', body: { skillIds }, space })
export const apiAnalysisSubmit = (skillIds: string[], space: SpaceHandle): Promise<AnalysisBatch> =>
  apiFetch('/skills/analysis/batches', { method: 'POST', body: { skillIds, confirm: true, aiAnalysisConsent: true }, space })
export const apiAnalysisBatch = (id: string, space: SpaceHandle): Promise<AnalysisBatch> =>
  apiFetch(`/skills/analysis/batches/${encodeURIComponent(id)}`, { space })
export const apiInstanceOverview = (space: SpaceHandle): Promise<InstanceOverview> => apiFetch('/instance/settings/overview', { space })
export const apiInstanceMembers = (offset: number, space: SpaceHandle): Promise<{ total: number; members: InstanceMember[] }> =>
  apiFetch(`/instance/settings/members?offset=${offset}&limit=100`, { space })
export const apiInstanceRole = (id: string, role: InstanceMember['role'], space: SpaceHandle): Promise<InstanceMember> =>
  apiFetch(`/instance/settings/members/${encodeURIComponent(id)}/role`, { method: 'PUT', body: { role }, space })
export const apiInstanceRegistration = (mode: InstanceRegistration['mode'], space: SpaceHandle): Promise<InstanceRegistration> =>
  apiFetch('/instance/settings/registration', { method: 'PUT', body: { mode }, space })
export const apiInstanceInvite = (space: SpaceHandle): Promise<InstanceRegistration & { inviteCode: string }> =>
  apiFetch('/instance/settings/registration/regenerate', { method: 'POST', space })

/** `localSkillId` is null for the owner's cloud-only tasks, listed so their display source survives a new session. */
export type ApiSkillAvatar = { localSkillId?: string | null; skillId?: string | null; aliases?: string[]; avatarUrl: string | null; avatarStatus: string; avatarSource?: 'generated' | 'custom' }
/** The same identity and sanitized introduction as `apiEnsureSkillAvatar`. */
export type SkillAvatarRegistration = {
  localSkillId: string; aliasLocalIds?: string[]; skillId?: string | null; name: string; description: string; scenarios: string[]
}
export type CustomAvatarImage = { mimeType: 'image/webp' | 'image/jpeg' | 'image/png'; dataBase64: string }
const registrationBody = (body: SkillAvatarRegistration): Record<string, unknown> => ({
  ...body, aliasLocalIds: body.aliasLocalIds?.length ? body.aliasLocalIds : undefined, skillId: body.skillId ?? undefined,
})
/** Custom avatar upload (#214) for a local Skill; creates an upload-only task when none is registered yet. */
export const apiUploadSkillAvatar = (body: SkillAvatarRegistration, image: CustomAvatarImage, space: SpaceHandle): Promise<ApiSkillAvatar> =>
  apiFetch('/skill-avatars/local/custom', { method: 'POST', body: { ...registrationBody(body), image }, space, timeoutMs: 60_000 })
export const apiUploadCloudSkillAvatar = (skillId: string, image: CustomAvatarImage, space: SpaceHandle): Promise<ApiSkillAvatar> =>
  apiFetch('/skill-avatars/skills/' + encodeURIComponent(skillId) + '/custom', { method: 'POST', body: { image }, space, timeoutMs: 60_000 })
/** 恢复自动生成: may queue one paid generation; a full daily quota keeps the custom image (429). */
export const apiRestoreSkillAvatar = (localSkillId: string, space: SpaceHandle): Promise<ApiSkillAvatar> =>
  apiFetch('/skill-avatars/local/' + encodeURIComponent(localSkillId) + '/custom', { method: 'DELETE', space, timeoutMs: 15_000 })
export const apiRestoreCloudSkillAvatar = (skillId: string, space: SpaceHandle): Promise<ApiSkillAvatar> =>
  apiFetch('/skill-avatars/skills/' + encodeURIComponent(skillId) + '/custom', { method: 'DELETE', space, timeoutMs: 15_000 })
export const apiGetSkillAvatars = (space: SpaceHandle, signal: AbortSignal): Promise<{ items: ApiSkillAvatar[] }> =>
  apiFetch('/skill-avatars/local', { space, signal, timeoutMs: 15_000 })
export const apiEnsureSkillAvatar = (body: {
  localSkillId: string; aliasLocalIds?: string[]; skillId?: string | null; name: string; description: string; scenarios: string[]
}, space: SpaceHandle, signal: AbortSignal): Promise<ApiSkillAvatar> =>
  apiFetch('/skill-avatars/local', { method: 'POST', body: { ...body, aliasLocalIds: body.aliasLocalIds?.length ? body.aliasLocalIds : undefined, skillId: body.skillId ?? undefined }, space, signal, timeoutMs: 15_000 })
/** Resumes a failed task: continues an accepted request / transfer, or, when neither exists, queues one new paid generation. */
export const apiRetrySkillAvatar = (localSkillId: string): Promise<ApiSkillAvatar> =>
  apiFetch('/skill-avatars/local/' + encodeURIComponent(localSkillId) + '/retry', { method: 'POST', timeoutMs: 15_000 })
export const apiEnsureCloudSkillAvatar = (skillId: string, space: SpaceHandle, signal: AbortSignal): Promise<ApiSkillAvatar> =>
  apiFetch('/skill-avatars/skills/' + encodeURIComponent(skillId), { method: 'POST', space, signal, timeoutMs: 15_000 })
export const apiGetSkillTrash = (): Promise<ApiDeletedSkill[]> => apiFetch('/skills/trash')
export const apiRestoreSkill = (skillId: string): Promise<ApiSkill> =>
  apiFetch(`/skills/${encodeURIComponent(skillId)}/restore`, { method: 'POST' })
export const apiGetTeamSkills = (teamId: string): Promise<ApiSkill[]> => apiFetch(`/skills?scope=team&teamId=${encodeURIComponent(teamId)}`)
export const apiGetSkill = (skillId: string, space?: SpaceHandle): Promise<ApiSkill> => apiFetch(`/skills/${encodeURIComponent(skillId)}`, { space })
export const apiGetSkillSource = (skillId: string, space?: SpaceHandle): Promise<{ skillMd: string }> =>
  apiFetch(`/skills/${encodeURIComponent(skillId)}/source`, { space })
export const apiGetSkillVersions = (skillId: string): Promise<ApiSkillVersion[]> => apiFetch(`/skills/${encodeURIComponent(skillId)}/versions`)
export const apiImportSkill = (data: {
  name: string
  /** The local 「来源」; omitted when the Skill has none. */
  sourceUrl?: string
  localSkillId?: string
  aliasLocalIds?: string[]
  skillMd: string
  compatibleAgents: string[]
  envDependencies: { key: string; description?: string; required: boolean; obtain?: string }[]
  currentVersion: string
  aiAnalysisConsent: true
  packageBase64: string
  packageSha256: string
}, space?: SpaceHandle): Promise<ApiImportResult> => apiFetch('/skills/import', {
  method: 'POST',
  body: data,
  space,
})
export const apiUpdateSkill = (skillId: string, data: Partial<ApiSkill>): Promise<ApiSkill> => apiFetch(`/skills/${encodeURIComponent(skillId)}`, { method: 'PATCH', body: data })
export async function apiDeleteSkill(skillId: string): Promise<void> {
  const response = await apiResponse(`/api/skills/${encodeURIComponent(skillId)}`, { method: 'DELETE' })
  // Delete is a reconciliation operation: the server may have completed the
  // previous request even when the desktop lost its response. A missing
  // remote asset must not permanently block deletion of the local copy.
  if (response.status === 404) return
  if (!response.ok) throw await responseError(response)
}
export const apiCreateSkillVersion = (skillId: string, data: { version: string; changelog: string; gitHash?: string; skillMd?: string; envDependencies?: { key: string; description?: string; required: boolean; obtain?: string }[]; packageBase64: string; packageSha256: string; libraryVersionReceiptId?: string }): Promise<ApiSkillVersion> =>
  apiFetch(`/skills/${encodeURIComponent(skillId)}/versions`, { method: 'POST', body: data })
export const apiShareSkillToTeam = (skillId: string, teamId: string): Promise<void> =>
  apiFetch<void>(`/skills/${encodeURIComponent(skillId)}/shares`, { method: 'POST', body: { teamId } }).then(() => notifyEnvReadinessChanged({ serverId: skillId }))
export const apiUnshareSkill = (skillId: string, teamId: string): Promise<void> =>
  apiFetch<void>(`/skills/${encodeURIComponent(skillId)}/shares/${encodeURIComponent(teamId)}`, { method: 'DELETE' }).then(() => notifyEnvReadinessChanged({ serverId: skillId }))
export type ApiExpectedSkillProfile = {
  displayName: string
  description: string | null
  category: string | null
  labels: string[]
  triggerScenarios: string[]
}
/** Server AI waits up to 120 s; the client stops waiting a little later and reports the result as unconfirmed. */
export const AI_ANALYSIS_TIMEOUT_MS = 150_000
export const apiAnalyzeSkill = (
  skillId: string,
  skillMd: string,
  options: { expectedProfile?: ApiExpectedSkillProfile; space?: SpaceHandle } = {},
): Promise<ApiImportResult> => apiFetch(`/skills/${encodeURIComponent(skillId)}/analyze`, {
  method: 'POST',
  body: {
    skillMd,
    aiAnalysisConsent: true,
    ...(options.expectedProfile ? { expectedProfile: options.expectedProfile } : {}),
  },
  space: options.space,
  timeoutMs: AI_ANALYSIS_TIMEOUT_MS,
})

async function packageResponsePayload(response: Response): Promise<{ base64: string; sha256: string; version: string }> {
  const bytes = new Uint8Array(await response.arrayBuffer())
  let binary = ''
  const chunkSize = 0x8000
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize))
  }
  return {
    base64: btoa(binary),
    sha256: response.headers.get('X-Checksum-Sha256') ?? '',
    version: response.headers.get('X-Skill-Version') ?? 'v0.1.0',
  }
}

export async function apiDownloadSkillPackage(skillId: string): Promise<{ base64: string; sha256: string; version: string }> {
  const response = await apiResponse(`/api/skills/${encodeURIComponent(skillId)}/package`)
  if (!response.ok) throw await responseError(response)
  return packageResponsePayload(response)
}

export async function apiDownloadMarketplacePackage(skillId: string): Promise<{ base64: string; sha256: string; version: string }> {
  if (catalogOfflineAt()) throw new Error(CATALOG_INSTALL_OFFLINE)
  const response = await apiResponse(`/api/marketplace/${encodeURIComponent(skillId)}/package`, {
    preserveSessionOn401: true,
  })
  // Marketplace packages are intentionally public. A malformed or stale local
  // account session must never be cleared by this unauthenticated request.
  if (!response.ok) throw await responseError(response)
  return packageResponsePayload(response)
}

export const apiGetComments = (skillId: string, teamId: string | undefined): Promise<ApiComment[]> =>
  apiFetch(`/comments?skillId=${encodeURIComponent(skillId)}${teamId ? `&teamId=${encodeURIComponent(teamId)}` : ''}`)
export const apiGetCommentMentionCandidates = (
  skillId: string,
  teamId: string,
): Promise<ApiCommentMentionCandidate[]> => apiFetch(
  `/comments/mention-candidates?skillId=${encodeURIComponent(skillId)}&teamId=${encodeURIComponent(teamId)}`,
)
export const apiPostComment = (
  skillId: string,
  content: string,
  teamId: string | undefined,
  parentId?: string,
  mentionUserIds: string[] = [],
): Promise<ApiComment> =>
  apiFetch('/comments', { method: 'POST', body: { skillId, teamId: teamId ?? null, parentId, content, mentionUserIds } })
export const apiUpdateComment = (
  commentId: string,
  content: string,
  mentionUserIds: string[] = [],
): Promise<ApiComment> => apiFetch(`/comments/${encodeURIComponent(commentId)}`, {
  method: 'PATCH',
  body: { content, mentionUserIds },
})
export const apiDeleteComment = (commentId: string): Promise<void> =>
  apiFetch(`/comments/${encodeURIComponent(commentId)}`, { method: 'DELETE' })
export const apiGetNotifications = (space?: SpaceHandle): Promise<ApiNotification[]> => apiFetch('/notifications', { space })
export const apiMarkNotificationRead = (id: string, space?: SpaceHandle): Promise<ApiNotification> => apiFetch(`/notifications/${encodeURIComponent(id)}/read`, { method: 'POST', space })
export const apiMarkAllRead = (space?: SpaceHandle): Promise<void> => apiFetch('/notifications/read-all', { method: 'POST', space })
