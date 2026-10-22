import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify'
import { readPublicMedia } from '../providers/builtin-media.js'

export const publicMediaRoutes: FastifyPluginAsync = async (fastify): Promise<void> => {
  fastify.get('/media/:prefix/:file', async (
    request: FastifyRequest<{ Params: { prefix: string; file: string } }>, reply: FastifyReply,
  ): Promise<FastifyReply> => {
    const { bytes, mimeType } = await readPublicMedia(`/media/${request.params.prefix}/${request.params.file}`)
    return reply.type(mimeType)
      .header('Cache-Control', 'public, max-age=31536000, immutable')
      .header('X-Content-Type-Options', 'nosniff')
      .header('Content-Security-Policy', "default-src 'none'")
      .send(bytes)
  })
}
