import { createHash, randomUUID } from 'node:crypto'
import Fastify, { type FastifyInstance } from 'fastify'
import sensible from '@fastify/sensible'
import jwt from '@fastify/jwt'
import { PrismaClient } from '@prisma/client'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

const postgresUrl = process.env['SKILLHUB_PG_TEST_URL']
const describePostgres = postgresUrl ? describe : describe.skip

describePostgres('editorial writes with real PostgreSQL and authentication', () => {
  let app: FastifyInstance
  let prisma: PrismaClient
  const adminId = randomUUID()
  const userId = randomUUID()
  const skillId = randomUUID()
  let cookie: string
  let ordinaryBearer: string
  const path = `/api/marketplace/admin/listings/${skillId}/editorial`

  beforeAll(async () => {
    prisma = new PrismaClient({ datasources: { db: { url: postgresUrl } } })
    vi.doMock('../db.js', () => ({ db: prisma }))
    const [{ marketplaceRoutes }, { marketplaceExperienceRoutes }] = await Promise.all([import('./marketplace.js'), import('./marketplace-experience.js')])
    app = Fastify()
    await app.register(sensible)
    await app.register(jwt, { secret: 'editorial-local-test-secret-only' })
    await app.register(marketplaceRoutes, { prefix: '/api/marketplace' })
    await app.register(marketplaceExperienceRoutes, { prefix: '/api/marketplace' })
    await app.ready()
    await prisma.user.createMany({ data: [
      { id: adminId, email: `${adminId}@example.test`, displayName: 'Admin', marketplaceRole: 'admin' },
      { id: userId, email: `${userId}@example.test`, displayName: 'Author' },
    ] })
    await prisma.skill.create({ data: { id: skillId, name: 'editorial-test', displayName: 'Editorial test', authorId: userId, labels: ['Profile'], versions: { create: { version: 'v1', labels: ['Snapshot'] } } } })
    const version = await prisma.skillVersion.findFirstOrThrow({ where: { skillId } })
    const submission = await prisma.marketplaceSubmission.create({ data: { skillId, versionId: version.id, submittedById: userId, skillName: 'editorial-test', displayName: 'Editorial test', sourceContent: 'Test', labels: ['Approved'], status: 'approved' } })
    await prisma.marketplaceListing.create({ data: { skillId, versionId: version.id, submissionId: submission.id } })
    cookie = `skillhub_admin_session=${app.jwt.sign({ sub: adminId, ver: 0, webAdmin: true, purpose: 'web-admin' })}`
    ordinaryBearer = `Bearer ${app.jwt.sign({ sub: userId, ver: 0, purpose: 'product' })}`
  })

  afterAll(async () => {
    await app?.close()
    await prisma?.skill.deleteMany({ where: { id: skillId } })
    await prisma?.user.deleteMany({ where: { id: { in: [adminId, userId] } } })
    await prisma?.$disconnect()
    vi.doUnmock('../db.js')
  })

  it('enforces auth, independent writes, conflict detection, filtering and visibility', async () => {
    const patch = (payload: Record<string, unknown>, headers: Record<string, string> = { cookie }) => app.inject({ method: 'PATCH', url: path, headers, payload })
    expect((await patch({ featured: true }, {})).statusCode).toBe(401)
    expect((await patch({ featured: true }, { authorization: ordinaryBearer })).statusCode).toBe(403)
    expect((await patch({ featured: true }, { cookie: `skillhub_admin_session=${ordinaryBearer.slice(7)}` })).statusCode).toBe(401)
    expect((await patch({ featured: true })).json()).toMatchObject({ featured: true, editorialLabels: [] })
    expect((await patch({ editorialLabels: [' AI工具 ', 'AI工具'], expectedEditorialLabels: [] })).json()).toMatchObject({ featured: true, editorialLabels: ['AI工具'] })
    const races = await Promise.all([
      patch({ editorialLabels: ['效率'], expectedEditorialLabels: ['AI工具'] }),
      patch({ editorialLabels: ['创作'], expectedEditorialLabels: ['AI工具'] }),
    ])
    expect(races.map(response => response.statusCode).sort()).toEqual([200, 409])
    const winner = races.find(response => response.statusCode === 200)!.json().editorialLabels as string[]
    expect((await patch({ editorialLabels: winner, expectedEditorialLabels: ['AI工具'] })).statusCode).toBe(200)
    expect((await patch({ featured: false })).json()).toMatchObject({ featured: false, editorialLabels: winner })
    const catalog = async (query: string): Promise<{ total: number; items: { id: string; featured: boolean; editorialLabels: string[] }[] }> => (await app.inject(`/api/marketplace?query=editorial-test&${query}`)).json()
    expect((await catalog('featured=true')).total).toBe(0)
    expect((await catalog('featured=false')).items).toEqual([expect.objectContaining({ id: skillId, featured: false, editorialLabels: winner })])
    await patch({ featured: true })
    expect((await catalog('featured=true&pageSize=1&page=1')).total).toBe(1)
    expect((await catalog('featured=true&pageSize=1&page=2')).items).toEqual([])
    expect((await app.inject('/api/marketplace?featured=invalid')).statusCode).toBe(400)
    const skill = await prisma.skill.findUniqueOrThrow({ where: { id: skillId }, include: { versions: true, marketplaceSubmissions: true } })
    expect(skill.labels).toEqual(['Profile'])
    expect(skill.versions[0]?.labels).toEqual(['Snapshot'])
    expect(skill.marketplaceSubmissions[0]?.labels).toEqual(['Approved'])
    // A minimal ZIP containing only SKILL.md, reviewed through the actual approval route.
    const packageData = Buffer.from('UEsDBBQAAAAAAIKwQV26Df4KEQAAABEAAAAIAAAAU0tJTEwubWQjIEVkaXRvcmlhbCB0ZXN0ClBLAQIUAxQAAAAAAIKwQV26Df4KEQAAABEAAAAIAAAAAAAAAAAAAACAAQAAAABTS0lMTC5tZFBLBQYAAAAAAQABADYAAAA3AAAAAAA=', 'base64')
    const packageSha256 = createHash('sha256').update(packageData).digest('hex')
    const approveVersion = async (versionName: string): Promise<void> => {
      const version = await prisma.skillVersion.create({ data: { skillId, version: versionName, packageData, packageSha256, packageSize: packageData.length } })
      const submission = await prisma.marketplaceSubmission.create({ data: { skillId, versionId: version.id, submittedById: userId, status: 'under_review', skillName: 'editorial-test', displayName: 'Editorial test', sourceContent: '# Editorial test' } })
      const response = await app.inject({ method: 'POST', url: `/api/marketplace/admin/submissions/${submission.id}/approve`, headers: { cookie }, payload: { expectedVersionId: version.id, expectedPackageSha256: packageSha256 } })
      expect(response.statusCode).toBe(200)
      expect(await prisma.marketplaceListing.findUniqueOrThrow({ where: { skillId } })).toMatchObject({ versionId: version.id, featured: true, editorialLabels: winner, withdrawnAt: null })
      expect((await prisma.skillVersion.findUniqueOrThrow({ where: { id: version.id } })).packageSha256).toBe(packageSha256)
    }
    await approveVersion('v2')
    await prisma.marketplaceListing.update({ where: { skillId }, data: { withdrawnAt: new Date() } })
    expect((await patch({ featured: false })).statusCode).toBe(404)
    expect((await catalog('featured=true')).total).toBe(0)
    await approveVersion('v3')
    expect((await catalog('featured=true')).items[0]).toMatchObject({ featured: true, editorialLabels: winner })
    await prisma.skill.update({ where: { id: skillId }, data: { deletedAt: new Date() } })
    expect((await patch({ featured: false })).statusCode).toBe(404)
    expect((await catalog('featured=true')).total).toBe(0)
  })
})
