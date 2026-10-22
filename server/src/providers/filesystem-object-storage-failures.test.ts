import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const faults = vi.hoisted(() => ({
  failSyncPath: '',
  failTemporary: '' as '' | 'write' | 'sync' | 'rename',
  failIo: false,
  syncedPaths: [] as string[],
}))
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    readFile: async (...args: Parameters<typeof actual.readFile>): ReturnType<typeof actual.readFile> => {
      if (faults.failIo) throw Object.assign(new Error('injected read failure'), { code: 'EACCES' })
      return actual.readFile(...args)
    },
    stat: async (...args: Parameters<typeof actual.stat>): ReturnType<typeof actual.stat> => {
      if (faults.failIo) throw Object.assign(new Error('injected stat failure'), { code: 'EIO' })
      return actual.stat(...args)
    },
    unlink: async (...args: Parameters<typeof actual.unlink>): ReturnType<typeof actual.unlink> => {
      if (faults.failIo) throw Object.assign(new Error('injected unlink failure'), { code: 'EACCES' })
      return actual.unlink(...args)
    },
    rename: async (...args: Parameters<typeof actual.rename>): ReturnType<typeof actual.rename> => {
      if (faults.failTemporary === 'rename') throw new Error('injected rename failure')
      return actual.rename(...args)
    },
    open: async (...args: Parameters<typeof actual.open>): ReturnType<typeof actual.open> => {
      if (faults.failIo) throw Object.assign(new Error('injected open failure'), { code: 'EIO' })
      const handle = await actual.open(...args)
      if (String(args[0]).endsWith('.tmp') && faults.failTemporary === 'write') {
        handle.writeFile = async (): Promise<void> => { throw new Error('injected write failure') }
      }
      const sync = handle.sync.bind(handle)
      handle.sync = async (): Promise<void> => {
        const path = String(args[0])
        faults.syncedPaths.push(path)
        if (path.endsWith('.tmp') && faults.failTemporary === 'sync') throw new Error('injected sync failure')
        if (path === faults.failSyncPath) throw new Error('injected fsync failure')
        await sync()
      }
      return handle
    },
  }
})

import { cardStorageKey, createCardStore } from '../lib/card-store-core.js'
import { createFilesystemObjectStorage } from './filesystem-object-storage.js'

const data = Buffer.from('durability retry')
const hash = createHash('sha256').update(data).digest('hex')
const key = cardStorageKey(hash)
let temporaryRoot: string

beforeEach(async (): Promise<void> => {
  temporaryRoot = await mkdtemp(join(tmpdir(), 'skillhub-card-durability-'))
  faults.failSyncPath = ''
  faults.failTemporary = ''
  faults.failIo = false
  faults.syncedPaths = []
})
afterEach(async (): Promise<void> => { await rm(temporaryRoot, { recursive: true, force: true }) })

describe('filesystem card durability failures', () => {
  it.each(['write', 'sync', 'rename'] as const)('cleans temporary files after %s failure and preserves previous bytes', async (fault): Promise<void> => {
    const backend = createFilesystemObjectStorage(temporaryRoot)
    await backend.put(key, data)
    faults.failTemporary = fault
    await expect(backend.put(key, Buffer.from('replacement'))).rejects.toThrow(`injected ${fault} failure`)
    expect(await backend.get(key)).toEqual(data)
    expect(await readdir(dirname(join(temporaryRoot, key)))).toEqual([`${hash}.zip`])
  })

  it('propagates permission and I/O errors without classifying them as missing', async () => {
    const backend = createFilesystemObjectStorage(temporaryRoot)
    faults.failIo = true
    await expect(backend.get(key)).rejects.toMatchObject({ code: 'EACCES' })
    await expect(backend.head(key)).rejects.toMatchObject({ code: 'EIO' })
    await expect(backend.delete(key)).rejects.toMatchObject({ code: 'EACCES' })
    await expect(backend.put(key, data)).rejects.toMatchObject({ code: 'EIO' })
  })

  it('syncs nested directories from the object parent through the root only', async () => {
    const backend = createFilesystemObjectStorage(`${temporaryRoot}/`)
    const objectKey = 'media/user/avatar.png'
    await backend.put(objectKey, data)
    faults.syncedPaths = []
    await backend.put(objectKey, data)
    expect(faults.syncedPaths).toEqual([
      join(temporaryRoot, objectKey), join(temporaryRoot, 'media/user'), join(temporaryRoot, 'media'), temporaryRoot,
    ])
  })

  it('requires a fresh store to reconfirm durability even when a failed write left readable bytes', async () => {
    const root = join(temporaryRoot, 'new-parent', 'cards')
    await mkdir(root, { recursive: true })
    faults.failSyncPath = root
    const freshStore = (): ReturnType<typeof createCardStore> => createCardStore(createFilesystemObjectStorage(root))
    await expect(freshStore().store(data, hash)).rejects.toThrow('injected fsync failure')
    expect(await readFile(join(root, key))).toEqual(data)
    // The readable file cannot bypass the still-failing fsync on retry.
    await expect(freshStore().store(data, hash)).rejects.toThrow('injected fsync failure')
    faults.failSyncPath = ''
    faults.syncedPaths = []
    expect(await freshStore().store(data, hash)).toBe(key)
    expect(faults.syncedPaths).toContain(join(root, key))
    expect(faults.syncedPaths).toContain(root)
    expect(faults.syncedPaths).toContain(dirname(join(root, key)))
    expect(faults.syncedPaths).not.toContain(dirname(root))
    expect(faults.syncedPaths).not.toContain(temporaryRoot)
  })
})
