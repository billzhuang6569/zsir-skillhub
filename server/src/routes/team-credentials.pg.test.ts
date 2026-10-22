import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify'
import sensible from '@fastify/sensible'
import { PrismaClient } from '@prisma/client'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

// End-to-end team key vault behaviour on a real PostgreSQL database that has
// every migration applied (#254 acceptance list).

const postgresUrl = process.env['SKILLHUB_PG_TEST_URL']
const describePostgres = postgresUrl ? describe : describe.skip

const OWNER = '51000000-0000-4000-8000-000000000001'
const HOLDER = '51000000-0000-4000-8000-000000000002'
const MEMBER = '51000000-0000-4000-8000-000000000003'
const OUTSIDER = '51000000-0000-4000-8000-000000000004'
const TEAM = '52000000-0000-4000-8000-000000000001'
const SKILL_SHARED = '53000000-0000-4000-8000-000000000001'
const SKILL_UNDECLARED = '53000000-0000-4000-8000-000000000002'
const SKILL_UNSHARED = '53000000-0000-4000-8000-000000000003'
const SKILL_NEW = '53000000-0000-4000-8000-000000000004'
const SKILL_ALIAS = '53000000-0000-4000-8000-000000000005'
const USERS = [OWNER, HOLDER, MEMBER, OUTSIDER]
const SKILLS = [SKILL_SHARED, SKILL_UNDECLARED, SKILL_UNSHARED, SKILL_NEW, SKILL_ALIAS]
const KEY = 'FAL_KEY'
const ALIAS = 'FAL_API_KEY'
const OTHER_KEY = 'OTHER_API_KEY'
const SECRET = 'fal-team-secret-for-pg-test'
const ROTATED = 'fal-team-secret-rotated'

describePostgres('team key vault on PostgreSQL', () => {
  let app: FastifyInstance
  let prisma: PrismaClient

  async function cleanup(): Promise<void> {
    await prisma.notification.deleteMany({ where: { userId: { in: USERS } } })
    await prisma.credentialAuditEvent.deleteMany({ where: { OR: [{ actorId: { in: USERS } }, { teamId: TEAM }] } })
    await prisma.teamCredential.deleteMany({ where: { teamId: TEAM } })
    await prisma.skillTeamShare.deleteMany({ where: { teamId: TEAM } })
    await prisma.skillVersion.deleteMany({ where: { skillId: { in: SKILLS } } })
    await prisma.skill.deleteMany({ where: { id: { in: SKILLS } } })
    await prisma.team.deleteMany({ where: { id: TEAM } })
    await prisma.user.deleteMany({ where: { id: { in: USERS } } })
  }

  beforeAll(async () => {
    if (!postgresUrl) return
    prisma = new PrismaClient({ datasources: { db: { url: postgresUrl } } })
    vi.doMock('../db.js', () => ({ db: prisma }))
    vi.doMock('../config.js', () => ({
      config: {
        AI_API_BASE_URL: undefined,
        AI_API_KEY: undefined,
        AI_MODEL: 'test-model',
        AI_PROTOCOL: 'openai',
        AI_RATE_LIMIT_PER_MINUTE: 100,
        AI_GLOBAL_DAILY_LIMIT: 1000,
        AI_MAX_CONCURRENT: 2,
        AI_TIMEOUT_MS: 30_000,
        SKILL_MAX_PER_USER: 50,
        SKILL_MAX_VERSIONS_PER_SKILL: 30,
        SKILL_MAX_STORAGE_BYTES_PER_USER: 250 * 1024 * 1024,
        SKILL_VERSION_WRITES_PER_HOUR: 30,
        CREDENTIAL_KEK_BASE64: 'QkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkI=',
        CREDENTIAL_KEK_VERSION: 7,
        CREDENTIAL_KEK_KEYRING_JSON: {},
        CREDENTIAL_WRITES_PER_HOUR: 100,
        CREDENTIAL_MAX_VALUE_BYTES: 16_384,
        RUNTIME_ENV_FETCHES_PER_MINUTE: 1000,
      },
    }))
    vi.doMock('../middleware/auth.js', () => ({
      authMiddleware: async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
        const userId = request.headers['x-test-user']
        if (typeof userId !== 'string') {
          await reply.code(401).send({ error: 'Unauthorized' })
          return
        }
        request.user = { id: userId, email: `${userId}@example.com`, displayName: userId, marketplaceRole: 'user' }
        request.verifiedAuthToken = { sub: userId, ver: 0 }
      },
    }))
    const [{ teamCredentialsRoutes, legacyCredentialsRoutes }, { runtimeRoutes }, { teamsRoutes }, { skillsRoutes }] = await Promise.all([
      import('./team-credentials.js'),
      import('./runtime.js'),
      import('./teams.js'),
      import('./skills.js'),
    ])
    app = Fastify()
    await app.register(sensible)
    await app.register(teamsRoutes, { prefix: '/api/teams' })
    await app.register(teamCredentialsRoutes, { prefix: '/api/teams' })
    await app.register(legacyCredentialsRoutes, { prefix: '/api/credentials' })
    await app.register(runtimeRoutes, { prefix: '/api/runtime' })
    await app.register(skillsRoutes, { prefix: '/api/skills' })
    await app.ready()

    await cleanup()
    await prisma.user.createMany({
      data: USERS.map((id, index) => ({ id, email: `pg-key-${index}@example.com`, displayName: `User ${index}` })),
    })
    await prisma.team.create({
      data: {
        id: TEAM,
        name: 'Key Team',
        ownerId: OWNER,
        members: { create: [{ userId: OWNER, role: 'owner' }, { userId: HOLDER }, { userId: MEMBER }] },
      },
    })
    const declared = [{ key: KEY, description: 'fal.ai', required: true }]
    await prisma.skill.createMany({
      data: [
        { id: SKILL_SHARED, name: 'imagegen', displayName: '生图', authorId: OWNER, envDependencies: declared },
        { id: SKILL_UNDECLARED, name: 'plain', displayName: '无钥匙', authorId: OWNER, envDependencies: [] },
        { id: SKILL_UNSHARED, name: 'private', displayName: '未共享', authorId: OWNER, envDependencies: declared },
        { id: SKILL_NEW, name: 'later', displayName: '后来共享', authorId: OWNER, envDependencies: declared, currentVersion: 'v1.0' },
        { id: SKILL_ALIAS, name: 'alias', displayName: '别名', authorId: OWNER, envDependencies: [{ key: ALIAS, required: true }] },
      ],
    })
    await prisma.skillVersion.create({
      data: { skillId: SKILL_NEW, version: 'v1.0', packageData: Buffer.from('pkg'), packageSha256: '0'.repeat(64), packageSize: 3 },
    })
    await prisma.skillTeamShare.createMany({
      data: [
        { skillId: SKILL_SHARED, teamId: TEAM, sharedById: OWNER },
        { skillId: SKILL_UNDECLARED, teamId: TEAM, sharedById: OWNER },
        { skillId: SKILL_ALIAS, teamId: TEAM, sharedById: OWNER },
      ],
    })
  }, 60_000)

  afterAll(async () => {
    if (!postgresUrl) return
    await app?.close()
    await cleanup()
    await prisma.$disconnect()
    vi.doUnmock('../db.js')
    vi.doUnmock('../config.js')
    vi.doUnmock('../middleware/auth.js')
  })

  const as = (user: string) => ({ 'x-test-user': user })
  const resolve = (user: string, skillId: string) => app.inject({
    method: 'POST',
    url: '/api/runtime/env',
    headers: as(user),
    payload: { skillId, sources: [{ key: KEY, teamId: TEAM }] },
  })

  it('walks the team key lifecycle end to end', async () => {
    // Outsiders cannot put; any member can.
    expect((await app.inject({ method: 'PUT', url: `/api/teams/${TEAM}/credentials/${KEY}`, headers: as(OUTSIDER), payload: { value: SECRET } })).statusCode).toBe(403)
    const put = await app.inject({ method: 'PUT', url: `/api/teams/${TEAM}/credentials/${KEY}`, headers: as(HOLDER), payload: { value: SECRET } })
    expect(put.statusCode).toBe(201)
    expect(put.json()).toMatchObject({ key: KEY, teamId: TEAM, revision: 1, holderId: HOLDER })
    expect(put.body).not.toContain(SECRET)

    // Another member's runtime resolves it with zero configuration.
    const options = await app.inject({ method: 'GET', url: `/api/runtime/env/options?skillId=${SKILL_SHARED}`, headers: as(MEMBER) })
    expect(options.json().sources).toEqual([{ key: KEY, teamId: TEAM, teamName: 'Key Team', revision: 1 }])
    const resolved = await resolve(MEMBER, SKILL_SHARED)
    expect(resolved.statusCode).toBe(200)
    expect(resolved.json().credentials).toEqual([{ key: KEY, value: SECRET, teamId: TEAM }])

    // Metadata: holder, scope, last use; never a value or ciphertext.
    const listed = await app.inject({ method: 'GET', url: `/api/teams/${TEAM}/credentials`, headers: as(MEMBER) })
    expect(listed.statusCode).toBe(200)
    expect(listed.body).not.toContain(SECRET)
    expect(listed.body).not.toMatch(/"(value|ciphertext|wrappedDek)"/)
    const row = listed.json().credentials[0]
    expect(row).toMatchObject({ key: KEY, holder: { id: HOLDER }, revision: 1, canManage: false, exclusions: [] })
    expect(row.aliases).toEqual([])
    expect(row.inScopeSkills).toEqual([{ id: SKILL_SHARED, name: '生图', declaredKey: KEY }])
    expect(row.lastUsedAt).not.toBeNull()

    // Usage is visible to the holder and the team owner only.
    expect((await app.inject({ method: 'GET', url: `/api/teams/${TEAM}/credentials/${KEY}/usage`, headers: as(MEMBER) })).statusCode).toBe(403)
    for (const reader of [HOLDER, OWNER]) {
      const usage = await app.inject({ method: 'GET', url: `/api/teams/${TEAM}/credentials/${KEY}/usage?days=30`, headers: as(reader) })
      expect(usage.statusCode).toBe(200)
      expect(usage.body).not.toContain(SECRET)
      expect(usage.body).not.toMatch(/"(value|ciphertext)"/)
      expect(usage.json().usage).toEqual([expect.objectContaining({ actor: { id: MEMBER, displayName: 'User 2' }, skill: { id: SKILL_SHARED, name: '生图' }, count: 1 })])
    }

    // Aliases (#288): holder/owner only; one name belongs to one key per team.
    const aliasUrl = (key: string): string => `/api/teams/${TEAM}/credentials/${key}/aliases`
    expect((await app.inject({ method: 'PUT', url: aliasUrl(KEY), headers: as(MEMBER), payload: { aliases: [ALIAS] } })).statusCode).toBe(403)
    const aliased = await app.inject({ method: 'PUT', url: aliasUrl(KEY), headers: as(HOLDER), payload: { aliases: [ALIAS] } })
    expect(aliased.statusCode).toBe(200)
    expect(aliased.json()).toEqual({ key: KEY, teamId: TEAM, aliases: [ALIAS] })
    const aliasOptions = await app.inject({ method: 'GET', url: `/api/runtime/env/options?skillId=${SKILL_ALIAS}`, headers: as(MEMBER) })
    expect(aliasOptions.json().sources).toEqual([{ key: ALIAS, teamId: TEAM, teamName: 'Key Team', revision: 1 }])
    const viaAlias = await app.inject({ method: 'POST', url: '/api/runtime/env', headers: as(MEMBER), payload: { skillId: SKILL_ALIAS, sources: [{ key: ALIAS, teamId: TEAM }] } })
    expect(viaAlias.statusCode).toBe(200)
    expect(viaAlias.json().credentials).toEqual([{ key: ALIAS, value: SECRET, teamId: TEAM }])
    const aliasRow = (await app.inject({ method: 'GET', url: `/api/teams/${TEAM}/credentials`, headers: as(MEMBER) })).json().credentials[0]
    expect(aliasRow.aliases).toEqual([ALIAS])
    expect(aliasRow.inScopeSkills).toEqual(expect.arrayContaining([{ id: SKILL_ALIAS, name: '别名', declaredKey: ALIAS }]))
    expect((await app.inject({ method: 'PUT', url: `/api/teams/${TEAM}/credentials/${OTHER_KEY}`, headers: as(MEMBER), payload: { value: 'other' } })).statusCode).toBe(201)
    for (const [key, aliases, clashing] of [[OTHER_KEY, [ALIAS], ALIAS], [KEY, [ALIAS, OTHER_KEY], OTHER_KEY]] as const) {
      const conflict = await app.inject({ method: 'PUT', url: aliasUrl(key), headers: as(OWNER), payload: { aliases } })
      expect(conflict.statusCode).toBe(409)
      expect(conflict.json()).toMatchObject({ reasonCode: 'alias_conflict', key: clashing })
    }
    const takenName = await app.inject({ method: 'PUT', url: `/api/teams/${TEAM}/credentials/${ALIAS}`, headers: as(MEMBER), payload: { value: 'x' } })
    expect(takenName.statusCode).toBe(409)
    expect(takenName.json()).toMatchObject({ reasonCode: 'alias_conflict', key: ALIAS })
    const other = await prisma.teamCredential.findUniqueOrThrow({ where: { teamId_envKey: { teamId: TEAM, envKey: OTHER_KEY } } })
    await expect(prisma.teamCredentialAlias.create({
      data: { credentialId: other.id, teamId: TEAM, envKey: ALIAS, createdById: MEMBER },
    })).rejects.toMatchObject({ code: 'P2002' })
    expect((await app.inject({ method: 'PUT', url: aliasUrl(OTHER_KEY), headers: as(MEMBER), payload: { aliases: ['OTHER_TOKEN'] } })).statusCode).toBe(200)
    expect((await app.inject({ method: 'DELETE', url: `/api/teams/${TEAM}/credentials/${OTHER_KEY}`, headers: as(MEMBER) })).statusCode).toBe(204)
    expect(await prisma.teamCredentialAlias.count({ where: { credentialId: other.id } })).toBe(0)

    // Exclusion: only holder/owner; the excluded Skill gets 409 at runtime.
    const exclusionUrl = `/api/teams/${TEAM}/credentials/${KEY}/exclusions/${SKILL_SHARED}`
    expect((await app.inject({ method: 'PUT', url: exclusionUrl, headers: as(MEMBER) })).statusCode).toBe(403)
    expect((await app.inject({ method: 'PUT', url: exclusionUrl, headers: as(HOLDER) })).statusCode).toBe(200)
    const excluded = await resolve(MEMBER, SKILL_SHARED)
    expect(excluded.statusCode).toBe(409)
    expect(excluded.json().error).toContain(KEY)
    expect((await app.inject({ method: 'GET', url: `/api/runtime/env/options?skillId=${SKILL_SHARED}`, headers: as(MEMBER) })).json().sources).toEqual([])
    expect((await app.inject({ method: 'DELETE', url: exclusionUrl, headers: as(OWNER) })).statusCode).toBe(200)
    expect((await resolve(MEMBER, SKILL_SHARED)).statusCode).toBe(200)

    // A Skill that does not declare the key, or is not shared, gets nothing.
    expect((await resolve(MEMBER, SKILL_UNDECLARED)).statusCode).toBe(409)
    expect((await resolve(MEMBER, SKILL_UNSHARED)).statusCode).toBe(403)
    const ownerUnshared = await resolve(OWNER, SKILL_UNSHARED)
    expect(ownerUnshared.statusCode).toBe(409)
    expect(ownerUnshared.body).not.toContain(SECRET)

    // Sharing a new declaring Skill notifies the holder.
    expect((await app.inject({ method: 'POST', url: `/api/skills/${SKILL_NEW}/shares`, headers: as(OWNER), payload: { teamId: TEAM } })).statusCode).toBe(201)
    const notifications = await prisma.notification.findMany({ where: { userId: HOLDER, type: 'team_key_scope_added' } })
    expect(notifications).toHaveLength(1)
    expect(notifications[0]?.payload).toMatchObject({ teamId: TEAM, skillId: SKILL_NEW, keys: [KEY] })

    // Unsharing takes the Skill out of scope without revoking the key.
    expect((await app.inject({ method: 'DELETE', url: `/api/skills/${SKILL_NEW}/shares/${TEAM}`, headers: as(OWNER) })).statusCode).toBe(204)
    expect((await resolve(MEMBER, SKILL_NEW)).statusCode).toBe(403)
    expect((await resolve(MEMBER, SKILL_SHARED)).statusCode).toBe(200)

    // Plain members cannot revoke; the holder rotates to a new revision.
    expect((await app.inject({ method: 'DELETE', url: `/api/teams/${TEAM}/credentials/${KEY}`, headers: as(MEMBER) })).statusCode).toBe(403)
    const rotated = await app.inject({ method: 'PUT', url: `/api/teams/${TEAM}/credentials/${KEY}`, headers: as(HOLDER), payload: { value: ROTATED } })
    expect(rotated.statusCode).toBe(200)
    expect(rotated.json().revision).toBe(2)
    expect((await resolve(MEMBER, SKILL_SHARED)).json().credentials[0].value).toBe(ROTATED)

    // The holder leaves: the key stays with the team and keeps its holder id.
    expect((await app.inject({ method: 'POST', url: `/api/teams/${TEAM}/leave`, headers: as(HOLDER) })).statusCode).toBe(204)
    const kept = await prisma.teamCredential.findUniqueOrThrow({ where: { teamId_envKey: { teamId: TEAM, envKey: KEY } } })
    expect(kept).toMatchObject({ status: 'active', createdById: HOLDER })
    expect((await resolve(MEMBER, SKILL_SHARED)).statusCode).toBe(200)

    // Dissolving the team revokes every key.
    expect((await app.inject({ method: 'DELETE', url: `/api/teams/${TEAM}`, headers: as(OWNER) })).statusCode).toBe(204)
    const revoked = await prisma.teamCredential.findUniqueOrThrow({ where: { teamId_envKey: { teamId: TEAM, envKey: KEY } } })
    expect(revoked.status).toBe('revoked')
    const afterDissolve = await resolve(MEMBER, SKILL_SHARED)
    expect([403, 409]).toContain(afterDissolve.statusCode)
    expect(afterDissolve.body).not.toContain(ROTATED)
  }, 60_000)

  it('answers the retired binding API with 426', async () => {
    for (const [method, url] of [['PUT', '/api/credentials/bindings'], ['GET', '/api/credentials/metadata?skillId=x&teamId=y'], ['DELETE', '/api/credentials/bindings/abc']] as const) {
      const response = await app.inject({ method, url, headers: as(MEMBER) })
      expect(response.statusCode).toBe(426)
      expect(response.json().code).toBe('credential_api_retired')
    }
  })
})
