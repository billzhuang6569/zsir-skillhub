import { PrismaClient } from '@prisma/client'
import { randomBytes, randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import Fastify, { type FastifyRequest } from 'fastify'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

it('marks existing skills completed before defaulting new skills to unanalysed', () => {
  const sql = readFileSync(new URL('../../prisma/migrations/20261018170000_instance_ai_management/migration.sql', import.meta.url), 'utf8')
  expect(sql).toMatch(/ALTER TABLE "skills" ADD COLUMN "analysisStatus" TEXT NOT NULL DEFAULT 'completed'[^;]*;\s*ALTER TABLE "skills" ALTER COLUMN "analysisStatus" SET DEFAULT 'unanalysed';/)
  expect(sql).toContain('ADD COLUMN "labelsManuallyEdited" BOOLEAN NOT NULL DEFAULT true')
})

const postgresUrl = process.env['SKILLHUB_PG_TEST_URL']
describe.skipIf(!postgresUrl)('PostgreSQL instance AI management', () => {
  let prisma: PrismaClient
  let settings: typeof import('./server-settings.js')
  let budget: typeof import('./ai-budget.js')
  const adminId = randomUUID()
  const userId = randomUUID()
  beforeAll(async () => {
    prisma = new PrismaClient({ datasources: { db: { url: postgresUrl } } })
    vi.doMock('../db.js', () => ({ db: prisma }))
    const { configSchema } = await import('../config-schema.js')
    vi.doMock('../config.js', () => ({ config: configSchema.parse({ ...process.env, SKILLHUB_PROFILE: 'selfhost',
      AI_API_BASE_URL: undefined, AI_API_KEY: undefined, CREDENTIAL_KEK_BASE64: randomBytes(32).toString('base64') }) }))
    settings = await import('./server-settings.js')
    budget = await import('./ai-budget.js')
    await prisma.user.create({ data: { id: adminId, email: `${adminId}@test.invalid`, displayName: 'Admin', marketplaceRole: 'admin' } })
    await prisma.user.create({ data: { id: userId, email: `${userId}@test.invalid`, displayName: 'User' } })
    await settings.loadServerSettings()
  })
  afterAll(async () => {
    if (!prisma) return
    await prisma.serverSetting.deleteMany({ where: { updatedById: adminId } })
    await prisma.aiDailyUsage.deleteMany({ where: { userId: { in: ['*', adminId, userId] } } })
    await prisma.skill.deleteMany({ where: { authorId: adminId } })
    await prisma.user.deleteMany({ where: { id: { in: [adminId, userId] } } })
    await prisma.$disconnect()
    vi.doUnmock('../db.js'); vi.doUnmock('../config.js')
  })
  it('atomically stores an encrypted value/key pair and retains it when the write fails', async () => {
    const value = { protocol: 'openai', baseUrl: 'https://example.test/v1', model: 'old' }
    await settings.writeServerSetting('ai', { value, secret: 'old-secret-key' }, adminId)
    const old = await prisma.serverSetting.findUniqueOrThrow({ where: { key: 'ai' } })
    expect(old.secretCiphertext?.toString('utf8')).not.toContain('old-secret-key')
    await expect(settings.writeServerSetting('ai', { value: { ...value, model: 'new' }, secret: 'new-secret-key' }, randomUUID())).rejects.toThrow()
    expect(await prisma.serverSetting.findUniqueOrThrow({ where: { key: 'ai' } })).toEqual(old)
    expect(await settings.getSettingSecret('ai')).toBe('old-secret-key')
    await settings.writeServerSetting('ai', { value: { ...value, model: 'new' }, secret: 'new-secret-key' }, adminId)
    expect(settings.getSettingValue('ai')?.model).toBe('new')
    expect(await settings.getSettingSecret('ai')).toBe('new-secret-key')
  })
  it('serializes concurrent partial reservations across users and refunds unused units', async () => {
    await settings.writeServerSetting('ai.policy', { value: { limits: { instanceDaily: 5, perUserDaily: 3 }, allowedPrivateHosts: [] } }, adminId)
    await prisma.aiDailyUsage.deleteMany({ where: { day: budget.utcDay(), userId: { in: ['*', adminId, userId] } } })
    const reserved = await Promise.all([budget.aiBudget.reserve(adminId, 10), budget.aiBudget.reserve(userId, 10)])
    expect(reserved.map(item => item.remaining).sort()).toEqual([2, 3])
    expect((await budget.aiBudget.available(adminId)).instance).toBe(0)
    const refund = reserved[0].remaining
    await budget.aiBudget.release(reserved[0])
    expect((await budget.aiBudget.available(adminId)).instance).toBe(refund)
  })
  it('serializes concurrent administrator demotions and leaves one administrator', async () => {
    await prisma.user.update({ where: { id: userId }, data: { marketplaceRole: 'admin' } })
    vi.doMock('../middleware/auth.js', () => ({ authMiddleware: async (request: FastifyRequest): Promise<void> => {
      request.user = { id: String(request.headers['x-test-actor']), email: '', displayName: '', marketplaceRole: 'admin' }
    } }))
    const { instanceSettingsRoutes } = await import('../routes/instance-settings.js')
    const app = Fastify()
    try {
      await app.register(instanceSettingsRoutes, { prefix: '/api/instance/settings' })
      const replies = await Promise.all([adminId, userId].map(id => app.inject({ method: 'PUT',
        url: `/api/instance/settings/members/${id}/role`, headers: { 'x-test-actor': id }, payload: { role: 'member' } })))
      expect(replies.map(reply => reply.statusCode).sort()).toEqual([200, 409])
      expect(await prisma.user.count({ where: { id: { in: [adminId, userId] }, marketplaceRole: 'admin' } })).toBe(1)
    } finally {
      await app.close()
      vi.doUnmock('../middleware/auth.js')
      await prisma.user.update({ where: { id: adminId }, data: { marketplaceRole: 'admin' } })
      await prisma.user.update({ where: { id: userId }, data: { marketplaceRole: 'user' } })
    }
  })
  it('defaults historic/manual labels to protected and rejects stale AI CAS writes', async () => {
    const skill = await prisma.skill.create({ data: { authorId: adminId, name: 'manual', displayName: 'Manual', labels: ['manual'] } })
    expect(skill.labelsManuallyEdited).toBe(true)
    expect(skill.analysisStatus).toBe('unanalysed')
    await prisma.skill.update({ where: { id: skill.id }, data: { labels: ['edited'], updatedAt: new Date(skill.updatedAt.getTime() + 1000) } })
    expect((await prisma.skill.updateMany({ where: { id: skill.id, updatedAt: skill.updatedAt }, data: { labels: ['AI'] } })).count).toBe(0)
    expect((await prisma.skill.findUniqueOrThrow({ where: { id: skill.id } })).labels).toEqual(['edited'])
  })
})
