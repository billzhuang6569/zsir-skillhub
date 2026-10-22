import { randomUUID } from 'node:crypto'
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify'
import sensible from '@fastify/sensible'
import { PrismaClient } from '@prisma/client'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createAgentKey } from '../lib/admin-agent-key.js'

const postgresUrl = process.env['SKILLHUB_PG_TEST_URL']
const describePostgres = postgresUrl ? describe : describe.skip
const agentPrefix = '/api/admin/v1/marketplace'

describePostgres('admin listing governance with real PostgreSQL (#208)', () => {
  let app: FastifyInstance
  let prisma: PrismaClient
  const adminId = randomUUID()
  const authorId = randomUUID()
  const tag = randomUUID().slice(0, 8)
  let reviewToken: string
  let reviewKeyId: string
  const skillIds: string[] = []
  // The already-verified user the real middleware would attach; switched to the author for author actions.
  let actingUserId = ''

  async function listedSkill(name: string): Promise<{ skillId: string; submissionId: string }> {
    const skillId = randomUUID()
    const versionId = randomUUID()
    const submissionId = randomUUID()
    skillIds.push(skillId)
    await prisma.skill.create({ data: { id: skillId, name: `${tag}-${name}`, displayName: `${name} 展示名`, description: '公开快照', authorId, visibility: 'public', marketplaceStatus: 'approved' } })
    await prisma.skillVersion.create({ data: { id: versionId, skillId, version: '0.1.0', sourceContent: `# ${name} 版本正文` } })
    await prisma.marketplaceSubmission.create({ data: {
      id: submissionId, skillId, versionId, submittedById: authorId, status: 'approved', skillName: `${tag}-${name}`, displayName: `${name} 展示名`,
      description: '公开快照', labels: ['写作'], envDependencies: [{ key: 'API_TOKEN', required: true }], sourceContent: `# ${name} 审核快照`,
      reviewedAt: new Date(),
    } })
    await prisma.marketplaceListing.create({ data: { skillId, submissionId, versionId } })
    return { skillId, submissionId }
  }

  async function buildApp(): Promise<FastifyInstance> {
    const [{ marketplaceRoutes }, { marketplaceExperienceRoutes }, { skillsRoutes }, { createAdminAgentAccess }] = await Promise.all([
      import('./marketplace.js'), import('./marketplace-experience.js'), import('./skills.js'), import('../middleware/admin-agent.js'),
    ])
    const server = Fastify()
    await server.register(sensible)
    const access = createAdminAgentAccess()
    await server.register(marketplaceRoutes, { prefix: '/api/marketplace' })
    await server.register(marketplaceExperienceRoutes, { prefix: '/api/marketplace' })
    await server.register(skillsRoutes, { prefix: '/api/skills' })
    await server.register(marketplaceRoutes, { prefix: agentPrefix, agentAccess: access })
    await server.register(marketplaceExperienceRoutes, { prefix: agentPrefix, agentAccess: access })
    await server.ready()
    return server
  }

  beforeAll(async (): Promise<void> => {
    prisma = new PrismaClient({ datasources: { db: { url: postgresUrl } } })
    vi.doMock('../db.js', () => ({ db: prisma }))
    actingUserId = adminId
    vi.doMock('../middleware/auth.js', () => ({
      optionalAuthMiddleware: async (): Promise<void> => {},
      authMiddleware: async (request: FastifyRequest): Promise<void> => {
        request.user = actingUserId === adminId
          ? { id: adminId, email: `${adminId}@example.test`, displayName: 'Admin', marketplaceRole: 'admin' }
          : { id: authorId, email: `${authorId}@example.test`, displayName: 'Author', marketplaceRole: 'user' }
      },
    }))
    await prisma.user.createMany({ data: [
      { id: adminId, email: `${adminId}@example.test`, displayName: 'Admin', marketplaceRole: 'admin' },
      { id: authorId, email: `${authorId}@example.test`, displayName: 'Author' },
    ] })
    reviewKeyId = randomUUID()
    const generated = createAgentKey(reviewKeyId)
    await prisma.adminAgentKey.create({ data: { id: reviewKeyId, name: '#208 integration', secretHash: generated.hash, issuerAdminId: adminId, clientOperationId: randomUUID(), scopes: ['marketplace:review'] } })
    reviewToken = generated.token
    app = await buildApp()
  })

  afterAll(async (): Promise<void> => {
    await app?.close()
    if (prisma) {
      await prisma.$executeRawUnsafe('ALTER TABLE admin_agent_audit_events DROP CONSTRAINT IF EXISTS pr208_block_web_audit')
      await prisma.adminAgentAuditEvent.deleteMany({ where: { OR: [{ keyId: reviewKeyId }, { actorAdminId: adminId }] } })
      await prisma.adminAgentKey.deleteMany({ where: { id: reviewKeyId } })
      await prisma.notification.deleteMany({ where: { userId: authorId } })
      await prisma.skill.deleteMany({ where: { id: { in: skillIds } } })
      await prisma.user.deleteMany({ where: { id: { in: [adminId, authorId] } } })
      await prisma.$disconnect()
    }
    vi.doUnmock('../db.js')
    vi.doUnmock('../middleware/auth.js')
  })

  it('unlists from every public surface, audits the web session and notifies the author', async () => {
    const { skillId } = await listedSkill('withdraw')
    expect((await app.inject(`/api/marketplace/${skillId}`)).statusCode).toBe(200)
    const before = await prisma.marketplaceListing.findUniqueOrThrow({ where: { skillId } })

    const response = await app.inject({ method: 'POST', url: `/api/marketplace/admin/listings/${skillId}/withdraw`, payload: { reason: '素材未授权' } })
    expect(response.statusCode, response.body).toBe(200)

    const row = await prisma.marketplaceListing.findUniqueOrThrow({ where: { skillId } })
    expect(row).toMatchObject({ withdrawnBy: 'admin', withdrawnReason: '素材未授权' })
    expect(row.withdrawnAt).not.toBeNull()
    expect((await app.inject(`/api/marketplace/${skillId}`)).statusCode).toBe(404)
    expect((await app.inject(`/api/marketplace/${skillId}/package`)).statusCode).toBe(404)
    const catalog = await app.inject(`/api/marketplace?query=${tag}&pageSize=50`)
    expect(catalog.json().items.map((item: { id: string }) => item.id)).not.toContain(skillId)

    const audit = await prisma.adminAgentAuditEvent.findFirstOrThrow({ where: { actorAdminId: adminId, operationId: 'marketplace.listing.withdraw', outcome: `write:${skillId}` } })
    expect(audit).toMatchObject({ channel: 'web', keyId: null })
    const notice = await prisma.notification.findFirstOrThrow({ where: { userId: authorId, type: 'marketplace_withdrawn' } })
    expect(notice.payload).toMatchObject({ skillId, reviewNote: '素材未授权' })

    const again = await app.inject({ method: 'POST', url: `/api/marketplace/admin/listings/${skillId}/withdraw`, payload: { reason: '重复' } })
    expect(again.statusCode).toBe(409)
    expect(await prisma.notification.count({ where: { userId: authorId, type: 'marketplace_withdrawn', payload: { path: ['skillId'], equals: skillId } } })).toBe(1)

    // The detail view reads the real relations, including the withdrawn state.
    const detail = await app.inject(`/api/marketplace/admin/listings/${skillId}`)
    expect(detail.statusCode, detail.body).toBe(200)
    expect(detail.json()).toMatchObject({
      listing: { status: 'withdrawn', withdrawnBy: 'admin', withdrawnReason: '素材未授权', badges: [] },
      skill: { displayName: 'withdraw 展示名', envDependencies: [{ key: 'API_TOKEN', description: null, required: true }] },
      currentVersion: { version: '0.1.0', sourceContent: '# withdraw 审核快照' },
    })
    expect(before.firstPublishedAt).toEqual(row.firstPublishedAt)
  })

  it('lets a review Key restore with a fresh expectedUpdatedAt and keeps firstPublishedAt', async () => {
    const { skillId } = await listedSkill('restore')
    const first = await prisma.marketplaceListing.findUniqueOrThrow({ where: { skillId } })
    await app.inject({ method: 'POST', url: `/api/marketplace/admin/listings/${skillId}/withdraw`, payload: { reason: '临时下架' } })
    const withdrawn = await prisma.marketplaceListing.findUniqueOrThrow({ where: { skillId } })
    const headers = { authorization: `Bearer ${reviewToken}` }

    expect((await app.inject({ method: 'POST', url: `${agentPrefix}/listings/${skillId}/restore`, headers, payload: {} })).statusCode).toBe(428)
    expect((await app.inject({ method: 'POST', url: `${agentPrefix}/listings/${skillId}/restore`, headers, payload: { expectedUpdatedAt: '2020-01-01T00:00:00.000Z' } })).statusCode).toBe(409)
    const restored = await app.inject({ method: 'POST', url: `${agentPrefix}/listings/${skillId}/restore`, headers, payload: { expectedUpdatedAt: withdrawn.updatedAt.toISOString() } })
    expect(restored.statusCode, restored.body).toBe(200)

    const row = await prisma.marketplaceListing.findUniqueOrThrow({ where: { skillId } })
    expect(row).toMatchObject({ withdrawnAt: null, withdrawnBy: null, withdrawnReason: null })
    expect(row.firstPublishedAt).toEqual(first.firstPublishedAt)
    expect((await app.inject(`/api/marketplace/${skillId}`)).statusCode).toBe(200)
    expect(await prisma.adminAgentAuditEvent.count({ where: { keyId: reviewKeyId, channel: 'agent', operationId: 'marketplace.listing.restore' } })).toBe(1)
  })

  it('never restores a Skill its author took down', async () => {
    const { skillId } = await listedSkill('author')
    await prisma.marketplaceListing.update({ where: { skillId }, data: { withdrawnAt: new Date(), withdrawnBy: 'author' } })
    const response = await app.inject({ method: 'POST', url: `/api/marketplace/admin/listings/${skillId}/restore`, payload: {} })
    expect(response.statusCode).toBe(409)
    expect(response.json()).toMatchObject({ code: 'LISTING_WITHDRAWN_BY_AUTHOR' })
    expect((await prisma.marketplaceListing.findUniqueOrThrow({ where: { skillId } })).withdrawnAt).not.toBeNull()
  })

  async function asAuthor<T>(action: () => Promise<T>): Promise<T> {
    actingUserId = authorId
    try { return await action() } finally { actingUserId = adminId }
  }

  it('lets an author withdrawal override an earlier admin unlisting, so an admin can never restore it', async () => {
    const { skillId } = await listedSkill('author-after-admin')
    expect((await app.inject({ method: 'POST', url: `/api/marketplace/admin/listings/${skillId}/withdraw`, payload: { reason: '先由管理员下架' } })).statusCode).toBe(200)
    const unlisted = await prisma.marketplaceListing.findUniqueOrThrow({ where: { skillId } })

    const deleted = await asAuthor(() => app.inject({ method: 'DELETE', url: `/api/marketplace/skills/${skillId}` }))
    expect(deleted.statusCode, deleted.body).toBe(204)
    const row = await prisma.marketplaceListing.findUniqueOrThrow({ where: { skillId } })
    expect(row).toMatchObject({ withdrawnBy: 'author', withdrawnReason: null })
    expect(row.withdrawnAt).toEqual(unlisted.withdrawnAt)
    expect(row.updatedAt.getTime()).toBeGreaterThan(unlisted.updatedAt.getTime())

    // An admin holding the pre-withdrawal version is told it changed; a fresh read still cannot restore.
    const stale = await app.inject({ method: 'POST', url: `/api/marketplace/admin/listings/${skillId}/restore`, payload: { expectedUpdatedAt: unlisted.updatedAt.toISOString() } })
    expect(stale.statusCode).toBe(409)
    expect(stale.json()).toMatchObject({ code: 'LISTING_CHANGED' })
    const restore = await app.inject({ method: 'POST', url: `/api/marketplace/admin/listings/${skillId}/restore`, payload: {} })
    expect(restore.statusCode).toBe(409)
    expect(restore.json()).toMatchObject({ code: 'LISTING_WITHDRAWN_BY_AUTHOR' })
    expect((await prisma.marketplaceListing.findUniqueOrThrow({ where: { skillId } })).withdrawnAt).not.toBeNull()
    expect((await app.inject(`/api/marketplace/${skillId}`)).statusCode).toBe(404)
  })

  it('keeps the author as the withdrawer through a soft delete and a recycle-bin restore', async () => {
    const { skillId } = await listedSkill('trash-after-admin')
    await app.inject({ method: 'POST', url: `/api/marketplace/admin/listings/${skillId}/withdraw`, payload: { reason: '先由管理员下架' } })

    const removed = await asAuthor(() => app.inject({ method: 'DELETE', url: `/api/skills/${skillId}` }))
    expect(removed.statusCode, removed.body).toBeLessThan(300)
    expect(await prisma.marketplaceListing.findUniqueOrThrow({ where: { skillId } })).toMatchObject({ withdrawnBy: 'author', withdrawnReason: null })
    expect((await app.inject({ method: 'POST', url: `/api/marketplace/admin/listings/${skillId}/restore`, payload: {} })).statusCode).toBe(404)

    const back = await asAuthor(() => app.inject({ method: 'POST', url: `/api/skills/${skillId}/restore` }))
    expect(back.statusCode, back.body).toBe(200)
    const restore = await app.inject({ method: 'POST', url: `/api/marketplace/admin/listings/${skillId}/restore`, payload: {} })
    expect(restore.statusCode).toBe(409)
    expect(restore.json()).toMatchObject({ code: 'LISTING_WITHDRAWN_BY_AUTHOR' })
    expect((await app.inject(`/api/marketplace/${skillId}`)).statusCode).toBe(404)
  })

  it('rolls the withdrawal back when the web audit row cannot be stored', async () => {
    const { skillId } = await listedSkill('rollback')
    await prisma.$executeRawUnsafe(`ALTER TABLE admin_agent_audit_events ADD CONSTRAINT pr208_block_web_audit CHECK (channel <> 'web' OR outcome <> 'write:${skillId}')`)
    try {
      const response = await app.inject({ method: 'POST', url: `/api/marketplace/admin/listings/${skillId}/withdraw`, payload: { reason: '会被回滚' } })
      expect(response.statusCode).toBe(503)
    } finally {
      await prisma.$executeRawUnsafe('ALTER TABLE admin_agent_audit_events DROP CONSTRAINT IF EXISTS pr208_block_web_audit')
    }
    expect(await prisma.marketplaceListing.findUniqueOrThrow({ where: { skillId } })).toMatchObject({ withdrawnAt: null, withdrawnBy: null })
    expect(await prisma.notification.count({ where: { userId: authorId, type: 'marketplace_withdrawn', payload: { path: ['skillId'], equals: skillId } } })).toBe(0)
  })

  it('shows reviewers that approving re-lists an admin-withdrawn Skill', async () => {
    const { skillId, submissionId } = await listedSkill('review')
    await app.inject({ method: 'POST', url: `/api/marketplace/admin/listings/${skillId}/withdraw`, payload: { reason: '待作者修正' } })
    const detail = await app.inject(`/api/marketplace/admin/submissions/${submissionId}`)
    expect(detail.statusCode, detail.body).toBe(200)
    expect(detail.json().adminWithdrawal).toMatchObject({ reason: '待作者修正' })
    const queue = await app.inject(`/api/marketplace/admin/submissions?status=all&search=${tag}-review`)
    expect(queue.json().items.find((item: { id: string }) => item.id === submissionId).adminWithdrawal).toMatchObject({ reason: '待作者修正' })
  })
})
