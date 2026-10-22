import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify'
import { ZodError } from 'zod'
import { authMiddleware } from '../middleware/auth.js'
import { registerInstanceAi } from './instance-ai.js'
import { registerInstanceFal } from './instance-fal.js'
import { config } from '../config.js'
import {
  deleteServerSetting, isServerSettingKey, maskedSetting, SERVER_SETTING_KEYS, writeServerSetting,
} from '../lib/server-settings.js'

export const instanceSettingsRoutes: FastifyPluginAsync = async (fastify): Promise<void> => {
  if (config.SKILLHUB_PROFILE !== 'selfhost') return
  fastify.addHook('onRequest', async (_request, reply): Promise<void> => {
    reply.header('Cache-Control', 'no-store')
  })
  fastify.addHook('preHandler', authMiddleware)
  fastify.addHook('preHandler', async (request, reply): Promise<void> => {
    if (request.user.marketplaceRole !== 'admin') return reply.code(403).send({ error: 'Administrator access required' })
  })
  await registerInstanceAi(fastify)
  await registerInstanceFal(fastify)
  fastify.get('/', async (_request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply> => {
    return reply.send(SERVER_SETTING_KEYS.map(maskedSetting))
  })
  fastify.put('/:key', async (request: FastifyRequest<{ Params: { key: string }; Body: unknown }>, reply: FastifyReply): Promise<FastifyReply> => {
    const { key } = request.params
    if (!isServerSettingKey(key)) return reply.code(404).send({ error: 'Unknown server setting' })
    if (key === 'ai' || key === 'ai.policy' || key === 'registration' || key === 'fal') return reply.code(409).send({ code: 'USE_SETTINGS_ENDPOINT' })
    try {
      await writeServerSetting(key, request.body, request.user.id)
    } catch (error: unknown) {
      if (error instanceof ZodError) return reply.code(400).send({ error: 'Invalid server setting' })
      // Never expose database error details or request bodies containing secrets.
      return reply.code(503).send({ error: 'Unable to save server setting; secrets require a configured CREDENTIAL_KEK_BASE64' })
    }
    return reply.send(maskedSetting(key))
  })
  fastify.delete('/:key', async (request: FastifyRequest<{ Params: { key: string } }>, reply: FastifyReply): Promise<FastifyReply> => {
    const { key } = request.params
    if (!isServerSettingKey(key)) return reply.code(404).send({ error: 'Unknown server setting' })
    if (key === 'ai' || key === 'ai.policy' || key === 'registration' || key === 'fal') return reply.code(409).send({ code: 'USE_SETTINGS_ENDPOINT' })
    await deleteServerSetting(key)
    return reply.code(204).send()
  })
}
