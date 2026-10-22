import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { PrismaClient } from '@prisma/client'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { canonicalJson, classicAvatarStyle, contentSha256 } from './avatar-style-catalog.js'

const postgresUrl = process.env.SKILLHUB_PG_TEST_URL
const describePostgres = postgresUrl ? describe : describe.skip

describePostgres('immutable avatar style cache (PostgreSQL)', () => {
  const schema = `avatar_styles_${randomUUID().replaceAll('-', '')}`
  const logger = { warn: vi.fn() }
  let admin: PrismaClient
  let prisma: PrismaClient
  let styles: typeof import('./avatar-styles.js')

  beforeAll(async (): Promise<void> => {
    admin = new PrismaClient({ datasources: { db: { url: postgresUrl } } })
    await admin.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`)
    const url = new URL(postgresUrl!)
    url.searchParams.set('schema', schema)
    prisma = new PrismaClient({ datasources: { db: { url: url.toString() } } })
    const sql = readFileSync(new URL('../../prisma/migrations/20261018120000_avatar_style_versions/migration.sql', import.meta.url), 'utf8')
    // Blank lines delimit the three migration statements, preserving the PL/pgSQL function body.
    for (const statement of sql.trim().split(/;\n\n/)) await prisma.$executeRawUnsafe(statement)
    vi.doMock('../db.js', () => ({ db: prisma }))
    styles = await import('./avatar-styles.js')
  })
  afterAll(async (): Promise<void> => {
    await prisma?.$disconnect()
    if (admin) {
      await admin.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`)
      await admin.$disconnect()
    }
    vi.doUnmock('../db.js')
  })

  it('applies the migration, stores canonical content/hash/provenance, and keeps all versions', async (): Promise<void> => {
    await styles.cacheAvatarStyles([classicAvatarStyle], 'repository', logger)
    const row = await prisma.avatarStyleVersion.findUniqueOrThrow({ where: { styleId_styleVersion: { styleId: 'classic', styleVersion: 1 } } })
    expect(row).toMatchObject({ content: canonicalJson(classicAvatarStyle), contentSha256: contentSha256(canonicalJson(classicAvatarStyle)), source: 'repository' })
    expect(row.createdAt).toBeInstanceOf(Date)
    await styles.cacheAvatarStyles([{ ...classicAvatarStyle, styleVersion: 2 }], 'fetched', logger)
    expect((await styles.listAvatarStyles()).map(style => style.styleVersion)).toEqual([2])
    expect(await styles.getAvatarStyle('classic', 1)).toEqual(classicAvatarStyle)
  })

  it('concurrent conflicting inserts keep the first row, hash, provenance and timestamp intact', async (): Promise<void> => {
    const original = { ...classicAvatarStyle, styleId: 'concurrent' }
    await styles.cacheAvatarStyles([original], 'repository', logger)
    const where = { styleId_styleVersion: { styleId: 'concurrent', styleVersion: 1 } }
    const before = await prisma.avatarStyleVersion.findUniqueOrThrow({ where })
    logger.warn.mockClear()
    await Promise.all([
      styles.cacheAvatarStyles([original], 'fetched', logger),
      styles.cacheAvatarStyles([{ ...original, directPrompt: 'conflict-do-not-log' }], 'fetched', logger),
    ])
    expect(await prisma.avatarStyleVersion.findUniqueOrThrow({ where })).toEqual(before)
    expect(logger.warn).toHaveBeenCalledExactlyOnceWith({ code: 'avatar_style_hash_conflict', styleId: 'concurrent', styleVersion: 1 }, 'Avatar style version retained')
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain('conflict-do-not-log')
  })

  it('database rejects duplicate keys, updates, deletes, truncation and invalid sources', async (): Promise<void> => {
    const style = { ...classicAvatarStyle, styleId: 'immutable' }
    await styles.cacheAvatarStyles([style], 'fetched', logger)
    const before = await prisma.avatarStyleVersion.count()
    await expect(prisma.$executeRaw`INSERT INTO "avatar_style_versions" SELECT * FROM "avatar_style_versions" WHERE "styleId" = 'immutable'`).rejects.toThrow()
    await expect(prisma.$executeRaw`UPDATE "avatar_style_versions" SET "source" = 'repository' WHERE "styleId" = 'immutable'`).rejects.toThrow('avatar_style_version_immutable')
    await expect(prisma.$executeRaw`DELETE FROM "avatar_style_versions" WHERE "styleId" = 'immutable'`).rejects.toThrow('avatar_style_version_immutable')
    await expect(prisma.$executeRaw`TRUNCATE "avatar_style_versions"`).rejects.toThrow('avatar_style_version_immutable')
    await expect(prisma.$executeRaw`INSERT INTO "avatar_style_versions" ("styleId", "styleVersion", "content", "contentSha256", "source") VALUES ('invalid', 1, '{}', ${'0'.repeat(64)}, 'invalid')`).rejects.toThrow()
    expect(await prisma.avatarStyleVersion.count()).toBe(before)
    expect(await styles.getAvatarStyle('immutable', 1)).toEqual(style)
  })
})
