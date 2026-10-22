import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify'
import sensible from '@fastify/sensible'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mockDb = vi.hoisted(() => ({
  team: {
    create: vi.fn(),
    findUnique: vi.fn(),
    update: vi.fn(),
  },
  teamActivity: {
    findMany: vi.fn(),
  },
  teamMember: {
    findMany: vi.fn(),
    findUnique: vi.fn(),
    delete: vi.fn(),
    deleteMany: vi.fn(),
  },
  teamJoinRequest: {
    findMany: vi.fn(),
    findUnique: vi.fn(),
  },
  notification: {
    findMany: vi.fn(),
  },
  $transaction: vi.fn(),
}))

const mockCredentialLifecycle = vi.hoisted(() => ({
  revokeTeamCredentialsForTeam: vi.fn().mockResolvedValue({ credentials: 0 }),
  writeCredentialLifecycleAudit: vi.fn().mockResolvedValue(undefined),
}))
const mockMutationLocks = vi.hoisted(() => ({
  lockTeamMutation: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('../db.js', () => ({ db: mockDb }))
vi.mock('../lib/credential-lifecycle.js', () => mockCredentialLifecycle)
vi.mock('../lib/mutation-lock.js', () => mockMutationLocks)
vi.mock('../middleware/auth.js', () => ({
  authMiddleware: async (request: FastifyRequest): Promise<void> => {
    request.user = {
      id: 'user-001',
      email: 'user@example.com',
      displayName: '测试用户',
    }
  },
}))

import { teamsRoutes } from './teams.js'

function expectSafeActivityPayloads(create: ReturnType<typeof vi.fn>): void {
  expect(create).toHaveBeenCalled()
  for (const [argument] of create.mock.calls) {
    const payload = (argument as { data: { payload: Record<string, unknown> } }).data.payload
    for (const forbidden of ['value', 'ciphertext', 'email', 'token']) {
      expect(payload).not.toHaveProperty(forbidden)
    }
  }
}

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify()
  await app.register(sensible)
  await app.register(teamsRoutes, { prefix: '/api/teams' })
  await app.ready()
  return app
}

describe('teams routes', () => {
  let app: FastifyInstance | undefined

  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(async () => {
    await app?.close()
    app = undefined
  })

  it('returns the desktop team summary after creation', async () => {
    const createdAt = new Date('2026-08-02T00:00:00.000Z')
    const createdTeam = {
      id: 'team-001',
      name: '产品组',
      description: 'Skill 共建',
      color: '#3574f0',
      avatarUrl: 'https://cdn.example.com/team.png',
      ownerId: 'user-001',
      createdAt,
      updatedAt: createdAt,
      dissolvedAt: null,
      _count: { members: 1, skillShares: 0 },
    }
    const transaction = {
      team: { create: vi.fn().mockResolvedValue(createdTeam) },
      notification: { create: vi.fn().mockResolvedValue({ id: 'notification-created' }) },
    }
    mockDb.$transaction.mockImplementation(
      async (callback: (client: typeof transaction) => Promise<unknown>): Promise<unknown> => callback(transaction)
    )
    app = await buildApp()

    const response = await app.inject({
      method: 'POST',
      url: '/api/teams',
      payload: {
        name: '产品组',
        description: 'Skill 共建',
        color: '#3574f0',
        avatarUrl: 'https://cdn.example.com/team.png',
      },
    })

    expect(response.statusCode).toBe(201)
    expect(response.json()).toEqual({
      id: 'team-001',
      name: '产品组',
      description: 'Skill 共建',
      color: '#3574f0',
      avatarUrl: 'https://cdn.example.com/team.png',
      role: 'owner',
      memberCount: 1,
      sharedCount: 0,
      credentialCount: 0,
      dissolvedAt: null,
    })
    expect(mockDb.$transaction).toHaveBeenCalledOnce()
    expect(transaction.team.create).toHaveBeenCalledWith({
      data: {
        name: '产品组',
        description: 'Skill 共建',
        color: '#3574f0',
        avatarUrl: 'https://cdn.example.com/team.png',
        ownerId: 'user-001',
        members: { create: { userId: 'user-001', role: 'owner' } },
      },
      include: { _count: { select: { members: true, skillShares: true } } },
    })
    expect(transaction.notification.create).toHaveBeenCalledWith({
      data: {
        userId: 'user-001',
        type: 'team_created',
        payload: { teamId: 'team-001', teamName: '产品组' },
      },
    })
  })

  it('derives owned and joined roles from the canonical ownerId', async () => {
    const baseTeam = {
      name: '团队', description: null, color: '#3574f0', avatarUrl: null,
      dissolvedAt: null, _count: { members: 2, skillShares: 1, credentials: 3 },
    }
    mockDb.teamMember.findMany.mockResolvedValue([
      { role: 'member', team: { ...baseTeam, id: 'owned-team', ownerId: 'user-001' } },
      { role: 'owner', team: { ...baseTeam, id: 'joined-team', ownerId: 'other-user' } },
    ])
    app = await buildApp()

    const response = await app.inject({ method: 'GET', url: '/api/teams' })

    expect(response.statusCode).toBe(200)
    expect(response.json().map((team: { id: string; role: string }) => [team.id, team.role])).toEqual([
      ['owned-team', 'owner'],
      ['joined-team', 'member'],
    ])
    expect(response.json().map((team: { credentialCount: number }) => team.credentialCount)).toEqual([3, 3])
    expect(mockDb.teamMember.findMany).toHaveBeenCalledWith(expect.objectContaining({
      orderBy: { joinedAt: 'desc' },
      include: {
        team: {
          include: {
            _count: {
              select: {
                members: true,
                skillShares: true,
                credentials: { where: { status: 'active', currentRevision: { gt: 0 } } },
              },
            },
          },
        },
      },
    }))
  })

  it('rejects a non-HTTPS, invalid, or oversized avatar URL before creating a team', async () => {
    app = await buildApp()

    const insecureResponse = await app.inject({
      method: 'POST',
      url: '/api/teams',
      payload: { name: '产品组', avatarUrl: 'http://example.com/team.png' },
    })
    const invalidResponse = await app.inject({
      method: 'POST',
      url: '/api/teams',
      payload: { name: '产品组', avatarUrl: 'not-a-url' },
    })
    const oversizedResponse = await app.inject({
      method: 'POST',
      url: '/api/teams',
      payload: { name: '产品组', avatarUrl: `https://example.com/${'a'.repeat(2048)}` },
    })

    expect(insecureResponse.statusCode).toBe(400)
    expect(invalidResponse.statusCode).toBe(400)
    expect(oversizedResponse.statusCode).toBe(400)
    expect(mockDb.$transaction).not.toHaveBeenCalled()
  })

  it('rejects a non-HTTPS team avatar before looking up the team to update', async () => {
    app = await buildApp()

    const response = await app.inject({
      method: 'PATCH',
      url: '/api/teams/team-001',
      payload: { avatarUrl: 'http://example.com/team.png' },
    })

    expect(response.statusCode).toBe(400)
    expect(mockDb.team.findUnique).not.toHaveBeenCalled()
    expect(mockDb.team.update).not.toHaveBeenCalled()
  })

  it('returns an active team detail with owner identity and member emails', async () => {
    const createdAt = new Date('2026-08-02T00:00:00.000Z')
    mockDb.teamMember.findUnique.mockResolvedValue({
      teamId: 'team-001',
      userId: 'user-001',
      role: 'owner',
      team: { dissolvedAt: null },
    })
    mockDb.team.findUnique.mockResolvedValue({
      id: 'team-001',
      name: '产品组',
      description: 'Skill 共建',
      color: '#3574f0',
      avatarUrl: null,
      ownerId: 'user-001',
      createdAt,
      updatedAt: createdAt,
      dissolvedAt: null,
      owner: {
        id: 'user-001',
        displayName: '测试用户',
        avatarUrl: null,
        email: 'user@example.com',
      },
      members: [{
        teamId: 'team-001',
        userId: 'user-001',
        role: 'owner',
        joinedAt: createdAt,
        user: {
          id: 'user-001',
          displayName: '测试用户',
          avatarUrl: null,
          email: 'user@example.com',
        },
      }],
      _count: { skillShares: 0, credentials: 2 },
    })
    app = await buildApp()

    const response = await app.inject({ method: 'GET', url: '/api/teams/team-001' })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({
      id: 'team-001',
      owner: { id: 'user-001', displayName: '测试用户', email: 'user@example.com' },
      members: [{ user: { id: 'user-001', email: 'user@example.com' } }],
      credentialCount: 2,
    })
    expect(mockDb.team.findUnique).toHaveBeenCalledWith({
      where: { id: 'team-001' },
      include: {
        owner: { select: { id: true, displayName: true, avatarUrl: true, email: true } },
        members: {
          include: {
            user: { select: { id: true, displayName: true, avatarUrl: true, email: true } },
          },
        },
        _count: {
          select: {
            skillShares: true,
            credentials: { where: { status: 'active', currentRevision: { gt: 0 } } },
          },
        },
      },
    })
  })

  it('returns only the current active member notifications for a team', async () => {
    const createdAt = new Date('2026-08-02T00:00:00.000Z')
    mockDb.teamMember.findUnique.mockResolvedValue({
      teamId: 'team-001',
      userId: 'user-001',
      role: 'owner',
      team: { dissolvedAt: null },
    })
    mockDb.notification.findMany.mockResolvedValue([{
      id: 'notification-001',
      userId: 'user-001',
      type: 'team_created',
      payload: { teamId: 'team-001', teamName: '产品组' },
      read: false,
      createdAt,
    }])
    app = await buildApp()

    const response = await app.inject({
      method: 'GET',
      url: '/api/teams/team-001/notifications',
    })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toHaveLength(1)
    expect(mockDb.notification.findMany).toHaveBeenCalledWith({
      where: {
        userId: 'user-001',
        payload: { path: ['teamId'], equals: 'team-001' },
      },
      orderBy: { createdAt: 'desc' },
      take: 50,
    })
  })

  it('denies team notifications and members after the team is dissolved', async () => {
    mockDb.teamMember.findUnique.mockResolvedValue({
      teamId: 'team-001',
      userId: 'user-001',
      role: 'owner',
      team: { dissolvedAt: new Date('2026-08-03T00:00:00.000Z') },
    })
    app = await buildApp()

    const notificationResponse = await app.inject({
      method: 'GET',
      url: '/api/teams/team-001/notifications',
    })
    const membersResponse = await app.inject({
      method: 'GET',
      url: '/api/teams/team-001/members',
    })

    expect(notificationResponse.statusCode).toBe(403)
    expect(membersResponse.statusCode).toBe(403)
    expect(mockDb.notification.findMany).not.toHaveBeenCalled()
    expect(mockDb.teamMember.findMany).not.toHaveBeenCalled()
  })

  it('updates or clears a team avatar only while the team is active', async () => {
    // The outer read models the stale pre-lock state used by the old route.
    // Only the transaction-scoped read sees the concurrent dissolution.
    mockDb.team.findUnique.mockResolvedValue({
      id: 'team-001', name: '产品组', ownerId: 'user-001', dissolvedAt: null,
    })
    mockDb.team.update.mockResolvedValue({
      id: 'team-001', ownerId: 'user-001', avatarUrl: null, dissolvedAt: null,
    })
    const transaction = {
      team: {
        findUnique: vi.fn()
          .mockResolvedValueOnce({
            id: 'team-001', name: '产品组', ownerId: 'user-001', dissolvedAt: null,
          })
          .mockResolvedValueOnce({
            id: 'team-001',
            name: '产品组',
            ownerId: 'user-001',
            dissolvedAt: new Date('2026-08-03T00:00:00.000Z'),
          }),
        update: vi.fn().mockResolvedValue({
          id: 'team-001', ownerId: 'user-001', avatarUrl: null, dissolvedAt: null,
        }),
      },
    }
    mockDb.$transaction.mockImplementation(
      async (callback: (client: typeof transaction) => Promise<unknown>): Promise<unknown> => callback(transaction)
    )
    app = await buildApp()

    const response = await app.inject({
      method: 'PATCH',
      url: '/api/teams/team-001',
      payload: { avatarUrl: null },
    })

    expect(response.statusCode).toBe(200)
    expect(transaction.team.update).toHaveBeenCalledWith({
      where: { id: 'team-001' },
      data: { avatarUrl: null },
    })

    const dissolvedResponse = await app.inject({
      method: 'PATCH',
      url: '/api/teams/team-001',
      payload: { avatarUrl: 'https://cdn.example.com/new-team.png' },
    })

    expect(dissolvedResponse.statusCode).toBe(404)
    expect(transaction.team.update).toHaveBeenCalledTimes(1)
    expect(mockMutationLocks.lockTeamMutation).toHaveBeenCalledTimes(2)
    expect(mockMutationLocks.lockTeamMutation.mock.invocationCallOrder[1]).toBeLessThan(
      transaction.team.findUnique.mock.invocationCallOrder[1] ?? Number.MAX_SAFE_INTEGER
    )
  })

  it('rejects a join request when the user is already a member', async () => {
    const transaction = {
      team: { findUnique: vi.fn().mockResolvedValue({
        id: 'team-001', name: '产品组', ownerId: 'owner-001', dissolvedAt: null,
      }) },
      teamMember: { findUnique: vi.fn().mockResolvedValue({
        teamId: 'team-001', userId: 'user-001', role: 'member',
      }) },
      teamJoinRequest: { findUnique: vi.fn() },
    }
    mockDb.$transaction.mockImplementation(
      async (callback: (client: typeof transaction) => Promise<unknown>): Promise<unknown> => callback(transaction)
    )
    app = await buildApp()

    const response = await app.inject({
      method: 'POST',
      url: '/api/teams/team-001/requests',
    })

    expect(response.statusCode).toBe(409)
    expect(transaction.teamJoinRequest.findUnique).not.toHaveBeenCalled()
  })

  it('creates a join request and owner notification atomically', async () => {
    const joinRequest = {
      id: 'request-001',
      teamId: 'team-001',
      applicantId: 'user-001',
      invitedBy: null,
      status: 'pending',
      createdAt: new Date('2026-08-02T00:00:00.000Z'),
    }
    const transaction = {
      team: { findUnique: vi.fn().mockResolvedValue({
        id: 'team-001', name: '产品组', ownerId: 'owner-001', dissolvedAt: null,
      }) },
      teamMember: { findUnique: vi.fn().mockResolvedValue(null) },
      teamJoinRequest: {
        findUnique: vi.fn().mockResolvedValue(null),
        create: vi.fn().mockResolvedValue(joinRequest),
      },
      notification: { create: vi.fn().mockResolvedValue({ id: 'notification-001' }) },
    }
    mockDb.$transaction.mockImplementation(
      async (callback: (client: typeof transaction) => Promise<unknown>): Promise<unknown> => callback(transaction)
    )
    app = await buildApp()

    const response = await app.inject({
      method: 'POST',
      url: '/api/teams/team-001/requests',
    })

    expect(response.statusCode).toBe(201)
    expect(response.json()).toMatchObject({ id: 'request-001', status: 'pending' })
    expect(transaction.notification.create).toHaveBeenCalledWith({
      data: {
        userId: 'owner-001',
        type: 'join_request',
        payload: {
          teamId: 'team-001',
          teamName: '产品组',
          requestId: 'request-001',
          applicantId: 'user-001',
          applicantName: '测试用户',
        },
      },
    })
    expect(mockMutationLocks.lockTeamMutation).toHaveBeenCalledWith(transaction, 'team-001')
  })

  it('does not create a join request when the locked team is already dissolved', async () => {
    const staleActiveTeam = {
      id: 'team-001', name: '产品组', ownerId: 'owner-001', dissolvedAt: null,
    }
    const joinRequest = {
      id: 'request-001',
      teamId: 'team-001',
      applicantId: 'user-001',
      invitedBy: null,
      status: 'pending',
      createdAt: new Date('2026-08-03T00:00:00.000Z'),
    }
    mockDb.team.findUnique.mockResolvedValue(staleActiveTeam)
    mockDb.teamMember.findUnique.mockResolvedValue(null)
    mockDb.teamJoinRequest.findUnique.mockResolvedValue(null)
    const transaction = {
      team: { findUnique: vi.fn().mockResolvedValue({
        id: 'team-001',
        name: '产品组',
        ownerId: 'owner-001',
        dissolvedAt: new Date('2026-08-03T00:00:00.000Z'),
      }) },
      teamMember: { findUnique: vi.fn() },
      teamJoinRequest: {
        findUnique: vi.fn(),
        create: vi.fn().mockResolvedValue(joinRequest),
      },
      notification: { create: vi.fn().mockResolvedValue({}) },
    }
    mockDb.$transaction.mockImplementation(
      async (callback: (client: typeof transaction) => Promise<unknown>): Promise<unknown> => callback(transaction)
    )
    app = await buildApp()

    const response = await app.inject({
      method: 'POST',
      url: '/api/teams/team-001/requests',
    })

    expect(response.statusCode).toBe(404)
    expect(mockMutationLocks.lockTeamMutation).toHaveBeenCalledWith(transaction, 'team-001')
    expect(mockMutationLocks.lockTeamMutation.mock.invocationCallOrder[0]).toBeLessThan(
      transaction.team.findUnique.mock.invocationCallOrder[0] ?? Number.MAX_SAFE_INTEGER
    )
    expect(transaction.teamMember.findUnique).not.toHaveBeenCalled()
    expect(transaction.teamJoinRequest.create).not.toHaveBeenCalled()
    expect(transaction.notification.create).not.toHaveBeenCalled()
  })

  it('approves a pending request and marks its owner notification read atomically', async () => {
    const request = {
      id: 'request-001', teamId: 'team-001', applicantId: 'member-002', status: 'pending',
    }
    const transaction = {
      team: { findUnique: vi.fn().mockResolvedValue({
        id: 'team-001', name: '产品组', ownerId: 'user-001', dissolvedAt: null,
      }) },
      teamJoinRequest: {
        findUnique: vi.fn().mockResolvedValue(request),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      teamMember: { upsert: vi.fn().mockResolvedValue({}) },
      user: { findUnique: vi.fn().mockResolvedValue({ displayName: '新成员' }) },
      teamActivity: { create: vi.fn().mockResolvedValue({}) },
      notification: {
        create: vi.fn().mockResolvedValue({}),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
    }
    mockDb.$transaction.mockImplementation(
      async (callback: (client: typeof transaction) => Promise<unknown>): Promise<unknown> => callback(transaction)
    )
    app = await buildApp()

    const response = await app.inject({
      method: 'POST', url: '/api/teams/team-001/requests/request-001/approve',
    })

    expect(response.statusCode).toBe(204)
    expect(transaction.teamMember.upsert).toHaveBeenCalledWith({
      where: { teamId_userId: { teamId: 'team-001', userId: 'member-002' } },
      update: {},
      create: { teamId: 'team-001', userId: 'member-002', role: 'member' },
    })
    expect(transaction.teamActivity.create).toHaveBeenCalledWith({
      data: {
        teamId: 'team-001',
        actorId: 'member-002',
        type: 'member_joined',
        payload: { userId: 'member-002', displayName: '新成员', via: 'request', approvedById: 'user-001' },
      },
    })
    expectSafeActivityPayloads(transaction.teamActivity.create)
    expect(transaction.notification.updateMany).toHaveBeenCalledWith({
      where: {
        userId: 'user-001', type: 'join_request', read: false,
        payload: { path: ['requestId'], equals: 'request-001' },
      },
      data: { read: true },
    })
  })

  it('rejects a pending request and marks its owner notification read atomically', async () => {
    const request = {
      id: 'request-001', teamId: 'team-001', applicantId: 'member-002', status: 'pending',
    }
    const transaction = {
      team: { findUnique: vi.fn().mockResolvedValue({
        id: 'team-001', name: '产品组', ownerId: 'user-001', dissolvedAt: null,
      }) },
      teamJoinRequest: {
        findUnique: vi.fn().mockResolvedValue(request),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      notification: {
        create: vi.fn().mockResolvedValue({}),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
    }
    mockDb.$transaction.mockImplementation(
      async (callback: (client: typeof transaction) => Promise<unknown>): Promise<unknown> => callback(transaction)
    )
    app = await buildApp()

    const response = await app.inject({
      method: 'POST', url: '/api/teams/team-001/requests/request-001/reject',
    })

    expect(response.statusCode).toBe(204)
    expect(transaction.notification.updateMany).toHaveBeenCalledWith({
      where: {
        userId: 'user-001', type: 'join_request', read: false,
        payload: { path: ['requestId'], equals: 'request-001' },
      },
      data: { read: true },
    })
  })

  it.each(['approve', 'reject'] as const)(
    'does not %s a request after the locked team has been dissolved',
    async (action) => {
      const staleActiveTeam = {
        id: 'team-001', name: '产品组', ownerId: 'user-001', dissolvedAt: null,
      }
      const request = {
        id: 'request-001', teamId: 'team-001', applicantId: 'member-002', status: 'pending',
      }
      mockDb.team.findUnique.mockResolvedValue(staleActiveTeam)
      mockDb.teamJoinRequest.findUnique.mockResolvedValue(request)
      const transaction = {
        team: { findUnique: vi.fn().mockResolvedValue({
          id: 'team-001',
          name: '产品组',
          ownerId: 'user-001',
          dissolvedAt: new Date('2026-08-03T00:00:00.000Z'),
        }) },
        teamJoinRequest: {
          findUnique: vi.fn(),
          updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        },
        teamMember: { upsert: vi.fn().mockResolvedValue({}) },
        notification: {
          create: vi.fn().mockResolvedValue({}),
          updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        },
      }
      mockDb.$transaction.mockImplementation(
        async (callback: (client: typeof transaction) => Promise<unknown>): Promise<unknown> => callback(transaction)
      )
      app = await buildApp()

      const response = await app.inject({
        method: 'POST',
        url: `/api/teams/team-001/requests/request-001/${action}`,
      })

      expect(response.statusCode).toBe(404)
      expect(mockMutationLocks.lockTeamMutation).toHaveBeenCalledWith(transaction, 'team-001')
      expect(transaction.teamJoinRequest.findUnique).not.toHaveBeenCalled()
      expect(transaction.teamJoinRequest.updateMany).not.toHaveBeenCalled()
      expect(transaction.teamMember.upsert).not.toHaveBeenCalled()
      expect(transaction.notification.create).not.toHaveBeenCalled()
    }
  )

  it('removes all Skill shares and revokes team keys when dissolving a team', async () => {
    const transaction = {
      teamMember: { findMany: vi.fn().mockResolvedValue([{ userId: 'member-002' }]) },
      team: {
        findUnique: vi.fn().mockResolvedValue({
          id: 'team-001', name: '产品组', ownerId: 'user-001', dissolvedAt: null,
        }),
        update: vi.fn().mockResolvedValue({}),
      },
      skillTeamShare: { deleteMany: vi.fn().mockResolvedValue({ count: 3 }) },
      notification: { createMany: vi.fn().mockResolvedValue({ count: 1 }) },
    }
    mockDb.$transaction.mockImplementation(
      async (callback: (client: typeof transaction) => Promise<unknown>): Promise<unknown> => callback(transaction)
    )
    app = await buildApp()

    const response = await app.inject({ method: 'DELETE', url: '/api/teams/team-001' })

    expect(response.statusCode).toBe(204)
    expect(mockCredentialLifecycle.revokeTeamCredentialsForTeam).toHaveBeenCalledWith(transaction, 'team-001', expect.any(Date))
    expect(transaction.skillTeamShare.deleteMany).toHaveBeenCalledWith({ where: { teamId: 'team-001' } })
    expect(transaction.notification.createMany).toHaveBeenCalledWith({
      data: [{
        userId: 'member-002',
        type: 'team_dissolved',
        payload: { teamId: 'team-001', teamName: '产品组' },
      }],
    })
    expect(mockMutationLocks.lockTeamMutation).toHaveBeenCalledWith(transaction, 'team-001')
    expect(mockMutationLocks.lockTeamMutation.mock.invocationCallOrder[0]).toBeLessThan(
      transaction.teamMember.findMany.mock.invocationCallOrder[0] ?? Number.MAX_SAFE_INTEGER
    )
  })

  it('makes a concurrent repeated dissolve a no-op after the team lock is acquired', async () => {
    const transaction = {
      team: {
        findUnique: vi.fn().mockResolvedValue({
          id: 'team-001',
          name: '产品组',
          ownerId: 'user-001',
          dissolvedAt: new Date('2026-08-03T00:00:00.000Z'),
        }),
        update: vi.fn(),
      },
      teamMember: { findMany: vi.fn() },
      skillTeamShare: { deleteMany: vi.fn() },
      notification: { createMany: vi.fn() },
    }
    mockDb.$transaction.mockImplementation(
      async (callback: (client: typeof transaction) => Promise<unknown>): Promise<unknown> => callback(transaction)
    )
    app = await buildApp()

    const response = await app.inject({ method: 'DELETE', url: '/api/teams/team-001' })

    expect(response.statusCode).toBe(404)
    expect(transaction.team.update).not.toHaveBeenCalled()
    expect(transaction.teamMember.findMany).not.toHaveBeenCalled()
    expect(transaction.skillTeamShare.deleteMany).not.toHaveBeenCalled()
  })

  it('does not allow the owner membership to be removed', async () => {
    const transaction = {
      team: { findUnique: vi.fn().mockResolvedValue({
        id: 'team-001', name: '产品组', ownerId: 'user-001', dissolvedAt: null,
      }) },
      teamMember: { deleteMany: vi.fn() },
    }
    mockDb.$transaction.mockImplementation(
      async (callback: (client: typeof transaction) => Promise<unknown>): Promise<unknown> => callback(transaction)
    )
    app = await buildApp()

    const response = await app.inject({
      method: 'DELETE',
      url: '/api/teams/team-001/members/user-001',
    })

    expect(response.statusCode).toBe(400)
    expect(transaction.teamMember.deleteMany).not.toHaveBeenCalled()
  })

  it('atomically removes authored Skill shares but keeps team keys when a member leaves', async () => {
    const transaction = {
      team: { findUnique: vi.fn().mockResolvedValue({
        id: 'team-001', name: '产品组', ownerId: 'owner-001', dissolvedAt: null,
      }) },
      skillTeamShare: { deleteMany: vi.fn().mockResolvedValue({ count: 1 }) },
      teamMember: { deleteMany: vi.fn().mockResolvedValue({ count: 1 }) },
      user: { findUnique: vi.fn().mockResolvedValue({ displayName: '被移出的成员' }) },
      teamActivity: { create: vi.fn().mockResolvedValue({}) },
      notification: { create: vi.fn().mockResolvedValue({}) },
    }
    mockDb.$transaction.mockImplementation(
      async (callback: (client: typeof transaction) => Promise<unknown>): Promise<unknown> => callback(transaction)
    )
    app = await buildApp()

    const response = await app.inject({ method: 'POST', url: '/api/teams/team-001/leave' })

    expect(response.statusCode).toBe(204)
    const authoredInTeam = { teamId: 'team-001', skill: { authorId: 'user-001' } }
    expect(mockCredentialLifecycle.revokeTeamCredentialsForTeam).not.toHaveBeenCalled()
    expect(transaction.skillTeamShare.deleteMany).toHaveBeenCalledWith({ where: authoredInTeam })
    expect(transaction.teamMember.deleteMany).toHaveBeenCalledWith({
      where: { teamId: 'team-001', userId: 'user-001' },
    })
    expect(transaction.teamActivity.create).toHaveBeenCalledWith({
      data: {
        teamId: 'team-001',
        actorId: 'user-001',
        type: 'member_left',
        payload: { userId: 'user-001', displayName: '测试用户' },
      },
    })
    expectSafeActivityPayloads(transaction.teamActivity.create)
    expect(mockMutationLocks.lockTeamMutation).toHaveBeenCalledWith(transaction, 'team-001')
  })

  it('returns a controlled 404 when a non-member tries to leave', async () => {
    const transaction = {
      team: { findUnique: vi.fn().mockResolvedValue({
        id: 'team-001', name: '产品组', ownerId: 'owner-001', dissolvedAt: null,
      }) },
      teamMember: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }) },
      skillTeamShare: { deleteMany: vi.fn() },
      notification: { create: vi.fn() },
    }
    mockDb.$transaction.mockImplementation(
      async (callback: (client: typeof transaction) => Promise<unknown>): Promise<unknown> => callback(transaction)
    )
    app = await buildApp()

    const response = await app.inject({ method: 'POST', url: '/api/teams/team-001/leave' })

    expect(response.statusCode).toBe(404)
    expect(transaction.skillTeamShare.deleteMany).not.toHaveBeenCalled()
    expect(transaction.notification.create).not.toHaveBeenCalled()
  })

  it('atomically removes a removed member authored Skill shares but keeps team keys', async () => {
    const transaction = {
      team: { findUnique: vi.fn().mockResolvedValue({
        id: 'team-001', name: '产品组', ownerId: 'user-001', dissolvedAt: null,
      }) },
      skillTeamShare: { deleteMany: vi.fn().mockResolvedValue({ count: 1 }) },
      teamMember: { deleteMany: vi.fn().mockResolvedValue({ count: 1 }) },
      user: { findUnique: vi.fn().mockResolvedValue({ displayName: '被移出的成员' }) },
      teamActivity: { create: vi.fn().mockResolvedValue({}) },
      notification: { create: vi.fn().mockResolvedValue({}) },
    }
    mockDb.$transaction.mockImplementation(
      async (callback: (client: typeof transaction) => Promise<unknown>): Promise<unknown> => callback(transaction)
    )
    app = await buildApp()

    const response = await app.inject({
      method: 'DELETE',
      url: '/api/teams/team-001/members/member-002',
    })

    expect(response.statusCode).toBe(204)
    const authoredInTeam = { teamId: 'team-001', skill: { authorId: 'member-002' } }
    expect(mockCredentialLifecycle.revokeTeamCredentialsForTeam).not.toHaveBeenCalled()
    expect(transaction.skillTeamShare.deleteMany).toHaveBeenCalledWith({ where: authoredInTeam })
    expect(transaction.teamMember.deleteMany).toHaveBeenCalledWith({
      where: { teamId: 'team-001', userId: 'member-002' },
    })
    expect(transaction.teamActivity.create).toHaveBeenCalledWith({
      data: {
        teamId: 'team-001',
        actorId: 'user-001',
        type: 'member_removed',
        payload: { userId: 'member-002', displayName: '被移出的成员' },
      },
    })
    expectSafeActivityPayloads(transaction.teamActivity.create)
    expect(mockMutationLocks.lockTeamMutation).toHaveBeenCalledWith(transaction, 'team-001')
  })

  it('returns a controlled 404 when the owner removes an absent member', async () => {
    const transaction = {
      team: { findUnique: vi.fn().mockResolvedValue({
        id: 'team-001', name: '产品组', ownerId: 'user-001', dissolvedAt: null,
      }) },
      teamMember: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }) },
      skillTeamShare: { deleteMany: vi.fn() },
      notification: { create: vi.fn() },
    }
    mockDb.$transaction.mockImplementation(
      async (callback: (client: typeof transaction) => Promise<unknown>): Promise<unknown> => callback(transaction)
    )
    app = await buildApp()

    const response = await app.inject({
      method: 'DELETE', url: '/api/teams/team-001/members/missing-member',
    })

    expect(response.statusCode).toBe(404)
    expect(transaction.skillTeamShare.deleteMany).not.toHaveBeenCalled()
    expect(transaction.notification.create).not.toHaveBeenCalled()
  })

  describe('GET /api/teams/:id/activity', () => {
    const activeTeam = { id: 'team-001', dissolvedAt: null }
    const activity = (id: string, createdAt: string, actor: { id: string; displayName: string; avatarUrl: string | null } | null) => ({
      id,
      teamId: 'team-001',
      actorId: actor?.id ?? null,
      type: 'skill_shared',
      payload: { skillId: 'skill-001', skillName: '周报助手' },
      createdAt: new Date(createdAt),
      actor,
    })

    it('returns 404 for an unknown team and 410 for a dissolved team', async () => {
      mockDb.team.findUnique.mockResolvedValueOnce(null)
      mockDb.team.findUnique.mockResolvedValueOnce({ id: 'team-001', dissolvedAt: new Date('2026-10-01T00:00:00.000Z') })
      app = await buildApp()

      const unknown = await app.inject({ method: 'GET', url: '/api/teams/team-404/activity' })
      const dissolved = await app.inject({ method: 'GET', url: '/api/teams/team-001/activity' })

      expect(unknown.statusCode).toBe(404)
      expect(dissolved.statusCode).toBe(410)
      expect(mockDb.teamActivity.findMany).not.toHaveBeenCalled()
    })

    it('forbids a non-member', async () => {
      mockDb.team.findUnique.mockResolvedValue(activeTeam)
      mockDb.teamMember.findUnique.mockResolvedValue(null)
      app = await buildApp()

      const response = await app.inject({ method: 'GET', url: '/api/teams/team-001/activity' })

      expect(response.statusCode).toBe(403)
      expect(mockDb.teamMember.findUnique).toHaveBeenCalledWith({
        where: { teamId_userId: { teamId: 'team-001', userId: 'user-001' } },
        select: { userId: true },
      })
      expect(mockDb.teamActivity.findMany).not.toHaveBeenCalled()
    })

    it('lists newest first with the default limit and a null actor for a deleted user', async () => {
      mockDb.team.findUnique.mockResolvedValue(activeTeam)
      mockDb.teamMember.findUnique.mockResolvedValue({ userId: 'user-001' })
      mockDb.teamActivity.findMany.mockResolvedValue([
        activity('activity-002', '2026-10-14T10:00:00.000Z', { id: 'user-002', displayName: '小王', avatarUrl: null }),
        activity('activity-001', '2026-10-14T09:00:00.000Z', null),
      ])
      app = await buildApp()

      const response = await app.inject({ method: 'GET', url: '/api/teams/team-001/activity' })

      expect(response.statusCode).toBe(200)
      expect(response.json()).toEqual({
        items: [
          {
            id: 'activity-002',
            type: 'skill_shared',
            actor: { id: 'user-002', displayName: '小王', avatarUrl: null },
            payload: { skillId: 'skill-001', skillName: '周报助手' },
            createdAt: '2026-10-14T10:00:00.000Z',
          },
          {
            id: 'activity-001',
            type: 'skill_shared',
            actor: null,
            payload: { skillId: 'skill-001', skillName: '周报助手' },
            createdAt: '2026-10-14T09:00:00.000Z',
          },
        ],
        nextBefore: null,
      })
      expect(mockDb.teamActivity.findMany).toHaveBeenCalledWith({
        where: { teamId: 'team-001' },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: 50,
        include: { actor: { select: { id: true, displayName: true, avatarUrl: true } } },
      })
    })

    it('pages with limit and before, returning the last createdAt as nextBefore on a full page', async () => {
      mockDb.team.findUnique.mockResolvedValue(activeTeam)
      mockDb.teamMember.findUnique.mockResolvedValue({ userId: 'user-001' })
      mockDb.teamActivity.findMany.mockResolvedValue([
        activity('activity-003', '2026-10-14T08:00:00.000Z', null),
        activity('activity-002', '2026-10-14T07:00:00.000Z', null),
      ])
      app = await buildApp()

      const response = await app.inject({
        method: 'GET',
        url: '/api/teams/team-001/activity?limit=2&before=2026-10-14T09:00:00.000Z',
      })

      expect(response.statusCode).toBe(200)
      expect(response.json().items.map((item: { id: string }) => item.id)).toEqual(['activity-003', 'activity-002'])
      expect(response.json().nextBefore).toBe('2026-10-14T07:00:00.000Z')
      expect(mockDb.teamActivity.findMany).toHaveBeenCalledWith(expect.objectContaining({
        where: { teamId: 'team-001', createdAt: { lt: new Date('2026-10-14T09:00:00.000Z') } },
        take: 2,
      }))
    })

    it('rejects an out-of-range limit or a malformed before', async () => {
      app = await buildApp()

      for (const query of ['limit=0', 'limit=101', 'limit=abc', 'before=yesterday']) {
        const response = await app.inject({ method: 'GET', url: `/api/teams/team-001/activity?${query}` })
        expect(response.statusCode).toBe(400)
      }
      expect(mockDb.team.findUnique).not.toHaveBeenCalled()
    })
  })

  it('rejects a whitespace-only team name update', async () => {
    app = await buildApp()

    const response = await app.inject({
      method: 'PATCH',
      url: '/api/teams/team-001',
      payload: { name: '   ' },
    })

    expect(response.statusCode).toBe(400)
    expect(mockDb.team.findUnique).not.toHaveBeenCalled()
  })
})
