import Fastify, { type FastifyInstance } from 'fastify'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createAgentKey } from '../lib/admin-agent-key.js'
import { AGENT_API_OPERATIONS } from '../lib/admin-agent-catalog.js'

const mockDb = vi.hoisted(() => ({
  adminAgentKey: { findUnique: vi.fn(), updateMany: vi.fn() },
  adminAgentAuditEvent: { create: vi.fn() },
  $transaction: vi.fn(),
  $queryRaw: vi.fn(),
  skillAvatar: { groupBy: vi.fn(), aggregate: vi.fn() },
  skill: { count: vi.fn() },
  skillVersion: { count: vi.fn() },
  skillCard: { count: vi.fn() },
  libraryEntry: { count: vi.fn() },
  adminDiagnosticEvent: { findMany: vi.fn() },
}))
vi.mock('../db.js', () => ({ db: mockDb }))

import { adminAgentApiRoutes } from './admin-agent-api.js'
import { marketplaceRoutes } from './marketplace.js'
import { marketplaceExperienceRoutes } from './marketplace-experience.js'
import { configureAgentRoutes, createAdminAgentAccess } from '../middleware/admin-agent.js'
import { CatalogAuthorshipError } from '../lib/skill-cards.js'
import sensible from '@fastify/sensible'

const ID = '11111111-1111-4111-8111-111111111111'
const generated = createAgentKey(ID)

beforeEach(() => {
  vi.clearAllMocks()
  mockDb.adminAgentKey.findUnique.mockResolvedValue({ id: ID, secretHash: generated.hash, scopes: ['ops:read'], revokedAt: null, issuer: { marketplaceRole: 'admin' } })
  mockDb.adminAgentAuditEvent.create.mockResolvedValue({})
  mockDb.adminAgentKey.updateMany.mockResolvedValue({ count: 1 })
  mockDb.$transaction.mockImplementation(async (callback: (transaction: typeof mockDb) => Promise<unknown>) => callback(mockDb))
  mockDb.$queryRaw.mockResolvedValue([{ applied: true }])
  mockDb.adminDiagnosticEvent.findMany.mockResolvedValue([])
})

async function app(): Promise<FastifyInstance> {
  const server = Fastify()
  await server.register(adminAgentApiRoutes, { prefix: '/api/admin/v1' })
  await server.ready()
  return server
}

describe('Admin Agent read API', () => {
  it('preserves the catalog authorship error code on Agent mutation routes', async (): Promise<void> => {
    const server = Fastify()
    configureAgentRoutes(server, {
      authenticate: async (request): Promise<void> => { request.verifiedAgentKey = { id: ID, issuerAdminId: 'admin', scopes: [], lastUsedAt: null } },
      releaseSlot: async (): Promise<void> => {},
    })
    server.post('/publish', async (): Promise<never> => { throw new CatalogAuthorshipError() })
    try {
      const response = await server.inject({ method: 'POST', url: '/publish' })
      expect(response.statusCode).toBe(409)
      expect(response.json()).toMatchObject({ code: 'CATALOG_NOT_AUTHORED', message: '来自官方商店的 Skill 不能作为自己的作品发布或共享', retryable: false })
    } finally { await server.close() }
  })
  it('publishes exactly the registered machine routes', async () => {
    const server = Fastify()
    const access = createAdminAgentAccess()
    await server.register(sensible)
    await server.register(adminAgentApiRoutes, { prefix: '/api/admin/v1', access })
    await server.register(marketplaceRoutes, { prefix: '/api/admin/v1/marketplace', agentAccess: access })
    await server.register(marketplaceExperienceRoutes, { prefix: '/api/admin/v1/marketplace', agentAccess: access })
    await server.ready()
    expect(AGENT_API_OPERATIONS).toHaveLength(27)
    for (const operation of AGENT_API_OPERATIONS) {
      expect(server.hasRoute({ method: operation.method, url: operation.path }), operation.operationId).toBe(true)
      expect(operation.example).toContain('process.env.SKILLHUB_AGENT_KEY')
    }
    for (const path of ['agent-keys', 'topics/generate', 'categories', 'users', 'listings', 'comments']) expect(server.hasRoute({ method: 'POST', url: `/api/admin/v1/marketplace/${path}` })).toBe(false)
    await server.close()
  })

  it('rejects missing, mixed, revoked and downgraded credentials', async () => {
    const server = await app()
    const url = '/api/admin/v1/capabilities'
    expect((await server.inject({ url })).statusCode).toBe(401)
    expect((await server.inject({ url, headers: { authorization: `Bearer ${generated.token}`, cookie: 'session=x' } })).statusCode).toBe(401)
    mockDb.adminAgentKey.findUnique.mockResolvedValueOnce({ id: ID, secretHash: generated.hash, scopes: ['ops:read'], revokedAt: new Date(), issuer: { marketplaceRole: 'admin' } })
    expect((await server.inject({ url, headers: { authorization: `Bearer ${generated.token}` } })).statusCode).toBe(401)
    mockDb.adminAgentKey.findUnique.mockResolvedValueOnce({ id: ID, secretHash: generated.hash, scopes: ['ops:read'], revokedAt: null, issuer: { marketplaceRole: 'user' } })
    expect((await server.inject({ url, headers: { authorization: `Bearer ${generated.token}` } })).statusCode).toBe(401)
    expect(mockDb.adminAgentAuditEvent.create).not.toHaveBeenCalled()
    await server.close()
  })

  it('returns only authorized operations and persists audit before output', async () => {
    const server = await app()
    const headers = { authorization: `Bearer ${generated.token}` }
    const success = await server.inject({ url: '/api/admin/v1/capabilities', headers })
    expect(success.statusCode).toBe(200)
    expect(success.json().data).toMatchObject({ expiresAt: null, scopes: ['ops:read'] })
    expect(success.json().data.operations).toHaveLength(6)
    expect(mockDb.adminAgentAuditEvent.create).toHaveBeenCalledWith({ data: expect.objectContaining({ operationId: 'agent.capabilities', keyId: ID }) })
    mockDb.adminAgentAuditEvent.create.mockRejectedValueOnce(new Error('db down'))
    const failedAudit = await server.inject({ url: '/api/admin/v1/overview', headers })
    expect(failedAudit.statusCode).toBe(503)
    expect(failedAudit.json()).toMatchObject({ code: 'AUDIT_UNAVAILABLE' })
    await server.close()
  })

  it('does not grant ops reads when the Key has no ops scope', async () => {
    mockDb.adminAgentKey.findUnique.mockResolvedValue({ id: ID, secretHash: generated.hash, scopes: [], revokedAt: null, issuer: { marketplaceRole: 'admin' } })
    const server = await app()
    const headers = { authorization: `Bearer ${generated.token}` }
    expect((await server.inject({ url: '/api/admin/v1/overview', headers })).statusCode).toBe(403)
    expect((await server.inject({ url: '/api/admin/v1/capabilities', headers })).json().data.operations).toHaveLength(1)
    await server.close()
  })

  it('keeps diagnostic reads behind a separate scope and audits them before output', async () => {
    const server = await app()
    const headers = { authorization: 'Bearer ' + generated.token }
    expect((await server.inject({ url: '/api/admin/v1/logs', headers })).statusCode).toBe(403)
    mockDb.adminAgentKey.findUnique.mockResolvedValue({
      id: ID, secretHash: generated.hash, scopes: ['ops:read', 'ops:logs:read'],
      revokedAt: null, issuer: { marketplaceRole: 'admin' },
    })
    const allowed = await server.inject({ url: '/api/admin/v1/logs', headers })
    expect(allowed.statusCode).toBe(200)
    expect(allowed.json().data.events).toEqual([])
    expect(mockDb.adminAgentAuditEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ operationId: 'agent.logs', keyId: ID }),
    })
    expect((await server.inject({ url: '/api/admin/v1/capabilities', headers })).json().data.operations).toHaveLength(10)
    mockDb.adminAgentAuditEvent.create.mockRejectedValueOnce(new Error('audit unavailable'))
    const failed = await server.inject({ url: '/api/admin/v1/errors', headers })
    expect(failed.statusCode).toBe(503)
    expect(failed.json().code).toBe('AUDIT_UNAVAILABLE')
    await server.close()
  })

  it('pages diagnostic events with a signed Key-bound cursor', async () => {
    mockDb.adminAgentKey.findUnique.mockResolvedValue({
      id: ID, secretHash: generated.hash, scopes: ['ops:read', 'ops:logs:read'],
      revokedAt: null, issuer: { marketplaceRole: 'admin' },
    })
    const server = await app()
    const headers = { authorization: 'Bearer ' + generated.token }
    const createdAt = new Date()
    const event = (id: string) => ({
      id, createdAt, requestId: 'a'.repeat(32), method: 'GET', route: '/skills/:id',
      statusCode: 503, durationMs: 123, eventCode: 'HTTP_503', fingerprint: 'f'.repeat(24),
    })
    const first = event('11111111-1111-4111-8111-111111111111')
    const second = event('22222222-2222-4222-8222-222222222222')
    const third = event('33333333-3333-4333-8333-333333333333')
    mockDb.adminDiagnosticEvent.findMany.mockResolvedValueOnce([first, second, third]).mockResolvedValueOnce([third])
    const page = await server.inject({ url: '/api/admin/v1/logs?limit=2', headers })
    expect(page.statusCode).toBe(200)
    expect(page.json().data.events).toHaveLength(2)
    const nextCursor: string = page.json().data.nextCursor
    expect(nextCursor).toBeTruthy()
    const next = await server.inject({ url: '/api/admin/v1/logs?cursor=' + encodeURIComponent(nextCursor), headers })
    expect(next.statusCode).toBe(200)
    expect(next.json().data.events).toHaveLength(1)
    expect(next.json().data.nextCursor).toBeNull()
    expect(mockDb.adminDiagnosticEvent.findMany.mock.calls[1][0].where.OR).toHaveLength(2)
    const tamperedCursor = (nextCursor[0] === 'A' ? 'B' : 'A') + nextCursor.slice(1)
    const tampered = await server.inject({ url: '/api/admin/v1/logs?cursor=' + encodeURIComponent(tamperedCursor), headers })
    expect(tampered.statusCode).toBe(400)
    const changedQuery = await server.inject({ url: '/api/admin/v1/logs?cursor=' + encodeURIComponent(nextCursor) + '&limit=3', headers })
    expect(changedQuery.statusCode).toBe(400)
    const other = createAgentKey('44444444-4444-4444-8444-444444444444')
    mockDb.adminAgentKey.findUnique.mockResolvedValue({
      id: '44444444-4444-4444-8444-444444444444', secretHash: other.hash,
      scopes: ['ops:read', 'ops:logs:read'], revokedAt: null, issuer: { marketplaceRole: 'admin' },
    })
    const crossKey = await server.inject({
      url: '/api/admin/v1/logs?cursor=' + encodeURIComponent(nextCursor),
      headers: { authorization: 'Bearer ' + other.token },
    })
    expect(crossKey.statusCode).toBe(400)
    expect(mockDb.adminDiagnosticEvent.findMany).toHaveBeenCalledTimes(2)
    await server.close()
  })
})
