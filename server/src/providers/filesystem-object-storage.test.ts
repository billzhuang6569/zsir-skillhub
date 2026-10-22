import { createHash } from 'node:crypto'
import { chmod, mkdtemp, mkdir, open, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { cardStorageKey, createCardStore } from '../lib/card-store-core.js'
import { ObjectMissingError } from './object-storage.js'
import { createFilesystemObjectStorage } from './filesystem-object-storage.js'
import { objectStorageContract } from './object-storage-contract.js'

const data = Buffer.from('filesystem card')
const hash = createHash('sha256').update(data).digest('hex')
const key = cardStorageKey(hash)
let temporaryRoot: string

beforeEach(async (): Promise<void> => { temporaryRoot = await mkdtemp(join(tmpdir(), 'skillhub-card-provider-')) })
afterEach(async (): Promise<void> => { await rm(temporaryRoot, { recursive: true, force: true }) })
objectStorageContract('filesystem object contract', () => createFilesystemObjectStorage(temporaryRoot))

describe('filesystem card storage', () => {
  it('reuses identical files and atomically replaces different bytes', async () => {
    const backend = createFilesystemObjectStorage(temporaryRoot)
    await backend.put(key, data)
    const before = await stat(join(temporaryRoot, key))
    await backend.put(key, data)
    expect((await stat(join(temporaryRoot, key))).ino).toBe(before.ino)
    const original = await open(join(temporaryRoot, key), 'r')
    try {
      const replacement = Buffer.from('replacement bytes')
      await backend.put(key, replacement)
      expect(await backend.get(key)).toEqual(replacement)
      expect(await original.readFile()).toEqual(data)
      expect(await readdir(join(temporaryRoot, hash.slice(0, 2)))).toEqual([`${hash}.zip`])
    } finally {
      await original.close()
    }
  })

  it('owns direct put input across asynchronous writes', async () => {
    const backend = createFilesystemObjectStorage(temporaryRoot)
    const input = Buffer.from(data)
    const pending = backend.put(key, input)
    input.fill(0)
    await pending
    expect(await backend.get(key)).toEqual(data)
  })

  it('propagates non-missing path errors for every operation', async () => {
    const backend = createFilesystemObjectStorage(temporaryRoot)
    await writeFile(join(temporaryRoot, 'file'), data)
    await expect(backend.get('file/child')).rejects.toMatchObject({ code: 'ENOTDIR' })
    await expect(backend.head('file/child')).rejects.toMatchObject({ code: 'ENOTDIR' })
    await expect(backend.put('file/child', data)).rejects.toMatchObject({ code: 'ENOTDIR' })
    await expect(backend.delete('file/child')).rejects.toMatchObject({ code: 'ENOTDIR' })
    await mkdir(join(temporaryRoot, 'directory'))
    await expect(backend.head('directory')).rejects.toThrow('not a file')
    await expect(backend.delete('directory')).rejects.toThrow()
    expect((await stat(join(temporaryRoot, 'directory'))).isDirectory()).toBe(true)
  })

  it('requires an absolute root and validates keys even for direct backend calls', async () => {
    expect(() => createFilesystemObjectStorage('relative')).toThrow('absolute path')
    const backend = createFilesystemObjectStorage(temporaryRoot)
    for (const invalid of ['', '../private', '/absolute', 'a/../b', 'a\\b', 'a//b', 'a/', './a', 'a/..', 'a..b', 'a b', 'a%2fb', 'a\n', 'a/雪']) {
      await expect(backend.get(invalid)).rejects.toThrow('Invalid object storage key')
      await expect(backend.put(invalid, data)).rejects.toThrow('Invalid object storage key')
      await expect(backend.head(invalid)).rejects.toThrow('Invalid object storage key')
      await expect(backend.delete(invalid)).rejects.toThrow('Invalid object storage key')
    }
    expect(await readdir(temporaryRoot)).toEqual([])
  })

  it('isolates roots and maps only ENOENT to a missing object', async () => {
    await mkdir(join(temporaryRoot, 'a'))
    const a = createFilesystemObjectStorage(join(temporaryRoot, 'a'))
    const b = createFilesystemObjectStorage(join(temporaryRoot, 'b'))
    await createCardStore(a).store(data, hash)
    expect(await a.get(key)).toEqual(data)
    await expect(b.get(key)).rejects.toBeInstanceOf(ObjectMissingError)
    await mkdir(join(temporaryRoot, 'b', key), { recursive: true })
    await expect(b.get(key)).rejects.toMatchObject({ code: 'EISDIR' })
    await expect(createCardStore(b).verify(key, hash)).rejects.toMatchObject({ code: 'EISDIR' })
  })

  it('requires deployment to provision the storage root', async () => {
    const root = join(temporaryRoot, 'not-provisioned')
    const store = createCardStore(createFilesystemObjectStorage(root))
    await expect(store.store(data, hash)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readdir(temporaryRoot)).toEqual([])
  })

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('works below a traverse-only ancestor without requiring its read permission', async () => {
    const ancestor = join(temporaryRoot, 'traverse-only')
    const root = join(ancestor, 'cards')
    await mkdir(root, { recursive: true })
    await chmod(ancestor, 0o111)
    try {
      const store = createCardStore(createFilesystemObjectStorage(root))
      expect(await store.store(data, hash)).toBe(key)
      expect(await store.store(data, hash)).toBe(key)
      expect(await store.read(key, hash)).toEqual(data)
    } finally {
      await chmod(ancestor, 0o700)
    }
  })

  it('publishes concurrent identical writes as one complete file with no temporary residue', async () => {
    const store = createCardStore(createFilesystemObjectStorage(temporaryRoot))
    expect(await Promise.all(Array.from({ length: 12 }, () => store.store(data, hash)))).toEqual(Array(12).fill(key))
    expect(await store.read(key, hash)).toEqual(data)
    expect(await readdir(join(temporaryRoot, hash.slice(0, 2)))).toEqual([`${hash}.zip`])
    if (process.platform !== 'win32') {
      expect((await stat(join(temporaryRoot, key))).mode & 0o777).toBe(0o640 & ~process.umask())
      expect((await stat(join(temporaryRoot, hash.slice(0, 2)))).mode & 0o777).toBe(0o750 & ~process.umask())
    }
  })

  it('removes the temporary file when publication fails without deleting the destination', async () => {
    const backend = createFilesystemObjectStorage(temporaryRoot)
    await mkdir(join(temporaryRoot, key), { recursive: true })
    await expect(backend.put(key, data)).rejects.toThrow()
    expect((await stat(join(temporaryRoot, key))).isDirectory()).toBe(true)
    expect(await readdir(join(temporaryRoot, hash.slice(0, 2)))).toEqual([`${hash}.zip`])
  })
})
