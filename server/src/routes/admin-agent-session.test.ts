import Fastify from 'fastify'
import jwt from '@fastify/jwt'
import { describe, expect, it, vi } from 'vitest'

const mockDb = vi.hoisted(() => ({
  user: { findUnique: vi.fn() },
  adminAgentKey: { findMany: vi.fn() },
}))
vi.mock('../db.js', () => ({ db: mockDb }))

import { adminAgentKeyRoutes } from './admin-agent-keys.js'

describe('Agent Key management uses the existing Admin session', () => {
  it('accepts the signed web Admin Cookie and rejects a product bearer token', async () => {
    mockDb.user.findUnique.mockResolvedValue({ id: 'admin', email: 'a@example.test', displayName: 'Admin', marketplaceRole: 'admin', tokenVersion: 0 })
    mockDb.adminAgentKey.findMany.mockResolvedValue([])
    const server = Fastify()
    await server.register(jwt, { secret: 'skillhub-test-jwt-secret-not-for-production' })
    await server.register(adminAgentKeyRoutes, { prefix: '/api/marketplace' })
    await server.ready()
    const adminToken = server.jwt.sign({ sub: 'admin', ver: 0, purpose: 'web-admin', webAdmin: true })
    const admin = await server.inject({ url: '/api/marketplace/admin/agent-keys', headers: { cookie: `skillhub_admin_session=${adminToken}` } })
    expect(admin.statusCode).toBe(200)
    expect(admin.json().csrfToken).toEqual(expect.any(String))
    const docs = await server.inject({ url: '/api/marketplace/admin/agent-api-docs', headers: { cookie: `skillhub_admin_session=${adminToken}` } })
    expect(docs.statusCode).toBe(200)
    expect(docs.json().agentOperations).toHaveLength(27)
    expect(docs.json().existingAdminOperations.length).toBeGreaterThan(20)
    expect(docs.body).not.toContain('skh_agent_')
    const productToken = server.jwt.sign({ sub: 'admin', ver: 0, purpose: 'product' })
    const product = await server.inject({ url: '/api/marketplace/admin/agent-keys', headers: { authorization: `Bearer ${productToken}` } })
    expect(product.statusCode).toBe(403)
    await server.close()
  })
})
