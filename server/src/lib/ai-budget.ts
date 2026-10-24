import { db } from '../db.js'
import { aiPolicy } from './ai-settings.js'

export type AiReservation = { day: string; userId: string; remaining: number }
export type AiBudget = {
  reserve: (userId: string, count: number, priority?: 'user' | 'background') => Promise<AiReservation>
  available: (userId: string) => Promise<{ instance: number; user: number }>
  release: (reservation: AiReservation) => Promise<void>
}
export const utcDay = (): string => new Date().toISOString().slice(0, 10)

export const aiBudget: AiBudget = {
  async available(userId): Promise<{ instance: number; user: number }> {
    const day = utcDay()
    const rows = await db.aiDailyUsage.findMany({ where: { day, userId: { in: ['*', userId] } } })
    const limits = aiPolicy().limits
    return { instance: Math.max(0, limits.instanceDaily - (rows.find(row => row.userId === '*')?.count ?? 0)),
      user: Math.max(0, limits.perUserDaily - (rows.find(row => row.userId === userId)?.count ?? 0)) }
  },
  async reserve(userId, count, priority = 'user'): Promise<AiReservation> {
    // Background work spends the instance's shared half, never an author's personal allowance.
    if (priority === 'background') userId = '*background*'
    return db.$transaction(async transaction => {
      // One database lock serializes instance + user accounting across workers.
      await transaction.$queryRaw`SELECT pg_advisory_xact_lock(403, 1)::text AS lock_result`
      const day = utcDay()
      const rows = await transaction.aiDailyUsage.findMany({ where: { day, userId: { in: ['*', userId] } } })
      const limits = aiPolicy().limits
      const remaining = Math.max(0, Math.min(count,
        limits.instanceDaily - (rows.find(row => row.userId === '*')?.count ?? 0),
        (priority === 'background' ? Math.floor(limits.instanceDaily / 2) : limits.perUserDaily)
          - (rows.find(row => row.userId === userId)?.count ?? 0)))
      for (const id of ['*', userId]) {
        await transaction.aiDailyUsage.upsert({ where: { day_userId: { day, userId: id } },
          create: { day, userId: id, count: remaining }, update: { count: { increment: remaining } } })
      }
      await transaction.aiDailyUsage.deleteMany({ where: { day: { lt: day } } })
      return { day, userId, remaining }
    })
  },
  async release(reservation): Promise<void> {
    const count = reservation.remaining
    if (!count) return
    await db.$transaction(async transaction => {
      await transaction.$queryRaw`SELECT pg_advisory_xact_lock(403, 1)::text AS lock_result`
      await transaction.aiDailyUsage.updateMany({ where: { day: reservation.day, userId: { in: ['*', reservation.userId] } },
        data: { count: { decrement: count } } })
    })
    reservation.remaining = 0
  },
}
