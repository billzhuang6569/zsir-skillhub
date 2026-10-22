import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { z } from 'zod'
import { AiServiceError } from '../lib/ai-http.js'
import { FalDraft, falSettingsView, saveFalDraft, testFalDraft } from '../lib/fal-settings.js'
import { deleteServerSetting, effectiveSource } from '../lib/server-settings.js'

/** Inherits selfhost-only registration, administrator auth and the safe settings error handler. */
export async function registerInstanceFal(fastify: FastifyInstance): Promise<void> {
  fastify.get('/fal', async (_request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply> => {
    return reply.send(falSettingsView())
  })
  fastify.post('/fal/test', async (request: FastifyRequest<{ Body: unknown }>, reply: FastifyReply): Promise<FastifyReply> => {
    const { apiKey } = FalDraft.parse(request.body)
    return reply.send(await testFalDraft(apiKey, request.user.id))
  })
  fastify.put('/fal', async (request: FastifyRequest<{ Body: unknown }>, reply: FastifyReply): Promise<FastifyReply> => {
    if (effectiveSource('fal') === 'env') throw new AiServiceError('ENV_OVERRIDE', 409)
    if (request.body && typeof request.body === 'object' && ('value' in request.body || 'secret' in request.body)) {
      return reply.code(409).send({ code: 'USE_SETTINGS_ENDPOINT' })
    }
    const { apiKey, draftToken } = FalDraft.extend({ draftToken: z.string().max(128).optional() }).parse(request.body)
    if (!draftToken) throw new AiServiceError('TEST_REQUIRED', 409)
    await saveFalDraft(apiKey, draftToken, request.user.id)
    return reply.send(falSettingsView())
  })
  fastify.delete('/fal', async (_request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply> => {
    if (effectiveSource('fal') === 'env') throw new AiServiceError('ENV_OVERRIDE', 409)
    await deleteServerSetting('fal')
    return reply.code(204).send()
  })
}
