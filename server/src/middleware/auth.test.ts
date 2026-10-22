import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify'
import jwt from '@fastify/jwt'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mockDb = vi.hoisted(() => ({
  user: { findUnique: vi.fn() },
}))

vi.mock('../db.js', () => ({ db: mockDb }))

import { authMiddleware } from './auth.js'

const JWT_SECRET = 'skillhub-test-jwt-secret-not-for-production'
const USER_ID = '11111111-1111-4111-8111-111111111111'
const BASE_TIME = new Date('2026-01-01T00:00:00.000Z')

// Production registers @fastify/jwt with only `secret`, which leaves the
// fast-jwt verifier cache disabled. GHSA-x937-hj6v-793p affects tokens with
// `exp` but no `iat` once the cache is enabled, so both modes are covered here
// without changing the production registration in src/index.ts.
const VERIFIER_MODES = [
  { name: 'verifier cache disabled (production registration)', verify: undefined },
  { name: 'verifier cache enabled', verify: { cache: true } },
] as const

async function buildApp(verify: { cache: true } | undefined): Promise<FastifyInstance> {
  const app = Fastify({ logger: false })
  await app.register(jwt, verify ? { secret: JWT_SECRET, verify } : { secret: JWT_SECRET })
  app.get('/protected', { preHandler: authMiddleware }, async (request: FastifyRequest, reply: FastifyReply) => {
    return reply.send({ userId: request.user.id })
  })
  await app.ready()
  return app
}

function signWithoutIat(app: FastifyInstance, exp: number): string {
  const token = app.jwt.sign({ sub: USER_ID, ver: 1, exp }, { noTimestamp: true })
  const decoded = app.jwt.decode<Record<string, unknown>>(token)
  expect(decoded).toMatchObject({ sub: USER_ID, ver: 1, exp })
  expect(decoded).not.toHaveProperty('iat')
  return token
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000)
}

async function requestWith(app: FastifyInstance, token: string): Promise<number> {
  const response = await app.inject({
    method: 'GET',
    url: '/protected',
    headers: { authorization: `Bearer ${token}` },
  })
  return response.statusCode
}

describe.each(VERIFIER_MODES)('authMiddleware expiry without iat: $name', ({ verify }) => {
  let app: FastifyInstance

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(BASE_TIME)
    mockDb.user.findUnique.mockReset()
    mockDb.user.findUnique.mockResolvedValue({
      id: USER_ID,
      email: 'user@example.com',
      displayName: 'User',
      avatarUrl: null,
      marketplaceRole: 'user',
      tokenVersion: 1,
    })
    app = await buildApp(verify)
  })

  afterEach(async () => {
    await app.close()
    vi.useRealTimers()
  })

  it('accepts an unexpired token that has exp but no iat', async () => {
    const token = signWithoutIat(app, nowSeconds() + 3600)

    expect(await requestWith(app, token)).toBe(200)
    expect(mockDb.user.findUnique).toHaveBeenCalledWith({ where: { id: USER_ID } })
  })

  it('rejects a token whose exp is already in the past and has no iat', async () => {
    const token = signWithoutIat(app, nowSeconds() - 60)

    expect(await requestWith(app, token)).toBe(401)
    expect(mockDb.user.findUnique).not.toHaveBeenCalled()
  })

  it('rejects a token without iat once it expires after a successful verification', async () => {
    const token = signWithoutIat(app, nowSeconds() + 60)

    expect(await requestWith(app, token)).toBe(200)

    vi.setSystemTime(new Date(BASE_TIME.getTime() + 120_000))

    expect(await requestWith(app, token)).toBe(401)
    expect(mockDb.user.findUnique).toHaveBeenCalledTimes(1)
  })
})
