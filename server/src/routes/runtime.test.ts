import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify'
import sensible from '@fastify/sensible'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { encryptCredentialValue } from '../lib/credential-crypto.js'

const mockDb = vi.hoisted(() => ({
  $transaction: vi.fn(),
  user: { findUnique: vi.fn() },
  skill: { findUnique: vi.fn() },
  skillTeamShare: { findFirst: vi.fn(), findMany: vi.fn() },
  teamMember: { findMany: vi.fn() },
  teamCredential: { findMany: vi.fn() },
  teamCredentialVersion: { findMany: vi.fn() },
  credentialAuditEvent: { count: vi.fn(), create: vi.fn() },
}))
const mockConfig = vi.hoisted(() => ({
  CREDENTIAL_KEK_BASE64: 'QkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkI=',
  CREDENTIAL_KEK_VERSION: 7,
  CREDENTIAL_KEK_KEYRING_JSON: {} as Record<string, string>,
  RUNTIME_ENV_FETCHES_PER_MINUTE: 60,
}))
const mockLocks = vi.hoisted(() => ({
  lockUserMutation: vi.fn().mockResolvedValue(undefined),
  lockSkillTeamMutation: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('../db.js', () => ({ db: mockDb }))
vi.mock('../config.js', () => ({ config: mockConfig }))
vi.mock('../lib/mutation-lock.js', () => mockLocks)
vi.mock('../middleware/auth.js', () => ({
  authMiddleware: async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    if (!request.headers.authorization) {
      await reply.code(401).send({ error: 'Unauthorized' })
      return
    }
    request.user = { id: USER_ID, email: 'member@example.com', displayName: 'Member' }
    request.verifiedAuthToken = { sub: USER_ID, ver: AUTH_TOKEN_VERSION }
  },
}))

import { runtimeRoutes } from './runtime.js'

const USER_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const AUTHOR_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const SKILL_ID = '11111111-1111-4111-8111-111111111111'
const TEAM_ID = '22222222-2222-4222-8222-222222222222'
const CREDENTIAL_ID = '33333333-3333-4333-8333-333333333333'
const ENV_KEY = 'SERVICE_API_KEY'
const AUTH_TOKEN_VERSION = 7
const SECRET = 'team-secret-value'

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

function encryptedVersion(): Record<string, unknown> {
  return {
    credentialId: CREDENTIAL_ID,
    revision: 1,
    ...encryptCredentialValue(
      SECRET,
      {
        credentialId: CREDENTIAL_ID,
        teamId: TEAM_ID,
        envKey: ENV_KEY,
        revision: 1,
      },
      Buffer.alloc(32, 0x42),
      7
    ),
  }
}

async function buildApp(logs?: string[]): Promise<FastifyInstance> {
  const app = logs
    ? Fastify({
        logger: {
          level: 'error',
          stream: { write: (chunk: string): void => { logs.push(chunk) } },
        },
      })
    : Fastify()
  await app.register(sensible)
  await app.register(runtimeRoutes, { prefix: '/api/runtime' })
  await app.ready()
  return app
}

describe('runtime environment routes', () => {
  let app: FastifyInstance | undefined

  beforeEach(() => {
    vi.clearAllMocks()
    mockDb.$transaction.mockImplementation(
      async (callback: (client: typeof mockDb) => Promise<unknown>) => callback(mockDb)
    )
    mockDb.skill.findUnique.mockResolvedValue({
      id: SKILL_ID,
      authorId: AUTHOR_ID,
      envDependencies: [{ key: ENV_KEY, description: 'Service token', required: true }],
    })
    mockDb.user.findUnique.mockResolvedValue({ tokenVersion: AUTH_TOKEN_VERSION })
    mockDb.skillTeamShare.findFirst.mockResolvedValue({ skillId: SKILL_ID })
    mockDb.skillTeamShare.findMany.mockResolvedValue([{ teamId: TEAM_ID }])
    mockDb.teamMember.findMany.mockResolvedValue([{ teamId: TEAM_ID }])
    mockDb.credentialAuditEvent.count.mockResolvedValue(0)
    mockDb.credentialAuditEvent.create.mockResolvedValue({ id: 'audit-001' })
    mockDb.teamCredential.findMany.mockResolvedValue([{
      id: CREDENTIAL_ID,
      envKey: ENV_KEY,
      teamId: TEAM_ID,
      status: 'active',
      currentRevision: 1,
      exclusions: [],
      team: { name: 'Product Team' },
    }])
    mockDb.teamCredentialVersion.findMany.mockResolvedValue([encryptedVersion()])
  })

  afterEach(async () => {
    await app?.close()
    app = undefined
  })

  it('requires account authentication before reading source metadata', async () => {
    app = await buildApp()
    const response = await app.inject({
      method: 'GET',
      url: `/api/runtime/env/options?skillId=${SKILL_ID}`,
    })
    expect(response.statusCode).toBe(401)
    expect(response.headers['cache-control']).toBe('no-store, private')
    expect(mockDb.skill.findUnique).not.toHaveBeenCalled()
  })

  it('requires account authentication before resolving credentials', async () => {
    app = await buildApp()
    const response = await app.inject({
      method: 'POST',
      url: '/api/runtime/env',
      payload: { skillId: SKILL_ID, sources: [{ key: ENV_KEY, teamId: TEAM_ID }] },
    })
    expect(response.statusCode).toBe(401)
    expect(response.headers['cache-control']).toBe('no-store, private')
    expect(mockDb.$transaction).not.toHaveBeenCalled()
    expect(response.body).not.toContain(SECRET)
  })

  it('lists only in-scope team keys without returning values', async () => {
    app = await buildApp()
    const response = await app.inject({
      method: 'GET',
      url: `/api/runtime/env/options?skillId=${SKILL_ID}`,
      headers: { authorization: 'Bearer valid-session' },
    })
    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({
      skillId: SKILL_ID,
      dependencies: [{ key: ENV_KEY, description: 'Service token', required: true }],
      sources: [{ key: ENV_KEY, teamId: TEAM_ID, teamName: 'Product Team', revision: 1 }],
    })
    expect(response.body).not.toContain(SECRET)
    expect(mockDb.teamCredential.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        status: 'active',
        currentRevision: { gt: 0 },
        OR: [
          { envKey: { in: [ENV_KEY] } },
          { aliases: { some: { envKey: { in: [ENV_KEY] } } } },
        ],
        exclusions: { none: { skillId: SKILL_ID } },
        team: {
          dissolvedAt: null,
          members: { some: { userId: USER_ID } },
          skillShares: { some: { skillId: SKILL_ID } },
        },
      }),
    }))
  })

  describe('aliases', () => {
    const ALIAS_KEY = 'SERVICE_TOKEN'

    beforeEach(() => {
      mockDb.skill.findUnique.mockResolvedValue({
        id: SKILL_ID,
        authorId: AUTHOR_ID,
        envDependencies: [{ key: ALIAS_KEY, required: true }],
      })
      mockDb.teamCredential.findMany.mockResolvedValue([{
        id: CREDENTIAL_ID,
        envKey: ENV_KEY,
        teamId: TEAM_ID,
        status: 'active',
        currentRevision: 1,
        exclusions: [],
        aliases: [{ envKey: ALIAS_KEY }],
        team: { name: 'Product Team' },
      }])
    })

    it('offers a team key under the alias name the Skill declares', async () => {
      app = await buildApp()
      const response = await app.inject({
        method: 'GET',
        url: `/api/runtime/env/options?skillId=${SKILL_ID}`,
        headers: { authorization: 'Bearer valid-session' },
      })
      expect(response.statusCode).toBe(200)
      expect(response.json().sources).toEqual([{ key: ALIAS_KEY, teamId: TEAM_ID, teamName: 'Product Team', revision: 1 }])
      expect(response.body).not.toContain(SECRET)
    })

    it('resolves an alias to the key value under the requested name and audits the main key', async () => {
      app = await buildApp()
      const response = await app.inject({
        method: 'POST',
        url: '/api/runtime/env',
        headers: { authorization: 'Bearer valid-session' },
        payload: { skillId: SKILL_ID, sources: [{ key: ALIAS_KEY, teamId: TEAM_ID }] },
      })
      expect(response.statusCode).toBe(200)
      expect(response.json().credentials).toEqual([{ key: ALIAS_KEY, value: SECRET, teamId: TEAM_ID }])
      expect(mockDb.teamCredential.findMany).toHaveBeenCalledWith(expect.objectContaining({
        where: {
          status: 'active',
          OR: [{ teamId: TEAM_ID, OR: [{ envKey: ALIAS_KEY }, { aliases: { some: { envKey: ALIAS_KEY } } }] }],
        },
      }))
      expect(mockDb.credentialAuditEvent.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          outcome: 'success',
          bindingIds: [CREDENTIAL_ID],
          metadata: { keyCount: 1, teamCount: 1, viaKey: ENV_KEY },
        }),
      })
      expect(JSON.stringify(mockDb.credentialAuditEvent.create.mock.calls)).not.toContain(SECRET)
    })

    it('serves nothing to a Skill that declares neither the main name nor an alias', async () => {
      mockDb.skill.findUnique.mockResolvedValue({
        id: SKILL_ID,
        authorId: AUTHOR_ID,
        envDependencies: [{ key: 'UNRELATED_KEY', required: true }],
      })
      mockDb.teamCredential.findMany.mockResolvedValue([])
      app = await buildApp()
      const options = await app.inject({
        method: 'GET',
        url: `/api/runtime/env/options?skillId=${SKILL_ID}`,
        headers: { authorization: 'Bearer valid-session' },
      })
      expect(options.json().sources).toEqual([])
      const resolve = await app.inject({
        method: 'POST',
        url: '/api/runtime/env',
        headers: { authorization: 'Bearer valid-session' },
        payload: { skillId: SKILL_ID, sources: [{ key: ALIAS_KEY, teamId: TEAM_ID }] },
      })
      expect(resolve.statusCode).toBe(409)
      expect(resolve.json()).toEqual({ error: 'Environment key is not declared by the Skill Profile' })
      expect(resolve.body).not.toContain(SECRET)
      expect(mockDb.teamCredentialVersion.findMany).not.toHaveBeenCalled()
    })

    it('ignores a matched key whose names the Skill does not declare when building options', async () => {
      mockDb.teamCredential.findMany.mockResolvedValue([{
        id: CREDENTIAL_ID,
        envKey: ENV_KEY,
        teamId: TEAM_ID,
        currentRevision: 1,
        aliases: [{ envKey: 'OTHER_ALIAS' }],
        team: { name: 'Product Team' },
      }])
      app = await buildApp()
      const response = await app.inject({
        method: 'GET',
        url: `/api/runtime/env/options?skillId=${SKILL_ID}`,
        headers: { authorization: 'Bearer valid-session' },
      })
      expect(response.json().sources).toEqual([])
    })
  })

  it('refuses an excluded team key with 409 and an actionable message', async () => {
    mockDb.teamCredential.findMany.mockResolvedValue([{
      id: CREDENTIAL_ID,
      envKey: ENV_KEY,
      teamId: TEAM_ID,
      currentRevision: 1,
      exclusions: [{ skillId: SKILL_ID }],
    }])
    app = await buildApp()
    const response = await app.inject({
      method: 'POST',
      url: '/api/runtime/env',
      headers: { authorization: 'Bearer valid-session' },
      payload: { skillId: SKILL_ID, sources: [{ key: ENV_KEY, teamId: TEAM_ID }] },
    })
    expect(response.statusCode).toBe(409)
    expect(response.json().error).toContain(ENV_KEY)
    expect(response.body).not.toContain(SECRET)
    expect(mockDb.teamCredentialVersion.findMany).not.toHaveBeenCalled()
    expect(mockDb.credentialAuditEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ outcome: 'denied', reasonCode: 'team_key_excluded', bindingIds: [CREDENTIAL_ID] }),
    })
  })

  it('returns a selected Team value without device proof and audits retrieval', async () => {
    app = await buildApp()
    const response = await app.inject({
      method: 'POST',
      url: '/api/runtime/env',
      headers: { authorization: 'Bearer valid-session' },
      payload: { skillId: SKILL_ID, sources: [{ key: ENV_KEY, teamId: TEAM_ID }] },
    })
    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({
      dependencies: [{ key: ENV_KEY, description: 'Service token', required: true }],
      credentials: [{ key: ENV_KEY, value: SECRET, teamId: TEAM_ID }],
    })
    expect(mockLocks.lockUserMutation).toHaveBeenCalledWith(mockDb, USER_ID)
    expect(mockDb.user.findUnique).toHaveBeenCalledWith({
      where: { id: USER_ID },
      select: { tokenVersion: true },
    })
    expect(mockLocks.lockUserMutation.mock.invocationCallOrder[0])
      .toBeLessThan(mockDb.user.findUnique.mock.invocationCallOrder[0] ?? 0)
    expect(mockDb.user.findUnique.mock.invocationCallOrder[0])
      .toBeLessThan(mockDb.teamCredentialVersion.findMany.mock.invocationCallOrder[0] ?? 0)
    expect(mockLocks.lockSkillTeamMutation).toHaveBeenCalledWith(mockDb, SKILL_ID, TEAM_ID)
    expect(mockDb.credentialAuditEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        actorId: USER_ID,
        action: 'runtime_env_resolve',
        outcome: 'success',
        teamId: TEAM_ID,
        bindingIds: [CREDENTIAL_ID],
      }),
    })
  })

  it.each(['logout', 'password change'])(
    'rejects the request when a concurrent %s revocation wins the User lock',
    async () => {
      const lockStarted = deferred()
      const revocationCommitted = deferred()
      let currentTokenVersion = AUTH_TOKEN_VERSION
      mockLocks.lockUserMutation.mockImplementationOnce(async (): Promise<void> => {
        lockStarted.resolve()
        await revocationCommitted.promise
      })
      mockDb.user.findUnique.mockImplementation(async () => ({ tokenVersion: currentTokenVersion }))
      app = await buildApp()

      const pendingResponse = app.inject({
        method: 'POST',
        url: '/api/runtime/env',
        headers: { authorization: 'Bearer valid-session' },
        payload: { skillId: SKILL_ID, sources: [{ key: ENV_KEY, teamId: TEAM_ID }] },
      })
      await lockStarted.promise
      currentTokenVersion += 1
      revocationCommitted.resolve()
      const response = await pendingResponse

      expect(response.statusCode).toBe(401)
      expect(response.json()).toEqual({ error: 'Unauthorized' })
      expect(response.body).not.toContain(SECRET)
      expect(mockDb.credentialAuditEvent.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          actorId: USER_ID,
          outcome: 'denied',
          reasonCode: 'session_revoked',
          bindingIds: [],
          metadata: {},
        }),
      })
      expect(mockDb.credentialAuditEvent.count).not.toHaveBeenCalled()
      expect(mockDb.skill.findUnique).not.toHaveBeenCalled()
      expect(mockDb.teamCredentialVersion.findMany).not.toHaveBeenCalled()
    }
  )

  it('fails closed when an explicitly selected Team source disappears', async () => {
    mockDb.teamMember.findMany.mockResolvedValue([])
    app = await buildApp()
    const response = await app.inject({
      method: 'POST',
      url: '/api/runtime/env',
      headers: { authorization: 'Bearer valid-session' },
      payload: { skillId: SKILL_ID, sources: [{ key: ENV_KEY, teamId: TEAM_ID }] },
    })
    expect(response.statusCode).toBe(409)
    expect(response.json()).toEqual({ error: 'A selected Team source is no longer available' })
    expect(mockDb.teamCredentialVersion.findMany).not.toHaveBeenCalled()
    expect(mockDb.credentialAuditEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ outcome: 'denied', reasonCode: 'team_source_unavailable' }),
    })
  })

  it('honors team key revocation and never falls back to another source', async () => {
    mockDb.teamCredential.findMany.mockResolvedValue([])
    app = await buildApp()
    const response = await app.inject({
      method: 'POST',
      url: '/api/runtime/env',
      headers: { authorization: 'Bearer valid-session' },
      payload: { skillId: SKILL_ID, sources: [{ key: ENV_KEY, teamId: TEAM_ID }] },
    })
    expect(response.statusCode).toBe(409)
    expect(response.body).not.toContain(SECRET)
    expect(mockDb.teamCredentialVersion.findMany).not.toHaveBeenCalled()
  })

  it('honors Team share revocation and never falls back to another source', async () => {
    mockDb.skillTeamShare.findMany.mockResolvedValue([])
    app = await buildApp()
    const response = await app.inject({
      method: 'POST',
      url: '/api/runtime/env',
      headers: { authorization: 'Bearer valid-session' },
      payload: { skillId: SKILL_ID, sources: [{ key: ENV_KEY, teamId: TEAM_ID }] },
    })
    expect(response.statusCode).toBe(409)
    expect(response.json()).toEqual({ error: 'A selected Team source is no longer available' })
    expect(response.body).not.toContain(SECRET)
    expect(mockDb.teamCredentialVersion.findMany).not.toHaveBeenCalled()
  })

  it('rejects undeclared environment keys before reading a credential version', async () => {
    const undeclaredKey = 'UNDECLARED_API_KEY'
    app = await buildApp()
    const response = await app.inject({
      method: 'POST',
      url: '/api/runtime/env',
      headers: { authorization: 'Bearer valid-session' },
      payload: { skillId: SKILL_ID, sources: [{ key: undeclaredKey, teamId: TEAM_ID }] },
    })
    expect(response.statusCode).toBe(409)
    expect(response.json()).toEqual({ error: 'Environment key is not declared by the Skill Profile' })
    expect(mockDb.teamCredential.findMany).not.toHaveBeenCalled()
    expect(mockDb.teamCredentialVersion.findMany).not.toHaveBeenCalled()
  })

  it('rejects duplicate source keys before opening a transaction', async () => {
    app = await buildApp()
    const response = await app.inject({
      method: 'POST',
      url: '/api/runtime/env',
      headers: { authorization: 'Bearer valid-session' },
      payload: {
        skillId: SKILL_ID,
        sources: [
          { key: ENV_KEY, teamId: TEAM_ID },
          { key: ENV_KEY, teamId: TEAM_ID },
        ],
      },
    })
    expect(response.statusCode).toBe(400)
    expect(mockDb.$transaction).not.toHaveBeenCalled()
    expect(response.body).not.toContain(SECRET)
  })

  it('rate limits after session revalidation and before reading Skill credentials', async () => {
    mockDb.credentialAuditEvent.count.mockResolvedValue(mockConfig.RUNTIME_ENV_FETCHES_PER_MINUTE)
    app = await buildApp()
    const response = await app.inject({
      method: 'POST',
      url: '/api/runtime/env',
      headers: { authorization: 'Bearer valid-session' },
      payload: { skillId: SKILL_ID, sources: [{ key: ENV_KEY, teamId: TEAM_ID }] },
    })
    expect(response.statusCode).toBe(429)
    expect(mockDb.user.findUnique).toHaveBeenCalledOnce()
    expect(mockDb.skill.findUnique).not.toHaveBeenCalled()
    expect(mockDb.teamCredentialVersion.findMany).not.toHaveBeenCalled()
    expect(mockDb.credentialAuditEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ outcome: 'denied', reasonCode: 'rate_limited' }),
    })
  })

  it('fails closed when the selected team key has no current encrypted version', async () => {
    mockDb.teamCredentialVersion.findMany.mockResolvedValue([])
    app = await buildApp()
    const response = await app.inject({
      method: 'POST',
      url: '/api/runtime/env',
      headers: { authorization: 'Bearer valid-session' },
      payload: { skillId: SKILL_ID, sources: [{ key: ENV_KEY, teamId: TEAM_ID }] },
    })
    expect(response.statusCode).toBe(409)
    expect(response.json()).toEqual({ error: 'A selected Team source is no longer available' })
    expect(response.body).not.toContain(SECRET)
    expect(mockDb.credentialAuditEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        outcome: 'denied',
        reasonCode: 'team_source_unavailable',
        bindingIds: [CREDENTIAL_ID],
      }),
    })
  })

  it('returns a generic error and never logs plaintext when decryption fails', async () => {
    const logs: string[] = []
    const tamperedVersion = encryptedVersion()
    tamperedVersion.tag = Buffer.alloc(16, 0)
    mockDb.teamCredentialVersion.findMany.mockResolvedValue([tamperedVersion])
    app = await buildApp(logs)
    const response = await app.inject({
      method: 'POST',
      url: '/api/runtime/env',
      headers: { authorization: 'Bearer valid-session' },
      payload: { skillId: SKILL_ID, sources: [{ key: ENV_KEY, teamId: TEAM_ID }] },
    })
    expect(response.statusCode).toBe(503)
    expect(response.json()).toEqual({
      error: 'Runtime environment service is temporarily unavailable',
    })
    expect(response.body).not.toContain(SECRET)
    expect(logs.join('\n')).not.toContain(SECRET)
  })
})
