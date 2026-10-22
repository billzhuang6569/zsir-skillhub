import { createHash, randomUUID } from 'node:crypto'
import Fastify, { type FastifyInstance } from 'fastify'
import sensible from '@fastify/sensible'
import jwt from '@fastify/jwt'
import { PrismaClient } from '@prisma/client'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

const postgresUrl = process.env['SKILLHUB_PG_TEST_URL']
const describePostgres = postgresUrl ? describe : describe.skip

// #197: store badges against the real schema and real routes — first publication,
// per-day counters written by counted downloads and installs, and the badge order.
describePostgres('store badges with real PostgreSQL', () => {
  let app: FastifyInstance
  let prisma: PrismaClient
  let resetHot: () => void
  let storeDayValue: (day: string) => Date
  let storeDay: (instant: Date) => string
  const adminId = randomUUID()
  const authorId = randomUUID()
  const skillId = randomUUID()
  let cookie: string
  // A minimal ZIP containing only SKILL.md (same fixture as the editorial PG test).
  const packageData = Buffer.from('UEsDBBQAAAAAAIKwQV26Df4KEQAAABEAAAAIAAAAU0tJTEwubWQjIEVkaXRvcmlhbCB0ZXN0ClBLAQIUAxQAAAAAAIKwQV26Df4KEQAAABEAAAAIAAAAAAAAAAAAAACAAQAAAABTS0lMTC5tZFBLBQYAAAAAAQABADYAAAA3AAAAAAA=', 'base64')
  const packageSha256 = createHash('sha256').update(packageData).digest('hex')

  async function approveVersion(versionName: string): Promise<void> {
    const version = await prisma.skillVersion.create({ data: { skillId, version: versionName, packageData, packageSha256, packageSize: packageData.length } })
    const submission = await prisma.marketplaceSubmission.create({ data: {
      skillId, versionId: version.id, submittedById: authorId, status: 'under_review',
      skillName: 'badges-test', displayName: 'Badges test', sourceContent: '# Badges test',
    } })
    const response = await app.inject({
      method: 'POST',
      url: `/api/marketplace/admin/submissions/${submission.id}/approve`,
      headers: { cookie },
      payload: { expectedVersionId: version.id, expectedPackageSha256: packageSha256 },
    })
    expect(response.statusCode).toBe(200)
  }

  async function badges(): Promise<string[]> {
    resetHot()
    return (await app.inject(`/api/marketplace/${skillId}`)).json().badges as string[]
  }

  async function todayMetric(): Promise<{ downloads: number; installs: number } | null> {
    return prisma.marketplaceListingDailyMetric.findUnique({
      where: { listingSkillId_day: { listingSkillId: skillId, day: storeDayValue(storeDay(new Date())) } },
      select: { downloads: true, installs: true },
    })
  }

  beforeAll(async () => {
    prisma = new PrismaClient({ datasources: { db: { url: postgresUrl } } })
    vi.doMock('../db.js', () => ({ db: prisma }))
    const [{ marketplaceRoutes }, { marketplaceExperienceRoutes }, badgesLib, trendsLib] = await Promise.all([
      import('./marketplace.js'),
      import('./marketplace-experience.js'),
      import('../lib/marketplace-badges.js'),
      import('../lib/marketplace-trends.js'),
    ])
    resetHot = badgesLib.resetMarketplaceHotCache
    storeDayValue = trendsLib.storeDayValue
    storeDay = trendsLib.storeDay
    app = Fastify()
    await app.register(sensible)
    await app.register(jwt, { secret: 'badges-local-test-secret-only' })
    await app.register(marketplaceRoutes, { prefix: '/api/marketplace' })
    await app.register(marketplaceExperienceRoutes, { prefix: '/api/marketplace' })
    await app.ready()
    await prisma.user.createMany({ data: [
      { id: adminId, email: `${adminId}@example.test`, displayName: 'Admin', marketplaceRole: 'admin' },
      { id: authorId, email: `${authorId}@example.test`, displayName: 'Uploader' },
    ] })
    await prisma.skill.create({ data: { id: skillId, name: 'badges-test', displayName: 'Badges test', authorId } })
    cookie = `skillhub_admin_session=${app.jwt.sign({ sub: adminId, ver: 0, webAdmin: true, purpose: 'web-admin' })}`
  })

  afterAll(async () => {
    await app?.close()
    await prisma?.skill.deleteMany({ where: { id: skillId } })
    await prisma?.user.deleteMany({ where: { id: { in: [adminId, authorId] } } })
    await prisma?.$disconnect()
    vi.doUnmock('../db.js')
  })

  it('keeps the first publication, counts real downloads and installs, and orders the badges', async () => {
    await approveVersion('0.1.0')
    const first = await prisma.marketplaceListing.findUniqueOrThrow({ where: { skillId } })
    expect(first.firstPublishedAt.getTime()).toBe(first.publishedAt.getTime())
    expect(await badges()).toEqual(['new'])

    // An update 20 days later is not 新上架; the first publication stays put.
    const twentyDaysAgo = new Date(Date.now() - 20 * 86_400_000)
    await prisma.marketplaceListing.update({ where: { skillId }, data: { firstPublishedAt: twentyDaysAgo } })
    await approveVersion('0.2.0')
    const updated = await prisma.marketplaceListing.findUniqueOrThrow({ where: { skillId } })
    expect(updated.firstPublishedAt).toEqual(twentyDaysAgo)
    expect(updated.publishedAt.getTime()).toBeGreaterThan(twentyDaysAgo.getTime())
    expect(await badges()).toEqual([])

    // A counted ZIP download writes today's row once per IP window.
    expect((await app.inject(`/api/marketplace/${skillId}/package`)).statusCode).toBe(200)
    expect((await app.inject(`/api/marketplace/${skillId}/package`)).statusCode).toBe(200)
    expect(await todayMetric()).toEqual({ downloads: 1, installs: 0 })

    // An install intent counts once; replaying its idempotency key does not.
    const intent = { idempotencyKey: `badges:${randomUUID()}`, clientId: 'badges-device-1', source: 'web' }
    expect((await app.inject({ method: 'POST', url: `/api/marketplace/${skillId}/install-intents`, payload: intent })).statusCode).toBe(201)
    expect((await app.inject({ method: 'POST', url: `/api/marketplace/${skillId}/install-intents`, payload: intent })).statusCode).toBe(200)
    expect(await todayMetric()).toEqual({ downloads: 1, installs: 1 })

    // 10 activity points in the last 7 store days make it 热门 (it is within the slots in a small store).
    await prisma.marketplaceListingDailyMetric.create({ data: {
      listingSkillId: skillId,
      day: storeDayValue(storeDay(new Date(Date.now() - 3 * 86_400_000))),
      downloads: 5,
      installs: 3,
    } })
    expect(await badges()).toEqual(['hot'])

    const patch = await app.inject({ method: 'PATCH', url: `/api/marketplace/admin/listings/${skillId}/editorial`, headers: { cookie }, payload: { featured: true, original: true } })
    expect(patch.statusCode).toBe(200)
    expect(await badges()).toEqual(['featured', 'original', 'hot'])

    await prisma.marketplaceListing.update({ where: { skillId }, data: { withdrawnAt: new Date() } })
    resetHot()
    const hotAfterWithdrawal = (await app.inject('/api/marketplace/trending?limit=20')).json().items as { listingId: string }[]
    expect(hotAfterWithdrawal.map((item) => item.listingId)).not.toContain(skillId)
  })
})
