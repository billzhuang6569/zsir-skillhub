import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify'
import sensible from '@fastify/sensible'
import jwt from '@fastify/jwt'
import { describe, expect, it, vi } from 'vitest'

vi.mock('./db.js', () => ({ db: { instanceSetup: { findUnique: vi.fn().mockResolvedValue({ initializedAt: null }) } } }))
vi.mock('./config.js', async () => {
  const { configSchema } = await import('./config-schema.js')
  return { config: configSchema.parse(process.env) }
})
vi.mock('./middleware/auth.js', () => ({
  authMiddleware: async (_request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    return reply.code(401).send({ error: 'Unauthorized' })
  },
  optionalAuthMiddleware: async (): Promise<void> => {},
}))

import { config } from './config.js'
import { registerRoutes } from './register-routes.js'

describe('profile route registration', () => {
  it.each(['selfhost', 'yitan-official'] as const)('registers the intended routes for %s', async (profile): Promise<void> => {
    const app = Fastify()
    await app.register(sensible)
    await app.register(jwt, { secret: config.JWT_SECRET })
    const originalProfile = config.SKILLHUB_PROFILE
    config.SKILLHUB_PROFILE = profile
    await registerRoutes(app, { SKILLHUB_PROFILE: profile })
    expect(app.hasRoute({ method: 'GET', url: '/api/avatar-styles' })).toBe(true)
    for (const route of [{ method: 'POST', url: '/api/migrations' }, { method: 'GET', url: '/api/migrations/:migrationId' },
      { method: 'POST', url: '/api/migrations/:migrationId/precheck' }, { method: 'POST', url: '/api/migrations/:migrationId/items' },
      { method: 'POST', url: '/api/migrations/:migrationId/avatars' }] as const) {
      expect(app.hasRoute(route)).toBe(true)
      expect((await app.inject({ ...route, ...(route.method === 'POST' ? { payload: {} } : {}) })).statusCode).toBe(401)
    }
    expect(app.hasRoute({ method: 'GET', url: '/api/avatar-styles/:styleId/versions/:styleVersion' })).toBe(true)
    expect(app.hasRoute({ method: 'GET', url: '/media/:prefix/:file' })).toBe(profile === 'selfhost')
    try {
      // Invalid input/auth stops before database access, while exercising the real plugins.
      const officialRoutes = [
        { method: 'GET', url: '/api/marketplace/?page=invalid', status: 400 },
        { method: 'GET', url: '/api/marketplace/example/team-comments', status: 401 },
        { method: 'POST', url: '/api/marketplace/presence/sync', status: 401 },
        { method: 'GET', url: '/api/marketplace/admin/agent-api-docs', status: 401 },
        { method: 'GET', url: '/api/web-admin/session', status: 401 },
        { method: 'GET', url: '/api/admin/v1/capabilities', status: 401 },
        { method: 'POST', url: '/api/admin/v1/marketplace/skills/publish', status: 401 },
        { method: 'GET', url: '/api/admin/v1/marketplace/topics', status: 401 },
      ] as const
      for (const { method, url, status } of officialRoutes) {
        const response = await app.inject({ method, url })
        expect(response.statusCode, `${method} ${url}: ${response.body}`).toBe(profile === 'selfhost' ? 404 : status)
      }
      for (const url of ['/api/skills', '/api/teams', '/api/library', '/api/library/tags']) {
        expect((await app.inject({ url })).statusCode, url).toBe(401)
      }
      expect((await app.inject({ url: '/api/setup/status' })).statusCode).toBe(profile === 'selfhost' ? 200 : 404)
      for (const route of [
        { method: 'GET', url: '/api/instance/settings' },
        { method: 'PUT', url: '/api/instance/settings/ai', payload: {} },
        { method: 'DELETE', url: '/api/instance/settings/ai' },
        { method: 'POST', url: '/api/local-ai/leases', payload: {} },
        { method: 'POST', url: '/api/local-ai/leases/example/result', payload: {} },
        { method: 'POST', url: '/api/local-ai/leases/example/failure', payload: {} },
        { method: 'DELETE', url: '/api/local-ai/leases/example' },
        { method: 'DELETE', url: '/api/local-ai/leases' },
      ] as const) {
        expect((await app.inject(route)).statusCode).toBe(profile === 'selfhost' ? 401 : 404)
      }
      expect((await app.inject({ method: 'POST', url: '/api/setup/admin', payload: {} })).statusCode).toBe(profile === 'selfhost' ? 400 : 404)
      expect((await app.inject({ method: 'POST', url: '/api/instance/address-proof', payload: {} })).statusCode).toBe(400)
    } finally {
      config.SKILLHUB_PROFILE = originalProfile
      await app.close()
    }
  })
})
