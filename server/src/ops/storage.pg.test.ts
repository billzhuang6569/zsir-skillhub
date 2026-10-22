import { PrismaClient } from '@prisma/client'
import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { repointStorageRow } from './storage.js'

describe.skipIf(!process.env.SKILLHUB_PG_TEST_URL)('storage namespace migration and CAS', () => {
  it('has nullable columns and rejects stale concurrent attribution updates', async () => {
    const db = new PrismaClient({ datasources: { db: { url: process.env.SKILLHUB_PG_TEST_URL } }, log: [] })
    const id = randomUUID()
    try {
      const columns = await db.$queryRaw<Array<{ table_name: string; is_nullable: string }>>`
        SELECT table_name, is_nullable FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name IN ('skill_cards', 'media_assets') AND column_name = 'storageNamespace'
      `
      expect(columns).toHaveLength(2)
      expect(columns.every(column => column.is_nullable === 'YES')).toBe(true)
      await db.skillCard.create({ data: { sha256: id, contentHash: id, size: 4, storageKey: 'test/key' } })
      await db.mediaAsset.create({ data: { id, purpose: 'feedback', ownerRef: id, visibility: 'private', status: 'ready',
        storageProvider: 'filesystem', storageKey: 'test/key' } })
      for (const kind of ['cards', 'media'] as const) {
        const row = { id, storageProvider: 'filesystem', storageNamespace: null, storageKey: 'test/key' }
        const results = await Promise.all(['s3:first', 's3:second'].map(storageNamespace =>
          repointStorageRow(db, kind, row, { storageProvider: 's3', storageNamespace })))
        expect(results.sort()).toEqual([false, true])
        expect(await repointStorageRow(db, kind, row, { storageProvider: 's3', storageNamespace: 's3:stale' })).toBe(false)
      }
    } finally {
      await db.mediaAsset.deleteMany({ where: { id } })
      await db.skillCard.deleteMany({ where: { sha256: id } })
      await db.$disconnect()
    }
  })
})
