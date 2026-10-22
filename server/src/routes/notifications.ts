import type { FastifyPluginAsync } from 'fastify'
import { db } from '../db.js'
import { authMiddleware } from '../middleware/auth.js'

export const notificationsRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.addHook('onRequest', authMiddleware)

  // GET /api/notifications
  fastify.get('/', async (req) => {
    return db.notification.findMany({
      where: { userId: req.user.id },
      orderBy: { createdAt: 'desc' },
      take: 50,
    })
  })

  // POST /api/notifications/:id/read
  fastify.post<{ Params: { id: string } }>('/:id/read', async (req, reply) => {
    const notif = await db.notification.findUnique({ where: { id: req.params.id } })
    if (!notif) return reply.notFound()
    if (notif.userId !== req.user.id) return reply.forbidden()
    return db.notification.update({ where: { id: req.params.id }, data: { read: true } })
  })

  // POST /api/notifications/read-all
  fastify.post('/read-all', async (req) => {
    await db.notification.updateMany({
      where: { userId: req.user.id, read: false },
      data: { read: true },
    })
    return { success: true }
  })
}
