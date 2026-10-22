import { invoke } from '@tauri-apps/api/core'
export const AUTH_TOKEN_STORAGE_KEY = 'yitan-skillhub.auth-token.v1'

export type AuthUser = {
  id: string
  email: string
  displayName: string
  avatarUrl?: string | null
  yitanAccountLinked?: boolean
}

export type LoginFields = {
  email: string
  password: string
}

export type RegisterFields = LoginFields & {
  displayName: string
}

export type AuthFieldErrors = Partial<Record<keyof RegisterFields, string>>

type TokenStorage = Pick<Storage, 'getItem' | 'removeItem'>
let legacySessionObserved = false
export function hadLegacySession(): boolean { return legacySessionObserved }
function defaultStorage(): TokenStorage | null {
  try { return typeof localStorage === 'undefined' ? null : localStorage } catch { return null }
}

/** The sole upgrade bridge: a rejected legacy token is deleted; transport failure retries next launch. */
export async function importLegacyAuth(
  importToken: (token: string) => Promise<boolean> = token => invoke<boolean>('import_legacy_auth', { token }),
  storage: TokenStorage | null = defaultStorage(),
): Promise<void> {
  const token = storage?.getItem(AUTH_TOKEN_STORAGE_KEY)?.trim()
  if (!token) return
  legacySessionObserved = true
  await importToken(token)
  storage?.removeItem(AUTH_TOKEN_STORAGE_KEY)
}

export function deleteLegacyAuth(storage: TokenStorage | null = defaultStorage()): void {
  storage?.removeItem(AUTH_TOKEN_STORAGE_KEY)
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase()
}

function validEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
}

export function validateLoginFields(fields: LoginFields): AuthFieldErrors {
  const errors: AuthFieldErrors = {}
  const email = normalizeEmail(fields.email)
  if (!email) errors.email = '请输入邮箱地址'
  else if (!validEmail(email)) errors.email = '请输入有效的邮箱地址'

  if (!fields.password) errors.password = '请输入密码'
  else if (fields.password.length < 6) errors.password = '密码至少需要 6 个字符'
  else if (fields.password.length > 128) errors.password = '密码不能超过 128 个字符'
  return errors
}

export function validateRegisterFields(fields: RegisterFields): AuthFieldErrors {
  const errors = validateLoginFields(fields)
  const displayName = fields.displayName.trim()
  if (!displayName) errors.displayName = '请输入显示名称'
  else if (displayName.length > 50) errors.displayName = '显示名称不能超过 50 个字符'
  return errors
}

export function authErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  if (message === 'Invalid invitation code') return '内测邀请码无效，请向邀请人确认'
  if (message === 'Invalid email or password') return '邮箱或密码不正确'
  if (message === 'Email already registered') return '该邮箱已经注册，请直接登录'
  if (message === 'Unauthorized') return '登录状态已失效，请重新登录'
  if (message === 'Too many attempts. Try again later.') return '尝试次数过多，请稍后再试'
  if (message === 'Invalid registration data') return '注册信息不符合要求，请检查后重试'
  if (message === 'Invalid login data') return '登录信息不符合要求，请检查后重试'
  if (message === 'LEGACY_LOGIN_MIGRATION_ONLY' || message === 'Legacy login is limited to approved account migration') return '当前旧账号暂未开放迁移，请稍后再试'
  if (message === 'LOCAL_REGISTRATION_DISABLED' || message === 'Local registration is disabled') return '新账号请在一探账号门户注册'
  return message || '请求失败，请稍后再试'
}

export function userInitials(user: Pick<AuthUser, 'displayName' | 'email'>): string {
  const name = user.displayName.replace(/\s+/g, '')
  if (name) return Array.from(name).slice(0, 2).join('').toUpperCase()
  return user.email.slice(0, 1).toUpperCase()
}
