import { importLegacyAuth } from './auth.ts'
import { apiGetMe, apiRenewSession, ApiError, sameSpace, type ApiAuthUser } from './api.ts'
import { authState, type SpaceHandle } from './tauri.ts'

export function shouldRenewSession({ issuedAt, expiresAt, now }: { issuedAt?: string; expiresAt?: string; now: number }): boolean {
  if (!issuedAt || !expiresAt) return false
  const issued = Date.parse(issuedAt)
  const expires = Date.parse(expiresAt)
  if (!Number.isFinite(issued) || !Number.isFinite(expires) || !Number.isFinite(now) || expires <= issued) return false
  const remaining = expires - now
  return remaining < (expires - issued) / 2 || remaining < 30 * 24 * 60 * 60 * 1000
}

export function nextRestoreDelay(attempt: number, random: () => number = Math.random): number {
  // ±20% jitter, with a hard five-minute ceiling including jitter.
  return Math.min(300_000, Math.round(Math.min(300_000, 5_000 * 2 ** Math.min(attempt, 6)) * (0.8 + random() * 0.4)))
}

export function isRetryableRestoreError(error: unknown): boolean {
  return error instanceof ApiError && error.status !== 401
    && (error.kind === 'network' || error.kind === 'timeout' || (error.status !== null && error.status >= 500))
}

type RestoreRetryOptions = {
  random?: () => number
  timer?: (run: () => void, delay: number) => () => void
  events?: EventTarget
  visibility?: EventTarget & { visibilityState: string }
  readState?: typeof authState
}

export function retryNativeAuthRestore(options: RestoreRetryOptions = {}) {
  const { random = Math.random, readState = authState,
    events = typeof window === 'undefined' ? undefined : window,
    visibility = typeof document === 'undefined' ? undefined : document,
    timer = (run, delay) => { const id = setTimeout(run, delay); return () => clearTimeout(id) },
  } = options
  let attempt = 0
  let generation = 0
  let cleanup = (): void => {}
  const cancel = (): void => { generation++; attempt = 0; cleanup() }
  const checkpoint = (): (() => boolean) => {
    const current = generation
    return () => current === generation
  }
  const schedule = (space: SpaceHandle, userId: string, restore: () => Promise<void>): void => {
    cleanup()
    const current = checkpoint()
    let waiting = true
    let stopTimer = (): void => {}
    const run = (immediate: boolean): void => {
      if (!waiting || !current()) return
      cleanup()
      if (immediate) attempt = 0
      void readState().then(state => {
        if (!current()) return
        if (state.pending || state.userId !== userId || !sameSpace(state, space)) { cancel(); return }
        return restore()
      }).catch(() => {})
    }
    const wake = (): void => run(true)
    const visible = (): void => { if (visibility?.visibilityState === 'visible') wake() }
    cleanup = (): void => {
      waiting = false
      stopTimer()
      events?.removeEventListener('focus', wake)
      events?.removeEventListener('online', wake)
      visibility?.removeEventListener('visibilitychange', visible)
    }
    events?.addEventListener('focus', wake)
    events?.addEventListener('online', wake)
    visibility?.addEventListener('visibilitychange', visible)
    stopTimer = timer(() => run(false), nextRestoreDelay(attempt++, random))
  }
  return { schedule, cancel, checkpoint }
}

export async function restoreNativeAuth({ allowRenew = true }: { allowRenew?: boolean } = {}): Promise<{ user: ApiAuthUser; space: SpaceHandle } | null> {
  const initial = await authState()
  await importLegacyAuth()
  const state = await authState()
  if ((state.error || initial.error) && !state.userId) {
    throw new ApiError('http', state.error || initial.error || '无法读取本机登录信息', { status: 401, code: 'LOCAL_SESSION_UNREADABLE' })
  }
  if (state.pending) throw new Error('SkillHub APP 正在同步账号，请稍后重试')
  if (!state.userId) return null
  try {
    const { user, tokenIssuedAt, tokenExpiresAt } = await apiGetMe({ space: { spaceId: state.spaceId, generation: state.generation }, timeoutMs: 10_000 })
    const current = await authState()
    if (!sameSpace(current, state) || current.pending || current.userId !== user.id) {
      throw new ApiError('aborted', 'Request aborted')
    }
    let space = { spaceId: state.spaceId, generation: state.generation }
    if (allowRenew && shouldRenewSession({ issuedAt: tokenIssuedAt, expiresAt: tokenExpiresAt, now: Date.now() })) {
      try {
        const renewed = await apiRenewSession(space)
        space = renewed.space
      } catch (error: unknown) {
        if (error instanceof ApiError && error.status === 401) throw error
        console.warn('SkillHub 会话续期失败，将在下次恢复时重试')
      }
      const afterRenew = await authState()
      if (!sameSpace(afterRenew, space) || afterRenew.pending || afterRenew.userId !== user.id) {
        throw new ApiError('aborted', 'Request aborted')
      }
    }
    return { user, space }
  } catch (error: unknown) {
    if (error instanceof ApiError && error.status === 401) {
      const current = await authState()
      if (!current.userId && !current.pending) return null
    }
    throw error
  }
}
