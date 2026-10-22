import { useSyncExternalStore } from 'react'
import { catalogOfflineAt, subscribeCatalog } from './catalog-cache.ts'

export function useCatalogOffline(): number | null {
  return useSyncExternalStore(subscribeCatalog, catalogOfflineAt, () => null)
}
