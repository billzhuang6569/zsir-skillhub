import { randomUUID } from 'node:crypto'
import { mkdir, open, readFile, rename, rm, stat, unlink } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { assertObjectStorageKey, ObjectMissingError, type ObjectStorage } from './object-storage.js'

function isMissingFile(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT'
}

async function fsyncDirectory(path: string): Promise<void> {
  const handle = await open(path, 'r')
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
}

export function createFilesystemObjectStorage(rootDirectory: string): ObjectStorage {
  if (!isAbsolute(rootDirectory)) throw new Error('Object storage root must be an absolute path')
  const root = resolve(rootDirectory)

  function objectPath(key: string): string {
    assertObjectStorageKey(key)
    return join(root, key)
  }

  async function get(key: string): Promise<Buffer> {
    try {
      return await readFile(objectPath(key))
    } catch (error: unknown) {
      if (isMissingFile(error)) throw new ObjectMissingError()
      throw error
    }
  }

  async function head(key: string): Promise<{ size: number } | null> {
    try {
      const info = await stat(objectPath(key))
      if (!info.isFile()) throw new Error('Storage object is not a file')
      return { size: info.size }
    } catch (error: unknown) {
      if (isMissingFile(error)) return null
      throw error
    }
  }

  async function deleteObject(key: string): Promise<void> {
    try {
      await unlink(objectPath(key))
    } catch (error: unknown) {
      if (!isMissingFile(error)) throw error
    }
  }

  async function syncDirectories(directory: string): Promise<void> {
    // Deployment owns the durable root; never read its traverse-only ancestors.
    for (let current = directory; ; current = dirname(current)) {
      await fsyncDirectory(current)
      if (current === root) break
    }
  }

  async function existingMatches(path: string, data: Buffer): Promise<boolean> {
    let handle
    try {
      handle = await open(path, 'r')
    } catch (error: unknown) {
      if (isMissingFile(error)) return false
      throw error
    }
    try {
      const info = await handle.stat()
      if (!info.isFile() || info.size !== data.length || !(await handle.readFile()).equals(data)) return false
      await handle.sync()
      return true
    } finally {
      await handle.close()
    }
  }

  async function put(key: string, data: Buffer): Promise<void> {
    const path = objectPath(key)
    const directory = dirname(path)
    const bytes = Buffer.from(data)
    if (await existingMatches(path, bytes)) {
      await syncDirectories(directory)
      return
    }
    let parent = root
    for (const part of key.split('/').slice(0, -1)) {
      parent = join(parent, part)
      try {
        // Non-recursive mkdir must not implicitly provision the storage root.
        await mkdir(parent, { mode: 0o750 })
      } catch (error: unknown) {
        if (typeof error !== 'object' || error === null || !('code' in error) || error.code !== 'EEXIST') throw error
      }
    }
    const temporary = join(directory, `.${randomUUID()}.tmp`)
    try {
      const handle = await open(temporary, 'wx', 0o640)
      try {
        await handle.writeFile(bytes)
        await handle.sync()
      } finally {
        await handle.close()
      }
      await rename(temporary, path)
      await syncDirectories(directory)
    } catch (error: unknown) {
      // Preserve the failure and any published bytes for a durability retry.
      await rm(temporary, { force: true }).catch(() => undefined)
      throw error
    }
  }

  return { provider: 'filesystem', get, head, put, delete: deleteObject }
}
