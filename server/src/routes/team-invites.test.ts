import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify'
import sensible from '@fastify/sensible'
import { createHmac } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const secret = 'test-team-invite-secret-value'
const teamId = '11111111-1111-4111-8111-111111111111'
const ownerId = '22222222-2222-4222-8222-222222222222'
const memberId = '33333333-3333-4333-8333-333333333333'

const mockDb = vi.hoisted(() => ({
  team: { findUnique: vi.fn() },
  $transaction: vi.fn(),
}))
const mockLocks = vi.hoisted(() => ({ lockTeamMutation: vi.fn().mockResolvedValue(undefined) }))
const mockIdentity = vi.hoisted(() => ({ value: { id: 'instance-a' } as { id: string } | undefined }))

vi.mock('../config.js', () => ({ config: { JWT_SECRET: 'test-team-invite-secret-value', PUBLIC_BASE_URL: 'https://skills.example.test/base', SKILLHUB_PROFILE: 'yitan-official' } }))
vi.mock('../lib/instance-identity.js', () => ({ getInstanceIdentity: () => mockIdentity.value }))
vi.mock('../db.js', () => ({ db: mockDb }))
vi.mock('../lib/mutation-lock.js', () => mockLocks)
vi.mock('../middleware/auth.js', () => ({
  authMiddleware: async (request: FastifyRequest): Promise<void> => {
    request.user = {
      id: memberId,
      email: 'member@example.com',
      displayName: '新成员',
      marketplaceRole: 'user',
    }
  },
}))

import { createTeamInviteToken } from '../lib/team-invite-token.js'
import { teamInviteRoutes } from './team-invites.js'
import { config } from '../config.js'

const activeTeam = {
  id: teamId,
  ownerId,
  name: '产品团队',
  color: '#3574f0',
  avatarUrl: null,
  dissolvedAt: null,
}

function token(expiresAt = Date.now() + 60_000): string {
  return createTeamInviteToken({ teamId, invitedBy: ownerId, expiresAt, secret, binding: { instanceId: 'instance-a', publicBaseUrl: config.PUBLIC_BASE_URL } })
}

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify()
  await app.register(sensible)
  await app.register(teamInviteRoutes)
  await app.ready()
  return app
}

describe('team invite routes', () => {
  let app: FastifyInstance | undefined

  beforeEach(() => { vi.clearAllMocks(); mockIdentity.value = { id: 'instance-a' }; config.PUBLIC_BASE_URL = 'https://skills.example.test/base'; config.SKILLHUB_PROFILE = 'yitan-official' })
  afterEach(async () => { await app?.close(); app = undefined })

  it('returns retryable unavailability while instance identity is not ready', async () => {
    mockDb.team.findUnique.mockResolvedValue({ ...activeTeam, ownerId: memberId })
    app = await buildApp()
    const inviteToken = token()
    mockIdentity.value = undefined
    for (const request of [
      { method: 'POST' as const, url: '/api/team-invites', payload: { teamId } },
      { method: 'GET' as const, url: `/api/team-invites/${inviteToken}` },
      { method: 'POST' as const, url: `/api/team-invites/${inviteToken}/accept` },
    ]) {
      expect((await app.inject(request)).statusCode).toBe(503)
    }
  })

  it('only lets the active owner create an invitation', async () => {
    mockDb.team.findUnique.mockResolvedValue(activeTeam)
    app = await buildApp()

    const denied = await app.inject({ method: 'POST', url: '/api/team-invites', payload: { teamId } })
    expect(denied.statusCode).toBe(403)

    mockDb.team.findUnique.mockResolvedValue({ ...activeTeam, ownerId: memberId })
    const created = await app.inject({ method: 'POST', url: '/api/team-invites', payload: { teamId } })
    expect(created.statusCode).toBe(201)
    expect(created.json()).toMatchObject({ team: { id: teamId, name: '产品团队' } })
    expect(typeof created.json().token).toBe('string')
    expect(created.json().deepLink).toBe(`skillhub://join-team/${created.json().token}?server=https%3A%2F%2Fskills.example.test%2Fbase`)
    expect(created.json().landingPageUrl).toBe(`${config.PUBLIC_BASE_URL}/invite/${created.json().token}`)
  })

  it('returns validated invite metadata and an app-opening web page', async () => {
    mockDb.team.findUnique.mockResolvedValue(activeTeam)
    app = await buildApp()
    const inviteToken = token()

    const info = await app.inject({ method: 'GET', url: `/api/team-invites/${inviteToken}` })
    const page = await app.inject({ method: 'GET', url: `/invite/${inviteToken}` })

    expect(info.statusCode).toBe(200)
    expect(info.headers['cache-control']).toBe('no-store, private')
    expect(info.json()).toMatchObject({ team: { id: teamId, name: '产品团队' } })
    expect(page.statusCode).toBe(200)
    expect(page.body).toContain('skillhub://join-team/')
    expect(page.body).not.toContain('产品团队')
    expect(page.body).not.toContain(teamId)
    expect(page.body).not.toContain('<script')
    expect(page.body).toContain('?server=https%3A%2F%2Fskills.example.test%2Fbase')
    expect(page.body).toContain('https://sk.woe.show')
    expect(page.headers).toMatchObject({
      'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'",
      'cache-control': 'no-store', 'referrer-policy': 'no-referrer',
      'x-frame-options': 'DENY', 'x-content-type-options': 'nosniff',
    })
    expect(mockDb.team.findUnique).toHaveBeenCalledTimes(1)
  })

  it('renders unverified invitations without database access and limits navigation attempts', async () => {
    app = await buildApp()
    for (let index = 0; index < 30; index++) {
      expect((await app.inject('/invite/unverified')).statusCode).toBe(200)
    }
    const limited = await app.inject('/invite/unverified')
    expect(limited.statusCode).toBe(429)
    expect(limited.headers['retry-after']).toBeDefined()
    expect(mockDb.team.findUnique).not.toHaveBeenCalled()
  })

  it('invalidates existing invitations when PUBLIC_BASE_URL changes', async () => {
    const old = token()
    config.PUBLIC_BASE_URL = 'https://moved.example.test'
    app = await buildApp()
    expect((await app.inject(`/api/team-invites/${old}`)).statusCode).toBe(404)
    expect((await app.inject({ method: 'POST', url: `/api/team-invites/${old}/accept` })).statusCode).toBe(404)
    expect(mockDb.team.findUnique).not.toHaveBeenCalled()
    expect(mockDb.$transaction).not.toHaveBeenCalled()
  })

  it.each([
    { profile: 'yitan-official' as const, expired: false, status: 200 },
    { profile: 'yitan-official' as const, expired: true, status: 404 },
    { profile: 'selfhost' as const, expired: false, status: 404 },
  ])('checks legacy invitations on preview and accept: $profile, expired=$expired', async ({ profile, expired, status }) => {
    config.SKILLHUB_PROFILE = profile
    const message = token(Date.now() + (expired ? -60_000 : 60_000)).split('.').slice(0, 2).join('.')
    const signature = createHmac('sha256', secret).update(message).digest().subarray(0, 20).toString('base64url')
    const legacyToken = `${message}.${signature}`
    mockDb.team.findUnique.mockResolvedValue(activeTeam)
    const transaction = {
      team: { findUnique: vi.fn().mockResolvedValue(activeTeam) },
      teamMember: { findUnique: vi.fn().mockResolvedValue({ teamId, userId: memberId }) },
    }
    mockDb.$transaction.mockImplementation(async (callback: (client: typeof transaction) => Promise<unknown>) => callback(transaction))
    app = await buildApp()

    expect((await app.inject(`/api/team-invites/${legacyToken}`)).statusCode).toBe(status)
    expect((await app.inject({ method: 'POST', url: `/api/team-invites/${legacyToken}/accept` })).statusCode).toBe(status)
    expect(mockDb.team.findUnique).toHaveBeenCalledTimes(status === 200 ? 1 : 0)
    expect(mockDb.$transaction).toHaveBeenCalledTimes(status === 200 ? 1 : 0)
  })

  it('accepts an owner invitation atomically without an approval round trip', async () => {
    const transaction = {
      team: { findUnique: vi.fn().mockResolvedValue(activeTeam) },
      teamMember: {
        findUnique: vi.fn().mockResolvedValue(null),
        create: vi.fn().mockResolvedValue({ teamId, userId: memberId, role: 'member' }),
      },
      teamJoinRequest: {
        findUnique: vi.fn().mockResolvedValue(null),
        create: vi.fn().mockResolvedValue({ id: 'request-1' }),
        update: vi.fn(),
      },
      teamActivity: { create: vi.fn().mockResolvedValue({}) },
      notification: { createMany: vi.fn().mockResolvedValue({ count: 2 }) },
    }
    mockDb.$transaction.mockImplementation(async (callback: (client: typeof transaction) => Promise<unknown>) => callback(transaction))
    app = await buildApp()

    const response = await app.inject({ method: 'POST', url: `/api/team-invites/${token()}/accept` })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({ joined: true, alreadyMember: false, team: { id: teamId } })
    expect(mockLocks.lockTeamMutation).toHaveBeenCalledWith(transaction, teamId)
    expect(transaction.teamMember.create).toHaveBeenCalledWith({
      data: { teamId, userId: memberId, role: 'member' },
    })
    expect(transaction.teamJoinRequest.create).toHaveBeenCalledWith({
      data: { teamId, applicantId: memberId, invitedBy: ownerId, status: 'approved' },
    })
    expect(transaction.notification.createMany).toHaveBeenCalledOnce()
    expect(transaction.teamActivity.create).toHaveBeenCalledOnce()
    const activity = transaction.teamActivity.create.mock.calls[0]?.[0] as {
      data: { teamId: string; actorId: string; type: string; payload: Record<string, unknown> }
    }
    expect(activity.data).toMatchObject({
      teamId,
      actorId: memberId,
      type: 'member_joined',
      payload: { userId: memberId, via: 'invite', invitedById: ownerId },
    })
    for (const forbidden of ['value', 'ciphertext', 'email', 'token']) {
      expect(activity.data.payload).not.toHaveProperty(forbidden)
    }
  })

  it('is idempotent for an existing member and rejects an expired token', async () => {
    const transaction = {
      team: { findUnique: vi.fn().mockResolvedValue(activeTeam) },
      teamMember: { findUnique: vi.fn().mockResolvedValue({ teamId, userId: memberId }) },
    }
    mockDb.$transaction.mockImplementation(async (callback: (client: typeof transaction) => Promise<unknown>) => callback(transaction))
    app = await buildApp()

    const member = await app.inject({ method: 'POST', url: `/api/team-invites/${token()}/accept` })
    const expired = await app.inject({ method: 'POST', url: `/api/team-invites/${token(Date.now() - 1)}/accept` })

    expect(member.statusCode).toBe(200)
    expect(member.json()).toMatchObject({ joined: false, alreadyMember: true })
    expect(expired.statusCode).toBe(404)
    expect(mockDb.$transaction).toHaveBeenCalledOnce()
  })
})
