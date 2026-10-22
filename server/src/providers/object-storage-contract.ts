import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { ObjectMissingError, type ObjectStorage } from './object-storage.js'

export function objectStorageContract(name: string, storage: () => ObjectStorage): void {
  describe(name, () => {
    it('round-trips flat/nested keys, metadata, repeated put and missing/delete semantics', async (): Promise<void> => {
      const backend = storage()
      for (const key of [`${randomUUID()}.png`, `${randomUUID()}/nested/Avatar_2.jpg`]) {
        const bytes = Buffer.from('object contract')
        try {
          expect(await backend.head(key)).toBeNull()
          await expect(backend.get(key)).rejects.toBeInstanceOf(ObjectMissingError)
          await backend.delete(key)
          await backend.put(key, bytes)
          await backend.put(key, bytes)
          expect(await backend.get(key)).toEqual(bytes)
          expect(await backend.head(key)).toEqual({ size: bytes.length })
          await backend.put(key, Buffer.from('replacement'))
          expect(await backend.get(key)).toEqual(Buffer.from('replacement'))
          await backend.delete(key)
          await backend.delete(key)
          expect(await backend.head(key)).toBeNull()
          await expect(backend.get(key)).rejects.toBeInstanceOf(ObjectMissingError)
        } finally { await backend.delete(key) }
      }
    }, 120_000)
    it('rejects invalid keys for every operation', async (): Promise<void> => {
      const backend = storage()
      for (const key of ['', '../private', '/absolute', 'a/../b', 'a\\b', 'a//b', 'a/', './a', 'a/..', 'a..b', 'a b', 'a%2fb', 'a\n', 'a/雪']) {
        await expect(backend.get(key)).rejects.toThrow('Invalid object storage key')
        await expect(backend.head(key)).rejects.toThrow('Invalid object storage key')
        await expect(backend.put(key, Buffer.from('bytes'))).rejects.toThrow('Invalid object storage key')
        await expect(backend.delete(key)).rejects.toThrow('Invalid object storage key')
      }
    }, 120_000)
    it('publishes concurrent identical writes as complete bytes', async (): Promise<void> => {
      const backend = storage()
      const key = `${randomUUID()}/concurrent.zip`
      const bytes = Buffer.from('concurrent object')
      try {
        await Promise.all(Array.from({ length: 12 }, () => backend.put(key, bytes)))
        expect(await backend.get(key)).toEqual(bytes)
        expect(await backend.head(key)).toEqual({ size: bytes.length })
      } finally { await backend.delete(key) }
    }, 120_000)
  })
}
