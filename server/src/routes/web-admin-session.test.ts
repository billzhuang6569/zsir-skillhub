import Fastify, { type FastifyInstance } from 'fastify'
import jwt from '@fastify/jwt'
import sensible from '@fastify/sensible'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockConfig = vi.hoisted(() => ({
  NODE_ENV: 'test' as 'test' | 'production',
  AUTH_MODE: 'legacy' as 'legacy' | 'dual' | 'yitan',
  WEB_ADMIN_EMERGENCY_PASSWORD_LOGIN_ENABLED: false,
  YITAN_OIDC_ISSUER: 'https://account.example.test/realms/yitan',
  YITAN_WEB_CLIENT_ID: 'skillhub-web',
  YITAN_WEB_CLIENT_SECRET: 'test-web-client-secret-value',
  YITAN_WEB_REDIRECT_URI: 'https://sk.example.test/api/web-admin/yitan/callback',
  YITAN_WEB_POST_LOGOUT_REDIRECT_URI: 'https://sk.example.test/admin/?loggedOut=1',
  YITAN_WEB_SUCCESS_URL: 'https://sk.example.test/admin/',
  YITAN_WEB_OIDC_TRANSACTION_SECONDS: 300,
  YITAN_WEB_OIDC_TOKEN_TIMEOUT_MS: 5_000,
}))

const mockYitan = vi.hoisted(() => ({
  verifyTokenPair: vi.fn(),
}))

const mockLocks = vi.hoisted(() => ({
  externalIdentity: vi.fn(),
}))

const mockUser = vi.hoisted(() => ({
  value: {
    id: '11111111-1111-4111-8111-111111111111',
    email: 'admin@example.com',
    displayName: 'Admin',
    avatarUrl: null,
    marketplaceRole: 'admin',
    tokenVersion: 0,
    passwordHash: 'hash',
    passwordSalt: 'salt',
  } as Record<string, unknown> | null,
}))

const mockDb = vi.hoisted(() => ({
  $transaction: vi.fn(),
  user: { findUnique: vi.fn() },
  externalIdentity: {
    findUnique: vi.fn(),
    update: vi.fn(),
  },
  oidcLogoutWatermark: { findUnique: vi.fn() },
}))

vi.mock('../db.js', () => ({ db: mockDb }))
vi.mock('../config.js', () => ({ config: mockConfig }))
vi.mock('../lib/mutation-lock.js', () => ({
  lockExternalIdentityMutation: mockLocks.externalIdentity,
}))
vi.mock('../lib/password.js', () => ({
  verifyPassword: vi.fn(async () => true),
}))
vi.mock('../lib/yitan-oidc.js', () => ({
  verifyYitanTokenPair: mockYitan.verifyTokenPair,
}))

import { webAdminSessionRoutes } from './web-admin-session.js'
import { registerApiGuard } from '../middleware/api-guard.js'
import { db } from '../db.js'

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify()
  registerApiGuard(app, { ...mockConfig, SKILLHUB_PROFILE: 'yitan-official', PUBLIC_BASE_URL: 'http://localhost', INSTANCE_ADDITIONAL_BASE_URLS: [], CORS_ORIGIN: '' })
  await app.register(sensible)
  await app.register(jwt, { secret: 'local-test-secret-that-is-long-enough' })
  await app.register(webAdminSessionRoutes, { prefix: '/api/web-admin' })
  await app.ready()
  return app
}

beforeEach(() => {
  vi.clearAllMocks()
  mockLocks.externalIdentity.mockResolvedValue(undefined)
  mockDb.$transaction.mockImplementation(async (
    callback: (client: typeof mockDb) => Promise<unknown>
  ) => callback(mockDb))
  mockDb.user.findUnique.mockImplementation(async () => mockUser.value)
  mockConfig.NODE_ENV = 'test'
  mockConfig.AUTH_MODE = 'legacy'
  mockConfig.WEB_ADMIN_EMERGENCY_PASSWORD_LOGIN_ENABLED = false
  mockConfig.YITAN_WEB_CLIENT_SECRET = 'test-web-client-secret-value'
  mockUser.value = {
    id: '11111111-1111-4111-8111-111111111111',
    email: 'admin@example.com',
    displayName: 'Admin',
    avatarUrl: null,
    marketplaceRole: 'admin',
    tokenVersion: 0,
    passwordHash: 'hash',
    passwordSalt: 'salt',
  }
  mockYitan.verifyTokenPair.mockResolvedValue({
    issuer: mockConfig.YITAN_OIDC_ISSUER,
    subject: 'central-admin-001',
    authorizedParty: 'skillhub-web',
    email: 'admin@example.com',
    emailVerified: true,
    displayName: 'Admin',
    avatarUrl: null,
    authTime: Math.floor(Date.now() / 1_000) - 30,
    issuedAt: Math.floor(Date.now() / 1_000),
  })
  vi.mocked(db.externalIdentity.findUnique).mockResolvedValue(null)
  mockDb.oidcLogoutWatermark.findUnique.mockResolvedValue(null)
  vi.stubGlobal('fetch', vi.fn())
})

describe('web admin session', () => {
  it('uses an HttpOnly same-origin cookie and restores the admin session', async () => {
    const app = await buildApp()
    const login = await app.inject({
      method: 'POST',
      url: '/api/web-admin/session',
      payload: { email: 'admin@example.com', password: 'local-password' },
    })
    expect(login.statusCode).toBe(200)
    const cookie = login.headers['set-cookie']
    expect(cookie).toContain('skillhub_admin_session=')
    expect(cookie).toContain('HttpOnly')
    expect(cookie).toContain('SameSite=Strict')

    const session = await app.inject({ method: 'GET', url: '/api/web-admin/session', headers: { cookie } })
    expect(session.statusCode).toBe(200)
    expect(session.json()).toMatchObject({ user: { email: 'admin@example.com', marketplaceRole: 'admin' } })
    await app.close()
  })

  it('rejects a product-purpose JWT from the web-admin cookie channel', async () => {
    const app = await buildApp()
    const productToken = app.jwt.sign({
      sub: '11111111-1111-4111-8111-111111111111',
      ver: 0,
      purpose: 'product',
      webAdmin: true,
    }, { expiresIn: 3600 })

    const session = await app.inject({
      method: 'GET',
      url: '/api/web-admin/session',
      headers: { cookie: `skillhub_admin_session=${productToken}` },
    })

    expect(session.statusCode).toBe(401)
    expect(mockDb.user.findUnique).not.toHaveBeenCalled()
    await app.close()
  })

  it('does not issue a session to a normal Marketplace account', async () => {
    mockUser.value = { ...mockUser.value, marketplaceRole: 'user' }
    const app = await buildApp()
    const response = await app.inject({
      method: 'POST',
      url: '/api/web-admin/session',
      payload: { email: 'member@example.com', password: 'local-password' },
    })
    expect(response.statusCode).toBe(403)
    expect(response.headers['set-cookie']).toBeUndefined()
    await app.close()
  })

  it('disables local password admin login in Yitan mode unless the emergency flag is explicit', async () => {
    mockConfig.AUTH_MODE = 'yitan'
    const app = await buildApp()
    const request = {
      method: 'POST' as const,
      url: '/api/web-admin/session',
      payload: { email: 'admin@example.com', password: 'local-password' },
    }

    const blocked = await app.inject(request)
    expect(blocked.statusCode).toBe(410)
    expect(blocked.json()).toMatchObject({ error: 'AUTH_PORTAL_REQUIRED' })

    mockConfig.WEB_ADMIN_EMERGENCY_PASSWORD_LOGIN_ENABLED = true
    expect((await app.inject(request)).statusCode).toBe(200)
    await app.close()
  })

  it('starts a fixed authorization-code flow with PKCE, state, nonce, and an HttpOnly transaction cookie', async () => {
    mockConfig.AUTH_MODE = 'dual'
    const app = await buildApp()

    const response = await app.inject({ method: 'GET', url: '/api/web-admin/yitan/start' })

    expect(response.statusCode).toBe(302)
    const location = new URL(response.headers.location!)
    expect(`${location.origin}${location.pathname}`).toBe(
      `${mockConfig.YITAN_OIDC_ISSUER}/protocol/openid-connect/auth`
    )
    expect(location.searchParams.get('response_type')).toBe('code')
    expect(location.searchParams.get('client_id')).toBe('skillhub-web')
    expect(location.searchParams.get('redirect_uri')).toBe(mockConfig.YITAN_WEB_REDIRECT_URI)
    expect(location.searchParams.get('state')).toHaveLength(43)
    expect(location.searchParams.get('nonce')).toHaveLength(43)
    expect(location.searchParams.get('code_challenge_method')).toBe('S256')
    expect(location.toString()).not.toContain(mockConfig.YITAN_WEB_CLIENT_SECRET)
    expect(response.headers['set-cookie']).toContain('skillhub_admin_oidc=')
    expect(response.headers['set-cookie']).toContain('HttpOnly')
    expect(response.headers['set-cookie']).toContain('SameSite=Lax')
    expect(response.headers['set-cookie']).toContain('Path=/')
    await app.close()
  })

  it('exchanges the code server-side and issues an admin cookie only for a linked local admin', async () => {
    mockConfig.AUTH_MODE = 'dual'
    vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify({
      access_token: 'verified-access-token',
      id_token: 'verified-id-token',
    }), { status: 200, headers: { 'content-type': 'application/json' } }))
    vi.mocked(db.externalIdentity.findUnique).mockResolvedValue({
      id: 'identity-admin-001',
      userId: '11111111-1111-4111-8111-111111111111',
      issuer: mockConfig.YITAN_OIDC_ISSUER,
      subject: 'central-admin-001',
      linkMethod: 'legacy_session',
      linkedAt: new Date(),
      lastLoginAt: new Date(),
      lastLogoutAt: null,
      user: {
        id: '11111111-1111-4111-8111-111111111111',
        marketplaceRole: 'admin',
        tokenVersion: 3,
      },
    } as never)
    const app = await buildApp()
    const start = await app.inject({ method: 'GET', url: '/api/web-admin/yitan/start' })
    const state = new URL(start.headers.location!).searchParams.get('state')!

    const callback = await app.inject({
      method: 'GET',
      url: `/api/web-admin/yitan/callback?code=authorization-code&state=${encodeURIComponent(state)}&session_state=opaque`,
      headers: { cookie: start.headers['set-cookie'] },
    })

    expect(callback.statusCode).toBe(302)
    expect(callback.headers.location).toBe(mockConfig.YITAN_WEB_SUCCESS_URL)
    expect(String(callback.headers['set-cookie'])).toContain('skillhub_admin_oidc=')
    expect(String(callback.headers['set-cookie'])).toContain('skillhub_admin_session=')
    expect(callback.body).not.toContain(mockConfig.YITAN_WEB_CLIENT_SECRET)
    expect(mockYitan.verifyTokenPair).toHaveBeenCalledWith({
      accessToken: 'verified-access-token',
      idToken: 'verified-id-token',
      nonce: expect.any(String),
    })
    const fetchCall = vi.mocked(fetch).mock.calls[0]
    expect(fetchCall?.[0]).toBe(`${mockConfig.YITAN_OIDC_ISSUER}/protocol/openid-connect/token`)
    const tokenRequest = fetchCall?.[1]
    expect(tokenRequest?.method).toBe('POST')
    expect(tokenRequest?.redirect).toBe('error')
    expect(String(tokenRequest?.body)).toContain(`client_secret=${mockConfig.YITAN_WEB_CLIENT_SECRET}`)
    await app.close()
  })

  it('rejects callback state mismatch before sending the code or secret to the portal', async () => {
    mockConfig.AUTH_MODE = 'dual'
    const app = await buildApp()
    const start = await app.inject({ method: 'GET', url: '/api/web-admin/yitan/start' })

    const callback = await app.inject({
      method: 'GET',
      url: `/api/web-admin/yitan/callback?code=authorization-code&state=${'x'.repeat(43)}`,
      headers: { cookie: start.headers['set-cookie'] },
    })

    expect(callback.statusCode).toBe(302)
    expect(callback.headers.location).toContain('authError=invalid_transaction')
    expect(fetch).not.toHaveBeenCalled()
    expect(String(callback.headers['set-cookie'])).not.toContain('skillhub_admin_session=')
    await app.close()
  })

  it('never authorizes an unlinked subject or a linked non-admin through portal claims', async () => {
    mockConfig.AUTH_MODE = 'dual'
    vi.mocked(fetch).mockImplementation(async () => new Response(JSON.stringify({
      access_token: 'verified-access-token',
      id_token: 'verified-id-token',
    }), { status: 200 }))
    const app = await buildApp()
    const start = await app.inject({ method: 'GET', url: '/api/web-admin/yitan/start' })
    const state = new URL(start.headers.location!).searchParams.get('state')!

    const callback = await app.inject({
      method: 'GET',
      url: `/api/web-admin/yitan/callback?code=authorization-code&state=${encodeURIComponent(state)}`,
      headers: { cookie: start.headers['set-cookie'] },
    })

    expect(callback.statusCode).toBe(302)
    expect(callback.headers.location).toContain('authError=account_link_required')
    expect(String(callback.headers['set-cookie'])).not.toContain('skillhub_admin_session=')

    vi.mocked(db.externalIdentity.findUnique).mockResolvedValue({
      id: 'identity-member-001',
      userId: 'member-001',
      issuer: mockConfig.YITAN_OIDC_ISSUER,
      subject: 'central-admin-001',
      linkMethod: 'legacy_session',
      linkedAt: new Date(),
      lastLoginAt: new Date(),
      lastLogoutAt: null,
      user: { id: 'member-001', marketplaceRole: 'user', tokenVersion: 0 },
    } as never)
    const nextStart = await app.inject({ method: 'GET', url: '/api/web-admin/yitan/start' })
    const nextState = new URL(nextStart.headers.location!).searchParams.get('state')!
    const nonAdmin = await app.inject({
      method: 'GET',
      url: `/api/web-admin/yitan/callback?code=next-code&state=${encodeURIComponent(nextState)}`,
      headers: { cookie: nextStart.headers['set-cookie'] },
    })
    expect(nonAdmin.headers.location).toContain('authError=admin_access_required')
    expect(String(nonAdmin.headers['set-cookie'])).not.toContain('skillhub_admin_session=')
    await app.close()
  })

  it('rejects an admin callback token at the independent logout watermark boundary', async () => {
    const issuedAt = Math.floor(Date.now() / 1_000)
    mockConfig.AUTH_MODE = 'dual'
    mockYitan.verifyTokenPair.mockResolvedValue({
      issuer: mockConfig.YITAN_OIDC_ISSUER,
      subject: 'central-admin-001',
      authorizedParty: 'skillhub-web',
      email: 'admin@example.com',
      emailVerified: true,
      displayName: 'Admin',
      avatarUrl: null,
      authTime: issuedAt - 30,
      issuedAt,
    })
    mockDb.oidcLogoutWatermark.findUnique.mockResolvedValue({
      latestLogoutAt: new Date(issuedAt * 1_000),
    })
    vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify({
      access_token: 'verified-access-token',
      id_token: 'verified-id-token',
    }), { status: 200 }))
    const app = await buildApp()
    const start = await app.inject({ method: 'GET', url: '/api/web-admin/yitan/start' })
    const state = new URL(start.headers.location!).searchParams.get('state')!

    const callback = await app.inject({
      method: 'GET',
      url: `/api/web-admin/yitan/callback?code=authorization-code&state=${encodeURIComponent(state)}`,
      headers: { cookie: start.headers['set-cookie'] },
    })

    expect(callback.statusCode).toBe(302)
    expect(callback.headers.location).toContain('authError=token_revoked')
    expect(mockLocks.externalIdentity).toHaveBeenCalledWith(
      mockDb,
      mockConfig.YITAN_OIDC_ISSUER,
      'central-admin-001'
    )
    expect(mockDb.externalIdentity.findUnique).not.toHaveBeenCalled()
    expect(String(callback.headers['set-cookie'])).not.toContain('skillhub_admin_session=')
    await app.close()
  })

  it('rejects a token endpoint response body larger than 256 KiB', async () => {
    mockConfig.AUTH_MODE = 'dual'
    vi.mocked(fetch).mockResolvedValue(new Response('x'.repeat((256 * 1024) + 1), { status: 200 }))
    const app = await buildApp()
    const start = await app.inject({ method: 'GET', url: '/api/web-admin/yitan/start' })
    const state = new URL(start.headers.location!).searchParams.get('state')!

    const callback = await app.inject({
      method: 'GET',
      url: `/api/web-admin/yitan/callback?code=authorization-code&state=${encodeURIComponent(state)}`,
      headers: { cookie: start.headers['set-cookie'] },
    })

    expect(callback.statusCode).toBe(302)
    expect(callback.headers.location).toContain('authError=authentication_failed')
    expect(mockYitan.verifyTokenPair).not.toHaveBeenCalled()
    expect(mockDb.$transaction).not.toHaveBeenCalled()
    await app.close()
  })

  it('clears local cookies and uses only the configured portal logout return URL', async () => {
    mockConfig.AUTH_MODE = 'yitan'
    const app = await buildApp()

    const response = await app.inject({ method: 'GET', url: '/api/web-admin/yitan/logout' })

    expect(response.statusCode).toBe(302)
    const location = new URL(response.headers.location!)
    expect(`${location.origin}${location.pathname}`).toBe(
      `${mockConfig.YITAN_OIDC_ISSUER}/protocol/openid-connect/logout`
    )
    expect(location.searchParams.get('client_id')).toBe('skillhub-web')
    expect(location.searchParams.get('post_logout_redirect_uri')).toBe(
      mockConfig.YITAN_WEB_POST_LOGOUT_REDIRECT_URI
    )
    expect(String(response.headers['set-cookie'])).toContain('Max-Age=0')
    await app.close()
  })
})
