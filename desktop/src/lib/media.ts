import { convertFileSrc } from '@tauri-apps/api/core'
import { useSyncExternalStore } from 'react'

export type MediaContext = { spaceId: string; serverBase: string; previousOrigins?: readonly string[]; allowedImageHosts: readonly string[] }

let context: MediaContext | null = null
const listeners = new Set<() => void>()
const storageKey = (spaceId: string): string => `skillhub-media:${spaceId}`
export function setMediaContext(value: MediaContext | null): void {
  context = value
  if (value) {
    try { localStorage.setItem(storageKey(value.spaceId), JSON.stringify(value)) } catch { /* Cache is optional. */ }
  }
  listeners.forEach(listener => listener())
}

/** Restore only this native space/base's last health policy so cached images work offline. */
export function restoreMediaContext(spaceId: string, serverBase: string, previousOrigins: readonly string[] = []): void {
  let hosts: string[] = []
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(storageKey(spaceId)) ?? 'null')
    if (saved && typeof saved === 'object' && 'serverBase' in saved && saved.serverBase === serverBase
      && 'allowedImageHosts' in saved && Array.isArray(saved.allowedImageHosts)) {
      hosts = saved.allowedImageHosts.filter((host): host is string => typeof host === 'string')
    }
  } catch { /* A missing or invalid policy permits only instance media. */ }
  setMediaContext({ spaceId, serverBase, previousOrigins, allowedImageHosts: hosts })
}
function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}
export function useMediaContext(): MediaContext | null {
  return useSyncExternalStore(subscribe, () => context, () => context)
}

const segment = (value: string): boolean => /^[a-zA-Z0-9._-]+$/.test(value) && value !== '.' && value !== '..'
const instanceKey = (value: string): boolean => /^([a-f0-9]{2})\/\1[a-f0-9]{62}\.(jpg|png|webp)$/.test(value)

/** Server URLs become native protocol addresses; never pass an untrusted URL to an img. */
export function mediaUrl(value: string | null | undefined, scope: MediaContext | null = context): string | null {
  if (!value || !scope || !segment(scope.spaceId) || /[%?#\\\s]/u.test(value)) return null
  try {
    const rawPath = value.split('://')[1]?.split('/').slice(1)
    if (!rawPath?.length || !rawPath.every(segment)) return null
    const url = new URL(value)
    if (url.username || url.password || !['http:', 'https:'].includes(url.protocol)) return null
    const key = [scope.serverBase, ...(scope.previousOrigins ?? [])].map(value => {
      const base = new URL(value)
      const prefix = `${base.pathname.replace(/\/+$/, '')}/media/`
      return url.origin === base.origin && url.pathname.startsWith(prefix) ? url.pathname.slice(prefix.length) : ''
    }).find(instanceKey)
    let reference: string
    if (key) {
      // serverBase comes from Rust, including its complete loopback/TLS validation.
      reference = `m/${key}`
    } else {
      if (url.protocol !== 'https:' || url.port || !scope.allowedImageHosts.includes(url.hostname)) return null
      reference = `h/${url.hostname}${url.pathname}`
    }
    return convertFileSrc(`${scope.spaceId}/${reference}`, 'skillhub-media')
  } catch { return null }
}

export function useMediaUrl(value: string | null | undefined): string | null {
  return mediaUrl(value, useMediaContext())
}
