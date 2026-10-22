import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify'
import { timingSafeEqual } from 'node:crypto'
import { z } from 'zod'
import { db } from '../db.js'
import { config } from '../config.js'
import { AttemptLimiter } from '../lib/attempt-limiter.js'
import { hashSetupCode, lockInstanceSetup } from '../lib/instance-setup.js'
import { hashPassword } from '../lib/password.js'
import { RegisterBody, authResponse, isUniqueConstraintError, publicUserSelect } from './auth.js'

const SetupBody = RegisterBody.omit({ inviteCode: true }).extend({ code: z.string().trim().min(1).max(128) })
type SetupResult = { status: 401 | 409 | 410; error: string }
  | { status: 201; user: Parameters<typeof authResponse>[1] & { tokenVersion: number } }

export const setupRoutes: FastifyPluginAsync = async (fastify): Promise<void> => {
  const attempts = new AttemptLimiter()
  fastify.get('/status', async (_request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply> => {
    reply.header('Cache-Control', 'no-store')
    const setup = await db.instanceSetup.findUnique({ where: { id: 1 }, select: { initializedAt: true } })
    return reply.send({ initialized: Boolean(setup?.initializedAt) })
  })

  fastify.post('/admin', async (request: FastifyRequest<{ Body: unknown }>, reply: FastifyReply): Promise<FastifyReply> => {
    reply.header('Cache-Control', 'no-store')
    const setup = await db.instanceSetup.findUnique({ where: { id: 1 }, select: { initializedAt: true } })
    if (setup?.initializedAt) return reply.code(409).send({ error: 'Instance already initialized' })
    const retryAfter = attempts.consume(`setup:${request.ip}`, config.AUTH_REGISTER_ATTEMPTS_PER_HOUR, 60 * 60 * 1000)
    if (retryAfter !== null) {
      return reply.header('Retry-After', String(retryAfter)).code(429).send({ error: 'Too many attempts. Try again later.' })
    }
    const body = SetupBody.safeParse(request.body)
    if (!body.success) return reply.code(400).send({ error: 'Invalid setup data' })

    try {
      const result = await db.$transaction(async (transaction): Promise<SetupResult> => {
        const setup = await lockInstanceSetup(transaction)
        if (setup?.initializedAt) return { status: 409, error: 'Instance already initialized' } as const
        if (!setup?.codeHash || !setup.codeExpiresAt || setup.codeExpiresAt.getTime() <= Date.now() || setup.codeAttempts >= 5) {
          return { status: 410, error: 'Initialization code expired or unavailable. Restart the server.' } as const
        }
        const candidate = Buffer.from(hashSetupCode(body.data.code), 'hex')
        const expected = Buffer.from(setup.codeHash, 'hex')
        if (candidate.length !== expected.length || !timingSafeEqual(candidate, expected)) {
          const codeAttempts = setup.codeAttempts + 1
          await transaction.instanceSetup.update({
            where: { id: 1 },
            data: { codeAttempts, ...(codeAttempts >= 5 ? { codeHash: null, codeExpiresAt: null } : {}) },
          })
          // Return instead of throwing so the failed-attempt count commits.
          return { status: 401, error: 'Invalid initialization code' } as const
        }
        const credentials = await hashPassword(body.data.password)
        const claimed = await transaction.instanceSetup.updateMany({
          where: { id: 1, initializedAt: null, codeHash: setup.codeHash },
          data: { initializedAt: new Date(), codeHash: null, codeExpiresAt: null },
        })
        if (claimed.count !== 1) return { status: 409, error: 'Instance already initialized' } as const
        const user = await transaction.user.create({
          data: { email: body.data.email, displayName: body.data.displayName, ...credentials, marketplaceRole: 'admin' },
          select: { ...publicUserSelect, tokenVersion: true },
        })
        return { status: 201, user } as const
      })
      if ('error' in result) return reply.code(result.status).send({ error: result.error })
      return reply.code(201).send(authResponse(fastify, result.user, result.user.tokenVersion))
    } catch (error: unknown) {
      if (isUniqueConstraintError(error)) return reply.code(409).send({ error: 'Email already registered' })
      throw error
    }
  })
}
