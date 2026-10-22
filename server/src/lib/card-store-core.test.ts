import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { CardIntegrityError, cardStorageKey, createCardStore } from './card-store-core.js'
import { ObjectMissingError, type ObjectStorage } from '../providers/object-storage.js'

const data = Buffer.from('immutable card')
const hash = createHash('sha256').update(data).digest('hex')
const key = cardStorageKey(hash)

function fixture(): { backend: ObjectStorage; objects: Map<string, Buffer> } {
  const objects = new Map<string, Buffer>()
  const backend: ObjectStorage = {
    provider: 'filesystem',
    head: vi.fn(),
    delete: vi.fn(),
    get: vi.fn(async (storageKey: string): Promise<Buffer> => {
      const bytes = objects.get(storageKey)
      if (!bytes) throw new ObjectMissingError()
      return Buffer.from(bytes)
    }),
    put: vi.fn(async (storageKey: string, bytes: Buffer): Promise<void> => {
      try {
        if ((await backend.get(storageKey)).equals(bytes)) return
      } catch (error: unknown) {
        if (!(error instanceof ObjectMissingError)) throw error
      }
      objects.set(storageKey, Buffer.from(bytes))
    }),
  }
  return { backend, objects }
}

describe('card storage content contract', () => {
  it('rejects invalid content and mismatched keys before touching a backend', async () => {
    const { backend } = fixture()
    const store = createCardStore(backend)
    await expect(store.store(Buffer.from('other'), hash)).rejects.toBeInstanceOf(CardIntegrityError)
    await expect(store.read('../../private', hash)).rejects.toBeInstanceOf(CardIntegrityError)
    await expect(store.read(cardStorageKey('0'.repeat(64)), hash)).rejects.toBeInstanceOf(CardIntegrityError)
    await expect(store.store(data, '../invalid')).rejects.toBeInstanceOf(CardIntegrityError)
    await expect(store.store(data, `${hash}\n`)).rejects.toBeInstanceOf(CardIntegrityError)
    await expect(store.read(`00/${hash}.zip`, hash)).rejects.toBeInstanceOf(CardIntegrityError)
    expect(backend.get).not.toHaveBeenCalled()
    expect(backend.put).not.toHaveBeenCalled()
  })

  it('shares integrity, idempotency and corruption repair rules across backends', async () => {
    const { backend, objects } = fixture()
    const store = createCardStore(backend)
    expect(await store.verify(key, hash)).toBe(false)
    expect(await store.store(data, hash)).toBe(key)
    expect(await store.store(data, hash)).toBe(key)
    expect(objects.size).toBe(1)
    objects.set(key, Buffer.from('corruption'))
    await expect(store.read(key, hash)).rejects.toBeInstanceOf(CardIntegrityError)
    expect(await store.verify(key, hash)).toBe(false)
    expect(await store.store(data, hash)).toBe(key)
    expect(objects.size).toBe(1)
    expect(await store.read(key, hash)).toEqual(data)
  })

  it('does not treat permission or transport failures as missing or corrupt content', async () => {
    const failure = new Error('backend unavailable')
    const backend: ObjectStorage = {
      provider: 'filesystem',
      head: vi.fn(),
      delete: vi.fn(),
      get: vi.fn(async (): Promise<Buffer> => { throw failure }),
      put: vi.fn(async (): Promise<void> => { throw failure }),
    }
    const store = createCardStore(backend)
    await expect(store.read(key, hash)).rejects.toBe(failure)
    await expect(store.verify(key, hash)).rejects.toBe(failure)
    await expect(store.store(data, hash)).rejects.toBe(failure)
    expect(backend.put).toHaveBeenCalledTimes(1)
  })

  it('does not return a reference when durable storage fails', async () => {
    const failure = new Error('disk full')
    const { backend } = fixture()
    backend.put = async (): Promise<void> => { throw failure }
    await expect(createCardStore(backend).store(data, hash)).rejects.toBe(failure)
  })

  it('does not interpret unclassified backend ENOENT errors as confirmed missing objects', async () => {
    const { backend } = fixture()
    const failure = Object.assign(new Error('backend metadata unavailable'), { code: 'ENOENT' })
    backend.get = async (): Promise<Buffer> => { throw failure }
    await expect(createCardStore(backend).verify(key, hash)).rejects.toBe(failure)
  })

  it('owns the verified bytes while asynchronous storage is in progress', async () => {
    const input = Buffer.from(data)
    const { backend, objects } = fixture()
    backend.get = async (): Promise<Buffer> => {
      input.fill(0)
      throw new ObjectMissingError()
    }
    expect(await createCardStore(backend).store(input, hash)).toBe(key)
    expect(objects.get(key)).toEqual(data)
  })
})
