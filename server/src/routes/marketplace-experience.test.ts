import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify'
import sensible from '@fastify/sensible'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mockRole = vi.hoisted(() => ({ value: 'user' as 'user' | 'admin' }))
const mockDb = vi.hoisted(() => ({
  $transaction: vi.fn(),
  $queryRaw: vi.fn(),
  teamMember: { count: vi.fn() },
  marketplaceCategory: { findMany: vi.fn(), findUnique: vi.fn(), create: vi.fn(), update: vi.fn() },
  marketplaceTopic: { findMany: vi.fn(), findFirst: vi.fn(), findUnique: vi.fn(), create: vi.fn(), update: vi.fn() },
  marketplaceTopicItem: { deleteMany: vi.fn(), createMany: vi.fn() },
  marketplaceListing: { count: vi.fn(), findMany: vi.fn(), findFirst: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
  marketplaceSubmission: { count: vi.fn() },
  user: { count: vi.fn(), findMany: vi.fn() },
  notification: { createMany: vi.fn() },
  adminAnnouncement: { create: vi.fn(), update: vi.fn(), findUnique: vi.fn() },
  marketplaceComment: { count: vi.fn(), findMany: vi.fn(), findUnique: vi.fn(), create: vi.fn(), update: vi.fn(), delete: vi.fn() },
  marketplaceInstallIntent: { count: vi.fn(), findUnique: vi.fn(), create: vi.fn(), update: vi.fn(), groupBy: vi.fn() },
  skill: { groupBy: vi.fn() },
  marketplaceListingDailyMetric: { groupBy: vi.fn(), upsert: vi.fn() },
  marketplaceManagedPresence: { findMany: vi.fn(), updateMany: vi.fn(), upsert: vi.fn() },
  appReleaseDownloadMetric: { aggregate: vi.fn(), groupBy: vi.fn() },
  adminAgentAuditEvent: { create: vi.fn() },
}))

const mockTopicCovers = vi.hoisted(() => ({ storeTopicCover: vi.fn() }))

vi.mock('../lib/mutation-lock.js', () => ({ lockSkillMutation: vi.fn().mockResolvedValue(undefined) }))

vi.mock('../db.js', () => ({ db: mockDb }))
vi.mock('../lib/topic-cover-assets.js', async () => {
  const actual = await vi.importActual<typeof import('../lib/topic-cover-assets.js')>('../lib/topic-cover-assets.js')
  return { ...actual, storeTopicCover: mockTopicCovers.storeTopicCover }
})
vi.mock('../middleware/auth.js', () => ({
  optionalAuthMiddleware: async (request: FastifyRequest): Promise<void> => {
    if (!request.headers.authorization) return
    request.user = {
      id: '11111111-1111-4111-8111-111111111111',
      email: 'user@example.com',
      displayName: 'User',
      marketplaceRole: mockRole.value,
    }
  },
  authMiddleware: async (request: FastifyRequest): Promise<void> => {
    request.user = {
      id: '11111111-1111-4111-8111-111111111111',
      email: 'user@example.com',
      displayName: 'User',
      marketplaceRole: mockRole.value,
    }
  },
}))

import * as skillAnalysis from './skills.js'

import { marketplaceExperienceRoutes } from './marketplace-experience.js'
import { resetMarketplaceHotCache } from '../lib/marketplace-badges.js'
import { storeDay, storeDayValue } from '../lib/marketplace-trends.js'

const SKILL_ID = '22222222-2222-4222-8222-222222222222'
const INTENT_ID = '33333333-3333-4333-8333-333333333333'

function listing() {
  return {
    skillId: SKILL_ID,
    submissionId: '44444444-4444-4444-8444-444444444444',
    versionId: '55555555-5555-4555-8555-555555555555',
    categoryId: null,
    downloadCount: 12,
    installClickCount: 9,
    activeUserCount: 4,
    featured: false,
    original: false,
    publishedAt: new Date('2026-09-12T00:00:00.000Z'),
    firstPublishedAt: new Date('2026-09-12T00:00:00.000Z'),
    updatedAt: new Date('2026-09-12T00:00:00.000Z'),
    withdrawnAt: null,
    category: { id: 'category-1', slug: 'development', name: '编程', description: null, sortOrder: 1, enabled: true },
    submission: {
      skillName: 'marketplace-helper',
      displayName: 'Marketplace 助手',
      description: '帮助安装 Skill',
      category: '开发与工程',
      labels: ['Skill 管理'],
      compatibleAgents: ['codex'],
    },
    version: {
      id: '55555555-5555-4555-8555-555555555555',
      version: 'v1.0.0',
      changelog: '首次上架',
      packageSize: 128,
      createdAt: new Date('2026-09-12T00:00:00.000Z'),
    },
    skill: { author: { id: 'author-1', displayName: '作者', avatarUrl: null } },
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
  mockRole.value = 'user'
  mockDb.$transaction.mockImplementation(async (input: unknown) => {
    if (Array.isArray(input)) return Promise.all(input)
    return (input as (transaction: typeof mockDb) => Promise<unknown>)(mockDb)
  })
  mockDb.marketplaceCategory.findMany.mockResolvedValue([])
  mockDb.marketplaceTopic.findMany.mockResolvedValue([])
  mockDb.marketplaceListing.findMany.mockResolvedValue([])
  mockDb.marketplaceListing.count.mockResolvedValue(0)
  mockDb.marketplaceComment.findMany.mockResolvedValue([])
  mockDb.marketplaceInstallIntent.findUnique.mockResolvedValue(null)
  mockDb.marketplaceManagedPresence.findMany.mockResolvedValue([])
  mockDb.appReleaseDownloadMetric.aggregate.mockResolvedValue({ _sum: { count: 0 } })
  mockDb.appReleaseDownloadMetric.groupBy.mockResolvedValue([])
  mockDb.user.count.mockResolvedValue(0)
  mockDb.user.findMany.mockResolvedValue([])
  mockTopicCovers.storeTopicCover.mockResolvedValue('https://picem-media.whatonearth.work/apps/app/assets/ast/v1/original.jpg')
  mockDb.teamMember.count.mockResolvedValue(0)
  mockDb.marketplaceInstallIntent.groupBy.mockResolvedValue([])
  mockDb.skill.groupBy.mockResolvedValue([])
  mockDb.$queryRaw.mockResolvedValue([])
  mockDb.marketplaceListingDailyMetric.groupBy.mockResolvedValue([])
  mockDb.marketplaceListingDailyMetric.upsert.mockResolvedValue({})
  resetMarketplaceHotCache()
})

describe('Marketplace experience routes', () => {
  it('builds the public home from managed directories and real non-empty topics', async () => {
    mockDb.marketplaceCategory.findMany.mockResolvedValue([{ id: 'cat', slug: 'development', name: '编程', sortOrder: 1 }])
    mockDb.marketplaceTopic.findMany.mockResolvedValue([
      { id: 'topic-empty', slug: 'empty', title: '空专题', description: null, introContent: null, coverImageUrl: null, featured: false, sortOrder: 2, publishedAt: null, items: [] },
      { id: 'topic-real', slug: 'real', title: '效率工具', description: '提高效率', introContent: '适合希望减少重复工作的团队。', coverImageUrl: null, featured: true, sortOrder: 1, publishedAt: new Date(), items: [{ sortOrder: 0, listing: listing() }] },
    ])
    mockDb.marketplaceListing.findMany
      .mockResolvedValueOnce([listing()])
      .mockResolvedValueOnce([listing()])
    mockDb.marketplaceListing.count.mockResolvedValue(1)
    const app = await buildApp()
    const response = await app.inject({ method: 'GET', url: '/api/marketplace/home' })
    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({
      total: 1,
      popularKind: 'hot',
      topics: [{ slug: 'real', introContent: '适合希望减少重复工作的团队。', items: [{ listingId: SKILL_ID, installCount: 9, userCount: 4 }] }],
      popular: [{ id: SKILL_ID, category: '编程' }],
    })
    await app.close()
  })

  it('ranks the home by current managed users independently of latest publications', async () => {
    mockDb.marketplaceListing.findMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([listing()])
    mockDb.marketplaceListing.count.mockResolvedValue(1)
    const app = await buildApp()
    const response = await app.inject({ method: 'GET', url: '/api/marketplace/home' })
    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({ popularKind: 'hot', popular: [{ id: SKILL_ID }] })
    expect(response.json().latest).toEqual([])
    expect(mockDb.marketplaceListing.findMany).toHaveBeenNthCalledWith(2, expect.objectContaining({
      orderBy: [{ activeUserCount: 'desc' }, { installClickCount: 'desc' }, { publishedAt: 'desc' }, { skillId: 'asc' }],
    }))
    expect(mockDb.marketplaceManagedPresence.findMany).not.toHaveBeenCalled()
    await app.close()
  })

  it('counts each user once while a public Skill remains managed on any device', async () => {
    mockDb.marketplaceListing.findMany.mockResolvedValue([{ skillId: SKILL_ID }])
    mockDb.marketplaceManagedPresence.findMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        { userId: '11111111-1111-4111-8111-111111111111' },
      ])
    mockDb.marketplaceManagedPresence.updateMany.mockResolvedValue({ count: 0 })
    mockDb.marketplaceManagedPresence.upsert.mockResolvedValue({})
    mockDb.marketplaceListing.updateMany.mockResolvedValue({ count: 1 })
    const app = await buildApp()
    const response = await app.inject({
      method: 'POST',
      url: '/api/marketplace/presence/sync',
      headers: { authorization: 'Bearer local-test' },
      payload: { deviceId: 'desktop-device-1', activeListingIds: [SKILL_ID] },
    })
    expect(response.statusCode).toBe(200)
    expect(mockDb.marketplaceManagedPresence.findMany).toHaveBeenNthCalledWith(2, {
      where: { listingSkillId: SKILL_ID, active: true },
      select: { userId: true },
      distinct: ['userId'],
    })
    expect(mockDb.marketplaceListing.updateMany).toHaveBeenCalledWith({
      where: { skillId: SKILL_ID, withdrawnAt: null },
      data: { activeUserCount: 1 },
    })
    await app.close()
  })

  it('counts an idempotent install click only once', async () => {
    mockDb.marketplaceListing.findFirst.mockResolvedValue({ skillId: SKILL_ID })
    mockDb.marketplaceInstallIntent.create.mockResolvedValue({ id: INTENT_ID, listingSkillId: SKILL_ID, status: 'clicked' })
    mockDb.marketplaceListing.update.mockResolvedValue({})
    const app = await buildApp()
    const body = { idempotencyKey: 'web:1234567890abcdef', clientId: 'browser-device-1', source: 'web' }
    const first = await app.inject({ method: 'POST', url: `/api/marketplace/${SKILL_ID}/install-intents`, payload: body })
    expect(first.statusCode).toBe(201)
    expect(mockDb.marketplaceListing.update).toHaveBeenCalledTimes(1)
    expect(mockDb.marketplaceListingDailyMetric.upsert).toHaveBeenCalledWith(expect.objectContaining({
      create: expect.objectContaining({ listingSkillId: SKILL_ID, installs: 1 }),
      update: { installs: { increment: 1 } },
    }))
    mockDb.marketplaceInstallIntent.findUnique.mockResolvedValue({ id: INTENT_ID, listingSkillId: SKILL_ID, status: 'clicked' })
    const repeated = await app.inject({ method: 'POST', url: `/api/marketplace/${SKILL_ID}/install-intents`, payload: body })
    expect(repeated.statusCode).toBe(200)
    expect(mockDb.marketplaceListing.update).toHaveBeenCalledTimes(1)
    expect(mockDb.marketplaceListingDailyMetric.upsert).toHaveBeenCalledTimes(1)
    await app.close()
  })

  it('exposes only visible public comments to an anonymous reader', async () => {
    mockDb.marketplaceListing.findFirst.mockResolvedValue({ skillId: SKILL_ID })
    const app = await buildApp()
    const response = await app.inject({ method: 'GET', url: `/api/marketplace/${SKILL_ID}/comments` })
    expect(response.statusCode).toBe(200)
    expect(mockDb.marketplaceComment.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ visibility: 'public', teamId: null, status: 'visible' }),
    }))
    await app.close()
  })

  it('rejects team discussion when the user is not a member', async () => {
    const app = await buildApp()
    const response = await app.inject({
      method: 'POST',
      url: `/api/marketplace/${SKILL_ID}/comments`,
      headers: { authorization: 'Bearer local-test' },
      payload: {
        visibility: 'team',
        teamId: '66666666-6666-4666-8666-666666666666',
        content: '团队讨论',
      },
    })
    expect(response.statusCode).toBe(403)
    expect(mockDb.marketplaceComment.create).not.toHaveBeenCalled()
    await app.close()
  })

  it('keeps admin controls role based instead of checking an email', async () => {
    mockDb.marketplaceCategory.findMany.mockResolvedValue([])
    const app = await buildApp()
    const denied = await app.inject({ method: 'GET', url: '/api/marketplace/admin/categories' })
    expect(denied.statusCode).toBe(403)
    mockRole.value = 'admin'
    const allowed = await app.inject({ method: 'GET', url: '/api/marketplace/admin/categories' })
    expect(allowed.statusCode).toBe(200)
    await app.close()
  })
})

describe('operator workflows', () => {
  it('allows only an administrator to send a bounded all-user notice', async () => {
    const app = await buildApp()
    const denied = await app.inject({ method: 'POST', url: '/api/marketplace/admin/announcements', payload: { message: '更新说明' } })
    expect(denied.statusCode).toBe(403)
    mockRole.value = 'admin'
    mockDb.user.findMany.mockResolvedValueOnce([{ id: '11111111-1111-4111-8111-111111111111' }])
    mockDb.notification.createMany.mockResolvedValue({ count: 1 })
    mockDb.adminAnnouncement.create.mockResolvedValue({ id: 'announcement-1' })
    mockDb.adminAnnouncement.update.mockResolvedValue({ id: 'announcement-1', recipientCount: 1 })
    const sent = await app.inject({ method: 'POST', url: '/api/marketplace/admin/announcements', payload: { message: '更新说明', clientOperationId: '33333333-3333-4333-8333-333333333333' } })
    expect(sent.statusCode).toBe(201)
    expect(sent.json()).toMatchObject({ recipients: 1 })
    expect(mockDb.notification.createMany).toHaveBeenCalledWith({ data: [expect.objectContaining({ type: 'admin_broadcast', payload: expect.objectContaining({ message: '更新说明' }) })] })
    const invalid = await app.inject({ method: 'POST', url: '/api/marketplace/admin/announcements', payload: { message: 'x'.repeat(2001) } })
    expect(invalid.statusCode).toBe(400)
    await app.close()
  })
  it('lists users with server-side search and pagination', async () => {
    mockRole.value = 'admin'
    mockDb.user.count.mockResolvedValue(1)
    mockDb.user.findMany.mockResolvedValue([{ id: SKILL_ID, email: 'user@example.com', displayName: '用户', marketplaceRole: 'user', createdAt: new Date(), updatedAt: new Date(), externalIdentities: [{ lastLoginAt: new Date() }], _count: { skills: 2, memberships: 1, marketplaceSubmissions: 3 } }])
    const app = await buildApp()
    const response = await app.inject({ method: 'GET', url: '/api/marketplace/admin/users?search=user&page=2&pageSize=25' })
    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({ total: 1, page: 2, pageSize: 25, items: [{ email: 'user@example.com', lastLoginAt: expect.any(String) }] })
    expect(mockDb.user.findMany).toHaveBeenCalledWith(expect.objectContaining({ skip: 25, take: 25 }))
    await app.close()
  })
  it('returns total users and provider configuration on the dashboard', async () => {
    mockRole.value = 'admin'
    mockDb.user.count.mockResolvedValue(42)
    mockDb.appReleaseDownloadMetric.aggregate.mockResolvedValue({ _sum: { count: 27 } })
    mockDb.appReleaseDownloadMetric.groupBy
      .mockResolvedValueOnce([
        { version: '0.24.1', target: 'darwin', arch: 'aarch64', _sum: { count: 12 }, _max: { day: new Date('2026-09-27T00:00:00.000Z') } },
        { version: '0.24.1', target: 'windows', arch: 'x86_64', _sum: { count: 15 }, _max: { day: new Date('2026-09-27T00:00:00.000Z') } },
      ])
      .mockResolvedValueOnce([{ day: new Date('2026-09-27T00:00:00.000Z'), _sum: { count: 27 } }])
    const app = await buildApp()
    const response = await app.inject({ method: 'GET', url: '/api/marketplace/admin/dashboard' })
    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({
      totalUsers: 42,
      aiProviders: [{ purpose: 'Skill 分析' }, { purpose: '专题撰写' }],
      appDownloads: {
        totalStarts: 27,
        last30Days: 27,
        byVersion: [{ version: '0.24.1', total: 27, platforms: expect.arrayContaining([
          { target: 'darwin', arch: 'aarch64', count: 12 },
          { target: 'windows', arch: 'x86_64', count: 15 },
        ]) }],
      },
    })
    await app.close()
  })
  it('stores a validated topic cover and returns its public URL', async () => {
    mockRole.value = 'admin'
    const app = await buildApp()
    const response = await app.inject({ method: 'POST', url: '/api/marketplace/admin/topics/cover', payload: { mimeType: 'image/png', dataBase64: 'iVBORw0KGgo=' } })
    expect(response.statusCode).toBe(201)
    expect(response.json().url).toBe('https://picem-media.whatonearth.work/apps/app/assets/ast/v1/original.jpg')
    expect(mockTopicCovers.storeTopicCover).toHaveBeenCalledOnce()
    await app.close()
  })
  it('creates categories without a slug and keeps a stable generated link', async () => {
    mockRole.value = 'admin'
    mockDb.marketplaceCategory.create.mockImplementation(async ({ data }) => ({ id: SKILL_ID, ...data }))
    const app = await buildApp()
    const response = await app.inject({ method: 'POST', url: '/api/marketplace/admin/categories', payload: { name: '视频剪辑' } })
    expect(response.statusCode).toBe(201)
    expect(response.json().slug).toMatch(/^category-/)
    expect(response.json().name).toBe('视频剪辑')
    await app.close()
  })
  it('keeps category mutation responses unchanged when shadow avatar columns exist', async () => {
    mockRole.value = 'admin'
    const legacy = { skillId: SKILL_ID, categoryId: null, updatedAt: new Date('2026-10-18T00:00:00Z') }
    mockDb.marketplaceListing.update.mockResolvedValue({ ...legacy, avatarUrl: 'private-shadow', avatarStatus: 'ready',
      avatarSource: 'legacy', avatarSnapshotAt: new Date(), avatarUpdatedById: 'internal' })
    const app = await buildApp()
    const response = await app.inject({ method: 'PATCH', url: `/api/marketplace/admin/listings/${SKILL_ID}/category`, payload: { categoryId: null } })
    expect(response.statusCode).toBe(200)
    expect(response.body).toBe(JSON.stringify(legacy))
    await app.close()
  })
  it('rejects publishing a topic with an unavailable Skill before any mutation', async () => {
    mockRole.value = 'admin'
    mockDb.marketplaceListing.count.mockResolvedValue(0)
    const app = await buildApp()
    const response = await app.inject({ method: 'POST', url: '/api/marketplace/admin/topics/save', payload: { title: '视频制作', status: 'published', listingIds: [SKILL_ID] } })
    expect(response.statusCode).toBe(409)
    expect(mockDb.marketplaceTopic.create).not.toHaveBeenCalled()
    expect(mockDb.marketplaceTopicItem.deleteMany).not.toHaveBeenCalled()
    await app.close()
  })
  it('saves a topic and ordered selection together', async () => {
    mockRole.value = 'admin'
    mockDb.marketplaceListing.count.mockResolvedValue(1)
    mockDb.marketplaceTopic.create.mockImplementation(async ({ data }) => ({ id: INTENT_ID, ...data }))
    // #211: Web saves are audited too (admin re-check under lock, then one audit row).
    mockDb.$queryRaw.mockResolvedValue([{ id: '11111111-1111-4111-8111-111111111111' }])
    const app = await buildApp()
    const response = await app.inject({ method: 'POST', url: '/api/marketplace/admin/topics/save', payload: { title: '视频制作', status: 'draft', listingIds: [SKILL_ID] } })
    expect(response.statusCode).toBe(200)
    expect(response.json().slug).toMatch(/^topic-/)
    expect(mockDb.marketplaceTopicItem.createMany).toHaveBeenCalledWith({ data: [{ topicId: INTENT_ID, skillId: SKILL_ID, sortOrder: 0 }] })
    expect(mockDb.adminAgentAuditEvent.create).toHaveBeenCalledWith({ data: { channel: 'web', actorAdminId: '11111111-1111-4111-8111-111111111111', operationId: 'marketplace.topic.save', outcome: `write:${INTENT_ID}` } })
    await app.close()
  })
  it('filters discussion on the server by Skill, content and stable time ordering', async () => {
    mockRole.value = 'admin'
    const app = await buildApp()
    const response = await app.inject({ method: 'GET', url: `/api/marketplace/admin/comments?listingSkillId=${SKILL_ID}&search=剪辑&order=asc&page=2&pageSize=25` })
    expect(response.statusCode).toBe(200)
    expect(mockDb.marketplaceComment.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ visibility: 'public', listingSkillId: SKILL_ID, content: { contains: '剪辑', mode: 'insensitive' } }), skip: 25, take: 25, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] }))
    await app.close()
  })
  it('requires admin role for AI generation and atomic topic writes', async () => {
    const app = await buildApp()
    for (const endpoint of ['topics/save', 'topics/generate']) {
      const response = await app.inject({ method: 'POST', url: `/api/marketplace/admin/${endpoint}`, payload: {} })
      expect(response.statusCode).toBe(403)
    }
    await app.close()
  })
})


describe('analytics stage definitions', () => {
  it('preserves legacy completions without inventing joined or Agent events', async () => {
    mockRole.value = 'admin'
    mockDb.$queryRaw.mockResolvedValue([{ day: '2026-09-13', clicks: 8n, completed: 6n, joined: 2n, agents: 1n }])
    mockDb.marketplaceSubmission.count.mockResolvedValue(3)
    mockDb.marketplaceComment.count.mockResolvedValue(4)
    const app = await buildApp()
    const response = await app.inject({ method: 'GET', url: '/api/marketplace/admin/analytics?from=2026-09-12T16:00:00Z&to=2026-09-13T16:00:00Z' })
    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({ timezone: 'Asia/Shanghai', daily: [{ day: '2026-09-13', clicks: 8, completed: 6, joined: 2, agents: 1 }], pendingReviews: 3, publicComments: 4 })
    expect(response.json().completionDefinition).toContain('旧版回执仅计入完成流程')
    await app.close()
  })
  it('rejects unbounded or reversed analytics ranges before querying', async () => {
    mockRole.value = 'admin'
    const app = await buildApp()
    for (const query of ['from=2025-01-01T00:00:00Z&to=2026-09-13T00:00:00Z', 'from=2026-09-13T00:00:00Z&to=2026-09-12T00:00:00Z']) {
      expect((await app.inject({ method: 'GET', url: `/api/marketplace/admin/analytics?${query}` })).statusCode).toBe(400)
    }
    expect(mockDb.$queryRaw).not.toHaveBeenCalled()
    await app.close()
  })
})


afterEach(() => vi.restoreAllMocks())
describe('topic AI result handling', () => {
  it('returns an editable draft without writing or publishing a topic', async () => {
    mockRole.value = 'admin'
    mockDb.marketplaceListing.findMany.mockResolvedValue([listing()])
    // #211: the draft is an article that embeds exactly the requested Skills.
    vi.spyOn(skillAnalysis, 'requestConfiguredAiDraft').mockResolvedValue(JSON.stringify({ title: '创作工具箱', description: '减少重复操作',
      contentMarkdown: `## 先选工具\n\n选择适合的工具完成创作流程。\n\n[tool](skill:${SKILL_ID})` }))
    const app = await buildApp()
    const response = await app.inject({ method: 'POST', url: '/api/marketplace/admin/topics/generate', payload: { listingIds: [SKILL_ID] } })
    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({ title: '创作工具箱', listingIds: [SKILL_ID], introContent: '先选工具\n\n选择适合的工具完成创作流程。' })
    expect(mockDb.marketplaceTopic.create).not.toHaveBeenCalled()
    expect(mockDb.marketplaceTopic.update).not.toHaveBeenCalled()
    await app.close()
  })
  it('reports a provider timeout distinctly and keeps manual editing available', async () => {
    mockRole.value = 'admin'
    mockDb.marketplaceListing.findMany.mockResolvedValue([listing()])
    vi.spyOn(skillAnalysis, 'requestConfiguredAiDraft').mockRejectedValue(new DOMException('timeout', 'TimeoutError'))
    const app = await buildApp()
    const response = await app.inject({ method: 'POST', url: '/api/marketplace/admin/topics/generate', payload: { listingIds: [SKILL_ID] } })
    expect(response.statusCode).toBe(504)
    expect(response.json().error).toContain('手工编辑')
    expect(mockDb.marketplaceTopic.create).not.toHaveBeenCalled()
    await app.close()
  })
})

describe('Store trending and statistics', () => {
  let app: FastifyInstance | undefined
  afterEach(async () => {
    await app?.close()
    app = undefined
  })

  const id = (letter: string): string => `${letter.repeat(8)}-0000-4000-8000-000000000000`
  function candidate(letter: string, installClickCount: number) {
    return { skillId: id(letter), publishedAt: new Date('2026-09-01T00:00:00.000Z'), downloadCount: 0, activeUserCount: 0, installClickCount }
  }

  it('puts listings with recent installs first and tops the board up by installs', async () => {
    mockDb.marketplaceListing.findMany.mockImplementation(async (args: { select?: unknown; where: { skillId?: { in: string[] } } }) => {
      if (args.select) return [candidate('a', 50), candidate('b', 1), candidate('c', 20)]
      return (args.where.skillId?.in ?? []).map((skillId) => ({ ...listing(), skillId, original: skillId === id('b') }))
    })
    const today = storeDayValue(storeDay(new Date())).getTime()
    mockDb.marketplaceListingDailyMetric.groupBy.mockImplementation(async (args: { where: { day: { gte: Date; lte: Date } } }) => {
      if (args.where.day.lte.getTime() !== today) return [{ listingSkillId: id('b'), _sum: { downloads: 1, installs: 0 } }]
      // 「今日」 is one day; the 热门 window spans 7, and stays below its minimum score here.
      return args.where.day.gte.getTime() === today ? [{ listingSkillId: id('b'), _sum: { downloads: 1, installs: 2 } }] : []
    })
    app = await buildApp()

    const response = await app.inject({ method: 'GET', url: '/api/marketplace/trending?range=day&limit=2' })

    expect(response.statusCode).toBe(200)
    expect(response.json().range).toBe('day')
    expect(response.json().items.map((item: { listingId: string }) => item.listingId)).toEqual([id('b'), id('a')])
    expect(response.json().items[0]).toMatchObject({ original: true, trend: { recentInstalls: 3, previousInstalls: 1, growthPercent: 200 } })
    expect(response.json().items[1].trend).toEqual({ recentInstalls: 0, previousInstalls: 0, growthPercent: null })
    expect(mockDb.marketplaceListing.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ withdrawnAt: null, skill: { is: { deletedAt: null } } }),
    }))
  })

  it.each([
    '/api/marketplace/trending?range=month',
    '/api/marketplace/trending?limit=0',
    '/api/marketplace/trending?limit=21',
    '/api/marketplace/trending?userId=x',
  ])('rejects %s before querying', async (url) => {
    app = await buildApp()
    const response = await app.inject({ method: 'GET', url })
    expect(response.statusCode).toBe(400)
    expect(mockDb.marketplaceListing.findMany).not.toHaveBeenCalled()
  })

  it('returns an empty board for an empty store', async () => {
    app = await buildApp()
    const response = await app.inject({ method: 'GET', url: '/api/marketplace/trending' })
    expect(response.json()).toEqual({ range: 'week', items: [] })
  })

  it('serves store statistics and reuses them within the cache window', async () => {
    mockDb.marketplaceListing.count.mockResolvedValue(5)
    mockDb.skill.groupBy.mockResolvedValue([{ authorId: 'author-1' }])
    const today = storeDayValue(storeDay(new Date()))
    mockDb.marketplaceListingDailyMetric.groupBy.mockResolvedValue([{ day: today, _sum: { downloads: 3, installs: 2 } }])
    app = await buildApp()

    const first = await app.inject({ method: 'GET', url: '/api/marketplace/stats' })
    const second = await app.inject({ method: 'GET', url: '/api/marketplace/stats' })

    expect(first.statusCode).toBe(200)
    expect(first.headers['cache-control']).toBe('public, max-age=60')
    expect(first.json()).toMatchObject({ totalSkills: 5, newThisWeek: 5, installsToday: 2, downloadsToday: 3, activeAuthors: 1 })
    expect(first.json().dailyInstalls).toEqual([0, 0, 0, 0, 0, 0, 2])
    expect(first.json().dailyDownloads).toEqual([0, 0, 0, 0, 0, 0, 3])
    expect(first.json().weeklyNewSkills).toHaveLength(8)
    expect(first.body).not.toContain('author-1')
    expect(second.json()).toEqual(first.json())
    expect(mockDb.marketplaceListing.count).toHaveBeenCalledTimes(2)
  })
})

describe('Original mark editing', () => {
  let app: FastifyInstance | undefined
  afterEach(async () => {
    await app?.close()
    app = undefined
  })

  it('lets a store administrator set the original mark', async () => {
    mockRole.value = 'admin'
    mockDb.marketplaceListing.findFirst.mockResolvedValue({ ...listing(), original: false, editorialLabels: [] })
    mockDb.marketplaceListing.update.mockResolvedValue({ ...listing(), original: true, editorialLabels: [] })
    app = await buildApp()

    const response = await app.inject({ method: 'PATCH', url: `/api/marketplace/admin/listings/${SKILL_ID}/editorial`, payload: { original: true } })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({ listingId: SKILL_ID, original: true })
    expect(mockDb.marketplaceListing.update).toHaveBeenCalledWith(expect.objectContaining({ data: { original: true } }))
  })

  // A hot listing must stay hot in every DTO, including the editorial success response and admin rankings.
  function hotListing(): void {
    mockDb.marketplaceListing.findMany.mockImplementation(async (args: { select?: unknown }) => (
      args.select ? [{ skillId: SKILL_ID, firstPublishedAt: new Date('2026-09-12T00:00:00.000Z') }] : [{ ...listing(), editorialLabels: [] }]
    ))
    mockDb.marketplaceListingDailyMetric.groupBy.mockResolvedValue([{ listingSkillId: SKILL_ID, _sum: { downloads: 6, installs: 4 } }])
  }

  it('keeps 热门 in the editorial response after setting 精选 and 原创', async () => {
    mockRole.value = 'admin'
    hotListing()
    mockDb.marketplaceListing.findFirst.mockResolvedValue({ ...listing(), editorialLabels: [] })
    mockDb.marketplaceListing.update.mockResolvedValue({ ...listing(), featured: true, original: true, editorialLabels: [] })
    app = await buildApp()

    const response = await app.inject({ method: 'PATCH', url: `/api/marketplace/admin/listings/${SKILL_ID}/editorial`, payload: { featured: true, original: true } })

    expect(response.statusCode).toBe(200)
    expect(response.json().badges).toEqual(['featured', 'original', 'hot'])
  })

  it('keeps 热门 on admin analytics rankings', async () => {
    mockRole.value = 'admin'
    hotListing()
    mockDb.$queryRaw.mockResolvedValue([])
    mockDb.marketplaceSubmission.count.mockResolvedValue(0)
    mockDb.marketplaceComment.count.mockResolvedValue(0)
    app = await buildApp()

    const response = await app.inject({ method: 'GET', url: '/api/marketplace/admin/analytics?from=2026-09-12T16:00:00Z&to=2026-09-13T16:00:00Z' })

    expect(response.statusCode).toBe(200)
    expect(response.json().rankings[0].badges).toEqual(['hot'])
  })

  it('forbids a non-administrator from setting the original mark', async () => {
    app = await buildApp()
    const response = await app.inject({ method: 'PATCH', url: `/api/marketplace/admin/listings/${SKILL_ID}/editorial`, payload: { original: true } })
    expect(response.statusCode).toBe(403)
    expect(mockDb.marketplaceListing.update).not.toHaveBeenCalled()
  })
})
