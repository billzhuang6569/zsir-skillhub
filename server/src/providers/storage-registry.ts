import { createHash } from 'node:crypto'
import type { Config } from '../config-schema.js'
import { createFilesystemObjectStorage } from './filesystem-object-storage.js'
import { createS3ObjectStorage, normalizeS3Endpoint } from './s3-object-storage.js'
import type { ObjectStorage } from './object-storage.js'

export type StorageKind = 'cards' | 'media'
export type StorageLocation = { storageProvider: string | null; storageNamespace: string | null }
type RegistryConfig = Pick<Config, 'STORAGE_DEFAULT' | 'SKILL_CARD_STORAGE_DIR' | 'MEDIA_STORAGE_DIR'
  | 'S3_ENDPOINT' | 'S3_REGION' | 'S3_BUCKET' | 'S3_PREFIX' | 'S3_ACCESS_KEY_ID' | 'S3_SECRET_ACCESS_KEY' | 'S3_FORCE_PATH_STYLE'>
export type LocatedStorage = StorageLocation & { storage: ObjectStorage }

export class StorageUnavailableError extends Error {
  readonly statusCode = 503
  readonly code = 'STORAGE_NAMESPACE_UNAVAILABLE'
  constructor(readonly storageProvider: string | null, readonly storageNamespace: string | null) {
    super('Storage namespace is not configured')
    this.name = 'StorageUnavailableError'
  }
}

export function s3StorageNamespace(endpoint: string, bucket: string, prefix: string): string {
  return 's3:' + createHash('sha256').update(JSON.stringify([normalizeS3Endpoint(endpoint), bucket, prefix])).digest('hex').slice(0, 16)
}

export function createStorageRegistry(config: RegistryConfig): {
  read: (kind: StorageKind, location: StorageLocation) => ObjectStorage
  target: (kind: StorageKind, provider?: ObjectStorage['provider']) => LocatedStorage
  available: (location: StorageLocation) => boolean
} {
  const configured = !!(config.S3_ENDPOINT && config.S3_REGION && config.S3_BUCKET && config.S3_ACCESS_KEY_ID && config.S3_SECRET_ACCESS_KEY)
  const namespace = configured ? s3StorageNamespace(config.S3_ENDPOINT!, config.S3_BUCKET!, config.S3_PREFIX) : null
  function available(location: StorageLocation): boolean {
    return (location.storageProvider === 'filesystem' && location.storageNamespace === null)
      || (configured && location.storageProvider === 's3' && location.storageNamespace === namespace)
  }
  function read(kind: StorageKind, location: StorageLocation): ObjectStorage {
    if (!available(location)) throw new StorageUnavailableError(location.storageProvider, location.storageNamespace)
    if (location.storageProvider === 'filesystem') {
      return createFilesystemObjectStorage(kind === 'cards' ? config.SKILL_CARD_STORAGE_DIR : config.MEDIA_STORAGE_DIR)
    }
    return createS3ObjectStorage({
      endpoint: config.S3_ENDPOINT!, bucket: config.S3_BUCKET!, prefix: config.S3_PREFIX,
      region: config.S3_REGION!, accessKeyId: config.S3_ACCESS_KEY_ID!, secretAccessKey: config.S3_SECRET_ACCESS_KEY!,
      forcePathStyle: config.S3_FORCE_PATH_STYLE,
    }, (kind === 'cards' ? 30 : 8) * 1024 * 1024)
  }
  function target(kind: StorageKind, provider = config.STORAGE_DEFAULT ?? 'filesystem'): LocatedStorage {
    const location = { storageProvider: provider, storageNamespace: provider === 's3' ? namespace : null }
    return { ...location, storage: read(kind, location) }
  }
  return { read, target, available }
}
