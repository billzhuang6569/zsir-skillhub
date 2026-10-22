import { config } from '../config.js'
import { createStorageRegistry, type StorageLocation } from '../providers/storage-registry.js'
import type { ObjectStorage } from '../providers/object-storage.js'
import { createCardStore, type CardStore } from './card-store-core.js'

export { CardIntegrityError, cardStorageKey, isCardSha256 } from './card-store-core.js'

function configuredStorage(): ObjectStorage {
  return createStorageRegistry(config).target('cards').storage
}

export function cardStorageProvider(): ObjectStorage['provider'] {
  return configuredStorage().provider
}

export function cardStorageNamespace(): string | null {
  return createStorageRegistry(config).target('cards').storageNamespace
}

/** New writes use the configured default; reads always carry row attribution. */
function configuredCardStore(): CardStore {
  return createCardStore(configuredStorage())
}

export async function storeCardBytes(data: Buffer, sha256: string): Promise<string> {
  return configuredCardStore().store(data, sha256)
}

export async function readCardBytes(storageKey: string, sha256: string, location: StorageLocation): Promise<Buffer> {
  return createCardStore(createStorageRegistry(config).read('cards', location)).read(storageKey, sha256)
}

export async function verifyStoredCard(storageKey: string, sha256: string, location: StorageLocation): Promise<boolean> {
  return createCardStore(createStorageRegistry(config).read('cards', location)).verify(storageKey, sha256)
}
