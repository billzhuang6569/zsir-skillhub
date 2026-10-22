import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { z } from 'zod'
import { avatarStyleIdSchema, avatarStyleVersionSchema, canonicalJson, contentSha256, type AvatarStyle } from '../lib/avatar-style-catalog.js'
import { getAvatarStyle, listAvatarStyles } from '../lib/avatar-styles.js'

function sendCached(request: FastifyRequest, reply: FastifyReply, value: AvatarStyle | AvatarStyle[], immutable: boolean): FastifyReply {
  const body = canonicalJson(value)
  const etag = `"${contentSha256(body)}"`
  reply.header('ETag', etag).header('Cache-Control', immutable ? 'public, max-age=31536000, immutable' : 'public, max-age=300')
  const matches = request.headers['if-none-match']?.split(',').some(tag => tag.trim() === '*' || tag.trim().replace(/^W\//, '') === etag)
  if (matches) return reply.code(304).send()
  return reply.type('application/json').send(body)
}

const paramsSchema = z.object({
  styleId: avatarStyleIdSchema,
  styleVersion: z.string().regex(/^[1-9][0-9]*$/).transform(Number).pipe(avatarStyleVersionSchema),
})

export async function avatarStylesRoutes(server: FastifyInstance): Promise<void> {
  server.get('/', async (request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply> => {
    try { return sendCached(request, reply, await listAvatarStyles(), false) }
    catch {
      request.log.warn({ code: 'avatar_style_cache_unavailable' }, 'Avatar style cache unavailable')
      return reply.code(503).header('Cache-Control', 'no-store').send({ error: 'avatar_style_cache_unavailable' })
    }
  })
  server.get('/:styleId/versions/:styleVersion', async (
    request: FastifyRequest<{ Params: { styleId: string; styleVersion: string } }>, reply: FastifyReply,
  ): Promise<FastifyReply> => {
    const parsed = paramsSchema.safeParse(request.params)
    if (!parsed.success) return reply.code(404).header('Cache-Control', 'no-store').send({ error: 'avatar_style_not_found' })
    try {
      const style = await getAvatarStyle(parsed.data.styleId, parsed.data.styleVersion)
      if (!style) return reply.code(404).header('Cache-Control', 'no-store').send({ error: 'avatar_style_not_found' })
      return sendCached(request, reply, style, true)
    } catch {
      request.log.warn({ code: 'avatar_style_cache_unavailable' }, 'Avatar style cache unavailable')
      return reply.code(503).header('Cache-Control', 'no-store').send({ error: 'avatar_style_cache_unavailable' })
    }
  })
}
