import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
const state = vi.hoisted(() => ({ limits: { instanceDaily: 5, perUserDaily: 3 }, rows: new Map<string, number>(), lock: vi.fn() }))
vi.mock('./ai-settings.js', () => ({ aiPolicy: () => ({ limits: state.limits, allowedPrivateHosts: [] }) }))
vi.mock('../db.js', () => {
  const usage = {
    findMany: async ({ where }: { where: { day: string; userId: { in: string[] } } }): Promise<object[]> => where.userId.in.map(userId => ({ userId, day: where.day, count: state.rows.get(`${where.day}/${userId}`) ?? 0 })),
    upsert: async ({ create }: { create: { day: string; userId: string; count: number } }): Promise<void> => {
      const key = `${create.day}/${create.userId}`
      state.rows.set(key, (state.rows.get(key) ?? 0) + create.count)
    },
    updateMany: async ({ where, data }: { where: { day: string; userId: { in: string[] } }; data: { count: { decrement: number } } }): Promise<void> => {
      for (const userId of where.userId.in) {
        const key = `${where.day}/${userId}`
        if (state.rows.has(key)) state.rows.set(key, state.rows.get(key)! - data.count.decrement)
      }
    },
    deleteMany: vi.fn(),
  }
  let tail: Promise<unknown> = Promise.resolve()
  return { db: { aiDailyUsage: usage, $transaction: (task: (transaction: object) => Promise<unknown>): Promise<unknown> => {
    const next = tail.then(() => task({ aiDailyUsage: usage, $queryRaw: state.lock }))
    tail = next.catch(() => {})
    return next
  } } }
})
import { aiBudget } from './ai-budget.js'
import { createAiRequestGuard } from '../utils/ai-request-guard.js'

beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-10-18T23:59:00Z')); state.rows.clear(); state.lock.mockReset() })
afterEach(() => { vi.useRealTimers() })
describe('persistent UTC AI budget through the shared guard', () => {
  it.each(['selfhost', 'yitan-official'])('%s reserves at most half for background and preserves personal quota', async profile => {
    const guard = (): ReturnType<typeof createAiRequestGuard> => createAiRequestGuard({ perMinute: 60, globalDaily: 5, maxConcurrent: 2,
      ...(profile === 'selfhost' ? { budget: () => aiBudget } : {}) })
    const official = guard()
    const next = (): ReturnType<typeof createAiRequestGuard> => profile === 'selfhost' ? guard() : official
    for (let index = 0; index < 2; index += 1) await next().run('one', async () => 'ok', 'background')
    await expect(next().run('two', async () => 'bad', 'background')).rejects.toMatchObject({ code: 'AI_INSTANCE_DAILY_LIMIT' })
    if (profile === 'selfhost') expect(await aiBudget.available('one')).toEqual({ instance: 3, user: 3 })
    for (let index = 0; index < 3; index += 1) await next().run('one', async () => 'ok')
    await expect(next().run('two', async () => 'bad')).rejects.toMatchObject({ code: 'AI_INSTANCE_DAILY_LIMIT' })
  })
  it('does not use a personal reservation to bypass the background share', async () => {
    const reservation = await aiBudget.reserve('one', 3)
    const guard = createAiRequestGuard({ perMinute: 60, globalDaily: 999, maxConcurrent: 2, budget: () => aiBudget })
    await guard.run('one', async () => 'ok', 'background', reservation)
    expect(reservation.remaining).toBe(3)
    expect(state.rows.get(`${reservation.day}/*background*`)).toBe(1)
  })
  it('casts the shared transaction lock result to text for both reservations and refunds', async () => {
    const reservation = await aiBudget.reserve('one', 1)
    await aiBudget.release(reservation)
    expect(state.lock).toHaveBeenCalledTimes(2)
    for (const call of state.lock.mock.calls) {
      expect(call).toEqual([['SELECT pg_advisory_xact_lock(403, 1)::text AS lock_result']])
    }
  })
  it('atomically reserves partial coverage under concurrent users and releases unused quota', async () => {
    const [first, second] = await Promise.all([aiBudget.reserve('one', 10), aiBudget.reserve('two', 10)])
    expect([first.remaining, second.remaining]).toEqual([3, 2])
    expect(await aiBudget.available('one')).toEqual({ instance: 0, user: 0 })
    first.remaining -= 1
    await aiBudget.release(first)
    await aiBudget.release(first)
    expect(await aiBudget.available('one')).toEqual({ instance: 2, user: 2 })
  })
  it('enforces personal and instance errors across IP keys and new guard instances', async () => {
    const guard = (): ReturnType<typeof createAiRequestGuard> => createAiRequestGuard({ perMinute: 60, globalDaily: 999, maxConcurrent: 2, budget: () => aiBudget })
    for (let index = 0; index < 3; index += 1) await guard().run(`one:ip${index}`, async () => 'ok')
    await expect(guard().run('one:another-ip', async () => 'bad')).rejects.toMatchObject({ code: 'AI_USER_DAILY_LIMIT' })
    await guard().run('topic:two', async () => 'ok')
    await guard().run('avatar:two', async () => 'ok')
    await expect(guard().run('three:ip', async () => 'bad')).rejects.toMatchObject({ code: 'AI_INSTANCE_DAILY_LIMIT' })
  })
  it('consumes reserved units once and resets at UTC midnight, including lock waits', async () => {
    const reservation = await aiBudget.reserve('one', 3)
    const guard = createAiRequestGuard({ perMinute: 60, globalDaily: 999, maxConcurrent: 2, budget: () => aiBudget })
    await guard.run('one', async () => 'ok', 'user', reservation)
    expect(reservation.remaining).toBe(2)
    expect(await aiBudget.available('one')).toEqual({ instance: 2, user: 0 })
    vi.setSystemTime(new Date('2026-10-19T00:00:00Z'))
    expect(await aiBudget.available('one')).toEqual({ instance: 5, user: 3 })
    await expect(guard.run('one', async () => 'bad', 'user', reservation)).rejects.toMatchObject({ reason: 'daily' })
    vi.setSystemTime(new Date('2026-10-19T23:59:59Z'))
    state.lock.mockImplementationOnce(async () => { vi.setSystemTime(new Date('2026-10-20T00:00:00Z')) })
    expect((await aiBudget.reserve('one', 1)).day).toBe('2026-10-20')
  })
})
