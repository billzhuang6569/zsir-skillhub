import { apiSyncMarketplacePresence, sameSpace } from './api.js'
import { currentSpace, getLocalSkills } from './tauri.js'
import { marketplaceManagedListingIds } from './marketplace-presence-state.js'

const DEVICE_STORAGE_KEY = 'yitan-skillhub.marketplace-device.v1'

export function marketplaceDeviceId(): string {
  let deviceId = window.localStorage.getItem(DEVICE_STORAGE_KEY)
  if (!deviceId) {
    deviceId = crypto.randomUUID()
    window.localStorage.setItem(DEVICE_STORAGE_KEY, deviceId)
  }
  return deviceId
}

export async function syncMarketplaceManagedPresence(): Promise<string[]> {
  const space = await currentSpace()
  if (space.spaceId !== 'official') return []
  const activeListingIds = marketplaceManagedListingIds(await getLocalSkills())
  if (!sameSpace(space, await currentSpace())) return []
  const result = await apiSyncMarketplacePresence(marketplaceDeviceId(), activeListingIds)
  return result.activeListingIds
}
