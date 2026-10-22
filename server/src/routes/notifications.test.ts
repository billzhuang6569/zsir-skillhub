import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify'
import sensible from '@fastify/sensible'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mockDb = vi.hoisted(() => ({
  notification: {
    findMany: vi.fn(),
    findUnique: vi.fn(),
    update: vi.fn(),
    updateMany: vi.fn(),
  },
}))

vi.mock('../db.js', () => ({ db: mockDb }))
vi.mock('../middleware/auth.js', () => ({
  authMiddleware: async (request: FastifyRequest): Promise<void> => {
    request.user = { id: 'user-001', email: 'user@example.com', displayName: '测试用户' }
  },
}))

import { notificationsRoutes } from './notifications.js'

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify()
  await app.register(sensible)
  await app.register(notificationsRoutes, { prefix: '/api/notifications' })
  await app.ready()
  return app
}

describe('notification routes', () => {
  let app: FastifyInstance | undefined

  beforeEach(() => vi.clearAllMocks())
  afterEach(async () => {
    await app?.close()
    app = undefined
  })

  it('lists only the current account notifications in newest-first order', async () => {
    mockDb.notification.findMany.mockResolvedValue([])
    app = await buildApp()

    const response = await app.inject({ method: 'GET', url: '/api/notifications' })

    expect(response.statusCode).toBe(200)
    expect(mockDb.notification.findMany).toHaveBeenCalledWith({
      where: { userId: 'user-001' },
      orderBy: { createdAt: 'desc' },
      take: 50,
    })
  })

  it('does not let one account mark another account notification as read', async () => {
    mockDb.notification.findUnique.mockResolvedValue({
      id: 'notification-001', userId: 'other-user', read: false,
    })
    app = await buildApp()

    const response = await app.inject({
      method: 'POST', url: '/api/notifications/notification-001/read',
    })

    expect(response.statusCode).toBe(403)
    expect(mockDb.notification.update).not.toHaveBeenCalled()
  })

  it('marks an owned notification as read', async () => {
    const notification = { id: 'notification-001', userId: 'user-001', read: false }
    mockDb.notification.findUnique.mockResolvedValue(notification)
    mockDb.notification.update.mockResolvedValue({ ...notification, read: true })
    app = await buildApp()

    const response = await app.inject({
      method: 'POST', url: '/api/notifications/notification-001/read',
    })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({ id: 'notification-001', read: true })
    expect(mockDb.notification.update).toHaveBeenCalledWith({
      where: { id: 'notification-001' }, data: { read: true },
    })
  })

  it('marks only the current account unread notifications as read', async () => {
    mockDb.notification.updateMany.mockResolvedValue({ count: 2 })
    app = await buildApp()

    const response = await app.inject({
      method: 'POST', url: '/api/notifications/read-all',
    })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({ success: true })
    expect(mockDb.notification.updateMany).toHaveBeenCalledWith({
      where: { userId: 'user-001', read: false },
      data: { read: true },
    })
  })
})
