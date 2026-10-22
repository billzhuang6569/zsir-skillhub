import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Fastify, { type FastifyInstance } from 'fastify'
import sensible from '@fastify/sensible'
import jwt from '@fastify/jwt'
import { PrismaClient } from '@prisma/client'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createAgentKey, type AgentScope } from '../lib/admin-agent-key.js'

const postgresUrl = process.env['SKILLHUB_PG_TEST_URL']
const describePostgres = postgresUrl ? describe : describe.skip
const prefix = '/api/admin/v1/marketplace'
const packageData = Buffer.from('UEsDBBQAAAAAAIKwQV26Df4KEQAAABEAAAAIAAAAU0tJTEwubWQjIEVkaXRvcmlhbCB0ZXN0ClBLAQIUAxQAAAAAAIKwQV26Df4KEQAAABEAAAAIAAAAAAAAAAAAAACAAQAAAABTS0lMTC5tZFBLBQYAAAAAAQABADYAAAA3AAAAAAA=', 'base64')
const packageSha256 = createHash('sha256').update(packageData).digest('hex')

describePostgres('Admin Marketplace on existing APIs with real PostgreSQL', () => {
  let app: FastifyInstance
  let prisma: PrismaClient
  let config: typeof import('../config.js')['config']
  let oldStorage: string
  let storage: string
  let afterAuth: (() => Promise<void>) | undefined
  const adminId = randomUUID()
  const userId = randomUUID()
  const skillId = randomUUID()
  const topicId = randomUUID()
  const name = `admin-${randomUUID()}`
  let publishKey: string
  let reviewKey: string
  let topicKey: string
  let readKey: string

  async function key(scopes: AgentScope[]): Promise<{ id: string; token: string }> {
    const id = randomUUID()
    const generated = createAgentKey(id)
    await prisma.adminAgentKey.create({ data: { id, name: 'Local integration test', secretHash: generated.hash, issuerAdminId: adminId, clientOperationId: randomUUID(), scopes } })
    return { id, token: generated.token }
  }

  async function buildApp(): Promise<FastifyInstance> {
    const [{ marketplaceRoutes }, { marketplaceExperienceRoutes }, { adminAgentApiRoutes }, { adminAgentKeyRoutes }, { createAdminAgentAccess }] = await Promise.all([
      import('./marketplace.js'), import('./marketplace-experience.js'), import('./admin-agent-api.js'), import('./admin-agent-keys.js'), import('../middleware/admin-agent.js'),
    ])
    const server = Fastify()
    await server.register(sensible)
    await server.register(jwt, { secret: 'issue196-local-test-session-only' })
    server.addHook('preHandler', async request => {
      if (request.verifiedAgentKey && afterAuth) { const action = afterAuth; afterAuth = undefined; await action() }
    })
    const access = createAdminAgentAccess()
    await server.register(marketplaceRoutes, { prefix: '/api/marketplace' })
    await server.register(marketplaceExperienceRoutes, { prefix: '/api/marketplace' })
    await server.register(adminAgentKeyRoutes, { prefix: '/api/marketplace' })
    await server.register(adminAgentApiRoutes, { prefix: '/api/admin/v1', access })
    await server.register(marketplaceRoutes, { prefix, agentAccess: access })
    await server.register(marketplaceExperienceRoutes, { prefix, agentAccess: access })
    await server.ready()
    return server
  }

  function publishPayload(id = skillId, skillName = name): Record<string, unknown> {
    return { clientOperationId: id, name: skillName, version: '0.1.0', profile: { displayName: '管理员测试 Skill', description: '测试公开包与资料', category: '开发与工程', labels: ['测试验证', 'Skill管理'], triggerScenarios: ['验证发布'] }, compatibleAgents: ['codex'], envDependencies: [], packageBase64: packageData.toString('base64'), packageSha256 }
  }
  const headers = (token: string): { authorization: string } => ({ authorization: `Bearer ${token}` })
  const publish = (payload: Record<string, unknown>, token = publishKey) => app.inject({ method: 'POST', url: `${prefix}/skills/publish`, headers: headers(token), payload })

  beforeAll(async (): Promise<void> => {
    prisma = new PrismaClient({ datasources: { db: { url: postgresUrl } } })
    vi.doMock('../db.js', () => ({ db: prisma }))
    config = (await import('../config.js')).config
    oldStorage = config.SKILL_CARD_STORAGE_DIR
    storage = await mkdtemp(join(tmpdir(), 'skillhub-196-cards-'))
    config.SKILL_CARD_STORAGE_DIR = storage
    await prisma.user.createMany({ data: [
      { id: adminId, email: `${adminId}@example.test`, displayName: 'Admin', marketplaceRole: 'admin' },
      { id: userId, email: `${userId}@example.test`, displayName: 'Author' },
    ] })
    publishKey = (await key(['marketplace:publish'])).token
    reviewKey = (await key(['marketplace:review'])).token
    topicKey = (await key(['marketplace:topics:write'])).token
    readKey = (await key(['ops:read'])).token
    app = await buildApp()
  })

  afterAll(async (): Promise<void> => {
    await app?.close()
    vi.unstubAllGlobals()
    if (prisma) {
      const keys = await prisma.adminAgentKey.findMany({ where: { issuerAdminId: adminId }, select: { id: true } })
      await prisma.adminAgentAuditEvent.deleteMany({ where: { keyId: { in: keys.map(row => row.id) } } })
      await prisma.adminAgentKey.deleteMany({ where: { issuerAdminId: adminId } })
      await prisma.marketplaceTopic.deleteMany({ where: { id: topicId } })
      await prisma.skill.updateMany({ where: { authorId: { in: [adminId, userId] } }, data: { importVersionId: null } })
      await prisma.skill.deleteMany({ where: { authorId: { in: [adminId, userId] } } })
      await prisma.mediaAsset.deleteMany({ where: { uploadedById: adminId } })
      await prisma.user.deleteMany({ where: { id: { in: [adminId, userId] } } })
      await prisma.$disconnect()
    }
    if (config) config.SKILL_CARD_STORAGE_DIR = oldStorage
    if (storage) await rm(storage, { recursive: true, force: true })
    vi.doUnmock('../db.js')
  })

  it('keeps read keys, Cookie, product JWT and unrelated scopes out of writes and Key management', async () => {
    expect((await publish(publishPayload(), readKey)).statusCode).toBe(403)
    expect((await publish(publishPayload(), reviewKey)).statusCode).toBe(403)
    expect((await app.inject({ method: 'POST', url: `${prefix}/skills/publish`, payload: publishPayload() })).statusCode).toBe(401)
    const cookie = `skillhub_admin_session=${app.jwt.sign({ sub: adminId, ver: 0, purpose: 'web-admin', webAdmin: true })}`
    expect((await app.inject({ method: 'POST', url: `${prefix}/skills/publish`, headers: { ...headers(publishKey), cookie }, payload: publishPayload() })).statusCode).toBe(401)
    expect((await publish(publishPayload(), app.jwt.sign({ sub: adminId, ver: 0, purpose: 'product' }))).statusCode).toBe(401)
    expect((await app.inject({ url: '/api/marketplace/admin/agent-keys', headers: headers(publishKey) })).statusCode).toBe(401)
    const capabilities = (await app.inject({ url: '/api/admin/v1/capabilities', headers: headers(publishKey) })).json().data
    expect(capabilities.operations.map((row: { method: string; path: string }) => `${row.method} ${row.path}`)).toEqual(expect.arrayContaining([`POST ${prefix}/skills/publish`, `GET ${prefix}/skills/:id`]))
    expect(capabilities.operations).toHaveLength(3)
    expect((await app.inject({ url: `${prefix}/topics`, headers: headers(publishKey) })).statusCode).toBe(403)
  })

  it('publishes once across concurrent retries and restart, pins Profile and serves the exact ZIP', async () => {
    const responses = await Promise.all([publish(publishPayload()), publish(publishPayload())])
    expect(responses.map(row => row.statusCode).sort(), responses.map(row => row.body).join('\n')).toEqual([200, 201])
    const result = responses.find(row => row.statusCode === 201)!.json().data
    expect(await prisma.skillVersion.count({ where: { skillId } })).toBe(1)
    expect(await prisma.marketplaceSubmission.count({ where: { skillId } })).toBe(1)
    expect((await prisma.marketplaceSubmission.findUniqueOrThrow({ where: { id: result.submissionId } })).status).toBe('approved')
    const listing = await prisma.marketplaceListing.findUniqueOrThrow({ where: { skillId } })
    expect(listing.firstPublishedAt).toEqual(listing.publishedAt)
    await app.close()
    app = await buildApp()
    expect((await publish(publishPayload())).statusCode).toBe(200)
    expect((await publish({ ...publishPayload(), version: '0.1.1' })).statusCode).toBe(409)
    expect((await publish(publishPayload(randomUUID(), name))).statusCode).toBe(409)
    await prisma.skill.update({ where: { id: skillId }, data: { displayName: 'Private later edit', description: 'Private later data' } })
    const publicDetail = await app.inject(`/api/marketplace/${skillId}`)
    expect(publicDetail.statusCode, publicDetail.body).toBe(200)
    expect(publicDetail.json().displayName).toBe('管理员测试 Skill')
    expect(publicDetail.json().badges).toContain('new')
    expect(publicDetail.json().firstPublishedAt).toBe(listing.firstPublishedAt.toISOString())
    const downloaded = await app.inject(`/api/marketplace/${skillId}/package`)
    expect(downloaded.statusCode).toBe(200)
    expect(createHash('sha256').update(downloaded.rawPayload).digest('hex')).toBe(packageSha256)
    expect((await app.inject({ url: `${prefix}/skills/${skillId}`, headers: headers(publishKey) })).json().data).toMatchObject({ skillId, packageSha256, status: 'approved' })
    expect((await prisma.adminAgentKey.findFirstOrThrow({ where: { issuerAdminId: adminId, scopes: { has: 'marketplace:publish' } } })).lastUsedAt).not.toBeNull()
  })

  it('rejects invalid packages, sensitive Profile, version and quota failures without creating a Listing', async () => {
    const id = randomUUID()
    expect((await publish({ ...publishPayload(id, `invalid-${id}`), packageSha256: '0'.repeat(64) })).statusCode).toBe(400)
    expect((await publish({ ...publishPayload(id, `invalid-${id}`), version: '1.10.0' })).statusCode).toBe(400)
    expect((await publish({ ...publishPayload(id, `invalid-${id}`), profile: { displayName: 'Secret', description: `sk_live_${'A'.repeat(24)}`, category: '开发与工程', labels: ['测试验证', 'Skill管理'], triggerScenarios: [] } })).statusCode).toBe(400)
    const oldQuota = config.SKILL_MAX_STORAGE_BYTES_PER_USER
    config.SKILL_MAX_STORAGE_BYTES_PER_USER = 0
    try { expect((await publish(publishPayload(id, `quota-${id}`))).statusCode).toBe(413) }
    finally { config.SKILL_MAX_STORAGE_BYTES_PER_USER = oldQuota }
    expect(await prisma.marketplaceListing.count({ where: { skillId: id } })).toBe(0)
  })

  it('preserves each source through mixed uploads, retries, approved snapshots and versioned edits', async () => {
    for (const sourceUrl of ['https://github.com/example/skill', 'https://example.test/guide?q=1#source', null]) {
      const id = randomUUID()
      const payload = publishPayload(id, `source-${id}`)
      payload.profile = { ...(payload.profile as Record<string, unknown>), sourceUrl }
      const response = await publish(payload)
      expect(response.statusCode, response.body).toBe(201)
      const created = response.json().data
      expect(created.sourceUrl).toBe(sourceUrl)
      expect((await publish(payload)).statusCode).toBe(200)
      expect((await publish({ ...payload, profile: { ...(payload.profile as Record<string, unknown>), sourceUrl: 'https://x.com/changed' } })).statusCode).toBe(409)
      const skill = await prisma.skill.findUniqueOrThrow({ where: { id }, include: { versions: true, marketplaceSubmissions: true } })
      expect(skill.sourceUrl).toBe(sourceUrl)
      expect(skill.versions[0].sourceUrl).toBe(sourceUrl)
      expect(skill.marketplaceSubmissions[0].sourceUrl).toBe(sourceUrl)
      const read = await app.inject({ url: `${prefix}/skills/${id}`, headers: headers(publishKey) })
      expect(read.json().data.sourceUrl).toBe(sourceUrl)
      await prisma.skill.update({ where: { id }, data: { sourceUrl: 'https://private.example.test/draft' } })
      expect((await app.inject(`/api/marketplace/${id}`)).json().sourceUrl).toBe(sourceUrl)
      const detail = (await app.inject({ url: `${prefix}/listings/${id}`, headers: headers(reviewKey) })).json().data
      expect(detail.skill.sourceUrl).toBe(sourceUrl)
      const edit = { method: 'POST' as const, url: `${prefix}/listings/${id}/source`, headers: headers(reviewKey), payload: { sourceUrl: 'https://skills.sh/example/new', expectedUpdatedAt: detail.listing.updatedAt } }
      expect((await app.inject({ ...edit, headers: headers(publishKey) })).statusCode).toBe(403)
      const saved = await app.inject(edit)
      expect(saved.statusCode, saved.body).toBe(200)
      expect((await app.inject(edit)).statusCode).toBe(409)
      expect((await prisma.skillVersion.findUniqueOrThrow({ where: { id: created.versionId } })).sourceUrl).toBe(sourceUrl)
      expect((await app.inject(`/api/marketplace/${id}`)).json().sourceUrl).toBe('https://skills.sh/example/new')
      const cleared = await app.inject({ ...edit, payload: { sourceUrl: ' ', expectedUpdatedAt: saved.json().data.updatedAt } })
      expect(cleared.statusCode, cleared.body).toBe(200)
      expect((await app.inject(`/api/marketplace/${id}`)).json().sourceUrl).toBeNull()
    }
    const invalid = publishPayload(randomUUID(), `invalid-source-${randomUUID()}`)
    invalid.profile = { ...(invalid.profile as Record<string, unknown>), sourceUrl: 'javascript:alert(1)' }
    expect((await publish(invalid)).statusCode).toBe(400)
  })

  it('runs the local admin batch uploader against the actual routes and verifies every source', async () => {
    const script = new URL('../../../.agents/skills/skillhub-maintenance/scripts/publish-skills.mjs', import.meta.url).href
    const { prepareBatch, publishBatch } = await import(script)
    const directory = await mkdtemp(join(tmpdir(), 'skillhub-329-batch-'))
    try {
      await writeFile(join(directory, 'skill.zip'), packageData)
      const manifest = ['https://x.com/example/status/123', 'https://ordinary.example.test/skill', null].map(sourceUrl => {
        const id = randomUUID()
        const payload = publishPayload(id, `batch-${id}`)
        return { ...payload, packageBase64: undefined, packagePath: 'skill.zip', profile: { ...(payload.profile as Record<string, unknown>), sourceUrl } }
      })
      const path = join(directory, 'manifest.json')
      await writeFile(path, JSON.stringify(manifest))
      const items = await prepareBatch(path)
      const fetchImpl = async (url: string, options: RequestInit): Promise<Response> => {
        const pathname = new URL(url).pathname
        if (pathname === '/ready') return Response.json({ capabilities: ['skills.source-url.v1'] })
        const response = await app.inject({ method: options.method as 'GET' | 'POST', url: pathname, headers: options.headers as Record<string, string>, ...(options.body ? { payload: String(options.body) } : {}) })
        return new Response(response.body, { status: response.statusCode })
      }
      const receiptPath = join(directory, 'receipts.jsonl')
      const receipts = await publishBatch(items, { baseUrl: 'http://localhost', key: publishKey, receiptPath, fetchImpl })
      expect(receipts).toHaveLength(3)
      expect(receipts.every((receipt: { matched: boolean }) => receipt.matched)).toBe(true)
      expect(receipts.map((receipt: { actualSource: unknown }) => receipt.actualSource)).toEqual(manifest.map(item => item.profile.sourceUrl))
      expect(await readFile(receiptPath, 'utf8')).not.toContain(publishKey)
      expect((await publishBatch(items, { baseUrl: 'http://localhost', key: publishKey, receiptPath, fetchImpl })).every((receipt: { matched: boolean }) => receipt.matched)).toBe(true)
    } finally { await rm(directory, { recursive: true, force: true }) }
  })

  it('rolls back publication on audit failure and on revoke/demotion after initial authentication', async () => {
    const id = randomUUID()
    await prisma.$executeRawUnsafe(`ALTER TABLE admin_agent_audit_events ADD CONSTRAINT issue196_audit_failure CHECK ("operationId" <> 'marketplace.publish') NOT VALID`)
    try { expect((await publish(publishPayload(id, `audit-${id}`))).statusCode).toBe(503) }
    finally { await prisma.$executeRawUnsafe('ALTER TABLE admin_agent_audit_events DROP CONSTRAINT issue196_audit_failure') }
    expect(await prisma.skill.count({ where: { id } })).toBe(0)
    for (const action of ['revoke', 'demote']) {
      const generated = await key(['marketplace:publish'])
      afterAuth = async (): Promise<void> => {
        if (action === 'revoke') await prisma.adminAgentKey.update({ where: { id: generated.id }, data: { revokedAt: new Date() } })
        else await prisma.user.update({ where: { id: adminId }, data: { marketplaceRole: 'user' } })
      }
      const target = randomUUID()
      try { expect((await publish(publishPayload(target, `revoked-${target}`), generated.token)).statusCode).toBe(401) }
      finally { await prisma.user.update({ where: { id: adminId }, data: { marketplaceRole: 'admin' } }) }
      expect(await prisma.skill.count({ where: { id: target } })).toBe(0)
    }
  })

  it('atomically creates, edits, publishes and archives topics with ordered links and CAS', async () => {
    const save = (payload: Record<string, unknown>) => app.inject({ method: 'POST', url: `${prefix}/topics/save`, headers: headers(topicKey), payload })
    const base = { id: topicId, title: '测试专题', listingIds: [skillId, skillId], expectedUpdatedAt: null }
    expect((await save({ title: '缺少 ID', listingIds: [] })).statusCode).toBe(428)
    expect((await save({ ...base, status: 'published', listingIds: [] })).statusCode).toBe(400)
    expect((await save({ ...base, listingIds: [randomUUID()] })).statusCode).toBe(409)
    expect(await prisma.marketplaceTopic.count({ where: { id: topicId } })).toBe(0)
    const created = await save(base)
    expect(created.statusCode, created.body).toBe(200)
    expect((await save(base)).statusCode).toBe(409)
    expect(await prisma.marketplaceTopic.count({ where: { id: topicId } })).toBe(1)
    const get = () => app.inject({ url: `${prefix}/topics/${topicId}`, headers: headers(topicKey) })
    const topic = (await get()).json().data
    expect(topic.items).toHaveLength(1)
    const races = await Promise.all([save({ ...base, expectedUpdatedAt: topic.updatedAt, title: '候选 A' }), save({ ...base, expectedUpdatedAt: topic.updatedAt, title: '候选 B' })])
    expect(races.map(row => row.statusCode).sort()).toEqual([200, 409])
    let latest = (await get()).json().data
    expect((await save({ ...base, expectedUpdatedAt: latest.updatedAt, status: 'published' })).statusCode).toBe(200)
    latest = (await get()).json().data
    expect((await save({ ...base, expectedUpdatedAt: latest.updatedAt, status: 'archived' })).statusCode).toBe(200)
    latest = (await get()).json().data
    expect(latest.status).toBe('archived')
    expect(latest.items).toHaveLength(1)
    expect((await save({ ...base, expectedUpdatedAt: latest.updatedAt, status: 'draft' })).statusCode).toBe(200)
    expect((await app.inject({ url: `${prefix}/topics?pageSize=1`, headers: headers(topicKey) })).json().data).toMatchObject({ pageSize: 1, nextPage: null })
  })

  it('reviews ordinary submissions through the same version checks, transactions and notifications', async () => {
    const authoredId = randomUUID()
    await prisma.skill.create({ data: { id: authoredId, name: `author-${authoredId}`, displayName: 'Author Skill', authorId: userId } })
    const version = await prisma.skillVersion.create({ data: { skillId: authoredId, version: '0.1.0', packageData, packageSha256, packageSize: packageData.length } })
    expect((await app.inject({ url: `${prefix}/skills/${authoredId}`, headers: headers(publishKey) })).statusCode).toBe(404)
    const makeSubmission = () => prisma.marketplaceSubmission.create({ data: { skillId: authoredId, versionId: version.id, submittedById: userId, skillName: 'author-skill', displayName: 'Author Skill', sourceContent: '# Editorial test\n' } })
    const submission = await makeSubmission()
    const send = (action: string, payload: Record<string, unknown>) => app.inject({ method: 'POST', url: `${prefix}/submissions/${submission.id}/${action}`, headers: headers(reviewKey), payload })
    const binding = { expectedVersionId: version.id, expectedPackageSha256: packageSha256, expectedStatus: 'submitted' }
    expect((await app.inject({ url: `${prefix}/submissions/${submission.id}/package-inspection`, headers: headers(reviewKey) })).json().data).toMatchObject({ versionId: version.id, packageSha256 })
    expect((await send('start', {})).statusCode).toBe(400)
    expect((await send('start', { ...binding, expectedPackageSha256: '0'.repeat(64) })).statusCode).toBe(409)
    expect((await send('start', binding)).statusCode).toBe(200)
    const underReview = { ...binding, expectedStatus: 'under_review' }
    expect((await send('approve', { ...underReview, expectedVersionId: randomUUID() })).statusCode).toBe(409)
    expect((await send('approve', underReview)).statusCode).toBe(200)
    expect((await send('approve', underReview)).statusCode).toBe(409)
    expect(await prisma.notification.count({ where: { userId, type: 'marketplace_approved' } })).toBe(1)
    const rejected = await makeSubmission()
    const reject = (action: string, payload: Record<string, unknown>) => app.inject({ method: 'POST', url: `${prefix}/submissions/${rejected.id}/${action}`, headers: headers(reviewKey), payload })
    expect((await reject('start', binding)).statusCode).toBe(200)
    expect((await reject('reject', underReview)).statusCode).toBe(400)
    expect((await reject('reject', { ...underReview, reviewNote: '请补充说明' })).statusCode).toBe(200)
    expect((await reject('reject', { ...underReview, reviewNote: '请补充说明' })).statusCode).toBe(409)
    expect(await prisma.notification.count({ where: { userId, type: 'marketplace_rejected' } })).toBe(1)
    expect((await prisma.marketplaceListing.findUniqueOrThrow({ where: { skillId: authoredId } })).versionId).toBe(version.id)
  })

  it('preserves first publication through machine approval of a new version and re-listing', async () => {
    const id = randomUUID()
    await prisma.skill.create({ data: { id, name: `first-publication-${id}`, displayName: 'First publication', authorId: userId } })
    const approve = async (versionName: string): Promise<void> => {
      const version = await prisma.skillVersion.create({ data: { skillId: id, version: versionName, packageData, packageSha256, packageSize: packageData.length } })
      const submission = await prisma.marketplaceSubmission.create({ data: { skillId: id, versionId: version.id, submittedById: userId, status: 'under_review', skillName: `first-publication-${id}`, displayName: 'First publication', sourceContent: '# Editorial test\n' } })
      const response = await app.inject({ method: 'POST', url: `${prefix}/submissions/${submission.id}/approve`, headers: headers(reviewKey), payload: { expectedVersionId: version.id, expectedPackageSha256: packageSha256, expectedStatus: 'under_review' } })
      expect(response.statusCode, response.body).toBe(200)
    }
    await approve('0.1.0')
    const first = await prisma.marketplaceListing.findUniqueOrThrow({ where: { skillId: id } })
    expect(first.firstPublishedAt).toEqual(first.publishedAt)
    const oldFirstPublication = new Date(Date.now() - 20 * 86_400_000)
    await prisma.marketplaceListing.update({ where: { skillId: id }, data: { firstPublishedAt: oldFirstPublication } })
    await approve('0.2.0')
    const updated = await prisma.marketplaceListing.findUniqueOrThrow({ where: { skillId: id } })
    expect(updated.firstPublishedAt).toEqual(oldFirstPublication)
    expect(updated.publishedAt.getTime()).toBeGreaterThan(oldFirstPublication.getTime())
    await prisma.marketplaceListing.update({ where: { skillId: id }, data: { withdrawnAt: new Date(), withdrawnBy: 'admin', withdrawnReason: '管理员下架' } })
    await approve('0.3.0')
    const restored = await prisma.marketplaceListing.findUniqueOrThrow({ where: { skillId: id } })
    expect(restored.firstPublishedAt).toEqual(oldFirstPublication)
    // Approving a new version re-lists the Skill and clears who withdrew it and why (#208).
    expect(restored).toMatchObject({ withdrawnAt: null, withdrawnBy: null, withdrawnReason: null })
    const detail = await app.inject(`/api/marketplace/${id}`)
    expect(detail.statusCode, detail.body).toBe(200)
    expect(detail.json().badges).not.toContain('new')
  })

  it('keeps topic changes atomic when auditing fails, withholds unaudited reads and respects legacy edits', async () => {
    const original = await prisma.marketplaceTopic.findUniqueOrThrow({ where: { id: topicId }, include: { items: true } })
    const save = () => app.inject({ method: 'POST', url: `${prefix}/topics/save`, headers: headers(topicKey), payload: { id: topicId, title: 'Must roll back', listingIds: [], expectedUpdatedAt: original.updatedAt.toISOString() } })
    await prisma.$executeRawUnsafe(`ALTER TABLE admin_agent_audit_events ADD CONSTRAINT issue196_audit_failure CHECK ("operationId" <> 'marketplace.topic.save' AND outcome <> 'read') NOT VALID`)
    try {
      const failed = await save()
      expect(failed.statusCode).toBe(503)
      expect(failed.json()).toMatchObject({ code: 'AUDIT_UNAVAILABLE', retryable: true })
      const read = await app.inject({ url: `${prefix}/topics/${topicId}`, headers: headers(topicKey) })
      expect(read.statusCode).toBe(503)
      expect(read.json()).not.toHaveProperty('data')
    } finally { await prisma.$executeRawUnsafe('ALTER TABLE admin_agent_audit_events DROP CONSTRAINT issue196_audit_failure') }
    expect(await prisma.marketplaceTopic.findUniqueOrThrow({ where: { id: topicId }, include: { items: true } })).toEqual(original)
    const cookie = `skillhub_admin_session=${app.jwt.sign({ sub: adminId, ver: 0, purpose: 'web-admin', webAdmin: true })}`
    const legacy = await app.inject({ method: 'PATCH', url: `/api/marketplace/admin/topics/${topicId}`, headers: { cookie }, payload: { title: 'Legacy administrator edit' } })
    expect(legacy.statusCode, legacy.body).toBe(200)
    expect(new Date(legacy.json().updatedAt).getTime()).toBeGreaterThan(original.updatedAt.getTime())
    expect((await save()).statusCode).toBe(409)
    expect((await prisma.marketplaceTopic.findUniqueOrThrow({ where: { id: topicId } })).title).toBe('Legacy administrator edit')
  })

  it('reuses Picem owner/content identity, preserves ownership checks and stops safely on upstream failures', async () => {
    const oldKey = config.PICEM_API_KEY
    config.PICEM_API_KEY = 'issue196-local-upstream-test-only'
    const upstreamKeys: string[] = []
    const imageUrl = `https://picem-media.whatonearth.work/apps/test/assets/ast_${adminId}/v1/original.png`
    const fetchMock = vi.fn(async (url: string, init?: RequestInit): Promise<Response> => {
      if (url.endsWith('/v1/assets')) { upstreamKeys.push(new Headers(init?.headers).get('Idempotency-Key') ?? ''); return Response.json({ id: `ast_${adminId}`, status: 'ready' }) }
      return Response.json({ url: imageUrl })
    })
    vi.stubGlobal('fetch', fetchMock)
    const cover = () => app.inject({ method: 'POST', url: `${prefix}/topics/cover`, headers: headers(topicKey), payload: { mimeType: 'image/png', dataBase64: 'iVBORw0KGgo=' } })
    try {
      expect((await cover()).statusCode).toBe(201)
      expect((await cover()).statusCode).toBe(201)
      expect(upstreamKeys).toHaveLength(2)
      expect(upstreamKeys[0]).toBe(upstreamKeys[1])
      expect(await prisma.mediaAsset.count({ where: { uploadedById: adminId } })).toBe(1)
      const latest = (await app.inject({ url: `${prefix}/topics/${topicId}`, headers: headers(topicKey) })).json().data
      await prisma.mediaAsset.updateMany({ where: { uploadedById: adminId }, data: { uploadedById: userId } })
      expect((await app.inject({ method: 'POST', url: `${prefix}/topics/save`, headers: headers(topicKey), payload: { id: topicId, title: '越权图片', listingIds: [skillId], expectedUpdatedAt: latest.updatedAt, coverImageUrl: imageUrl } })).statusCode).toBe(403)
      await prisma.mediaAsset.updateMany({ where: { url: imageUrl }, data: { uploadedById: adminId } })
      fetchMock.mockRejectedValueOnce(new Error('upstream down'))
      expect((await cover()).statusCode).toBe(503)
      expect((await prisma.marketplaceTopic.findUniqueOrThrow({ where: { id: topicId } })).title).not.toBe('越权图片')
    } finally { config.PICEM_API_KEY = oldKey; vi.unstubAllGlobals() }
  })

  it('#211 article bodies: derived items stay FK-safe, follow withdraw / restore, and every Web save is audited or rolled back', async () => {
    const cookie = `skillhub_admin_session=${app.jwt.sign({ sub: adminId, ver: 0, purpose: 'web-admin', webAdmin: true })}`
    const unknownId = randomUUID()
    const webSave = (payload: Record<string, unknown>) => app.inject({ method: 'POST', url: '/api/marketplace/admin/topics/save', headers: { cookie }, payload })
    let articleId: string | undefined
    const listingBefore = await prisma.marketplaceListing.findUniqueOrThrow({ where: { skillId } })
    try {
      // A draft may reference a Skill that has no listing: kept in the body, never written as an item.
      const draft = await webSave({ title: '文章专题', status: 'draft', contentMarkdown: `导语。\n\n[known](skill:${skillId})\n\n[gone](skill:${unknownId})` })
      expect(draft.statusCode, draft.body).toBe(200)
      expect(draft.json().warnings).toEqual([{ code: 'TOPIC_SKILL_UNKNOWN', line: 5, listingId: unknownId }])
      articleId = draft.json().id as string
      expect((await prisma.marketplaceTopicItem.findMany({ where: { topicId: articleId } })).map(item => item.skillId)).toEqual([skillId])
      expect(await prisma.adminAgentAuditEvent.count({ where: { channel: 'web', actorAdminId: adminId, operationId: 'marketplace.topic.save', outcome: `write:${articleId}` } })).toBe(1)
      // Publishing with the unknown reference is refused and changes nothing.
      const stored = await prisma.marketplaceTopic.findUniqueOrThrow({ where: { id: articleId }, include: { items: true } })
      const blocked = await webSave({ id: articleId, title: '文章专题', status: 'published', contentMarkdown: `导语。\n\n[known](skill:${skillId})\n\n[gone](skill:${unknownId})` })
      expect(blocked.statusCode).toBe(409)
      expect(await prisma.marketplaceTopic.findUniqueOrThrow({ where: { id: articleId }, include: { items: true } })).toEqual(stored)
      const published = await webSave({ id: articleId, title: '文章专题', status: 'published', contentMarkdown: `导语。\n\n[known](skill:${skillId})` })
      expect(published.statusCode, published.body).toBe(200)
      const slug = published.json().slug as string
      const read = async () => (await app.inject(`/api/marketplace/topics/${slug}`)).json() as { items: Array<{ id: string }>; contentMarkdown: string }
      expect((await read()).items.map(item => item.id)).toEqual([skillId])
      // Withdrawn: the item row stays (FK intact), the public DTO omits it, the body keeps the line.
      await prisma.marketplaceListing.update({ where: { skillId }, data: { withdrawnAt: new Date() } })
      expect((await read()).items).toEqual([])
      expect((await read()).contentMarkdown).toContain(`skill:${skillId}`)
      expect(await prisma.marketplaceTopicItem.count({ where: { topicId: articleId, skillId } })).toBe(1)
      await prisma.marketplaceListing.update({ where: { skillId }, data: { withdrawnAt: listingBefore.withdrawnAt } })
      expect((await read()).items.map(item => item.id)).toEqual([skillId])
      // The Agent read carries the body; the home list does not.
      const agentRead = (await app.inject({ url: `${prefix}/topics/${articleId}`, headers: headers(topicKey) })).json().data
      expect(agentRead.contentMarkdown).toBe(`导语。\n\n[known](skill:${skillId})`)
      const home = (await app.inject('/api/marketplace/home')).json() as { topics: Array<Record<string, unknown>> }
      expect(home.topics.find(topic => topic.id === articleId)).not.toHaveProperty('contentMarkdown')
      // An article refuses the legacy save; a failed Web audit rolls the whole save back.
      expect((await webSave({ id: articleId, title: 'x', listingIds: [skillId] })).json().code).toBe('TOPIC_ARTICLE_REQUIRES_UPGRADE')
      const before = await prisma.marketplaceTopic.findUniqueOrThrow({ where: { id: articleId }, include: { items: true } })
      await prisma.$executeRawUnsafe(`ALTER TABLE admin_agent_audit_events ADD CONSTRAINT issue211_web_audit_failure CHECK (channel <> 'web' OR "operationId" <> 'marketplace.topic.save') NOT VALID`)
      try {
        const failed = await webSave({ id: articleId, title: '必须回滚', status: 'draft', contentMarkdown: '新正文' })
        expect(failed.statusCode).toBe(503)
      } finally { await prisma.$executeRawUnsafe('ALTER TABLE admin_agent_audit_events DROP CONSTRAINT issue211_web_audit_failure') }
      expect(await prisma.marketplaceTopic.findUniqueOrThrow({ where: { id: articleId }, include: { items: true } })).toEqual(before)
    } finally {
      await prisma.marketplaceListing.update({ where: { skillId }, data: { withdrawnAt: listingBefore.withdrawnAt } })
      if (articleId) await prisma.marketplaceTopic.deleteMany({ where: { id: articleId } })
      await prisma.adminAgentAuditEvent.deleteMany({ where: { channel: 'web', actorAdminId: adminId } })
    }
  })
})
