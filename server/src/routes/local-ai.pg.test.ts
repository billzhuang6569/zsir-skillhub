import { PrismaClient, type Prisma } from '@prisma/client'
import { randomUUID } from 'node:crypto'
import Fastify, { type FastifyInstance } from 'fastify'
import jwt from '@fastify/jwt'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { LocalAiInput } from '../lib/local-ai-tasks.js'

const postgresUrl = process.env['SKILLHUB_PG_TEST_URL']
type LeaseResponse = { leaseId: string; skillId: string; inputHash: string; configVersion: string; input: LocalAiInput }
const profile = { displayName: '周报', description: '整理文档', category: '协作与办公', labels: ['文档处理', '办公效率'], triggerScenarios: [] }

describe.skipIf(!postgresUrl)('PostgreSQL local AI leases', () => {
  let prisma: PrismaClient
  let routes: typeof import('./local-ai.js')
  let app: FastifyInstance
  let peer: FastifyInstance
  let headers: { authorization: string }
  const userId = randomUUID()
  const otherId = randomUUID()
  const instanceId = randomUUID()
  const avatarIds: string[] = []

  async function createApp(): Promise<FastifyInstance> {
    const instance = Fastify()
    await instance.register(jwt, { secret: 'local-ai-pg-test-only-signing-key' })
    await instance.register(routes.localAiRoutes, { prefix: '/api/local-ai' })
    return instance
  }
  async function createSkill(name: string = 'weekly'): Promise<string> {
    const skill = await prisma.skill.create({ data: { authorId: userId, name, displayName: name,
      sourceContent: '# Weekly', description: 'Weekly', labels: ['manual'] } })
    return skill.id
  }
  async function claim(instance: FastifyInstance = app): Promise<Awaited<ReturnType<FastifyInstance['inject']>>> {
    return instance.inject({ method: 'POST', url: '/api/local-ai/leases', headers, payload: { types: ['analyzeSkill'] } })
  }
  async function submit(lease: LeaseResponse): Promise<Awaited<ReturnType<FastifyInstance['inject']>>> {
    return app.inject({ method: 'POST', url: `/api/local-ai/leases/${lease.leaseId}/result`, headers,
      payload: { inputHash: lease.inputHash, configVersion: lease.configVersion, profile } })
  }

  beforeAll(async (): Promise<void> => {
    prisma = new PrismaClient({ datasources: { db: { url: postgresUrl } } })
    vi.doMock('../db.js', () => ({ db: prisma }))
    const { configSchema } = await import('../config-schema.js')
    vi.doMock('../config.js', () => ({ config: configSchema.parse({ ...process.env, SKILLHUB_PROFILE: 'selfhost' }) }))
    vi.doMock('../lib/ai-settings.js', () => ({ aiStatus: () => ({ configured: false, source: 'none' }) }))
    vi.doMock('../lib/instance-identity.js', () => ({ getInstanceIdentity: () => ({ id: instanceId }) }))
    routes = await import('./local-ai.js')
    await prisma.user.createMany({ data: [userId, otherId].map(id => ({ id, email: `${id}@test.invalid`, displayName: 'Lease test' })) })
  })
  beforeEach(async (): Promise<void> => {
    app = await createApp(); peer = await createApp()
    headers = { authorization: `Bearer ${app.jwt.sign({ sub: userId, ver: 0 })}` }
  })
  afterEach(async (): Promise<void> => {
    await app?.close(); await peer?.close()
    // Constraint fixtures have no selections/variants/current pointers. Deleting
    // their Jobs also cascades their draft leases before deleting the anchors.
    await prisma?.avatarGenerationJob.deleteMany({ where: { logicalSkillId: { in: avatarIds } } })
    await prisma?.skillAvatar.deleteMany({ where: { id: { in: avatarIds } } })
    avatarIds.length = 0
    await prisma?.skill.deleteMany({ where: { authorId: userId } })
  })
  afterAll(async (): Promise<void> => {
    if (prisma) {
      await prisma.localAiLease.deleteMany({ where: { userId: { in: [userId, otherId] } } })
      await prisma.skill.deleteMany({ where: { authorId: userId } })
      await prisma.user.deleteMany({ where: { id: { in: [userId, otherId] } } })
      await prisma.$disconnect()
    }
    for (const path of ['../db.js', '../config.js', '../lib/ai-settings.js', '../lib/instance-identity.js']) vi.doUnmock(path)
  })

  it('serializes concurrent claims across app instances into one lease', async (): Promise<void> => {
    const skillId = await createSkill()
    const responses = await Promise.all([claim(app), claim(peer)])
    expect(responses.map(response => response.statusCode).sort()).toEqual([200, 204])
    const lease = responses.find(response => response.statusCode === 200)!.json<LeaseResponse>()
    expect(lease.skillId).toBe(skillId)
    expect(await prisma.localAiLease.count({ where: { skillId } })).toBe(1)
    expect(await prisma.localAiLease.findUnique({ where: { id: lease.leaseId } })).toMatchObject({ userId, state: 'leased', tokenVersion: 0 })
  })
  it('rejects a result after source content changes', async (): Promise<void> => {
    const skillId = await createSkill()
    const lease = (await claim()).json<LeaseResponse>()
    await prisma.skill.update({ where: { id: skillId }, data: { sourceContent: '# Edited' } })
    const response = await submit(lease)
    expect(response.statusCode).toBe(409); expect(response.json().code).toBe('LEASE_STALE')
    expect((await prisma.skill.findUniqueOrThrow({ where: { id: skillId } })).analysisStatus).toBe('unanalysed')
    expect(await prisma.localAiLease.count({ where: { skillId } })).toBe(1)
  })
  it('stops the same hash after three failures, respects backoff, and resets after content changes', async (): Promise<void> => {
    const skillId = await createSkill()
    let previous: LeaseResponse | undefined
    for (let count = 1; count <= 3; count += 1) {
      const response = await claim()
      expect(response.statusCode).toBe(200)
      const lease = response.json<LeaseResponse>()
      if (previous) expect(lease.leaseId).not.toBe(previous.leaseId)
      const started = Date.now()
      expect((await app.inject({ method: 'POST', url: `/api/local-ai/leases/${lease.leaseId}/failure`, headers, payload: { code: 'TIMEOUT' } })).statusCode).toBe(204)
      const row = await prisma.localAiLease.findUniqueOrThrow({ where: { id: lease.leaseId } })
      expect(row.state).toBe('failed'); expect(row.failureCount).toBe(count)
      const backoff = 15 * 60_000 * 2 ** (count - 1)
      expect(row.expiresAt.getTime()).toBeGreaterThanOrEqual(started + backoff)
      expect(row.expiresAt.getTime()).toBeLessThanOrEqual(Date.now() + backoff)
      expect((await claim()).statusCode).toBe(204)
      await prisma.localAiLease.update({ where: { id: lease.leaseId }, data: { expiresAt: new Date(Date.now() - 1000) } })
      previous = lease
    }
    expect((await claim()).statusCode).toBe(204)
    // Even a changed hash cannot bypass an active failed backoff window.
    await prisma.localAiLease.update({ where: { id: previous!.leaseId }, data: { expiresAt: new Date(Date.now() + 60_000) } })
    await prisma.skill.update({ where: { id: skillId }, data: { sourceContent: '# Changed after failures' } })
    expect((await claim()).statusCode).toBe(204)
    await prisma.localAiLease.update({ where: { id: previous!.leaseId }, data: { expiresAt: new Date(Date.now() - 1000) } })
    const response = await claim()
    expect(response.statusCode).toBe(200)
    const renewed = response.json<LeaseResponse>()
    expect(renewed.inputHash).not.toBe(previous!.inputHash)
    expect((await prisma.localAiLease.findUniqueOrThrow({ where: { id: renewed.leaseId } })).failureCount).toBe(0)
  })
  it('rotates expired IDs so late results, failures and releases cannot touch a new attempt', async (): Promise<void> => {
    await createSkill()
    const old = (await claim()).json<LeaseResponse>()
    await prisma.localAiLease.update({ where: { id: old.leaseId }, data: { expiresAt: new Date(Date.now() - 1000) } })
    const current = (await claim()).json<LeaseResponse>()
    expect(current.leaseId).not.toBe(old.leaseId)
    expect((await submit(old)).statusCode).toBe(404)
    expect((await app.inject({ method: 'POST', url: `/api/local-ai/leases/${old.leaseId}/failure`, headers, payload: { code: 'TIMEOUT' } })).statusCode).toBe(404)
    expect((await app.inject({ method: 'DELETE', url: `/api/local-ai/leases/${old.leaseId}`, headers })).statusCode).toBe(204)
    expect(await prisma.localAiLease.findUnique({ where: { id: current.leaseId } })).toMatchObject({ state: 'leased', failureCount: 0 })
  })
  it('commits the Profile and lease deletion atomically while retaining manual labels', async (): Promise<void> => {
    const skillId = await createSkill()
    const lease = (await claim()).json<LeaseResponse>()
    expect((await submit(lease)).statusCode).toBe(200)
    expect(await prisma.skill.findUnique({ where: { id: skillId } })).toMatchObject({ ...profile, labels: ['manual'], analysisStatus: 'completed' })
    expect(await prisma.localAiLease.count({ where: { skillId } })).toBe(0)
    expect((await submit(lease)).statusCode).toBe(404)
  })
  it('enforces task targets, state/count checks and both unique task pairs', async (): Promise<void> => {
    const skillId = await createSkill()
    const otherSkillId = await createSkill('another-task-target')
    const jobIds: string[] = []
    for (let index = 0; index < 2; index += 1) {
      const anchor = await prisma.skillAvatar.create({ data: { ownerId: userId, localSkillId: randomUUID(),
        input: { name: 'Lease fixture', description: 'Constraint checks', scenarios: [] },
        inputFingerprint: 'fixture', promptVersion: 'fixture', status: 'cancelled' } })
      avatarIds.push(anchor.id)
      const job = await prisma.avatarGenerationJob.create({ data: { ownerId: userId, logicalSkillId: anchor.id,
        generationRevision: 1, selectionRevision: 1, styleId: 'classic', styleVersion: 1,
        input: anchor.input as Prisma.InputJsonValue,
        inputFingerprint: 'fixture', promptVersion: 'fixture', falModel: 'fixture/model', falParameters: {},
        idempotencyKey: randomUUID(), status: 'cancelled' } })
      jobIds.push(job.id)
    }
    const data = { userId, skillId, type: 'analyzeSkill', state: 'leased', inputHash: 'a'.repeat(64),
      configVersion: 'analyzeSkill.v1', tokenVersion: 0, expiresAt: new Date() }
    const draftData = { ...data, skillId: null, avatarJobId: jobIds[0], type: 'draftAvatarPrompt', configVersion: 'draftAvatarPrompt.v1' }
    for (const target of [data, draftData]) for (const change of [{ type: 'unknown' }, { state: 'unknown' }, { failureCount: -1 }]) {
      await expect(prisma.localAiLease.create({ data: { ...target, ...change } })).rejects.toThrow()
    }
    // A valid FK target makes these target-CHECK failures independent of FK failures.
    for (const change of [{ skillId: null }, { avatarJobId: jobIds[0] }, { skillId: null, avatarJobId: jobIds[0] },
      { type: 'draftAvatarPrompt' }, { type: 'draftAvatarPrompt', skillId: null }]) {
      await expect(prisma.localAiLease.create({ data: { ...data, ...change } })).rejects.toThrow()
    }
    await prisma.localAiLease.create({ data })
    await expect(prisma.localAiLease.create({ data })).rejects.toThrow()
    await prisma.localAiLease.create({ data: { ...data, skillId: otherSkillId } })
    // NULL avatarJobId does not collide for two analyzeSkill targets.
    expect(await prisma.localAiLease.count({ where: { userId, type: 'analyzeSkill', avatarJobId: null } })).toBe(2)
    await prisma.localAiLease.create({ data: draftData })
    await expect(prisma.localAiLease.create({ data: draftData })).rejects.toThrow()
    await expect(prisma.localAiLease.create({ data: { ...draftData, skillId: otherSkillId } })).rejects.toThrow()
    const secondDraft = await prisma.localAiLease.create({ data: { ...draftData, avatarJobId: jobIds[1] } })
    // NULL skillId does not collide for two draftAvatarPrompt targets.
    expect(await prisma.localAiLease.count({ where: { userId, type: 'draftAvatarPrompt', skillId: null } })).toBe(2)
    // A draft may also reference a Skill; the original unique key includes type.
    await prisma.localAiLease.update({ where: { id: secondDraft.id }, data: { skillId } })
    expect(await prisma.localAiLease.count({ where: { skillId } })).toBe(2)
  })
  it('cascades lease deletion for both Skill and user foreign keys', async (): Promise<void> => {
    const skillId = await createSkill()
    await claim()
    await prisma.skill.delete({ where: { id: skillId } })
    expect(await prisma.localAiLease.count({ where: { skillId } })).toBe(0)
    const remainingSkillId = await createSkill('cascade-user')
    // Isolate the lease user FK from the existing non-cascading Skill author FK.
    const lease = await prisma.localAiLease.create({ data: { userId: otherId, skillId: remainingSkillId,
      type: 'analyzeSkill', state: 'leased', inputHash: 'a'.repeat(64), configVersion: 'analyzeSkill.v1', tokenVersion: 0, expiresAt: new Date() } })
    await prisma.user.delete({ where: { id: otherId } })
    expect(await prisma.localAiLease.findUnique({ where: { id: lease.id } })).toBeNull()
    expect(await prisma.skill.findUnique({ where: { id: remainingSkillId } })).not.toBeNull()
  })
})
