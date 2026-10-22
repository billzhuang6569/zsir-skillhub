import { randomUUID } from 'node:crypto'
import { PrismaClient } from '@prisma/client'
import type { FastifyBaseLogger } from 'fastify'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { SKILL_ART_FIXED_STYLE } from './skill-avatar-prompt.js'

/**
 * #235 on real PostgreSQL: several workers (separate pools, as in several processes, plus
 * raw claimers) race over one batch. Every task is claimed by exactly one of them at a time,
 * FAL is submitted exactly once per task, and no requestId repeats.
 */
const postgresUrl = process.env.SKILLHUB_PG_TEST_URL
const describePostgres = postgresUrl ? describe : describe.skip
describePostgres('Skill avatar worker concurrency (PostgreSQL)', () => {
  const owners = [randomUUID(), randomUUID(), randomUUID()]
  let prisma: PrismaClient
  let avatars: typeof import('./skill-avatars.js')
  const submit = vi.fn(), draft = vi.fn()
  const logger = { warn: vi.fn(), info: vi.fn() } as unknown as FastifyBaseLogger
  const config = { SKILL_AVATARS_ENABLED: true, SKILL_MAX_PER_USER: 50, SKILL_AVATAR_DAILY_LIMIT: 1_000, SKILL_AVATAR_WORKER_CONCURRENCY: 4, SKILL_AVATAR_GENERATE_CONCURRENCY: 2 }
  const mine = { ownerId: { in: owners } }
  beforeAll(async () => {
    prisma = new PrismaClient({ datasources: { db: { url: postgresUrl } } })
    vi.doMock('../db.js', () => ({ db: prisma }))
    vi.doMock('../config.js', () => ({ config }))
    vi.doMock('../routes/skills.js', () => ({ requestConfiguredAiDraft: draft }))
    vi.doMock('./fal.js', async (original) => ({ ...await original<typeof import('./fal.js')>(), submitFalAvatar: submit, pollFalAvatar: vi.fn(), downloadFalAvatar: vi.fn() }))
    vi.doMock('./media.js', () => ({ uploadMedia: vi.fn(), publicImageUrl: (url: string): string => url }))
    avatars = await import('./skill-avatars.js')
    await prisma.user.createMany({ data: owners.map(id => ({ id, email: `avatar-worker-${id}@example.invalid`, displayName: 'Worker QA' })) })
    // Park any active task left by other test files so only this batch is due.
    await prisma.skillAvatar.updateMany({ where: { ownerId: { notIn: owners }, status: { in: ['queued', 'prompting', 'submitting', 'awaiting', 'transferring'] } },
      data: { nextAttemptAt: new Date('2999-01-01T00:00:00.000Z') } })
    const created = Date.now() - 600_000
    await prisma.skillAvatar.createMany({ data: Array.from({ length: 12 }, (_, index) => ({
      ownerId: owners[index % owners.length]!, localSkillId: `worker-${index}`, input: { name: `n${index}`, description: 'd', scenarios: [] },
      inputFingerprint: 'fp', promptVersion: 'v1', status: 'queued', nextAttemptAt: new Date(created + index), queuedAt: new Date(created + index), createdAt: new Date(created + index),
    })) })
  })
  afterAll(async () => {
    if (!prisma) return
    await prisma.avatarSelection.deleteMany({ where: { ownerId: { in: owners } } })
    await prisma.skillAvatarGenerationAttempt.deleteMany({ where: { avatar: { ownerId: { in: owners } } } })
    await prisma.skillAvatar.updateMany({ where: { ownerId: { in: owners } }, data: { currentJobId: null } })
    await prisma.avatarVariant.deleteMany({ where: { ownerId: { in: owners } } })
    await prisma.avatarGenerationJob.deleteMany({ where: { ownerId: { in: owners } } })
    await prisma.user.deleteMany({ where: { id: { in: owners } } })
    await prisma.$disconnect()
  })

  it('concurrent raw claimers claim every task exactly once', async () => {
    const claims = await Promise.all(Array.from({ length: 30 }, () => avatars.claimAvatar(avatars.AVATAR_LANES.generate)))
    const ids = claims.flatMap(avatar => avatar ? [avatar.id] : [])
    expect(ids).toHaveLength(12)
    expect(new Set(ids).size).toBe(12)
    const rows = await prisma.skillAvatar.findMany({ where: mine })
    for (const avatar of claims) if (avatar) expect(rows.find(row => row.id === avatar.id)?.leaseToken).toBe(avatar.leaseToken)
    await prisma.skillAvatar.updateMany({ where: mine, data: { leaseToken: null, leaseUntil: null } })
    // Fair: successive claims rotate over the owners instead of draining the earliest owner's backlog.
    const rotation = [await avatars.claimAvatar(), await avatars.claimAvatar(), await avatars.claimAvatar()]
    expect(new Set(rotation.map(avatar => avatar?.ownerId))).toEqual(new Set(owners))
    await prisma.skillAvatar.updateMany({ where: mine, data: { leaseToken: null, leaseUntil: null } })
  })

  it('three worker pools racing over the batch submit to FAL exactly once per task, with distinct requestIds', async () => {
    draft.mockResolvedValue('A square illustration of a vermilion ribbon gathering mint leaves into a neat bundle. '.repeat(4) + '\n\n' + SKILL_ART_FIXED_STYLE)
    submit.mockImplementation(async () => { await new Promise(resolve => setTimeout(resolve, 15)); return `req-${randomUUID()}` })
    const pools = [0, 1, 2].map(() => avatars.createAvatarWorkerPool(logger, { total: 4, generate: 2 }))
    for (let round = 0; round < 60; round += 1) {
      await Promise.all(pools.map(pool => pool.fill()))
      if (await prisma.skillAvatar.count({ where: { ...mine, status: 'awaiting' } }) === 12) break
      await new Promise(resolve => setTimeout(resolve, 20))
    }
    await Promise.all(pools.map(pool => pool.stop()))
    const rows = await prisma.skillAvatar.findMany({ where: mine })
    expect(rows.map(row => `${row.status}:${row.errorCode ?? ''}:${row.leaseToken ? 'leased' : 'free'}`).sort()).toEqual(Array(12).fill('awaiting::free'))
    expect(rows.every(row => row.status === 'awaiting' && row.requestId && row.leaseToken === null)).toBe(true)
    expect(new Set(rows.map(row => row.requestId)).size).toBe(12)
    expect(submit).toHaveBeenCalledTimes(12)
    expect(rows.some(row => row.status === 'needs_review')).toBe(false)
  })
})
