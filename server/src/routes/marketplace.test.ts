import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify'
import sensible from '@fastify/sensible'
import { Prisma } from '@prisma/client'
import { createHash } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mockDb = vi.hoisted(() => ({
  $transaction: vi.fn(),
  skill: {
    findMany: vi.fn(),
    findUnique: vi.fn(),
    findUniqueOrThrow: vi.fn(),
    update: vi.fn(),
  },
  marketplaceSubmission: {
    count: vi.fn(),
    findFirst: vi.fn(),
    findUnique: vi.fn(),
    findMany: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
  },
  cardGrant: { findUnique: vi.fn() },
  marketplaceListing: {
    count: vi.fn(),
    findMany: vi.fn(),
    findFirst: vi.fn(),
    updateMany: vi.fn(),
    upsert: vi.fn(),
  },
  marketplaceCategory: {
    findMany: vi.fn(),
  },
  marketplaceInstallIntent: {
    groupBy: vi.fn(),
  },
  marketplaceListingDailyMetric: {
    groupBy: vi.fn(),
    upsert: vi.fn(),
  },
  notification: {
    create: vi.fn(),
  },
}))

const mockConfig = vi.hoisted(() => ({
  MARKETPLACE_DOWNLOADS_PER_MINUTE: 60,
}))

const mockAuth = vi.hoisted(() => ({
  role: 'user' as 'user' | 'admin',
}))

const mockMutationLocks = vi.hoisted(() => ({
  lockUserMutation: vi.fn().mockResolvedValue(undefined),
  lockSkillMutation: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('../db.js', () => ({ db: mockDb }))
vi.mock('../config.js', () => ({ config: mockConfig }))
vi.mock('../lib/mutation-lock.js', () => mockMutationLocks)
vi.mock('../middleware/auth.js', () => ({
  authMiddleware: async (request: FastifyRequest): Promise<void> => {
    request.user = {
      id: '11111111-1111-4111-8111-111111111111',
      email: 'author@example.com',
      displayName: 'Marketplace Author',
      avatarUrl: null,
      marketplaceRole: mockAuth.role,
    }
  },
}))

import { MARKETPLACE_ABUSE_LIMITS, marketplaceRoutes } from './marketplace.js'
import { resetMarketplaceHotCache } from '../lib/marketplace-badges.js'
import { storeDay, storeDayValue } from '../lib/marketplace-trends.js'
import { SKILL_PACKAGE_REVIEW_LIMITS } from '../lib/skill-package.js'

const USER_ID = '11111111-1111-4111-8111-111111111111'
const ADMIN_ID = USER_ID
const SKILL_ID = '22222222-2222-4222-8222-222222222222'
const VERSION_ID = '33333333-3333-4333-8333-333333333333'
const SUBMISSION_ID = '44444444-4444-4444-8444-444444444444'
const NOW = new Date('2026-08-04T01:02:03.000Z')

const crcTable = (() => {
  const table = new Uint32Array(256)
  for (let index = 0; index < table.length; index += 1) {
    let value = index
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) === 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
    }
    table[index] = value >>> 0
  }
  return table
})()

function crc32(data: Buffer): number {
  let crc = 0xffffffff
  for (const byte of data) crc = (crcTable[(crc ^ byte) & 0xff] ?? 0) ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

function createStoredZip(entries: { name: string; data: Buffer | string }[]): Buffer {
  const localParts: Buffer[] = []
  const centralParts: Buffer[] = []
  let localOffset = 0
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8')
    const data = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data, 'utf8')
    const crc = crc32(data)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0x0800, 6)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(data.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(name.length, 26)
    localParts.push(local, name, data)

    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(0x0314, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(0x0800, 8)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(data.length, 20)
    central.writeUInt32LE(data.length, 24)
    central.writeUInt16LE(name.length, 28)
    central.writeUInt32LE((0o100644 * 0x10000) >>> 0, 38)
    central.writeUInt32LE(localOffset, 42)
    centralParts.push(central, name)
    localOffset += local.length + name.length + data.length
  }

  const centralDirectory = Buffer.concat(centralParts)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(entries.length, 8)
  eocd.writeUInt16LE(entries.length, 10)
  eocd.writeUInt32LE(centralDirectory.length, 12)
  eocd.writeUInt32LE(localOffset, 16)
  return Buffer.concat([...localParts, centralDirectory, eocd])
}

function createStoredSkillZip(skillMd = '# Marketplace Helper\n'): Buffer {
  return createStoredZip([{ name: 'SKILL.md', data: skillMd }])
}

function submissionCandidateVersion(overrides: Record<string, unknown> = {}) {
  const packageData = createStoredSkillZip()
  return {
    id: VERSION_ID,
    skillId: SKILL_ID,
    version: 'v1.2.0',
    changelog: '发布稳定版',
    packageData,
    packageSha256: createHash('sha256').update(packageData).digest('hex'),
    packageSize: packageData.length,
    profileSnapshotVersion: 1,
    skillName: 'marketplace-helper',
    displayName: 'Marketplace 助手',
    description: '安装助手',
    category: '开发与工程',
    labels: ['Skill管理'],
    triggerScenarios: ['安装 Skill'],
    compatibleAgents: ['codex'],
    envDependencies: [{ key: 'EXAMPLE_API_KEY', required: true }],
    sourceContent: '# Marketplace Helper\n',
    createdAt: NOW,
    ...overrides,
  }
}

function ownedSubmissionSkill(version = submissionCandidateVersion()) {
  return {
    id: SKILL_ID,
    name: 'marketplace-helper',
    displayName: 'Marketplace 助手',
    authorId: USER_ID,
    deletedAt: null,
    versions: [version],
  }
}

function publicVersion(overrides: Record<string, unknown> = {}) {
  return {
    id: VERSION_ID,
    version: 'v1.2.0',
    changelog: '发布稳定版',
    packageSha256: 'a'.repeat(64),
    packageSize: 512,
    createdAt: NOW,
    ...overrides,
  }
}

function submission(overrides: Record<string, unknown> = {}) {
  return {
    id: SUBMISSION_ID,
    skillId: SKILL_ID,
    versionId: VERSION_ID,
    submittedById: USER_ID,
    reviewerId: null,
    status: 'submitted',
    submitterNote: '请验收安装与搜索流程',
    reviewNote: null,
    skillName: 'marketplace-helper',
    displayName: 'Marketplace 助手',
    description: '帮助用户完成安全的 Skill 安装',
    category: '开发与工程',
    labels: ['Skill管理', '测试验证'],
    triggerScenarios: ['安装 Skill'],
    compatibleAgents: ['codex', 'claude'],
    envDependencies: [{ key: 'EXAMPLE_API_KEY', required: true }],
    sourceContent: '# Marketplace Helper\n',
    submittedAt: NOW,
    reviewStartedAt: null,
    reviewedAt: null,
    withdrawnAt: null,
    version: publicVersion(),
    ...overrides,
  }
}

function listing(overrides: Record<string, unknown> = {}) {
  return {
    skillId: SKILL_ID,
    submissionId: SUBMISSION_ID,
    versionId: VERSION_ID,
    downloadCount: 27,
    featured: false,
    original: false,
    publishedAt: NOW,
    firstPublishedAt: NOW,
    updatedAt: NOW,
    withdrawnAt: null,
    submission: submission({ status: 'approved' }),
    version: publicVersion(),
    skill: {
      deletedAt: null,
      author: { id: USER_ID, displayName: 'Marketplace Author', avatarUrl: null },
    },
    ...overrides,
  }
}

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify()
  await app.register(sensible)
  await app.register(marketplaceRoutes, { prefix: '/api/marketplace' })
  await app.ready()
  return app
}

describe('Marketplace routes', () => {
  it.each(['checksum', 'skill-md', 'encoding', 'unsafe-package'])('rejects invalid catalog submission %s before database writes', async kind => {
    const server = await buildApp()
    try {
      const skillMd = '# Catalog test'
      const data = createStoredZip([{ name: 'SKILL.md', data: skillMd }, ...(kind === 'unsafe-package' ? [{ name: '../escape.txt', data: 'escape' }] : [])])
      const payload = {
        clientOperationId: SUBMISSION_ID, name: 'catalog-test', sourceOrigin: 'https://private.example.test', sourceSkillId: SKILL_ID,
        profile: { displayName: 'Catalog test', description: 'Catalog description', category: '开发与工程', labels: ['测试验证', 'Skill管理'], triggerScenarios: [] },
        compatibleAgents: ['codex'], envDependencies: [], skillMd: kind === 'skill-md' ? '# Different' : skillMd,
        packageBase64: kind === 'encoding' ? '!bad' : data.toString('base64'),
        packageSha256: kind === 'checksum' ? '0'.repeat(64) : createHash('sha256').update(data).digest('hex'),
      }
      const response = await server.inject({ method: 'POST', url: '/api/marketplace/catalog-submissions', payload })
      expect(response.statusCode, response.body).toBe(400)
      expect(response.json().message).not.toContain('labels')
      expect(mockDb.$transaction).not.toHaveBeenCalled()
    } finally { await server.close() }
  })
  let app: FastifyInstance | undefined

  beforeEach(() => {
    mockDb.cardGrant.findUnique.mockReset()
    vi.clearAllMocks()
    mockAuth.role = 'user'
    mockConfig.MARKETPLACE_DOWNLOADS_PER_MINUTE = 60
    mockDb.$transaction.mockImplementation(
      async (callback: (transaction: typeof mockDb) => Promise<unknown>): Promise<unknown> => callback(mockDb)
    )
    mockDb.skill.findMany.mockResolvedValue([])
    mockDb.skill.findUnique.mockResolvedValue(null)
    mockDb.skill.findUniqueOrThrow.mockResolvedValue({ avatarUrl: null, avatarStatus: 'none' })
    mockDb.skill.update.mockResolvedValue({})
    mockDb.marketplaceSubmission.findFirst.mockResolvedValue(null)
    mockDb.marketplaceSubmission.findUnique.mockResolvedValue(null)
    mockDb.marketplaceSubmission.findMany.mockResolvedValue([])
    mockDb.marketplaceSubmission.count.mockResolvedValue(0)
    mockDb.marketplaceListing.count.mockResolvedValue(0)
    mockDb.marketplaceListing.findMany.mockResolvedValue([])
    mockDb.marketplaceListing.findFirst.mockResolvedValue(null)
    mockDb.marketplaceListing.updateMany.mockResolvedValue({ count: 1 })
    mockDb.marketplaceListing.upsert.mockResolvedValue({})
    mockDb.marketplaceCategory.findMany.mockResolvedValue([])
    mockDb.marketplaceInstallIntent.groupBy.mockResolvedValue([])
    mockDb.marketplaceListingDailyMetric.groupBy.mockResolvedValue([])
    mockDb.marketplaceListingDailyMetric.upsert.mockResolvedValue({})
    resetMarketplaceHotCache()
    mockDb.notification.create.mockResolvedValue({})
  })

  afterEach(async () => {
    await app?.close()
    app = undefined
  })

  it('lists only active approved snapshots, searches exact labels, and filters by Agent before pagination', async () => {
    mockDb.marketplaceListing.count.mockResolvedValue(1)
    mockDb.marketplaceListing.findMany.mockResolvedValue([listing()])
    mockDb.marketplaceSubmission.findMany.mockResolvedValue([
      { category: '搜索与研究' },
      { category: '开发与工程' },
      { category: '' },
      { category: null },
      { category: '开发与工程' },
    ])
    app = await buildApp()

    const response = await app.inject({
      method: 'GET',
      url: '/api/marketplace?query=helper&category=%E5%BC%80%E5%8F%91%E4%B8%8E%E5%B7%A5%E7%A8%8B&label=Skill%E7%AE%A1%E7%90%86&agent=codex&sort=downloads&page=2&pageSize=10',
    })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({
      total: 1,
      page: 2,
      pageSize: 10,
      categories: ['开发与工程', '搜索与研究'],
      items: [{
        id: SKILL_ID,
        name: 'marketplace-helper',
        displayName: 'Marketplace 助手',
        currentVersion: 'v1.2.0',
        compatibleAgents: ['codex', 'claude'],
        downloadCount: 27,
        author: { id: USER_ID, displayName: 'Marketplace Author' },
        version: { id: VERSION_ID, version: 'v1.2.0' },
      }],
    })
    expect(response.body).not.toContain('sourceContent')
    expect(response.body).not.toContain('skillMd')
    expect(mockDb.marketplaceListing.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        withdrawnAt: null,
        skill: { is: { deletedAt: null } },
        OR: expect.arrayContaining([
          { categoryId: null, submission: { is: expect.objectContaining({ category: '开发与工程' }) } },
        ]),
        submission: {
          is: expect.objectContaining({
            status: 'approved',
            labels: { array_contains: ['Skill管理'] },
            compatibleAgents: { array_contains: ['codex'] },
            OR: expect.arrayContaining([
              { labels: { array_contains: ['helper'] } },
            ]),
          }),
        },
      }),
      orderBy: [{ downloadCount: 'desc' }, { publishedAt: 'desc' }, { skillId: 'asc' }],
      skip: 10,
      take: 10,
    }))
    expect(mockDb.marketplaceSubmission.findMany).toHaveBeenCalledWith({
      where: {
        status: 'approved',
        category: { not: null },
        listing: {
          is: {
            withdrawnAt: null,
            skill: { is: { deletedAt: null } },
          },
        },
      },
      select: { category: true },
      distinct: ['category'],
      orderBy: { category: 'asc' },
    })
  })

  it('rejects unknown Agent filters instead of silently returning a misleading catalog', async () => {
    app = await buildApp()
    const response = await app.inject({ method: 'GET', url: '/api/marketplace?agent=unknown-agent' })
    expect(response.statusCode).toBe(400)
    expect(mockDb.marketplaceListing.findMany).not.toHaveBeenCalled()
  })

  it.each(['workbuddy', 'doubao', 'trae'])('accepts the %s Agent filter', async (agent) => {
    app = await buildApp()
    const response = await app.inject({ method: 'GET', url: `/api/marketplace?agent=${agent}` })

    expect(response.statusCode).toBe(200)
    expect(mockDb.marketplaceListing.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        submission: {
          is: expect.objectContaining({
            compatibleAgents: { array_contains: [agent] },
          }),
        },
      }),
    }))
  })

  it('filters by required environment keys (the 需配置 API Key badge rule) and rejects unknown API Key filters', async () => {
    app = await buildApp()
    const none = await app.inject({ method: 'GET', url: '/api/marketplace?apiKey=none' })
    expect(none.statusCode).toBe(200)
    expect(mockDb.marketplaceListing.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        submission: { is: expect.objectContaining({ NOT: { envDependencies: { array_contains: [{ required: true }] } } }) },
      }),
    }))

    const required = await app.inject({ method: 'GET', url: '/api/marketplace?apiKey=required&query=helper' })
    expect(required.statusCode).toBe(200)
    expect(mockDb.marketplaceListing.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        submission: {
          is: expect.objectContaining({
            envDependencies: { array_contains: [{ required: true }] },
            OR: expect.arrayContaining([{ labels: { array_contains: ['helper'] } }]),
          }),
        },
      }),
    }))

    const invalid = await app.inject({ method: 'GET', url: '/api/marketplace?apiKey=maybe' })
    expect(invalid.statusCode).toBe(400)
  })

  it('returns all store badges in their fixed order and sorts 最近上新 by first publication', async () => {
    const recent = new Date(Date.now() - 2 * 86_400_000)
    mockDb.marketplaceListing.count.mockResolvedValue(1)
    mockDb.marketplaceListing.findMany.mockImplementation(async (args: { select?: unknown }) => (
      args.select ? [{ skillId: SKILL_ID, firstPublishedAt: recent }] : [listing({ featured: true, original: true, firstPublishedAt: recent })]
    ))
    mockDb.marketplaceListingDailyMetric.groupBy.mockResolvedValue([{ listingSkillId: SKILL_ID, _sum: { downloads: 6, installs: 5 } }])
    app = await buildApp()

    const response = await app.inject({ method: 'GET', url: '/api/marketplace?sort=latest' })

    expect(response.json().items[0]).toMatchObject({ badges: ['featured', 'original', 'hot', 'new'], firstPublishedAt: recent.toISOString() })
    expect(mockDb.marketplaceListing.findMany).toHaveBeenCalledWith(expect.objectContaining({
      orderBy: [{ firstPublishedAt: 'desc' }, { skillId: 'asc' }],
    }))
  })

  it('exposes the original mark on catalog items', async () => {
    mockDb.marketplaceListing.count.mockResolvedValue(1)
    mockDb.marketplaceListing.findMany.mockResolvedValue([listing({ original: true })])
    app = await buildApp()
    const response = await app.inject({ method: 'GET', url: '/api/marketplace' })
    expect(response.json().items[0]).toMatchObject({ id: SKILL_ID, original: true })
    expect(response.json().items[0]).not.toHaveProperty('trend')
  })

  it('ranks sort=rising by recent installs and pages without repeating listings', async () => {
    const ids = ['a', 'b', 'c', 'd'].map((letter) => `${letter.repeat(8)}-0000-4000-8000-000000000000`)
    const published = (day: number): Date => new Date(Date.UTC(2026, 9, day))
    mockDb.marketplaceListing.findMany.mockImplementation(async (args: { select?: unknown; where: { skillId?: { in: string[] } } }) => {
      if (args.select) {
        return [
          { skillId: ids[0], publishedAt: published(1) },
          { skillId: ids[1], publishedAt: published(2) },
          { skillId: ids[2], publishedAt: published(9) },
          { skillId: ids[3], publishedAt: published(3) },
        ]
      }
      return (args.where.skillId?.in ?? []).map((skillId) => listing({ skillId }))
    })
    const today = storeDayValue(storeDay(new Date())).getTime()
    const activity = (listingSkillId: string, downloads: number, installs: number) => ({ listingSkillId, _sum: { downloads, installs } })
    mockDb.marketplaceListingDailyMetric.groupBy.mockImplementation(async (args: { where: { day: { lte: Date } } }) => (
      args.where.day.lte.getTime() === today
        ? [activity(ids[1], 2, 4), activity(ids[3], 0, 2)]
        : [activity(ids[1], 1, 2)]
    ))
    app = await buildApp()

    const first = await app.inject({ method: 'GET', url: '/api/marketplace?sort=rising&pageSize=2' })
    const second = await app.inject({ method: 'GET', url: '/api/marketplace?sort=rising&pageSize=2&page=2' })

    expect(first.statusCode).toBe(200)
    expect(first.json()).toMatchObject({ total: 4, page: 1 })
    expect(first.json().items.map((item: { id: string }) => item.id)).toEqual([ids[1], ids[3]])
    expect(first.json().items[0].trend).toEqual({ recentInstalls: 6, previousInstalls: 3, growthPercent: 100 })
    expect(first.json().items[1].trend).toEqual({ recentInstalls: 2, previousInstalls: 0, growthPercent: null })
    expect(second.json().items.map((item: { id: string }) => item.id)).toEqual([ids[2], ids[0]])
    expect(mockDb.marketplaceListing.count).not.toHaveBeenCalled()
  })

  it('caps offset pagination and rate limits public catalog reads per client IP', async () => {
    app = await buildApp()

    const excessivePage = await app.inject({
      method: 'GET',
      url: `/api/marketplace?page=${MARKETPLACE_ABUSE_LIMITS.maxCatalogPage + 1}`,
    })
    expect(excessivePage.statusCode).toBe(400)

    for (let index = 1; index < MARKETPLACE_ABUSE_LIMITS.publicReadsPerMinute; index += 1) {
      const response = await app.inject({ method: 'GET', url: '/api/marketplace' })
      expect(response.statusCode).toBe(200)
    }
    const limited = await app.inject({ method: 'GET', url: '/api/marketplace' })
    expect(limited.statusCode).toBe(429)
    expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0)
  })

  it('serves a public detail snapshot without authentication', async () => {
    mockDb.marketplaceListing.findFirst.mockResolvedValue(listing())
    app = await buildApp()

    const response = await app.inject({ method: 'GET', url: `/api/marketplace/${SKILL_ID}` })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({
      id: SKILL_ID,
      skillMd: '# Marketplace Helper\n',
      envDependencies: [{ key: 'EXAMPLE_API_KEY', required: true }],
    })
    expect(mockDb.marketplaceListing.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        skillId: SKILL_ID,
        withdrawnAt: null,
        submission: { status: 'approved' },
      }),
    }))
  })

  it('validates a public package and increments its active Listing exactly once', async () => {
    const packageData = createStoredSkillZip()
    const packageSha256 = createHash('sha256').update(packageData).digest('hex')
    mockDb.marketplaceListing.findFirst.mockResolvedValue({
      ...listing(),
      submission: { id: SUBMISSION_ID, skillName: 'marketplace-helper' },
      version: { id: VERSION_ID, version: 'v1.2.0', packageData, packageSha256 },
    })
    app = await buildApp()

    const response = await app.inject({ method: 'GET', url: `/api/marketplace/${SKILL_ID}/package` })

    expect(response.statusCode).toBe(200)
    expect(response.rawPayload.equals(packageData)).toBe(true)
    expect(response.headers['content-type']).toBe('application/zip')
    expect(response.headers['x-skill-version']).toBe('v1.2.0')
    expect(response.headers['x-checksum-sha256']).toBe(packageSha256)
    expect(response.headers['cache-control']).toBe('no-store')
    expect(mockDb.marketplaceListing.updateMany).toHaveBeenCalledWith({
      where: { skillId: SKILL_ID, submissionId: SUBMISSION_ID, withdrawnAt: null },
      data: { downloadCount: { increment: 1 } },
    })
  })

  it('counts repeated anonymous package downloads only once per Skill and IP window', async () => {
    const packageData = createStoredSkillZip()
    const packageSha256 = createHash('sha256').update(packageData).digest('hex')
    mockDb.marketplaceListing.findFirst.mockResolvedValue({
      ...listing(),
      submission: { id: SUBMISSION_ID, skillName: 'marketplace-helper' },
      version: { id: VERSION_ID, version: 'v1.2.0', packageData, packageSha256 },
    })
    app = await buildApp()

    const first = await app.inject({ method: 'GET', url: `/api/marketplace/${SKILL_ID}/package` })
    const repeated = await app.inject({ method: 'GET', url: `/api/marketplace/${SKILL_ID}/package` })

    expect(first.statusCode).toBe(200)
    expect(repeated.statusCode).toBe(200)
    expect(mockDb.marketplaceListing.updateMany).toHaveBeenCalledTimes(1)
    // Today's counter behind 热门 moves with the running total, once.
    expect(mockDb.marketplaceListingDailyMetric.upsert).toHaveBeenCalledTimes(1)
    expect(mockDb.marketplaceListingDailyMetric.upsert).toHaveBeenCalledWith({
      where: { listingSkillId_day: { listingSkillId: SKILL_ID, day: storeDayValue(storeDay(new Date())) } },
      create: { listingSkillId: SKILL_ID, day: storeDayValue(storeDay(new Date())), downloads: 1 },
      update: { downloads: { increment: 1 } },
    })
  })

  it('does not write a daily counter when the counted listing is gone', async () => {
    const packageData = createStoredSkillZip()
    const packageSha256 = createHash('sha256').update(packageData).digest('hex')
    mockDb.marketplaceListing.findFirst.mockResolvedValue({
      ...listing(),
      submission: { id: SUBMISSION_ID, skillName: 'marketplace-helper' },
      version: { id: VERSION_ID, version: 'v1.2.0', packageData, packageSha256 },
    })
    mockDb.marketplaceListing.updateMany.mockResolvedValue({ count: 0 })
    app = await buildApp()

    const response = await app.inject({ method: 'GET', url: `/api/marketplace/${SKILL_ID}/package` })

    expect(response.statusCode).toBe(404)
    expect(mockDb.marketplaceListingDailyMetric.upsert).not.toHaveBeenCalled()
  })

  it('does not count or return a Marketplace package containing a Google API key', async () => {
    const googleApiKey = `AIza${'A'.repeat(35)}`
    const packageData = createStoredSkillZip(
      `# Unsafe Skill\n${googleApiKey}\n`
    )
    mockDb.marketplaceListing.findFirst.mockResolvedValue({
      ...listing(),
      submission: { id: SUBMISSION_ID, skillName: 'marketplace-helper' },
      version: {
        id: VERSION_ID,
        version: 'v1.2.0',
        packageData,
        packageSha256: createHash('sha256').update(packageData).digest('hex'),
      },
    })
    app = await buildApp()

    const response = await app.inject({ method: 'GET', url: `/api/marketplace/${SKILL_ID}/package` })

    expect(response.statusCode).toBe(409)
    expect(mockDb.marketplaceListing.updateMany).not.toHaveBeenCalled()
  })

  it('rate limits anonymous package downloads per client IP', async () => {
    const packageData = createStoredSkillZip()
    const packageSha256 = createHash('sha256').update(packageData).digest('hex')
    mockConfig.MARKETPLACE_DOWNLOADS_PER_MINUTE = 1
    mockDb.marketplaceListing.findFirst.mockResolvedValue({
      ...listing(),
      submission: { id: SUBMISSION_ID, skillName: 'marketplace-helper' },
      version: { id: VERSION_ID, version: 'v1.2.0', packageData, packageSha256 },
    })
    app = await buildApp()

    expect((await app.inject({ method: 'GET', url: `/api/marketplace/${SKILL_ID}/package` })).statusCode).toBe(200)
    const limited = await app.inject({ method: 'GET', url: `/api/marketplace/${SKILL_ID}/package` })

    expect(limited.statusCode).toBe(429)
    expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0)
    expect(mockDb.marketplaceListing.findFirst).toHaveBeenCalledTimes(1)
    expect(mockDb.marketplaceListing.updateMany).toHaveBeenCalledTimes(1)
  })

  it('rechecks package bytes on cache hits and never serves a changed approved version', async () => {
    const packageData = createStoredSkillZip()
    const packageSha256 = createHash('sha256').update(packageData).digest('hex')
    const approvedListing = {
      ...listing(),
      submission: { id: SUBMISSION_ID, skillName: 'marketplace-helper' },
      version: { id: VERSION_ID, version: 'v1.2.0', packageData, packageSha256 },
    }
    mockDb.marketplaceListing.findFirst
      .mockResolvedValueOnce(approvedListing)
      .mockResolvedValueOnce({
        ...approvedListing,
        version: {
          ...approvedListing.version,
          packageData: Buffer.concat([packageData, Buffer.from('tampered')]),
        },
      })
    app = await buildApp()

    const first = await app.inject({ method: 'GET', url: `/api/marketplace/${SKILL_ID}/package` })
    const changed = await app.inject({ method: 'GET', url: `/api/marketplace/${SKILL_ID}/package` })

    expect(first.statusCode).toBe(200)
    expect(changed.statusCode).toBe(409)
    expect(mockDb.marketplaceListing.updateMany).toHaveBeenCalledTimes(1)
  })

  it('returns the active Listing and latest submission independently for an author', async () => {
    const latest = submission({
      id: '55555555-5555-4555-8555-555555555555',
      status: 'under_review',
      version: publicVersion({ id: '66666666-6666-4666-8666-666666666666', version: 'v1.3.0' }),
    })
    mockDb.skill.findMany.mockResolvedValue([{
      id: SKILL_ID,
      name: 'marketplace-helper',
      displayName: 'Marketplace 助手',
      currentVersion: 'v1.3.0',
      updatedAt: NOW,
      marketplaceListing: {
        ...listing(),
        version: { id: VERSION_ID, version: 'v1.2.0' },
      },
      marketplaceSubmissions: [latest],
    }])
    app = await buildApp()

    const response = await app.inject({ method: 'GET', url: '/api/marketplace/mine' })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({
      items: [{
        skillId: SKILL_ID,
        skill: { currentVersion: 'v1.3.0' },
        listing: { submissionId: SUBMISSION_ID, versionId: VERSION_ID, version: 'v1.2.0' },
        latestSubmission: { status: 'under_review', version: { version: 'v1.3.0' } },
      }],
    })
  })

  it.each([false, true])('submits an exact snapshot unless its package is catalog-acquired (%s)', async (catalog) => {
    const packageData = createStoredSkillZip()
    const packageSha256 = createHash('sha256').update(packageData).digest('hex')
    mockDb.skill.findUnique.mockResolvedValue({
      id: SKILL_ID,
      name: 'mutable-new-name',
      displayName: '尚未发布的新资料',
      description: '不应进入旧版本提交',
      category: '内容与创作',
      labels: ['内容写作'],
      triggerScenarios: ['写新内容'],
      compatibleAgents: ['claude'],
      envDependencies: [],
      authorId: USER_ID,
      deletedAt: null,
      versions: [{
        id: VERSION_ID,
        skillId: SKILL_ID,
        version: 'v1.2.0',
        changelog: null,
        packageData,
        packageSha256,
        packageSize: packageData.length,
        profileSnapshotVersion: 1,
        skillName: 'marketplace-helper',
        displayName: 'Marketplace 助手',
        description: '安装助手',
        category: '开发与工程',
        labels: ['Skill管理'],
        triggerScenarios: ['安装 Skill'],
        compatibleAgents: ['codex'],
        envDependencies: [{ key: 'EXAMPLE_API_KEY', required: true }],
        sourceContent: '# Redacted Marketplace Helper\n',
        createdAt: NOW,
      }],
    })
    mockDb.marketplaceListing.findFirst.mockResolvedValue({ skillId: SKILL_ID })
    mockDb.marketplaceSubmission.create.mockResolvedValue(submission())
    if (catalog) mockDb.cardGrant.findUnique.mockResolvedValue({ reason: 'catalog' })
    app = await buildApp()

    const response = await app.inject({
      method: 'POST',
      url: `/api/marketplace/skills/${SKILL_ID}/submissions`,
      payload: { versionId: VERSION_ID, note: '请审核这个固定版本' },
    })

    if (catalog) {
      expect(response.statusCode).toBe(409); expect(response.json().code).toBe('CATALOG_NOT_AUTHORED')
      expect(mockDb.marketplaceSubmission.create).not.toHaveBeenCalled()
      expect(mockMutationLocks.lockUserMutation.mock.invocationCallOrder[0]).toBeLessThan(mockMutationLocks.lockSkillMutation.mock.invocationCallOrder[0]!)
      return
    }

    expect(response.statusCode).toBe(201)
    expect(mockMutationLocks.lockSkillMutation).toHaveBeenCalledWith(mockDb, SKILL_ID)
    expect(mockDb.marketplaceSubmission.create).toHaveBeenCalledWith({
      data: {
        skillId: SKILL_ID,
        versionId: VERSION_ID,
        submittedById: USER_ID,
        status: 'submitted',
        submitterNote: '请审核这个固定版本',
        skillName: 'marketplace-helper',
        displayName: 'Marketplace 助手',
        description: '安装助手',
        category: '开发与工程',
        labels: ['Skill管理'],
        triggerScenarios: ['安装 Skill'],
        compatibleAgents: ['codex'],
        envDependencies: [{ key: 'EXAMPLE_API_KEY', required: true }],
        sourceContent: '# Redacted Marketplace Helper\n',
      },
      include: expect.any(Object),
    })
    expect(mockDb.skill.update).toHaveBeenCalledWith({
      where: { id: SKILL_ID },
      data: { marketplaceStatus: 'approved' },
    })
  })

  it.each([
    ['version changelog', {
      changelog: `Rotate to sk_live_${'A'.repeat(24)}`,
    }],
    ['environment dependency description', {
      envDependencies: [{
        key: 'PAYMENT_API_KEY',
        description: `Use GOCSPX-${'A'.repeat(24)}`,
        required: true,
      }],
    }],
  ])('rejects sensitive public metadata in %s before opening a transaction', async (_field, overrides) => {
    mockDb.skill.findUnique.mockResolvedValue(ownedSubmissionSkill(
      submissionCandidateVersion(overrides)
    ))
    app = await buildApp()

    const response = await app.inject({
      method: 'POST',
      url: `/api/marketplace/skills/${SKILL_ID}/submissions`,
      payload: { versionId: VERSION_ID },
    })

    expect(response.statusCode).toBe(409)
    expect(response.json()).toMatchObject({
      message: 'The selected version contains sensitive public metadata',
    })
    expect(mockDb.$transaction).not.toHaveBeenCalled()
    expect(mockDb.marketplaceSubmission.create).not.toHaveBeenCalled()
  })

  it('rejects an unsafe package before opening the Marketplace transaction', async () => {
    const packageData = createStoredSkillZip(
      `# Unsafe Marketplace Skill\nsk_live_${'A'.repeat(24)}\n`
    )
    mockDb.skill.findUnique.mockResolvedValue(ownedSubmissionSkill(
      submissionCandidateVersion({
        packageData,
        packageSha256: createHash('sha256').update(packageData).digest('hex'),
        packageSize: packageData.length,
      })
    ))
    app = await buildApp()

    const response = await app.inject({
      method: 'POST',
      url: `/api/marketplace/skills/${SKILL_ID}/submissions`,
      payload: { versionId: VERSION_ID },
    })

    expect(response.statusCode).toBe(409)
    expect(mockDb.$transaction).not.toHaveBeenCalled()
  })

  it('caps Marketplace submission history per Skill', async () => {
    mockDb.skill.findUnique.mockResolvedValue(ownedSubmissionSkill())
    mockDb.marketplaceSubmission.count.mockResolvedValue(
      MARKETPLACE_ABUSE_LIMITS.maxSubmissionHistoryPerSkill
    )
    app = await buildApp()

    const response = await app.inject({
      method: 'POST',
      url: `/api/marketplace/skills/${SKILL_ID}/submissions`,
      payload: { versionId: VERSION_ID },
    })

    expect(response.statusCode).toBe(409)
    expect(response.json()).toMatchObject({
      message: 'This Skill has reached the Marketplace submission history limit',
    })
    expect(mockDb.marketplaceSubmission.create).not.toHaveBeenCalled()
  })

  it('rate limits repeated Marketplace submissions by author', async () => {
    mockDb.skill.findUnique.mockResolvedValue(ownedSubmissionSkill())
    mockDb.marketplaceSubmission.create.mockResolvedValue(submission())
    app = await buildApp()

    for (let index = 0; index < MARKETPLACE_ABUSE_LIMITS.submissionWritesPerHour; index += 1) {
      const response = await app.inject({
        method: 'POST',
        url: `/api/marketplace/skills/${SKILL_ID}/submissions`,
        payload: { versionId: VERSION_ID },
      })
      expect(response.statusCode).toBe(201)
    }
    const limited = await app.inject({
      method: 'POST',
      url: `/api/marketplace/skills/${SKILL_ID}/submissions`,
      payload: { versionId: VERSION_ID },
    })
    expect(limited.statusCode).toBe(429)
    expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0)
  })

  it('rejects a legacy version without a complete public Profile snapshot', async () => {
    const packageData = createStoredSkillZip()
    mockDb.skill.findUnique.mockResolvedValue({
      id: SKILL_ID,
      name: 'marketplace-helper',
      displayName: 'Mutable profile',
      authorId: USER_ID,
      deletedAt: null,
      versions: [{
        id: VERSION_ID,
        skillId: SKILL_ID,
        version: 'v1.1.0',
        changelog: null,
        packageData,
        packageSha256: createHash('sha256').update(packageData).digest('hex'),
        packageSize: packageData.length,
        profileSnapshotVersion: null,
        skillName: null,
        displayName: null,
        description: null,
        category: null,
        labels: null,
        triggerScenarios: null,
        compatibleAgents: null,
        envDependencies: null,
        sourceContent: '# Legacy snapshot\n',
        createdAt: NOW,
      }],
    })
    app = await buildApp()

    const response = await app.inject({
      method: 'POST',
      url: `/api/marketplace/skills/${SKILL_ID}/submissions`,
      payload: { versionId: VERSION_ID },
    })

    expect(response.statusCode).toBe(409)
    expect(response.json()).toMatchObject({
      message: 'The selected version has no complete public Profile snapshot; upload it again',
    })
    expect(mockDb.marketplaceSubmission.create).not.toHaveBeenCalled()
  })

  it('turns a raced duplicate active submission into a stable 409 response', async () => {
    const packageData = createStoredSkillZip()
    const packageSha256 = createHash('sha256').update(packageData).digest('hex')
    mockDb.skill.findUnique.mockResolvedValue({
      id: SKILL_ID,
      name: 'marketplace-helper',
      displayName: 'Marketplace 助手',
      description: null,
      category: null,
      labels: [],
      triggerScenarios: [],
      compatibleAgents: [],
      envDependencies: [],
      authorId: USER_ID,
      deletedAt: null,
      versions: [{
        id: VERSION_ID,
        skillId: SKILL_ID,
        version: 'v1.2.0',
        changelog: null,
        packageData,
        packageSha256,
        packageSize: packageData.length,
        profileSnapshotVersion: 1,
        skillName: 'marketplace-helper',
        displayName: 'Marketplace 助手',
        description: null,
        category: null,
        labels: [],
        triggerScenarios: [],
        compatibleAgents: [],
        envDependencies: [],
        sourceContent: '# Marketplace Helper\n',
        createdAt: NOW,
      }],
    })
    mockDb.marketplaceSubmission.create.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('duplicate active submission', {
        code: 'P2002',
        clientVersion: '5.22.0',
      })
    )
    app = await buildApp()

    const response = await app.inject({
      method: 'POST',
      url: `/api/marketplace/skills/${SKILL_ID}/submissions`,
      payload: { versionId: VERSION_ID },
    })

    expect(response.statusCode).toBe(409)
    expect(response.json()).toMatchObject({
      statusCode: 409,
      message: 'This Skill already has an active Marketplace submission',
    })
  })

  it('keeps an approved compatibility status when withdrawing a pending new release', async () => {
    mockDb.marketplaceSubmission.findUnique
      .mockResolvedValueOnce({ skillId: SKILL_ID })
      .mockResolvedValueOnce(submission({ status: 'submitted' }))
    mockDb.marketplaceSubmission.update.mockResolvedValue(submission({ status: 'withdrawn', withdrawnAt: NOW }))
    mockDb.marketplaceListing.findFirst.mockResolvedValue({ skillId: SKILL_ID })
    app = await buildApp()

    const response = await app.inject({
      method: 'POST',
      url: `/api/marketplace/submissions/${SUBMISSION_ID}/withdraw`,
    })

    expect(response.statusCode).toBe(200)
    expect(mockDb.skill.update).toHaveBeenCalledWith({
      where: { id: SKILL_ID },
      data: { marketplaceStatus: 'approved' },
    })
  })

  it('rate limits repeated Marketplace withdrawals by author', async () => {
    mockDb.marketplaceSubmission.findUnique.mockImplementation(async (args: {
      select?: { skillId?: boolean }
    }) => args.select?.skillId
      ? { skillId: SKILL_ID }
      : submission({ status: 'submitted' }))
    mockDb.marketplaceSubmission.update.mockResolvedValue(
      submission({ status: 'withdrawn', withdrawnAt: NOW })
    )
    app = await buildApp()

    for (let index = 0; index < MARKETPLACE_ABUSE_LIMITS.submissionWritesPerHour; index += 1) {
      const response = await app.inject({
        method: 'POST',
        url: `/api/marketplace/submissions/${SUBMISSION_ID}/withdraw`,
      })
      expect(response.statusCode).toBe(200)
    }
    const limited = await app.inject({
      method: 'POST',
      url: `/api/marketplace/submissions/${SUBMISSION_ID}/withdraw`,
    })
    expect(limited.statusCode).toBe(429)
    expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0)
  })

  it('unpublishes the active Listing without deleting a pending new submission', async () => {
    mockDb.skill.findUnique.mockResolvedValue({ id: SKILL_ID, authorId: USER_ID, deletedAt: null })
    mockDb.marketplaceSubmission.findFirst.mockResolvedValue({ status: 'under_review' })
    app = await buildApp()

    const response = await app.inject({ method: 'DELETE', url: `/api/marketplace/skills/${SKILL_ID}` })

    expect(response.statusCode).toBe(204)
    expect(mockDb.marketplaceListing.updateMany).toHaveBeenCalledWith({
      where: { skillId: SKILL_ID, withdrawnAt: null },
      data: { withdrawnAt: expect.any(Date), withdrawnBy: 'author', withdrawnReason: null },
    })
    // An earlier admin unlisting is re-attributed to the author so it cannot be restored by an admin.
    expect(mockDb.marketplaceListing.updateMany).toHaveBeenCalledWith({
      where: { skillId: SKILL_ID, withdrawnAt: { not: null }, withdrawnBy: 'admin' },
      data: { withdrawnBy: 'author', withdrawnReason: null },
    })
    expect(mockDb.skill.update).toHaveBeenCalledWith({
      where: { id: SKILL_ID },
      data: { visibility: 'private', marketplaceStatus: 'under_review' },
    })
  })

  it('requires the database-backed Marketplace admin role', async () => {
    app = await buildApp()
    const response = await app.inject({ method: 'GET', url: '/api/marketplace/admin/submissions' })
    expect(response.statusCode).toBe(403)
    expect(mockDb.marketplaceSubmission.findMany).not.toHaveBeenCalled()
  })

  it('forbids non-admin access to the immutable package inspection', async () => {
    app = await buildApp()
    const response = await app.inject({
      method: 'GET',
      url: `/api/marketplace/admin/submissions/${SUBMISSION_ID}/package-inspection`,
    })
    expect(response.statusCode).toBe(403)
    expect(mockDb.marketplaceSubmission.findUnique).not.toHaveBeenCalled()
  })

  it('inspects the exact submitted version and exposes scripts but never binary bytes', async () => {
    const script = '#!/bin/sh\nprintf ready\\n\n'
    const binary = Buffer.from([0, 1, 2, 3, 255, 137, 80, 78, 71])
    const packageData = createStoredZip([
      { name: 'SKILL.md', data: '# Marketplace Helper\n' },
      { name: 'scripts/verify.sh', data: script },
      { name: 'assets/icon.bin', data: binary },
    ])
    const packageSha256 = createHash('sha256').update(packageData).digest('hex')
    mockAuth.role = 'admin'
    mockDb.marketplaceSubmission.findUnique.mockResolvedValue({
      id: SUBMISSION_ID,
      versionId: VERSION_ID,
      version: {
        id: VERSION_ID,
        version: 'v1.2.0',
        packageData,
        packageSha256,
        packageSize: packageData.length,
      },
    })
    app = await buildApp()

    const response = await app.inject({
      method: 'GET',
      url: `/api/marketplace/admin/submissions/${SUBMISSION_ID}/package-inspection`,
    })

    expect(response.statusCode).toBe(200)
    expect(response.headers['cache-control']).toBe('no-store')
    expect(response.json()).toMatchObject({
      submissionId: SUBMISSION_ID,
      versionId: VERSION_ID,
      version: 'v1.2.0',
      packageSha256,
      packageSize: packageData.length,
      files: [
        { path: 'SKILL.md', kind: 'text', content: '# Marketplace Helper\n' },
        { path: 'scripts/verify.sh', kind: 'text', content: script },
        { path: 'assets/icon.bin', kind: 'binary', size: binary.length, content: null },
      ],
    })
    expect(response.body).not.toContain(binary.toString('base64'))
    expect(mockDb.marketplaceSubmission.findUnique).toHaveBeenCalledWith({
      where: { id: SUBMISSION_ID },
      select: expect.objectContaining({
        id: true,
        versionId: true,
        version: { select: expect.objectContaining({ id: true, packageData: true }) },
      }),
    })
  })

  it('cannot approve a package whose complete inspection exceeds the review limit', async () => {
    const packageData = createStoredZip([
      { name: 'SKILL.md', data: '# Marketplace Helper\n' },
      {
        name: 'references/too-large.txt',
        data: Buffer.alloc(SKILL_PACKAGE_REVIEW_LIMITS.maxReadableTextBytes, 0x61),
      },
    ])
    const packageSha256 = createHash('sha256').update(packageData).digest('hex')
    const version = {
      id: VERSION_ID,
      skillId: SKILL_ID,
      version: 'v1.2.0',
      changelog: '发布稳定版',
      packageData,
      packageSha256,
      packageSize: packageData.length,
    }
    mockAuth.role = 'admin'
    mockDb.marketplaceSubmission.findUnique.mockResolvedValueOnce({
      id: SUBMISSION_ID,
      versionId: VERSION_ID,
      version,
    })
    app = await buildApp()

    const inspection = await app.inject({
      method: 'GET',
      url: `/api/marketplace/admin/submissions/${SUBMISSION_ID}/package-inspection`,
    })
    expect(inspection.statusCode).toBe(413)

    mockDb.marketplaceSubmission.findUnique
      .mockResolvedValueOnce({ skillId: SKILL_ID })
      .mockResolvedValueOnce({
        ...submission({ status: 'under_review' }),
        version,
        skill: { id: SKILL_ID, displayName: 'Marketplace 助手', deletedAt: null },
      })

    const approval = await app.inject({
      method: 'POST',
      url: `/api/marketplace/admin/submissions/${SUBMISSION_ID}/approve`,
      payload: {},
    })

    expect(approval.statusCode).toBe(413)
    expect(mockDb.marketplaceSubmission.update).not.toHaveBeenCalled()
    expect(mockDb.marketplaceListing.upsert).not.toHaveBeenCalled()
    expect(mockDb.skill.update).not.toHaveBeenCalled()
    expect(mockDb.notification.create).not.toHaveBeenCalled()
  })

  it('fails closed when a submission version binding does not match', async () => {
    mockAuth.role = 'admin'
    mockDb.marketplaceSubmission.findUnique.mockResolvedValue({
      id: SUBMISSION_ID,
      versionId: VERSION_ID,
      version: {
        id: '66666666-6666-4666-8666-666666666666',
        version: 'v9.9.9',
        packageData: createStoredSkillZip(),
        packageSha256: null,
        packageSize: null,
      },
    })
    app = await buildApp()

    const response = await app.inject({
      method: 'GET',
      url: `/api/marketplace/admin/submissions/${SUBMISSION_ID}/package-inspection`,
    })

    expect(response.statusCode).toBe(409)
    expect(response.body).not.toContain('v9.9.9')
  })

  it('returns the review queue using the desktop item.skill and item.author contract', async () => {
    mockAuth.role = 'admin'
    mockDb.marketplaceSubmission.count.mockResolvedValue(151)
    mockDb.marketplaceSubmission.findMany.mockResolvedValue([{
      ...submission(),
      submittedBy: { id: USER_ID, displayName: 'Marketplace Author', avatarUrl: null },
    }])
    app = await buildApp()

    const response = await app.inject({
      method: 'GET',
      url: '/api/marketplace/admin/submissions?status=submitted',
    })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({
      items: [{
        id: SUBMISSION_ID,
        author: { id: USER_ID, displayName: 'Marketplace Author' },
        skill: {
          id: SKILL_ID,
          name: 'marketplace-helper',
          displayName: 'Marketplace 助手',
          currentVersion: 'v1.2.0',
        },
      }],
      total: 151,
      page: 1,
      pageSize: 50,
      totalPages: 4,
    })
    expect(mockDb.marketplaceSubmission.findMany).toHaveBeenCalledWith(expect.objectContaining({
      orderBy: [{ submittedAt: 'asc' }, { id: 'asc' }],
      skip: 0,
      take: 50,
    }))
  })

  it('paginates the admin review queue with a stable tie breaker', async () => {
    mockAuth.role = 'admin'
    mockDb.marketplaceSubmission.count.mockResolvedValue(75)
    app = await buildApp()

    const response = await app.inject({
      method: 'GET',
      url: '/api/marketplace/admin/submissions?status=approved&page=3&pageSize=25',
    })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({
      items: [],
      total: 75,
      page: 3,
      pageSize: 25,
      totalPages: 3,
    })
    expect(mockDb.marketplaceSubmission.findMany).toHaveBeenCalledWith(expect.objectContaining({
      orderBy: [{ submittedAt: 'asc' }, { id: 'asc' }],
      skip: 50,
      take: 25,
    }))
  })

  it('starts review while an older public Listing remains approved', async () => {
    mockAuth.role = 'admin'
    mockDb.marketplaceSubmission.findUnique
      .mockResolvedValueOnce({ skillId: SKILL_ID })
      .mockResolvedValueOnce({ ...submission(), skill: { deletedAt: null } })
    mockDb.marketplaceSubmission.update.mockResolvedValue(submission({
      status: 'under_review',
      reviewerId: ADMIN_ID,
      reviewStartedAt: NOW,
    }))
    mockDb.marketplaceListing.findFirst.mockResolvedValue({ skillId: SKILL_ID })
    app = await buildApp()

    const response = await app.inject({
      method: 'POST',
      url: `/api/marketplace/admin/submissions/${SUBMISSION_ID}/start`,
    })

    expect(response.statusCode).toBe(200)
    expect(mockDb.marketplaceSubmission.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: SUBMISSION_ID },
      data: expect.objectContaining({ status: 'under_review', reviewerId: ADMIN_ID }),
    }))
    expect(mockDb.skill.update).toHaveBeenCalledWith({
      where: { id: SKILL_ID },
      data: { marketplaceStatus: 'approved' },
    })
  })

  it('requires start-review before approval', async () => {
    mockAuth.role = 'admin'
    mockDb.marketplaceSubmission.findUnique
      .mockResolvedValueOnce({ skillId: SKILL_ID })
      .mockResolvedValueOnce({
        ...submission({ status: 'submitted' }),
        version: { ...publicVersion(), skillId: SKILL_ID, packageData: createStoredSkillZip() },
        skill: { id: SKILL_ID, displayName: 'Marketplace 助手', deletedAt: null },
      })
    app = await buildApp()

    const response = await app.inject({
      method: 'POST',
      url: `/api/marketplace/admin/submissions/${SUBMISSION_ID}/approve`,
      payload: {},
    })

    expect(response.statusCode).toBe(409)
    expect(mockDb.marketplaceListing.upsert).not.toHaveBeenCalled()
    expect(mockDb.notification.create).not.toHaveBeenCalled()
  })

  it('rechecks legacy pending submission metadata before approval', async () => {
    const packageData = createStoredSkillZip()
    const packageSha256 = createHash('sha256').update(packageData).digest('hex')
    mockAuth.role = 'admin'
    mockDb.marketplaceSubmission.findUnique
      .mockResolvedValueOnce({ skillId: SKILL_ID })
      .mockResolvedValueOnce({
        ...submission({ status: 'under_review' }),
        version: {
          id: VERSION_ID,
          skillId: SKILL_ID,
          version: 'v1.2.0',
          changelog: `Rotate to sk_live_${'A'.repeat(24)}`,
          packageData,
          packageSha256,
        },
        skill: { id: SKILL_ID, displayName: 'Marketplace 助手', deletedAt: null },
      })
    app = await buildApp()

    const response = await app.inject({
      method: 'POST',
      url: `/api/marketplace/admin/submissions/${SUBMISSION_ID}/approve`,
      payload: {},
    })

    expect(response.statusCode).toBe(409)
    expect(response.json()).toMatchObject({
      message: 'Submitted Skill contains sensitive public metadata',
    })
    expect(mockDb.marketplaceListing.upsert).not.toHaveBeenCalled()
    expect(mockDb.notification.create).not.toHaveBeenCalled()
  })

  it('atomically promotes the reviewed version and notifies its author', async () => {
    const packageData = createStoredSkillZip()
    const packageSha256 = createHash('sha256').update(packageData).digest('hex')
    mockAuth.role = 'admin'
    mockDb.marketplaceSubmission.findUnique
      .mockResolvedValueOnce({ skillId: SKILL_ID })
      .mockResolvedValueOnce({
        ...submission({ status: 'under_review' }),
        version: { id: VERSION_ID, skillId: SKILL_ID, version: 'v1.2.0', packageData, packageSha256 },
        skill: { id: SKILL_ID, displayName: 'Marketplace 助手', deletedAt: null },
      })
    mockDb.marketplaceSubmission.update.mockResolvedValue(submission({ status: 'approved', reviewedAt: NOW }))
    app = await buildApp()

    const response = await app.inject({
      method: 'POST',
      url: `/api/marketplace/admin/submissions/${SUBMISSION_ID}/approve`,
      payload: { note: '审核通过' },
    })

    expect(response.statusCode).toBe(200)
    expect(mockDb.marketplaceListing.upsert).toHaveBeenCalledWith({
      where: { skillId: SKILL_ID },
      create: expect.objectContaining({
        skillId: SKILL_ID,
        submissionId: SUBMISSION_ID,
        versionId: VERSION_ID,
        firstPublishedAt: expect.any(Date),
      }),
      update: expect.objectContaining({
        submissionId: SUBMISSION_ID,
        versionId: VERSION_ID,
        withdrawnAt: null,
      }),
    })
    // A new version never moves the first publication (新上架 / 最近上新).
    expect(mockDb.marketplaceListing.upsert.mock.calls[0]?.[0].update).not.toHaveProperty('firstPublishedAt')
    expect(mockDb.skill.update).toHaveBeenCalledWith({
      where: { id: SKILL_ID },
      data: { visibility: 'public', marketplaceStatus: 'approved' },
    })
    expect(mockDb.notification.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        userId: USER_ID,
        type: 'marketplace_approved',
        payload: expect.objectContaining({ submissionId: SUBMISSION_ID, version: 'v1.2.0' }),
      }),
    })
  })

  it('stores rejection as reviewNote, notifies the author, and keeps an old Listing public', async () => {
    mockAuth.role = 'admin'
    mockDb.marketplaceSubmission.findUnique
      .mockResolvedValueOnce({ skillId: SKILL_ID })
      .mockResolvedValueOnce({
        ...submission({ status: 'under_review' }),
        skill: { displayName: 'Marketplace 助手', deletedAt: null },
      })
    mockDb.marketplaceSubmission.update.mockResolvedValue(submission({
      status: 'rejected',
      reviewNote: '请补充安装说明',
      reviewedAt: NOW,
    }))
    mockDb.marketplaceListing.findFirst.mockResolvedValue({ skillId: SKILL_ID })
    app = await buildApp()

    const response = await app.inject({
      method: 'POST',
      url: `/api/marketplace/admin/submissions/${SUBMISSION_ID}/reject`,
      payload: { reviewNote: '请补充安装说明' },
    })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({ status: 'rejected', reviewNote: '请补充安装说明' })
    expect(mockDb.marketplaceSubmission.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: 'rejected', reviewNote: '请补充安装说明' }),
    }))
    expect(mockDb.skill.update).toHaveBeenCalledWith({
      where: { id: SKILL_ID },
      data: { marketplaceStatus: 'approved' },
    })
    expect(mockDb.notification.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        userId: USER_ID,
        type: 'marketplace_rejected',
        payload: expect.objectContaining({ reviewNote: '请补充安装说明' }),
      }),
    })
  })

  it('serializes competing approve/reject decisions so exactly one wins', async () => {
    const packageData = createStoredSkillZip()
    const packageSha256 = createHash('sha256').update(packageData).digest('hex')
    mockAuth.role = 'admin'
    let status = 'under_review'
    let transactionTail = Promise.resolve()
    mockDb.$transaction.mockImplementation(async (
      callback: (transaction: typeof mockDb) => Promise<unknown>
    ): Promise<unknown> => {
      const previous = transactionTail
      let release = (): void => undefined
      transactionTail = new Promise<void>((resolve) => { release = resolve })
      await previous
      try {
        return await callback(mockDb)
      } finally {
        release()
      }
    })
    mockDb.marketplaceSubmission.findUnique.mockImplementation(async (args: {
      select?: { skillId?: boolean }
    }) => {
      if (args.select?.skillId) return { skillId: SKILL_ID }
      return {
        ...submission({ status }),
        version: { id: VERSION_ID, skillId: SKILL_ID, version: 'v1.2.0', packageData, packageSha256 },
        skill: { id: SKILL_ID, displayName: 'Marketplace 助手', deletedAt: null },
      }
    })
    mockDb.marketplaceSubmission.update.mockImplementation(async ({ data }: {
      data: { status: string; reviewNote?: string }
    }) => {
      status = data.status
      return submission({ status, reviewNote: data.reviewNote ?? null, reviewedAt: NOW })
    })
    mockDb.marketplaceListing.findFirst.mockResolvedValue({ skillId: SKILL_ID })
    app = await buildApp()

    const [approved, rejected] = await Promise.all([
      app.inject({
        method: 'POST',
        url: `/api/marketplace/admin/submissions/${SUBMISSION_ID}/approve`,
        payload: {},
      }),
      app.inject({
        method: 'POST',
        url: `/api/marketplace/admin/submissions/${SUBMISSION_ID}/reject`,
        payload: { reason: '竞态退回' },
      }),
    ])

    expect([approved.statusCode, rejected.statusCode].sort()).toEqual([200, 409])
    expect(['approved', 'rejected']).toContain(status)
    expect(mockDb.marketplaceSubmission.update).toHaveBeenCalledTimes(1)
    expect(mockDb.notification.create).toHaveBeenCalledTimes(1)
    expect(mockMutationLocks.lockSkillMutation).toHaveBeenCalledTimes(2)
  })
})
