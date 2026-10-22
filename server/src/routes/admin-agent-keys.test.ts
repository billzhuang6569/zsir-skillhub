import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify'
import { randomUUID } from 'node:crypto'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockDb = vi.hoisted(() => ({
  adminAgentKey: { findMany: vi.fn(), findUnique: vi.fn(), create: vi.fn(), updateMany: vi.fn() },
  adminAgentAuditEvent: { create: vi.fn() },
  $transaction: vi.fn(),
}))
vi.mock('../db.js', () => ({ db: mockDb }))
vi.mock('../middleware/auth.js', () => ({
  authMiddleware: async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    if (!request.headers.cookie) return reply.code(401).send({ error: 'Unauthorized' })
    request.verifiedAuthToken = { sub: 'admin', ver: 0, purpose: 'web-admin', iat: Math.floor(Date.now() / 1000) }
    request.user = { id: 'admin', email: 'admin@example.test', displayName: 'Admin', marketplaceRole: 'admin' }
  },
}))

import { adminAgentKeyRoutes } from './admin-agent-keys.js'
import { config } from '../config.js'
import { registerApiGuard } from '../middleware/api-guard.js'

const base = '/api/marketplace/admin/agent-keys'
const headers = { cookie: 'skillhub_admin_session=unit-test-session', origin: 'https://sk.woe.show', 'sec-fetch-site': 'same-origin' }
const operationId = '22222222-2222-4222-8222-222222222222'
let stored: Record<string, unknown> | null = null

beforeEach(() => {
  vi.clearAllMocks()
  stored = null
  mockDb.adminAgentKey.findMany.mockImplementation(async () => stored ? [stored] : [])
  mockDb.adminAgentKey.findUnique.mockImplementation(async () => stored)
  mockDb.adminAgentKey.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => {
    stored = { ...data, createdAt: new Date('2026-10-04T00:00:00Z'), revokedAt: null, lastUsedAt: null }
    return stored
  })
  mockDb.adminAgentKey.updateMany.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => {
    stored = { ...stored, ...data }
    return { count: 1 }
  })
  mockDb.adminAgentAuditEvent.create.mockResolvedValue({})
  mockDb.$transaction.mockImplementation(async (callback: (transaction: typeof mockDb) => Promise<unknown>) => callback(mockDb))
})

async function app(): Promise<FastifyInstance> {
  const server = Fastify()
  registerApiGuard(server, { ...config, PUBLIC_BASE_URL: 'http://localhost' })
  await server.register(adminAgentKeyRoutes, { prefix: '/api/marketplace' })
  await server.ready()
  return server
}

describe('human Admin Agent Key management', () => {
  it('uses the configured public base URL in API docs and every Agent example', async () => {
    const server = await app()
    try {
      const response = await server.inject({ url: '/api/marketplace/admin/agent-api-docs', headers })
      expect(response.statusCode).toBe(200)
      const docs = response.json<{ baseUrl: string; agentOperations: { example: string }[] }>()
      expect(docs.baseUrl).toBe('https://skills.example.test/instance')
      for (const operation of docs.agentOperations) {
        expect(operation.example).toContain('https://skills.example.test/instance/api/admin/v1/')
        expect(operation.example).not.toContain('bill-api.whatonearth.work')
      }
    } finally {
      await server.close()
    }
  })
  it.each(['marketplace:publish', 'marketplace:review', 'marketplace:topics:write'])('issues %s independently without granting diagnostics', async scope => {
    const server = await app()
    const list = (await server.inject({ url: base, headers })).json()
    expect(list.availableScopes).toContain(scope)
    const payload = { name: 'Content workflow', scopes: [scope], clientOperationId: operationId }
    const writeHeaders = { ...headers, 'x-skillhub-csrf': list.csrfToken }
    expect((await server.inject({ method: 'POST', url: base, headers: writeHeaders, payload: { ...payload, scopes: [scope, scope] } })).statusCode).toBe(400)
    const created = await server.inject({ method: 'POST', url: base, headers: writeHeaders, payload })
    expect(created.statusCode).toBe(201)
    expect(created.json().key.scopes).toEqual([scope])
    await server.close()
  })

  it('rejects cross-origin writes and never replays a created secret', async () => {
    const server = await app()
    const list = await server.inject({ url: base, headers })
    expect(list.statusCode).toBe(200)
    const csrf = list.json().csrfToken as string
    const payload = { name: 'Codex Cloud', scopes: ['ops:read'], clientOperationId: operationId }
    const crossOrigin = await server.inject({ method: 'POST', url: base, headers: { ...headers, origin: 'https://other.example', 'x-skillhub-csrf': csrf }, payload })
    expect(crossOrigin.statusCode).toBe(403)
    const created = await server.inject({ method: 'POST', url: base, headers: { ...headers, 'x-skillhub-csrf': csrf }, payload })
    expect(created.statusCode).toBe(201)
    expect(created.json().secret).toMatch(/^skh_agent_/)
    expect(JSON.stringify(stored)).not.toContain(created.json().secret)
    const retried = await server.inject({ method: 'POST', url: base, headers: { ...headers, 'x-skillhub-csrf': csrf }, payload })
    expect(retried.statusCode).toBe(200)
    expect(retried.json()).toMatchObject({ created: false, secretAvailable: false })
    expect(retried.json()).not.toHaveProperty('secret')
    expect(mockDb.adminAgentAuditEvent.create).toHaveBeenCalledTimes(1)
    await server.close()
  })

  it('rejects unsupported scopes and Agent bearer credentials', async () => {
    const server = await app()
    const csrf = (await server.inject({ url: base, headers })).json().csrfToken as string
    const invalid = await server.inject({ method: 'POST', url: base, headers: { ...headers, 'x-skillhub-csrf': csrf }, payload: { name: 'No', scopes: ['ops:logs:read'], clientOperationId: operationId } })
    expect(invalid.statusCode).toBe(400)
    const unsupported = await server.inject({ method: 'POST', url: base, headers: { ...headers, 'x-skillhub-csrf': csrf }, payload: { name: 'No', scopes: ['ops:read', 'ops:write'], clientOperationId: operationId } })
    expect(unsupported.statusCode).toBe(400)
    const machine = await server.inject({ url: base, headers: { ...headers, authorization: 'Bearer skh_agent_fake' } })
    expect(machine.statusCode).toBe(403)
    await server.close()
  })

  it('pages older Keys with a stable cursor so they remain revocable', async () => {
    const server = await app()
    const keys = Array.from({ length: 101 }, () => ({ id: randomUUID(), name: 'Cloud', scopes: ['ops:read'], issuerAdminId: 'admin', createdAt: new Date(), revokedAt: null, lastUsedAt: null }))
    mockDb.adminAgentKey.findMany.mockResolvedValue(keys)
    const first = await server.inject({ url: base, headers })
    expect(first.statusCode).toBe(200)
    expect(first.json().keys).toHaveLength(100)
    expect(first.json().nextCursor).toBe(keys[99].id)
    const second = await server.inject({ url: `${base}?cursor=${keys[99].id}`, headers })
    expect(second.statusCode).toBe(200)
    expect(mockDb.adminAgentKey.findMany).toHaveBeenLastCalledWith(expect.objectContaining({ cursor: { id: keys[99].id }, skip: 1 }))
    expect((await server.inject({ url: `${base}?cursor=bad`, headers })).statusCode).toBe(400)
    await server.close()
  })

  it('revokes once and preserves the audit on a repeated request', async () => {
    const server = await app()
    const csrf = (await server.inject({ url: base, headers })).json().csrfToken as string
    const writeHeaders = { ...headers, 'x-skillhub-csrf': csrf }
    const created = await server.inject({ method: 'POST', url: base, headers: writeHeaders, payload: { name: 'Cloud', scopes: ['ops:read'], clientOperationId: operationId } })
    const url = `${base}/${created.json().key.id}/revoke`
    const first = await server.inject({ method: 'POST', url, headers: writeHeaders, payload: {} })
    expect(first.statusCode).toBe(200)
    expect(first.json().key.status).toBe('revoked')
    const second = await server.inject({ method: 'POST', url, headers: writeHeaders, payload: {} })
    expect(second.statusCode).toBe(200)
    expect(mockDb.adminAgentAuditEvent.create).toHaveBeenCalledTimes(2)
    await server.close()
  })
})
