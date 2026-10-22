import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify'
import sensible from '@fastify/sensible'
import { PrismaClient } from '@prisma/client'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

const postgresUrl = process.env.SKILLHUB_PG_TEST_URL
const suite = postgresUrl ? describe : describe.skip
const packageData = Buffer.from('UEsDBBQAAAAAAIKwQV26Df4KEQAAABEAAAAIAAAAU0tJTEwubWQjIEVkaXRvcmlhbCB0ZXN0ClBLAQIUAxQAAAAAAIKwQV26Df4KEQAAABEAAAAIAAAAAAAAAAAAAACAAQAAAABTS0lMTC5tZFBLBQYAAAAAAQABADYAAAA3AAAAAAA=', 'base64')
const packageSha256 = createHash('sha256').update(packageData).digest('hex')

suite('variants avatar displays and listing snapshots (PostgreSQL)', () => {
  const author = randomUUID(), viewer = randomUUID(), admin = randomUUID()
  const owners = [author, viewer, admin], teamId = randomUUID()
  const topicId = randomUUID()
  let acting = author
  let prisma: PrismaClient, app: FastifyInstance
  let avatars: typeof import('../lib/skill-avatars.js'), jobs: typeof import('../lib/avatar-jobs.js')
  let config: typeof import('../config.js')['config']
  let oldConfig: Pick<typeof config, 'SKILL_AVATAR_MODEL_READS' | 'SKILLHUB_PROFILE' | 'SKILL_AVATARS_ENABLED' | 'SKILL_CARD_STORAGE_DIR' | 'SKILL_AVATAR_DAILY_LIMIT'>
  let directory: string
  const upload = vi.fn(), submit = vi.fn()
  const png = Buffer.alloc(33)
  Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]).copy(png)
  png.writeUInt32BE(13,8); png.write('IHDR',12); png.writeUInt32BE(256,16); png.writeUInt32BE(256,20)
  const image = { mimeType: 'image/png' as const, dataBase64: png.toString('base64') }
  const url = (name: string): string => `https://picem-media.whatonearth.work/${name}.png`
  beforeAll(async () => {
    prisma = new PrismaClient({ datasources: { db: { url: postgresUrl } } })
    vi.doMock('../db.js', () => ({ db: prisma }))
    vi.doMock('../middleware/auth.js', () => ({
      optionalAuthMiddleware: async (): Promise<void> => {},
      authMiddleware: async (request: FastifyRequest): Promise<void> => {
        request.user = { id: acting, email: `${acting}@example.invalid`, displayName: 'Avatar QA', marketplaceRole: acting === admin ? 'admin' : 'user' }
      },
    }))
    vi.doMock('../lib/media.js', async original => ({ ...await original<typeof import('../lib/media.js')>(), uploadMedia: upload, publicImageUrl: (value: string): string => value }))
    vi.doMock('../lib/fal.js', async original => ({ ...await original<typeof import('../lib/fal.js')>(), submitFalAvatar: submit }))
    config = (await import('../config.js')).config
    oldConfig = { SKILL_AVATAR_MODEL_READS: config.SKILL_AVATAR_MODEL_READS, SKILLHUB_PROFILE: config.SKILLHUB_PROFILE,
      SKILL_AVATARS_ENABLED: config.SKILL_AVATARS_ENABLED, SKILL_CARD_STORAGE_DIR: config.SKILL_CARD_STORAGE_DIR, SKILL_AVATAR_DAILY_LIMIT: config.SKILL_AVATAR_DAILY_LIMIT }
    directory = await mkdtemp(join(tmpdir(), 'avatar-phase-b-cards-'))
    Object.assign(config, { SKILL_AVATAR_MODEL_READS: 'variants', SKILLHUB_PROFILE: 'yitan-official', SKILL_AVATARS_ENABLED: true, SKILL_AVATAR_DAILY_LIMIT: 10_000, SKILL_CARD_STORAGE_DIR: directory })
    await prisma.user.createMany({ data: owners.map(id => ({ id, email: `${id}@example.invalid`, displayName: 'Avatar QA', marketplaceRole: id === admin ? 'admin' : 'user' })) })
    await prisma.team.create({ data: { id: teamId, name: 'Avatar team', ownerId: author } })
    await prisma.teamMember.createMany({ data: [author, viewer].map(userId => ({ userId, teamId })) })
    avatars = await import('../lib/skill-avatars.js'); jobs = await import('../lib/avatar-jobs.js')
    app = Fastify(); await app.register(sensible)
    await app.register((await import('./skills.js')).skillsRoutes, { prefix: '/api/skills' })
    await app.register((await import('./skill-avatars.js')).skillAvatarRoutes, { prefix: '/api/skill-avatars' })
    await app.register((await import('./marketplace.js')).marketplaceRoutes, { prefix: '/api/marketplace' })
    await app.register((await import('./marketplace-experience.js')).marketplaceExperienceRoutes, { prefix: '/api/marketplace' })
    await app.ready()
  })
  afterAll(async () => {
    await app?.close()
    if (!prisma) return
    const mine = { ownerId: { in: owners } }
    await prisma.adminAgentAuditEvent.deleteMany({ where: { actorAdminId: { in: owners } } })
    await prisma.notification.deleteMany({ where: { userId: { in: owners } } })
    await prisma.marketplaceTopic.deleteMany({ where: { id: topicId } })
    await prisma.marketplaceListing.deleteMany({ where: { skill: { authorId: { in: owners } } } })
    await prisma.avatarSelection.deleteMany({ where: mine })
    await prisma.skillAvatarGenerationAttempt.deleteMany({ where: { avatar: mine } })
    await prisma.skillAvatar.updateMany({ where: mine, data: { currentJobId: null } })
    await prisma.avatarVariant.deleteMany({ where: mine })
    await prisma.avatarGenerationJob.deleteMany({ where: mine })
    await prisma.skillAvatar.deleteMany({ where: mine })
    await prisma.skill.deleteMany({ where: { authorId: { in: owners } } })
    await prisma.team.deleteMany({ where: { id: teamId } })
    await prisma.user.deleteMany({ where: { id: { in: owners } } })
    await prisma.$disconnect()
    Object.assign(config, oldConfig)
    await rm(directory, { recursive: true, force: true })
  })
  async function skillFixture(): Promise<{ skillId: string; submissionId: string }> {
    const skillId = randomUUID()
    await prisma.skill.create({ data: { id: skillId, authorId: author, name: `avatar-${skillId}`, displayName: 'Avatar QA', description: 'Avatar display isolation', avatarUrl: url('frozen'), avatarStatus: 'failed' } })
    return { skillId, submissionId: await submission(skillId, '0.1.0') }
  }
  async function submission(skillId: string, version: string): Promise<string> {
    const saved = await prisma.skillVersion.create({ data: { skillId, version, packageData, packageSha256, packageSize: packageData.length } })
    return (await prisma.marketplaceSubmission.create({ data: { skillId, versionId: saved.id, submittedById: author, status: 'under_review', skillName: `avatar-${skillId}`, displayName: 'Avatar QA', description: 'Avatar display isolation', sourceContent: '# Editorial test' } })).id
  }
  async function approve(submissionId: string): Promise<void> {
    acting = admin
    const response = await app.inject({ method: 'POST', url: `/api/marketplace/admin/submissions/${submissionId}/approve`, payload: {} })
    expect(response.statusCode, response.body).toBe(200)
    acting = author
  }
  async function custom(skillId: string, name: string): Promise<void> {
    upload.mockResolvedValue({ assetId: name, url: url(name) })
    await avatars.uploadCustomAvatar({ ownerId: author, skillId, image })
  }

  it('own/team show the author selection; every store surface shows the approved snapshot', async () => {
    const { skillId, submissionId } = await skillFixture()
    await custom(skillId, 'approved'); await approve(submissionId)
    await custom(skillId, 'author-live')
    await prisma.skillTeamShare.create({ data: { skillId, teamId, sharedById: author } })
    acting = author
    expect((await app.inject(`/api/skills/${skillId}`)).json()).toMatchObject({ avatarUrl: url('author-live'), avatarSource: 'custom' })
    acting = viewer
    const shared = await app.inject(`/api/skills?scope=team&teamId=${teamId}`)
    expect(shared.statusCode, shared.body).toBe(200)
    expect(shared.json()).toContainEqual(expect.objectContaining({ id: skillId, avatarUrl: url('author-live') }))
    expect((await app.inject(`/api/skills/${skillId}`)).json()).toMatchObject({ avatarUrl: url('author-live') })
    expect(await prisma.skillAvatar.count({ where: { ownerId: viewer, skillId } })).toBe(0)
    expect((await app.inject(`/api/marketplace/${skillId}`)).json()).toMatchObject({ avatarUrl: url('approved'), avatarSource: 'custom' })
    const catalog = await app.inject(`/api/marketplace?query=avatar-${skillId}`)
    expect(catalog.json().items).toContainEqual(expect.objectContaining({ id: skillId, avatarUrl: url('approved') }))
    await prisma.marketplaceListing.update({ where: { skillId }, data: { installClickCount: 1_000_000 } })
    expect((await app.inject('/api/marketplace/trending')).json().items).toContainEqual(expect.objectContaining({ id: skillId, avatarUrl: url('approved') }))
    await prisma.marketplaceTopic.create({ data: { id: topicId, slug: topicId, title: 'Avatar QA', status: 'published', items: { create: { skillId } } } })
    expect((await app.inject(`/api/marketplace/topics/${topicId}`)).body).toContain(url('approved'))
    expect((await app.inject(`/api/marketplace/topics/${topicId}`)).body).not.toContain(url('author-live'))
    acting = admin
    expect((await app.inject(`/api/marketplace/admin/listings/${skillId}`)).json()).toMatchObject({ skill: { avatarUrl: url('approved') } })
    expect(await prisma.skill.findUniqueOrThrow({ where: { id: skillId } })).toMatchObject({ avatarUrl: url('frozen'), avatarStatus: 'failed' })
  })

  it('empty approval fills once, explicit update is author-only with both CAS tokens, and approved versions refresh', async () => {
    const { skillId, submissionId } = await skillFixture()
    await approve(submissionId)
    expect(await prisma.marketplaceListing.findUniqueOrThrow({ where: { skillId } })).toMatchObject({ avatarUrl: null, avatarStatus: 'none' })
    await custom(skillId, 'first-ready'); await custom(skillId, 'second-ready')
    const listing = await prisma.marketplaceListing.findUniqueOrThrow({ where: { skillId } })
    expect(listing.avatarUrl).toBe(url('first-ready'))
    const anchor = await prisma.skillAvatar.findUniqueOrThrow({ where: { skillId }, include: { selection: true } })
    const payload = { expectedUpdatedAt: listing.updatedAt.toISOString(), expectedSelectionRevision: anchor.selection!.revision }
    const endpoint = `/api/marketplace/${skillId}/avatar`
    acting = admin
    expect((await app.inject({ method: 'POST', url: endpoint, payload })).statusCode).toBe(403)
    acting = author
    expect((await app.inject({ method: 'POST', url: endpoint, payload: { ...payload, url: url('injected') } })).statusCode).toBe(400)
    expect((await app.inject({ method: 'POST', url: endpoint, payload: { ...payload, expectedSelectionRevision: payload.expectedSelectionRevision - 1 } })).statusCode).toBe(409)
    submit.mockClear()
    const race = await Promise.all([app.inject({ method: 'POST', url: endpoint, payload }), app.inject({ method: 'POST', url: endpoint, payload })])
    expect(race.map(response => response.statusCode).sort()).toEqual([200,409])
    expect(submit).not.toHaveBeenCalled()
    expect(await prisma.marketplaceListing.findUniqueOrThrow({ where: { skillId } })).toMatchObject({ avatarUrl: url('second-ready'), avatarUpdatedById: author })
    await custom(skillId, 'next-version')
    await approve(await submission(skillId, '0.1.1'))
    expect((await prisma.marketplaceListing.findUniqueOrThrow({ where: { skillId } })).avatarUrl).toBe(url('next-version'))
  })

  it('source changes and withdraw/restore preserve the complete avatar snapshot', async () => {
    const { skillId, submissionId } = await skillFixture()
    await custom(skillId, 'source-approved'); await approve(submissionId)
    await custom(skillId, 'source-live')
    const before = await prisma.marketplaceListing.findUniqueOrThrow({ where: { skillId } })
    acting = admin
    const changed = await app.inject({ method: 'POST', url: `/api/marketplace/admin/listings/${skillId}/source`, payload: { sourceUrl: 'https://example.org/source', expectedUpdatedAt: before.updatedAt.toISOString() } })
    expect(changed.statusCode, changed.body).toBe(200)
    const withdrawal = await app.inject({ method: 'POST', url: `/api/marketplace/admin/listings/${skillId}/withdraw`, payload: { reason: 'Fixture review' } })
    expect(withdrawal.statusCode, withdrawal.body).toBe(200)
    const withdrawn = await prisma.marketplaceListing.findUniqueOrThrow({ where: { skillId } })
    const restored = await app.inject({ method: 'POST', url: `/api/marketplace/admin/listings/${skillId}/restore`, payload: { expectedUpdatedAt: withdrawn.updatedAt.toISOString() } })
    expect(restored.statusCode, restored.body).toBe(200)
    const after = await prisma.marketplaceListing.findUniqueOrThrow({ where: { skillId } })
    for (const field of ['avatarUrl','avatarStatus','avatarSource','avatarSnapshotAt','avatarUpdatedById'] as const) expect(after[field]).toEqual(before[field])
  })

  it('local claimed task bound after approval fills the empty cloud listing when it finishes', async () => {
    acting = author
    const localSkillId = randomUUID()
    const anchor = await avatars.ensureSkillAvatar({ ownerId: author, localSkillId, input: { name: 'Bound later', description: 'Cloud binding fixture', scenarios: [] } })
    await prisma.avatarGenerationJob.update({ where: { id: anchor.currentJobId! }, data: { status: 'transferring', path: 'meta', assetId: 'late-binding', url: url('late-binding'), leaseToken: randomUUID() } })
    const claimed = await jobs.readAvatarTask(prisma, anchor.id)
    expect(claimed.skillId).toBeNull()
    const { skillId, submissionId } = await skillFixture()
    await approve(submissionId)
    expect(await avatars.bindCloudAvatarToEntry(author, skillId, localSkillId)).toBe(true)
    await jobs.persistAvatarJob(claimed, { status: 'ready' })
    expect((await prisma.marketplaceListing.findUniqueOrThrow({ where: { skillId } })).avatarUrl).toBe(url('late-binding'))
  })

  it('account style endpoint validates cached styles and selfhost rejects account writes', async () => {
    acting = author
    const endpoint = '/api/skill-avatars/style'
    expect((await app.inject(endpoint)).json()).toMatchObject({ styleId: 'classic', accountStyleId: null })
    expect((await app.inject({ method: 'PUT', url: endpoint, payload: { styleId: 'missing-style' } })).statusCode).toBe(400)
    expect((await app.inject({ method: 'PUT', url: endpoint, payload: { styleId: 'classic' } })).statusCode).toBe(200)
    config.SKILLHUB_PROFILE = 'selfhost'
    expect((await app.inject({ method: 'PUT', url: endpoint, payload: { styleId: null } })).statusCode).toBe(403)
    expect((await app.inject(endpoint)).json()).toMatchObject({ accountStyleId: null })
    config.SKILLHUB_PROFILE = 'yitan-official'
  })

  it('admin direct publish captures empty then auto-fills once from the admin author selection', async () => {
    acting = admin
    const skillId = randomUUID()
    const response = await app.inject({ method: 'POST', url: '/api/marketplace/admin/skills/publish', payload: {
      clientOperationId: skillId, name: `avatar-${skillId}`, version: '0.1.0',
      profile: { displayName: 'Direct publish', description: 'Avatar snapshot fixture', category: '开发与工程', labels: ['测试验证', 'Skill管理'], triggerScenarios: ['验证发布'] },
      compatibleAgents: ['codex'], envDependencies: [], packageBase64: packageData.toString('base64'), packageSha256,
    } })
    expect(response.statusCode, response.body).toBe(201)
    expect((await prisma.marketplaceListing.findUniqueOrThrow({ where: { skillId } })).avatarUrl).toBeNull()
    upload.mockResolvedValue({ assetId: 'direct-first', url: url('direct-first') })
    await avatars.uploadCustomAvatar({ ownerId: admin, skillId, image })
    upload.mockResolvedValue({ assetId: 'direct-later', url: url('direct-later') })
    await avatars.uploadCustomAvatar({ ownerId: admin, skillId, image })
    expect((await prisma.marketplaceListing.findUniqueOrThrow({ where: { skillId } })).avatarUrl).toBe(url('direct-first'))
  })
})
