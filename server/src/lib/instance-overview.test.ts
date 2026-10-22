import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { directoryUsage } from './instance-overview.js'

describe('bounded storage usage', () => {
  it('counts files without following symlinks and marks entry/time limits incomplete', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ai-storage-'))
    try {
      await mkdir(join(root, 'nested'))
      await writeFile(join(root, 'nested', 'file'), '123456')
      await symlink(join(root, 'nested'), join(root, 'link'))
      expect(await directoryUsage(root)).toMatchObject({ bytes: 6, complete: true })
      expect(await directoryUsage(root, 1)).toMatchObject({ entries: 1, complete: false })
      expect(await directoryUsage(root, 100, 0)).toMatchObject({ entries: 0, complete: false })
      expect(await directoryUsage(join(root, 'missing'))).toMatchObject({ bytes: 0, complete: false })
    } finally { await rm(root, { recursive: true, force: true }) }
  })
})
