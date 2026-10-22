import { randomUUID } from 'node:crypto'
import Fastify, { type FastifyInstance } from 'fastify'
import sensible from '@fastify/sensible'
import jwt from '@fastify/jwt'
import { Prisma, PrismaClient } from '@prisma/client'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

const postgresUrl = process.env['SKILLHUB_PG_TEST_URL']
const describePostgres = postgresUrl ? describe : describe.skip

// #193: rising order, trending growth, store statistics, API Key filter and the
// original mark against the real schema, including the raw daily-install SQL.
describePostgres('store trends with real PostgreSQL', () => {
  let app: FastifyInstance
  let prisma: PrismaClient
  const adminId = randomUUID()
  const authorId = randomUUID()
  const otherAuthorId = randomUUID()
  const tag = `trend-${randomUUID().slice(0, 8)}`
  const ids = { steady: randomUUID(), rising: randomUUID(), keyed: randomUUID(), withdrawn: randomUUID() }
  let cookie: string
  let storeDay: (instant: Date) => string
  let storeDayValue: (day: string) => Date

  async function publish(skillId: string, owner: string, name: string, envDependencies: Prisma.InputJsonValue = []): Promise<void> {
    await prisma.skill.create({ data: { id: skillId, name, displayName: name, authorId: owner, versions: { create: { version: '0.1.0' } } } })
    const version = await prisma.skillVersion.findFirstOrThrow({ where: { skillId } })
    const submission = await prisma.marketplaceSubmission.create({ data: {
      skillId, versionId: version.id, submittedById: owner, status: 'approved',
      skillName: name, displayName: name, description: tag, sourceContent: `# ${name}`, envDependencies,
    } })
    await prisma.marketplaceListing.create({ data: { skillId, versionId: version.id, submissionId: submission.id } })
  }

  // Seeds the per-store-day counters that the routes read (written by counted downloads and installs).
  async function installs(skillId: string, daysAgo: number, count: number): Promise<void> {
    await prisma.marketplaceListingDailyMetric.create({ data: {
      listingSkillId: skillId,
      day: storeDayValue(storeDay(new Date(Date.now() - daysAgo * 86_400_000))),
      installs: count,
    } })
  }

  beforeAll(async () => {
    prisma = new PrismaClient({ datasources: { db: { url: postgresUrl } } })
    vi.doMock('../db.js', () => ({ db: prisma }))
    const [{ marketplaceRoutes }, { marketplaceExperienceRoutes }, trends] = await Promise.all([import('./marketplace.js'), import('./marketplace-experience.js'), import('../lib/marketplace-trends.js')])
    storeDay = trends.storeDay
    storeDayValue = trends.storeDayValue
    app = Fastify()
    await app.register(sensible)
    await app.register(jwt, { secret: 'store-trends-local-test-secret-only' })
    await app.register(marketplaceRoutes, { prefix: '/api/marketplace' })
    await app.register(marketplaceExperienceRoutes, { prefix: '/api/marketplace' })
    await app.ready()
    await prisma.user.createMany({ data: [
      { id: adminId, email: `${adminId}@example.test`, displayName: 'Admin', marketplaceRole: 'admin' },
      { id: authorId, email: `${authorId}@example.test`, displayName: 'Author' },
      { id: otherAuthorId, email: `${otherAuthorId}@example.test`, displayName: 'Other' },
    ] })
    await publish(ids.steady, authorId, `${tag}-steady`)
    await publish(ids.rising, authorId, `${tag}-rising`)
    await publish(ids.keyed, otherAuthorId, `${tag}-keyed`, [{ key: 'TREND_API_KEY', required: true }])
    await publish(ids.withdrawn, otherAuthorId, `${tag}-withdrawn`)
    await prisma.marketplaceListing.update({ where: { skillId: ids.withdrawn }, data: { withdrawnAt: new Date() } })
    // steady: 4 yesterday vs 4 the week before; rising: 6 today vs 2; withdrawn activity never counts.
    await installs(ids.steady, 1, 4)
    await installs(ids.steady, 8, 4)
    await installs(ids.rising, 0, 6)
    await installs(ids.rising, 8, 2)
    await installs(ids.withdrawn, 0, 50)
    cookie = `skillhub_admin_session=${app.jwt.sign({ sub: adminId, ver: 0, webAdmin: true, purpose: 'web-admin' })}`
  })

  afterAll(async () => {
    await app?.close()
    await prisma?.skill.deleteMany({ where: { id: { in: Object.values(ids) } } })
    await prisma?.user.deleteMany({ where: { id: { in: [adminId, authorId, otherAuthorId] } } })
    await prisma?.$disconnect()
    vi.doUnmock('../db.js')
  })

  it('ranks, filters, counts and marks listings from real rows', async () => {
    const rising = (await app.inject(`/api/marketplace?query=${tag}&sort=rising`)).json()
    expect(rising.total).toBe(3)
    expect(rising.items.map((item: { id: string }) => item.id)).toEqual([ids.rising, ids.steady, ids.keyed])
    expect(rising.items[0].trend).toEqual({ recentInstalls: 6, previousInstalls: 2, growthPercent: 200 })
    expect(rising.items[1].trend).toEqual({ recentInstalls: 4, previousInstalls: 4, growthPercent: 0 })
    const secondPage = (await app.inject(`/api/marketplace?query=${tag}&sort=rising&pageSize=2&page=2`)).json()
    expect(secondPage.items.map((item: { id: string }) => item.id)).toEqual([ids.keyed])

    const keyed = (await app.inject(`/api/marketplace?query=${tag}&apiKey=required`)).json()
    expect(keyed.items.map((item: { id: string }) => item.id)).toEqual([ids.keyed])
    const keyless = (await app.inject(`/api/marketplace?query=${tag}&apiKey=none`)).json()
    expect(keyless.items.map((item: { id: string }) => item.id).sort()).toEqual([ids.steady, ids.rising].sort())

    const day = (await app.inject('/api/marketplace/trending?range=day&limit=20')).json()
    const ours = day.items.filter((item: { listingId: string }) => Object.values(ids).includes(item.listingId))
    expect(ours[0]).toMatchObject({ listingId: ids.rising, trend: { recentInstalls: 6, previousInstalls: 0, growthPercent: null } })
    expect(ours.map((item: { listingId: string }) => item.listingId)).not.toContain(ids.withdrawn)

    const stats = (await app.inject('/api/marketplace/stats')).json()
    expect(stats.totalSkills).toBeGreaterThanOrEqual(3)
    expect(stats.dailyInstalls).toHaveLength(7)
    expect(stats.dailyInstalls.reduce((sum: number, value: number) => sum + value, 0)).toBeGreaterThanOrEqual(6)
    expect(stats.weeklyNewSkills).toHaveLength(8)
    expect(stats.activeAuthors).toBeGreaterThanOrEqual(2)
    expect(stats.newThisWeek).toBeGreaterThanOrEqual(3)

    expect((await app.inject({ method: 'PATCH', url: `/api/marketplace/admin/listings/${ids.keyed}/editorial`, payload: { original: true } })).statusCode).toBe(401)
    const marked = await app.inject({ method: 'PATCH', url: `/api/marketplace/admin/listings/${ids.keyed}/editorial`, headers: { cookie }, payload: { original: true } })
    expect(marked.statusCode).toBe(200)
    expect(marked.json()).toMatchObject({ listingId: ids.keyed, original: true, featured: false })
    expect((await app.inject(`/api/marketplace/${ids.keyed}`)).json()).toMatchObject({ original: true })
  })
})
