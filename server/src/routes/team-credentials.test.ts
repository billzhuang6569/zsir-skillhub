import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify'
import sensible from '@fastify/sensible'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { decryptCredentialValue } from '../lib/credential-crypto.js'

const mockDb = vi.hoisted(() => ({
  $transaction: vi.fn(),
  $queryRaw: vi.fn(),
  teamMember: { findUnique: vi.fn() },
  teamCredential: { findUnique: vi.fn(), findFirst: vi.fn(), findMany: vi.fn(), create: vi.fn(), update: vi.fn() },
  teamCredentialAlias: { findFirst: vi.fn(), findMany: vi.fn(), deleteMany: vi.fn(), createMany: vi.fn() },
  teamCredentialVersion: { create: vi.fn() },
  teamCredentialExclusion: { upsert: vi.fn(), deleteMany: vi.fn() },
  skillTeamShare: { findMany: vi.fn() },
  skill: { findUnique: vi.fn() },
  credentialAuditEvent: { count: vi.fn(), create: vi.fn() },
  teamActivity: { create: vi.fn() },
}))
const mockConfig = vi.hoisted(() => ({
  CREDENTIAL_KEK_BASE64: 'QkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkI=' as string | undefined,
  CREDENTIAL_KEK_VERSION: 7,
  CREDENTIAL_WRITES_PER_HOUR: 30,
  CREDENTIAL_MAX_VALUE_BYTES: 64,
}))
const mockLocks = vi.hoisted(() => ({
  lockTeamMutation: vi.fn().mockResolvedValue(undefined),
  lockSkillTeamMutation: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('../db.js', () => ({ db: mockDb }))
vi.mock('../config.js', () => ({ config: mockConfig }))
vi.mock('../lib/mutation-lock.js', () => mockLocks)
vi.mock('../middleware/auth.js', () => ({
  authMiddleware: async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const userId = request.headers['x-test-user']
    if (typeof userId !== 'string') {
      await reply.code(401).send({ error: 'Unauthorized' })
      return
    }
    request.user = { id: userId, email: 'user@example.com', displayName: 'User', marketplaceRole: 'user' }
  },
}))

import { legacyCredentialsRoutes, teamCredentialsRoutes } from './team-credentials.js'

const TEAM_ID = '22222222-2222-4222-8222-222222222222'
const OWNER_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const HOLDER_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const MEMBER_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const SKILL_ID = '11111111-1111-4111-8111-111111111111'
const CREDENTIAL_ID = '33333333-3333-4333-8333-333333333333'
const KEY = 'FAL_KEY'
const SECRET = 'fal-secret-value'

function expectKeyActivity(type: string, payload: Record<string, unknown>): void {
  expect(mockDb.teamActivity.create).toHaveBeenCalledOnce()
  expect(mockDb.teamActivity.create).toHaveBeenCalledWith({
    data: { teamId: TEAM_ID, actorId: expect.any(String), type, payload },
  })
  const serialized = JSON.stringify(mockDb.teamActivity.create.mock.calls)
  expect(serialized).not.toContain(SECRET)
  expect(serialized).not.toMatch(/"(value|ciphertext|email|token)"/)
}

function membership(): Record<string, unknown> {
  return { team: { id: TEAM_ID, name: 'Product', ownerId: OWNER_ID, dissolvedAt: null } }
}

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify()
  await app.register(sensible)
  await app.register(teamCredentialsRoutes, { prefix: '/api/teams' })
  await app.register(legacyCredentialsRoutes, { prefix: '/api/credentials' })
  await app.ready()
  return app
}

describe('team key vault routes', () => {
  let app: FastifyInstance | undefined

  beforeEach(() => {
    vi.clearAllMocks()
    mockConfig.CREDENTIAL_KEK_BASE64 = 'QkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkI='
    mockDb.$transaction.mockImplementation(async (callback: (client: typeof mockDb) => Promise<unknown>) => callback(mockDb))
    mockDb.teamMember.findUnique.mockResolvedValue(membership())
    mockDb.credentialAuditEvent.count.mockResolvedValue(0)
    mockDb.credentialAuditEvent.create.mockResolvedValue({})
    mockDb.teamActivity.create.mockResolvedValue({})
    mockDb.teamCredential.findUnique.mockResolvedValue(null)
    mockDb.teamCredential.create.mockResolvedValue({})
    mockDb.teamCredentialVersion.create.mockResolvedValue({})
    mockDb.teamCredential.update.mockResolvedValue({
      envKey: KEY, teamId: TEAM_ID, currentRevision: 1, createdById: MEMBER_ID, updatedAt: new Date('2026-10-13T00:00:00Z'),
    })
    mockDb.$queryRaw.mockResolvedValue([])
    mockDb.teamCredential.findFirst.mockResolvedValue(null)
    mockDb.teamCredentialAlias.findFirst.mockResolvedValue(null)
    mockDb.teamCredentialAlias.findMany.mockResolvedValue([])
    mockDb.teamCredentialAlias.deleteMany.mockResolvedValue({ count: 0 })
    mockDb.teamCredentialAlias.createMany.mockResolvedValue({ count: 0 })
  })

  afterEach(async () => {
    await app?.close()
    app = undefined
  })

  it('lets any active member put a key, encrypts it under the team AAD and never echoes it', async () => {
    app = await buildApp()
    const response = await app.inject({
      method: 'PUT',
      url: `/api/teams/${TEAM_ID}/credentials/${KEY}`,
      headers: { 'x-test-user': MEMBER_ID },
      payload: { value: SECRET },
    })
    expect(response.statusCode).toBe(201)
    expect(response.headers['cache-control']).toBe('no-store, private')
    expect(response.body).not.toContain(SECRET)
    expect(response.body).not.toMatch(/"(value|ciphertext)"/)
    expect(mockLocks.lockTeamMutation).toHaveBeenCalledWith(mockDb, TEAM_ID)
    const created = mockDb.teamCredential.create.mock.calls[0]?.[0] as { data: { id: string; createdById: string } }
    expect(created.data.createdById).toBe(MEMBER_ID)
    const version = mockDb.teamCredentialVersion.create.mock.calls[0]?.[0] as { data: Parameters<typeof decryptCredentialValue>[0] & { credentialId: string; revision: number } }
    expect(version.data.revision).toBe(1)
    expect(version.data.aadVersion).toBe(2)
    expect(decryptCredentialValue(version.data, { credentialId: created.data.id, teamId: TEAM_ID, envKey: KEY, revision: 1 }, new Map([[7, Buffer.alloc(32, 0x42)]]))).toBe(SECRET)
    expect(mockDb.credentialAuditEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ action: 'team_credential_write', outcome: 'success', teamId: TEAM_ID }),
    })
    expect(JSON.stringify(mockDb.credentialAuditEvent.create.mock.calls)).not.toContain(SECRET)
    expectKeyActivity('key_put', { envKey: KEY, holderId: MEMBER_ID })
  })

  it('rotates an existing key to the next revision and makes the writer its holder', async () => {
    mockDb.teamCredential.findUnique.mockResolvedValue({ id: CREDENTIAL_ID, currentRevision: 4, status: 'active' })
    app = await buildApp()
    const response = await app.inject({
      method: 'PUT',
      url: `/api/teams/${TEAM_ID}/credentials/${KEY}`,
      headers: { 'x-test-user': MEMBER_ID },
      payload: { value: SECRET },
    })
    expect(response.statusCode).toBe(200)
    expect(mockDb.teamCredential.create).not.toHaveBeenCalled()
    expect(mockDb.teamCredential.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: CREDENTIAL_ID },
      data: { currentRevision: 5, status: 'active', revokedAt: null, createdById: MEMBER_ID },
    }))
    expectKeyActivity('key_rotated', { envKey: KEY, holderId: MEMBER_ID })
  })

  it('records a restored key as rotated in the team activity', async () => {
    mockDb.teamCredential.findUnique.mockResolvedValue({ id: CREDENTIAL_ID, currentRevision: 2, status: 'revoked' })
    app = await buildApp()
    const response = await app.inject({
      method: 'PUT',
      url: `/api/teams/${TEAM_ID}/credentials/${KEY}`,
      headers: { 'x-test-user': MEMBER_ID },
      payload: { value: SECRET },
    })
    expect(response.statusCode).toBe(200)
    expectKeyActivity('key_rotated', { envKey: KEY, holderId: MEMBER_ID })
  })

  it.each([
    ['a non-member', null, 403],
    ['a member of a dissolved team', { team: { id: TEAM_ID, name: 'P', ownerId: OWNER_ID, dissolvedAt: new Date() } }, 403],
  ])('rejects %s', async (_label, member, status) => {
    mockDb.teamMember.findUnique.mockResolvedValue(member)
    app = await buildApp()
    const response = await app.inject({
      method: 'PUT',
      url: `/api/teams/${TEAM_ID}/credentials/${KEY}`,
      headers: { 'x-test-user': MEMBER_ID },
      payload: { value: SECRET },
    })
    expect(response.statusCode).toBe(status)
    expect(mockDb.teamCredentialVersion.create).not.toHaveBeenCalled()
  })

  it('validates key names, values and size before touching the database', async () => {
    app = await buildApp()
    const cases = [
      { url: `/api/teams/${TEAM_ID}/credentials/lower_case`, payload: { value: SECRET }, status: 400 },
      { url: `/api/teams/not-a-uuid/credentials/${KEY}`, payload: { value: SECRET }, status: 400 },
      { url: `/api/teams/${TEAM_ID}/credentials/${KEY}`, payload: { value: 'a\nb' }, status: 400 },
      { url: `/api/teams/${TEAM_ID}/credentials/${KEY}`, payload: { value: SECRET, extra: true }, status: 400 },
      { url: `/api/teams/${TEAM_ID}/credentials/${KEY}`, payload: { value: 'x'.repeat(65) }, status: 413 },
    ]
    for (const item of cases) {
      const response = await app.inject({ method: 'PUT', url: item.url, headers: { 'x-test-user': MEMBER_ID }, payload: item.payload })
      expect(response.statusCode, item.url).toBe(item.status)
    }
    expect(mockDb.$transaction).not.toHaveBeenCalled()
  })

  it('applies the hourly write limit', async () => {
    mockDb.credentialAuditEvent.count.mockResolvedValue(30)
    app = await buildApp()
    const response = await app.inject({
      method: 'PUT',
      url: `/api/teams/${TEAM_ID}/credentials/${KEY}`,
      headers: { 'x-test-user': MEMBER_ID },
      payload: { value: SECRET },
    })
    expect(response.statusCode).toBe(429)
    expect(mockDb.teamCredentialVersion.create).not.toHaveBeenCalled()
  })

  it('fails closed with 503 when the KEK is not configured', async () => {
    mockConfig.CREDENTIAL_KEK_BASE64 = undefined
    app = await buildApp()
    const response = await app.inject({
      method: 'PUT',
      url: `/api/teams/${TEAM_ID}/credentials/${KEY}`,
      headers: { 'x-test-user': MEMBER_ID },
      payload: { value: SECRET },
    })
    expect(response.statusCode).toBe(503)
    expect(mockDb.$transaction).not.toHaveBeenCalled()
  })

  it.each([
    [MEMBER_ID, 403],
    [HOLDER_ID, 204],
    [OWNER_ID, 204],
  ])('lets only the holder or team owner revoke (%s → %i)', async (userId, status) => {
    mockDb.teamCredential.findUnique.mockResolvedValue({ id: CREDENTIAL_ID, teamId: TEAM_ID, envKey: KEY, status: 'active', currentRevision: 2, createdById: HOLDER_ID })
    app = await buildApp()
    const response = await app.inject({ method: 'DELETE', url: `/api/teams/${TEAM_ID}/credentials/${KEY}`, headers: { 'x-test-user': userId } })
    expect(response.statusCode).toBe(status)
    if (status === 204) {
      expect(mockDb.teamCredential.update).toHaveBeenCalledWith({ where: { id: CREDENTIAL_ID }, data: { status: 'revoked', revokedAt: expect.any(Date) } })
      // Revoking frees the alias names; a later restore starts without aliases.
      expect(mockDb.teamCredentialAlias.deleteMany).toHaveBeenCalledWith({ where: { credentialId: CREDENTIAL_ID } })
      expectKeyActivity('key_revoked', { envKey: KEY })
    } else {
      expect(mockDb.teamActivity.create).not.toHaveBeenCalled()
      expect(mockDb.teamCredential.update).not.toHaveBeenCalled()
      expect(mockDb.teamCredentialAlias.deleteMany).not.toHaveBeenCalled()
    }
  })

  it('lets only the holder or team owner change exclusions, under the Skill/Team lock', async () => {
    mockDb.teamCredential.findUnique.mockResolvedValue({ id: CREDENTIAL_ID, teamId: TEAM_ID, envKey: KEY, status: 'active', currentRevision: 1, createdById: HOLDER_ID })
    mockDb.skill.findUnique.mockResolvedValue({ id: SKILL_ID, deletedAt: null })
    app = await buildApp()
    const url = `/api/teams/${TEAM_ID}/credentials/${KEY}/exclusions/${SKILL_ID}`
    expect((await app.inject({ method: 'PUT', url, headers: { 'x-test-user': MEMBER_ID } })).statusCode).toBe(403)
    const excluded = await app.inject({ method: 'PUT', url, headers: { 'x-test-user': HOLDER_ID } })
    expect(excluded.statusCode).toBe(200)
    expect(excluded.json()).toEqual({ key: KEY, skillId: SKILL_ID, excluded: true })
    expect(mockLocks.lockSkillTeamMutation).toHaveBeenCalledWith(mockDb, SKILL_ID, TEAM_ID)
    expect(mockDb.teamCredentialExclusion.upsert).toHaveBeenCalledWith({
      where: { credentialId_skillId: { credentialId: CREDENTIAL_ID, skillId: SKILL_ID } },
      update: {},
      create: { credentialId: CREDENTIAL_ID, skillId: SKILL_ID, createdById: HOLDER_ID },
    })
    const included = await app.inject({ method: 'DELETE', url, headers: { 'x-test-user': OWNER_ID } })
    expect(included.json()).toEqual({ key: KEY, skillId: SKILL_ID, excluded: false })
    expect(mockDb.teamCredentialExclusion.deleteMany).toHaveBeenCalledWith({ where: { credentialId: CREDENTIAL_ID, skillId: SKILL_ID } })
  })

  it('lists metadata with scope and exclusions but never values', async () => {
    mockDb.teamCredential.findMany.mockResolvedValue([{
      id: CREDENTIAL_ID,
      envKey: KEY,
      currentRevision: 2,
      createdById: HOLDER_ID,
      createdAt: new Date('2026-10-01T00:00:00Z'),
      updatedAt: new Date('2026-10-02T00:00:00Z'),
      createdBy: { id: HOLDER_ID, displayName: 'Holder' },
      exclusions: [{ skillId: 'skill-excluded', createdAt: new Date('2026-10-03T00:00:00Z'), skill: { displayName: 'Excluded' } }],
      aliases: [{ envKey: 'FAL_API_KEY' }],
    }])
    mockDb.skillTeamShare.findMany.mockResolvedValue([
      { skill: { id: SKILL_ID, displayName: '生图', envDependencies: [{ key: KEY }] } },
      { skill: { id: 'skill-alias', displayName: 'Alias Skill', envDependencies: [{ key: 'FAL_API_KEY' }] } },
      { skill: { id: 'skill-excluded', displayName: 'Excluded', envDependencies: [{ key: KEY }] } },
      { skill: { id: 'skill-other', displayName: 'Other', envDependencies: [{ key: 'OPENAI_API_KEY' }] } },
    ])
    mockDb.$queryRaw.mockResolvedValue([{ credentialId: CREDENTIAL_ID, lastUsedAt: new Date('2026-10-05T00:00:00Z') }])
    app = await buildApp()
    const response = await app.inject({ method: 'GET', url: `/api/teams/${TEAM_ID}/credentials`, headers: { 'x-test-user': OWNER_ID } })
    expect(response.statusCode).toBe(200)
    expect(response.body).not.toMatch(/"(value|ciphertext|wrappedDek|iv|tag)"/)
    expect(response.json()).toEqual({
      teamId: TEAM_ID,
      teamName: 'Product',
      isTeamOwner: true,
      credentials: [{
        key: KEY,
        aliases: ['FAL_API_KEY'],
        holder: { id: HOLDER_ID, displayName: 'Holder' },
        revision: 2,
        createdAt: '2026-10-01T00:00:00.000Z',
        updatedAt: '2026-10-02T00:00:00.000Z',
        canManage: true,
        inScopeSkills: [
          { id: SKILL_ID, name: '生图', declaredKey: KEY },
          { id: 'skill-alias', name: 'Alias Skill', declaredKey: 'FAL_API_KEY' },
        ],
        exclusions: [{ skillId: 'skill-excluded', name: 'Excluded', createdAt: '2026-10-03T00:00:00.000Z' }],
        lastUsedAt: '2026-10-05T00:00:00.000Z',
      }],
    })
    const listSelect = mockDb.teamCredential.findMany.mock.calls[0]?.[0] as { select: Record<string, unknown> }
    expect(Object.keys(listSelect.select)).not.toContain('versions')
  })

  it('refuses to create a key whose name is another active key\'s alias', async () => {
    mockDb.teamCredentialAlias.findFirst.mockResolvedValue({ credential: { envKey: KEY } })
    app = await buildApp()
    const response = await app.inject({
      method: 'PUT',
      url: `/api/teams/${TEAM_ID}/credentials/FAL_API_KEY`,
      headers: { 'x-test-user': MEMBER_ID },
      payload: { value: SECRET },
    })
    expect(response.statusCode).toBe(409)
    expect(response.json()).toEqual({ error: expect.stringContaining('FAL_API_KEY'), reasonCode: 'alias_conflict', key: 'FAL_API_KEY' })
    expect(response.body).not.toContain(SECRET)
    expect(mockDb.teamCredentialAlias.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: { teamId: TEAM_ID, envKey: 'FAL_API_KEY', credential: { status: 'active' } },
    }))
    expect(mockDb.teamCredential.create).not.toHaveBeenCalled()
    expect(mockDb.teamCredentialVersion.create).not.toHaveBeenCalled()
  })

  describe('aliases', () => {
    const url = `/api/teams/${TEAM_ID}/credentials/${KEY}/aliases`
    const activeKey = { id: CREDENTIAL_ID, teamId: TEAM_ID, envKey: KEY, status: 'active', currentRevision: 1, createdById: HOLDER_ID }

    it('lets the holder replace the alias set under the team lock and audits names only', async () => {
      mockDb.teamCredential.findUnique.mockResolvedValue(activeKey)
      mockDb.teamCredentialAlias.findMany.mockResolvedValue([{ envKey: 'FAL_OLD_KEY' }, { envKey: 'FAL_API_KEY' }])
      app = await buildApp()
      const response = await app.inject({
        method: 'PUT',
        url,
        headers: { 'x-test-user': HOLDER_ID },
        payload: { aliases: ['FAL_TOKEN', 'FAL_API_KEY', 'FAL_TOKEN'] },
      })
      expect(response.statusCode).toBe(200)
      expect(response.json()).toEqual({ key: KEY, teamId: TEAM_ID, aliases: ['FAL_API_KEY', 'FAL_TOKEN'] })
      expect(mockLocks.lockTeamMutation).toHaveBeenCalledWith(mockDb, TEAM_ID)
      expect(mockDb.teamCredential.findFirst).toHaveBeenCalledWith(expect.objectContaining({
        where: { teamId: TEAM_ID, status: 'active', envKey: { in: ['FAL_API_KEY', 'FAL_TOKEN'] }, id: { not: CREDENTIAL_ID } },
      }))
      expect(mockDb.teamCredentialAlias.deleteMany).toHaveBeenCalledWith({
        where: { credentialId: CREDENTIAL_ID, envKey: { notIn: ['FAL_API_KEY', 'FAL_TOKEN'] } },
      })
      expect(mockDb.teamCredentialAlias.createMany).toHaveBeenCalledWith({
        data: [{ credentialId: CREDENTIAL_ID, teamId: TEAM_ID, envKey: 'FAL_TOKEN', createdById: HOLDER_ID }],
      })
      expect(mockDb.credentialAuditEvent.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          action: 'team_credential_alias_write',
          outcome: 'success',
          bindingIds: [CREDENTIAL_ID],
          metadata: { envKey: KEY, aliases: ['FAL_API_KEY', 'FAL_TOKEN'] },
        }),
      })
    })

    it('lets the team owner clear every alias', async () => {
      mockDb.teamCredential.findUnique.mockResolvedValue(activeKey)
      app = await buildApp()
      const response = await app.inject({ method: 'PUT', url, headers: { 'x-test-user': OWNER_ID }, payload: { aliases: [] } })
      expect(response.statusCode).toBe(200)
      expect(response.json()).toEqual({ key: KEY, teamId: TEAM_ID, aliases: [] })
      expect(mockDb.teamCredentialAlias.deleteMany).toHaveBeenCalledWith({ where: { credentialId: CREDENTIAL_ID, envKey: { notIn: [] } } })
      expect(mockDb.teamCredentialAlias.createMany).not.toHaveBeenCalled()
    })

    it('refuses a member who is neither holder nor owner', async () => {
      mockDb.teamCredential.findUnique.mockResolvedValue(activeKey)
      app = await buildApp()
      const response = await app.inject({ method: 'PUT', url, headers: { 'x-test-user': MEMBER_ID }, payload: { aliases: ['FAL_API_KEY'] } })
      expect(response.statusCode).toBe(403)
      expect(mockDb.teamCredentialAlias.deleteMany).not.toHaveBeenCalled()
      expect(mockDb.teamCredentialAlias.createMany).not.toHaveBeenCalled()
    })

    it('answers 404 for a revoked or missing key', async () => {
      mockDb.teamCredential.findUnique.mockResolvedValue({ ...activeKey, status: 'revoked' })
      app = await buildApp()
      const response = await app.inject({ method: 'PUT', url, headers: { 'x-test-user': HOLDER_ID }, payload: { aliases: ['FAL_API_KEY'] } })
      expect(response.statusCode).toBe(404)
    })

    it('conflicts with another active key\'s main name', async () => {
      mockDb.teamCredential.findUnique.mockResolvedValue(activeKey)
      mockDb.teamCredential.findFirst.mockResolvedValue({ envKey: 'FAL_API_KEY' })
      app = await buildApp()
      const response = await app.inject({ method: 'PUT', url, headers: { 'x-test-user': HOLDER_ID }, payload: { aliases: ['FAL_API_KEY'] } })
      expect(response.statusCode).toBe(409)
      expect(response.json()).toEqual({ error: expect.stringContaining('FAL_API_KEY'), reasonCode: 'alias_conflict', key: 'FAL_API_KEY' })
      expect(mockDb.teamCredentialAlias.createMany).not.toHaveBeenCalled()
      expect(mockDb.teamCredentialAlias.deleteMany).not.toHaveBeenCalled()
    })

    it('conflicts with another key\'s alias', async () => {
      mockDb.teamCredential.findUnique.mockResolvedValue(activeKey)
      mockDb.teamCredentialAlias.findFirst.mockResolvedValue({ envKey: 'FAL_TOKEN', credential: { envKey: 'OTHER_KEY' } })
      app = await buildApp()
      const response = await app.inject({ method: 'PUT', url, headers: { 'x-test-user': OWNER_ID }, payload: { aliases: ['FAL_TOKEN'] } })
      expect(response.statusCode).toBe(409)
      const body = response.json() as { error: string; reasonCode: string; key: string }
      expect(body).toMatchObject({ reasonCode: 'alias_conflict', key: 'FAL_TOKEN' })
      expect(body.error).toContain('OTHER_KEY')
      expect(mockDb.teamCredentialAlias.findFirst).toHaveBeenCalledWith(expect.objectContaining({
        where: { teamId: TEAM_ID, envKey: { in: ['FAL_TOKEN'] }, credentialId: { not: CREDENTIAL_ID } },
      }))
      expect(mockDb.teamCredentialAlias.createMany).not.toHaveBeenCalled()
    })

    it('validates alias names before touching the database', async () => {
      app = await buildApp()
      const payloads = [
        { aliases: ['lower_case'] },
        { aliases: [KEY] },
        { aliases: Array.from({ length: 11 }, (_unused, index) => `KEY_${index}`) },
        { aliases: ['FAL_API_KEY'], extra: true },
        {},
      ]
      for (const payload of payloads) {
        const response = await app.inject({ method: 'PUT', url, headers: { 'x-test-user': HOLDER_ID }, payload })
        expect(response.statusCode, JSON.stringify(payload)).toBe(400)
      }
      expect(mockDb.$transaction).not.toHaveBeenCalled()
    })
  })

  it('keeps usage records to the holder and team owner', async () => {
    mockDb.teamCredential.findUnique.mockResolvedValue({ id: CREDENTIAL_ID, teamId: TEAM_ID, envKey: KEY, status: 'active', currentRevision: 1, createdById: HOLDER_ID })
    mockDb.$queryRaw.mockResolvedValue([{ actorId: MEMBER_ID, actorName: 'Member', skillId: SKILL_ID, skillName: '生图', count: 3, lastAt: new Date('2026-10-05T00:00:00Z') }])
    app = await buildApp()
    const url = `/api/teams/${TEAM_ID}/credentials/${KEY}/usage?days=7`
    expect((await app.inject({ method: 'GET', url, headers: { 'x-test-user': MEMBER_ID } })).statusCode).toBe(403)
    const response = await app.inject({ method: 'GET', url, headers: { 'x-test-user': HOLDER_ID } })
    expect(response.statusCode).toBe(200)
    expect(response.body).not.toMatch(/"(value|ciphertext)"/)
    expect(response.json()).toEqual({
      key: KEY,
      teamId: TEAM_ID,
      days: 7,
      usage: [{ actor: { id: MEMBER_ID, displayName: 'Member' }, skill: { id: SKILL_ID, name: '生图' }, count: 3, lastAt: '2026-10-05T00:00:00.000Z' }],
    })
    expect((await app.inject({ method: 'GET', url: `/api/teams/${TEAM_ID}/credentials/${KEY}/usage?days=365`, headers: { 'x-test-user': HOLDER_ID } })).statusCode).toBe(400)
  })

  it('answers the retired per-Skill binding API with 426 for old clients', async () => {
    app = await buildApp()
    for (const [method, url] of [['PUT', '/api/credentials/bindings'], ['GET', '/api/credentials/metadata'], ['DELETE', '/api/credentials/bindings/x']] as const) {
      const response = await app.inject({ method, url })
      expect(response.statusCode).toBe(426)
      expect(response.json()).toMatchObject({ code: 'credential_api_retired' })
    }
  })
})
