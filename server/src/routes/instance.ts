import { sign } from 'node:crypto'
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify'
import { z } from 'zod'
import { config } from '../config.js'
import { publicBaseUrlSchema } from '../config-schema.js'
import { AttemptLimiter } from '../lib/attempt-limiter.js'
import { getInstanceIdentity } from '../lib/instance-identity.js'

const AddressProofBody = z.object({
  nonce: z.string().regex(/^[A-Za-z0-9_-]{43}$/)
    .refine((value) => Buffer.from(value, 'base64url').toString('base64url') === value, 'Nonce must be canonical base64url for 32 bytes'),
  expectedBaseUrl: publicBaseUrlSchema.optional(),
})

export const instanceRoutes: FastifyPluginAsync = async (fastify): Promise<void> => {
  const attempts = new AttemptLimiter()
  fastify.post('/address-proof', async (request: FastifyRequest<{ Body: unknown }>, reply: FastifyReply): Promise<FastifyReply> => {
    reply.header('Cache-Control', 'no-store')
    const retryAfter = attempts.consume(request.ip, 30, 60_000)
    if (retryAfter !== null) {
      return reply.header('Retry-After', String(retryAfter)).code(429).send({ error: 'Too many attempts. Try again later.' })
    }
    const body = AddressProofBody.safeParse(request.body)
    if (!body.success) return reply.code(400).send({ error: 'Invalid address proof request' })

    const expected = body.data.expectedBaseUrl ?? config.PUBLIC_BASE_URL
    const origin = [config.PUBLIC_BASE_URL, ...config.INSTANCE_ADDITIONAL_BASE_URLS].find((url) => url === expected)
    if (!origin) return reply.code(400).send({ error: 'Expected base URL is not configured for this instance' })
    const identity = getInstanceIdentity()
    if (!identity) return reply.code(503).send({ error: 'Instance identity is unavailable' })

    const bytes = Buffer.from(JSON.stringify({
      purpose: 'skillhub-instance-address-proof-v1',
      instanceId: identity.id,
      origin,
      nonce: body.data.nonce,
    }), 'utf8')
    return reply.send({
      payload: bytes.toString('base64url'),
      signature: sign(null, bytes, identity.privateKey).toString('base64url'),
    })
  })
}
