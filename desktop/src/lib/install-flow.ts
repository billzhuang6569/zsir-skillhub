import { reconcileLocalSkillRefresh } from './ui-helpers.ts'

export type InstallFlowAsset = {
  id: string
  localPath: string
  serverId?: string
  teamSharedFrom?: string
  sharedTo?: Record<string, unknown>
  accountSyncRequired?: boolean
}

type InstallFlowInput<T extends InstallFlowAsset> = {
  asset: T
  agents: string[]
  importRemote?: () => Promise<T>
  install: (localId: string, agents: string[]) => Promise<void>
  refresh: (localId: string) => Promise<T | undefined>
  replace: (currentStoreId: string, updated: T) => void
}

/**
 * Keeps the UI identity reconciled across remote download and local projection.
 * Replacing remote -> local before projection makes a failed projection
 * retryable without importing the same managed directory twice.
 */
export async function runSkillInstallFlow<T extends InstallFlowAsset>(
  input: InstallFlowInput<T>,
): Promise<void> {
  let localId = input.asset.id
  let storeId = input.asset.id
  let currentAsset = input.asset
  if (!input.asset.localPath) {
    if (!input.importRemote) throw new Error('该资产缺少可下载的安装包')
    const imported = await input.importRemote()
    localId = imported.id
    input.replace(storeId, imported)
    storeId = imported.id
    currentAsset = imported
  }

  await input.install(localId, input.agents)
  const refreshed = await input.refresh(localId)
  if (refreshed) input.replace(storeId, reconcileLocalSkillRefresh(currentAsset, refreshed))
}
