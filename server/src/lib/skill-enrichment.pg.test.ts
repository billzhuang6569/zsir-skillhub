import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { PrismaClient } from '@prisma/client'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

const url = process.env.SKILLHUB_PG_TEST_URL
describe.skipIf(!url)('PostgreSQL enrichment leases and profile CAS', () => {
  const owner = randomUUID()
  let prisma: PrismaClient
  let worker: typeof import('./skill-enrichment.js')
  const analyze = vi.fn()
  beforeAll(async () => {
    prisma = new PrismaClient({ datasources: { db: { url } } })
    const scoped = prisma.$extends({ query: {
      skill: { async findMany({ args, query }) {
        args.where = { AND: [args.where ?? {}, { authorId: owner }] }
        return query(args)
      } },
      skillEnrichment: { async findMany({ args, query }) {
        args.where = { AND: [args.where ?? {}, { skill: { authorId: owner } }] }
        return query(args)
      } },
    } })
    vi.doMock('../db.js', () => ({ db: scoped }))
    vi.doMock('../routes/skills.js', () => ({ analyzeSkillWithAI: analyze, requestConfiguredAiDraft: vi.fn() }))
    vi.doMock('./ai-settings.js', () => ({ aiStatus: () => ({ configured: true }), resolveAiConfig: vi.fn() }))
    worker = await import('./skill-enrichment.js')
    await prisma.user.create({ data: { id: owner, email: `${owner}@example.test`, displayName: 'Enrichment fixture' } })
  })
  afterAll(async () => {
    if (!prisma) return
    await prisma.skill.deleteMany({ where: { authorId: owner } })
    await prisma.user.delete({ where: { id: owner } })
    await prisma.$disconnect()
    vi.doUnmock('../db.js'); vi.doUnmock('../routes/skills.js'); vi.doUnmock('./ai-settings.js')
  })
  it('installs the partial compensation index on existing Skill rows', async () => {
    const indexes = await prisma.$queryRaw<Array<{ indexdef: string }>>`
      SELECT indexdef FROM pg_indexes WHERE schemaname = current_schema()
      AND tablename = 'skills' AND indexname = 'skills_enrichment_candidates_idx'`
    expect(indexes).toHaveLength(1)
    expect(indexes[0].indexdef).toContain("'unanalysed'")
    expect(indexes[0].indexdef).toContain('"deletedAt" IS NULL')
    expect(indexes[0].indexdef).toContain('"avatarUrl" IS NULL')
  })
  it('backfills historical manual metadata and labels conservatively using the migration SQL', async () => {
    const migration = readFileSync(new URL('../../prisma/migrations/20261024160000_skill_enrichment/migration.sql', import.meta.url), 'utf8')
    const backfill = migration.slice(migration.indexOf('UPDATE "skills"'), migration.indexOf('CREATE INDEX'))
    await prisma.$transaction(async tx => {
      await tx.$executeRawUnsafe(`CREATE TEMP TABLE skills (
        id text, "analysisStatus" text DEFAULT 'unanalysed', "profileManuallyEdited" boolean DEFAULT false,
        "labelsManuallyEdited" boolean DEFAULT false, "importVersionId" text, "displayName" text,
        description text, category text, "triggerScenarios" jsonb DEFAULT '[]', labels jsonb DEFAULT '[]'
      ) ON COMMIT DROP`)
      await tx.$executeRawUnsafe(`CREATE TEMP TABLE skill_versions (
        id text, "skillId" text, "profileSnapshotVersion" integer DEFAULT 1, "createdAt" timestamp DEFAULT now(),
        "displayName" text, description text, category text, "triggerScenarios" jsonb DEFAULT '[]'
      ) ON COMMIT DROP`)
      await tx.$executeRawUnsafe(`INSERT INTO skills (id, "displayName", description, labels, "importVersionId") VALUES
        ('same', 'Original', 'Original description', '[]', 'import-same'),
        ('edited', 'My title', 'My description', '["manual"]', 'import-edited'),
        ('import-diff', 'Latest', 'Latest description', '[]', 'import-old'),
        ('no-snapshot', 'Hand written', 'Hand written description', '["manual"]', NULL),
        ('no-snapshot-default', 'folder-name', '', '[]', NULL)`)
      await tx.$executeRawUnsafe(`INSERT INTO skill_versions (id, "skillId", "displayName", description, "createdAt") VALUES
        ('import-same', 'same', 'Original', 'Original description', '2026-01-01'),
        ('import-edited', 'edited', 'Original', 'Original description', '2026-01-01'),
        ('import-old', 'import-diff', 'Original', 'Original description', '2026-01-01'),
        ('latest', 'import-diff', 'Latest', 'Latest description', '2026-02-01')`)
      for (const statement of backfill.split(';').filter(sql => sql.trim())) await tx.$executeRawUnsafe(statement)
      const rows = await tx.$queryRaw<Array<{ id: string; profileManuallyEdited: boolean; labelsManuallyEdited: boolean }>>`
        SELECT id, "profileManuallyEdited", "labelsManuallyEdited" FROM skills ORDER BY id`
      expect(rows).toEqual([
        { id: 'edited', profileManuallyEdited: true, labelsManuallyEdited: true },
        { id: 'import-diff', profileManuallyEdited: true, labelsManuallyEdited: false },
        { id: 'no-snapshot', profileManuallyEdited: true, labelsManuallyEdited: true },
        { id: 'no-snapshot-default', profileManuallyEdited: true, labelsManuallyEdited: false },
        { id: 'same', profileManuallyEdited: false, labelsManuallyEdited: false },
      ])
    })
  })
  it('claims once across workers and keeps imported/manual labels', async () => {
    const skill = await prisma.skill.create({ data: { authorId: owner, name: 'new', displayName: 'Raw', sourceContent: '# Latest', labels: ['manual'] } })
    analyze.mockImplementation(async () => ({ source: 'ai', profile: { displayName: 'Analyzed', description: 'Result', category: null, labels: ['ai'], triggerScenarios: [] } }))
    await Promise.all([worker.enrichmentCycle(), worker.enrichmentCycle()])
    expect(analyze).toHaveBeenCalledOnce()
    expect(await prisma.skill.findUniqueOrThrow({ where: { id: skill.id } })).toMatchObject({ analysisStatus: 'completed', displayName: 'Analyzed', labels: ['manual'] })
    expect(await prisma.skillEnrichment.findUniqueOrThrow({ where: { skillId: skill.id } })).toMatchObject({ phase: 'avatar', leaseToken: null })
  })
  it('a concurrent manual edit defeats the stale AI result', async () => {
    const skill = await prisma.skill.create({ data: { authorId: owner, name: 'edited', displayName: 'Raw', sourceContent: '# Source' } })
    analyze.mockImplementation(async () => {
      await prisma.skill.update({ where: { id: skill.id }, data: { displayName: 'My edit', profileManuallyEdited: true } })
      return { source: 'ai', profile: { displayName: 'Stale AI', labels: [], triggerScenarios: [] } }
    })
    await worker.enrichmentCycle()
    expect(await prisma.skill.findUniqueOrThrow({ where: { id: skill.id } })).toMatchObject({ displayName: 'My edit', analysisStatus: 'unanalysed' })
  })
  it('commits despite concurrent install counters and bounds a reclaimed paid attempt', async () => {
    const skill = await prisma.skill.create({ data: { authorId: owner, name: 'installed', displayName: 'Raw', sourceContent: '# Source' } })
    analyze.mockImplementation(async () => {
      await prisma.skill.update({ where: { id: skill.id }, data: { installCount: { increment: 1 } } })
      expect((await prisma.skillEnrichment.findUniqueOrThrow({ where: { skillId: skill.id } })).attempts).toBe(1)
      return { source: 'ai', profile: { displayName: 'Analyzed', labels: [], triggerScenarios: [] } }
    })
    await worker.enrichmentCycle()
    expect(await prisma.skill.findUniqueOrThrow({ where: { id: skill.id } })).toMatchObject({ analysisStatus: 'completed', installCount: 1 })
    const crashed = await prisma.skill.create({ data: { authorId: owner, name: 'crashed', displayName: 'Raw', sourceContent: '# Source',
      enrichment: { create: { attempts: 5, leaseToken: 'crashed-process', leaseUntil: new Date(0) } } } })
    analyze.mockClear()
    await worker.enrichmentCycle()
    expect(analyze).not.toHaveBeenCalled()
    expect(await prisma.skillEnrichment.findUniqueOrThrow({ where: { skillId: crashed.id } })).toMatchObject({ phase: 'failed', attempts: 5 })
  })
  it('recovers an expired lease but never claims a live lease; inherited copies stay out', async () => {
    const skill = await prisma.skill.create({ data: { authorId: owner, name: 'restart', displayName: 'Raw', sourceContent: '# Source',
      enrichment: { create: { leaseToken: 'dead-process', leaseUntil: new Date(0) } } } })
    const copy = await prisma.skill.create({ data: { authorId: owner, name: 'copy', displayName: 'Inherited', analysisStatus: 'completed' } })
    const live = await prisma.skill.create({ data: { authorId: owner, name: 'live', displayName: 'Raw',
      enrichment: { create: { leaseToken: 'live-process', leaseUntil: new Date(Date.now() + 600_000) } } } })
    analyze.mockResolvedValue({ source: 'ai', profile: { displayName: 'Recovered', labels: [], triggerScenarios: [] } })
    await worker.enrichmentCycle()
    expect((await prisma.skill.findUniqueOrThrow({ where: { id: skill.id } })).analysisStatus).toBe('completed')
    expect(await prisma.skillEnrichment.findUnique({ where: { skillId: copy.id } })).toBeNull()
    expect((await prisma.skillEnrichment.findUniqueOrThrow({ where: { skillId: live.id } })).leaseToken).toBe('live-process')
  })
})
