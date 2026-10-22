import { createHash } from 'node:crypto'
import { ObjectMissingError, type ObjectStorage } from '../providers/object-storage.js'

const SHA256_PATTERN = /^[a-f0-9]{64}$/

export class CardIntegrityError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CardIntegrityError'
  }
}

export type CardStore = {
  store: (data: Buffer, sha256: string) => Promise<string>
  read: (storageKey: string, sha256: string) => Promise<Buffer>
  verify: (storageKey: string, sha256: string) => Promise<boolean>
}

export function isCardSha256(value: string): boolean {
  return value.length === 64 && SHA256_PATTERN.test(value)
}

export function cardStorageKey(sha256: string): string {
  if (!isCardSha256(sha256)) throw new CardIntegrityError('Invalid card hash')
  return `${sha256.slice(0, 2)}/${sha256}.zip`
}

function sha256Hex(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex')
}

/** Shared content rules for every backend, independent of process config. */
export function createCardStore(backend: ObjectStorage): CardStore {
  async function read(storageKey: string, sha256: string): Promise<Buffer> {
    if (storageKey !== cardStorageKey(sha256)) {
      throw new CardIntegrityError('Card storage key does not match its hash')
    }
    const data = await backend.get(storageKey)
    if (sha256Hex(data) !== sha256) {
      throw new CardIntegrityError('Stored card bytes do not match their hash')
    }
    return data
  }

  async function store(data: Buffer, sha256: string): Promise<string> {
    const storageKey = cardStorageKey(sha256)
    // Own the bytes across awaits so callers cannot change the verified input.
    const bytes = Buffer.from(data)
    if (sha256Hex(bytes) !== sha256) throw new CardIntegrityError('Card bytes do not match their hash')
    await backend.put(storageKey, bytes)
    return storageKey
  }

  async function verify(storageKey: string, sha256: string): Promise<boolean> {
    try {
      await read(storageKey, sha256)
      return true
    } catch (error: unknown) {
      if (error instanceof CardIntegrityError || error instanceof ObjectMissingError) return false
      throw error
    }
  }

  return { store, read, verify }
}
