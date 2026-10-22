import Fastify, { type FastifyInstance } from 'fastify'
import jwt from '@fastify/jwt'
import { Prisma, type InstanceSetup } from '@prisma/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { verifyPassword } from '../lib/password.js'

const mockDb = vi.hoisted(() => ({
  $transaction: vi.fn(), $queryRaw: vi.fn(),
  instanceSetup: { findUnique: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
  user: { create: vi.fn() },
}))
const mockConfig = vi.hoisted(() => ({
  AUTH_REGISTER_ATTEMPTS_PER_HOUR: 100, JWT_EXPIRES_IN_SECONDS: 3600, YITAN_OIDC_ISSUER: 'https://identity.example.test',
}))
vi.mock('../db.js', () => ({ db: mockDb }))
vi.mock('../config.js', () => ({ config: mockConfig }))
vi.mock('../middleware/auth.js', () => ({ authMiddleware: vi.fn() }))
import { setupRoutes } from './setup.js'
import { hashSetupCode } from '../lib/instance-setup.js'

describe('instance setup routes', () => {
  let app: FastifyInstance
  let state: InstanceSetup
  const code = 'ABCD-EFGH-JKLM-NPQR'
  const payload = { code, email: ' ADMIN@Example.com ', displayName: ' 管理员 ', password: 'secure-password' }
  beforeEach(async (): Promise<void> => {
    vi.resetAllMocks()
    mockConfig.AUTH_REGISTER_ATTEMPTS_PER_HOUR = 100
    state = { id: 1, initializedAt: null, codeHash: hashSetupCode(code), codeExpiresAt: new Date(Date.now() + 1800000), codeAttempts: 0, updatedAt: new Date() }
    mockDb.$transaction.mockImplementation(async (callback: (client: typeof mockDb) => Promise<unknown>): Promise<unknown> => {
      const previous = { ...state }
      try { return await callback(mockDb) }
      catch (error: unknown) { state = previous; throw error }
    })
    mockDb.$queryRaw.mockImplementation(async (): Promise<InstanceSetup[]> => [{ ...state }])
    mockDb.instanceSetup.findUnique.mockImplementation(async (): Promise<InstanceSetup> => state)
    mockDb.instanceSetup.update.mockImplementation(async ({ data }: { data: Partial<InstanceSetup> }): Promise<InstanceSetup> => Object.assign(state, data))
    mockDb.instanceSetup.updateMany.mockImplementation(async ({ where, data }: { where: Partial<InstanceSetup>; data: Partial<InstanceSetup> }): Promise<{ count: number }> => {
      if (state.initializedAt !== where.initializedAt || state.codeHash !== where.codeHash) return { count: 0 }
      Object.assign(state, data)
      return { count: 1 }
    })
    mockDb.user.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }): Promise<Record<string, unknown>> => ({ ...data, id: 'admin-1', avatarUrl: null, tokenVersion: 0 }))
    app = Fastify()
    await app.register(jwt, { secret: 'setup-test-secret-not-for-production' })
    await app.register(setupRoutes, { prefix: '/api/setup' })
  })
  afterEach(async (): Promise<void> => { await app.close() })

  it('commits failed attempts, invalidates the fifth failure, then initializes exactly once with a fresh valid code', async (): Promise<void> => {
    expect((await app.inject('/api/setup/status')).json()).toEqual({ initialized: false })
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      expect((await app.inject({ method: 'POST', url: '/api/setup/admin', payload: { ...payload, code: 'wrong' } })).statusCode).toBe(401)
      expect(state.codeAttempts).toBe(attempt)
    }
    expect(state.codeHash).toBeNull()
    expect(state.codeExpiresAt).toBeNull()
    expect((await app.inject({ method: 'POST', url: '/api/setup/admin', payload })).statusCode).toBe(410)
    state.codeHash = hashSetupCode(code)
    state.codeAttempts = 0
    state.codeExpiresAt = new Date(Date.now() - 1)
    expect((await app.inject({ method: 'POST', url: '/api/setup/admin', payload })).statusCode).toBe(410)
    expect(mockDb.user.create).not.toHaveBeenCalled()
    state.codeExpiresAt = new Date(Date.now() + 1800000)
    const response = await app.inject({ method: 'POST', url: '/api/setup/admin', payload })
    expect(response.statusCode).toBe(201)
    expect(response.json()).toMatchObject({ tokenType: 'Bearer', expiresIn: 3600, user: {
      id: 'admin-1', email: 'admin@example.com', displayName: '管理员', marketplaceRole: 'admin', yitanAccountLinked: false,
    } })
    expect(app.jwt.verify(response.json().token)).toMatchObject({ sub: 'admin-1', ver: 0, purpose: 'product' })
    expect(response.body).not.toContain('passwordHash')
    expect(response.body).not.toContain('passwordSalt')
    expect(response.body).not.toContain(code)
    const data = mockDb.user.create.mock.calls[0]?.[0].data
    expect(await verifyPassword(payload.password, data.passwordHash, data.passwordSalt)).toBe(true)
    expect(state.codeHash).toBeNull()
    expect(state.codeExpiresAt).toBeNull()
    expect(mockDb.$queryRaw.mock.calls[0]?.[0].join('')).toContain('WHERE "id" = 1 FOR UPDATE')
    expect(mockDb.instanceSetup.updateMany).toHaveBeenCalledWith({
      where: { id: 1, initializedAt: null, codeHash: hashSetupCode(code) },
      data: { initializedAt: expect.any(Date), codeHash: null, codeExpiresAt: null },
    })
    expect((await app.inject({ method: 'POST', url: '/api/setup/admin', payload })).statusCode).toBe(409)
    expect((await app.inject('/api/setup/status')).json()).toEqual({ initialized: true })
    expect(mockDb.user.create).toHaveBeenCalledTimes(1)
  })

  it('allows only one guarded claim even when two transactions see an uninitialized snapshot', async (): Promise<void> => {
    const responses = await Promise.all([1, 2].map(() => app.inject({ method: 'POST', url: '/api/setup/admin', payload })))
    expect(responses.map((response) => response.statusCode).sort()).toEqual([201, 409])
    expect(mockDb.user.create).toHaveBeenCalledTimes(1)
  })

  it('rolls back the claim on duplicate email so a different email can initialize', async (): Promise<void> => {
    mockDb.user.create.mockRejectedValueOnce(new Prisma.PrismaClientKnownRequestError('duplicate', { code: 'P2002', clientVersion: '5.22.0' }))
    expect((await app.inject({ method: 'POST', url: '/api/setup/admin', payload })).statusCode).toBe(409)
    expect(state.initializedAt).toBeNull()
    expect(state.codeHash).toBe(hashSetupCode(code))
    expect((await app.inject({ method: 'POST', url: '/api/setup/admin', payload: { ...payload, email: 'different@example.com' } })).statusCode).toBe(201)
  })

  it.each([{ email: 'bad' }, { password: 'short' }, { displayName: ' ' }, { code: '' }])('validates registration fields and code: %j', async (invalid): Promise<void> => {
    expect((await app.inject({ method: 'POST', url: '/api/setup/admin', payload: { ...payload, ...invalid } })).statusCode).toBe(400)
    expect(mockDb.$transaction).not.toHaveBeenCalled()
  })

  it('returns 409 after initialization even for invalid input or an exhausted IP budget', async (): Promise<void> => {
    mockConfig.AUTH_REGISTER_ATTEMPTS_PER_HOUR = 1
    expect((await app.inject({ method: 'POST', url: '/api/setup/admin', payload })).statusCode).toBe(201)
    expect((await app.inject({ method: 'POST', url: '/api/setup/admin', payload: {} })).statusCode).toBe(409)
    expect((await app.inject({ method: 'POST', url: '/api/setup/admin', payload })).statusCode).toBe(409)
    expect(mockDb.$transaction).toHaveBeenCalledTimes(1)
  })

  it('rate limits by IP before locking or changing setup state', async (): Promise<void> => {
    mockConfig.AUTH_REGISTER_ATTEMPTS_PER_HOUR = 1
    expect((await app.inject({ method: 'POST', url: '/api/setup/admin', payload: {} })).statusCode).toBe(400)
    const blocked = await app.inject({ method: 'POST', url: '/api/setup/admin', payload })
    expect(blocked.statusCode).toBe(429)
    expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(0)
    expect(mockDb.$transaction).not.toHaveBeenCalled()
    expect((await app.inject({ method: 'POST', url: '/api/setup/admin', remoteAddress: '127.0.0.2', payload: {} })).statusCode).toBe(400)
  })
})
