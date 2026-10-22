import Fastify, { type FastifyInstance, type HTTPMethods, type InjectOptions } from 'fastify'
import jwt from '@fastify/jwt'
import sensible from '@fastify/sensible'
import cors from '@fastify/cors'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  user: { id: 'catalog-user', email: 'catalog@example.test', displayName: 'Catalog', avatarUrl: null, marketplaceRole: 'user', tokenVersion: 0, catalogTokenVersion: 0 },
  missing: false,
  watermark: null as Date | null,
  identityLogout: null as Date | null,
}))
vi.mock('../db.js', () => {
  const db = {
    user: {
      findUnique: vi.fn(async () => state.missing ? null : { ...state.user }),
      update: vi.fn(async ({ data }: { data: { tokenVersion?: { increment: number }; catalogTokenVersion?: { increment: number } } }) => {
        state.user.tokenVersion += data.tokenVersion?.increment ?? 0
        state.user.catalogTokenVersion += data.catalogTokenVersion?.increment ?? 0
        return { ...state.user }
      }),
    },
    externalIdentity: {
      findUnique: vi.fn(async () => ({ id: 'identity', userId: state.user.id, issuer: 'https://identity.test', subject: 'subject', lastLogoutAt: state.identityLogout })),
      update: vi.fn(async () => ({})),
    },
    oidcLogoutWatermark: {
      findUnique: vi.fn(async () => state.watermark ? { latestLogoutAt: state.watermark } : null),
      upsert: vi.fn(async ({ create }: { create: { latestLogoutAt: Date } }) => { state.watermark = create.latestLogoutAt }),
    },
    $queryRaw: vi.fn(async () => []),
    $transaction: async (operation: (tx: unknown) => Promise<unknown>): Promise<unknown> => operation(db),
  }
  return { db }
})
vi.mock('../lib/yitan-oidc.js', () => ({
  verifyYitanBackchannelLogout: async () => ({ issuer: 'https://identity.test', subject: 'subject', issuedAt: Math.floor(Date.now() / 1000), tokenId: 'logout' }),
  verifyYitanTestBackchannelLogout: vi.fn(), verifyYitanTokenPair: vi.fn(),
}))
import { config } from '../config.js'
import { authMiddleware } from './auth.js'
import { CATALOG_ROUTES, catalogAuthMiddleware, catalogBoundary, catalogRouteAllowed } from './catalog-auth.js'
import { registerRoutes } from '../register-routes.js'
import { authRoutes } from '../routes/auth.js'

let app: FastifyInstance
async function base(): Promise<FastifyInstance> {
  const server = Fastify()
  await server.register(jwt, { secret: config.JWT_SECRET })
  await server.register(sensible)
  return server
}
function catalog(overrides: Record<string, unknown> = {}): string {
  const iat = Math.floor(Date.now() / 1000) - 1
  return app.jwt.sign({ sub: state.user.id, purpose: 'catalog', cver: 0, iat, exp: iat + 3600, ...overrides })
}
function headers(token: string): { authorization: string } { return { authorization: `Bearer ${token}` } }
beforeEach(() => {
  config.SKILLHUB_PROFILE = 'yitan-official'
  state.missing = false; state.watermark = null; state.identityLogout = null
  state.user.tokenVersion = 0; state.user.catalogTokenVersion = 0
})
afterEach(async () => { await app?.close() })

describe('catalog authentication boundary', () => {
  it('keeps ordinary auth independently closed even when a catalog token also carries a valid product version', async () => {
    app = await base()
    app.get('/ordinary', { preHandler: authMiddleware }, async () => ({ ok: true }))
    expect((await app.inject({ url: '/ordinary', headers: headers(catalog({ ver: 0 })) })).statusCode).toBe(401)
  })
  it('checks every registered route, including anonymous and admin routes, against the single allowlist', async () => {
    app = await base()
    const routes: Array<{ method: HTTPMethods; url: string }> = []
    app.addHook('onRoute', route => {
      for (const method of Array.isArray(route.method) ? route.method : [route.method]) {
        routes.push({ method, url: route.url })
        if (catalogRouteAllowed(method, route.url)) {
          const handlers = Array.isArray(route.preHandler) ? route.preHandler : [route.preHandler]
          expect(handlers, `${method} ${route.url}`).toContain(catalogAuthMiddleware)
        }
      }
    })
    app.addHook('onRequest', catalogBoundary)
    await app.register(cors, { origin: true })
    app.get('/health', async () => ({ ok: true }))
    app.get('/ready', async () => ({ ok: true }))
    await registerRoutes(app, config)
    // New routes inherit the boundary, even if their author forgets authentication.
    app.get('/future-public-route', async () => ({ ok: true }))
    const authorization = headers(catalog())
    expect(routes.length).toBeGreaterThan(150)
    for (const route of routes) {
      if (catalogRouteAllowed(route.method, route.url)) continue
      const url = route.url.replace(/:[^/]+/g, '00000000-0000-4000-8000-000000000001')
      const response = await app.inject({ method: route.method as InjectOptions['method'], url, headers: authorization })
      expect([401, 403], `${route.method} ${route.url}: ${response.body}`).toContain(response.statusCode)
    }
    for (const entry of CATALOG_ROUTES) {
      const [method, url] = entry.split(' ')
      expect(routes.some(route => route.method === method && route.url === url), entry).toBe(true)
    }
    expect((await app.inject({ url: '/future-public-route', headers: { authorization: `Bearer ${catalog()} ` } })).statusCode).toBe(401)
    expect((await app.inject({ method: 'OPTIONS', url: '/api/skills', headers: { ...authorization, origin: 'https://store.example.test', 'access-control-request-method': 'GET' } })).statusCode).toBe(401)
  })

  it('accepts both purposes at every allowed middleware binding and rejects catalog on ordinary auth', async () => {
    app = await base()
    app.addHook('onRequest', catalogBoundary)
    for (const entry of CATALOG_ROUTES) {
      const [method, url] = entry.split(' ')
      app.route({ method: method as HTTPMethods, url, preHandler: catalogAuthMiddleware, handler: async () => ({ ok: true }) })
    }
    app.get('/product', { preHandler: authMiddleware }, async () => ({ ok: true }))
    for (const token of [catalog(), app.jwt.sign({ sub: state.user.id, ver: 0, purpose: 'product' })]) {
      for (const entry of CATALOG_ROUTES) {
        const [method, template] = entry.split(' ')
        const response = await app.inject({ method: method as InjectOptions['method'], url: template.replace(/:[^/]+/g, 'id'), headers: headers(token) })
        expect(response.statusCode, entry).toBe(200)
      }
    }
    expect((await app.inject({ url: '/product', headers: headers(catalog()) })).statusCode).toBe(401)
  })

  it.each(['version', 'expired', 'watermark', 'identity-watermark', 'missing', 'missing-iat', 'admin'])('rejects %s catalog sessions', async reason => {
    app = await base()
    await app.register(authRoutes, { prefix: '/api/auth' })
    let token = catalog()
    if (reason === 'version') state.user.catalogTokenVersion = 1
    if (reason === 'expired') token = catalog({ exp: Math.floor(Date.now() / 1000) - 1 })
    if (reason === 'watermark') state.watermark = new Date()
    if (reason === 'identity-watermark') state.identityLogout = new Date()
    if (reason === 'missing') state.missing = true
    if (reason === 'missing-iat') token = app.jwt.sign({ sub: state.user.id, purpose: 'catalog', cver: 0, iat: 0, exp: Math.floor(Date.now() / 1000) + 100 }, { noTimestamp: true })
    if (reason === 'admin') token = catalog({ webAdmin: true })
    expect((await app.inject({ url: '/api/auth/catalog/me', headers: headers(token) })).statusCode).toBe(401)
  })

  it.each(['catalog/logout', 'logout', 'logout-all', 'yitan/backchannel-logout'])('separates revocation for %s', async path => {
    app = await base()
    await app.register(authRoutes, { prefix: '/api/auth' })
    const catalogToken = catalog()
    const productToken = app.jwt.sign({ sub: state.user.id, ver: 0, purpose: 'product' })
    const response = await app.inject({ method: 'POST', url: `/api/auth/${path}`, ...(path.startsWith('yitan')
      ? { headers: { 'content-type': 'application/x-www-form-urlencoded' }, payload: 'logout_token=test' }
      : { headers: headers(path === 'catalog/logout' ? catalogToken : productToken) }) })
    expect([200, 204]).toContain(response.statusCode)
    expect((await app.inject({ url: '/api/auth/me', headers: headers(productToken) })).statusCode).toBe(path === 'catalog/logout' ? 200 : 401)
    expect((await app.inject({ url: '/api/auth/catalog/me', headers: headers(catalogToken) })).statusCode).toBe(path === 'logout' ? 200 : 401)
  })
})
