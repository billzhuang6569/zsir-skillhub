import Fastify, { type FastifyInstance } from 'fastify'
import jwt from '@fastify/jwt'
import { Prisma } from '@prisma/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { hashPassword } from '../lib/password.js'

const mockConfig = vi.hoisted(() => ({
  SKILLHUB_PROFILE: 'yitan-official' as 'yitan-official' | 'selfhost',
  CATALOG_TOKEN_TTL_DAYS: 30,
  JWT_EXPIRES_IN_SECONDS: 3600,
  AUTH_MODE: 'legacy' as 'legacy' | 'dual' | 'yitan',
  LOCAL_REGISTRATION_ENABLED: true,
  AUTH_LEGACY_MIGRATION_ALLOWLIST: [] as string[],
  AUTH_LEGACY_MIGRATION_SESSION_SECONDS: 600,
  AUTH_LOGIN_ATTEMPTS_PER_15_MIN: 100,
  AUTH_LOGIN_IP_ATTEMPTS_PER_15_MIN: 1_000,
  AUTH_REGISTER_ATTEMPTS_PER_HOUR: 100,
  AUTH_YITAN_EXCHANGE_ATTEMPTS_PER_15_MIN: 100,
  AUTH_YITAN_BACKCHANNEL_ATTEMPTS_PER_MINUTE: 300,
  YITAN_OIDC_ISSUER: 'https://account.example.test/realms/yitan',
  YITAN_OIDC_CLOCK_TOLERANCE_SECONDS: 0,
  YITAN_OIDC_LINK_MAX_AUTH_AGE_SECONDS: 600,
  YITAN_TEST_BACKCHANNEL_ENABLED: false,
  REGISTRATION_MODE: 'open' as 'open' | 'invite',
  REGISTRATION_INVITE_CODE: undefined as string | undefined,
}))

const mockYitan = vi.hoisted(() => ({
  verifyTokenPair: vi.fn(),
  verifyLogout: vi.fn(),
  verifyTestLogout: vi.fn(),
}))

const mockLocks = vi.hoisted(() => ({
  externalIdentity: vi.fn(),
  user: vi.fn(),
}))

const mockDb = vi.hoisted(() => ({
  $transaction: vi.fn(),
  user: {
    create: vi.fn(),
    findFirst: vi.fn(),
    findUnique: vi.fn(),
    findUniqueOrThrow: vi.fn(),
    update: vi.fn(),
  },
  externalIdentity: {
    create: vi.fn(),
    findUnique: vi.fn(),
    update: vi.fn(),
  },
  oidcLogoutWatermark: {
    findUnique: vi.fn(),
    upsert: vi.fn(),
  },
}))

vi.mock('../config.js', () => ({ config: mockConfig }))
vi.mock('../db.js', () => ({ db: mockDb }))
vi.mock('../lib/mutation-lock.js', () => ({
  lockExternalIdentityMutation: mockLocks.externalIdentity,
  lockUserMutation: mockLocks.user,
}))
vi.mock('../lib/yitan-oidc.js', () => ({
  verifyYitanTokenPair: mockYitan.verifyTokenPair,
  verifyYitanBackchannelLogout: mockYitan.verifyLogout,
  verifyYitanTestBackchannelLogout: mockYitan.verifyTestLogout,
}))

import { authRoutes } from './auth.js'

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify()
  await app.register(jwt, { secret: 'auth-test-secret-longer-than-sixteen-characters' })
  await app.register(authRoutes, { prefix: '/api/auth' })
  await app.ready()
  return app
}

describe('auth routes', () => {
  let app: FastifyInstance | undefined

  beforeEach(() => {
    mockConfig.SKILLHUB_PROFILE = 'yitan-official'
    vi.clearAllMocks()
    mockLocks.externalIdentity.mockResolvedValue(undefined)
    mockLocks.user.mockResolvedValue(undefined)
    mockDb.$transaction.mockImplementation(async (callback: (client: typeof mockDb) => Promise<unknown>) => callback(mockDb))
    mockConfig.AUTH_MODE = 'legacy'
    mockConfig.LOCAL_REGISTRATION_ENABLED = true
    mockConfig.AUTH_LEGACY_MIGRATION_ALLOWLIST = []
    mockConfig.AUTH_LOGIN_ATTEMPTS_PER_15_MIN = 100
    mockConfig.AUTH_LOGIN_IP_ATTEMPTS_PER_15_MIN = 1_000
    mockConfig.AUTH_REGISTER_ATTEMPTS_PER_HOUR = 100
    mockConfig.AUTH_YITAN_EXCHANGE_ATTEMPTS_PER_15_MIN = 100
    mockConfig.YITAN_TEST_BACKCHANNEL_ENABLED = false
    mockConfig.REGISTRATION_MODE = 'open'
    mockConfig.REGISTRATION_INVITE_CODE = undefined
    const now = Math.floor(Date.now() / 1_000)
    mockYitan.verifyTokenPair.mockResolvedValue({
      issuer: mockConfig.YITAN_OIDC_ISSUER,
      subject: 'central-user-001',
      authorizedParty: 'skillhub-desktop',
      email: 'user@example.com',
      emailVerified: true,
      displayName: '一探用户',
      avatarUrl: null,
      authTime: now - 30,
      issuedAt: now,
    })
    mockYitan.verifyLogout.mockResolvedValue({
      issuer: mockConfig.YITAN_OIDC_ISSUER,
      subject: 'central-user-001',
      issuedAt: now,
      tokenId: 'logout-event-001',
    })
    mockYitan.verifyTestLogout.mockResolvedValue({
      issuer: 'https://account.example.test/realms/yitan-test',
      subject: 'central-test-user-001',
      issuedAt: now,
      tokenId: 'logout-test-event-001',
    })
    mockDb.user.findFirst.mockResolvedValue(null)
    mockDb.externalIdentity.findUnique.mockResolvedValue(null)
    mockDb.oidcLogoutWatermark.findUnique.mockResolvedValue(null)
  })

  afterEach(async () => {
    await app?.close()
    app = undefined
  })

  it.each(['yitan-official', 'selfhost'] as const)('renews product sessions on %s and exposes verified timestamps', async profile => {
    mockConfig.SKILLHUB_PROFILE = profile
    const user = { id: 'renew-user', email: 'renew@example.test', displayName: 'Renew', avatarUrl: null, marketplaceRole: 'user', tokenVersion: 3 }
    mockDb.user.findUnique.mockResolvedValue(user)
    app = await buildApp()
    const iat = Math.floor(Date.now() / 1000) - 100
    const oldToken = app.jwt.sign({ sub: user.id, ver: 3, iat }, { expiresIn: 3600 })
    const response = await app.inject({ method: 'POST', url: '/api/auth/renew', headers: { authorization: `Bearer ${oldToken}` } })
    expect(response.statusCode).toBe(200)
    expect(response.headers['cache-control']).toBe('no-store')
    const renewed = response.json<{ token: string; user: { id: string } }>()
    expect(renewed.user.id).toBe(user.id)
    const payload = app.jwt.verify<{ iat: number; exp: number; ver: number }>(renewed.token)
    expect(payload.iat).toBeGreaterThan(iat)
    expect(payload.ver).toBe(3)
    const me = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { authorization: `Bearer ${renewed.token}` } })
    expect(me.statusCode).toBe(200)
    expect(me.json()).toMatchObject({ tokenIssuedAt: new Date(payload.iat * 1000).toISOString(), tokenExpiresAt: new Date(payload.exp * 1000).toISOString() })
    mockDb.user.findUnique.mockResolvedValue({ ...user, tokenVersion: 4 })
    for (const token of [oldToken, renewed.token]) {
      for (const [method, url] of [['GET', '/api/auth/me'], ['POST', '/api/auth/renew']] as const) {
        expect((await app.inject({ method, url, headers: { authorization: `Bearer ${token}` } })).statusCode).toBe(401)
      }
    }
  })

  it('rejects catalog renewal and a product session revoked after middleware validation', async () => {
    app = await buildApp()
    const catalog = app.jwt.sign({ sub: 'renew-user', purpose: 'catalog', cver: 0 })
    expect((await app.inject({ method: 'POST', url: '/api/auth/renew', headers: { authorization: `Bearer ${catalog}` } })).statusCode).toBe(401)
    mockDb.user.findUnique.mockResolvedValueOnce({ id: 'renew-user', tokenVersion: 0 }).mockResolvedValueOnce({ id: 'renew-user', tokenVersion: 1 })
    const token = app.jwt.sign({ sub: 'renew-user', ver: 0 })
    expect((await app.inject({ method: 'POST', url: '/api/auth/renew', headers: { authorization: `Bearer ${token}` } })).statusCode).toBe(401)
  })

  it('limits renewal by user even across different IP addresses', async () => {
    mockDb.user.findUnique.mockResolvedValue({ id: 'renew-user', email: 'renew@example.test', displayName: 'Renew', avatarUrl: null, tokenVersion: 0 })
    app = await buildApp()
    const token = app.jwt.sign({ sub: 'renew-user', ver: 0 })
    for (let attempt = 0; attempt < 21; attempt++) {
      const response = await app.inject({ method: 'POST', url: '/api/auth/renew', remoteAddress: `192.0.2.${attempt + 1}`, headers: { authorization: `Bearer ${token}` } })
      expect(response.statusCode).toBe(attempt < 20 ? 200 : 429)
      if (attempt === 20) expect(Number(response.headers['retry-after'])).toBeGreaterThan(0)
    }
  })

  it.each(['logout', 'logout-all', 'yitan/backchannel-logout'])('%s revokes renewed and original product sessions', async route => {
    const logoutAt = Math.floor(Date.now() / 1000) - 2
    mockYitan.verifyLogout.mockResolvedValue({ issuer: mockConfig.YITAN_OIDC_ISSUER, subject: 'central-user-001', issuedAt: logoutAt, tokenId: 'renewed-logout' })
    const user = { id: 'renew-user', email: 'renew@example.test', displayName: 'Renew', avatarUrl: null, tokenVersion: 0 }
    mockDb.user.findUnique.mockImplementation(async () => ({ ...user }))
    mockDb.user.update.mockImplementation(async () => { user.tokenVersion++; return { ...user } })
    mockDb.externalIdentity.findUnique.mockResolvedValue({ id: 'identity', userId: user.id })
    app = await buildApp()
    const token = app.jwt.sign({ sub: user.id, ver: 0, iat: Math.floor(Date.now() / 1000) - 10 }, { expiresIn: 3600 })
    const renewal = await app.inject({ method: 'POST', url: '/api/auth/renew', headers: { authorization: `Bearer ${token}` } })
    expect(renewal.statusCode).toBe(200)
    const renewed = renewal.json<{ token: string }>().token
    const logout = route.startsWith('yitan/')
      ? await app.inject({ method: 'POST', url: `/api/auth/${route}`, headers: { 'content-type': 'application/x-www-form-urlencoded' }, payload: 'logout_token=fixture' })
      : await app.inject({ method: 'POST', url: `/api/auth/${route}`, headers: { authorization: `Bearer ${renewed}` } })
    expect(logout.statusCode).toBe(route.startsWith('yitan/') ? 200 : 204)
    for (const bearer of [token, renewed]) {
      for (const [method, url] of [['GET', '/api/auth/me'], ['POST', '/api/auth/renew']] as const) {
        expect((await app.inject({ method, url, headers: { authorization: `Bearer ${bearer}` } })).statusCode).toBe(401)
      }
    }
    if (route === 'yitan/backchannel-logout') {
      mockConfig.AUTH_MODE = 'yitan'
      expect(mockDb.oidcLogoutWatermark.upsert).toHaveBeenCalledWith(expect.objectContaining({ update: { latestLogoutAt: new Date(logoutAt * 1000) } }))
      mockDb.oidcLogoutWatermark.findUnique.mockResolvedValue({ latestLogoutAt: new Date(logoutAt * 1000) })
      mockDb.externalIdentity.findUnique.mockResolvedValue({ id: 'identity', userId: user.id, user, lastLogoutAt: new Date(logoutAt * 1000) })
      for (const offset of [-1, 0, 1]) {
        mockYitan.verifyTokenPair.mockResolvedValue({ issuer: mockConfig.YITAN_OIDC_ISSUER, subject: 'central-user-001', authorizedParty: 'skillhub-desktop', email: user.email, emailVerified: true, displayName: user.displayName, avatarUrl: null, authTime: logoutAt + offset, issuedAt: logoutAt + offset })
        const exchange = await app.inject({ method: 'POST', url: '/api/auth/yitan/exchange', payload: { accessToken: 'fixture-access', idToken: 'fixture-id', nonce: 'nonce-that-is-long-enough' } })
        expect(exchange.statusCode).toBe(offset > 0 ? 200 : 401)
        if (offset > 0) {
          const fresh = await app.inject({ method: 'POST', url: '/api/auth/renew', headers: { authorization: `Bearer ${exchange.json<{ token: string }>().token}` } })
          expect(fresh.statusCode).toBe(200)
          expect(app.jwt.verify<{ iat: number }>(fresh.json<{ token: string }>().token).iat).toBeGreaterThan(logoutAt)
        } else expect(exchange.json()).toMatchObject({ error: 'YITAN_TOKEN_REVOKED' })
      }
    }
  })

  it('issues an independent minimal catalog session through the same OIDC mapping', async () => {
    mockConfig.AUTH_MODE = 'yitan'
    const user = { id: 'catalog-user', email: 'user@example.com', displayName: 'Catalog', avatarUrl: null, tokenVersion: 7, catalogTokenVersion: 3 }
    mockDb.externalIdentity.findUnique.mockResolvedValue({ id: 'identity', lastLogoutAt: null, user })
    app = await buildApp()
    const response = await app.inject({ method: 'POST', url: '/api/auth/yitan/exchange', payload: { accessToken: 'access', idToken: 'id', nonce: 'nonce-long-enough', purpose: 'catalog' } })
    expect(response.statusCode).toBe(200)
    const result = response.json()
    expect(Object.keys(result).sort()).toEqual(['expiresAt', 'token', 'user'])
    expect(result.user).toEqual({ id: user.id, displayName: user.displayName, avatarUrl: null })
    const token = app.jwt.verify<{ sub: string; purpose: string; cver: number; iat: number; exp: number }>(result.token)
    expect(token).toMatchObject({ sub: user.id, purpose: 'catalog', cver: 3 })
    expect(Object.keys(token).sort()).toEqual(['cver', 'exp', 'iat', 'purpose', 'sub'])
    expect(token.exp - token.iat).toBe(30 * 86400)
    expect(result.expiresAt).toBe(new Date(token.exp * 1000).toISOString())
    expect(mockDb.user.update).not.toHaveBeenCalled()
  })

  it('does not register OIDC exchange, linking or catalog session routes on selfhost', async () => {
    mockConfig.SKILLHUB_PROFILE = 'selfhost'
    app = await buildApp()
    for (const url of ['/api/auth/yitan/exchange', '/api/auth/yitan/link', '/api/auth/catalog/logout']) expect(app.hasRoute({ method: 'POST', url })).toBe(false)
    expect(app.hasRoute({ method: 'GET', url: '/api/auth/catalog/me' })).toBe(false)
  })

  it.each(['verification', 'watermark'])('applies existing exchange %s rejection to catalog issuance', async failure => {
    mockConfig.AUTH_MODE = 'yitan'
    if (failure === 'verification') mockYitan.verifyTokenPair.mockRejectedValueOnce(new Error('Invalid token pair'))
    else mockDb.oidcLogoutWatermark.findUnique.mockResolvedValueOnce({ latestLogoutAt: new Date() })
    app = await buildApp()
    const response = await app.inject({ method: 'POST', url: '/api/auth/yitan/exchange', payload: { accessToken: 'access', idToken: 'id', nonce: 'nonce-long-enough', purpose: 'catalog' } })
    expect(response.statusCode).toBe(401)
    expect(mockDb.user.create).not.toHaveBeenCalled()
  })

  it('registers a normalized email and returns only public user data', async () => {
    mockDb.user.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
      id: 'user-001',
      email: data.email,
      displayName: data.displayName,
      avatarUrl: null,
      tokenVersion: 0,
    }))
    app = await buildApp()

    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: {
        email: '  USER@Example.COM ',
        password: 'secure-password',
        displayName: '  一探用户  ',
      },
    })

    expect(response.statusCode).toBe(201)
    const payload = response.json()
    expect(payload).toMatchObject({
      tokenType: 'Bearer',
      expiresIn: 3600,
      user: {
        id: 'user-001',
        email: 'user@example.com',
        displayName: '一探用户',
        avatarUrl: null,
        marketplaceRole: 'user',
        yitanAccountLinked: false,
      },
    })
    expect(payload.token).toEqual(expect.any(String))
    expect(response.body).not.toContain('passwordHash')
    expect(response.body).not.toContain('passwordSalt')
    expect(response.body).not.toContain('secure-password')
    expect(response.body).not.toContain('private-invite-code-2026')

    const createCall = mockDb.user.create.mock.calls[0]?.[0]
    expect(createCall.data.email).toBe('user@example.com')
    expect(createCall.data.displayName).toBe('一探用户')
    expect(createCall.data.passwordHash).toEqual(expect.any(String))
    expect(createCall.data.passwordSalt).toEqual(expect.any(String))
    expect(createCall.data).not.toHaveProperty('password')
    expect(createCall.data).not.toHaveProperty('inviteCode')

    const decoded = app.jwt.verify<{ sub: string; ver: number; iat: number; exp: number }>(payload.token)
    expect(decoded.sub).toBe('user-001')
    expect(decoded.ver).toBe(0)
    expect(decoded.exp - decoded.iat).toBe(3600)
  })

  it('rejects duplicate email without exposing credentials', async () => {
    mockDb.user.create.mockRejectedValue(new Prisma.PrismaClientKnownRequestError('duplicate', {
      code: 'P2002',
      clientVersion: '5.22.0',
    }))
    app = await buildApp()

    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: {
        email: 'user@example.com',
        password: 'secure-password',
        displayName: '用户',
      },
    })

    expect(response.statusCode).toBe(409)
    expect(response.json()).toEqual({ error: 'Email already registered' })
  })

  it.each([undefined, ''])('never accepts an empty or unset configured invitation code (%s)', async (configured) => {
    mockConfig.REGISTRATION_MODE = 'invite'
    mockConfig.REGISTRATION_INVITE_CODE = configured
    app = await buildApp()
    for (const inviteCode of [undefined, '', '   ', 'some-code']) {
      const response = await app.inject({ method: 'POST', url: '/api/auth/register', payload: {
        email: 'user@example.com', password: 'secure-password', displayName: '用户', inviteCode,
      } })
      expect(response.statusCode).toBe(403)
    }
    expect(mockDb.user.create).not.toHaveBeenCalled()
  })

  it('rejects missing and incorrect invitation codes with one response and no user creation', async () => {
    mockConfig.REGISTRATION_MODE = 'invite'
    mockConfig.REGISTRATION_INVITE_CODE = 'private-invite-code-2026'
    app = await buildApp()
    const registration = {
      email: 'user@example.com',
      password: 'secure-password',
      displayName: '用户',
    }

    const missing = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: registration,
    })
    expect(missing.statusCode).toBe(403)
    expect(missing.json()).toEqual({ error: 'Invalid invitation code' })

    const malformedRegistration = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { email: 'not-an-email' },
    })
    expect(malformedRegistration.statusCode).toBe(403)
    expect(malformedRegistration.json()).toEqual({ error: 'Invalid invitation code' })

    mockConfig.REGISTRATION_INVITE_CODE = undefined
    const unavailable = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { ...registration, inviteCode: 'private-invite-code-2026' },
    })
    expect(unavailable.statusCode).toBe(403)
    expect(unavailable.json()).toEqual({ error: 'Invalid invitation code' })
    mockConfig.REGISTRATION_INVITE_CODE = 'private-invite-code-2026'

    const incorrect = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { ...registration, inviteCode: 'incorrect-invite-code' },
    })
    expect(incorrect.statusCode).toBe(403)
    expect(incorrect.json()).toEqual({ error: 'Invalid invitation code' })

    const malformed = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { ...registration, inviteCode: { nested: 'not-a-code' } },
    })
    expect(malformed.statusCode).toBe(403)
    expect(malformed.json()).toEqual({ error: 'Invalid invitation code' })

    const tooLong = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { ...registration, inviteCode: 'x'.repeat(513) },
    })
    expect(tooLong.statusCode).toBe(403)
    expect(tooLong.json()).toEqual({ error: 'Invalid invitation code' })
    expect(mockDb.user.create).not.toHaveBeenCalled()
  })

  it('validates registration fields only after a valid invitation', async () => {
    mockConfig.REGISTRATION_MODE = 'invite'
    mockConfig.REGISTRATION_INVITE_CODE = 'private-invite-code-2026'
    app = await buildApp()

    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { email: 'not-an-email', inviteCode: 'private-invite-code-2026' },
    })

    expect(response.statusCode).toBe(400)
    expect(response.json()).toEqual({ error: 'Invalid registration data' })
    expect(mockDb.user.create).not.toHaveBeenCalled()
  })

  it('accepts 6 and 128 character passwords and rejects 5 and 129', async () => {
    mockDb.user.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
      id: `user-${String(data.email)}`,
      email: data.email,
      displayName: data.displayName,
      avatarUrl: null,
      tokenVersion: 0,
    }))
    app = await buildApp()
    const register = (length: number) => app!.inject({
      method: 'POST', url: '/api/auth/register',
      payload: { email: `p${length}@example.com`, password: 'x'.repeat(length), displayName: '边界用户' },
    })

    expect((await register(5)).statusCode).toBe(400)
    expect((await register(6)).statusCode).toBe(201)
    expect((await register(128)).statusCode).toBe(201)
    expect((await register(129)).statusCode).toBe(400)
    expect(mockDb.user.create).toHaveBeenCalledTimes(2)
  })

  it('allows open registration without an invitation code when explicitly configured', async () => {
    mockConfig.REGISTRATION_MODE = 'open'
    mockDb.user.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
      id: 'user-open',
      email: data.email,
      displayName: data.displayName,
      avatarUrl: null,
      tokenVersion: 0,
    }))
    app = await buildApp()

    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { email: 'open@example.com', password: 'secure-password', displayName: '开放用户' },
    })

    expect(response.statusCode).toBe(201)
    expect(response.json()).toMatchObject({ user: { id: 'user-open', email: 'open@example.com' } })
  })

  it('logs in with normalized email and returns a signed token', async () => {
    const credentials = await hashPassword('secure-password')
    mockDb.user.findUnique.mockResolvedValue({
      id: 'user-001',
      email: 'user@example.com',
      displayName: '一探用户',
      avatarUrl: null,
      tokenVersion: 0,
      ...credentials,
    })
    app = await buildApp()

    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: ' USER@EXAMPLE.COM ', password: 'secure-password' },
    })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({
      tokenType: 'Bearer',
      expiresIn: 3600,
      user: {
        id: 'user-001',
        email: 'user@example.com',
        displayName: '一探用户',
        avatarUrl: null,
        marketplaceRole: 'user',
        yitanAccountLinked: false,
      },
    })
    expect(mockDb.user.findUnique).toHaveBeenCalledWith(expect.objectContaining({
      where: { email: 'user@example.com' },
    }))
    expect(response.body).not.toContain('passwordHash')
    expect(response.body).not.toContain('passwordSalt')
  })

  it('uses one generic error for unknown users and wrong passwords', async () => {
    app = await buildApp()
    mockDb.user.findUnique.mockResolvedValue(null)
    const unknown = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'missing@example.com', password: 'secure-password' },
    })
    expect(unknown.statusCode).toBe(401)
    expect(unknown.json()).toEqual({ error: 'Invalid email or password' })

    const credentials = await hashPassword('different-password')
    mockDb.user.findUnique.mockResolvedValue({
      id: 'user-001', email: 'user@example.com', displayName: '用户', avatarUrl: null, tokenVersion: 0, ...credentials,
    })
    const incorrect = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'user@example.com', password: 'secure-password' },
    })
    expect(incorrect.statusCode).toBe(401)
    expect(incorrect.json()).toEqual({ error: 'Invalid email or password' })
  })

  it('rejects /me without a token and resolves the current user from a valid token', async () => {
    app = await buildApp()
    const unauthorized = await app.inject({ method: 'GET', url: '/api/auth/me' })
    expect(unauthorized.statusCode).toBe(401)
    expect(unauthorized.json()).toEqual({ error: 'Unauthorized' })

    mockDb.user.findUnique.mockResolvedValue({
      id: 'user-001', email: 'user@example.com', displayName: '一探用户', avatarUrl: null, tokenVersion: 0,
    })
    const token = app.jwt.sign({ sub: 'user-001', ver: 0 }, { expiresIn: 3600 })
    const authorized = await app.inject({
      method: 'GET',
      url: '/api/auth/me',
      headers: { authorization: `Bearer ${token}` },
    })
    expect(authorized.statusCode).toBe(200)
    expect(authorized.json()).toEqual({
      tokenIssuedAt: expect.any(String),
      tokenExpiresAt: expect.any(String),
      user: {
        id: 'user-001',
        email: 'user@example.com',
        displayName: '一探用户',
        avatarUrl: null,
        marketplaceRole: 'user',
        yitanAccountLinked: false,
      },
    })

    mockDb.externalIdentity.findUnique.mockResolvedValue({ id: 'identity-001' })
    const linked = await app.inject({
      method: 'GET',
      url: '/api/auth/me',
      headers: { authorization: `Bearer ${token}` },
    })
    expect(linked.statusCode).toBe(200)
    expect(linked.json()).toMatchObject({ user: { yitanAccountLinked: true } })
  })

  it('reads the Marketplace administrator role from the database on every authenticated request', async () => {
    mockDb.user.findUnique.mockResolvedValue({
      id: 'admin-001',
      email: 'admin@example.com',
      displayName: '审核员',
      avatarUrl: null,
      tokenVersion: 0,
      marketplaceRole: 'admin',
    })
    app = await buildApp()
    const token = app.jwt.sign({ sub: 'admin-001', ver: 0 }, { expiresIn: 3600 })

    const response = await app.inject({
      method: 'GET',
      url: '/api/auth/me',
      headers: { authorization: `Bearer ${token}` },
    })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({ user: { id: 'admin-001', marketplaceRole: 'admin' } })
  })

  it('updates only public profile fields for an authenticated user', async () => {
    mockDb.user.findUnique.mockResolvedValue({
      id: 'user-001', email: 'user@example.com', displayName: '旧名称', avatarUrl: null, tokenVersion: 0,
    })
    mockDb.user.update.mockResolvedValue({
      id: 'user-001', email: 'user@example.com', displayName: '新名称', avatarUrl: 'https://cdn.example.com/avatar.png',
    })
    app = await buildApp()
    const token = app.jwt.sign({ sub: 'user-001', ver: 0 }, { expiresIn: 3600 })

    const response = await app.inject({
      method: 'PATCH',
      url: '/api/auth/profile',
      headers: { authorization: `Bearer ${token}` },
      payload: { displayName: '  新名称  ', avatarUrl: 'https://cdn.example.com/avatar.png' },
    })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({
      user: {
        id: 'user-001',
        email: 'user@example.com',
        displayName: '新名称',
        avatarUrl: 'https://cdn.example.com/avatar.png',
        marketplaceRole: 'user',
        yitanAccountLinked: false,
      },
    })
    expect(mockDb.user.update).toHaveBeenCalledWith({
      where: { id: 'user-001' },
      data: { displayName: '新名称', avatarUrl: 'https://cdn.example.com/avatar.png' },
      select: {
        id: true,
        email: true,
        displayName: true,
        avatarUrl: true,
        marketplaceRole: true,
        externalIdentities: {
          where: { issuer: mockConfig.YITAN_OIDC_ISSUER },
          select: { id: true },
          take: 1,
        },
      },
    })
  })

  it('rejects non-HTTPS avatar URLs', async () => {
    mockDb.user.findUnique.mockResolvedValue({
      id: 'user-001', email: 'user@example.com', displayName: '用户', avatarUrl: null, tokenVersion: 0,
    })
    app = await buildApp()
    const token = app.jwt.sign({ sub: 'user-001', ver: 0 }, { expiresIn: 3600 })

    const response = await app.inject({
      method: 'PATCH',
      url: '/api/auth/profile',
      headers: { authorization: `Bearer ${token}` },
      payload: { avatarUrl: 'http://example.com/avatar.png' },
    })

    expect(response.statusCode).toBe(400)
    expect(mockDb.user.update).not.toHaveBeenCalled()
  })

  it('changes the password, increments token version, and returns a replacement token', async () => {
    const current = await hashPassword('current-password')
    mockDb.user.findUnique.mockResolvedValue({
      id: 'user-001', email: 'user@example.com', displayName: '用户', avatarUrl: null, tokenVersion: 3, ...current,
    })
    mockDb.user.update.mockResolvedValue({
      id: 'user-001', email: 'user@example.com', displayName: '用户', avatarUrl: null, tokenVersion: 4,
    })
    app = await buildApp()
    const token = app.jwt.sign({ sub: 'user-001', ver: 3 }, { expiresIn: 3600 })

    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/change-password',
      headers: { authorization: `Bearer ${token}` },
      payload: { currentPassword: 'current-password', newPassword: 'replacement-password' },
    })

    expect(response.statusCode).toBe(200)
    const payload = response.json()
    expect(payload).toMatchObject({
      tokenType: 'Bearer', expiresIn: 3600,
      user: {
        id: 'user-001',
        email: 'user@example.com',
        displayName: '用户',
        avatarUrl: null,
        marketplaceRole: 'user',
      },
    })
    expect(app.jwt.verify<{ sub: string; ver: number }>(payload.token)).toMatchObject({ sub: 'user-001', ver: 4 })
    const updateData = mockDb.user.update.mock.calls[0]?.[0].data
    expect(updateData.passwordHash).toEqual(expect.any(String))
    expect(updateData.passwordSalt).toEqual(expect.any(String))
    expect(updateData.tokenVersion).toEqual({ increment: 1 })
    expect(response.body).not.toContain('passwordHash')
  })

  it('rejects old JWTs after the account token version changes', async () => {
    mockDb.user.findUnique.mockResolvedValue({
      id: 'user-001', email: 'user@example.com', displayName: '用户', avatarUrl: null, tokenVersion: 2,
    })
    app = await buildApp()
    const oldToken = app.jwt.sign({ sub: 'user-001', ver: 1 }, { expiresIn: 3600 })

    const response = await app.inject({
      method: 'GET', url: '/api/auth/me', headers: { authorization: `Bearer ${oldToken}` },
    })

    expect(response.statusCode).toBe(401)
    expect(response.json()).toEqual({ error: 'Unauthorized' })
  })

  it('revokes the authenticated JWT on logout at the server', async () => {
    const activeUser = {
      id: 'user-001', email: 'user@example.com', displayName: '用户', avatarUrl: null, tokenVersion: 3,
    }
    mockDb.user.findUnique
      .mockResolvedValueOnce(activeUser)
      .mockResolvedValueOnce({ ...activeUser, tokenVersion: 4 })
    mockDb.user.update.mockResolvedValue({ ...activeUser, tokenVersion: 4 })
    app = await buildApp()
    const token = app.jwt.sign({ sub: activeUser.id, ver: 3 }, { expiresIn: 3600 })

    const logout = await app.inject({
      method: 'POST', url: '/api/auth/logout', headers: { authorization: `Bearer ${token}` },
    })
    expect(logout.statusCode).toBe(204)
    expect(mockDb.user.update).toHaveBeenCalledWith({
      where: { id: activeUser.id },
      data: { tokenVersion: { increment: 1 } },
    })

    const reused = await app.inject({
      method: 'GET', url: '/api/auth/me', headers: { authorization: `Bearer ${token}` },
    })
    expect(reused.statusCode).toBe(401)
    expect(reused.json()).toEqual({ error: 'Unauthorized' })
  })

  it('rate limits repeated login attempts on one server instance', async () => {
    mockConfig.AUTH_LOGIN_ATTEMPTS_PER_15_MIN = 1
    mockDb.user.findUnique.mockResolvedValue(null)
    app = await buildApp()
    const request = {
      method: 'POST' as const,
      url: '/api/auth/login',
      payload: { email: 'user@example.com', password: 'secure-password' },
    }

    expect((await app.inject(request)).statusCode).toBe(401)
    const limited = await app.inject(request)
    expect(limited.statusCode).toBe(429)
    expect(limited.json()).toEqual({ error: 'Too many attempts. Try again later.' })
    expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0)
    mockConfig.AUTH_LOGIN_ATTEMPTS_PER_15_MIN = 100
  })

  it('isolates login limits by normalized account as well as IP', async () => {
    mockConfig.AUTH_LOGIN_ATTEMPTS_PER_15_MIN = 1
    mockDb.user.findUnique.mockResolvedValue(null)
    app = await buildApp()

    const firstAccount = {
      method: 'POST' as const,
      url: '/api/auth/login',
      payload: { email: 'FIRST@example.com', password: 'secure-password' },
    }
    const secondAccount = {
      ...firstAccount,
      payload: { email: 'second@example.com', password: 'secure-password' },
    }

    expect((await app.inject(firstAccount)).statusCode).toBe(401)
    expect((await app.inject(secondAccount)).statusCode).toBe(401)
    expect((await app.inject({
      ...firstAccount,
      payload: { ...firstAccount.payload, email: ' first@EXAMPLE.com ' },
    })).statusCode).toBe(429)
  })

  it('uses a wider IP budget to stop random-email limiter key rotation', async () => {
    mockConfig.AUTH_LOGIN_ATTEMPTS_PER_15_MIN = 1
    mockConfig.AUTH_LOGIN_IP_ATTEMPTS_PER_15_MIN = 2
    mockDb.user.findUnique.mockResolvedValue(null)
    app = await buildApp()

    const attempt = (email: string) => app!.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email, password: 'secure-password' },
    })

    expect((await attempt('random-1@example.com')).statusCode).toBe(401)
    expect((await attempt('random-2@example.com')).statusCode).toBe(401)
    expect((await attempt('random-3@example.com')).statusCode).toBe(429)
    expect(mockDb.user.findUnique).toHaveBeenCalledTimes(2)
  })

  it('clears the account-and-IP limiter after a successful login', async () => {
    mockConfig.AUTH_LOGIN_ATTEMPTS_PER_15_MIN = 1
    const credentials = await hashPassword('secure-password')
    mockDb.user.findUnique.mockResolvedValue({
      id: 'user-001', email: 'user@example.com', displayName: '用户', avatarUrl: null, tokenVersion: 0, ...credentials,
    })
    app = await buildApp()
    const request = {
      method: 'POST' as const,
      url: '/api/auth/login',
      payload: { email: 'user@example.com', password: 'secure-password' },
    }

    expect((await app.inject(request)).statusCode).toBe(200)
    expect((await app.inject(request)).statusCode).toBe(200)
  })

  it('keeps new local registration closed during a legacy-auth rollback', async () => {
    mockConfig.AUTH_MODE = 'legacy'
    mockConfig.LOCAL_REGISTRATION_ENABLED = false
    app = await buildApp()

    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { email: 'new@example.com', password: 'secure-password', displayName: '新用户' },
    })

    expect(response.statusCode).toBe(410)
    expect(response.json()).toEqual({
      error: 'AUTH_PORTAL_REQUIRED',
      message: 'New accounts must be created in the Yitan account portal',
    })
    expect(mockDb.user.create).not.toHaveBeenCalled()
  })

  it('does not implicitly close local registration when dual login is enabled in development', async () => {
    mockConfig.AUTH_MODE = 'dual'
    mockConfig.LOCAL_REGISTRATION_ENABLED = true
    mockDb.user.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
      id: 'user-dual',
      email: data.email,
      displayName: data.displayName,
      avatarUrl: null,
      marketplaceRole: 'user',
      tokenVersion: 0,
      externalIdentities: [],
    }))
    app = await buildApp()

    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { email: 'dual@example.com', password: 'secure-password', displayName: '双栈用户' },
    })

    expect(response.statusCode).toBe(201)
  })

  it('uses only a local User UUID allowlist for target-mode legacy login', async () => {
    const userId = '11111111-1111-4111-8111-111111111111'
    const credentials = await hashPassword('secure-password')
    mockConfig.AUTH_MODE = 'yitan'
    mockConfig.AUTH_LEGACY_MIGRATION_ALLOWLIST = ['user@example.com']
    mockDb.user.findUnique.mockResolvedValue({
      id: userId,
      email: 'user@example.com',
      displayName: '旧用户',
      avatarUrl: null,
      marketplaceRole: 'user',
      tokenVersion: 0,
      ...credentials,
    })
    app = await buildApp()
    const request = {
      method: 'POST' as const,
      url: '/api/auth/login',
      payload: { email: 'user@example.com', password: 'secure-password' },
    }

    const emailOnly = await app.inject(request)
    expect(emailOnly.statusCode).toBe(403)
    expect(emailOnly.json()).toMatchObject({ error: 'LEGACY_LOGIN_MIGRATION_ONLY' })

    mockConfig.AUTH_LEGACY_MIGRATION_ALLOWLIST = [userId]
    const allowed = await app.inject(request)
    expect(allowed.statusCode).toBe(200)
    expect(allowed.json()).toMatchObject({ expiresIn: 600 })
  })

  it('rejects target-mode password login after the allowlisted user is mapped', async () => {
    const userId = '11111111-1111-4111-8111-111111111111'
    const credentials = await hashPassword('secure-password')
    mockConfig.AUTH_MODE = 'yitan'
    mockConfig.AUTH_LEGACY_MIGRATION_ALLOWLIST = [userId]
    mockDb.user.findUnique.mockResolvedValue({
      id: userId,
      email: 'user@example.com',
      displayName: '已迁移用户',
      avatarUrl: null,
      marketplaceRole: 'user',
      tokenVersion: 4,
      externalIdentities: [{ id: 'identity-001' }],
      ...credentials,
    })
    app = await buildApp()

    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'user@example.com', password: 'secure-password' },
    })

    expect(response.statusCode).toBe(403)
    expect(response.json()).toMatchObject({ error: 'LEGACY_LOGIN_MIGRATION_ONLY' })
  })

  it('exchanges a verified mapped Yitan identity for the existing local product session', async () => {
    mockConfig.AUTH_MODE = 'dual'
    mockDb.externalIdentity.findUnique.mockResolvedValue({
      id: 'identity-001',
      userId: 'local-user-001',
      lastLogoutAt: null,
      user: {
        id: 'local-user-001',
        email: 'legacy@example.com',
        displayName: '保留资料',
        avatarUrl: null,
        marketplaceRole: 'user',
        tokenVersion: 4,
        externalIdentities: [{ id: 'identity-001' }],
      },
    })
    app = await buildApp()

    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/yitan/exchange',
      payload: { accessToken: 'access-token', idToken: 'id-token', nonce: 'nonce-that-is-long-enough' },
    })

    expect(response.statusCode).toBe(200)
    const payload = response.json()
    expect(payload.user).toMatchObject({
      id: 'local-user-001',
      email: 'legacy@example.com',
      displayName: '保留资料',
      yitanAccountLinked: true,
    })
    expect(app.jwt.verify<{ sub: string; ver: number }>(payload.token)).toMatchObject({
      sub: 'local-user-001',
      ver: 4,
    })
  })

  it('never auto-binds a portal identity when its verified email collides with a local user', async () => {
    mockConfig.AUTH_MODE = 'dual'
    mockDb.user.findFirst.mockResolvedValue({ id: 'existing-local-user' })
    app = await buildApp()

    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/yitan/exchange',
      payload: { accessToken: 'access-token', idToken: 'id-token', nonce: 'nonce-that-is-long-enough' },
    })

    expect(response.statusCode).toBe(409)
    expect(response.json()).toMatchObject({ error: 'YITAN_ACCOUNT_LINK_REQUIRED' })
    expect(mockDb.user.create).not.toHaveBeenCalled()
    expect(mockDb.externalIdentity.create).not.toHaveBeenCalled()
  })

  it('provisions a new local user and mapping only when no local email collides', async () => {
    mockConfig.AUTH_MODE = 'dual'
    mockDb.user.create.mockResolvedValue({
      id: 'new-local-user',
      email: 'user@example.com',
      displayName: '一探用户',
      avatarUrl: null,
      marketplaceRole: 'user',
      tokenVersion: 0,
      externalIdentities: [{ id: 'identity-new' }],
    })
    app = await buildApp()

    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/yitan/exchange',
      payload: { accessToken: 'access-token', idToken: 'id-token', nonce: 'nonce-that-is-long-enough' },
    })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({ user: { id: 'new-local-user', yitanAccountLinked: true } })
    expect(mockDb.user.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        email: 'user@example.com',
        externalIdentities: {
          create: {
            issuer: mockConfig.YITAN_OIDC_ISSUER,
            subject: 'central-user-001',
            linkMethod: 'oidc_provisioned',
          },
        },
      }),
    }))
    expect(mockDb.user.create.mock.calls[0]?.[0].data).not.toHaveProperty('passwordHash')
  })

  it('links an allowlisted legacy user only with a current local session and fresh portal proof', async () => {
    const userId = '11111111-1111-4111-8111-111111111111'
    const localUserProfile = {
      id: userId,
      email: 'legacy@example.com',
      displayName: '旧用户资料',
      avatarUrl: null,
      marketplaceRole: 'user',
    }
    let currentTokenVersion = 2
    let linked = false
    const currentUser = () => ({
      ...localUserProfile,
      tokenVersion: currentTokenVersion,
      externalIdentities: linked ? [{ id: 'identity-linked' }] : [],
    })
    mockConfig.AUTH_MODE = 'dual'
    mockConfig.AUTH_LEGACY_MIGRATION_ALLOWLIST = [userId]
    mockDb.user.findUnique.mockImplementation(async () => currentUser())
    mockDb.user.update.mockImplementation(async () => {
      currentTokenVersion += 1
      return currentUser()
    })
    mockDb.externalIdentity.findUnique.mockImplementation(async () => linked ? {
      id: 'identity-linked',
      userId,
      issuer: mockConfig.YITAN_OIDC_ISSUER,
      subject: 'central-user-001',
      lastLogoutAt: null,
    } : null)
    mockDb.externalIdentity.create.mockImplementation(async () => {
      linked = true
      return {
        id: 'identity-linked',
        userId,
        issuer: mockConfig.YITAN_OIDC_ISSUER,
        subject: 'central-user-001',
      }
    })
    app = await buildApp()
    const oldToken = app.jwt.sign({ sub: userId, ver: 2 }, { expiresIn: 3600 })

    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/yitan/link',
      headers: { authorization: `Bearer ${oldToken}` },
      payload: {
        accessToken: 'access-token',
        idToken: 'id-token',
        nonce: 'nonce-that-is-long-enough',
        expectedLocalUserId: userId,
      },
    })

    expect(response.statusCode).toBe(200)
    const linkedSession = response.json()
    expect(linkedSession).toMatchObject({
      user: { id: userId, email: 'legacy@example.com', yitanAccountLinked: true },
    })
    expect(app.jwt.verify<{ sub: string; ver: number; purpose: string }>(linkedSession.token)).toMatchObject({
      sub: userId,
      ver: 3,
      purpose: 'product',
    })
    expect(mockDb.externalIdentity.create).toHaveBeenCalledWith({
      data: {
        userId,
        issuer: mockConfig.YITAN_OIDC_ISSUER,
        subject: 'central-user-001',
        linkMethod: 'legacy_session',
      },
    })
    expect(mockDb.user.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: userId },
      data: { tokenVersion: { increment: 1 } },
    }))

    const oldSession = await app.inject({
      method: 'GET',
      url: '/api/auth/me',
      headers: { authorization: `Bearer ${oldToken}` },
    })
    expect(oldSession.statusCode).toBe(401)

    const newSession = await app.inject({
      method: 'GET',
      url: '/api/auth/me',
      headers: { authorization: `Bearer ${linkedSession.token}` },
    })
    expect(newSession.statusCode).toBe(200)
    expect(newSession.json()).toMatchObject({
      user: { id: userId, yitanAccountLinked: true },
    })
  })

  it('rejects a web-admin JWT when it is presented as a product Bearer for linking', async () => {
    const userId = '11111111-1111-4111-8111-111111111111'
    mockConfig.AUTH_MODE = 'dual'
    mockConfig.AUTH_LEGACY_MIGRATION_ALLOWLIST = [userId]
    app = await buildApp()
    const adminToken = app.jwt.sign({
      sub: userId,
      ver: 0,
      purpose: 'web-admin',
      webAdmin: true,
    }, { expiresIn: 3600 })

    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/yitan/link',
      headers: { authorization: `Bearer ${adminToken}` },
      payload: {
        accessToken: 'access-token',
        idToken: 'id-token',
        nonce: 'nonce-that-is-long-enough',
        expectedLocalUserId: userId,
      },
    })

    expect(response.statusCode).toBe(401)
    expect(mockYitan.verifyTokenPair).not.toHaveBeenCalled()
    expect(mockDb.user.findUnique).not.toHaveBeenCalled()
    expect(mockDb.externalIdentity.create).not.toHaveBeenCalled()
  })

  it('rejects a stale local-account expectation before verifying or mutating the portal link', async () => {
    const userId = '11111111-1111-4111-8111-111111111111'
    mockConfig.AUTH_MODE = 'dual'
    mockConfig.AUTH_LEGACY_MIGRATION_ALLOWLIST = [userId]
    mockDb.user.findUnique.mockResolvedValue({
      id: userId,
      email: 'legacy@example.com',
      displayName: '旧用户',
      avatarUrl: null,
      marketplaceRole: 'user',
      tokenVersion: 2,
      externalIdentities: [],
    })
    app = await buildApp()
    const token = app.jwt.sign({
      sub: userId,
      ver: 2,
      purpose: 'product',
    }, { expiresIn: 3600 })

    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/yitan/link',
      headers: { authorization: `Bearer ${token}` },
      payload: {
        accessToken: 'access-token',
        idToken: 'id-token',
        nonce: 'nonce-that-is-long-enough',
        expectedLocalUserId: '22222222-2222-4222-8222-222222222222',
      },
    })

    expect(response.statusCode).toBe(409)
    expect(response.json()).toMatchObject({ error: 'YITAN_LOCAL_USER_MISMATCH' })
    expect(mockYitan.verifyTokenPair).not.toHaveBeenCalled()
    expect(mockDb.$transaction).not.toHaveBeenCalled()
    expect(mockLocks.externalIdentity).not.toHaveBeenCalled()
    expect(mockLocks.user).not.toHaveBeenCalled()
    expect(mockDb.externalIdentity.create).not.toHaveBeenCalled()
    expect(mockDb.user.update).not.toHaveBeenCalled()
  })

  it('rejects linking when the local session is revoked after middleware verification', async () => {
    const userId = '11111111-1111-4111-8111-111111111111'
    const user = {
      id: userId,
      email: 'legacy@example.com',
      displayName: '旧用户',
      avatarUrl: null,
      marketplaceRole: 'user',
      externalIdentities: [],
    }
    mockConfig.AUTH_MODE = 'dual'
    mockConfig.AUTH_LEGACY_MIGRATION_ALLOWLIST = [userId]
    mockDb.user.findUnique
      .mockResolvedValueOnce({ ...user, tokenVersion: 2 })
      .mockResolvedValueOnce({ ...user, tokenVersion: 3 })
    app = await buildApp()
    const revokedDuringRequest = app.jwt.sign({
      sub: userId,
      ver: 2,
      purpose: 'product',
    }, { expiresIn: 3600 })

    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/yitan/link',
      headers: { authorization: `Bearer ${revokedDuringRequest}` },
      payload: {
        accessToken: 'access-token',
        idToken: 'id-token',
        nonce: 'nonce-that-is-long-enough',
        expectedLocalUserId: userId,
      },
    })

    expect(response.statusCode).toBe(401)
    expect(response.json()).toMatchObject({ error: 'UNAUTHORIZED' })
    expect(mockLocks.externalIdentity).toHaveBeenCalledWith(
      mockDb,
      mockConfig.YITAN_OIDC_ISSUER,
      'central-user-001'
    )
    expect(mockLocks.user).toHaveBeenCalledWith(mockDb, userId)
    expect(mockLocks.externalIdentity.mock.invocationCallOrder[0]).toBeLessThan(
      mockLocks.user.mock.invocationCallOrder[0]!
    )
    expect(mockDb.externalIdentity.create).not.toHaveBeenCalled()
    expect(mockDb.user.update).not.toHaveBeenCalled()
  })

  it('keeps an identical link retry idempotent without rotating tokenVersion again', async () => {
    const userId = '11111111-1111-4111-8111-111111111111'
    const linkedUser = {
      id: userId,
      email: 'legacy@example.com',
      displayName: '旧用户资料',
      avatarUrl: null,
      marketplaceRole: 'user',
      tokenVersion: 3,
      externalIdentities: [{ id: 'identity-linked' }],
    }
    const existingIdentity = {
      id: 'identity-linked',
      userId,
      issuer: mockConfig.YITAN_OIDC_ISSUER,
      subject: 'central-user-001',
      lastLogoutAt: null,
    }
    mockConfig.AUTH_MODE = 'dual'
    mockConfig.AUTH_LEGACY_MIGRATION_ALLOWLIST = [userId]
    mockDb.user.findUnique.mockResolvedValue(linkedUser)
    mockDb.externalIdentity.findUnique.mockResolvedValue(existingIdentity)
    app = await buildApp()
    const currentToken = app.jwt.sign({ sub: userId, ver: 3 }, { expiresIn: 3600 })

    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/yitan/link',
      headers: { authorization: `Bearer ${currentToken}` },
      payload: {
        accessToken: 'access-token',
        idToken: 'id-token',
        nonce: 'nonce-that-is-long-enough',
        expectedLocalUserId: userId,
      },
    })

    expect(response.statusCode).toBe(200)
    expect(app.jwt.verify<{ sub: string; ver: number }>(response.json().token)).toMatchObject({
      sub: userId,
      ver: 3,
    })
    expect(mockDb.externalIdentity.update).toHaveBeenCalledWith({
      where: { id: 'identity-linked' },
      data: { lastLoginAt: expect.any(Date) },
    })
    expect(mockDb.externalIdentity.create).not.toHaveBeenCalled()
    expect(mockDb.user.update).not.toHaveBeenCalled()
  })

  it('rejects linking when the portal authentication is not verified and recent', async () => {
    const userId = '11111111-1111-4111-8111-111111111111'
    mockConfig.AUTH_MODE = 'dual'
    mockConfig.AUTH_LEGACY_MIGRATION_ALLOWLIST = [userId]
    mockDb.user.findUnique.mockResolvedValue({
      id: userId,
      email: 'legacy@example.com',
      displayName: '旧用户',
      avatarUrl: null,
      marketplaceRole: 'user',
      tokenVersion: 0,
    })
    mockYitan.verifyTokenPair.mockResolvedValue({
      issuer: mockConfig.YITAN_OIDC_ISSUER,
      subject: 'central-user-001',
      authorizedParty: 'skillhub-desktop',
      email: 'user@example.com',
      emailVerified: false,
      displayName: null,
      avatarUrl: null,
      authTime: null,
      issuedAt: Math.floor(Date.now() / 1_000),
    })
    app = await buildApp()
    const token = app.jwt.sign({ sub: userId, ver: 0 }, { expiresIn: 3600 })

    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/yitan/link',
      headers: { authorization: `Bearer ${token}` },
      payload: {
        accessToken: 'access-token',
        idToken: 'id-token',
        nonce: 'nonce-that-is-long-enough',
        expectedLocalUserId: userId,
      },
    })

    expect(response.statusCode).toBe(401)
    expect(response.json()).toMatchObject({ error: 'YITAN_REAUTH_REQUIRED' })
    expect(mockDb.externalIdentity.create).not.toHaveBeenCalled()
  })

  it('refuses to replace a different Yitan subject already bound to the local user', async () => {
    const userId = '11111111-1111-4111-8111-111111111111'
    mockConfig.AUTH_MODE = 'dual'
    mockConfig.AUTH_LEGACY_MIGRATION_ALLOWLIST = [userId]
    mockDb.user.findUnique.mockResolvedValue({
      id: userId,
      email: 'legacy@example.com',
      displayName: '旧用户',
      avatarUrl: null,
      marketplaceRole: 'user',
      tokenVersion: 0,
      externalIdentities: [],
    })
    mockDb.externalIdentity.findUnique.mockResolvedValueOnce({
      id: 'identity-other',
      userId,
      issuer: mockConfig.YITAN_OIDC_ISSUER,
      subject: 'different-central-user',
      lastLogoutAt: null,
    })
    app = await buildApp()
    const token = app.jwt.sign({ sub: userId, ver: 0 }, { expiresIn: 3600 })

    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/yitan/link',
      headers: { authorization: `Bearer ${token}` },
      payload: {
        accessToken: 'access-token',
        idToken: 'id-token',
        nonce: 'nonce-that-is-long-enough',
        expectedLocalUserId: userId,
      },
    })

    expect(response.statusCode).toBe(409)
    expect(response.json()).toMatchObject({ error: 'YITAN_LOCAL_ACCOUNT_ALREADY_LINKED' })
    expect(mockDb.externalIdentity.create).not.toHaveBeenCalled()
    expect(mockDb.user.update).not.toHaveBeenCalled()
  })

  it('refuses to bind a Yitan subject already owned by another local user', async () => {
    const userId = '11111111-1111-4111-8111-111111111111'
    mockConfig.AUTH_MODE = 'dual'
    mockConfig.AUTH_LEGACY_MIGRATION_ALLOWLIST = [userId]
    mockDb.user.findUnique.mockResolvedValue({
      id: userId,
      email: 'legacy@example.com',
      displayName: '旧用户',
      avatarUrl: null,
      marketplaceRole: 'user',
      tokenVersion: 0,
      externalIdentities: [],
    })
    mockDb.externalIdentity.findUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        id: 'identity-owned',
        userId: 'another-local-user',
        issuer: mockConfig.YITAN_OIDC_ISSUER,
        subject: 'central-user-001',
        lastLogoutAt: null,
      })
    app = await buildApp()
    const token = app.jwt.sign({ sub: userId, ver: 0 }, { expiresIn: 3600 })

    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/yitan/link',
      headers: { authorization: `Bearer ${token}` },
      payload: {
        accessToken: 'access-token',
        idToken: 'id-token',
        nonce: 'nonce-that-is-long-enough',
        expectedLocalUserId: userId,
      },
    })

    expect(response.statusCode).toBe(409)
    expect(response.json()).toMatchObject({ error: 'YITAN_IDENTITY_ALREADY_LINKED' })
    expect(mockDb.externalIdentity.create).not.toHaveBeenCalled()
    expect(mockDb.user.update).not.toHaveBeenCalled()
  })

  it('rejects exchange and link tokens issued before an unknown-subject logout', async () => {
    const userId = '11111111-1111-4111-8111-111111111111'
    const logoutIssuedAt = Math.floor(Date.now() / 1_000)
    let latestLogoutAt: Date | null = null
    mockConfig.AUTH_MODE = 'dual'
    mockConfig.AUTH_LEGACY_MIGRATION_ALLOWLIST = [userId]
    mockYitan.verifyLogout.mockResolvedValue({
      issuer: mockConfig.YITAN_OIDC_ISSUER,
      subject: 'central-user-001',
      issuedAt: logoutIssuedAt,
      tokenId: 'logout-before-link',
    })
    mockYitan.verifyTokenPair.mockResolvedValue({
      issuer: mockConfig.YITAN_OIDC_ISSUER,
      subject: 'central-user-001',
      authorizedParty: 'skillhub-desktop',
      email: 'user@example.com',
      emailVerified: true,
      displayName: '一探用户',
      avatarUrl: null,
      authTime: logoutIssuedAt - 30,
      issuedAt: logoutIssuedAt - 1,
    })
    mockDb.user.findUnique.mockResolvedValue({
      id: userId,
      email: 'legacy@example.com',
      displayName: '旧用户',
      avatarUrl: null,
      marketplaceRole: 'user',
      tokenVersion: 0,
      externalIdentities: [],
    })
    mockDb.oidcLogoutWatermark.findUnique.mockImplementation(async () => latestLogoutAt
      ? { latestLogoutAt }
      : null)
    mockDb.oidcLogoutWatermark.upsert.mockImplementation(async (input: {
      create: { latestLogoutAt: Date }
      update: { latestLogoutAt: Date }
    }) => {
      latestLogoutAt = input.create.latestLogoutAt ?? input.update.latestLogoutAt
      return { latestLogoutAt }
    })
    app = await buildApp()

    const logout = await app.inject({
      method: 'POST',
      url: '/api/auth/yitan/backchannel-logout',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: 'logout_token=unknown-subject-logout-token',
    })
    expect(logout.statusCode).toBe(200)
    expect(mockDb.oidcLogoutWatermark.upsert).toHaveBeenCalledTimes(1)
    expect(mockDb.user.update).not.toHaveBeenCalled()

    const tokenPair = {
      accessToken: 'access-token',
      idToken: 'id-token',
      nonce: 'nonce-that-is-long-enough',
    }
    const exchange = await app.inject({
      method: 'POST',
      url: '/api/auth/yitan/exchange',
      payload: tokenPair,
    })
    expect(exchange.statusCode).toBe(401)
    expect(exchange.json()).toMatchObject({ error: 'YITAN_TOKEN_REVOKED' })

    const localToken = app.jwt.sign({ sub: userId, ver: 0 }, { expiresIn: 3600 })
    const link = await app.inject({
      method: 'POST',
      url: '/api/auth/yitan/link',
      headers: { authorization: `Bearer ${localToken}` },
      payload: { ...tokenPair, expectedLocalUserId: userId },
    })
    expect(link.statusCode).toBe(401)
    expect(link.json()).toMatchObject({ error: 'YITAN_TOKEN_REVOKED' })
    expect(mockDb.user.create).not.toHaveBeenCalled()
    expect(mockDb.externalIdentity.create).not.toHaveBeenCalled()
    expect(mockDb.user.update).not.toHaveBeenCalled()
  })

  it('serializes concurrent duplicate logout delivery into one watermark advance', async () => {
    const issuedAt = Math.floor(Date.now() / 1_000)
    let latestLogoutAt: Date | null = null
    let transactionTail = Promise.resolve()
    mockYitan.verifyLogout.mockResolvedValue({
      issuer: mockConfig.YITAN_OIDC_ISSUER,
      subject: 'central-user-001',
      issuedAt,
      tokenId: 'concurrent-logout-event',
    })
    mockDb.$transaction.mockImplementation(async (
      callback: (client: typeof mockDb) => Promise<unknown>
    ) => {
      const previous = transactionTail
      let release = (): void => undefined
      transactionTail = new Promise<void>((resolve) => {
        release = resolve
      })
      await previous
      try {
        return await callback(mockDb)
      } finally {
        release()
      }
    })
    mockDb.oidcLogoutWatermark.findUnique.mockImplementation(async () => latestLogoutAt
      ? { latestLogoutAt }
      : null)
    mockDb.oidcLogoutWatermark.upsert.mockImplementation(async (input: {
      create: { latestLogoutAt: Date }
    }) => {
      latestLogoutAt = input.create.latestLogoutAt
      return { latestLogoutAt }
    })
    mockDb.externalIdentity.findUnique.mockResolvedValue({
      id: 'identity-001',
      userId: 'local-user-001',
    })
    app = await buildApp()
    const request = {
      method: 'POST' as const,
      url: '/api/auth/yitan/backchannel-logout',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: 'logout_token=concurrent-signed-token',
    }

    const responses = await Promise.all([app.inject(request), app.inject(request)])

    expect(responses.map((response) => response.statusCode)).toEqual([200, 200])
    expect(mockLocks.externalIdentity).toHaveBeenCalledTimes(2)
    expect(mockLocks.externalIdentity).toHaveBeenNthCalledWith(
      1,
      mockDb,
      mockConfig.YITAN_OIDC_ISSUER,
      'central-user-001'
    )
    expect(mockLocks.externalIdentity).toHaveBeenNthCalledWith(
      2,
      mockDb,
      mockConfig.YITAN_OIDC_ISSUER,
      'central-user-001'
    )
    expect(mockDb.oidcLogoutWatermark.upsert).toHaveBeenCalledTimes(1)
    expect(mockDb.user.update).toHaveBeenCalledTimes(1)
    expect(mockLocks.user).toHaveBeenCalledTimes(1)
    expect(mockDb.externalIdentity.update).toHaveBeenCalledTimes(1)
  })

  it('ignores an older logout but atomically advances a newer watermark', async () => {
    const initialIssuedAt = Math.floor(Date.now() / 1_000) - 10
    let latestLogoutAt = new Date(initialIssuedAt * 1_000)
    mockYitan.verifyLogout
      .mockResolvedValueOnce({
        issuer: mockConfig.YITAN_OIDC_ISSUER,
        subject: 'central-user-001',
        issuedAt: initialIssuedAt - 1,
        tokenId: 'older-logout-event',
      })
      .mockResolvedValueOnce({
        issuer: mockConfig.YITAN_OIDC_ISSUER,
        subject: 'central-user-001',
        issuedAt: initialIssuedAt + 1,
        tokenId: 'newer-logout-event',
      })
    mockDb.oidcLogoutWatermark.findUnique.mockImplementation(async () => ({ latestLogoutAt }))
    mockDb.oidcLogoutWatermark.upsert.mockImplementation(async (input: {
      create: { latestLogoutAt: Date }
      update: { latestLogoutAt: Date }
    }) => {
      latestLogoutAt = input.update.latestLogoutAt ?? input.create.latestLogoutAt
      return { latestLogoutAt }
    })
    mockDb.externalIdentity.findUnique.mockResolvedValue({
      id: 'identity-001',
      userId: 'local-user-001',
    })
    app = await buildApp()
    const request = {
      method: 'POST' as const,
      url: '/api/auth/yitan/backchannel-logout',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: 'logout_token=signed-logout-token',
    }

    expect((await app.inject(request)).statusCode).toBe(200)
    expect(mockDb.oidcLogoutWatermark.upsert).not.toHaveBeenCalled()
    expect(mockDb.user.update).not.toHaveBeenCalled()

    expect((await app.inject(request)).statusCode).toBe(200)
    expect(mockDb.oidcLogoutWatermark.upsert).toHaveBeenCalledTimes(1)
    expect(latestLogoutAt).toEqual(new Date((initialIssuedAt + 1) * 1_000))
    expect(mockDb.user.update).toHaveBeenCalledTimes(1)
  })

  it('persists back-channel logout replay protection and increments tokenVersion only once', async () => {
    const issuedAt = Math.floor(Date.now() / 1_000)
    mockYitan.verifyLogout.mockResolvedValue({
      issuer: mockConfig.YITAN_OIDC_ISSUER,
      subject: 'central-user-001',
      issuedAt,
      tokenId: 'logout-event-001',
    })
    mockDb.oidcLogoutWatermark.findUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ latestLogoutAt: new Date(issuedAt * 1_000) })
    mockDb.externalIdentity.findUnique.mockResolvedValue({
      id: 'identity-001',
      userId: 'local-user-001',
    })
    app = await buildApp()
    const request = {
      method: 'POST' as const,
      url: '/api/auth/yitan/backchannel-logout',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: 'logout_token=signed-logout-token',
    }

    expect((await app.inject(request)).statusCode).toBe(200)
    expect((await app.inject(request)).statusCode).toBe(200)
    expect(mockDb.user.update).toHaveBeenCalledTimes(1)
    expect(mockDb.user.update).toHaveBeenCalledWith({
      where: { id: 'local-user-001' },
      data: { tokenVersion: { increment: 1 }, catalogTokenVersion: { increment: 1 } },
    })
    expect(mockDb.oidcLogoutWatermark.upsert).toHaveBeenCalledTimes(1)
    expect(mockDb.oidcLogoutWatermark.upsert).toHaveBeenCalledWith({
      where: {
        issuer_subject: {
          issuer: mockConfig.YITAN_OIDC_ISSUER,
          subject: 'central-user-001',
        },
      },
      create: {
        issuer: mockConfig.YITAN_OIDC_ISSUER,
        subject: 'central-user-001',
        latestLogoutAt: new Date(issuedAt * 1_000),
      },
      update: { latestLogoutAt: new Date(issuedAt * 1_000) },
    })
    expect(mockDb.externalIdentity.update).toHaveBeenCalledTimes(1)
    expect(mockLocks.externalIdentity.mock.invocationCallOrder[0]).toBeLessThan(
      mockLocks.user.mock.invocationCallOrder[0]!
    )
  })

  it('rejects malformed back-channel requests and never accepts JSON logout tokens', async () => {
    app = await buildApp()
    const json = await app.inject({
      method: 'POST',
      url: '/api/auth/yitan/backchannel-logout',
      payload: { logout_token: 'signed-logout-token' },
    })
    expect(json.statusCode).toBe(400)
    expect(json.headers['cache-control']).toBe('no-store')
    expect(mockYitan.verifyLogout).not.toHaveBeenCalled()

    mockYitan.verifyLogout.mockRejectedValue(new Error('invalid'))
    const invalid = await app.inject({
      method: 'POST',
      url: '/api/auth/yitan/backchannel-logout',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: 'logout_token=invalid-token',
    })
    expect(invalid.statusCode).toBe(400)
    expect(invalid.json()).toMatchObject({ error: 'invalid_request' })
    expect(mockDb.user.update).not.toHaveBeenCalled()
  })

  it('registers the isolated test-realm backchannel only behind its explicit flag', async () => {
    mockConfig.YITAN_TEST_BACKCHANNEL_ENABLED = true
    app = await buildApp()

    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/yitan-test/backchannel-logout',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: 'logout_token=signed-test-logout-token',
    })

    expect(response.statusCode).toBe(200)
    expect(mockYitan.verifyTestLogout).toHaveBeenCalledWith('signed-test-logout-token')
    expect(mockYitan.verifyLogout).not.toHaveBeenCalled()
    expect(mockDb.oidcLogoutWatermark.upsert).toHaveBeenCalledTimes(1)
    expect(mockDb.user.update).not.toHaveBeenCalled()
  })

  it('rejects re-exchange of portal tokens issued at or before the last logout', async () => {
    const now = Math.floor(Date.now() / 1_000)
    mockConfig.AUTH_MODE = 'dual'
    mockYitan.verifyTokenPair.mockResolvedValue({
      issuer: mockConfig.YITAN_OIDC_ISSUER,
      subject: 'central-user-001',
      authorizedParty: 'skillhub-desktop',
      email: 'user@example.com',
      emailVerified: true,
      displayName: null,
      avatarUrl: null,
      authTime: now - 30,
      issuedAt: now - 1,
    })
    mockDb.oidcLogoutWatermark.findUnique.mockResolvedValue({
      latestLogoutAt: new Date(now * 1_000),
    })
    app = await buildApp()

    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/yitan/exchange',
      payload: { accessToken: 'access-token', idToken: 'id-token', nonce: 'nonce-that-is-long-enough' },
    })
    expect(response.statusCode).toBe(401)
    expect(response.json()).toMatchObject({ error: 'YITAN_TOKEN_REVOKED' })
  })
})
