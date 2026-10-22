import { mirrorSkillAvatar } from './avatar-model.js'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { PrismaClient } from '@prisma/client'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

/**
 * #221 daily avatar quota ledger on real PostgreSQL: the advisory lock, conditional
 * transitions, transaction rollback and the migration's backfill SQL. Today's usage is
 * shared by the whole database, so each case sets the limit relative to what is
 * already used today.
 */
const postgresUrl = process.env.SKILLHUB_PG_TEST_URL
const describePostgres = postgresUrl ? describe : describe.skip
const MIGRATION = new URL('../../prisma/migrations/20261013170000_avatar_generation_attempts/migration.sql', import.meta.url)

describePostgres('Skill avatar generation-attempt ledger (PostgreSQL)', () => {
  const ownerId = randomUUID()
  let prisma: PrismaClient
  let avatars: typeof import('./skill-avatars.js')
  const upload = vi.fn()
  const config = { SKILL_AVATARS_ENABLED: true, SKILL_MAX_PER_USER: 50, SKILL_AVATAR_DAILY_LIMIT: 200 }
  const input = { name: 'Ledger', description: 'Quota ledger fixture', scenarios: [] }
  const READY = { assetId: 'ast_ready', url: 'https://picem-media.whatonearth.work/ready.jpg' }
  const today = (): Date => { const day = new Date(); day.setUTCHours(0, 0, 0, 0); return day }
  const yesterday = (): Date => new Date(today().getTime() - 86_400_000)
  const usedToday = async (): Promise<number> => prisma.skillAvatarGenerationAttempt.count({ where: { day: today(), releasedAt: null } })
  const seedTask = async (fields: Record<string, unknown>): Promise<string> => (await prisma.skillAvatar.create({ data: {
    ownerId, localSkillId: `seed-${randomUUID()}`, input, inputFingerprint: 'fp', promptVersion: 'v1', ...fields,
  } })).id

  beforeAll(async () => {
    prisma = new PrismaClient({ datasources: { db: { url: postgresUrl } } })
    vi.doMock('../db.js', () => ({ db: prisma }))
    vi.doMock('../config.js', () => ({ config }))
    vi.doMock('../routes/skills.js', () => ({ requestConfiguredAiDraft: vi.fn() }))
    vi.doMock('./fal.js', () => ({ submitFalAvatar: vi.fn(), pollFalAvatar: vi.fn(), downloadFalAvatar: vi.fn(), FalError: class extends Error {} }))
    vi.doMock('./media.js', () => ({ uploadMedia: upload, publicImageUrl: (url: string): string => url }))
    avatars = await import('./skill-avatars.js')
    await prisma.user.create({ data: { id: ownerId, email: `avatar-ledger-${ownerId}@example.invalid`, displayName: 'Ledger QA' } })
  })
  afterAll(async () => {
    if (!prisma) return
    config.SKILL_AVATAR_DAILY_LIMIT = 200
    await prisma.avatarSelection.deleteMany({ where: { ownerId: ownerId } })
    await prisma.skillAvatarGenerationAttempt.deleteMany({ where: { avatar: { ownerId: ownerId } } })
    await prisma.skillAvatar.updateMany({ where: { ownerId: ownerId }, data: { currentJobId: null } })
    await prisma.avatarVariant.deleteMany({ where: { ownerId: ownerId } })
    await prisma.avatarGenerationJob.deleteMany({ where: { ownerId: ownerId } })
    await prisma.user.deleteMany({ where: { id: ownerId } }) // cascades tasks and their attempts
    await prisma.$disconnect()
  })

  it('mixed concurrent create / restore / retry at the limit: only the first N pass, the rest are 429 with nothing changed', async () => {
    const restorable = await Promise.all([0, 1].map(() => seedTask({ status: 'cancelled', queuedAt: null, source: 'custom', customAssetId: 'ast', customUrl: 'https://picem-media.whatonearth.work/c.png' })))
    const failed = await Promise.all([0, 1].map(() => seedTask({ status: 'failed', errorCode: 'fal_generation_failed', attempts: 5 })))
    const restoreKeys = await Promise.all(restorable.map(async id => (await prisma.skillAvatar.findUniqueOrThrow({ where: { id } })).localSkillId!))
    config.SKILL_AVATAR_DAILY_LIMIT = await usedToday() + 3
    try {
      const results = await Promise.allSettled([
        avatars.ensureSkillAvatar({ ownerId, localSkillId: 'mixed-new-1', input }),
        avatars.ensureSkillAvatar({ ownerId, localSkillId: 'mixed-new-2', input }),
        ...restoreKeys.map(key => avatars.restoreGeneratedAvatar(ownerId, { localSkillId: key })),
        ...failed.map(id => avatars.retryFailedAvatar(ownerId, id)),
      ])
      expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(3)
      const refused = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected')
      expect(refused).toHaveLength(3)
      for (const result of refused) expect(result.reason).toMatchObject({ statusCode: 429, code: 'AVATAR_DAILY_QUOTA' })
      expect(await usedToday()).toBe(config.SKILL_AVATAR_DAILY_LIMIT)
      // Every refused operation left its task exactly as it was and wrote no attempt.
      const newTasks = await prisma.skillAvatar.findMany({ where: { ownerId, localSkillId: { in: ['mixed-new-1', 'mixed-new-2'] } }, include: { generationAttempts: true } })
      const restoreRows = await prisma.skillAvatar.findMany({ where: { id: { in: restorable } }, include: { generationAttempts: true } })
      const retryRows = await prisma.skillAvatar.findMany({ where: { id: { in: failed } }, include: { generationAttempts: true } })
      for (const task of newTasks) expect(task.generationAttempts.map(item => item.kind)).toEqual(['create'])
      for (const task of restoreRows) {
        if (task.status === 'queued') expect(task.generationAttempts.map(item => item.kind)).toEqual(['restore'])
        else expect(task).toMatchObject({ status: 'cancelled', source: 'custom', queuedAt: null, generationAttempts: [] })
      }
      for (const task of retryRows) {
        if (task.status === 'queued') expect(task.generationAttempts.map(item => item.kind)).toEqual(['retry'])
        else expect(task).toMatchObject({ status: 'failed', errorCode: 'fal_generation_failed', attempts: 5, generationAttempts: [] })
      }
      expect(newTasks.length + restoreRows.filter(task => task.status === 'queued').length + retryRows.filter(task => task.status === 'queued').length).toBe(3)
    } finally { config.SKILL_AVATAR_DAILY_LIMIT = 200 }
  })

  it('HTTP duplicates: concurrent retries of one failed task move it once and write one attempt', async () => {
    const id = await seedTask({ status: 'failed', errorCode: 'x' })
    const results = await Promise.all(Array.from({ length: 6 }, () => avatars.retryFailedAvatar(ownerId, id)))
    expect(results.filter(result => result.transitioned)).toHaveLength(1)
    expect(await prisma.skillAvatarGenerationAttempt.count({ where: { avatarId: id } })).toBe(1)
  })

  it('one task pays twice on the same day: retry → failed again → retry is two attempts', async () => {
    const created = await avatars.ensureSkillAvatar({ ownerId, localSkillId: 'twice', input })
    for (let round = 0; round < 2; round += 1) {
      await prisma.$transaction(async tx => {
        await tx.skillAvatar.update({ where: { id: created.id }, data: { status: 'failed', leaseToken: null } })
        await mirrorSkillAvatar(tx, created.id)
      })
      expect((await avatars.retryFailedAvatar(ownerId, created.id)).transitioned).toBe(true)
    }
    const kinds = (await prisma.skillAvatarGenerationAttempt.findMany({ where: { avatarId: created.id }, orderBy: { createdAt: 'asc' } })).map(item => item.kind)
    expect(kinds).toEqual(['create', 'retry', 'retry'])
    // A continuation (accepted request) is free.
    await prisma.skillAvatar.update({ where: { id: created.id }, data: { status: 'failed', requestId: `req-${randomUUID()}` } })
    expect(await avatars.retryFailedAvatar(ownerId, created.id)).toMatchObject({ transitioned: true, avatar: { status: 'awaiting' } })
    expect(await prisma.skillAvatarGenerationAttempt.count({ where: { avatarId: created.id } })).toBe(3)
  })

  it('counts by UTC day: yesterday\'s attempts never use today\'s quota', async () => {
    const old = await seedTask({ status: 'ready', ...READY })
    await prisma.skillAvatarGenerationAttempt.createMany({ data: Array.from({ length: 5 }, () => ({ avatarId: old, day: yesterday(), kind: 'create', createdAt: yesterday() })) })
    config.SKILL_AVATAR_DAILY_LIMIT = await usedToday() + 1
    try {
      await expect(avatars.ensureSkillAvatar({ ownerId, localSkillId: 'after-midnight', input })).resolves.toMatchObject({ status: 'queued' })
      await expect(avatars.ensureSkillAvatar({ ownerId, localSkillId: 'after-midnight-2', input })).rejects.toMatchObject({ statusCode: 429 })
    } finally { config.SKILL_AVATAR_DAILY_LIMIT = 200 }
  })

  it('a failed transaction leaves no attempt row', async () => {
    const id = await seedTask({ status: 'failed' })
    await expect(prisma.$transaction(async transaction => {
      await avatars.reserveAvatarGeneration(transaction, id, 'retry')
      throw new Error('later step failed')
    })).rejects.toThrow('later step failed')
    expect(await prisma.skillAvatarGenerationAttempt.count({ where: { avatarId: id } })).toBe(0)
  })

  it('cancelling an unclaimed queued task by upload refunds its attempt; a same-day restore nets 1', async () => {
    upload.mockResolvedValue({ assetId: 'ast_ledger', url: 'https://picem-media.whatonearth.work/ledger.png' })
    const png = Buffer.alloc(33); Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(png, 0)
    png.writeUInt32BE(13, 8); png.write('IHDR', 12, 'ascii'); png.writeUInt32BE(512, 16); png.writeUInt32BE(512, 20)
    const before = await usedToday()
    const created = await avatars.ensureSkillAvatar({ ownerId, localSkillId: 'refund', input })
    expect(await usedToday()).toBe(before + 1)
    await avatars.uploadCustomAvatar({ ownerId, localSkillId: 'refund', input, image: { mimeType: 'image/png', dataBase64: png.toString('base64') } })
    expect(await usedToday()).toBe(before)
    await avatars.restoreGeneratedAvatar(ownerId, { localSkillId: 'refund' })
    expect(await usedToday()).toBe(before + 1)
    const rows = await prisma.skillAvatarGenerationAttempt.findMany({ where: { avatarId: created.id }, orderBy: { createdAt: 'asc' } })
    expect(rows.map(item => [item.kind, item.releasedAt !== null])).toEqual([['create', true], ['restore', false]])
  })

  it('the migration backfill: one baseline per queued task on the UTC day of queuedAt, cancelled refunded, idempotent', async () => {
    const backfill = /INSERT INTO "skill_avatar_generation_attempts"[\s\S]*?DO NOTHING;/.exec(readFileSync(MIGRATION, 'utf8'))![0]
    const now = new Date()
    // Created yesterday, re-queued today → baseline today (not on createdAt's day).
    const requeued = await seedTask({ status: 'queued', queuedAt: now })
    await prisma.$executeRaw`UPDATE skill_avatars SET "createdAt" = ${yesterday()} WHERE id = ${requeued}`
    const cancelled = await seedTask({ status: 'cancelled', queuedAt: now, source: 'custom', customAssetId: 'a', customUrl: 'https://picem-media.whatonearth.work/x.png' })
    const uploadOnly = await seedTask({ status: 'cancelled', queuedAt: null, source: 'custom', customAssetId: 'a', customUrl: 'https://picem-media.whatonearth.work/y.png' })
    const queuedYesterday = await seedTask({ status: 'ready', ...READY, queuedAt: new Date(today().getTime() - 1) }) // 23:59:59.999 UTC yesterday
    const ids = [requeued, cancelled, uploadOnly, queuedYesterday]
    // Run it from a session in a non-UTC time zone: the UTC day must not depend on it.
    await prisma.$transaction(async transaction => {
      await transaction.$executeRawUnsafe(`SET LOCAL TIME ZONE 'Asia/Shanghai'`)
      await transaction.$executeRawUnsafe(backfill)
    })
    await prisma.$executeRawUnsafe(backfill) // a second run adds nothing
    const baselines = await prisma.skillAvatarGenerationAttempt.findMany({ where: { avatarId: { in: ids }, kind: 'baseline' } })
    expect(baselines).toHaveLength(3)
    const byTask = new Map(baselines.map(item => [item.avatarId, item]))
    expect(byTask.get(requeued)).toMatchObject({ day: today(), releasedAt: null })
    expect(byTask.get(cancelled)!.day).toEqual(today())
    const cancelledRow = await prisma.skillAvatar.findUniqueOrThrow({ where: { id: cancelled } })
    expect(byTask.get(cancelled)!.releasedAt).toEqual(cancelledRow.updatedAt)
    expect(byTask.has(uploadOnly)).toBe(false)
    expect(byTask.get(queuedYesterday)!.day).toEqual(yesterday())
    // The three numbers for day D = today, on the seeded tasks:
    const D = today()
    const queuedOnD = (await prisma.skillAvatar.findMany({ where: { id: { in: ids }, queuedAt: { gte: D, lt: new Date(D.getTime() + 86_400_000) } } }))
    const baseline = baselines.filter(item => item.day.getTime() === D.getTime()).length
    const refunded = baselines.filter(item => item.day.getTime() === D.getTime() && item.releasedAt !== null).length
    expect(baseline).toBe(queuedOnD.length) // 2
    expect(refunded).toBe(queuedOnD.filter(task => task.status === 'cancelled').length) // 1
    const net = await prisma.skillAvatarGenerationAttempt.count({ where: { avatarId: { in: ids }, day: D, releasedAt: null } })
    expect(net).toBe(baseline - refunded) // 1
    // At most one baseline per task is enforced by the database.
    await expect(prisma.skillAvatarGenerationAttempt.create({ data: { avatarId: requeued, day: D, kind: 'baseline' } })).rejects.toThrow()
    await expect(prisma.skillAvatarGenerationAttempt.create({ data: { avatarId: requeued, day: D, kind: 'bogus' } })).rejects.toThrow()
  })
})
