import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Fastify, { type FastifyInstance } from 'fastify'
import jwt from '@fastify/jwt'
import sensible from '@fastify/sensible'
import { PrismaClient } from '@prisma/client'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

const postgresUrl = process.env.SKILLHUB_PG_TEST_URL
const packageData = Buffer.from('UEsDBBQAAAAAAIKwQV26Df4KEQAAABEAAAAIAAAAU0tJTEwubWQjIEVkaXRvcmlhbCB0ZXN0ClBLAQIUAxQAAAAAAIKwQV26Df4KEQAAABEAAAAIAAAAAAAAAAAAAACAAQAAAABTS0lMTC5tZFBLBQYAAAAAAQABADYAAAA3AAAAAAA=', 'base64')
const packageSha256 = createHash('sha256').update(packageData).digest('hex')

describe.skipIf(!postgresUrl)('catalog submissions with migrated PostgreSQL', () => {
  let app: FastifyInstance
  let prisma: PrismaClient
  let config: typeof import('../config.js')['config']
  let oldStorage: string
  let storage: string
  const userId = randomUUID()
  const otherId = randomUUID()
  let token: string
  const auth = (): { authorization: string } => ({ authorization: `Bearer ${token}` })
  const payload = (sourceSkillId = randomUUID()): Record<string, unknown> => ({
    clientOperationId: randomUUID(), sourceOrigin: 'https://private.example.test', sourceSkillId,
    name: `catalog-${randomUUID()}`, version: '0.1.0', skillMd: '# Editorial test\n',
    profile: { displayName: 'Catalog', description: 'Catalog submission test', category: '开发与工程', labels: ['测试验证', 'Skill管理'], triggerScenarios: [] },
    compatibleAgents: ['codex'], envDependencies: [], packageBase64: packageData.toString('base64'), packageSha256,
  })
  const submit = (body: Record<string, unknown>) => app.inject({ method: 'POST', url: '/api/marketplace/catalog-submissions', headers: auth(), payload: body })
  beforeAll(async () => {
    prisma = new PrismaClient({ datasources: { db: { url: postgresUrl } } })
    vi.doMock('../db.js', () => ({ db: prisma }))
    config = (await import('../config.js')).config
    oldStorage = config.SKILL_CARD_STORAGE_DIR
    storage = await mkdtemp(join(tmpdir(), 'skillhub-410-'))
    config.SKILL_CARD_STORAGE_DIR = storage
    await prisma.user.createMany({ data: [userId, otherId].map(id => ({ id, email: `${id}@example.test`, displayName: 'Catalog author' })) })
    await prisma.externalIdentity.create({ data: { userId, issuer: config.YITAN_OIDC_ISSUER, subject: userId, linkMethod: 'oidc_provisioned' } })
    app = Fastify()
    await app.register(jwt, { secret: config.JWT_SECRET })
    await app.register(sensible)
    await app.register((await import('./marketplace.js')).marketplaceRoutes, { prefix: '/api/marketplace' })
    await app.register((await import('./marketplace-experience.js')).marketplaceExperienceRoutes, { prefix: '/api/marketplace' })
    token = app.jwt.sign({ sub: userId, purpose: 'catalog', cver: 0, iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 3600 })
  })
  afterAll(async () => {
    await app?.close()
    if (prisma) {
      await prisma.skill.updateMany({ where: { authorId: { in: [userId, otherId] } }, data: { importVersionId: null } })
      await prisma.skill.deleteMany({ where: { authorId: { in: [userId, otherId] } } })
      await prisma.user.deleteMany({ where: { id: { in: [userId, otherId] } } })
      await prisma.$disconnect()
    }
    if (config) config.SKILL_CARD_STORAGE_DIR = oldStorage
    if (storage) await rm(storage, { recursive: true, force: true })
    vi.doUnmock('../db.js')
  })

  it('has the migrated independent revocation counter', async () => {
    expect((await prisma.user.findUniqueOrThrow({ where: { id: userId } })).catalogTokenVersion).toBe(0)
  })

  it('serializes concurrent retries and reuses the mapped Skill after withdrawal, without changing an approved listing', async () => {
    const body = payload()
    const responses = await Promise.all([submit(body), submit(body)])
    expect(responses.map(r => r.statusCode).sort()).toEqual([200, 201])
    const first = responses[0].json()
    expect(responses[1].json()).toEqual(first)
    expect(first.status).toBe('submitted')
    const cards = await import('../lib/skill-cards.js')
    const unavailable = vi.spyOn(cards, 'prepareCard').mockRejectedValueOnce(new Error('Storage unavailable'))
    try {
      expect((await submit(body)).json().id).toBe(first.id)
      expect(unavailable).not.toHaveBeenCalled()
    } finally { unavailable.mockRestore() }
    const skill = await prisma.skill.findUniqueOrThrow({ where: { id: first.skillId } })
    expect(skill.authorId).toBe(userId)
    expect(skill.analysisStatus).toBe('unanalysed')
    expect(await prisma.skillVersion.count({ where: { skillId: skill.id } })).toBe(1)
    expect((await submit({ ...body, note: 'changed' })).statusCode).toBe(409)
    const secondBody = { ...body, clientOperationId: randomUUID() }
    expect((await submit(secondBody)).statusCode).toBe(409)
    expect((await app.inject({ method: 'POST', url: `/api/marketplace/submissions/${first.id}/withdraw`, headers: auth() })).statusCode).toBe(200)
    const second = await submit(secondBody)
    expect(second.statusCode, second.body).toBe(201)
    expect(second.json().skillId).toBe(skill.id)
    expect(second.json().version.version).toBe('0.1.1')
    await prisma.marketplaceSubmission.update({ where: { id: second.json().id }, data: { status: 'approved' } })
    await prisma.marketplaceListing.create({ data: { skillId: skill.id, versionId: second.json().version.id, submissionId: second.json().id } })
    await prisma.skill.update({ where: { id: skill.id }, data: { visibility: 'public' } })
    const comment = await app.inject({ method: 'POST', url: `/api/marketplace/${skill.id}/comments`, headers: auth(), payload: { visibility: 'public', content: 'Catalog comment' } })
    expect(comment.statusCode, comment.body).toBe(201)
    const foreignToken = app.jwt.sign({ sub: otherId, purpose: 'product', ver: 0 })
    expect((await app.inject({ method: 'DELETE', url: `/api/marketplace/comments/${comment.json().id}`, headers: { authorization: `Bearer ${foreignToken}` } })).statusCode).toBe(403)
    expect((await app.inject({ method: 'DELETE', url: `/api/marketplace/comments/${comment.json().id}`, headers: auth() })).statusCode).toBe(204)
    expect((await app.inject({ method: 'POST', url: `/api/marketplace/${skill.id}/comments`, headers: auth(), payload: { visibility: 'team', content: 'Forbidden team comment' } })).statusCode).toBe(403)
    const third = await submit({ ...body, clientOperationId: randomUUID() })
    expect(third.statusCode, third.body).toBe(201)
    expect((await prisma.marketplaceListing.findUniqueOrThrow({ where: { skillId: skill.id } })).submissionId).toBe(second.json().id)
    expect((await prisma.skill.findUniqueOrThrow({ where: { id: skill.id } })).marketplaceStatus).toBe('approved')
    expect((await submit(body)).json().id).toBe(first.id)
    expect(await prisma.catalogSubmissionOperation.count({ where: { userId, submission: { skillId: skill.id } } })).toBe(3)
  })

  it('rolls back Skill, version, mapping and submission if the transaction fails after the operation insert', async () => {
    const body = payload()
    const before = await prisma.skill.count({ where: { authorId: userId } })
    const actual = prisma.$transaction.bind(prisma)
    let reachedCommit = false
    const spy = vi.spyOn(prisma, '$transaction').mockImplementationOnce(async operation => {
      if (typeof operation !== 'function') throw new Error('Expected interactive transaction')
      return actual(async tx => {
        await operation(tx)
        reachedCommit = true
        throw new Error('Injected transaction failure before commit')
      })
    })
    try { expect((await submit(body)).statusCode).toBe(500) } finally { spy.mockRestore() }
    expect(reachedCommit).toBe(true)
    expect(await prisma.skill.count({ where: { authorId: userId } })).toBe(before)
    expect(await prisma.catalogSkillSource.count({ where: { userId, sourceSkillId: body.sourceSkillId as string } })).toBe(0)
    expect(await prisma.catalogSubmissionOperation.count({ where: { userId, clientOperationId: body.clientOperationId as string } })).toBe(0)
  })

  it('does not turn catalog-acquired bytes into authored assets', async () => {
    await prisma.cardGrant.upsert({ where: { userId_cardSha256: { userId, cardSha256: packageSha256 } }, create: { userId, cardSha256: packageSha256, reason: 'catalog' }, update: { reason: 'catalog' } })
    const response = await submit(payload())
    expect(response.statusCode, response.body).toBe(409)
    await prisma.cardGrant.update({ where: { userId_cardSha256: { userId, cardSha256: packageSha256 } }, data: { reason: 'authored' } })
  })

  it('isolates operation keys and source mappings by user and accepts product JWTs', async () => {
    const body = payload()
    const first = await submit(body)
    expect(first.statusCode, first.body).toBe(201)
    const saved = token
    token = app.jwt.sign({ sub: otherId, purpose: 'product', ver: 0 })
    try {
      const second = await submit(body)
      expect(second.statusCode, second.body).toBe(201)
      expect(second.json().skillId).not.toBe(first.json().skillId)
      expect((await app.inject({ url: `/api/marketplace/mine/${first.json().id}`, headers: auth() })).statusCode).toBe(404)
    } finally { token = saved }
  })
})
