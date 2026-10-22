import { randomUUID } from 'node:crypto'
import { PrismaClient } from '@prisma/client'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

/** #246 on real PostgreSQL: an applied ops retry adds exactly one ledger row and queues the task. */
const postgresUrl = process.env.SKILLHUB_PG_TEST_URL
const describePostgres = postgresUrl ? describe : describe.skip
describePostgres('Skill avatar ops retry (PostgreSQL)', () => {
  const ownerId = randomUUID()
  let prisma: PrismaClient
  let ops: typeof import('./skill-avatars.js')
  const config = { SKILL_AVATARS_ENABLED: true, SKILL_MAX_PER_USER: 50, SKILL_AVATAR_DAILY_LIMIT: 1_000 }
  beforeAll(async () => {
    prisma = new PrismaClient({ datasources: { db: { url: postgresUrl } } })
    vi.doMock('../db.js', () => ({ db: prisma }))
    vi.doMock('../config.js', () => ({ config }))
    vi.doMock('../routes/skills.js', () => ({ requestConfiguredAiDraft: vi.fn() }))
    vi.doMock('../lib/media.js', () => ({ uploadMedia: vi.fn(), publicImageUrl: (url: string): string => url }))
    ops = await import('./skill-avatars.js')
    await prisma.user.create({ data: { id: ownerId, email: `avatar-ops-retry-${ownerId}@example.invalid`, displayName: 'Ops retry QA' } })
  })
  afterAll(async () => {
    if (!prisma) return
    await prisma.avatarSelection.deleteMany({ where: { ownerId: ownerId } })
    await prisma.skillAvatarGenerationAttempt.deleteMany({ where: { avatar: { ownerId: ownerId } } })
    await prisma.skillAvatar.updateMany({ where: { ownerId: ownerId }, data: { currentJobId: null } })
    await prisma.avatarVariant.deleteMany({ where: { ownerId: ownerId } })
    await prisma.avatarGenerationJob.deleteMany({ where: { ownerId: ownerId } })
    await prisma.skill.deleteMany({ where: { authorId: ownerId } })
    await prisma.user.deleteMany({ where: { id: ownerId } })
    await prisma.$disconnect()
  })

  it('apply: failed → queued, one retry ledger row, Skill pending; a re-run changes nothing', async () => {
    const skill = await prisma.skill.create({ data: { authorId: ownerId, name: 'ops-retry', displayName: 'Ops retry', avatarStatus: 'failed' } })
    const task = await prisma.skillAvatar.create({ data: { ownerId, skillId: skill.id, input: { name: 'n', description: 'd', scenarios: [] }, inputFingerprint: 'fp',
      promptVersion: 'v1', status: 'failed', errorCode: 'upstream_unavailable', attempts: 5, queuedAt: new Date(Date.now() - 4 * 86_400_000) } })
    const preview = await ops.runAvatarOperation(ops.parseAvatarOperation(['retry', '--task', task.id])) as { tasks: Array<{ outcome: string; target: string }> }
    expect(preview.tasks[0]).toMatchObject({ outcome: 'would_retry', target: 'queued' })
    expect(await prisma.skillAvatarGenerationAttempt.count({ where: { avatarId: task.id } })).toBe(0)

    const applied = await ops.runAvatarOperation(ops.parseAvatarOperation(['retry', '--apply', '--task', task.id])) as { tasks: Array<{ outcome: string }> }
    expect(applied.tasks[0]!.outcome).toBe('retried')
    expect(await prisma.skillAvatar.findUniqueOrThrow({ where: { id: task.id } })).toMatchObject({ status: 'queued', attempts: 0, errorCode: null })
    const ledger = await prisma.skillAvatarGenerationAttempt.findMany({ where: { avatarId: task.id } })
    expect(ledger.map(row => [row.kind, row.releasedAt])).toEqual([['retry', null]])
    expect((await prisma.skill.findUniqueOrThrow({ where: { id: skill.id } })).avatarStatus).toBe('pending')

    await ops.runAvatarOperation(ops.parseAvatarOperation(['retry', '--apply', '--task', task.id]))
    expect(await prisma.skillAvatarGenerationAttempt.count({ where: { avatarId: task.id } })).toBe(1)
  })
})
