import { createHash, randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify'
import sensible from '@fastify/sensible'
import { PrismaClient } from '@prisma/client'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { describeSkillPackage } from '../lib/skill-package.js'
import { classicAvatarStyle, canonicalJson } from '../lib/avatar-style-catalog.js'
import type { MigrationPlan } from '../lib/skill-migrations.js'

const pgUrl = process.env.SKILLHUB_PG_TEST_URL
const suite = pgUrl ? describe : describe.skip
const packageBase64 = 'UEsDBBQAAAAAAIKwQV26Df4KEQAAABEAAAAIAAAAU0tJTEwubWQjIEVkaXRvcmlhbCB0ZXN0ClBLAQIUAxQAAAAAAIKwQV26Df4KEQAAABEAAAAIAAAAAAAAAAAAAACAAQAAAABTS0lMTC5tZFBLBQYAAAAAAQABADYAAAA3AAAAAAA='
const bytes = Buffer.from(packageBase64, 'base64')
const hash = (value: Buffer | string): string => createHash('sha256').update(value).digest('hex')
const png = Buffer.alloc(33)
Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]).copy(png)
png.writeUInt32BE(13, 8); png.write('IHDR', 12); png.writeUInt32BE(256, 16); png.writeUInt32BE(256, 20)

suite('migration target (PostgreSQL)', () => {
  const owners = [randomUUID(), randomUUID()]
  const styleId = `migration-${randomUUID()}`
  let app: FastifyInstance, prisma: PrismaClient, directory: string
  let config: typeof import('../config.js')['config'], oldConfig: typeof config
  let migrations: typeof import('../lib/skill-migrations.js')
  const fal = vi.fn(), enqueue = vi.fn()
  beforeAll(async (): Promise<void> => {
    const url = new URL(pgUrl!)
    prisma = new PrismaClient({ datasources: { db: { url: url.toString() } } })
    vi.doMock('../db.js', () => ({ db: prisma }))
    vi.doMock('../middleware/auth.js', () => ({
      optionalAuthMiddleware: async (): Promise<void> => {},
      authMiddleware: async (request: FastifyRequest): Promise<void> => {
        const userId = String(request.headers['x-test-user'] ?? owners[0])
        request.user = { id: userId, email: `${userId}@example.invalid`, displayName: 'Migration QA', marketplaceRole: 'user' }
        request.verifiedAuthToken = { sub: userId, ver: 0 }
      },
    }))
    vi.doMock('../lib/fal.js', async original => ({ ...await original<typeof import('../lib/fal.js')>(), submitFalAvatar: fal }))
    vi.doMock('../lib/skill-avatars.js', async original => ({ ...await original<typeof import('../lib/skill-avatars.js')>(), queueCloudAvatar: enqueue }))
    config = (await import('../config.js')).config; oldConfig = { ...config }
    directory = await mkdtemp(join(tmpdir(), 'migration-411-'))
    Object.assign(config, { SKILLHUB_PROFILE: 'selfhost', SKILL_AVATAR_MODEL_READS: 'variants', SKILL_AVATARS_ENABLED: false,
      SKILL_CARD_STORAGE_DIR: join(directory, 'cards'), MEDIA_STORAGE_DIR: join(directory, 'media'), SKILL_VERSION_WRITES_PER_HOUR: 1000 })
    // Deployment provisions storage roots; the provider only creates object subdirectories.
    await mkdir(config.SKILL_CARD_STORAGE_DIR, { mode: 0o750 })
    await mkdir(config.MEDIA_STORAGE_DIR, { mode: 0o750 })
    await prisma.user.createMany({ data: owners.map(id => ({ id, email: `${id}@example.invalid`, displayName: 'Migration QA' })) })
    const style = { ...classicAvatarStyle, styleId }
    await prisma.avatarStyleVersion.create({ data: { styleId, styleVersion: 1, content: canonicalJson(style), contentSha256: hash(canonicalJson(style)), source: 'repository' } })
    migrations = await import('../lib/skill-migrations.js')
    app = Fastify(); await app.register(sensible)
    await app.register((await import('./migrations.js')).migrationRoutes, { prefix: '/api/migrations' })
    await app.register((await import('./marketplace.js')).marketplaceRoutes, { prefix: '/api/marketplace' })
    await app.register((await import('./skills.js')).skillsRoutes, { prefix: '/api/skills' })
    await app.ready()
  })
  afterAll(async (): Promise<void> => {
    await app?.close()
    if (!prisma) return
    const mine = { ownerId: { in: owners } }
    await prisma.avatarSelection.deleteMany({ where: mine })
    await prisma.skillAvatar.updateMany({ where: mine, data: { currentJobId: null } })
    await prisma.skillAvatarGenerationAttempt.deleteMany({ where: { avatar: mine } })
    await prisma.avatarVariant.deleteMany({ where: mine })
    await prisma.avatarGenerationJob.deleteMany({ where: mine })
    await prisma.skillAvatar.deleteMany({ where: mine })
    await prisma.skill.updateMany({ where: { authorId: { in: owners } }, data: { importVersionId: null } })
    await prisma.skill.deleteMany({ where: { authorId: { in: owners } } })
    await prisma.mediaAsset.deleteMany({ where: { uploadedById: { in: owners } } })
    // Published styles are immutable; retain this suite's UUID-scoped style.
    await prisma.user.deleteMany({ where: { id: { in: owners } } })
    await prisma.$disconnect()
    Object.assign(config, oldConfig)
    await rm(directory, { recursive: true, force: true })
    vi.doUnmock('../db.js'); vi.doUnmock('../middleware/auth.js'); vi.doUnmock('../lib/fal.js'); vi.doUnmock('../lib/skill-avatars.js')
  })
  function plan(overrides: Partial<MigrationPlan> = {}): MigrationPlan {
    return migrations.ItemPlan.parse({ sourceOrigin: 'https://source.invalid/skillhub', sourceUserId: 'source-user', sourceSkillId: randomUUID(),
      contentHash: describeSkillPackage(bytes).contentHash, kind: 'own_skill', version: '0.2.3', name: `migration-${randomUUID()}`, displayName: 'Migration QA',
      description: 'Imported profile', labels: ['test'], packageSize: bytes.length, packageSha256: hash(bytes), ...overrides })
  }
  async function session(userId = owners[0]): Promise<string> {
    const response = await app.inject({ method: 'POST', url: '/api/migrations', headers: { 'x-test-user': userId },
      payload: { protocolVersion: 1, source: { profile: 'selfhost', origin: 'https://source.invalid/skillhub/', userId: 'source-user' } } })
    expect(response.statusCode, response.body).toBe(201)
    return response.json().id as string
  }
  async function send(id: string, item: MigrationPlan, userId = owners[0]): Promise<Awaited<ReturnType<typeof app.inject>>> {
    return app.inject({ method: 'POST', url: `/api/migrations/${id}/items`, headers: { 'x-test-user': userId }, payload: { item, ...(item.mapToSkillId ? {} : { packageBase64 }) } })
  }
  it('lost response and concurrent duplicate imports create exactly one Skill and one first version', async (): Promise<void> => {
    const id = await session(), item = plan()
    const results = await Promise.all([send(id, item), send(id, item), send(id, item)])
    expect(results.map(r => r.statusCode)).toEqual([201,201,201])
    expect(results[1].json()).toEqual(results[0].json())
    const target = results[0].json().targetSkillId as string
    expect(await prisma.skill.count({ where: { id: target } })).toBe(1)
    expect(await prisma.skillMigrationItem.count({ where: { migrationId: id } })).toBe(1)
    expect(await prisma.skillVersion.count({ where: { skillId: target } })).toBe(1)
    expect((await send(id, item)).json()).toEqual(results[0].json())
    expect((await app.inject(`/api/migrations/${id}`)).json().items[0].result).toEqual(results[0].json())
    expect((await send(id, { ...item, description: 'Changed' })).statusCode).toBe(409)
    expect(fal).not.toHaveBeenCalled(); expect(enqueue).not.toHaveBeenCalled()
  })
  it('another target account needs a new migration and receives its own Skill', async (): Promise<void> => {
    const id = await session(), item = plan()
    const first = await send(id, item)
    expect((await send(id, item, owners[1])).statusCode).toBe(404)
    expect((await app.inject({ url: `/api/migrations/${id}`, headers: { 'x-test-user': owners[1] } })).statusCode).toBe(404)
    const second = await send(await session(owners[1]), item, owners[1])
    expect(second.statusCode, second.body).toBe(201)
    expect(second.json().targetSkillId).not.toBe(first.json().targetSkillId)
    expect((await prisma.skill.findUniqueOrThrow({ where: { id: second.json().targetSkillId } })).authorId).toBe(owners[1])
  })
  it('official-store personal copies remain visibly labelled and cannot be submitted', async (): Promise<void> => {
    const item = plan({ kind: 'store_copy', storeCopy: { listingId: 'official-listing', version: '0.2.3', state: 'delisted' } })
    const response = await send(await session(), item)
    expect(response.statusCode, response.body).toBe(201)
    const skill = await prisma.skill.findUniqueOrThrow({ where: { id: response.json().targetSkillId } })
    expect(skill.labels).toContain('官方商店个人副本')
    expect((await app.inject(`/api/skills/${skill.id}`)).json().storeCopy).toMatchObject(item.storeCopy!)
    const submitted = await app.inject({ method: 'POST', url: `/api/marketplace/skills/${skill.id}/submissions`, payload: { versionId: skill.importVersionId } })
    expect(submitted.statusCode, submitted.body).toBe(403)
    expect(submitted.json().code).toBe('MIGRATION_STORE_COPY_NOT_PUBLISHABLE')
    expect(await prisma.marketplaceSubmission.count({ where: { skillId: skill.id } })).toBe(0)
    expect((await prisma.cardGrant.findMany({ where: { userId: owners[0], sourceRef: `skill:${skill.id}` } })).every(g => g.reason !== 'marketplace')).toBe(true)
  })
  it('stages images with real builtin media, recreates variants/selection and restores without fal or quota', async (): Promise<void> => {
    const id = await session()
    const avatar = { id: 'generated', kind: 'generated' as const, styleId, styleVersion: 1, mimeType: 'image/png' as const, size: png.length, sha256: hash(png) }
    const item = plan({ avatars: [avatar, { ...avatar, id: 'classic', styleId: 'classic' }, { ...avatar, id: 'unknown', styleId: 'unknown' },
      { id: 'custom', kind: 'custom', mimeType: 'image/png', size: png.length, sha256: hash(png) }], selectedAvatarId: 'custom' })
    const operation = { sourceOrigin: item.sourceOrigin, sourceUserId: item.sourceUserId, sourceSkillId: item.sourceSkillId, contentHash: item.contentHash }
    expect((await send(id, item)).json().code).toBe('MIGRATION_AVATAR_NOT_UPLOADED')
    for (const avatar of item.avatars) {
      const request = { method: 'POST' as const, url: `/api/migrations/${id}/avatars`, payload: { operation, avatar, dataBase64: png.toString('base64') } }
      const uploaded = await app.inject(request)
      expect(uploaded.statusCode, uploaded.body).toBe(200)
      expect((await app.inject(request)).json()).toEqual(uploaded.json())
    }
    const response = await send(id, item)
    expect(response.statusCode, response.body).toBe(201)
    expect(response.json().avatars).toContainEqual({ id: 'unknown', status: 'skipped', code: 'AVATAR_STYLE_UNAVAILABLE' })
    const skillId = response.json().targetSkillId as string
    const anchor = await prisma.skillAvatar.findUniqueOrThrow({ where: { skillId }, include: { selection: true, variants: true } })
    expect(anchor.variants).toHaveLength(2)
    const fallback = anchor.variants.find(variant => variant.styleId === 'classic')!
    expect(anchor.selection).toMatchObject({ source: 'custom', variantId: fallback.id })
    expect(anchor.selection!.customUrl).toMatch(/^\/media\//)
    const verify = await import('../lib/avatar-model-verification.js')
    const snapshot = {
      anchors: [await prisma.skillAvatar.findUniqueOrThrow({ where: { id: anchor.id } })],
      jobs: await prisma.avatarGenerationJob.findMany({ where: { logicalSkillId: anchor.id } }), variants: anchor.variants,
      selections: [anchor.selection!], aliases: [], attempts: [], listings: [],
      skills: [await prisma.skill.findUniqueOrThrow({ where: { id: skillId } })], styles: await prisma.avatarStyleVersion.findMany(),
    }
    expect(verify.inspectAvatarModel(snapshot, 'legacy').differences).toEqual([])
    expect(verify.inspectAvatarModel(snapshot, 'variants').differences).toEqual([])
    const jobs = await import('../lib/avatar-jobs.js')
    await prisma.$transaction(tx => jobs.restoreAvatarSelection(tx, anchor))
    expect((await prisma.avatarSelection.findUniqueOrThrow({ where: { ownerId_logicalSkillId: { ownerId: owners[0], logicalSkillId: anchor.id } } })).variantId).toBe(fallback.id)
    expect(await prisma.skillAvatarGenerationAttempt.count({ where: { avatarId: anchor.id } })).toBe(0)
    expect(fal).not.toHaveBeenCalled(); expect(enqueue).not.toHaveBeenCalled()
    expect(await prisma.avatarGenerationJob.count({ where: { logicalSkillId: anchor.id, status: { notIn: ['ready', 'cancelled'] } } })).toBe(0)
    const generatedItem = { ...item, name: `migration-${randomUUID()}`, sourceSkillId: randomUUID(), selectedAvatarId: 'generated' }
    for (const avatar of generatedItem.avatars) {
      const staged = await app.inject({ method: 'POST', url: `/api/migrations/${id}/avatars`, payload: { operation: { ...operation, sourceSkillId: generatedItem.sourceSkillId }, avatar, dataBase64: png.toString('base64') } })
      expect(staged.statusCode, staged.body).toBe(200)
    }
    const generatedResponse = await send(id, generatedItem)
    expect(generatedResponse.statusCode, generatedResponse.body).toBe(201)
    const generatedAnchor = await prisma.skillAvatar.findUniqueOrThrow({ where: { skillId: generatedResponse.json().targetSkillId }, include: { selection: { include: { variant: true } } } })
    expect(generatedAnchor.selection).toMatchObject({ source: 'generated', variant: { styleId } })
    expect(generatedAnchor.selection!.customUrl).toBeTruthy()
    expect(await prisma.skillAvatarGenerationAttempt.count({ where: { avatarId: generatedAnchor.id } })).toBe(0)
  })
  it('precheck reports stored/mismatched operations and current quotas without changing data', async (): Promise<void> => {
    const id = await session(), item = plan()
    expect((await send(id, item)).statusCode).toBe(201)
    const request = { method: 'POST' as const, url: `/api/migrations/${id}/precheck`, payload: { items: [item, { ...item, description: 'different' }, plan({ packageSize: 21 * 1024 * 1024 }), plan()] } }
    const response = await app.inject(request)
    expect(response.json().items.map((i: { status: string }) => i.status)).toEqual(['skip', 'conflict', 'over_quota', 'ok'])
    const previous = config.SKILL_MAX_STORAGE_BYTES_PER_USER
    try {
      config.SKILL_MAX_STORAGE_BYTES_PER_USER = 1
      expect((await send(id, plan())).json().errors).toEqual(['STORAGE_LIMIT'])
    } finally { config.SKILL_MAX_STORAGE_BYTES_PER_USER = previous }
  })
  it('reports name conflicts and permits a successful copy retry without overwriting', async (): Promise<void> => {
    const id = await session(), original = plan()
    const first = await send(id, original)
    expect(first.statusCode, first.body).toBe(201)
    const existingSkillId = first.json().targetSkillId as string
    const before = await prisma.skill.findUniqueOrThrow({ where: { id: existingSkillId } })
    const item = plan({ name: original.name })
    const precheck = await app.inject({ method: 'POST', url: `/api/migrations/${id}/precheck`, payload: { items: [item] } })
    expect(precheck.json().items[0]).toMatchObject({ status: 'conflict', reason: 'name_exists', existingSkillId })
    for (const planned of [item, { ...item, targetName: original.name }]) {
      const conflict = await send(id, planned)
      expect(conflict.statusCode).toBe(409)
      expect(conflict.json()).toMatchObject({ code: 'MIGRATION_NAME_CONFLICT', existingSkillId })
    }
    expect(await prisma.skillMigrationItem.count({ where: { migrationId: id, operationKey: migrations.operationKey(item) } })).toBe(0)
    const copy = { ...item, targetName: `copy-${randomUUID()}` }
    const response = await send(id, copy)
    expect(response.statusCode, response.body).toBe(201)
    expect(response.json().targetSkillId).not.toBe(existingSkillId)
    const created = await prisma.skill.findUniqueOrThrow({ where: { id: response.json().targetSkillId }, include: { versions: true } })
    expect(created.name).toBe(copy.targetName); expect(created.versions[0].skillName).toBe(copy.targetName)
    expect((await send(id, copy)).json()).toEqual(response.json())
    expect((await send(id, item)).json().code).toBe('MIGRATION_PAYLOAD_MISMATCH')
    expect(await prisma.skill.findUniqueOrThrow({ where: { id: existingSkillId } })).toEqual(before)
  })
  it('records mappings idempotently without importing content and rejects foreign or missing targets', async (): Promise<void> => {
    const id = await session(), original = plan()
    const first = await send(id, original)
    expect(first.statusCode, first.body).toBe(201)
    const mapToSkillId = first.json().targetSkillId as string
    const item = plan({ name: original.name, mapToSkillId, avatars: [{ id: 'custom', kind: 'custom', mimeType: 'image/png', size: png.length, sha256: hash(png) }] })
    const otherSession = await session(owners[1])
    for (const target of [mapToSkillId, randomUUID()]) {
      const response = await send(otherSession, { ...item, mapToSkillId: target }, owners[1])
      expect(response.statusCode).toBe(404); expect(response.json().code).toBe('MIGRATION_TARGET_NOT_FOUND')
    }
    expect(await prisma.skillMigrationItem.count({ where: { migrationId: otherSession } })).toBe(0)
    const before = await prisma.skill.findUniqueOrThrow({ where: { id: mapToSkillId }, include: { versions: true } })
    const previous = config.SKILL_MAX_STORAGE_BYTES_PER_USER
    try {
      config.SKILL_MAX_STORAGE_BYTES_PER_USER = 1
      const precheck = await app.inject({ method: 'POST', url: `/api/migrations/${id}/precheck`, payload: { items: [item] } })
      expect(precheck.json().items[0]).toMatchObject({ status: 'ok', avatars: [] })
      const responses = await Promise.all([send(id, item), send(id, item)])
      expect(responses.map(response => response.statusCode)).toEqual([200, 200])
      expect(responses[0].json()).toMatchObject({ status: 'mapped', targetSkillId: mapToSkillId, version: original.version, avatars: [], errors: [] })
      expect(responses[1].json()).toEqual(responses[0].json())
      expect((await send(id, item)).json()).toEqual(responses[0].json())
      const read = (await app.inject(`/api/migrations/${id}`)).json().items
      expect(read.find((row: { operationKey: string }) => row.operationKey === migrations.operationKey(item)).result).toEqual(responses[0].json())
      expect((await send(id, { ...item, mapToSkillId: randomUUID() })).json().code).toBe('MIGRATION_PAYLOAD_MISMATCH')
    } finally { config.SKILL_MAX_STORAGE_BYTES_PER_USER = previous }
    expect(await prisma.skillMigrationItem.count({ where: { migrationId: id, operationKey: migrations.operationKey(item) } })).toBe(1)
    expect(await prisma.skill.findUniqueOrThrow({ where: { id: mapToSkillId }, include: { versions: true } })).toEqual(before)
    expect(await prisma.skillAvatar.count({ where: { skillId: mapToSkillId } })).toBe(0)
    expect(await prisma.skillMigrationAvatar.count({ where: { migrationId: id } })).toBe(0)
    expect(fal).not.toHaveBeenCalled(); expect(enqueue).not.toHaveBeenCalled()
  })
  it('serializes competing copy names and refuses mapping to a deleted Skill', async (): Promise<void> => {
    const id = await session(), targetName = `copy-${randomUUID()}`
    const responses = await Promise.all([send(id, plan({ targetName })), send(id, plan({ targetName }))])
    expect(responses.map(response => response.statusCode).sort()).toEqual([201, 409])
    const skill = await prisma.skill.findFirstOrThrow({ where: { authorId: owners[0], name: targetName, deletedAt: null } })
    expect(responses.find(response => response.statusCode === 409)!.json()).toMatchObject({ code: 'MIGRATION_NAME_CONFLICT', existingSkillId: skill.id })
    expect(await prisma.skill.count({ where: { authorId: owners[0], name: targetName } })).toBe(1)
    expect(await prisma.skillMigrationItem.count({ where: { migrationId: id } })).toBe(1)
    await prisma.skill.update({ where: { id: skill.id }, data: { deletedAt: new Date() } })
    const mapped = plan({ mapToSkillId: skill.id })
    const response = await send(id, mapped)
    expect(response.statusCode).toBe(404); expect(response.json().code).toBe('MIGRATION_TARGET_NOT_FOUND')
    expect(await prisma.skillMigrationItem.count({ where: { migrationId: id, operationKey: migrations.operationKey(mapped) } })).toBe(0)
    const available = plan({ targetName })
    const precheck = await app.inject({ method: 'POST', url: `/api/migrations/${id}/precheck`, payload: { items: [mapped, available] } })
    expect(precheck.json().items[0]).toMatchObject({ status: 'conflict', reason: 'MIGRATION_TARGET_NOT_FOUND' })
    expect(precheck.json().items[1]).toMatchObject({ status: 'ok' })
    expect((await send(id, available)).statusCode).toBe(201)
  })
})
