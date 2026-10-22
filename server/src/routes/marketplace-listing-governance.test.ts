import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify'
import sensible from '@fastify/sensible'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const ADMIN_ID = '11111111-1111-4111-8111-111111111111'
const SKILL_ID = '22222222-2222-4222-8222-222222222222'
const SUBMISSION_ID = '44444444-4444-4444-8444-444444444444'
const VERSION_ID = '55555555-5555-4555-8555-555555555555'
const UPDATED_AT = new Date('2026-10-01T00:00:00.000Z')

const mockRole = vi.hoisted(() => ({ value: 'admin' as 'user' | 'admin' }))
const mockDb = vi.hoisted(() => ({
  $transaction: vi.fn(),
  $queryRaw: vi.fn(),
  marketplaceListing: { findUnique: vi.fn(), update: vi.fn() },
  marketplaceSubmission: { findMany: vi.fn(), findFirst: vi.fn() },
  marketplaceTopicItem: { findMany: vi.fn() },
  marketplaceListingDailyMetric: { findMany: vi.fn() },
  marketplaceComment: { count: vi.fn() },
  adminAgentAuditEvent: { create: vi.fn() },
  notification: { create: vi.fn() },
}))

vi.mock('../db.js', () => ({ db: mockDb }))
vi.mock('../lib/mutation-lock.js', () => ({ lockSkillMutation: vi.fn().mockResolvedValue(undefined), lockMarketplaceTopicMutation: vi.fn() }))
vi.mock('../lib/marketplace-badges.js', async () => {
  const actual = await vi.importActual<typeof import('../lib/marketplace-badges.js')>('../lib/marketplace-badges.js')
  return { ...actual, loadHotSkillIds: vi.fn().mockResolvedValue(new Set<string>()) }
})
vi.mock('../middleware/auth.js', () => ({
  optionalAuthMiddleware: async (): Promise<void> => {},
  authMiddleware: async (request: FastifyRequest): Promise<void> => {
    request.user = { id: ADMIN_ID, email: 'admin@example.com', displayName: '管理员', marketplaceRole: mockRole.value }
  },
}))

import { marketplaceExperienceRoutes } from './marketplace-experience.js'

type ListingOverrides = { withdrawnAt?: Date | null; withdrawnBy?: string | null; withdrawnReason?: string | null; deletedAt?: Date | null; submissionStatus?: string; visibility?: string }

function listing(overrides: ListingOverrides = {}) {
  return {
    skillId: SKILL_ID,
    submissionId: SUBMISSION_ID,
    versionId: VERSION_ID,
    categoryId: null,
    downloadCount: 12,
    installClickCount: 9,
    activeUserCount: 4,
    featured: true,
    original: false,
    editorialLabels: ['写作'],
    publishedAt: new Date('2026-09-12T00:00:00.000Z'),
    firstPublishedAt: new Date('2026-09-12T00:00:00.000Z'),
    updatedAt: UPDATED_AT,
    withdrawnAt: overrides.withdrawnAt ?? null,
    withdrawnBy: overrides.withdrawnBy ?? null,
    withdrawnReason: overrides.withdrawnReason ?? null,
    category: null,
    submission: {
      status: overrides.submissionStatus ?? 'approved',
      skillName: 'humanizer-zh',
      displayName: '去 AI 味改写',
      description: '把中文稿改得像人写的',
      category: '内容与创作',
      labels: ['写作', 42],
      triggerScenarios: ['改写周报'],
      compatibleAgents: ['codex'],
      envDependencies: [{ key: 'OPENAI_API_KEY', description: '模型调用', required: true, value: 'sk-should-never-leave' }, { nope: true }],
      sourceContent: '# humanizer-zh\n审核快照正文',
    },
    version: { id: VERSION_ID, version: '0.2.0', changelog: '修正', packageSha256: 'a'.repeat(64), packageSize: 2048, createdAt: UPDATED_AT },
    skill: {
      id: SKILL_ID,
      name: 'humanizer-zh',
      authorId: 'author-1',
      visibility: overrides.visibility ?? 'public',
      marketplaceStatus: 'approved',
      avatarUrl: null,
      avatarStatus: 'ready',
      createdAt: UPDATED_AT,
      updatedAt: UPDATED_AT,
      deletedAt: overrides.deletedAt ?? null,
      author: { id: 'author-1', displayName: '作者', avatarUrl: null },
    },
  }
}

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify()
  await app.register(sensible)
  await app.register(marketplaceExperienceRoutes, { prefix: '/api/marketplace' })
  await app.ready()
  return app
}

beforeEach(() => {
  vi.clearAllMocks()
  mockRole.value = 'admin'
  mockDb.$transaction.mockImplementation(async (input: unknown) => (input as (tx: typeof mockDb) => Promise<unknown>)(mockDb))
  mockDb.$queryRaw.mockResolvedValue([{ id: ADMIN_ID }])
  mockDb.adminAgentAuditEvent.create.mockResolvedValue({})
  mockDb.notification.create.mockResolvedValue({})
  mockDb.marketplaceListing.update.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({ ...listing(), ...data }))
  mockDb.marketplaceSubmission.findMany.mockResolvedValue([])
  mockDb.marketplaceTopicItem.findMany.mockResolvedValue([])
  mockDb.marketplaceListingDailyMetric.findMany.mockResolvedValue([])
  mockDb.marketplaceComment.count.mockResolvedValue(3)
})

describe('admin listing withdrawal', () => {
  it('is reserved for store administrators', async () => {
    mockRole.value = 'user'
    const app = await buildApp()
    for (const request of [
      { method: 'POST' as const, url: `/api/marketplace/admin/listings/${SKILL_ID}/withdraw`, payload: { reason: '违规' } },
      { method: 'POST' as const, url: `/api/marketplace/admin/listings/${SKILL_ID}/restore`, payload: {} },
      { method: 'GET' as const, url: `/api/marketplace/admin/listings/${SKILL_ID}` },
      { method: 'GET' as const, url: `/api/marketplace/admin/listings/${SKILL_ID}/submissions/${SUBMISSION_ID}/skill-md` },
    ]) {
      expect((await app.inject(request)).statusCode).toBe(403)
    }
    expect(mockDb.marketplaceListing.update).not.toHaveBeenCalled()
  })

  it('requires a reason before touching the listing', async () => {
    const app = await buildApp()
    const response = await app.inject({ method: 'POST', url: `/api/marketplace/admin/listings/${SKILL_ID}/withdraw`, payload: { reason: '  ' } })
    expect(response.statusCode).toBe(400)
    expect(mockDb.$transaction).not.toHaveBeenCalled()
  })

  it('unlists, audits the web session and notifies the author', async () => {
    mockDb.marketplaceListing.findUnique.mockResolvedValue(listing())
    const app = await buildApp()
    const response = await app.inject({ method: 'POST', url: `/api/marketplace/admin/listings/${SKILL_ID}/withdraw`, payload: { reason: '包含未授权素材', expectedUpdatedAt: UPDATED_AT.toISOString() } })
    expect(response.statusCode, response.body).toBe(200)
    expect(mockDb.marketplaceListing.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { skillId: SKILL_ID },
      data: { withdrawnAt: expect.any(Date), withdrawnBy: 'admin', withdrawnReason: '包含未授权素材' },
    }))
    expect(mockDb.adminAgentAuditEvent.create).toHaveBeenCalledWith({ data: { channel: 'web', actorAdminId: ADMIN_ID, operationId: 'marketplace.listing.withdraw', outcome: `write:${SKILL_ID}` } })
    expect(mockDb.notification.create).toHaveBeenCalledWith({ data: expect.objectContaining({
      userId: 'author-1',
      type: 'marketplace_withdrawn',
      payload: expect.objectContaining({ skillId: SKILL_ID, reviewNote: '包含未授权素材' }),
    }) })
    expect(response.json()).toMatchObject({ listingId: SKILL_ID, status: 'withdrawn', withdrawnBy: 'admin', withdrawnReason: '包含未授权素材' })
  })

  it('answers 409 with the actor when the listing is already down, treating legacy rows as author withdrawals', async () => {
    mockDb.marketplaceListing.findUnique.mockResolvedValue(listing({ withdrawnAt: new Date() }))
    const app = await buildApp()
    const response = await app.inject({ method: 'POST', url: `/api/marketplace/admin/listings/${SKILL_ID}/withdraw`, payload: { reason: '重复' } })
    expect(response.statusCode).toBe(409)
    expect(response.json()).toMatchObject({ code: 'LISTING_ALREADY_WITHDRAWN', withdrawnBy: 'author' })
    expect(mockDb.marketplaceListing.update).not.toHaveBeenCalled()
    expect(mockDb.notification.create).not.toHaveBeenCalled()
  })

  it('refuses a stale expectedUpdatedAt', async () => {
    mockDb.marketplaceListing.findUnique.mockResolvedValue(listing())
    const app = await buildApp()
    const response = await app.inject({ method: 'POST', url: `/api/marketplace/admin/listings/${SKILL_ID}/withdraw`, payload: { reason: '违规', expectedUpdatedAt: '2026-01-01T00:00:00.000Z' } })
    expect(response.statusCode).toBe(409)
    expect(response.json()).toMatchObject({ code: 'LISTING_CHANGED' })
    expect(mockDb.marketplaceListing.update).not.toHaveBeenCalled()
  })

  it('fails closed with 503 when the audit row cannot be written', async () => {
    mockDb.marketplaceListing.findUnique.mockResolvedValue(listing())
    mockDb.adminAgentAuditEvent.create.mockRejectedValue(new Error('audit table unavailable'))
    const app = await buildApp()
    const response = await app.inject({ method: 'POST', url: `/api/marketplace/admin/listings/${SKILL_ID}/withdraw`, payload: { reason: '违规' } })
    expect(response.statusCode).toBe(503)
    expect(mockDb.notification.create).not.toHaveBeenCalled()
  })

  it('rejects a session whose admin role was removed before the audit', async () => {
    mockDb.marketplaceListing.findUnique.mockResolvedValue(listing())
    mockDb.$queryRaw.mockResolvedValue([])
    const app = await buildApp()
    const response = await app.inject({ method: 'POST', url: `/api/marketplace/admin/listings/${SKILL_ID}/withdraw`, payload: { reason: '违规' } })
    expect(response.statusCode).toBe(403)
    expect(mockDb.adminAgentAuditEvent.create).not.toHaveBeenCalled()
  })

  it('keeps the withdrawal when the author notification cannot be stored', async () => {
    mockDb.marketplaceListing.findUnique.mockResolvedValue(listing())
    mockDb.notification.create.mockRejectedValue(new Error('notifications down'))
    const app = await buildApp()
    const response = await app.inject({ method: 'POST', url: `/api/marketplace/admin/listings/${SKILL_ID}/withdraw`, payload: { reason: '违规' } })
    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({ status: 'withdrawn' })
  })

  it('returns 404 for a Skill its author deleted', async () => {
    mockDb.marketplaceListing.findUnique.mockResolvedValue(listing({ deletedAt: new Date() }))
    const app = await buildApp()
    const response = await app.inject({ method: 'POST', url: `/api/marketplace/admin/listings/${SKILL_ID}/withdraw`, payload: { reason: '违规' } })
    expect(response.statusCode).toBe(404)
  })
})

describe('admin listing restore', () => {
  it('restores an admin unlisting and clears every withdrawal column', async () => {
    mockDb.marketplaceListing.findUnique.mockResolvedValue(listing({ withdrawnAt: new Date(), withdrawnBy: 'admin', withdrawnReason: '违规' }))
    const app = await buildApp()
    const response = await app.inject({ method: 'POST', url: `/api/marketplace/admin/listings/${SKILL_ID}/restore`, payload: {} })
    expect(response.statusCode, response.body).toBe(200)
    expect(mockDb.marketplaceListing.update).toHaveBeenCalledWith(expect.objectContaining({ data: { withdrawnAt: null, withdrawnBy: null, withdrawnReason: null } }))
    expect(mockDb.adminAgentAuditEvent.create).toHaveBeenCalledWith({ data: expect.objectContaining({ channel: 'web', operationId: 'marketplace.listing.restore' }) })
    expect(response.json()).toMatchObject({ status: 'published', withdrawnAt: null, withdrawnBy: null })
  })

  it.each([
    [{ withdrawnAt: new Date(), withdrawnBy: 'author' }, 'LISTING_WITHDRAWN_BY_AUTHOR'],
    [{ withdrawnAt: new Date(), withdrawnBy: null }, 'LISTING_WITHDRAWN_BY_AUTHOR'],
    [{ withdrawnAt: null }, 'LISTING_NOT_WITHDRAWN'],
    [{ withdrawnAt: new Date(), withdrawnBy: 'admin', submissionStatus: 'withdrawn' }, 'LISTING_NOT_APPROVED'],
    [{ withdrawnAt: new Date(), withdrawnBy: 'admin', visibility: 'private' }, 'LISTING_WITHDRAWN_BY_AUTHOR'],
  ])('refuses restore for %o with %s', async (overrides, code) => {
    mockDb.marketplaceListing.findUnique.mockResolvedValue(listing(overrides))
    const app = await buildApp()
    const response = await app.inject({ method: 'POST', url: `/api/marketplace/admin/listings/${SKILL_ID}/restore`, payload: {} })
    expect(response.statusCode).toBe(409)
    expect(response.json()).toMatchObject({ code })
    expect(mockDb.marketplaceListing.update).not.toHaveBeenCalled()
    expect(mockDb.adminAgentAuditEvent.create).not.toHaveBeenCalled()
  })
})

describe('admin listing detail', () => {
  it('shows the reviewed snapshot with requirement-only environment entries and no secrets', async () => {
    mockDb.marketplaceListing.findUnique.mockResolvedValue(listing({ withdrawnAt: new Date('2026-10-02T00:00:00.000Z'), withdrawnBy: 'admin', withdrawnReason: '违规' }))
    mockDb.marketplaceSubmission.findMany.mockResolvedValue([
      { id: SUBMISSION_ID, status: 'approved', submitterNote: null, reviewNote: null, submittedAt: UPDATED_AT, reviewStartedAt: null, reviewedAt: UPDATED_AT, withdrawnAt: null, version: listing().version },
      { id: '66666666-6666-4666-8666-666666666666', status: 'rejected', submitterNote: '请看', reviewNote: '补充说明', submittedAt: UPDATED_AT, reviewStartedAt: null, reviewedAt: UPDATED_AT, withdrawnAt: null, version: { ...listing().version, id: 'v0', version: '0.1.0' } },
    ])
    mockDb.marketplaceTopicItem.findMany.mockResolvedValue([{ topic: { id: 'topic-1', slug: 'writing', title: '写作专题', status: 'published' } }])
    mockDb.marketplaceListingDailyMetric.findMany.mockResolvedValue([{ day: new Date('2026-10-01T00:00:00.000Z'), downloads: 2, installs: 5 }])
    const app = await buildApp()
    const response = await app.inject({ method: 'GET', url: `/api/marketplace/admin/listings/${SKILL_ID}` })
    expect(response.statusCode, response.body).toBe(200)
    const body = response.json()
    expect(body.listing).toMatchObject({ status: 'withdrawn', withdrawnBy: 'admin', withdrawnReason: '违规', badges: [], commentCount: 3, installCount: 9 })
    expect(body.skill).toMatchObject({ name: 'humanizer-zh', displayName: '去 AI 味改写', labels: ['写作'], envDependencies: [{ key: 'OPENAI_API_KEY', description: '模型调用', required: true }] })
    expect(body.currentVersion).toMatchObject({ version: '0.2.0', submissionId: SUBMISSION_ID, sourceContent: '# humanizer-zh\n审核快照正文' })
    expect(body.submissions.map((row: { isListed: boolean }) => row.isListed)).toEqual([true, false])
    expect(body.topics).toEqual([{ id: 'topic-1', slug: 'writing', title: '写作专题', status: 'published' }])
    expect(body.metrics.days).toEqual([{ day: '2026-10-01', downloads: 2, installs: 5 }])
    expect(response.body).not.toContain('sk-should-never-leave')
    expect(response.body).not.toContain('admin@example.com')
    expect(response.body).not.toContain('"email"')
  })

  it('returns 404 once the author deleted the Skill', async () => {
    mockDb.marketplaceListing.findUnique.mockResolvedValue(listing({ deletedAt: new Date() }))
    const app = await buildApp()
    expect((await app.inject({ method: 'GET', url: `/api/marketplace/admin/listings/${SKILL_ID}` })).statusCode).toBe(404)
  })

  it('reads another reviewed submission SKILL.md only within the same Skill', async () => {
    mockDb.marketplaceSubmission.findFirst.mockResolvedValue({ id: SUBMISSION_ID, sourceContent: '# 旧版', version: { id: 'v0', version: '0.1.0' } })
    const app = await buildApp()
    const response = await app.inject({ method: 'GET', url: `/api/marketplace/admin/listings/${SKILL_ID}/submissions/${SUBMISSION_ID}/skill-md` })
    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({ submissionId: SUBMISSION_ID, versionId: 'v0', version: '0.1.0', sourceContent: '# 旧版' })
    expect(mockDb.marketplaceSubmission.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: SUBMISSION_ID, skillId: SKILL_ID, skill: { is: { deletedAt: null } } } }))
  })
})
