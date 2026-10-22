import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify'
import { z } from 'zod'
import { prepareTopicCover } from '../lib/topic-cover-assets.js'
import { uploadMedia } from '../lib/media.js'
import { authMiddleware } from '../middleware/auth.js'
import { AttemptLimiter } from '../lib/attempt-limiter.js'

const AvatarBody = z.object({ mimeType: z.enum(['image/jpeg', 'image/png', 'image/webp']), dataBase64: z.string().max(7_000_000) }).strict()

export const mediaRoutes: FastifyPluginAsync = async (fastify): Promise<void> => {
  const attempts = new AttemptLimiter()
  fastify.post('/avatars', { preHandler: authMiddleware, bodyLimit: 8 * 1024 * 1024 }, async (request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply> => {
    const body = AvatarBody.safeParse(request.body)
    if (!body.success) return reply.badRequest('请上传 5 MB 以内的 JPG、PNG 或 WebP 图片')
    const retryAfter = attempts.consume(request.user.id, 20, 60 * 60 * 1_000)
    if (retryAfter !== null) return reply.header('Retry-After', retryAfter).code(429).send({ error: '上传过于频繁' })
    let prepared: ReturnType<typeof prepareTopicCover>
    try { prepared = prepareTopicCover(body.data) } catch { return reply.badRequest('图片内容无效') }
    const asset = await uploadMedia(prepared.bytes, body.data.mimeType, prepared.storageName, {
      purpose: 'avatar', visibility: 'public', ownerRef: `user:${request.user.id}`, userId: request.user.id,
    })
    return reply.code(201).send(asset)
  })
}
