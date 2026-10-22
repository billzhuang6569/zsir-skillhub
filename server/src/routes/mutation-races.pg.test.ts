import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify'
import sensible from '@fastify/sensible'
import { PrismaClient } from '@prisma/client'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  lockExternalIdentityMutation,
  lockTeamMutation,
} from '../lib/mutation-lock.js'

const postgresUrl = process.env['SKILLHUB_PG_TEST_URL']
const AUTH_USER_ID = '11111111-1111-4111-8111-111111111111'
const OWNER_USER_ID = '22222222-2222-4222-8222-222222222222'
const TEAM_ID = '33333333-3333-4333-8333-333333333333'
const SKILL_ID = '44444444-4444-4444-8444-444444444444'
const VERSION_ID = '55555555-5555-4555-8555-555555555555'
const ENV_KEY = 'SERVICE_API_KEY'
const AUTHORIZATION = 'Bearer postgres-race-session'

type Deferred = {
  promise: Promise<void>
  resolve: () => void
}

function deferred(): Deferred {
  let resolve = (): void => undefined
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

const describePostgres = postgresUrl ? describe : describe.skip

describePostgres('PostgreSQL authorization mutation races', () => {
  let app: FastifyInstance
  let prisma: PrismaClient
  let control: PrismaClient

  beforeAll(async () => {
    if (!postgresUrl) return
    prisma = new PrismaClient({ datasources: { db: { url: postgresUrl } } })
    control = new PrismaClient({ datasources: { db: { url: postgresUrl } } })
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
      },
    }))
    vi.doMock('../middleware/auth.js', () => ({
      authMiddleware: async (request: FastifyRequest): Promise<void> => {
        request.user = {
          id: AUTH_USER_ID,
          email: 'race-author@example.com',
          displayName: 'Race Author',
        }
      },
    }))

    const [{ teamCredentialsRoutes }, { skillsRoutes }] = await Promise.all([
      import('./team-credentials.js'),
      import('./skills.js'),
    ])
    app = Fastify()
    await app.register(sensible)
    await app.register(teamCredentialsRoutes, { prefix: '/api/teams' })
    await app.register(skillsRoutes, { prefix: '/api/skills' })
    await app.ready()

    await prisma.credentialAuditEvent.deleteMany({
      where: { OR: [{ actorId: AUTH_USER_ID }, { skillId: SKILL_ID }, { teamId: TEAM_ID }] },
    })
    await prisma.teamCredential.deleteMany({ where: { teamId: TEAM_ID } })
    await prisma.skillTeamShare.deleteMany({ where: { skillId: SKILL_ID } })
    await prisma.skillVersion.deleteMany({ where: { skillId: SKILL_ID } })
    await prisma.skill.deleteMany({ where: { id: SKILL_ID } })
    await prisma.team.deleteMany({ where: { id: TEAM_ID } })
    await prisma.user.deleteMany({ where: { id: { in: [AUTH_USER_ID, OWNER_USER_ID] } } })

    await prisma.user.createMany({
      data: [
        { id: AUTH_USER_ID, email: 'race-author@example.com', displayName: 'Race Author' },
        { id: OWNER_USER_ID, email: 'race-owner@example.com', displayName: 'Race Owner' },
      ],
    })
    await prisma.team.create({
      data: {
        id: TEAM_ID,
        name: 'Race Team',
        ownerId: OWNER_USER_ID,
        members: {
          create: [
            { userId: OWNER_USER_ID, role: 'owner' },
            { userId: AUTH_USER_ID, role: 'member' },
          ],
        },
      },
    })
    await prisma.skill.create({
      data: {
        id: SKILL_ID,
        name: 'race-skill',
        displayName: 'Race Skill',
        authorId: AUTH_USER_ID,
        envDependencies: [{ key: ENV_KEY, required: true }],
        versions: {
          create: {
            id: VERSION_ID,
            version: 'v1.0',
            packageData: Buffer.from('installable-test-package'),
            packageSha256: '0'.repeat(64),
            packageSize: 24,
          },
        },
      },
    })
  })

  beforeEach(async () => {
    await prisma.teamCredential.deleteMany({ where: { teamId: TEAM_ID } })
    await prisma.skillTeamShare.deleteMany({ where: { skillId: SKILL_ID } })
    await prisma.team.update({ where: { id: TEAM_ID }, data: { dissolvedAt: null } })
    await prisma.teamMember.upsert({
      where: { teamId_userId: { teamId: TEAM_ID, userId: AUTH_USER_ID } },
      update: { role: 'member' },
      create: { teamId: TEAM_ID, userId: AUTH_USER_ID, role: 'member' },
    })
    await prisma.skill.update({
      where: { id: SKILL_ID },
      data: { envDependencies: [{ key: ENV_KEY, required: true }] },
    })
  })

  afterAll(async () => {
    if (!postgresUrl) return
    await app?.close()
    await prisma.credentialAuditEvent.deleteMany({
      where: { OR: [{ actorId: AUTH_USER_ID }, { skillId: SKILL_ID }, { teamId: TEAM_ID }] },
    })
    await prisma.teamCredential.deleteMany({ where: { teamId: TEAM_ID } })
    await prisma.skillTeamShare.deleteMany({ where: { skillId: SKILL_ID } })
    await prisma.skill.deleteMany({ where: { id: SKILL_ID } })
    await prisma.team.deleteMany({ where: { id: TEAM_ID } })
    await prisma.user.deleteMany({ where: { id: { in: [AUTH_USER_ID, OWNER_USER_ID] } } })
    await Promise.all([prisma.$disconnect(), control.$disconnect()])
    vi.doUnmock('../db.js')
    vi.doUnmock('../config.js')
    vi.doUnmock('../middleware/auth.js')
  })

  async function putTeamKey(value: string): Promise<number> {
    const response = await app.inject({
      method: 'PUT',
      url: `/api/teams/${TEAM_ID}/credentials/${ENV_KEY}`,
      headers: { authorization: AUTHORIZATION },
      payload: { value },
    })
    return response.statusCode
  }

  it('does not reactivate a team key after a dissolve transaction revokes it', async () => {
    expect(await putTeamKey('initial-secret')).toBe(201)
    const ready = deferred()
    const release = deferred()
    const dissolve = control.$transaction(async (transaction) => {
      await lockTeamMutation(transaction, TEAM_ID)
      await transaction.team.update({ where: { id: TEAM_ID }, data: { dissolvedAt: new Date() } })
      await transaction.teamCredential.updateMany({
        where: { teamId: TEAM_ID, status: 'active' },
        data: { status: 'revoked', revokedAt: new Date() },
      })
      ready.resolve()
      await release.promise
    })
    await ready.promise

    const rotate = putTeamKey('rotated-secret')
    release.resolve()
    await dissolve
    const statusCode = await rotate
    const credential = await prisma.teamCredential.findUnique({
      where: { teamId_envKey: { teamId: TEAM_ID, envKey: ENV_KEY } },
    })

    expect(statusCode).toBe(403)
    expect(credential?.status).toBe('revoked')
    expect(credential?.currentRevision).toBe(1)
  })

  it('does not recreate a Skill share after its author membership is removed', async () => {
    const ready = deferred()
    const release = deferred()
    const leave = control.$transaction(async (transaction) => {
      await lockTeamMutation(transaction, TEAM_ID)
      await transaction.teamMember.deleteMany({ where: { teamId: TEAM_ID, userId: AUTH_USER_ID } })
      await transaction.skillTeamShare.deleteMany({
        where: { teamId: TEAM_ID, skill: { authorId: AUTH_USER_ID } },
      })
      ready.resolve()
      await release.promise
    })
    await ready.promise

    const share = app.inject({
      method: 'POST',
      url: `/api/skills/${SKILL_ID}/shares`,
      payload: { teamId: TEAM_ID },
    })
    release.resolve()
    await leave
    const response = await share

    expect(response.statusCode).toBe(403)
    await expect(prisma.skillTeamShare.findUnique({
      where: { skillId_teamId: { skillId: SKILL_ID, teamId: TEAM_ID } },
    })).resolves.toBeNull()
  })

  it('does not let a removed member put a team key after the removal commits', async () => {
    const ready = deferred()
    const release = deferred()
    const removal = control.$transaction(async (transaction) => {
      await lockTeamMutation(transaction, TEAM_ID)
      await transaction.teamMember.deleteMany({ where: { teamId: TEAM_ID, userId: AUTH_USER_ID } })
      ready.resolve()
      await release.promise
    })
    await ready.promise

    const put = putTeamKey('late-secret')
    release.resolve()
    await removal
    const statusCode = await put

    expect(statusCode).toBe(403)
    await expect(prisma.teamCredential.findUnique({
      where: { teamId_envKey: { teamId: TEAM_ID, envKey: ENV_KEY } },
    })).resolves.toBeNull()
  })

  it('serializes the same external issuer and subject across real PostgreSQL connections', async () => {
    const firstAcquired = deferred()
    const releaseFirst = deferred()
    const secondStarted = deferred()
    let secondAcquired = false
    const issuer = 'https://account.example.test/realms/yitan'
    const subject = 'logout-before-link-race-subject'

    const first = prisma.$transaction(async (transaction) => {
      await lockExternalIdentityMutation(transaction, issuer, subject)
      firstAcquired.resolve()
      await releaseFirst.promise
    })
    await firstAcquired.promise

    const second = control.$transaction(async (transaction) => {
      secondStarted.resolve()
      await lockExternalIdentityMutation(transaction, issuer, subject)
      secondAcquired = true
    })
    await secondStarted.promise

    let wasBlocked = false
    try {
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 50))
      wasBlocked = !secondAcquired
    } finally {
      releaseFirst.resolve()
      await Promise.all([first, second])
    }

    expect(wasBlocked).toBe(true)
    expect(secondAcquired).toBe(true)
  })

})
