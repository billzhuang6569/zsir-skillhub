import { invoke } from '@tauri-apps/api/core'
import { flushOrganizerSave, useStore } from '../store/index.js'
import { authState, type SpaceHandle } from './tauri.js'
import { apiCandidate, apiGetMe, ApiError, notifyApiUnauthorized, type ApiAuthUser, type ApiHealth } from './api.js'
import { spaceProfile } from './space-capabilities.js'
import { DOC_LINKS } from './docs.js'

export const SPACE_SWITCH_VIEW_KEY = 'skillhub-space-switch-view'

export function selectedServiceProfile(space: SpaceHandle | null, requested?: ReturnType<typeof spaceProfile>): ReturnType<typeof spaceProfile> {
  return requested ?? spaceProfile(space)
}

export function displayServerAddress(address: string): string {
  return address.trim().replace(/\/+$/, '')
}

export type ConnectionReport = {
  origin: string | null
  checks: Array<{ item: string; state: 'pass' | 'actionRequired' | 'blocked' | 'unavailable'; message: string }>
  error: { code: string; message: string } | null
  info: ApiHealth | null
  deployment: { profile: 'official' | 'local' | 'selfhost'; origin?: string } | null
  rebind?: { previousOrigin: string; active: boolean } | null
}

type RebindLoginStatus = 'verified' | 'invalid' | 'unavailable'

export function rebindOutcome(input: {
  active: boolean
  beforeUserId: string | null
  afterUserId: string | null
  origin: string
  verification?: RebindLoginStatus
}): { action: 'close' | 'login'; message: string } {
  if (!input.active) return { action: 'login', message: '已改用新地址，数据已保留。请登录此实例。' }
  const message = `已改用新地址 ${input.origin}，数据已保留`
  if (!input.beforeUserId) return { action: 'close', message }
  if (input.afterUserId !== input.beforeUserId || input.verification === 'invalid') {
    return { action: 'login', message: '已改用新地址，数据已保留。原登录已失效，请重新登录。' }
  }
  return { action: 'close', message: input.verification === 'verified'
    ? `已改用新地址 ${input.origin}，数据和登录状态已保留`
    : `${message}。暂时无法验证登录状态，稍后会自动重试。` }
}

export async function verifyReboundLogin(space: SpaceHandle, userId: string): Promise<RebindLoginStatus> {
  try {
    const { user } = await apiGetMe({ space, timeoutMs: 10_000 })
    if (user.id === userId) return 'verified'
    await notifyApiUnauthorized(space)
    return 'invalid'
  } catch (error: unknown) {
    if (error instanceof ApiError) {
      if (error.status === 401) return 'invalid'
      if (error.kind === 'aborted') {
        const current = await authState()
        // The concurrent session restore may have already handled a 401.
        if (current.spaceId === space.spaceId && !current.pending && !current.userId) return 'invalid'
      }
      if (error.kind === 'network' || error.kind === 'timeout' || (error.status !== null && error.status >= 500)) return 'unavailable'
    }
    throw error
  }
}

export const SELF_HOST_DOCS = DOC_LINKS.connect
export const SETUP_CODE_DOCS = DOC_LINKS.setup
export const CONNECTION_ITEMS = [
  ['security', '连接安全'], ['version', '版本兼容'], ['instance', '实例状态'],
  ['auth', '登录方式'], ['ai', 'AI 服务'], ['avatars', 'Skill 头像'],
] as const

export function connectionChecks(report: ConnectionReport | null): ConnectionReport['checks'] {
  return CONNECTION_ITEMS.map(([item]) => {
    const check = report?.checks.find(check => check.item === item)
      ?? { item, state: 'unavailable' as const, message: '尚未检查' }
    if (check.message === '非本机回环地址必须使用 HTTPS，请检查服务器地址') return { ...check, message: '需要 HTTPS：只有 localhost、127/8、::1 等本机回环地址允许 HTTP。其他地址请配置 HTTPS。' }
    if ((item === 'ai' || item === 'avatars') && check.state === 'pass' && (report?.info?.features?.[item] === false || check.message === '未配置')) {
      return { ...check, state: 'actionRequired', message: '未配置' }
    }
    if (item === 'avatars' && check.state === 'pass' && report?.info?.features?.avatars) return { ...check, message: '已启用' }
    return check
  })
}

export function setupErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 401) return '初始化码不正确，请检查后重试'
    if (error.status === 410) return '初始化码已过期或失效，请到服务器终端重启服务获取新码'
    if (error.status === 429) return error.retryAfterSeconds ? `请求过于频繁，请 ${error.retryAfterSeconds} 秒后重试` : '请求过于频繁，请稍后重试'
  }
  return error instanceof Error ? error.message : String(error)
}

export type SelfhostCredentials = { email: string; password: string; displayName?: string; code?: string; inviteCode?: string }
export async function authenticateSelfhost(space: SpaceHandle, mode: 'setup' | 'login' | 'register', fields: SelfhostCredentials, onInitialized: () => void = () => {}): Promise<{ user: ApiAuthUser; initialized: boolean }> {
  let initialized = false
  try {
    await apiCandidate(space, mode === 'setup' ? '/setup/admin' : mode === 'register' ? '/auth/register' : '/auth/login', fields)
    initialized = mode === 'setup'
    if (initialized) onInitialized()
  } catch (error: unknown) {
    if (mode !== 'setup' || (error instanceof ApiError && error.status !== 409 && error.kind === 'http')) throw error
    const status = await apiCandidate<{ initialized: boolean }>(space, '/setup/status')
    if (!status.initialized) throw error
    onInitialized()
    if (error instanceof ApiError && error.status === 409) throw new ApiError('http', '实例已初始化，请使用管理员账号登录', { status: 409 })
    // A lost create response is reconciled once; never repeat setup.admin.
    await apiCandidate(space, '/auth/login', { email: fields.email, password: fields.password })
    initialized = true
  }
  if (mode === 'setup' && !(await apiCandidate<{ initialized: boolean }>(space, '/setup/status')).initialized) throw new Error('尚未确认实例初始化状态，请重新测试')
  const { user } = await apiCandidate<{ user: ApiAuthUser }>(space, '/auth/me')
  return { user, initialized }
}

export async function testSpaceConnection(target: string): Promise<ConnectionReport> {
  return invoke('test_space_connection', { target })
}

export type SpaceCommitChoice = '迁移并切换' | '只切换' | '取消'
export type BeforeSpaceCommit = (source: SpaceHandle, target: SpaceHandle) => Promise<SpaceCommitChoice>

export async function switchSpace(
  source: SpaceHandle,
  target: string,
  authenticate: (candidate: SpaceHandle) => Promise<void>,
  beforeCommit: BeforeSpaceCommit,
  rebind = false,
): Promise<SpaceHandle | null> {
  useStore.setState({ spacePending: true })
  let candidate: SpaceHandle | null = null
  let committed = false
  try {
    await flushOrganizerSave(true)
    candidate = await invoke<SpaceHandle>('begin_space_switch', { space: { spaceId: source.spaceId, generation: source.generation }, target, rebind })
    if (target !== 'local' && !rebind) await authenticate(candidate)
    if (await beforeCommit(source, candidate) === '取消') return null
    const result = await invoke<SpaceHandle>('commit_space_switch', { space: candidate })
    committed = true
    return result
  } finally {
    try {
      if (!committed && candidate) await invoke('cancel_space_switch', { space: candidate })
    } finally {
      window.dispatchEvent(new Event('skillhub-space-refresh'))
    }
  }
}
