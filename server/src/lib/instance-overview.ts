import { opendir, lstat } from 'node:fs/promises'
import { join } from 'node:path'
import { config } from '../config.js'
import { effectiveSource, getSettingValue, hasSettingSecret, maskedSetting } from './server-settings.js'

export function registrationView(): { source: 'env' | 'setting' | 'none'; mode: 'open' | 'invite' | 'closed'; inviteCodeMask: string | null } {
  const source = effectiveSource('registration')
  return { source: !config.LOCAL_REGISTRATION_ENABLED ? 'env' : source,
    mode: !config.LOCAL_REGISTRATION_ENABLED ? 'closed' : getSettingValue('registration')?.mode ?? config.REGISTRATION_MODE,
    inviteCodeMask: source === 'env' ? config.REGISTRATION_INVITE_CODE ? `••••${config.REGISTRATION_INVITE_CODE.slice(-4)}` : null
      : maskedSetting('registration').secret?.mask ?? null }
}

export function registrationMode(): 'open' | 'invite' | 'closed' {
  const view = registrationView()
  const secretSet = view.source === 'env' ? Boolean(config.REGISTRATION_INVITE_CODE?.trim()) : hasSettingSecret('registration')
  return !config.LOCAL_REGISTRATION_ENABLED || (view.mode === 'invite' && !secretSet) ? 'closed' : view.mode
}

export type DirectoryUsage = { bytes: number; entries: number; complete: boolean }
/** Async iteration bounds memory, work, and elapsed time; symlinks are never followed. */
export async function directoryUsage(root: string, maxEntries = 10_000, maxMs = 200): Promise<DirectoryUsage> {
  const result: DirectoryUsage = { bytes: 0, entries: 0, complete: true }
  const pending = [root]
  const deadline = Date.now() + maxMs
  while (pending.length) {
    if (result.entries >= maxEntries || Date.now() >= deadline) { result.complete = false; break }
    try {
      const directory = pending.pop()!
      if (!(await lstat(directory)).isDirectory()) { result.complete = false; continue }
      for await (const entry of await opendir(directory)) {
        if (result.entries >= maxEntries || Date.now() >= deadline) { result.complete = false; break }
        result.entries += 1
        const path = join(directory, entry.name)
        if (entry.isDirectory()) pending.push(path)
        else if (entry.isFile()) result.bytes += (await lstat(path)).size
      }
      if (!result.complete) break
    } catch { result.complete = false }
  }
  return result
}

type StorageUsage = { provider: 'builtin'; media: DirectoryUsage; cards: DirectoryUsage; measuredAt: string }
let cached: { expires: number; value: Promise<StorageUsage> } | undefined
export async function storageUsage(): Promise<StorageUsage> {
  if (!cached || cached.expires <= Date.now()) {
    cached = { expires: Date.now() + 60_000, value: Promise.all([
      directoryUsage(config.MEDIA_STORAGE_DIR), directoryUsage(config.SKILL_CARD_STORAGE_DIR),
    ]).then(([media, cards]) => ({ provider: 'builtin', media, cards, measuredAt: new Date().toISOString() })) }
  }
  return cached.value
}
