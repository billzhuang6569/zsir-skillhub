import { isTauri } from '@tauri-apps/api/core'
import { relaunch } from '@tauri-apps/plugin-process'
import { check, type Update } from '@tauri-apps/plugin-updater'
import { useStore } from '../store/index.js'

let availableUpdate: Update | null = null
let checking: Promise<void> | null = null

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function supportsAppUpdates(): boolean {
  return isTauri()
}

export async function checkForAppUpdate(options: { silent?: boolean } = {}): Promise<void> {
  if (checking) return checking
  const run = async (): Promise<void> => {
    if (!supportsAppUpdates()) {
      if (!options.silent) useStore.getState().setAppUpdate({ phase: 'error', error: '应用更新只能在已安装的 SkillHub 中检查' })
      return
    }
    useStore.getState().setAppUpdate({ phase: 'checking' })
    try {
      const update = await check({ timeout: 15_000 })
      if (!update) {
        availableUpdate = null
        useStore.getState().setAppUpdate({ phase: 'latest' })
        return
      }
      if (availableUpdate && availableUpdate !== update) await availableUpdate.close().catch(() => undefined)
      availableUpdate = update
      useStore.getState().setAppUpdate({
        phase: 'available',
        version: update.version,
        notes: update.body?.trim() || '包含稳定性和体验改进。',
      })
    } catch (error: unknown) {
      const next = { phase: 'error' as const, error: `检查更新失败：${messageOf(error)}` }
      useStore.getState().setAppUpdate(options.silent ? { phase: 'idle' } : next)
    }
  }
  checking = run().finally(() => { checking = null })
  return checking
}

export async function downloadAndInstallAppUpdate(): Promise<void> {
  if (!availableUpdate) {
    useStore.getState().setAppUpdate({ phase: 'error', error: '更新信息已失效，请重新检查' })
    return
  }
  const { version, notes } = useStore.getState().appUpdate
  let downloadedBytes = 0
  let totalBytes: number | undefined
  useStore.getState().setAppUpdate({ phase: 'downloading', version, notes, downloadedBytes })
  try {
    await availableUpdate.downloadAndInstall((event) => {
      if (event.event === 'Started') totalBytes = event.data.contentLength
      if (event.event === 'Progress') downloadedBytes += event.data.chunkLength
      useStore.getState().setAppUpdate({
        phase: 'downloading', version, notes, downloadedBytes, totalBytes,
      })
    })
    useStore.getState().setAppUpdate({ phase: 'ready', version, notes, downloadedBytes, totalBytes })
  } catch (error: unknown) {
    useStore.getState().setAppUpdate({
      phase: 'error', version, notes, error: `更新安装失败：${messageOf(error)}`,
    })
  }
}

export async function restartAfterAppUpdate(): Promise<void> {
  await relaunch()
}

export function dismissAppUpdate(): void {
  const state = useStore.getState().appUpdate
  if (state.phase === 'available' || state.phase === 'error' || state.phase === 'latest') {
    useStore.getState().setAppUpdate({ phase: 'idle' })
  }
}
