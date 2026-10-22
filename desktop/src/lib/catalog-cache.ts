import { OFFICIAL_ENDPOINTS } from './official-endpoints.ts'

const prefix = `skillhub.catalog.v1:${OFFICIAL_ENDPOINTS.catalogOrigin.replace(/\/+$/, '')}:`
const unavailable = new Map<string, number>()
const listeners = new Set<() => void>()
export const catalogOfflineAt = (): number | null => unavailable.size ? Math.min(...unavailable.values()) : null
export const subscribeCatalog = (listener: () => void): (() => void) => {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}
export const CATALOG_INSTALL_OFFLINE = '连接官方商店后才能安装'
export function catalogOfflineMessage(time: number): string {
  const date = new Date(time)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `无法连接官方商店，显示 ${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())} 的缓存`
}

/** Only callers of public GET endpoints may use this cache. Never cache user data. */
export async function cachedCatalog<T>(path: string, request: () => Promise<T>): Promise<T> {
  const key = prefix + path
  const emit = (): void => { for (const listener of listeners) listener() }
  try {
    const data = await request()
    try {
      const json = JSON.stringify({ fetchedAt: Date.now(), data })
      if (json.length <= 1_000_000) {
        const keys = Object.keys(localStorage).filter(item => item.startsWith(prefix))
        // Bound WebView disk storage independently of the private ZIP cache.
        while (keys.length >= 8) localStorage.removeItem(keys.shift()!)
        localStorage.setItem(key, json)
      }
    } catch { /* A full or unavailable cache must not break online browsing. */ }
    unavailable.clear()
    emit()
    return data
  } catch (error: unknown) {
    const failure = error as { kind?: string; status?: number | null }
    if (failure.kind === 'aborted' || (failure.status && failure.status < 500)) throw error
    try {
      const raw = localStorage.getItem(key)
      if (raw && raw.length <= 1_000_000) {
        const record = JSON.parse(raw) as { fetchedAt?: unknown; data?: T }
        if (typeof record.fetchedAt === 'number' && Number.isFinite(record.fetchedAt) && record.data !== undefined) {
          unavailable.set(key, record.fetchedAt)
          emit()
          return record.data
        }
      }
    } catch { /* Missing or corrupt cache keeps the normal error state. */ }
    throw error
  }
}
