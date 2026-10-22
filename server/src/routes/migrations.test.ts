import { createHash } from 'node:crypto'
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify'
import sensible from '@fastify/sensible'
import { Prisma } from '@prisma/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => {
  const database = {
    skillMigration: { create: vi.fn(), findFirst: vi.fn() },
    cardGrant: { findUnique: vi.fn() },
    skillMigrationItem: { findUnique: vi.fn(), findMany: vi.fn(), create: vi.fn() },
    skillMigrationAvatar: { findUnique: vi.fn(), findMany: vi.fn(), create: vi.fn() },
    skill: { count: vi.fn(), findFirst: vi.fn(), create: vi.fn(), update: vi.fn() },
    skillVersion: { aggregate: vi.fn() }, user: { findUnique: vi.fn() }, avatarStyleVersion: { findUnique: vi.fn() },
    $queryRaw: vi.fn(), $executeRaw: vi.fn(), $transaction: vi.fn(),
  }
  return { database, prepareCard: vi.fn(), upload: vi.fn() }
})
vi.mock('../db.js', () => ({ db: mocks.database }))
vi.mock('../config.js', async () => {
  const { configSchema } = await import('../config-schema.js')
  return { config: configSchema.parse(process.env) }
})
vi.mock('../lib/skill-cards.js', async original => ({ ...await original<typeof import('../lib/skill-cards.js')>(), prepareCard: mocks.prepareCard }))
vi.mock('../lib/media.js', async original => ({ ...await original<typeof import('../lib/media.js')>(), uploadMedia: mocks.upload }))
vi.mock('../middleware/auth.js', () => ({
  authMiddleware: async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    if (!request.headers.authorization) return reply.code(401).send({ error: 'Unauthorized' })
    request.user = { id: 'target', email: 'test@example.invalid', displayName: 'Test', marketplaceRole: 'user' }
    request.verifiedAuthToken = { sub: 'target', ver: 0 }
  },
}))
import { migrationRoutes } from './migrations.js'
import { ItemPlan, operationKey, payloadHash } from '../lib/skill-migrations.js'
import { describeSkillPackage } from '../lib/skill-package.js'
import { config } from '../config.js'
import { canonicalJson, classicAvatarStyle } from '../lib/avatar-style-catalog.js'

const packageBase64 = 'UEsDBBQAAAAAAIKwQV26Df4KEQAAABEAAAAIAAAAU0tJTEwubWQjIEVkaXRvcmlhbCB0ZXN0ClBLAQIUAxQAAAAAAIKwQV26Df4KEQAAABEAAAAIAAAAAAAAAAAAAACAAQAAAABTS0lMTC5tZFBLBQYAAAAAAQABADYAAAA3AAAAAAA='
const bytes = Buffer.from(packageBase64, 'base64')
const sha = createHash('sha256').update(bytes).digest('hex')
const migrationId = '41100000-0000-4000-8000-000000000001'
const migration = { id: migrationId, targetUserId: 'target', sourceProfile: 'selfhost', sourceOrigin: 'https://source.invalid/skillhub', sourceUserId: 'source', protocolVersion: 1, createdAt: new Date() }
const item = ItemPlan.parse({ sourceOrigin: migration.sourceOrigin, sourceUserId: 'source', sourceSkillId: 'skill', contentHash: describeSkillPackage(bytes).contentHash,
  kind: 'own_skill', version: '0.1.0', name: 'migration-test', displayName: 'Migration test', packageSize: bytes.length, packageSha256: sha })
const headers = { authorization: 'Bearer test' }
const endpoint = `/api/migrations/${migrationId}`

describe('migration target routes', () => {
  let app: FastifyInstance
  beforeEach(async (): Promise<void> => {
    vi.resetAllMocks()
    mocks.database.$transaction.mockImplementation(async (fn: (tx: typeof mocks.database) => Promise<unknown>): Promise<unknown> => fn(mocks.database))
    mocks.database.skillMigration.findFirst.mockResolvedValue(migration)
    mocks.database.skillMigration.create.mockResolvedValue(migration)
    mocks.database.skillMigrationItem.findUnique.mockResolvedValue(null)
    mocks.database.skillMigrationItem.findMany.mockResolvedValue([])
    mocks.database.skillMigrationAvatar.findMany.mockResolvedValue([])
    mocks.database.skillMigrationAvatar.findUnique.mockResolvedValue(null)
    mocks.database.skillMigrationItem.create.mockImplementation(async ({ data }: { data: unknown }): Promise<unknown> => data)
    mocks.database.skill.count.mockResolvedValue(0)
    mocks.database.skill.findFirst.mockResolvedValue(null)
    mocks.database.skillVersion.aggregate.mockResolvedValue({ _sum: { packageSize: 0 } })
    mocks.database.user.findUnique.mockResolvedValue({ tokenVersion: 0 })
    mocks.database.avatarStyleVersion.findUnique.mockResolvedValue(null)
    mocks.prepareCard.mockResolvedValue({ sha256: sha, ...describeSkillPackage(bytes), size: bytes.length, storageKey: 'test', storageProvider: 'local' })
    app = Fastify(); await app.register(sensible); await app.register(migrationRoutes, { prefix: '/api/migrations' })
  })
  afterEach(async (): Promise<void> => { await app.close() })
  it('refuses to migrate known catalog bytes as an authored asset', async (): Promise<void> => {
    mocks.database.cardGrant.findUnique.mockResolvedValue({ reason: 'catalog' })
    const response = await app.inject({ method: 'POST', url: `${endpoint}/items`, headers, payload: { item, packageBase64 } })
    expect(response.statusCode, response.body).toBe(409); expect(response.json().code).toBe('CATALOG_NOT_AUTHORED')
    expect(mocks.database.skillMigrationItem.create).not.toHaveBeenCalled()
  })
  it('creates a normalized source descriptor and rejects unsupported protocols/credentials', async (): Promise<void> => {
    const response = await app.inject({ method: 'POST', url: '/api/migrations', headers, payload: { protocolVersion: 1, source: { profile: 'selfhost', origin: 'https://SOURCE.invalid:443/skillhub/', userId: 'source' } } })
    expect(response.statusCode).toBe(201)
    expect(mocks.database.skillMigration.create).toHaveBeenCalledWith({ data: expect.objectContaining({ sourceOrigin: migration.sourceOrigin, targetUserId: 'target' }) })
    for (const payload of [{ protocolVersion: 2 }, { protocolVersion: 1, source: { profile: 'selfhost', origin: 'https://user:password@source.invalid', userId: 'source' } }, { protocolVersion: 1, source: { profile: 'selfhost', origin: migration.sourceOrigin, userId: 'source', token: 'forbidden' } }]) {
      expect((await app.inject({ method: 'POST', url: '/api/migrations', headers, payload })).json()).toMatchObject({ code: 'MIGRATION_INVALID_REQUEST' })
    }
  })
  it('requires auth and returns 404 for a migration belonging to another target on every child route', async (): Promise<void> => {
    expect((await app.inject({ method: 'POST', url: '/api/migrations', payload: {} })).statusCode).toBe(401)
    mocks.database.skillMigration.findFirst.mockResolvedValue(null)
    for (const [method, url] of [['GET', endpoint], ['POST', `${endpoint}/precheck`], ['POST', `${endpoint}/items`], ['POST', `${endpoint}/avatars`]] as const) {
      expect((await app.inject({ method, url, headers, ...(method === 'POST' ? { payload: {} } : {}) })).json()).toEqual({ code: 'MIGRATION_NOT_FOUND', error: 'MIGRATION_NOT_FOUND' })
    }
    expect(mocks.database.skillMigration.findFirst).toHaveBeenCalledWith({ where: { id: migrationId, targetUserId: 'target' } })
  })
  it('reads stored results without returning payload fingerprints or contents', async (): Promise<void> => {
    const result = { operationKey: operationKey(item), status: 'imported', targetSkillId: 'created' }
    mocks.database.skillMigrationItem.findMany.mockResolvedValue([{ operationKey: operationKey(item), result }])
    expect((await app.inject({ url: endpoint, headers })).json()).toMatchObject({ items: [{ result }] })
    expect(mocks.database.skillMigrationItem.findMany).toHaveBeenCalledWith(expect.objectContaining({ select: { operationKey: true, result: true, statusCode: true, createdAt: true } }))
  })
  it('prechecks cumulative limits, repeated keys, changed payloads, and unknown avatar styles', async (): Promise<void> => {
    mocks.database.skill.count.mockResolvedValue(config.SKILL_MAX_PER_USER - 1)
    const avatar = { id: 'unknown', kind: 'generated', styleId: 'unknown', styleVersion: 1, mimeType: 'image/png', size: 33, sha256: 'a'.repeat(64) }
    const response = await app.inject({ method: 'POST', url: `${endpoint}/precheck`, headers, payload: { items: [item, item, { ...item, displayName: 'Changed' }, { ...item, sourceSkillId: 'second', avatars: [avatar] }] } })
    expect(response.statusCode, response.body).toBe(200)
    expect(response.json().items.map((i: { status: string }) => i.status)).toEqual(['ok', 'skip', 'conflict', 'over_quota'])
    expect(response.json().items[3].avatars[0]).toMatchObject({ status: 'skipped', reason: 'AVATAR_STYLE_UNAVAILABLE' })
    expect(response.json().limits).toMatchObject({ avatarCount: null, avatarStorageBytes: null })
  })
  it('imports without AI, stores a result and returns exactly that result on a lost-response retry', async (): Promise<void> => {
    const response = await app.inject({ method: 'POST', url: `${endpoint}/items`, headers, payload: { item, packageBase64 } })
    expect(response.statusCode, response.body).toBe(201)
    expect(response.json()).toMatchObject({ status: 'imported', version: '0.1.0', errors: [] })
    const saved = mocks.database.skillMigrationItem.create.mock.calls[0][0].data
    mocks.database.skillMigrationItem.findUnique.mockResolvedValue(saved)
    expect((await app.inject({ method: 'POST', url: `${endpoint}/items`, headers, payload: { item, packageBase64 } })).json()).toEqual(response.json())
    expect(mocks.database.skill.create).toHaveBeenCalledTimes(1)
    expect(mocks.prepareCard).toHaveBeenCalledTimes(1)
    expect(mocks.upload).not.toHaveBeenCalled()
  })
  it('returns 409 for metadata or bytes changed under the same operation key', async (): Promise<void> => {
    mocks.database.skillMigrationItem.findUnique.mockResolvedValue({ payloadHash: payloadHash(item), statusCode: 201, result: {} })
    for (const payload of [{ item: { ...item, description: 'Changed' }, packageBase64 }, { item, packageBase64: 'YWJj' }]) {
      const response = await app.inject({ method: 'POST', url: `${endpoint}/items`, headers, payload })
      expect(response.statusCode).toBe(409)
      expect(response.json().code).toBe('MIGRATION_PAYLOAD_MISMATCH')
    }
    expect(mocks.database.skill.create).not.toHaveBeenCalled()
  })
  it('reports name conflicts without completing the item, then imports a chosen copy name', async (): Promise<void> => {
    const existingSkillId = '41100000-0000-4000-8000-000000000002'
    mocks.database.skill.findFirst.mockResolvedValue({ id: existingSkillId, currentVersion: '1.0.0' })
    const precheck = await app.inject({ method: 'POST', url: `${endpoint}/precheck`, headers, payload: { items: [item] } })
    expect(precheck.json().items[0]).toMatchObject({ status: 'conflict', reason: 'name_exists', existingSkillId })
    for (const planned of [item, { ...item, targetName: 'occupied-copy' }]) {
      const response = await app.inject({ method: 'POST', url: `${endpoint}/items`, headers, payload: { item: planned, packageBase64 } })
      expect(response.statusCode).toBe(409)
      expect(response.json()).toMatchObject({ code: 'MIGRATION_NAME_CONFLICT', existingSkillId })
    }
    expect(mocks.database.skillMigrationItem.create).not.toHaveBeenCalled()
    expect(mocks.database.skill.create).not.toHaveBeenCalled()
    expect(mocks.prepareCard).not.toHaveBeenCalled()
    mocks.database.skill.findFirst.mockResolvedValue(null)
    const copy = { ...item, targetName: 'available-copy' }
    const response = await app.inject({ method: 'POST', url: `${endpoint}/items`, headers, payload: { item: copy, packageBase64 } })
    expect(response.statusCode, response.body).toBe(201)
    expect(mocks.database.skill.create).toHaveBeenCalledWith({ data: expect.objectContaining({ name: copy.targetName, versions: { create: expect.objectContaining({ skillName: copy.targetName }) } }) })
    mocks.database.skillMigrationItem.findUnique.mockResolvedValue(mocks.database.skillMigrationItem.create.mock.calls[0][0].data)
    expect((await app.inject({ method: 'POST', url: `${endpoint}/items`, headers, payload: { item: copy, packageBase64 } })).json()).toEqual(response.json())
    expect((await app.inject({ method: 'POST', url: `${endpoint}/items`, headers, payload: { item, packageBase64 } })).json().code).toBe('MIGRATION_PAYLOAD_MISMATCH')
  })
  it('maps only an owned active Skill, with no package, avatars or quota use, and replays the saved result', async (): Promise<void> => {
    const mapToSkillId = '41100000-0000-4000-8000-000000000002'
    const mapped = { ...item, mapToSkillId, avatars: [{ id: 'custom', kind: 'custom', mimeType: 'image/png', size: 33, sha256: 'a'.repeat(64) }] }
    const payload = { item: mapped }
    const missing = await app.inject({ method: 'POST', url: `${endpoint}/items`, headers, payload })
    expect(missing.statusCode).toBe(404); expect(missing.json().code).toBe('MIGRATION_TARGET_NOT_FOUND')
    expect(mocks.database.skill.findFirst).toHaveBeenCalledWith({ where: { id: mapToSkillId, authorId: 'target', deletedAt: null }, select: { id: true, currentVersion: true } })
    expect(mocks.database.skillMigrationItem.create).not.toHaveBeenCalled()
    mocks.database.skill.findFirst.mockResolvedValue({ id: mapToSkillId, currentVersion: '1.0.0' })
    mocks.database.skill.count.mockResolvedValue(config.SKILL_MAX_PER_USER * 20)
    const response = await app.inject({ method: 'POST', url: `${endpoint}/items`, headers, payload })
    expect(response.statusCode, response.body).toBe(200)
    expect(response.json()).toMatchObject({ status: 'mapped', targetSkillId: mapToSkillId, version: '1.0.0', avatars: [], errors: [] })
    expect(mocks.database.skill.count).not.toHaveBeenCalled()
    expect(mocks.database.skillMigrationAvatar.findUnique).not.toHaveBeenCalled()
    const precheck = await app.inject({ method: 'POST', url: `${endpoint}/precheck`, headers, payload: { items: [mapped] } })
    expect(precheck.json().items[0]).toMatchObject({ status: 'ok', avatars: [] })
    mocks.database.skillMigrationItem.findUnique.mockResolvedValue(mocks.database.skillMigrationItem.create.mock.calls[0][0].data)
    mocks.database.skill.findFirst.mockResolvedValue(null)
    expect((await app.inject({ method: 'POST', url: `${endpoint}/items`, headers, payload })).json()).toEqual(response.json())
    const changed = await app.inject({ method: 'POST', url: `${endpoint}/items`, headers, payload: { item: { ...mapped, mapToSkillId: migrationId } } })
    expect(changed.statusCode).toBe(409); expect(changed.json().code).toBe('MIGRATION_PAYLOAD_MISMATCH')
    expect(mocks.database.skillMigrationItem.create).toHaveBeenCalledTimes(1)
    expect(mocks.database.skill.create).not.toHaveBeenCalled(); expect(mocks.database.skill.update).not.toHaveBeenCalled()
    expect(mocks.prepareCard).not.toHaveBeenCalled(); expect(mocks.upload).not.toHaveBeenCalled()
  })
  it('validates copy names, mapping ids, mutually exclusive choices and package presence', async (): Promise<void> => {
    for (const payload of [
      { item }, { item: { ...item, targetName: '../invalid' }, packageBase64 },
      { item: { ...item, mapToSkillId: 'invalid' } }, { item: { ...item, mapToSkillId: migrationId }, packageBase64 },
      { item: { ...item, targetName: 'copy', mapToSkillId: migrationId } },
    ]) {
      const response = await app.inject({ method: 'POST', url: `${endpoint}/items`, headers, payload })
      expect(response.statusCode).toBe(400); expect(response.json().code).toBe('MIGRATION_INVALID_REQUEST')
    }
    expect(mocks.database.skillMigrationItem.create).not.toHaveBeenCalled()
  })
  it.each([
    ['P2002', 'MIGRATION_UNIQUE_CONFLICT'], ['P2003', 'MIGRATION_REFERENCE_CONFLICT'], ['P2004', 'MIGRATION_CONSTRAINT_CONFLICT'],
    ['P2011', 'MIGRATION_CONSTRAINT_CONFLICT'], ['P2014', 'MIGRATION_RELATION_CONFLICT'], ['P2025', 'MIGRATION_TARGET_CONFLICT'], ['P2034', 'MIGRATION_WRITE_CONFLICT'],
  ])('returns a sanitized 409 for %s', async (code, expected): Promise<void> => {
    mocks.database.skill.create.mockRejectedValue(new Prisma.PrismaClientKnownRequestError('private package and token', { code, clientVersion: '5.22.0', meta: { private: 'content' } }))
    const response = await app.inject({ method: 'POST', url: `${endpoint}/items`, headers, payload: { item, packageBase64 } })
    expect(response.statusCode).toBe(409); expect(response.json()).toEqual({ code: expected })
    expect(mocks.database.skillMigrationItem.create).not.toHaveBeenCalled()
  })
  it('uploads each image independently, skips unresolved styles, and replays without re-uploading', async (): Promise<void> => {
    const png = Buffer.alloc(33)
    Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]).copy(png)
    png.writeUInt32BE(13, 8); png.write('IHDR', 12); png.writeUInt32BE(256, 16); png.writeUInt32BE(256, 20)
    const avatar = { id: 'generated', kind: 'generated', styleId: 'classic', styleVersion: 1, mimeType: 'image/png', size: png.length, sha256: createHash('sha256').update(png).digest('hex') }
    const operation = { sourceOrigin: item.sourceOrigin, sourceUserId: item.sourceUserId, sourceSkillId: item.sourceSkillId, contentHash: item.contentHash }
    const payload = { operation, avatar, dataBase64: png.toString('base64') }
    const content = canonicalJson(classicAvatarStyle)
    mocks.database.avatarStyleVersion.findUnique.mockResolvedValue({ styleId: 'classic', styleVersion: 1, content, contentSha256: createHash('sha256').update(content).digest('hex') })
    mocks.upload.mockResolvedValue({ assetId: 'asset', url: '/media/test.png' })
    const response = await app.inject({ method: 'POST', url: `${endpoint}/avatars`, headers, payload })
    expect(response.statusCode, response.body).toBe(200)
    expect(response.json()).toMatchObject({ status: 'uploaded', id: 'generated' })
    const stored = mocks.database.skillMigrationAvatar.create.mock.calls[0][0].data
    mocks.database.skillMigrationAvatar.findUnique.mockResolvedValue(stored)
    expect((await app.inject({ method: 'POST', url: `${endpoint}/avatars`, headers, payload })).json()).toEqual(response.json())
    expect(mocks.upload).toHaveBeenCalledTimes(1)
    expect((await app.inject({ method: 'POST', url: `${endpoint}/avatars`, headers, payload: { ...payload, avatar: { ...avatar, styleVersion: 2 } } })).statusCode).toBe(409)
    mocks.database.skillMigrationAvatar.findUnique.mockResolvedValue(null)
    mocks.database.avatarStyleVersion.findUnique.mockResolvedValue(null)
    const skipped = await app.inject({ method: 'POST', url: `${endpoint}/avatars`, headers, payload })
    expect(skipped.json()).toMatchObject({ status: 'skipped', code: 'AVATAR_STYLE_UNAVAILABLE' })
    expect(mocks.upload).toHaveBeenCalledTimes(1)
    const malformed = await app.inject({ method: 'POST', url: `${endpoint}/avatars`, headers, payload: { ...payload, dataBase64: 'AAAA' } })
    expect(malformed.statusCode).toBe(400)
    expect(malformed.json().code).toBe('MIGRATION_HASH_MISMATCH')
  })
  it('requires staged avatar identities and rejects undeclared credential fields', async (): Promise<void> => {
    const withAvatar = { ...item, avatars: [{ id: 'custom', kind: 'custom', mimeType: 'image/png', size: 33, sha256: 'a'.repeat(64) }], selectedAvatarId: 'custom' }
    const response = await app.inject({ method: 'POST', url: `${endpoint}/items`, headers, payload: { item: withAvatar, packageBase64 } })
    expect(response.statusCode).toBe(409); expect(response.json().code).toBe('MIGRATION_AVATAR_NOT_UPLOADED')
    for (const url of [`${endpoint}/precheck`, `${endpoint}/items`, `${endpoint}/avatars`]) {
      const invalid = await app.inject({ method: 'POST', url, headers, payload: { item, packageBase64, token: 'forbidden' } })
      expect(invalid.statusCode).toBe(400); expect(invalid.json().code).toBe('MIGRATION_INVALID_REQUEST')
    }
    expect(mocks.database.skill.create).not.toHaveBeenCalled()
  })
  it('persists invalid package/hash results and rejects source mismatch without creating a Skill', async (): Promise<void> => {
    const cases = [
      { item, packageBase64: 'YWJj', error: 'MIGRATION_HASH_MISMATCH' },
      { item: { ...item, contentHash: 'a'.repeat(64) }, packageBase64, error: 'MIGRATION_CONTENT_INVALID' },
    ]
    for (const { error, ...payload } of cases) {
      const response = await app.inject({ method: 'POST', url: `${endpoint}/items`, headers, payload })
      expect(response.statusCode).toBe(400)
      expect(response.json().code ?? response.json().errors[0]).toBe(error)
    }
    const mismatched = await app.inject({ method: 'POST', url: `${endpoint}/items`, headers, payload: { item: { ...item, sourceUserId: 'other' }, packageBase64 } })
    expect(mismatched.json().code).toBe('MIGRATION_SOURCE_MISMATCH')
    expect(mocks.database.skill.create).not.toHaveBeenCalled()
  })
  it('enforces storage quota and final session validity inside the transaction', async (): Promise<void> => {
    mocks.database.skillVersion.aggregate.mockResolvedValue({ _sum: { packageSize: config.SKILL_MAX_STORAGE_BYTES_PER_USER } })
    const response = await app.inject({ method: 'POST', url: `${endpoint}/items`, headers, payload: { item, packageBase64 } })
    expect(response.statusCode).toBe(413); expect(response.json().errors).toEqual(['STORAGE_LIMIT'])
    mocks.database.user.findUnique.mockResolvedValue({ tokenVersion: 1 })
    expect((await app.inject({ method: 'POST', url: `${endpoint}/items`, headers, payload: { item, packageBase64 } })).statusCode).toBe(401)
    expect(mocks.database.skill.create).not.toHaveBeenCalled()
  })
  it('sanitizes unexpected failures and rate limits writes', async (): Promise<void> => {
    mocks.database.skillMigration.create.mockRejectedValue(new Error('private package and token'))
    const payload = { protocolVersion: 1, source: { profile: 'selfhost', origin: migration.sourceOrigin, userId: 'source' } }
    const response = await app.inject({ method: 'POST', url: '/api/migrations', headers, payload })
    expect(response.statusCode).toBe(503); expect(response.body).not.toContain('private')
    const original = config.MIGRATION_WRITES_PER_HOUR
    try {
      config.MIGRATION_WRITES_PER_HOUR = 1
      const limited = await app.inject({ method: 'POST', url: '/api/migrations', headers, payload })
      expect(limited.statusCode).toBe(429); expect(limited.headers['retry-after']).toBeDefined()
    } finally { config.MIGRATION_WRITES_PER_HOUR = original }
  })
  it('uses a separate migration budget shared by POST endpoints, while GET remains available', async (): Promise<void> => {
    const original = { migration: config.MIGRATION_WRITES_PER_HOUR, versions: config.SKILL_VERSION_WRITES_PER_HOUR }
    try {
      config.MIGRATION_WRITES_PER_HOUR = 2
      config.SKILL_VERSION_WRITES_PER_HOUR = 1
      const payload = { protocolVersion: 1, source: { profile: 'selfhost', origin: migration.sourceOrigin, userId: 'source' } }
      expect((await app.inject({ method: 'POST', url: '/api/migrations', headers, payload })).statusCode).toBe(201)
      expect((await app.inject({ method: 'POST', url: `${endpoint}/precheck`, headers, payload: { items: [] } })).statusCode).toBe(200)
      for (const url of [`${endpoint}/items`, `${endpoint}/avatars`]) {
        const response = await app.inject({ method: 'POST', url, headers, payload: {} })
        expect(response.statusCode).toBe(429)
        expect(response.json().code).toBe('MIGRATION_RATE_LIMIT')
      }
      expect((await app.inject({ url: endpoint, headers })).statusCode).toBe(200)
    } finally {
      config.MIGRATION_WRITES_PER_HOUR = original.migration
      config.SKILL_VERSION_WRITES_PER_HOUR = original.versions
    }
  })
})
